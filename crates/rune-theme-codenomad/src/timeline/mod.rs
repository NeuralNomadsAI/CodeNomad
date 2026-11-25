//! Fixed-geometry timeline rail. Its caller supplies identities and active state.
pub mod icons;
pub mod preview;
pub mod search;
mod wheel;
use crate::{catalogue, generated_layout::TIMELINE_MIN_WIDTH, layout, palettes, tokens};
use rune::{El, GrowthSpec, Icon, ScrollSpec, Tx};
use std::{borrow::Cow, rc::Rc};

pub const VIEWPORT: &str = "timeline";
pub use rune::ScrollPos as ScrollPosition;
pub use rune::{GesturePhase, WheelEvent};
pub use wheel::RailWheelOverride;

pub fn navigation_status(label: &'static str) -> El {
    use crate::{Space, TextRole, layout::Layout};
    let dark = layout::dark();
    let k = crate::kit(dark);
    rune_kit::popover::raised(
        k,
        rune::col()
            .key("history-navigation-status")
            .role("status")
            .label_static(label)
            .pad(Space::Sm)
            .child(rune::text(label).text_role(TextRole::Label)),
        0.0,
    )
    .anchored(
        "oldest",
        rune::Side::Top,
        rune::Align::Start,
        tokens(dark).space(Space::Xs).px(),
    )
}

pub fn user_scrolled() -> bool {
    let (hand, instant, _) = rune::scroll_watch_state();
    hand && !instant
}

pub fn rail_scrolled() -> bool {
    rune::scroll_watch_state().0
}

pub fn fits(width: f32) -> bool {
    width >= TIMELINE_MIN_WIDTH
}

pub fn transcript_lane(history: El) -> El {
    rune::col().grow(1.0).min_w(0.0).min_h(0.0).child(history)
}

pub fn conversation(expanded: bool) -> El {
    rune::row()
        .w_full()
        .grow(1.0)
        .min_h(crate::interruption::history_minimum(expanded))
}

/// Stable wrapper keeping `conversation` mounted when status banners appear or clear above it.
pub fn panel(expanded: bool, notice: Option<El>, conversation: El) -> El {
    let panel = rune::col()
        .key("conversation-panel")
        .w_full()
        .grow(1.0)
        .children(notice)
        .child(conversation);
    if expanded { panel } else { panel.min_h(0.0) }
}

/// Fixed-width slot that isolates the timeline rail's virtualized height from flex min-content sizing.
pub fn rail_slot(rail: El) -> El {
    let width = tokens(layout::dark()).metric("timelineRail", "width").px();
    rune::col()
        .w(width)
        .min_h(0.0)
        .child(rail.pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)))
}
// Chromium's CSS layout quantum is 1/64 px. Whole bands are integral even
// though their markers are not, so Rune's f32 prefix sum accumulates no drift.
const BAND: usize = 64;

fn geometry() -> (f32, f32) {
    let t = tokens(layout::dark());
    (
        t.metric("timelineMarker", "minHeight").px(),
        t.metric("timelineGap", "height").px(),
    )
}

pub fn show_marker(index: usize, tx: &mut Tx) {
    tx.scroll_to_instant(VIEWPORT, 0.0, row_top(index));
}

pub fn scroll_rail_to(target: f32, tx: &mut Tx) {
    tx.scroll_to_instant(VIEWPORT, 0.0, target);
}

pub fn glide_rail_to(target: f32, tx: &mut Tx) {
    tx.scroll_to(VIEWPORT, 0.0, target);
}

pub fn reveal_target(index: usize, at: rune::ScrollPos) -> Option<f32> {
    if at.viewport[1] <= 0.0 {
        return None;
    }
    let top = row_top(index);
    let end = top + geometry().0;
    let target = if top < at.offset[1] || end - top > at.viewport[1] {
        top
    } else if end > at.offset[1] + at.viewport[1] {
        end - at.viewport[1]
    } else {
        return None;
    };
    let clamped = target.clamp(0.0, at.max[1].max(0.0));
    ((clamped - at.offset[1]).abs() > 0.5).then_some(clamped)
}

pub fn visible_markers(at: rune::ScrollPos, count: usize) -> std::ops::Range<usize> {
    if at.viewport[1] <= 0.0 {
        return 0..0;
    }
    let (height, gap) = geometry();
    let pitch = height + gap;
    let top = at.offset[1].max(0.0);
    let first = ((top + gap) / pitch).floor() as usize;
    let last = ((top + at.viewport[1]) / pitch).ceil() as usize;
    first.min(count)..last.min(count)
}

fn row_top(index: usize) -> f32 {
    let (height, gap) = geometry();
    ((f64::from(height) + f64::from(gap)) * index as f64) as f32
}

pub struct Marker<'a> {
    pub label: Cow<'a, str>,
    pub current: &'static str,
    pub glyph: &'static Icon,
    pub tone: &'static str,
    pub active: bool,
}

