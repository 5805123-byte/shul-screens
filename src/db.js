// מסד הנתונים (D1). הטבלאות נוצרות ומתעדכנות לבד בבקשה הראשונה — אין צורך להריץ שום פקודה.
import { DEFAULT_ZMANIM } from './days.js';

// כל שלב רץ פעם אחת. מוסיפים שלבים רק בסוף.
const MIGRATIONS = [
  [
    `CREATE TABLE IF NOT EXISTS screens (
       id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
       settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    // תוכן: scope = 'global' (לכל המסכים) או מזהה של מסך (רק לו, גובר על הכללי)
    `CREATE TABLE IF NOT EXISTS content (
       scope TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY (scope, key))`,
  ],
  [
    'ALTER TABLE screens ADD COLUMN seen_at TEXT',        // מתי המסך דיווח לאחרונה
    'ALTER TABLE screens ADD COLUMN seen_info TEXT',      // רזולוציה, גרסה, דפדפן
    'ALTER TABLE screens ADD COLUMN cmd TEXT',            // פקודה אחרונה (רענון, זיהוי)
    'ALTER TABLE screens ADD COLUMN alert TEXT',          // הודעה דחופה על כל המסך
    // תמונות / סרטונים / עמודי PDF
    `CREATE TABLE IF NOT EXISTS media (
       id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, r2key TEXT NOT NULL,
       mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, w INTEGER, h INTEGER,
       title TEXT NOT NULL DEFAULT '', seconds INTEGER, full INTEGER NOT NULL DEFAULT 0,
       enabled INTEGER NOT NULL DEFAULT 1, date_from TEXT, date_to TEXT, grp TEXT,
       sort REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS media_scope ON media (scope, sort)',
    // מספר גרסה של התוכן — המסך בודק אותו כל 15 שניות, ומוריד הכול רק כשהוא השתנה
    'CREATE TABLE IF NOT EXISTS revs (scope TEXT PRIMARY KEY, rev INTEGER NOT NULL)',
  ],
];

// סוגי התוכן שאפשר לשמור
export const CONTENT_KEYS = ['tefilot', 'announcements', 'donors', 'parnes'];

export const DEFAULT_SETTINGS = {
  title: 'בית הכנסת',
  subtitle: '',
  orientation: 'auto',           // auto (לפי המסך) | landscape | portrait
  theme: 'navy',                 // navy | cream | burgundy
  clock24: true,                 // השעון: 13:05 (או 1:05)
  hour12: false,                 // זמני התפילה והיום: 18:10 (או 6:10)
  showSeconds: true,
  location: { name: 'ביתר עילית', lat: 31.6966, lon: 35.1153, tz: 'Asia/Jerusalem' },
  candleMinutes: 40,             // הדלקת נרות: דקות לפני השקיעה (כמו ב-CRM)
  havdalahMinutes: 40,           // צאת השבת: דקות אחרי השקיעה
  tzeitMinutes: 18,              // צאת הכוכבים: דקות אחרי השקיעה (כמו ב-CRM)
  zmanim: DEFAULT_ZMANIM,
  slideSeconds: 12,
  // מה מוצג על המסך
  showTefilot: true,
  showZmanim: true,
  showTicker: true,
  showParnes: true,
  showGlobalMedia: true,         // להציג גם קבצים של "כל המסכים"
  // מסך שחור בשעות הלילה (ריק = אף פעם)
  sleepFrom: '',
  sleepTo: '',
};

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)').run();
  const row = await db.prepare("SELECT v FROM meta WHERE k = 'schema'").first();
  let ver = row ? Number(row.v) : 0;
  for (let i = ver; i < MIGRATIONS.length; i++) {
    for (const sql of MIGRATIONS[i]) {
      try { await db.prepare(sql).run(); } catch (err) {
        // שני שרתים שמריצים את אותו שלב בבת אחת — העמודה כבר קיימת, זה בסדר
        if (!/duplicate column/i.test(String(err && err.message))) throw err;
      }
    }
    ver = i + 1;
    await db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?1) ON CONFLICT (k) DO UPDATE SET v = ?1")
      .bind(String(ver)).run();
  }
  schemaReady = true;
}

const now = () => new Date().toISOString();

function randomId(prefix, n = 8) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return prefix + Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

