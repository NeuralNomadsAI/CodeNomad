use super::{
    super::{
        Display, TOOL_LIMIT, Tool,
        children::{Children, CopyKey, STEP_LIMIT},
        duration, format, input_json, string, tool_key, window,
    },
    MAX_DEPTH, PANE_LIMIT, delivery, is_task, parent_child, watched_child,
};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    TextRole, catalogue,
    layout::{self, Layout},
    markdown,
};
use std::{borrow::Cow, collections::HashMap, rc::Rc, sync::Arc};

const INITIAL_STEPS: usize = 30;
const REVEAL: usize = 100;

pub(super) struct StepsInput<'a> {
    pub key: &'a str,
    pub tool: &'a Arc<Tool>,
    pub ancestors: &'a [&'a str],
    pub parent: Option<&'a str>,
    pub child_id: Option<&'a str>,
    pub child_steps: &'a [(String, Arc<Tool>)],
    pub visible_live: Vec<(String, Arc<Tool>)>,
    pub legacy_all: &'a [serde_json::Value],
    pub legacy_count_truncated: bool,
    pub legacy_base: usize,
    pub legacy: &'a [serde_json::Value],
    pub step_count: usize,
    pub live_truncated: bool,
    pub live_incomplete: bool,
}

pub(super) fn append_steps(
    s: &State,
    mut result: El,
    budget: &mut usize,
    input: StepsInput<'_>,
) -> El {
    let StepsInput {
        key,
        tool,
        ancestors,
        parent,
        child_id,
        child_steps,
        visible_live,
        legacy_all,
        legacy_count_truncated,
        legacy_base,
        legacy,
        step_count,
        live_truncated,
        live_incomplete,
    } = input;
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
                super::super::tool_key(&format!("{step_key}-child:{cid}:{msg}"), &step.id)
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
                                step_contains_link(s, &owner, step, row_key, &next_anc, focused, 0)
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
    let step_budget = *budget;
    let rendered_steps = tail_len.min(step_budget);
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
    let legacy_truncated = child_steps.is_empty() && legacy_count_truncated;
    if live_truncated || legacy_truncated || budget_truncated {
        let notice = if (child_steps.is_empty() && live_truncated)
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
                    if let Some(json) = format::bounded_json(
                        &snapshot.metadata["summary"],
                        super::super::children::MAX_COPY_BYTES,
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
        let remaining_step_budget = step_budget.min(STEP_LIMIT).saturating_sub(rendered_steps);
        let reveal_count = start.min(REVEAL).min(remaining_step_budget);
        let has_reveal = start > 0 && !budget_truncated && reveal_count > 0;
        let offset = usize::from(has_reveal);
        let reveal_clears_gap = start <= reveal_count;
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
            let expanded_nested = steps
                .iter()
                .enumerate()
                .filter(|(idx, (msg, step))| {
                    is_task(step)
                        && super::super::render::nested_card_expanded(
                            s,
                            &format!("child:{cid}:{msg}"),
                            step,
                            &virtual_keys[offset + idx],
                        )
                })
                .count();
            let per_nested_budget = child_budget / expanded_nested.max(1);
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
        let mount_gen = s.transcript_display.task_mount_gen(&step_key);
        result = result.child(
            col()
                .full_width()
                .key(format!("{step_key}-mount-{mount_gen}"))
                .child(crate::chat::reading::inner_scroller(
                    duration::observe_clip(
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
                                        return col()
                                            .key(build_keys[0].clone())
                                            .role("listitem")
                                            .child(
                                                layout::action_row()
                                                    .child(
                                                        text(hidden_label)
                                                            .text_role(TextRole::Label),
                                                    )
                                                    .child(
                                                        layout::button_tx(
                                                            &label,
                                                            false,
                                                            screen::action_tx(
                                                                &s.input_scope,
                                                                move |s, tx| {
                                                                    Display::reveal_task_at_least(
                                                                        s, &toggle, next_extra,
                                                                    );
                                                                    if reveal_clears_gap {
                                                                        tx.scroll_to_instant(
                                                                            format!(
                                                                                "{toggle}-scroll"
                                                                            ),
                                                                            0.0,
                                                                            0.0,
                                                                        );
                                                                    }
                                                                },
                                                            ),
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
                                                    col()
                                                        .key(row_key.clone())
                                                        .role("listitem")
                                                        .child(super::super::render::render_nested(
                                                            s,
                                                            &owner,
                                                            step,
                                                            row_key,
                                                            &anc_refs,
                                                            &mut row_budget,
                                                        ))
                                                },
                                            )
                                        }
                                        StepItems::Legacy { tool, base } => {
                                            tool.metadata["summary"]
                                                .as_array()
                                                .and_then(|arr| arr.get(base + item_index))
                                                .map_or_else(
                                                    || col().key(row_key.clone()).role("listitem"),
                                                    |step| render_legacy_row(s, step, row_key),
                                                )
                                        }
                                    }
                                })
                            },
                            move |s: &mut State, range| {
                                if s.current_scope(&scope) {
                                    let vis_start = range.start.saturating_sub(offset);
                                    let vis_end =
                                        range.end.saturating_sub(offset).min(mounted_ids.len());
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
                                            if let Some((_, rest)) =
                                                seg.path().split_once(&list_segment)
                                                && let Some(row_key) = rest.split('/').next()
                                                && !row_key.is_empty()
                                                && !selected
                                                    .iter()
                                                    .any(|existing| existing == row_key)
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
                    ),
                    false,
                )),
        );
    }
    result
}

