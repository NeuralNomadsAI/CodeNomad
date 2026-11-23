//! The native tool event transitions used before the authoritative page settles.
use super::{Part, Tool, resident_json};
use crate::Message;
use serde_json::Value;
use std::{mem::size_of, sync::Arc};

const LIVE_BYTES: usize = 256 * 1024;

fn no_progress(metadata: &Value) -> bool {
    metadata.is_null() || metadata.as_object().is_some_and(|fields| fields.is_empty())
}

pub(super) fn merge(live: &Arc<Tool>, fetched: &mut Arc<Tool>) {
    let replace = match (live.status.as_str(), fetched.status.as_str()) {
        ("streaming", "streaming") => live
            .input
            .as_str()
            .zip(fetched.input.as_str())
            .is_some_and(|(live, fetched)| live.len() > fetched.len() && live.starts_with(fetched)),
        ("running", "streaming") => true,
        ("running", "running")
            if no_progress(&fetched.metadata) && !no_progress(&live.metadata) =>
        {
            // Native history can retain the initial {} after SSE-only progress.
            let snapshot = Arc::make_mut(fetched);
            snapshot.metadata = live.metadata.clone();
            measure(snapshot);
            false
        }
        _ => false,
    };
    if replace {
        *fetched = live.clone();
    }
}

pub(crate) enum Fit {
    Applied(Arc<Tool>),
    Drop,
    Repair,
}

pub(crate) fn apply(row: &mut Message, kind: &str, data: &Value) -> Fit {
    let Some(id) = data["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
    else {
        return Fit::Repair;
    };
    if row.role != "assistant" || row.completed {
        return Fit::Drop;
    }
    let prior = row.parts.iter_mut().find_map(|part| match part {
        Part::Tool(tool) if tool.id == id => Some(tool),
        _ => None,
    });
    if kind == "session.tool.input.started" {
        if prior.is_some() {
            return Fit::Drop;
        }
        let Some(name) = data["name"].as_str().filter(|name| name.len() <= 256) else {
            return Fit::Repair;
        };
        if row.parts.len() >= 1000 {
            return Fit::Repair;
        }
        let mut tool = Tool {
            id: id.into(),
            name: name.into(),
            status: "streaming".into(),
            input: Value::String(String::new()),
            metadata: Value::Null,
            output: String::new(),
            error: String::new(),
            bytes: 0,
            output_bytes: 0,
        };
        measure(&mut tool);
        let tool = Arc::new(tool);
        install(row, tool.clone());
        return Fit::Applied(tool);
    }
    let Some(prior) = prior else {
        return Fit::Repair;
    };
    let mut tool = (**prior).clone();
    match kind {
        "session.tool.input.delta" | "session.tool.input.ended" => {
            if tool.status != "streaming" {
                return Fit::Drop;
            }
            let Some(input) = tool.input.as_str() else {
                return Fit::Repair;
            };
            let append = kind.ends_with(".delta");
            let Some(next) = data[if append { "delta" } else { "text" }].as_str() else {
                return Fit::Repair;
            };
            let prefix = if append { input } else { "" };
            if prefix.len().saturating_add(next.len()) > LIVE_BYTES {
                return Fit::Repair;
            }
            tool.input = Value::String(format!("{prefix}{next}"));
        }
        "session.tool.called" => {
            if tool.status != "streaming" {
                return Fit::Drop;
            }
            tool.status = "running".into();
            tool.input = data["input"].clone();
            tool.metadata = Value::Null;
        }
        "session.tool.progress" => {
            if tool.status != "running" {
                return if tool.status == "streaming" {
                    Fit::Repair
                } else {
                    Fit::Drop
                };
            }
            tool.metadata = data["metadata"].clone();
        }
        _ => return Fit::Repair,
    }
    measure(&mut tool);
    if tool.bytes.saturating_add(tool.output_bytes) > LIVE_BYTES {
        return Fit::Repair;
    }
    let tool = Arc::new(tool);
    *prior = tool.clone();
    Fit::Applied(tool)
}

fn measure(tool: &mut Tool) {
    let (input_nodes, input_text) = resident_json(&tool.input);
    let (metadata_nodes, metadata_text) = resident_json(&tool.metadata);
    tool.bytes = size_of::<Tool>()
        + tool.id.len()
        + tool.name.len()
        + tool.status.len()
        + input_nodes
        + input_text
        + metadata_nodes;
    tool.output_bytes = metadata_text + tool.output.len() + tool.error.len();
}

pub fn install(row: &mut Message, tool: Arc<Tool>) {
    if let Some(current) = row.parts.iter_mut().find_map(|part| match part {
        Part::Tool(current) if current.id == tool.id => Some(current),
        _ => None,
    }) {
        *current = tool;
    } else {
        row.parts.push(Part::Tool(tool));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn input_appends_but_progress_replaces() {
        let mut row =
            crate::history::decode_message(&json!({"id":"row","type":"assistant"})).unwrap();
        let events = [
            ("input.started", json!({"id":"call","name":"bash"})),
            ("input.delta", json!({"id":"call","delta":"{\"command\":"})),
            ("input.delta", json!({"id":"call","delta":"\"sample\"}"})),
        ];
        for (kind, data) in events {
            assert!(matches!(
                apply(&mut row, &format!("session.tool.{kind}"), &data),
                Fit::Applied(_)
            ));
        }
        let Part::Tool(tool) = &row.parts[0] else {
            panic!("tool part")
        };
        assert_eq!(tool.input, "{\"command\":\"sample\"}");
        for (kind, data) in [
            ("called", json!({"id":"call","input":{"command":"sample"}})),
            (
                "progress",
                json!({"id":"call","metadata":{"output":"first","title":"old"}}),
            ),
            (
                "progress",
                json!({"id":"call","metadata":{"output":"second"}}),
            ),
        ] {
            assert!(matches!(
                apply(&mut row, &format!("session.tool.{kind}"), &data),
                Fit::Applied(_)
            ));
        }
        let Part::Tool(tool) = &row.parts[0] else {
            panic!("tool part")
        };
        assert_eq!(tool.metadata, json!({"output":"second"}));
        assert!(matches!(
            apply(
                &mut row,
                "session.tool.input.delta",
                &json!({"id":"call","delta":"stale"})
            ),
            Fit::Drop
        ));
        assert!(matches!(
            apply(
                &mut row,
                "session.tool.progress",
                &json!({"id":"missing","metadata":{}})
            ),
            Fit::Repair
        ));
    }
}
