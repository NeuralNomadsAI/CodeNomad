use super::*;
use rune::{TextEdit, Tx};
use rune_kit::{ButtonVariant, IconButton, IconButtonVariant, TextArea};
use std::sync::OnceLock;

mod anchor;
pub use anchor::{LineAnchor, SourceLayout};

// Rune's TextArea keeps the multiline editor; a full-width scroll surface determines wrap.
pub fn metrics(dark: bool) -> rune_kit::TextAreaMetrics {
    code_kit(dark)
        .metrics
        .text_area
        .expect("code_kit defines text_area metrics")
}
fn drawing_width(dark: bool, text: &str, viewport_width: f32) -> f32 {
    let m = metrics(dark);
    let lines = text.as_bytes().iter().filter(|&&c| c == b'\n').count() + 1;
    (source_width(dark, viewport_width)
        - gutter_width(m.style, lines)
        - tokens(dark).space(Space::Lg).px()
        + m.padding)
        .max(0.0)
}
pub fn field(
    dark: bool,
    path: &str,
    edit: &TextEdit,
    label: &str,
    wrap: bool,
    viewport_width: Option<f32>,
) -> TextArea {
    let m = metrics(dark);
    let viewport_width = viewport_width.map(|width| drawing_width(dark, &edit.text, width));
    let available = if wrap {
        viewport_width
    } else {
        let span = edit
            .text
            .split('\n')
            .map(|line| rune::text::advance(line, m.style))
            .fold(0.0, f32::max);
        Some((span.ceil() + 2.0 * m.padding + 1.0).max(viewport_width.unwrap_or_default()))
    };
    TextArea::new(edit)
        .label(label)
        .width(available)
        .spellcheck(false)
        .wrap_anywhere()
        .spans(source_spans(dark, path, &edit.text))
}

pub fn editor_view(
    dark: bool,
    field: El,
    text: &str,
    wrap: bool,
    viewport_width: Option<f32>,
    anchor_watch: El,
) -> El {
    // The gutter's wrap width excludes the TextArea's inner chrome; its logical lines
    // use the same line spacing as the editor.
    let width = if wrap {
        viewport_width.map(|width| source_width(dark, width))
    } else {
        None
    };
    let m = metrics(dark);
    source_view(
        dark,
        rune::row()
            .w_full()
            .literal_direction()
            .child(gutter_style(dark, text, width, m.style, m.padding).pt(m.padding))
            .child(field)
            .child(anchor_watch.pin(Some(0.0), Some(0.0), None, None)),
        wrap,
    )
}

pub(crate) fn build_code_kit(
    dark: bool,
    base: &rune_kit::Kit,
    inset_bg: rune::Color,
) -> rune_kit::Kit {
    let mut kit = base.clone();
    let style = source_font(dark);
    kit.ty.ui = style;
    kit.c.bg_base = inset_bg;
    kit.metrics.text_area = Some(rune_kit::TextAreaMetrics {
        style,
        padding: tokens(dark).space(Space::Sm).px(),
    });
    kit
}

pub fn code_kit(dark: bool) -> crate::KitRef {
    if let Some(palette) = crate::palettes::active(dark) {
        return match palette {
            crate::palettes::ResolvedPalette::BuiltIn(palette) => {
                crate::KitRef::static_kit(palette.code.get_or_init(|| {
                    build_code_kit(dark, &kit(dark), tokens(dark).color("surface-inset"))
                }))
            }
            crate::palettes::ResolvedPalette::Custom(palette) => {
                crate::KitRef::dynamic(palette, crate::kit::DynamicKit::Code)
            }
        };
    }
    static KITS: [OnceLock<rune_kit::Kit>; 4] = [const { OnceLock::new() }; 4];
    crate::KitRef::static_kit(
        KITS[crate::palette_index(dark)]
            .get_or_init(|| build_code_kit(dark, &kit(dark), tokens(dark).color("surface-inset"))),
    )
}

const SAVE: rune::Icon = rune::Icon {
    name: "lucide-save",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7"/></g>"#,
};

pub fn save<S: 'static>(
    dark: bool,
    label: &str,
    shortcut: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let button = IconButton::new(&SAVE)
        .variant(IconButtonVariant::Neutral)
        .label(label)
        .help(label)
        .disabled(disabled)
        .on_press_tx(press);
    let button = if shortcut.is_empty() {
        button
    } else {
        button.shortcut(shortcut)
    };
    button.build(&kit(dark))
}

