use super::{
    Display, Tool,
    children::{Children, STEP_LIMIT},
    input_json, string, window,
};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
    markdown,
};

const PANE_LIMIT: usize = 20_000;
const INITIAL_STEPS: usize = 30;
const REVEAL: usize = 100;

pub(super) fn is_task(tool: &Tool) -> bool {
    matches!(tool.name.as_str(), "task" | "subagent")
}

pub(super) fn detail(tool: &Tool) -> String {
    let description = string(&tool.input, &["description"]);
    let agent = string(&tool.input, &["subagent_type", "agent"]);
    if description.is_empty() {
        String::new()
    } else if agent.is_empty() {
        description.chars().take(250).collect()
    } else {
        format!("[{agent}] {description}")
            .chars()
            .take(250)
            .collect()
    }
}

fn child(tool: &Tool) -> &str {
    string(&tool.metadata, &["sessionId", "sessionID"])
}

pub(super) fn report<'a>(s: &'a State, tool: &Tool) -> Option<&'a crate::content::SubagentReport> {
    use crate::content::Part;
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    let from = tool.started?;
    let child_id = child(tool);
    if child_id.is_empty() {
        return None;
    }
    let rows = &s.messages[s.messages.len().saturating_sub(500)..];
    let mut boundaries: Vec<_> = rows
        .iter()
        .flat_map(|row| &row.parts)
        .filter_map(|part| match part {
            Part::Tool(other) if is_task(other) && child(other) == child_id => {
                other.started.filter(|at| *at > from)
            }
            _ => None,
        })
        .collect();
    boundaries.sort_unstable();
    let reports = || {
        rows.iter().flat_map(|row| {
            row.parts.iter().filter_map(move |part| match part {
                Part::SubagentReport(report)
                    if report.child == child_id && report.created >= from =>
                {
                    Some((report.created, row.id.as_str(), report))
                }
                _ => None,
            })
        })
    };
    let first = reports().map(|(created, _, _)| created).min()?;
    let end = boundaries
        .into_iter()
        .find(|next| *next > first)
        .unwrap_or(u64::MAX);
    reports()
        .filter(|(created, _, _)| *created < end)
        .max_by_key(|(created, id, _)| (*created, *id))
        .map(|(_, _, report)| report)
}

pub(super) fn output<'a>(
    tool: &'a Tool,
    report: Option<&'a crate::content::SubagentReport>,
) -> &'a str {
    if tool.status == "completed" && tool.metadata["status"] == "running" {
        report.map_or("", |report| report.body.as_str())
    } else {
        &tool.output
    }
}

pub(super) fn status(s: &State, tool: &Tool) -> Option<&'static str> {
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    use crate::content::Part;
    let child_id = child(tool);
    let rows = &s.messages[s.messages.len().saturating_sub(500)..];
    let newest = rows
        .iter()
        .flat_map(|row| &row.parts)
        .filter_map(|part| match part {
            Part::Tool(other) if is_task(other) && child(other) == child_id => other.started,
            _ => None,
        })
        .max()
        .or(tool.started);
    let latest = newest.and_then(|from| {
        rows.iter()
            .flat_map(|row| {
                row.parts.iter().filter_map(move |part| match part {
                    Part::SubagentReport(report)
                        if report.child == child_id && report.created >= from =>
                    {
                        Some((report.created, row.id.as_str(), report.state.as_str()))
                    }
                    _ => None,
                })
            })
            .max_by_key(|(created, id, _)| (*created, *id))
            .map(|(_, _, state)| state)
    });
    Some(match latest {
        Some("completed") => "toolCall.status.completed",
        Some("error" | "cancelled") => "toolCall.status.error",
        _ => "toolCall.status.running",
    })
}

