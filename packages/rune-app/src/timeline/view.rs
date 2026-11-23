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
    pub at: rune::ScrollPos,
}

pub(crate) fn watch(s: &State, el: El) -> El {
    scroll(s, el, false)
}

fn scroll(s: &State, el: El, rail: bool) -> El {
    let scroll = s.transcript_display.timeline.scroll.clone();
    let wake = s.wake.clone();
    let scope = s.input_scope.clone();
    el.on_wheel(move |s: &mut State, _, _| {
        if s.current_scope(&scope) {
            super::navigation::hand_scrolled(s, rail);
        }
        false
    })
    .on_scroll_offset(move |at| {
        let (hand, instant, _) = rune::scroll_watch_state();
        let mut gesture = scroll.get();
        if rail {
            gesture.at = at;
        }
        if hand && !instant {
            let epoch = if rail {
                &mut gesture.rail
            } else {
                &mut gesture.transcript
            };
            *epoch = epoch.wrapping_add(1);
            wake();
        }
        scroll.set(gesture);
    })
}

pub(crate) fn view(s: &State, history: El, expanded: bool) -> El {
    let t = &s.transcript_display.timeline;
    let scope = s.input_scope.clone();
    let mut area = rune::row()
        .key("conversation-history")
        .full_width()
        .remaining()
        .min_h(rune_theme_codenomad::interruption::history_minimum(
            expanded,
        ))
        .on_layout_tx(move |s: &mut State, [_, _, width, _], tx| {
            if s.current_scope(&scope) && super::owner(s).width != width {
                super::owner(s).width = width;
                (s.wake)();
            } else {
                tx.live_only();
            }
        })
        .child(rune::col().remaining().child(history));
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
        move |s: &State, i| {
            crate::strings::with_locale(locale, || glyph(&s.transcript_display.timeline, i))
        },
        move |s, id, tx| {
            if s.current_scope(&scope) {
                super::navigation::select(s, id, tx);
            }
        },
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

fn glyph(owner: &super::Timeline, index: usize) -> timeline::Marker<'_> {
    use super::MarkerKind::*;
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
        label: m.tool.as_deref().unwrap_or_else(|| t(label)),
        glyph,
        tone,
        active: owner.jump.active.as_deref() == Some(m.id.as_str()),
    }
}
