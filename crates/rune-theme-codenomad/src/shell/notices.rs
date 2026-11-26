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
    skip_tab: bool,
    invoke: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let invoke = Rc::new(invoke);
    let press = invoke.clone();
    let name = unread
        .as_ref()
        .map_or_else(|| label.into(), |(_, count)| format!("{label} · {count}"));
    let button = if touch {
        crate::tabs::touch_bar_button(&super::icons::BELL, &name, label, move |s, tx| press(s, tx))
            .expanded(open)
    } else {
        super::control(&super::icons::BELL, label, false)
            .label(name)
            .help(label)
            .expanded(open)
            .on_press_tx(move |s, tx| press(s, tx))
            .build(&kit(layout::dark()))
    }
    .on_key(layout::enter_action(invoke))
    .tab_index(if skip_tab { -1 } else { 0 })
    .key(ANCHOR);
    row()
        .center_y()
        .child(button)
        .children(unread.map(|(count, _)| text(count).text_role(TextRole::Small).a11y_hidden()))
}

pub fn title(title: &str) -> El {
    text(title)
        .text_role(TextRole::Button)
        .wrap_anywhere()
        .max_lines(2)
}

pub fn record(
    title: El,
    body: &str,
    toolbar: El,
    bubble_height: Option<f32>,
    skip_tab: bool,
) -> El {
    col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Xs)
        .fill(tokens(layout::dark()).color("surface-overlay"))
        .child(title)
        .child(if let Some(height) = bubble_height {
            col()
                .key("notification-text")
                .focusable(true)
                .tab_index(if skip_tab { -1 } else { 0 })
                .max_h((height * 0.15).max(32.0))
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(text(body).wrap_anywhere().role("status"))
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
    close_control: El,
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
        .w((viewport.0 - inset * 2.0).max(0.0).min(380.0))
        .child(
            row()
                .full_width()
                .center_y()
                .justify_between()
                .child(text(label).text_role(TextRole::Button).role("heading"))
                .child(close_control),
        )
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
