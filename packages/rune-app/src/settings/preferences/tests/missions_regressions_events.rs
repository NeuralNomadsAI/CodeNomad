use super::{
    missions::{click, click_option, next_request, settle_meta, tick},
    missions_regressions::{depth_snapshot_json, drain_location_catalog_and_depth},
    *,
};
use crate::settings::{providers::Target, view};
use codenomad_client::stream::{CatalogueChanges, CatalogueWatch};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

fn masked_depth_snapshot_json(directory: &str, expectation: &str) -> Value {
    json!({
        "location": { "directory": directory },
        "capability": { "minimum": 1, "maximum": 5, "default": 2 },
        "effectiveDepth": 2,
        "nesting": { "effect": "allow", "hidden": false },
        "origin": format!("{directory}/opencode.jsonc"),
        "project": {
            "path": format!("{directory}/opencode.jsonc"),
            "depth": null,
            "expectation": expectation,
            "nestingSkipped": false,
            "emptyExperimental": true
        }
    })
}

async fn accept_sse_stream(listener: &TcpListener) -> Request {
    loop {
        let req = request(listener).await;
        if req.first == "GET /api/meta HTTP/1.1" {
            req.reply(200, json!({"capabilities":[]})).await;
            continue;
        }
        assert!(
            req.first.starts_with("GET /api/events?"),
            "unexpected pre-SSE request: {}",
            req.first
        );
        let mut req = req;
        req.socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
            )
            .await
            .unwrap();
        return req;
    }
}

#[test]
fn upstream_error_blocks_depth_reresolution_and_put_until_connected() {
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
        let mut sse_stream = accept_sse_stream(&listener).await;
        let _ = timeout(Duration::from_secs(2), wake_rx.recv())
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

        // Upstream OpenCode event stream drops while HTTP stays reachable: must invalidate /repo/wt-a,
        // keep depth disabled, and avoid re-resolving or allowing PUT until `connected`.
        let before_err = backend_client.location_revision("captured", Some("session"));
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"captured\",\"status\":\"error\",\"reason\":\"upstream closed\"}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| {
            backend_client.location_revision("captured", Some("session")) > before_err
                && !backend_client.workspace_upstream_healthy("captured")
        })
        .await;

        for _ in 0..5 {
            tick(&mut rt);
        }
        assert_eq!(shared.borrow().missions.pinned_directory(), None);
        assert!(shared.borrow().missions.depth_disabled(true, false, None));
        // Even reopening on a stale opener directory must not re-pin while upstream is unhealthy.
        let reopened = Target::capture(&root).unwrap();
        shared
            .borrow_mut()
            .missions
            .capture_opener(Some("/repo/wt-a".into()), Some(&reopened));
        assert_eq!(shared.borrow().missions.pinned_directory(), None);
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "depth must not re-resolve or issue PUT while upstream OpenCode stream is unhealthy"
        );

        // Once upstream reconnects, lookup resolves the moved worktree /repo/wt-b and PUT targets B.
        let before_ok = backend_client.location_revision("captured", Some("session"));
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"captured\",\"status\":\"connected\"}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| {
            backend_client.location_revision("captured", Some("session")) > before_ok
                && backend_client.workspace_upstream_healthy("captured")
        })
        .await;

        let exp_b = "2".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-b",
            "%2Frepo%2Fwt-b",
            Some(3),
            &exp_b,
            true,
        )
        .await;
        wait_until(|| {
            tick(&mut rt);
            !shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-b"))
        })
        .await;

        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        let put_b = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_b.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_b.body["location"]["directory"], json!("/repo/wt-b"));
        assert_eq!(put_b.body["depth"], json!(4));
        assert_eq!(put_b.body["expectation"], json!(exp_b));
        put_b.reply_no_content().await;
    });
}

