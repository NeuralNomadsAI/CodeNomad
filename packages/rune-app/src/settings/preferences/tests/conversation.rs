use super::*;
use crate::transport::{Command, Event, run_backend};
use codenomad_client::{Receiver, Sender, transport::WorkspaceEvent};
use std::sync::Arc;

mod observer;

async fn start(
    listener: &TcpListener,
    mut backend: Backend,
) -> (Request, Sender<Command>, Receiver<Event>) {
    backend.workspace = "project".into();
    backend.session = "session".into();
    let expected_identity = backend.client.tracks_server_attestation().then(|| {
        backend
            .client
            .server_identity()
            .unwrap_or("fixture-profile")
            .to_owned()
    });
    let (out, events) = bounded(16);
    let (commands, input) = bounded(4);
    platform::spawn(async move {
        run_backend(backend, out, input, Arc::new(|| {}))
            .await
            .unwrap();
    });
    if let Some(id) = expected_identity {
        let meta = request(listener).await;
        assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
        meta.reply(200, json!({"apiContract":1,"serverId":id}))
            .await;
    }
    let mut sse = request(listener).await;
    assert!(sse.first.starts_with("GET /api/events?"));
    sse.socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
        .await
        .unwrap();
    let page = request(listener).await;
    assert_eq!(
        page.body,
        json!({"sessionID":"session","target":{"kind":"latest"}})
    );
    page.reply(200, window(&["recent"], true)).await;
    let status = request(listener).await;
    assert_eq!(
        status.first,
        "GET /workspaces/project/instance/api/session/session HTTP/1.1"
    );
    status.reply(200, json!({"data":{}})).await;
    until(&events, |event| matches!(event, Event::Sync(_))).await;
    let inbox = request_raw(listener).await;
    assert_eq!(
        inbox.first,
        "GET /workspaces/project/instance/api/session/session/inbox HTTP/1.1"
    );
    inbox.reply(200, json!({"data":[]})).await;
    until(&events, |event| matches!(event, Event::Inbox { .. })).await;
    (sse, commands, events)
}

fn window(ids: &[&str], older: bool) -> Value {
    json!({
        "status":"window",
        "messages":ids.iter().map(|id| json!({"id":id,"type":"user","text":id})).collect::<Vec<_>>(),
        "older":older.then(|| json!({"kind":"before","messageID":"recent"})),
        "newer":null,"latest":true,
    })
}

async fn until(events: &Receiver<Event>, accept: impl Fn(&Event) -> bool) -> Event {
    timeout(Duration::from_secs(4), async {
        loop {
            let event = events.recv().await.unwrap();
            if accept(&event) {
                return event;
            }
        }
    })
    .await
    .unwrap()
}

