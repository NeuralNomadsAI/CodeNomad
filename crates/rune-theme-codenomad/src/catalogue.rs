//! Shared UI messages, lazily decoded one locale at a time with Solid's English fallback.
use crate::generated_catalogues::SOURCES;
pub use crate::generated_catalogues::{LANGUAGE_NAMES, SUPPORTED_LOCALES};
use serde_json::{Map, Value};
use std::sync::OnceLock;
thread_local! { static RENDER_LOCALE: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) }; }
pub fn render_locale(default: impl FnOnce() -> &'static str) -> &'static str {
    RENDER_LOCALE.get().unwrap_or_else(default)
}
/// A render-local catalogue selection; deferred builders capture this selection explicitly.
pub fn with_locale<T>(locale: &'static str, render: impl FnOnce() -> T) -> T {
    struct Restore(Option<&'static str>);
    impl Drop for Restore {
        fn drop(&mut self) {
            RENDER_LOCALE.set(self.0);
        }
    }
    let _restore = Restore(RENDER_LOCALE.replace(Some(locale)));
    render()
}

fn index(locale: &str) -> usize {
    let normalized = locale.trim().replace('_', "-").to_ascii_lowercase();
    SOURCES
        .iter()
        .position(|(tag, _, _)| tag.to_ascii_lowercase() == normalized)
        .or_else(|| {
            SOURCES
                .iter()
                .position(|(tag, _, _)| *tag == normalized.split('-').next().unwrap_or_default())
        })
        .or_else(|| {
            (normalized.split('-').next() == Some("zh"))
                .then(|| SOURCES.iter().position(|(tag, _, _)| *tag == "zh-Hans"))
                .flatten()
        })
        .unwrap_or_else(|| {
            SOURCES
                .iter()
                .position(|(tag, _, _)| *tag == "en")
                .expect("English catalogue")
        })
}
fn messages(i: usize) -> &'static Map<String, Value> {
    static CATALOGUES: [OnceLock<Map<String, Value>>; SOURCES.len()] =
        [const { OnceLock::new() }; SOURCES.len()];
    CATALOGUES[i].get_or_init(|| serde_json::from_str(SOURCES[i].1).expect("generated messages"))
}
pub fn direction(locale: &str) -> &'static str {
    if SOURCES[index(locale)].2 {
        "rtl"
    } else {
        "ltr"
    }
}
pub fn canonical_locale(locale: &str) -> &'static str {
    SOURCES[index(locale)].0
}
pub fn message(locale: &str, key: &str) -> Option<&'static str> {
    messages(index(locale))
        .get(key)
        .and_then(Value::as_str)
        .or_else(|| messages(index("en")).get(key).and_then(Value::as_str))
}
/// `{word}` placeholders match the Solid catalogue; absent supplied values become empty text.
pub fn format(locale: &str, key: &str, params: &[(&str, &str)]) -> String {
    let template = message(locale, key).unwrap_or(key);
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest.find('}') {
            let name = &rest[1..end];
            if !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
                out.push_str(
                    params
                        .iter()
                        .find(|(key, _)| *key == name)
                        .map(|(_, value)| *value)
                        .unwrap_or_default(),
                );
                rest = &rest[end + 1..];
                continue;
            }
        }
        out.push('{');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_catalogues_keep_locale_direction_and_fallback() {
        assert_eq!(SUPPORTED_LOCALES.len(), 10);
        assert_eq!(direction("he"), "rtl");
        assert_eq!(direction("fr"), "ltr");
        assert_eq!(
            message("fr", "interruption.previous"),
            Some("Demande précédente")
        );
        assert_eq!(
            message("ja", "settings.servers.remove.tabs.one"),
            message("en", "settings.servers.remove.tabs.one")
        );
        assert_eq!(
            message("unknown", "interruption.next"),
            message("en", "interruption.next")
        );
        assert_eq!(
            message("zh-TW", "interruption.next"),
            message("zh-Hans", "interruption.next")
        );
        assert!(message("fr", "not-a-real-key").is_none());
    }
    #[test]
    fn interpolation_preserves_unrecognized_braces() {
        assert_eq!(
            format("en", "not {a-b} {value}", &[("value", "yes")]),
            "not {a-b} yes"
        );
    }
}
