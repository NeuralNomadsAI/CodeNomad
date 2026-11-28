use crate::transport::{
    HistoryEdge,
    HistoryEdge::{After, Before},
};
use crate::{
    Phase, State, screen,
    strings::{locale, t},
};
use rune::El;
use rune_theme_codenomad::{
    layout,
    timeline::{self, icons},
    transcript,
};

#[derive(Default, Clone, Copy)]
pub(super) struct Scroll {
    pub transcript: u64,
    pub rail: u64,
    pub programmatic_rail: Option<f32>,
    pub rail_glide: Option<f32>,
    pub rail_glide_last: f32,
    pub rail_glide_stalled_at: Option<f64>,
    pub rail_glide_interrupted: bool,
    pub halt_rail_glide: bool,
    pub rail_wheel: timeline::RailWheelOverride,
    pub transcript_wheel_target: Option<f32>,
    pub transcript_wheel_momentum: bool,
    pub last_hand_rail: bool,
    pub wheel_last_rail: Option<bool>,
    pub wheel_pending_commit: Option<f64>,
    #[cfg(test)]
    pub last_rail_wheel_taken: bool,
    pub at: timeline::ScrollPosition,
    pub(super) viewport: timeline::ScrollPosition,
    in_edge_return: bool,
    edge: Option<HistoryEdge>,
    direction: Option<HistoryEdge>,
}

pub(crate) fn poll_edge(s: &mut State, tx: &mut rune::Tx) -> bool {
    let scroll = s.transcript_display.timeline.scroll.clone();
    let mut position = scroll.get();
    let edge = position.edge.take();
    let direction = position.direction.take();
    scroll.set(position);
    let was_paging = s.paging;
    if let Some(direction) = direction {
        turn_page_gesture(s, direction);
    }
    if !s.history_error
        && let Some(edge) = edge
        && crate::chat::reader::request_page(s, edge)
    {
        crate::chat::reader::announce_paging(tx);
    }
    s.paging != was_paging
}

fn turn_page_gesture(s: &mut State, direction: HistoryEdge) {
    if s.transcript_display
        .timeline
        .paging
        .as_ref()
        .is_some_and(|(_, pending)| {
            matches!(pending, Before | HistoryEdge::Oldest) != (direction == Before)
        })
    {
        crate::chat::reader::cancel_page(s);
    }
}
fn boundary(pos: timeline::ScrollPosition, direction: f32) -> Option<HistoryEdge> {
    if pos.viewport[1] <= 0.0 {
        return None;
    }
    if direction < 0.0 && pos.offset[1] <= 0.5 {
        Some(Before)
    } else if direction > 0.0 && pos.offset[1] >= pos.max[1] - 0.5 {
        Some(After)
    } else {
        None
    }
}

fn directed_delta(
    previous: timeline::ScrollPosition,
    now: timeline::ScrollPosition,
) -> Option<f32> {
    let delta = now.offset[1] - previous.offset[1];
    (delta != 0.0).then_some(delta)
}

#[cfg(test)]
#[test]
fn only_outward_motion_on_a_measured_edge_requests_a_page() {
    let mut pos = timeline::ScrollPosition::default();
    assert_eq!(boundary(pos, -1.0), None);
    pos.viewport[1] = 480.0;
    pos.max[1] = 1200.0;
    assert_eq!(boundary(pos, 0.0), None);
    assert_eq!(boundary(pos, 1.0), None);
    assert_eq!(boundary(pos, -1.0), Some(Before));
    pos.offset[1] = 1200.0;
    assert_eq!(boundary(pos, -1.0), None);
    assert_eq!(boundary(pos, 1.0), Some(After));
}

