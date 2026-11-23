use super::*;
use crate::files::test_http::{Http, Request, wait};
use serde_json::json;
use std::sync::Arc;

#[test]
fn status_exposes_the_folded_mode_and_keyboard_controls_in_both_themes() {
    use rune::{Env, Key, KeyEvent, Mods, Runtime};
    fn render(s: &State, cx: &mut rune::Cx<State>) -> El {
        layout::render(cx, |_| {
            col().full_width().full_height().child(view(s).unwrap())
        })
    }
    fn node<'a>(tree: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
        if tree["key"] == key {
            return Some(tree);
        }
        tree["children"]
            .as_array()?
            .iter()
            .find_map(|child| node(child, key))
    }
    for dark in [false, true] {
        let mut s = crate::init();
        s.status_permissions = Permissions {
            backend: Some(platform::block_on(Backend::connect("http://127.0.0.1:9/", "")).unwrap()),
            visible: true,
            online: true,
            confirmed: Some(Snapshot {
                mode: Mode::Supervised,
                root: None,
            }),
            ..Permissions::default()
        };
        crate::strings::with_locale("en", || {
            let mut runtime = Runtime::new(s, render, (320.0, 300.0), Env::new(dark, 1.0));
            runtime.frame(0.0);
            let tree = runtime.accessibility_json();
            let trigger = node(&tree, "trigger").unwrap();
            assert!(trigger.to_string().contains("Permissions · Supervised"));
            assert!(node(&tree, "segment1").is_none());
            runtime.update(|_, tx| tx.focus("trigger", true));
            runtime.frame(0.02);
            let focused = runtime.accessibility_json();
            assert!(
                node(&focused, "trigger").unwrap()["states"]
                    .to_string()
                    .contains("focused"),
                "{focused}"
            );
            let enter = KeyEvent {
                key: Key::Enter,
                mods: Mods::default(),
            };
            runtime.key(enter.clone());
            runtime.key_up(enter);
            runtime.frame(0.04);
            let tree = runtime.accessibility_json();
            assert!(runtime.state.status_permissions.expanded, "{tree}");
            let supervised = node(&tree, "segment1").unwrap_or_else(|| panic!("{tree}"));
            assert_eq!(supervised["role"], "radio-button");
            assert!(
                supervised["states"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|state| state == "selected" || state == "checked"),
                "{supervised}"
            );
            assert!(
                node(&tree, "permission-mode-info")
                    .unwrap()
                    .to_string()
                    .contains("About permission modes")
            );
            runtime.update(|_, tx| tx.focus("segment0", true));
            runtime.frame(0.06);
            let (_result, reply) = bounded(1);
            runtime.update(|s, _| s.status_permissions.write = Some((Mode::Autonomous, reply)));
            runtime.frame(0.08);
            let pending = runtime.accessibility_json();
            assert!(
                node(&pending, "segment0").unwrap()["states"]
                    .to_string()
                    .contains("focused"),
                "{pending}"
            );
        });
    }
}

async fn request(http: &Http, method: &str) -> Request {
    let request = http.accept().await;
    assert!(request.header.starts_with(&format!(
        "{method} /api/workspaces/owned/sessions/ses_child/permission-mode HTTP/"
    )));
    request
}

