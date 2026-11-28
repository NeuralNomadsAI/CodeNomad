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
pub use rune::{GesturePhase, ScrollSource, WheelEvent};
pub use wheel::RailWheelOverride;

/// Compact left-aligned bordered status box matching Solid `.history-navigation-status`
/// (12 px text + compact bordered tertiary retry button adjacent to the message).
pub fn status_notice<S: 'static>(
    key: &'static str,
    message: &str,
    retry_label: &str,
    on_retry: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    use crate::{Space, TextRole, layout::Layout};
    let t = tokens(layout::dark());
    let border = t.metric("gitContext", "borderBottomWidth").px();
    rune::row()
        .w_full()
        .items_center()
        .px(t.space(Space::Sm).px())
        .pt(t.space(Space::Xxs).px())
        .child(
            rune::row()
                .key(key)
                .role("status")
                .items_center()
                .flex_wrap()
                .shrink()
                .min_w(0.0)
                .gap(t.space(Space::Sm).px())
                .px(t.space(Space::Sm).px())
                .py(t.space(Space::Xxs).px())
                .fill(t.color("surface-secondary"))
                .border(border, t.color("border-base"))
                .border_layout()
                .child(
                    rune::text(message)
                        .text_role(TextRole::Label)
                        .color(t.color("text-primary"))
                        .shrink()
                        .min_w(0.0)
                        .wrap(),
                )
                .child(crate::git_panel::tertiary_button(
                    retry_label,
                    false,
                    on_retry,
                )),
        )
}

/// Compact left-aligned bordered alert matching the timeline status surface role.
pub fn filtered_notice(key: &'static str, message: &str) -> El {
    use crate::{Space, TextRole, layout::Layout};
    let t = tokens(layout::dark());
    let border = t.metric("gitContext", "borderBottomWidth").px();
    rune::row()
        .w_full()
        .items_center()
        .px(t.space(Space::Sm).px())
        .pt(t.space(Space::Xxs).px())
        .child(
            rune::text(message)
                .key(key)
                .role("alert")
                .text_role(TextRole::Label)
                .color(t.color("status-error"))
                .fill(t.color("surface-secondary"))
                .px(t.space(Space::Sm).px())
                .py(t.space(Space::Xxs).px())
                .border(border, t.color("border-base"))
                .border_layout()
                .shrink()
                .min_w(0.0)
                .wrap(),
        )
}