#[test]
fn reopening_web_preferences_with_steady_catalogue_watch_keeps_queued_depth_write() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let backend = backend.clone();

        let (watch, task) = CatalogueWatch::new(backend.clone(), Arc::new(|| {}));
        platform::spawn(task);
        let _sse_stream = accept_sse_stream(&listener).await;
        wait_until(|| watch.generation() == 1).await;
        let _ = watch.take_provider_changes();
        let _ = watch.take_mission_catalog_changes();

        let mut root = crate::init();
        root.screen = crate::screen::Screen::Launcher(crate::launcher::Launcher::fixture());
        root.workspace = Some(crate::workspace::Ui::new());
        let project = crate::catalog::Project {
            id: "captured".into(),
            path: "/repo/wt-a".into(),
        };
        crate::workspace::opened(&mut root, &project);
        crate::workspace::bound(&mut root, &backend);
        assert!(crate::workspace::contains_project(&root, "captured"));
        {
            let launcher = root.screen.launcher_mut().unwrap();
            launcher.connection = Some(backend.clone());
            launcher.project = Some(project);
            launcher.catalogue_watch = Some(watch);
        }

        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;

        let target = Target::capture(&root).unwrap();
        assert!(target.online());
        assert_eq!(target.authority(), 0);
        {
            let mut prefs = shared.borrow_mut();
            prefs
                .missions
                .capture_opener(Some("/repo/wt-a".into()), Some(&target));
            prefs.provider_target = Some(target);
        }
        crate::settings::poll(&mut root, &mut rune::Tx::default());
        assert_eq!(
            shared
                .borrow()
                .provider_target
                .as_ref()
                .unwrap()
                .authority(),
            0,
            "initial validate against unchanged CatalogueWatch generation must not bump authority"
        );

        let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let (mut saw_meta, mut saw_config, mut saw_state) = (false, false, false);
        while !(saw_meta && saw_config && saw_state) {
            let req = next_request(&listener, &mut rt).await;
            match req.first.as_str() {
                "GET /api/meta HTTP/1.1" => {
                    saw_meta = true;
                    req.reply(200, json!({"capabilities":[]})).await;
                }
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                    saw_config = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                }
                "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                    saw_state = true;
                    req.reply(200, json!({"state":{}})).await;
                }
                other => panic!("unexpected bootstrap request: {other}"),
            }
        }
        wait_until(|| {
            tick(&mut rt);
            shared.borrow().config_loaded()
        })
        .await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        let exp_1 = "3".repeat(64);
        let exp_2 = "4".repeat(64);
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

        // Start PUT(4), queue 5 while PUT(4) is in flight, then close and reopen Preferences.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(put_4.body["depth"], json!(4));

        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "5");
        tick(&mut rt);

        {
            let mut prefs = shared.borrow_mut();
            prefs.provider_target = None;
            prefs.missions.suspend_reads();
        }
        let reopened = Target::capture(&root).unwrap();
        assert!(reopened.online());
        assert_eq!(reopened.authority(), 0);
        {
            let mut prefs = shared.borrow_mut();
            prefs
                .missions
                .capture_opener(Some("/repo/wt-a".into()), Some(&reopened));
            prefs.provider_target = Some(reopened);
        }
        // Real settings::poll runs Target::validate against the steady generation=1 CatalogueWatch.
        crate::settings::poll(&mut root, &mut rune::Tx::default());
        assert_eq!(
            shared
                .borrow()
                .provider_target
                .as_ref()
                .unwrap()
                .authority(),
            0,
            "reopening Preferences with unchanged CatalogueWatch generation must not revoke location"
        );
        tick(&mut rt);

        // Reply 204 to PUT(4): follow-up GET and queued PUT(5) must still succeed.
        put_4.reply_no_content().await;
        let followup_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            followup_get.first,
            "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a HTTP/1.1"
        );
        followup_get
            .reply(200, depth_snapshot_json("/repo/wt-a", Some(4), &exp_2))
            .await;

        let put_5 = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_5.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_5.body["depth"], json!(5));
        assert_eq!(put_5.body["expectation"], json!(exp_2));
        put_5.reply_no_content().await;
    });
}

