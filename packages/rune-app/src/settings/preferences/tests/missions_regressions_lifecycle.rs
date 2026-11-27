use super::{
    missions::{click, click_option, make_window, next_request, settle_meta, tick},
    missions_regressions::drain_location_catalog_and_depth,
    *,
};
use crate::settings::{providers::Target, view};
use std::{cell::Cell, rc::Rc, sync::Arc};

#[test]
fn depth_put_aborts_when_sse_session_moved_arrives_during_flush_attestation() {
    let (listener, shared, _rt, mut sse_stream, attest_meta, backend_client) =
        platform::block_on(async {
            let (listener, mut prefs) = fixture().await;
            let backend = prefs.backend.as_mut().unwrap();
            backend.workspace = "captured".into();
            backend.session = "session".into();
            let backend_client = backend.client.clone();

            // Establish initial server attestation so depth PUT runs GET /api/meta before PUT.
            let attest_client = backend.clone();
            let (attest_tx, attest_rx) = bounded(1);
            platform::spawn(async move {
                let _ = attest_tx.send(attest_client.attest_server().await).await;
            });
            let init_meta = request(&listener).await;
            assert_eq!(init_meta.first, "GET /api/meta HTTP/1.1");
            init_meta
                .reply(
                    200,
                    json!({"apiContract":1,"serverId":"srv-flush-depth","capabilities":[]}),
                )
                .await;
            attest_rx.recv().await.unwrap().unwrap();

            // Open a live multiplexed SSE stream on the same Http client (shared by CatalogueWatch
            // and PreferencesWatch) so session.moved is observed on the background SSE task.
            let (wake_tx, wake_rx) = bounded(16);
            let watch_wake: rune::Waker = Arc::new(move || {
                let _ = wake_tx.try_send(());
            });
            prefs.watch(&watch_wake);
            let mut sse_stream = loop {
                let req = request(&listener).await;
                if req.first == "GET /api/meta HTTP/1.1" {
                    req.reply(
                        200,
                        json!({"apiContract":1,"serverId":"srv-flush-depth","capabilities":[]}),
                    )
                    .await;
                    continue;
                }
                assert!(
                    req.first.starts_with("GET /api/events?"),
                    "expected SSE stream open, got {}",
                    req.first
                );
                break req;
            };
            sse_stream
                .socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            timeout(Duration::from_secs(3), wake_rx.recv())
                .await
                .unwrap()
                .unwrap();
            let _ = prefs.stream.as_ref().unwrap().take();

            let root = crate::init();
            let shared = root.settings.shared.clone();
            prefs.window_wake = Some(Arc::new(|| {}));
            *shared.borrow_mut() = prefs;
            let target = Target::capture(&root).unwrap();
            {
                let mut prefs = shared.borrow_mut();
                prefs
                    .missions
                    .capture_opener(Some("/repo/wt-a".into()), Some(&target));
                prefs.provider_target = Some(target);
            }
            let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
            let mut rt = rune::Runtime::new(
                window,
                view::view,
                (1100.0, 760.0),
                rune::Env::new(false, 1.0),
            );
            rt.frame(0.0);
            settle_meta(&listener, &mut rt).await;
            click(&mut rt, "settings-missions");
            tick(&mut rt);

            let exp_a = "f".repeat(64);
            drain_location_catalog_and_depth(
                &listener,
                &mut rt,
                "/repo/wt-a",
                "%2Frepo%2Fwt-a",
                Some(2),
                &exp_a,
                false,
            )
            .await;
            wait_until(|| {
                tick(&mut rt);
                !shared
                    .borrow()
                    .missions
                    .depth_disabled(true, true, Some("/repo/wt-a"))
            })
            .await;

            // Choose depth 4 and hold GET /api/meta open while closing Preferences into flush().
            click(&mut rt, "mission-subagent-depth-trigger");
            click_option(&mut rt, "mission-subagent-depth", "4");
            tick(&mut rt);
            let attest_meta = next_request(&listener, &mut rt).await;
            assert_eq!(attest_meta.first, "GET /api/meta HTTP/1.1");

            shared.borrow_mut().provider_target = None;
            (
                listener,
                shared,
                rt,
                sse_stream,
                attest_meta,
                backend_client,
            )
        });

    // While native flush() blocks the UI thread (no main-window poll running), deliver
    // session.moved on the open SSE stream, wait for the background Hub to bump location_revision,
    // and then release GET /api/meta.
    let loc_before = backend_client.location_revision();
    let driver = std::thread::spawn(move || {
        platform::block_on(async move {
            sse_stream
                .socket
                .write_all(
                    b"data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"session.moved\",\"data\":{\"sessionID\":\"session\"}}}\n\n",
                )
                .await
                .unwrap();
            wait_until(|| backend_client.location_revision() > loc_before).await;
            attest_meta
                .reply(
                    200,
                    json!({"apiContract":1,"serverId":"srv-flush-depth","capabilities":[]}),
                )
                .await;
            sse_stream
        })
    });

    let flushed = shared.borrow_mut().flush();
    assert!(
        !flushed,
        "depth PUT aborted after SSE session.moved during flush must report unconfirmed"
    );
    let _sse_stream = driver.join().unwrap();

    platform::block_on(async {
        assert!(
            timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err(),
            "depth PUT must never reach worktree A after session.moved arrives during flush()"
        );
    });
}

