use super::{
    missions::{click, click_option, make_window, next_request, settle_meta, tick},
    missions_regressions::{depth_snapshot_json, drain_location_catalog_and_depth},
    *,
};
use crate::settings::{providers::Target, view};
use std::{cell::Cell, rc::Rc, sync::Arc};

#[test]
fn depth_put_aborts_when_sse_session_moved_arrives_during_flush_attestation() {
    let (
        listener,
        shared,
        _rt,
        mut sse_stream,
        attest_meta,
        backend_client,
        post_attest_entered,
        release_post_attest,
    ) = platform::block_on(async {
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
            true,
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

        // Pause the depth PUT worker right after authorize_send finishes and
        // immediately before set_subagent_depth_checked sends the PUT.
        let (entered_post_attest, post_attest_entered) = bounded(1);
        let (release_post_attest, post_attest_gate) = bounded(1);
        shared
            .borrow_mut()
            .missions
            .set_post_attest_depth_gate(entered_post_attest, post_attest_gate);

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
            post_attest_entered,
            release_post_attest,
        )
    });

    // While native flush() blocks the UI thread (no main-window poll running):
    // 1. Reply 200 OK to GET /api/meta so authorize_send() finishes and returns true.
    // 2. Wait until the worker signals it is paused immediately before set_subagent_depth_checked,
    //    then deliver session.moved on the open SSE stream and wait for Hub::location_revision.
    // 3. Resume the worker: set_subagent_depth_checked's synchronous pre-send guard must abort.
    let loc_before = backend_client.location_revision("captured", Some("session"));
    let driver = std::thread::spawn(move || {
        platform::block_on(async move {
            attest_meta
                .reply(
                    200,
                    json!({"apiContract":1,"serverId":"srv-flush-depth","capabilities":[]}),
                )
                .await;
            post_attest_entered.recv().await.unwrap();
            sse_stream
                .socket
                .write_all(
                    b"data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"session.moved\",\"data\":{\"sessionID\":\"session\"}}}\n\n",
                )
                .await
                .unwrap();
            wait_until(|| {
                backend_client.location_revision("captured", Some("session")) > loc_before
            })
            .await;
            release_post_attest.send(()).await.unwrap();
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
            true,
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

#[test]
fn unrelated_workspace_session_move_does_not_block_depth_writes() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let backend_client = backend.client.clone();

        let (wake_tx, wake_rx) = bounded(16);
        let watch_wake: rune::Waker = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        prefs.watch(&watch_wake);
        let mut sse_stream = request(&listener).await;
        assert!(sse_stream.first.starts_with("GET /api/events?"));
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

        let exp_a = "1".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp_a,
            true,
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

        // Deliver session.moved for an unrelated workspace and an unrelated session on the same server.
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.event\",\"instanceId\":\"other-ws\",\"event\":{\"type\":\"session.moved\",\"data\":{\"sessionID\":\"other-ses\"}}}\n\n\
data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"session.moved\",\"data\":{\"sessionID\":\"other-ses\"}}}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| {
            backend_client.location_revision("other-ws", Some("other-ses")) > 0
                && backend_client.location_revision("captured", Some("other-ses")) > 0
        })
        .await;
        assert_eq!(
            backend_client.location_revision("captured", Some("session")),
            0
        );

        // Choosing depth 4 on the unaffected workspace/session must still send PUT cleanly.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);
        let put = next_request(&listener, &mut rt).await;
        assert_eq!(
            put.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put.body["depth"], json!(4));
        put.reply_no_content().await;
    });
}

