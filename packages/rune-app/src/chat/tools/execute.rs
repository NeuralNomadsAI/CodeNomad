//! Passive Code Mode transcript details.
use super::{TOOL_LIMIT, bounded_json, input_json, window};
use crate::{
    State,
    chat::document::{self, HIGHLIGHT_LIMIT},
    content::Tool,
    screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
    markdown,
    timeline::search::Query,
};
use serde_json::Value;

const CALL_LIMIT: usize = 200;

fn calls(tool: &Tool) -> impl Iterator<Item = (&str, &'static str, &Value)> + Clone {
    tool.metadata["toolCalls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| {
            let name = call["tool"].as_str().filter(|name| !name.is_empty())?;
            let status = match call["status"].as_str()? {
                "running" => "toolCall.status.running",
                "completed" => "toolCall.status.completed",
                "error" => "toolCall.status.error",
                _ => return None,
            };
            Some((name, status, &call["input"]))
        })
}

pub(super) fn title(tool: &Tool) -> String {
    let mut counts = std::collections::HashMap::<&str, usize>::new();
    let mut first = Vec::new();
    for (name, _, _) in calls(tool) {
        let count = counts.entry(name).or_default();
        if *count == 0 && first.len() < 4 {
            first.push(name);
        }
        *count += 1;
    }
    let omitted = counts.len().saturating_sub(4);
    let summary = first
        .into_iter()
        .map(|name| {
            let count = counts[name];
            let name: String = name.chars().take(50).collect();
            if count > 1 {
                format!("{name} ×{count}")
            } else {
                name
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut title = t("toolCall.execute.script").to_owned();
    if !summary.is_empty() {
        title.push_str(" · ");
        title.push_str(&summary);
    }
    if omitted > 0 {
        title.push_str(&format!(" +{omitted}"));
    }
    title
}

pub(super) fn view(s: &State, key: &str, tool: &Tool, query: Option<Query<'_>>) -> Option<El> {
    let code = tool.input["code"]
        .as_str()
        .filter(|code| !code.trim().is_empty());
    let calls = calls(tool);
    let count = calls.clone().count();
    if code.is_none() && count == 0 {
        return None;
    }
    let active = query.is_some_and(|q| q.active);
    let limit = document::search_limit_for(s, key, query);
    let mut body = col().full_width().separate(Space::Sm);
    let wrap = !s.transcript_display.toggled(&format!("{key}-wrap"));
    if let Some(code) = code {
        body = body.child(crate::chat::reading::inner_scroller(
            markdown::tool_pane(
                window(
                    s,
                    format!("{key}-execute-script"),
                    &[code],
                    limit,
                    |shown, units| {
                        markdown::search_code(
                            shown,
                            "javascript",
                            tool.status != "running" && units <= HIGHLIGHT_LIMIT,
                            wrap,
                            query,
                        )
                    },
                ),
                false,
            ),
            !wrap,
        ));
    }
    if count == 0 {
        return Some(body);
    }
    let mut list = col()
        .role("list")
        .label(t("toolCall.execute.calls"))
        .separate(Space::Sm);
    let search_id = active
        .then(|| {
            s.transcript_display
                .search_highlight
                .as_ref()
                .map(|hit| hit.id)
        })
        .flatten()
        .unwrap_or(0);
    for (index, (name, status, input)) in calls.take(CALL_LIMIT).enumerate() {
        let call = format!("{key}-execute-call-{index}");
        let manual = s.transcript_display.toggled(&call);
        let rendered_input = (input.is_object() && (manual || active))
            .then(|| input_json(input, TOOL_LIMIT, false))
            .flatten();
        let search_match = active
            && rendered_input
                .as_deref()
                .is_some_and(|text| query.is_some_and(|q| q.matches(text)));
        let expanded = if search_match {
            s.transcript_display
                .execute_search_expanded(search_id, &call, true)
        } else {
            manual
        };
        let name: String = name.chars().take(250).collect();
        let mut row = col().key(call.clone()).role("listitem").child(
            layout::action_row()
                .child(if input.is_object() {
                    let toggle = call.clone();
                    layout::button(
                        &name,
                        false,
                        screen::action(&s.input_scope, move |s| {
                            if search_match {
                                super::Display::set_execute_search_expanded(
                                    s, search_id, &toggle, !expanded,
                                );
                            } else {
                                super::Display::toggle(s, &toggle);
                            }
                        }),
                    )
                    .key(format!("toggle-{call}"))
                    .expanded(expanded)
                } else {
                    text(name)
                })
                .child(text(t(status)).text_role(TextRole::Label)),
        );
        if expanded && input.is_object() {
            row = row.child(if let Some(input) = rendered_input {
                crate::chat::reading::inner_scroller(
                    markdown::tool_pane(
                        window(
                            s,
                            format!("{call}-input"),
                            &[&input],
                            TOOL_LIMIT,
                            |shown, units| {
                                markdown::search_code(
                                    shown,
                                    "json",
                                    tool.status != "running" && units <= HIGHLIGHT_LIMIT,
                                    wrap,
                                    query,
                                )
                            },
                        ),
                        false,
                    ),
                    !wrap,
                )
            } else {
                text(t("toolCall.output.tooLarge"))
            });
        }
        list = list.child(row);
    }
    if count > CALL_LIMIT {
        list = list.child(text(catalogue::format(
            locale(),
            "toolCall.execute.more",
            &[("count", &(count - CALL_LIMIT).to_string())],
        )));
    }
    Some(body.child(list))
}

pub(super) fn notice(tool: &Tool) -> Option<El> {
    if tool.metadata["truncated"] != true {
        return None;
    }
    let path: String = tool.metadata["outputPath"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(500)
        .collect();
    Some(text(format!("{} {path}", t("toolCall.execute.truncated"))).wrap())
}

pub(super) fn formatted_output(output: &str) -> Option<String> {
    const LIMIT: usize = 200_000;
    if output.len() > LIMIT {
        return None;
    }
    let end = ["\n\nWarnings:\n", "\n\nLogs:\n"]
        .into_iter()
        .filter_map(|marker| output.find(marker))
        .min()
        .unwrap_or(output.len());
    if !output[..end].trim_start().starts_with(['{', '[']) {
        return None;
    }
    let data = serde_json::from_str::<Value>(&output[..end]).ok()?;
    if !within_depth(&data, 64) {
        return None;
    }
    Some(bounded_json(&data, LIMIT * 4)? + &output[end..])
}

fn within_depth(value: &Value, remaining: usize) -> bool {
    match value {
        Value::Array(items) => {
            remaining > 0 && items.iter().all(|item| within_depth(item, remaining - 1))
        }
        Value::Object(items) => {
            remaining > 0 && items.values().all(|item| within_depth(item, remaining - 1))
        }
        _ => true,
    }
}

#[cfg(test)]
#[test]
fn execute_progress_is_rendered_and_keeps_an_open_call() {
    use crate::{Phase, content::Part, history, init, transport::Event};
    use rune::{Env, Runtime};
    use serde_json::json;

    let row = |status| {
        history::decode_message(&json!({"id":"step","type":"assistant","content":[{
            "type":"tool","id":"call","name":"execute","state":{"status":"running",
                "input":{"code":"// fixture script"},"metadata":{"toolCalls":[
                    {"tool":"sample_then","status":status,"input":{"marker":"visible argument"}},
                    {"tool":"not a native status","status":"unknown"}
                ]}}
        }]}))
        .unwrap()
    };
    let mut state = init();
    state.phase = Phase::Streaming;
    state.messages.push(row("running").into());
    let (out, queue) = crate::bounded(4);
    state.incoming = Some(queue);
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    let (x, y) = rt.find("toggle-tool-step:4:call-execute-call-0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("visible argument") && tree.contains("Nested tool calls"));
    assert!(!tree.contains("not a native status"));
    let [Part::Tool(tool)] = &row("completed").parts[..] else {
        panic!("expected execute")
    };
    out.try_send(Event::Tool("step".into(), tool.clone()))
        .unwrap();
    rt.frame(0.02);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Completed") && tree.contains("visible argument"));
}

#[cfg(test)]
#[test]
fn execute_pretty_output_keeps_warnings_and_rejects_deep_output() {
    assert_eq!(
        formatted_output("{\"ok\":true}\n\nWarnings:\nfixture").as_deref(),
        Some("{\n  \"ok\": true\n}\n\nWarnings:\nfixture")
    );
    assert_eq!(
        formatted_output(&format!("{}0{}", "[".repeat(65), "]".repeat(65))),
        None
    );
}

#[cfg(test)]
#[test]
fn execute_summary_counts_past_the_render_limit_and_reports_native_error() {
    use crate::{Phase, content::Part, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let calls: Vec<_> = (0..201)
        .map(|_| json!({"tool":"sample","status":"completed"}))
        .collect();
    let row = history::decode_message(&json!({"id":"step","type":"assistant","time":{"completed":2},"content":[
        {"type":"tool","id":"exec","name":"execute","state":{"status":"completed","metadata":{"toolCalls":calls,"error":true}}},
        {"type":"tool","id":"read","name":"read","state":{"status":"completed","metadata":{"error":true}}}
    ]})).unwrap();
    let Part::Tool(tool) = &row.parts[0] else {
        panic!("expected execute")
    };
    assert!(title(tool).contains("sample ×201"));
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages.push(row.into());
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 760.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let status = |tool: &str, label: &str| {
        rt.elements()
            .into_iter()
            .any(|element| element.path.contains(tool) && element.text.as_deref() == Some(label))
    };
    assert!(status("tool-step:4:exec", "Error"));
    assert!(status("tool-step:4:read", "Completed"));
}
