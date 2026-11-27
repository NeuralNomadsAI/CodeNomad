use super::{
    missions::{click, click_option, make_window, next_request, settle_meta, tick},
    missions_regressions::{depth_snapshot_json, drain_location_catalog_and_depth},
    *,
};
use crate::settings::{providers::Target, view};
use codenomad_client::stream::CatalogueWatch;
use std::{cell::Cell, rc::Rc, sync::Arc};

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

#[test]
fn worktrees_changed_and_upstream_event_status_invalidate_pinned_location_and_retarget() {
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
        let mut sse_stream = loop {
            let req = request(&listener).await;
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
            break req;
        };
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
        assert_eq!(
            shared.borrow().missions.pinned_directory(),
            Some("/repo/wt-a")
        );

        // 1. Upstream OpenCode stream drops while CodeNomad SSE stays open, then a move emits
        // workspace.worktreesChanged: Hub::location_revision must bump and force fresh resolution.
        let loc_before = backend_client.location_revision("captured", Some("session"));
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"captured\",\"status\":\"disconnected\"}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| backend_client.location_revision("captured", Some("session")) > loc_before)
            .await;
        let loc_after_disc = backend_client.location_revision("captured", Some("session"));

        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"workspace.worktreesChanged\",\"workspaceId\":\"captured\"}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| {
            backend_client.location_revision("captured", Some("session")) > loc_after_disc
        })
        .await;
        let loc_after_wt = backend_client.location_revision("captured", Some("session"));

        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"captured\",\"status\":\"connected\"}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| backend_client.location_revision("captured", Some("session")) > loc_after_wt)
            .await;

        tick(&mut rt);
        let exp_b = "b".repeat(64);
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
        assert_eq!(
            shared.borrow().missions.pinned_directory(),
            Some("/repo/wt-b")
        );
    });
}

#[test]
fn reopening_web_settings_on_same_session_preserves_queued_depth_write() {
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

        let exp_1 = "1".repeat(64);
        let exp_2 = "2".repeat(64);
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

        // Start PUT 4 and hold it open while queueing 5.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_4.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(put_4.body["depth"], json!(4));

        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "5");
        tick(&mut rt);

        // Close Web Settings, then reopen on the EXACT same session and worktree before 204 arrives.
        {
            let mut prefs = shared.borrow_mut();
            prefs.provider_target = None;
            prefs.missions.suspend_reads();
        }
        let reopened_target = Target::capture(&root).unwrap();
        {
            let mut prefs = shared.borrow_mut();
            prefs
                .missions
                .capture_opener(Some("/repo/wt-a".into()), Some(&reopened_target));
            prefs.provider_target = Some(reopened_target);
        }
        tick(&mut rt);

        // Reply 204 to PUT 4: follow-up GET and PUT 5 must proceed cleanly without Uncertain.
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

        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().missions.has_unconfirmed()
        })
        .await;
    });
}

#[test]
fn native_flush_launches_and_confirms_unsubmitted_pending_depth_choice() {
    let (listener, shared, _rt) = platform::block_on(async {
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

        let exp_1 = "c".repeat(64);
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

        // Stage a depth choice (`pending_save = true`) WITHOUT running a subsequent Missions poll.
        shared
            .borrow_mut()
            .missions
            .choose_depth("4".into(), true, true, Some("/repo/wt-a"));
        (listener, shared, rt)
    });

    let server = std::thread::spawn(move || {
        platform::block_on(async move {
            let put = request(&listener).await;
            assert_eq!(
                put.first,
                "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
            );
            assert_eq!(put.body["depth"], json!(4));
            put.reply_no_content().await;
        })
    });

    let flushed = shared.borrow_mut().flush();
    assert!(
        flushed,
        "native flush() must launch and confirm a staged pending depth choice"
    );
    server.join().unwrap();
}

