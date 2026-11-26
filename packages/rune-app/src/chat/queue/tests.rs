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
        editable: true,
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
            !rt.state
                .transcript_display
                .queue
                .items()
                .iter()
                .any(|item| item.id == "q1"),
            "edited item leaves queue"
        );
        assert!(
            rt.state
                .transcript_display
                .queue
                .items()
                .iter()
                .any(|item| item.id == "q2")
        );
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
        !rt.state
            .transcript_display
            .queue
            .items()
            .iter()
            .any(|item| item.id == "q-move"),
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

    // Pending-row reorder preserves a visible pending bookmark without jumping.
    let (ev_tx, ev_rx) = bounded(4);
    rt.update(|s, _| {
        s.history_detached = false;
        s.incoming = Some(ev_rx);
        s.transcript_display.queue.fixture_set(
            None,
            vec![
                queued("q-watch", Delivery::Queue, "Watched queued prompt"),
                queued(
                    "q-tail",
                    Delivery::Queue,
                    &format!("Tail prompt\n\n{}", "Long line ".repeat(40)),
                ),
            ],
        );
        s.revision += 1;
    });
    settle(&mut rt);
    rt.update(|_, tx| tx.scroll_key_to("q-watch", -24.0));
    settle(&mut rt);
    let before_pending_y = row_y(&rt, "q-watch");
    ev_tx
        .try_send(Event::Inbox {
            items: vec![
                queued(
                    "q-promoted",
                    Delivery::Steer,
                    &format!("Promoted above watched\n\n{}", "Detail ".repeat(30)),
                ),
                queued("q-watch", Delivery::Queue, "Watched queued prompt"),
                queued(
                    "q-tail",
                    Delivery::Queue,
                    &format!("Tail prompt\n\n{}", "Long line ".repeat(40)),
                ),
            ],
            authoritative: true,
            fence: None,
        })
        .unwrap();
    rt.update(|s, tx| {
        assert!(crate::chat::events::poll_chat(s, 4));
        let _ = crate::chat::reader::renderer_ready(s, tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        let _ = crate::chat::reader::renderer_ready(s, tx);
    });
    settle(&mut rt);
    let after_pending_y = row_y(&rt, "q-watch");
    assert!(
        (after_pending_y - before_pending_y).abs() < 0.5,
        "pending bookmark jumped on inbox reorder: before={before_pending_y}, after={after_pending_y}"
    );
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

        // Scope changes to another conversation before response arrives.
        rt.update(|s, _| {
            let mut other = http.backend.clone();
            other.session = "other-session".into();
            s.transcript_display.queue.bind(other);
        });
        req.reply(500, json!({"error": "late"})).await;
        wait_queue(&mut rt, "stale cleared", |s| {
            !s.transcript_display.queue.pending()
        })
        .await;
        assert!(
            !rt.state.transcript_display.queue.has_error(),
            "late error from expired conversation must not leak into current conversation"
        );
    });
}

