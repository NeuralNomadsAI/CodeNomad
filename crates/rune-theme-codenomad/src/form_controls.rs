//! Native accessible radio and checkbox controls for interruption question forms.
use crate::{
    Space, TextRole, Tokens, kit,
    layout::{self, Layout},
    palettes, tokens,
};
use rune::{Color, El, col, el, icon, row, text};

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn color_rgb(color: Color, over: [u8; 3]) -> [u8; 3] {
    let a = color.a.clamp(0.0, 1.0);
    let mix = |fg: f32, bg: u8| -> u8 {
        ((fg.clamp(0.0, 1.0) * a + (f32::from(bg) / 255.0) * (1.0 - a)) * 255.0).round() as u8
    };
    [
        mix(color.r, over[0]),
        mix(color.g, over[1]),
        mix(color.b, over[2]),
    ]
}

fn unchecked_indicator_border(t: &Tokens, fill: Color, card: Color) -> Color {
    let base = color_rgb(t.color("surface-overlay"), [0, 0, 0]);
    let fill_rgb = color_rgb(fill, base);
    let card_rgb = color_rgb(card, base);
    for token in [
        "border-base",
        "text-muted",
        "text-secondary",
        "text-primary",
    ] {
        let candidate = t.color(token);
        let rgb = color_rgb(candidate, card_rgb);
        if palettes::contrast_ratio(rgb, fill_rgb) >= 3.0
            && palettes::contrast_ratio(rgb, card_rgb) >= 3.0
        {
            return candidate;
        }
    }
    t.color("text-primary")
}

pub fn field_heading(title: &str) -> El {
    let t = tokens(layout::dark());
    text(title)
        .text_role(TextRole::Label)
        .color(t.color("text-primary"))
        .wrap_anywhere()
}

pub fn field_description(description: &str) -> El {
    let t = tokens(layout::dark());
    text(description)
        .text_role(TextRole::Small)
        .color(t.color("text-secondary"))
        .wrap_anywhere()
}

pub fn radio_group(
    key: &str,
    label: &str,
    description: Option<&str>,
    horizontal: bool,
    items: Vec<El>,
) -> El {
    let t = tokens(layout::dark());
    let mut group = if horizontal {
        row().flex_wrap().gap(t.space(Space::Sm).px())
    } else {
        col().gap(t.space(Space::Xs).px())
    }
    .key(key.to_string())
    .w_full()
    .role("radiogroup")
    .label(label)
    .focus_group();
    if let Some(desc) = non_empty(description) {
        group = group.description(desc);
    }
    group.children(items)
}

fn option_copy(label: &str, desc: Option<&str>, disabled: bool) -> El {
    let t = tokens(layout::dark());
    let label_color = if disabled {
        t.color("text-muted")
    } else {
        t.color("text-primary")
    };
    let mut copy = col()
        .key("copy")
        .shrink()
        .min_w(0.0)
        .gap(t.space(Space::Xxs).px())
        .child(
            text(label)
                .key("label")
                .text_role(TextRole::Button)
                .color(label_color)
                .wrap_anywhere(),
        )
        .a11y_hidden();
    if let Some(d) = desc {
        let desc_color = if disabled {
            t.color("text-muted")
        } else {
            t.color("text-secondary")
        };
        copy = copy.child(
            text(d)
                .key("description")
                .text_role(TextRole::Small)
                .color(desc_color)
                .wrap_anywhere(),
        );
    }
    copy
}

#[allow(clippy::too_many_arguments)]
fn option_card<S: 'static>(
    key: &str,
    role: &'static str,
    label: &str,
    desc: Option<&str>,
    selected: bool,
    disabled: bool,
    full_width: bool,
    indicator: El,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let card_fill = if selected && !disabled {
        t.color("menu-item-selected-bg")
    } else {
        t.color("surface-control")
    };
    let card_border = if disabled {
        t.color("border-muted")
    } else if selected {
        t.color("accent-primary")
    } else {
        t.color("border-base")
    };
    let mut item = row()
        .key(key.to_string())
        .role(role)
        .label(label)
        .checked(selected)
        .focusable(!disabled)
        .disabled(disabled)
        .min_h(t.metric("button", "minHeight").px())
        .padding(t.space(Space::Sm).px())
        .gap(t.space(Space::Sm).px())
        .radius(0.0)
        .fill(card_fill)
        .border(1.0, card_border)
        .focus_ring(2.0, -4.0, t.color("focus-ring-color"))
        .focus_ring_radius(0.0)
        .child(indicator)
        .child(option_copy(label, desc, disabled));
    if desc.is_some() {
        item = item.items_start();
    } else {
        item = item.center_y();
    }
    if full_width {
        item = item.w_full();
    }
    if let Some(d) = desc {
        item = item.description(d);
    }
    if !disabled && !selected {
        item = item.hover(t.color("surface-hover"));
    }
    if !disabled {
        item = item.on_press(press);
    }
    item
}