#[test]
fn masked_empty_experimental_allows_queued_inherit_choice_during_reread() {
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

        let exp_masked = "d".repeat(64);
        let mut got_session = false;
        let mut got_catalog = 0usize;
        let mut got_depth = false;
        while !(got_session && got_catalog == 3 && got_depth) {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/workspaces/captured/instance/api/session/session" {
                got_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/repo/wt-a"}}}),
                )
                .await;
            } else if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a" {
                got_depth = true;
                req.reply(200, masked_depth_snapshot_json("/repo/wt-a", &exp_masked))
                    .await;
            } else {
                got_catalog += 1;
                if url.contains("/agents") {
                    req.reply(200, json!({"data":[]})).await;
                } else {
                    req.reply(200, json!({"data":{"all":[],"default":{},"connected":[]}}))
                        .await;
                }
            }
        }
        wait_until(|| {
            tick(&mut rt);
            !shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-a"))
        })
        .await;

        // Trigger a config.updated reread and hold the depth GET open while choosing Inherit ("").
        shared
            .borrow_mut()
            .provider_target
            .as_mut()
            .unwrap()
            .hint("captured");
        let mut held_depth_get = None;
        for _ in 0..4 {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a" {
                held_depth_get = Some(req);
                break;
            } else if url.contains("/agents") {
                req.reply(200, json!({"data":[]})).await;
            } else {
                req.reply(200, json!({"data":{"all":[],"default":{},"connected":[]}}))
                    .await;
            }
        }
        let held_depth_get = held_depth_get.expect("expected depth reread GET");

        // Choose Inherit ("") while the reread is in flight (promotes read to background_read).
        shared
            .borrow_mut()
            .missions
            .choose_depth(String::new(), true, true, Some("/repo/wt-a"));
        tick(&mut rt);

        // Reply with the same emptyExperimental=true snapshot: Inherit must STILL send PUT depth:null.
        held_depth_get
            .reply(200, masked_depth_snapshot_json("/repo/wt-a", &exp_masked))
            .await;

        let put_inherit = loop {
            let req = next_request(&listener, &mut rt).await;
            if req.first == "PUT /api/workspaces/captured/subagent-depth HTTP/1.1" {
                break req;
            }
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url.contains("/agents") {
                req.reply(200, json!({"data":[]})).await;
            } else {
                req.reply(200, json!({"data":{"all":[],"default":{},"connected":[]}}))
                    .await;
            }
        };
        assert_eq!(put_inherit.body["depth"], json!(null));
        assert_eq!(put_inherit.body["expectation"], json!(exp_masked));
        put_inherit.reply_no_content().await;
    });
}

#[test]
fn agent_updated_refreshes_missions_catalog_and_discarded_depth_does_not_repeat_get() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let watch_backend = backend.clone();

        let (wake_tx, _wake_rx) = bounded(16);
        let watch_wake: rune::Waker = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let (watch, watch_task) = CatalogueWatch::new(watch_backend, watch_wake);
        platform::spawn(watch_task);
        let mut sse_stream = loop {
            let req = request(&listener).await;
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
            break req;
        };

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

        let exp_1 = "e".repeat(64);
        let exp_ext = "f".repeat(64);
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

        // 1. Discarding a queued depth choice on follow-up GET must NOT repeat the depth GET.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        let put_4 = next_request(&listener, &mut rt).await;
        assert_eq!(
            put_4.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "5");
        tick(&mut rt);
        put_4.reply_no_content().await;

        let followup_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            followup_get.first,
            "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a HTTP/1.1"
        );
        // External client wrote 3 -> queued 5 is discarded; seen_revision must prevent a second GET.
        followup_get
            .reply(200, depth_snapshot_json("/repo/wt-a", Some(3), &exp_ext))
            .await;
        for _ in 0..5 {
            tick(&mut rt);
        }
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "discarding a queued depth choice after follow-up GET must not trigger a duplicate GET"
        );

        // 2. Delivering agent.updated must invalidate mission_catalog_changes without touching provider_changes.
        wait_until(|| watch.generation() == 1).await;
        let _ = watch.take_provider_changes();
        let _ = watch.take_mission_catalog_changes();
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"agent.updated\",\"data\":{}}}\n\n",
            )
            .await
            .unwrap();
        let mut saw_mission_catalog_change = false;
        wait_until(|| {
            let changes = watch.take_mission_catalog_changes();
            if matches!(
                changes,
                codenomad_client::stream::CatalogueChanges::Workspaces(ref set)
                    if set.contains("captured")
            ) {
                saw_mission_catalog_change = true;
            }
            saw_mission_catalog_change
        })
        .await;
        let (provider_changes, _, _) = watch.take_provider_changes();
        assert!(matches!(
            provider_changes,
            codenomad_client::stream::CatalogueChanges::None
        ));
        let rev_before = shared.borrow().provider_target.as_ref().unwrap().revision();
        assert!(
            shared
                .borrow_mut()
                .provider_target
                .as_mut()
                .unwrap()
                .mission_catalog_hint("captured")
        );
        assert_eq!(
            shared.borrow().provider_target.as_ref().unwrap().revision(),
            rev_before,
            "mission_catalog_hint must not bump Providers revision"
        );
        // Only the Missions catalog (agents + providers + models) reloads; depth does not re-read.
        let mut saw_agents = false;
        let mut saw_providers = false;
        let mut saw_models = false;
        for _ in 0..3 {
            let req = next_request(&listener, &mut rt).await;
            if req
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
            } else {
                panic!("unexpected request after agent.updated: {}", req.first);
            }
        }
        assert!(saw_agents && saw_providers && saw_models);
        drop(watch);
    });
}

