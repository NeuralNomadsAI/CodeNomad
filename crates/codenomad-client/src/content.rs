//! Ordered native message blocks. Tool data is passive; this module never executes calls.
use crate::history::Result;
use serde_json::Value;
use std::{mem::size_of, sync::Arc};
mod tool_live;
mod user;
pub use tool_live::install as install_tool;
pub(crate) use tool_live::{Fit as ToolFit, apply as apply_tool};
pub(crate) use user::digest as attachment_digest;
pub use user::{File, Reference, Skill};
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(Text),
    Tool(Arc<Tool>),
    Skill(Skill),
    File(File),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextProvenance {
    Live,
    Partial,
    Closed,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Text {
    pub text: String,
    pub provenance: TextProvenance,
}
#[derive(Clone, Debug, PartialEq)]
pub enum TextEvent {
    Start {
        ordinal: Option<usize>,
    },
    Delta {
        ordinal: Option<usize>,
        text: String,
    },
    End {
        ordinal: Option<usize>,
        text: String,
    },
}
impl TextEvent {
    pub fn ordinal(&self) -> Option<usize> {
        match self {
            Self::Start { ordinal } | Self::Delta { ordinal, .. } | Self::End { ordinal, .. } => {
                *ordinal
            }
        }
    }
    pub fn is_end(&self) -> bool {
        matches!(self, Self::End { .. })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextFit {
    Applied,
    Drop,
    Repair,
    Settlement,
}

pub fn text_body(parts: &[Part]) -> String {
    parts
        .iter()
        .filter_map(|p| match p {
            Part::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
/// Apply the native fragment identity, then derive the display body from those same parts.
pub fn apply_text(row: &mut crate::Message, event: &TextEvent) -> Result<TextFit> {
    if row.role != "assistant" {
        return Ok(TextFit::Repair);
    }
    let indices: Vec<_> = row
        .parts
        .iter()
        .enumerate()
        .filter_map(|(i, p)| matches!(p, Part::Text(_)).then_some(i))
        .collect();
    let count = indices.len();
    let started = matches!(event, TextEvent::Start { .. });
    let ordinal = event.ordinal();
    if ordinal.is_some_and(|o| o >= 1000) {
        return Err("text ordinal bound reached".into());
    }
    if let Some(o) = ordinal {
        let expected = if started { o } else { o + 1 };
        if count > expected {
            return Ok(TextFit::Drop);
        }
        if count < expected {
            return Ok(TextFit::Repair);
        }
    }
    if started {
        if row.parts.len() >= 1000 {
            return Err("message part bound reached".into());
        }
        if row.body.len() + usize::from(count > 0) > 256 * 1024 {
            return Err("live text budget reached".into());
        }
        row.parts.push(Part::Text(Text {
            text: String::new(),
            provenance: TextProvenance::Live,
        }));
        row.body = text_body(&row.parts);
        return Ok(TextFit::Applied);
    }
    let Some(&index) = ordinal
        .and_then(|o| indices.get(o))
        .or_else(|| ordinal.is_none().then(|| indices.last()).flatten())
    else {
        return Ok(TextFit::Repair);
    };
    let Part::Text(prior) = &row.parts[index] else {
        unreachable!()
    };
    let mut fit = TextFit::Applied;
    let (text, provenance) = match event {
        TextEvent::Delta { text, .. } => {
            if ordinal.is_some() {
                if prior.provenance == TextProvenance::Closed {
                    return Ok(TextFit::Drop);
                }
                if prior.provenance == TextProvenance::Partial {
                    fit = TextFit::Settlement;
                }
            }
            if prior.text.len() + text.len() > 256 * 1024 {
                return Err("live text budget reached".into());
            }
            (format!("{}{text}", prior.text), TextProvenance::Live)
        }
        TextEvent::End { text, .. } => {
            if text.len() > 256 * 1024 {
                return Err("live text budget reached".into());
            }
            (text.clone(), TextProvenance::Closed)
        }
        TextEvent::Start { .. } => unreachable!(),
    };
    let bytes = row
        .parts
        .iter()
        .enumerate()
        .filter_map(|(i, p)| match p {
            Part::Text(t) => Some(if i == index { text.len() } else { t.text.len() }),
            _ => None,
        })
        .sum::<usize>()
        + count.saturating_sub(1);
    if bytes > 256 * 1024 {
        return Err("live text budget reached".into());
    }
    row.parts[index] = Part::Text(Text { text, provenance });
    row.body = text_body(&row.parts);
    Ok(fit)
}

/// Merge open fragments without making an older persisted prefix replace live text.
pub fn merge_page(live: &[crate::history::Row], page: &mut [crate::history::Row]) -> Result<()> {
    for row in page.iter_mut().filter(|r| r.role == "assistant") {
        if row.completed {
            continue;
        }
        let Some(prior) = live.iter().find(|r| r.id == row.id) else {
            continue;
        };
        let row = std::sync::Arc::make_mut(row);
        let texts: Vec<_> = prior
            .parts
            .iter()
            .filter_map(|p| match p {
                Part::Text(t) => Some(t),
                _ => None,
            })
            .collect();
        let mut ordinal = 0;
        for part in &mut row.parts {
            let Part::Text(fetched) = part else { continue };
            if let Some(live) = texts.get(ordinal) {
                if fetched.provenance != TextProvenance::Closed
                    && live.text.starts_with(&fetched.text)
                    && live.text != fetched.text
                {
                    *fetched = (*live).clone();
                }
            }
            ordinal += 1;
        }
        let source_keys = part_keys(&prior.parts);
        let mut keys = part_keys(&row.parts);
        for (i, part) in prior.parts.iter().enumerate() {
            if let Some(target) = keys.iter().position(|key| key == &source_keys[i]) {
                if let (Part::Tool(live), Part::Tool(fetched)) = (part, &mut row.parts[target]) {
                    tool_live::merge(live, fetched);
                }
                continue;
            }
            if matches!(part, Part::Tool(tool) if !matches!(tool.status.as_str(), "streaming" | "running"))
            {
                continue;
            }
            let after = source_keys[..i]
                .iter()
                .rev()
                .find_map(|key| keys.iter().position(|k| k == key));
            let before = source_keys[i + 1..]
                .iter()
                .find_map(|key| keys.iter().position(|k| k == key));
            let at = after.map(|p| p + 1).or(before).unwrap_or(row.parts.len());
            if row.parts.len() >= 1000 {
                return Err("message part bound reached".into());
            }
            row.parts.insert(at, part.clone());
            keys.insert(at, source_keys[i].clone());
        }
        row.body = text_body(&row.parts);
    }
    crate::history::check(page)
}
fn part_keys(parts: &[Part]) -> Vec<String> {
    let mut ordinal = 0;
    parts
        .iter()
        .map(|p| match p {
            Part::Text(_) => {
                let key = format!("text:{ordinal}");
                ordinal += 1;
                key
            }
            Part::Tool(t) => format!("tool:{}", t.id),
            Part::Skill(s) => format!("skill:{}", s.id),
            Part::File(f) => format!("file:{}", f.id),
        })
        .collect()
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub status: String,
    pub input: Value,
    pub metadata: Value,
    pub output: String,
    pub error: String,
    bytes: usize,
    output_bytes: usize,
}
pub fn decode(v: &Value) -> Result<Vec<Part>> {
    if v["type"] == "user" {
        return user::decode(v);
    }
    let Some(parts) = v["content"].as_array() else {
        return Ok(vec![]);
    };
    if parts.len() > crate::history::MAX_BYTES / size_of::<Part>() {
        return Err("resident history limit reached".into());
    }
    let mut result = vec![];
    let mut resident = parts.len() * size_of::<Part>();
    let mut tool_text = 0usize;
    let mut ids = std::collections::HashSet::new();
    for part in parts {
        if part["type"] == "text" {
            if let Some(text) = part["text"].as_str() {
                charge(&mut resident, text.len())?;
                let closed = !v["time"]["completed"].is_null()
                    || !part["native"].is_null()
                    || !part["state"].is_null();
                result.push(Part::Text(Text {
                    text: text.into(),
                    provenance: if closed {
                        TextProvenance::Closed
                    } else if text.is_empty() {
                        TextProvenance::Live
                    } else {
                        TextProvenance::Partial
                    },
                }));
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
            let status = state["status"].as_str().unwrap_or("streaming");
            let text_parts = state["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["type"] == "text")
                .filter_map(|item| item["text"].as_str());
            let error = state["error"]["message"].as_str().unwrap_or_default();
            let (input_nodes, input_text) = resident_json(&state["input"]);
            let (metadata_nodes, metadata_text) = resident_json(&state["metadata"]);
            let output_bytes = metadata_text
                + error.len()
                + text_parts
                    .clone()
                    .map(|text| text.len() + 1)
                    .sum::<usize>()
                    .saturating_sub(1);
            let bytes = id.len()
                + name.len()
                + status.len()
                + size_of::<Tool>()
                + input_nodes
                + input_text
                + metadata_nodes;
            charge(&mut resident, bytes)?;
            tool_text = tool_text.saturating_add(output_bytes);
            if tool_text > crate::history::MAX_TOOL_TEXT_BYTES {
                return Err("resident tool text limit reached".into());
            }
            result.push(Part::Tool(Arc::new(Tool {
                id: id.into(),
                name: name.into(),
                status: status.into(),
                input: state["input"].clone(),
                metadata: state["metadata"].clone(),
                output: text_parts.collect::<Vec<_>>().join("\n"),
                error: error.into(),
                bytes,
                output_bytes,
            })));
        }
    }
    Ok(result)
}
fn charge(resident: &mut usize, added: usize) -> Result<()> {
    *resident = resident.saturating_add(added);
    if *resident > crate::history::MAX_BYTES {
        return Err("resident history limit reached".into());
    }
    Ok(())
}

fn resident_json(v: &Value) -> (usize, usize) {
    let root = size_of::<Value>();
    match v {
        Value::Array(items) => items.iter().fold((root, 0), |(nodes, text), item| {
            let (child, bytes) = resident_json(item);
            (nodes + child, text + bytes)
        }),
        Value::Object(items) => items.iter().fold((root, 0), |(nodes, text), (key, item)| {
            let (child, bytes) = resident_json(item);
            (
                nodes + key.len() + size_of::<String>() * 2 + child,
                text + bytes,
            )
        }),
        Value::String(s) => (root, s.len()),
        _ => (root, 0),
    }
}

pub fn bytes(parts: &[Part]) -> usize {
    std::mem::size_of_val(parts)
        + parts
            .iter()
            .map(|p| match p {
                Part::Text(t) => t.text.len(),
                Part::Tool(t) => t.bytes,
                Part::Skill(s) => s.id.len() + s.skill_id.len() + s.name.len(),
                Part::File(f) => file_bytes(f),
            })
            .sum::<usize>()
}

pub(crate) fn tool_text_bytes(parts: &[Part]) -> usize {
    parts
        .iter()
        .filter_map(|part| match part {
            Part::Tool(tool) => Some(tool.output_bytes),
            _ => None,
        })
        .sum()
}
pub fn attachment_bytes(parts: &[Part]) -> usize {
    parts
        .iter()
        .map(|part| match part {
            Part::File(f) => file_bytes(f),
            Part::Skill(s) => s.id.len() + s.skill_id.len() + s.name.len(),
            _ => 0,
        })
        .sum()
}
fn file_bytes(file: &File) -> usize {
    file.id.len()
        + file.mime.len()
        + file.name.as_ref().map_or(0, String::len)
        + file
            .reference
            .as_ref()
            .map_or(0, |r| r.message.len() + r.sha256.len())
}