#[test]
fn pagination_401_checks_authentication_without_replaying_the_page() {
    use codenomad_client::{
        recovery::{ReadingLane, demand},
        transport::run_backend_reading,
    };
    use std::sync::atomic::{AtomicU64, Ordering::SeqCst};

    platform::block_on(async {
        for (authenticated, suspend) in [(true, false), (false, false), (false, true)] {
            let (listener, mut prefs) = fixture().await;
            let backend = prefs.backend.as_mut().unwrap();
            backend.workspace = "project".into();
            backend.session = "session".into();
            attest(&listener, backend, "fixture-profile").await;
            let (reader, demand) = demand::open();
            let generation = reader.publish(Some(demand::Target::Around("recent".into())));
            let (out, events) = bounded(16);
            let (commands, input) = bounded(4);
            let (page_out, pages) = bounded(4);
            let connection = Arc::new(AtomicU64::new(0));
            let lane = ReadingLane {
                demand,
                events: page_out,
                connection: connection.clone(),
                on_session_deleted: None,
                revoked: Default::default(),
            };
            let backend = backend.clone();
            platform::spawn(async move {
                run_backend_reading(backend, out, input, Arc::new(|| {}), lane)
                    .await
                    .unwrap();
            });
            let meta = request(&listener).await;
            assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
            meta.reply(200, json!({"apiContract":1,"serverId":"fixture-profile"}))
                .await;
            let mut sse = request(&listener).await;
            assert!(sse.first.starts_with("GET /api/events?"));
            sse.socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            let seed = request(&listener).await;
            assert_eq!(
                seed.body["target"],
                json!({"kind":"around","messageID":"recent"})
            );
            seed.reply(200, window(&["recent"], true)).await;
            request(&listener)
                .await
                .reply(200, json!({"data":{}}))
                .await;
            let next_page = || async {
                timeout(Duration::from_secs(2), pages.recv())
                    .await
                    .unwrap()
                    .unwrap()
            };
            assert!(
                matches!(next_page().await, (g, 0, Event::ReaderSync { .. }) if g == generation)
            );
            commands.send(Command::Older).await.unwrap();
            let page = request(&listener).await;
            assert_eq!(
                page.body["target"],
                json!({"kind":"before","messageID":"recent"})
            );
            page.reply(401, json!({})).await;
            let mut status = request(&listener).await;
            assert_eq!(status.first, "GET /api/auth/status HTTP/1.1");
            if suspend {
                reader.publish(None);
                let closed = timeout(Duration::from_secs(2), status.socket.read_u8()).await;
                assert!(closed.is_ok_and(|read| read.is_err()));
            } else {
                status
                    .reply(200, json!({"authenticated":authenticated}))
                    .await;
            }
            if authenticated || suspend {
                if suspend {
                    assert!(pages.is_empty());
                    assert_eq!(connection.load(SeqCst), 0);
                } else {
                    assert!(matches!(
                        next_page().await,
                        (g, 0, Event::PagingFailed) if g == generation
                    ));
                }
                sse.socket
                    .write_all(b"event: codenomad.client.ping\ndata: {}\n\n")
                    .await
                    .unwrap();
                let pong = request(&listener).await;
                assert_eq!(pong.first, "POST /api/client-connections/pong HTTP/1.1");
                pong.reply(200, json!({})).await;
                assert!(
                    timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err()
                );
                commands.send(Command::Close).await.unwrap();
            } else {
                let auth = until(&events, |event| {
                    matches!(event, Event::AuthenticationRequired(_))
                })
                .await;
                let auth = match auth {
                    Event::AuthenticationRequired(auth) => auth,
                    other => panic!("unexpected pagination event: {other:?}"),
                };
                assert!(auth.confirmed && auth.backend.session == "session");
                assert_eq!(connection.load(SeqCst), 1);
                assert!(pages.is_empty());
                let closed = timeout(Duration::from_secs(2), sse.socket.read_u8())
                    .await
                    .unwrap()
                    .unwrap_err();
                assert!(matches!(
                    closed.kind(),
                    std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
                ));
                let mut root = crate::init();
                root.paging = true;
                *root.settings.shared.borrow_mut() = prefs;
                assert!(crate::settings::conversation_authentication(
                    &mut root, auth
                ));
                assert!(!root.paging);
                assert!(crate::chat::authentication::dialog(&root).is_some());
                assert!(
                    timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err()
                );
            }
        }
    });
}

#[test]
fn settings_config_invalidation_during_pagination_keeps_the_valid_history_page() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let (mut sse, commands, events) = start(&listener, prefs.backend.take().unwrap()).await;
        commands.send(Command::Older).await.unwrap();
        let page = request(&listener).await;
        assert_eq!(
            page.body["target"],
            json!({"kind":"before","messageID":"recent"})
        );

        // The pong is a barrier: dispatch has handled the config frame before the page answers.
        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n\
            event: codenomad.client.ping\ndata: {}\n\n",
            )
            .await
            .unwrap();
        let pong = request(&listener).await;
        assert_eq!(pong.first, "POST /api/client-connections/pong HTTP/1.1");
        pong.reply(200, json!({})).await;
        page.reply(200, window(&["earlier", "recent"], false)).await;

        let mut seen = (false, false, false);
        while seen != (true, true, true) {
            match until(&events, |_| true).await {
                Event::Preferences(Owner::Config) => seen.0 = true,
                Event::Workspace(WorkspaceEvent::UiPreferencesChanged) => seen.1 = true,
                Event::Older(page) => {
                    assert_eq!(page.rows[0].id, "earlier");
                    seen.2 = true;
                }
                other => panic!("unexpected event during pagination: {other:?}"),
            }
        }
        commands.send(Command::Close).await.unwrap();
    });
}

