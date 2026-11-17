// לוח היום: תאריך עברי, פרשה, חגים, הדלקת נרות / הבדלה, וזמני היום — לפי המיקום של המסך.
// הנץ והשקיעה מחושבים בגובה פני הים, כמו ב-CRM (server/zmanim.py), כדי שהזמנים יתאימו.
import { HDate, HebrewCalendar, Location, Zmanim, flags } from '@hebcal/core';

const LOCALE = 'he-x-NoNikud';

// זמני היום שאפשר להציג, בסדר הזה
export const ZMANIM = [
  { key: 'alot', label: 'עלות השחר' },
  { key: 'misheyakir', label: 'זמן ציצית ותפילין' },
  { key: 'sunrise', label: 'הנץ החמה' },
  { key: 'shmaMGA', label: 'סוף זמן ק"ש מג"א' },
  { key: 'shmaGRA', label: 'סוף זמן ק"ש גר"א' },
  { key: 'tfillaMGA', label: 'סוף זמן תפילה מג"א' },
  { key: 'tfillaGRA', label: 'סוף זמן תפילה גר"א' },
  { key: 'chatzot', label: 'חצות היום' },
  { key: 'minchaGedola', label: 'מנחה גדולה' },
  { key: 'minchaKetana', label: 'מנחה קטנה' },
  { key: 'plag', label: 'פלג המנחה' },
  { key: 'sunset', label: 'שקיעה' },
  { key: 'tzeit', label: 'צאת הכוכבים' },
  { key: 'tzeitRT', label: 'צאת הכוכבים ר"ת' },
  { key: 'chatzotNight', label: 'חצות הלילה' },
];

export const DEFAULT_ZMANIM = ['alot', 'misheyakir', 'sunrise', 'shmaMGA', 'shmaGRA', 'tfillaMGA', 'tfillaGRA',
  'chatzot', 'minchaGedola', 'plag', 'sunset', 'tzeit'];

const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// אירועים שלא מציגים על המסך
const SKIP_DESC = new Set(['Chag HaBanot']);
const SKIP_FLAGS = flags.MODERN_HOLIDAY | flags.DAF_YOMI | flags.OMER_COUNT | flags.MOLAD | flags.HEBREW_DATE
  | flags.MISHNA_YOMI | flags.YERUSHALMI_YOMI | flags.NACH_YOMI | flags.DAILY_LEARNING | flags.KIDDUSH_LEVANA
  | flags.YOM_KIPPUR_KATAN;