fn fnv64(text: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

pub(super) fn legacy_identities(
    legacy_all: &[serde_json::Value],
    legacy_base: usize,
) -> Vec<String> {
    let mut visible_counts: HashMap<u64, usize> = HashMap::new();
    for step in &legacy_all[legacy_base..] {
        let id = string(step, &["id", "callID"]);
        if !id.is_empty() {
            *visible_counts.entry(fnv64(id)).or_default() += 1;
        }
    }
    if legacy_base > 0 && !visible_counts.is_empty() {
        for step in &legacy_all[..legacy_base] {
            let id = string(step, &["id", "callID"]);
            if !id.is_empty()
                && let Some(count) = visible_counts.get_mut(&fnv64(id))
            {
                *count = count.saturating_add(1);
            }
        }
    }
    legacy_all
        .iter()
        .enumerate()
        .skip(legacy_base)
        .map(|(index, step)| {
            let id = string(step, &["id", "callID"]);
            if id.is_empty() {
                format!("idx:{index}")
            } else {
                let hash = fnv64(id);
                if visible_counts.get(&hash).copied().unwrap_or(0) > 1 {
                    format!("id:{hash:016x}:{index}")
                } else {
                    format!("id:{hash:016x}")
                }
            }
        })
        .collect()
}

pub(super) fn key_matches_row(focused: &str, row_key: &str) -> bool {
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

fn within_displayed(
    s: &State,
    text: &str,
    base_limit: usize,
    section_key: &str,
    target: &str,
) -> bool {
    if text.is_empty() {
        return false;
    }
    let limit = base_limit.saturating_add(
        s.transcript_display
            .steps(section_key)
            .saturating_mul(super::super::super::document::STEP),
    );
    let mut units = 0usize;
    let mut end = text.len();
    for (idx, ch) in text.char_indices() {
        let next = units + ch.len_utf16();
        if next > limit {
            end = idx;
            break;
        }
        units = next;
    }
    text[..end].contains(target)
}

pub(super) fn step_contains_link(
    s: &State,
    owner: &str,
    step: &Tool,
    row_key: &str,
    ancestors: &[&str],
    target: &str,
    depth: usize,
) -> bool {
    let (output_limit, output_key) = if is_task(step) {
        (PANE_LIMIT, format!("{row_key}-task-output"))
    } else if step.name == "skill" {
        (
            super::super::super::document::PROSE_LIMIT,
            format!("{row_key}-tool_output"),
        )
    } else {
        (
            super::super::super::document::TOOL_LIMIT,
            format!("{row_key}-tool_output"),
        )
    };
    if within_displayed(s, &step.output, output_limit, &output_key, target)
        || within_displayed(
            s,
            string(&step.input, &["prompt"]),
            PANE_LIMIT,
            &format!("{row_key}-task-prompt"),
            target,
        )
    {
        return true;
    }
    if !is_task(step) {
        return false;
    }
    if delivery(s, owner, step, ancestors)
        .and_then(|d| d.report)
        .is_some_and(|r| {
            within_displayed(
                s,
                &r.body,
                PANE_LIMIT,
                &format!("{row_key}-task-output"),
                target,
            )
        })
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
            let nested_key = tool_key(&format!("{step_key}-{nested_owner}"), &nested.id);
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
    row
}
