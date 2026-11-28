//! Theme primitives for the Clone Git Repository modal opened from the Home launcher.
use crate::{
    Space, TextRole, kit,
    layout::{self, Layout, dark},
    tokens,
};
use rune::{El, KeyEvent, Tx, col, row, text};
use rune_kit::{Button, ButtonVariant, Checkbox};
use std::rc::Rc;

const DIALOG_WIDTH: f32 = 520.0;

pub fn field_section(label: &str, control: El) -> El {
    let t = tokens(dark());
    col()
        .full_width()
        .separate(Space::Xs)
        .child(
            text(label)
                .text_role(TextRole::Label)
                .color(t.color("text-secondary")),
        )
        .child(control)
}

pub fn cleanup_checkbox<S: 'static>(
    key: &str,
    label: &str,
    checked: bool,
    disabled: bool,
    on_toggle: impl Fn(&mut S) + 'static,
) -> El {
    Checkbox::new(checked)
        .label(label)
        .disabled(disabled)
        .on_toggle(on_toggle)
        .build(&kit(dark()))
        .key(key.to_owned())
}

pub fn secondary_button<S: 'static>(
    key: &str,
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let action = Rc::new(press);
    let on_press = action.clone();
    let btn = Button::new(label)
        .disabled(disabled)
        .on_press_tx(move |s, tx| on_press(s, tx))
        .build(&kit(dark()))
        .key(key.to_owned());
    if disabled {
        btn
    } else {
        btn.on_key(layout::enter_action(action))
    }
}

pub fn primary_button<S: 'static>(
    key: &str,
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let is_dark = dark();
    let t = tokens(is_dark);
    let mut theme = kit(is_dark).clone();
    let fill = t.color("accent-primary");
    let hover = t.color("accent-hover");
    let ink = t.color("text-on-accent");
    theme.c.bg_contrast = fill;
    theme.c.bg_accent = fill;
    theme.c.contrast_hover = hover;
    theme.c.contrast_pressed = hover;
    theme.c.submit_hover = hover;
    theme.c.submit_fg = ink;
    theme.c.submit_icon = ink;
    theme.c.text_contrast = ink;
    theme.c.icon_contrast = ink;
    let action = Rc::new(press);
    let on_press = action.clone();
    let btn = Button::new(label)
        .variant(ButtonVariant::Submit)
        .disabled(disabled)
        .on_press_tx(move |s, tx| on_press(s, tx))
        .build(&theme)
        .key(key.to_owned());
    if disabled {
        btn
    } else {
        btn.on_key(layout::enter_action(action))
    }
}

#[allow(clippy::too_many_arguments)]
pub fn modal<S: 'static>(
    key: &str,
    title: &str,
    close_label: &str,
    close_disabled: bool,
    repo_section: El,
    dest_section: El,
    cleanup: El,
    error: Option<El>,
    cancel: El,
    submit: El,
    on_key: impl Fn(&mut S, &KeyEvent, &mut Tx) -> bool + 'static,
    on_close: impl Fn(&mut S) + 'static,
    layer: &mut Vec<El>,
) {
    let on_close = Rc::new(on_close);
    let footer = row()
        .full_width()
        .justify_end()
        .separate(Space::Sm)
        .child(cancel)
        .child(submit);

    let mut body = col()
        .full_width()
        .pad(Space::Md)
        .separate(Space::Md)
        .on_key(on_key)
        .child(repo_section)
        .child(dest_section)
        .child(cleanup);
    if let Some(error) = error {
        body = body.child(error);
    }
    body = body.child(footer);

    layout::dialog(key, title, close_label)
        .open(true)
        .fit()
        .width(DIALOG_WIDTH)
        .close_disabled(close_disabled)
        .click_outside(!close_disabled)
        .child(body)
        .on_close(move |s: &mut S| on_close(s))
        .build(&kit(dark()), layer);
}