/// Width is measured on the conversation container before reserving space for the rail.
/// `version` changes whenever the ordered row keys change.
pub fn view<S: 'static>(
    width: f32,
    locale: &str,
    count: usize,
    version: u64,
    key: impl for<'a> Fn(&'a S, usize) -> Cow<'a, str> + 'static,
    marker: impl for<'a> Fn(&'a S, usize) -> Marker<'a> + 'static,
    activate: impl Fn(&mut S, &str, &mut Tx) + 'static,
    decorate: impl Fn(&S, usize, El) -> El + 'static,
) -> Option<El> {
    if !fits(width) {
        return None;
    }
    let dark = layout::dark();
    let palette = palettes::current();
    let t = tokens(dark);
    let (height, gap) = geometry();
    let pitch = height + gap;
    let rail = rune::col()
        .key(VIEWPORT)
        .role("navigation")
        .focusable(count != 0)
        .label_static(catalogue::message(locale, "messageTimeline.ariaLabel").unwrap())
        .w(t.metric("timelineRail", "width").px())
        .h_full()
        .fill(t.color("surface-secondary"))
        .border_sides(
            [0.0, 0.0, 0.0, t.metric("timelineRail", "edgeWidth").px()],
            t.color("border-base"),
        )
        .scroll(ScrollSpec {
            stick_bottom: false,
        });
    if count == 0 {
        return Some(rail);
    }
    let activate = Rc::new(activate);
    let build = Rc::new(move |s: &S, first: usize, len: usize| {
        let last = first + len;
        let extent = len as f32 * pitch - if last == count { gap } else { 0.0 };
        rune::col()
            .w_full()
            .h(extent)
            .children((first..last).map(|i| {
                let id = key(s, i).into_owned();
                let enter = id.clone();
                let on_enter = activate.clone();
                let activate = activate.clone();
                palettes::with_palette(palette, || {
                    let button = button(dark, marker(s, i))
                        .key(id.clone())
                        .pin(Some(0.0), Some((i - first) as f32 * pitch), Some(0.0), None)
                        .on_press_tx(move |s, tx| activate(s, &id, tx))
                        // Match HTML button activation; Rune reserves Return for default actions.
                        .on_key(move |s, event, tx| {
                            if event.key != rune::Key::Enter {
                                return false;
                            }
                            on_enter(s, &enter, tx);
                            true
                        });
                    decorate(s, i, button)
                })
            }))
    });
    // Keep the last band separate so that even before it mounts its extent
    // reflects the short final band and the absence of a trailing gap.
    let last = (count - 1) / BAND * BAND;
    let full = build.clone();
    let bands = rune::col()
        .key("timeline-bands")
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            last / BAND,
            BAND as f32 * pitch,
            |_: &S, i| Cow::Owned(i.to_string()),
            move |s, i| full(s, i * BAND, BAND),
        )
        .virtual_rows_version(version);
    let tail = rune::col()
        .key("timeline-tail")
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            1,
            (count - last) as f32 * pitch - gap,
            |_: &S, _| Cow::Borrowed("tail"),
            move |s, _| build(s, last, count - last),
        );
    Some(rail.child(bands).child(tail))
}

fn button(dark: bool, marker: Marker<'_>) -> El {
    let t = tokens(dark);
    let metric = |name| t.metric("timelineMarker", name).px();
    let color = t.color(marker.tone);
    let highlight = t.color("selection-neutral-strong-bg");
    let border = metric("borderTopWidth");
    let mut button = rune::row()
        .role("button")
        .focusable(true)
        .label(marker.label.into_owned())
        .w_full()
        .h(metric("minHeight"))
        .center()
        .hover(highlight)
        .hover_group()
        .focus_ring(
            t.metric("timelineFocus", "ringWidth").px(),
            -t.metric("timelineFocus", "extent").px(),
            t.color("accent-primary"),
        )
        .child(
            rune::icon(marker.glyph, t.metric("timelineGlyph", "width").px())
                .color(color)
                .group_opacity(
                    if marker.active {
                        1.0
                    } else {
                        metric("opacity")
                    },
                    1.0,
                )
                .a11y_hidden(),
        );
    if marker.active {
        // Rune's native tree and DOM bridge expose descriptions for buttons.
        button = button
            .description_static(marker.current)
            .fill(highlight)
            .border(border, color);
    } else {
        button = button
            .child(
                rune::el()
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .border(border, color)
                    .group_opacity(0.0, 1.0)
                    .a11y_hidden(),
            )
            .child(
                rune::row()
                    .pin(Some(border), None, Some(border), Some(border))
                    .justify_center()
                    .group_opacity(metric("opacity"), 0.0)
                    .a11y_hidden()
                    .child(
                        rune::el()
                            .w_frac(metric("separatorFraction"))
                            .h(metric("separatorHeight"))
                            .fill(t.color("border-divider")),
                    ),
            );
    }
    button
}
