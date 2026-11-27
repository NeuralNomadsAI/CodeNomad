use super::super::*;

#[test]
fn independent_row_sends_after_row_failure_flush_revalidates_held_patch_and_hidden_drop_allows_active_save()
 {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    // 1. Failing one transcript row must NOT block editing and saving another independent row.
    let (listener1, mut prefs1) = platform::block_on(fixture());
    platform::block_on(async {
        prefs1.set_transcript(Some(Row::Groups), "hidden");
        assert!(prefs1.poll());
        let failed = request(&listener1).await;
        assert_eq!(
            failed.body,
            json!({"settings":{"toolGroupVisibility":"hidden"}})
        );
        failed.reply(503, json!({})).await;
        let readback = request(&listener1).await;
        readback
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        wait_until(|| {
            prefs1.poll();
            prefs1.transcript_error().is_some()
        })
        .await;
        prefs1.set_transcript(Some(Row::Diagnostics), "hidden");
        assert!(prefs1.poll());
        let other_row = poll_next_request(&mut prefs1, &listener1).await;
        assert_eq!(other_row.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            other_row.body,
            json!({"settings":{"diagnosticsExpansion":"hidden"}})
        );
        other_row
            .reply(
                200,
                json!({"settings":{"locale":"en","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        wait_until(|| {
            prefs1.poll();
            prefs1.transcript_mode(Row::Diagnostics, false) == "hidden"
        })
        .await;
        assert!(
            prefs1.transcript_error().is_some(),
            "earlier failed row must stay visible for Retry"
        );
    });

    // 2. flush() with the ONLY pending choice held in flight before send, when active SSE drops,
    // must revalidate and persist the choice rather than abandoning it.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    let mut tab2 = prefs2.backend.clone().unwrap();
    tab2.client_id.push_str("-flush-held");
    tab2.workspace = "project".into();
    tab2.session = "session".into();
    let tab2_id = tab2.client_id.clone();
    prefs2.observe_conversation_clients(&[(tab2_id.clone(), true)]);
    let (out2, events2) = bounded(16);
    let (commands2, input2) = bounded(4);
    let drop_client2 = prefs2.backend.as_ref().unwrap().client.clone();
    let (release_tx, release_rx) = bounded(1);
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab2, out2, input2, Arc::new(|| {})).await;
        });
        let mut sse2 = request(&listener2).await;
        sse2.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener2)
            .await
            .reply(
                200,
                json!({
                    "status":"window",
                    "messages":[{"id":"recent","type":"user","text":"recent"}],
                    "older":null,"newer":null,"latest":true
                }),
            )
            .await;
        request(&listener2)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events2.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        prefs2.config.set_pre_patch_gate(release_rx);
        prefs2.set_transcript(Some(Row::Groups), "hidden");
        assert!(prefs2.poll());
        drop(sse2);
        timeout(Duration::from_secs(4), async {
            while drop_client2.transport_drops(&tab2_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    });
    let server_thread = std::thread::spawn(move || {
        platform::block_on(async move {
            let _ = release_tx.send(()).await;
            let mut got_get = false;
            let mut got_patch = false;
            let mut _reconnects = Vec::new();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !(got_get && got_patch) {
                assert!(
                    std::time::Instant::now() < deadline,
                    "flush must revalidate and send the skipped in-flight write"
                );
                let req = request(&listener2).await;
                if req.first.starts_with("GET /api/events?") {
                    _reconnects.push(req);
                } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    let hold_until = std::time::Instant::now() + Duration::from_millis(30);
                    while std::time::Instant::now() < hold_until {
                        if let Ok(accepted) =
                            timeout(Duration::from_millis(5), listener2.accept()).await
                        {
                            let (socket, _) = accepted.unwrap();
                            let concurrent = read_request(socket, Duration::from_secs(3)).await;
                            assert_ne!(
                                concurrent.first, "PATCH /api/storage/config/ui HTTP/1.1",
                                "flush() must not dispatch PATCH while revalidation GET is open"
                            );
                            if concurrent.first.starts_with("GET /api/events?") {
                                _reconnects.push(concurrent);
                            } else if concurrent.first
                                == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
                            {
                                concurrent
                                    .reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                                    .await;
                            }
                        }
                    }
                    got_get = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                    req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                        .await;
                } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                    assert!(got_get, "revalidation GET must precede skipped write");
                    assert_eq!(
                        req.body,
                        json!({"settings":{"toolGroupVisibility":"hidden"}})
                    );
                    got_patch = true;
                    req.reply(
                        200,
                        json!({"settings":{"locale":"en","toolGroupVisibility":"hidden"}}),
                    )
                    .await;
                }
            }
            let _ = commands2.send(Command::Close).await;
        });
    });
    assert!(
        prefs2.flush(),
        "flush() must revalidate and persist a held in-flight write after active SSE drop"
    );
    server_thread.join().unwrap();

    // 3. With a live active Tab A SSE stream, Tab B shares that single /api/events stream;
    // closing hidden Tab B voluntarily keeps Tab A's shared SSE open without bumping global
    // drop_gen, and Tab A saves cleanly.
    let (listener3, mut prefs3) = platform::block_on(fixture_atomic());
    let mut tab_a = prefs3.backend.clone().unwrap();
    tab_a.client_id.push_str("-active-a");
    tab_a.workspace = "project".into();
    tab_a.session = "session-a".into();
    let mut tab_b = prefs3.backend.clone().unwrap();
    tab_b.client_id.push_str("-hidden-b");
    tab_b.workspace = "project".into();
    tab_b.session = "session-b".into();
    let tab_a_id = tab_a.client_id.clone();
    prefs3.observe_conversation_clients(&[(tab_a_id.clone(), true)]);
    let (out_a, events_a) = bounded(16);
    let (commands_a, input_a) = bounded(4);
    let (out_b, events_b) = bounded(16);
    let (commands_b, input_b) = bounded(4);
    let client3 = prefs3.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, input_a, Arc::new(|| {})).await;
        });
        let meta_a = request(&listener3).await;
        assert_eq!(meta_a.first, "GET /api/meta HTTP/1.1");
        meta_a
            .reply(
                200,
                json!({"apiContract":1,"serverId":"fixture-b3","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        let mut sse_a = request(&listener3).await;
        assert!(
            sse_a.first.starts_with("GET /api/events?"),
            "expected initial shared SSE open, got {}",
            sse_a.first
        );
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener3)
            .await
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener3).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(
                200,
                json!({"apiContract":1,"serverId":"fixture-b3","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        // Tab B reuses Tab A's physical /api/events stream and proceeds directly to HTTP sync.
        let history_b = request(&listener3).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "second tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        let _ = commands_b.send(Command::Close).await;
        timeout(Duration::from_secs(4), async {
            while events_b.recv().await.is_ok() {}
        })
        .await
        .unwrap();
        assert!(
            !client3.needs_capability_recheck(),
            "closing hidden Tab B while active Tab A SSE is open must not trigger global capability recheck"
        );
        prefs3.set_transcript(Some(Row::Groups), "hidden");
        assert!(prefs3.poll());
        let mut saved = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !saved {
            assert!(
                std::time::Instant::now() < deadline,
                "active Tab A must save cleanly while shared SSE remains open"
            );
            let req = poll_next_request(&mut prefs3, &listener3).await;
            if req.first == "GET /api/meta HTTP/1.1" {
                req.reply(
                    200,
                    json!({"apiContract":1,"serverId":"fixture-b3","capabilities":["settings-atomic-patches"]}),
                )
                .await;
            } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                assert_eq!(
                    req.body,
                    json!({"settings":{"toolGroupVisibility":"hidden"}})
                );
                req.reply(
                    200,
                    json!({"settings":{"locale":"en","toolGroupVisibility":"hidden"}}),
                )
                .await;
                saved = true;
            } else {
                panic!(
                    "unexpected request while shared SSE stays open: {}",
                    req.first
                );
            }
        }
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_mode(Row::Groups, false) == "hidden"
        })
        .await;
        let _ = commands_a.send(Command::Close).await;
        drop(sse_a);
    });
}

