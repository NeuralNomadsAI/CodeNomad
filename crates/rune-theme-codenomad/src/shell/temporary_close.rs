use crate::{
    Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{El, KeyEvent, Tx, col, row, text};
use std::rc::Rc;

pub const DIALOG: &str = "temporary-close-dialog";
pub const CLOSE: &str = "temporary-close-dismiss";
pub const CANCEL: &str = "temporary-close-cancel";
pub const KEEP: &str = "temporary-close-keep";
pub const DISCARD: &str = "temporary-close-discard";

#[allow(clippy::too_many_arguments)]
pub fn dialog<S: 'static>(
    title: &str,
    message: &str,
    close_control: El,
    cancel_label: &str,
    keep_label: &str,
    discard_label: &str,
    busy: bool,
    viewport: (f32, f32),
    on_key: impl Fn(&mut S, &KeyEvent, &mut Tx) -> bool + 'static,
    on_cancel: impl Fn(&mut S, &mut Tx) + 'static,
    on_keep: impl Fn(&mut S, &mut Tx) + 'static,
    on_discard: impl Fn(&mut S, &mut Tx) + 'static,
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
    let dismiss_action = on_cancel;
    let on_keep = Rc::new(on_keep);
    let keep_press = on_keep.clone();
    let on_discard = Rc::new(on_discard);
    let discard_press = on_discard.clone();
    let keep_btn = {
        let btn = rune_kit::Button::new(keep_label)
            .variant(rune_kit::ButtonVariant::Submit)
            .disabled(busy)
            .on_press_tx(move |s, tx| keep_press(s, tx))
            .build(&kit(layout::dark()))
            .key(KEEP);
        if busy {
            btn
        } else {
            btn.on_key(layout::enter_action(on_keep))
        }
    };
    let cancel_btn = layout::button_tx(cancel_label, busy, move |s, tx| cancel_press(s, tx))
        .key(CANCEL)
        .autofocus();
    let discard_btn = {
        let btn = rune_kit::Button::new(discard_label)
            .variant(rune_kit::ButtonVariant::Danger)
            .disabled(busy)
            .on_press_tx(move |s, tx| discard_press(s, tx))
            .build(&kit(layout::dark()))
            .key(DISCARD);
        if busy {
            btn
        } else {
            btn.on_key(layout::enter_action(on_discard))
        }
    };
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
        )
        .child(close_control);
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
            row()
                .full_width()
                .justify_end()
                .separate(Space::Sm)
                .child(cancel_btn)
                .child(discard_btn)
                .child(keep_btn),
        );
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
        .modal_tx(true, move |s, tx| dismiss_action(s, tx))
        .raise()
}
