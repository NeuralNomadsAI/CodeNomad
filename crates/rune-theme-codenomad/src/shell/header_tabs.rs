//! Conversation header chrome (context meter, connection indicator) and bordered right-panel tabs.
use super::ServiceDot;
use crate::{Length, Space, TextRole, layout, tokens};
use rune::{El, Icon, Tx, el, icon, row, text};
use std::rc::Rc;

const DIAL_SIZE: f32 = 22.0;
const DIAL_DIAMETER: f32 = 18.0;
const DIAL_RADIUS: f32 = 9.0;
const METER_LABEL_SIZE: f32 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextMeterDensity {
    Full,
    Compact,
    DialOnly,
}

static SECTOR_FULL: Icon = Icon {
    name: "context-sector-36",
    view: 22.0,
    body: r#"<circle cx="11" cy="11" r="9" fill="currentColor"/>"#,
};

static SECTORS: [Icon; 35] = [
    Icon {
        name: "context-sector-01",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 12.56 2.14 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-02",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 14.08 2.54 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-03",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 15.5 3.21 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-04",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 16.79 4.11 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-05",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 17.89 5.21 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-06",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 18.79 6.5 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-07",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 19.46 7.92 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-08",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 19.86 9.44 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-09",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 20 11 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-10",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 19.86 12.56 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-11",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 19.46 14.08 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-12",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 18.79 15.5 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-13",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 17.89 16.79 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-14",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 16.79 17.89 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-15",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 15.5 18.79 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-16",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 14.08 19.46 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-17",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 12.56 19.86 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-18",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 0 1 11 20 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-19",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 9.44 19.86 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-20",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 7.92 19.46 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-21",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 6.5 18.79 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-22",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 5.21 17.89 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-23",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 4.11 16.79 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-24",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 3.21 15.5 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-25",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 2.54 14.08 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-26",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 2.14 12.56 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-27",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 2 11 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-28",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 2.14 9.44 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-29",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 2.54 7.92 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-30",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 3.21 6.5 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-31",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 4.11 5.21 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-32",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 5.21 4.11 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-33",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 6.5 3.21 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-34",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 7.92 2.54 Z" fill="currentColor"/>"#,
    },
    Icon {
        name: "context-sector-35",
        view: 22.0,
        body: r#"<path d="M 11 11 L 11 2 A 9 9 0 1 1 9.44 2.14 Z" fill="currentColor"/>"#,
    },
];

fn sector_icon(ratio: f32) -> Option<&'static Icon> {
    if ratio <= 0.001 {
        return None;
    }
    if ratio >= 0.999 {
        return Some(&SECTOR_FULL);
    }
    let step = ((ratio.clamp(0.0, 1.0) * 36.0).round() as usize).clamp(1, 35);
    Some(&SECTORS[step - 1])
}

