use super::*;
use rune::{TextEdit, Tx};
use rune_kit::{ButtonVariant, IconButton, IconButtonVariant, TextArea};
use std::sync::OnceLock;

// Rune's TextArea keeps the multiline editor; a full-width scroll surface determines wrap.
pub fn field(dark: bool, path: &str, edit: &TextEdit, label: &str, wrap: bool) -> TextArea {
    let available = if wrap {
        None
    } else {
        let style = code_kit(dark).ty.ui;
        let span = edit
            .text
            .split('\n')
            .map(|line| rune::text::advance(line, style))
            .fold(0.0, f32::max);
        // TextArea owns 8 points of inset on each side at this Rune pin.
        Some(span.ceil() + 16.0 + 1.0)
    };
    TextArea::new(edit)
        .label(label)
        .width(available)
        .spellcheck(false)
        .spans(source_spans(dark, path, &edit.text))
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
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    IconButton::new(&SAVE)
        .variant(IconButtonVariant::Neutral)
        .label(label)
        .shortcut("ctrl+s")
        .disabled(disabled)
        .on_press_tx(press)
        .build(kit(dark))
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
        .build(kit(dark))
        .key("file-decision-cancel");
    let confirm = rune_kit::Button::new(confirm)
        .variant(ButtonVariant::Submit)
        .on_press_tx({
            let decide = decide.clone();
            move |s, tx| decide(s, true, tx)
        })
        .build(kit(dark))
        .key("file-decision-confirm");
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
        .modal_tx(true, move |s, tx| decide(s, false, tx));
    rune::col()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .center()
        .fill(t.color("overlay-scrim"))
        .child(card)
}
