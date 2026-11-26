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

fn card_hover_fill(t: &Tokens, card_fill: Color) -> Color {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let rest = effective_backgrounds(card_fill, base);
    let raw_hover = t.color("surface-hover");
    let hover = effective_backgrounds(raw_hover, base);
    let backgrounds = [rest[0], rest[1], hover[0], hover[1]];
    if try_contrasting_color(
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
    .is_some()
    {
        raw_hover
    } else {
        card_fill
    }
}

fn unchecked_indicator_colors(t: &Tokens, card_fill: Color, hover_fill: Color) -> (Color, Color) {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let raw_fill = t.color("surface-field");
    let fill = effective_backgrounds(raw_fill, base);
    let rest = effective_backgrounds(card_fill, base);
    let hover = effective_backgrounds(hover_fill, base);
    let candidates = [
        "border-base",
        "text-muted",
        "text-secondary",
        "text-primary",
        "accent-primary",
    ];
    let all = [fill[0], fill[1], rest[0], rest[1], hover[0], hover[1]];
    if let Some(border) = try_contrasting_color(t, &candidates, &all, 3.0) {
        return (raw_fill, border);
    }
    // When surface-field and card surfaces span incompatible luminances (e.g. black field on
    // mid-grey resting / white hover card), align indicator fill with the card so one border
    // achieves >= 3:1 against indicator fill, rest card, and hover card.
    let card_bgs = [rest[0], rest[1], hover[0], hover[1]];
    (card_fill, contrasting_color(t, &candidates, &card_bgs, 3.0))
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
    let fill_bgs = effective_backgrounds(raw_fill, base);
    let (indicator_fill, indicator_border) = if let Some(border) = try_contrasting_color(
        t,
        &candidates,
        &[fill_bgs[0], fill_bgs[1], rest[0], rest[1]],
        3.0,
    ) {
        (raw_fill, border)
    } else {
        (card_fill, contrasting_color(t, &candidates, &rest, 3.0))
    };
    let active_fill_bgs = effective_backgrounds(indicator_fill, base);
    let mark = contrasting_color(t, &candidates, &active_fill_bgs, 3.0);
    (indicator_fill, indicator_border, mark)
}

fn checked_checkbox_colors(t: &Tokens, card_fill: Color) -> (Color, Color, Color) {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let accent = t.color("accent-primary");
    let rest = effective_backgrounds(card_fill, base);
    let accent_bgs = effective_backgrounds(accent, base);
    let border_candidates = [
        "accent-primary",
        "focus-ring-color",
        "text-primary",
        "text-secondary",
    ];
    let (indicator_fill, indicator_border) = if worst_contrast(accent, &rest) >= 3.0 {
        (accent, accent)
    } else if let Some(border) = try_contrasting_color(
        t,
        &border_candidates,
        &[accent_bgs[0], accent_bgs[1], rest[0], rest[1]],
        3.0,
    ) {
        (accent, border)
    } else {
        (
            card_fill,
            contrasting_color(t, &border_candidates, &rest, 3.0),
        )
    };
    let active_fill_bgs = effective_backgrounds(indicator_fill, base);
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

pub const FORM_FOCUS_ANCHOR: &str = "form-header";

pub fn form_title(title: &str) -> El {
    text(title).wrap_anywhere()
}

pub fn form_header(eyebrow: &str, title: &str) -> El {
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
    let label = if title.trim().is_empty() {
        eyebrow
    } else {
        title.trim()
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
        .child(text(eyebrow).wrap_anywhere())
        .child(form_title(title).key("form-title"))
}

pub fn clear_choice_button<S: 'static>(
    key: &str,
    text_label: &str,
    accessible_label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    layout::button_tx(text_label, disabled, press)
        .key(key.to_string())
        .label(accessible_label)
        .focus_return(FORM_FOCUS_ANCHOR)
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
    let hover_fill = card_hover_fill(t, card_fill);
    let card_border = if disabled {
        t.color("border-muted")
    } else if selected {
        t.color("accent-primary")
    } else {
        t.color("border-base")
    };
    let focus_color = card_focus_ring_color(t, selected, card_fill, hover_fill);
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
        item = item.hover(hover_fill);
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
    let card_fill = if selected && !disabled {
        t.color("menu-item-selected-bg")
    } else {
        t.color("surface-control")
    };
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
    let card_fill = if checked && !disabled {
        t.color("menu-item-selected-bg")
    } else {
        t.color("surface-control")
    };
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