/** מזהה קבוע למסך — לא משתנה גם כשמשנים שם או כתובת */
export const newId = () => randomId('m');

const parseJson = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };

function parseScreen(row) {
  if (!row) return null;
  return {
    id: row.id, slug: row.slug, name: row.name,
    settings: mergeSettings(parseJson(row.settings, {})),
    seen_at: row.seen_at || null,
    seen_info: parseJson(row.seen_info, null),
    cmd: parseJson(row.cmd, null),
    alert: parseJson(row.alert, null),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export function mergeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
  out.location = { ...DEFAULT_SETTINGS.location, ...((s && s.location) || {}) };
  return out;
}

// ---------- גרסת תוכן ----------

export async function bumpRev(db, scope) {
  await db.prepare('INSERT INTO revs (scope, rev) VALUES (?, 1) ON CONFLICT (scope) DO UPDATE SET rev = rev + 1')
    .bind(scope).run();
}

// ---------- מסכים ----------

export async function listScreens(db) {
  const { results } = await db.prepare('SELECT * FROM screens ORDER BY created_at').all();
  return results.map(parseScreen);
}

/** לפי מזהה קבוע או לפי הכתובת (slug) */
export async function findScreen(db, key) {
  const row = await db.prepare('SELECT * FROM screens WHERE id = ?1 OR slug = ?1 ORDER BY (id = ?1) DESC LIMIT 1')
    .bind(key).first();
  return parseScreen(row);
}

/** הבדיקה הקטנה שהמסך עושה כל 15 שניות: גרסת התוכן + פקודה + עדכון "נראה לאחרונה" */
export async function pollScreen(db, key, info) {
  const row = await db.prepare(`SELECT s.id, s.seen_at, s.cmd,
      (SELECT rev FROM revs WHERE scope = 'global') AS grev,
      (SELECT rev FROM revs WHERE scope = s.id) AS srev
    FROM screens s WHERE s.id = ?1 OR s.slug = ?1 ORDER BY (s.id = ?1) DESC LIMIT 1`).bind(key).first();
  if (!row) return null;
  // כותבים "נראה לאחרונה" לכל היותר פעם בדקה — חוסך כתיבות
  if (info && (!row.seen_at || Date.now() - Date.parse(row.seen_at) > 55000)) {
    await db.prepare('UPDATE screens SET seen_at = ?, seen_info = ? WHERE id = ?')
      .bind(now(), JSON.stringify(info), row.id).run();
  }
  return { id: row.id, rev: `${row.grev || 0}.${row.srev || 0}`, cmd: parseJson(row.cmd, null) };
}

export async function createScreen(db, { name, slug, settings }) {
  const id = newId();
  const t = now();
  await db.prepare('INSERT INTO screens (id, slug, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, slug, name, JSON.stringify(settings || {}), t, t).run();
  return findScreen(db, id);
}

export async function updateScreen(db, id, { name, slug, settings }) {
  const cur = await db.prepare('SELECT * FROM screens WHERE id = ?').bind(id).first();
  if (!cur) return null;
  let s = parseJson(cur.settings, {});
  if (settings) {
    const prevLoc = s.location || {};
    s = { ...s, ...settings };
    if (settings.location) s.location = { ...prevLoc, ...settings.location };
  }
  await db.prepare('UPDATE screens SET name = ?, slug = ?, settings = ?, updated_at = ? WHERE id = ?')
    .bind(name ?? cur.name, slug ?? cur.slug, JSON.stringify(s), now(), id).run();
  await bumpRev(db, id);
  return findScreen(db, id);
}

export async function setScreenField(db, id, field, value) {
  if (!['cmd', 'alert'].includes(field)) throw new Error('bad field');
  await db.prepare(`UPDATE screens SET ${field} = ? WHERE id = ?`)
    .bind(value == null ? null : JSON.stringify(value), id).run();
  await bumpRev(db, id);
}

export async function deleteScreen(db, id) {
  await db.batch([
    db.prepare('DELETE FROM screens WHERE id = ?').bind(id),
    db.prepare('DELETE FROM content WHERE scope = ?').bind(id),
    db.prepare('DELETE FROM revs WHERE scope = ?').bind(id),
  ]);
}

export async function slugTaken(db, slug, exceptId) {
  const row = await db.prepare('SELECT id FROM screens WHERE (slug = ?1 OR id = ?1) AND id != ?2 LIMIT 1')
    .bind(slug, exceptId || '').first();
  return !!row;
}

// ---------- תוכן (טקסט) ----------

export async function getContent(db, scope) {
  const { results } = await db.prepare('SELECT key, data, updated_at FROM content WHERE scope = ?').bind(scope).all();
  const out = {};
  for (const r of results) {
    const data = parseJson(r.data, null);
    if (data) out[r.key] = { data, updated_at: r.updated_at };
  }
  return out;
}

export async function putContent(db, scope, key, data) {
  await db.prepare(`INSERT INTO content (scope, key, data, updated_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT (scope, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind(scope, key, JSON.stringify(data), now()).run();
  await bumpRev(db, scope);
}

export async function deleteContent(db, scope, key) {
  await db.prepare('DELETE FROM content WHERE scope = ? AND key = ?').bind(scope, key).run();
  await bumpRev(db, scope);
}

// ---------- קבצים ----------

function parseMedia(r) {
  return {
    id: r.id, scope: r.scope, kind: r.kind, mime: r.mime, size: r.size, w: r.w, h: r.h,
    title: r.title, seconds: r.seconds, full: !!r.full, enabled: !!r.enabled,
    from: r.date_from || null, to: r.date_to || null, group: r.grp || null, sort: r.sort,
    url: '/media/' + r.r2key, created_at: r.created_at,
  };
}

export async function listMedia(db, scopes) {
  const marks = scopes.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT * FROM media WHERE scope IN (${marks}) ORDER BY sort, created_at`)
    .bind(...scopes).all();
  return results.map(parseMedia);
}

export async function getMedia(db, id) {
  const r = await db.prepare('SELECT * FROM media WHERE id = ?').bind(id).first();
  return r ? { ...parseMedia(r), r2key: r.r2key } : null;
}

export async function addMedia(db, m) {
  const id = randomId('f', 10);
  const max = await db.prepare('SELECT MAX(sort) AS s FROM media WHERE scope = ?').bind(m.scope).first();
  const sort = (max && max.s != null ? max.s : 0) + 1;
  await db.prepare(`INSERT INTO media (id, scope, kind, r2key, mime, size, w, h, title, seconds, full, enabled,
                      date_from, date_to, grp, sort, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .bind(id, m.scope, m.kind, m.r2key, m.mime, m.size, m.w ?? null, m.h ?? null, m.title, m.seconds ?? null,
      m.full ? 1 : 0, m.from ?? null, m.to ?? null, m.group ?? null, sort, now()).run();
  await bumpRev(db, m.scope);
  return getMedia(db, id);
}

export async function updateMedia(db, id, patch) {
  const cur = await getMedia(db, id);
  if (!cur) return null;
  const v = { ...cur, ...patch };
  await db.prepare(`UPDATE media SET title = ?, seconds = ?, full = ?, enabled = ?, date_from = ?, date_to = ?
                    WHERE id = ?`)
    .bind(v.title, v.seconds ?? null, v.full ? 1 : 0, v.enabled ? 1 : 0, v.from || null, v.to || null, id).run();
  await bumpRev(db, cur.scope);
  return getMedia(db, id);
}

export async function reorderMedia(db, scope, ids) {
  await db.batch(ids.map((id, i) => db.prepare('UPDATE media SET sort = ? WHERE id = ? AND scope = ?').bind(i + 1, id, scope)));
  await bumpRev(db, scope);
}

export async function deleteMedia(db, id) {
  const cur = await getMedia(db, id);
  if (!cur) return null;
  await db.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  await bumpRev(db, cur.scope);
  return cur;
}

/** כמה קבצים עוד משתמשים באותו קובץ באחסון (בדרך כלל 0) */
export async function mediaUsingKey(db, r2key) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM media WHERE r2key = ?').bind(r2key).first();
  return r ? r.n : 0;
}

export async function mediaOfScreen(db, screenId) {
  const { results } = await db.prepare('SELECT id, r2key FROM media WHERE scope = ?').bind(screenId).all();
  return results;
}

export async function deleteMediaRows(db, ids) {
  if (!ids.length) return;
  await db.batch(ids.map((id) => db.prepare('DELETE FROM media WHERE id = ?').bind(id)));
}
