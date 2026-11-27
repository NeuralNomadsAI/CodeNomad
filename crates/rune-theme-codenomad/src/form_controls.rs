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
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let rest = effective_backgrounds(card_fill, base);
    if disabled {
        let muted = contrasting_color(
            t,
            &["text-muted", "text-secondary", "text-primary"],
            &rest,
            4.5,
        );
        return (muted, muted);
    }
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

fn disabled_indicator_colors(t: &Tokens, card_fill: Color) -> (Color, Color, Color) {
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let rest = effective_backgrounds(card_fill, base);
    let mut fill = t.color("surface-control");
    let mut ind_bgs = composite_over(fill, &rest);
    let border_candidates = [
        "border-muted",
        "border-strong",
        "text-muted",
        "text-secondary",
        "text-primary",
    ];
    let mut all_bgs = Vec::with_capacity(rest.len() + ind_bgs.len());
    all_bgs.extend_from_slice(&rest);
    all_bgs.extend_from_slice(&ind_bgs);
    let border = if let Some(color) = try_contrasting_color(t, &border_candidates, &all_bgs, 3.0) {
        color
    } else {
        fill = card_fill;
        ind_bgs = rest.to_vec();
        contrasting_color(t, &border_candidates, &rest, 3.0)
    };
    let mark = contrasting_color(
        t,
        &["text-muted", "text-secondary", "text-primary"],
        &ind_bgs,
        3.0,
    );
    (fill, border, mark)
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
    field_error("form-unsupported", message)
}

pub fn field_error(key: &str, message: &str) -> El {
    let t = tokens(layout::dark());
    text(message)
        .key(key.to_string())
        .role("alert")
        .text_role(TextRole::Label)
        .color(surface_text_color(
            t,
            &["status-error", "text-primary", "text-secondary"],
        ))
        .wrap_anywhere()
}

pub fn field_container(
    key: &str,
    label: &str,
    description: Option<&str>,
    as_group: bool,
    children: Vec<El>,
) -> El {
    let t = tokens(layout::dark());
    let mut container = col()
        .key(key.to_string())
        .w_full()
        .gap(t.space(Space::Xs).px());
    if as_group {
        container = container.role("group").label(label);
        if let Some(desc) = non_empty(description) {
            container = container.description(desc);
        }
    }
    container.children(children)
}

/// Hard ceiling on form editor text (in UTF-16 code units) enforced at the input boundary for
/// paste, IME, web replacement, and layout. Kept slightly above OpenCode's 20,000-unit protocol
/// validation ceiling so oversized pastes still trigger `TooLong { max: 20_000 }` instead of
/// silently truncating into a submittable answer.
pub const MAX_FORM_EDITOR_UTF16: usize = 20_480;

fn utf16_prefix_byte_len(s: &str, max_units: usize) -> usize {
    let mut units = 0usize;
    for (idx, ch) in s.char_indices() {
        let len = ch.len_utf16();
        if units + len > max_units {
            return idx;
        }
        units += len;
    }
    s.len()
}

/// Byte prefix of `s` whose post-`TextEdit::sanitize` (`\r\n` -> `\n`) UTF-16 length stays within
/// `max_units`, stopping before a `\r\n` pair if the `\n` itself would cross the limit.
fn utf16_normalized_paste_prefix_byte_len(s: &str, max_units: usize) -> usize {
    let mut units = 0usize;
    let mut chars = s.char_indices().peekable();
    while let Some((idx, ch)) = chars.next() {
        if ch == '\r' && chars.peek().is_some_and(|&(_, next)| next == '\n') {
            if units + 1 > max_units {
                return idx;
            }
            continue;
        }
        let len = ch.len_utf16();
        if units + len > max_units {
            return idx;
        }
        units += len;
    }
    s.len()
}

fn normalize_and_cap_utf16(s: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' && chars.peek() == Some(&'\n') {
            if units + 1 > max_units {
                break;
            }
            continue;
        }
        let len = ch.len_utf16();
        if units + len > max_units {
            break;
        }
        out.push(ch);
        units += len;
    }
    out
}

fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut end = idx.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn safe_edit_range(edit: &rune::TextEdit) -> (usize, usize) {
    let (a, b) = edit.range();
    let start = floor_char_boundary(&edit.text, a);
    let end = floor_char_boundary(&edit.text, b).max(start);
    (start, end)
}

fn edit_exceeds_form_cap(edit: &rune::TextEdit) -> bool {
    let preedit_len = edit.preedit().map_or(0, |(p, _)| p.len());
    if edit.text.len().saturating_add(preedit_len) <= MAX_FORM_EDITOR_UTF16 {
        return false;
    }
    if edit.text.len() > MAX_FORM_EDITOR_UTF16
        && utf16_prefix_byte_len(&edit.text, MAX_FORM_EDITOR_UTF16) < edit.text.len()
    {
        return true;
    }
    let Some((preedit, _)) = edit.preedit() else {
        return false;
    };
    let (sel_start, sel_end) = safe_edit_range(edit);
    let kept_utf16 =
        edit.text[..sel_start].encode_utf16().count() + edit.text[sel_end..].encode_utf16().count();
    let remaining = MAX_FORM_EDITOR_UTF16.saturating_sub(kept_utf16);
    utf16_prefix_byte_len(preedit, remaining) < preedit.len()
}

fn build_bounded_form_text_edit(edit: &rune::TextEdit, force_unfocus: bool) -> rune::TextEdit {
    let text_end = utf16_prefix_byte_len(&edit.text, MAX_FORM_EDITOR_UTF16);
    let focused = if force_unfocus { false } else { edit.focused };
    let anchor = floor_char_boundary(&edit.text[..text_end], edit.anchor.min(text_end));
    let focus = floor_char_boundary(&edit.text[..text_end], edit.focus.min(text_end));
    let mut bounded = rune::TextEdit::new(&edit.text[..text_end]);
    bounded.focused = focused;
    bounded.anchor = anchor;
    bounded.focus = focus;
    bounded.sync_invariants();
    if let Some((preedit, cursor)) = edit.preedit() {
        let (sel_start, sel_end) = safe_edit_range(&bounded);
        let kept_utf16 = bounded.text[..sel_start].encode_utf16().count()
            + bounded.text[sel_end..].encode_utf16().count();
        let remaining = MAX_FORM_EDITOR_UTF16.saturating_sub(kept_utf16);
        if remaining > 0 {
            if utf16_prefix_byte_len(preedit, remaining) == preedit.len() {
                bounded.ime(&rune::Ime::Preedit(
                    preedit.to_string(),
                    cursor,
                    edit.preedit_clauses(),
                ));
            } else {
                let clamped = normalize_and_cap_utf16(preedit, remaining);
                if !clamped.is_empty() {
                    let clamped_cursor = cursor.map(|(a, b)| {
                        let ca = floor_char_boundary(&clamped, a);
                        let cb = floor_char_boundary(&clamped, b);
                        (ca, cb)
                    });
                    bounded.ime(&rune::Ime::Preedit(clamped, clamped_cursor, Vec::new()));
                }
            }
        }
    }
    bounded
}

pub fn clamp_form_text_edit(edit: &mut rune::TextEdit) -> bool {
    if !edit_exceeds_form_cap(edit) {
        return false;
    }
    let text_exceeds = edit.text.len() > MAX_FORM_EDITOR_UTF16
        && utf16_prefix_byte_len(&edit.text, MAX_FORM_EDITOR_UTF16) < edit.text.len();
    if text_exceeds {
        *edit = build_bounded_form_text_edit(edit, false);
        return true;
    }
    let (sel_start, sel_end) = safe_edit_range(edit);
    let kept_utf16 =
        edit.text[..sel_start].encode_utf16().count() + edit.text[sel_end..].encode_utf16().count();
    let remaining = MAX_FORM_EDITOR_UTF16.saturating_sub(kept_utf16);
    let Some((clamped, clamped_cursor)) = edit.preedit().map(|(preedit, cursor)| {
        let clamped = normalize_and_cap_utf16(preedit, remaining);
        let clamped_cursor = cursor.map(|(a, b)| {
            let ca = floor_char_boundary(&clamped, a);
            let cb = floor_char_boundary(&clamped, b);
            (ca, cb)
        });
        (clamped, clamped_cursor)
    }) else {
        return false;
    };
    if clamped.is_empty() {
        edit.cancel_composition();
    } else {
        edit.ime(&rune::Ime::Preedit(clamped, clamped_cursor, Vec::new()));
    }
    true
}

