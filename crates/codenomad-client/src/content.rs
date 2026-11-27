//! Ordered native message blocks. Tool data is passive; this module never executes calls.
use crate::history::Result;
use serde_json::Value;
use std::{mem::size_of, sync::Arc};
mod media;
mod reasoning;
mod subagent;
pub use media::{Picture, PictureSource};
mod tool_live;
mod usage;
mod user;
pub use reasoning::{Reasoning, ReasoningEvent, apply_window as apply_reasoning};
pub use subagent::SubagentReport;
pub(crate) use subagent::decode as decode_subagent_report;
pub(crate) use tool_live::Fit as ToolFit;
pub use tool_live::install as install_tool;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolEventOutcome {
    Applied,
    Drop,
    Pending,
}

pub fn apply_tool_event(
    rows: &mut Vec<crate::history::Row>,
    message_id: Option<&str>,
    kind: &str,
    data: &Value,
    at: Option<u64>,
) -> ToolEventOutcome {
    let call_id = data["id"].as_str().unwrap_or_default();
    let idx = if let Some(msg) = message_id {
        rows.iter().position(|r| r.id == msg)
    } else if !call_id.is_empty() {
        rows.iter().rposition(|r| {
            r.role == "assistant"
                && r.parts
                    .iter()
                    .any(|p| matches!(p, Part::Tool(t) if t.id == call_id))
        })
    } else {
        None
    };
    let idx = match idx {
        Some(idx) => idx,
        None if kind == "session.tool.input.started"
            && rows.len() < crate::history::MAX_ROWS
            && message_id.is_some_and(crate::history::valid_id) =>
        {
            let msg = message_id.unwrap_or_default();
            rows.push(Arc::new(crate::Message {
                id: msg.into(),
                role: "assistant".into(),
                completed: false,
                body: String::new(),
                usage: None,
                parts: vec![],
            }));
            rows.len() - 1
        }
        None => return ToolEventOutcome::Pending,
    };
    let row = Arc::make_mut(&mut rows[idx]);
    match tool_live::apply_at(row, kind, data, at) {
        ToolFit::Applied(_) | ToolFit::Settled(_) => ToolEventOutcome::Applied,
        ToolFit::Drop => ToolEventOutcome::Drop,
        ToolFit::Repair => ToolEventOutcome::Pending,
    }
}

pub(crate) fn apply_tool_checked(
    resident: &mut [crate::history::Row],
    row_idx: usize,
    kind: &str,
    data: &Value,
    at: Option<u64>,
) -> (ToolFit, bool) {
    let call_id = data["id"].as_str().unwrap_or_default();
    let prev_len = resident[row_idx].parts.len();
    let prev_tool = resident[row_idx]
        .parts
        .iter()
        .enumerate()
        .find_map(|(j, part)| match part {
            Part::Tool(tool) if tool.id == call_id => Some((j, tool.clone())),
            _ => None,
        });
    let fit = tool_live::apply_at(Arc::make_mut(&mut resident[row_idx]), kind, data, at);
    if matches!(fit, ToolFit::Applied(_) | ToolFit::Settled(_))
        && crate::history::check(resident).is_err()
    {
        let row = Arc::make_mut(&mut resident[row_idx]);
        if let Some((j, tool)) = prev_tool {
            row.parts[j] = Part::Tool(tool);
        } else {
            row.parts.truncate(prev_len);
        }
        return (fit, false);
    }
    (fit, true)
}
pub use usage::{FAMILY_LIMIT, Family, FamilyChange, FamilyMember, FamilySnapshot, Usage};
pub use user::{File, Reference, Skill};
pub(crate) use user::{decode_payload as decode_user_payload, digest as attachment_digest};
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(Text),
    Reasoning(Reasoning),
    SubagentReport(SubagentReport),
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
    pub part_index: Option<usize>,
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
            part_index: None,
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
    let part_index = prior.part_index;
    row.parts[index] = Part::Text(Text {
        part_index,
        text,
        provenance,
    });
    row.body = text_body(&row.parts);
    Ok(fit)
}

