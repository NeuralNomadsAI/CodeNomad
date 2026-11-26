//! Native accessible radio and checkbox controls for interruption question forms.
use crate::{
    Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{El, col, el, icon, row, text};

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

pub fn radio_group(label: &str, description: Option<&str>, horizontal: bool, items: Vec<El>) -> El {
    let t = tokens(layout::dark());
    let mut group = if horizontal {
        row().flex_wrap().gap(t.space(Space::Sm).px())
    } else {
        col().gap(t.space(Space::Xs).px())
    }
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
        .gap(t.space(Space::Xxs).px())
        .child(
            text(label)
                .key("label")
                .text_role(TextRole::Button)
                .color(label_color)
                .wrap(),
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
                .wrap(),
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
        .focus_ring(1.0, -1.0, t.color("focus-ring-color"))
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
    let indicator_border = if disabled {
        t.color("border-muted")
    } else if selected {
        accent
    } else {
        t.color("border-base")
    };
    let indicator_fill = if disabled {
        t.color("surface-control")
    } else {
        t.color("surface-field")
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

pub fn checkbox_group(label: &str, description: Option<&str>, items: Vec<El>) -> El {
    let t = tokens(layout::dark());
    let mut group = col()
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
    let (indicator_fill, indicator_border, mark_color) = if disabled {
        (
            t.color("surface-control"),
            t.color("border-muted"),
            t.color("text-muted"),
        )
    } else if checked {
        (accent, accent, t.color("text-on-accent"))
    } else {
        (
            t.color("surface-field"),
            t.color("border-base"),
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
    use rune::{Cx, Env, Runtime};
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
    fn radio_and_checkbox_options_keep_square_geometry_and_accessible_states() {
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
                    .child(
                        radio_group(
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
                                    "Beta",
                                    None,
                                    s.radio == 1,
                                    false,
                                    true,
                                    (2, 2),
                                    |s: &mut Demo| s.radio = 1,
                                ),
                            ],
                        )
                        .key("radio-grp"),
                    )
                    .child(
                        checkbox_group(
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
                        )
                        .key("check-grp"),
                    )
            })
        }

        for dark in [false, true] {
            let demo = Demo {
                radio: 0,
                checked_a: false,
                checked_b: true,
            };
            let mut rt = Runtime::new(demo, view, (360.0, 400.0), Env::new(dark, 1.0));
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
        }
    }
}