pub fn panel_tabs<S: 'static>(
    title: &str,
    labels: &[&str],
    chosen: usize,
    activate: impl Fn(&mut S, usize, &mut Tx) + Clone + 'static,
) -> El {
    let t = tokens(layout::dark());
    let height = t.metric("tabActive", "height").px();
    let top_w = t.metric("tabActive", "borderTopWidth").px();
    let bottom_w = t.metric("tabActive", "borderBottomWidth").px();
    let start_edge = t.metric("tabActive", "borderLeftWidth").px();
    let end_edge = t.metric("tabActive", "borderRightWidth").px();
    let pad_x = t.space(Space::Lg).px();
    let edge = t.color("tab-border");
    let hover = t.color("surface-hover-overlay");
    let ring_offset = t.metric("tabFocus", "ringOffset").px();
    let ring_width = t.metric("tabFocus", "ringWidth").px();
    let ring_color = t.color("accent-primary");
    let ring_offset_color = t.color("surface-secondary");
    let label_font = t.text(TextRole::Body);
    row()
        .role("tablist")
        .label(title)
        .focus_group()
        .items_end()
        .children(labels.iter().copied().enumerate().map(|(index, label)| {
            let active = index == chosen;
            let start_w = if index == 0 { start_edge } else { 0.0 };
            let background = t.color(if active {
                "surface-secondary"
            } else {
                "surface-shade-light"
            });
            let ink = t.color(if active {
                "tab-active-text"
            } else {
                "tab-inactive-text"
            });
            let activate = activate.clone();
            let action = Rc::new(move |s: &mut S, tx: &mut Tx| activate(s, index, tx));
            let press = action.clone();
            let space = action.clone();
            let key = format!("right-panel-tab-{index}");
            // Pass logical [top, end, bottom, start]; Rune's mirror_visual flips left/right in RTL.
            let tab = row()
                .key(key.clone())
                .role("tab")
                .label(label)
                .focusable(true)
                .focus_selected(active)
                .position_in_set(index + 1, labels.len())
                .h(height)
                .px(pad_x)
                .center()
                .radius(0.0)
                .fill(background)
                .hover(hover)
                .border_sides(
                    [
                        top_w,
                        end_edge,
                        if active { 0.0 } else { bottom_w },
                        start_w,
                    ],
                    edge,
                )
                .border_layout()
                .no_focus_ring()
                .focus_ring_for(key.clone(), ring_width, ring_offset, ring_color)
                .on_press_tx(move |s, tx| press(s, tx))
                .on_key(move |s, event, tx| {
                    if event.mods != rune::Mods::default() {
                        return false;
                    }
                    match event.key {
                        rune::Key::Enter => {
                            action(s, tx);
                            true
                        }
                        rune::Key::Text(ref value) if value == " " => {
                            space(s, tx);
                            true
                        }
                        _ => false,
                    }
                })
                .child(text(label).font(label_font).color(ink).a11y_hidden());
            row()
                .focus_ring_for(key, ring_offset, 0.0, ring_offset_color)
                .child(tab)
        }))
}

pub fn right_panel_header(left: bool, right: bool, touch: bool, tabs: El) -> El {
    let t = tokens(layout::dark());
    let control = super::control_size(touch);
    let inset = |reserve| {
        if reserve {
            t.space(Space::Xs).px() + control + t.space(Space::Sm).px()
        } else {
            t.space(Space::Sm).px()
        }
    };
    let border = t.metric("tabActive", "borderBottomWidth").px();
    let edge = t.color("tab-border");
    row()
        .w_full()
        .h(t.length(Length::PanelHeader).px())
        .items_end()
        .fill(t.color("surface-shade-light"))
        .child(
            el().w(inset(left))
                .h_full()
                .border_sides([0.0, 0.0, border, 0.0], edge)
                .border_layout(),
        )
        .child(tabs)
        .child(
            el().grow(1.0)
                .min_w(inset(right))
                .h_full()
                .border_sides([0.0, 0.0, border, 0.0], edge)
                .border_layout(),
        )
}