#[allow(clippy::too_many_arguments)]
pub fn radio_option<S: 'static>(
    key: &str,
    label: &str,
    description: Option<&str>,
    selected: bool,
    disabled: bool,
    full_width: bool,
    position: (usize, usize),
    press: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let desc = non_empty(description);
    let accent = t.color("accent-primary");
    let card_fill = if selected && !disabled {
        t.color("menu-item-selected-bg")
    } else {
        t.color("surface-control")
    };
    let indicator_fill = if disabled {
        t.color("surface-control")
    } else {
        t.color("surface-field")
    };
    let indicator_border = if disabled {
        t.color("border-muted")
    } else if selected {
        accent
    } else {
        unchecked_indicator_border(&t, indicator_fill, card_fill)
    };
    let mark_color = if disabled {
        t.color("text-muted")
    } else {
        accent
    };
    let indicator = el()
        .key("indicator")
        .size(16.0, 16.0)
        .center()
        .radius(0.0)
        .fill(indicator_fill)
        .border(1.0, indicator_border)
        .child(
            el().key("mark")
                .size(8.0, 8.0)
                .radius(0.0)
                .fill(mark_color)
                .opacity(if selected { 1.0 } else { 0.0 }),
        )
        .a11y_hidden();

    option_card(
        key, "radio", label, desc, selected, disabled, full_width, indicator, press,
    )
    .focus_selected(selected)
    .position_in_set(position.0, position.1)
}

pub fn checkbox_group(key: &str, label: &str, description: Option<&str>, items: Vec<El>) -> El {
    let t = tokens(layout::dark());
    let mut group = col()
        .key(key.to_string())
        .w_full()
        .gap(t.space(Space::Xs).px())
        .role("group")
        .label(label);
    if let Some(desc) = non_empty(description) {
        group = group.description(desc);
    }
    group.children(items)
}

