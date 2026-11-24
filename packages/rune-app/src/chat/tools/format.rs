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

pub(super) fn path(tool: &Tool) -> &str {
    match tool.name.as_str() {
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
    let name = tool
        .name
        .trim()
        .strip_prefix("opencode_")
        .unwrap_or(tool.name.trim());
    let mut title = if name == "websearch" {
        name.into()
    } else if name == "invalid" && !string(&tool.input, &["tool"]).trim().is_empty() {
        format!(
            "{} {}",
            label("invalid"),
            label(string(&tool.input, &["tool"]))
        )
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
    if !summary.is_empty() {
        title.push(' ');
        title.extend(summary.chars().take(250));
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
    let trimmed = name.trim();
    let normalized = trimmed.strip_prefix("opencode_").unwrap_or(trimmed);
    let key = match normalized {
        "" | "invalid" => "toolCall.renderer.toolName.invalid",
        "bash" | "shell" => "toolCall.renderer.toolName.shell",
        "webfetch" => "toolCall.renderer.toolName.fetch",
        "todowrite" => "toolCall.renderer.toolName.plan",
        "apply_patch" => "toolCall.renderer.toolName.applyPatch",
        _ => {
            let mut chars = normalized.chars();
            return chars
                .next()
                .into_iter()
                .flat_map(char::to_uppercase)
                .chain(chars.take(249))
                .collect();
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
            } else {
                Formatted::Text(s.clone(), "text")
            }
        }
        Value::Bool(b) => Formatted::Text(b.to_string(), "text"),
        Value::Number(n) => Formatted::Text(n.to_string(), "text"),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                let piece = match format_unknown(item, limit) {
                    Formatted::Empty => continue,
                    Formatted::TooLarge => return Formatted::TooLarge,
                    Formatted::Text(piece, _) => piece,
                };
                if piece.is_empty() {
                    continue;
                }
                let add = piece.len() + usize::from(!out.is_empty());
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
    if tool.name != "webfetch" || tool.status == "completed" || !tool.output.is_empty() {
        return None;
    }
    let value = tool.metadata.get("output")?;
    if value.is_null() || value.is_string() || value.as_array().is_some_and(Vec::is_empty) {
        return None;
    }
    Some(value)
}

pub(super) fn output<'a>(tool: &'a Tool, parts: &mut [&'a str; 4]) -> &'a str {
    let live = string(&tool.metadata, &["output", "preview"]);
    if shell::matches(tool) {
        *parts = shell::output(tool);
        "bash"
    } else if tool.name == "edit" {
        parts[0] = edit::output(tool, live);
        "diff"
    } else if tool.name == "write" {
        let (content, language) = write::output(tool);
        parts[0] = content;
        language
    } else if tool.name == "webfetch" {
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
}
