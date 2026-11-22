//! Shared UI catalogue access. Locale override supports isolated fixtures.
pub fn locale() -> &'static str {
    static LOCALE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    rune_theme_codenomad::catalogue::render_locale(|| {
        LOCALE.get_or_init(crate::platform::locale).as_str()
    })
}
/// Scope a render and its text to an explicit locale without process-global environment changes.
pub fn with_locale<T>(locale: &'static str, render: impl FnOnce() -> T) -> T {
    rune_theme_codenomad::catalogue::with_locale(locale, render)
}
pub fn t(key: &str) -> &'static str {
    let locale = locale();
    rune_theme_codenomad::catalogue::message(locale, key).expect("shared catalogue key")
}
