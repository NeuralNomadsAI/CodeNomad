use crate::transport::{
    HistoryEdge,
    HistoryEdge::{After, Before},
};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::El;
use rune_theme_codenomad::{
    layout::{self, Layout},
    timeline::{self, icons},
};

#[derive(Default, Clone, Copy)]
pub(super) struct Scroll {
    pub transcript: u64,
    pub rail: u64,
    pub at: timeline::ScrollPosition,
    viewport: timeline::ScrollPosition,
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
    let old = previous.offset[1];
    let delta = now.offset[1] - old;
    // Rune #1674 counts the elastic return as by-hand motion. Ignore inward movement
    // from outside the scroll extent, including the final step back to the edge.
    (delta != 0.0 && !(old < 0.0 && delta > 0.0 || old > previous.max[1] && delta < 0.0))
        .then_some(delta)
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

pub(crate) fn watch(s: &State, el: El) -> El {
    scroll(s, el, false)
}

fn scroll(s: &State, el: El, rail: bool) -> El {
    let scroll = s.transcript_display.timeline.scroll.clone();
    let wheel_scroll = scroll.clone();
    let wake = s.wake.clone();
    let scope = s.input_scope.clone();
    el.on_wheel(move |s: &mut State, event, tx| {
        if s.current_scope(&scope) {
            super::navigation::hand_scrolled(s, rail);
            if !rail && event.dy != 0.0 && event.dy.abs() > event.dx.abs() {
                let direction = if event.dy > 0.0 { Before } else { After };
                turn_page_gesture(s, direction);
                if !s.history_error
                    && !event.momentum
                    && let Some(edge) = boundary(wheel_scroll.get().viewport, -event.dy)
                    && crate::chat::reader::request_page(s, edge)
                {
                    crate::chat::reader::announce_paging(tx);
                }
            }
        }
        false
    })
    .on_scroll_offset(move |at| {
        let mut gesture = scroll.get();
        let previous = gesture.viewport;
        let moved = rail && gesture.at != at;
        if rail {
            gesture.at = at;
        } else {
            gesture.viewport = at;
        }
        if timeline::user_scrolled() {
            let epoch = if rail {
                &mut gesture.rail
            } else {
                &mut gesture.transcript
            };
            *epoch = epoch.wrapping_add(1);
            if !rail && let Some(delta) = directed_delta(previous, at) {
                gesture.direction = Some(if delta < 0.0 { Before } else { After });
                gesture.edge = boundary(at, delta);
            }
            wake();
        }
        scroll.set(gesture);
        if moved {
            wake();
        }
    })
}

pub(crate) fn view(s: &State, history: El, expanded: bool) -> El {
    let t = &s.transcript_display.timeline;
    let scope = s.input_scope.clone();
    let mut area = timeline::conversation(expanded)
        .key("conversation-history")
        .on_layout_tx(move |s: &mut State, [_, _, width, _], tx| {
            if s.current_scope(&scope) && super::owner(s).width != width {
                super::owner(s).width = width;
                (s.wake)();
            } else {
                tx.live_only();
            }
        })
        .child(timeline::transcript_lane(history));
    if !super::demanded(s) {
        return area;
    }
    let scope = s.input_scope.clone();
    let locale = locale();
    if let Some(rail) = timeline::view(
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
        super::preview::marker,
    ) {
        area = area.child(scroll(s, rail, true));
    }
    let retry = if t.jump.retry.is_some() {
        Some((
            "history.sessionUnavailable",
            super::navigation::retry as fn(&mut State, &mut rune::Tx),
        ))
    } else if t.outline_error && t.scan.is_none() {
        Some((
            "history.navigation.outlineUnavailable",
            retry_outline as fn(&mut State, &mut rune::Tx),
        ))
    } else {
        None
    };
    if let Some((label, action)) = retry {
        rune::col()
            .full_width()
            .remaining()
            .child(
                layout::action_row()
                    .child(rune::text(crate::strings::t(label)))
                    .child(layout::button_tx(
                        crate::strings::t("messageSection.search.retry"),
                        false,
                        screen::action_tx(&s.input_scope, action),
                    )),
            )
            .child(area)
    } else {
        area
    }
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
