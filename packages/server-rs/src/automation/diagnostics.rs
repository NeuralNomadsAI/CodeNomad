//! The server's own recent panics and internal errors, with file and line, for the runtime
//! diagnostics of `codenomad.inspect` (renderer console and host logs come from the host side).
use std::{
    collections::VecDeque,
    panic::{self, Location, PanicHookInfo},
    sync::{Mutex, Once},
};

use serde_json::{Value, json};

const KEPT: usize = 32;
const TEXT: usize = 2048;
static RECENT: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn record(text: String) {
    let text = match text.char_indices().nth(TEXT - 3) {
        Some((at, _)) if text.chars().count() > TEXT => format!("{}...", &text[..at]),
        _ => text,
    };
    let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    if recent.len() == KEPT {
        recent.pop_front();
    }
    recent.push_back(text);
}

/// Keeps the default hook (stderr), adds the panic with its location and, with
/// `RUST_BACKTRACE=1` and line tables, this crate's frames.
pub fn install() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            record(panic_text(info));
            previous(info);
        }));
    });
}

fn panic_text(info: &PanicHookInfo) -> String {
    let payload = info.payload();
    let message = payload.downcast_ref::<&str>().copied().or(payload.downcast_ref::<String>().map(String::as_str));
    let at = info.location().map_or_else(|| "unknown location".into(), |l| format!("{}:{}", l.file(), l.line()));
    let mut text = format!("Rust server panic at {at}: {}", message.unwrap_or("non-text payload"));
    let trace = std::backtrace::Backtrace::capture().to_string();
    let mut frames = Vec::new();
    let mut lines = trace.lines().map(str::trim);
    while let Some(line) = lines.next() {
        let Some((_, symbol)) = line.split_once(": ").filter(|(_, s)| s.starts_with("codenomad_rs::")) else {
            continue;
        };
        if symbol.starts_with("codenomad_rs::automation::diagnostics") {
            continue;
        }
        let place = lines.clone().next().and_then(|l| l.strip_prefix("at ")).unwrap_or("?");
        frames.push(format!("{symbol} ({place})"));
    }
    if !frames.is_empty() {
        text.push_str(&format!("; backtrace: {}", frames.into_iter().take(8).collect::<Vec<_>>().join(" < ")));
    }
    text
}

/// A 5xx refusal other than "not implemented", at its call site.
pub fn error(status: u16, message: &str, at: &Location) {
    if status >= 500 && status != 501 {
        record(format!("Rust server error {status} at {}:{}: {message}", at.file(), at.line()));
    }
}

/// `inspect` results: the host's last 32 logs, then this server's diagnostics.
#[allow(dead_code)] // First caller: the window inspection, once its route is chosen (docs/automation.md).
pub fn extend(inspection: &mut Value, host_logs: &Value) {
    let Some(list) = inspection.get_mut("diagnostics").and_then(Value::as_array_mut) else { return };
    let logs = host_logs.as_array().map_or(&[][..], Vec::as_slice);
    list.extend(logs[logs.len().saturating_sub(KEPT)..].iter().cloned());
    let recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    list.extend(recent.iter().map(|text| json!({ "level": "error", "text": text })));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panics_and_internal_errors_reach_inspection_diagnostics_with_their_line() {
        install();
        let line = line!() + 1;
        let _ = panic::catch_unwind(|| panic!("diagnostics fixture panic"));
        let _ = crate::error(axum::http::StatusCode::BAD_GATEWAY, "diagnostics fixture error");
        let _ = crate::error(axum::http::StatusCode::NOT_IMPLEMENTED, "diagnostics fixture skipped");
        let mut inspection = json!({ "diagnostics": [{ "level": "log", "text": "renderer" }] });
        let host: Vec<Value> = (0..40).map(|i| json!({ "level": "error", "text": format!("host {i}") })).collect();
        extend(&mut inspection, &json!(host));
        let texts: Vec<String> =
            inspection["diagnostics"].as_array().unwrap().iter().map(|d| d["text"].as_str().unwrap().into()).collect();
        assert_eq!(texts[0], "renderer");
        assert_eq!(texts[1], "host 8");
        let file = file!();
        assert!(
            texts
                .iter()
                .any(|t| t.starts_with(&format!("Rust server panic at {file}:{line}: diagnostics fixture panic")))
        );
        assert!(
            texts
                .iter()
                .any(|t| t.starts_with("Rust server error 502 at src") && t.ends_with(": diagnostics fixture error"))
        );
        assert!(!texts.iter().any(|t| t.contains("fixture skipped")));
        record("x".repeat(5000));
        assert_eq!(RECENT.lock().unwrap().back().unwrap().chars().count(), TEXT);
    }
}
