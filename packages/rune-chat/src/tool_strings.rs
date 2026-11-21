const KEYS: &[&str] = &[
    "tool_pending",
    "tool_running",
    "tool_done",
    "tool_error",
    "details",
    "hide_details",
    "tool_input",
    "tool_output",
    "tool_limited",
];
const CATALOG: &[(&str, [&str; 9])] = &[
    (
        "en",
        [
            "Preparing",
            "Running",
            "Completed",
            "Failed",
            "Details",
            "Hide",
            "Input",
            "Output",
            "Output limited",
        ],
    ),
    (
        "fr",
        [
            "Préparation",
            "En cours",
            "Terminé",
            "Échec",
            "Détails",
            "Masquer",
            "Entrée",
            "Sortie",
            "Sortie limitée",
        ],
    ),
    (
        "de",
        [
            "Vorbereitung",
            "Läuft",
            "Abgeschlossen",
            "Fehlgeschlagen",
            "Details",
            "Ausblenden",
            "Eingabe",
            "Ausgabe",
            "Ausgabe begrenzt",
        ],
    ),
    (
        "es",
        [
            "Preparando",
            "En curso",
            "Completado",
            "Error",
            "Detalles",
            "Ocultar",
            "Entrada",
            "Salida",
            "Salida limitada",
        ],
    ),
    (
        "he",
        [
            "בהכנה",
            "פועל",
            "הושלם",
            "נכשל",
            "פרטים",
            "הסתר",
            "קלט",
            "פלט",
            "פלט מוגבל",
        ],
    ),
    (
        "ja",
        [
            "準備中",
            "実行中",
            "完了",
            "失敗",
            "詳細",
            "隠す",
            "入力",
            "出力",
            "出力を制限",
        ],
    ),
    (
        "ne",
        [
            "तयारी",
            "चलिरहेको",
            "पूरा भयो",
            "असफल",
            "विवरण",
            "लुकाउनुहोस्",
            "इनपुट",
            "आउटपुट",
            "सीमित आउटपुट",
        ],
    ),
    (
        "ru",
        [
            "Подготовка",
            "Выполняется",
            "Завершено",
            "Ошибка",
            "Подробности",
            "Скрыть",
            "Ввод",
            "Вывод",
            "Вывод ограничен",
        ],
    ),
    (
        "tr",
        [
            "Hazırlanıyor",
            "Çalışıyor",
            "Tamamlandı",
            "Başarısız",
            "Ayrıntılar",
            "Gizle",
            "Girdi",
            "Çıktı",
            "Çıktı sınırlı",
        ],
    ),
    (
        "zh-Hans",
        [
            "准备中",
            "运行中",
            "已完成",
            "失败",
            "详情",
            "隐藏",
            "输入",
            "输出",
            "输出已限制",
        ],
    ),
];
pub fn get(locale: &str, key: &str) -> Option<&'static str> {
    if key == "tool_more" {
        return Some(match locale {
            "fr" => "Afficher tout",
            "de" => "Alles anzeigen",
            "es" => "Mostrar todo",
            "he" => "הצג הכול",
            "ja" => "すべて表示",
            "ne" => "सबै देखाउनुहोस्",
            "ru" => "Показать всё",
            "tr" => "Tümünü göster",
            "zh-Hans" => "显示全部",
            _ => "Show all",
        });
    }
    let i = KEYS.iter().position(|k| *k == key)?;
    Some(
        CATALOG
            .iter()
            .find(|(id, _)| *id == locale)
            .unwrap_or(&CATALOG[0])
            .1[i],
    )
}