#[test]
fn missions_confirmation_survives_failed_document_patch_started_in_same_poll() {
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Start a Missions PATCH and queue a Document contrast PATCH behind it.
        click(&mut rt, "mission-delete-sessions");
        tick(&mut rt);
        let patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        shared.borrow_mut().set_contrast("on");
        patch
            .reply(
                200,
                json!({"settings":{"locale":"en","missionDeleteSessions":true}}),
            )
            .await;

        // Authoritative GET confirms missionDeleteSessions=true. On the very next poll,
        // Document settles this GET and immediately launches the queued highContrast PATCH.
        let auth_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            auth_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        auth_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionDeleteSessions":true}}),
            )
            .await;

        // Fail both the queued Document PATCH and its fallback GET with 503.
        let contrast_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            contrast_patch.first,
            "PATCH /api/storage/config/ui HTTP/1.1"
        );
        assert_eq!(
            contrast_patch.body,
            json!({"settings":{"highContrast":"on"}})
        );
        contrast_patch.reply(503, json!({"error":"down"})).await;

        let fallback_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            fallback_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        fallback_get.reply(503, json!({"error":"down"})).await;

        wait_until(|| {
            tick(&mut rt);
            shared.borrow().contrast_failed()
        })
        .await;
        assert!(
            !shared.borrow().missions.has_unconfirmed(),
            "already-confirmed Missions mutation must not be marked failed by a later Document 503"
        );
    });
}

#[test]
fn failed_config_get_unblocks_queued_missions_edits_and_exposes_reload() {
    platform::block_on(async {
        let model = json!({
            "version": 1,
            "id": "004633fb-53c4-477c-8b01-4cc5c177724b",
            "name": "Alpha",
            "objective": "Check alpha",
            "notes": "",
            "template": "custom"
        });
        let (listener, mut prefs) = fixture().await;
        prefs.apply_mission_config(json!({
            "settings": {
                "locale": "en",
                "missionModels": [model.clone()]
            }
        }));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Trigger a config GET (e.g. SSE invalidation) and hold it open.
        shared.borrow_mut().invalidate(Owner::Config);
        tick(&mut rt);
        let held_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            held_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );

        // While the GET is in flight, queue a Defaults edit and confirm a Library removal.
        click(&mut rt, "mission-task-mode-trigger");
        click_option(&mut rt, "mission-task-mode", "Independent sessions");
        click(&mut rt, "mission-model-library-trigger");
        click_option(&mut rt, "mission-model-library", "Alpha");
        click(&mut rt, "mission-models-remove");
        click(&mut rt, "file-decision-confirm");
        tick(&mut rt);
        assert!(shared.borrow().missions.defaults_writing());

        // Fail the held GET with 503: both queued mutations must fail cleanly so Reload is usable.
        held_get.reply(503, json!({"error":"down"})).await;
        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().missions.defaults_writing()
                && rt.find("mission-defaults-reload-unavailable").is_some()
                && rt.find("mission-models-reload").is_some()
        })
        .await;

        // Clicking Reload in Saved configurations must trigger a fresh authoritative GET and recover.
        click(&mut rt, "mission-models-reload");
        tick(&mut rt);
        let reload_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            reload_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        reload_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionModels":[model]}}),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            shared.borrow().config_loaded()
        })
        .await;
    });
}

#[test]
fn closing_web_settings_preserves_inflight_depth_put_acknowledgement() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let root = crate::init();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;
        let target = Target::capture(&root).unwrap();
        {
            let mut prefs = shared.borrow_mut();
            prefs
                .missions
                .capture_opener(Some("/repo/wt-a".into()), Some(&target));
            prefs.provider_target = Some(target);
        }
        let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        let exp_a = "a".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp_a,
            false,
        )
        .await;
        wait_until(|| {
            tick(&mut rt);
            !shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-a"))
        })
        .await;

        // Start a depth PUT and hold it open on the server.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);
        let put = next_request(&listener, &mut rt).await;
        assert_eq!(
            put.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );

        // Simulate Web Settings close: clear provider_target and poll missions with active = false.
        let wake: rune::Waker = Arc::new(|| {});
        let mut closed_missions = crate::settings::missions::Missions::default();
        shared.borrow_mut().provider_target = None;
        closed_missions.poll(&mut shared.borrow_mut(), &wake, false);

        // Server now acknowledges the PUT with 204 No Content: must settle confirmed, not Uncertain.
        put.reply_no_content().await;
        wait_until(|| {
            closed_missions.poll(&mut shared.borrow_mut(), &wake, false);
            !shared.borrow().missions.has_unconfirmed()
        })
        .await;
    });
}