pub fn context_meter(
    used_label: &str,
    used_value: &str,
    available_label: &str,
    available_value: &str,
    ratio: Option<f32>,
    density: ContextMeterDensity,
    tooltip: &str,
) -> El {
    let t = tokens(layout::dark());
    let sector = ratio.and_then(|value| {
        let glyph = sector_icon(value)?;
        let color = if value >= 0.8 {
            t.color("status-error")
        } else if value >= 0.6 {
            t.color("status-warning")
        } else {
            t.color("status-success")
        };
        Some(
            icon(glyph, DIAL_SIZE)
                .key("context-meter-sector")
                .color(color)
                .opacity(0.95)
                .pin(Some(0.0), Some(0.0), None, None)
                .a11y_hidden(),
        )
    });
    let dial = row()
        .key("context-meter-dot")
        .size(DIAL_SIZE, DIAL_SIZE)
        .center()
        .a11y_hidden()
        .child(
            el().size(DIAL_DIAMETER, DIAL_DIAMETER)
                .radius(DIAL_RADIUS)
                .fill(t.color("surface-secondary"))
                .border(1.0, t.color("border-base"))
                .border_layout()
                .a11y_hidden(),
        )
        .children(sector);

    let values = (density != ContextMeterDensity::DialOnly).then(|| {
        let label_font =
            rune::TextStyle::new(METER_LABEL_SIZE, t.number("font-weight-regular").px());
        let value_font = rune::TextStyle::new(
            t.text(TextRole::Small).size,
            t.number("font-weight-semibold").px(),
        );
        let muted = t.color("text-muted");
        let primary = t.color("text-primary");
        let show_labels = density == ContextMeterDensity::Full;
        let used_upper = show_labels.then(|| used_label.to_uppercase());
        let avail_upper = show_labels.then(|| available_label.to_uppercase());
        row()
            .key("context-meter-values")
            .center_y()
            .gap(t.space(Space::Sm).px())
            .px(t.space(Space::Sm).px())
            .py(t.space(Space::Xxs).px())
            .radius(t.length(Length::ChipRadius).px())
            .border(1.0, t.color("border-base"))
            .border_layout()
            .opacity(0.5)
            .a11y_hidden()
            .children(used_upper.map(|label| {
                text(label)
                    .key("context-meter-used-label")
                    .font(label_font)
                    .color(muted)
                    .a11y_hidden()
            }))
            .child(
                text(used_value)
                    .font(value_font)
                    .color(primary)
                    .a11y_hidden(),
            )
            .child(
                text("/")
                    .font(t.text(TextRole::Small))
                    .color(muted)
                    .a11y_hidden(),
            )
            .children(avail_upper.map(|label| {
                text(label)
                    .key("context-meter-avail-label")
                    .font(label_font)
                    .color(muted)
                    .a11y_hidden()
            }))
            .child(
                text(available_value)
                    .font(value_font)
                    .color(primary)
                    .a11y_hidden(),
            )
    });

    let gap = if density == ContextMeterDensity::DialOnly {
        0.0
    } else {
        t.space(Space::Sm).px()
    };
    row()
        .key("context-meter")
        .center_y()
        .gap(gap)
        .label(tooltip)
        .help(tooltip)
        .child(dial)
        .children(values)
}

