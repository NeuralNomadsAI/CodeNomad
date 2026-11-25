use super::*;
use rune::{TextEdit, Tx};
use rune_kit::{ButtonVariant, IconButton, IconButtonVariant, TextArea};
use std::sync::OnceLock;

mod anchor;
pub use anchor::{LineAnchor, SourceLayout};

// Rune's TextArea keeps the multiline editor; a full-width scroll surface determines wrap.
// Pinned TextArea metrics in rune-kit/src/controls/text_input.rs.
const INSET: f32 = 8.0;
const LINE_HEIGHT: f32 = 17.5;
fn drawing_width(dark: bool, text: &str, viewport_width: f32) -> f32 {
    let style = code_kit(dark).ty.ui;
    let lines = text.as_bytes().iter().filter(|&&c| c == b'\n').count() + 1;
    (source_width(dark, viewport_width)
        - gutter_width(style, lines)
        - tokens(dark).space(Space::Lg).px()
        + INSET)
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
    let viewport_width = viewport_width.map(|width| drawing_width(dark, &edit.text, width));
    let available = if wrap {
        viewport_width
    } else {
        let style = code_kit(dark).ty.ui;
        let span = edit
            .text
            .split('\n')
            .map(|line| rune::text::advance(line, style))
            .fold(0.0, f32::max);
        // TextArea owns 8 points of inset on each side at this Rune pin.
        Some((span.ceil() + 2.0 * INSET + 1.0).max(viewport_width.unwrap_or_default()))
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
    let mut style = code_kit(dark).ty.ui;
    style.line_height = LINE_HEIGHT;
    source_view(
        dark,
        rune::row()
            .w_full()
            .literal_direction()
            .child(gutter_style(dark, text, width, style, INSET).pt(INSET))
            .child(field)
            .child(anchor_watch.pin(Some(0.0), Some(0.0), None, None)),
        wrap,
    )
}

pub fn code_kit(dark: bool) -> &'static rune_kit::Kit {
    static KITS: [OnceLock<rune_kit::Kit>; 4] = [const { OnceLock::new() }; 4];
    KITS[crate::palette_index(dark)].get_or_init(|| {
        let mut kit = kit(dark).clone();
        kit.ty.ui = source_font(dark);
        kit.c.bg_base = tokens(dark).color("surface-inset");
        kit
    })
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
    button.build(kit(dark))
}

pub fn confirmation<S: 'static>(
    dark: bool,
    message: &str,
    cancel: &str,
    confirm: &str,
    decide: impl Fn(&mut S, bool, &mut Tx) + 'static,
) -> El {
    confirmation_with_title(dark, None, message, cancel, confirm, decide)
}

pub fn confirmation_titled<S: 'static>(
    dark: bool,
    title: &str,
    message: &str,
    cancel: &str,
    confirm: &str,
    decide: impl Fn(&mut S, bool, &mut Tx) + 'static,
) -> El {
    confirmation_with_title(dark, Some(title), message, cancel, confirm, decide)
}

fn confirmation_with_title<S: 'static>(
    dark: bool,
    title: Option<&str>,
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
        .build(kit(dark))
        .key("file-decision-cancel")
        .autofocus();
    let confirm = rune_kit::Button::new(confirm)
        .variant(ButtonVariant::Submit)
        .on_press_tx({
            let decide = decide.clone();
            move |s, tx| decide(s, true, tx)
        })
        .build(kit(dark))
        .key("file-decision-confirm");
    let enter = decide.clone();
    let mut card = rune::col()
        .w_full()
        .max_w(t.length(Length::TouchTarget).px() * 10.0)
        .pad(Space::Lg)
        .separate(Space::Md)
        .role("alertdialog")
        .label(title.unwrap_or(message))
        .fill(t.color("surface-overlay"));
    if let Some(title) = title {
        card = card.child(rune::text(title).text_role(crate::TextRole::Title).wrap());
    }
    let card = card
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