#[test]
fn unmasking_empty_experimental_with_inherit_preserves_choice_queued_during_confirmation_get() {
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

        let exp_1 = "5".repeat(64);
        let exp_2 = "6".repeat(64);
        let mut saw_session = false;
        let mut saw_agents = false;
        let mut saw_providers = false;
        let mut saw_models = false;
        let mut saw_depth = false;
        for _ in 0..5 {
            let req = next_request(&listener, &mut rt).await;
            if req.first == "GET /workspaces/captured/instance/api/session/session HTTP/1.1" {
                saw_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/repo/wt-a"}}}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/agent")
            {
                saw_agents = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-a"},"data":[{"name":"build","mode":"primary"}]}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/provider")
            {
                saw_providers = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-a"},"data":{"all":[],"connected":[]}}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/model")
            {
                saw_models = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-a"},"data":[]}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /api/workspaces/captured/subagent-depth?")
            {
                saw_depth = true;
                req.reply(200, masked_depth_snapshot_json("/repo/wt-a", &exp_1))
                    .await;
            } else {
                panic!("unexpected request: {}", req.first);
            }
        }
        assert!(saw_session && saw_agents && saw_providers && saw_models && saw_depth);
        wait_until(|| {
            tick(&mut rt);
            !shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-a"))
        })
        .await;

        // Unmask emptyExperimental: true by choosing "Inherit" (""), then reply 204.
        shared
            .borrow_mut()
            .missions
            .choose_depth(String::new(), true, true, Some("/repo/wt-a"));
        let put_inherit = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_inherit.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_inherit.body["depth"], json!(null));
        assert_eq!(put_inherit.body["expectation"], json!(exp_1));
        put_inherit.reply_no_content().await;

        // Hold the post-save confirmation GET open and queue "4" while it is in flight.
        let confirm_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            confirm_get.first,
            "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a HTTP/1.1"
        );
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);

        // Confirmation GET returns emptyExperimental: false, depth: null -> queued "4" must be sent.
        confirm_get
            .reply(200, depth_snapshot_json("/repo/wt-a", None, &exp_2))
            .await;

        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_4.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_4.body["depth"], json!(4));
        assert_eq!(put_4.body["expectation"], json!(exp_2));
        put_4.reply_no_content().await;
    });
}

#[test]
fn mission_catalog_events_refresh_missions_without_touching_providers() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let backend = backend.clone();

        let (watch, task) = CatalogueWatch::new(backend.clone(), Arc::new(|| {}));
        platform::spawn(task);
        let mut sse_stream = accept_sse_stream(&listener).await;
        wait_until(|| watch.generation() == 1).await;
        let _ = watch.take_provider_changes();
        let _ = watch.take_mission_catalog_changes();

        let mut target = Target::fixture(backend.clone(), "captured", Some("session"));
        for event_type in ["agent.updated", "plugin.updated", "models-dev.refreshed"] {
            let frame = format!(
                "data: {{\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{{\"type\":\"{event_type}\",\"data\":{{}}}}}}\n\n"
            );
            sse_stream.socket.write_all(frame.as_bytes()).await.unwrap();

            let mut received = CatalogueChanges::None;
            wait_until(|| {
                let changes = watch.take_mission_catalog_changes();
                if matches!(
                    changes,
                    CatalogueChanges::Workspaces(ref set) if set.contains("captured")
                ) {
                    received = changes;
                    true
                } else {
                    false
                }
            })
            .await;

            let (provider_changes, _, _) = watch.take_provider_changes();
            assert!(
                matches!(provider_changes, CatalogueChanges::None),
                "{event_type} must not trigger Providers panel reload"
            );

            let provider_rev_before = target.revision();
            let catalog_rev_before = target.mission_catalog_revision();
            assert!(target.mission_catalog_catalogue(&received));
            assert_eq!(
                target.revision(),
                provider_rev_before,
                "{event_type} must not bump Target::revision"
            );
            assert_eq!(
                target.mission_catalog_revision(),
                catalog_rev_before.wrapping_add(1),
                "{event_type} must bump Target::mission_catalog_revision"
            );
        }

        // Direct chat path (no CatalogueWatch): WorkspaceEvent::MissionCatalogChanged wakes and bumps only Missions catalog.
        let root = crate::init();
        let woke = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let woke_flag = woke.clone();
        {
            let mut prefs = root.settings.shared.borrow_mut();
            prefs.window_wake = Some(Arc::new(move || {
                woke_flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }));
            prefs.provider_target = Some(Target::fixture(backend, "captured", Some("session")));
        }
        let provider_rev_before = root
            .settings
            .shared
            .borrow()
            .provider_target
            .as_ref()
            .unwrap()
            .revision();
        let catalog_rev_before = root
            .settings
            .shared
            .borrow()
            .provider_target
            .as_ref()
            .unwrap()
            .mission_catalog_revision();
        crate::settings::connection_event(
            &root,
            &crate::transport::Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::MissionCatalogChanged {
                    workspace_id: "captured".into(),
                },
            ),
            true,
        );
        assert!(woke.load(std::sync::atomic::Ordering::SeqCst));
        let shared = root.settings.shared.borrow();
        let target = shared.provider_target.as_ref().unwrap();
        assert_eq!(target.revision(), provider_rev_before);
        assert_eq!(
            target.mission_catalog_revision(),
            catalog_rev_before.wrapping_add(1)
        );
        drop(watch);
    });
}

