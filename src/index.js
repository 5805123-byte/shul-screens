// מסכי בית הכנסת — השרת (Cloudflare Worker)
//
//   /s/<מזהה או כתובת>         הדף שמוצג על המסך
//   /admin                      דף ניהול (יצירת מסכים, שינוי שם, הודעות)
//   /api/screen/<מזהה>          הנתונים של מסך (ציבורי, לקריאה בלבד)
//   /api/admin/...              ניהול — דורש  Authorization: Bearer <ADMIN_KEY>
//
// ה-CRM ישלח לכאן את זמני התפילה, פרנס היום, תורמים והודעות דרך /api/admin/content.
import {
  ensureSchema, listScreens, findScreen, createScreen, updateScreen, deleteScreen, slugTaken,
  getContent, putContent, deleteContent, CONTENT_KEYS, DEFAULT_SETTINGS,
} from './db.js';
import { buildDays, demoTefilot, isoToday, ZMANIM } from './days.js';

const DAYS_AHEAD = 3;             // היום + יומיים, כדי שהמסך ימשיך לעבוד גם בלי אינטרנט
const MAX_BODY = 256 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path.startsWith('/s/') && request.method === 'GET') return screenPage(request, env);
      if (path === '/api/health') return json({ ok: true, version: version(env) });
      if (path.startsWith('/api/screen/') && request.method === 'GET') {
        await ensureSchema(env.DB);
        return screenData(env, decodeURIComponent(path.slice('/api/screen/'.length)));
      }
      if (path.startsWith('/api/admin/')) {
        const denied = await checkAdmin(request, env);
        if (denied) return denied;
        await ensureSchema(env.DB);
        return admin(request, env, path.slice('/api/admin/'.length).split('/').map(decodeURIComponent), url);
      }
      return json({ ok: false, error: 'לא נמצא' }, 404);
    } catch (err) {
      console.error(JSON.stringify({ message: 'request failed', path, error: String(err && err.stack || err) }));
      return json({ ok: false, error: 'שגיאת שרת' }, 500);
    }
  },
};

// ---------- עזרים ----------

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function version(env) {
  return (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || 'dev';
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'הבקשה גדולה מדי');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'JSON לא תקין'); }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function sha256(s) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

async function checkAdmin(request, env) {
  if (!env.ADMIN_KEY) {
    return json({ ok: false, error: 'לא הוגדר מפתח ניהול (ADMIN_KEY) ב-Cloudflare' }, 503);
  }
  const h = request.headers.get('authorization') || '';
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const [a, b] = await Promise.all([sha256(given), sha256(env.ADMIN_KEY)]);
  if (!given || !crypto.subtle.timingSafeEqual(a, b)) return json({ ok: false, error: 'מפתח ניהול שגוי' }, 401);
  return null;
}

// ---------- הדף של המסך ----------

async function screenPage(request, env) {
  // אותו דף לכל המסכים; הדף קורא את המזהה מהכתובת
  const res = await env.ASSETS.fetch(new URL('/screen', request.url));
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-cache');
  return out;
}

