//! Text projections shared by the tool card and its clipboard actions.
use super::{Tool, edit, read, search, shell, task, write};
use crate::strings::t;
use serde_json::Value;
use std::io;

pub(super) fn string<'a>(value: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .filter_map(|key| value[*key].as_str())
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

pub(super) fn canonical_name(name: &str) -> &str {
    let trimmed = name.trim();
    trimmed.strip_prefix("opencode_").unwrap_or(trimmed)
}

fn is_bidi_control(ch: char) -> bool {
    matches!(
        ch,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

pub(super) fn sanitize_header_text(raw: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut count = 0usize;
    let mut pending_space = false;
    let mut truncated = false;
    for ch in raw.chars() {
        if is_bidi_control(ch) || (ch.is_control() && !ch.is_whitespace()) {
            continue;
        }
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        let needed = usize::from(pending_space) + 1;
        if count + needed > max_chars {
            truncated = true;
            break;
        }
        if pending_space {
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        out.push(ch);
        count += 1;
    }
    if truncated {
        let keep = max_chars.saturating_sub(1);
        while count > keep {
            out.pop();
            count -= 1;
        }
        while out.ends_with(' ') {
            out.pop();
        }
        out.push('…');
    }
    out
}

pub(super) fn path(tool: &Tool) -> &str {
    match canonical_name(&tool.name) {
        "read" => read::path(tool),
        "edit" => edit::path(tool),
        _ => write::path(tool),
    }
}

pub(super) fn bounded_json(value: &Value, limit: usize) -> Option<String> {
    input_json(value, limit, false)
}

pub(super) fn input_json(value: &Value, limit: usize, partial: bool) -> Option<String> {
    struct Limited(Vec<u8>, usize);
    impl io::Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let count = bytes.len().min(self.1.saturating_sub(self.0.len()));
            if count == 0 && !bytes.is_empty() {
                return Err(io::ErrorKind::FileTooLarge.into());
            }
            self.0.extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut out = Limited(Vec::new(), limit);
    let serialized = serde_json::to_writer_pretty(&mut out, value);
    if serialized
        .as_ref()
        .is_err_and(|error| error.io_error_kind() != Some(io::ErrorKind::FileTooLarge) || !partial)
    {
        return None;
    }
    if serialized.is_err() {
        if let Err(error) = std::str::from_utf8(&out.0) {
            out.0.drain(error.valid_up_to()..);
        }
        out.0.extend_from_slice("…".as_bytes());
    }
    String::from_utf8(out.0).ok()
}

pub(super) fn title(tool: &Tool) -> String {
    let name = canonical_name(&tool.name);
    let mut title = if name == "websearch" {
        name.into()
    } else if name == "invalid" {
        let requested = sanitize_header_text(string(&tool.input, &["tool"]), 250);
        if requested.is_empty() || canonical_name(&requested) == "invalid" {
            label("invalid")
        } else {
            format!("{} {}", label("invalid"), label(&requested))
        }
    } else {
        label(name)
    };
    let summary = match name {
        "read" | "edit" | "write" => {
            let path = path(tool);
            path.rsplit(['/', '\\'])
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(path)
        }
        "bash" | "shell" => shell::summary(tool),
        "glob" | "grep" => search::pattern(tool),
        "webfetch" => string(&tool.input, &["url"]),
        _ => "",
    };
    let summary = sanitize_header_text(summary, 250);
    if !summary.is_empty() {
        title.push(' ');
        title.push_str(&summary);
    }
    if name == "websearch" {
        search::web_title(tool, &mut title);
    }
    if task::is_task(tool) {
        let detail = task::detail(tool);
        if !detail.is_empty() {
            if !detail.starts_with('[') {
                title.push(' ');
            }
            title.push_str(&detail);
        }
    }
    match name {
        "read" => read::detail(tool, &mut title),
        "bash" | "shell" => shell::detail(tool, &mut title),
        _ => (),
    }
    title
}

pub(super) fn label(name: &str) -> String {
    let normalized = canonical_name(name);
    let key = match normalized {
        "" | "invalid" => "toolCall.renderer.toolName.invalid",
        "bash" | "shell" => "toolCall.renderer.toolName.shell",
        "webfetch" => "toolCall.renderer.toolName.fetch",
        "todowrite" => "toolCall.renderer.toolName.plan",
        "apply_patch" => "toolCall.renderer.toolName.applyPatch",
        _ => {
            let clean = sanitize_header_text(normalized, 250);
            let mut chars = clean.chars();
            let Some(first) = chars.next() else {
                return t("toolCall.renderer.toolName.invalid").into();
            };
            return first.to_uppercase().chain(chars).collect();
        }
    };
    t(key).into()
}

pub(super) fn error(tool: &Tool) -> &str {
    shell::interrupted(tool).map_or(tool.error.as_str(), |(_, notice)| notice)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Formatted {
    Empty,
    Text(String, &'static str),
    TooLarge,
}

pub(super) fn format_unknown(value: &Value, limit: Option<usize>) -> Formatted {
    match value {
        Value::Null => Formatted::Empty,
        Value::String(s) => {
            if s.is_empty() {
                Formatted::Empty
            } else if limit.is_some_and(|max| s.len() > max) {
                Formatted::TooLarge
            } else {
                Formatted::Text(s.clone(), "text")
            }
        }
        Value::Bool(b) => Formatted::Text(b.to_string(), "text"),
        Value::Number(n) => Formatted::Text(n.to_string(), "text"),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                let sep = usize::from(!out.is_empty());
                let remaining = limit.map(|max| max.saturating_sub(out.len().saturating_add(sep)));
                let piece = match format_unknown(item, remaining) {
                    Formatted::Empty => continue,
                    Formatted::TooLarge => return Formatted::TooLarge,
                    Formatted::Text(piece, _) => piece,
                };
                if piece.is_empty() {
                    continue;
                }
                let add = piece.len() + sep;
                if limit.is_some_and(|max| out.len().saturating_add(add) > max) {
                    return Formatted::TooLarge;
                }
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&piece);
            }
            if out.is_empty() {
                Formatted::Empty
            } else {
                Formatted::Text(out, "text")
            }
        }
        Value::Object(_) => {
            let json = match limit {
                Some(max) => input_json(value, max, false),
                None => serde_json::to_string_pretty(value).ok(),
            };
            match json {
                Some(json) => Formatted::Text(json, "json"),
                None => Formatted::TooLarge,
            }
        }
    }
}

pub(super) fn structured_output(tool: &Tool) -> Option<&Value> {
    if canonical_name(&tool.name) != "webfetch"
        || tool.status == "completed"
        || !tool.output.is_empty()
    {
        return None;
    }
    let value = tool.metadata.get("output")?;
    if value.is_null() || value.is_string() || value.as_array().is_some_and(Vec::is_empty) {
        return None;
    }
    Some(value)
}

pub(super) fn output<'a>(tool: &'a Tool, parts: &mut [&'a str; 4]) -> &'a str {
    let name = canonical_name(&tool.name);
    let live = string(&tool.metadata, &["output", "preview"]);
    if shell::matches(tool) {
        *parts = shell::output(tool);
        "bash"
    } else if name == "edit" {
        parts[0] = edit::output(tool, live);
        "diff"
    } else if name == "write" {
        let (content, language) = write::output(tool);
        parts[0] = content;
        language
    } else if name == "webfetch" {
        parts[0] = if tool.status == "completed" {
            &tool.output
        } else {
            tool.metadata["output"].as_str().unwrap_or_default()
        };
        "text"
    } else {
        parts[0] = if tool.output.is_empty() && tool.status != "completed" {
            live
        } else {
            &tool.output
        };
        "text"
    }
}

#[test]
fn nested_tool_arguments_stop_at_the_actual_pretty_json_budget() {
    let mut value = serde_json::json!(vec!["x"; 2300]);
    for _ in 0..100 {
        value = Value::Array(vec![value]);
    }
    let limit = crate::chat::document::TOOL_LIMIT;
    assert!(value.to_string().len() < limit);
    assert!(serde_json::to_string_pretty(&value).unwrap().len() > 400_000);
    assert!(input_json(&value, limit, false).is_none());
}

#[test]
fn format_unknown_skips_empty_nested_arrays_instead_of_marking_too_large() {
    assert_eq!(
        format_unknown(&serde_json::json!([[null], "ok"]), Some(1024)),
        Formatted::Text("ok".into(), "text")
    );
    assert_eq!(
        format_unknown(&serde_json::json!([[null, ""]]), Some(1024)),
        Formatted::Empty
    );
    assert_eq!(
        format_unknown(&serde_json::json!("abcdef"), Some(4)),
        Formatted::TooLarge
    );
    assert_eq!(
        format_unknown(&serde_json::json!(["ab", "cde"]), Some(4)),
        Formatted::TooLarge
    );
}

#[test]
fn webfetch_and_invalid_titles_are_bounded_sanitized_and_deduplicated() {
    let make_tool = |name: &str, input: Value| {
        let row = crate::history::decode_message(&serde_json::json!({
            "type": "assistant",
            "id": "m",
            "content": [{"type": "tool", "id": "t1", "name": name, "state": {"status": "completed", "input": input}}]
        }))
        .unwrap();
        match row.parts.into_iter().next().unwrap() {
            crate::content::Part::Tool(tool) => tool,
            _ => panic!("expected tool part"),
        }
    };
    crate::strings::with_locale("en", || {
        assert_eq!(
            title(&make_tool(
                "opencode_webfetch",
                serde_json::json!({"url": "https://example.test/a\nb\tc\u{202E}\x07"})
            )),
            "Fetch https://example.test/a b c"
        );
        let long_url = format!("https://example.test/{}", "x".repeat(300));
        let long_title = title(&make_tool("webfetch", serde_json::json!({"url": long_url})));
        let url_part = long_title.strip_prefix("Fetch ").unwrap();
        assert_eq!(url_part.chars().count(), 250);
        assert!(url_part.ends_with('…'));

        assert_eq!(
            title(&make_tool(
                "webfetch",
                serde_json::json!({"url": " \n\t\x00 "})
            )),
            "Fetch"
        );
        assert_eq!(
            title(&make_tool(
                "invalid",
                serde_json::json!({"tool": "invalid"})
            )),
            "Invalid"
        );
        assert_eq!(
            title(&make_tool(
                "opencode_invalid",
                serde_json::json!({"tool": "opencode_invalid"})
            )),
            "Invalid"
        );
        assert_eq!(
            title(&make_tool(
                "invalid",
                serde_json::json!({"tool": " \n\x07 "})
            )),
            "Invalid"
        );
        assert_eq!(
            title(&make_tool(
                "invalid",
                serde_json::json!({"tool": "bad\nname\u{202E}"})
            )),
            "Invalid Bad name"
        );
        let long_name = "tool_".to_owned() + &"z".repeat(300);
        let invalid_long = title(&make_tool(
            "invalid",
            serde_json::json!({"tool": long_name}),
        ));
        let requested_part = invalid_long.strip_prefix("Invalid ").unwrap();
        assert_eq!(requested_part.chars().count(), 250);
        assert!(requested_part.ends_with('…'));
    });
}

#[test]
fn sanitize_header_text_handles_boundaries_without_trailing_ellipsis_on_exact_fit() {
    assert_eq!(sanitize_header_text("abc   ", 3), "abc");
    assert_eq!(sanitize_header_text("abcd", 3), "ab…");
    assert_eq!(sanitize_header_text("ab c", 3), "ab…");
    assert_eq!(sanitize_header_text("a bc", 3), "a…");
    assert_eq!(sanitize_header_text("a\u{202E}b\x00c", 10), "abc");
}
