use super::*;
use crate::files::test_http::Http;
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;

fn state(backend: &Backend) -> State {
    let mut s = crate::init();
    s.phase = Phase::Ready;
    s.transcript_display.messages.backend = Some(backend.clone());
    s.messages = [
        json!({"id":"prompt","type":"user","text":"Original **prompt**"}),
        json!({"id":"answer","type":"assistant","time":{"completed":1},"content":[
            {"type":"text","text":"First **paragraph**."},
            {"type":"tool","name":"read","id":"call","state":{"status":"completed"}},
            {"type":"reasoning","text":"Private reasoning"},
            {"type":"text","text":"Second paragraph."}
        ]}),
    ]
    .iter()
    .map(|row| crate::history::decode_message(row).unwrap().into())
    .collect();
    s
}

fn runtime(s: State) -> Runtime<State> {
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (1000.0, 900.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    rt
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..16 {
        rt.frame(0.02);
    }
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

async fn received(rt: &mut Runtime<State>, name: &str, stop: impl Fn(&State) -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            rt.update_if(poll);
            rt.frame(0.02);
            if stop(&rt.state) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("missing {name}"));
}

#[test]
fn copy_omits_technical_parts_and_unavailable_prune_stays_visible_with_help() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut rt = runtime(state(&http.backend));
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        click(&mut rt, "copy-message-answer");
        assert_eq!(
            clipboard.text().unwrap().as_str(),
            "First **paragraph**.\n\nSecond paragraph."
        );
        click(&mut rt, "message-actions-answer:trigger");
        let prune = rt
            .elements()
            .into_iter()
            .find(|e| e.label.as_deref() == Some("Remove tools and reasoning from this response"))
            .unwrap();
        assert_eq!(
            prune.help.as_deref(),
            Some("This server doesn’t support this action.")
        );
        let [x, y, w, h] = prune.rect;
        rt.pointer_down(x + w / 2.0, y + h / 2.0);
        rt.pointer_up(x + w / 2.0, y + h / 2.0);
        settle(&mut rt);
        assert!(!rt.state.transcript_display.messages.pending());
        http.quiet().await;
    });
}

#[test]
fn edit_waits_for_the_native_revert_and_restore_reads_back_the_boundary() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut s = state(&http.backend);
        s.transcript_display.messages.caps.revert = true;
        let mut rt = runtime(s);
        rt.update(|_, tx| tx.focus("message-actions-prompt:trigger", true));
        settle(&mut rt);
        rt.key(KeyEvent {
            key: Key::Up,
            mods: Mods::default(),
        });
        settle(&mut rt);
        assert!(
            rt.elements().iter().any(
                |e| e.focused && e.key.as_deref() == Some("message-actions-prompt:item:revert")
            )
        );
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        settle(&mut rt);
        assert!(
            rt.find("message-actions-prompt:item:revert").is_none(),
            "edit closes menu"
        );
        received(&mut rt, "edit dispatch", |s| {
            s.transcript_display.messages.job.is_some()
        })
        .await;
        let stage = http.accept().await;
        assert!(
            stage
                .header
                .starts_with("POST /workspaces/owned/instance/api/session/session/revert/stage ")
        );
        assert_eq!(stage.body, json!({"messageID":"prompt"}));
        assert!(rt.state.draft.text.is_empty());
        stage
            .reply(200, json!({"data":{"messageID":"prompt"}}))
            .await;
        received(&mut rt, "prefilled draft", |s| {
            s.draft.text == "Original **prompt**"
        })
        .await;
        let info = http.accept().await;
        assert!(
            info.header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
        );
        info.reply(
            200,
            json!({"data":{"id":"session","revert":{"messageID":"prompt"}}}),
        )
        .await;
        received(&mut rt, "confirmed revert", |s| {
            s.transcript_display.messages.can_restore()
        })
        .await;
        settle(&mut rt);
        assert!(rt.find("copy-message-answer").is_none());
        click(&mut rt, "restore-message-history");
        assert!(
            rt.state.transcript_display.messages.job.is_some(),
            "restore button dispatches its action"
        );
        let clear = http.accept().await;
        assert!(
            clear
                .header
                .starts_with("DELETE /workspaces/owned/instance/api/session/session/revert ")
        );
        clear.reply(204, json!(null)).await;
        received(&mut rt, "restore reconciliation", |s| {
            s.transcript_display.messages.read.is_some()
        })
        .await;
        http.accept()
            .await
            .reply(200, json!({"data":{"id":"session"}}))
            .await;
        received(&mut rt, "cleared revert", |s| {
            s.transcript_display.messages.read.is_none()
        })
        .await;
        assert!(rt.find("restore-message-history").is_none());
        assert_eq!(rt.state.draft.text.as_str(), "Original **prompt**");
    });
}

