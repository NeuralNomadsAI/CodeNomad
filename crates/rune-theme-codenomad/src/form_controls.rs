//! Native accessible radio and checkbox controls for interruption question forms.
use crate::{
    Space, TextRole, Tokens, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{Color, El, col, el, icon, row, text};

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn srgb_encode(linear: f32) -> f32 {
    let c = linear.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn srgb_decode(encoded: f32) -> f32 {
    let c = encoded.clamp(0.0, 1.0);
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Composite `fg` over opaque linear `bg` in linear light.
fn composite_linear(fg: Color, bg: Color) -> Color {
    let a = fg.a.clamp(0.0, 1.0);
    Color {
        r: fg.r.clamp(0.0, 1.0) * a + bg.r.clamp(0.0, 1.0) * (1.0 - a),
        g: fg.g.clamp(0.0, 1.0) * a + bg.g.clamp(0.0, 1.0) * (1.0 - a),
        b: fg.b.clamp(0.0, 1.0) * a + bg.b.clamp(0.0, 1.0) * (1.0 - a),
        a: 1.0,
    }
}

/// Composite `fg` over opaque linear `bg` in sRGB-encoded space, returning linear light.
fn composite_srgb(fg: Color, bg: Color) -> Color {
    let a = fg.a.clamp(0.0, 1.0);
    let mix = |f: f32, b: f32| srgb_decode(srgb_encode(f) * a + srgb_encode(b) * (1.0 - a));
    Color {
        r: mix(fg.r, bg.r),
        g: mix(fg.g, bg.g),
        b: mix(fg.b, bg.b),
        a: 1.0,
    }
}

/// WCAG relative luminance of an opaque linear-sRGB `Color`.
fn linear_luminance(c: Color) -> f64 {
    0.2126 * f64::from(c.r.clamp(0.0, 1.0))
        + 0.7152 * f64::from(c.g.clamp(0.0, 1.0))
        + 0.0722 * f64::from(c.b.clamp(0.0, 1.0))
}

fn linear_contrast(a: Color, b: Color) -> f64 {
    let la = linear_luminance(a);
    let lb = linear_luminance(b);
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

fn worst_contrast(fg: Color, backgrounds: &[Color]) -> f64 {
    backgrounds
        .iter()
        .map(|&bg| {
            let lin = linear_contrast(composite_linear(fg, bg), bg);
            let srgb = linear_contrast(composite_srgb(fg, bg), bg);
            lin.min(srgb)
        })
        .fold(f64::INFINITY, f64::min)
}

fn try_contrasting_color(
    t: &Tokens,
    candidates: &[&str],
    backgrounds: &[Color],
    min_ratio: f64,
) -> Option<Color> {
    for &token in candidates {
        let candidate = t.color(token);
        if worst_contrast(candidate, backgrounds) >= min_ratio {
            return Some(candidate);
        }
    }
    const FALLBACKS: [Color; 8] = [
        Color::BLACK,
        Color::WHITE,
        Color {
            r: 0.12,
            g: 0.12,
            b: 0.12,
            a: 1.0,
        },
        Color {
            r: 0.16,
            g: 0.16,
            b: 0.16,
            a: 1.0,
        },
        Color {
            r: 0.18,
            g: 0.18,
            b: 0.18,
            a: 1.0,
        },
        Color {
            r: 0.22,
            g: 0.22,
            b: 0.22,
            a: 1.0,
        },
        Color {
            r: 0.26,
            g: 0.26,
            b: 0.26,
            a: 1.0,
        },
        Color {
            r: 0.30,
            g: 0.30,
            b: 0.30,
            a: 1.0,
        },
    ];
    let best = FALLBACKS
        .into_iter()
        .max_by(|&a, &b| {
            worst_contrast(a, backgrounds)
                .partial_cmp(&worst_contrast(b, backgrounds))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(Color::BLACK);
    (worst_contrast(best, backgrounds) >= min_ratio).then_some(best)
}

fn contrasting_color(
    t: &Tokens,
    candidates: &[&str],
    backgrounds: &[Color],
    min_ratio: f64,
) -> Color {
    if let Some(color) = try_contrasting_color(t, candidates, backgrounds, min_ratio) {
        return color;
    }
    if worst_contrast(Color::BLACK, backgrounds) >= worst_contrast(Color::WHITE, backgrounds) {
        Color::BLACK
    } else {
        Color::WHITE
    }
}

fn effective_backgrounds(surface: Color, base: Color) -> [Color; 2] {
    [
        composite_linear(surface, base),
        composite_srgb(surface, base),
    ]
}

fn composite_over(fg: Color, bgs: &[Color]) -> Vec<Color> {
    let mut out = Vec::with_capacity(bgs.len() * 2);
    for &bg in bgs {
        out.push(composite_linear(fg, bg));
        out.push(composite_srgb(fg, bg));
    }
    out
}

fn card_fill(t: &Tokens, selected: bool, disabled: bool) -> Color {
    let raw = if selected && !disabled {
        t.color("menu-item-selected-bg")
    } else {
        t.color("surface-control")
    };
    if disabled {
        return raw;
    }
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let bgs = effective_backgrounds(raw, base);
    if try_contrasting_color(t, &["text-primary", "text-secondary"], &bgs, 4.5).is_some() {
        raw
    } else {
        // When a translucent card fill straddles the 4.5:1 luminance boundary across linear
        // vs sRGB compositing, flatten it once so text always achieves >= 4.5:1.
        composite_srgb(raw, base)
    }
}

fn card_hover_fill(t: &Tokens, card_fill: Color) -> Color {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let rest = effective_backgrounds(card_fill, base);
    let raw_hover = t.color("surface-hover");
    let hover = effective_backgrounds(raw_hover, base);
    let backgrounds = [rest[0], rest[1], hover[0], hover[1]];
    let focus_ok = try_contrasting_color(
        t,
        &[
            "focus-ring-color",
            "accent-primary",
            "text-primary",
            "text-secondary",
        ],
        &backgrounds,
        3.0,
    )
    .is_some();
    let text_ok =
        try_contrasting_color(t, &["text-primary", "text-secondary"], &backgrounds, 4.5).is_some();
    if focus_ok && text_ok {
        raw_hover
    } else {
        card_fill
    }
}

fn card_text_colors(
    t: &Tokens,
    selected: bool,
    disabled: bool,
    card_fill: Color,
    hover_fill: Color,
) -> (Color, Color) {
    if disabled {
        let muted = t.color("text-muted");
        return (muted, muted);
    }
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let rest = effective_backgrounds(card_fill, base);
    if selected {
        let label = contrasting_color(t, &["text-primary", "text-secondary"], &rest, 4.5);
        let desc = contrasting_color(t, &["text-secondary", "text-primary"], &rest, 4.5);
        (label, desc)
    } else {
        let hover = effective_backgrounds(hover_fill, base);
        let backgrounds = [rest[0], rest[1], hover[0], hover[1]];
        let label = contrasting_color(t, &["text-primary", "text-secondary"], &backgrounds, 4.5);
        let desc = contrasting_color(t, &["text-secondary", "text-primary"], &backgrounds, 4.5);
        (label, desc)
    }
}

fn unchecked_indicator_colors(t: &Tokens, card_fill: Color, hover_fill: Color) -> (Color, Color) {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let raw_fill = t.color("surface-field");
    let rest = effective_backgrounds(card_fill, base);
    let hover = effective_backgrounds(hover_fill, base);
    let card_bgs = [rest[0], rest[1], hover[0], hover[1]];
    let fill = composite_over(raw_fill, &card_bgs);
    let candidates = [
        "border-base",
        "text-muted",
        "text-secondary",
        "text-primary",
        "accent-primary",
    ];
    let mut all = Vec::with_capacity(fill.len() + card_bgs.len());
    all.extend_from_slice(&fill);
    all.extend_from_slice(&card_bgs);
    if let Some(border) = try_contrasting_color(t, &candidates, &all, 3.0) {
        return (raw_fill, border);
    }
    // Keep the fallback fill transparent so translucent card fills are never painted twice.
    (
        Color::TRANSPARENT,
        contrasting_color(t, &candidates, &card_bgs, 3.0),
    )
}

fn checked_radio_colors(t: &Tokens, card_fill: Color) -> (Color, Color, Color) {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let raw_fill = t.color("surface-field");
    let rest = effective_backgrounds(card_fill, base);
    let candidates = [
        "accent-primary",
        "focus-ring-color",
        "text-primary",
        "text-secondary",
    ];
    let fill_bgs = composite_over(raw_fill, &rest);
    let mut border_bgs = Vec::with_capacity(fill_bgs.len() + rest.len());
    border_bgs.extend_from_slice(&fill_bgs);
    border_bgs.extend_from_slice(&rest);
    let (indicator_fill, indicator_border) =
        if let Some(border) = try_contrasting_color(t, &candidates, &border_bgs, 3.0) {
            (raw_fill, border)
        } else {
            (
                Color::TRANSPARENT,
                contrasting_color(t, &candidates, &rest, 3.0),
            )
        };
    let active_fill_bgs = composite_over(indicator_fill, &rest);
    let mark = contrasting_color(t, &candidates, &active_fill_bgs, 3.0);
    (indicator_fill, indicator_border, mark)
}

fn checked_checkbox_colors(t: &Tokens, card_fill: Color) -> (Color, Color, Color) {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let accent = t.color("accent-primary");
    let rest = effective_backgrounds(card_fill, base);
    let accent_bgs = composite_over(accent, &rest);
    let border_candidates = [
        "accent-primary",
        "focus-ring-color",
        "text-primary",
        "text-secondary",
    ];
    let mut accent_and_rest = Vec::with_capacity(accent_bgs.len() + rest.len());
    accent_and_rest.extend_from_slice(&accent_bgs);
    accent_and_rest.extend_from_slice(&rest);
    let (indicator_fill, indicator_border) = if worst_contrast(accent, &rest) >= 3.0 {
        (accent, accent)
    } else if let Some(border) = try_contrasting_color(t, &border_candidates, &accent_and_rest, 3.0)
    {
        (accent, border)
    } else {
        // Transparent fallback avoids painting a translucent selected card fill twice underneath
        // the checkmark.
        (
            Color::TRANSPARENT,
            contrasting_color(t, &border_candidates, &rest, 3.0),
        )
    };
    let active_fill_bgs = composite_over(indicator_fill, &rest);
    let mark = contrasting_color(
        t,
        &["text-on-accent", "text-primary", "surface-field"],
        &active_fill_bgs,
        3.0,
    );
    (indicator_fill, indicator_border, mark)
}

fn card_focus_ring_color(t: &Tokens, selected: bool, card_fill: Color, hover_fill: Color) -> Color {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let rest = effective_backgrounds(card_fill, base);
    let candidates = [
        "focus-ring-color",
        "accent-primary",
        "text-primary",
        "text-secondary",
    ];
    if selected {
        contrasting_color(t, &candidates, &rest, 3.0)
    } else {
        let hover = effective_backgrounds(hover_fill, base);
        let backgrounds = [rest[0], rest[1], hover[0], hover[1]];
        contrasting_color(t, &candidates, &backgrounds, 3.0)
    }
}

fn surface_text_color(t: &Tokens, candidates: &[&str]) -> Color {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    contrasting_color(t, candidates, &[base], 4.5)
}

pub const FORM_FOCUS_ANCHOR: &str = "form-header";

pub fn form_title(title: &str) -> El {
    let t = tokens(layout::dark());
    text(title)
        .color(surface_text_color(t, &["text-primary", "text-secondary"]))
        .wrap_anywhere()
}

pub fn form_header(eyebrow: &str, title: &str, required: bool) -> El {
    let t = tokens(layout::dark());
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let focus_color = contrasting_color(
        t,
        &[
            "focus-ring-color",
            "accent-primary",
            "text-primary",
            "text-secondary",
        ],
        &[base],
        3.0,
    );
    let eyebrow_color = surface_text_color(t, &["text-secondary", "text-primary"]);
    let label = if title.trim().is_empty() {
        eyebrow
    } else {
        title.trim()
    };
    let title_el = if required {
        let marker_color =
            surface_text_color(t, &["status-error", "accent-primary", "text-primary"]);
        row()
            .w_full()
            .gap(t.space(Space::Xxs).px())
            .items_start()
            .child(form_title(title).key("form-title").shrink().min_w(0.0))
            .child(
                text("*")
                    .key("required-marker")
                    .color(marker_color)
                    .a11y_hidden(),
            )
    } else {
        form_title(title).key("form-title")
    };
    col()
        .key(FORM_FOCUS_ANCHOR)
        .w_full()
        .gap(t.space(Space::Xs).px())
        .label(label)
        .focusable(true)
        .keyboard_focus_only()
        .tab_index(-1)
        .focus_ring(2.0, -2.0, focus_color)
        .focus_ring_radius(0.0)
        .child(
            text(eyebrow)
                .key("form-eyebrow")
                .color(eyebrow_color)
                .wrap_anywhere(),
        )
        .child(title_el)
}

pub fn form_error(message: &str) -> El {
    let t = tokens(layout::dark());
    text(message)
        .key("form-unsupported")
        .role("alert")
        .text_role(TextRole::Label)
        .color(surface_text_color(
            t,
            &["status-error", "text-primary", "text-secondary"],
        ))
        .wrap_anywhere()
}

pub fn clear_choice_button<S: 'static>(
    key: &str,
    text_label: &str,
    accessible_label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let fill = card_fill(t, false, disabled);
    let mut hover = card_hover_fill(t, fill);
    let border = if disabled {
        t.color("border-muted")
    } else {
        let rest = effective_backgrounds(fill, base);
        let hover_bgs = effective_backgrounds(hover, base);
        let rest_visible = worst_contrast(fill, &[base]) >= 3.0;
        let hover_visible = worst_contrast(hover, &[base]) >= 3.0;
        let candidates = [
            "border-base",
            "border-strong",
            "text-secondary",
            "text-primary",
        ];
        if rest_visible && hover_visible {
            t.color("border-base")
        } else {
            let mut boundary_bgs = vec![base];
            if !rest_visible {
                boundary_bgs.extend_from_slice(&rest);
            }
            if !hover_visible {
                boundary_bgs.extend_from_slice(&hover_bgs);
            }
            if let Some(color) = try_contrasting_color(t, &candidates, &boundary_bgs, 3.0) {
                color
            } else {
                hover = fill;
                contrasting_color(t, &candidates, &[base, rest[0], rest[1]], 3.0)
            }
        }
    };
    let focus_color = card_focus_ring_color(t, false, fill, hover);
    let (label_color, _) = card_text_colors(t, false, disabled, fill, hover);
    let mut button = row()
        .key(key.to_string())
        .role("button")
        .label(accessible_label)
        .focusable(!disabled)
        .disabled(disabled)
        .focus_return(FORM_FOCUS_ANCHOR)
        .min_h(t.metric("button", "minHeight").px())
        .px(t.space(Space::Md).px())
        .py(t.space(Space::Xs).px())
        .center()
        .radius(0.0)
        .fill(fill)
        .border(1.0, border)
        .focus_ring(2.0, -4.0, focus_color)
        .focus_ring_radius(0.0)
        .child(
            text(text_label)
                .key("label")
                .text_role(TextRole::Button)
                .color(label_color)
                .a11y_hidden(),
        );
    if !disabled {
        let action = std::rc::Rc::new(press);
        let click = action.clone();
        button = button
            .hover(hover)
            .on_press_tx(move |s, tx| click(s, tx))
            .on_key(layout::enter_action(action));
    }
    button
}

pub fn field_heading(title: &str, required: bool) -> El {
    let t = tokens(layout::dark());
    let title_color = surface_text_color(t, &["text-primary", "text-secondary"]);
    if !required {
        return text(title)
            .text_role(TextRole::Label)
            .color(title_color)
            .wrap_anywhere();
    }
    let marker_color = surface_text_color(t, &["status-error", "accent-primary", "text-primary"]);
    row()
        .w_full()
        .gap(t.space(Space::Xxs).px())
        .items_start()
        .child(
            text(title)
                .key("heading-text")
                .shrink()
                .min_w(0.0)
                .text_role(TextRole::Label)
                .color(title_color)
                .wrap_anywhere(),
        )
        .child(
            text("*")
                .key("required-marker")
                .text_role(TextRole::Label)
                .color(marker_color)
                .a11y_hidden(),
        )
}

pub fn field_description(description: &str) -> El {
    let t = tokens(layout::dark());
    text(description)
        .text_role(TextRole::Small)
        .color(surface_text_color(t, &["text-secondary", "text-primary"]))
        .wrap_anywhere()
}

pub fn radio_group(
    key: &str,
    label: &str,
    description: Option<&str>,
    horizontal: bool,
    required: bool,
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
    .required(required)
    .focus_group();
    if let Some(desc) = non_empty(description) {
        group = group.description(desc);
    }
    group.children(items)
}

fn option_copy(label: &str, desc: Option<&str>, label_color: Color, desc_color: Color) -> El {
    let t = tokens(layout::dark());
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
    let card_fill = card_fill(t, selected, disabled);
    let hover_fill = card_hover_fill(t, card_fill);
    let card_border = if disabled {
        t.color("border-muted")
    } else if selected {
        t.color("accent-primary")
    } else {
        t.color("border-base")
    };
    let focus_color = card_focus_ring_color(t, selected, card_fill, hover_fill);
    let (label_color, desc_color) = card_text_colors(t, selected, disabled, card_fill, hover_fill);
    let mut item = row()
        .key(key.to_string())
        .role(role)
        .label(label)
        .checked(selected)
        .focusable(!disabled)
        .disabled(disabled)
        .focus_return(FORM_FOCUS_ANCHOR)
        .min_h(t.metric("button", "minHeight").px())
        .padding(t.space(Space::Sm).px())
        .gap(t.space(Space::Sm).px())
        .radius(0.0)
        .fill(card_fill)
        .border(1.0, card_border)
        .focus_ring(2.0, -4.0, focus_color)
        .focus_ring_radius(0.0)
        .child(indicator)
        .child(option_copy(label, desc, label_color, desc_color));
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
        item = item.hover(hover_fill);
    }
    if !disabled {
        let action = std::rc::Rc::new(press);
        let click = action.clone();
        let key_action = std::rc::Rc::new(move |s: &mut S, _: &mut rune::Tx| action(s));
        item = item
            .on_press(move |s: &mut S| click(s))
            .on_key(layout::enter_action(key_action));
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
    let card_fill = card_fill(t, selected, disabled);
    let hover_fill = card_hover_fill(t, card_fill);
    let (indicator_fill, indicator_border, mark_color) = if disabled {
        (
            t.color("surface-control"),
            t.color("border-muted"),
            t.color("text-muted"),
        )
    } else if selected {
        checked_radio_colors(t, card_fill)
    } else {
        let (fill, border) = unchecked_indicator_colors(t, card_fill, hover_fill);
        (fill, border, border)
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

pub fn checkbox_group(
    key: &str,
    label: &str,
    description: Option<&str>,
    required: bool,
    items: Vec<El>,
) -> El {
    let t = tokens(layout::dark());
    let mut group = col()
        .key(key.to_string())
        .w_full()
        .gap(t.space(Space::Xs).px())
        .role("group")
        .label(label)
        .required(required);
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
    let card_fill = card_fill(t, checked, disabled);
    let hover_fill = card_hover_fill(t, card_fill);
    let (indicator_fill, indicator_border, mark_color) = if disabled {
        (
            t.color("surface-control"),
            t.color("border-muted"),
            t.color("text-muted"),
        )
    } else if checked {
        checked_checkbox_colors(t, card_fill)
    } else {
        let (fill, border) = unchecked_indicator_colors(t, card_fill, hover_fill);
        (fill, border, t.color("text-on-accent"))
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
#[path = "form_controls_tests.rs"]
mod tests;
