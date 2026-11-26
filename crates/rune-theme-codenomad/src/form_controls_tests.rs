use super::*;
use crate::palettes::{self, ColorField, ColorSchemeColors};
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

#[derive(Default)]
struct Demo {
    radio: usize,
    checked_a: bool,
    checked_b: bool,
}

fn demo_view(s: &Demo, cx: &mut Cx<Demo>) -> El {
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

fn assert_palette_controls(label: &str, dark: bool) {
    let demo = Demo {
        radio: 0,
        checked_a: false,
        checked_b: true,
    };
    let mut rt = Runtime::new(demo, demo_view, (240.0, 480.0), Env::new(dark, 1.0));
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

    let els = rt.elements();
    for key in ["opt-a", "opt-b", "chk-a", "chk-b"] {
        let root = els.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
        assert_eq!(root.radius, 0.0, "{label}/{key} must stay square");
        for child in els.iter().filter(|e| e.path.starts_with(&root.path)) {
            assert_eq!(
                child.radius, 0.0,
                "{label}/{key} child {} must stay square",
                child.path
            );
        }
    }

    // Unchecked radio and checkbox indicator outlines meet WCAG 3:1 in linear RGB
    // against indicator fill, rest card fill, and hover card fill.
    let t = tokens(dark);
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    for key in ["opt-b", "chk-a"] {
        let card = els.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
        let indicator = els
            .iter()
            .find(|e| e.key.as_deref() == Some("indicator") && e.path.starts_with(&card.path))
            .unwrap();
        let border = indicator.border_color.expect("unchecked outline border");
        let fill = effective_backgrounds(indicator.fill, base);
        let rest = effective_backgrounds(card.fill, base);
        let hover = effective_backgrounds(card_hover_fill(t, card.fill), base);
        let backgrounds = [fill[0], fill[1], rest[0], rest[1], hover[0], hover[1]];
        let ratio = worst_contrast(border, &backgrounds);
        assert!(
            ratio >= 3.0,
            "{label}/{key} unchecked indicator border contrast below 3:1: {ratio:.2}"
        );
    }

    // Checked radio indicator border and inner mark meet WCAG 3:1 in linear RGB.
    {
        let card = els
            .iter()
            .find(|e| e.key.as_deref() == Some("opt-a"))
            .unwrap();
        let indicator = els
            .iter()
            .find(|e| e.key.as_deref() == Some("indicator") && e.path.starts_with(&card.path))
            .unwrap();
        let mark = els
            .iter()
            .find(|e| e.key.as_deref() == Some("mark") && e.path.starts_with(&card.path))
            .unwrap();
        let border = indicator.border_color.expect("checked radio border");
        let fill = effective_backgrounds(indicator.fill, base);
        let rest = effective_backgrounds(card.fill, base);
        let border_ratio = worst_contrast(border, &[fill[0], fill[1], rest[0], rest[1]]);
        assert!(
            border_ratio >= 3.0,
            "{label}/opt-a checked radio border contrast below 3:1: {border_ratio:.2}"
        );
        let mark_ratio = worst_contrast(mark.fill, &[fill[0], fill[1]]);
        assert!(
            mark_ratio >= 3.0,
            "{label}/opt-a checked radio mark contrast below 3:1: {mark_ratio:.2}"
        );
    }

    // Checked checkbox indicator is distinguishable from the card and its checkmark meets >= 3:1.
    {
        let card = els
            .iter()
            .find(|e| e.key.as_deref() == Some("chk-b"))
            .unwrap();
        let indicator = els
            .iter()
            .find(|e| e.key.as_deref() == Some("indicator") && e.path.starts_with(&card.path))
            .unwrap();
        let border = indicator.border_color.expect("checked checkbox border");
        let fill = effective_backgrounds(indicator.fill, base);
        let rest = effective_backgrounds(card.fill, base);
        let box_visible = worst_contrast(indicator.fill, &rest).max(worst_contrast(
            border,
            &[fill[0], fill[1], rest[0], rest[1]],
        ));
        assert!(
            box_visible >= 3.0,
            "{label}/chk-b checked checkbox box contrast below 3:1: {box_visible:.2}"
        );
        let (_, _, mark_color) = checked_checkbox_colors(t, card.fill);
        let mark_ratio = worst_contrast(mark_color, &[fill[0], fill[1]]);
        assert!(
            mark_ratio >= 3.0,
            "{label}/chk-b checked checkbox mark contrast below 3:1: {mark_ratio:.2}"
        );
    }

    // Focus ring color meets WCAG 3:1 in linear RGB on both checked and unchecked cards.
    let checked_fill = t.color("menu-item-selected-bg");
    let unchecked_fill = t.color("surface-control");
    let unchecked_hover = card_hover_fill(t, unchecked_fill);
    let checked_bgs = effective_backgrounds(checked_fill, base);
    let unchecked_rest = effective_backgrounds(unchecked_fill, base);
    let hover = effective_backgrounds(unchecked_hover, base);
    let unchecked_bgs = [unchecked_rest[0], unchecked_rest[1], hover[0], hover[1]];
    let checked_ring = card_focus_ring_color(t, true, checked_fill, checked_fill);
    let unchecked_ring = card_focus_ring_color(t, false, unchecked_fill, unchecked_hover);
    assert!(
        worst_contrast(checked_ring, &checked_bgs) >= 3.0,
        "{label}: checked focus ring contrast below 3:1 ({:.2})",
        worst_contrast(checked_ring, &checked_bgs)
    );
    assert!(
        worst_contrast(unchecked_ring, &unchecked_bgs) >= 3.0,
        "{label}: unchecked focus ring contrast below 3:1 ({:.2})",
        worst_contrast(unchecked_ring, &unchecked_bgs)
    );

    // Overlong unbroken option label and description wrap within 240px width.
    let opt_b_card = els
        .iter()
        .find(|e| e.key.as_deref() == Some("opt-b"))
        .unwrap();
    let opt_b_label = els
        .iter()
        .find(|e| e.key.as_deref() == Some("label") && e.path.starts_with(&opt_b_card.path))
        .unwrap();
    let opt_b_desc = els
        .iter()
        .find(|e| e.key.as_deref() == Some("description") && e.path.starts_with(&opt_b_card.path))
        .unwrap();
    assert!(
        opt_b_label.rect[0] + opt_b_label.rect[2] <= opt_b_card.rect[0] + opt_b_card.rect[2] + 0.5,
        "{label}: unbroken label overflowed card: label={:?} card={:?}",
        opt_b_label.rect,
        opt_b_card.rect
    );
    assert!(
        opt_b_desc.rect[0] + opt_b_desc.rect[2] <= opt_b_card.rect[0] + opt_b_card.rect[2] + 0.5,
        "{label}: unbroken description overflowed card: desc={:?} card={:?}",
        opt_b_desc.rect,
        opt_b_card.rect
    );
    assert!(
        opt_b_label.rect[3] > t.text(TextRole::Button).line_px() * 1.5,
        "{label}: unbroken label should wrap across multiple lines: {:?}",
        opt_b_label.rect
    );
    assert!(
        opt_b_desc.rect[3] > t.text(TextRole::Small).line_px() * 1.5,
        "{label}: unbroken description should wrap across multiple lines: {:?}",
        opt_b_desc.rect
    );

    // Tabbing into an already-selected radio paints a square 2px focus ring inset inside its 1px border.
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
        "{label}: Tab into radio group must focus selected radio with visible focus ring"
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
        "{label}: checked radio focus ring must be inset and distinct from 1px border: card={:?} expected_ring={:?}",
        focused_el.rect, expected_ring
    );
}