#[test]
fn session_moved_while_preferences_closed_ignores_stale_opener_and_resolves_moved_worktree() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        backend.session_directory = Some("/repo/wt-a".into());
        let backend_client = backend.client.clone();

        let (wake_tx, wake_rx) = bounded(16);
        let watch_wake: rune::Waker = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        prefs.watch(&watch_wake);
        let mut sse_stream = accept_sse_stream(&listener).await;
        let _ = timeout(Duration::from_secs(2), wake_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let _ = prefs.stream.as_ref().unwrap().take();

        // While Preferences is closed, another client moves the session from A to B.
        let before_move = backend_client.location_revision("captured", Some("session"));
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"session.moved\",\"data\":{\"sessionID\":\"session\"}}}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| backend_client.location_revision("captured", Some("session")) > before_move)
            .await;

        let root = crate::init();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;

        // Even though the backend still carries stale session_directory "/repo/wt-a",
        // opener_directory must return None for an active session and capture_opener must refuse stale A.
        assert_eq!(crate::settings::missions::opener_directory(&root), None);
        let target = Target::capture(&root).unwrap();
        {
            let mut prefs = shared.borrow_mut();
            prefs
                .missions
                .capture_opener(Some("/repo/wt-a".into()), Some(&target));
            assert_eq!(prefs.missions.pinned_directory(), None);
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

        // Authoritative session lookup resolves moved worktree B; depth GET and PUT must target B only.
        let exp_b = "9".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-b",
            "%2Frepo%2Fwt-b",
            Some(2),
            &exp_b,
            true,
        )
        .await;
        wait_until(|| {
            tick(&mut rt);
            !shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-b"))
        })
        .await;

        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        let put_b = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_b.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_b.body["location"]["directory"], json!("/repo/wt-b"));
        assert_eq!(put_b.body["depth"], json!(4));
        assert_eq!(put_b.body["expectation"], json!(exp_b));
        put_b.reply_no_content().await;
    });
}

