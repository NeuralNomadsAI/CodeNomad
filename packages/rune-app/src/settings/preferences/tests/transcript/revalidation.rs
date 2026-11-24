use super::super::*;
use crate::settings::transcript_preset;

#[test]
fn superseded_failed_preset_does_not_block_queued_replacement_and_watch_clears_transport_lost() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        // 1. Click Everything, then Minimal before Everything responds; Everything fails (503).
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let failed_everything = request(&listener).await;
        prefs.set_transcript(None, "minimal");
        failed_everything.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(
            readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;

        // Minimal supersedes Everything, so it must send immediately without blocking behind Retry.
        let minimal_req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(minimal_req.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            minimal_req.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "minimal"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        minimal_req
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "minimal" && prefs.transcript_error().is_none()
        })
        .await;

        // 2. Losing transport disables Chat; a pre-outage fallback readback GET must NOT confirm a
        // write or clear read_failed/transport_lost, and PreferencesWatch disconnects also disable
        // controls until a post-outage non-stale GET succeeds.
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let outage_patch = request(&listener).await;
        outage_patch.reply(503, json!({})).await;
        let pre_outage_readback = request(&listener).await;
        assert_eq!(
            pre_outage_readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        prefs.mark_transport_lost();
        assert!(!prefs.transcript_ready());
        assert_eq!(
            prefs.transcript_error(),
            Some("rune.connect_error"),
            "transport_lost must surface an actionable connection error"
        );
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        pre_outage_readback
            .reply(200, json!({"settings":everything}))
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.config.refreshing()
        })
        .await;
        assert!(
            !prefs.transcript_ready(),
            "pre-outage readback GET must not clear transport_lost"
        );
        assert_eq!(
            prefs.transcript_preset(),
            "minimal",
            "pre-outage readback GET must not confirm Everything or publish a stale snapshot"
        );
        // Handing back to PreferencesWatch keeps controls disabled until the watch's fresh GET settles.
        let wake: rune::Waker = std::sync::Arc::new(|| {});
        prefs.watch(&wake);
        assert!(
            !prefs.transcript_ready(),
            "watch() must not clear transport_lost before revalidation"
        );
        let mut watch_sse = request(&listener).await;
        assert!(watch_sse.first.starts_with("GET /api/events?"));
        use tokio::io::AsyncWriteExt;
        watch_sse
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let mut revalidated_get = None;
        for _ in 0..2 {
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.contains("/api/storage/config/ui") {
                assert!(
                    !prefs.transcript_ready(),
                    "launching a fresh GET must not clear transport_lost"
                );
                revalidated_get = Some(req);
            } else {
                req.reply(200, json!({"settings":{}})).await;
            }
        }
        revalidated_get
            .expect("watch SSE open must trigger a fresh config GET")
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready()
        })
        .await;

        // Dropping PreferencesWatch SSE must also disable Chat (returning true from poll() for
        // redraw) and keep queued writes parked until the reconnected watch completes its GET.
        drop(watch_sse);
        let mut disconnect_reported = false;
        wait_until(|| {
            if prefs.poll() {
                disconnect_reported = true;
            }
            !prefs.transcript_ready()
        })
        .await;
        assert!(
            disconnect_reported,
            "Preferences::poll must return true when PreferencesWatch disconnects"
        );
        let mut watch_sse_2 = request(&listener).await;
        assert!(watch_sse_2.first.starts_with("GET /api/events?"));
        watch_sse_2
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let mut revalidated_2 = None;
        for _ in 0..2 {
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.contains("/api/storage/config/ui") {
                revalidated_2 = Some(req);
            } else {
                req.reply(200, json!({"settings":{}})).await;
            }
        }
        revalidated_2
            .expect("reconnected watch SSE must trigger a fresh config GET")
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready()
        })
        .await;

        // Same-address reattach keeps Chat disabled until the reattach GET completes.
        let mut current = prefs.backend.take().unwrap();
        attest(&listener, &mut current, "same-server").await;
        let mut reattach_backend = Backend::unauthenticated(&current.base).unwrap();
        reattach_backend.client_id.push_str("-reattach");
        attest(&listener, &mut reattach_backend, "same-server").await;
        prefs.backend = Some(current);
        assert!(prefs.bind(Some(reattach_backend)));
        assert!(
            !prefs.transcript_ready(),
            "same-address reattach must disable Chat until reattach GET settles"
        );
        let mut reattach_get = None;
        for _ in 0..2 {
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.contains("/api/storage/config/ui") {
                reattach_get = Some(req);
            } else {
                req.reply(200, json!({"settings":{}})).await;
            }
        }
        reattach_get
            .expect("reattach must perform a config GET")
            .reply(200, json!({"settings":minimal}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready()
        })
        .await;
        prefs.unwatch();
    });
}

