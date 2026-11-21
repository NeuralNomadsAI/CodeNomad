//! Ordered native message blocks. Tool data is passive; this module never executes calls.
use crate::history::Result;
use serde_json::Value;
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(String),
    Tool(Tool),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub status: String,
    pub input: String,
    pub output: String,
    pub limited: bool,
}
pub fn decode(v: &Value) -> Result<Vec<Part>> {
    let Some(parts) = v["content"].as_array() else {
        return Ok(vec![]);
    };
    if parts.len() > 1000 {
        return Err("message part bound reached".into());
    }
    let mut result = vec![];
    let mut ids = std::collections::HashSet::new();
    for part in parts {
        if part["type"] == "text" {
            if let Some(text) = part["text"].as_str() {
                result.push(Part::Text(text.into()));
            }
        } else if part["type"] == "tool" {
            let id = part["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or("invalid tool id")?;
            if !ids.insert(id) {
                return Err("duplicate tool id".into());
            }
            let name = part["name"]
                .as_str()
                .filter(|s| s.len() <= 256)
                .ok_or("invalid tool name")?;
            let state = &part["state"];
            let status = state["status"].as_str().unwrap_or("streaming").to_string();
            let mut limited = false;
            let input = bounded(&state["input"], &mut limited);
            let output = if status == "error" {
                bounded(&state["error"]["message"], &mut limited)
            } else {
                let mut output = String::new();
                if let Some(parts) = state["content"].as_array() {
                    for item in parts {
                        if item["type"] == "text" {
                            output.push_str(item["text"].as_str().unwrap_or_default());
                            output.push('\n');
                        }
                        if output.len() > 256 * 1024 {
                            limited = true;
                            break;
                        }
                    }
                }
                truncate(&output, &mut limited)
            };
            result.push(Part::Tool(Tool {
                id: id.into(),
                name: name.into(),
                status,
                input,
                output,
                limited,
            }));
        }
    }
    Ok(result)
}
fn truncate(v: &str, limited: &mut bool) -> String {
    if v.len() <= 256 * 1024 {
        return v.into();
    }
    *limited = true;
    let mut end = 256 * 1024;
    while !v.is_char_boundary(end) {
        end -= 1;
    }
    v[..end].into()
}
fn bounded(v: &Value, limited: &mut bool) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => truncate(s, limited),
        _ => truncate(
            &serde_json::to_string_pretty(v).unwrap_or_default(),
            limited,
        ),
    }
}
pub fn bytes(parts: &[Part]) -> usize {
    parts
        .iter()
        .map(|p| match p {
            Part::Text(t) => t.len(),
            Part::Tool(t) => t.id.len() + t.name.len() + t.input.len() + t.output.len(),
        })
        .sum()
}