#[test]
fn radio_and_checkbox_options_meet_contrast_focus_and_wrapping_across_all_palettes() {
    for dark in [false, true] {
        palettes::with_palette(None, || {
            assert_palette_controls(
                if dark {
                    "default-dark"
                } else {
                    "default-light"
                },
                dark,
            );
        });
        let hc = palettes::increased_contrast(None, dark).expect("high-contrast default");
        palettes::with_palette(Some(hc), || {
            assert_palette_controls(
                if dark {
                    "default-dark-hc"
                } else {
                    "default-light-hc"
                },
                dark,
            );
        });
    }

    // Verify every built-in palette (including Iris and Parchment) and its high-contrast variant.
    for palette in palettes::built_in() {
        palettes::with_palette(Some(palette), || {
            assert_palette_controls(palette.id, palette.dark);
        });
        if let Some(hc) = palettes::increased_contrast(Some(palette), palette.dark) {
            palettes::with_palette(Some(hc), || {
                assert_palette_controls(&format!("{}-hc", palette.id), palette.dark);
            });
        }
    }

    // Verify pathological low-contrast custom palette triggers the verified black/white fallback.
    let low_contrast = ColorField::ALL
        .into_iter()
        .fold(ColorSchemeColors::default_custom(), |colors, field| {
            colors.with(field, "#848484").expect("canonical grey hex")
        });
    for dark in [false, true] {
        let custom = palettes::custom(Some("low-contrast-test"), dark, false, low_contrast.clone());
        palettes::with_resolved(Some(custom), || {
            assert_palette_controls(
                if dark {
                    "custom-low-contrast-dark"
                } else {
                    "custom-low-contrast-light"
                },
                dark,
            );
        });
    }

    // Verify mixed-surface custom palette (black surfaceBase with white surfaceSecondary &
    // textPrimary, producing black field + mid-grey card + white hover) still passes >= 3:1.
    let mixed_surface = ColorSchemeColors::default_custom()
        .with(ColorField::SurfaceBase, "#000000")
        .unwrap()
        .with(ColorField::SurfaceSecondary, "#FFFFFF")
        .unwrap()
        .with(ColorField::TextPrimary, "#FFFFFF")
        .unwrap();
    for dark in [false, true] {
        let custom = palettes::custom(
            Some("mixed-surface-test"),
            dark,
            false,
            mixed_surface.clone(),
        );
        palettes::with_resolved(Some(custom), || {
            assert_palette_controls(
                if dark {
                    "custom-mixed-surface-dark"
                } else {
                    "custom-mixed-surface-light"
                },
                dark,
            );
        });
    }
}