pub fn navigation_status(label: &'static str) -> El {
    use crate::{Space, TextRole, layout::Layout};
    let dark = layout::dark();
    let k = &*crate::kit(dark);
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

pub fn user_scrolled(at: ScrollPosition) -> bool {
    let (hand, instant, _) = rune::scroll_watch_state();
    hand && !instant && at.source != rune::ScrollSource::EdgeReturn
}

pub fn rail_scrolled(at: ScrollPosition) -> bool {
    rune::scroll_watch_state().0 && at.source != rune::ScrollSource::EdgeReturn
}

pub fn fits(width: f32) -> bool {
    width >= TIMELINE_MIN_WIDTH
}

pub fn transcript_lane(history: El) -> El {
    transcript_lane_with_controls(history, None)
}

pub fn transcript_lane_with_controls(history: El, controls: Option<El>) -> El {
    rune::col()
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .child(history)
        .children(controls)
}

pub fn conversation(layout: crate::interruption::SessionLayout) -> El {
    rune::row().w_full().grow(1.0).min_h(layout.history_min())
}

/// Stable wrapper keeping `conversation` mounted when status banners appear or clear above it.
pub fn panel(
    layout: crate::interruption::SessionLayout,
    notice: Option<El>,
    conversation: El,
) -> El {
    let panel = rune::col()
        .key("conversation-panel")
        .w_full()
        .grow(1.0)
        .children(notice)
        .child(conversation);
    if layout.scrolls_stack() {
        panel
    } else {
        panel.min_h(0.0)
    }
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
                palettes::with_resolved(palette.clone(), || {
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
    let band_count = count.div_ceil(BAND);
    let expected = ((f64::from(height) + f64::from(gap)) * count as f64 - f64::from(gap)) as f32;
    let estimate = if band_count == 1 {
        expected
    } else {
        BAND as f32 * pitch
    };
    let bands = rune::col()
        .key("timeline-bands")
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            band_count,
            estimate,
            move |_: &S, i| {
                let first = i * BAND;
                let len = (count - first).min(BAND);
                if len == BAND && first + len < count {
                    Cow::Owned(i.to_string())
                } else {
                    Cow::Owned(format!("{i}:{len}:last"))
                }
            },
            move |s, i| {
                let first = i * BAND;
                build(s, first, (count - first).min(BAND))
            },
        )
        .virtual_rows_version((version, count));
    let extent = rune::col()
        .key("timeline-extent")
        .w_full()
        .h(expected)
        .child(bands);
    Some(rail.child(extent))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn timeline_bands_has_no_trailing_sibling_and_preserves_exact_extent() {
        struct Scene {
            count: usize,
            scroll: Rc<Cell<ScrollPosition>>,
        }
        let (height, gap) = geometry();
        for count in [1usize, 64, 65, 200] {
            let scroll = Rc::new(Cell::new(ScrollPosition::default()));
            let scene = Scene {
                count,
                scroll: scroll.clone(),
            };
            let mut rt = rune::Runtime::new(
                scene,
                |s: &Scene, _| {
                    let scroll = s.scroll.clone();
                    let rail = view(
                        800.0,
                        "en",
                        s.count,
                        0,
                        |_: &Scene, i| Cow::Owned(format!("m-{i}")),
                        |_: &Scene, i| Marker {
                            label: Cow::Owned(format!("Marker {i}")),
                            current: "Current",
                            glyph: &icons::USER,
                            tone: "message-user-border",
                            active: i == 0,
                        },
                        |_: &mut Scene, _, _| {},
                        |_: &Scene, _, el| el,
                    )
                    .unwrap()
                    .on_scroll_offset(move |pos| scroll.set(pos));
                    rail_slot(rail)
                },
                (800.0, 320.0),
                rune::Env::new(false, 1.0),
            );
            for _ in 0..4 {
                rt.frame(0.016);
            }
            // The growth stack `timeline-bands` must never have a following sibling inside `timeline`.
            assert!(
                rt.find("timeline-tail").is_none(),
                "timeline-bands must not be followed by a timeline-tail sibling (count={count})"
            );
            let pos = scroll.get();
            let expected = count as f32 * height + (count - 1) as f32 * gap;
            let expected_max = (expected - pos.viewport[1]).max(0.0);
            assert!(
                (pos.max[1] - expected_max).abs() < 1.0,
                "count={count}: expected max {expected_max} (extent {expected}), got {pos:?}"
            );
            let extent = rt
                .elements()
                .into_iter()
                .find(|n| n.key.as_deref() == Some("timeline-extent"))
                .expect("timeline-extent mounted");
            assert!(
                (extent.rect[3] - expected).abs() < 1.0,
                "count={count}: expected timeline-extent height {expected}, got {}",
                extent.rect[3]
            );
            if count >= 65 {
                let m0 = rt
                    .elements()
                    .into_iter()
                    .find(|n| n.key.as_deref() == Some("m-0"))
                    .expect("m-0 mounted")
                    .rect;
                rt.update(|_, tx| show_marker(count - 1, tx));
                for _ in 0..4 {
                    rt.frame(0.016);
                }
                let last_key = format!("m-{}", count - 1);
                let last_el = rt
                    .elements()
                    .into_iter()
                    .find(|n| n.key.as_deref() == Some(last_key.as_str()))
                    .expect("last marker mounted after show_marker");
                assert!(
                    (m0[1]).abs() < 1.0 && last_el.rect[3] > 0.0,
                    "first and last markers must align cleanly (count={count})"
                );
            }
        }
        // Growing a rail in the same runtime after measuring a short final band (65 -> 512)
        // must rekey that band so its cached short height never shifts later bands upward.
        let scroll = Rc::new(Cell::new(ScrollPosition::default()));
        let mut rt = rune::Runtime::new(
            Scene {
                count: 65,
                scroll: scroll.clone(),
            },
            |s: &Scene, _| {
                let scroll = s.scroll.clone();
                let rail = view(
                    800.0,
                    "en",
                    s.count,
                    s.count as u64,
                    |_: &Scene, i| Cow::Owned(format!("m-{i}")),
                    |_: &Scene, i| Marker {
                        label: Cow::Owned(format!("Marker {i}")),
                        current: "Current",
                        glyph: &icons::USER,
                        tone: "message-user-border",
                        active: i == 0,
                    },
                    |_: &mut Scene, _, _| {},
                    |_: &Scene, _, el| el,
                )
                .unwrap()
                .on_scroll_offset(move |pos| scroll.set(pos));
                rail_slot(rail)
            },
            (800.0, 320.0),
            rune::Env::new(false, 1.0),
        );
        for _ in 0..4 {
            rt.frame(0.016);
        }
        rt.update(|_, tx| show_marker(64, tx));
        for _ in 0..4 {
            rt.frame(0.016);
        }
        assert!(rt.find("m-64").is_some(), "short final band measured");
        rt.update(|_, tx| show_marker(0, tx));
        for _ in 0..4 {
            rt.frame(0.016);
        }
        rt.update(|s, _| s.count = 512);
        for _ in 0..4 {
            rt.frame(0.016);
        }
        rt.update(|_, tx| show_marker(511, tx));
        for _ in 0..4 {
            rt.frame(0.016);
        }
        let pos = scroll.get();
        let expected_512 = 512.0 * height + 511.0 * gap;
        assert!(
            (pos.max[1] + pos.viewport[1] - expected_512).abs() < 1.0,
            "grown rail must keep exact extent {expected_512}, got {pos:?}"
        );
        let m511 = rt
            .elements()
            .into_iter()
            .find(|n| n.key.as_deref() == Some("m-511"))
            .expect("last marker must mount after growing past a previously measured short band");
        assert!(
            m511.rect[1] >= 0.0
                && (m511.rect[1] + m511.rect[3] - 320.0).abs() <= 2.0
                && m511.visible[3] > 0.0,
            "m-511 must sit flush with the bottom of the 320px rail viewport: rect={:?}, visible={:?}",
            m511.rect,
            m511.visible
        );
        // Shrinking back 512 -> 65 must likewise align m-64 cleanly at the bottom.
        rt.update(|s, _| s.count = 65);
        for _ in 0..4 {
            rt.frame(0.016);
        }
        rt.update(|_, tx| show_marker(64, tx));
        for _ in 0..4 {
            rt.frame(0.016);
        }
        let pos65 = scroll.get();
        let expected_65 = 65.0 * height + 64.0 * gap;
        assert!(
            (pos65.max[1] + pos65.viewport[1] - expected_65).abs() < 1.0,
            "shrunk rail must keep exact extent {expected_65}, got {pos65:?}"
        );
        let m64 = rt
            .elements()
            .into_iter()
            .find(|n| n.key.as_deref() == Some("m-64"))
            .expect("m-64 must mount after shrinking back to 65");
        assert!(
            m64.rect[1] >= 0.0
                && (m64.rect[1] + m64.rect[3] - 320.0).abs() <= 2.0
                && m64.visible[3] > 0.0,
            "m-64 must sit flush with the bottom of the 320px rail viewport after shrink: rect={:?}, visible={:?}",
            m64.rect,
            m64.visible
        );
    }
}