#[test]
fn settings_failed_prompt_keeps_one_sse_subscription_and_one_config_read() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.take().unwrap();
        let (mut sse, commands, events) = start(&listener, backend.clone()).await;
        commands
            .send(Command::Prompt(codenomad_client::prompt::Prompt {
                id: Some("fixture-message".into()),
                text: "fixture".into(),
                ..Default::default()
            }))
            .await
            .unwrap();
        let mut prompt = request(&listener).await;
        assert_eq!(
            prompt.first,
            "POST /workspaces/project/instance/api/session/session/prompt HTTP/1.1"
        );
        prompt
            .reply_with_headers(400, json!({}), "x-codenomad-before-dispatch: 1\r\n")
            .await;
        until(&events, |event| {
            matches!(
                event,
                Event::PromptAcknowledged {
                    outcome: crate::transport::PromptOutcome::Rejected,
                    ..
                }
            )
        })
        .await;

        let mut root = crate::init();
        prefs.backend = Some(backend);
        *root.settings.shared.borrow_mut() = prefs;
        root.phase = crate::Phase::Failed;
        root.incoming = Some(events);
        super::super::super::poll(&mut root, &mut rune::Tx::default());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "prompt failure must not open a fallback stream"
        );

        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| {
            let changed = crate::poll_chat(&mut root, 8);
            super::super::super::poll(&mut root, &mut rune::Tx::default());
            changed
        })
        .await;
        let read = request(&listener).await;
        assert_eq!(
            read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        read.reply(200, json!({"settings":{"locale":"fr"}})).await;
        wait_until(|| {
            super::super::super::poll(&mut root, &mut rune::Tx::default());
            root.settings.shared.borrow().locale() == Some("fr")
        })
        .await;
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        commands.send(Command::Close).await.unwrap();
    });
}

#[test]
fn settings_direct_retry_replaces_a_closed_transport() {
    let (out, incoming) = bounded::<Event>(1);
    let mut root = crate::init();
    root.phase = crate::Phase::Failed;
    root.incoming = Some(incoming.clone());
    drop(out);

    let mut runtime = rune::Runtime::new(
        root,
        crate::view,
        (1100.0, 760.0),
        rune::Env::new(false, 1.0),
    );
    runtime.update(crate::retry_connection);
    assert!(runtime.state.phase == crate::Phase::Reconnecting);
    assert!(
        !runtime
            .state
            .incoming
            .as_ref()
            .unwrap()
            .same_channel(&incoming)
    );
}

