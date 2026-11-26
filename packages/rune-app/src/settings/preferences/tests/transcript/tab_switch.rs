use super::super::*;
use crate::settings::transcript_preset;

#[test]
fn tab_switch_revalidates_hidden_drop_and_state_and_bounds_queue_and_notification_seed() {
    use crate::settings::notification_routing::{Category, Destination};
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    // 1. Tab B drops while hidden (Tab A is active). Switching to Tab B detects Tab B's unseen
    // drop instead of erasing it, AND revalidates both Config and State (so a queued Mode write
    // on State is not left stranded after Config revalidates).
    let (listener, mut prefs) = platform::block_on(fixture());
    let mut tab_b_backend = prefs.backend.clone().unwrap();
    tab_b_backend.client_id.push_str("-tab-b");
    tab_b_backend.workspace = "project".into();
    tab_b_backend.session = "session".into();
    let tab_a_id = "conv-tab-a".to_owned();
    let tab_b_id = tab_b_backend.client_id.clone();
    prefs.observe_conversation_clients(&[(tab_a_id.clone(), true)]);

    let (out_b, events_b) = bounded(16);
    let (commands_b, input_b) = bounded(4);
    let drop_client = prefs.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_b_backend, out_b, input_b, Arc::new(|| {})).await;
        });
        let mut sse_b = request(&listener).await;
        assert!(sse_b.first.starts_with("GET /api/events?"));
        sse_b
            .socket
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
        // Drop Tab B while Tab A is still active: Tab A stays ready.
        drop(sse_b);
        timeout(Duration::from_secs(4), async {
            while drop_client.transport_drops(&tab_b_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("tab B drop must be recorded");
        prefs.poll();
        assert!(
            prefs.transcript_ready(),
            "hidden Tab B drop must not disturb healthy Tab A"
        );

        // Now activate Tab B (with a pending State write): observe_conversation_clients detects
        // Tab B's unseen drop, disables Chat, and revalidate_transport() revalidates BOTH Config
        // and State so the pending State write proceeds after State GET.
        prefs.set_mode("dark");
        prefs.observe_conversation_clients(&[(tab_b_id.clone(), false)]);
        assert!(
            !prefs.transcript_ready(),
            "switching to dropped Tab B must detect its unseen drop"
        );
        prefs.revalidate_transport();
        prefs.poll();

        let mut got_config_get = false;
        let mut got_state_get = false;
        let mut got_state_patch = false;
        let mut _reconnects = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !(got_config_get && got_state_get && got_state_patch) {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for Config GET + State GET + State PATCH"
            );
            let req = poll_next_request(&mut prefs, &listener).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
                continue;
            }
            if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                got_config_get = true;
                req.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                got_state_get = true;
                req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                    .await;
            } else if req.first == "PATCH /api/storage/state/ui HTTP/1.1" {
                assert!(
                    got_state_get,
                    "State PATCH must wait for State revalidation GET after Tab B drop"
                );
                got_state_patch = true;
                req.reply(200, json!({"appearancePreferences":{"mode":"dark"}}))
                    .await;
            } else {
                panic!("unexpected request: {}", req.first);
            }
        }
        wait_until(|| {
            prefs.poll();
            prefs.transcript_ready() && prefs.mode() == "dark"
        })
        .await;
        let _ = commands_b.send(Command::Close).await;
    });

    // 2. NotificationRoute PATCH without existing notificationRouting object must run a queued
    // GET first when Config was invalidated, avoiding clobbering a concurrent client's routes.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    prefs2.config.snapshot = Some(json!({"settings":{"osNotificationsEnabled":true}}));
    prefs2.invalidate(Owner::Config);
    prefs2.set_notification_route(Category::SessionDone, Destination::System, false);
    prefs2.poll();
    platform::block_on(async {
        let get = request(&listener2).await;
        assert_eq!(
            get.first, "GET /api/storage/config/ui?authoritative=1 HTTP/1.1",
            "invalidated NotificationRoute seed must GET before PATCH"
        );
        get.reply(
            200,
            json!({"settings":{"notificationRouting":{"needsInput":{"system":false},"sessionDone":{"system":true}}}}),
        )
        .await;
        let patch = poll_next_request(&mut prefs2, &listener2).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            patch.body,
            json!({"settings":{"notificationRouting":{"sessionDone":{"system":false}}}}),
            "fresh snapshot with existing notificationRouting must send minimal single-leaf PATCH"
        );
        patch
            .reply(
                200,
                json!({"settings":{"notificationRouting":{"needsInput":{"system":false},"sessionDone":{"system":false}}}}),
            )
            .await;
        wait_until(|| {
            prefs2.poll();
            !prefs2.config.refreshing()
        })
        .await;
    });

    // 3. Coalesced FIFO ordering: earlier unsent row edits still send ahead of a later preset so a
    // 503 on the preset never drops them, while repeated/alternating preset clicks deduplicate.
    let (listener3, mut prefs3) = platform::block_on(fixture());
    prefs3.set_transcript(None, "minimal");
    prefs3.poll();
    platform::block_on(async {
        let first = request(&listener3).await;
        // Stage row edits followed by repeated Everything clicks while minimal is in flight:
        // the queued row batch sends first (surviving an Everything 503), and repeated Everything
        // clicks deduplicate to one preset batch.
        prefs3.set_transcript(Some(Row::Groups), "hidden");
        prefs3.set_transcript(Some(Row::Diagnostics), "hidden");
        for _ in 0..5 {
            prefs3.set_transcript(None, "everything");
        }
        let mut saved = transcript_preset::patch("minimal");
        saved["locale"] = json!("en");
        first.reply(200, json!({"settings":saved.clone()})).await;

        let queued_rows = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            queued_rows.body,
            json!({"settings":{"diagnosticsExpansion":"hidden","toolGroupVisibility":"hidden"}})
        );
        saved["diagnosticsExpansion"] = json!("hidden");
        saved["toolGroupVisibility"] = json!("hidden");
        queued_rows
            .reply(200, json!({"settings":saved.clone()}))
            .await;

        let everything_fail = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            everything_fail.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("everything")
        );
        everything_fail.reply(503, json!({})).await;
        let readback = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            readback.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback.reply(200, json!({"settings":saved.clone()})).await;
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_error().is_some()
        })
        .await;
        assert_eq!(
            prefs3.transcript_mode(Row::Groups, false),
            "hidden",
            "queued row edit before a 503 preset must be persisted, not dropped"
        );
        assert_eq!(prefs3.transcript_mode(Row::Diagnostics, false), "hidden");

        prefs3.retry_transcript();
        let retry_get = poll_next_request(&mut prefs3, &listener3).await;
        retry_get.reply(200, json!({"settings":saved})).await;
        let retry_patch = poll_next_request(&mut prefs3, &listener3).await;
        assert_eq!(
            retry_patch.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("everything")
        );
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        retry_patch.reply(200, json!({"settings":everything})).await;
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_preset() == "everything" && prefs3.transcript_error().is_none()
        })
        .await;
        assert!(
            timeout(Duration::from_millis(60), listener3.accept())
                .await
                .is_err(),
            "duplicate consecutive preset clicks must not leave extra batches in transcript_queue"
        );
    });

    // 4. Retry in Chat after disconnect also revalidates State so a pending appearance Mode write
    // is never stranded after transport_lost clears.
    let (listener4, mut prefs4) = platform::block_on(fixture());
    prefs4.mark_transport_lost();
    prefs4.set_mode("dark");
    prefs4.retry_transcript();
    prefs4.poll();
    platform::block_on(async {
        timeout(Duration::from_secs(5), async {
            let mut got_config = false;
            let mut got_state_get = false;
            let mut got_state_patch = false;
            while !(got_config && got_state_get && got_state_patch) {
                let req = poll_next_request(&mut prefs4, &listener4).await;
                if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    got_config = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                    got_state_get = true;
                    req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                        .await;
                } else if req.first == "PATCH /api/storage/state/ui HTTP/1.1" {
                    assert!(got_state_get);
                    got_state_patch = true;
                    req.reply(200, json!({"appearancePreferences":{"mode":"dark"}}))
                        .await;
                } else {
                    panic!("unexpected request: {}", req.first);
                }
            }
        })
        .await
        .expect("timed out waiting for Config GET + State GET + State PATCH");
        wait_until(|| {
            prefs4.poll();
            prefs4.transcript_ready() && prefs4.mode() == "dark"
        })
        .await;
    });

    // 5. flush() reconciles an already-failed Chat write when an SSE storage.configChanged bumped
    // preferences_revision on the conversation stream without UI polling yet.
    let (listener5, mut prefs5) = platform::block_on(fixture());
    let mut conv5 = prefs5.backend.clone().unwrap();
    conv5.workspace = "project".into();
    conv5.session = "session".into();
    let (out5, events5) = bounded(16);
    let (commands5, input5) = bounded(4);
    let sse5 = platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(conv5, out5, input5, Arc::new(|| {})).await;
        });
        let mut sse = request(&listener5).await;
        assert!(sse.first.starts_with("GET /api/events?"));
        sse.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let page = request(&listener5).await;
        page.reply(
            200,
            json!({
                "status":"window",
                "messages":[{"id":"recent","type":"user","text":"recent"}],
                "older":null,"newer":null,"latest":true
            }),
        )
        .await;
        request(&listener5)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), events5.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        // Fail a Groups -> hidden write with 503 + fallback GET returning old value.
        prefs5.set_transcript(Some(Row::Groups), "hidden");
        prefs5.poll();
        request(&listener5).await.reply(503, json!({})).await;
        request(&listener5)
            .await
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        wait_until(|| {
            prefs5.poll();
            prefs5.transcript_error() == Some("settings.preferenceSaveFailed")
        })
        .await;
        sse
    });
    let rev_before = prefs5
        .backend
        .as_ref()
        .unwrap()
        .client
        .preferences_revision(Owner::Config);
    let rev_client = prefs5.backend.as_ref().unwrap().client.clone();
    let (done5_tx, done5_rx) = bounded(1);
    platform::block_on(async {
        let mut sse5 = sse5;
        sse5.socket
            .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
            .await
            .unwrap();
        timeout(Duration::from_secs(4), async {
            while rev_client.preferences_revision(Owner::Config) == rev_before {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("SSE storage.configChanged must bump preferences_revision");
        // Spawn reply to the reconciliation GET that flush() must run (keep sse5 open until
        // flush returns so closing sse5 does not simulate a mid-GET transport drop).
        platform::spawn(async move {
            let get = request(&listener5).await;
            assert_eq!(
                get.first,
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
            );
            get.reply(
                200,
                json!({"settings":{"locale":"en","toolGroupVisibility":"hidden"}}),
            )
            .await;
            let _ = done5_tx.send(sse5).await;
        });
    });
    assert!(
        prefs5.flush(),
        "flush must reconcile a failed write after unseen conversation SSE invalidation"
    );
    let sse5 = platform::block_on(done5_rx.recv()).unwrap();
    platform::block_on(async {
        let _ = commands5.send(Command::Close).await;
        drop(sse5);
    });
    assert_eq!(prefs5.transcript_mode(Row::Groups, false), "hidden");
}

#[test]
fn tab_switch_revokes_prepared_patch_stale_ack_waits_for_get_and_sibling_hidden_streams_survive() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    // 1. Switching from healthy Tab A to dropped Tab B after poll() prepared a PATCH must revoke
    // the unsent PATCH via epoch_guard before it hits the wire.
    let (listener1, mut prefs1) = platform::block_on(fixture());
    let mut tab_b = prefs1.backend.clone().unwrap();
    tab_b.client_id.push_str("-dropped-b");
    tab_b.workspace = "project".into();
    tab_b.session = "session".into();
    let tab_a_id = "healthy-a".to_owned();
    let tab_b_id = tab_b.client_id.clone();
    prefs1.observe_conversation_clients(&[(tab_a_id.clone(), true)]);
    let (out_b, events_b) = bounded(16);
    let (commands_b, input_b) = bounded(4);
    let drop_client = prefs1.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, input_b, Arc::new(|| {})).await;
        });
        let mut sse_b = request(&listener1).await;
        sse_b
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener1)
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
        request(&listener1)
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
        drop(sse_b);
        timeout(Duration::from_secs(4), async {
            while drop_client.transport_drops(&tab_b_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("tab B drop must be recorded");
        // Empty active tab with TWO hidden streams (dropped B + healthy C): sibling C keeps
        // Preferences healthy and ready without advancing B's seen drop counter.
        let tab_c_id = "healthy-c".to_owned();
        prefs1.observe_conversation_clients(&[(tab_b_id.clone(), false), (tab_c_id.clone(), true)]);
        assert!(
            prefs1.transcript_ready(),
            "healthy sibling hidden stream must keep Preferences ready when another hidden tab drops"
        );

        // Now prepare a PATCH while Tab C is healthy, hold it before the pre-send guard, activate
        // dropped Tab B, then release: epoch_guard must revoke the unsent PATCH so no PATCH hits
        // the wire before revalidation GET.
        let (release_tx, release_rx) = bounded(1);
        prefs1.config.set_pre_patch_gate(release_rx);
        prefs1.set_transcript(None, "everything");
        assert!(prefs1.poll());
        prefs1.observe_conversation_clients(&[(tab_b_id.clone(), false)]);
        assert!(!prefs1.transcript_ready());
        let _ = release_tx.send(()).await;
        prefs1.revalidate_transport();
        let mut got_config_get = false;
        let mut got_patch = false;
        let mut _reconnects = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !(got_config_get && got_patch) {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for revalidation GET followed by PATCH"
            );
            let req = poll_next_request(&mut prefs1, &listener1).await;
            if req.first.starts_with("GET /api/events?") {
                _reconnects.push(req);
            } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                let hold_until = std::time::Instant::now() + Duration::from_millis(30);
                while std::time::Instant::now() < hold_until {
                    prefs1.poll();
                    if let Ok(accepted) =
                        timeout(Duration::from_millis(5), listener1.accept()).await
                    {
                        let (socket, _) = accepted.unwrap();
                        let concurrent = read_request(socket, Duration::from_secs(3)).await;
                        assert_ne!(
                            concurrent.first, "PATCH /api/storage/config/ui HTTP/1.1",
                            "PATCH must not be dispatched while revalidation GET is still open"
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
                got_config_get = true;
                req.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({"appearancePreferences":{"mode":"system"}}))
                    .await;
            } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                assert!(
                    got_config_get,
                    "revoked PATCH must NOT hit the wire before revalidation GET completes"
                );
                got_patch = true;
                let mut everything = transcript_preset::patch("everything");
                everything["locale"] = json!("en");
                req.reply(200, json!({"settings":everything})).await;
            }
        }
        wait_until(|| {
            prefs1.poll();
            prefs1.transcript_preset() == "everything" && prefs1.transcript_ready()
        })
        .await;
        let _ = commands_b.send(Command::Close).await;
    });

    // 2. A PATCH ACK arriving after an SSE invalidation publishes the confirmed write immediately
    // (no flicker back to the pre-write preset, and choosing an old value is not dropped) while
    // keeping the trailing authoritative GET queued to reconcile any concurrent remote change.
    let (listener2, mut prefs2) = platform::block_on(fixture());
    platform::block_on(async {
        prefs2.set_transcript(None, "everything");
        assert!(prefs2.poll());
        let patch = request(&listener2).await;
        assert_eq!(patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        // Simulate SSE invalidation arriving before our PATCH 200 ACK.
        prefs2.invalidate(Owner::Config);
        let mut stale_everything = transcript_preset::patch("everything");
        stale_everything["locale"] = json!("en");
        patch.reply(200, json!({"settings":stale_everything})).await;
        let authoritative = poll_next_request(&mut prefs2, &listener2).await;
        assert_eq!(
            authoritative.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        // While the trailing GET is in flight, snapshot reflects the confirmed Everything write
        // rather than reverting to the pre-write Balanced preset.
        assert_eq!(
            prefs2.transcript_preset(),
            "everything",
            "confirmed PATCH ACK must publish immediately instead of reverting to pre-write state"
        );
        assert!(
            prefs2.transcript_error().is_none(),
            "accepted PATCH must still be confirmed without error"
        );
        let mut concurrent_nothing = transcript_preset::patch("nothing");
        concurrent_nothing["locale"] = json!("en");
        authoritative
            .reply(200, json!({"settings":concurrent_nothing}))
            .await;
        wait_until(|| {
            prefs2.poll();
            prefs2.transcript_preset() == "nothing"
        })
        .await;
    });

    // 3. Skip::Transport after switching from Tab A to healthy Tab B must automatically trigger
    // a revalidation GET (never stranding the write with writes_allowed == false while healthy).
    let (listener3, mut prefs3) = platform::block_on(fixture_atomic());
    let mut tab_a3 = prefs3.backend.clone().unwrap();
    tab_a3.client_id.push_str("-departing-a");
    tab_a3.workspace = "project".into();
    tab_a3.session = "session".into();
    let tab_a3_id = tab_a3.client_id.clone();
    let tab_b3_id = "healthy-b".to_owned();
    prefs3.observe_conversation_clients(&[(tab_a3_id.clone(), true)]);
    let (out_a3, events_a3) = bounded(16);
    let (commands_a3, input_a3) = bounded(4);
    let drop_client3 = prefs3.backend.as_ref().unwrap().client.clone();
    platform::block_on(async {
        platform::spawn(async move {
            let _ = run_backend(tab_a3, out_a3, input_a3, Arc::new(|| {})).await;
        });
        let meta_a3 = request(&listener3).await;
        assert_eq!(meta_a3.first, "GET /api/meta HTTP/1.1");
        meta_a3
            .reply(
                200,
                json!({"apiContract":1,"serverId":"fixture-3","capabilities":["settings-atomic-patches"]}),
            )
            .await;
        let mut sse_a3 = request(&listener3).await;
        sse_a3
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener3)
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
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        timeout(Duration::from_secs(5), async {
            loop {
                if matches!(events_a3.recv().await.unwrap(), Event::Sync(_)) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        // Prepare a PATCH while Tab A is active, pause before send, switch to healthy Tab B,
        // drop Tab A, then release: worker sees Tab A's drop -> Skip::Transport -> automatic
        // revalidation GET + PATCH succeeds while Preferences stays healthy on Tab B.
        let (release_tx, release_rx) = bounded(1);
        prefs3.config.set_pre_patch_gate(release_rx);
        prefs3.set_transcript(None, "everything");
        assert!(prefs3.poll());
        prefs3.observe_conversation_clients(&[(tab_b3_id.clone(), true)]);
        assert!(prefs3.transcript_ready());
        drop(sse_a3);
        timeout(Duration::from_secs(4), async {
            while drop_client3.transport_drops(&tab_a3_id) == 0 {
                platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("departing Tab A drop must be recorded");
        let _ = release_tx.send(()).await;
        let mut got_get = false;
        let mut got_patch = false;
        let mut _reconnects = Vec::new();
        timeout(Duration::from_secs(5), async {
            while !(got_get && got_patch) {
                let req = poll_next_request(&mut prefs3, &listener3).await;
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(
                        200,
                        json!({"apiContract":1,"serverId":"fixture-3","capabilities":["settings-atomic-patches"]}),
                    )
                    .await;
                } else if req.first.starts_with("GET /api/events?") {
                    _reconnects.push(req);
                } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    got_get = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req.first == "PATCH /api/storage/config/ui HTTP/1.1" {
                    assert!(got_get, "revalidation GET must precede requeued PATCH");
                    got_patch = true;
                    let mut everything = transcript_preset::patch("everything");
                    everything["locale"] = json!("en");
                    req.reply(200, json!({"settings":everything})).await;
                }
            }
        })
        .await
        .expect("Skip::Transport after healthy tab switch must auto-revalidate and send");
        wait_until(|| {
            prefs3.poll();
            prefs3.transcript_preset() == "everything" && prefs3.transcript_ready()
        })
        .await;
        let _ = commands_a3.send(Command::Close).await;
    });

    // 4. Rapid preset changes and dozens of row toggles coalesce to at most 2 unsent batches
    // ([Preset, Rows]), keeping controls responsive and flushing cleanly without overflow.
    let (listener4, mut prefs4) = platform::block_on(fixture_atomic());
    platform::block_on(async {
        prefs4.set_transcript(None, "minimal");
        assert!(prefs4.poll());
        let in_flight = request(&listener4).await;
        // Identical preset while in flight and queue empty must deduplicate.
        let rev_before = prefs4.revision;
        prefs4.set_transcript(None, "minimal");
        assert_eq!(
            prefs4.revision, rev_before,
            "duplicate in-flight preset must not enqueue a second PATCH"
        );
        // Alternating presets supersede each other; trailing row edits coalesce into one batch.
        prefs4.set_transcript(None, "balanced");
        prefs4.set_transcript(None, "nothing");
        prefs4.set_transcript(None, "everything");
        for i in 0..80 {
            assert!(prefs4.transcript_ready());
            prefs4.set_transcript(
                Some(Row::Diagnostics),
                if i % 2 == 0 { "hidden" } else { "collapsed" },
            );
        }
        prefs4.set_transcript(Some(Row::Groups), "hidden");
        let mut minimal = transcript_preset::patch("minimal");
        minimal["locale"] = json!("en");
        in_flight.reply(200, json!({"settings":minimal})).await;

        let coalesced_preset = poll_next_request(&mut prefs4, &listener4).await;
        assert_eq!(
            coalesced_preset.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        let mut everything = transcript_preset::patch("everything");
        everything["locale"] = json!("en");
        coalesced_preset
            .reply(200, json!({"settings":everything.clone()}))
            .await;

        let coalesced_rows = poll_next_request(&mut prefs4, &listener4).await;
        assert_eq!(
            coalesced_rows.body,
            json!({"settings":{"diagnosticsExpansion":"collapsed","toolGroupVisibility":"hidden"}})
        );
        everything["diagnosticsExpansion"] = json!("collapsed");
        everything["toolGroupVisibility"] = json!("hidden");
        coalesced_rows
            .reply(200, json!({"settings":everything}))
            .await;
        wait_until(|| {
            prefs4.poll();
            prefs4.transcript_mode(Row::Diagnostics, false) == "collapsed"
                && prefs4.transcript_mode(Row::Groups, false) == "hidden"
        })
        .await;
    });

    // 5. HistoryInvalidated (turn cancel/history reload while SSE stays open) must NOT simulate
    // an SSE outage or leave Chat disabled when history finishes reloading.
    let mut root = crate::init();
    let (events_tx, incoming_rx) = bounded(8);
    root.incoming = Some(incoming_rx);
    let backend5 = Backend::unauthenticated("http://127.0.0.1:1").unwrap();
    events_tx.try_send(Event::Connected(backend5)).unwrap();
    assert!(crate::poll_chat(&mut root, 4));
    {
        let mut prefs = root.settings.shared.borrow_mut();
        prefs.fixture();
        prefs.observe_conversation_clients(&crate::workspace::conversation_stream_clients(&root));
        assert!(prefs.transcript_ready());
    }
    events_tx.try_send(Event::HistoryInvalidated).unwrap();
    assert!(crate::poll_chat(&mut root, 4));
    assert!(root.phase == crate::Phase::Reconnecting);
    {
        let mut prefs = root.settings.shared.borrow_mut();
        prefs.observe_conversation_clients(&crate::workspace::conversation_stream_clients(&root));
        assert!(
            prefs.transcript_ready(),
            "HistoryInvalidated over an open SSE stream must not mark transport lost"
        );
    }

    // 6. On a legacy server without settings-atomic-patches, starting from a stale `custom`
    // snapshot with a pending SSE invalidation (another client switched to `detailed`) must run
    // an authoritative GET before editing `read` so `skill`/`invalid` stay collapsed.
    let (listener6, mut prefs6) = platform::block_on(fixture());
    prefs6.config.snapshot = Some(json!({
        "settings": {
            "locale": "en",
            "toolOutputExpansion": "collapsed",
            "toolCallExpansionDefaults": { "preset": "custom", "tools": { "read": "collapsed" } }
        }
    }));
    platform::block_on(async {
        prefs6.invalidate(Owner::Config);
        prefs6.set_transcript(Some(Row::Tool("read")), "expanded");
        assert!(prefs6.poll());
        let preflight = request(&listener6).await;
        assert_eq!(
            preflight.first, "GET /api/storage/config/ui?authoritative=1 HTTP/1.1",
            "legacy client must re-read before editing read when SSE invalidated a custom snapshot"
        );
        preflight
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"detailed"}}}),
            )
            .await;
        let legacy_patch = poll_next_request(&mut prefs6, &listener6).await;
        assert_eq!(legacy_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["read"],
            "expanded"
        );
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["skill"],
            "collapsed"
        );
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["invalid"],
            "collapsed"
        );
        assert_eq!(
            legacy_patch.body["settings"]["toolCallExpansionDefaults"]["tools"]["bash"],
            "expanded"
        );
        let body = legacy_patch.body.clone();
        legacy_patch.reply(200, body).await;
        wait_until(|| {
            prefs6.poll();
            prefs6.transcript_mode(Row::Tool("read"), false) == "expanded"
        })
        .await;
    });
}