#[test]
fn edit_preserves_prompt_in_recovery_slot_when_draft_changes_or_tab_suspends() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut s = crate::init();
        s.phase = Phase::Streaming;
        s.messages = vec![user_row("u1", "First")];
        s.transcript_display.queue.fixture_set(
            Some(http.backend.clone()),
            vec![
                queued("q1", Delivery::Queue, "Preserve me"),
                queued("q2", Delivery::Queue, "Second queued"),
            ],
        );
        let mut rt = runtime(s);

        click(&mut rt, "queued-edit-q1");
        wait_queue(&mut rt, "edit delete dispatch", |s| {
            s.transcript_display.queue.pending()
        })
        .await;
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("DELETE /workspaces/owned/instance/api/session/session/inbox/q1 ")
        );

        // Tab suspends while DELETE is in flight even with an EMPTY draft -> must land in recovery slot.
        rt.update(|s, _| {
            s.renew_scope();
            s.transcript_display.queue.suspend();
        });
        req.reply(204, json!(null)).await;
        wait_queue(&mut rt, "suspended edit settled into recovery slot", |s| {
            !s.transcript_display.queue.pending()
        })
        .await;
        assert_eq!(
            rt.state.draft.text, "",
            "suspended edit must not silently hijack an empty draft"
        );
        assert_eq!(
            rt.state.transcript_display.queue.saved_edit(),
            Some("Preserve me"),
            "suspended edit must be preserved in recovery slot"
        );

        // Even once authoritative inbox re-enables actions and draft is empty, a second Edit is blocked while saved_edit is populated.
        let (ev_tx, ev_rx) = bounded(4);
        rt.update(|s, _| s.incoming = Some(ev_rx));
        ev_tx
            .try_send(Event::Inbox {
                items: vec![queued("q2", Delivery::Queue, "Second queued")],
                authoritative: true,
                fence: None,
            })
            .unwrap();
        rt.update(|s, _| {
            assert!(crate::chat::events::poll_chat(s, 4));
        });
        settle(&mut rt);
        click(&mut rt, "queued-edit-q2");
        http.quiet().await;
        assert!(
            !rt.state.transcript_display.queue.pending(),
            "second Edit must be disabled while recovery slot holds a saved prompt"
        );

        // Typing into draft keeps Restore disabled so current draft cannot be overwritten.
        rt.update(|s, _| s.draft.replace_text("new draft"));
        settle(&mut rt);
        assert!(rt.find("queued-edit-recovery").is_some());
        assert!(rt.find("queued-edit-copy").is_some());
        assert!(rt.find("queued-edit-discard").is_some());
        click(&mut rt, "queued-edit-restore");
        assert_eq!(rt.state.draft.text, "new draft");
        assert_eq!(
            rt.state.transcript_display.queue.saved_edit(),
            Some("Preserve me")
        );

        // Clearing the draft enables Restore, which moves the saved prompt into the composer.
        rt.update(|s, _| s.draft.replace_text(""));
        settle(&mut rt);
        click(&mut rt, "queued-edit-restore");
        assert_eq!(rt.state.draft.text, "Preserve me");
        assert_eq!(rt.state.transcript_display.queue.saved_edit(), None);
    });
}