#[test]
fn native_flush_revalidates_sse_invalidated_config_before_queued_missions_edit() {
    let (listener, shared, _rt, _sse_stream, _other_watch) = platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.clone().unwrap();
        let backend_client = backend.client.clone();

        // Open a live SSE stream on the same Http client WITHOUT attaching PreferencesWatch to
        // `prefs.stream` (simulating a conversation SSE stream bumping preferences_revision while
        // PreferencesWatch is inactive).
        let (wake_tx, wake_rx) = bounded(16);
        let watch_wake: rune::Waker = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let (other_watch, task) = PreferencesWatch::task(backend.clone(), None, watch_wake);
        platform::spawn(task);
        let mut sse_stream = request(&listener).await;
        assert!(sse_stream.first.starts_with("GET /api/events?"));
        sse_stream
            .socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        timeout(Duration::from_secs(3), wake_rx.recv())
            .await
            .unwrap()
            .unwrap();

        prefs.apply_mission_config(json!({
            "settings": {
                "locale": "en",
                "missionProfileDefaults": []
            }
        }));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Hold a config GET open so the Missions edit stays queued without any Document write.
        shared.borrow_mut().invalidate(Owner::Config);
        tick(&mut rt);
        let held_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            held_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        click(&mut rt, "mission-task-mode-trigger");
        click_option(&mut rt, "mission-task-mode", "Independent sessions");
        tick(&mut rt);
        assert!(shared.borrow().missions.defaults_writing());

        // Complete the held GET with the old snapshot, then bump preferences_revision via SSE
        // BEFORE flush() runs (and without calling tick() first).
        held_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionProfileDefaults":[]}}),
            )
            .await;
        let rev_before = backend_client.preferences_revision(Owner::Config);
        sse_stream
            .socket
            .write_all(b"data: {\"type\":\"storage.configChanged\",\"owner\":\"ui\"}\n\n")
            .await
            .unwrap();
        wait_until(|| backend_client.preferences_revision(Owner::Config) > rev_before).await;

        (listener, shared, rt, sse_stream, other_watch)
    });

    // Server driver for flush(): expects an authoritative GET BEFORE Missions PATCH, returning
    // a concurrent profile change that Missions must preserve instead of hitting a stale 409.
    let server = std::thread::spawn(move || {
        platform::block_on(async move {
            let fresh_profile = json!([{
                "template": "all",
                "profiles": { "coordinator": { "agent": "lead" } }
            }]);
            let auth_get = request(&listener).await;
            assert_eq!(
                auth_get.first, "GET /api/storage/config/ui?authoritative=1 HTTP/1.1",
                "flush() must fetch fresh config/ui before launching queued Missions PATCH"
            );
            auth_get
                .reply(
                    200,
                    json!({"settings":{"locale":"en","missionProfileDefaults":fresh_profile}}),
                )
                .await;

            let patch = request(&listener).await;
            assert_eq!(
                patch.first,
                "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
            );
            assert_eq!(
                patch.body["patch"]["settings"]["missionProfileDefaults"][0]["taskMode"],
                json!("independent")
            );
            assert_eq!(
                patch.body["patch"]["settings"]["missionProfileDefaults"][0]["profiles"]["coordinator"]
                    ["agent"],
                json!("lead")
            );
            let updated_doc = json!({
                "settings": {
                    "locale": "en",
                    "missionProfileDefaults": patch.body["patch"]["settings"]["missionProfileDefaults"]
                }
            });
            patch.reply(200, updated_doc.clone()).await;

            let confirm_get = request(&listener).await;
            assert_eq!(
                confirm_get.first,
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
            );
            confirm_get.reply(200, updated_doc).await;
        })
    });

    assert!(
        shared.borrow_mut().flush(),
        "flush() must cleanly revalidate, merge, and confirm the queued Missions edit"
    );
    server.join().unwrap();
}

#[test]
fn closing_web_settings_drains_queued_depth_choice_after_first_put_acknowledgement() {
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

        let exp_1 = "2".repeat(64);
        let exp_2 = "3".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp_1,
            true,
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

        // Start PUT(4), then queue 5 while PUT(4) is in flight, then close Web Settings.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);
        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(put_4.body["depth"], json!(4));

        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "5");
        tick(&mut rt);

        let wake: rune::Waker = Arc::new(|| {});
        let mut closed_missions = crate::settings::missions::Missions::default();
        shared.borrow_mut().provider_target = None;
        closed_missions.poll(&mut shared.borrow_mut(), &wake, false);

        // Acknowledge PUT(4): the closed background loop must fetch the fresh expectation and send PUT(5).
        put_4.reply_no_content().await;
        let followup_get = timeout(Duration::from_secs(5), async {
            loop {
                closed_missions.poll(&mut shared.borrow_mut(), &wake, false);
                if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                    let (socket, _) = accepted.unwrap();
                    if let Some(req) = try_read_request(socket, Duration::from_secs(3)).await {
                        return req;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            followup_get.first,
            "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a HTTP/1.1"
        );
        followup_get
            .reply(200, depth_snapshot_json("/repo/wt-a", Some(4), &exp_2))
            .await;

        let put_5 = timeout(Duration::from_secs(5), async {
            loop {
                closed_missions.poll(&mut shared.borrow_mut(), &wake, false);
                if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                    let (socket, _) = accepted.unwrap();
                    if let Some(req) = try_read_request(socket, Duration::from_secs(3)).await {
                        return req;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            put_5.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(
            put_5.body,
            json!({
                "location": { "directory": "/repo/wt-a" },
                "depth": 5,
                "expectation": exp_2
            })
        );
        put_5.reply_no_content().await;

        wait_until(|| {
            closed_missions.poll(&mut shared.borrow_mut(), &wake, false);
            !shared.borrow().missions.has_unconfirmed()
        })
        .await;
    });
}

#[test]
fn stale_location_resolution_after_sse_session_moved_is_discarded_and_reresolved() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let backend_client = backend.client.clone();

        let (wake_tx, wake_rx) = bounded(16);
        let watch_wake: rune::Waker = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        prefs.watch(&watch_wake);
        let mut sse_stream = request(&listener).await;
        assert!(sse_stream.first.starts_with("GET /api/events?"));
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
            // Open Missions WITHOUT a pre-pinned directory so poll_location resolves the session.
            prefs.missions.capture_opener(None, Some(&target));
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

        let first_lookup = next_request(&listener, &mut rt).await;
        assert_eq!(
            first_lookup.first,
            "GET /workspaces/captured/instance/api/session/session HTTP/1.1"
        );

        // Session moves on SSE while first_lookup is still in flight (catalogue poll delayed).
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"session.moved\",\"data\":{\"sessionID\":\"session\"}}}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| backend_client.location_revision("captured", Some("session")) > 0).await;

        // Returning stale /repo/wt-a must be discarded, triggering a fresh session lookup for /repo/wt-b.
        first_lookup
            .reply(
                200,
                json!({"data":{"id":"session","location":{"directory":"/repo/wt-a"}}}),
            )
            .await;

        let second_lookup = next_request(&listener, &mut rt).await;
        assert_eq!(
            second_lookup.first, "GET /workspaces/captured/instance/api/session/session HTTP/1.1",
            "stale /repo/wt-a resolution must be discarded without fetching wt-a depth/catalog"
        );
        second_lookup
            .reply(
                200,
                json!({"data":{"id":"session","location":{"directory":"/repo/wt-b"}}}),
            )
            .await;
        let exp_b = "4".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-b",
            "%2Frepo%2Fwt-b",
            Some(3),
            &exp_b,
            false,
        )
        .await;
        assert_eq!(
            shared.borrow().missions.pinned_directory(),
            Some("/repo/wt-b")
        );
    });
}

