use super::{
    Display, Tool,
    children::{Children, STEP_BYTES, STEP_LIMIT, split_chain},
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

#[derive(Clone, Copy)]
pub(super) struct Delivery<'a> {
    pub status: HeaderStatus,
    pub body: Option<&'a str>,
}

#[derive(Clone, Copy)]
struct Launch<'a> {
    order: (u64, usize),
    row_id: &'a str,
    call_id: &'a str,
}

#[derive(Clone, Copy)]
struct ReportEntry<'a> {
    order: (u64, usize),
    row_id: &'a str,
    state: &'a str,
    created: u64,
    body: Option<&'a str>,
}

fn launch_time(tool: &Tool) -> Option<u64> {
    tool.started.or(tool.message_created).filter(|&at| at > 0)
}

fn child_chain(message: &str) -> Option<&str> {
    message
        .strip_prefix("child:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(chain, _)| chain)
}

fn message_row_id(message: &str) -> &str {
    message
        .strip_prefix("child:")
        .and_then(|rest| rest.split_once(':'))
        .map_or(message, |(_, id)| id)
}

fn launches_and_reports<'a>(
    s: &'a State,
    message: &str,
    child_id: &str,
) -> (Vec<Launch<'a>>, Vec<ReportEntry<'a>>) {
    use crate::content::Part;
    let mut launches = Vec::new();
    let mut reports = Vec::new();
    let mut floor = 0u64;
    if let Some(chain) = child_chain(message) {
        let (parent, owner) = split_chain(chain);
        if let Some(snap) = s.transcript_display.children.snapshot(parent, owner) {
            let mut next_report = 0usize;
            for (index, (row_id, other)) in snap.steps.iter().enumerate() {
                while next_report < snap.reports.len()
                    && snap.reports[next_report].after_steps <= index
                {
                    let report = &snap.reports[next_report];
                    if report.created > 0 {
                        floor = floor.max(report.created);
                    }
                    if report.child == child_id {
                        let effective = if report.created > 0 {
                            report.created
                        } else {
                            floor
                        };
                        reports.push(ReportEntry {
                            order: (effective, report.after_steps * 2),
                            row_id: report.row_id.as_str(),
                            state: report.state.as_str(),
                            created: report.created,
                            body: report.body.as_deref(),
                        });
                    }
                    next_report += 1;
                }
                let at = launch_time(other);
                if let Some(t) = at {
                    floor = floor.max(t);
                }
                if is_task(other) && child(other) == child_id {
                    launches.push(Launch {
                        order: (at.unwrap_or(floor), index * 2 + 1),
                        row_id: row_id.as_str(),
                        call_id: other.id.as_str(),
                    });
                }
            }
            for report in &snap.reports[next_report..] {
                if report.created > 0 {
                    floor = floor.max(report.created);
                }
                if report.child == child_id {
                    let effective = if report.created > 0 {
                        report.created
                    } else {
                        floor
                    };
                    reports.push(ReportEntry {
                        order: (effective, report.after_steps * 2),
                        row_id: report.row_id.as_str(),
                        state: report.state.as_str(),
                        created: report.created,
                        body: report.body.as_deref(),
                    });
                }
            }
        }
        return (launches, reports);
    }
    let mut pos = 0usize;
    for row in &s.messages[s.messages.len().saturating_sub(500)..] {
        for part in &row.parts {
            match part {
                Part::Tool(other) => {
                    let at = launch_time(other);
                    if let Some(t) = at {
                        floor = floor.max(t);
                    }
                    if is_task(other) && child(other) == child_id {
                        launches.push(Launch {
                            order: (at.unwrap_or(floor), pos),
                            row_id: row.id.as_str(),
                            call_id: other.id.as_str(),
                        });
                    }
                }
                Part::SubagentReport(report) => {
                    if report.created > 0 {
                        floor = floor.max(report.created);
                    }
                    if report.child == child_id {
                        let effective = if report.created > 0 {
                            report.created
                        } else {
                            floor
                        };
                        reports.push(ReportEntry {
                            order: (effective, pos),
                            row_id: row.id.as_str(),
                            state: report.state.as_str(),
                            created: report.created,
                            body: Some(report.body.as_str()),
                        });
                    }
                }
                _ => {}
            }
            pos += 1;
        }
    }
    (launches, reports)
}