#[test]
fn non_editable_attachment_prompt_disables_edit_and_omits_download_and_committed_wins_overlap() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut s = crate::init();
        s.phase = Phase::Streaming;
        s.transcript_display.pictures.bind(http.backend.clone());
        s.messages = vec![
            user_row("m1", "Committed first"),
            user_row("m2", "Committed second"),
        ];
        let image_ref = crate::content::Reference {
            message: "q-att".into(),
            ordinal: 0,
            sha256: "a".repeat(64),
        };
        let attachment_item = QueuedPrompt {
            id: "q-att".into(),
            delivery: Delivery::Queue,
            text: "With file".into(),
            parts: vec![Part::File(crate::content::File {
                id: "f1".into(),
                reference: Some(image_ref.clone()),
                picture: Some(crate::content::PictureSource::Attachment(image_ref)),
                mime: "image/png".into(),
                name: Some("photo.png".into()),
            })],
            created: Some(2),
            editable: false,
        };
        let overlap_item = queued("m1", Delivery::Queue, "Stale pending copy");
        s.transcript_display.queue.fixture_set(
            Some(http.backend.clone()),
            vec![overlap_item, attachment_item.clone()],
        );
        let mut rt = runtime(s);

        // Deferred queued image renders as a metadata-only chip without an image view or HTTP fetch.
        assert!(rt.find("f1").is_some(), "metadata chip must render");
        assert!(
            rt.find("f1-image").is_none(),
            "deferred queued image must not mount an image view"
        );
        rt.update(|s, _| {
            let _ = s.transcript_display.pictures.poll(&s.reads, &s.wake);
        });
        http.quiet().await;

        // Committed row m1 takes precedence: no QUEUED badge or queue buttons for m1.
        assert!(rt.find("queued-badge-m1").is_none());
        assert!(rt.find("queued-delivery-m1").is_none());
        // Non-editable attachment prompt disables Edit and omits dead download button.
        click(&mut rt, "queued-edit-q-att");
        assert!(
            !rt.state.transcript_display.queue.pending(),
            "non-editable prompt must not dispatch Edit"
        );
        assert!(
            rt.find("download-f1").is_none(),
            "queued deferred attachment must not render a dead download button"
        );

        // Event::InboxFailed marks cached queue rows inert and emits an assertive live-region announcement.
        let (ev_tx, ev_rx) = bounded(4);
        rt.update(|s, _| s.incoming = Some(ev_rx));
        ev_tx.try_send(Event::InboxFailed).unwrap();
        rt.update(|s, tx| {
            assert!(crate::chat::events::poll_chat(s, 4));
            assert!(crate::strings::with_locale("en", || poll(s, tx)));
        });
        settle(&mut rt);
        let a11y = rt.accessibility_json();
        let has_assertive_announcer =
            a11y["children"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|node| {
                    node["role"] == "status"
                        && node["name"] == "Unable to update the prompt queue"
                        && node["states"]
                            .as_array()
                            .is_some_and(|states| states.iter().any(|s| s == "live-assertive"))
                });
        assert!(
            has_assertive_announcer,
            "Event::InboxFailed must emit an assertive live-region announcement: {a11y}"
        );
        assert!(rt.state.transcript_display.queue.is_stale());
        assert!(rt.state.transcript_display.queue.has_error());

        // A non-authoritative SSE delta must NOT clear staleness or re-enable cached actions.
        ev_tx
            .try_send(Event::Inbox {
                items: vec![attachment_item],
                authoritative: false,
                fence: None,
            })
            .unwrap();
        rt.update(|s, _| {
            let _ = crate::chat::events::poll_chat(s, 4);
        });
        settle(&mut rt);
        assert!(
            rt.state.transcript_display.queue.is_stale(),
            "non-authoritative SSE delta must not clear inbox staleness"
        );
        click(&mut rt, "queued-delivery-q-att");
        assert!(
            !rt.state.transcript_display.queue.pending(),
            "cached queue actions must remain inert until authoritative GET settles"
        );

        // An authoritative Event::Inbox whose fence was invalidated while queued must also be rejected.
        let inbox_rev = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(2));
        ev_tx
            .try_send(Event::Inbox {
                items: Vec::new(),
                authoritative: true,
                fence: Some(codenomad_client::inbox::InboxFence::from_revision(
                    inbox_rev.clone(),
                    1,
                )),
            })
            .unwrap();
        rt.update(|s, _| {
            let _ = crate::chat::events::poll_chat(s, 4);
        });
        settle(&mut rt);
        assert!(
            rt.state.transcript_display.queue.is_stale(),
            "queued authoritative snapshot invalidated by wire revision must be rejected"
        );
        assert!(
            !rt.state.transcript_display.queue.items().is_empty(),
            "rejected invalidated snapshot must not mutate cached queue"
        );

        // Authoritative empty Event::Inbox with current fence clears cached rows and stale error.
        ev_tx
            .try_send(Event::Inbox {
                items: Vec::new(),
                authoritative: true,
                fence: Some(codenomad_client::inbox::InboxFence::from_revision(
                    inbox_rev, 2,
                )),
            })
            .unwrap();
        rt.update(|s, _| {
            assert!(crate::chat::events::poll_chat(s, 4));
        });
        settle(&mut rt);
        assert!(!rt.state.transcript_display.queue.is_stale());
        assert!(rt.state.transcript_display.queue.items().is_empty());
        assert!(rt.find("queued-badge-q-att").is_none());
    });
}
