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
            false,
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
            false,
        )
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
        let mut got_catalog = 0usize;
        let mut got_depth = false;
        while !(got_catalog == 3 && got_depth) {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-a" {
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
            false,
        )
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

        // 2. Delivering agent.updated must invalidate provider_changes and refresh Missions catalog.
        sse_stream
            .socket
            .write_all(
                b"data: {\"type\":\"instance.event\",\"instanceId\":\"captured\",\"event\":{\"type\":\"agent.updated\",\"data\":{}}}\n\n",
            )
            .await
            .unwrap();
        let mut saw_provider_change = false;
        wait_until(|| {
            let (changes, _, _) = watch.take_provider_changes();
            if matches!(
                changes,
                codenomad_client::stream::CatalogueChanges::Workspaces(ref set)
                    if set.contains("captured")
            ) {
                saw_provider_change = true;
            }
            saw_provider_change
        })
        .await;
        shared
            .borrow_mut()
            .provider_target
            .as_mut()
            .unwrap()
            .hint("captured");
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(3),
            &exp_ext,
            false,
        )
        .await;
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
