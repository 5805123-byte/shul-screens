// Service worker של המסך: אם השרת לא עונה או מחזיר שגיאה (למשל 502 בזמן עדכון),
// מגישים את העותק האחרון ששמור — כך שעל המסך לעולם לא יופיע דף שגיאה.
const CACHE = 'shul-screen-v1';
const SHELL = ['/screen', '/screen.css', '/screen.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // גופנים — מהמטמון קודם
  if (url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com') {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // הנתונים — הדף עצמו מטפל בזה

  // דף המסך וקבצי העיצוב — קודם מהרשת, ואם נכשל/שגיאה — מהמטמון
  const isScreenPage = req.mode === 'navigate' && url.pathname.startsWith('/s/');
  const cacheKey = isScreenPage ? '/screen' : url.pathname;
  if (!isScreenPage && !SHELL.includes(url.pathname)) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res.ok) { c.put(cacheKey, res.clone()); return res; }
      const hit = await c.match(cacheKey);
      return hit || res;
    } catch (err) {
      const hit = await c.match(cacheKey);
      if (hit) return hit;
      throw err;
    }
  })());
});
