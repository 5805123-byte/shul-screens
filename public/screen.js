// מסך בית הכנסת — הדף שרץ על המחשב.
// עיקרון: המסך לעולם לא מציג דף שגיאה. אם השרת לא עונה, ממשיכים להציג את המידע האחרון ששמור.
//
// כל 15 שניות: בדיקה קטנה (poll) — האם התוכן השתנה, האם יש פקודה (רענון / זיהוי), האם עלתה גרסה חדשה.
// רק אם משהו השתנה מורידים את כל הנתונים. בנוסף, הורדה מלאה כל 10 דקות.
(function () {
  'use strict';

  const KEY = decodeURIComponent((location.pathname.match(/^\/(?:s\/)?([^/]+)\/?$/) || [])[1] || '');
  const PREVIEW = new URLSearchParams(location.search).has('preview');   // תצוגה מקדימה בדף הניהול
  const CACHE = 'screen-data:' + KEY;
  const CMD_KEY = 'screen-cmd:' + KEY;
  const POLL_MS = 15 * 1000;
  const FULL_MS = 10 * 60 * 1000;
  const $ = (id) => document.getElementById(id);

  let data = null;          // הנתונים האחרונים מהשרת
  let pageVersion = null;   // גרסת האתר שהדף נטען איתה
  let lastFull = 0;
  let lastMinute = '';
  let slidesSig = '';
  let tickerSig = '';

  // ---------- עזרים ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* אין מקום — לא נורא */ } },
  };
  const settings = () => (data ? data.screen.settings : {});
  const tz = () => (data && data.screen.settings.location.tz) || 'Asia/Jerusalem';

  function nowParts() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, h: +p.hour, m: +p.minute, s: p.second };
  }

  const isTime = (t) => /^\d{1,2}:\d{2}$/.test(String(t || '').trim());
  const norm = (t) => { const [h, m] = String(t).trim().split(':'); return h.padStart(2, '0') + ':' + m; };
  function fmt(t) {
    if (!isTime(t)) return esc(t || '');
    const [h, m] = norm(t).split(':').map(Number);
    const hh = settings().hour12 ? (h % 12 || 12) : String(h).padStart(2, '0');
    return `${hh}:${String(m).padStart(2, '0')}`;
  }

  async function fetchJson(url, opts = {}, ms = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal, ...opts });
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    } finally { clearTimeout(t); }
  }

  function showMessage(text) {
    $('message').textContent = text;
    $('message').hidden = false;
    $('app').hidden = true;
  }

  // ---------- טעינה ----------
  async function loadFull() {
    if (!KEY) { showMessage('חסרה כתובת מסך'); return; }
    let res;
    try { res = await fetchJson('/api/screen/' + encodeURIComponent(KEY)); } catch { res = null; }

    if (res && res.status === 200 && res.body && res.body.ok) {
      $('offline').hidden = true;
      lastFull = Date.now();
      data = res.body;
      ls.set(CACHE, JSON.stringify(data));
      if (pageVersion === null) pageVersion = data.version;
      else if (data.version !== pageVersion) return safeReload();
      render();
      return;
    }
    if (res && res.status === 404 && res.body && res.body.notFound) {
      showMessage('המסך "' + KEY + '" לא נמצא. בדקו את הכתובת בדף הניהול.');
      return;
    }
    offline();
  }

  // השרת לא זמין (עדכון, תקלה, אין אינטרנט) — ממשיכים עם מה שיש
  function offline() {
    $('offline').hidden = false;
    if (!data) {
      try { data = JSON.parse(ls.get(CACHE)); } catch { data = null; }
      if (data) render();
      else showMessage('מתחבר לשרת…');
    }
  }

  async function poll() {
    if (!KEY) return;
    if (!data || Date.now() - lastFull > FULL_MS) return loadFull();
    let res;
    try {
      res = await fetchJson('/api/screen/' + encodeURIComponent(KEY) + '/poll', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PREVIEW ? {} : { w: screen.width, h: screen.height, v: pageVersion }),
      });
    } catch { res = null; }
    if (!res || res.status !== 200 || !res.body || !res.body.ok) {
      if (res && res.status === 404 && res.body && res.body.notFound) return loadFull();
      return offline();
    }
    $('offline').hidden = true;
    const p = res.body;
    if (p.cmd && runCommand(p.cmd)) return;
    if (pageVersion && p.version !== pageVersion) return safeReload();
    if (p.rev !== data.rev) return loadFull();
  }

  // פקודות מדף הניהול. מחזיר true אם הדף עומד להתרענן.
  function runCommand(cmd) {
    if (!cmd.id || ls.get(CMD_KEY) === cmd.id) return false;
    ls.set(CMD_KEY, cmd.id);
    if (PREVIEW) return false;
    if (Date.now() - Date.parse(cmd.at) > 10 * 60 * 1000) return false;   // פקודה ישנה — מתעלמים
    if (cmd.type === 'reload') { safeReload(); return true; }
    if (cmd.type === 'refresh') { loadFull(); return true; }
    if (cmd.type === 'identify') identify();
    return false;
  }

  function identify() {
    const el = $('identify');
    el.innerHTML = `<b>${esc(data.screen.name)}</b><span>${esc(location.host + '/' + data.screen.slug)}</span>`
      + `<span>${screen.width}×${screen.height}</span>`;
    el.hidden = false;
    clearTimeout(identify.t);
    identify.t = setTimeout(() => { el.hidden = true; }, 15000);
  }

  // רענון הדף רק אחרי שווידאנו שהשרת עונה כמו שצריך — כדי שלא ייתקע דף שגיאה על המסך
  async function safeReload() {
    try {
      const r = await fetch(location.pathname, { cache: 'no-store' });
      if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) { location.reload(); return; }
    } catch { /* לא עכשיו */ }
    render();
  }

  // ---------- תצוגה ----------
  function applyLayout() {
    const s = settings();
    let o = s.orientation || 'auto';
    if (o === 'auto') o = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
    const cls = [`theme-${s.theme || 'navy'}`, o];
    if (s.showTefilot === false) cls.push('no-tefilot');
    if (s.showZmanim === false) cls.push('no-zmanim');
    if (s.showTicker === false) cls.push('no-ticker');
    if (s.showParnes === false) cls.push('no-parnes');
    if (document.body.classList.contains('idle')) cls.push('idle');
    document.body.className = cls.join(' ');
  }

  function render() {
    if (!data) return;
    const s = settings();
    applyLayout();
    $('message').hidden = true;
    $('app').hidden = false;
    document.title = data.screen.name;
    $('title').textContent = s.title || '';
    $('subtitle').textContent = s.subtitle || '';
    lastMinute = '';
    tick();
    renderSlides();
    renderTicker();
  }

  function today() {
    const n = nowParts();
    const days = data.days || [];
    const i = days.findIndex((d) => d.date === n.date);
    return { n, day: days[i >= 0 ? i : days.length - 1], next: i >= 0 ? days[i + 1] : null };
  }

  function inSleep(hm) {
    const { sleepFrom: a, sleepTo: b } = settings();
    if (!a || !b || a === b) return false;
    return a < b ? (hm >= a && hm < b) : (hm >= a || hm < b);
  }

  // נקרא כל שנייה; את רוב הדף מעדכנים רק פעם בדקה
  function tick() {
    if (!data) return;
    const { n, day, next } = today();
    const s = settings();
    const hh = s.clock24 === false ? (n.h % 12 || 12) : String(n.h).padStart(2, '0');
    $('clock').innerHTML = `${hh}:${String(n.m).padStart(2, '0')}` + (s.showSeconds !== false ? `<span class="sec">${n.s}</span>` : '');
    if (n.hm === lastMinute || !day) return;
    lastMinute = n.hm;

    $('sleep').hidden = PREVIEW || !inSleep(n.hm);
    renderAlert();
    $('hebrew').textContent = `יום ${day.weekday}, ${day.hebrew}`;
    $('greg').textContent = day.gregorian;
    $('parsha').textContent = day.weekParsha || '';
    renderSpecial(day, next);
    renderTefilot(day, next, n.hm);
    renderZmanim(day, n.hm);
    renderParnes(day);
    fitList($('tefilot'));
    fitList($('zmanim'));
  }

  // מקטין את הכתב עד שכל השורות נכנסות בחלון
  function fitList(ul) {
    if (!ul.offsetParent) return;
    let k = 1;
    ul.style.setProperty('--k', k);
    while (ul.scrollHeight > ul.clientHeight + 1 && k > 0.45) {
      k -= 0.05;
      ul.style.setProperty('--k', k.toFixed(2));
    }
  }

  function renderAlert() {
    const a = data.alert;
    const on = a && a.text && (!a.until || Date.parse(a.until) > Date.now());
    $('alert').hidden = !on;
    if (on) $('alert').textContent = a.text;
  }

  function renderSpecial(day, next) {
    const el = $('special');
    let name = '';
    const times = [];
    if (day.isShabbat) {
      name = 'שבת קודש' + (day.parsha ? ' — ' + day.parsha : '');
      if (day.havdalah) times.push(['צאת השבת', day.havdalah]);
    } else if (day.candles) {
      name = (next && next.isShabbat ? 'ערב שבת קודש' : 'ערב חג') + (day.weekParsha && next && next.isShabbat ? ' — ' + day.weekParsha : '');
      times.push(['הדלקת נרות', day.candles]);
    }
    const hol = (day.holidays || []).join(' · ');
    if (hol) name = name ? `${esc(name)}<div style="font-size:.6em;margin-top:.2em">${esc(hol)}</div>` : esc(hol);
    else name = esc(name);
    if (day.havdalah && !day.isShabbat) times.push(['צאת החג', day.havdalah]);
    if (!name && !times.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<div class="name">${name}</div>` + (times.length
      ? `<div class="times">${times.map(([l, t]) => `<div>${esc(l)}<b>${fmt(t)}</b></div>`).join('')}</div>` : '');
  }

  function tefilotFor(date) {
    const items = ((data.content.tefilot || {}).items || []);
    return items.filter((it) => !it.date || it.date === date);
  }

  function renderTefilot(day, next, hm) {
    $('demoBadge').hidden = !(data.demo && data.demo.tefilot);
    $('tefilotTitle').textContent = (data.content.tefilot && data.content.tefilot.title) || 'זמני תפילה';
    const list = tefilotFor(day.date);
    const timed = list.filter((it) => isTime(it.time));
    const allPast = timed.length && timed.every((it) => norm(it.time) < hm);
    const rows = [];
    let marked = false;
    const row = (it, past) => {
      const isNext = !past && !marked && isTime(it.time);
      if (isNext) marked = true;
      return `<li class="${past ? 'past' : ''}${isNext ? ' next' : ''}"><span>${esc(it.label)}${it.note ? ` <small>${esc(it.note)}</small>` : ''}</span><span class="t">${fmt(it.time)}</span></li>`;
    };
    if (allPast && next) {
      // אחרי התפילה האחרונה של היום — מציגים את מחר
      rows.push(`<li class="day-head">מחר, יום ${esc(next.weekday)}</li>`);
      for (const it of tefilotFor(next.date)) rows.push(row(it, false));
    } else {
      for (const it of list) rows.push(row(it, isTime(it.time) && norm(it.time) < hm));
    }
    $('tefilot').innerHTML = rows.join('') || '<li class="past"><span>אין זמנים להיום</span></li>';
  }

  function renderZmanim(day, hm) {
    const keys = settings().zmanim || [];
    const labels = data.zmanimLabels || {};
    let marked = false;
    $('zmanim').innerHTML = keys.filter((k) => day.zmanim[k]).map((k) => {
      const t = day.zmanim[k];
      const past = t < hm;
      const isNext = !past && !marked;
      if (isNext) marked = true;
      return `<li class="${past ? 'past' : ''}${isNext ? ' next' : ''}"><span>${esc(labels[k] || k)}</span><span class="t">${fmt(t)}</span></li>`;
    }).join('');
  }

  function renderParnes(day) {
    const items = ((data.content.parnes || {}).items || []);
    const it = items.find((x) => x.date === day.date) || items.find((x) => !x.date);
    const el = $('parnes');
    if (!it || !it.text || settings().showParnes === false) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = /^פרנס/.test(it.text) ? it.text : 'פרנס היום: ' + it.text;
  }

  // ---------- שקופיות: קבצים, הודעות, תורמים ----------
  function buildSlides() {
    const c = data.content;
    const s = settings();
    const dflt = Math.max(3, Number(s.slideSeconds) || 12);
    const today = nowParts().date;
    const slides = [];
    for (const m of (data.media || [])) {
      if ((m.from && m.from > today) || (m.to && m.to < today)) continue;
      slides.push({ kind: m.kind, url: m.url, title: m.title, full: m.full, seconds: m.seconds || (m.kind === 'video' ? 0 : dflt) });
    }
    for (const a of ((c.announcements || {}).items || [])) {
      if ((a.from && a.from > today) || (a.to && a.to < today)) continue;
      slides.push({ kind: 'html', seconds: dflt, html: `<div class="kicker">הודעות</div><div class="big">${esc(a.text)}</div>` });
    }
    const donors = ((c.donors || {}).items || []);
    for (let i = 0; i < donors.length; i += 8) {
      const chunk = donors.slice(i, i + 8);
      slides.push({ kind: 'html', seconds: dflt, html: `<div class="kicker">${esc((c.donors && c.donors.title) || 'תודה לתורמים')}</div><ul class="list">`
        + chunk.map((d) => `<li>${esc(d.name)}${d.note ? `<small>${esc(d.note)}</small>` : ''}</li>`).join('') + '</ul>' });
    }
    if (!slides.length) {
      slides.push({ kind: 'html', seconds: dflt, html: `<div class="kicker">ברוכים הבאים</div><div class="big">${esc(s.title || '')}</div>` });
    }
    return slides;
  }

  let player = { els: [], items: [], i: -1, timer: null };

  function renderSlides() {
    const items = buildSlides();
    const sig = JSON.stringify(items);
    if (sig === slidesSig) return;
    slidesSig = sig;
    clearTimeout(player.timer);
    $('slides').innerHTML = '';
    $('full').innerHTML = '';
    $('full').hidden = true;
    const els = items.map((it) => {
      const el = document.createElement('div');
      el.className = 'slide' + (it.kind === 'html' ? '' : ' media');
      if (it.kind === 'image') {
        el.innerHTML = `<img src="${esc(it.url)}" alt="">`;
      } else if (it.kind === 'video') {
        el.innerHTML = `<video src="${esc(it.url)}" muted playsinline preload="auto"></video>`;
      } else {
        el.innerHTML = it.html;
      }
      (it.full ? $('full') : $('slides')).appendChild(el);
      return el;
    });
    player = { els, items, i: -1, timer: null };
    next();
  }

  function next() {
    const { els, items } = player;
    if (!els.length) return;
    const prev = player.i;
    player.i = (player.i + 1) % els.length;
    const it = items[player.i];
    const el = els[player.i];
    if (prev >= 0 && prev !== player.i) {
      els[prev].classList.remove('on');
      const v = els[prev].querySelector('video');
      if (v) v.pause();
    }
    el.classList.add('on');
    $('full').hidden = !it.full;
    if (els.length === 1 && it.kind !== 'video') return;     // שקופית אחת — לא מחליפים
    clearTimeout(player.timer);
    if (it.kind === 'video') {
      const v = el.querySelector('video');
      try { v.currentTime = 0; } catch { /* עוד לא נטען */ }
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      if (it.seconds) player.timer = setTimeout(next, it.seconds * 1000);
      else {
        v.onended = () => { v.onended = null; next(); };
        player.timer = setTimeout(next, 5 * 60 * 1000);     // גיבוי — אם הסרטון נתקע
      }
    } else {
      player.timer = setTimeout(next, it.seconds * 1000);
    }
  }

  // ---------- פס רץ ----------
  let tickerX = 0;
  let tickerLast = 0;
  function renderTicker() {
    const c = data.content;
    const parts = ((c.announcements || {}).items || []).map((a) => a.text);
    const donors = ((c.donors || {}).items || []).map((d) => d.name);
    if (donors.length) parts.push('תודה לתורמים: ' + donors.join(' · '));
    const sig = JSON.stringify(parts);
    if (sig === tickerSig) return;
    tickerSig = sig;
    const html = parts.map((p) => `<span>${esc(p)}</span>`).join('');
    $('ticker').innerHTML = html ? html + html : '';   // פעמיים — כדי שהגלילה תהיה רציפה
    tickerX = 0;
  }
  function animateTicker(ts) {
    const track = $('ticker');
    if (track.firstChild && track.offsetParent) {
      const dt = tickerLast ? Math.min(100, ts - tickerLast) : 0;
      tickerX += (window.innerWidth / 16) * dt / 1000;       // פיקסלים לשנייה
      const half = track.scrollWidth / 2;
      if (half > 0 && tickerX >= half) tickerX -= half;
      track.style.transform = `translate(${tickerX}px, -50%)`;   // RTL: הטקסט נע ימינה
    }
    tickerLast = ts;
    requestAnimationFrame(animateTicker);
  }

  // ---------- העכבר: נעלם אחרי 3 שניות בלי תנועה ----------
  let idleTimer = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  ['mousemove', 'mousedown', 'touchstart', 'keydown'].forEach((e) => window.addEventListener(e, wake, { passive: true }));
  wake();

  // ---------- המסך לא נכבה ----------
  async function keepAwake() {
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch { /* לא נתמך */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  window.addEventListener('resize', () => { if (!data) return; applyLayout(); lastMinute = ''; tick(); });
  if (document.fonts) document.fonts.ready.then(() => { lastMinute = ''; tick(); });
  // כשגודל החלונות משתנה (הודעה דחופה, גופן שנטען) — מתאימים מחדש את גודל הכתב
  if (window.ResizeObserver) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { fitList($('tefilot')); fitList($('zmanim')); });
    }).observe(document.querySelector('.grid'));
  }

  // ---------- התחלה ----------
  try { data = JSON.parse(ls.get(CACHE)); } catch { data = null; }
  if (data) render();
  loadFull();
  setInterval(poll, POLL_MS);
  setInterval(tick, 1000);
  requestAnimationFrame(animateTicker);
  keepAwake();

  // רענון יומי ב-3 בלילה (רק אם השרת עונה) — שומר על המסך רענן לאורך זמן
  setInterval(() => {
    const n = nowParts();
    if (n.h === 3 && n.m === 0 && !PREVIEW) safeReload();
  }, 60 * 1000);

  if ('serviceWorker' in navigator && !PREVIEW) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