pub(crate) fn observe_history_wheel(
    s: &mut State,
    scope: &std::rc::Rc<()>,
    event: &rune::WheelEvent,
    tx: &mut rune::Tx,
    allow_edge_page: bool,
) {
    if !s.current_scope(scope) {
        return;
    }
    let wheel_scroll = s.transcript_display.timeline.scroll.clone();
    let mut state = wheel_scroll.get();
    state.rail_wheel.note_phase(event.phase, tx);
    state.transcript_wheel_momentum = false;
    state.last_hand_rail = false;
    if event.dy != 0.0 {
        state.wheel_last_rail = Some(false);
        state.wheel_pending_commit = Some(tx.clock());
    }
    wheel_scroll.set(state);
    super::navigation::hand_scrolled(s, false);
    if event.dy != 0.0 && event.dy.abs() > event.dx.abs() {
        let direction = if event.dy > 0.0 { Before } else { After };
        turn_page_gesture(s, direction);
        if allow_edge_page
            && !s.history_error
            && !event.momentum
            && let Some(edge) = boundary(wheel_scroll.get().viewport, -event.dy)
            && crate::chat::reader::request_page(s, edge)
        {
            crate::chat::reader::announce_paging(tx);
        }
    }
}

pub(crate) fn observe_history_scroll(s: &State) -> impl Fn(timeline::ScrollPosition) + 'static {
    let scroll = s.transcript_display.timeline.scroll.clone();
    let wake = s.wake.clone();
    move |at| {
        let mut gesture = scroll.get();
        let previous = gesture.viewport;
        gesture.transcript_wheel_target = None;
        gesture.wheel_pending_commit = None;
        gesture.viewport = at;
        // A virtual_rows commit during EdgeReturn clamps offset to 0.0 in Rune without
        // clearing rebound velocity, leaking Programmatic/Momentum until the next Direct input.
        match at.source {
            timeline::ScrollSource::EdgeReturn => gesture.in_edge_return = true,
            timeline::ScrollSource::Momentum | timeline::ScrollSource::Programmatic
                if gesture.in_edge_return => {}
            _ => gesture.in_edge_return = false,
        }
        let forwarded_momentum = std::mem::take(&mut gesture.transcript_wheel_momentum);
        if !gesture.in_edge_return && timeline::user_scrolled(at) {
            gesture.last_hand_rail = false;
            gesture.transcript = gesture.transcript.wrapping_add(1);
            if let Some(delta) = directed_delta(previous, at) {
                gesture.direction = Some(if delta < 0.0 { Before } else { After });
                if !forwarded_momentum {
                    gesture.edge = boundary(at, delta);
                }
            }
            wake();
        }
        scroll.set(gesture);
    }
}

fn point_in_rect(rect: [f32; 4], x: f32, y: f32) -> bool {
    rect[2] > 0.0
        && rect[3] > 0.0
        && x >= rect[0]
        && x <= rect[0] + rect[2]
        && y >= rect[1]
        && y <= rect[1] + rect[3]
}