/// Merge open fragments without making an older persisted prefix replace live text.
pub fn merge_page(live: &[crate::history::Row], page: &mut [crate::history::Row]) -> Result<()> {
    for row in page.iter_mut().filter(|r| r.role == "assistant") {
        if row.completed {
            if let Some(prior) = live.iter().find(|r| r.id == row.id)
                && row.parts.iter().any(|p| {
                    matches!(p, Part::Tool(t) if matches!(t.status.as_str(), "streaming" | "running"))
                })
            {
                let live_tools: std::collections::HashMap<&str, &std::sync::Arc<Tool>> = prior
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::Tool(t) => Some((t.id.as_str(), t)),
                        _ => None,
                    })
                    .collect();
                let row = std::sync::Arc::make_mut(row);
                for part in &mut row.parts {
                    if let Part::Tool(fetched) = part
                        && matches!(fetched.status.as_str(), "streaming" | "running")
                        && let Some(live_tool) = live_tools.get(fetched.id.as_str())
                    {
                        tool_live::merge(live_tool, fetched);
                    }
                }
            }
            continue;
        }
        let Some(prior) = live.iter().find(|r| r.id == row.id) else {
            continue;
        };
        let row = std::sync::Arc::make_mut(row);
        row.usage = row.usage.or(prior.usage);
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
                    let index = fetched.part_index;
                    *fetched = (*live).clone();
                    fetched.part_index = index;
                }
            }
            ordinal += 1;
        }
        let source_keys = part_keys(&prior.parts);
        let mut keys = part_keys(&row.parts);
        for (i, part) in prior.parts.iter().enumerate() {
            if let Some(target) = keys.iter().position(|key| key == &source_keys[i]) {
                match (part, &mut row.parts[target]) {
                    (Part::Tool(live), Part::Tool(fetched)) => tool_live::merge(live, fetched),
                    (Part::Reasoning(live), Part::Reasoning(fetched))
                        if fetched.provenance != TextProvenance::Closed
                            && live.text.starts_with(&fetched.text)
                            && (live.text.len() > fetched.text.len()
                                || live.units > fetched.units) =>
                    {
                        let index = fetched.part_index;
                        *fetched = live.clone();
                        fetched.part_index = index;
                    }
                    _ => {}
                }
                continue;
            }
            if matches!(
                part,
                Part::Tool(tool)
                    if !matches!(tool.status.as_str(), "streaming" | "running")
                        && tool.part_index.is_some()
            ) {
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
            Part::Reasoning(part) => format!("reasoning:{}", part.ordinal),
            Part::SubagentReport(report) => format!("report:{}", report.child),
            Part::Skill(s) => format!("skill:{}", s.id),
            Part::File(f) => format!("file:{}", f.id),
        })
        .collect()
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    pub part_index: Option<usize>,
    pub id: String,
    pub name: String,
    pub status: String,
    pub input: Value,
    pub metadata: Value,
    pub output: String,
    pub error: String,
    pub started: Option<u64>,
    pub message_created: Option<u64>,
    pub ended: Option<u64>,
    pub pictures: Vec<Picture>,
    bytes: usize,
    output_bytes: usize,
}
impl Tool {
    pub fn retained_bytes(&self) -> usize {
        self.bytes + self.output_bytes + self.media_bytes()
    }

    pub fn with_budget(&self, budget: usize) -> Self {
        if self.retained_bytes() <= budget {
            return self.clone();
        }
        let status = if self.status.len() <= 64 {
            self.status.clone()
        } else {
            "unknown".into()
        };
        let base_bytes = self.id.len() + self.name.len() + status.len() + size_of::<Tool>();
        let mut rem = budget.saturating_sub(base_bytes);

        let take_str = |src: &str, rem: &mut usize| -> String {
            if src.is_empty() || *rem == 0 {
                return String::new();
            }
            let keep = src.len().min(*rem);
            let end = src.floor_char_boundary(keep);
            *rem -= end;
            src[..end].to_owned()
        };

        let (in_n, in_b) = resident_json(&self.input);
        let input = if in_n.saturating_add(in_b) <= rem {
            rem -= in_n + in_b;
            self.input.clone()
        } else {
            Value::Null
        };

        let (md_n, md_b) = resident_json(&self.metadata);
        let metadata = if md_n.saturating_add(md_b) <= rem {
            rem -= md_n + md_b;
            self.metadata.clone()
        } else {
            Value::Null
        };

        let error = take_str(&self.error, &mut rem);
        let output = take_str(&self.output, &mut rem);

        let (in_n, in_b) = resident_json(&input);
        let (md_n, md_b) = resident_json(&metadata);
        Self {
            part_index: self.part_index,
            id: self.id.clone(),
            name: self.name.clone(),
            status,
            input,
            metadata,
            output_bytes: md_b + error.len() + output.len(),
            output,
            error,
            started: self.started,
            message_created: self.message_created,
            ended: self.ended,
            pictures: Vec::new(),
            bytes: base_bytes + in_n + in_b + md_n,
        }
    }