pub fn checkbox_option<S: 'static>(
    key: &str,
    label: &str,
    description: Option<&str>,
    checked: bool,
    disabled: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let k = kit(dark);
    let desc = non_empty(description);
    let accent = t.color("accent-primary");
    let card_fill = if checked && !disabled {
        t.color("menu-item-selected-bg")
    } else {
        t.color("surface-control")
    };
    let (indicator_fill, indicator_border, mark_color) = if disabled {
        (
            t.color("surface-control"),
            t.color("border-muted"),
            t.color("text-muted"),
        )
    } else if checked {
        (accent, accent, t.color("text-on-accent"))
    } else {
        let fill = t.color("surface-field");
        (
            fill,
            unchecked_indicator_border(&t, fill, card_fill),
            t.color("text-on-accent"),
        )
    };
    let indicator = el()
        .key("indicator")
        .size(16.0, 16.0)
        .center()
        .radius(0.0)
        .fill(indicator_fill)
        .border(1.0, indicator_border)
        .child(
            icon(k.glyph.check, 10.0)
                .key("mark")
                .color(mark_color)
                .opacity(if checked { 1.0 } else { 0.0 }),
        )
        .a11y_hidden();

    option_card(
        key, "checkbox", label, desc, checked, disabled, true, indicator, toggle,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Cx, Env, Key, KeyEvent, Mods, Runtime, render::KIND_RECT};
    use serde_json::Value;

    fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
        if tree["key"] == key {
            return Some(tree);
        }
        tree["children"]
            .as_array()?
            .iter()
            .find_map(|child| node(child, key))
    }

    fn has_state(node: &Value, state: &str) -> bool {
        node["states"]
            .as_array()
            .is_some_and(|states| states.iter().any(|s| s == state))
    }

    #[test]
    fn radio_and_checkbox_options_keep_square_geometry_contrast_focus_and_wrapping() {
        #[derive(Default)]
        struct Demo {
            radio: usize,
            checked_a: bool,
            checked_b: bool,
        }
        fn view(s: &Demo, cx: &mut Cx<Demo>) -> El {
            layout::render(cx, |_| {
                col()
                    .w_full()
                    .h_full()
                    .child(radio_group(
                        "radio-grp",
                        "Choice",
                        None,
                        false,
                        vec![
                            radio_option(
                                "opt-a",
                                "Alpha",
                                Some("First choice"),
                                s.radio == 0,
                                false,
                                true,
                                (1, 2),
                                |s: &mut Demo| s.radio = 0,
                            ),
                            radio_option(
                                "opt-b",
                                "https://example.invalid/very/long/unbroken/option/segment/that/must/wrap/anywhere",
                                Some("unbroken_description_token_without_spaces_for_mobile_wrap_check_1234567890"),
                                s.radio == 1,
                                false,
                                true,
                                (2, 2),
                                |s: &mut Demo| s.radio = 1,
                            ),
                        ],
                    ))
                    .child(checkbox_group(
                        "check-grp",
                        "Tags",
                        None,
                        vec![
                            checkbox_option(
                                "chk-a",
                                "Enable logging",
                                Some("Detailed output"),
                                s.checked_a,
                                false,
                                |s: &mut Demo| s.checked_a = !s.checked_a,
                            ),
                            checkbox_option(
                                "chk-b",
                                "Dry run",
                                None,
                                s.checked_b,
                                false,
                                |s: &mut Demo| s.checked_b = !s.checked_b,
                            ),
                        ],
                    ))
            })
        }

        for dark in [false, true] {
            for high_contrast in [false, true] {
                let palette = high_contrast.then(|| {
                    palettes::increased_contrast(None, dark).expect("high-contrast default palette")
                });
                palettes::with_palette(palette, || {
                    let demo = Demo {
                        radio: 0,
                        checked_a: false,
                        checked_b: true,
                    };
                    let mut rt = Runtime::new(demo, view, (240.0, 480.0), Env::new(dark, 1.0));
                    rt.frame(0.0);
                    let tree = rt.accessibility_json();
                    let group = node(&tree, "radio-grp").unwrap();
                    assert_eq!(group["role"], "radio-group");
                    assert_eq!(group["name"], "Choice");

                    let opt_a = node(&tree, "opt-a").unwrap();
                    assert_eq!(opt_a["role"], "radio-button");
                    assert_eq!(opt_a["name"], "Alpha");
                    assert_eq!(opt_a["description"], "First choice");
                    assert_eq!(opt_a["position"], 1);
                    assert!(has_state(opt_a, "checked"), "{opt_a}");

                    let opt_b = node(&tree, "opt-b").unwrap();
                    assert_eq!(opt_b["role"], "radio-button");
                    assert_eq!(opt_b["position"], 2);
                    assert!(has_state(opt_b, "unchecked"), "{opt_b}");

                    let chk_a = node(&tree, "chk-a").unwrap();
                    assert_eq!(chk_a["role"], "check-box");
                    assert_eq!(chk_a["name"], "Enable logging");
                    assert_eq!(chk_a["description"], "Detailed output");
                    assert!(has_state(chk_a, "unchecked"), "{chk_a}");

                    let chk_b = node(&tree, "chk-b").unwrap();
                    assert_eq!(chk_b["role"], "check-box");
                    assert_eq!(chk_b["name"], "Dry run");
                    assert!(has_state(chk_b, "checked"), "{chk_b}");

                    // Square corners on radio card, indicator, mark, and checkbox control.
                    let els = rt.elements();
                    for key in ["opt-a", "opt-b", "chk-a", "chk-b"] {
                        let root = els.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
                        assert_eq!(root.radius, 0.0, "{key} must stay square");
                        for child in els.iter().filter(|e| e.path.starts_with(&root.path)) {
                            assert_eq!(
                                child.radius, 0.0,
                                "{key} child {} must stay square",
                                child.path
                            );
                        }
                    }

                    // Unchecked radio and checkbox indicator outlines meet 3:1 against fill and card.
                    let t = tokens(dark);
                    let base = color_rgb(t.color("surface-overlay"), [0, 0, 0]);
                    for key in ["opt-b", "chk-a"] {
                        let card = els.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
                        let indicator = els
                            .iter()
                            .find(|e| {
                                e.key.as_deref() == Some("indicator")
                                    && e.path.starts_with(&card.path)
                            })
                            .unwrap();
                        let border = indicator.border_color.expect("unchecked outline border");
                        let card_rgb = color_rgb(card.fill, base);
                        let fill_rgb = color_rgb(indicator.fill, base);
                        let border_rgb = color_rgb(border, card_rgb);
                        let vs_fill = palettes::contrast_ratio(border_rgb, fill_rgb);
                        let vs_card = palettes::contrast_ratio(border_rgb, card_rgb);
                        assert!(
                            vs_fill >= 3.0 && vs_card >= 3.0,
                            "{key} (dark={dark}, hc={high_contrast}) contrast below 3:1: vs_fill={vs_fill:.2}, vs_card={vs_card:.2}"
                        );
                    }

                    // Overlong unbroken option label and description wrap within 240px width.
                    let opt_b_card = els
                        .iter()
                        .find(|e| e.key.as_deref() == Some("opt-b"))
                        .unwrap();
                    let opt_b_label = els
                        .iter()
                        .find(|e| {
                            e.key.as_deref() == Some("label")
                                && e.path.starts_with(&opt_b_card.path)
                        })
                        .unwrap();
                    let opt_b_desc = els
                        .iter()
                        .find(|e| {
                            e.key.as_deref() == Some("description")
                                && e.path.starts_with(&opt_b_card.path)
                        })
                        .unwrap();
                    assert!(
                        opt_b_label.rect[0] + opt_b_label.rect[2]
                            <= opt_b_card.rect[0] + opt_b_card.rect[2] + 0.5,
                        "unbroken label overflowed card: label={:?} card={:?}",
                        opt_b_label.rect,
                        opt_b_card.rect
                    );
                    assert!(
                        opt_b_desc.rect[0] + opt_b_desc.rect[2]
                            <= opt_b_card.rect[0] + opt_b_card.rect[2] + 0.5,
                        "unbroken description overflowed card: desc={:?} card={:?}",
                        opt_b_desc.rect,
                        opt_b_card.rect
                    );
                    assert!(
                        opt_b_label.rect[3] > t.text(TextRole::Button).line_px() * 1.5,
                        "unbroken label should wrap across multiple lines: {:?}",
                        opt_b_label.rect
                    );
                    assert!(
                        opt_b_desc.rect[3] > t.text(TextRole::Small).line_px() * 1.5,
                        "unbroken description should wrap across multiple lines: {:?}",
                        opt_b_desc.rect
                    );

                    // Distinct selected vs unselected visual treatments.
                    let a_el = els
                        .iter()
                        .find(|e| e.key.as_deref() == Some("opt-a"))
                        .unwrap();
                    let b_el = els
                        .iter()
                        .find(|e| e.key.as_deref() == Some("opt-b"))
                        .unwrap();
                    assert_ne!(a_el.border_color, b_el.border_color);
                    assert_ne!(a_el.fill, b_el.fill);

                    let chk_a_el = els
                        .iter()
                        .find(|e| e.key.as_deref() == Some("chk-a"))
                        .unwrap();
                    let chk_b_el = els
                        .iter()
                        .find(|e| e.key.as_deref() == Some("chk-b"))
                        .unwrap();
                    assert_ne!(chk_a_el.border_color, chk_b_el.border_color);
                    assert_ne!(chk_a_el.fill, chk_b_el.fill);

                    // Tabbing into an already-selected radio paints a square focus ring inset inside its 1px border.
                    let tab = KeyEvent {
                        key: Key::Tab,
                        mods: Mods::default(),
                    };
                    rt.key(tab.clone());
                    rt.key_up(tab);
                    rt.frame(1.0 / 60.0);
                    let focused_el = rt
                        .elements()
                        .into_iter()
                        .find(|e| e.key.as_deref() == Some("opt-a"))
                        .unwrap();
                    assert!(
                        focused_el.focused && focused_el.focus_visible,
                        "Tab into radio group must focus selected radio with visible focus ring"
                    );
                    let expected_ring = [
                        focused_el.rect[0] + 2.0,
                        focused_el.rect[1] + 2.0,
                        focused_el.rect[2] - 4.0,
                        focused_el.rect[3] - 4.0,
                    ];
                    let has_distinct_ring = rt.instances.iter().any(|inst| {
                        inst.params[1] == KIND_RECT
                            && (inst.params[0] - 2.0).abs() < 0.01
                            && inst.border[3] > 0.0
                            && inst.radii == [0.0; 4]
                            && inst.rect[0] >= focused_el.rect[0] + 1.5
                            && inst.rect[1] >= focused_el.rect[1] + 1.5
                            && (0..4).all(|i| (inst.rect[i] - expected_ring[i]).abs() <= 1.0)
                    });
                    assert!(
                        has_distinct_ring,
                        "checked radio focus ring must be inset and distinct from 1px border: card={:?} expected_ring={:?}",
                        focused_el.rect, expected_ring
                    );
                });
            }
        }
    }
}