#[test]
fn settings_sse_401_releases_the_transport_for_explicit_authentication() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let (out, events) = bounded(16);
        let (_commands, input) = bounded(1);
        platform::spawn(async move {
            run_backend(prefs.backend.take().unwrap(), out, input, Arc::new(|| {}))
                .await
                .unwrap();
        });
        let sse = request(&listener).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.reply(401, json!({})).await;
        until(&events, |event| {
            matches!(event, Event::AuthenticationRequired(..))
        })
        .await;
        assert!(
            timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap()
                .is_err()
        );
        assert!(
            timeout(Duration::from_millis(600), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn retry_remains_available_when_the_terminal_reader_closes_after_the_gesture() {
    let mut root = crate::init();
    root.phase = crate::Phase::Failed;
    let (commands, input) = bounded(1);
    let (events, incoming) = bounded::<Event>(1);
    root.commands = Some(commands);
    root.incoming = Some(incoming);
    let mut runtime = rune::Runtime::new(
        root,
        crate::view,
        (1100.0, 760.0),
        rune::Env::new(false, 1.0),
    );
    runtime.update(crate::retry_connection);
    assert!(runtime.state.phase == crate::Phase::Reconnecting);
    assert!(matches!(input.try_recv(), Ok(Command::Retry)));
    drop(input);
    drop(events);
    runtime.update(|s, _| {
        assert!(crate::poll_chat(s, 8));
    });
    assert!(runtime.state.phase == crate::Phase::Failed);
}

#[test]
fn settings_terminal_transport_close_restores_an_unsettled_prompt_before_retry() {
    let mut root = crate::init();
    root.draft = rune::edit::TextEdit::new("keep queued text");
    root.phase = crate::Phase::Ready;
    let (commands, input) = bounded(1);
    let (events, incoming) = bounded(1);
    root.commands = Some(commands);
    root.incoming = Some(incoming);
    let mut runtime = rune::Runtime::new(
        root,
        crate::view,
        (1100.0, 760.0),
        rune::Env::new(false, 1.0),
    );
    runtime.update(crate::send);
    assert!(runtime.state.draft.text.is_empty());
    events.try_send(Event::Failed).unwrap();
    runtime.update(crate::retry_connection);
    assert_eq!(
        runtime.state.composer.pending_text(),
        Some("keep queued text")
    );
    drop(input);
    drop(events);
    runtime.update(|s, _| {
        assert!(crate::poll_chat(s, 8));
    });
    assert_eq!(runtime.state.draft.text, "keep queued text");
    assert!(!runtime.state.composer.pending());
    assert!(runtime.state.composer.unconfirmed_id().is_some());
}

#[test]
fn settings_direct_authentication_accepts_a_rotated_password_and_keeps_the_draft() {
    assert_direct_recovery(Some(401));
}

#[test]
fn an_unmarked_native_command_401_with_a_live_backend_session_has_one_unconfirmed_receipt_and_no_relogin()
 {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let (_sse, commands, events) = start(&listener, prefs.backend.take().unwrap()).await;
        commands
            .send(Command::Slash {
                attempt: "fixture-attempt".into(),
                name: "review".into(),
                text: "fixture".into(),
            })
            .await
            .unwrap();
        let command = request(&listener).await;
        assert!(command.first.ends_with("/session/command HTTP/1.1"));
        command.reply(401, json!({})).await;
        let status = request(&listener).await;
        assert_eq!(status.first, "GET /api/auth/status HTTP/1.1");
        status.reply(200, json!({"authenticated":true})).await;
        assert!(
            matches!(until(&events, |_| true).await, Event::PromptAcknowledged {
            attempted, outcome: crate::transport::PromptOutcome::Unconfirmed,
        } if attempted == "fixture-attempt")
        );
        assert!(
            timeout(Duration::from_millis(100), events.recv())
                .await
                .is_err()
        );
        commands.send(Command::Close).await.unwrap();
    });
}

#[test]
fn retry_waits_for_the_opening_stream_to_report_authentication() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let (stream, commands, events) = start(&listener, prefs.backend.take().unwrap()).await;
        drop(stream);
        let opening = request(&listener).await;
        assert!(opening.first.starts_with("GET /api/events?"));
        commands.send(Command::Retry).await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        opening.reply(401, json!({})).await;
        until(&events, |event| {
            matches!(event, Event::AuthenticationRequired(_))
        })
        .await;
    });
}

#[test]
fn settings_send_during_a_stream_outage_keeps_unconfirmed_lock_and_draft() {
    assert_direct_recovery(None);
}

#[test]
fn settings_rotation_conflict_restores_the_draft_without_replaying() {
    assert_direct_recovery(Some(409));
}

