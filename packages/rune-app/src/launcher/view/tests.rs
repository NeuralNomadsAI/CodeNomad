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

#[test]
fn launcher_address_and_password_fields_preserve_focus_editing_and_a11y() {
    let mut s = launcher_state();
    s.screen.launcher_mut().unwrap().address = rune::TextEdit::new("");
    let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
    rt.frame(0.0);

    let click_and_type = |rt: &mut Runtime<State>, key: &str, text: &str| {
        let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        rt.key(rune::KeyEvent {
            key: rune::Key::Text(text.into()),
            mods: rune::Mods::default(),
        });
        rt.frame(0.02);
    };

    click_and_type(&mut rt, "server-address", "https://demo.local:9898");
    click_and_type(&mut rt, "server-password", "s3cr3t-launcher-pass");

    let l = rt.state.screen.launcher().unwrap();
    assert_eq!(l.address.text, "https://demo.local:9898");
    assert_eq!(l.password.text, "s3cr3t-launcher-pass");

    let elements = rt.elements();
    let addr = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("server-address"))
        .unwrap();
    let pass = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("server-password"))
        .unwrap();
    assert_eq!(addr.role, "textbox");
    assert_eq!(pass.role, "textbox");
    assert!(
        !elements
            .iter()
            .any(|n| n.text.as_deref() == Some("s3cr3t-launcher-pass")),
        "secure launcher password must never leak into ElementInfo::text"
    );
    let a11y = rt.a11y_json();
    assert!(a11y.contains("https://demo.local:9898"));
    assert!(
        !a11y.contains("s3cr3t-launcher-pass"),
        "secure launcher password must never leak into a11y_json"
    );
}

#[test]
fn direct_recovery_fields_mount_inside_dialog_without_leaking_password() {
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    crate::chat::authentication::expired(
        &mut s,
        codenomad_client::transport::Authentication {
            backend,
            confirmed: true,
        },
    );
    let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
    rt.frame(0.0);

    let elements = rt.elements();
    let dialog = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("direct-recovery-dialog"))
        .unwrap();
    let user = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("direct-recovery-username"))
        .unwrap();
    let pass = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("direct-recovery-password"))
        .unwrap();
    assert_eq!(dialog.role, "dialog");
    let dialog_prefix = format!("{}/", dialog.path);
    assert!(
        user.path.starts_with(&dialog_prefix) && pass.path.starts_with(&dialog_prefix),
        "username and password must be descendants of the recovery dialog"
    );
    let has_intervening_scope = |field_path: &str| {
        elements.iter().any(|n| {
            n.path.starts_with(&dialog_prefix)
                && field_path.starts_with(&format!("{}/", n.path))
                && matches!(n.role, "form" | "dialog" | "alertdialog")
        })
    };
    assert!(
        !has_intervening_scope(&user.path) && !has_intervening_scope(&pass.path),
        "no intermediate form or dialog scope may split recovery username and password"
    );

    let (ux, uy) = rt.find("direct-recovery-username").unwrap();
    rt.pointer_down(ux, uy);
    rt.pointer_up(ux, uy);
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Text("-admin".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);

    let (px, py) = rt.find("direct-recovery-password").unwrap();
    rt.pointer_down(px, py);
    rt.pointer_up(px, py);
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Text("s3cr3t-recovery-pass".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);

    assert_eq!(
        rt.state.direct_authentication.username.text,
        "codenomad-admin"
    );
    assert_eq!(
        rt.state.direct_authentication.password.text,
        "s3cr3t-recovery-pass"
    );
    assert!(
        !rt.a11y_json().contains("s3cr3t-recovery-pass"),
        "secure recovery password must never leak into a11y_json"
    );
}