#[test]
fn worktrees_changed_wakes_open_preferences_window_without_manual_tick() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let backend = backend.clone();
        let backend_client = backend.client.clone();

        let (watch, task) = CatalogueWatch::new(backend.clone(), Arc::new(|| {}));
        platform::spawn(task);
        let mut sse_stream = accept_sse_stream(&listener).await;
        wait_until(|| watch.generation() == 1).await;
        let _ = watch.take_provider_changes();
        let _ = watch.take_mission_catalog_changes();

        let mut root = crate::init();
        root.screen = crate::screen::Screen::Launcher(crate::launcher::Launcher::fixture());
        root.workspace = Some(crate::workspace::Ui::new());
        let project = crate::catalog::Project {
            id: "captured".into(),
            path: "/repo/wt-a".into(),
        };
        crate::workspace::opened(&mut root, &project);
        crate::workspace::bound(&mut root, &backend);
        {
            let launcher = root.screen.launcher_mut().unwrap();
            launcher.connection = Some(backend.clone());
            launcher.project = Some(project);
            launcher.catalogue_watch = Some(watch);
        }

        let wake_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let wake_count_cb = wake_count.clone();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(move || {
            wake_count_cb.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        *shared.borrow_mut() = prefs;

        let target = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target);
        crate::settings::poll(&mut root, &mut rune::Tx::default());
        let wakes_before = wake_count.load(std::sync::atomic::Ordering::SeqCst);

        // Deliver ONLY workspace.worktreesChanged: settings::poll must detect the Hub location_revision
        // bump via Target::sync_location_state and wake the native Preferences window.
        let before_rev = backend_client.location_revision("captured", Some("session"));
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"workspace.worktreesChanged\",\"workspaceId\":\"captured\"}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| backend_client.location_revision("captured", Some("session")) > before_rev)
            .await;

        crate::settings::poll(&mut root, &mut rune::Tx::default());
        assert!(
            wake_count.load(std::sync::atomic::Ordering::SeqCst) > wakes_before,
            "workspace.worktreesChanged must wake the open native Preferences window"
        );
    });
}

#[test]
fn native_preferences_reopen_preserves_missions_scope_and_profiles_disclosure() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.window_wake = Some(Arc::new(|| {}));
        prefs.config.snapshot = Some(json!({
            "settings": {
                "locale": "en",
                "missionProfileDefaults": []
            }
        }));
        let shared = Rc::new(RefCell::new(prefs));
        let target_scope = codenomad_client::settings::missions::MissionDefaultScope::ALL[1];

        fn scope_trigger_value(a11y: &serde_json::Value) -> Option<String> {
            if a11y["key"] == "mission-scope-trigger" {
                return a11y["value"].as_str().map(str::to_owned);
            }
            a11y["children"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(scope_trigger_value)
        }

        // Open native Preferences window #1, choose a non-default scope and expand Profiles disclosure.
        let initial_value;
        let chosen_value;
        {
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
            initial_value = scope_trigger_value(&rt.accessibility_json())
                .expect("mission-scope-trigger must expose initial value");
            click(&mut rt, "mission-scope-trigger");
            click(&mut rt, "option1");
            click(&mut rt, "trigger");
            tick(&mut rt);
            chosen_value = scope_trigger_value(&rt.accessibility_json())
                .expect("mission-scope-trigger must expose chosen value");
            assert_ne!(chosen_value, initial_value);
            assert_eq!(shared.borrow().missions.scope(), target_scope);
            assert!(shared.borrow().missions.profiles_open());
            assert!(
                rt.find("mission-reset-profiles").is_some(),
                "expanding Profiles disclosure must render mission-reset-profiles"
            );
        }

        // Reopen native Preferences window #2 on the same Preferences state: scope and disclosure must persist.
        {
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
            let reopened_value = scope_trigger_value(&rt.accessibility_json())
                .expect("reopened mission-scope-trigger must expose chosen value");
            assert_ne!(
                reopened_value, initial_value,
                "reopened native Preferences window must preserve selected Missions scope"
            );
            assert!(
                rt.find("mission-reset-profiles").is_some(),
                "reopened native Preferences window must preserve expanded Profiles disclosure"
            );
            assert_eq!(shared.borrow().missions.scope(), target_scope);
            assert!(shared.borrow().missions.profiles_open());
        }

        // Switching to a different backend clears the remembered scope and disclosure state.
        shared.borrow_mut().missions.rebind(false);
        assert_eq!(
            shared.borrow().missions.scope(),
            codenomad_client::settings::missions::MissionDefaultScope::All
        );
        assert!(!shared.borrow().missions.profiles_open());
    });
}