#[allow(clippy::too_many_arguments)]
pub fn form_textarea<S: 'static>(
    key: &str,
    edit: &rune::TextEdit,
    label: &str,
    description: Option<&str>,
    disabled: bool,
    required: bool,
    invalid: bool,
    on_edit: impl Fn(&mut S) -> &mut rune::TextEdit + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let k = crate::field_kit(dark);
    let base = composite_linear(t.color("surface-overlay"), Color::BLACK);
    let raw_fill = t.color("surface-field");
    let raw_bgs = effective_backgrounds(raw_fill, base);
    let mut fill =
        if try_contrasting_color(t, &["text-primary", "text-secondary"], &raw_bgs, 4.5).is_some() {
            raw_fill
        } else {
            composite_srgb(raw_fill, base)
        };
    let mut fill_bgs = effective_backgrounds(fill, base);
    let border_candidates = [
        "border-base",
        "border-strong",
        "text-secondary",
        "text-primary",
    ];
    let border = if disabled {
        let disabled_candidates = [
            "border-muted",
            "border-base",
            "text-muted",
            "text-secondary",
            "text-primary",
        ];
        if worst_contrast(fill, &[base]) >= 3.0 {
            t.color("border-muted")
        } else if let Some(color) = try_contrasting_color(
            t,
            &disabled_candidates,
            &[base, fill_bgs[0], fill_bgs[1]],
            3.0,
        ) {
            color
        } else {
            fill = base;
            fill_bgs = effective_backgrounds(fill, base);
            contrasting_color(t, &disabled_candidates, &[base], 3.0)
        }
    } else if invalid {
        let err_candidates = ["status-error", "text-primary", "text-secondary"];
        if let Some(color) =
            try_contrasting_color(t, &err_candidates, &[base, fill_bgs[0], fill_bgs[1]], 3.0)
        {
            color
        } else {
            fill = base;
            fill_bgs = effective_backgrounds(fill, base);
            contrasting_color(t, &err_candidates, &[base], 3.0)
        }
    } else if worst_contrast(fill, &[base]) >= 3.0 {
        t.color("border-base")
    } else if let Some(color) = try_contrasting_color(
        t,
        &border_candidates,
        &[base, fill_bgs[0], fill_bgs[1]],
        3.0,
    ) {
        color
    } else {
        fill = base;
        fill_bgs = effective_backgrounds(fill, base);
        contrasting_color(t, &border_candidates, &[base], 3.0)
    };
    let ink = if disabled {
        contrasting_color(
            t,
            &["text-muted", "text-secondary", "text-primary"],
            &fill_bgs,
            4.5,
        )
    } else {
        contrasting_color(t, &["text-primary", "text-secondary"], &fill_bgs, 4.5)
    };
    let raw_sel = contrasting_color(
        t,
        &[
            "accent-primary",
            "focus-ring-color",
            "text-primary",
            "text-secondary",
        ],
        &[fill_bgs[0], fill_bgs[1]],
        3.0,
    );
    let sel_bg = composite_linear(raw_sel, fill_bgs[0]);
    let sel_ink = contrasting_color(
        t,
        &["text-on-accent", "text-primary", "surface-field"],
        &[sel_bg],
        4.5,
    );
    let focus_color = contrasting_color(
        t,
        &[
            "focus-ring-color",
            "accent-primary",
            "text-primary",
            "text-secondary",
        ],
        &[fill_bgs[0], fill_bgs[1]],
        3.0,
    );
    let metrics = k
        .metrics
        .text_area
        .unwrap_or_else(|| rune_kit::TextAreaMetrics::kit(&k));
    let mut bounded_edit;
    let needs_clamp = edit_exceeds_form_cap(edit);
    let shown_edit = if needs_clamp {
        bounded_edit = build_bounded_form_text_edit(edit, disabled);
        &bounded_edit
    } else if disabled && edit.focused {
        bounded_edit = edit.clone();
        bounded_edit.focused = false;
        &bounded_edit
    } else {
        edit
    };
    let mut input = rune::text_input(shown_edit, metrics.style)
        .key("input")
        .w_full()
        .color(ink)
        .caret(ink, sel_bg)
        .selection_style(
            rune::SelectionStyle::new(sel_bg)
                .ink(sel_ink)
                .inactive(sel_bg, Some(sel_ink)),
        )
        .label(label)
        .required(required)
        .invalid(invalid)
        .disabled(disabled);
    if let Some(desc) = non_empty(description) {
        input = input.description(desc);
    }
    if !disabled {
        let access = std::rc::Rc::new(on_edit);
        let edit_access = std::rc::Rc::clone(&access);
        let paste_access = std::rc::Rc::clone(&access);
        let change_access = std::rc::Rc::clone(&access);
        input = input
            .on_edit(move |s: &mut S| edit_access(s))
            .on_input_paste(move |s: &mut S, content, _| {
                let raw = content.text();
                if raw.is_empty() {
                    return false;
                }
                let edit = paste_access(s);
                clamp_form_text_edit(edit);
                let (sel_start, sel_end) = edit.range();
                let kept_utf16 = edit.text[..sel_start].encode_utf16().count()
                    + edit.text[sel_end..].encode_utf16().count();
                let remaining = MAX_FORM_EDITOR_UTF16.saturating_sub(kept_utf16);
                let prefix_len = utf16_normalized_paste_prefix_byte_len(raw, remaining);
                if prefix_len == raw.len() {
                    return false;
                }
                if prefix_len > 0 {
                    edit.paste(&raw[..prefix_len]);
                } else if sel_start != sel_end {
                    edit.insert("");
                }
                true
            })
            .on_input_change(move |s: &mut S, _| {
                clamp_form_text_edit(change_access(s));
            });
    }
    let viewport = rune::auto_grow(input, 1, 1);
    let mut box_el = col()
        .key(key.to_string())
        .w_full()
        .role("textbox")
        .padding(metrics.padding)
        .radius(0.0)
        .fill(fill)
        .border(1.0, border)
        .child(viewport);
    if !disabled && edit.focused {
        box_el = box_el.outline(2.0, -2.0, focus_color);
    }
    box_el
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
    let mut fill = card_fill(t, false, disabled);
    let mut hover = card_hover_fill(t, fill);
    let border = if disabled {
        let rest = effective_backgrounds(fill, base);
        let disabled_candidates = [
            "border-muted",
            "border-base",
            "text-muted",
            "text-secondary",
            "text-primary",
        ];
        if worst_contrast(fill, &[base]) >= 3.0 {
            t.color("border-muted")
        } else if let Some(color) =
            try_contrasting_color(t, &disabled_candidates, &[base, rest[0], rest[1]], 3.0)
        {
            color
        } else {
            fill = base;
            contrasting_color(t, &disabled_candidates, &[base], 3.0)
        }
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
            } else if !rest_visible {
                if let Some(color) =
                    try_contrasting_color(t, &candidates, &[base, rest[0], rest[1]], 3.0)
                {
                    hover = fill;
                    color
                } else {
                    // When the control surface sits in the 2.5-2.9:1 gap where neither the fill
                    // nor any single border reaches 3:1 against both dock and fill, match the
                    // dock surface so a single high-contrast border meets >= 3:1 cleanly.
                    fill = base;
                    hover = card_hover_fill(t, fill);
                    let next_hover_bgs = effective_backgrounds(hover, base);
                    let next_hover_visible = worst_contrast(hover, &[base]) >= 3.0;
                    if next_hover_visible {
                        contrasting_color(t, &candidates, &[base], 3.0)
                    } else if let Some(color) = try_contrasting_color(
                        t,
                        &candidates,
                        &[base, next_hover_bgs[0], next_hover_bgs[1]],
                        3.0,
                    ) {
                        color
                    } else {
                        hover = fill;
                        contrasting_color(t, &candidates, &[base], 3.0)
                    }
                }
            } else {
                hover = fill;
                t.color("border-base")
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
                .wrap_anywhere()
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
    invalid: bool,
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
    .invalid(invalid)
    .focus_group();
    if let Some(desc) = non_empty(description) {
        group = group.description(desc);
    }
    group.children(items)
}

