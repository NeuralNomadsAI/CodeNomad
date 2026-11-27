use crate::{
    Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{El, KeyEvent, Tx, col, row, text};
use std::rc::Rc;

pub const TRIGGER: &str = "rename-project-tab";
pub const DIALOG: &str = "tab-rename-dialog";

pub fn trigger<S: 'static>(
    label: &'static str,
    help: String,
    open: bool,
    touch: bool,
    invoke: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let invoke = Rc::new(invoke);
    let press = invoke.clone();
    super::control(&super::icons::PENCIL, label, touch)
        .label(label)
        .help(help)
        .expanded(open)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(&kit(layout::dark()))
        .on_key(layout::enter_action(invoke))
        .key(TRIGGER)
}

#[allow(clippy::too_many_arguments)]
pub fn dialog<S: 'static>(
    title: &str,
    field_label: &str,
    input: El,
    close_control: El,
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
    let width = (vw - inset * 2.0).clamp(0.0, 420.0);
    let left = ((vw - width) / 2.0).max(inset);
    let top = (vh * 0.16).clamp(inset, 128.0);
    let on_cancel = Rc::new(on_cancel);
    let cancel_btn_action = on_cancel.clone();
    let dismiss_action = on_cancel;
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
    let on_confirm = Rc::new(on_confirm);
    let confirm_press = on_confirm.clone();
    let confirm_btn = rune_kit::Button::new(confirm_label)
        .variant(rune_kit::ButtonVariant::Submit)
        .on_press_tx(move |s, tx| confirm_press(s, tx))
        .build(&kit(layout::dark()))
        .on_key(layout::enter_action(on_confirm))
        .key("tab-rename-confirm");
    let body = col()
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .child(
            text(field_label)
                .text_role(TextRole::Small)
                .color(t.color("text-secondary")),
        )
        .child(input)
        .child(
            row()
                .full_width()
                .justify_end()
                .separate(Space::Sm)
                .child(
                    layout::button_tx(cancel_label, false, move |s, tx| cancel_btn_action(s, tx))
                        .key("tab-rename-cancel"),
                )
                .child(confirm_btn),
        );
    col()
        .key(DIALOG)
        .role("dialog")
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