#[test]
fn direct_mode_reopening_preferences_during_sse_outage_keeps_target_offline_after_http_refresh() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let client_id = backend.client_id.clone();

        let mut root = crate::init();
        let (_out, incoming) = codenomad_client::bounded(4);
        root.incoming = Some(incoming);
        root.conversation_client_id = Some(client_id);
        root.conversation_stream_connected = true;
        root.phase = crate::Phase::Ready;
        prefs.window_wake = Some(Arc::new(|| {}));
        let shared = root.settings.shared.clone();
        *shared.borrow_mut() = prefs;

        // Direct conversation SSE drops while HTTP stays reachable.
        crate::settings::connection_event(&root, &crate::transport::Event::ConnectionLost, true);
        root.conversation_stream_connected = false;
        root.phase = crate::Phase::Reconnecting;
        assert!(shared.borrow().is_transport_lost());

        // Reopen native Preferences during the SSE outage: Target::capture must see offline.
        let target = Target::capture(&root).unwrap();
        assert!(
            !target.online(),
            "direct-mode Target::capture must stay offline while conversation SSE is disconnected"
        );
        shared.borrow_mut().provider_target = Some(target);

        // Even after HTTP config refresh clears transport_lost, target must stay offline (no session/depth requests).
        shared.borrow_mut().refresh();
        let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let (mut saw_meta, mut saw_config, mut saw_state) = (false, false, false);
        while !(saw_meta && saw_config && saw_state) {
            let req = next_request(&listener, &mut rt).await;
            match req.first.as_str() {
                "GET /api/meta HTTP/1.1" => {
                    saw_meta = true;
                    req.reply(200, json!({"capabilities":[]})).await;
                }
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                    saw_config = true;
                    req.reply(200, json!({"settings":{"locale":"en"}})).await;
                }
                "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                    saw_state = true;
                    req.reply(200, json!({"state":{}})).await;
                }
                other => panic!("unexpected request while SSE offline: {other}"),
            }
        }
        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().is_transport_lost()
        })
        .await;
        assert!(
            !shared.borrow().provider_target.as_ref().unwrap().online(),
            "HTTP refresh must not mark direct-mode Target online while SSE is still down"
        );

        // Open Missions tab while SSE is still down: must NOT issue any session or depth HTTP request.
        click(&mut rt, "settings-missions");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "Missions must not resolve session or allow depth reads/writes during direct-mode SSE outage"
        );

        // Once SSE reconnects (AgentHint(true)), target becomes online and resolves live location.
        root.conversation_stream_connected = true;
        root.phase = crate::Phase::Ready;
        crate::settings::connection_event(&root, &crate::transport::Event::AgentHint(true), true);
        assert!(shared.borrow().provider_target.as_ref().unwrap().online());
        let req = next_request(&listener, &mut rt).await;
        assert!(
            req.first == "GET /workspaces/captured/instance/api/session/session HTTP/1.1",
            "expected live session lookup after SSE reconnect, got {}",
            req.first
        );
    });
}

