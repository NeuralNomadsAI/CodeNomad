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
            .child(form_header("Question", "Confirm deployment"))
            .child(form_error("Unsupported form"))
            .child(field_heading("Environment").key("field-heading"))
            .child(field_description("Choose a target").key("field-description"))
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
            .child(clear_choice_button(
                "clear-btn",
                "Clear",
                "Choice · Clear",
                false,
                |s: &mut Demo, _| s.radio = 0,
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
    let mut rt = Runtime::new(demo, demo_view, (240.0, 640.0), Env::new(dark, 1.0));
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
    for key in ["opt-a", "opt-b", "clear-btn", "chk-a", "chk-b"] {
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

    let decode_instance_color = |rgba: [f32; 4], srgb_blend: bool| -> Color {
        let a = rgba[3].clamp(0.0, 1.0);
        let decode = |v: f32| {
            let straight = if a > 0.0 {
                (v / a).clamp(0.0, 1.0)
            } else {
                0.0
            };
            if srgb_blend {
                srgb_decode(straight)
            } else {
                straight
            }
        };
        Color {
            r: decode(rgba[0]),
            g: decode(rgba[1]),
            b: decode(rgba[2]),
            a,
        }
    };
    let painted_card_fill = |rt: &Runtime<Demo>, key: &str| -> Color {
        let card = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some(key))
            .unwrap();
        let rect = rt
            .instances
            .iter()
            .find(|inst| {
                inst.params[1] == KIND_RECT
                    && inst.fill[3] > 0.0
                    && (0..4).all(|i| (inst.rect[i] - card.rect[i]).abs() <= 1.0)
            })
            .unwrap_or_else(|| panic!("{label}/{key}: missing painted card rect {:?}", card.rect));
        decode_instance_color(rect.fill, rt.srgb_blend())
    };

    // Inspect actual painted rest, hover, and selected colors across all cards and Clear button.
    let t = tokens(dark);
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let mut painted_hover_fills: std::collections::HashMap<&str, Color> =
        std::collections::HashMap::new();
    let mut now = 0.0;
    for key in ["opt-b", "clear-btn", "chk-a"] {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_move(x, y);
        now += 1.0;
        rt.frame(now);
        painted_hover_fills.insert(key, painted_card_fill(&rt, key));
    }
    rt.pointer_move(-10.0, -10.0);
    now += 1.0;
    rt.frame(now);
    let els = rt.elements();

    // Form header, error banner, field heading, and field description meet >= 4.5:1 against base.
    for key in [
        "form-eyebrow",
        "form-title",
        "form-unsupported",
        "field-heading",
        "field-description",
    ] {
        let text_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("{label}: missing form copy {key}"));
        let color = text_el.text_color.expect("form copy text_color");
        let ratio = worst_contrast(color, &[base]);
        assert!(
            ratio >= 4.5,
            "{label}/{key} form copy contrast below 4.5:1: {ratio:.2} (color={color:?}, base={base:?})"
        );
    }

    // Enabled Clear control meets >= 4.5:1 text contrast against both painted rest and hover fills.
    {
        let clear = els
            .iter()
            .find(|e| e.key.as_deref() == Some("clear-btn"))
            .unwrap();
        let rest = effective_backgrounds(painted_card_fill(&rt, "clear-btn"), base);
        let hover = effective_backgrounds(painted_hover_fills["clear-btn"], base);
        let text_bgs = [rest[0], rest[1], hover[0], hover[1]];
        let label_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some("label") && e.path.starts_with(&clear.path))
            .unwrap();
        let label_color = label_el.text_color.expect("clear label text_color");
        let label_ratio = worst_contrast(label_color, &text_bgs);
        assert!(
            label_ratio >= 4.5,
            "{label}/clear-btn label text contrast below 4.5:1: {label_ratio:.2}"
        );
    }

    // Unchecked radio and checkbox indicator outlines (>= 3:1) and option copy (>= 4.5:1)
    // against actual painted indicator fill, rest card fill, and hovered card fill.
    for key in ["opt-b", "chk-a"] {
        let card = els.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
        let indicator = els
            .iter()
            .find(|e| e.key.as_deref() == Some("indicator") && e.path.starts_with(&card.path))
            .unwrap();
        let border = indicator.border_color.expect("unchecked outline border");
        let fill = effective_backgrounds(indicator.fill, base);
        let rest = effective_backgrounds(painted_card_fill(&rt, key), base);
        let hover = effective_backgrounds(painted_hover_fills[key], base);
        let backgrounds = [fill[0], fill[1], rest[0], rest[1], hover[0], hover[1]];
        let ratio = worst_contrast(border, &backgrounds);
        assert!(
            ratio >= 3.0,
            "{label}/{key} unchecked indicator border contrast below 3:1: {ratio:.2}"
        );
        let text_bgs = [rest[0], rest[1], hover[0], hover[1]];
        let label_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some("label") && e.path.starts_with(&card.path))
            .unwrap();
        let label_color = label_el.text_color.expect("option label text_color");
        let label_ratio = worst_contrast(label_color, &text_bgs);
        assert!(
            label_ratio >= 4.5,
            "{label}/{key} unchecked label text contrast below 4.5:1: {label_ratio:.2}"
        );
        if let Some(desc_el) = els
            .iter()
            .find(|e| e.key.as_deref() == Some("description") && e.path.starts_with(&card.path))
        {
            let desc_color = desc_el.text_color.expect("option description text_color");
            let desc_ratio = worst_contrast(desc_color, &text_bgs);
            assert!(
                desc_ratio >= 4.5,
                "{label}/{key} unchecked description text contrast below 4.5:1: {desc_ratio:.2}"
            );
        }
    }

    // Checked radio & checkbox text contrast (>= 4.5:1) against actual painted selected card fill.
    for key in ["opt-a", "chk-b"] {
        let card = els.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
        let rest = effective_backgrounds(painted_card_fill(&rt, key), base);
        let label_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some("label") && e.path.starts_with(&card.path))
            .unwrap();
        let label_color = label_el.text_color.expect("selected label text_color");
        let label_ratio = worst_contrast(label_color, &rest);
        assert!(
            label_ratio >= 4.5,
            "{label}/{key} selected label text contrast below 4.5:1: {label_ratio:.2}"
        );
        if let Some(desc_el) = els
            .iter()
            .find(|e| e.key.as_deref() == Some("description") && e.path.starts_with(&card.path))
        {
            let desc_color = desc_el.text_color.expect("selected description text_color");
            let desc_ratio = worst_contrast(desc_color, &rest);
            assert!(
                desc_ratio >= 4.5,
                "{label}/{key} selected description text contrast below 4.5:1: {desc_ratio:.2}"
            );
        }
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
        let mark = els
            .iter()
            .find(|e| e.key.as_deref() == Some("mark") && e.path.starts_with(&card.path))
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
        let mark_color = mark
            .text_color
            .unwrap_or_else(|| checked_checkbox_colors(t, card.fill).2);
        let mark_ratio = worst_contrast(mark_color, &[fill[0], fill[1]]);
        assert!(
            mark_ratio >= 3.0,
            "{label}/chk-b checked checkbox mark contrast below 3:1: {mark_ratio:.2}"
        );
    }

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

    // Tabbing into an already-selected radio, Clear button, or unchecked checkbox paints a square
    // 2px focus ring inset inside its 1px border with >= 3:1 linear-RGB contrast against actual
    // painted rest and hover fills; programmatic keyboard focus on form-header paints a >= 3:1 ring
    // against base.
    let assert_ring = |rt: &Runtime<Demo>, key: &str, inset: f32, backgrounds: &[Color]| {
        let focused_el = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some(key))
            .unwrap();
        assert!(
            focused_el.focused && focused_el.focus_visible,
            "{label}/{key}: control must show visible keyboard focus"
        );
        let expected_ring = [
            focused_el.rect[0] + inset,
            focused_el.rect[1] + inset,
            focused_el.rect[2] - inset * 2.0,
            focused_el.rect[3] - inset * 2.0,
        ];
        let ring = rt.instances.iter().find(|inst| {
            inst.params[1] == KIND_RECT
                && (inst.params[0] - 2.0).abs() < 0.01
                && inst.border[3] > 0.0
                && inst.radii == [0.0; 4]
                && (0..4).all(|i| (inst.rect[i] - expected_ring[i]).abs() <= 1.0)
        });
        let ring = ring.unwrap_or_else(|| {
            panic!(
                "{label}/{key}: missing expected square 2px focus ring: el={:?} expected_ring={:?}",
                focused_el.rect, expected_ring
            )
        });
        let ring_color = decode_instance_color(ring.border, rt.srgb_blend());
        let ratio = worst_contrast(ring_color, backgrounds);
        assert!(
            ratio >= 3.0,
            "{label}/{key}: painted focus ring contrast below 3:1: {ratio:.2} (ring={ring_color:?}, raw_border={:?}, bgs={backgrounds:?})",
            ring.border
        );
    };

    rt.update(|_, tx| tx.focus(FORM_FOCUS_ANCHOR, true));
    now += 1.0;
    rt.frame(now);
    assert_ring(&rt, FORM_FOCUS_ANCHOR, 0.0, &[base]);

    let tab = KeyEvent {
        key: Key::Tab,
        mods: Mods::default(),
    };
    rt.key(tab.clone());
    rt.key_up(tab.clone());
    now += 1.0;
    rt.frame(now);
    let checked_bgs = effective_backgrounds(painted_card_fill(&rt, "opt-a"), base);
    assert_ring(&rt, "opt-a", 2.0, &checked_bgs);

    // Tabbing moves focus to the Clear button and paints a >= 3:1 focus ring on rest & hover.
    rt.key(tab.clone());
    rt.key_up(tab.clone());
    now += 1.0;
    rt.frame(now);
    let clear_rest = effective_backgrounds(painted_card_fill(&rt, "clear-btn"), base);
    let clear_hover = effective_backgrounds(painted_hover_fills["clear-btn"], base);
    assert_ring(
        &rt,
        "clear-btn",
        2.0,
        &[clear_rest[0], clear_rest[1], clear_hover[0], clear_hover[1]],
    );

    // Tabbing again moves focus to the unchecked checkbox without toggling it.
    rt.key(tab.clone());
    rt.key_up(tab);
    now += 1.0;
    rt.frame(now);
    let unchecked_rest = effective_backgrounds(painted_card_fill(&rt, "chk-a"), base);
    let unchecked_hover = effective_backgrounds(painted_hover_fills["chk-a"], base);
    assert_ring(
        &rt,
        "chk-a",
        2.0,
        &[
            unchecked_rest[0],
            unchecked_rest[1],
            unchecked_hover[0],
            unchecked_hover[1],
        ],
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
