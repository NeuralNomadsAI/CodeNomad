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
        ("completed" | "error", "streaming" | "running") => true,
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
            if saved.len() >= published.len()
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
                            let mut merged = sse.clone();
                            if let (Some(dst), Some(src)) =
                                (merged.as_object_mut(), http.as_object())
                                && !dst.contains_key("input")
                                && let Some(input) = src.get("input")
                            {
                                dst.insert("input".into(), input.clone());
                            }
                            merged
                        } else {
                            http.clone()
                        }
                    })
                    .chain(saved.iter().skip(published.len()).cloned())
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
        let fetched_started = fetched.started;
        let fetched_message_created = fetched.message_created;
        *fetched = live.clone();
        let merged = Arc::make_mut(fetched);
        merged.part_index = index;
        if merged.started.is_none() {
            merged.started = fetched_started;
        }
        if merged.message_created.is_none() {
            merged.message_created = fetched_message_created;
        }
    } else if matches!(fetched.status.as_str(), "streaming" | "running") {
        if live.status == "running" && fetched.started.is_none() && live.started.is_some() {
            Arc::make_mut(fetched).started = live.started;
        }
        if fetched.ended.is_none() && live.ended.is_some() {
            Arc::make_mut(fetched).ended = live.ended;
        }
    }
}

pub(crate) enum Fit {
    Applied(Arc<Tool>),
    Settled(Arc<Tool>),
    Drop,
    Repair,
}

#[cfg(test)]
fn apply(row: &mut Message, kind: &str, data: &Value) -> Fit {
    apply_at(row, kind, data, None)
}