pub fn confirmation<S: 'static>(
    dark: bool,
    message: &str,
    cancel: &str,
    confirm: &str,
    decide: impl Fn(&mut S, bool, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark);
    let decide = std::rc::Rc::new(decide);
    let cancel = rune_kit::Button::new(cancel)
        .on_press_tx({
            let decide = decide.clone();
            move |s, tx| decide(s, false, tx)
        })
        .build(&kit(dark))
        .key("file-decision-cancel")
        .autofocus();
    let confirm = rune_kit::Button::new(confirm)
        .variant(ButtonVariant::Submit)
        .on_press_tx({
            let decide = decide.clone();
            move |s, tx| decide(s, true, tx)
        })
        .build(&kit(dark))
        .key("file-decision-confirm");
    let enter = decide.clone();
    let card = rune::col()
        .w_full()
        .max_w(t.length(Length::TouchTarget).px() * 10.0)
        .pad(Space::Lg)
        .separate(Space::Md)
        .role("alertdialog")
        .label(message)
        .fill(t.color("surface-overlay"))
        .child(rune::text(message).wrap())
        .child(
            rune::row()
                .w_full()
                .justify_end()
                .gap(t.space(Space::Sm).px())
                .child(cancel)
                .child(confirm),
        )
        .on_key(move |s: &mut S, key, tx| {
            if key.key != rune::Key::Enter || key.mods != rune::Mods::default() {
                return false;
            }
            if !tx.key_repeat() {
                enter(s, tx.focused() == Some("file-decision-confirm"), tx);
            }
            true
        })
        .modal_tx(true, move |s, tx| decide(s, false, tx));
    rune::col()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .center()
        .fill(t.color("overlay-scrim"))
        .child(card)
}

#[cfg(test)]
mod code_kit_tests {
    use super::*;
    use crate::palettes::{
        ColorField, built_in, custom, increased_contrast, with_palette, with_resolved,
    };

    #[test]
    fn code_kit_tracks_active_built_in_contrast_and_custom_palettes() {
        let dark_palettes: Vec<_> = built_in().iter().filter(|p| p.dark).collect();
        let first = dark_palettes[0];
        let second = dark_palettes
            .iter()
            .copied()
            .find(|p| p.id != first.id)
            .expect("multiple dark built-in palettes");
        let contrast = increased_contrast(Some(first), true).expect("high-contrast variant");

        let (first_bg, first_fg) = with_palette(Some(first), || {
            let k = code_kit(true);
            assert!(k.metrics.text_area.is_some());
            (k.c.bg_base, k.c.text_base)
        });
        let (second_bg, second_fg) = with_palette(Some(second), || {
            let k = code_kit(true);
            (k.c.bg_base, k.c.text_base)
        });
        let (contrast_bg, contrast_fg) = with_palette(Some(contrast), || {
            let k = code_kit(true);
            (k.c.bg_base, k.c.text_base)
        });
        assert!(
            first_bg != second_bg || first_fg != second_fg,
            "switching built-in dark palettes must update code_kit colors"
        );
        assert!(
            first_bg != contrast_bg || first_fg != contrast_fg,
            "high contrast must update code_kit colors"
        );

        let base_colors = first.colors();
        let edited_colors = base_colors
            .with(ColorField::SurfaceBase, "#102820")
            .and_then(|c| c.with(ColorField::TextPrimary, "#F5E6C8"))
            .expect("valid custom colors");
        let custom_a = custom(Some("custom-a"), true, false, base_colors);
        let custom_b = custom(Some("custom-a"), true, false, edited_colors);
        let (a_bg, a_fg) = with_resolved(Some(custom_a), || {
            let k = code_kit(true);
            assert!(k.metrics.text_area.is_some());
            (k.c.bg_base, k.c.text_base)
        });
        let (b_bg, b_fg) = with_resolved(Some(custom_b), || {
            let k = code_kit(true);
            (k.c.bg_base, k.c.text_base)
        });
        assert_ne!(a_bg, b_bg, "custom palette background must update code_kit");
        assert_ne!(a_fg, b_fg, "custom palette foreground must update code_kit");
    }
}
