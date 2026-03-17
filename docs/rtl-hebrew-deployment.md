# CodeNomad — התקנה ופריסה עם תמיכת RTL + עברית

מדריך זה מסביר כיצד להתקין ולהפעיל את CodeNomad עם ממשק RTL ותרגום עברית מלא (`v0.12.3-rtl-he`).

---

## דרישות מוקדמות

- **Node.js 18+** — ההתקנה חייבת להתבצע דרך `npm` בלבד.
  > ⚠️ **bun אינו נתמך.** השרת חייב לרוץ דרך `node`, לא `bun`.
- **OpenCode CLI** — נדרש לפעולת הסוכן.

### התקנת OpenCode

```bash
curl -fsSL https://opencode.ai/install | bash
```

---

## 1. התקנת CodeNomad גלובלית

```bash
npm install -g @neuralnomads/codenomad@latest
```

בדיקה:

```bash
codenomad --version
```

> אם `codenomad` אינו נמצא ב-PATH, בדוק היכן npm מתקין packages גלובליים:
> ```bash
> npm prefix -g
> # הוסף את <output>/bin ל-PATH
> ```

---

## 2. הגדרת אישורים

```bash
mkdir -p ~/.config/codenomad
cat > ~/.config/codenomad/env <<'EOF'
CODENOMAD_SERVER_USERNAME=codenomad
CODENOMAD_SERVER_PASSWORD=your-password
EOF
chmod 600 ~/.config/codenomad/env
```

---

## 3. הורדת ממשק ה-RTL+Hebrew

### הורדה וחילוץ אוטומטי

```bash
mkdir -p ~/.config/codenomad/ui

curl -L https://github.com/MusiCode1/CodeNomad/releases/download/v0.12.3-rtl-he/codenomad-ui-rtl-he.zip \
  -o /tmp/codenomad-ui-rtl-he.zip

python3 -c "
import zipfile, os
with zipfile.ZipFile('/tmp/codenomad-ui-rtl-he.zip') as z:
    z.extractall(os.path.expanduser('~/.config/codenomad/ui'))
print('Done.')
"
```

לאחר החילוץ, וודא שהתיקייה תקינה:

```bash
ls ~/.config/codenomad/ui/
# אמור לכלול: index.html, assets/, sw.js, ...
```

---

## 4. הפעלה ידנית (לבדיקה)

```bash
codenomad \
  --host 0.0.0.0 \
  --ui-dir ~/.config/codenomad/ui \
  --ui-no-update
```

פתח בדפדפן: `http://<כתובת-השרת>:9899`

בחלון ה-UI, עבור לבורר השפות ובחר **עברית** להפעלת התרגום.

### אפשרות: עדכון אוטומטי של ה-UI מהמניפסט

במקום `--ui-dir` אפשר להשתמש ב-`--ui-manifest-url` כדי שהשרת יוריד ויעדכן את ה-UI אוטומטית:

```bash
codenomad \
  --host 0.0.0.0 \
  --ui-manifest-url https://raw.githubusercontent.com/MusiCode1/CodeNomad/i18n-hebrew/manifest.json
```

> במצב זה השרת יוריד את ה-UI בהפעלה הראשונה ויעדכן אוטומטית כשיוצאת גרסה חדשה.

---

## 5. שירות systemd (הפעלה אוטומטית עם המערכת)

### יצירת קובץ השירות

```bash
mkdir -p ~/.config/systemd/user
```

מצא את נתיב ה-node וה-codenomad שלך:

```bash
which node        # למשל: /usr/bin/node
which codenomad   # למשל: /usr/local/bin/codenomad
```

צור את קובץ השירות:

```bash
cat > ~/.config/systemd/user/codenomad.service <<'EOF'
[Unit]
Description=CodeNomad Server (RTL + Hebrew)
After=network.target

[Service]
Type=simple
Restart=on-failure
RestartSec=5

# קובץ אישורים — ראה שלב 2
EnvironmentFile=%h/.config/codenomad/env

ExecStart=/usr/bin/node /usr/local/lib/node_modules/@neuralnomads/codenomad/dist/bin.js \
  --host 0.0.0.0 \
  --ui-dir %h/.config/codenomad/ui \
  --ui-no-update

[Install]
WantedBy=default.target
EOF
```

> **חשוב:** החלף את הנתיבים בנתיבים מהפקודות `which` שהרצת למעלה.
> נתיב הבינארי של node: `$(which node)`
> נתיב bin.js: `$(npm prefix -g)/lib/node_modules/@neuralnomads/codenomad/dist/bin.js`

### הפעלת השירות

```bash
systemctl --user daemon-reload
systemctl --user enable --now codenomad
systemctl --user status codenomad
```

### לוגים

```bash
journalctl --user -u codenomad -f
```

---

## 6. הפעלה לאחר logout (שרתים ללא מסך)

```bash
loginctl enable-linger $USER
```

פקודה זו מאפשרת לשירותי המשתמש לרוץ גם כשאין session פעיל.

---

## עדכון לגרסה חדשה

כשיוצאת גרסה חדשה:

```bash
# הורד את ה-UI החדש
curl -L https://github.com/MusiCode1/CodeNomad/releases/latest/download/codenomad-ui-rtl-he.zip \
  -o /tmp/codenomad-ui-rtl-he.zip

rm -rf ~/.config/codenomad/ui/*

python3 -c "
import zipfile, os
with zipfile.ZipFile('/tmp/codenomad-ui-rtl-he.zip') as z:
    z.extractall(os.path.expanduser('~/.config/codenomad/ui'))
"

systemctl --user restart codenomad
```

---

## פתרון בעיות נפוצות

| בעיה | פתרון |
|------|--------|
| `codenomad: command not found` | הוסף `$(npm prefix -g)/bin` ל-`~/.bashrc` |
| השירות לא עולה | בדוק נתיבים ב-`ExecStart` — חייב להיות `node`, לא `bun` |
| הממשק לא נטען | וודא שהחלצה הצליחה: `ls ~/.config/codenomad/ui/index.html` |
| העברית לא מופיעה | בחר את השפה ידנית מבורר השפות בממשק |
| השרת לא נגיש מרחוק | וודא ש-`--host 0.0.0.0` מוגדר ושה-firewall פותח את פורט 9899 |