#[test]
fn delete_sessions_lost_ack_clears_error_after_authoritative_get_confirms_value() {
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Toggle missionDeleteSessions on and drop the PATCH response without replying (lost ack).
        click(&mut rt, "mission-delete-sessions");
        let patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        drop(patch);

        // Authoritative GET returns missionDeleteSessions=true (the server did apply the write).
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

        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().missions.has_unconfirmed()
        })
        .await;
        assert!(
            !shared.borrow().missions.has_unconfirmed(),
            "authoritative GET confirming missionDeleteSessions=true must clear delete_failed"
        );
    });
}

#[test]
fn depth_get_mismatched_directory_is_rejected_and_never_authorizes_foreign_put() {
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

        let exp_b = "9".repeat(64);
        let mut got_session = false;
        let mut got_catalog = 0usize;
        let mut got_depth = false;
        while !(got_session && got_catalog == 3 && got_depth) {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/workspaces/captured/instance/api/session/session" {
                got_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/repo/wt-a"}}}),
                )
                .await;
            } else if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a" {
                got_depth = true;
                // Reply with a valid snapshot for a DIFFERENT checkout (/repo/wt-b).
                req.reply(200, depth_snapshot_json("/repo/wt-b", Some(2), &exp_b))
                    .await;
            } else {
                got_catalog += 1;
                if url.contains("/agents") {
                    req.reply(200, json!({"data":[]})).await;
                } else {
                    req.reply(200, json!({"data":{"all":[],"default":{},"connected":[]}}))
                        .await;
                }
            }
        }
        for _ in 0..4 {
            tick(&mut rt);
        }
        assert!(
            shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-a")),
            "depth GET returning foreign checkout directory must be rejected"
        );
        shared
            .borrow_mut()
            .missions
            .choose_depth("4".into(), true, true, Some("/repo/wt-a"));
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "mismatched depth GET must never authorize a PUT to the foreign checkout"
        );
    });
}