fn rail_scroll(s: &State, el: El) -> El {
    let scroll = s.transcript_display.timeline.scroll.clone();
    let wheel_scroll = scroll.clone();
    let rail_bounds = s.transcript_display.timeline.rail_bounds.0.clone();
    let wake = s.wake.clone();
    let scope = s.input_scope.clone();
    el.drawn_rect_into(&rail_bounds)
        .on_wheel(move |s: &mut State, event, tx| {
            if s.current_scope(&scope) {
                let mut state = wheel_scroll.get();
                let rail_rect = rail_bounds.get();
                let has_rail_rect = rail_rect[2] > 0.0 && rail_rect[3] > 0.0;
                let (wx, wy) = (rail_rect[0] + event.x, rail_rect[1] + event.y);
                let covered = has_rail_rect
                    && (super::preview::covers_point(s, wx, wy)
                        || super::search::covers_point(s, wx, wy));
                let inside = !covered
                    && timeline::RailWheelOverride::contains_point(state.at, event.x, event.y);
                if !inside {
                    let owned = state.rail_wheel.forward_outside(event, tx);
                    if owned && covered {
                        let _ = super::preview::forward_wheel(s, wx, wy, event.dy, tx)
                            || super::search::forward_wheel(s, wx, wy, event.dy, tx);
                        #[cfg(test)]
                        {
                            state.last_rail_wheel_taken = false;
                        }
                        wheel_scroll.set(state);
                        return true;
                    }
                    let hist_rect = s.tool_diff_preferences.history_bounds.get();
                    let in_transcript = owned
                        && !covered
                        && if has_rail_rect && hist_rect[2] > 0.0 && hist_rect[3] > 0.0 {
                            point_in_rect(hist_rect, wx, wy)
                        } else {
                            let rail_h = if state.at.drawn[1] > 0.0 {
                                state.at.drawn[1]
                            } else {
                                state.at.viewport[1]
                            };
                            let hist_w = if state.viewport.drawn[0] > 0.0 {
                                state.viewport.drawn[0]
                            } else {
                                state.viewport.viewport[0]
                            };
                            !super::search::is_open(s)
                                && !super::preview::is_shown(s)
                                && event.x < 0.0
                                && (hist_w <= 0.0 || event.x >= -hist_w)
                                && event.y >= 0.0
                                && (rail_h <= 0.0 || event.y <= rail_h)
                        };
                    #[cfg(test)]
                    {
                        state.last_rail_wheel_taken = false;
                    }
                    if in_transcript && event.dy != 0.0 {
                        super::navigation::hand_scrolled(s, false);
                        let base = state
                            .transcript_wheel_target
                            .unwrap_or(state.viewport.offset[1]);
                        let target = (base - event.dy).clamp(0.0, state.viewport.max[1].max(0.0));
                        state.transcript_wheel_target = Some(target);
                        state.transcript_wheel_momentum = event.momentum;
                        state.last_hand_rail = false;
                        state.wheel_last_rail = Some(false);
                        state.wheel_pending_commit = Some(tx.clock());
                        wheel_scroll.set(state);
                        if (target - state.viewport.offset[1]).abs() > 0.5
                            && s.reader
                                .as_ref()
                                .is_some_and(crate::chat::reader::Reader::defers_scroll)
                        {
                            s.transcript_display
                                .reading_mut()
                                .note_pending_manual_scroll();
                        }
                        tx.scroll_to_instant("history", state.viewport.offset[0], target);
                        if event.dy.abs() > event.dx.abs() {
                            let direction = if event.dy > 0.0 { Before } else { After };
                            turn_page_gesture(s, direction);
                            let mut pos = state.viewport;
                            pos.offset[1] = target;
                            if !s.history_error
                                && !event.momentum
                                && let Some(edge) = boundary(pos, -event.dy)
                                && crate::chat::reader::request_page(s, edge)
                            {
                                crate::chat::reader::announce_paging(tx);
                            }
                        }
                        return true;
                    }
                    wheel_scroll.set(state);
                    return false;
                }
                if event.dy != 0.0 {
                    super::navigation::hand_scrolled(s, true);
                    state.last_hand_rail = true;
                    state.wheel_last_rail = Some(true);
                    state.wheel_pending_commit = Some(tx.clock());
                    state.rail_glide = None;
                    state.rail_glide_stalled_at = None;
                    state.rail_glide_interrupted = false;
                    state.halt_rail_glide = false;
                }
                let claim = s.paging || s.transcript_display.timeline.jump.has_flight();
                let taken = if claim {
                    state.rail_wheel.apply_claiming(
                        &mut state.programmatic_rail,
                        state.at,
                        event,
                        tx,
                    )
                } else {
                    state
                        .rail_wheel
                        .apply(&mut state.programmatic_rail, state.at, event, tx)
                };
                #[cfg(test)]
                {
                    state.last_rail_wheel_taken = taken;
                }
                if taken {
                    state.wheel_pending_commit = Some(tx.clock());
                }
                wheel_scroll.set(state);
                if taken {
                    return true;
                }
            }
            false
        })
        .on_scroll_offset(move |at| {
            let mut gesture = scroll.get();
            let moved = gesture.at != at;
            let programmatic = gesture.programmatic_rail.take().is_some_and(|target| {
                (at.offset[1] - target.clamp(0.0, at.max[1].max(0.0))).abs() <= 0.5
            });
            gesture.rail_wheel.clear_frame();
            gesture.wheel_pending_commit = None;
            gesture.at = at;
            if let Some(aim) = gesture.rail_glide {
                let clamped = aim.clamp(0.0, at.max[1].max(0.0));
                if (at.offset[1] - clamped).abs() <= 0.5 {
                    gesture.rail_glide = None;
                    gesture.rail_glide_stalled_at = None;
                    gesture.rail_glide_interrupted = false;
                } else if (at.offset[1] - gesture.rail_glide_last).abs() > 0.01 {
                    gesture.rail_glide_last = at.offset[1];
                    gesture.rail_glide_stalled_at = None;
                }
            }
            let user_moved = timeline::rail_scrolled(at) && !programmatic;
            if user_moved {
                if gesture.rail_glide.take().is_some() {
                    gesture.rail_glide_stalled_at = None;
                    gesture.rail_glide_interrupted = true;
                }
                gesture.last_hand_rail = true;
                gesture.rail = gesture.rail.wrapping_add(1);
                wake();
            } else if gesture.rail_glide_interrupted && !programmatic {
                gesture.rail_glide_interrupted = false;
                gesture.halt_rail_glide = true;
                wake();
            }
            scroll.set(gesture);
            if moved {
                wake();
            }
        })
}

