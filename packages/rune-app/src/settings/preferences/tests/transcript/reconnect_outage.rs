use super::super::*;
use crate::settings::transcript_preset;

#[test]
fn hidden_tab_reconnect_attestation_and_repeated_outage_and_voluntary_close_and_readback_sse() {
    use crate::transport::{Command, Event, run_backend};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    platform::block_on(async {
        // 1. Held hidden-tab reconnect /api/meta: saving a masked env var must attest /api/meta
        // (with Cache-Control: no-store) before sending PATCH and never leak the secret to server B.
        let (listener, mut prefs) = fixture_atomic().await;
        let base = prefs.backend.clone().unwrap();
        let mut tab_a = base.clone();
        tab_a.client_id.push_str("-active-a");
        tab_a.workspace = "project".into();
        tab_a.session = "session-a".into();
        let mut tab_b = base.clone();
        tab_b.client_id.push_str("-hidden-b");
        tab_b.workspace = "project".into();
        tab_b.session = "session-b".into();
        let tab_a_id = tab_a.client_id.clone();
        let tab_b_id = tab_b.client_id.clone();
        prefs.observe_conversation_clients(&[(tab_a_id.clone(), true), (tab_b_id.clone(), true)]);
        prefs.show_environment(true);
        assert!(prefs.poll());
        let env_init = request(&listener).await;
        assert_eq!(
            env_init.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        env_init
            .reply(200, json!({"environmentVariables":{},"secureEnvVars":[]}))
            .await;
        wait_until(|| {
            prefs.poll();
            prefs.environment_ready()
        })
        .await;
        let (out_a, events_a) = bounded(16);
        let (cmd_a, in_a) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_a, out_a, in_a, Arc::new(|| {})).await;
        });
        let (mut meta_a_sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 2048];
        let n = meta_a_sock.read(&mut buf).await.unwrap();
        let raw_meta_a = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
        assert!(raw_meta_a.starts_with("get /api/meta http/1.1\r\n"));
        assert!(
            raw_meta_a.contains("cache-control: no-store"),
            "expected Cache-Control: no-store on /api/meta, got:\n{raw_meta_a}"
        );
        let body_a = json!({"apiContract":1,"serverId":"server-a","capabilities":["settings-atomic-patches"]}).to_string();
        meta_a_sock
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body_a.len(),
                    body_a
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        drop(meta_a_sock);
        let mut sse_a = request(&listener).await;
        sse_a
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}))
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
        let (out_b, events_b) = bounded(16);
        let (cmd_b, in_b) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(tab_b, out_b, in_b, Arc::new(|| {})).await;
        });
        let meta_b = request(&listener).await;
        assert_eq!(meta_b.first, "GET /api/meta HTTP/1.1");
        meta_b
            .reply(200, json!({"apiContract":1,"serverId":"server-a","capabilities":["settings-atomic-patches"]}))
            .await;
        let history_b = request(&listener).await;
        assert!(
            !history_b.first.starts_with("GET /api/events?"),
            "second tab must share existing /api/events stream, got {}",
            history_b.first
        );
        history_b
            .reply(200, json!({"status":"window","messages":[{"id":"b","type":"user","text":"b"}],"older":null,"newer":null,"latest":true}))
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
        // Drop the shared SSE stream while attestation is valid, verify EOF itself revokes
        // attestation, then stage a masked secret and confirm Preferences probes /api/meta
        // (and blocks on foreign server-b) without ever sending "top-secret" in a PATCH.
        let client = prefs.backend.as_ref().unwrap().client.clone();
        assert!(!client.needs_capability_recheck());
        drop(sse_a);
        wait_until(|| client.needs_capability_recheck() && client.transport_drops(&tab_b_id) == 1)
            .await;
        assert!(prefs.stage_environment("API_KEY".into(), Some("top-secret".into()), Some(true),));
        assert!(prefs.poll());
        let pre_patch_meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(
            pre_patch_meta.first, "GET /api/meta HTTP/1.1",
            "Preferences must attest /api/meta before sending a masked secret after SSE EOF"
        );
        pre_patch_meta
            .reply(200, json!({"apiContract":1,"serverId":"server-b","capabilities":["settings-atomic-patches"]}))
            .await;
        wait_until(|| {
            prefs.poll();
            !prefs.environment_ready()
        })
        .await;
        // Drain any follow-up revalidation /api/meta (still server-b) and confirm zero PATCH ever ran.
        let mut saw_patch = false;
        let deadline = std::time::Instant::now() + Duration::from_millis(600);
        while std::time::Instant::now() < deadline {
            prefs.poll();
            if let Ok(accepted) = timeout(Duration::from_millis(40), listener.accept()).await {
                let (socket, _) = accepted.unwrap();
                let req = read_request(socket, Duration::from_secs(2)).await;
                if req.first.starts_with("PATCH ") {
                    saw_patch = true;
                }
                req.reply(200, json!({"apiContract":1,"serverId":"server-b","capabilities":["settings-atomic-patches"]})).await;
            }
        }
        assert!(
            !saw_patch,
            "masked secret PATCH must never be sent to foreign server-b"
        );
        assert!(
            !prefs.environment_ready(),
            "Preferences must stay blocked after foreign server-b rejection"
        );
        let _ = cmd_a.send(Command::Close).await;
        let _ = cmd_b.send(Command::Close).await;

        // 2. Active Tab A drops while hidden Tab B is healthy: repeated outage must be detected.
        let (listener2, mut prefs2) = fixture().await;
        let mut ta = prefs2.backend.clone().unwrap();
        ta.client_id.push_str("-rep-a");
        ta.workspace = "project".into();
        ta.session = "session-rep-a".into();
        let ta_id = ta.client_id.clone();
        let tb_id = "rep-tab-b".to_owned();
        prefs2.observe_conversation_clients(&[(ta_id.clone(), true), (tb_id.clone(), true)]);
        let (oa, ea) = bounded(16);
        let (ca, ia) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(ta, oa, ia, Arc::new(|| {})).await;
        });
        let mut sse_rep = request(&listener2).await;
        sse_rep
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener2)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"a","type":"user","text":"a"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener2)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), ea.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        drop(sse_rep);
        let client2 = prefs2.backend.as_ref().unwrap().client.clone();
        wait_until(|| client2.transport_drops(&ta_id) == 1).await;
        assert!(!prefs2.is_repeated_outage(&ta_id));
        prefs2.note_client_outage(&ta_id);
        prefs2.mark_transport_lost();
        assert!(
            prefs2.is_repeated_outage(&ta_id),
            "subsequent 503 retries for active Tab A must be recognized as repeated outage even while Tab B is healthy"
        );
        let _ = ca.send(Command::Close).await;

        // 3. Voluntary close of last conversation tab on !atomic server + pre-poll catalog
        // re-attestation must still mark Preferences transport_lost before any legacy PATCH.
        let (listener3, mut prefs3) = fixture().await;
        let base3 = prefs3.backend.clone().unwrap();
        attest(&listener3, &base3, "legacy-a").await;
        let mut only_tab = base3.clone();
        only_tab.client_id.push_str("-only");
        only_tab.workspace = "project".into();
        only_tab.session = "session-only".into();
        let (o3, e3) = bounded(16);
        let (c3, i3) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(only_tab, o3, i3, Arc::new(|| {})).await;
        });
        let m3 = request(&listener3).await;
        assert_eq!(m3.first, "GET /api/meta HTTP/1.1");
        m3.reply(
            200,
            json!({"apiContract":1,"serverId":"legacy-a","capabilities":[]}),
        )
        .await;
        let mut sse3 = request(&listener3).await;
        sse3.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener3)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"o","type":"user","text":"o"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener3)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e3.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        let gen_before = base3.client.drop_generation();
        let _ = c3.send(Command::Close).await;
        drop(sse3);
        wait_until(|| base3.client.drop_generation() > gen_before).await;
        // Re-attest before Preferences polls (clearing attestation_revoked()).
        attest(&listener3, &base3, "legacy-a").await;
        assert!(!base3.client.attestation_revoked());
        assert!(prefs3.poll());
        assert!(
            prefs3.is_transport_lost(),
            "voluntary close of last SSE followed by catalog re-attestation must still require revalidation"
        );

        // 4. Lost-receipt PATCH readback started AFTER SSE storage.configChanged confirms cleanly
        // without firing a false failure alert.
        let (listener4, mut prefs4) = fixture().await;
        let mut sse_tab = prefs4.backend.clone().unwrap();
        sse_tab.client_id.push_str("-sse-rb");
        sse_tab.workspace = "project".into();
        sse_tab.session = "session-rb".into();
        let (o4, e4) = bounded(16);
        let (c4, i4) = bounded(4);
        platform::spawn(async move {
            let _ = run_backend(sse_tab, o4, i4, Arc::new(|| {})).await;
        });
        let mut sse4 = request(&listener4).await;
        sse4.socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        request(&listener4)
            .await
            .reply(200, json!({"status":"window","messages":[{"id":"r","type":"user","text":"r"}],"older":null,"newer":null,"latest":true}))
            .await;
        request(&listener4)
            .await
            .reply(200, json!({"data":{}}))
            .await;
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e4.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Sync(_)
            ) {
                break;
            }
        }
        prefs4.set_locale("fr");
        assert!(prefs4.poll());
        let patch4 = request(&listener4).await;
        assert_eq!(patch4.first, "PATCH /api/storage/config/ui HTTP/1.1");
        // Server applies PATCH, emits SSE configChanged first, then drops the PATCH socket.
        sse4.socket
            .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
            .await
            .unwrap();
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e4.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Preferences(Owner::Config)
            ) {
                prefs4.invalidate_from_sse(Owner::Config);
                break;
            }
        }
        drop(patch4);
        let readback4 = request(&listener4).await;
        assert_eq!(
            readback4.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback4
            .reply(200, json!({"settings":{"locale":"fr"}}))
            .await;
        wait_until(|| {
            prefs4.poll();
            prefs4.locale() == Some("fr") && !prefs4.config.refreshing()
        })
        .await;
        assert!(
            prefs4.error().is_none(),
            "lost-receipt readback started after SSE invalidation must not report an error"
        );
        assert!(
            !prefs4.take_notification_failure(),
            "lost-receipt readback started after SSE invalidation must not fire a failure toast"
        );

        // 5. Lost-receipt PATCH readback invalidated MID-GET by its own SSE storage.configChanged
        // defers settlement to the follow-up fresh GET and confirms without a false failure toast.
        prefs4.set_transcript(Some(Row::Diagnostics), "hidden");
        assert!(prefs4.poll());
        let diag_patch = request(&listener4).await;
        assert_eq!(diag_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        drop(diag_patch);
        let first_rb = request(&listener4).await;
        assert_eq!(
            first_rb.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        sse4.socket
            .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
            .await
            .unwrap();
        loop {
            if matches!(
                timeout(Duration::from_secs(4), e4.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Event::Preferences(Owner::Config)
            ) {
                prefs4.invalidate_from_sse(Owner::Config);
                break;
            }
        }
        first_rb
            .reply(
                200,
                json!({"settings":{"locale":"fr","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        let second_rb = poll_next_request(&mut prefs4, &listener4).await;
        assert_eq!(
            second_rb.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        assert!(
            !prefs4.take_notification_failure(),
            "invalidated readback must not fire a premature failure toast before the follow-up GET"
        );
        second_rb
            .reply(
                200,
                json!({"settings":{"locale":"fr","diagnosticsExpansion":"hidden"}}),
            )
            .await;
        wait_until(|| {
            prefs4.poll();
            prefs4.transcript_mode(Row::Diagnostics, false) == "hidden"
                && !prefs4.config.refreshing()
        })
        .await;
        assert!(prefs4.transcript_error().is_none());
        assert!(!prefs4.take_notification_failure());
        let _ = c4.send(Command::Close).await;
        drop(sse4);

        // 6. When both a preset (Everything) and a following row edit (read -> hidden) fail,
        // Retry must send them as two separate ordered PATCHes (preset first, then row) rather
        // than merging them into one conflicting PATCH.
        let (listener5, mut prefs5) = fixture_atomic().await;
        prefs5.set_transcript(None, "everything");
        assert!(prefs5.poll());
        let p5 = request(&listener5).await;
        prefs5.set_transcript(Some(Row::Tool("read")), "hidden");
        p5.reply(503, json!({})).await;
        let rb5a = request(&listener5).await;
        rb5a.reply(200, json!({"settings":{"locale":"en"}})).await;
        let r5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(
            r5.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        r5.reply(503, json!({})).await;
        let rb5b = request(&listener5).await;
        rb5b.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| {
            prefs5.poll();
            !prefs5.config.refreshing() && prefs5.transcript_error().is_some()
        })
        .await;
        prefs5.retry_transcript();
        let retry_get5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(
            retry_get5.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        retry_get5
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        let retry_preset5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(retry_preset5.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            retry_preset5.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        let mut saved5 = transcript_preset::patch("everything");
        saved5["locale"] = json!("en");
        retry_preset5
            .reply(200, json!({"settings":saved5.clone()}))
            .await;
        let retry_row5 = poll_next_request(&mut prefs5, &listener5).await;
        assert_eq!(
            retry_row5.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        assert_eq!(
            retry_row5.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"hidden"}}}})
        );
        saved5["toolCallExpansionDefaults"]["preset"] = json!("custom");
        saved5["toolCallExpansionDefaults"]["tools"]["read"] = json!("hidden");
        retry_row5.reply(200, json!({"settings":saved5})).await;
        wait_until(|| {
            prefs5.poll();
            !prefs5.config.refreshing() && prefs5.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs5.transcript_mode(Row::Tool("read"), false), "hidden");
        assert_eq!(
            prefs5.transcript_mode(Row::Tool("write"), false),
            "expanded"
        );

        // 7. Server downgraded mid-session (SSE stays open) returns 400 on `?conditional=atomic-v1`:
        // Retry must re-attest `/api/meta`, discover `capabilities: []`, and succeed with legacy PATCH.
        let (listener6, mut prefs6) = fixture_atomic().await;
        prefs6.set_transcript(Some(Row::Tool("read")), "expanded");
        assert!(prefs6.poll());
        let bad_atomic = request(&listener6).await;
        assert_eq!(
            bad_atomic.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        bad_atomic
            .reply(400, json!({"error":"Unknown conditional patch mode"}))
            .await;
        wait_until(|| {
            prefs6.poll();
            !prefs6.config.refreshing() && prefs6.transcript_error().is_some()
        })
        .await;
        assert!(
            prefs6
                .backend
                .as_ref()
                .unwrap()
                .client
                .needs_capability_recheck(),
            "400 on atomic-v1 PATCH must force capability recheck on Retry"
        );
        prefs6.retry_transcript();
        let mut saw_meta6 = false;
        let legacy6 = loop {
            let req = poll_next_request(&mut prefs6, &listener6).await;
            if req.first == "GET /api/meta HTTP/1.1" {
                saw_meta6 = true;
                req.reply(
                    200,
                    json!({"apiContract":1,"serverId":"fixture-atomic","capabilities":[]}),
                )
                .await;
            } else if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({})).await;
            } else {
                break req;
            }
        };
        assert!(
            saw_meta6,
            "Retry must re-attest /api/meta after atomic-v1 400"
        );
        assert_eq!(
            legacy6.first, "PATCH /api/storage/config/ui HTTP/1.1",
            "Retry after downgrade must fall back to non-atomic PATCH"
        );
        let mut legacy_saved = legacy6.body["settings"].clone();
        legacy_saved["locale"] = json!("en");
        legacy6.reply(200, json!({"settings":legacy_saved})).await;
        wait_until(|| {
            prefs6.poll();
            !prefs6.config.refreshing() && prefs6.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs6.transcript_mode(Row::Tool("read"), false), "expanded");
    });
}
