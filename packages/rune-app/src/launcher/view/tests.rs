use super::*;
use crate::components::button;
use rune::{Cx, Env, Runtime};

fn view(s: &State, _: &mut Cx<State>) -> El {
    let action = if s.paging {
        button_tx(
            "action",
            t("rune.refresh"),
            false,
            crate::screen::action_tx(&s.input_scope, |s, tx| {
                s.draft.text.push_str("accepted");
                tx.focus("destination", true);
            }),
        )
    } else {
        button(
            "action",
            t("rune.refresh"),
            false,
            crate::screen::action(&s.input_scope, |s| s.draft.text.push_str("accepted")),
        )
    };
    col()
        .child(action)
        .child(text(t("rune.refresh")).key("destination").focusable(true))
}

#[test]
fn queued_actions_keep_their_screen_scope_and_tx() {
    for tx in [false, true] {
        let mut s = crate::init();
        s.paging = tx;
        let mut rt = Runtime::new(s, view, (320.0, 180.0), Env::new(false, 1.0));
        rt.frame(1.0);
        let (x, y) = rt.find("action").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        // The gesture is queued against the old tree when a session replaces its scope.
        rt.state.renew_scope();
        rt.frame(0.02);
        assert!(rt.state.draft.text.is_empty());

        rt.update(|_, _| {});
        rt.frame(0.02);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert_eq!(rt.state.draft.text, "accepted");
        let destination = rt
            .elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some("destination"))
            .unwrap();
        assert_eq!(destination.focused, tx);
    }
}

fn web_view(s: &State, cx: &mut Cx<State>) -> El {
    cx.web_focus();
    view(s, cx)
}

#[test]
fn web_focus_keyboard_actions_keep_their_screen_scope_and_tx() {
    for transactional in [false, true] {
        for key in [rune::Key::Enter, rune::Key::Text(" ".into())] {
            let mut s = crate::init();
            s.paging = transactional;
            let mut rt = Runtime::new(s, web_view, (320.0, 180.0), Env::new(false, 1.0));
            rt.frame(0.0);
            rt.update(|_, tx| tx.focus("action", true));
            rt.frame(0.0);
            let event = rune::KeyEvent {
                key,
                mods: rune::Mods::default(),
            };
            rt.key(event.clone());
            rt.state.renew_scope();
            rt.frame(0.0);
            rt.key_up(event.clone());
            rt.frame(0.0);
            assert!(
                rt.state.draft.text.is_empty(),
                "queued activation keeps old screen scope"
            );
            assert!(
                !rt.elements()
                    .iter()
                    .any(|node| node.key.as_deref() == Some("destination") && node.focused)
            );

            rt.update(|_, _| {});
            rt.frame(0.0);
            rt.key(event.clone());
            rt.frame(0.0);
            rt.key_up(event);
            rt.frame(0.0);
            assert_eq!(rt.state.draft.text, "accepted");
            let destination = rt
                .elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some("destination"))
                .unwrap();
            assert_eq!(
                destination.focused, transactional,
                "original Tx reaches the destination"
            );
        }
    }
}

fn launcher_state() -> State {
    let mut s = crate::init();
    s.screen = crate::Screen::Launcher(Box::new(launcher::Launcher::fixture()));
    s
}

fn product_root_with_probe(s: &State, cx: &mut Cx<State>) -> El {
    let probe = text(t("rune.refresh"))
        .key("web-focus-probe")
        .role("button")
        .label(t("rune.refresh"))
        .on_press(|_: &mut State| {});
    col().child(probe).child(crate::view(s, cx))
}

#[test]
fn product_root_enables_web_focus_for_launcher_controls() {
    let mut rt = Runtime::new(
        launcher_state(),
        product_root_with_probe,
        (960.0, 640.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    // Without .focusable(true), a pressable role="button" only takes focus when
    // crate::view enables Cx::web_focus() through settings::render.
    rt.update(|_, tx| tx.focus("web-focus-probe", true));
    rt.frame(0.0);
    assert!(
        rt.elements()
            .iter()
            .any(|node| node.key.as_deref() == Some("web-focus-probe") && node.focused),
        "product root must enable shared web_focus so pressable buttons without focusable(true) take focus"
    );
}
