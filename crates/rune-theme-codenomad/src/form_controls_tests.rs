use super::*;
use crate::palettes::{self, ColorField, ColorSchemeColors};
use rune::{
    Cx, Env, Key, KeyEvent, Mods, Runtime,
    render::{KIND_GLYPH, KIND_RECT},
};
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
    custom: rune::TextEdit,
    locked: bool,
}

fn demo_view(s: &Demo, cx: &mut Cx<Demo>) -> El {
    layout::render(cx, |_| {
        col()
            .w_full()
            .h_full()
            .child(form_header("Question", "Confirm deployment", false))
            .child(form_error("Unsupported form"))
            .child(field_heading("Environment", true).key("field-heading"))
            .child(field_description("Choose a target").key("field-description"))
            .child(radio_group(
                "radio-grp",
                "Choice",
                None,
                false,
                true,
                false,
                vec![
                    radio_option(
                        "opt-a",
                        "Alpha",
                        Some("First choice"),
                        None,
                        s.radio == 0,
                        s.locked,
                        true,
                        (1, 2),
                        |s: &mut Demo| s.radio = 0,
                    ),
                    radio_option(
                        "opt-b",
                        "https://example.invalid/very/long/unbroken/option/segment/that/must/wrap/anywhere",
                        Some("unbroken_description_token_without_spaces_for_mobile_wrap_check_1234567890"),
                        None,
                        s.radio == 1,
                        s.locked,
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
                s.locked,
                |s: &mut Demo, _| s.radio = 0,
            ))
            .child(form_textarea(
                "custom-input",
                &s.custom,
                "Other values",
                None,
                s.locked,
                true,
                false,
                |s: &mut Demo| &mut s.custom,
            ))
            .child(checkbox_group(
                "check-grp",
                "Tags",
                Some("Question Required"),
                vec![
                    checkbox_option(
                        "chk-a",
                        "Enable logging",
                        Some("Detailed output"),
                        Some("Question Required"),
                        s.checked_a,
                        s.locked,
                        false,
                        |s: &mut Demo| s.checked_a = !s.checked_a,
                    ),
                    checkbox_option(
                        "chk-b",
                        "Dry run",
                        None,
                        Some("Question Required"),
                        s.checked_b,
                        s.locked,
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
        custom: rune::TextEdit::new("Custom answer"),
        locked: false,
    };
    let mut rt = Runtime::new(demo, demo_view, (240.0, 720.0), Env::new(dark, 1.0));
    rt.frame(0.0);
    let tree = rt.accessibility_json();
    let group = node(&tree, "radio-grp").unwrap();
    assert_eq!(group["role"], "radio-group");
    assert_eq!(group["name"], "Choice");
    assert!(has_state(group, "required"), "{group}");

    let check_group = node(&tree, "check-grp").unwrap();
    assert_eq!(check_group["role"], "group");
    assert!(!has_state(check_group, "required"), "{check_group}");
    assert_eq!(check_group["description"], "Question Required");

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
    assert_eq!(chk_a["description"], "Detailed output · Question Required");
    assert!(has_state(chk_a, "unchecked"), "{chk_a}");

    let chk_b = node(&tree, "chk-b").unwrap();
    assert_eq!(chk_b["role"], "check-box");
    assert_eq!(chk_b["name"], "Dry run");
    assert_eq!(chk_b["description"], "Question Required");
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

    // Form header, error banner, required field heading + marker, and field description meet >= 4.5:1 against base.
    for key in [
        "form-eyebrow",
        "form-title",
        "form-unsupported",
        "heading-text",
        "required-marker",
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

    // Enabled Clear control meets >= 4.5:1 text contrast and >= 3:1 boundary contrast at rest and hover.
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
        let clear_border = clear.border_color.expect("clear-btn border_color");
        let rest_fill = painted_card_fill(&rt, "clear-btn");
        let hover_fill = painted_hover_fills["clear-btn"];
        let rest_boundary = worst_contrast(rest_fill, &[base])
            .max(worst_contrast(clear_border, &[base, rest[0], rest[1]]));
        let hover_boundary = worst_contrast(hover_fill, &[base])
            .max(worst_contrast(clear_border, &[base, hover[0], hover[1]]));
        assert!(
            rest_boundary >= 3.0 && hover_boundary >= 3.0,
            "{label}/clear-btn boundary contrast below 3:1: rest={rest_boundary:.2} hover={hover_boundary:.2} (border={clear_border:?}, rest={rest_fill:?}, hover={hover_fill:?}, base={base:?})"
        );
    }

    // Form custom/text editor meets >= 4.5:1 ink contrast against its actual painted field fill,
    // >= 3:1 boundary visibility against the dock, and >= 3:1 selection fill + >= 4.5:1 selected
    // glyph contrast when focused with a range selection.
    {
        let box_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some("custom-input"))
            .expect("custom-input box");
        assert_eq!(box_el.radius, 0.0, "{label}/custom-input must stay square");
        let input_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some("input") && e.path.starts_with(&box_el.path))
            .expect("custom-input inner input");
        let field_fill = painted_card_fill(&rt, "custom-input");
        let field_bgs = effective_backgrounds(field_fill, base);
        let ink = input_el.text_color.expect("custom-input text_color");
        let ink_ratio = worst_contrast(ink, &field_bgs);
        assert!(
            ink_ratio >= 4.5,
            "{label}/custom-input ink contrast below 4.5:1: {ink_ratio:.2} (ink={ink:?}, bgs={field_bgs:?})"
        );
        let field_border = box_el.border_color.expect("custom-input border_color");
        let field_boundary = worst_contrast(field_fill, &[base]).max(worst_contrast(
            field_border,
            &[base, field_bgs[0], field_bgs[1]],
        ));
        assert!(
            field_boundary >= 3.0,
            "{label}/custom-input boundary contrast below 3:1: {field_boundary:.2}"
        );

        let ix = input_el.rect[0] + input_el.rect[2] * 0.5;
        let iy = input_el.rect[1] + input_el.rect[3] * 0.5;
        rt.pointer_down(ix, iy);
        rt.pointer_up(ix, iy);
        now += 1.0;
        rt.frame(now);
        rt.update(|s, _| {
            s.custom.anchor = 0;
            s.custom.focus = 6;
        });
        now += 1.0;
        rt.frame(now);
        let sel_rect = rt
            .instances
            .iter()
            .find(|inst| {
                inst.params[1] == KIND_RECT
                    && inst.fill[3] > 0.0
                    && inst.rect[0] >= input_el.rect[0] - 1.0
                    && inst.rect[1] >= input_el.rect[1] - 1.0
                    && inst.rect[0] + inst.rect[2] <= input_el.rect[0] + input_el.rect[2] + 1.0
                    && inst.rect[1] + inst.rect[3] <= input_el.rect[1] + input_el.rect[3] + 1.0
                    && inst.rect[2] > 4.0
                    && inst.rect[2] < input_el.rect[2] - 1.0
            })
            .unwrap_or_else(|| {
                panic!(
                    "{label}/custom-input: missing painted selection rect inside {:?}",
                    input_el.rect
                )
            });
        let sel_fill = decode_instance_color(sel_rect.fill, rt.srgb_blend());
        let sel_fill_ratio = worst_contrast(sel_fill, &field_bgs);
        assert!(
            sel_fill_ratio >= 3.0,
            "{label}/custom-input painted selection fill contrast below 3:1: {sel_fill_ratio:.2} (sel={sel_fill:?}, field={field_bgs:?})"
        );
        let sel_bgs = effective_backgrounds(sel_fill, field_bgs[0]);
        let mut selected_glyphs = 0usize;
        for inst in &rt.instances {
            if inst.params[1] != KIND_GLYPH || inst.fill[3] <= 0.0 {
                continue;
            }
            let cx = inst.rect[0] + inst.rect[2] * 0.5;
            let cy = inst.rect[1] + inst.rect[3] * 0.5;
            if cx >= sel_rect.rect[0]
                && cx <= sel_rect.rect[0] + sel_rect.rect[2]
                && cy >= sel_rect.rect[1]
                && cy <= sel_rect.rect[1] + sel_rect.rect[3]
            {
                selected_glyphs += 1;
                let glyph_ink = decode_instance_color(inst.fill, rt.srgb_blend());
                let glyph_ratio = worst_contrast(glyph_ink, &sel_bgs);
                assert!(
                    glyph_ratio >= 4.5,
                    "{label}/custom-input painted selected glyph contrast below 4.5:1: {glyph_ratio:.2} (ink={glyph_ink:?}, sel={sel_bgs:?})"
                );
            }
        }
        assert!(
            selected_glyphs > 0,
            "{label}/custom-input: expected painted glyphs inside selection rect {:?}",
            sel_rect.rect
        );
    }

    // Unchecked radio and checkbox indicator outlines (>= 3:1) and option copy (>= 4.5:1)
    // against actual composited indicator pixels, rest card fill, and hovered card fill.
    for key in ["opt-b", "chk-a"] {
        let card = els.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
        let indicator = els
            .iter()
            .find(|e| e.key.as_deref() == Some("indicator") && e.path.starts_with(&card.path))
            .unwrap();
        let border = indicator.border_color.expect("unchecked outline border");
        let rest = effective_backgrounds(painted_card_fill(&rt, key), base);
        let hover = effective_backgrounds(painted_hover_fills[key], base);
        let card_bgs = [rest[0], rest[1], hover[0], hover[1]];
        let nested_fill = composite_over(indicator.fill, &card_bgs);
        let mut backgrounds = Vec::with_capacity(nested_fill.len() + card_bgs.len());
        backgrounds.extend_from_slice(&nested_fill);
        backgrounds.extend_from_slice(&card_bgs);
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

    // Checked radio indicator border and inner mark meet WCAG 3:1 against composited nested pixels.
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
        let rest = effective_backgrounds(painted_card_fill(&rt, "opt-a"), base);
        let fill = composite_over(indicator.fill, &rest);
        let mut border_bgs = Vec::with_capacity(fill.len() + rest.len());
        border_bgs.extend_from_slice(&fill);
        border_bgs.extend_from_slice(&rest);
        let border_ratio = worst_contrast(border, &border_bgs);
        assert!(
            border_ratio >= 3.0,
            "{label}/opt-a checked radio border contrast below 3:1: {border_ratio:.2}"
        );
        let mark_ratio = worst_contrast(mark.fill, &fill);
        assert!(
            mark_ratio >= 3.0,
            "{label}/opt-a checked radio mark contrast below 3:1: {mark_ratio:.2}"
        );
    }

    // Checked checkbox indicator is distinguishable from the card and its checkmark meets >= 3:1
    // against actual composited nested pixels (no translucent double-coating).
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
        let rest = effective_backgrounds(painted_card_fill(&rt, "chk-b"), base);
        let fill = composite_over(indicator.fill, &rest);
        let mut border_bgs = Vec::with_capacity(fill.len() + rest.len());
        border_bgs.extend_from_slice(&fill);
        border_bgs.extend_from_slice(&rest);
        let box_visible =
            worst_contrast(indicator.fill, &rest).max(worst_contrast(border, &border_bgs));
        assert!(
            box_visible >= 3.0,
            "{label}/chk-b checked checkbox box contrast below 3:1: {box_visible:.2}"
        );
        let mark_color = mark
            .text_color
            .unwrap_or_else(|| checked_checkbox_colors(t, card.fill).2);
        let mark_ratio = worst_contrast(mark_color, &fill);
        assert!(
            mark_ratio >= 3.0,
            "{label}/chk-b checked checkbox mark contrast below 3:1: {mark_ratio:.2} (mark={mark_color:?}, nested_fill={fill:?})"
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

    // Tabbing again moves focus through custom-input to the unchecked checkbox without toggling it.
    rt.key(tab.clone());
    rt.key_up(tab.clone());
    now += 1.0;
    rt.frame(now);
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

    // Verify translucent double-coat regression palette (#3C3C3C surfaces, #909090 muted,
    // #A8A8A8 primary, #9A9A9A accent in dark mode) keeps checked checkbox mark >= 3:1.
    let mid_grey_dark = ColorSchemeColors::default_custom()
        .with(ColorField::SurfaceBase, "#3C3C3C")
        .unwrap()
        .with(ColorField::SurfaceSecondary, "#3C3C3C")
        .unwrap()
        .with(ColorField::TextMuted, "#909090")
        .unwrap()
        .with(ColorField::TextPrimary, "#A8A8A8")
        .unwrap()
        .with(ColorField::AccentPrimary, "#9A9A9A")
        .unwrap();
    let custom_mid_grey = palettes::custom(Some("mid-grey-dark"), true, false, mid_grey_dark);
    palettes::with_resolved(Some(custom_mid_grey), || {
        assert_palette_controls("custom-mid-grey-dark", true);
    });

    // Verify no-mans-land boundary palette (SurfaceBase=#343434, SurfaceSecondary=#CACACA)
    // keeps Clear and editor boundaries >= 3:1 at rest and on hover.
    let mid_gap = ColorSchemeColors::default_custom()
        .with(ColorField::SurfaceBase, "#343434")
        .unwrap()
        .with(ColorField::SurfaceSecondary, "#CACACA")
        .unwrap();
    for dark in [false, true] {
        let custom_gap = palettes::custom(Some("mid-gap"), dark, false, mid_gap.clone());
        palettes::with_resolved(Some(custom_gap), || {
            assert_palette_controls(
                if dark {
                    "custom-mid-gap-dark"
                } else {
                    "custom-mid-gap-light"
                },
                dark,
            );
        });
    }

    // Verify monochromatic mid-gray palette (all swatches #848484) keeps editor text,
    // focused selection highlight (>= 3:1), and selected glyphs (>= 4.5:1) visible.
    let monochrome_mid = ColorField::ALL
        .into_iter()
        .fold(ColorSchemeColors::default_custom(), |colors, field| {
            colors.with(field, "#848484").unwrap()
        });
    for dark in [false, true] {
        let custom_mono =
            palettes::custom(Some("monochrome-mid"), dark, false, monochrome_mid.clone());
        palettes::with_resolved(Some(custom_mono), || {
            assert_palette_controls(
                if dark {
                    "custom-monochrome-mid-dark"
                } else {
                    "custom-monochrome-mid-light"
                },
                dark,
            );

            // Locked (disabled) controls must stay readable (>= 4.5:1) with distinguishable
            // selected radio and checked checkbox marks (>= 3:1) even on all-#848484 palettes.
            let locked_demo = Demo {
                radio: 0,
                checked_a: false,
                checked_b: true,
                custom: rune::TextEdit::new("Locked answer"),
                locked: true,
            };
            let mut lrt = Runtime::new(locked_demo, demo_view, (240.0, 720.0), Env::new(dark, 1.0));
            lrt.frame(0.0);
            let ltree = lrt.accessibility_json();
            for disabled_key in ["opt-a", "opt-b", "clear-btn", "chk-a", "chk-b"] {
                assert!(
                    has_state(node(&ltree, disabled_key).unwrap(), "disabled"),
                    "locked {disabled_key} must expose disabled state"
                );
            }
            let lels = lrt.elements();
            let t = tokens(dark);
            let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
            let decode = |rgba: [f32; 4], srgb_blend: bool| -> Color {
                let a = rgba[3].clamp(0.0, 1.0);
                let ch = |v: f32| {
                    let s = if a > 0.0 {
                        (v / a).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    if srgb_blend { srgb_decode(s) } else { s }
                };
                Color {
                    r: ch(rgba[0]),
                    g: ch(rgba[1]),
                    b: ch(rgba[2]),
                    a,
                }
            };
            let painted_fill = |key: &str| -> Color {
                let el = lels.iter().find(|e| e.key.as_deref() == Some(key)).unwrap();
                let inst = lrt
                    .instances
                    .iter()
                    .find(|i| {
                        i.params[1] == KIND_RECT
                            && i.fill[3] > 0.0
                            && (0..4).all(|k| (i.rect[k] - el.rect[k]).abs() <= 1.0)
                    })
                    .unwrap();
                decode(inst.fill, lrt.srgb_blend())
            };
            let box_el = lels
                .iter()
                .find(|e| e.key.as_deref() == Some("custom-input"))
                .unwrap();
            let input_el = lels
                .iter()
                .find(|e| e.key.as_deref() == Some("input") && e.path.starts_with(&box_el.path))
                .unwrap();
            let f_bgs = effective_backgrounds(painted_fill("custom-input"), base);
            assert!(
                worst_contrast(input_el.text_color.unwrap(), &f_bgs) >= 4.5,
                "locked custom-input text must stay readable on monochrome palette"
            );
            for card_key in ["opt-a", "chk-b", "clear-btn"] {
                let card = lels
                    .iter()
                    .find(|e| e.key.as_deref() == Some(card_key))
                    .unwrap();
                let c_bgs = effective_backgrounds(painted_fill(card_key), base);
                let lbl = lels
                    .iter()
                    .find(|e| e.key.as_deref() == Some("label") && e.path.starts_with(&card.path))
                    .unwrap();
                assert!(
                    worst_contrast(lbl.text_color.unwrap(), &c_bgs) >= 4.5,
                    "locked {card_key} label must stay readable on monochrome palette"
                );
            }
            for checked_key in ["opt-a", "chk-b"] {
                let card = lels
                    .iter()
                    .find(|e| e.key.as_deref() == Some(checked_key))
                    .unwrap();
                let c_bgs = effective_backgrounds(painted_fill(checked_key), base);
                let ind = lels
                    .iter()
                    .find(|e| {
                        e.key.as_deref() == Some("indicator") && e.path.starts_with(&card.path)
                    })
                    .unwrap();
                let mark = lels
                    .iter()
                    .find(|e| e.key.as_deref() == Some("mark") && e.path.starts_with(&card.path))
                    .unwrap();
                let ind_bgs = composite_over(ind.fill, &c_bgs);
                let mut border_bgs = ind_bgs.clone();
                border_bgs.extend_from_slice(&c_bgs);
                assert!(
                    worst_contrast(ind.border_color.unwrap(), &border_bgs) >= 3.0,
                    "locked {checked_key} indicator border must stay visible on monochrome palette"
                );
                let mark_color = if checked_key == "opt-a" {
                    mark.fill
                } else {
                    lrt.instances
                        .iter()
                        .find(|i| {
                            i.params[1] == KIND_GLYPH
                                && i.fill[3] > 0.0
                                && i.rect[0] >= ind.rect[0] - 1.0
                                && i.rect[1] >= ind.rect[1] - 1.0
                                && i.rect[0] + i.rect[2] <= ind.rect[0] + ind.rect[2] + 1.0
                                && i.rect[1] + i.rect[3] <= ind.rect[1] + ind.rect[3] + 1.0
                        })
                        .map(|i| decode(i.fill, lrt.srgb_blend()))
                        .or(mark.text_color)
                        .expect("painted locked checkbox mark")
                };
                assert!(
                    worst_contrast(mark_color, &ind_bgs) >= 3.0,
                    "locked {checked_key} checked mark must stay distinguishable on monochrome palette"
                );
            }
        });
    }
}

#[test]
fn reduced_tab_order_reaches_radios_clear_and_checkboxes_with_full_keyboard_access_off() {
    let demo = Demo {
        radio: 0,
        checked_a: false,
        checked_b: true,
        custom: rune::TextEdit::new(""),
        locked: false,
    };
    let mut rt = Runtime::new(demo, demo_view, (240.0, 720.0), Env::new(true, 1.0));
    rt.frame(0.0);
    rt.set_full_keyboard_access(false);

    let focused = |rt: &mut Runtime<Demo>| -> Option<String> {
        let mut key = None;
        rt.update(|_, tx| key = tx.focused().map(str::to_owned));
        key
    };
    let send = |rt: &mut Runtime<Demo>, key: Key| {
        let ev = KeyEvent {
            key,
            mods: Mods::default(),
        };
        rt.key(ev.clone());
        rt.key_up(ev);
        rt.frame(1.0 / 60.0);
    };

    send(&mut rt, Key::Tab);
    assert_eq!(focused(&mut rt).as_deref(), Some("opt-a"));

    // Arrow key inside radio group still moves focus and selects opt-b.
    send(&mut rt, Key::Down);
    assert_eq!(focused(&mut rt).as_deref(), Some("opt-b"));
    assert_eq!(rt.state.radio, 1);

    // Tab advances through Clear button, custom editor, and both checkboxes with FKA off.
    send(&mut rt, Key::Tab);
    assert_eq!(focused(&mut rt).as_deref(), Some("clear-btn"));
    send(&mut rt, Key::Tab);
    assert_eq!(focused(&mut rt).as_deref(), Some("input"));
    send(&mut rt, Key::Tab);
    assert_eq!(focused(&mut rt).as_deref(), Some("chk-a"));
    send(&mut rt, Key::Enter);
    assert!(rt.state.checked_a, "Enter must toggle focused checkbox");
    send(&mut rt, Key::Tab);
    assert_eq!(focused(&mut rt).as_deref(), Some("chk-b"));

    // Tabbing to radio opt-a then activating opt-b via press moves Rune focus to opt-b so a
    // subsequent Space press keeps opt-b checked instead of reverting to opt-a.
    let mut rt2 = Runtime::new(
        Demo {
            radio: 0,
            checked_a: false,
            checked_b: false,
            custom: rune::TextEdit::new(""),
            locked: false,
        },
        demo_view,
        (240.0, 720.0),
        Env::new(true, 1.0),
    );
    rt2.frame(0.0);
    send(&mut rt2, Key::Tab);
    assert_eq!(focused(&mut rt2).as_deref(), Some("opt-a"));
    let (bx, by) = rt2.find("opt-b").expect("opt-b bounds");
    rt2.pointer_down(bx, by);
    rt2.pointer_up(bx, by);
    rt2.frame(1.0 / 60.0);
    assert_eq!(rt2.state.radio, 1, "activating opt-b must check opt-b");
    assert_eq!(
        focused(&mut rt2).as_deref(),
        Some("opt-b"),
        "activating opt-b must move Rune focus to opt-b"
    );
    send(&mut rt2, Key::Text(" ".into()));
    assert_eq!(
        rt2.state.radio, 1,
        "Space after activating opt-b must keep opt-b checked"
    );
    assert_eq!(focused(&mut rt2).as_deref(), Some("opt-b"));
}
