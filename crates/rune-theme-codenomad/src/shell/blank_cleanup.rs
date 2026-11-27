use crate::{
    Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{El, KeyEvent, Tx, col, row, text};
use std::rc::Rc;

pub const DIALOG: &str = "blank-cleanup-dialog";
pub const CANCEL: &str = "blank-cleanup-cancel";
pub const CONFIRM: &str = "blank-cleanup-confirm";

#[allow(clippy::too_many_arguments)]
pub fn dialog<S: 'static>(
    title: &str,
    message: &str,
    detail: &str,
    cancel_label: &str,
    confirm_label: &str,
    viewport: (f32, f32),
    on_key: impl Fn(&mut S, &KeyEvent, &mut Tx) -> bool + 'static,
    on_cancel: impl Fn(&mut S, &mut Tx) + 'static,
    on_confirm: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let inset = t.space(Space::Md).px();
    let vw = if viewport.0 > 0.0 { viewport.0 } else { 1400.0 };
    let vh = if viewport.1 > 0.0 { viewport.1 } else { 900.0 };
    let width = (vw - inset * 2.0).clamp(0.0, 440.0);
    let left = ((vw - width) / 2.0).max(inset);
    let top = (vh * 0.16).clamp(inset, 128.0);
    let on_cancel = Rc::new(on_cancel);
    let cancel_press = on_cancel.clone();
    let on_confirm = Rc::new(on_confirm);
    let confirm_press = on_confirm.clone();
    let cancel_btn = layout::button_tx(cancel_label, false, move |s, tx| cancel_press(s, tx))
        .key(CANCEL)
        .autofocus();
    let confirm_btn = rune_kit::Button::new(confirm_label)
        .variant(rune_kit::ButtonVariant::Submit)
        .on_press_tx(move |s, tx| confirm_press(s, tx))
        .build(&kit(layout::dark()))
        .key(CONFIRM)
        .on_key(layout::enter_action(on_confirm));
    let header = row()
        .full_width()
        .center_y()
        .justify_between()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .child(
            text(title)
                .text_role(TextRole::Label)
                .color(t.color("text-primary"))
                .role("heading")
                .truncate(),
        );
    let body = col()
        .full_width()
        .pad(Space::Md)
        .separate(Space::Md)
        .child(
            text(message)
                .text_role(TextRole::Small)
                .color(t.color("text-secondary"))
                .wrap(),
        )
        .child(
            text(detail)
                .text_role(TextRole::Small)
                .color(t.color("text-secondary"))
                .wrap(),
        )
        .child(
            row()
                .full_width()
                .justify_end()
                .separate(Space::Sm)
                .child(cancel_btn)
                .child(confirm_btn),
        );
    // Solid opens deepConfirm with dismissible: false, so outside clicks stay inert.
    col()
        .key(DIALOG)
        .role("alertdialog")
        .label(title)
        .w(width)
        .fill(t.color("surface-overlay"))
        .border(1.0, t.color("border-base"))
        .child(header)
        .child(body)
        .pin(Some(left), Some(top), None, None)
        .on_key(on_key)
        .modal_tx(true, |_: &mut S, _: &mut Tx| {})
        .raise()
}
