use super::{
    Display, Tool,
    children::{Children, ReportCopyKey, STEP_LIMIT},
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
use std::{collections::HashMap, rc::Rc, sync::Arc};

pub(super) const PANE_LIMIT: usize = 20_000;
pub(super) const MAX_DEPTH: usize = 4;
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
                            ^ tool.started.unwrap_or(0)
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
                            && let Some(started) = other.started
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
    let report = tool.started.and_then(|from| {
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
    let newest = launches.iter().copied().max().or(tool.started);
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

pub(super) fn delivery<'a>(s: &'a State, message: &str, tool: &Tool) -> Option<Delivery<'a>> {
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
        let launches: Vec<u64> = s
            .transcript_display
            .children
            .steps(parent)
            .iter()
            .filter_map(|(_, other)| {
                (is_task(other) && child(other) == child_id)
                    .then_some(other.started)
                    .flatten()
            })
            .collect();
        let reports: Vec<_> = s
            .transcript_display
            .children
            .reports(parent)
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
    tool: &Tool,
    output: &str,
    report_location: Option<(&str, usize)>,
    output_truncated: bool,
    ancestors: &[&str],
    query: Option<Query<'_>>,
) -> Option<El> {
    let prompt = string(&tool.input, &["prompt"]);
    let child_id = (ancestors.len() < MAX_DEPTH)
        .then(|| watched_child(tool))
        .flatten()
        .filter(|id| !ancestors.contains(id));
    let child_steps = child_id.map_or(&[][..], |id| s.transcript_display.children.steps(id));
    let live_truncated =
        child_id.is_some_and(|id| s.transcript_display.children.steps_truncated(id));
    let visible_steps = child_steps
        .iter()
        .filter(|(message, step)| super::visible(s, message, step));
    let legacy = tool.metadata["summary"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let step_count = if child_steps.is_empty() {
        legacy.len()
    } else {
        visible_steps.clone().count()
    };
    if prompt.trim().is_empty()
        && step_count == 0
        && !live_truncated
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
                        PANE_LIMIT,
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
                    status_row = status_row.child(
                        layout::button(
                            t("messageBlock.hiddenText.showAll"),
                            false,
                            screen::action(&s.input_scope, move |s| {
                                Children::expand_report(s, expand_key.clone());
                            }),
                        )
                        .key(format!("expand-{key}-output")),
                    );
                    result = result.child(status_row);
                    if s.transcript_display.children.copy_failed(&copy_key)
                        || s.transcript_display.children.expand_failed(&copy_key)
                    {
                        result =
                            result.child(text(t("sessionList.loadError.retry")).role("status"));
                    } else if s.transcript_display.children.copy_ready(&copy_key) {
                        result =
                            result.child(text(t("toolCall.io.copyOutputAriaLabel")).role("status"));
                    }
                } else {
                    result = result.child(status_row);
                }
            }
        }
    }
    if step_count > 0 || live_truncated {
        let step_key = format!("{key}-task-steps");
        let revealed_steps = s.transcript_display.steps(&step_key);
        let detached = s.transcript_display.step_scroll_detached(&step_key);
        let count = (INITIAL_STEPS + REVEAL.saturating_mul(revealed_steps)).min(STEP_LIMIT);
        let mut start = step_count.saturating_sub(count);
        let visible_live: Vec<_> = if child_steps.is_empty() {
            Vec::new()
        } else {
            visible_steps.collect()
        };
        if !visible_live.is_empty() {
            if revealed_steps == 0 && !detached.get() {
                s.transcript_display.unpin_step_anchor(&step_key);
            }
            if let Some(anchor) = s.transcript_display.step_anchor(&step_key)
                && let Some(pos) = visible_live
                    .iter()
                    .position(|(msg, step)| format!("{msg}:{}", step.id) == anchor)
            {
                start = start.min(pos);
            }
            if let Some(cid) = child_id {
                let focused = s.transcript_display.focused_key();
                if let Some(protected) = visible_live.iter().position(|(msg, step)| {
                    let owner = format!("child:{cid}:{msg}");
                    let child_key = super::tool_key(&format!("{step_key}-{owner}"), &step.id);
                    s.transcript_display.expanded(&child_key, false)
                        || focused.is_some_and(|f| f.contains(&child_key))
                }) {
                    start = start.min(protected);
                }
            }
            if detached.get()
                && s.transcript_display.step_anchor(&step_key).is_none()
                && let Some((msg, step)) = visible_live.get(start)
            {
                s.transcript_display
                    .pin_step_anchor(&step_key, format!("{msg}:{}", step.id));
            }
        }
        let mut list = col()
            .role("list")
            .label(t("toolCall.task.sections.steps"))
            .separate(Space::Sm);
        let min_start = step_count.saturating_sub(STEP_LIMIT);
        if start > min_start {
            let toggle = step_key.clone();
            let next_start = start.saturating_sub(REVEAL).max(min_start);
            let next_anchor = visible_live
                .get(next_start)
                .map(|(msg, step)| format!("{msg}:{}", step.id));
            let label = catalogue::format(
                locale(),
                "messageBlock.hiddenParts.show",
                &[("count", &(start - next_start).to_string())],
            );
            list = list.child(
                layout::button(
                    &label,
                    false,
                    screen::action(&s.input_scope, move |s| {
                        Display::reveal_steps(s, &toggle, next_anchor.clone());
                    }),
                )
                .key(format!("reveal-{step_key}")),
            );
        }
        let pane_clip = s.transcript_display.tool_clock.clip_rect(&step_key);
        if let Some(child_id) = child_id.filter(|_| !visible_live.is_empty()) {
            let mut next_ancestors = Vec::with_capacity(ancestors.len() + 1);
            next_ancestors.extend_from_slice(ancestors);
            next_ancestors.push(child_id);
            list = s.transcript_display.tool_clock.with_clip(&pane_clip, || {
                let mut list = list;
                for (message, step) in visible_live.into_iter().skip(start) {
                    let owner = format!("child:{child_id}:{message}");
                    let child_key = super::tool_key(&format!("{step_key}-{owner}"), &step.id);
                    list = list.child(col().key(child_key.clone()).role("listitem").child(
                        super::render::render_nested(s, &owner, step, &child_key, &next_ancestors),
                    ));
                }
                list
            });
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
            list = list.child(row);
        }
        if step_count > STEP_LIMIT
            || child_id.is_some_and(|id| s.transcript_display.children.steps_truncated(id))
        {
            list = list.child(
                text(catalogue::format(
                    locale(),
                    "toolCall.task.steps.truncated",
                    &[("count", &STEP_LIMIT.to_string())],
                ))
                .role("status"),
            );
        }
        let scroll_detached = detached.clone();
        result = result.child(super::duration::observe_clip(
            s,
            markdown::tool_pane(list, true)
                .drawn_rect_into(&pane_clip)
                .on_scroll_offset(move |pos| {
                    scroll_detached.set(pos.max[1] > 0.0 && pos.offset[1] + 24.0 < pos.max[1]);
                }),
        ));
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
    let lease = s.transcript_display.children.lease(id, key);
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
                        &layout_id,
                        layout_parent.as_deref(),
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
                Children::demand(s, &id, parent.as_deref(), &key, &lease, effective);
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