/** "YYYY-MM-DD" של היום לפי אזור הזמן */
export function isoToday(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Date מקומי (שעה 12) עבור hebcal — שבונה תאריכים מהשנה/חודש/יום המקומיים
function localDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

function hhmm(date, tz) {
  if (!date || isNaN(date)) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function plusMinutes(date, min) {
  return date && !isNaN(date) ? new Date(date.getTime() + min * 60000) : null;
}

/**
 * לוח לכמה ימים, החל מ-startIso.
 * settings.location = {name, lat, lon, elevation, tz}
 */
export function buildDays(startIso, count, settings) {
  const loc = settings.location;
  const tz = loc.tz;
  const candleMins = Number(settings.candleMinutes) || 40;
  const havdalahMins = Number(settings.havdalahMinutes) || 40;
  const tzeitMins = Number(settings.tzeitMinutes) || 18;
  const location = new Location(loc.lat, loc.lon, true, tz, loc.name, 'IL', undefined, 0);
  const endIso = addDays(startIso, count - 1);

  const events = HebrewCalendar.calendar({
    start: localDate(startIso), end: localDate(endIso), location, il: true,
    candlelighting: true, candleLightingMins: candleMins, havdalahMins, sedrot: true,
  });

  const days = [];
  for (let i = 0; i < count; i++) {
    const iso = addDays(startIso, i);
    const d = localDate(iso);
    const hd = new HDate(d);
    const z = new Zmanim(location, d, false);
    const sunset = z.sunset();
    const zm = {
      alot: hhmm(z.alotHaShachar(), tz),
      misheyakir: hhmm(z.misheyakir(), tz),
      sunrise: hhmm(z.sunrise(), tz),
      shmaMGA: hhmm(z.sofZmanShmaMGA(), tz),
      shmaGRA: hhmm(z.sofZmanShma(), tz),
      tfillaMGA: hhmm(z.sofZmanTfillaMGA(), tz),
      tfillaGRA: hhmm(z.sofZmanTfilla(), tz),
      chatzot: hhmm(z.chatzot(), tz),
      minchaGedola: hhmm(z.minchaGedola(), tz),
      minchaKetana: hhmm(z.minchaKetana(), tz),
      plag: hhmm(z.plagHaMincha(), tz),
      sunset: hhmm(sunset, tz),
      tzeit: hhmm(plusMinutes(sunset, tzeitMins), tz),
      tzeitRT: hhmm(plusMinutes(sunset, 72), tz),
      chatzotNight: hhmm(z.chatzotNight(), tz),
    };

    const day = {
      date: iso,
      weekday: WEEKDAYS[d.getDay()],
      hebrew: hd.renderGematriya(true),
      gregorian: new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric' }).format(d),
      isShabbat: d.getDay() === 6,
      isYomTov: false,
      holidays: [],
      parsha: null,
      candles: null,
      havdalah: null,
      zmanim: zm,
    };

    for (const ev of events) {
      if (ev.getDate().greg().toDateString() !== d.toDateString()) continue;
      const desc = ev.getDesc();
      const fl = ev.getFlags();
      if (desc === 'Candle lighting') { day.candles = hhmm(ev.eventTime, tz); continue; }
      if (desc === 'Havdalah') { day.havdalah = hhmm(ev.eventTime, tz); continue; }
      if (fl & flags.PARSHA_HASHAVUA) { day.parsha = ev.render(LOCALE); continue; }
      if (fl & flags.CHAG) day.isYomTov = true;
      if (SKIP_DESC.has(desc) || (fl & SKIP_FLAGS)) continue;
      const name = ev.render(LOCALE);
      if (!day.holidays.includes(name)) day.holidays.push(name);
    }
    days.push(day);
  }

  // הפרשה של השבת הקרובה — כדי להציג "פרשת השבוע" בכל ימות השבוע
  const firstSat = days.find((x) => x.isShabbat && x.parsha);
  const weekParsha = firstSat ? firstSat.parsha : upcomingParsha(startIso, location);
  for (const x of days) x.weekParsha = weekParsha;
  return days;
}

function upcomingParsha(startIso, location) {
  const evs = HebrewCalendar.calendar({
    start: localDate(startIso), end: localDate(addDays(startIso, 14)), location, il: true, sedrot: true, noHolidays: true,
  });
  const p = evs.find((e) => e.getFlags() & flags.PARSHA_HASHAVUA);
  return p ? p.render(LOCALE) : null;
}

/** תפילות לדוגמה — מוצגות עד שה-CRM שולח את זמני התפילה האמיתיים */
export function demoTefilot(days) {
  const items = [];
  const minus = (t, m) => {
    if (!t) return null;
    const [h, mi] = t.split(':').map(Number);
    const x = h * 60 + mi - m;
    return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
  };
  for (const d of days) {
    if (d.isShabbat) {
      items.push({ date: d.date, label: 'שחרית', time: '08:00' });
      items.push({ date: d.date, label: 'מנחה', time: minus(d.zmanim.sunset, 40) });
      items.push({ date: d.date, label: 'ערבית מוצ"ש', time: d.havdalah || d.zmanim.tzeit });
      continue;
    }
    items.push({ date: d.date, label: 'שחרית כוותיקין', time: d.zmanim.sunrise });
    items.push({ date: d.date, label: 'שחרית', time: '07:00' });
    items.push({ date: d.date, label: 'שחרית', time: '08:00' });
    items.push({ date: d.date, label: 'מנחה', time: minus(d.zmanim.sunset, 15) });
    items.push({ date: d.date, label: 'ערבית', time: d.zmanim.tzeit });
    if (d.candles) items.push({ date: d.date, label: 'הדלקת נרות', time: d.candles });
  }
  return { items };
}