#[test]
fn late_edit_receipt_preserves_new_draft_and_ignores_a_rotated_input_scope() {
    platform::block_on(async {
        let http = Http::new().await;
        for switch in [false, true] {
            let mut s = state(&http.backend);
            s.transcript_display.messages.caps.revert = true;
            let mut rt = runtime(s);
            rt.update(|s, _| {
                start(
                    s,
                    Intent::Edit {
                        id: "prompt".into(),
                        text: "Original".into(),
                    },
                );
            });
            let stage = http.accept().await;
            rt.update(|s, _| {
                if switch {
                    s.renew_scope();
                } else {
                    s.draft.replace_text("Already typing");
                }
            });
            stage
                .reply(200, json!({"data":{"messageID":"prompt"}}))
                .await;
            received(&mut rt, "settled edit", |s| {
                !s.transcript_display.messages.pending()
            })
            .await;
            assert_eq!(
                rt.state.draft.text.as_str(),
                if switch { "" } else { "Already typing" }
            );
            assert_eq!(
                rt.state.transcript_display.messages.boundary.as_deref(),
                (!switch).then_some("prompt")
            );
            http.accept()
                .await
                .reply(
                    200,
                    json!({"data":{"id":"session","revert":{"messageID":"prompt"}}}),
                )
                .await;
        }
    });
}

#[test]
fn fork_uses_the_native_successor_and_prune_sends_only_confirmed_indexes() {
    platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let exercise = tokio::spawn(async move {
            let (keep, cancel) = bounded(1);
            let fork = backend.fork_after_message("prompt", &cancel).await.unwrap();
            drop(keep);
            assert_eq!(fork, "new");
            let preview = backend.preview_message_prune("answer").await.unwrap();
            assert_eq!(preview.counts(), (1, 1));
            backend.prune_message(preview).await.unwrap();
        });
        let respond = async {
            let page = http.accept().await;
            assert!(page.header.starts_with(
                "GET /workspaces/owned/instance/api/session/session/message?limit=200&order=desc "
            ));
            page.reply(
                200,
                json!({"data":[{"id":"hidden","type":"system"},{"id":"prompt","type":"user"}]}),
            )
            .await;
            let fork = http.accept().await;
            assert!(
                fork.header
                    .starts_with("POST /workspaces/owned/instance/api/session/session/fork ")
            );
            assert_eq!(fork.body, json!({"before":"hidden"}));
            fork.reply(200, json!({"data":{"id":"new","fork":{"sessionID":"session","boundary":{"type":"before","messageID":"hidden"}}}})).await;
            let preview = http.accept().await;
            assert!(
                preview
                    .header
                    .starts_with("POST /api/workspaces/owned/session-pruning/preview ")
            );
            assert_eq!(
                preview.body,
                json!({"sessionID":"session","messageID":"answer"})
            );
            let revision = "a".repeat(64);
            preview.reply(200, json!({"status":"preview","liveMutation":true,"revision":revision,
                "parts":[{"index":5,"type":"tool","bytes":20},{"index":2,"type":"reasoning","bytes":10}]})).await;
            let prune = http.accept().await;
            assert!(
                prune
                    .header
                    .starts_with("POST /api/workspaces/owned/session-pruning/prune ")
            );
            assert_eq!(
                prune.body,
                json!({"sessionID":"session","messageID":"answer","revision":"a".repeat(64),"indexes":[2,5]})
            );
            prune.reply(200, json!({"status":"pruned","messageID":"answer","revision":"b".repeat(64),"removedCount":2})).await;
        };
        respond.await;
        exercise.await.unwrap();
    });
}

#[test]
fn capability_probe_ignores_other_features_and_does_not_attempt_a_mutation() {
    platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let read =
            tokio::spawn(async move { backend.message_action_capabilities().await.unwrap() });
        let meta = http.accept().await;
        assert!(meta.header.starts_with("GET /api/meta "));
        meta.reply(200, json!({"capabilities":["session-pruning","other"]}))
            .await;
        let capabilities = read.await.unwrap();
        assert!(capabilities.prune && !capabilities.revert);
        http.quiet().await;
    });
}
