// מסך בית הכנסת — הדף שרץ על המחשב.
// עיקרון: המסך לעולם לא מציג דף שגיאה. אם השרת לא עונה, ממשיכים להציג את המידע האחרון ששמור.
(function () {
  'use strict';

  const KEY = decodeURIComponent((location.pathname.match(/^\/(?:s\/)?([^/]+)\/?$/) || [])[1] || '');
  const CACHE = 'screen-data:' + KEY;
  const POLL_MS = 60 * 1000;
  const $ = (id) => document.getElementById(id);

  let data = null;          // הנתונים האחרונים מהשרת
  let pageVersion = null;   // גרסת האתר שהדף נטען איתה
  let slideTimer = null;
  let slidesSig = '';
  let tickerSig = '';
  let lastMinute = '';

  // ---------- עזרים ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(CACHE)); } catch { return null; } },
    set(v) { try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch { /* אין מקום — לא נורא */ } },
  };
  const tz = () => (data && data.screen.settings.location.tz) || 'Asia/Jerusalem';
  const hour12 = () => !data || data.screen.settings.hour12 !== false;

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
    const hh = hour12() ? (h % 12 || 12) : h;
    return `${hh}:${String(m).padStart(2, '0')}`;
  }

  async function fetchJson(url, ms = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
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
  async function load() {
    if (!KEY) { showMessage('חסרה כתובת מסך'); return; }
    let res;
    try { res = await fetchJson('/api/screen/' + encodeURIComponent(KEY)); } catch { res = null; }

    if (res && res.status === 200 && res.body && res.body.ok) {
      $('offline').hidden = true;
      data = res.body;
      store.set(data);
      if (pageVersion === null) pageVersion = data.version;
      else if (data.version !== pageVersion) return safeReload();
      render();
      return;
    }
    if (res && res.status === 404 && res.body && res.body.notFound) {
      showMessage('המסך "' + KEY + '" לא נמצא. בדקו את הכתובת בדף הניהול.');
      return;
    }
    // השרת לא זמין (עדכון, תקלה, אין אינטרנט) — ממשיכים עם מה שיש
    $('offline').hidden = false;
    if (!data) {
      data = store.get();
      if (data) render();
      else showMessage('מתחבר לשרת…');
    }
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
  function render() {
    if (!data) return;
    const s = data.screen.settings;
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
  function applyLayout() {
    const s = data.screen.settings;
    let o = s.orientation || 'auto';
    if (o === 'auto') o = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
    document.body.className = `theme-${s.theme || 'navy'} ${o}`;
  }
  window.addEventListener('resize', () => { if (!data) return; applyLayout(); lastMinute = ''; tick(); });
  if (document.fonts) document.fonts.ready.then(() => { lastMinute = ''; tick(); });

  function today() {
    const n = nowParts();
    const days = data.days || [];
    const i = days.findIndex((d) => d.date === n.date);
    return { n, day: days[i >= 0 ? i : days.length - 1], next: i >= 0 ? days[i + 1] : null };
  }

  // נקרא כל שנייה; את רוב הדף מעדכנים רק פעם בדקה
  function tick() {
    if (!data) return;
    const { n, day, next } = today();
    const s = data.screen.settings;
    const hh = hour12() ? (n.h % 12 || 12) : String(n.h).padStart(2, '0');
    $('clock').innerHTML = `${hh}:${String(n.m).padStart(2, '0')}` + (s.showSeconds !== false ? `<span class="sec">${n.s}</span>` : '');
    if (n.hm === lastMinute || !day) return;
    lastMinute = n.hm;

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
    let k = 1;
    ul.style.setProperty('--k', k);
    while (ul.scrollHeight > ul.clientHeight + 1 && k > 0.45) {
      k -= 0.05;
      ul.style.setProperty('--k', k.toFixed(2));
    }
  }

  function renderSpecial(day, next) {
    const el = $('special');
    let name = '';
    const times = [];
    if (day.isShabbat) {
      name = 'שבת קודש' + (day.parsha ? ' — ' + day.parsha : '');
      if (day.havdalah) times.push(['צאת השבת', day.havdalah]);
    } else if (day.candles) {
      name = (next && next.isShabbat ? 'ערב שבת קודש' : 'ערב חג') + (day.weekParsha ? ' — ' + day.weekParsha : '');
      times.push(['הדלקת נרות', day.candles]);
    }
    const hol = (day.holidays || []).join(' · ');
    if (hol) name = name ? `${name}<div style="font-size:.6em;margin-top:.2em">${esc(hol)}</div>` : esc(hol);
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
    let list = tefilotFor(day.date);
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
    const keys = data.screen.settings.zmanim || [];
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
    if (!it || !it.text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = /^פרנס/.test(it.text) ? it.text : 'פרנס היום: ' + it.text;
  }

  // ---------- שקופיות ----------
  function buildSlides() {
    const c = data.content;
    const slides = [];
    for (const a of ((c.announcements || {}).items || [])) {
      slides.push(`<div class="kicker">הודעות</div><div class="big">${esc(a.text)}</div>`);
    }
    const donors = ((c.donors || {}).items || []);
    for (let i = 0; i < donors.length; i += 8) {
      const chunk = donors.slice(i, i + 8);
      slides.push(`<div class="kicker">${esc((c.donors && c.donors.title) || 'תודה לתורמים')}</div><ul class="list">`
        + chunk.map((d) => `<li>${esc(d.name)}${d.note ? `<small>${esc(d.note)}</small>` : ''}</li>`).join('') + '</ul>');
    }
    if (!slides.length) {
      const s = data.screen.settings;
      slides.push(`<div class="kicker">ברוכים הבאים</div><div class="big">${esc(s.title || '')}</div>`);
    }
    return slides;
  }

  function renderSlides() {
    const slides = buildSlides();
    const sig = JSON.stringify(slides) + data.screen.settings.slideSeconds;
    if (sig === slidesSig) return;
    slidesSig = sig;
    clearInterval(slideTimer);
    $('slides').innerHTML = slides.map((h, i) => `<div class="slide${i === 0 ? ' on' : ''}">${h}</div>`).join('');
    if (slides.length < 2) return;
    let i = 0;
    slideTimer = setInterval(() => {
      const els = $('slides').children;
      els[i].classList.remove('on');
      i = (i + 1) % els.length;
      els[i].classList.add('on');
    }, Math.max(3, Number(data.screen.settings.slideSeconds) || 12) * 1000);
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
    const track = $('ticker');
    const html = parts.map((p) => `<span>${esc(p)}</span>`).join('');
    track.innerHTML = html ? html + html : '';   // פעמיים — כדי שהגלילה תהיה רציפה
    tickerX = 0;
  }
  function animateTicker(ts) {
    const track = $('ticker');
    if (track.firstChild) {
      const dt = tickerLast ? Math.min(100, ts - tickerLast) : 0;
      const speed = window.innerWidth / 16;             // פיקסלים לשנייה
      tickerX += speed * dt / 1000;
      const half = track.scrollWidth / 2;
      if (half > 0 && tickerX >= half) tickerX -= half;
      track.style.transform = `translate(${tickerX}px, -50%)`;   // RTL: הטקסט נע מימין לשמאל
    }
    tickerLast = ts;
    requestAnimationFrame(animateTicker);
  }

  // ---------- המסך לא נכבה ----------
  async function keepAwake() {
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch { /* לא נתמך */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  // ---------- התחלה ----------
  data = store.get();
  if (data) render();
  load();
  setInterval(load, POLL_MS);
  setInterval(tick, 1000);
  requestAnimationFrame(animateTicker);
  keepAwake();

  // רענון יומי ב-3 בלילה (רק אם השרת עונה) — שומר על המסך רענן לאורך זמן
  setInterval(() => {
    const n = nowParts();
    if (n.h === 3 && n.m === 0) safeReload();
  }, 60 * 1000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