pub(super) fn body(s: &State, key: &str, tool: &Tool, output: &str, watch: bool) -> Option<El> {
    let prompt = string(&tool.input, &["prompt"]);
    let child_id = watch.then(|| watched_child(tool)).flatten();
    let child_steps = child_id.map_or(&[][..], |id| s.transcript_display.children.steps(id));
    let legacy = tool.metadata["summary"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let step_count = if child_steps.is_empty() {
        legacy.len()
    } else {
        child_steps.len()
    };
    if prompt.trim().is_empty() && step_count == 0 && output.trim().is_empty() && child_id.is_none()
    {
        return None;
    }
    let mut result = col().full_width().separate(Space::Sm);
    for (section, label, value) in [
        ("prompt", "toolCall.task.sections.prompt", prompt),
        ("output", "toolCall.task.sections.output", output),
    ] {
        if !value.trim().is_empty() {
            result = result
                .child(text(t(label)).text_role(TextRole::Label))
                .child(markdown::tool_pane(
                    super::super::document::prose_at(
                        s,
                        format!("{key}-task-{section}"),
                        value,
                        tool.status == "running" && section == "output",
                        PANE_LIMIT,
                    ),
                    true,
                ));
        }
    }
    if step_count > 0 {
        let step_key = format!("{key}-task-steps");
        let count = (INITIAL_STEPS + REVEAL.saturating_mul(s.transcript_display.steps(&step_key)))
            .min(STEP_LIMIT);
        let start = step_count.saturating_sub(count);
        let mut list = col()
            .role("list")
            .label(t("toolCall.task.sections.steps"))
            .separate(Space::Sm);
        if start > step_count.saturating_sub(STEP_LIMIT) {
            let toggle = step_key.clone();
            let label = catalogue::format(
                locale(),
                "messageBlock.hiddenParts.show",
                &[("count", &start.min(REVEAL).to_string())],
            );
            list = list.child(
                layout::button(
                    &label,
                    false,
                    screen::action(&s.input_scope, move |s| {
                        Display::reveal_next(s, &toggle);
                    }),
                )
                .key(format!("reveal-{step_key}")),
            );
        }
        if let Some(child_id) = child_id.filter(|_| !child_steps.is_empty()) {
            for (message, step) in &child_steps[start..] {
                let owner = format!("child:{child_id}:{message}");
                let child_key = super::tool_key(&format!("{step_key}-{owner}"), &step.id);
                list = list.child(
                    col()
                        .key(child_key.clone())
                        .role("listitem")
                        .child(super::render(s, &owner, step, &child_key)),
                );
            }
        }
        for (index, step) in legacy
            .iter()
            .enumerate()
            .skip(start)
            .filter(|_| child_steps.is_empty())
        {
            let status = string(step, &["status"]);
            let status = if status.is_empty() {
                string(&step["state"], &["status"])
            } else {
                status
            };
            let status = match status {
                "pending" => "toolCall.status.pending",
                "running" => "toolCall.status.running",
                "completed" => "toolCall.status.completed",
                "error" => "toolCall.status.error",
                _ => "toolCall.status.unknown",
            };
            let name: String = string(step, &["title", "tool"]).chars().take(250).collect();
            let input = step.get("input").or_else(|| step["state"].get("input"));
            let key = format!("{step_key}-{index}");
            let expanded = s.transcript_display.toggled(&key);
            let label = if input.is_some_and(|input| input.is_object()) {
                let toggle = key.clone();
                layout::button(
                    &name,
                    false,
                    screen::action(&s.input_scope, move |s| Display::toggle(s, &toggle)),
                )
                .key(format!("toggle-{key}"))
                .expanded(expanded)
            } else {
                text(name)
            };
            let mut row = col()
                .key(key.clone())
                .role("listitem")
                .child(layout::action_row().child(label).child(text(t(status))));
            if expanded && let Some(input) = input {
                row = row.child(if let Some(input) = input_json(input, TOOL_LIMIT, false) {
                    window(
                        s,
                        format!("{key}-input"),
                        &[&input],
                        PANE_LIMIT,
                        |shown, _| markdown::code(shown, "json", true, true),
                    )
                } else {
                    text(t("toolCall.output.tooLarge"))
                });
            }
            list = list.child(row);
        }
        if step_count > STEP_LIMIT {
            list = list.child(
                text(catalogue::format(
                    locale(),
                    "toolCall.task.steps.truncated",
                    &[("count", &STEP_LIMIT.to_string())],
                ))
                .role("status"),
            );
        }
        result = result.child(markdown::tool_pane(list, true));
    }
    Some(result)
}

fn watched_child(tool: &Tool) -> Option<&str> {
    let id = child(tool);
    (matches!(tool.status.as_str(), "running" | "completed" | "error")
        && crate::history::valid_id(id))
    .then_some(id)
}

pub(super) fn observe(s: &State, key: &str, tool: &Tool, card: El) -> El {
    let Some(id) = watched_child(tool) else {
        return card;
    };
    let lease = s.transcript_display.children.lease(id, key);
    let (id, key, scope) = (id.to_owned(), key.to_owned(), s.input_scope.clone());
    col()
        .full_width()
        .key(format!("{key}-watch-{id}"))
        .child(card)
        .on_visible(move |s: &mut State, visible, tx| {
            if s.current_scope(&scope) {
                Children::demand(s, &id, &key, &lease, visible);
            }
            tx.live_only();
        })
}

#[cfg(test)]
#[test]
fn task_uses_its_own_background_report_and_keeps_the_synthetic_row_hidden() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let launch = |id, at| {
        history::decode_message(&json!({
        "id":id,"type":"assistant","time":{"created":at,"completed":at},"content":[{
            "type":"tool","id":"call","name":"subagent","time":{"ran":at},
            "state":{"status":"completed","input":{"description":"Check the fixture","prompt":"Bounded prompt"},
                "metadata":{"sessionId":"child","status":"running"},
                "content":[{"type":"text","text":"Launch acknowledgement"}]}}]
    })).unwrap()
    };
    let report_row = |id, at, text| {
        history::decode_message(&json!({
        "id":id,"type":"synthetic","time":{"created":at},
        "text":format!("<subagent sessionID=\"child\" state=\"completed\">\n{text}\n</subagent>")
    })).unwrap()
    };
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![
        launch("first", 10).into(),
        report_row("older", 20, "First result").into(),
        launch("second", 30).into(),
        report_row("latest", 40, "Second result").into(),
    ];
    let mut rt = Runtime::new(state, crate::view, (960.0, 900.0), Env::new(false, 1.0));
    rt.frame(0.0);
    let before = rt.accessibility_json().to_string();
    assert!(!before.contains("First result") && !before.contains("Second result"));
    let (x, y) = rt.find("toggle-tool-first:4:call").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let after = rt.accessibility_json().to_string();
    assert!(after.contains("First result") && after.contains("Bounded prompt"));
    assert!(!after.contains("Second result") && !after.contains("Launch acknowledgement"));
}