fn assert_direct_recovery(prompt_reply: Option<u16>) {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let mut backend = prefs.backend.take().unwrap();
        backend.workspace = "project".into();
        backend.session = "session".into();
        attest(&listener, &backend, "fixture-profile").await;
        let (stream, commands, events) = start(&listener, backend.clone()).await;
        let mut stream = Some(stream);
        let mut root = crate::init();
        prefs.backend = Some(backend);
        *root.settings.shared.borrow_mut() = prefs;
        root.draft = rune::edit::TextEdit::new("refused prompt");
        root.phase = crate::Phase::Ready;
        root.commands = Some(commands);
        root.incoming = Some(events);
        let mut runtime = rune::Runtime::new(
            root,
            crate::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        let reconnect = if prompt_reply.is_none() {
            drop(stream.take());
            let meta = request(&listener).await;
            assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
            meta.reply(200, json!({"apiContract":1,"serverId":"fixture-profile"}))
                .await;
            let reconnect = request(&listener).await;
            assert!(reconnect.first.starts_with("GET /api/events?"));
            wait_until(|| {
                runtime.update(|s, _| {
                    crate::poll_chat(s, 8);
                });
                matches!(
                    runtime.state.phase,
                    crate::Phase::StreamDisconnected { running: false }
                )
            })
            .await;
            assert!(crate::composer::can_send(&runtime.state));
            Some(reconnect)
        } else {
            None
        };
        runtime.update(crate::send);
        assert!(runtime.state.draft.text.is_empty());
        runtime.paste("a different draft");
        runtime.frame(0.02);
        assert!(runtime.state.draft.text.is_empty());
        if let Some(reconnect) = reconnect {
            let prompt = request(&listener).await;
            assert_eq!(
                prompt.first,
                "POST /workspaces/project/instance/api/session/session/prompt HTTP/1.1"
            );
            assert_eq!(prompt.body["text"], "refused prompt");
            prompt.reply(401, json!({})).await;
            let status = request(&listener).await;
            assert_eq!(status.first, "GET /api/auth/status HTTP/1.1");
            status.reply(200, json!({"authenticated":false})).await;
            reconnect.reply(401, json!({})).await;
        } else {
            let mut prompt = request(&listener).await;
            assert_eq!(
                prompt.first,
                "POST /workspaces/project/instance/api/session/session/prompt HTTP/1.1"
            );
            assert_eq!(prompt.body["text"], "refused prompt");
            let status = prompt_reply.unwrap();
            if status == 409 {
                prompt
                    .reply_with_headers(status, json!({}), "x-codenomad-before-dispatch: 1\r\n")
                    .await;
            } else {
                prompt.reply(status, json!({})).await;
            }
            if prompt_reply == Some(401) {
                let status = request(&listener).await;
                assert_eq!(status.first, "GET /api/auth/status HTTP/1.1");
                status.reply(200, json!({"authenticated":false})).await;
            }
        }
        if prompt_reply == Some(409) {
            wait_until(|| {
                runtime.update(|s, _| {
                    crate::poll_chat(s, 8);
                });
                runtime.state.draft.text == "refused prompt" && !runtime.state.composer.pending()
            })
            .await;
            assert_eq!(runtime.state.draft.text, "refused prompt");
            drop(stream.take());
            let meta = request(&listener).await;
            assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
            meta.reply(200, json!({"apiContract":1,"serverId":"fixture-profile"}))
                .await;
            let reconnect = request(&listener).await;
            assert!(reconnect.first.starts_with("GET /api/events?"));
            reconnect.reply(401, json!({})).await;
        }
        wait_until(|| {
            runtime.update(|s, _| {
                crate::poll_chat(s, 8);
            });
            runtime.state.phase == crate::Phase::Failed && runtime.state.commands.is_none()
        })
        .await;
        if let Some(mut stream) = stream {
            let closure = timeout(Duration::from_secs(2), stream.socket.read(&mut [0]))
                .await
                .unwrap();
            assert!(
                matches!(closure, Ok(0))
                    || closure
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset)
            );
        }
        if prompt_reply == Some(409) {
            let status = request(&listener).await;
            assert_eq!(status.first, "GET /api/auth/status HTTP/1.1");
            status.reply(200, json!({"authenticated":false})).await;
        }

        let update = |runtime: &mut rune::Runtime<crate::State>| {
            runtime.update(|s, _| {
                crate::chat::authentication::poll(s);
            });
            runtime.frame(0.02);
        };
        wait_until(|| {
            update(&mut runtime);
            runtime.find("direct-recovery-password").is_some()
        })
        .await;
        let (x, y) = runtime.find("direct-recovery-username").unwrap();
        runtime.pointer_down(x, y);
        runtime.pointer_up(x, y);
        runtime.frame(0.02);
        runtime.key(rune::KeyEvent {
            key: rune::Key::Home,
            mods: Default::default(),
        });
        runtime.paste(" operator-");
        runtime.frame(0.02);
        for password in ["old-fixture-password", "new-fixture-password"] {
            let (x, y) = runtime.find("direct-recovery-password").unwrap();
            runtime.pointer_down(x, y);
            runtime.pointer_up(x, y);
            runtime.frame(0.02);
            runtime.paste(password);
            runtime.frame(0.02);
            let (x, y) = runtime.find("direct-recovery-sign-in").unwrap();
            runtime.pointer_down(x, y);
            runtime.pointer_up(x, y);
            runtime.frame(0.02);
            let mut login = request(&listener).await;
            assert_eq!(login.first, "POST /api/auth/login HTTP/1.1");
            assert_eq!(login.body["password"], password);
            assert_eq!(login.body["username"], " operator-codenomad");
            if password.starts_with("old") {
                login.reply(401, json!({})).await;
                wait_until(|| {
                    update(&mut runtime);
                    runtime.find("direct-recovery-error").is_some()
                })
                .await;
                assert!(runtime.state.direct_authentication.password.text.is_empty());
            } else {
                login
                    .reply_with_headers(
                        200,
                        json!({"ok":true}),
                        "Set-Cookie: fixture=renewed; Path=/; HttpOnly\r\n",
                    )
                    .await;
            }
        }
        let mut identity = request(&listener).await;
        if prompt_reply.is_none() {
            assert_eq!(identity.first, "GET /api/meta HTTP/1.1");
            identity.reply(503, json!({})).await;
            wait_until(|| {
                update(&mut runtime);
                runtime.find("direct-recovery-error").is_some()
            })
            .await;
            let (x, y) = runtime.find("direct-recovery-check").unwrap();
            runtime.pointer_down(x, y);
            runtime.pointer_up(x, y);
            runtime.frame(0.02);
            let status = request(&listener).await;
            assert_eq!(status.first, "GET /api/auth/status HTTP/1.1");
            assert!(
                status
                    .headers
                    .to_ascii_lowercase()
                    .contains("\r\ncookie: fixture=renewed\r\n")
            );
            status.reply(200, json!({"authenticated":true})).await;
            identity = request(&listener).await;
        }
        assert_eq!(identity.first, "GET /api/meta HTTP/1.1");
        assert!(
            identity
                .headers
                .to_ascii_lowercase()
                .contains("\r\ncookie: fixture=renewed\r\n")
        );
        identity
            .reply(200, json!({"apiContract":1,"serverId":"fixture-profile"}))
            .await;
        let placement = request(&listener).await;
        assert_eq!(
            placement.first,
            "GET /workspaces/project/instance/api/session/session HTTP/1.1"
        );
        assert!(
            placement
                .headers
                .to_ascii_lowercase()
                .contains("\r\ncookie: fixture=renewed\r\n")
        );
        placement
            .reply(
                200,
                json!({"data":{"id":"session","location":{"directory":"/project"}}}),
            )
            .await;
        wait_until(|| {
            update(&mut runtime);
            runtime.state.phase == crate::Phase::Reconnecting
        })
        .await;
        assert_eq!(
            crate::settings::bound_backend(&runtime.state)
                .and_then(|backend| backend.session_directory)
                .as_deref(),
            Some("/project")
        );
        assert!(runtime.find("direct-recovery-dialog").is_none());
        assert_eq!(runtime.state.draft.text, "refused prompt");
        let resumed_meta = request(&listener).await;
        assert_eq!(resumed_meta.first, "GET /api/meta HTTP/1.1");
        resumed_meta
            .reply(200, json!({"apiContract":1,"serverId":"fixture-profile"}))
            .await;
        let mut resumed = request(&listener).await;
        assert!(resumed.first.starts_with("GET /api/events?"));
        assert!(
            resumed
                .headers
                .to_ascii_lowercase()
                .contains("\r\ncookie: fixture=renewed\r\n")
        );
        resumed
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let history = request(&listener).await;
        assert_eq!(
            history.body,
            json!({"sessionID":"session","target":{"kind":"latest"}})
        );
        history.reply(200, window(&["recent"], false)).await;
        let status = request(&listener).await;
        assert_eq!(
            status.first,
            "GET /workspaces/project/instance/api/session/session HTTP/1.1"
        );
        status.reply(200, json!({"data":{}})).await;
        wait_until(|| {
            runtime.update(|s, _| {
                crate::poll_chat(s, 8);
            });
            runtime.state.phase == crate::Phase::Ready
        })
        .await;
        assert_eq!(runtime.state.draft.text, "refused prompt");
        assert_eq!(runtime.state.messages[0].id, "recent");
        if prompt_reply.is_none() || prompt_reply == Some(401) {
            assert!(
                runtime.state.composer.unconfirmed_id().is_some(),
                "unmarked 401 prompt must keep its unconfirmed lock when Sync omits the attempted ID"
            );
        }
    });
}