#[test]
fn upstream_error_status_and_worktree_updated_bump_location_and_retry_failed_lookup() {
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
        let mut sse_stream = loop {
            let req = request(&listener).await;
            if req.first == "GET /api/meta HTTP/1.1" {
                req.reply(200, json!({"capabilities":[]})).await;
                continue;
            }
            assert!(req.first.starts_with("GET /api/events?"));
            let mut req = req;
            req.socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
                )
                .await
                .unwrap();
            break req;
        };
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
            // Open without a pinned directory so session lookup runs and fails first.
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

        // Fail initial session lookup (503) so location_failed is recorded.
        let first_lookup = next_request(&listener, &mut rt).await;
        assert_eq!(
            first_lookup.first,
            "GET /workspaces/captured/instance/api/session/session HTTP/1.1"
        );
        first_lookup.reply(503, json!({"error":"down"})).await;
        for _ in 0..4 {
            tick(&mut rt);
        }
        assert_eq!(shared.borrow().missions.pinned_directory(), None);

        // 1. instance.eventStatus:error, :connecting, and native worktree.updated must all bump Hub::location_revision,
        // and lookup must remain blocked while upstream OpenCode status is not connected.
        for frame in [
            b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"captured\",\"status\":\"error\",\"reason\":\"upstream closed\"}\n\n".as_slice(),
            b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"captured\",\"status\":\"connecting\"}\n\n".as_slice(),
            b"data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"worktree.updated\",\"data\":{}}}\n\n".as_slice(),
        ] {
            let before = backend_client.location_revision("captured", Some("session"));
            sse_stream.socket.write_all(frame).await.unwrap();
            wait_until(|| backend_client.location_revision("captured", Some("session")) > before)
                .await;
        }
        assert!(
            !backend_client.workspace_upstream_healthy("captured"),
            "error/connecting status must mark workspace upstream unhealthy"
        );
        for _ in 0..4 {
            tick(&mut rt);
        }
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "location lookup must stay blocked while workspace upstream is unhealthy"
        );

        // 2. Delivering instance.eventStatus:connected restores upstream health, advances location_revision,
        // clears location_failed, and retries lookup automatically.
        let before_connected = backend_client.location_revision("captured", Some("session"));
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"captured\",\"status\":\"connected\"}\n\n",
            )
            .await
            .unwrap();
        wait_until(|| {
            backend_client.location_revision("captured", Some("session")) > before_connected
                && backend_client.workspace_upstream_healthy("captured")
        })
        .await;
        let exp_b = "8".repeat(64);
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
        assert_eq!(
            shared.borrow().missions.pinned_directory(),
            Some("/repo/wt-b")
        );
    });
}

#[test]
fn transport_loss_during_queued_reread_marks_depth_uncertain_so_flush_warns() {
    let (shared, _rt) = platform::block_on(async {
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

        let exp_1 = "7".repeat(64);
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

        // Trigger a depth reread and hold GET open while queueing depth 4.
        shared
            .borrow_mut()
            .provider_target
            .as_mut()
            .unwrap()
            .hint("captured");
        let mut held_depth = None;
        for _ in 0..4 {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a" {
                held_depth = Some(req);
                break;
            } else if url.contains("/agents") {
                req.reply(200, json!({"data":[]})).await;
            } else {
                req.reply(200, json!({"data":{"all":[],"default":{},"connected":[]}}))
                    .await;
            }
        }
        let _held_depth = held_depth.expect("expected held depth reread");
        shared
            .borrow_mut()
            .missions
            .choose_depth("4".into(), true, true, Some("/repo/wt-a"));
        tick(&mut rt);

        // Lose transport before the reread completes: depth must become Uncertain (not Ready).
        shared.borrow_mut().missions.on_transport_lost();
        assert!(
            shared.borrow().missions.has_unconfirmed(),
            "dropping a queued depth choice on transport loss must report unconfirmed"
        );
        (shared, rt)
    });

    assert!(
        !shared.borrow_mut().flush(),
        "flush() must return false after transport loss dropped a queued depth choice"
    );
}

