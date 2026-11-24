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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct HeaderStatus {
    pub status: &'static str,
    pub running: bool,
    pub ended: Option<u64>,
}

fn launch_time(tool: &Tool) -> Option<u64> {
    tool.started.or(tool.message_created)
}

pub(super) fn report<'a>(s: &'a State, tool: &Tool) -> Option<&'a crate::content::SubagentReport> {
    use crate::content::Part;
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    let from = launch_time(tool)?;
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
                launch_time(other).filter(|at| *at > from)
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

pub(super) fn header_status(s: &State, tool: &Tool) -> Option<HeaderStatus> {
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    use crate::content::Part;
    let child_id = child(tool);
    let latest = (!child_id.is_empty())
        .then(|| {
            let rows = &s.messages[s.messages.len().saturating_sub(500)..];
            let newest = rows
                .iter()
                .flat_map(|row| &row.parts)
                .filter_map(|part| match part {
                    Part::Tool(other) if is_task(other) && child(other) == child_id => {
                        launch_time(other)
                    }
                    _ => None,
                })
                .max()
                .or_else(|| launch_time(tool))
                .unwrap_or(0);
            rows.iter()
                .flat_map(|row| {
                    row.parts.iter().filter_map(move |part| match part {
                        Part::SubagentReport(report)
                            if report.child == child_id && report.created >= newest =>
                        {
                            Some((report.created, row.id.as_str(), report.state.as_str()))
                        }
                        _ => None,
                    })
                })
                .max_by_key(|(created, id, _)| (*created, *id))
                .map(|(created, _, state)| (created, state))
        })
        .flatten();
    Some(match latest {
        Some((created, "completed")) => HeaderStatus {
            status: "toolCall.status.completed",
            running: false,
            ended: (created > 0).then_some(created),
        },
        Some((created, "error" | "cancelled")) => HeaderStatus {
            status: "toolCall.status.error",
            running: false,
            ended: (created > 0).then_some(created),
        },
        _ => HeaderStatus {
            status: "toolCall.status.running",
            running: true,
            ended: None,
        },
    })
}

fn legacy_step_id(index: usize, step: &serde_json::Value) -> String {
    let id = string(step, &["id"]);
    if id.is_empty() {
        format!("legacy:{index}")
    } else {
        format!("legacy:{id}")
    }
}