#[test]
fn settings_renewed_connection_authenticates_git_reads_with_the_new_cookie() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let mut previous = prefs.backend.take().unwrap();
        previous.workspace = "project".into();
        previous.session = "session".into();
        attest(&listener, &previous, "fixture-profile").await;
        let mut renewed = Backend::unauthenticated(&previous.base).unwrap();
        renewed.workspace.clone_from(&previous.workspace);
        renewed.session.clone_from(&previous.session);
        let login = renewed.clone();
        let (signed_in, receipt) = bounded(1);
        platform::spawn(async move {
            signed_in
                .send(login.sign_in("operator", "new-fixture-password").await)
                .await
                .unwrap();
        });
        request(&listener)
            .await
            .reply_with_headers(
                200,
                json!({"ok":true}),
                "Set-Cookie: fixture=renewed; Path=/\r\n",
            )
            .await;
        receipt.recv().await.unwrap().unwrap();
        attest(&listener, &renewed, "fixture-profile").await;
        let mut root = crate::init();
        crate::git::connected(&mut root, &previous);
        crate::git::set_mode(&mut root, crate::git::Mode::History);
        crate::git::connected(&mut root, &renewed);
        assert!(crate::git::mode(&root) == crate::git::Mode::History);
        crate::git::show(&mut root, true);
        crate::git::online(&mut root, true);
        for _ in 0..2 {
            let read = request(&listener).await;
            assert!(read.first.starts_with("GET "));
            assert!(
                read.headers
                    .to_ascii_lowercase()
                    .contains("\r\ncookie: fixture=renewed\r\n")
            );
            read.reply(503, json!({})).await;
        }
    });
}

