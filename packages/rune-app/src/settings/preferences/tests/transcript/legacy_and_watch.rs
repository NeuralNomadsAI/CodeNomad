use super::super::*;

#[test]
fn legacy_materialization_stale_requeue_and_watch_revalidation() {
    use crate::transport::{Event, run_backend};
    use std::sync::Arc;
    use tokio::io::AsyncWriteExt;

    platform::block_on(async {
        // 8. Staging update feed after an SSE disconnect queues server revalidation GET so Info
        // never gets stuck disabled when HTTP still works.
        let (listener7, mut prefs7) = fixture().await;
        prefs7.mark_transport_lost();
        prefs7.stage_update_feed("preview");
        assert!(prefs7.poll());
        let srv_get = poll_next_request(&mut prefs7, &listener7).await;
        assert_eq!(
            srv_get.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        srv_get.reply(200, json!({"updateFeed":"stable"})).await;
        let srv_patch = poll_next_request(&mut prefs7, &listener7).await;
        assert_eq!(srv_patch.first, "PATCH /api/storage/config/server HTTP/1.1");
        assert_eq!(srv_patch.body, json!({"updateFeed":"preview"}));
        srv_patch.reply(200, json!({"updateFeed":"preview"})).await;
        wait_until(|| {
            prefs7.poll();
            !prefs7.update_feed_pending()
        })
        .await;
        assert!(!prefs7.update_feed_failed());

        // 9. General tab exposes transport_lost error and staging locale after SSE loss queues
        // revalidation GET so saves complete when HTTP still responds.
        let (listener8, mut prefs8) = fixture().await;
        prefs8.mark_transport_lost();
        assert_eq!(prefs8.general_error(), Some("rune.connect_error"));
        prefs8.set_locale("fr");
        assert!(prefs8.poll());
        let g8 = poll_next_request(&mut prefs8, &listener8).await;
        assert_eq!(
            g8.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        g8.reply(200, json!({"settings":{"locale":"en"}})).await;
        let p8 = loop {
            let req = poll_next_request(&mut prefs8, &listener8).await;
            if req.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req.reply(200, json!({})).await;
            } else {
                break req;
            }
        };
        assert_eq!(p8.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(p8.body, json!({"settings":{"locale":"fr"}}));
        p8.reply(200, json!({"settings":{"locale":"fr"}})).await;
        wait_until(|| {
            prefs8.poll();
            prefs8.locale() == Some("fr") && !prefs8.config.refreshing()
        })
        .await;
        assert!(prefs8.general_error().is_none());

        // 10. Held 400 on `?conditional=atomic-v1` must NOT revoke a newer `/api/meta` attestation.
        let (listener9, mut prefs9) = fixture_atomic().await;
        let base9 = prefs9.backend.clone().unwrap();
        prefs9.set_transcript(Some(Row::Tool("read")), "expanded");
        assert!(prefs9.poll());
        let held_400 = request(&listener9).await;
        assert_eq!(
            held_400.first,
            "PATCH /api/storage/config/ui?conditional=atomic-v1 HTTP/1.1"
        );
        // Simulate a newer `/api/meta` probe advancing observed stamp before the old 400 arrives.
        base9.client.observe_atomic_settings_patches(true);
        held_400
            .reply(400, json!({"error":"Unknown conditional patch mode"}))
            .await;
        wait_until(|| {
            prefs9.poll();
            !prefs9.config.refreshing() && prefs9.transcript_error().is_some()
        })
        .await;
        assert!(
            base9.client.supports_atomic_settings_patches(),
            "stale 400 on atomic-v1 must not revoke a newer capability observation"
        );
        assert!(!base9.client.needs_capability_recheck());

        // 11. On a legacy (!atomic) server, editing a Chat tool row refreshes config/ui from disk
        // first so external config.yaml overrides (e.g. bash: hidden without SSE) are preserved.
        let (listener10, mut prefs10) = fixture().await;
        prefs10.set_transcript(Some(Row::Tool("read")), "hidden");
        assert!(prefs10.poll());
        let pre10 = request(&listener10).await;
        assert_eq!(
            pre10.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre10
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"balanced","tools":{"bash":"hidden"}}}}),
            )
            .await;
        let patch10 = poll_next_request(&mut prefs10, &listener10).await;
        assert_eq!(patch10.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert!(
            patch10.body["settings"]["toolCallExpansionDefaults"]["tools"]
                .get("bash")
                .is_none(),
            "legacy tool materialization must omit bash so external config.yaml bash: hidden is not overwritten"
        );
        assert_eq!(
            patch10.body["settings"]["toolCallExpansionDefaults"]["tools"]["write"],
            "expanded"
        );
        assert_eq!(
            patch10.body["settings"]["toolCallExpansionDefaults"]["tools"]["read"],
            "hidden"
        );
        let mut saved10 = patch10.body["settings"].clone();
        saved10["locale"] = json!("en");
        saved10["toolCallExpansionDefaults"]["tools"]["bash"] = json!("hidden");
        patch10.reply(200, json!({"settings":saved10})).await;
        wait_until(|| {
            prefs10.poll();
            !prefs10.config.refreshing()
                && prefs10.transcript_mode(Row::Tool("read"), false) == "hidden"
        })
        .await;
        assert_eq!(prefs10.transcript_mode(Row::Tool("bash"), false), "hidden");

        // 12. Lost-receipt row edit confirmed during Retry GET is still preserved after the failed
        // Everything preset replays, instead of being overwritten back to expanded.
        let (listener11, mut prefs11) = fixture_atomic().await;
        prefs11.set_transcript(None, "everything");
        assert!(prefs11.poll());
        let p11 = request(&listener11).await;
        prefs11.set_transcript(Some(Row::Tool("read")), "hidden");
        p11.reply(503, json!({})).await;
        request(&listener11)
            .await
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        let r11 = poll_next_request(&mut prefs11, &listener11).await;
        drop(r11); // Server applied read=hidden, but receipt lost + first readback fails 503.
        request(&listener11).await.reply(503, json!({})).await;
        wait_until(|| {
            prefs11.poll();
            !prefs11.config.refreshing() && prefs11.transcript_error().is_some()
        })
        .await;
        prefs11.retry_transcript();
        let retry_get11 = poll_next_request(&mut prefs11, &listener11).await;
        retry_get11
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"hidden"}}}}),
            )
            .await;
        let rp11 = poll_next_request(&mut prefs11, &listener11).await;
        assert_eq!(
            rp11.body["settings"]["toolCallExpansionDefaults"]["preset"],
            "everything"
        );
        let mut s11 = transcript_preset::patch("everything");
        s11["locale"] = json!("en");
        rp11.reply(200, json!({"settings":s11.clone()})).await;
        let rr11 = poll_next_request(&mut prefs11, &listener11).await;
        assert_eq!(
            rr11.body,
            json!({"settings":{"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"hidden"}}}})
        );
        s11["toolCallExpansionDefaults"]["preset"] = json!("custom");
        s11["toolCallExpansionDefaults"]["tools"]["read"] = json!("hidden");
        rr11.reply(200, json!({"settings":s11})).await;
        wait_until(|| {
            prefs11.poll();
            !prefs11.config.refreshing() && prefs11.transcript_error().is_none()
        })
        .await;
        assert_eq!(prefs11.transcript_mode(Row::Tool("read"), false), "hidden");
        assert_eq!(
            prefs11.transcript_mode(Row::Tool("write"), false),
            "expanded"
        );

        // 13. On a legacy (!atomic) server with an existing notificationRouting table, an SSE
        // storage.configChanged arriving between queued route edits must refresh first instead of
        // deadlocking the config/ui queue in Skip::Stale.
        {
            use crate::settings::notification_routing::{Category, Destination};
            let (listener12, mut prefs12) = fixture().await;
            let mut sse_tab12 = prefs12.backend.clone().unwrap();
            sse_tab12.client_id.push_str("-sse-nr");
            sse_tab12.workspace = "project".into();
            sse_tab12.session = "session-nr".into();
            let (o12, e12) = bounded(16);
            let (_c12, i12) = bounded(4);
            platform::spawn(async move {
                let _ = run_backend(sse_tab12, o12, i12, Arc::new(|| {})).await;
            });
            let mut sse12 = request(&listener12).await;
            sse12
                .socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            request(&listener12)
                .await
                .reply(200, json!({"status":"window","messages":[{"id":"r","type":"user","text":"r"}],"older":null,"newer":null,"latest":true}))
                .await;
            request(&listener12)
                .await
                .reply(200, json!({"data":{}}))
                .await;
            loop {
                if matches!(
                    timeout(Duration::from_secs(4), e12.recv())
                        .await
                        .unwrap()
                        .unwrap(),
                    Event::Sync(_)
                ) {
                    break;
                }
            }
            prefs12.refresh();
            let mut got_cfg12 = false;
            let mut got_state12 = false;
            while !got_cfg12 || !got_state12 {
                let req12 = poll_next_request(&mut prefs12, &listener12).await;
                if req12.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    req12
                        .reply(
                            200,
                            json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":true,"history":false}}}}),
                        )
                        .await;
                    got_cfg12 = true;
                } else {
                    req12.reply(200, json!({})).await;
                    got_state12 = true;
                }
            }
            wait_until(|| {
                prefs12.poll();
                !prefs12.config.refreshing()
                    && !prefs12.state.refreshing()
                    && prefs12.notification_route(Category::NeedsInput, Destination::Screen)
            })
            .await;
            prefs12.set_notification_route(Category::NeedsInput, Destination::History, true);
            assert!(prefs12.poll());
            let p12a = request(&listener12).await;
            assert_eq!(p12a.first, "PATCH /api/storage/config/ui HTTP/1.1");
            prefs12.set_notification_route(Category::NeedsInput, Destination::Screen, false);
            let rev12 = prefs12
                .backend
                .as_ref()
                .unwrap()
                .client
                .preferences_revision(Owner::Config);
            sse12
                .socket
                .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
                .await
                .unwrap();
            wait_until(|| {
                prefs12
                    .backend
                    .as_ref()
                    .unwrap()
                    .client
                    .preferences_revision(Owner::Config)
                    > rev12
            })
            .await;
            p12a.reply(
                200,
                json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":true,"history":true}}}}),
            )
            .await;
            let pre12 = poll_next_request(&mut prefs12, &listener12).await;
            assert_eq!(
                pre12.first,
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
            );
            pre12
                .reply(
                    200,
                    json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":true,"history":true}}}}),
                )
                .await;
            let p12b = poll_next_request(&mut prefs12, &listener12).await;
            assert_eq!(p12b.first, "PATCH /api/storage/config/ui HTTP/1.1");
            p12b.reply(
                200,
                json!({"settings":{"locale":"en","notificationRouting":{"needsInput":{"screen":false,"history":true}}}}),
            )
            .await;
            wait_until(|| {
                prefs12.poll();
                !prefs12.config.refreshing()
                    && !prefs12.config.draining()
                    && !prefs12.notification_route(Category::NeedsInput, Destination::Screen)
            })
            .await;
        }

        // 14. On a legacy (!atomic) server, an explicit Preferences::refresh() while a legacy
        // materializing PATCH is paused at pre_patch_gate cancels that PATCH as stale, rereads
        // disk, and preserves external bash: hidden in the rebuilt PATCH.
        let (listener13, mut prefs13) = fixture().await;
        prefs13.set_transcript(Some(Row::Tool("read")), "hidden");
        assert!(prefs13.poll());
        let pre13a = request(&listener13).await;
        assert_eq!(
            pre13a.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let (gate_tx13, gate_rx13) = bounded(1);
        prefs13.config.set_pre_patch_gate(gate_rx13);
        pre13a.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| {
            prefs13.poll();
            prefs13.config.refreshing()
        })
        .await;
        prefs13.refresh();
        let _ = gate_tx13.try_send(());
        let pre13b = loop {
            let req13 = poll_next_request(&mut prefs13, &listener13).await;
            if req13.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req13.reply(200, json!({})).await;
                continue;
            }
            break req13;
        };
        assert_eq!(
            pre13b.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre13b
            .reply(
                200,
                json!({"settings":{"locale":"en","toolCallExpansionDefaults":{"preset":"balanced","tools":{"bash":"hidden"}}}}),
            )
            .await;
        let patch13 = loop {
            let req13 = poll_next_request(&mut prefs13, &listener13).await;
            if req13.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                req13.reply(200, json!({})).await;
                continue;
            }
            break req13;
        };
        assert_eq!(patch13.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert!(
            patch13.body["settings"]["toolCallExpansionDefaults"]["tools"]
                .get("bash")
                .is_none(),
            "explicit refresh before send must cancel stale legacy PATCH and preserve bash: hidden"
        );
        let mut saved13 = patch13.body["settings"].clone();
        saved13["locale"] = json!("en");
        saved13["toolCallExpansionDefaults"]["tools"]["bash"] = json!("hidden");
        patch13.reply(200, json!({"settings":saved13})).await;
        wait_until(|| {
            prefs13.poll();
            !prefs13.config.refreshing()
                && prefs13.transcript_mode(Row::Tool("read"), false) == "hidden"
        })
        .await;
        assert_eq!(prefs13.transcript_mode(Row::Tool("bash"), false), "hidden");

        // 15. On a legacy (!atomic) server, if a row PATCH is skipped as stale (`Skip::Stale`)
        // while a TranscriptPreset is already queued behind it, requeuing keeps the row edit
        // ahead of the preset so it still sends first and survives a subsequent preset 503.
        let (listener14, mut prefs14) = fixture().await;
        prefs14.set_transcript(Some(Row::Tool("read")), "hidden");
        assert!(prefs14.poll());
        let pre14a = request(&listener14).await;
        assert_eq!(
            pre14a.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        let (gate_tx14, gate_rx14) = bounded(1);
        prefs14.config.set_pre_patch_gate(gate_rx14);
        pre14a.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| {
            prefs14.poll();
            prefs14.config.refreshing()
        })
        .await;
        // Stage preset "everything" while `read` is paused at pre_patch_gate, then fire an
        // external invalidation so `read` skips as `Skip::Stale`.
        prefs14.set_transcript(None, "everything");
        prefs14.invalidate(Owner::Config);
        let _ = gate_tx14.try_send(());

        let pre14b = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(
            pre14b.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        pre14b.reply(200, json!({"settings":{"locale":"en"}})).await;

        let read_patch14 = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(read_patch14.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            read_patch14.body["settings"]["toolCallExpansionDefaults"]["tools"]["read"],
            json!("hidden"),
            "stale row edit must be requeued ahead of queued preset, not dropped"
        );
        assert_eq!(
            read_patch14.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("custom")
        );
        let mut saved14 = read_patch14.body["settings"].clone();
        saved14["locale"] = json!("en");
        read_patch14
            .reply(200, json!({"settings":saved14.clone()}))
            .await;

        let preset_patch14 = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(
            preset_patch14.first,
            "PATCH /api/storage/config/ui HTTP/1.1"
        );
        assert_eq!(
            preset_patch14.body["settings"]["toolCallExpansionDefaults"]["preset"],
            json!("everything")
        );
        preset_patch14.reply(503, json!({})).await;
        let readback14 = poll_next_request(&mut prefs14, &listener14).await;
        assert_eq!(
            readback14.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        readback14
            .reply(200, json!({"settings":saved14.clone()}))
            .await;
        wait_until(|| {
            prefs14.poll();
            prefs14.transcript_error().is_some()
        })
        .await;
        assert_eq!(
            prefs14.transcript_mode(Row::Tool("read"), false),
            "hidden",
            "requeued row edit must survive a 503 on the queued preset"
        );

        // 16. A healthy Missions PreferencesWatch stream counts as another healthy stream when
        // the sole background conversation stream drops, immediately triggering revalidation.
        let (listener15, mut prefs15) = fixture().await;
        let sse_wake15: rune::Waker = Arc::new(|| {});
        prefs15.watch_project(Some("proj-b"), &sse_wake15);
        let mut sse_req15 = request(&listener15).await;
        assert!(sse_req15.first.starts_with("GET /api/events?"));
        sse_req15
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        wait_until(|| {
            prefs15.poll();
            prefs15.has_healthy_watch_stream()
        })
        .await;
        // Simulate ConnectionLost on the sole background conversation stream while Missions watch
        // remains connected: Preferences must revalidate immediately and keep transcript_ready.
        let conv_id = "conv-bg-a".to_owned();
        prefs15.observe_conversation_clients(&[(conv_id.clone(), true)]);
        prefs15.note_client_outage(&conv_id);
        prefs15.mark_transport_lost();
        assert!(!prefs15.transcript_ready());
        assert!(prefs15.has_healthy_watch_stream());
        prefs15.revalidate_transport();
        prefs15.observe_conversation_clients(&[(conv_id.clone(), false)]);
        let mut saw_cfg15 = false;
        let mut saw_state15 = false;
        while !(saw_cfg15 && saw_state15 && prefs15.transcript_ready()) {
            prefs15.poll();
            if saw_cfg15 && saw_state15 && prefs15.transcript_ready() {
                break;
            }
            if let Ok(req15) = timeout(
                Duration::from_millis(20),
                poll_next_request(&mut prefs15, &listener15),
            )
            .await
            {
                if req15.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    saw_cfg15 = true;
                    req15.reply(200, json!({"settings":{"locale":"en"}})).await;
                } else if req15.first == "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" {
                    saw_state15 = true;
                    req15.reply(200, json!({})).await;
                } else {
                    panic!(
                        "unexpected request during watch revalidation: {}",
                        req15.first
                    );
                }
            }
        }
        wait_until(|| {
            prefs15.poll();
            prefs15.transcript_ready()
        })
        .await;
        drop(sse_req15);
    });
}