#[test]
fn tab_switch_after_active_sse_drop_still_reattests_server_before_revalidation() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    let (listener, mut prefs) = platform::block_on(fixture());
    let base = prefs.backend.clone().unwrap();
    let mut tab_a = base.clone();
    tab_a.client_id.push_str("-active-a");
    tab_a.workspace = "project".into();
    tab_a.session = "session-a".into();
    let mut tab_b = base.clone();
    tab_b.client_id.push_str("-sibling-b");
    tab_b.workspace = "project".into();
    tab_b.session = "session-b".into();
    let tab_a_id = tab_a.client_id.clone();
    let tab_b_id = tab_b.client_id.clone();
    let client = base.client.clone();
    platform::block_on(async {
        attest(&listener, &base, "server-a").await;
        prefs.observe_conversation_clients(&[(tab_a_id.clone(), true)]);
        let (out_a, events_a) = bounded(16);
        let (commands_a, input_a) = bounded(4);
        let (out_b, events_b) = bounded(16);
        let (commands_b, input_b) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, input_a, Arc::new(|| {})).await;
        });
        let meta_a = request(&listener).await;
        assert_eq!(meta_a.first, "GET /api/meta HTTP/1.1");
        meta_a
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let mut sse_a = request(&listener).await;
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener)
            .await
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let history_b = request(&listener).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "sibling tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }

        // Drop the shared SSE stream, then switch directly to sibling tab B BEFORE calling
        // prefs.poll(): it must still observe the drop, disable Chat, and force /api/meta
        // re-attestation before any GET or PATCH.
        drop(sse_a);
        timeout(Duration::from_secs(4), async {
            while client.transport_drops(&tab_a_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();

        prefs.observe_conversation_clients(&[(tab_b_id.clone(), true)]);
        assert!(
            !prefs.transcript_ready(),
            "switching away from a dropped tab before poll must still disable Chat"
        );
        prefs.revalidate_transport();
        let mut _reconnects = Vec::new();
        let mut saw_meta = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !saw_meta {
            assert!(
                std::time::Instant::now() < deadline,
                "revalidation after switching to sibling tab must call /api/meta"
            );
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
            } else if req.first == "GET /api/meta HTTP/1.1" {
                saw_meta = true;
                req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                    .await;
            } else {
                panic!(
                    "must not read or write preferences before /api/meta re-attestation, got: {}",
                    req.first
                );
            }
        }
        // Mismatched serverId ("server-b" != "server-a") must keep preferences unconfirmed and
        // never issue GET /api/storage/config/ui.
        let check_until = std::time::Instant::now() + Duration::from_millis(80);
        while std::time::Instant::now() < check_until {
            prefs.poll();
            if let Ok(req) = timeout(Duration::from_millis(10), request(&listener)).await {
                if req.first.starts_with("GET /api/events?") {
                    _reconnects.push(req);
                } else if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                        .await;
                } else {
                    panic!(
                        "mismatched serverId must block config readback, got: {}",
                        req.first
                    );
                }
            }
        }
        assert!(
            !prefs.transcript_ready(),
            "mismatched serverId after tab switch must not re-enable Chat"
        );
        let _ = commands_a.send(Command::Close).await;
        let _ = commands_b.send(Command::Close).await;
    });
}