#[test]
fn uncertain_depth_write_survives_visiting_another_worktree_and_returning() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let backend_clone = backend.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        let root = crate::init();
        let shared = root.settings.shared.clone();
        *shared.borrow_mut() = prefs;

        let target_a = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target_a);
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

        let exp_a1 = "a".repeat(64);
        let exp_a2 = "b".repeat(64);
        let exp_b1 = "c".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp_a1,
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

        // Start PUT(4) on A and drop the connection without replying -> Uncertain on A.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        let put_a = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_a.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        drop(put_a);
        wait_until(|| {
            tick(&mut rt);
            shared.borrow().missions.has_unconfirmed() && rt.find("mission-depth-refresh").is_some()
        })
        .await;

        // Close web settings, visit worktree B, and resolve B cleanly.
        {
            let mut prefs = shared.borrow_mut();
            prefs.provider_target = None;
            prefs.missions.suspend_reads();
        }
        tick(&mut rt);
        let target_b = Target::fixture(backend_clone.clone(), "captured", Some("session-b"));
        shared.borrow_mut().provider_target = Some(target_b);
        tick(&mut rt);
        let mut saw_b_session = false;
        let mut saw_b_agents = false;
        let mut saw_b_providers = false;
        let mut saw_b_models = false;
        let mut saw_b_depth = false;
        while !(saw_b_session && saw_b_agents && saw_b_providers && saw_b_models && saw_b_depth) {
            let req = next_request(&listener, &mut rt).await;
            if req.first == "GET /workspaces/captured/instance/api/session/session-b HTTP/1.1" {
                saw_b_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session-b","location":{"directory":"/repo/wt-b"}}}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/agent")
            {
                saw_b_agents = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-b"},"data":[]}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/provider")
            {
                saw_b_providers = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-b"},"data":{"all":[],"connected":[]}}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/model")
            {
                saw_b_models = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-b"},"data":[]}),
                )
                .await;
            } else if req.first
                == "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-b HTTP/1.1"
            {
                saw_b_depth = true;
                req.reply(200, depth_snapshot_json("/repo/wt-b", Some(3), &exp_b1))
                    .await;
            } else {
                panic!("unexpected request on B: {}", req.first);
            }
        }
        wait_until(|| {
            tick(&mut rt);
            !shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-b"))
        })
        .await;
        assert!(
            shared.borrow().missions.has_unconfirmed(),
            "visiting B must not forget unconfirmed write on A"
        );

        // Return to A: session lookup and catalog may run, but NO automatic depth GET on A.
        {
            let mut prefs = shared.borrow_mut();
            prefs.provider_target = None;
            prefs.missions.suspend_reads();
        }
        tick(&mut rt);
        let target_a2 = Target::fixture(backend_clone, "captured", Some("session"));
        shared.borrow_mut().provider_target = Some(target_a2);
        tick(&mut rt);
        let mut saw_a_session = false;
        let mut saw_a_agents = false;
        let mut saw_a_providers = false;
        let mut saw_a_models = false;
        while !(saw_a_session && saw_a_agents && saw_a_providers && saw_a_models) {
            let req = next_request(&listener, &mut rt).await;
            if req.first == "GET /workspaces/captured/instance/api/session/session HTTP/1.1" {
                saw_a_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/repo/wt-a"}}}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/agent")
            {
                saw_a_agents = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-a"},"data":[]}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/provider")
            {
                saw_a_providers = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-a"},"data":{"all":[],"connected":[]}}),
                )
                .await;
            } else if req
                .first
                .starts_with("GET /workspaces/captured/instance/api/model")
            {
                saw_a_models = true;
                req.reply(
                    200,
                    json!({"location":{"directory":"/repo/wt-a"},"data":[]}),
                )
                .await;
            } else {
                panic!(
                    "returning to uncertain A must not auto-GET depth: {}",
                    req.first
                );
            }
        }
        tick(&mut rt);
        if let Ok(accepted) = timeout(Duration::from_millis(120), listener.accept()).await {
            let (socket, _) = accepted.unwrap();
            let req = read_request(socket, Duration::from_secs(3)).await;
            panic!(
                "returning to uncertain A must wait for explicit Refresh, got {}",
                req.first
            );
        }
        assert!(
            shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-a"))
        );
        assert!(rt.find("mission-depth-refresh").is_some());

        // Explicit Refresh + confirmation recovers A and clears has_unconfirmed.
        click(&mut rt, "mission-depth-refresh");
        click(&mut rt, "file-decision-confirm");
        let recovery_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            recovery_get.first,
            "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a HTTP/1.1"
        );
        recovery_get
            .reply(200, depth_snapshot_json("/repo/wt-a", Some(4), &exp_a2))
            .await;
        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().missions.has_unconfirmed()
                && !shared
                    .borrow()
                    .missions
                    .depth_disabled(true, true, Some("/repo/wt-a"))
        })
        .await;
    });
}