pub(crate) fn apply_at(row: &mut Message, kind: &str, data: &Value, at: Option<u64>) -> Fit {
    let at = at.filter(|at| *at > 0);
    let Some(id) = data["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
    else {
        return Fit::Repair;
    };
    let terminal = matches!(kind, "session.tool.success" | "session.tool.failed");
    if row.role != "assistant" || (row.completed && !terminal) {
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
            started: at,
            message_created: None,
            ended: None,
            pictures: Vec::new(),
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
            if tool.status != "streaming" || tool.ended.is_some() {
                return Fit::Drop;
            }
            tool.status = "running".into();
            tool.started = at.or(tool.started);
            tool.input = data["input"].clone();
            tool.metadata = Value::Null;
        }
        "session.tool.progress" => {
            if tool.ended.is_some() {
                return Fit::Drop;
            }
            if tool.status != "running" {
                return if tool.status == "streaming" {
                    Fit::Repair
                } else {
                    Fit::Drop
                };
            }
            tool.metadata = data["metadata"].clone();
        }
        "session.tool.success" | "session.tool.failed" => {
            if !matches!(tool.status.as_str(), "streaming" | "running") {
                return Fit::Drop;
            }
            let Some(ended) = at.or(tool.ended) else {
                return Fit::Repair;
            };
            tool.ended = Some(ended);
            if kind == "session.tool.success" {
                tool.status = "completed".into();
                if let Some(items) = data["content"].as_array() {
                    let mut out = String::new();
                    let mut fits = true;
                    for text in items
                        .iter()
                        .filter(|item| item["type"] == "text")
                        .filter_map(|item| item["text"].as_str())
                    {
                        let add = text.len() + usize::from(!out.is_empty());
                        if out.len().saturating_add(add) > LIVE_BYTES {
                            fits = false;
                            break;
                        }
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(text);
                    }
                    if fits {
                        tool.output = out;
                    }
                }
            } else {
                tool.status = "error".into();
                if let Some(msg) = data["error"]["message"]
                    .as_str()
                    .or_else(|| data["error"].as_str())
                    && msg.len() <= LIVE_BYTES
                {
                    tool.error = msg.into();
                }
            }
            if let Some(meta) = data.get("metadata").filter(|m| !m.is_null()) {
                let (nodes, bytes) = resident_json(meta);
                if nodes.saturating_add(bytes) <= LIVE_BYTES {
                    tool.metadata = meta.clone();
                }
            }
            measure(&mut tool);
            if tool.bytes.saturating_add(tool.output_bytes) > LIVE_BYTES {
                // Keep settled status and frozen timer even when payload awaits HTTP.
                tool.output.clear();
                tool.error.clear();
                tool.metadata = Value::Null;
                measure(&mut tool);
            }
            let tool = Arc::new(tool);
            *prior = tool.clone();
            return Fit::Settled(tool);
        }
        _ => return Fit::Repair,
    }
    measure(&mut tool);
    if tool.name == "execute"
        && kind == "session.tool.progress"
        && tool.bytes.saturating_add(tool.output_bytes) > LIVE_BYTES
        && let Some(calls) = tool
            .metadata
            .as_object_mut()
            .and_then(|fields| fields.get_mut("toolCalls"))
            .and_then(Value::as_array_mut)
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

    #[test]
    fn running_http_page_without_timestamp_preserves_live_start() {
        let mut live =
            crate::history::decode_message(&json!({"id":"row","type":"assistant"})).unwrap();
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.input.started",
                &json!({"id":"call","name":"bash"}),
                Some(1_000)
            ),
            Fit::Applied(_)
        ));
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.called",
                &json!({"id":"call","input":{"command":"sleep 5"}}),
                Some(2_000)
            ),
            Fit::Applied(_)
        ));
        let mut fetched = [Arc::new(
            crate::history::decode_message(&json!({
                "id":"row","type":"assistant","content":[
                    {"type":"tool","id":"call","name":"bash","state":{"status":"running","input":{"command":"sleep 5"}}}
                ]
            }))
            .unwrap(),
        )];
        crate::content::merge_page(&[Arc::new(live)], &mut fetched).unwrap();
        let Part::Tool(tool) = &fetched[0].parts[0] else {
            panic!("tool part")
        };
        assert_eq!(tool.started, Some(2_000));
    }

    #[test]
    fn tool_success_and_failed_settle_immediately_with_end_timestamp() {
        let mut live =
            crate::history::decode_message(&json!({"id":"row","type":"assistant"})).unwrap();
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.input.started",
                &json!({"id":"a","name":"bash"}),
                Some(1_000)
            ),
            Fit::Applied(_)
        ));
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.called",
                &json!({"id":"a","input":{"command":"echo hi"}}),
                Some(2_000)
            ),
            Fit::Applied(_)
        ));
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.progress",
                &json!({"id":"a","metadata":{"output":"hi"}}),
                Some(2_500)
            ),
            Fit::Applied(_)
        ));
        let Fit::Settled(done) = apply_at(
            &mut live,
            "session.tool.success",
            &json!({"id":"a","content":[{"type":"text","text":"hi"}]}),
            Some(5_000),
        ) else {
            panic!("expected Settled")
        };
        assert_eq!(done.status, "completed");
        assert_eq!(done.started, Some(2_000));
        assert_eq!(done.ended, Some(5_000));
        assert_eq!(done.output, "hi");
        assert_eq!(done.metadata["output"], "hi");

        // A stale running HTTP page must not revert a settled SSE tool or restart its timer.
        let mut stale = [Arc::new(
            crate::history::decode_message(&json!({
                "id":"row","type":"assistant","content":[
                    {"type":"tool","id":"a","name":"bash","time":{"ran":2000},"state":{"status":"running","input":{"command":"echo hi"}}}
                ]
            }))
            .unwrap(),
        )];
        crate::content::merge_page(&[Arc::new(live.clone())], &mut stale).unwrap();
        let Part::Tool(merged) = &stale[0].parts[0] else {
            panic!("tool part")
        };
        assert_eq!(merged.status, "completed");
        assert_eq!(merged.ended, Some(5_000));
        assert_eq!(merged.output, "hi");

        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.input.started",
                &json!({"id":"b","name":"bash"}),
                Some(6_000)
            ),
            Fit::Applied(_)
        ));
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.called",
                &json!({"id":"b","input":{"command":"false"}}),
                Some(6_500)
            ),
            Fit::Applied(_)
        ));
        let Fit::Settled(failed) = apply_at(
            &mut live,
            "session.tool.failed",
            &json!({"id":"b","error":{"message":"exit 1"}}),
            Some(8_000),
        ) else {
            panic!("expected Settled")
        };
        assert_eq!(failed.status, "error");
        assert_eq!(failed.error, "exit 1");
        assert_eq!(failed.ended, Some(8_000));

        // Even if `called` was missed and live stayed `streaming`, a running HTTP page inherits `ended`.
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.input.started",
                &json!({"id":"c","name":"bash"}),
                Some(9_000)
            ),
            Fit::Applied(_)
        ));
        assert!(matches!(
            apply_at(
                &mut live,
                "session.tool.success",
                &json!({"id":"c"}),
                Some(11_000)
            ),
            Fit::Settled(_)
        ));
        let mut running_c = [Arc::new(
            crate::history::decode_message(&json!({
                "id":"row","type":"assistant","content":[
                    {"type":"tool","id":"c","name":"bash","time":{"ran":9500},"state":{"status":"running","input":{"command":"true"}}}
                ]
            }))
            .unwrap(),
        )];
        crate::content::merge_page(&[Arc::new(live)], &mut running_c).unwrap();
        let merged_c = running_c[0]
            .parts
            .iter()
            .find_map(|part| match part {
                Part::Tool(tool) if tool.id == "c" => Some(tool),
                _ => None,
            })
            .expect("merged tool c");
        assert_eq!(merged_c.ended, Some(11_000));

        // A terminal SSE event still settles a running tool on a completed assistant row.
        let mut done_row = crate::history::decode_message(&json!({
            "id":"done","type":"assistant","time":{"completed":12_000},"content":[
                {"type":"tool","id":"late","name":"bash","time":{"ran":10_000},"state":{"status":"running","input":{"command":"sleep 1"}}}
            ]
        }))
        .unwrap();
        let Fit::Settled(late) = apply_at(
            &mut done_row,
            "session.tool.success",
            &json!({"id":"late"}),
            Some(13_000),
        ) else {
            panic!("expected Settled on completed row")
        };
        assert_eq!(late.ended, Some(13_000));

        // Late called, progress or duplicate terminal events after settlement are dropped.
        assert!(matches!(
            apply_at(
                &mut done_row,
                "session.tool.progress",
                &json!({"id":"late","metadata":{"output":"overwrite"}}),
                Some(14_000)
            ),
            Fit::Drop
        ));
        assert!(matches!(
            apply_at(
                &mut done_row,
                "session.tool.failed",
                &json!({"id":"late"}),
                Some(15_000)
            ),
            Fit::Drop
        ));
        // Completed HTTP page that still reports the tool running preserves SSE ended.
        let mut stale_done = [Arc::new(
            crate::history::decode_message(&json!({
                "id":"done","type":"assistant","time":{"completed":12_000},"content":[
                    {"type":"tool","id":"late","name":"bash","time":{"ran":10_000},"state":{"status":"running","input":{"command":"sleep 1"}}}
                ]
            }))
            .unwrap(),
        )];
        crate::content::merge_page(&[Arc::new(done_row)], &mut stale_done).unwrap();
        let Part::Tool(merged_late) = &stale_done[0].parts[0] else {
            panic!("tool part")
        };
        assert_eq!(merged_late.ended, Some(13_000));

        // Oversized non-object execute metadata returns Repair without panicking, and equal-length
        // execute toolCalls preserve HTTP inputs while adopting settled SSE statuses.
        let mut exec_row =
            crate::history::decode_message(&json!({"id":"ex","type":"assistant"})).unwrap();
        assert!(matches!(
            apply_at(
                &mut exec_row,
                "session.tool.input.started",
                &json!({"id":"e1","name":"execute"}),
                Some(1_000)
            ),
            Fit::Applied(_)
        ));
        assert!(matches!(
            apply_at(
                &mut exec_row,
                "session.tool.called",
                &json!({"id":"e1","input":{"code":"1"}}),
                Some(1_500)
            ),
            Fit::Applied(_)
        ));
        assert!(matches!(
            apply_at(
                &mut exec_row,
                "session.tool.progress",
                &json!({"id":"e1","metadata":"x".repeat(LIVE_BYTES + 32)}),
                Some(1_600)
            ),
            Fit::Repair
        ));
        assert!(matches!(
            apply_at(
                &mut exec_row,
                "session.tool.progress",
                &json!({"id":"e1","metadata":{"toolCalls":[{"tool":"read","status":"completed"}]}}),
                Some(1_700)
            ),
            Fit::Applied(_)
        ));
        let mut exec_http = [Arc::new(
            crate::history::decode_message(&json!({
                "id":"ex","type":"assistant","content":[
                    {"type":"tool","id":"e1","name":"execute","state":{"status":"running",
                     "metadata":{"toolCalls":[{"tool":"read","status":"running","input":{"filePath":"a.rs"}}]}}}
                ]
            }))
            .unwrap(),
        )];
        crate::content::merge_page(&[Arc::new(exec_row)], &mut exec_http).unwrap();
        let Part::Tool(merged_exec) = &exec_http[0].parts[0] else {
            panic!("tool part")
        };
        assert_eq!(merged_exec.metadata["toolCalls"][0]["status"], "completed");
        assert_eq!(
            merged_exec.metadata["toolCalls"][0]["input"]["filePath"],
            "a.rs"
        );
    }
}
