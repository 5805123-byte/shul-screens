// מסכי בית הכנסת — השרת (Cloudflare Worker)
//
//   /<כתובת או מזהה>              הדף שמוצג על המסך (גם /s/<...> עובד)
//   /admin                         דף ניהול
//   /media/<...>                   התמונות והסרטונים שהועלו
//   /api/screen/<מזהה>             כל הנתונים של מסך (ציבורי, לקריאה בלבד)
//   /api/screen/<מזהה>/poll        בדיקה קטנה כל 15 שניות: האם השתנה משהו / יש פקודה
//   /api/admin/...                 ניהול — דורש  Authorization: Bearer <ADMIN_KEY>
import {
  ensureSchema, listScreens, findScreen, pollScreen, createScreen, updateScreen, setScreenField, deleteScreen,
  slugTaken, getContent, putContent, deleteContent, CONTENT_KEYS, DEFAULT_SETTINGS,
  listMedia, getMedia, addMedia, updateMedia, reorderMedia, deleteMedia, mediaUsingKey, mediaOfScreen, deleteMediaRows,
} from './db.js';
import { buildDays, demoTefilot, isoToday, ZMANIM } from './days.js';

// כתובת של מסך: /hall או /s/hall. קבצי האתר (/admin וכו') מוגשים לפני שמגיעים לכאן.
const SCREEN_PATH = /^\/(?:s\/)?[a-z0-9][a-z0-9-]*$/;
// מילים שלא יכולות להיות כתובת של מסך
const RESERVED = new Set(['admin', 'api', 's', 'screen', 'index', 'sw', 'robots', 'favicon', 'assets', 'static',
  'agent', 'media', 'files', 'upload']);

