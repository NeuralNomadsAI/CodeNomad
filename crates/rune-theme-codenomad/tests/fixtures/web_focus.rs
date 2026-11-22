//! Offline browser qualification of the actual shared controls and DOM mirror.
use rune::{Cx, El, TextEdit};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
};

#[path = "../../../../packages/rune-app/src/components/window_close_button.rs"]
mod close;
mod strings {
    pub fn t(key: &str) -> &'static str {
        rune_theme_codenomad::catalogue::message("en", key).expect("fixture catalogue key")
    }
}

#[derive(Default)]
struct State {
    focused: String,
    close: close::WindowCloseState,
    field: TextEdit,
    submit_field: TextEdit,
    actions: usize,
    closes: usize,
    defaults: usize,
    submits: usize,
    modal_actions: usize,
    modal_defaults: usize,
    modal: bool,
}
fn receipts(s: &State, key: &str) -> El {
    rune::col().key(key)
        .child(rune::text(format!("focus-key={};", s.focused)))
        .child(rune::text(format!("receipts actions={} closes={} defaults={} submits={} modal_actions={} modal_defaults={}",
            s.actions, s.closes, s.defaults, s.submits, s.modal_actions, s.modal_defaults)).role("status"))
}
fn view(s: &State, cx: &mut Cx<State>) -> El {
    layout::render(cx, |cx| {
        let mut root = rune::col()
            .w_full()
            .h_full()
            .pad(Space::Md)
            .separate(Space::Sm)
            .reading_surface()
            .child(rune::text("Rune web focus fixture").role("heading"))
            .child(receipts(s, "receipts"))
            .child(
                layout::input(&s.field)
                    .single_line()
                    .key("field")
                    .label("Default field")
                    .on_edit(|s: &mut State| &mut s.field),
            )
            .child(
                rune::row()
                    .separate(Space::Sm)
                    .child(
                        layout::button("Action", false, |s: &mut State| s.actions += 1)
                            .key("action"),
                    )
                    .child(
                        layout::button_tx("Action with Tx", false, |s: &mut State, tx| {
                            s.actions += 1;
                            tx.focus("destination", true);
                        })
                        .key("tx-action"),
                    )
                    .child(
                        layout::button("Disabled", true, |_: &mut State| {
                            panic!("disabled fixture action")
                        })
                        .key("disabled"),
                    )
                    .child(close::close_button(
                        &s.close,
                        "close",
                        cx.system_dark(),
                        Some("Shared close"),
                        |s: &mut State| &mut s.close,
                        |s, _| s.closes += 1,
                    )),
            )
            .child(
                layout::input(&s.submit_field)
                    .single_line()
                    .key("submit-field")
                    .label("Submit field")
                    .on_edit(|s: &mut State| &mut s.submit_field)
                    .on_submit(|s: &mut State, _| s.submits += 1),
            )
            .child(
                layout::button("Default action", false, |s: &mut State| s.defaults += 1)
                    .key("default")
                    .default_button(),
            )
            .child(
                layout::button("Open modal", false, |s: &mut State| s.modal = true)
                    .key("open-modal"),
            )
            .child(
                layout::button("Reset receipts", false, |s: &mut State| {
                    s.actions = 0;
                    s.closes = 0;
                    s.defaults = 0;
                    s.submits = 0;
                    s.modal_actions = 0;
                    s.modal_defaults = 0;
                })
                .key("reset"),
            )
            .child(
                rune::text("Destination")
                    .key("destination")
                    .label("Destination")
                    .role("group")
                    .focusable(true),
            );
        if s.modal {
            root = root.child(
                rune::col()
                    .key("modal")
                    .role("dialog")
                    .label("Fixture modal")
                    .absolute(150.0, 100.0)
                    .size(400.0, 240.0)
                    .pad(Space::Md)
                    .separate(Space::Sm)
                    .reading_surface()
                    .modal(false, |s: &mut State| s.modal = false)
                    .child(receipts(s, "modal-receipts"))
                    .child(
                        layout::button("Modal action", false, |s: &mut State| s.modal_actions += 1)
                            .key("modal-action"),
                    )
                    .child(
                        layout::button("Modal default", false, |s: &mut State| {
                            s.modal_defaults += 1
                        })
                        .key("modal-default")
                        .default_button(),
                    )
                    .child(
                        layout::button("Dismiss modal", false, |s: &mut State| s.modal = false)
                            .key("dismiss-modal"),
                    ),
            );
        }
        root
    })
}
fn main() {
    let spec = rune::AppSpec {
        poll: Some(|s: &mut State, _, tx| {
            tx.wake_after(std::time::Duration::from_millis(20));
            let focused = tx.focused().unwrap_or("none");
            if s.focused == focused {
                return false;
            }
            s.focused = focused.into();
            true
        }),
        ..layout::app_spec("Rune web focus fixture", State::default, view)
    };
    layout::run(spec, |_, _| {});
}