#[test]
fn revoked_location_token_blocks_queued_depth_background_followup_put() {
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

        let exp_a = "5".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp_a,
            true,
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

        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);
        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(put_4.body["depth"], json!(4));

        // Queue 5 while PUT(4) is in flight, then explicitly revoke location (as on tab close).
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "5");
        tick(&mut rt);

        let wake: rune::Waker = Arc::new(|| {});
        let mut closed_missions = crate::settings::missions::Missions::default();
        {
            let mut prefs = shared.borrow_mut();
            prefs.provider_target = None;
            prefs.missions.revoke_location();
        }
        closed_missions.poll(&mut shared.borrow_mut(), &wake, false);

        // Even after PUT(4) returns 204, the revoked location_token must block any follow-up GET/PUT(5).
        put_4.reply_no_content().await;
        wait_until(|| {
            closed_missions.poll(&mut shared.borrow_mut(), &wake, false);
            !shared.borrow().missions.depth_save_in_flight()
        })
        .await;
        assert!(
            timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err(),
            "revoked location_token must prevent background follow-up GET/PUT(5)"
        );
        assert!(shared.borrow().missions.has_unconfirmed());
    });
}

#[test]
fn depth_choice_queued_during_post_save_get_drains_after_web_settings_close() {
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

        let exp_1 = "6".repeat(64);
        let exp_2 = "7".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp_1,
            true,
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

        // Finish PUT(4) with no queued choice yet, then hold its post-save GET open.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);
        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(put_4.body["depth"], json!(4));
        put_4.reply_no_content().await;

        let post_save_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            post_save_get.first,
            "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a HTTP/1.1"
        );

        // Queue 5 during the held post-save GET, then close Web Settings before the GET replies.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "5");
        tick(&mut rt);

        let wake: rune::Waker = Arc::new(|| {});
        let mut closed_missions = crate::settings::missions::Missions::default();
        shared.borrow_mut().provider_target = None;
        closed_missions.poll(&mut shared.borrow_mut(), &wake, false);

        post_save_get
            .reply(200, depth_snapshot_json("/repo/wt-a", Some(4), &exp_2))
            .await;

        let put_5 = timeout(Duration::from_secs(5), async {
            loop {
                closed_missions.poll(&mut shared.borrow_mut(), &wake, false);
                if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                    let (socket, _) = accepted.unwrap();
                    if let Some(req) = try_read_request(socket, Duration::from_secs(3)).await {
                        return req;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            put_5.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(
            put_5.body,
            json!({
                "location": { "directory": "/repo/wt-a" },
                "depth": 5,
                "expectation": exp_2
            })
        );
        put_5.reply_no_content().await;

        wait_until(|| {
            closed_missions.poll(&mut shared.borrow_mut(), &wake, false);
            !shared.borrow().missions.has_unconfirmed()
        })
        .await;
    });
}