async function screenData(env, key) {
  const screen = await findScreen(env.DB, key);
  if (!screen) return json({ ok: false, error: 'המסך לא נמצא', notFound: true }, 404);
  const s = screen.settings;
  const today = isoToday(s.location.tz);
  const days = buildDays(today, DAYS_AHEAD, s);

  const [global, own] = await Promise.all([getContent(env.DB, 'global'), getContent(env.DB, screen.id)]);
  const pick = (k) => (own[k] || global[k] || null);

  const content = {};
  const demo = {};
  for (const k of CONTENT_KEYS) {
    const c = pick(k);
    content[k] = c ? c.data : null;
  }
  if (!content.tefilot) { content.tefilot = demoTefilot(days); demo.tefilot = true; }

  const last = days[days.length - 1].date;
  const inRange = (it) => (!it.from || it.from <= last) && (!it.to || it.to >= today);
  if (content.tefilot && Array.isArray(content.tefilot.items)) {
    content.tefilot.items = content.tefilot.items.filter((it) => !it.date || (it.date >= today && it.date <= last));
  }
  if (content.announcements && Array.isArray(content.announcements.items)) {
    content.announcements.items = content.announcements.items.filter(inRange);
  }
  if (content.parnes && Array.isArray(content.parnes.items)) {
    content.parnes.items = content.parnes.items.filter((it) => !it.date || (it.date >= today && it.date <= last));
  }

  return json({
    ok: true,
    version: version(env),
    serverTime: new Date().toISOString(),
    screen: { id: screen.id, slug: screen.slug, name: screen.name, settings: s },
    zmanimLabels: Object.fromEntries(ZMANIM.map((z) => [z.key, z.label])),
    days,
    content,
    demo,
  });
}

// ---------- ניהול ----------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 60) throw new HttpError(400, 'שם המסך חייב להיות בין 1 ל-60 תווים');
  return n;
}

function cleanSlug(slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new HttpError(400, 'כתובת המסך: אותיות באנגלית, ספרות ומקפים בלבד (עד 40 תווים)');
  return s;
}

function cleanSettings(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object') throw new HttpError(400, 'הגדרות לא תקינות');
  const out = {};
  const str = (k, max = 120) => { if (k in input) out[k] = String(input[k] ?? '').slice(0, max); };
  const num = (k, min, max) => {
    if (!(k in input)) return;
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `ערך לא תקין: ${k}`);
    out[k] = v;
  };
  const oneOf = (k, list) => {
    if (!(k in input)) return;
    if (!list.includes(input[k])) throw new HttpError(400, `ערך לא תקין: ${k}`);
    out[k] = input[k];
  };
  str('title'); str('subtitle');
  oneOf('orientation', ['auto', 'landscape', 'portrait']);
  oneOf('theme', ['navy', 'cream', 'burgundy']);
  if ('hour12' in input) out.hour12 = !!input.hour12;
  if ('showSeconds' in input) out.showSeconds = !!input.showSeconds;
  num('candleMinutes', 0, 90); num('havdalahMinutes', 0, 120); num('tzeitMinutes', 0, 120); num('slideSeconds', 3, 300);
  if ('zmanim' in input) {
    const valid = new Set(ZMANIM.map((z) => z.key));
    if (!Array.isArray(input.zmanim) || input.zmanim.some((k) => !valid.has(k))) throw new HttpError(400, 'רשימת זמנים לא תקינה');
    out.zmanim = input.zmanim;
  }
  if ('location' in input) {
    const l = input.location || {};
    const loc = {};
    if ('name' in l) loc.name = String(l.name).slice(0, 60);
    for (const [k, lim] of [['lat', 90], ['lon', 180]]) {
      if (k in l) {
        const v = Number(l[k]);
        if (!Number.isFinite(v) || Math.abs(v) > lim) throw new HttpError(400, `מיקום לא תקין: ${k}`);
        loc[k] = v;
      }
    }
    if ('tz' in l) {
      try { new Intl.DateTimeFormat('en', { timeZone: l.tz }); } catch { throw new HttpError(400, 'אזור זמן לא תקין'); }
      loc.tz = l.tz;
    }
    out.location = loc;
  }
  return out;
}