pub(crate) fn notice_key(s: &State) -> Option<&'static str> {
    if !super::conversation_shown(s) {
        return None;
    }
    let t = &s.transcript_display.timeline;
    if t.jump.filtered && !super::search::is_open(s) {
        Some("timeline-destination-filtered")
    } else if t.jump.retry.is_some() {
        Some("timeline-jump-retry")
    } else if super::demanded(s) && t.outline_error && t.scan.is_none() {
        Some("timeline-outline-retry")
    } else {
        None
    }
}

pub(crate) fn view(
    s: &State,
    history: El,
    layout: rune_theme_codenomad::interruption::SessionLayout,
) -> El {
    let t = &s.transcript_display.timeline;
    let scope = s.input_scope.clone();
    let locale = locale();
    let oldest = (!s.messages.is_empty()).then(|| {
        transcript::scroll_button(
            "oldest",
            crate::strings::t("messageSection.scroll.toFirstAriaLabel"),
            true,
            s.paging || s.phase.reconnecting() || s.phase == Phase::Failed || s.stream_offline,
            screen::action_tx(&s.input_scope, crate::chat::reader::oldest),
        )
    });
    let latest = (!s.messages.is_empty() || s.history_detached).then(|| {
        transcript::scroll_button(
            "latest",
            crate::strings::t("rune.latest"),
            false,
            false,
            screen::action_tx(&s.input_scope, crate::latest),
        )
    });
    let scroll_controls = transcript::scroll_controls(locale, oldest, latest);
    let mut area = timeline::conversation(layout)
        .key("conversation-history")
        .on_layout_tx(move |s: &mut State, [_, _, width, _], tx| {
            if s.current_scope(&scope) && super::owner(s).width != width {
                let was_shown = super::owner(s).rail_shown;
                super::owner(s).width = width;
                let shown = super::demanded(s)
                    && (super::owner(s).has_raw_markers || !super::owner(s).markers.is_empty());
                if shown != was_shown {
                    super::owner(s).rail_shown = shown;
                    if super::owner(s).jump.align.is_none() {
                        if super::owner(s).poll_input_waiting
                            || super::owner(s).scroll.get().wheel_last_rail == Some(false)
                        {
                            super::defer_keep_passage(s, tx);
                        } else {
                            tx.instant();
                            crate::chat::reading::keep_passage(s, tx);
                        }
                    }
                }
                (s.wake)();
            } else {
                tx.live_only();
            }
        })
        .child(timeline::transcript_lane_with_controls(
            history,
            scroll_controls,
        ));
    let scope = s.input_scope.clone();
    if super::demanded(s)
        && (t.has_raw_markers || !t.markers.is_empty())
        && let Some(rail) = timeline::view(
            t.width,
            locale,
            t.markers.len(),
            t.version,
            |s: &State, i| s.transcript_display.timeline.markers[i].id.as_str().into(),
            move |s: &State, i| crate::strings::with_locale(locale, || glyph(s, i)),
            move |s, id, tx| {
                if s.current_scope(&scope) {
                    super::dismiss_preview(s);
                    super::navigation::select(s, id, tx);
                }
            },
            move |s, i, button| {
                crate::strings::with_locale(locale, || super::preview::marker(s, i, button))
            },
        )
    {
        area = area.child(timeline::rail_slot(rail_scroll(s, rail)));
    }
    let notice = match notice_key(s) {
        Some("timeline-destination-filtered") => Some(
            rune::text(crate::strings::t("history.destinationFiltered"))
                .key("timeline-destination-filtered")
                .role("alert")
                .wrap(),
        ),
        Some(key) => {
            let (label, action) = if key == "timeline-jump-retry" {
                (
                    "history.sessionUnavailable",
                    super::navigation::retry as fn(&mut State, &mut rune::Tx),
                )
            } else {
                (
                    "history.navigation.outlineUnavailable",
                    retry_outline as fn(&mut State, &mut rune::Tx),
                )
            };
            Some(
                layout::action_row()
                    .key(key)
                    .child(rune::text(crate::strings::t(label)))
                    .child(layout::button_tx(
                        crate::strings::t("messageSection.search.retry"),
                        false,
                        screen::action_tx(&s.input_scope, action),
                    )),
            )
        }
        None => None,
    };
    timeline::panel(layout, notice, area)
}

