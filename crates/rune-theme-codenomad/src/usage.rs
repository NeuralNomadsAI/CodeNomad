//! Shared token and cost chips for the transcript and Status.
pub mod numbers;
use crate::{
    Length, Space, TextRole, Tokens,
    layout::{self, Layout},
    tokens,
};
use rune::{El, Span, SpanBox, icon, rich, row, text};
use std::rc::Rc;

const CHIP_HEIGHT: f32 = 22.0;
const CHEVRON_SIZE: f32 = 12.0;

fn chip_height(theme: &Tokens) -> f32 {
    (theme.text(TextRole::Label).line_px() + theme.space(Space::Xs).px() * 2.0).max(CHIP_HEIGHT)
}

#[derive(Clone, Copy, Debug)]
pub struct Metric<'a> {
    pub label: &'a str,
    pub value: &'a str,
    pub full: &'a str,
}

pub fn metric(label: &str, value: &str, full: &str) -> El {
    let theme = tokens(layout::dark());
    let caption = format!("{label}: {full}");
    row()
        .min_h(chip_height(theme))
        .items_center()
        .gap(theme.space(Space::Xs).px())
        .px(theme.space(Space::Sm).px())
        .py(theme.space(Space::Xs).px())
        .radius(theme.length(Length::ChipRadius).px())
        .border(1.0, theme.color("border-base"))
        .label(caption.clone())
        .help(caption)
        .child(
            text(label)
                .text_role(TextRole::Label)
                .color(theme.color("text-muted")),
        )
        .child(
            text(value)
                .text_role(TextRole::Label)
                .color(theme.color("text-primary")),
        )
}

fn metrics_caption(items: &[Metric<'_>]) -> String {
    let mut caption = String::new();
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            caption.push_str(", ");
        }
        caption.push_str(item.label);
        caption.push_str(": ");
        caption.push_str(item.full);
    }
    caption
}

fn summary_strip(key: &str, items: &[Metric<'_>], theme: &Tokens) -> El {
    let mut line = String::new();
    let mut spans = Vec::with_capacity(items.len());
    let mut boxes = Vec::with_capacity(items.len());
    let value_ink = theme.color("text-primary");
    let chip_box = SpanBox::new()
        .border(theme.color("border-base"), 1.0)
        .radius(theme.length(Length::ChipRadius).px());
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            line.push(' ');
        }
        let start = line.len();
        line.push('\u{00a0}');
        if !item.label.is_empty() {
            line.push_str(item.label);
            line.push('\u{00a0}');
        }
        let value_start = line.len();
        line.push_str(item.value);
        let value_end = line.len();
        line.push('\u{00a0}');
        let end = line.len();
        spans.push(Span::new(value_start, value_end).color(value_ink));
        boxes.push((start..end, chip_box));
    }
    rich(line, spans)
        .text_role(TextRole::Label)
        .color(theme.color("text-muted"))
        .span_boxes(boxes)
        .truncate()
        .remaining()
        .shrink()
        .min_w(0.0)
        .py(theme.space(Space::Xs).px())
        .help(metrics_caption(items))
        .key(format!("summary-{key}"))
}