function cleanContent(key, data) {
  if (!data || typeof data !== 'object') throw new HttpError(400, 'תוכן לא תקין');
  const items = Array.isArray(data.items) ? data.items : null;
  if (!items) throw new HttpError(400, 'התוכן צריך להיות בצורה {"items": [...]}');
  if (items.length > 500) throw new HttpError(400, 'יותר מדי פריטים');
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const txt = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const date = (v) => {
    if (v == null || v === '') return undefined;
    if (!DATE.test(String(v))) throw new HttpError(400, `תאריך לא תקין: ${v} (צריך YYYY-MM-DD)`);
    return String(v);
  };
  const clean = items.map((it) => {
    if (!it || typeof it !== 'object') throw new HttpError(400, 'פריט לא תקין');
    switch (key) {
      case 'tefilot': return { date: date(it.date), label: txt(it.label, 60), time: txt(it.time, 40), note: txt(it.note, 80) || undefined };
      case 'announcements': return { text: txt(it.text, 500), from: date(it.from), to: date(it.to) };
      case 'donors': return { name: txt(it.name, 120), note: txt(it.note, 200) || undefined };
      case 'parnes': return { date: date(it.date), text: txt(it.text, 300) };
      default: throw new HttpError(400, 'סוג תוכן לא מוכר');
    }
  }).filter((it) => Object.values(it).some((v) => v));
  const out = { items: clean };
  if (data.title != null) out.title = txt(data.title, 80);
  return out;
}

async function admin(request, env, parts, url) {
  const db = env.DB;
  const m = request.method;
  try {
    // GET /api/admin/meta — מה אפשר להגדיר
    if (parts[0] === 'meta' && m === 'GET') {
      return json({ ok: true, version: version(env), zmanim: ZMANIM, defaults: DEFAULT_SETTINGS, contentKeys: CONTENT_KEYS });
    }

    if (parts[0] === 'screens') {
      const id = parts[1];
      if (!id && m === 'GET') return json({ ok: true, screens: await listScreens(db) });
      if (!id && m === 'POST') {
        const body = await readJson(request);
        const name = cleanName(body.name);
        const slug = cleanSlug(body.slug);
        if (await slugTaken(db, slug)) throw new HttpError(409, 'הכתובת הזאת כבר תפוסה');
        const screen = await createScreen(db, { name, slug, settings: cleanSettings(body.settings) || {} });
        return json({ ok: true, screen }, 201);
      }
      if (id) {
        const screen = await findScreen(db, id);
        if (!screen || screen.id !== id) throw new HttpError(404, 'המסך לא נמצא');
        if (m === 'GET') return json({ ok: true, screen });
        if (m === 'PATCH') {
          const body = await readJson(request);
          const patch = {};
          if ('name' in body) patch.name = cleanName(body.name);
          if ('slug' in body) {
            patch.slug = cleanSlug(body.slug);
            if (await slugTaken(db, patch.slug, id)) throw new HttpError(409, 'הכתובת הזאת כבר תפוסה');
          }
          patch.settings = cleanSettings(body.settings);
          return json({ ok: true, screen: await updateScreen(db, id, patch) });
        }
        if (m === 'DELETE') { await deleteScreen(db, id); return json({ ok: true }); }
      }
    }

    // /api/admin/content/<global|מזהה מסך>[/<סוג>]
    if (parts[0] === 'content' && parts[1]) {
      const scope = parts[1];
      if (scope !== 'global') {
        const s = await findScreen(db, scope);
        if (!s || s.id !== scope) throw new HttpError(404, 'המסך לא נמצא');
      }
      const key = parts[2];
      if (!key && m === 'GET') return json({ ok: true, content: await getContent(db, scope) });
      if (key) {
        if (!CONTENT_KEYS.includes(key)) throw new HttpError(400, 'סוג תוכן לא מוכר');
        if (m === 'PUT') {
          const data = cleanContent(key, await readJson(request));
          await putContent(db, scope, key, data);
          return json({ ok: true, count: data.items.length });
        }
        if (m === 'DELETE') { await deleteContent(db, scope, key); return json({ ok: true }); }
      }
    }
    throw new HttpError(404, 'לא נמצא');
  } catch (err) {
    if (err instanceof HttpError) return json({ ok: false, error: err.message }, err.status);
    if (String(err).includes('UNIQUE')) return json({ ok: false, error: 'הכתובת הזאת כבר תפוסה' }, 409);
    throw err;
  }
}
