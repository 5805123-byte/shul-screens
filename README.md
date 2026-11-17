# מסכי בית הכנסת

אתר שמוצג על מסכים בבית הכנסת: שעון, תאריך עברי, פרשה, זמני היום, זמני תפילה,
פרנס היום, תורמים והודעות. רץ על **Cloudflare Workers** (המסלול החינמי מספיק),
בנפרד מה-CRM — כך שגם כשה-CRM מתעדכן (502), המסכים ממשיכים לעבוד.

## איך זה בנוי

| מה | איפה |
|----|------|
| הדף של המסך | `/<כתובת>` או `/<מזהה קבוע>` (למשל `/hall`) |
| דף ניהול (יצירת מסכים, שינוי שם, הודעות) | `/admin` |
| הנתונים של מסך (ציבורי) | `GET /api/screen/<מזהה>` |
| ניהול דרך API (בשביל ה-CRM) | `/api/admin/...` עם `Authorization: Bearer <ADMIN_KEY>` |

- **כל מסך** מקבל שם וכתובת שאתה בוחר ויכול לשנות בכל זמן, וגם **מזהה קבוע**
  (למשל `m4tikfetk`) שלא משתנה לעולם. במחשב שמציג כדאי לשים את הכתובת עם המזהה הקבוע.
- **זמני היום** מחושבים לפי ביתר עילית, בגובה פני הים — אותו חישוב כמו ב-CRM.
  הדלקת נרות 40 דקות לפני השקיעה, צאת הכוכבים 18 דקות אחריה (אפשר לשנות לכל מסך).
- **אף פעם לא מוצג דף שגיאה:** הדף שומר את המידע האחרון. אם השרת לא עונה, ממשיכים
  להציג אותו (נקודה אדומה קטנה בפינה מסמנת שאין חיבור). הדף גם מתרענן לבד אחרי עדכון
  של האתר — אבל רק אחרי שבדק שהשרת עונה כמו שצריך.
- **זמני תפילה:** עד שה-CRM ישלח את הזמנים האמיתיים, מוצגים זמנים לדוגמה עם התווית
  "זמנים לדוגמה". אפשר גם להקליד זמנים ידנית בדף הניהול.

## חיבור ל-Cloudflare (פעם אחת)

1. נכנסים ל-[dash.cloudflare.com](https://dash.cloudflare.com) (חשבון חינמי, לא צריך דומיין).
2. בתפריט: **Workers & Pages** ← **Create** ← לשונית **Workers** ← **Import a repository**.
3. מחברים את GitHub (אם מבקש) ובוחרים את הריפו **shul-screens** (שם הריפו נשאר כמו שהוא).
4. בהגדרות:
   - **Project name:** `tv` — חייב להיות בדיוק השם הזה.
   - **Build command:** להשאיר ריק.
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/`
5. **Create and deploy.** בפריסה הראשונה Cloudflare יוצר לבד את מסד הנתונים.
6. אחרי שהפריסה הצליחה: נכנסים ל-Worker ← **Settings** ← **Variables and Secrets** ← **Add**:
   - Type: **Secret**
   - Name: `ADMIN_KEY`
   - Value: סיסמה ארוכה שתבחר (זאת הסיסמה לדף הניהול, וה-CRM ישתמש בה).
7. הכתובת של האתר מופיעה בדף ה-Worker, בצורה `https://tv.<השם-שלך>.workers.dev`.
   נכנסים ל-`/admin`, מקלידים את הסיסמה, ויוצרים את המסך הראשון.

מכאן והלאה: **כל עדכון שנדחף לענף `main` בגיטהאב עולה לאתר לבד.**

## API לניהול (בשביל ה-CRM)

כל הבקשות עם הכותרת `Authorization: Bearer <ADMIN_KEY>` ו-JSON.

| בקשה | מה עושה |
|------|---------|
| `GET /api/admin/screens` | רשימת המסכים |
| `POST /api/admin/screens` `{"name","slug","settings"?}` | מסך חדש |
| `PATCH /api/admin/screens/<id>` `{"name"?,"slug"?,"settings"?}` | שינוי שם / כתובת / הגדרות |
| `DELETE /api/admin/screens/<id>` | מחיקת מסך |
| `GET /api/admin/content/<global או id>` | התוכן שמור |
| `PUT /api/admin/content/<global או id>/<סוג>` `{"items":[...], "title"?}` | החלפת תוכן |
| `DELETE /api/admin/content/<global או id>/<סוג>` | מחיקת תוכן |
| `GET /api/admin/meta` | רשימת זמני היום וההגדרות האפשריות |

`global` = לכל המסכים. מזהה של מסך = רק לו (גובר על הכללי).

סוגי התוכן:

| סוג | פריט |
|-----|------|
| `tefilot` | `{"date":"2026-11-21"?, "label":"שחרית", "time":"08:00", "note"?}` — שעה ב-24 שעות; בלי תאריך = כל יום |
| `announcements` | `{"text":"...", "from":"2026-11-20"?, "to":"2026-11-25"?}` |
| `donors` | `{"name":"...", "note"?}` |
| `parnes` | `{"date":"2026-11-18"?, "text":"..."}` |

הגדרות מסך (`settings`): `title`, `subtitle`, `orientation` (`auto`/`landscape`/`portrait`),
`theme` (`navy`/`cream`/`burgundy`), `hour12`, `showSeconds`, `slideSeconds`,
`candleMinutes`, `havdalahMinutes`, `tzeitMinutes`, `zmanim` (רשימה מתוך `/api/admin/meta`),
`location` (`name`, `lat`, `lon`, `tz`).

## פיתוח מקומי

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev      # http://localhost:8787/admin
npm test         # בדיקות לחישוב התאריכים והזמנים
npm run check    # בדיקה שהפריסה תעבוד, בלי לפרוס
```

## מה בהמשך

- ה-CRM שולח לכאן זמני תפילה, פרנס היום ותורמים (דחיפה, לא משיכה).
- העלאת תמונות ו-PDF שמתחלפים על המסך.
- לשונית "מסכים" ב-CRM.
- תוכנה למחשבי Windows: פותחת את המסך במסך מלא, שומרת שהוא חי, ומקבלת פקודות
  (רענון, הפעלה מחדש) מה-CRM.
