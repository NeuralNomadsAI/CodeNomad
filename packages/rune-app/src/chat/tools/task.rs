use super::{
    Display, Tool,
    children::{Children, CopyKey, ReportCopyKey, STEP_BYTES, STEP_LIMIT},
    input_json, string, window,
};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, DrawnRect, Layout},
    markdown,
    timeline::search::Query,
};
use std::{borrow::Cow, collections::HashMap, rc::Rc, sync::Arc};

pub(super) const PANE_LIMIT: usize = 20_000;
pub(super) const MAX_DEPTH: usize = 12;
const INITIAL_STEPS: usize = 30;
const REVEAL: usize = 100;

#[derive(Default)]
pub(in crate::chat) struct DeliveryCache {
    fingerprint: u64,
    by_child: HashMap<String, ChildDeliveries>,
}

#[derive(Default)]
struct ChildDeliveries {
    launches: Vec<u64>,
    // Lightweight (created, row_index, part_index) refs; bodies stay owned by `s.messages`.
    reports: Vec<(u64, usize, usize)>,
}

impl DeliveryCache {
    pub(in crate::chat) fn clear(&mut self) {
        self.fingerprint = 0;
        self.by_child.clear();
    }

    fn refresh(&mut self, revision: u64, rows: &[crate::history::Row]) {
        use crate::content::Part;
        let mut fp = revision.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ (rows.len() as u64);
        for row in rows {
            fp = fp.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                ^ (Arc::as_ptr(row) as usize as u64)
                ^ ((row.parts.len() as u64) << 1);
            for part in &row.parts {
                match part {
                    Part::Tool(tool) if is_task(tool) => {
                        fp = fp.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                            ^ (Arc::as_ptr(tool) as usize as u64)
                            ^ launch_at(tool).unwrap_or(0)
                            ^ ((child(tool).len() as u64) << 4)
                            ^ (tool.status.len() as u64);
                    }
                    Part::SubagentReport(report) => {
                        fp = fp.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                            ^ report.created
                            ^ ((report.state.len() as u64) << 8)
                            ^ (report.child.len() as u64);
                    }
                    _ => {}
                }
            }
        }
        let fp = fp.max(1);
        if self.fingerprint == fp {
            return;
        }
        self.fingerprint = fp;
        self.by_child.clear();
        for (row_idx, row) in rows.iter().enumerate() {
            for (part_idx, part) in row.parts.iter().enumerate() {
                match part {
                    Part::Tool(other) if is_task(other) => {
                        let cid = child(other);
                        if !cid.is_empty()
                            && let Some(started) = launch_at(other)
                        {
                            self.by_child
                                .entry(cid.to_owned())
                                .or_default()
                                .launches
                                .push(started);
                        }
                    }
                    Part::SubagentReport(report) => {
                        self.by_child
                            .entry(report.child.clone())
                            .or_default()
                            .reports
                            .push((report.created, row_idx, part_idx));
                    }
                    _ => {}
                }
            }
        }
    }
}

pub(super) struct Delivery<'a> {
    pub status: &'static str,
    pub running: bool,
    pub ended: Option<u64>,
    pub report: Option<&'a crate::content::SubagentReport>,
    pub report_location: Option<(&'a str, usize)>,
    pub report_truncated: bool,
}

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

pub(super) fn child(tool: &Tool) -> &str {
    string(&tool.metadata, &["sessionId", "sessionID"])
}