#[test]
fn native_flush_and_poll_observe_conversation_stream_invalidation_during_readback() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    let (listener, mut prefs) = platform::block_on(fixture());
    let backend_ref = prefs.backend.clone().unwrap();
    let mut conv_backend = backend_ref.clone();
    conv_backend.workspace = "project".into();
    conv_backend.session = "session".into();
    let (out, events) = bounded(16);
    let (commands, input) = bounded(4);
    let (mut sse, patch) = platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(conv_backend, out, input, Arc::new(|| {})).await;
        });
        let mut sse = request(&listener).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let page = request(&listener).await;
        page.reply(
            200,
            json!({
                "status":"window",
                "messages":[{"id":"recent","type":"user","text":"recent"}],
                "older":null,"newer":null,"latest":true
            }),
        )
        .await;
        request(&listener)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        // Drain initial Event::Sync + Event::Preferences just like chat/events.rs does.
        timeout(Duration::from_secs(5), async {
            loop {
                match events.recv().await.unwrap() {
                    Event::Preferences(owner) => prefs.invalidate(owner),
                    Event::Sync(_) => break,
                    _ => {}
                }
            }
        })
        .await
        .expect("timed out waiting for initial Event::Sync");
        while let Ok(event) = events.try_recv() {
            if let Event::Preferences(owner) = event {
                prefs.invalidate(owner);
            }
        }
        prefs.poll();
        timeout(Duration::from_secs(5), async {
            let mut settled = 0;
            while settled < 2 {
                let req = poll_next_request(&mut prefs, &listener).await;
                if req.first.contains("/api/storage/config/ui") {
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                    settled += 1;
                } else if req.first.contains("/api/storage/state") {
                    req.reply(200, json!({"settings":{}})).await;
                    settled += 1;
                }
            }
        })
        .await
        .expect("timed out draining initial config/state reads");
        wait_until(|| {
            prefs.poll();
            prefs.notification_config().is_some()
        })
        .await;

        // 1. Outside flush(): Preferences::poll() alone (before chat/events.rs pumps Event::Preferences)
        // must still reject a stale fallback readback invalidated on the conversation stream.
        prefs.set_transcript(None, "everything");
        prefs.poll();
        let poll_patch = request(&listener).await;
        assert_eq!(poll_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        poll_patch.reply(503, json!({})).await;
        let poll_readback = request(&listener).await;
        let rev_before = backend_ref.client.preferences_revision(Owner::Config);
        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| backend_ref.client.preferences_revision(Owner::Config) > rev_before).await;
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        poll_readback
            .reply(200, json!({"settings":everything.clone()}))
            .await;
        let poll_fresh = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            poll_fresh.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        poll_fresh
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.transcript_preset() == "minimal"
        })
        .await;
        assert!(
            prefs.transcript_error().is_some(),
            "poll() must not confirm Everything from a readback invalidated on the conversation stream"
        );

        // 2. Inside flush(): same guard holds while blocking on native close.
        prefs.set_transcript(None, "nothing");
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        (sse, patch)
    });

    let rev_client = backend_ref.client.clone();
    let (done_tx, done_rx) = bounded(1);
    platform::spawn(async move {
        platform::sleep(Duration::from_millis(20)).await;
        patch.reply(503, json!({})).await;
        let stale_readback = request(&listener).await;
        assert_eq!(
            stale_readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let rev_before = rev_client.preferences_revision(Owner::Config);
        sse.socket
            .write_all(
                b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\",\"value\":{}}\n\n",
            )
            .await
            .unwrap();
        timeout(Duration::from_secs(4), async {
            while rev_client.preferences_revision(Owner::Config) <= rev_before {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("conversation stream must observe storage.configChanged");
        let mut nothing = transcript_preset::patch("nothing");
        nothing["locale"] = json!("en");
        stale_readback.reply(200, json!({"settings":nothing})).await;

        let fresh_get = request(&listener).await;
        assert_eq!(
            fresh_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        fresh_get.reply(200, json!({"settings":minimal})).await;
        let _ = commands.send(Command::Close).await;
        let _ = done_tx.send(()).await;
    });

    assert!(
        !prefs.flush(),
        "flush must not confirm Nothing from a fallback readback invalidated on the conversation stream"
    );
    platform::block_on(done_rx.recv()).unwrap();
    assert_eq!(prefs.transcript_preset(), "minimal");
    assert!(prefs.transcript_error().is_some());
}

#[test]
fn flush_after_disconnect_revalidates_or_fails_promptly_and_hidden_tab_disconnect_is_ignored() {
    // 1. poll_hidden_chat with a closed hidden channel containing ConnectionLost does NOT disable
    // a healthy active conversation tab (active_has_stream = true), while an empty active tab
    // (active_has_stream = false) DOES disable Chat when its hidden fallback stream disconnects.
    let (listener, prefs) = platform::block_on(fixture());
    let mut root = crate::init();
    *root.settings.shared.borrow_mut() = prefs;
    let (hidden_tx, hidden_rx) = bounded(2);
    platform::block_on(hidden_tx.send(crate::transport::Event::ConnectionLost)).unwrap();
    drop(hidden_tx); // Closed hidden channel with buffered ConnectionLost!
    root.incoming = Some(hidden_rx);
    crate::chat::events::poll_hidden_chat(&mut root, 8, true);
    assert!(
        root.settings.shared.borrow().transcript_ready(),
        "hidden closed channel ConnectionLost must not disable a healthy active conversation tab"
    );
    let (hidden_tx2, hidden_rx2) = bounded(2);
    platform::block_on(hidden_tx2.send(crate::transport::Event::ConnectionLost)).unwrap();
    drop(hidden_tx2);
    root.incoming = Some(hidden_rx2);
    crate::chat::events::poll_hidden_chat(&mut root, 8, false);
    assert!(
        !root.settings.shared.borrow().transcript_ready(),
        "hidden tab ConnectionLost must disable Chat when active tab has no open stream"
    );
    assert_eq!(
        root.settings.shared.borrow().transcript_error(),
        Some("rune.connect_error")
    );
    drop(listener);
    let (listener, mut prefs) = platform::block_on(fixture());

    // 2. Disconnecting with a queued write and calling flush() must run one revalidation GET and
    // return false promptly on failure instead of hanging until the drain timeout.
    prefs.set_transcript(None, "minimal");
    prefs.mark_transport_lost();
    let (done_tx, done_rx) = bounded(1);
    platform::spawn(async move {
        let reval = request(&listener).await;
        assert_eq!(
            reval.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        reval.reply(503, json!({})).await;
        let _ = done_tx.send(()).await;
    });
    let started = std::time::Instant::now();
    assert!(
        !prefs.flush(),
        "flush after disconnect with failing revalidation GET must return false"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "flush after disconnect must not hang waiting for a blocked write"
    );
    platform::block_on(done_rx.recv()).unwrap();

    // 3. Disconnecting while PATCH #1 is in flight and PATCH #2 is queued: flush() must finish
    // PATCH #1, run one revalidation GET, and then save & confirm PATCH #2.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    prefs2.set_transcript(None, "minimal");
    prefs2.poll();
    let patch1 = platform::block_on(request(&listener2));
    assert_eq!(patch1.first, "PATCH /api/storage/config/ui HTTP/1.1");
    prefs2.set_transcript(Some(Row::Groups), "hidden");
    prefs2.mark_transport_lost();
    let (done2_tx, done2_rx) = bounded(1);
    platform::spawn(async move {
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        patch1.reply(200, json!({"settings":minimal.clone()})).await;
        let reval = request(&listener2).await;
        assert_eq!(
            reval.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        reval.reply(200, json!({"settings":minimal.clone()})).await;
        let patch2 = request(&listener2).await;
        assert_eq!(patch2.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            patch2.body,
            json!({"settings":{"toolGroupVisibility":"hidden"}})
        );
        minimal["toolGroupVisibility"] = json!("hidden");
        patch2.reply(200, json!({"settings":minimal})).await;
        let _ = done2_tx.send(()).await;
    });
    assert!(
        prefs2.flush(),
        "flush with in-flight PATCH + disconnect + queued PATCH must revalidate and confirm PATCH #2"
    );
    platform::block_on(done2_rx.recv()).unwrap();
    assert_eq!(prefs2.transcript_mode(Row::Groups, false), "hidden");

    // 4. Real conversation stream with a distinct client_id (as produced by catalog/binding.rs)
    // dropping while PATCH #1 is in flight and PATCH #2 is queued: flush() must observe the
    // distinct conversation client_id's drop and run a revalidation GET before PATCH #2.
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    let (listener3, mut prefs3) = platform::block_on(fixture());
    let mut conv_backend = prefs3.backend.clone().unwrap();
    conv_backend.client_id.push_str("-conversation");
    conv_backend.workspace = "project".into();
    conv_backend.session = "session".into();
    let conv_client_id = conv_backend.client_id.clone();
    prefs3.observe_conversation_clients(&[(conv_client_id.clone(), true)]);
    let (out3, events3) = bounded(16);
    let (commands3, input3) = bounded(4);
    let (sse3, patch3_1) = platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(conv_backend, out3, input3, Arc::new(|| {})).await;
        });
        let mut sse = request(&listener3).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let page = request(&listener3).await;
        page.reply(
            200,
            json!({
                "status":"window",
                "messages":[{"id":"recent","type":"user","text":"recent"}],
                "older":null,"newer":null,"latest":true
            }),
        )
        .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events3.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        prefs3.set_transcript(None, "minimal");
        prefs3.poll();
        let p1 = request(&listener3).await;
        assert_eq!(p1.first, "PATCH /api/storage/config/ui HTTP/1.1");
        prefs3.set_transcript(Some(Row::Groups), "hidden");
        (sse, p1)
    });
    let drop_client = prefs3.backend.as_ref().unwrap().client.clone();
    let (done3_tx, done3_rx) = bounded(1);
    platform::spawn(async move {
        // Drop the conversation SSE stream without delivering ConnectionLost to the UI loop.
        drop(sse3);
        timeout(Duration::from_secs(4), async {
            while drop_client.transport_drops(&conv_client_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("conversation client_id drop must be recorded");
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        patch3_1
            .reply(200, json!({"settings":minimal.clone()}))
            .await;
        // Revalidation GET MUST arrive before PATCH #2 (hold any background SSE reconnects open).
        let mut _reconnects = Vec::new();
        loop {
            let req = request(&listener3).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
                continue;
            }
            assert_eq!(
                req.first, "GET /api/storage/config/ui?authoritative=1 HTTP/1.1",
                "flush must revalidate before sending PATCH #2 after active conversation SSE drop"
            );
            req.reply(200, json!({"settings":minimal.clone()})).await;
            break;
        }
        loop {
            let req = request(&listener3).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
                continue;
            }
            assert_eq!(req.first, "PATCH /api/storage/config/ui HTTP/1.1");
            assert_eq!(
                req.body,
                json!({"settings":{"toolGroupVisibility":"hidden"}})
            );
            minimal["toolGroupVisibility"] = json!("hidden");
            req.reply(200, json!({"settings":minimal})).await;
            break;
        }
        let _ = commands3.send(Command::Close).await;
        let _ = done3_tx.send(()).await;
    });
    assert!(
        prefs3.flush(),
        "flush must detect distinct conversation client_id SSE drop, revalidate, and confirm PATCH #2"
    );
    platform::block_on(done3_rx.recv()).unwrap();
    assert_eq!(prefs3.transcript_mode(Row::Groups, false), "hidden");
}
