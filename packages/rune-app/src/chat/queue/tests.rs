use super::*;
use crate::files::test_http::Http;
use codenomad_client::transport::Event;
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;

fn queued(id: &str, delivery: Delivery, text: &str) -> QueuedPrompt {
    QueuedPrompt {
        id: id.into(),
        delivery,
        text: text.into(),
        parts: vec![],
        created: Some(1),
    }
}

fn user_row(id: &str, text: &str) -> crate::history::Row {
    crate::history::decode_message(&json!({"id": id, "type": "user", "text": text}))
        .unwrap()
        .into()
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

async fn wait_queue(rt: &mut Runtime<State>, name: &str, stop: impl Fn(&State) -> bool) {
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
fn queued_prompt_gestures_guard_double_submit_recover_from_errors_and_edit_draft() {
    platform::block_on(async {
        let http = Http::new().await;
        let (cmd_tx, cmd_rx) = bounded(16);
        let mut s = crate::init();
        s.phase = Phase::Streaming;
        s.commands = Some(cmd_tx);
        s.messages = vec![user_row("u1", "First prompt")];
        s.transcript_display.queue.fixture_set(
            Some(http.backend.clone()),
            vec![
                queued("q1", Delivery::Queue, "Queued follow-up"),
                queued("q2", Delivery::Queue, "Second queued"),
            ],
        );
        let mut rt = runtime(s);

        // Badge and controls render for queued items.
        assert!(rt.find("queued-badge-q1").is_some());
        assert!(rt.find("queued-delivery-q1").is_some());
        assert!(rt.find("queued-edit-q1").is_some());
        assert!(rt.find("queued-remove-q1").is_some());

        // Click "Steer now" -> holds busy; second click and keyboard Enter must NOT dispatch again.
        click(&mut rt, "queued-delivery-q1");
        wait_queue(&mut rt, "steer dispatch", |s| {
            s.transcript_display.queue.pending()
        })
        .await;
        let steer_req = http.accept().await;
        assert!(
            steer_req
                .header
                .starts_with("PATCH /workspaces/owned/instance/api/session/session/inbox/q1 ")
        );
        assert_eq!(steer_req.body, json!({"delivery": "steer"}));
        click(&mut rt, "queued-delivery-q1");
        click(&mut rt, "queued-remove-q2");
        http.quiet().await;

        steer_req.reply(200, json!({"ok": true})).await;
        wait_queue(&mut rt, "steer settled", |s| {
            !s.transcript_display.queue.pending()
                && s.transcript_display.queue.items()[0].delivery == Delivery::Steer
        })
        .await;
        assert!(
            matches!(cmd_rx.try_recv().ok(), Some(Command::SyncInbox)),
            "settled gesture triggers authoritative inbox sync"
        );
        settle(&mut rt);
        assert!(
            rt.find("queued-badge-q1").is_none(),
            "steering item hides QUEUED badge while retaining Move to queue control"
        );

        // Keyboard Enter triggers "Move to queue" -> 500 error clears busy and shows alert.
        rt.update(|_, tx| tx.focus("queued-delivery-q1", true));
        settle(&mut rt);
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        settle(&mut rt);
        wait_queue(&mut rt, "demote dispatch", |s| {
            s.transcript_display.queue.pending()
        })
        .await;
        let demote_req = http.accept().await;
        assert_eq!(demote_req.body, json!({"delivery": "queue"}));
        demote_req.reply(500, json!({"error": "boom"})).await;
        wait_queue(&mut rt, "error settled", |s| {
            !s.transcript_display.queue.pending() && s.transcript_display.queue.has_error()
        })
        .await;
        assert!(matches!(cmd_rx.try_recv().ok(), Some(Command::SyncInbox)));
        assert!(rt.elements().iter().any(|e| {
            e.role == "alert" && e.text.as_deref() == Some("Unable to update the prompt queue")
        }));

        // 501 surfaces localized unavailable message without locking buttons.
        click(&mut rt, "queued-remove-q2");
        wait_queue(&mut rt, "remove 501 dispatch", |s| {
            s.transcript_display.queue.pending()
        })
        .await;
        let unavail_req = http.accept().await;
        assert!(
            unavail_req
                .header
                .starts_with("DELETE /workspaces/owned/instance/api/session/session/inbox/q2 ")
        );
        unavail_req
            .reply(501, json!({"error": "unavailable"}))
            .await;
        wait_queue(&mut rt, "501 settled", |s| {
            !s.transcript_display.queue.pending()
                && s.transcript_display.queue.error
                    == Some("session.messageActions.serverUnavailable")
        })
        .await;
        let _ = cmd_rx.try_recv();
        assert!(rt.elements().iter().any(|e| {
            e.role == "alert"
                && e.text.as_deref() == Some("This server doesn’t support this action.")
        }));

        // Edit is disabled when draft is non-empty, then restores text into empty draft on 204.
        rt.update(|s, _| s.draft.replace_text("Existing typing"));
        settle(&mut rt);
        click(&mut rt, "queued-edit-q1");
        http.quiet().await;
        assert!(!rt.state.transcript_display.queue.pending());

        rt.update(|s, _| s.draft.clear());
        settle(&mut rt);
        click(&mut rt, "queued-edit-q1");
        wait_queue(&mut rt, "edit dispatch", |s| {
            s.transcript_display.queue.pending()
        })
        .await;
        let edit_req = http.accept().await;
        assert!(
            edit_req
                .header
                .starts_with("DELETE /workspaces/owned/instance/api/session/session/inbox/q1 ")
        );
        edit_req.reply(204, json!(null)).await;
        wait_queue(&mut rt, "edit settled", |s| {
            !s.transcript_display.queue.pending() && s.draft.text == "Queued follow-up"
        })
        .await;
        assert!(
            !rt.state.transcript_display.queue.contains("q1"),
            "edited item leaves queue"
        );
        assert!(rt.state.transcript_display.queue.contains("q2"));
        http.quiet().await;
    });
}

#[test]
fn displaced_authoritative_sync_preserves_detached_anchor_and_deduplicates_pending_rows() {
    let (mut reader, lane) = crate::chat::reader::Reader::fixture_open();
    reader.install(false);
    let generation = reader.generation();
    let mut s = crate::init();
    s.phase = Phase::Streaming;
    s.reader = Some(reader);
    s.messages = (0..30)
        .map(|i| {
            user_row(
                &format!("row-{i:02}"),
                &format!("Message {i:02} body line.\n\n{}", "Detail ".repeat(18)),
            )
        })
        .collect();
    // Simulate an optimistic steer row temporarily present in both s.messages and queue.
    s.messages.push(user_row("q-move", "Promoted prompt"));
    s.transcript_display.queue.fixture_set(
        None,
        vec![queued("q-move", Delivery::Steer, "Promoted prompt")],
    );

    let mut rt = runtime(s);
    // Deduplication: q-move renders once, never twice.
    let q_count = rt
        .elements()
        .iter()
        .filter(|e| e.key.as_deref() == Some("q-move"))
        .count();
    assert_eq!(
        q_count, 1,
        "pending prompt must not duplicate committed row"
    );

    // Scroll to detached mid-history anchor row-12.
    rt.update(|_, tx| tx.scroll_key_to("row-12", -10.0));
    settle(&mut rt);
    let row_y = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("missing {key}"))
            .rect[1]
    };
    let before_y = row_y(&rt, "row-12");

    // Authoritative ReaderSync delivers q-move ABOVE row-12 (displacing rows before the anchor).
    let mut reordered: Vec<crate::history::Row> = (0..30)
        .map(|i| {
            user_row(
                &format!("row-{i:02}"),
                &format!("Message {i:02} body line.\n\n{}", "Detail ".repeat(18)),
            )
        })
        .collect();
    reordered.insert(4, user_row("q-move", "Promoted prompt"));
    lane.events
        .try_send((
            generation,
            0,
            Event::ReaderSync {
                page: crate::history::Page {
                    rows: reordered,
                    older: None,
                    newer: None,
                    running: true,
                    user_file_references: false,
                },
                version: 1,
            },
        ))
        .unwrap();

    rt.update(|s, tx| {
        assert!(crate::chat::events::poll_chat(s, 8));
        let _ = crate::chat::reader::renderer_ready(s, tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        let _ = crate::chat::reader::renderer_ready(s, tx);
    });
    settle(&mut rt);

    assert!(
        !rt.state.transcript_display.queue.contains("q-move"),
        "committed row is pruned from pending queue"
    );
    assert_eq!(rt.state.messages[4].id, "q-move");
    let after_y = row_y(&rt, "row-12");
    assert!(
        (after_y - before_y).abs() < 0.5,
        "detached anchor jumped on displaced delivery: before={before_y}, after={after_y}"
    );

    // Detached historical window omits pending prompts from the tail.
    rt.update(|s, _| {
        s.history_detached = true;
        s.transcript_display
            .queue
            .fixture_set(None, vec![queued("q-tail", Delivery::Queue, "Tail only")]);
        s.revision += 1;
    });
    settle(&mut rt);
    assert!(rt.find("queued-badge-q-tail").is_none());
}

#[test]
fn stale_scope_ignores_late_queued_prompt_completion() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut s = crate::init();
        s.phase = Phase::Streaming;
        s.messages = vec![user_row("u1", "First")];
        s.transcript_display.queue.fixture_set(
            Some(http.backend.clone()),
            vec![queued("q1", Delivery::Queue, "Old scope prompt")],
        );
        let mut rt = runtime(s);

        click(&mut rt, "queued-remove-q1");
        wait_queue(&mut rt, "remove dispatch", |s| {
            s.transcript_display.queue.pending()
        })
        .await;
        let req = http.accept().await;

        // Scope changes before response arrives (reconnect / tab switch).
        rt.update(|s, _| {
            s.renew_scope();
            s.transcript_display.queue.offline();
        });
        req.reply(500, json!({"error": "late"})).await;
        wait_queue(&mut rt, "stale cleared", |s| {
            !s.transcript_display.queue.pending()
        })
        .await;
        assert!(
            !rt.state.transcript_display.queue.has_error(),
            "late error from expired scope must not leak into current scope"
        );
        assert!(rt.state.transcript_display.queue.contains("q1"));
    });
}