const DAYS_AHEAD = 3;             // היום + יומיים, כדי שהמסך ימשיך לעבוד גם בלי אינטרנט
const MAX_BODY = 256 * 1024;
const UPLOAD_TYPES = {
  'image/jpeg': ['image', 'jpg', 25], 'image/png': ['image', 'png', 25], 'image/webp': ['image', 'webp', 25],
  'image/gif': ['image', 'gif', 25], 'video/mp4': ['video', 'mp4', 90], 'video/webm': ['video', 'webm', 90],
};
const COMMANDS = ['reload', 'refresh', 'identify'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'GET' && SCREEN_PATH.test(path)) return screenPage(request, env);
      if (path.startsWith('/media/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return serveMedia(request, env, decodeURIComponent(path.slice('/media/'.length)));
      }
      if (path === '/api/health') return json({ ok: true, version: version(env) });

      const sm = path.match(/^\/api\/screen\/([^/]+)(\/poll)?$/);
      if (sm) {
        await ensureSchema(env.DB);
        const key = decodeURIComponent(sm[1]);
        if (sm[2] && request.method === 'POST') return screenPoll(request, env, key);
        if (!sm[2] && request.method === 'GET') return screenData(env, key);
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

function needMedia(env) {
  if (!env.MEDIA) throw new HttpError(503, 'אחסון הקבצים (R2) לא מחובר ב-Cloudflare');
  return env.MEDIA;
}

// ---------- הדף של המסך ----------

async function screenPage(request, env) {
  // אותו דף לכל המסכים; הדף קורא את המזהה מהכתובת
  const res = await env.ASSETS.fetch(new URL('/screen', request.url));
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-cache');
  return out;
}

async function serveMedia(request, env, key) {
  if (!env.MEDIA || !/^[a-z0-9]+\/[a-z0-9]+\.[a-z0-9]+$/.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');   // שם הקובץ לא משתנה לעולם
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  let status = 200;
  if (obj.range && request.headers.has('range')) {
    const off = obj.range.offset ?? (obj.size - obj.range.suffix);
    const len = obj.range.length ?? (obj.size - off);
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    status = 206;
  } else {
    headers.set('content-length', String(obj.size));
  }
  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
}

async function screenPoll(request, env, key) {
  let info = null;
  try {
    const b = await readJson(request);
    if (b.w) info = {
      w: Number(b.w) || null, h: Number(b.h) || null, v: String(b.v || '').slice(0, 60),
      ua: String(request.headers.get('user-agent') || '').slice(0, 200),
    };
  } catch { info = null; }
  const p = await pollScreen(env.DB, key, info);
  if (!p) return json({ ok: false, error: 'המסך לא נמצא', notFound: true }, 404);
  return json({ ok: true, rev: p.rev, version: version(env), cmd: p.cmd });
}

async function screenData(env, key) {
  const screen = await findScreen(env.DB, key);
  if (!screen) return json({ ok: false, error: 'המסך לא נמצא', notFound: true }, 404);
  const s = screen.settings;
  const today = isoToday(s.location.tz);
  const days = buildDays(today, DAYS_AHEAD, s);
  const last = days[days.length - 1].date;

  const [global, own, poll, media] = await Promise.all([
    getContent(env.DB, 'global'), getContent(env.DB, screen.id), pollScreen(env.DB, screen.id, null),
    listMedia(env.DB, s.showGlobalMedia === false ? [screen.id] : ['global', screen.id]),
  ]);

  const content = {};
  const demo = {};
  for (const k of CONTENT_KEYS) {
    const c = own[k] || global[k] || null;
    content[k] = c ? c.data : null;
  }
  if (!content.tefilot) { content.tefilot = demoTefilot(days); demo.tefilot = true; }

  const inRange = (it) => (!it.from || it.from <= last) && (!it.to || it.to >= today);
  const onDays = (it) => !it.date || (it.date >= today && it.date <= last);
  if (content.tefilot && Array.isArray(content.tefilot.items)) content.tefilot.items = content.tefilot.items.filter(onDays);
  if (content.announcements && Array.isArray(content.announcements.items)) {
    content.announcements.items = content.announcements.items.filter(inRange);
  }
  if (content.parnes && Array.isArray(content.parnes.items)) content.parnes.items = content.parnes.items.filter(onDays);

  // קבצים: קודם של כל המסכים, אחר כך של המסך הזה; רק פעילים ובטווח התאריכים
  const files = media
    .filter((m) => m.enabled && inRange(m))
    .sort((a, b) => (a.scope === b.scope ? a.sort - b.sort : a.scope === 'global' ? -1 : 1))
    .map((m) => ({ id: m.id, kind: m.kind, url: m.url, w: m.w, h: m.h, title: m.title,
      seconds: m.seconds, full: m.full, from: m.from, to: m.to }));

  const alert = screen.alert && (!screen.alert.until || Date.parse(screen.alert.until) > Date.now()) ? screen.alert : null;

  return json({
    ok: true,
    version: version(env),
    rev: poll.rev,
    serverTime: new Date().toISOString(),
    screen: { id: screen.id, slug: screen.slug, name: screen.name, settings: s },
    zmanimLabels: Object.fromEntries(ZMANIM.map((z) => [z.key, z.label])),
    days,
    content,
    media: files,
    alert,
    demo,
  });
}

// ---------- בדיקת קלט ----------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 60) throw new HttpError(400, 'שם המסך חייב להיות בין 1 ל-60 תווים');
  return n;
}

function cleanSlug(slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new HttpError(400, 'כתובת המסך: אותיות באנגלית, ספרות ומקפים בלבד (עד 40 תווים)');
  if (RESERVED.has(s)) throw new HttpError(400, `המילה "${s}" שמורה למערכת — בחר כתובת אחרת`);
  return s;
}

function cleanDate(v) {
  if (v == null || v === '') return null;
  if (!DATE_RE.test(String(v))) throw new HttpError(400, `תאריך לא תקין: ${v} (צריך YYYY-MM-DD)`);
  return String(v);
}

function cleanSettings(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object') throw new HttpError(400, 'הגדרות לא תקינות');
  const out = {};
  const str = (k, max = 120) => { if (k in input) out[k] = String(input[k] ?? '').slice(0, max); };
  const bool = (k) => { if (k in input) out[k] = !!input[k]; };
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
  const hm = (k) => {
    if (!(k in input)) return;
    const v = String(input[k] ?? '').trim();
    if (v && !HM_RE.test(v)) throw new HttpError(400, `שעה לא תקינה: ${v} (צריך HH:MM)`);
    out[k] = v;
  };
  str('title'); str('subtitle');
  oneOf('orientation', ['auto', 'landscape', 'portrait']);
  oneOf('theme', ['navy', 'cream', 'burgundy']);
  for (const k of ['clock24', 'hour12', 'showSeconds', 'showTefilot', 'showZmanim', 'showTicker', 'showParnes',
    'showGlobalMedia']) bool(k);
  num('candleMinutes', 0, 90); num('havdalahMinutes', 0, 120); num('tzeitMinutes', 0, 120); num('slideSeconds', 3, 300);
  hm('sleepFrom'); hm('sleepTo');
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
  const txt = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const date = (v) => cleanDate(v) || undefined;
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

function cleanMediaPatch(b) {
  const p = {};
  if ('title' in b) p.title = String(b.title ?? '').trim().slice(0, 120);
  if ('seconds' in b) {
    if (b.seconds == null || b.seconds === '') p.seconds = null;
    else {
      const v = Number(b.seconds);
      if (!Number.isFinite(v) || v < 2 || v > 600) throw new HttpError(400, 'זמן תצוגה: בין 2 ל-600 שניות');
      p.seconds = Math.round(v);
    }
  }
  if ('full' in b) p.full = !!b.full;
  if ('enabled' in b) p.enabled = !!b.enabled;
  if ('from' in b) p.from = cleanDate(b.from);
  if ('to' in b) p.to = cleanDate(b.to);
  return p;
}

// ---------- ניהול ----------

async function checkScope(db, scope) {
  if (scope === 'global') return scope;
  const s = await findScreen(db, scope);
  if (!s || s.id !== scope) throw new HttpError(404, 'המסך לא נמצא');
  return scope;
}

async function removeObjects(env, keys) {
  if (!env.MEDIA || !keys.length) return;
  const unused = [];
  for (const k of new Set(keys)) if ((await mediaUsingKey(env.DB, k)) === 0) unused.push(k);
  if (unused.length) await env.MEDIA.delete(unused);
}

async function admin(request, env, parts, url) {
  const db = env.DB;
  const m = request.method;
  try {
    // GET /api/admin/meta — מה אפשר להגדיר
    if (parts[0] === 'meta' && m === 'GET') {
      return json({ ok: true, version: version(env), zmanim: ZMANIM, defaults: DEFAULT_SETTINGS,
        contentKeys: CONTENT_KEYS, storage: !!env.MEDIA, commands: COMMANDS });
    }

    if (parts[0] === 'screens') {
      const id = parts[1];
      if (!id && m === 'GET') return json({ ok: true, screens: await listScreens(db), now: new Date().toISOString() });
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
        const sub = parts[2];

        // POST /api/admin/screens/<id>/command  {"type": "reload" | "refresh" | "identify"}
        if (sub === 'command' && m === 'POST') {
          const b = await readJson(request);
          if (!COMMANDS.includes(b.type)) throw new HttpError(400, 'פקודה לא מוכרת');
          await setScreenField(db, id, 'cmd', { id: crypto.randomUUID(), type: b.type, at: new Date().toISOString() });
          return json({ ok: true });
        }
        // PUT /api/admin/screens/<id>/alert  {"text": "...", "minutes": 10}   |   DELETE
        if (sub === 'alert' && m === 'PUT') {
          const b = await readJson(request);
          const text = String(b.text ?? '').trim().slice(0, 300);
          if (!text) throw new HttpError(400, 'חסר טקסט להודעה');
          const minutes = Number(b.minutes) || 0;
          if (minutes < 0 || minutes > 7 * 24 * 60) throw new HttpError(400, 'משך לא תקין');
          const until = minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null;
          await setScreenField(db, id, 'alert', { text, until });
          return json({ ok: true, until });
        }
        if (sub === 'alert' && m === 'DELETE') { await setScreenField(db, id, 'alert', null); return json({ ok: true }); }

        if (!sub && m === 'GET') return json({ ok: true, screen });
        if (!sub && m === 'PATCH') {
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
        if (!sub && m === 'DELETE') {
          const rows = await mediaOfScreen(db, id);
          await deleteMediaRows(db, rows.map((r) => r.id));
          await removeObjects(env, rows.map((r) => r.r2key));
          await deleteScreen(db, id);
          return json({ ok: true });
        }
      }
    }

    // /api/admin/content/<global|מזהה מסך>[/<סוג>]
    if (parts[0] === 'content' && parts[1]) {
      const scope = await checkScope(db, parts[1]);
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

    // ---------- קבצים ----------
    if (parts[0] === 'media') {
      const id = parts[1];
      // GET /api/admin/media?scope=global
      if (!id && m === 'GET') {
        const scope = await checkScope(db, url.searchParams.get('scope') || 'global');
        return json({ ok: true, media: await listMedia(db, [scope]) });
      }
      // POST /api/admin/media?scope=..&title=..&w=..&h=..&group=..   גוף הבקשה = הקובץ עצמו
      if (!id && m === 'POST') {
        const bucket = needMedia(env);
        const q = url.searchParams;
        const scope = await checkScope(db, q.get('scope') || 'global');
        const mime = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const type = UPLOAD_TYPES[mime];
        if (!type) throw new HttpError(415, 'סוג קובץ לא נתמך (תמונות JPG/PNG/WEBP/GIF או סרטון MP4/WEBM)');
        const len = Number(request.headers.get('content-length') || 0);
        if (!len) throw new HttpError(411, 'חסר גודל קובץ');
        if (len > type[2] * 1024 * 1024) throw new HttpError(413, `הקובץ גדול מדי (עד ${type[2]}MB)`);
        const r2key = `${scope === 'global' ? 'global' : scope}/${crypto.randomUUID().replace(/-/g, '')}.${type[1]}`;
        await bucket.put(r2key, request.body, { httpMetadata: { contentType: mime } });
        const intq = (k) => { const v = Number(q.get(k)); return Number.isFinite(v) && v > 0 ? Math.round(v) : null; };
        const patch = cleanMediaPatch({
          title: q.get('title') || '', ...(q.get('seconds') ? { seconds: q.get('seconds') } : {}),
          full: q.get('full') === '1', from: q.get('from') || null, to: q.get('to') || null,
        });
        const item = await addMedia(db, {
          scope, kind: type[0], r2key, mime, size: len, w: intq('w'), h: intq('h'),
          title: patch.title, seconds: patch.seconds, full: patch.full, from: patch.from, to: patch.to,
          group: (q.get('group') || '').slice(0, 40) || null,
        });
        return json({ ok: true, media: item }, 201);
      }
      // POST /api/admin/media/order  {"scope": "...", "ids": [...]}
      if (id === 'order' && m === 'POST') {
        const b = await readJson(request);
        const scope = await checkScope(db, b.scope || 'global');
        if (!Array.isArray(b.ids) || b.ids.length > 1000) throw new HttpError(400, 'רשימה לא תקינה');
        await reorderMedia(db, scope, b.ids.map(String));
        return json({ ok: true });
      }
      if (id && m === 'PATCH') {
        const item = await updateMedia(db, id, cleanMediaPatch(await readJson(request)));
        if (!item) throw new HttpError(404, 'הקובץ לא נמצא');
        return json({ ok: true, media: item });
      }
      if (id && m === 'DELETE') {
        const item = await deleteMedia(db, id);
        if (!item) throw new HttpError(404, 'הקובץ לא נמצא');
        await removeObjects(env, [item.r2key]);
        return json({ ok: true });
      }
    }
    throw new HttpError(404, 'לא נמצא');
  } catch (err) {
    if (err instanceof HttpError) return json({ ok: false, error: err.message }, err.status);
    if (String(err).includes('UNIQUE')) return json({ ok: false, error: 'הכתובת הזאת כבר תפוסה' }, 409);
    throw err;
  }
}
