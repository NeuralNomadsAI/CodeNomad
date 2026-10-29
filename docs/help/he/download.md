# הורדת CodeNomad

יישום שולחן עבודה חינמי בקוד פתוח (MIT) ל־Windows, ל־macOS ול־Linux. הוא מתחבר לשירות OpenCode שלכם; בדקו תחילה את [הדרישות](install.md#requirements).

## יישומי שולחן העבודה {#desktop}

{{release}}

{{download-button}}

| פלטפורמה | Tauri (מומלץ) | Electron |
| --- | --- | --- |
| Windows 10 ואילך | [מתקין, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 ואילך | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (נבדק ב־Ubuntu 24.04) | [AppImage, x64](release:tauri-linux-x64) | [חבילת Debian, x64](release:electron-linux-x64) |

שתי הגרסאות מספקות את אותה סביבת עבודה. Tauri יכול להתקין עדכונים מתוך היישום; Electron מתעדכן בהורדת גרסה חדשה ותומך באוטומציית דפדפן מקורית בכל הפלטפורמות (Tauri ב־Windows בלבד). [השוואת הגרסאות](install.md#desktop-downloads).

## מנהלי חבילות {#package-managers}

ב־Windows, ‏winget מתקין את גרסת Tauri:

```sh
winget install NeuralNomadsAI.CodeNomad
```

כדי להריץ את CodeNomad כשרת עצמאי ולהשתמש בו בדפדפן, הפעילו אותו עם npm במארח שמותקן בו Node.js 24:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

העמוד [שרת עצמאי](server.md#run) מכסה את ההתחברות הראשונה, ההתקנה הגלובלית, הכתובות והאימות; [הדרישות](install.md#requirements) מפרטות את Node.js, Git ו־OpenCode.

## התקנה והפעלה ראשונה {#verify-and-install}

הורידו רק מהעמוד הזה או מ־[הגרסאות הרשמיות](https://github.com/NeuralNomadsAI/CodeNomad/releases), ולעולם אל תריצו ארכיון שאינו מהימן רק כדי לעקוף אזהרה.

- **Linux**: הפכו את ה־AppImage לקובץ הרצה או התקינו את חבילת Debian; ראו [התקנה ב־Linux](install.md#linux-install).
- **macOS**: אם macOS חוסם את ההפעלה הראשונה, ראו [הסגר ב־macOS](troubleshooting.md#macos-quarantine).
- **כל הפלטפורמות**: התקינו Git ו־OpenCode CLI תואם כמפורט ב־[דרישות](install.md#requirements), ואז [בחרו OpenCode בהפעלה הראשונה](install.md#first-launch). בעיות הפעלה אחרות מכוסות ב־[פתרון בעיות](troubleshooting.md#desktop-launch).