#[test]
fn library_remove_lost_ack_clears_error_when_authoritative_get_confirms_removal() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.window_wake = Some(Arc::new(|| {}));
        prefs.config.snapshot = Some(json!({
            "settings": {
                "locale": "en",
                "missionProfileDefaults": [],
                "missionModels": [
                    {
                        "version": 1,
                        "id": "11111111-1111-4111-8111-111111111111",
                        "name": "Saved preset",
                        "objective": "Check build",
                        "notes": "",
                        "template": "custom"
                    }
                ]
            }
        }));
        let shared = Rc::new(RefCell::new(prefs));
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

        click(&mut rt, "mission-model-library-trigger");
        click_option(&mut rt, "mission-model-library", "Saved preset");
        click(&mut rt, "mission-models-remove");
        click(&mut rt, "file-decision-confirm");

        // Drop the PATCH response without replying (server applied removal, ack was lost).
        let patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        drop(patch);

        // Authoritative reconciliation GET returns missionModels: [] confirming removal.
        let get = next_request(&listener, &mut rt).await;
        assert_eq!(
            get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        get.reply(
            200,
            json!({
                "settings": {
                    "locale": "en",
                    "missionProfileDefaults": [],
                    "missionModels": []
                }
            }),
        )
        .await;

        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().missions.has_unconfirmed()
        })
        .await;
        assert!(
            rt.find("mission-models-reload").is_none(),
            "confirmed lost-ack removal must clear library reload/error lock"
        );
    });
}

#[test]
fn depth_picker_announces_busy_during_save_and_steps_closed_with_arrow_key() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        prefs.window_wake = Some(Arc::new(|| {}));
        let root = crate::init();
        let shared = root.settings.shared.clone();
        *shared.borrow_mut() = prefs;
        let target = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target);

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

        let exp_1 = "7".repeat(64);
        let exp_2 = "8".repeat(64);
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(3),
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

        fn find_node<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
            if node["key"] == key {
                return Some(node);
            }
            node["children"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|child| find_node(child, key))
        }

        // Focus closed depth trigger and press ArrowDown -> steps from 3 to 4 without opening popup.
        rt.update(|_, tx| tx.focus("mission-subagent-depth-trigger", true));
        rt.frame(0.02);
        rt.key(rune::KeyEvent {
            key: rune::Key::Down,
            mods: Default::default(),
        });
        rt.frame(0.02);
        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_4.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_4.body["depth"], json!(4));

        // While PUT(4) is in flight, trigger stays focused/collapsed and closed ArrowDown queues 5.
        rt.frame(0.02);
        assert!(shared.borrow().missions.depth_save_in_flight());
        let a11y = rt.accessibility_json();
        let trigger = find_node(&a11y, "mission-subagent-depth-trigger")
            .expect("depth trigger must remain mounted while saving");
        assert_eq!(trigger["value"], json!("4"));
        let states = trigger["states"].as_array().cloned().unwrap_or_default();
        assert!(
            states.iter().any(|s| s == "focused"),
            "depth trigger must stay focused during save, trigger={trigger}"
        );
        assert!(
            find_node(&a11y, "mission-subagent-depth-content").is_none(),
            "closed stepping must not open depth listbox"
        );

        rt.key(rune::KeyEvent {
            key: rune::Key::Down,
            mods: Default::default(),
        });
        rt.frame(0.02);
        assert!(
            find_node(&rt.accessibility_json(), "mission-subagent-depth-content").is_none(),
            "stepping while saving must queue next depth without opening popup"
        );

        put_4.reply_no_content().await;
        let confirm_get = next_request(&listener, &mut rt).await;
        confirm_get
            .reply(200, depth_snapshot_json("/repo/wt-a", Some(4), &exp_2))
            .await;
        let put_5 = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_5.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_5.body["depth"], json!(5));
        assert_eq!(put_5.body["expectation"], json!(exp_2));
        put_5.reply_no_content().await;
    });
}