pub(super) fn parent_child(message: &str) -> Option<&str> {
    message
        .strip_prefix("child:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(parent, _)| parent)
}

fn launch_at(tool: &Tool) -> Option<u64> {
    tool.started.or(tool.message_created)
}

fn resolve_delivery<'a>(
    tool: &Tool,
    launches: &[u64],
    reports: &[(
        u64,
        &'a str,
        usize,
        &'a crate::content::SubagentReport,
        bool,
    )],
) -> Delivery<'a> {
    let report = launch_at(tool).and_then(|from| {
        let mut boundaries: Vec<_> = launches.iter().copied().filter(|at| *at > from).collect();
        boundaries.sort_unstable();
        let first = reports
            .iter()
            .filter(|(created, _, _, _, _)| *created >= from)
            .map(|(created, _, _, _, _)| *created)
            .min()?;
        let end = boundaries
            .into_iter()
            .find(|next| *next > first)
            .unwrap_or(u64::MAX);
        reports
            .iter()
            .filter(|(created, _, _, _, _)| *created >= from && *created < end)
            .max_by_key(|(created, id, _, _, _)| (*created, *id))
            .map(|(_, row_id, part_idx, report, truncated)| {
                (*row_id, *part_idx, *report, *truncated)
            })
    });
    let newest = launches.iter().copied().max().or_else(|| launch_at(tool));
    let latest = newest.and_then(|from| {
        reports
            .iter()
            .filter(|(created, _, _, _, _)| *created >= from)
            .max_by_key(|(created, id, _, _, _)| (*created, *id))
            .map(|(created, _, _, report, _)| (*created, report.state.as_str()))
    });
    let (status, running, ended) = match latest {
        Some((created, "completed")) => (
            "toolCall.status.completed",
            false,
            (created > 0).then_some(created),
        ),
        Some((created, "error" | "cancelled")) => (
            "toolCall.status.error",
            false,
            (created > 0).then_some(created),
        ),
        _ => ("toolCall.status.running", true, None),
    };
    let (report, report_location, report_truncated) = match report {
        Some((row_id, part_idx, report, truncated)) => {
            (Some(report), Some((row_id, part_idx)), truncated)
        }
        None => (None, None, false),
    };
    Delivery {
        status,
        running,
        ended,
        report,
        report_location,
        report_truncated,
    }
}

pub(super) fn delivery<'a>(
    s: &'a State,
    message: &str,
    tool: &Tool,
    ancestors: &[&str],
) -> Option<Delivery<'a>> {
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    let child_id = child(tool);
    if child_id.is_empty() {
        return Some(Delivery {
            status: "toolCall.status.running",
            running: true,
            ended: None,
            report: None,
            report_location: None,
            report_truncated: false,
        });
    }
    if let Some(parent) = parent_child(message) {
        let owner_parent = ancestors.len().checked_sub(2).map(|i| ancestors[i]);
        let launches: Vec<u64> = s
            .transcript_display
            .children
            .steps(owner_parent, parent)
            .iter()
            .filter_map(|(_, other)| {
                (is_task(other) && child(other) == child_id)
                    .then_some(launch_at(other))
                    .flatten()
            })
            .collect();
        let reports: Vec<_> = s
            .transcript_display
            .children
            .reports(owner_parent, parent)
            .iter()
            .filter(|entry| entry.report.child == child_id)
            .map(|entry| {
                (
                    entry.report.created,
                    entry.row_id.as_str(),
                    entry.part_index,
                    entry.report.as_ref(),
                    entry.truncated,
                )
            })
            .collect();
        return Some(resolve_delivery(tool, &launches, &reports));
    }
    let rows = &s.messages[s.messages.len().saturating_sub(500)..];
    let mut cache = s.transcript_display.task_deliveries.borrow_mut();
    cache.refresh(s.revision, rows);
    let Some(entry) = cache.by_child.get(child_id) else {
        return Some(Delivery {
            status: "toolCall.status.running",
            running: true,
            ended: None,
            report: None,
            report_location: None,
            report_truncated: false,
        });
    };
    let reports: Vec<_> = entry
        .reports
        .iter()
        .filter_map(|&(created, row_idx, part_idx)| {
            let row = rows.get(row_idx)?;
            let crate::content::Part::SubagentReport(report) = row.parts.get(part_idx)? else {
                return None;
            };
            Some((created, row.id.as_str(), part_idx, report, false))
        })
        .collect();
    Some(resolve_delivery(tool, &entry.launches, &reports))
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