pub(super) fn delivery<'a>(s: &'a State, message: &str, tool: &Tool) -> Option<Delivery<'a>> {
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    let child_id = child(tool);
    if child_id.is_empty() {
        return Some(Delivery {
            status: HeaderStatus {
                status: "toolCall.status.running",
                running: true,
                ended: None,
            },
            body: None,
        });
    }
    let row_id = message_row_id(message);
    let (launches, reports) = launches_and_reports(s, message, child_id);
    let current = launches
        .iter()
        .copied()
        .find(|launch| launch.row_id == row_id && launch.call_id == tool.id)
        .or_else(|| {
            launch_time(tool).map(|at| Launch {
                order: (at, 0),
                row_id: "",
                call_id: "",
            })
        });
    let body = current.and_then(|current| {
        let mut later: Vec<_> = launches
            .iter()
            .copied()
            .filter(|other| other.order > current.order)
            .collect();
        later.sort_unstable_by_key(|launch| launch.order);
        let first = reports
            .iter()
            .copied()
            .filter(|report| report.order >= current.order)
            .min_by_key(|report| (report.order, report.row_id))?;
        let boundary = later
            .into_iter()
            .find(|other| other.order > first.order)
            .map(|other| other.order);
        reports
            .iter()
            .copied()
            .filter(|report| {
                report.order >= current.order && boundary.is_none_or(|end| report.order < end)
            })
            .max_by_key(|report| (report.order, report.row_id))
            .and_then(|report| report.body)
    });
    let latest = current.and_then(|current| {
        let newest = launches
            .iter()
            .map(|launch| launch.order)
            .max()
            .map_or(current.order, |max| max.max(current.order));
        reports
            .iter()
            .copied()
            .filter(|report| report.order >= newest)
            .max_by_key(|report| (report.order, report.row_id))
            .map(|report| (report.created, report.state))
    });
    let status = match latest {
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
    };
    Some(Delivery { status, body })
}

pub(super) fn report_body<'a>(s: &'a State, message: &str, tool: &Tool) -> Option<&'a str> {
    delivery(s, message, tool).and_then(|d| d.body)
}

pub(super) fn output<'a>(tool: &'a Tool, report: Option<&'a str>) -> &'a str {
    if tool.status == "completed" && tool.metadata["status"] == "running" {
        report.unwrap_or("")
    } else {
        &tool.output
    }
}

fn fnv64(text: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn json_bytes(value: &serde_json::Value) -> usize {
    let base = std::mem::size_of::<serde_json::Value>();
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => base,
        serde_json::Value::String(s) => base + s.len(),
        serde_json::Value::Array(items) => base + items.iter().map(json_bytes).sum::<usize>(),
        serde_json::Value::Object(map) => {
            base + map
                .iter()
                .map(|(k, v)| k.len() + base + json_bytes(v))
                .sum::<usize>()
        }
    }
}

fn legacy_identities(legacy_all: &[serde_json::Value], legacy_base: usize) -> Vec<String> {
    let mut seen = std::collections::HashMap::<&str, usize>::new();
    let mut ids = Vec::with_capacity(legacy_all.len().saturating_sub(legacy_base));
    for (index, step) in legacy_all.iter().enumerate() {
        let id = string(step, &["id"]);
        let key = if id.is_empty() {
            format!("idx:{index}")
        } else {
            let occ = seen.entry(id).or_default();
            let key = format!("id:{:016x}:{}", fnv64(id), *occ);
            *occ += 1;
            key
        };
        if index >= legacy_base {
            ids.push(key);
        }
    }
    ids
}

fn key_matches_row(focused: &str, row_key: &str) -> bool {
    let rest = focused
        .strip_prefix("toggle-")
        .or_else(|| focused.strip_prefix("copy-"))
        .unwrap_or(focused);
    rest == row_key
        || rest
            .strip_prefix(row_key)
            .is_some_and(|tail| tail.starts_with('-'))
}

