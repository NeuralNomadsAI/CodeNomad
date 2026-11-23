//! The native tool event transitions used before the authoritative page settles.
use super::{Part, Tool, resident_json};
use crate::Message;
use serde_json::Value;
use std::{mem::size_of, sync::Arc};

const LIVE_BYTES: usize = 256 * 1024;

fn no_progress(metadata: &Value) -> bool {
    metadata.is_null() || metadata.as_object().is_some_and(|fields| fields.is_empty())
}

fn execute_calls(metadata: &Value) -> &[Value] {
    metadata["toolCalls"].as_array().map_or(&[], Vec::as_slice)
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
        ("running", "running") if live.name == "execute" && fetched.name == "execute" => {
            let saved = execute_calls(&live.metadata);
            let published = execute_calls(&fetched.metadata);
            if saved.len() > published.len()
                && saved
                    .iter()
                    .zip(published)
                    .all(|(a, b)| a["tool"] == b["tool"])
            {
                let calls = published
                    .iter()
                    .zip(saved)
                    .map(|(http, sse)| {
                        if http["status"] == "running" && sse["status"] != "running" {
                            sse
                        } else {
                            http
                        }
                    })
                    .chain(saved.iter().skip(published.len()))
                    .cloned()
                    .collect();
                let snapshot = Arc::make_mut(fetched);
                if let Some(fields) = snapshot.metadata.as_object_mut() {
                    fields.insert("toolCalls".into(), Value::Array(calls));
                }
                measure(snapshot);
            }
            false
        }
        _ => false,
    };
    if replace {
        let index = fetched.part_index;
        *fetched = live.clone();
        Arc::make_mut(fetched).part_index = index;
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
            part_index: None,
            id: id.into(),
            name: name.into(),
            status: "streaming".into(),
            input: Value::String(String::new()),
            metadata: Value::Null,
            output: String::new(),
            error: String::new(),
            started: None,
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
    if tool.name == "execute"
        && kind == "session.tool.progress"
        && tool.bytes.saturating_add(tool.output_bytes) > LIVE_BYTES
        && let Some(calls) = tool.metadata["toolCalls"].as_array_mut()
    {
        // Keep progress visible even when the nested inputs cannot be retained.
        for call in calls {
            if let Some(fields) = call.as_object_mut() {
                fields.remove("input");
            }
        }
        measure(&mut tool);
    }
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
    fn large_execute_progress_keeps_statuses_and_pages_recover_missing_calls() {
        let row = |metadata| {
            crate::history::decode_message(&json!({
            "id":"row","type":"assistant","content":[
                {"type":"tool","id":"call","name":"execute","state":{"status":"running","input":{},"metadata":metadata}}
            ]
        })).unwrap()
        };
        let mut live = row(json!({}));
        let calls: Vec<_> = (0..4)
            .map(|index| {
                json!({
                    "tool":"write","status":if index == 3 {"running"} else {"completed"},
                    "input":{"filePath":format!("{index}.txt"),"content":"x".repeat(70 * 1024)}
                })
            })
            .collect();
        let Fit::Applied(tool) = apply(
            &mut live,
            "session.tool.progress",
            &json!({"id":"call","metadata":{"toolCalls":calls}}),
        ) else {
            panic!("large progress snapshot was lost")
        };
        assert_eq!(execute_calls(&tool.metadata).len(), 4);
        assert_eq!(tool.metadata["toolCalls"][3]["status"], "running");
        assert!(
            execute_calls(&tool.metadata)
                .iter()
                .all(|call| call["tool"] == "write" && call.get("input").is_none())
        );
        assert!(tool.bytes + tool.output_bytes <= LIVE_BYTES);

        let mut behind = [Arc::new(row(
            json!({"title":"HTTP title","toolCalls":calls[..1]}),
        ))];
        crate::content::merge_page(&[Arc::new(live.clone())], &mut behind).unwrap();
        let Part::Tool(restored) = &behind[0].parts[0] else {
            panic!("tool part")
        };
        assert_eq!(execute_calls(&restored.metadata).len(), 4);
        assert_eq!(restored.metadata["title"], "HTTP title");
        assert_eq!(
            restored.metadata["toolCalls"][0]["input"]["content"]
                .as_str()
                .unwrap()
                .len(),
            70 * 1024
        );

        let older = row(json!({"toolCalls":calls[..1]}));
        let mut ahead = [Arc::new(row(json!({"toolCalls":calls})))];
        crate::content::merge_page(&[Arc::new(older)], &mut ahead).unwrap();
        let Part::Tool(restored) = &ahead[0].parts[0] else {
            panic!("tool part")
        };
        assert_eq!(execute_calls(&restored.metadata).len(), 4);
    }

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
