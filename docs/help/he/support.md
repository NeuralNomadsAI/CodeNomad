# תמיכה ובנייה מקוד מקור

השתמשו במאגר לדיווחי תקלות, לגרסאות עדכניות ולתרומות. [מדריך פתרון הבעיות](troubleshooting.md) מכסה התאוששות בטוחה לפני דיווח על תקלה.

## דיווח על באג {#report-a-bug}

1. פתחו **הגדרות → מידע → אבחון**.
2. בחרו **דווח על באג** לפתיחת טופס דיווח התקלה ב־GitHub.
3. בדקו את פרטי הגרסה/הלקוח שמולאו מראש. הוסיפו שחזור מינימלי, התנהגות צפויה ותוצאה בפועל, ואז שלחו דרך GitHub.

הפעולה ממלאת מראש את גרסאות CodeNomad ו־OpenCode (לרבות שירות OpenCode הפועל כשהוא שונה מהגרסה המותקנת), את מערכת ההפעלה שלכם, את סוג הלקוח (עם ה־user agent של הדפדפן בדפדפן אינטרנט) ואת מערכת ההפעלה של השרת. היא אינה ממלאת מראש כתובות מאזינים, נתיבי סביבת עבודה, פרטי התחברות או טקסט שיחה. פתיחת הטופס אינה שליחת דיווח.

אם דרוש אבחון נוסף, **העתק ללוח** או **הורד .txt** מפיקים דוח נפרד. דוח מפורט זה יכול להכיל נתיבים מקומיים וכתובות רשת: בדקו והשחירו אותו לפני צירופו. צילום מסך או קטע יומן עדיין יכולים להכיל סודות גם כשדוח האבחון האוטומטי אינו כולל סודות אימות.

אם שדות טופס GitHub אינם תואמים, CodeNomad פותח דיווח רגיל עם אותם פרטי דוח. כשל זמני בקריאת הטופס אינו מונע את פתיחתו. תמיד אפשר להשתמש ידנית ב־[רשימת הדיווחים](https://github.com/NeuralNomadsAI/CodeNomad/issues).

## קהילה וגרסאות {#community}

| משאב | שימוש |
| --- | --- |
| [מאגר CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad) | קוד מקור, פעילות הפרויקט ותיעוד. |
| [דיווחים](https://github.com/NeuralNomadsAI/CodeNomad/issues) | חפשו דיווחים קיימים לפני פתיחת באג שניתן לשחזור או בקשת תכונה. |
| [בקשות משיכה](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | סקירת שינויים מוצעים או תיאום תרומה. |
| [הגרסה האחרונה](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | קובצי הורדה יציבים. |
| [כל הגרסאות](https://github.com/NeuralNomadsAI/CodeNomad/releases) | תצוגות מקדימות שפורסמו והערות גרסה. |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | ארגון הפרויקט. |
| [רישיון MIT](../../../LICENSE) | תנאי הרישיון. |

לבעיות בתצורה המקורית של OpenCode ולא בפקדי CodeNomad, עיינו ב־[תיעוד OpenCode](https://opencode.ai/v2/docs/) וב־[גרסאות המקור](https://github.com/anomalyco/opencode/releases).

## בנייה מקוד מקור {#build-from-source}

השתמשו ב־Node.js **24.20.0**, כפי שמקובע ב־`.node-version`, ב־npm, ב־Git וב־OpenCode CLI תואם. הריצו את הפקודות מעותק פיתוח:

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` מפעיל את מארח הפיתוח של Electron. לשימוש ב־Tauri, התקינו תחילה את [דרישות הבנייה לפלטפורמה](https://v2.tauri.app/start/prerequisites/), לרבות כלי Rust, ואז הריצו:

```sh
npm run dev:tauri
```

שינויי פיתוח משפיעים על מארח הפיתוח, לא על הגרסה המותקנת של דמון OpenCode הפועל בנפרד. אריזה מקורית דורשת את כלי היעד המתאימים; העדיפו בנייה במערכת ההפעלה של היעד.

### בנייה ואימות {#build-and-validate}

| פקודה, משורש המאגר | מטרה |
| --- | --- |
| `npm run build` | בניית משאבי יישום Electron. |
| `npm run build:tauri` | בניית יישום Tauri עם דרישות הקדם המקוריות שלו. |
| `npm run build:ui` | בניית ממשק הדפדפן. |
| `npm run build --workspace @neuralnomads/codenomad` | בניית השרת העצמאי והנכסים הכלולים. |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | אריזת גרסת Debian של Electron. |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | אריזת AppImage של Tauri ל־Linux. |
| `npm run typecheck` | בדיקת סביבות העבודה של TypeScript שהוגדרו בשורש. |
| `npm run test:help` | אימות כל שפות העזרה הציבורית והקישורים. |
| `npm run build:help` | בניית העזרה הציבורית העצמאית אל `dist/help`. |

בניית העזרה אינה דורשת שירות CodeNomad או OpenCode פועל. ראו [BUILD.md](../../../BUILD.md) לפרטי אריזה ו־[CONTRIBUTING.md](../../../CONTRIBUTING.md) לאימות ממוקד ולנוהלי PR; השתמשו בסקריפטים הקיימים בפועל בחבילת היעד.

## מפת החבילות ותרומה {#contribute}

| חבילה | אחריות |
| --- | --- |
| `packages/server` | פקדי סביבת עבודה/API/Git, חיבור OpenCode, אימות, אירועים וקול. |
| `packages/ui` | סביבת העבודה של SolidJS, פקדים, תרגום ונקודת הכניסה לעזרה בדפדפן. |
| `packages/electron-app` | חלונות Electron, שילוב מקורי ואריזה. |
| `packages/tauri-app` | חלונות Tauri, שילוב פלטפורמה ואריזה. |
| `packages/remote-tunnel` | סביבת תעבורת OpenTunnel בצד שרת הקצה. |

1. דונו בהיקף בדיווח הרלוונטי לפני מימוש עבודה חופפת.
2. הסתעפו מ־`dev` ושמרו על שינוי ממוקד.
3. הריצו בדיקות לאזור המושפע, עדכנו עזרת משתמש לצד ההתנהגות והפנו את ה־PR ל־`dev`.

מקורות העזרה הציבורית נמצאים ב־`docs/help/<locale>/`. שמרו בתרגומים על המזהה המפורש, הרמה והסדר של כל כותרת באנגלית; כותרות מתורגמות חייבות לא לשבור קישורים עמוקים. [חוזה תחזוקת העזרה](../../../dev-docs/USER_HELP.md) מתאר בדיקות שלמות קפדניות ואת תהליך הפרסום הסטטי.