pub fn connection_indicator(state: ServiceDot, label: &str, show_label: bool) -> El {
    let t = tokens(layout::dark());
    let dot_size = t.space(Space::Sm).px();
    let dot_color = match state {
        ServiceDot::Ready => t.color("status-success"),
        ServiceDot::Pending => t.color("status-warning"),
        ServiceDot::Error => t.color("status-error"),
        ServiceDot::Stopped => t.color("text-muted"),
    };
    let dot = el()
        .key("connection-status-dot")
        .size(dot_size, dot_size)
        .radius(dot_size * 0.5)
        .fill(dot_color)
        .a11y_hidden();
    row()
        .key("connection-status")
        .center_y()
        .gap(t.space(Space::Xs).px() + t.space(Space::Xxs).px())
        .role("img")
        .label(label)
        .help(label)
        .child(dot)
        .children(show_label.then(|| {
            text(label)
                .font(t.text(TextRole::Small))
                .color(t.color("text-muted"))
                .a11y_hidden()
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Direction, col};

    #[test]
    fn context_meter_and_right_panel_header_adapt_in_light_and_dark_and_rtl() {
        struct Case {
            chosen: usize,
            dark: bool,
            rtl: bool,
            ratio: Option<f32>,
            density: ContextMeterDensity,
        }
        fn view(case: &Case, _: &mut rune::Cx<Case>) -> El {
            layout::with_appearance(case.dark, || {
                let tabs = panel_tabs(
                    "Right panel",
                    &["Status", "Files", "Missions"],
                    case.chosen,
                    |s: &mut Case, i, _| s.chosen = i,
                );
                let content = col()
                    .child(right_panel_header(false, true, false, tabs))
                    .child(context_meter(
                        "Used",
                        "28",
                        "Avail",
                        "128K",
                        case.ratio,
                        case.density,
                        "Used: 28 / Avail: 128,000",
                    ))
                    .child(connection_indicator(ServiceDot::Ready, "Connected", true));
                if case.rtl {
                    content.dir(Direction::Rtl)
                } else {
                    content
                }
            })
        }
        let run = |dark: bool, rtl: bool, ratio: Option<f32>, density: ContextMeterDensity| {
            let mut rt = rune::Runtime::new(
                Case {
                    chosen: 0,
                    dark,
                    rtl,
                    ratio,
                    density,
                },
                view,
                (380.0, 140.0),
                rune::Env::new(dark, 1.0),
            );
            rt.frame(0.0);
            let elements = rt.elements();
            let active = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("right-panel-tab-0"))
                .expect("active tab");
            let inactive = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("right-panel-tab-1"))
                .expect("inactive tab");
            assert_eq!(active.radius, 0.0);
            assert_ne!(active.fill, inactive.fill);
            if rtl {
                assert!(
                    active.rect[0] > inactive.rect[0],
                    "RTL tab 0 must sit to the right of tab 1: {:?} vs {:?}",
                    active.rect,
                    inactive.rect
                );
            } else {
                assert!(
                    active.rect[0] < inactive.rect[0],
                    "LTR tab 0 must sit to the left of tab 1: {:?} vs {:?}",
                    active.rect,
                    inactive.rect
                );
            }
            let has_sector = elements
                .iter()
                .any(|el| el.key.as_deref() == Some("context-meter-sector"));
            let has_values = elements
                .iter()
                .any(|el| el.key.as_deref() == Some("context-meter-values"));
            let has_used_label = elements
                .iter()
                .any(|el| el.key.as_deref() == Some("context-meter-used-label"));
            (active.fill, has_sector, has_values, has_used_label)
        };

        let (light_active, light_sector, light_vals, light_lbl) =
            run(false, false, Some(0.25), ContextMeterDensity::Full);
        let (dark_active, dark_sector, dark_vals, dark_lbl) =
            run(true, true, Some(0.85), ContextMeterDensity::Compact);
        let (_, empty_sector, dial_only_vals, dial_only_lbl) =
            run(true, false, None, ContextMeterDensity::DialOnly);

        assert_ne!(light_active, dark_active, "tab fill adapts light vs dark");
        assert!(light_sector && dark_sector, "non-zero ratio draws sector");
        assert!(!empty_sector, "missing ratio omits sector");
        assert!(light_vals && light_lbl, "Full shows values and labels");
        assert!(
            dark_vals && !dark_lbl,
            "Compact shows values without labels"
        );
        assert!(!dial_only_vals && !dial_only_lbl, "DialOnly hides pill");

        assert!(sector_icon(0.0).is_none());
        assert_eq!(sector_icon(0.25).map(|i| i.name), Some("context-sector-09"));
        assert_eq!(sector_icon(0.5).map(|i| i.name), Some("context-sector-18"));
        assert_eq!(sector_icon(1.0).map(|i| i.name), Some("context-sector-36"));

        fn dot_view(state: &(bool, ServiceDot), _: &mut rune::Cx<(bool, ServiceDot)>) -> El {
            layout::with_appearance(state.0, || connection_indicator(state.1, "Status", true))
        }
        for dark in [false, true] {
            let palette = tokens(dark);
            for (dot_state, token_name) in [
                (ServiceDot::Ready, "status-success"),
                (ServiceDot::Pending, "status-warning"),
                (ServiceDot::Error, "status-error"),
            ] {
                let mut rt = rune::Runtime::new(
                    (dark, dot_state),
                    dot_view,
                    (180.0, 40.0),
                    rune::Env::new(dark, 1.0),
                );
                rt.frame(0.0);
                let dot = rt
                    .elements()
                    .into_iter()
                    .find(|el| el.key.as_deref() == Some("connection-status-dot"))
                    .expect("connection-status-dot");
                assert_eq!(
                    dot.fill,
                    palette.color(token_name),
                    "connection dot must use {token_name} (dark={dark})"
                );
            }
        }
    }
}