pub const OPTION_DESCRIPTION_INITIAL_CHARS: usize = 240;
pub const OPTION_DESCRIPTION_REVEAL_STEP: usize = 2_000;

/// Return `(shown_text, hidden_chars, next_reveal_chars)` for an option description so long
/// authored explanations never force megabytes of eager text layout or accessibility duplication.
pub fn option_description_window(desc: &str, reveal_steps: usize) -> (String, usize, usize) {
    let limit = OPTION_DESCRIPTION_INITIAL_CHARS
        .saturating_add(reveal_steps.saturating_mul(OPTION_DESCRIPTION_REVEAL_STEP));
    let mut chars = desc.chars();
    let prefix: String = chars.by_ref().take(limit).collect();
    let hidden = chars.count();
    if hidden == 0 {
        (prefix, 0, 0)
    } else {
        (
            format!("{prefix}…"),
            hidden,
            hidden.min(OPTION_DESCRIPTION_REVEAL_STEP),
        )
    }
}

fn join_a11y_description(visible: Option<&str>, note: Option<&str>) -> Option<String> {
    match (non_empty(visible), non_empty(note)) {
        (Some(a), Some(b)) => Some(format!("{a} · {b}")),
        (Some(a), None) => Some(a.to_string()),
        (None, Some(b)) => Some(b.to_string()),
        (None, None) => None,
    }
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
    a11y_note: Option<&str>,
    selected: bool,
    disabled: bool,
    invalid: bool,
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
        .invalid(invalid)
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
    if let Some(d) = join_a11y_description(desc, a11y_note) {
        item = item.description(d);
    }
    if !disabled && !selected {
        item = item.hover(hover_fill);
    }
    if !disabled {
        let action = std::rc::Rc::new(press);
        let click = action.clone();
        let focus_key = key.to_string();
        let key_action = std::rc::Rc::new(move |s: &mut S, _: &mut rune::Tx| action(s));
        item = item
            .on_press_tx(move |s: &mut S, tx: &mut rune::Tx| {
                tx.focus(focus_key.clone(), tx.focus_visible());
                click(s);
            })
            .on_key(layout::enter_action(key_action));
    }
    item
}

#[allow(clippy::too_many_arguments)]
pub fn radio_option<S: 'static>(
    key: &str,
    label: &str,
    description: Option<&str>,
    a11y_note: Option<&str>,
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
        disabled_indicator_colors(t, card_fill)
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
        key, "radio", label, desc, a11y_note, selected, disabled, false, full_width, indicator,
        press,
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

#[allow(clippy::too_many_arguments)]
pub fn checkbox_option<S: 'static>(
    key: &str,
    label: &str,
    description: Option<&str>,
    a11y_note: Option<&str>,
    checked: bool,
    disabled: bool,
    invalid: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let k = kit(dark);
    let desc = non_empty(description);
    let card_fill = card_fill(t, checked, disabled);
    let hover_fill = card_hover_fill(t, card_fill);
    let (indicator_fill, indicator_border, mark_color) = if disabled {
        disabled_indicator_colors(t, card_fill)
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
        key, "checkbox", label, desc, a11y_note, checked, disabled, invalid, true, indicator,
        toggle,
    )
}

#[cfg(test)]
#[path = "form_controls_tests.rs"]
mod tests;
