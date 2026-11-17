// בדיקות ללוח היום: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDays, demoTefilot } from '../src/days.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

const S = DEFAULT_SETTINGS;

test('יום חול: תאריך עברי, פרשת השבוע, נץ ושקיעה כמו ב-CRM', () => {
  const [d] = buildDays('2026-11-17', 1, S);
  assert.equal(d.hebrew, 'ז׳ כסלו תשפ״ז');
  assert.equal(d.weekday, 'שלישי');
  assert.equal(d.weekParsha, 'פרשת ויצא');
  assert.equal(d.zmanim.sunrise, '06:09');
  assert.equal(d.zmanim.sunset, '16:39');
  assert.equal(d.zmanim.tzeit, '16:57');          // שקיעה + 18
  assert.equal(d.candles, null);
});

test('ערב שבת ושבת חנוכה: הדלקת נרות, צאת שבת, פרשה וחג', () => {
  const [fri, sat] = buildDays('2026-12-04', 2, S);
  assert.equal(fri.candles, '15:55');             // שקיעה - 40
  assert.ok(fri.holidays.some((h) => h.includes('חנוכה')));
  assert.equal(sat.isShabbat, true);
  assert.equal(sat.parsha, 'פרשת וישב');
  assert.equal(sat.havdalah, '17:16');
  assert.equal(fri.weekParsha, 'פרשת וישב');
});

test('לא מציגים חג הבנות; ראש חודש כן', () => {
  const [d] = buildDays('2026-12-10', 1, S);
  assert.ok(!d.holidays.includes('חג הבנות'));
  assert.ok(d.holidays.some((h) => h.includes('ראש חודש')));
});

test('תפילות לדוגמה לכל יום', () => {
  const days = buildDays('2026-12-04', 2, S);
  const t = demoTefilot(days).items;
  assert.ok(t.some((x) => x.date === '2026-12-04' && x.label === 'הדלקת נרות' && x.time === '15:55'));
  assert.ok(t.some((x) => x.date === '2026-12-05' && x.label === 'שחרית'));
});