#[cfg(test)]
#[test]
fn loaded_child_cards_replace_the_legacy_summary() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let parent = history::decode_message(&json!({
        "id":"parent","type":"assistant","time":{"completed":1},"content":[{
            "type":"tool","id":"launch","name":"task","state":{"status":"completed",
              "metadata":{"sessionID":"child","status":"running",
                "summary":[{"tool":"bash","title":"Legacy summary only","status":"completed"}]}}
        }]
    }))
    .unwrap();
    let child = history::decode(json!({"status":"window","latest":true,"messages":[
        {"id":"child-step","type":"assistant","time":{},"content":[{
            "type":"tool","id":"read","name":"read","state":{"status":"running","input":{"filePath":"actual.txt"}}
        }]}
    ]})).unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages.push(parent.into());
    let mut rt = Runtime::new(state, crate::view, (960.0, 900.0), Env::new(false, 1.0));
    rt.frame(0.0);
    let (x, y) = rt.find("toggle-tool-parent:6:launch").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Legacy summary only")
    );
    let mut lease = None;
    rt.update(|s, _| {
        lease = Some(s.transcript_display.children.install("child", child));
        assert!(crate::chat::events::poll_chat(s, 1));
    });
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("actual.txt") && !tree.contains("Legacy summary only"));
}