    fn media_bytes(&self) -> usize {
        self.pictures
            .iter()
            .map(|item| {
                size_of::<Picture>()
                    + item.mime.len()
                    + item.name.as_ref().map_or(0, String::len)
                    + item.source.retained_bytes()
            })
            .sum()
    }
}
pub fn decode(v: &Value) -> Result<Vec<Part>> {
    if v["type"] == "user" {
        return user::decode(v);
    }
    if v["type"] == "synthetic"
        && let Some(report) = subagent::decode(v)
    {
        return Ok(vec![Part::SubagentReport(report)]);
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
    let mut reasoning_ordinal = 0;
    let mut media_bytes = media::ROW_IMAGE_BYTES;
    for (index, part) in parts.iter().enumerate() {
        if part["type"] == "text" {
            if let Some(text) = part["text"].as_str() {
                charge(&mut resident, text.len())?;
                let closed = !v["time"]["completed"].is_null()
                    || !part["native"].is_null()
                    || !part["state"].is_null();
                result.push(Part::Text(Text {
                    part_index: Some(index),
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
        } else if part["type"] == "reasoning" {
            result.push(Part::Reasoning(reasoning::decode(
                part,
                reasoning_ordinal,
                index,
                !v["time"]["completed"].is_null(),
            )));
            reasoning_ordinal += 1;
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
            let status = match state["status"].as_str() {
                None => "streaming",
                Some(s) if s.len() <= 64 => s,
                Some(_) => "unknown",
            };
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
                part_index: Some(index),
                id: id.into(),
                name: name.into(),
                status: status.into(),
                input: state["input"].clone(),
                metadata: state["metadata"].clone(),
                output: text_parts.collect::<Vec<_>>().join("\n"),
                error: error.into(),
                pictures: media::tool_pictures(
                    state,
                    v["id"].as_str().unwrap_or_default(),
                    index,
                    &mut media_bytes,
                ),
                started: part["time"]["ran"]
                    .as_u64()
                    .filter(|at| *at > 0)
                    .or_else(|| part["time"]["created"].as_u64())
                    .filter(|at| *at > 0),
                message_created: v["time"]["created"].as_u64().filter(|at| *at > 0),
                ended: part["time"]["completed"].as_u64().filter(|at| *at > 0),
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

pub(crate) fn json_bytes(v: &Value) -> usize {
    let (nodes, text) = resident_json(v);
    nodes.saturating_add(text)
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
                Part::Reasoning(t) => t.text.len(),
                Part::SubagentReport(_) => 0,
                Part::Tool(t) => t.bytes,
                Part::Skill(s) => s.id.len() + s.skill_id.len() + s.name.len(),
                Part::File(f) => file_bytes(f),
            })
            .sum::<usize>()
}

pub(crate) fn reasoning_bytes(parts: &[Part]) -> usize {
    parts
        .iter()
        .filter_map(|part| match part {
            Part::Reasoning(part) => Some(part.text.len()),
            _ => None,
        })
        .sum()
}

pub(crate) fn tool_text_bytes(parts: &[Part]) -> usize {
    parts
        .iter()
        .filter_map(|part| match part {
            Part::Tool(tool) => Some(tool.output_bytes),
            Part::SubagentReport(report) => {
                Some(report.body.len() + report.child.len() + report.state.len())
            }
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

pub(crate) fn media_bytes(parts: &[Part]) -> usize {
    parts
        .iter()
        .map(|part| match part {
            Part::Tool(tool) => tool.media_bytes(),
            _ => 0,
        })
        .sum()
}
fn file_bytes(file: &File) -> usize {
    file.id.len()
        + file.mime.len()
        + file.name.as_ref().map_or(0, String::len)
        + file
            .picture
            .as_ref()
            .map_or(0, PictureSource::retained_bytes)
        + file
            .reference
            .as_ref()
            .map_or(0, |r| r.message.len() + r.sha256.len())
}