#[test]
fn native_flush_drains_more_than_eight_queued_missions_defaults_edits() {
    let (listener, shared, first_patch, _rt) = platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Start 1st TaskMode edit and hold its PATCH open, then queue 9 more toggles (10 total = 20 ops).
        click(&mut rt, "mission-task-mode-trigger");
        click_option(&mut rt, "mission-task-mode", "Independent sessions");
        let first_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            first_patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        for i in 0..9 {
            click(&mut rt, "mission-task-mode-trigger");
            let label = if i % 2 == 0 {
                "Native subagents"
            } else {
                "Independent sessions"
            };
            click_option(&mut rt, "mission-task-mode", label);
            tick(&mut rt);
        }
        (listener, shared, first_patch, rt)
    });

    let server = std::thread::spawn(move || {
        platform::block_on(async move {
            let mut latest =
                first_patch.body["patch"]["settings"]["missionProfileDefaults"].clone();
            assert!(!latest.is_null());
            first_patch
                .reply(
                    200,
                    json!({"settings":{"locale":"en","missionProfileDefaults":latest}}),
                )
                .await;
            let mut patches = 1usize;
            while patches < 10 {
                let req = request(&listener).await;
                if req.first == "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" {
                    req.reply(
                        200,
                        json!({"settings":{"locale":"en","missionProfileDefaults":latest}}),
                    )
                    .await;
                } else {
                    assert_eq!(
                        req.first,
                        "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
                    );
                    latest = req.body["patch"]["settings"]["missionProfileDefaults"].clone();
                    assert!(!latest.is_null());
                    patches += 1;
                    req.reply(
                        200,
                        json!({"settings":{"locale":"en","missionProfileDefaults":latest}}),
                    )
                    .await;
                }
            }
            let final_get = request(&listener).await;
            assert_eq!(
                final_get.first,
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
            );
            final_get
                .reply(
                    200,
                    json!({"settings":{"locale":"en","missionProfileDefaults":latest}}),
                )
                .await;
            patches
        })
    });

    let flushed = shared.borrow_mut().flush();
    let count = server.join().unwrap();
    assert_eq!(count, 10, "all 10 queued defaults PATCHes must be sent");
    assert!(
        flushed,
        "native flush() must drain all 10 queued Missions defaults edits cleanly"
    );
}

#[test]
fn reset_profiles_works_without_project_and_succeeds_after_inflight_task_mode_patch() {
    platform::block_on(async {
        let initial_defaults = json!([{
            "template": "all",
            "taskMode": "native",
            "profiles": {
                "coordinator": {
                    "agent": "build",
                    "model": { "providerID": "anthropic", "id": "claude" }
                }
            }
        }]);
        let (listener, mut prefs) = fixture().await;
        prefs.config.snapshot = Some(json!({
            "settings": {
                "locale": "en",
                "missionProfileDefaults": initial_defaults
            }
        }));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // No project open (provider_target == None): expand profiles disclosure and start TaskMode PATCH.
        assert!(shared.borrow().provider_target.is_none());
        click(&mut rt, "mission-task-mode-trigger");
        click_option(&mut rt, "mission-task-mode", "Independent sessions");
        let mode_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            mode_patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        let after_mode = mode_patch.body["patch"]["settings"]["missionProfileDefaults"].clone();
        assert!(!after_mode.is_null());

        // While TaskMode PATCH is still in flight (and without a project!), click Reset profiles & confirm.
        click(&mut rt, "trigger");
        tick(&mut rt);
        click(&mut rt, "mission-reset-profiles");
        tick(&mut rt);
        click(&mut rt, "file-decision-confirm");
        tick(&mut rt);

        // Complete TaskMode PATCH + authoritative GET.
        mode_patch
            .reply(
                200,
                json!({"settings":{"locale":"en","missionProfileDefaults":after_mode}}),
            )
            .await;
        let mode_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            mode_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        mode_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionProfileDefaults":after_mode}}),
            )
            .await;

        // Confirmed ResetProfiles must now send its PATCH preserving taskMode="independent" and clearing profiles.
        let reset_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            reset_patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        let after_reset = reset_patch.body["patch"]["settings"]["missionProfileDefaults"].clone();
        assert_eq!(
            after_reset,
            json!([{"template":"all","profiles":{},"taskMode":"independent"}]),
            "ResetProfiles must clear profiles while preserving the same-client TaskMode update"
        );
        reset_patch
            .reply(
                200,
                json!({"settings":{"locale":"en","missionProfileDefaults":after_reset}}),
            )
            .await;
        let reset_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            reset_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        reset_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionProfileDefaults":after_reset}}),
            )
            .await;

        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().missions.has_unconfirmed()
        })
        .await;
    });
}
