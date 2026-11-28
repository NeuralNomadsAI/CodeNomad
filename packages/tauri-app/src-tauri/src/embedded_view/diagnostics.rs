//! Preview failures retained for the existing native diagnostics snapshot.
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fmt::Display;
use std::sync::Mutex;

const LOG_LIMIT: usize = 32;
const TEXT_LIMIT: usize = 2048;
static ERRORS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

pub(crate) fn preview_error(step: &str, error: impl Display) -> String {
    let error = error.to_string();
    // Preserve the most specific native step when a command adds a fallback context.
    if error.starts_with("browser preview: ") {
        return error;
    }
    let message = format!("browser preview: {step}: {error}");
    if let Ok(mut logs) = ERRORS.lock() {
        retain_error(&mut logs, &message);
    }
    message
}

fn retain_error(logs: &mut VecDeque<String>, message: &str) {
    if logs.len() == LOG_LIMIT {
        logs.pop_front();
    }
    logs.push_back(message.chars().take(TEXT_LIMIT).collect());
}

pub(crate) fn logs() -> Vec<Value> {
    ERRORS
        .lock()
        .map(|logs| {
            logs.iter()
                .map(|text| json!({ "level": "error", "text": text }))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_preserves_native_message_and_the_most_specific_step() {
        let native = "Paramètre incorrect. (0x80070057)";
        let error = preview_error("install navigation handler", native);
        assert_eq!(
            error,
            format!("browser preview: install navigation handler: {native}")
        );
        assert_eq!(preview_error("register", &error), error);
        assert!(logs().iter().any(|log| log["text"] == error));
    }

    #[cfg(windows)]
    #[test]
    fn cdp_context_preserves_the_actual_windows_hresult() {
        let native = windows_core::Error::from_hresult(windows_core::HRESULT(0x80070057u32 as i32));
        let original = native.to_string();
        assert_eq!(
            preview_error("CDP Emulation.setDeviceMetricsOverride", native),
            format!("browser preview: CDP Emulation.setDeviceMetricsOverride: {original}")
        );
        assert!(original.contains("0x80070057"));
    }

    #[test]
    fn retained_errors_bound_count_and_unicode_text_without_truncating_returned_errors() {
        let mut logs = VecDeque::new();
        for index in 0..LOG_LIMIT + 2 {
            retain_error(&mut logs, &index.to_string());
        }
        assert_eq!(logs.len(), LOG_LIMIT);
        assert_eq!(logs.front().unwrap(), "2");
        let long = "é".repeat(TEXT_LIMIT + 1);
        retain_error(&mut logs, &long);
        assert_eq!(logs.back().unwrap().chars().count(), TEXT_LIMIT);
        assert!(preview_error("test long message", &long).ends_with(&long));
    }
}
