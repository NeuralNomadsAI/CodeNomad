mod delivery;
mod steps;

#[cfg(test)]
mod anchor_tests;
#[cfg(test)]
mod tests;

pub(in crate::chat) use delivery::DeliveryCache;
pub(super) use delivery::{child, delivery, detail, is_task, output, parent_child};

#[cfg(test)]
use steps::{key_matches_row, legacy_identities, step_contains_link};

use super::{
    Display, Tool,
    children::{Children, CopyKey, ReportCopyKey, STEP_LIMIT},
    string,
};
use crate::{State, screen, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, DrawnRect, Layout},
    markdown,
    timeline::search::Query,
};
use std::{rc::Rc, sync::Arc};

pub(super) const PANE_LIMIT: usize = 20_000;
pub(super) const MAX_DEPTH: usize = 12;

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
    let legacy_base = legacy_all.len().saturating_sub(STEP_LIMIT);
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
                result = result.child(crate::chat::reading::inner_scroller(
                    markdown::tool_pane(
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
                    ),
                    false,
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
    if step_count > 0 || live_truncated || live_incomplete {
        result = steps::append_steps(
            s,
            result,
            budget,
            steps::StepsInput {
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
            },
        );
    }
    Some(result)
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
