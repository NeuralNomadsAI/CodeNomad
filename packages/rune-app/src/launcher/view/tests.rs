use super::*;
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
