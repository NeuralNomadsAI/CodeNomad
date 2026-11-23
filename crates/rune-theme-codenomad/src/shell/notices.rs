use crate::{
    Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{Align, El, ScrollSpec, Side, Tx, col, row, text};
use std::rc::Rc;

pub const ANCHOR: &str = "notification-history-toggle";

pub fn bell<S: 'static>(
    label: &'static str,
    unread: Option<(String, String)>,
    open: bool,
    touch: bool,
    invoke: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let invoke = Rc::new(invoke);
    let press = invoke.clone();
    let button = super::control(&super::icons::BELL, label, touch)
        .help(label)
        .expanded(open)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(kit(layout::dark()))
        .on_key(super::enter_action(invoke))
        .key(ANCHOR);
    row().center_y().child(button).children(
        unread.map(|(count, label)| text(count).text_role(TextRole::Caption).label(label)),
    )
}

pub fn record(title: &str, body: &str, toolbar: El, live: bool) -> El {
    col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Xs)
        .fill(tokens(layout::dark()).color("surface-overlay"))
        .child(text(title).text_role(TextRole::Button).wrap_anywhere())
        .child(if live {
            text(body).wrap_anywhere().role("status")
        } else {
            text(body).wrap_anywhere()
        })
        .child(toolbar)
}

pub fn bubbles(cards: impl IntoIterator<Item = El>, viewport: f32) -> El {
    super::floating_notice(
        col()
            .w(viewport.min(320.0))
            .separate(Space::Sm)
            .children(cards),
    )
}

pub fn history<S: 'static>(
    label: &str,
    toolbar: El,
    records: impl IntoIterator<Item = El>,
    viewport: (f32, f32),
    close: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let inset = t.space(Space::Sm).px();
    col()
        .key("notification-history")
        .role("dialog")
        .label(label)
        .fill(t.color("surface-overlay"))
        .pad(Space::Sm)
        .separate(Space::Sm)
        .w((viewport.0 - inset * 2.0).max(0.0).min(360.0))
        .child(text(label).text_role(TextRole::Button).role("heading"))
        .child(toolbar)
        .child(
            col()
                .key("notification-history-list")
                .full_width()
                .separate(Space::Sm)
                .max_h((viewport.1 - 128.0).max(0.0).min(480.0))
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .children(records),
        )
        .anchored_fit(ANCHOR, Side::Bottom, Align::End, inset)
        .modal_tx(true, close)
        .raise()
}