#[test]
fn closing_project_without_conversation_uses_the_renewed_cookie() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let previous = prefs.backend.take().unwrap();
        attest(&listener, &previous, "fixture-profile").await;
        let renewed = Backend::unauthenticated(&previous.base).unwrap();
        let login = renewed.clone();
        let (signed_in, receipt) = bounded(1);
        platform::spawn(async move {
            signed_in
                .send(login.sign_in("operator", "new-fixture-password").await)
                .await
                .unwrap();
        });
        request(&listener)
            .await
            .reply_with_headers(200, json!({}), "Set-Cookie: fixture=renewed; Path=/\r\n")
            .await;
        receipt.recv().await.unwrap().unwrap();
        attest(&listener, &renewed, "fixture-profile").await;
        let mut root = crate::init();
        let mut launcher = crate::launcher::Launcher::fixture();
        let project = crate::catalog::Project {
            id: "project".into(),
            path: "C:/fixture".into(),
            temporary: false,
        };
        launcher.project = Some(project.clone());
        launcher.connection = Some(previous);
        launcher.server_id = Some("fixture-profile".into());
        root.screen = crate::Screen::Launcher(launcher);
        root.workspace = Some(crate::workspace::Ui::new());
        crate::workspace::opened(&mut root, &project);
        let key = root.workspace.as_ref().unwrap().active_key().to_owned();
        root.screen.launcher_mut().unwrap().connection = Some(renewed);
        crate::workspace::connected(&mut root);
        crate::workspace::renew_connection(&mut root);
        let mut runtime = rune::Runtime::new(
            root,
            crate::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        runtime.update(|s, tx| crate::workspace::close(s, &key, tx));
        let close = request(&listener).await;
        assert_eq!(close.first, "DELETE /api/workspaces/project HTTP/1.1");
        assert!(
            close
                .headers
                .to_ascii_lowercase()
                .contains("\r\ncookie: fixture=renewed\r\n")
        );
        close.reply(200, json!({})).await;
    });
}