pub fn disclosure<S: 'static>(
    key: &str,
    label: &str,
    heading: Option<&str>,
    expanded: bool,
    items: &[Metric<'_>],
    press: impl Fn(&mut S) + 'static,
) -> El {
    let theme = tokens(layout::dark());
    let (glyph, directional) = if expanded {
        (&crate::git_panel::CHEVRON_DOWN, false)
    } else {
        (&crate::git_panel::CHEVRON_RIGHT, true)
    };
    let gap = theme.space(Space::Xs).px();
    let chip_h = chip_height(theme);
    let focus_width = theme.metric("windowIconFocus", "outlineWidth").px();
    let mut chevron_icon = icon(glyph, CHEVRON_SIZE)
        .color(theme.color("text-muted"))
        .a11y_hidden();
    if directional {
        chevron_icon = chevron_icon.mirror_in_rtl();
    }
    let chevron = row()
        .w(16.0)
        .h(chip_h)
        .center()
        .child(chevron_icon)
        .key(format!("chevron-{key}"))
        .a11y_hidden();

    let action = Rc::new(move |s: &mut S, _: &mut rune::Tx| press(s));
    let on_press = action.clone();
    let mut trigger = row()
        .full_width()
        .min_w(0.0)
        .gap(gap)
        .hover(theme.color("surface-hover"))
        .focus_ring(focus_width, -focus_width, theme.color("focus-ring-color"))
        .role("button")
        .label(label)
        .help(metrics_caption(items))
        .expanded(expanded)
        .focusable(true)
        .on_press_tx(move |s, tx| on_press(s, tx))
        .on_key(layout::enter_action(action))
        .key(format!("toggle-{key}"));

    if !expanded {
        trigger = trigger.min_h(chip_h).items_center().child(chevron);
        if let Some(heading) = heading {
            trigger = trigger.child(
                text(heading)
                    .text_role(TextRole::Label)
                    .color(theme.color("text-muted"))
                    .a11y_hidden(),
            );
        }
        trigger = trigger.child(summary_strip(key, items, theme).a11y_hidden());
    } else if let Some(heading) = heading {
        let head = row()
            .min_h(chip_h)
            .items_center()
            .gap(gap)
            .child(chevron)
            .child(
                text(heading)
                    .text_role(TextRole::Label)
                    .color(theme.color("text-muted"))
                    .a11y_hidden(),
            )
            .a11y_hidden();
        trigger =
            trigger
                .flex_wrap()
                .items_center()
                .child(head)
                .children(items.iter().enumerate().map(|(i, item)| {
                    metric(item.label, item.value, item.full)
                        .key(format!("chip-{key}-{i}"))
                        .a11y_hidden()
                }));
    } else {
        let chips = row()
            .remaining()
            .min_w(0.0)
            .flex_wrap()
            .items_center()
            .gap(gap)
            .children(items.iter().enumerate().map(|(i, item)| {
                metric(item.label, item.value, item.full)
                    .key(format!("chip-{key}-{i}"))
                    .a11y_hidden()
            }));
        trigger = trigger.items_start().child(chevron).child(chips);
    }

    row().full_width().min_w(0.0).child(trigger).key(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Direction, Env, Key, KeyEvent, Mods, Runtime};

    #[derive(Default)]
    struct Harness {
        expanded: bool,
        heading: bool,
        rtl: bool,
    }

    fn view(s: &Harness, _: &mut rune::Cx<Harness>) -> El {
        let summary = [
            Metric {
                label: "Input",
                value: "1.2M",
                full: "1,234,567",
            },
            Metric {
                label: "Output",
                value: "23K",
                full: "23,456",
            },
            Metric {
                label: "Cost",
                value: "$12.34",
                full: "$12.34",
            },
        ];
        let full = [
            Metric {
                label: "Input",
                value: "1.2M",
                full: "1,234,567",
            },
            Metric {
                label: "Output",
                value: "23K",
                full: "23,456",
            },
            Metric {
                label: "Reasoning",
                value: "500",
                full: "500",
            },
            Metric {
                label: "Cache Read",
                value: "2K",
                full: "2,400",
            },
            Metric {
                label: "Cache Write",
                value: "48",
                full: "48",
            },
            Metric {
                label: "Cost",
                value: "$12.34",
                full: "$12.34",
            },
        ];
        let items: &[Metric<'_>] = if s.expanded { &full } else { &summary };
        let heading = s.heading.then_some("Tokens");
        let body = disclosure(
            "row",
            "Expand token metrics. Input: 1,234,567",
            heading,
            s.expanded,
            items,
            |s: &mut Harness| s.expanded = !s.expanded,
        );
        let root = rune::col().w_full().child(body);
        if s.rtl {
            root.dir(Direction::Rtl)
        } else {
            root
        }
    }

    #[test]
    fn collapsed_summary_ellipsizes_narrow_ltr_and_rtl_and_fits_wide() {
        for (heading, rtl) in [(false, false), (false, true), (true, false), (true, true)] {
            let mut rt = Runtime::new(
                Harness {
                    expanded: false,
                    heading,
                    rtl,
                },
                view,
                (220.0, 120.0),
                Env::new(false, 1.0),
            );
            rt.frame(0.0);
            let summary = rt
                .elements()
                .into_iter()
                .find(|el| el.key.as_deref() == Some("summary-row"))
                .expect("summary strip");
            assert!(summary.truncate, "summary strip must truncate");
            assert!(
                summary.text_cut,
                "narrow 220px summary must ellipsize (heading={heading}, rtl={rtl}): rect={:?}",
                summary.rect
            );
            assert!(
                rt.elements()
                    .iter()
                    .all(|el| el.target[0] >= -0.5 && el.target[0] + el.target[2] <= 220.5),
                "narrow collapsed row overflowed (heading={heading}, rtl={rtl})"
            );
            assert_eq!(
                rt.elements()
                    .iter()
                    .filter(|el| el.role == "button")
                    .count(),
                1,
                "disclosure must have exactly one button (no nested buttons)"
            );

            // Wide viewport fits without truncation.
            rt.set_viewport((640.0, 120.0), 1.0);
            rt.frame(1.0 / 60.0);
            let wide = rt
                .elements()
                .into_iter()
                .find(|el| el.key.as_deref() == Some("summary-row"))
                .expect("summary strip");
            assert!(
                !wide.text_cut,
                "wide 640px summary must not ellipsize (heading={heading}, rtl={rtl})"
            );
        }
    }

    #[test]
    fn expanded_wraps_without_overflow_keeps_top_chevron_and_toggles_by_enter_and_space() {
        let mut rt = Runtime::new(
            Harness::default(),
            view,
            (220.0, 200.0),
            Env::new(false, 1.0),
        );
        rt.frame(0.0);
        rt.update(|_, tx| tx.focus("toggle-row", true));
        rt.frame(0.0);

        let enter = KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        };
        rt.key(enter.clone());
        rt.key_up(enter);
        rt.frame(1.0 / 60.0);
        assert!(rt.state.expanded, "Enter must expand disclosure");

        let chevron = rt
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some("chevron-row"))
            .unwrap();
        let chips: Vec<_> = rt
            .elements()
            .into_iter()
            .filter(|el| {
                el.key
                    .as_deref()
                    .is_some_and(|k| k.starts_with("chip-row-"))
            })
            .collect();
        assert_eq!(chips.len(), 6);
        assert!(
            chips
                .iter()
                .all(|c| c.target[0] >= -0.5 && c.target[0] + c.target[2] <= 220.5),
            "expanded chips overflowed 220px"
        );
        let rows: std::collections::BTreeSet<i32> =
            chips.iter().map(|c| c.target[1].round() as i32).collect();
        assert!(rows.len() > 1, "expanded chips must wrap at 220px");
        let chevron_mid = chevron.target[1] + chevron.target[3] * 0.5;
        let first_mid = chips[0].target[1] + chips[0].target[3] * 0.5;
        assert!(
            (chevron_mid - first_mid).abs() < 1.0,
            "chevron must align with first chip row: chevron={:?} chip0={:?}",
            chevron.target,
            chips[0].target
        );

        rt.set_viewport((900.0, 200.0), 1.0);
        rt.frame(1.0 / 60.0);
        let wide_chips: Vec<_> = rt
            .elements()
            .into_iter()
            .filter(|el| {
                el.key
                    .as_deref()
                    .is_some_and(|k| k.starts_with("chip-row-"))
            })
            .collect();
        let wide_rows: std::collections::BTreeSet<i32> = wide_chips
            .iter()
            .map(|c| c.target[1].round() as i32)
            .collect();
        assert_eq!(
            wide_rows.len(),
            1,
            "expanded chips must fit on 1 row at 900px: {wide_rows:?}"
        );
        rt.set_viewport((220.0, 200.0), 1.0);
        rt.frame(1.0 / 60.0);

        let space = KeyEvent {
            key: Key::Text(" ".into()),
            mods: Mods::default(),
        };
        rt.key(space.clone());
        rt.key_up(space);
        rt.frame(1.0 / 60.0);
        assert!(!rt.state.expanded, "Space must collapse disclosure");
    }
}