fn retry_outline(s: &mut State, _: &mut rune::Tx) {
    let owner = super::owner(s);
    owner.outline_error = false;
    owner.refresh = true;
    (s.wake)();
}

fn glyph(s: &State, index: usize) -> timeline::Marker<'_> {
    use super::MarkerKind::*;
    let owner = &s.transcript_display.timeline;
    let m = &owner.markers[index];
    let (label, glyph, tone) = match m.kind {
        User => (
            "messageTimeline.tooltip.userFallback",
            &icons::USER,
            "message-user-border",
        ),
        Assistant => (
            "messageTimeline.tooltip.assistantFallback",
            &icons::BOT,
            "message-assistant-border",
        ),
        Reasoning => (
            "messageBlock.reasoning.thinkingLabel",
            &icons::BRAIN,
            "text-secondary",
        ),
        Tool => (
            "messageTimeline.tool.fallbackLabel",
            &icons::LAYOUT_GRID,
            "message-tool-border",
        ),
        Compaction => (
            "messageTimeline.segment.compaction.label",
            &icons::FOLD_VERTICAL,
            "session-status-compacting-fg",
        ),
        System => ("messageBlock.system.label", &icons::INFO, "text-secondary"),
    };
    timeline::Marker {
        label: super::preview::resident(s, m)
            .map(|(block, _)| excerpt(block.text))
            .filter(|text| !text.is_empty())
            .map(std::borrow::Cow::Owned)
            .unwrap_or_else(|| m.tool.as_deref().unwrap_or_else(|| t(label)).into()),
        current: t("messageTimeline.current"),
        glyph,
        tone,
        active: owner.jump.active.as_deref() == Some(m.id.as_str()),
    }
}

pub(super) fn excerpt(source: &str) -> String {
    const LIMIT: usize = 220; // message-timeline-projection.ts:7,76
    let source = source.trim_start();
    let mut end = 0;
    let mut units = 0;
    for (offset, ch) in source.char_indices() {
        if units + ch.len_utf16() > LIMIT {
            if units == LIMIT {
                end -= source[..end].chars().next_back().unwrap().len_utf8();
            }
            return format!("{}…", source[..end].trim_end());
        }
        units += ch.len_utf16();
        end = offset + ch.len_utf8();
    }
    source[..end].trim_end().into()
}