#[allow(clippy::too_many_arguments)]
pub(super) fn body(
    s: &State,
    message: &str,
    key: &str,
    tool: &Arc<Tool>,
    output: &str,
    report_location: Option<(&str, usize)>,
    output_truncated: bool,
    ancestors: &[&str],
    budget: &mut usize,
    query: Option<Query<'_>>,
) -> Option<El> {
    let prompt = string(&tool.input, &["prompt"]);
    let parent = parent_child(message);
    let child_id = (ancestors.len() < MAX_DEPTH)
        .then(|| watched_child(tool))
        .flatten()
        .filter(|id| !ancestors.contains(id));
    let child_steps = child_id.map_or(&[][..], |id| {
        s.transcript_display.children.steps(parent, id)
    });
    let live_truncated =
        child_id.is_some_and(|id| s.transcript_display.children.steps_truncated(parent, id));
    let live_incomplete =
        child_id.is_some_and(|id| s.transcript_display.children.steps_incomplete(parent, id));
    let child_load_error =
        child_id.is_some_and(|id| s.transcript_display.children.load_error(parent, id));
    let child_waiting =
        child_id.is_some_and(|id| s.transcript_display.children.is_waiting(parent, id));
    let visible_live: Vec<(String, Arc<Tool>)> = if child_steps.is_empty() {
        Vec::new()
    } else {
        child_steps
            .iter()
            .filter(|(message, step)| super::visible(s, message, step))
            .cloned()
            .collect()
    };
    let legacy_all = tool.metadata["summary"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let legacy_count_truncated = legacy_all.len() > STEP_LIMIT;
    let mut legacy_remaining = STEP_BYTES;
    let mut legacy_keep = 0usize;
    let mut legacy_byte_truncated = false;
    if child_steps.is_empty() {
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
    let legacy = if child_steps.is_empty() {
        &legacy_all[legacy_base..]
    } else {
        &[][..]
    };
    let step_count = if child_steps.is_empty() {
        legacy.len()
    } else {
        visible_live.len()
    };
    if prompt.trim().is_empty()
        && step_count == 0
        && !live_truncated
        && !live_incomplete
        && !legacy_byte_truncated
        && !child_load_error
        && !child_waiting
        && output.trim().is_empty()
        && !output_truncated
        && child_id.is_none()
    {
        return None;
    }
    let prompt_key = format!("{key}-task-prompt");
    let prompt_claims = !prompt.trim().is_empty()
        && query.is_some_and(|q| {
            q.active
                && q.claimed.is_none_or(|c| !c.get())
                && super::super::document::bounded_prose_matches_for(
                    s,
                    key,
                    &prompt_key,
                    prompt,
                    PANE_LIMIT,
                    q,
                )
        });
    let mut result = col().full_width().separate(Space::Sm);
    for (section, label, value, truncated, section_query) in [
        (
            "prompt",
            "toolCall.task.sections.prompt",
            prompt,
            false,
            query.map(|q| Query {
                active: prompt_claims,
                claimed: None,
                ..q
            }),
        ),
        (
            "output",
            "toolCall.task.sections.output",
            output,
            output_truncated,
            query.map(|q| Query {
                active: q.active && !prompt_claims && q.claimed.is_none_or(|c| !c.get()),
                claimed: None,
                ..q
            }),
        ),
    ] {
        if !value.trim().is_empty() || truncated {
            let copy_key = (section == "output" && truncated)
                .then(|| {
                    let parent = parent_child(message)?;
                    let (row_id, part_index) = report_location?;
                    Some(ReportCopyKey {
                        key: format!("copy-{key}-output"),
                        parent: parent.to_owned(),
                        row_id: row_id.to_owned(),
                        part_index,
                        child: child(tool).to_owned(),
                    })
                })
                .flatten();
            let expanded_full = copy_key
                .as_ref()
                .and_then(|k| s.transcript_display.children.loaded_report(k));
            let shown_value = expanded_full.unwrap_or(value);
            let pane_limit = PANE_LIMIT;
            result = result.child(text(t(label)).text_role(TextRole::Label));
            if !shown_value.trim().is_empty() {
                result = result.child(markdown::tool_pane(
                    super::super::document::prose_pane_search(
                        s,
                        message,
                        key,
                        format!("{key}-task-{section}"),
                        shown_value,
                        tool.status == "running" && section == "output",
                        pane_limit,
                        section_query,
                    ),
                    true,
                ));
            }
            if truncated && expanded_full.is_none() {
                let mut status_row =
                    layout::action_row().child(text(t("toolCall.output.tooLarge")).role("status"));
                if let Some(copy_key) = copy_key {
                    let expand_key = copy_key.clone();
                    let reveal_key = format!("{key}-task-output");
                    status_row = status_row.child(
                        layout::button(
                            t("messageBlock.hiddenText.showAll"),
                            false,
                            screen::action(&s.input_scope, move |s| {
                                Children::expand_report(s, expand_key.clone());
                                Display::reveal_next(s, &reveal_key);
                            }),
                        )
                        .key(format!("expand-{key}-output")),
                    );
                    result = result.child(status_row);
                    let copy_target = CopyKey::Report(copy_key.clone());
                    if s.transcript_display.children.copy_failed(&copy_target) {
                        result =
                            result.child(text(t("messageSection.quote.copyFailed")).role("status"));
                    } else if s.transcript_display.children.expand_failed(&copy_key) {
                        result =
                            result.child(text(t("sessionList.loadError.retry")).role("status"));
                    } else if s.transcript_display.children.copy_copied(&copy_target) {
                        result =
                            result.child(text(t("markdown.codeBlock.copy.copied")).role("status"));
                    } else if s.transcript_display.children.copy_ready(&copy_target) {
                        result =
                            result.child(text(t("toolCall.io.copyOutputAriaLabel")).role("status"));
                    }
                } else {
                    result = result.child(status_row);
                }
            }
        }
    }
    if child_load_error && let Some(cid) = child_id {
        let retry_parent = parent.map(str::to_owned);
        let retry_child = cid.to_owned();
        result = result.child(
            layout::action_row()
                .child(text(t("messageSection.loadError.title")).role("status"))
                .child(
                    layout::button(
                        t("messageSection.loadError.reload"),
                        false,
                        screen::action(&s.input_scope, move |s| {
                            Children::retry(s, retry_parent.as_deref(), &retry_child);
                        }),
                    )
                    .key(format!("retry-{key}")),
                ),
        );
    } else if child_waiting && step_count == 0 && !live_truncated && !live_incomplete {
        result = result
            .child(text(t("toolCall.task.sections.steps")).text_role(TextRole::Label))
            .child(text(t("toolCall.status.running")).role("status"));
    }
    if step_count > 0 || live_truncated || live_incomplete || legacy_byte_truncated {
        let step_key = format!("{key}-task-steps");
        let pane_clip = s.transcript_display.tool_clock.clip_rect(&step_key);
        let use_child = !visible_live.is_empty();
        let legacy_ids = if use_child {
            Vec::new()
        } else {
            legacy_identities(legacy_all, legacy_base)
        };
        let row_keys: Vec<String> = if let Some(cid) = child_id.filter(|_| use_child) {
            visible_live
                .iter()
                .map(|(msg, step)| {
                    super::tool_key(&format!("{step_key}-child:{cid}:{msg}"), &step.id)
                })
                .collect()
        } else {
            legacy_ids
                .iter()
                .map(|identity| format!("{step_key}-{identity}"))
                .collect()
        };
        let revealed = s.transcript_display.task_revealed(&step_key);
        let count = (INITIAL_STEPS + revealed).min(STEP_LIMIT);
        let desired = step_count.saturating_sub(count);
        let anchors = s.transcript_display.task_anchors(&step_key);
        let visible_anchor = if anchors.is_empty() {
            None
        } else {
            anchors
                .iter()
                .find_map(|anchor| {
                    if use_child {
                        visible_live
                            .iter()
                            .position(|(msg, step)| format!("{msg}:{}", step.id) == *anchor)
                    } else {
                        legacy_ids.iter().position(|id| id == anchor)
                    }
                })
                .or(Some(0))
        };
        let focused_anchor = s.transcript_display.focused_key().and_then(|focused| {
            row_keys
                .iter()
                .position(|row_key| key_matches_row(focused, row_key))
                .or_else(|| {
                    (use_child && focused.len() >= 2 && !focused.starts_with('#'))
                        .then(|| {
                            let cid = child_id?;
                            let mut next_anc = Vec::with_capacity(ancestors.len() + 1);
                            next_anc.extend_from_slice(ancestors);
                            next_anc.push(cid);
                            visible_live.iter().take(desired).enumerate().find_map(
                                |(idx, (msg, step))| {
                                    let row_key = &row_keys[idx];
                                    if !s.transcript_display.expanded(row_key, false) {
                                        return None;
                                    }
                                    let owner = format!("child:{cid}:{msg}");
                                    step_contains_link(
                                        s, &owner, step, row_key, &next_anc, focused, 0,
                                    )
                                    .then_some(idx)
                                },
                            )
                        })
                        .flatten()
                })
        });
        if focused_anchor.is_some() {
            s.transcript_display.mark_task_focus_pinned();
        }
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
        let mut start = desired.min(boundary.unwrap_or(usize::MAX));
        let tail_len = if use_child {
            visible_live.len().saturating_sub(start)
        } else {
            legacy.len().saturating_sub(start)
        };
        let rendered_steps = tail_len.min(*budget);
        let budget_truncated = rendered_steps < tail_len;
        start += tail_len.saturating_sub(rendered_steps);
        let child_budget = if use_child {
            let rem = budget.saturating_sub(rendered_steps);
            *budget = rem;
            rem
        } else {
            *budget = budget.saturating_sub(rendered_steps);
            0
        };
        let legacy_truncated =
            child_steps.is_empty() && (legacy_count_truncated || legacy_byte_truncated);
        if live_truncated || legacy_truncated || budget_truncated {
            let notice = if (child_steps.is_empty()
                && (live_truncated || legacy_byte_truncated && legacy.is_empty()))
                || (budget_truncated && rendered_steps == 0)
            {
                text(t("toolCall.output.tooLarge")).role("status")
            } else {
                let shown_limit = if budget_truncated {
                    rendered_steps
                } else if live_truncated && child_steps.len() < STEP_LIMIT {
                    child_steps.len()
                } else if legacy_truncated && legacy.len() < STEP_LIMIT {
                    legacy.len()
                } else {
                    STEP_LIMIT
                };
                text(catalogue::format(
                    locale(),
                    "toolCall.task.steps.truncated",
                    &[("count", &shown_limit.to_string())],
                ))
                .role("status")
            };
            result = result.child(notice);
        }
        if live_incomplete && let Some(cid) = child_id {
            let copy_id = format!("copy-{key}-steps");
            let copy_target = CopyKey::Steps {
                key: copy_id.clone(),
                parent: parent.map(str::to_owned),
                child: cid.to_owned(),
            };
            let action_target = copy_target.clone();
            let mut row = layout::action_row().child(
                markdown::copy_button(
                    t("toolCall.io.copyOutputAriaLabel"),
                    screen::action_tx(&s.input_scope, move |s, tx| {
                        if !Children::commit_ready_copy(s, &action_target, tx)
                            && let CopyKey::Steps { key, parent, child } = &action_target
                        {
                            Children::copy_steps(s, key.clone(), parent.clone(), child.clone(), tx);
                        }
                    }),
                )
                .key(copy_id),
            );
            if s.transcript_display.children.copy_failed(&copy_target) {
                row = row.child(text(t("messageSection.quote.copyFailed")).role("status"));
            } else if s.transcript_display.children.copy_copied(&copy_target) {
                row = row.child(text(t("markdown.codeBlock.copy.copied")).role("status"));
            } else if s.transcript_display.children.copy_ready(&copy_target) {
                row = row.child(text(t("toolCall.io.copyOutputAriaLabel")).role("status"));
            }
            result = result.child(row);
        } else if legacy_truncated {
            let snapshot = Arc::clone(tool);
            result = result.child(
                markdown::copy_button(
                    t("toolCall.io.copyOutputAriaLabel"),
                    screen::action_tx(&s.input_scope, move |s, tx| {
                        s.transcript_display.children.cancel_copy();
                        if let Some(json) = super::format::bounded_json(
                            &snapshot.metadata["summary"],
                            super::children::MAX_COPY_BYTES,
                        ) {
                            tx.copy(json);
                        } else {
                            crate::shell::notifications::emit_outcome(
                                s,
                                crate::shell::notifications::Category::Sessions,
                                None,
                                t("messageSection.quote.copyFailed"),
                                true,
                            );
                        }
                    }),
                )
                .key(format!("copy-{key}-steps")),
            );
        }
        if rendered_steps > 0 {
            let has_reveal = start > 0 && !budget_truncated;
            let offset = usize::from(has_reveal);
            let reveal_count = start.min(REVEAL);
            let hidden_total = start;
            let min_extra = step_count
                .saturating_sub(start.saturating_sub(reveal_count))
                .saturating_sub(INITIAL_STEPS);
            let next_extra = revealed.saturating_add(REVEAL).max(min_extra);
            let mut virtual_keys = Vec::with_capacity(rendered_steps + offset);
            if has_reveal {
                virtual_keys.push(format!("reveal-row-{step_key}"));
            }
            virtual_keys.extend(row_keys.into_iter().skip(start));
            let mounted_ids: Vec<String> = if use_child {
                visible_live
                    .iter()
                    .skip(start)
                    .map(|(msg, step)| format!("{msg}:{}", step.id))
                    .collect()
            } else {
                legacy_ids.into_iter().skip(start).collect()
            };
            let items = Rc::new(if let Some(cid) = child_id.filter(|_| use_child) {
                let mut next_anc = Vec::with_capacity(ancestors.len() + 1);
                next_anc.extend(ancestors.iter().map(|&a| a.to_owned()));
                next_anc.push(cid.to_owned());
                let steps: Vec<_> = visible_live.into_iter().skip(start).collect();
                let nested_tasks = steps.iter().filter(|(_, step)| is_task(step)).count();
                let per_nested_budget = child_budget / nested_tasks.max(1);
                StepItems::Child {
                    child_id: cid.to_owned(),
                    ancestors: next_anc,
                    steps,
                    per_nested_budget,
                }
            } else {
                StepItems::Legacy {
                    tool: Arc::clone(tool),
                    base: legacy_base + start,
                }
            });
            let row_count = virtual_keys.len();
            let virtual_keys = Rc::new(virtual_keys);
            let key_source = virtual_keys.clone();
            let build_keys = virtual_keys;
            let build_step_key = step_key.clone();
            let build_clip = s.transcript_display.tool_clock.extend_clip(&pane_clip);
            let active_locale = locale();
            let version = s.revision.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                ^ s.transcript_display.tool_clock.epoch().wrapping_mul(31)
                ^ fnv64(active_locale)
                ^ ((row_count as u64) << 16)
                ^ (start as u64);
            let anchor_key = step_key.clone();
            let bottom_key = step_key.clone();
            let sel_key = step_key.clone();
            let list_segment = format!("/{step_key}-scroll-list/");
            let scope = s.input_scope.clone();
            let bottom_scope = scope.clone();
            let sel_scope = scope.clone();
            result = result.child(super::duration::observe_clip(
                s,
                markdown::steps_pane(
                    format!("{step_key}-scroll"),
                    t("toolCall.task.sections.steps"),
                    row_count,
                    version,
                    move |_: &State, index| Cow::Owned(key_source[index].clone()),
                    move |s: &State, index| {
                        #[cfg(test)]
                        s.transcript_display
                            .task_row_builds
                            .set(s.transcript_display.task_row_builds.get() + 1);
                        crate::strings::with_locale(active_locale, || {
                            if has_reveal && index == 0 {
                                let toggle = build_step_key.clone();
                                let hidden_label = catalogue::format(
                                    active_locale,
                                    if hidden_total == 1 {
                                        "messageBlock.hiddenParts.one"
                                    } else {
                                        "messageBlock.hiddenParts.other"
                                    },
                                    &[("count", &hidden_total.to_string())],
                                );
                                let label = catalogue::format(
                                    active_locale,
                                    "messageBlock.hiddenParts.show",
                                    &[("count", &reveal_count.to_string())],
                                );
                                return col().key(build_keys[0].clone()).role("listitem").child(
                                    layout::action_row()
                                        .child(text(hidden_label).text_role(TextRole::Label))
                                        .child(
                                            layout::button(
                                                &label,
                                                false,
                                                screen::action(&s.input_scope, move |s| {
                                                    Display::reveal_task_at_least(
                                                        s, &toggle, next_extra,
                                                    );
                                                }),
                                            )
                                            .key(format!("reveal-{build_step_key}")),
                                        ),
                                );
                            }
                            let item_index = index - offset;
                            let row_key = &build_keys[index];
                            match items.as_ref() {
                                StepItems::Child {
                                    child_id,
                                    ancestors,
                                    steps,
                                    per_nested_budget,
                                } => {
                                    let (msg, step) = &steps[item_index];
                                    let owner = format!("child:{child_id}:{msg}");
                                    let anc_refs: Vec<&str> =
                                        ancestors.iter().map(String::as_str).collect();
                                    let mut row_budget = *per_nested_budget;
                                    s.transcript_display.tool_clock.with_active_clip(
                                        &build_clip,
                                        || {
                                            col().key(row_key.clone()).role("listitem").child(
                                                super::render::render_nested(
                                                    s,
                                                    &owner,
                                                    step,
                                                    row_key,
                                                    &anc_refs,
                                                    &mut row_budget,
                                                ),
                                            )
                                        },
                                    )
                                }
                                StepItems::Legacy { tool, base } => tool.metadata["summary"]
                                    .as_array()
                                    .and_then(|arr| arr.get(base + item_index))
                                    .map_or_else(
                                        || col().key(row_key.clone()).role("listitem"),
                                        |step| render_legacy_row(s, step, row_key),
                                    ),
                            }
                        })
                    },
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
                )
                .drawn_rect_into(&pane_clip),
            ));
        }
    }
    Some(result)
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
    legacy_all
        .iter()
        .enumerate()
        .skip(legacy_base)
        .map(|(index, step)| {
            let id = string(step, &["id", "callID"]);
            if id.is_empty() {
                format!("idx:{index}")
            } else {
                format!("id:{:016x}:{index}", fnv64(id))
            }
        })
        .collect()
}

fn key_matches_row(focused: &str, row_key: &str) -> bool {
    let bytes = focused.as_bytes();
    let mut offset = 0;
    while let Some(pos) = focused[offset..].find(row_key) {
        let start = offset + pos;
        let end = start + row_key.len();
        let before_ok = start == 0 || matches!(bytes[start - 1], b'-' | b':');
        let after_ok = end == bytes.len() || bytes[end] == b'-';
        if before_ok && after_ok {
            return true;
        }
        offset = start + 1;
    }
    false
}

fn step_contains_link(
    s: &State,
    owner: &str,
    step: &Tool,
    row_key: &str,
    ancestors: &[&str],
    target: &str,
    depth: usize,
) -> bool {
    let within = |text: &str| {
        if text.is_empty() {
            return false;
        }
        let end = text.floor_char_boundary(text.len().min(PANE_LIMIT));
        text[..end].contains(target)
    };
    if within(&step.output) || within(string(&step.input, &["prompt"])) {
        return true;
    }
    if !is_task(step) {
        return false;
    }
    if delivery(s, owner, step, ancestors)
        .and_then(|d| d.report)
        .is_some_and(|r| within(&r.body))
    {
        return true;
    }
    if depth >= MAX_DEPTH {
        return false;
    }
    let parent = parent_child(owner);
    let Some(cid) = watched_child(step).filter(|id| !ancestors.contains(id)) else {
        return false;
    };
    let step_key = format!("{row_key}-task-steps");
    let mut next_anc = Vec::with_capacity(ancestors.len() + 1);
    next_anc.extend_from_slice(ancestors);
    next_anc.push(cid);
    s.transcript_display
        .children
        .steps(parent, cid)
        .iter()
        .any(|(msg, nested)| {
            let nested_owner = format!("child:{cid}:{msg}");
            let nested_key = super::tool_key(&format!("{step_key}-{nested_owner}"), &nested.id);
            s.transcript_display.expanded(&nested_key, false)
                && step_contains_link(
                    s,
                    &nested_owner,
                    nested,
                    &nested_key,
                    &next_anc,
                    target,
                    depth + 1,
                )
        })
}

enum StepItems {
    Child {
        child_id: String,
        ancestors: Vec<String>,
        steps: Vec<(String, Arc<Tool>)>,
        per_nested_budget: usize,
    },
    Legacy {
        tool: Arc<Tool>,
        base: usize,
    },
}

fn render_legacy_row(s: &State, step: &serde_json::Value, key: &str) -> El {
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
        let toggle = key.to_owned();
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
        .key(key.to_owned())
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
    row
}

pub(super) fn watched_child(tool: &Tool) -> Option<&str> {
    let id = child(tool);
    (matches!(tool.status.as_str(), "running" | "completed" | "error")
        && crate::history::valid_id(id))
    .then_some(id)
}

pub(super) fn observe(s: &State, key: &str, parent: Option<&str>, tool: &Tool, card: El) -> El {
    let Some(id) = watched_child(tool) else {
        return card;
    };
    let lease = s.transcript_display.children.lease(parent, id, key);
    let drawn = Rc::new(DrawnRect::new([0.0; 4]));
    let clip = s.transcript_display.tool_clock.current_clip();
    let (id, parent, key, scope) = (
        id.to_owned(),
        parent.map(str::to_owned),
        key.to_owned(),
        s.input_scope.clone(),
    );
    let layout_id = id.clone();
    let layout_parent = parent.clone();
    let layout_key = key.clone();
    let layout_scope = scope.clone();
    let layout_lease = lease.clone();
    let layout_drawn = drawn.clone();
    let layout_clip = clip.clone();
    let visible_drawn = drawn.clone();
    let visible_clip = clip;
    col()
        .full_width()
        .key(format!("{key}-watch-{id}"))
        .drawn_rect_into(&drawn)
        .child(card)
        .on_drawn_layout_tx(move |s: &mut State, _, tx| {
            if s.current_scope(&layout_scope) {
                let rect = layout_drawn.get();
                if rect[2] > 0.0 && rect[3] > 0.0 {
                    let bounds = s.tool_diff_preferences.history_bounds.get();
                    let in_view =
                        s.transcript_display
                            .tool_clock
                            .rect_in_view(rect, bounds, &layout_clip);
                    Children::demand(
                        s,
                        layout_parent.as_deref(),
                        &layout_id,
                        &layout_key,
                        &layout_lease,
                        in_view,
                    );
                }
            }
            tx.live_only();
        })
        .on_visible(move |s: &mut State, visible, tx| {
            if s.current_scope(&scope) {
                let rect = visible_drawn.get();
                let effective = visible
                    && (rect[2] <= 0.0
                        || rect[3] <= 0.0
                        || s.transcript_display.tool_clock.rect_in_view(
                            rect,
                            s.tool_diff_preferences.history_bounds.get(),
                            &visible_clip,
                        ));
                Children::demand(s, parent.as_deref(), &id, &key, &lease, effective);
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
    crate::settings::fixture_transcript(
        &mut state,
        json!({
            "toolCallExpansionDefaults":{"tools":{"task":"collapsed"}}
        }),
    );
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
    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "toolCallExpansionDefaults":{"tools":{"read":"hidden"}}
            }),
        )
    });
    rt.frame(0.02);
    let tree = rt.accessibility_json().to_string();
    assert!(!tree.contains("actual.txt") && !tree.contains("Legacy summary only"));
}

#[cfg(test)]
mod anchor_tests;