pub(super) fn body(s: &State, message: &str, key: &str, tool: &Tool, output: &str) -> Option<El> {
    let prompt = string(&tool.input, &["prompt"]);
    let chain = child_chain(message);
    let parent = chain.map(|c| split_chain(c).1);
    let child_id =
        watched_child(tool).filter(|id| s.transcript_display.children.can_watch(chain, id));
    let child_snapshot = child_id.and_then(|id| s.transcript_display.children.snapshot(parent, id));
    let use_child = child_snapshot.is_some_and(|snap| !snap.steps.is_empty());
    let child_all_dropped =
        child_snapshot.is_some_and(|snap| snap.steps.is_empty() && snap.byte_truncated);
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
    let legacy_count_truncated = legacy_all.len() > STEP_LIMIT;
    let mut legacy_remaining = STEP_BYTES;
    let mut legacy_keep = 0usize;
    let mut legacy_byte_truncated = false;
    if !use_child {
        for entry in legacy_all.iter().rev().take(STEP_LIMIT) {
            let Some(left) = legacy_remaining.checked_sub(json_bytes(entry)) else {
                legacy_byte_truncated = true;
                break;
            };
            legacy_remaining = left;
            legacy_keep += 1;
        }
    }
    let legacy_base = legacy_all.len().saturating_sub(legacy_keep);
    let legacy = if use_child {
        &[][..]
    } else {
        &legacy_all[legacy_base..]
    };
    let step_count = if use_child {
        visible_steps.len()
    } else {
        legacy.len()
    };
    let count_truncated = if use_child {
        child_snapshot.is_some_and(|snap| snap.count_truncated)
    } else {
        legacy_count_truncated || child_snapshot.is_some_and(|snap| snap.count_truncated)
    };
    let byte_truncated = if use_child {
        child_snapshot.is_some_and(|snap| snap.byte_truncated)
    } else {
        legacy_byte_truncated || child_all_dropped
    };
    let truncated = count_truncated || byte_truncated;
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
        let displayed_count = if use_child && truncated && step_count == 0 {
            child_snapshot.map_or(0, |snap| snap.steps.len())
        } else {
            step_count
        };
        if displayed_count > 0 || count_truncated {
            let count_text = if count_truncated {
                format!("{STEP_LIMIT}+")
            } else if byte_truncated {
                format!("{displayed_count}+")
            } else {
                displayed_count.to_string()
            };
            let count_label = catalogue::format(
                locale(),
                if !truncated && displayed_count == 1 {
                    "toolCall.task.steps.count.one"
                } else {
                    "toolCall.task.steps.count.other"
                },
                &[("count", &count_text)],
            );
            section_header = section_header.child(text(count_label).text_role(TextRole::Label));
        }
        result = result.child(section_header);
        if truncated {
            let notice = if child_all_dropped {
                t("toolCall.output.tooLarge").to_owned()
            } else if use_child
                && let Some(snap) = child_snapshot
                && snap.byte_truncated
                && snap.steps.len() < STEP_LIMIT
            {
                catalogue::format(
                    locale(),
                    "toolCall.task.steps.truncated",
                    &[("count", &snap.steps.len().to_string())],
                )
            } else if !use_child && legacy_byte_truncated && legacy.is_empty() {
                t("toolCall.output.tooLarge").to_owned()
            } else if !use_child && legacy_byte_truncated && legacy.len() < STEP_LIMIT {
                catalogue::format(
                    locale(),
                    "toolCall.task.steps.truncated",
                    &[("count", &legacy.len().to_string())],
                )
            } else {
                catalogue::format(
                    locale(),
                    "toolCall.task.steps.truncated",
                    &[("count", &STEP_LIMIT.to_string())],
                )
            };
            result = result.child(text(notice).text_role(TextRole::Label).role("status"));
        }
        if step_count > 0 {
            let legacy_ids = if use_child {
                Vec::new()
            } else {
                legacy_identities(legacy_all, legacy_base)
            };
            let next_chain = child_id.map(|id| match chain {
                Some(prefix) => format!("{prefix}>{id}"),
                None => id.to_owned(),
            });
            let row_keys: Vec<String> =
                if let Some(next_chain) = next_chain.as_deref().filter(|_| use_child) {
                    visible_steps
                        .iter()
                        .map(|(message, step)| {
                            super::tool_key(
                                &format!("{step_key}-child:{next_chain}:{message}"),
                                &step.id,
                            )
                        })
                        .collect()
                } else {
                    legacy_ids
                        .iter()
                        .map(|identity| format!("{step_key}-{identity}"))
                        .collect()
                };
            let count = (INITIAL_STEPS + s.transcript_display.steps(&step_key)).min(STEP_LIMIT);
            let desired = step_count.saturating_sub(count);
            let visible_anchor = s
                .transcript_display
                .task_anchors(&step_key)
                .iter()
                .find_map(|anchor| {
                    if use_child {
                        visible_steps
                            .iter()
                            .position(|(message, step)| format!("{message}:{}", step.id) == *anchor)
                    } else {
                        legacy_ids.iter().position(|id| id == anchor)
                    }
                });
            let focused_anchor = s.transcript_display.focused_key().and_then(|focused| {
                row_keys
                    .iter()
                    .position(|row_key| key_matches_row(focused, row_key))
            });
            let selected_anchor = s
                .transcript_display
                .task_selected(&step_key)
                .iter()
                .filter_map(|sel| row_keys.iter().position(|row_key| row_key == sel))
                .min();
            let boundary = visible_anchor
                .into_iter()
                .chain(focused_anchor)
                .chain(selected_anchor)
                .min();
            let start = desired.min(boundary.unwrap_or(usize::MAX));
            let has_reveal = start > 0;
            let mut mounted_ids = Vec::with_capacity(step_count.saturating_sub(start));
            let mut step_rows =
                Vec::with_capacity(step_count.saturating_sub(start) + usize::from(has_reveal));
            if has_reveal {
                let toggle = step_key.clone();
                let reveal_count = start.min(REVEAL);
                let next_extra = step_count
                    .saturating_sub(start.saturating_sub(reveal_count))
                    .saturating_sub(INITIAL_STEPS);
                let label = catalogue::format(
                    locale(),
                    "messageBlock.hiddenParts.show",
                    &[("count", &reveal_count.to_string())],
                );
                step_rows.push(
                    col()
                        .key(format!("reveal-row-{step_key}"))
                        .role("listitem")
                        .child(
                            layout::button(
                                &label,
                                false,
                                screen::action(&s.input_scope, move |s| {
                                    Display::reveal_at_least(s, &toggle, next_extra);
                                }),
                            )
                            .key(format!("reveal-{step_key}")),
                        ),
                );
            }
            if let Some(next_chain) = next_chain.as_deref().filter(|_| use_child) {
                for ((message, step), child_key) in
                    visible_steps.into_iter().zip(row_keys.iter()).skip(start)
                {
                    mounted_ids.push(format!("{message}:{}", step.id));
                    let owner = format!("child:{next_chain}:{message}");
                    step_rows.push(
                        col()
                            .key(child_key.clone())
                            .role("listitem")
                            .child(super::render::render(s, &owner, step, child_key)),
                    );
                }
            }
            for ((step, identity), key) in legacy
                .iter()
                .zip(legacy_ids.iter())
                .zip(row_keys.iter())
                .skip(start)
                .filter(|_| !use_child)
            {
                mounted_ids.push(identity.clone());
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
                let expanded = s.transcript_display.toggled(key);
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
            let offset = usize::from(has_reveal);
            let anchor_key = step_key.clone();
            let bottom_key = step_key.clone();
            let sel_key = step_key.clone();
            let list_segment = format!("/{step_key}-scroll-list/");
            let scope = s.input_scope.clone();
            let bottom_scope = scope.clone();
            let sel_scope = scope.clone();
            result = result.child(markdown::steps_pane(
                format!("{step_key}-scroll"),
                t("toolCall.task.sections.steps"),
                step_rows,
                move |s: &mut State, range| {
                    if s.current_scope(&scope) {
                        let vis_start = range.start.saturating_sub(offset);
                        let vis_end = range.end.saturating_sub(offset).min(mounted_ids.len());
                        if vis_start < vis_end {
                            s.transcript_display.set_task_visible(
                                &anchor_key,
                                mounted_ids[vis_start..vis_end]
                                    .iter()
                                    .take(32)
                                    .cloned()
                                    .collect(),
                            );
                        }
                    }
                    false
                },
                move |s: &mut State, at_bottom| {
                    if s.current_scope(&bottom_scope)
                        && s.transcript_display
                            .set_task_at_bottom(&bottom_key, at_bottom)
                    {
                        s.revision += 1;
                        return true;
                    }
                    false
                },
                move |s: &mut State, change, tx| {
                    if s.current_scope(&sel_scope) {
                        let mut selected = Vec::new();
                        if let Some(sel) = change.selection() {
                            for seg in sel.texts() {
                                if let Some((_, rest)) = seg.path().split_once(&list_segment)
                                    && let Some(row_key) = rest.split('/').next()
                                    && !row_key.is_empty()
                                    && !selected.iter().any(|existing| existing == row_key)
                                {
                                    selected.push(row_key.to_owned());
                                    if selected.len() >= 8 {
                                        break;
                                    }
                                }
                            }
                        }
                        if s.transcript_display.set_task_selected(&sel_key, selected) {
                            s.revision += 1;
                            return;
                        }
                    }
                    tx.live_only();
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

pub(super) fn observe(s: &State, message: &str, key: &str, tool: &Tool, card: El) -> El {
    let chain = child_chain(message).map(str::to_owned);
    let parent = chain.as_deref().map(|c| split_chain(c).1);
    let child_id = watched_child(tool).filter(|id| {
        s.transcript_display
            .children
            .can_watch(chain.as_deref(), id)
    });
    let Some(id) = child_id else {
        return card;
    };
    let lease = s.transcript_display.children.lease(parent, id, key);
    let (id, key, scope) = (id.to_owned(), key.to_owned(), s.input_scope.clone());
    card.on_visible(move |s: &mut State, visible, tx| {
        if s.current_scope(&scope) {
            Children::demand(s, chain.as_deref(), &id, &key, &lease, visible);
        }
        tx.live_only();
    })
}

#[cfg(test)]
mod tests;