#[test]
fn hidden_connected_event_does_not_overwrite_healthy_active_tab_or_custom_preset_display() {
    // 1. Custom saved preset matching Balanced except Diagnostics stays "custom" while
    // Diagnostics is edited back to "expanded" (matching Solid's selectedPreset).
    let mut custom_prefs = Preferences::default();
    custom_prefs.fixture_transcript(json!({
        "toolGroupVisibility": "collapsed",
        "systemMessagesVisibility": "hidden",
        "showThinkingBlocks": false,
        "diagnosticsExpansion": "collapsed",
        "toolInputsVisibility": "collapsed",
        "showUsageMetrics": false,
        "usageMetricsExpansion": "collapsed",
        "toolCallExpansionDefaults": {
            "preset": "custom",
            "thinking": "collapsed",
            "tools": {
                "bash": "expanded", "read": "collapsed", "write": "expanded",
                "edit": "expanded", "patch": "expanded", "webfetch": "collapsed",
                "websearch": "collapsed", "glob": "collapsed", "grep": "collapsed",
                "task": "expanded", "execute": "expanded", "skill": "collapsed",
                "question": "expanded", "invalid": "collapsed", "other": "collapsed"
            }
        }
    }));
    assert_eq!(custom_prefs.transcript_preset(), "custom");
    custom_prefs
        .config
        .stage(Choice::TranscriptRow(Row::Diagnostics), "expanded");
    assert_eq!(
        custom_prefs.transcript_preset_display(),
        "custom",
        "editing Diagnostics on a saved custom preset must stay custom while in flight"
    );

    // 2. Hidden tab processing Event::Connected when active tab already has a healthy stream
    // must NOT rebind or replace observed_clients with the hidden tab.
    let mut root = crate::init();
    let backend_a = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    let mut backend_b = backend_a.clone();
    backend_b.client_id = "tab-b".into();
    let active_id = backend_a.client_id.clone();
    {
        let mut prefs = root.settings.shared.borrow_mut();
        prefs.bind(Some(backend_a));
        prefs.fixture_transcript(json!({"diagnosticsExpansion":"expanded"}));
        prefs.transport_lost = false;
        prefs.observe_conversation_clients(&[(active_id.clone(), true)]);
        assert!(prefs.transcript_ready());
    }
    let (tx, rx) = bounded(4);
    tx.try_send(crate::transport::Event::Connected(backend_b))
        .unwrap();
    root.incoming = Some(rx);
    crate::chat::events::poll_hidden_chat(&mut root, 8, true);
    let prefs = root.settings.shared.borrow();
    assert_eq!(
        prefs.backend.as_ref().map(|b| b.client_id.as_str()),
        Some(active_id.as_str()),
        "hidden Event::Connected must not rebind preferences away from healthy active tab"
    );
    assert!(
        prefs.transcript_ready(),
        "hidden Event::Connected must not disrupt healthy active tab"
    );

    // 3. With two open tabs on Server A, dropping ONLY hidden tab B while active tab A's SSE
    // stays open must attest /api/meta when tab B reconnects; if the endpoint switched to Server B,
    // tab B's mismatch revokes shared attestation immediately so no Preferences PATCH reaches B.
    platform::block_on(async {
        use crate::transport::{Command, Event, run_backend};
        use std::sync::Arc;
        let (listener, mut prefs) = fixture().await;
        let base = prefs.backend.clone().unwrap();
        let client = base.client.clone();
        let mut tab_a = base.clone();
        tab_a.client_id = "reconnect-tab-a".into();
        let mut tab_b = base.clone();
        tab_b.client_id = "reconnect-tab-b".into();
        attest(&listener, &base, "server-a").await;
        prefs.observe_conversation_clients(&[(tab_a.client_id.clone(), true)]);
        let (out_a, events_a) = bounded(16);
        let (commands_a, input_a) = bounded(4);
        let (out_b, events_b) = bounded(16);
        let (commands_b, input_b) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, input_a, Arc::new(|| {})).await;
        });
        let meta_a = request(&listener).await;
        assert_eq!(meta_a.first, "GET /api/meta HTTP/1.1");
        meta_a
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let mut sse_a = request(&listener).await;
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener)
            .await
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(200, json!({"apiContract":1,"serverId":"server-a"}))
            .await;
        let history_b = request(&listener).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "second tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(
                200,
                json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}),
            )
            .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        // 3a. While the shared SSE socket is STILL OPEN (no global transport drop), a foreign
        // /api/meta mismatch ("server-b") must revoke shared attestation immediately so no
        // Preferences PATCH reaches Server B.
        let probe_backend = base.clone();
        platform::spawn(async move {
            let _ = probe_backend.attest_server().await;
        });
        let mismatch_meta = timeout(Duration::from_secs(4), request(&listener))
            .await
            .expect("probe must request /api/meta");
        assert_eq!(mismatch_meta.first, "GET /api/meta HTTP/1.1");
        mismatch_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b"}))
            .await;
        wait_until(|| client.needs_capability_recheck()).await;
        // Now attempt a Preferences write while the old SSE socket is still open:
        // it must NOT send SSE or PATCH to Server B, only /api/meta.
        prefs.set_transcript(None, "minimal");
        assert!(prefs.poll());
        let deadline = std::time::Instant::now() + Duration::from_millis(120);
        while std::time::Instant::now() < deadline {
            prefs.poll();
            if let Ok(req) = timeout(Duration::from_millis(15), request(&listener)).await {
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                        .await;
                } else {
                    panic!(
                        "foreign server must not receive SSE or settings PATCH after foreign attestation while SSE is open, got: {}",
                        req.first
                    );
                }
            }
        }
        // 3b. Dropping the shared SSE stream must also attest /api/meta before reopening SSE.
        drop(sse_a);
        let reconnect_meta = timeout(Duration::from_secs(4), request(&listener))
            .await
            .expect("reconnect must attest /api/meta before reopening SSE");
        assert_eq!(reconnect_meta.first, "GET /api/meta HTTP/1.1");
        reconnect_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b"}))
            .await;
        let _ = commands_a.send(Command::Close).await;
        let _ = commands_b.send(Command::Close).await;
    });

    // 4. An in-flight GET whose server attestation is revoked mid-flight must be discarded and
    // never overwrite the confirmed snapshot with foreign-server data.
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let base = prefs.backend.clone().unwrap();
        let client = base.client.clone();
        attest(&listener, &base, "server-a").await;
        prefs.fixture_transcript(json!({"diagnosticsExpansion":"expanded"}));
        prefs.invalidate(Owner::Config);
        assert!(prefs.poll());
        let held_get = request(&listener).await;
        assert_eq!(
            held_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        // Revoke shared attestation while the GET is still in flight.
        let probe_backend = base.clone();
        platform::spawn(async move {
            let _ = probe_backend.attest_server().await;
        });
        let mismatch_meta = request(&listener).await;
        assert_eq!(mismatch_meta.first, "GET /api/meta HTTP/1.1");
        mismatch_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b"}))
            .await;
        wait_until(|| client.needs_capability_recheck()).await;
        // Now return foreign Server B data on the already-dispatched GET.
        held_get
            .reply(
                200,
                json!({"settings":{"locale":"fr","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        let deadline = std::time::Instant::now() + Duration::from_millis(120);
        while std::time::Instant::now() < deadline {
            prefs.poll();
            if let Ok(req) = timeout(Duration::from_millis(15), request(&listener)).await {
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(200, json!({"apiContract":1,"serverId":"server-b"}))
                        .await;
                } else {
                    panic!(
                        "revoked server must not receive another config read, got: {}",
                        req.first
                    );
                }
            }
        }
        assert_eq!(
            prefs.transcript_mode(Row::Diagnostics, false),
            "expanded",
            "in-flight GET completed after attestation revocation must not overwrite snapshot"
        );
        assert!(
            !prefs.transcript_ready(),
            "revoked attestation must disable preferences writes"
        );
    });

    // 5. Incompatible apiContract on a second probe revokes shared Server A attestation so no
    // PATCH from an open tab reaches the foreign server; voluntary SSE close + same-server
    // re-attestation fences a pre-close held PATCH via prepared_gen; recovered hidden tab
    // baselines its drop count; and flush() after voluntary SSE close revalidates and persists.
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let base = prefs.backend.clone().unwrap();
        let client = base.client.clone();
        attest(&listener, &base, "server-a").await;
        assert!(!client.needs_capability_recheck());
        let probe = base.clone();
        let (err_tx, err_rx) = bounded(1);
        platform::spawn(async move {
            let _ = err_tx.send(probe.attest_server().await.is_err()).await;
        });
        let incompat = request(&listener).await;
        assert_eq!(incompat.first, "GET /api/meta HTTP/1.1");
        incompat
            .reply(200, json!({"apiContract":2,"serverId":"server-b"}))
            .await;
        assert!(err_rx.recv().await.unwrap());
        assert!(
            client.needs_capability_recheck(),
            "incompatible apiContract from foreign server must revoke shared attestation"
        );
        // A 404 /api/meta on a re-probe after attestation also revokes shared attestation.
        attest(&listener, &base, "server-a").await;
        assert!(!client.needs_capability_recheck());
        let probe_404 = base.clone();
        let (err404_tx, err404_rx) = bounded(1);
        platform::spawn(async move {
            let _ = err404_tx
                .send(probe_404.attest_server().await.is_err())
                .await;
        });
        let not_found = request(&listener).await;
        assert_eq!(not_found.first, "GET /api/meta HTTP/1.1");
        not_found.reply(404, json!({})).await;
        assert!(err404_rx.recv().await.unwrap());
        assert!(
            client.needs_capability_recheck(),
            "404 /api/meta must revoke shared attestation"
        );
        // Recovered hidden tab baselines its drop count so closing the original active tab later
        // does not leave Preferences stuck in transport_lost.
        let (listener2, mut prefs2) = fixture().await;
        let tab_a_id = "rec-tab-a".to_owned();
        let tab_b_id = "rec-tab-b".to_owned();
        prefs2.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), true)]);
        let mut tab_b_backend = prefs2.backend.clone().unwrap();
        tab_b_backend.client_id = tab_b_id.clone();
        let (out_b, events_b) = bounded(16);
        let (cmd_b, in_b) = bounded(4);
        platform::spawn(async move {
            let _ = crate::transport::run_backend(
                tab_b_backend,
                out_b,
                in_b,
                std::sync::Arc::new(|| {}),
            )
            .await;
        });
        let mut sse_b = request(&listener2).await;
        sse_b
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener2)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener2)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                crate::transport::Event::Sync(_)
            ) {
                break;
            }
        }
        drop(sse_b);
        let client2 = prefs2.backend.as_ref().unwrap().client.clone();
        wait_until(|| client2.transport_drops(&tab_b_id) == 1).await;
        prefs2.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), false)]);
        prefs2.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), true)]);
        prefs2.observe_conversation_clients(&[(tab_b_id.clone(), true)]);
        assert!(
            prefs2.transcript_ready(),
            "closing original active tab after hidden tab recovered must keep Chat ready"
        );
        let _ = cmd_b.send(crate::transport::Command::Close).await;
    });
}
