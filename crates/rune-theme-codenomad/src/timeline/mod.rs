//! Fixed-geometry timeline rail. Its caller supplies identities and active state.
pub mod icons;
use crate::{catalogue, generated_layout::TIMELINE_MIN_WIDTH, layout, palettes, tokens};
use rune::{El, GrowthSpec, Icon, ScrollSpec, Tx};
use std::{borrow::Cow, rc::Rc};

pub const VIEWPORT: &str = "timeline";

pub struct Marker<'a> {
    pub label: &'a str,
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
    if width < TIMELINE_MIN_WIDTH || count == 0 {
        return None;
    }
    let dark = layout::dark();
    let palette = palettes::current();
    let t = tokens(dark);
    let gap = t.metric("timelineGap", "height").px();
    let height = t.metric("timelineMarker", "minHeight").px();
    let key = Rc::new(key);
    let row_key = key.clone();
    let activate = Rc::new(activate);
    let rows = rune::col()
        .w_full()
        .gap(gap)
        .growth(GrowthSpec::default())
        .virtual_rows(
            count,
            height,
            move |s, i| row_key(s, i),
            move |s, i| {
                let id = key(s, i).into_owned();
                let enter = id.clone();
                let on_enter = activate.clone();
                let activate = activate.clone();
                palettes::with_palette(palette, || {
                    button(dark, marker(s, i))
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
            },
        )
        .virtual_rows_version(version);
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
            .child(rows),
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
        .label(marker.label)
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
        button = button.fill(highlight).border(border, color);
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