#[test]
fn settings_stale_401_does_not_displace_the_current_connection() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_ref().unwrap();
        let expired = Backend::unauthenticated(&backend.base).unwrap();
        let mut root = crate::init();
        *root.settings.shared.borrow_mut() = std::mem::take(&mut prefs);
        root.phase = crate::Phase::Ready;
        let (out, events) = bounded(1);
        root.incoming = Some(events);
        out.send(Event::authentication_required(expired))
            .await
            .unwrap();
        crate::poll_chat(&mut root, 1);
        assert!(root.phase == crate::Phase::Ready);
        assert!(!crate::chat::authentication::retry(&mut root));
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn settings_initial_direct_login_401_requests_confirmation_instead_of_replaying_credentials() {
    assert_initial_direct_confirmation(false);
}

#[test]
fn settings_initial_direct_attestation_401_requests_confirmation_before_binding() {
    assert_initial_direct_confirmation(true);
}

fn assert_initial_direct_confirmation(after_login: bool) {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let mut target = prefs.backend.take().unwrap();
        target.workspace = "project".into();
        target.session = "session".into();
        let (out, events) = bounded(2);
        let (_commands, incoming) = bounded(1);
        platform::spawn(async move {
            crate::transport::authenticate_and_run(
                target,
                "expired-fixture".into(),
                None,
                out,
                incoming,
                Arc::new(|| {}),
            )
            .await;
        });
        let login = request(&listener).await;
        assert_eq!(login.first, "POST /api/auth/login HTTP/1.1");
        if after_login {
            login.reply(200, json!({})).await;
            let meta = request(&listener).await;
            assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
            meta.reply(401, json!({})).await;
        } else {
            login.reply(401, json!({})).await;
        }
        let mut root = crate::init();
        root.incoming = Some(events);
        wait_until(|| {
            crate::poll_chat(&mut root, 8);
            root.phase == crate::Phase::Failed
        })
        .await;
        assert!(crate::settings::bound_backend(&root).is_none());
        let status = request(&listener).await;
        assert_eq!(status.first, "GET /api/auth/status HTTP/1.1");
        status.reply(200, json!({"authenticated":false})).await;
        wait_until(|| crate::chat::authentication::poll(&mut root)).await;
        assert!(crate::chat::authentication::dialog(&root).is_some());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn settings_launcher_retry_accepts_password_with_project_open() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.take().unwrap();
        let mut root = crate::init();
        let mut launcher = crate::launcher::Launcher::fixture();
        launcher.project = Some(crate::catalog::Project {
            id: "project".into(),
            path: "C:/fixture".into(),
            temporary: false,
        });
        launcher.connection = Some(backend.clone());
        root.screen = crate::Screen::Chat {
            launcher: Some(launcher),
        };
        let (out, incoming) = bounded(2);
        root.incoming = Some(incoming);
        out.send(Event::authentication_required(backend))
            .await
            .unwrap();
        crate::poll_chat(&mut root, 2);

        let mut runtime = rune::Runtime::new(
            root,
            crate::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        runtime.update(crate::retry_connection);
        runtime.frame(0.0);
        let (x, y) = runtime.find("server-password").unwrap();
        runtime.pointer_down(x, y);
        runtime.pointer_up(x, y);
        runtime.frame(0.02);
        runtime.paste("isolated-fixture-password");
        runtime.frame(0.02);
        assert_eq!(
            runtime.state.screen.launcher().unwrap().password.text,
            "isolated-fixture-password"
        );
        runtime.update(crate::launcher::connect);
        let request = request(&listener).await;
        assert_eq!(request.first, "POST /api/auth/login HTTP/1.1");
        assert_eq!(request.body["password"], "isolated-fixture-password");
        request.reply(503, json!({})).await;
    });
}
