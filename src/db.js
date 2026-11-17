// מסד הנתונים (D1). הטבלאות נוצרות לבד בבקשה הראשונה — אין צורך להריץ שום פקודה.
import { DEFAULT_ZMANIM } from './days.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS screens (
     id TEXT PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     settings TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // תוכן: scope = 'global' (לכל המסכים) או מזהה של מסך (רק לו, גובר על הכללי)
  `CREATE TABLE IF NOT EXISTS content (
     scope TEXT NOT NULL,
     key TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (scope, key)
   )`,
];

// סוגי התוכן שאפשר לשמור
export const CONTENT_KEYS = ['tefilot', 'announcements', 'donors', 'parnes'];

export const DEFAULT_SETTINGS = {
  title: 'בית הכנסת',
  subtitle: '',
  orientation: 'auto',           // auto (לפי המסך) | landscape | portrait
  theme: 'navy',                 // navy | cream | burgundy
  hour12: true,                  // 6:10 במקום 18:10 בזמנים
  showSeconds: true,
  location: { name: 'ביתר עילית', lat: 31.6966, lon: 35.1153, tz: 'Asia/Jerusalem' },
  candleMinutes: 40,             // הדלקת נרות: דקות לפני השקיעה (כמו ב-CRM)
  havdalahMinutes: 40,           // צאת השבת: דקות אחרי השקיעה
  tzeitMinutes: 18,              // צאת הכוכבים: דקות אחרי השקיעה (כמו ב-CRM)
  zmanim: DEFAULT_ZMANIM,
  slideSeconds: 12,
};

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

const now = () => new Date().toISOString();

/** מזהה קבוע למסך — לא משתנה גם כשמשנים שם או כתובת */
export function newId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'm' + Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

function parseScreen(row) {
  if (!row) return null;
  let s = {};
  try { s = JSON.parse(row.settings || '{}'); } catch { s = {}; }
  return {
    id: row.id, slug: row.slug, name: row.name,
    settings: mergeSettings(s),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export function mergeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
  out.location = { ...DEFAULT_SETTINGS.location, ...((s && s.location) || {}) };
  return out;
}

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
  let s = {};
  try { s = JSON.parse(cur.settings || '{}'); } catch { s = {}; }
  if (settings) {
    const prevLoc = s.location || {};
    s = { ...s, ...settings };
    if (settings.location) s.location = { ...prevLoc, ...settings.location };
  }
  await db.prepare('UPDATE screens SET name = ?, slug = ?, settings = ?, updated_at = ? WHERE id = ?')
    .bind(name ?? cur.name, slug ?? cur.slug, JSON.stringify(s), now(), id).run();
  return findScreen(db, id);
}

export async function deleteScreen(db, id) {
  await db.batch([
    db.prepare('DELETE FROM screens WHERE id = ?').bind(id),
    db.prepare('DELETE FROM content WHERE scope = ?').bind(id),
  ]);
}

export async function slugTaken(db, slug, exceptId) {
  const row = await db.prepare('SELECT id FROM screens WHERE (slug = ?1 OR id = ?1) AND id != ?2 LIMIT 1')
    .bind(slug, exceptId || '').first();
  return !!row;
}

export async function getContent(db, scope) {
  const { results } = await db.prepare('SELECT key, data, updated_at FROM content WHERE scope = ?').bind(scope).all();
  const out = {};
  for (const r of results) {
    try { out[r.key] = { data: JSON.parse(r.data), updated_at: r.updated_at }; } catch { /* שורה פגומה — מדלגים */ }
  }
  return out;
}

export async function putContent(db, scope, key, data) {
  await db.prepare(`INSERT INTO content (scope, key, data, updated_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT (scope, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind(scope, key, JSON.stringify(data), now()).run();
}

export async function deleteContent(db, scope, key) {
  await db.prepare('DELETE FROM content WHERE scope = ? AND key = ?').bind(scope, key).run();
}