pub(super) fn body(s: &State, key: &str, tool: &Tool, output: &str, watch: bool) -> Option<El> {
    let prompt = string(&tool.input, &["prompt"]);
    let child_id = watch.then(|| watched_child(tool)).flatten();
    let child_snapshot = child_id.and_then(|id| s.transcript_display.children.snapshot(id));
    let use_child = child_snapshot.is_some_and(|snap| !snap.steps.is_empty() || snap.truncated);
    let visible_steps: Vec<_> = child_snapshot
        .filter(|_| use_child)
        .map(|snap| {
            snap.steps
                .iter()
                .filter(|(message, step)| super::visible(s, message, step))
                .collect()
        })
        .unwrap_or_default();
    let legacy_all = tool.metadata["summary"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let legacy_base = legacy_all.len().saturating_sub(STEP_LIMIT);
    let legacy = &legacy_all[legacy_base..];
    let step_count = if use_child {
        visible_steps.len()
    } else {
        legacy.len()
    };
    let truncated = if use_child {
        child_snapshot.is_some_and(|snap| snap.truncated)
    } else {
        legacy_base > 0
    };
    if prompt.trim().is_empty()
        && step_count == 0
        && !truncated
        && output.trim().is_empty()
        && child_id.is_none()
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
    if step_count > 0 || truncated {
        let step_key = format!("{key}-task-steps");
        let mut section_header = layout::action_row()
            .child(text(t("toolCall.task.sections.steps")).text_role(TextRole::Label));
        if step_count > 0 {
            let count_label = catalogue::format(
                locale(),
                if step_count == 1 {
                    "toolCall.task.steps.count.one"
                } else {
                    "toolCall.task.steps.count.other"
                },
                &[("count", &step_count.to_string())],
            );
            section_header = section_header.child(text(count_label).text_role(TextRole::Label));
        }
        result = result.child(section_header);
        if truncated {
            let notice = match child_snapshot.filter(|_| use_child) {
                Some(snap) if snap.byte_truncated && snap.steps.is_empty() => {
                    t("toolCall.output.tooLarge").to_owned()
                }
                Some(snap) if snap.byte_truncated && snap.steps.len() < STEP_LIMIT => {
                    catalogue::format(
                        locale(),
                        "toolCall.task.steps.truncated",
                        &[("count", &snap.steps.len().to_string())],
                    )
                }
                _ => catalogue::format(
                    locale(),
                    "toolCall.task.steps.truncated",
                    &[("count", &STEP_LIMIT.to_string())],
                ),
            };
            result = result.child(text(notice).text_role(TextRole::Label).role("status"));
        }
        if step_count > 0 {
            let count = (INITIAL_STEPS
                + REVEAL.saturating_mul(s.transcript_display.steps(&step_key)))
            .min(STEP_LIMIT);
            let desired = step_count.saturating_sub(count);
            let anchor_index = s
                .transcript_display
                .task_anchor(&step_key)
                .and_then(|anchor| {
                    if use_child {
                        visible_steps
                            .iter()
                            .position(|(message, step)| format!("{message}:{}", step.id) == anchor)
                    } else {
                        legacy.iter().enumerate().position(|(offset, step)| {
                            legacy_step_id(legacy_base + offset, step) == anchor
                        })
                    }
                });
            let start = desired.min(anchor_index.unwrap_or(usize::MAX));
            let reveal_button = (start > 0).then(|| {
                let toggle = step_key.clone();
                let label = catalogue::format(
                    locale(),
                    "messageBlock.hiddenParts.show",
                    &[("count", &start.min(REVEAL).to_string())],
                );
                layout::button(
                    &label,
                    false,
                    screen::action(&s.input_scope, move |s| {
                        Display::reveal_next(s, &toggle);
                    }),
                )
                .key(format!("reveal-{step_key}"))
            });
            let mut mounted_ids = Vec::with_capacity(step_count.saturating_sub(start));
            let mut step_rows = Vec::with_capacity(step_count.saturating_sub(start));
            if let Some(child_id) = child_id.filter(|_| use_child) {
                for (message, step) in visible_steps.into_iter().skip(start) {
                    mounted_ids.push(format!("{message}:{}", step.id));
                    let owner = format!("child:{child_id}:{message}");
                    let child_key = super::tool_key(&format!("{step_key}-{owner}"), &step.id);
                    step_rows.push(
                        col()
                            .key(child_key.clone())
                            .role("listitem")
                            .child(super::render::render(s, &owner, step, &child_key)),
                    );
                }
            }
            for (offset, step) in legacy.iter().enumerate().skip(start).filter(|_| !use_child) {
                let index = legacy_base + offset;
                mounted_ids.push(legacy_step_id(index, step));
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
                    row = row.child(
                        if let Some(input) = input_json(input, super::TOOL_LIMIT, false) {
                            window(
                                s,
                                format!("{key}-input"),
                                &[&input],
                                PANE_LIMIT,
                                |shown, _| markdown::code(shown, "json", true, true),
                            )
                        } else {
                            text(t("toolCall.output.tooLarge"))
                        },
                    );
                }
                step_rows.push(row);
            }
            let anchor_key = step_key.clone();
            let scope = s.input_scope.clone();
            result = result.child(markdown::steps_pane(
                format!("{step_key}-scroll"),
                t("toolCall.task.sections.steps"),
                reveal_button,
                step_rows,
                move |s: &mut State, range| {
                    if s.current_scope(&scope)
                        && let Some(id) = mounted_ids.get(range.start)
                    {
                        s.transcript_display
                            .set_task_anchor(&anchor_key, Some(id.clone()));
                    }
                    false
                },
            ));
        }
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
mod tests;
