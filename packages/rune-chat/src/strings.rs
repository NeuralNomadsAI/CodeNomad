//! Prototype catalogue; locale is explicit and independent of the user's profile.
const KEYS: &[&str] = &[
    "title",
    "loading",
    "ready",
    "streaming",
    "failed",
    "latest",
    "prompt",
    "send",
];
const CATALOG: &[(&str, [&str; 8])] = &[
    (
        "en",
        [
            "Code Nomad · Rune",
            "Loading",
            "Ready",
            "Streaming",
            "Connection failed",
            "Latest",
            "Message",
            "Send",
        ],
    ),
    (
        "fr",
        [
            "Code Nomad · Rune",
            "Chargement",
            "Prêt",
            "Réponse en cours",
            "Connexion échouée",
            "Derniers messages",
            "Message",
            "Envoyer",
        ],
    ),
    (
        "de",
        [
            "Code Nomad · Rune",
            "Laden",
            "Bereit",
            "Antwort läuft",
            "Verbindung fehlgeschlagen",
            "Neueste",
            "Nachricht",
            "Senden",
        ],
    ),
    (
        "es",
        [
            "Code Nomad · Rune",
            "Cargando",
            "Listo",
            "Respondiendo",
            "Error de conexión",
            "Últimos",
            "Mensaje",
            "Enviar",
        ],
    ),
    (
        "he",
        [
            "Code Nomad · Rune",
            "טוען",
            "מוכן",
            "תגובה בתהליך",
            "החיבור נכשל",
            "אחרונים",
            "הודעה",
            "שליחה",
        ],
    ),
    (
        "ja",
        [
            "Code Nomad · Rune",
            "読み込み中",
            "準備完了",
            "応答中",
            "接続失敗",
            "最新",
            "メッセージ",
            "送信",
        ],
    ),
    (
        "ne",
        [
            "Code Nomad · Rune",
            "लोड हुँदैछ",
            "तयार",
            "जवाफ आउँदैछ",
            "जडान असफल",
            "पछिल्लो",
            "सन्देश",
            "पठाउनुहोस्",
        ],
    ),
    (
        "ru",
        [
            "Code Nomad · Rune",
            "Загрузка",
            "Готово",
            "Ответ поступает",
            "Ошибка подключения",
            "Последние",
            "Сообщение",
            "Отправить",
        ],
    ),
    (
        "tr",
        [
            "Code Nomad · Rune",
            "Yükleniyor",
            "Hazır",
            "Yanıt geliyor",
            "Bağlantı başarısız",
            "Son",
            "Mesaj",
            "Gönder",
        ],
    ),
    (
        "zh-Hans",
        [
            "Code Nomad · Rune",
            "加载中",
            "就绪",
            "正在回复",
            "连接失败",
            "最新",
            "消息",
            "发送",
        ],
    ),
];
pub fn t(key: &str) -> &'static str {
    static LOCALE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let locale =
        LOCALE.get_or_init(|| std::env::var("RUNE_LOCALE").unwrap_or_else(|_| "fr".into()));
    if let Some(index) = ["older", "reconnecting", "retry"]
        .iter()
        .position(|k| *k == key)
    {
        let values = match locale.as_str() {
            "fr" => ["Messages précédents", "Reconnexion", "Réessayer"],
            "de" => [
                "Ältere Nachrichten",
                "Verbindung wird hergestellt",
                "Erneut versuchen",
            ],
            "es" => ["Mensajes anteriores", "Reconectando", "Reintentar"],
            "he" => ["הודעות קודמות", "מתחבר מחדש", "נסה שוב"],
            "ja" => ["以前のメッセージ", "再接続中", "再試行"],
            "ne" => ["पुराना सन्देशहरू", "पुनः जडान हुँदैछ", "फेरि प्रयास गर्नुहोस्"],
            "ru" => ["Предыдущие сообщения", "Переподключение", "Повторить"],
            "tr" => ["Önceki mesajlar", "Yeniden bağlanıyor", "Tekrar dene"],
            "zh-Hans" => ["较早消息", "正在重新连接", "重试"],
            _ => ["Older messages", "Reconnecting", "Retry"],
        };
        return values[index];
    }
    if key == "user" || key == "assistant" {
        let roles = match locale.as_str() {
            "fr" => ["Vous", "Assistant"],
            "de" => ["Sie", "Assistent"],
            "es" => ["Tú", "Asistente"],
            "he" => ["אתה", "עוזר"],
            "ja" => ["あなた", "アシスタント"],
            "ne" => ["तपाईं", "सहायक"],
            "ru" => ["Вы", "Ассистент"],
            "tr" => ["Siz", "Asistan"],
            "zh-Hans" => ["你", "助手"],
            _ => ["You", "Assistant"],
        };
        return roles[usize::from(key == "assistant")];
    }
    let messages = &CATALOG
        .iter()
        .find(|(id, _)| *id == locale)
        .unwrap_or(&CATALOG[0])
        .1;
    messages[KEYS.iter().position(|k| *k == key).expect("catalogue key")]
}