#[test]
fn a_child_uses_the_confirmed_family_mode_and_reconciles_a_lost_write_without_replaying() {
    platform::block_on(async {
        let mut http = Http::new().await;
        http.backend.session = "ses_child".into();
        let (wake, events) = bounded::<()>(1);
        let mut s = crate::init();
        s.wake = Arc::new(move || {
            let _ = wake.try_send(());
        });
        let backend = http.backend.clone();
        let attestation = tokio::spawn(async move { backend.attest_server().await });
        let meta = http.accept().await;
        assert!(meta.header.starts_with("GET /api/meta HTTP/"));
        meta.reply(200, json!({"serverId":"private", "apiContract":1, "capabilities":["conversation-permissions"]})).await;
        attestation.await.unwrap().unwrap();
        s.status_permissions.bind(&http.backend);
        let (relay, incoming) = bounded(4);
        s.incoming = Some(incoming);
        relay
            .try_send(crate::transport::Event::Reconnecting)
            .unwrap();
        relay
            .try_send(crate::transport::Event::Sync(crate::history::Page {
                rows: vec![],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            }))
            .unwrap();
        assert!(crate::poll_chat(&mut s, 4));
        assert!(
            s.status_permissions.online,
            "direct startup can resume permission reads"
        );
        assert!(!s.status_permissions.poll(&s.reads, &s.wake));
        s.status_permissions.show(true);
        assert!(s.status_permissions.poll(&s.reads, &s.wake));
        let obsolete = request(&http, "GET").await;
        for _ in 0..3 {
            s.status_permissions.invalidate(Some("ses_root"));
        }
        obsolete
            .reply(200, json!({"mode":"supervised","rootSessionID":"ses_root"}))
            .await;
        wait(events.recv()).await.unwrap();
        s.status_permissions.poll(&s.reads, &s.wake);
        assert!(s.status_permissions.confirmed.is_none());
        request(&http, "GET")
            .await
            .reply(200, json!({"mode":"autonomous","rootSessionID":"ses_root"}))
            .await;
        wait(events.recv()).await.unwrap();
        s.status_permissions.poll(&s.reads, &s.wake);
        assert!(s.status_permissions.available());
        s.status_permissions.invalidate(Some("ses_unrelated"));
        assert!(!s.status_permissions.dirty);

        // The application rejects a gesture after the panel is hidden. This fixture
        // drives just the admitted operation and reducer below that gate.
        let (commands, _submitted) = bounded(1);
        s.commands = Some(commands);
        s.draft = rune::edit::TextEdit::new("Wait until permissions settle");
        assert!(crate::composer::can_send(&s));
        assert!(crate::launcher::can_change_session(&s));
        s.status_permissions.write(Mode::Supervised, &s.wake);
        let put = request(&http, "PUT").await;
        assert_eq!(put.body, json!({"mode":"supervised"}));
        assert!(!crate::composer::can_send(&s));
        assert!(!crate::launcher::can_change_session(&s));
        assert!(!s.status_permissions.available());
        assert_eq!(
            s.status_permissions.confirmed.as_ref().unwrap().mode,
            Mode::Autonomous
        );
        drop(put);
        wait(events.recv()).await.unwrap();
        s.status_permissions.poll(&s.reads, &s.wake);
        assert!(!crate::composer::can_send(&s));
        assert!(
            s.status_permissions.issue.is_none(),
            "a lost reply is unresolved until the read"
        );
        request(&http, "GET").await.reply(503, json!({})).await;
        wait(events.recv()).await.unwrap();
        s.status_permissions.poll(&s.reads, &s.wake);
        assert!(s.status_permissions.failed);
        assert!(!s.status_permissions.available());
        s.status_permissions.invalidate(Some("ses_root"));
        s.status_permissions.poll(&s.reads, &s.wake);
        request(&http, "GET")
            .await
            .reply(200, json!({"mode":"supervised","rootSessionID":"ses_root"}))
            .await;
        wait(events.recv()).await.unwrap();
        s.status_permissions.poll(&s.reads, &s.wake);
        assert_eq!(
            s.status_permissions.confirmed.as_ref().unwrap().mode,
            Mode::Supervised
        );
        assert!(s.status_permissions.issue.is_none());
        assert!(s.status_permissions.available());
        // Removing this fork's block can legitimately leave inherited rules in place.
        s.status_permissions.write(Mode::Autonomous, &s.wake);
        request(&http, "PUT")
            .await
            .reply(200, json!({"mode":"supervised","rootSessionID":"ses_root"}))
            .await;
        wait(events.recv()).await.unwrap();
        s.status_permissions.poll(&s.reads, &s.wake);
        request(&http, "GET").await.reply(503, json!({})).await;
        wait(events.recv()).await.unwrap();
        s.status_permissions.poll(&s.reads, &s.wake);
        assert_eq!(
            s.status_permissions.confirmed.as_ref().unwrap().mode,
            Mode::Supervised
        );
        assert!(s.status_permissions.failed);
        assert!(
            s.status_permissions.issue.is_none(),
            "the reported remaining mode is authoritative"
        );
        s.status_permissions.show(false);
        assert!(!s.status_permissions.poll(&s.reads, &s.wake));
        http.quiet().await;
    });
}
