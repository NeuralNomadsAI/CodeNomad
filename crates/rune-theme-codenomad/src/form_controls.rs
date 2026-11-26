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

fn contrasting_color(
    t: &Tokens,
    candidates: &[&str],
    backgrounds: &[Color],
    min_ratio: f64,
) -> Color {
    for &token in candidates {
        let candidate = t.color(token);
        if worst_contrast(candidate, backgrounds) >= min_ratio {
            return candidate;
        }
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

fn unchecked_indicator_border(t: &Tokens, indicator_fill: Color, card_fill: Color) -> Color {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let fill = effective_backgrounds(indicator_fill, base);
    let rest = effective_backgrounds(card_fill, base);
    let hover = effective_backgrounds(t.color("surface-hover"), base);
    let backgrounds = [fill[0], fill[1], rest[0], rest[1], hover[0], hover[1]];
    contrasting_color(
        t,
        &[
            "border-base",
            "text-muted",
            "text-secondary",
            "text-primary",
            "accent-primary",
        ],
        &backgrounds,
        3.0,
    )
}

fn card_focus_ring_color(t: &Tokens, selected: bool, card_fill: Color) -> Color {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let rest = effective_backgrounds(card_fill, base);
    if selected {
        contrasting_color(
            t,
            &[
                "focus-ring-color",
                "accent-primary",
                "text-primary",
                "text-secondary",
            ],
            &rest,
            3.0,
        )
    } else {
        let hover = effective_backgrounds(t.color("surface-hover"), base);
        let backgrounds = [rest[0], rest[1], hover[0], hover[1]];
        contrasting_color(
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
    }
}

pub fn form_title(title: &str) -> El {
    text(title).wrap_anywhere()
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
    let focus_color = card_focus_ring_color(t, selected, card_fill);
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
        unchecked_indicator_border(t, indicator_fill, card_fill)
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
            unchecked_indicator_border(t, fill, card_fill),
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
#[path = "form_controls_tests.rs"]
mod tests;
