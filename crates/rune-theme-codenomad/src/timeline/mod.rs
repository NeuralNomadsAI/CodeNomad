//! Fixed-geometry timeline rail. Its caller supplies identities and active state.
pub mod icons;
pub mod search;
use crate::{catalogue, generated_layout::TIMELINE_MIN_WIDTH, layout, palettes, tokens};
use rune::{El, GrowthSpec, Icon, ScrollSpec, Tx};
use std::{borrow::Cow, rc::Rc};

pub const VIEWPORT: &str = "timeline";
pub use rune::ScrollPos as ScrollPosition;

pub fn user_scrolled() -> bool {
    let (hand, instant, _) = rune::scroll_watch_state();
    hand && !instant
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

pub fn reveal_when_outside(index: usize, at: rune::ScrollPos, tx: &mut Tx) {
    let top = row_top(index);
    let end = top + geometry().0;
    if top < at.offset[1] {
        tx.scroll_to_instant(VIEWPORT, 0.0, top);
    } else if end > at.offset[1] + at.viewport[1] {
        tx.scroll_to_instant(VIEWPORT, 0.0, end - at.viewport[1]);
    }
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
) -> Option<El> {
    if !fits(width) || count == 0 {
        return None;
    }
    let dark = layout::dark();
    let palette = palettes::current();
    let t = tokens(dark);
    let (height, gap) = geometry();
    let pitch = height + gap;
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
                    button(dark, marker(s, i))
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
                        })
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
    Some(
        rune::col()
            .key(VIEWPORT)
            .role("navigation")
            .focusable(true)
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
            })
            .child(bands)
            .child(tail),
    )
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
