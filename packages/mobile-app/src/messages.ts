// This standalone launcher must not mount the server-backed preferences provider.
// Reuse each UI locale's remote-access messages, not an English-only import.
const shared = import.meta.glob<{ remoteAccessMessages: Record<string, string> }>(
  "../../ui/src/lib/i18n/messages/*/remoteAccess.ts",
)
const keys = ["endpoint", "help", "invalid", "failed", "working", "network", "recovery", "privacy"] as const
const unsupported: Record<string, string> = {
  en: "Native recovery is unavailable or Android System WebView needs an update. Reopen the app after updating.",
  es: "La recuperación nativa no está disponible o Android System WebView necesita una actualización. Actualiza y vuelve a abrir la aplicación.",
  fr: "La récupération native est indisponible ou Android System WebView doit être mis à jour. Rouvrez l’application après la mise à jour.",
  de: "Native Wiederherstellung ist nicht verfügbar oder Android System WebView muss aktualisiert werden. Öffnen Sie die App danach erneut.",
  ru: "Нативный возврат недоступен или требуется обновление Android System WebView. После обновления откройте приложение снова.",
  ja: "ネイティブの復帰機能が利用できないか、Android System WebViewの更新が必要です。更新後にアプリを開き直してください。",
  "zh-Hans": "原生恢复功能不可用，或Android System WebView需要更新。更新后请重新打开应用。",
  he: "החזרה המקורית אינה זמינה או שיש לעדכן את Android System WebView. פתחו שוב את האפליקציה לאחר העדכון.",
  ne: "नेटिभ पुनःप्राप्ति उपलब्ध छैन वा Android System WebView अद्यावधिक गर्नुपर्छ। अद्यावधिकपछि एप फेरि खोल्नुहोस्।",
  tr: "Yerel kurtarma kullanılamıyor veya Android System WebView güncellenmeli. Güncellemeden sonra uygulamayı yeniden açın.",
}
const messages: Record<string, readonly string[]> = {
  en: ["Server HTTPS origin", "Open the hosted CodeNomad interface and sign in there.", "Enter a root HTTPS origin without credentials, path, query or fragment.", "Unable to open the server. Try again.", "Opening…", "Use a trusted server reachable from this device. No local backend runs here.", "The native ↩ CodeNomad control returns here even if the server is offline. Returning disconnects this view, not the server session.", "Returning preserves sign-in and server drafts. Sign out in the hosted interface to end authentication."],
  es: ["Origen HTTPS del servidor", "Abre la interfaz alojada de CodeNomad e inicia sesión allí.", "Introduce un origen HTTPS raíz sin credenciales, ruta, consulta ni fragmento.", "No se pudo abrir el servidor. Inténtalo de nuevo.", "Abriendo…", "Usa un servidor de confianza accesible desde este dispositivo. Aquí no se ejecuta un servidor local.", "El control nativo ↩ CodeNomad vuelve aquí incluso sin conexión. Volver desconecta esta vista, no la sesión del servidor.", "Volver conserva el acceso y los borradores del servidor. Cierra sesión en la interfaz alojada para terminar la autenticación."],
  fr: ["Origine HTTPS du serveur", "Ouvrez l’interface hébergée de CodeNomad et connectez-vous.", "Saisissez une origine HTTPS racine sans identifiants, chemin, paramètres ni fragment.", "Impossible d’ouvrir le serveur. Réessayez.", "Ouverture…", "Utilisez un serveur de confiance accessible depuis cet appareil. Aucun serveur local ne fonctionne ici.", "Le contrôle natif ↩ CodeNomad permet de revenir ici même hors ligne. Le retour déconnecte cette vue, pas la session serveur.", "Le retour conserve la connexion et les brouillons du serveur. Déconnectez-vous dans l’interface hébergée pour terminer l’authentification."],
  de: ["HTTPS-Ursprung des Servers", "Öffnen Sie die gehostete CodeNomad-Oberfläche und melden Sie sich dort an.", "Geben Sie einen HTTPS-Ursprung ohne Zugangsdaten, Pfad, Abfrage oder Fragment ein.", "Der Server konnte nicht geöffnet werden. Versuchen Sie es erneut.", "Wird geöffnet…", "Verwenden Sie einen vertrauenswürdigen, vom Gerät erreichbaren Server. Hier läuft kein lokaler Server.", "Die native Steuerung ↩ CodeNomad führt auch offline hierher zurück. Die Rückkehr trennt diese Ansicht, nicht die Serversitzung.", "Die Rückkehr erhält Anmeldung und Serverentwürfe. Melden Sie sich in der gehosteten Oberfläche ab, um die Authentifizierung zu beenden."],
  ru: ["HTTPS-источник сервера", "Откройте размещённый интерфейс CodeNomad и войдите в нём.", "Введите корневой HTTPS-источник без учётных данных, пути, запроса или фрагмента.", "Не удалось открыть сервер. Попробуйте снова.", "Открытие…", "Используйте доверенный сервер, доступный с этого устройства. Локальный сервер здесь не запускается.", "Нативная кнопка ↩ CodeNomad возвращает сюда даже без сети. Возврат отключает этот вид, но не сеанс сервера.", "Возврат сохраняет вход и черновики сервера. Для завершения аутентификации выйдите в интерфейсе сервера."],
  ja: ["サーバーのHTTPSオリジン", "ホストされたCodeNomad画面を開き、そこでログインします。", "認証情報、パス、クエリ、フラグメントを含まないルートHTTPSオリジンを入力してください。", "サーバーを開けませんでした。再試行してください。", "開いています…", "この端末から接続できる信頼済みサーバーを使用してください。ローカルサーバーは起動しません。", "ネイティブの↩ CodeNomadボタンでオフライン時もここに戻れます。戻るとこの画面を切断しますが、サーバーのセッションは終了しません。", "戻ってもログインとサーバーの下書きは保持されます。認証を終了するにはサーバー画面でログアウトしてください。"],
  "zh-Hans": ["服务器HTTPS源", "打开托管的CodeNomad界面并在那里登录。", "请输入不含凭据、路径、查询或片段的根HTTPS源。", "无法打开服务器，请重试。", "正在打开…", "请使用此设备可以访问的可信服务器。此处不会运行本地后端。", "即使服务器离线，原生↩ CodeNomad控件也能返回此处。返回会断开此视图，而非服务器会话。", "返回会保留登录和服务器草稿。请在托管界面中退出登录以结束身份验证。"],
  he: ["מקור HTTPS של השרת", "פתחו את ממשק CodeNomad המתארח והתחברו בו.", "הזינו מקור HTTPS ראשי ללא פרטי גישה, נתיב, שאילתה או מקטע.", "לא ניתן לפתוח את השרת. נסו שוב.", "פותח…", "השתמשו בשרת מהימן הנגיש מהמכשיר. לא פועל כאן שרת מקומי.", "הפקד המקורי ↩ CodeNomad מחזיר לכאן גם ללא רשת. החזרה מנתקת את התצוגה ולא את הפעלת השרת.", "החזרה שומרת את ההתחברות ואת טיוטות השרת. התנתקו בממשק המתארח כדי לסיים את האימות."],
  ne: ["सर्भरको HTTPS मूल", "होस्ट गरिएको CodeNomad खोल्नुहोस् र त्यहाँ लगइन गर्नुहोस्।", "प्रमाण, पथ, क्वेरी वा खण्ड नभएको मूल HTTPS ठेगाना प्रविष्ट गर्नुहोस्।", "सर्भर खोल्न सकिएन। फेरि प्रयास गर्नुहोस्।", "खोलिँदै…", "यस उपकरणबाट पहुँच हुने विश्वसनीय सर्भर प्रयोग गर्नुहोस्। यहाँ स्थानीय ब्याकएन्ड चल्दैन।", "नेटिभ ↩ CodeNomad नियन्त्रणले अफलाइन हुँदा पनि यहाँ फर्काउँछ। फर्किँदा यो दृश्य छुट्छ, सर्भर सत्र होइन।", "फर्किँदा लगइन र सर्भरका मस्यौदा सुरक्षित रहन्छन्। प्रमाणीकरण अन्त्य गर्न होस्ट गरिएको इन्टरफेसमा लगआउट गर्नुहोस्।"],
  tr: ["Sunucunun HTTPS kökeni", "Barındırılan CodeNomad arayüzünü açın ve orada oturum açın.", "Kimlik bilgisi, yol, sorgu veya parça içermeyen kök HTTPS kökeni girin.", "Sunucu açılamadı. Yeniden deneyin.", "Açılıyor…", "Bu cihazdan erişilebilen güvenilir bir sunucu kullanın. Burada yerel arka uç çalışmaz.", "Yerel ↩ CodeNomad denetimi çevrimdışıyken bile buraya döner. Dönüş sunucu oturumunu değil, bu görünümü ayırır.", "Dönüş oturum açmayı ve sunucu taslaklarını korur. Kimlik doğrulamayı bitirmek için barındırılan arayüzde oturumu kapatın."],
}

export async function loadMessages(languages: readonly string[]) {
  const locale = languages.map((tag) => tag.toLowerCase().split("-")[0])
    .map((base) => base === "zh" ? "zh-Hans" : base).find((candidate) => candidate in messages) ?? "en"
  const { remoteAccessMessages } = await shared[`../../ui/src/lib/i18n/messages/${locale}/remoteAccess.ts`]()
  document.documentElement.lang = locale
  document.documentElement.dir = locale === "he" ? "rtl" : "ltr"
  const own = Object.fromEntries(keys.map((key, index) => [key, messages[locale][index]]))
  return (key: string) => key === "unsupported" ? unsupported[locale] : own[key] ?? remoteAccessMessages[key] ?? key
}
