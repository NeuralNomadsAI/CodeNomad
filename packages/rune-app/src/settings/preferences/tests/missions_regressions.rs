use super::{
    missions::{click, click_option, make_window, next_request, settle_meta, tick},
    *,
};
use crate::settings::{providers::Target, view};
use codenomad_client::transport::{Event, WorkspaceEvent};
use std::{cell::Cell, rc::Rc, sync::Arc};

pub(super) fn depth_snapshot_json(directory: &str, depth: Option<u64>, expectation: &str) -> Value {
    json!({
        "location": { "directory": directory },
        "capability": { "minimum": 1, "maximum": 5, "default": 2 },
        "effectiveDepth": depth.unwrap_or(2),
        "nesting": { "effect": "allow", "hidden": false },
        "origin": format!("{directory}/opencode.jsonc"),
        "project": {
            "path": format!("{directory}/opencode.jsonc"),
            "depth": depth,
            "expectation": expectation,
            "nestingSkipped": false,
            "emptyExperimental": false
        }
    })
}

pub(super) async fn drain_location_catalog_and_depth(
    listener: &TcpListener,
    rt: &mut rune::Runtime<view::Window>,
    expected_dir: &str,
    encoded_dir: &str,
    depth: Option<u64>,
    expectation: &str,
    expect_session_lookup: bool,
) {
    let mut got_session = !expect_session_lookup;
    let mut got_catalog = 0usize;
    let mut got_depth = false;
    while !(got_session && got_catalog == 3 && got_depth) {
        let req = next_request(listener, rt).await;
        let url = req.first.split_whitespace().nth(1).unwrap();
        if url == "/workspaces/captured/instance/api/session/session" {
            assert!(
                !got_session,
                "unexpected duplicate session lookup: {}",
                req.first
            );
            got_session = true;
            req.reply(
                200,
                json!({"data":{"id":"session","location":{"directory":expected_dir}}}),
            )
            .await;
        } else if url == format!("/api/workspaces/captured/subagent-depth?directory={encoded_dir}")
        {
            got_depth = true;
            req.reply(200, depth_snapshot_json(expected_dir, depth, expectation))
                .await;
        } else if url.starts_with("/workspaces/captured/instance/api/")
            && url.contains(&format!("location%5Bdirectory%5D={encoded_dir}"))
        {
            got_catalog += 1;
            req.reply(
                200,
                json!({"location":{"directory":expected_dir},"data":[]}),
            )
            .await;
        } else {
            panic!("unexpected request for {expected_dir}: {}", req.first);
        }
    }
}

#[test]
fn missions_session_moved_and_rebind_invalidate_pinned_directory_and_retarget_writes() {
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
        let exp_b = "b".repeat(64);
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
            shared.borrow().missions.pinned_directory() == Some("/repo/wt-a")
                && !shared
                    .borrow()
                    .missions
                    .depth_disabled(true, true, Some("/repo/wt-a"))
        })
        .await;

        // session.moved invalidates pinned_directory and pending choices until re-resolved.
        crate::settings::connection_event(
            &root,
            &Event::Workspace(WorkspaceEvent::SessionMoved {
                workspace_id: "captured".into(),
                session_id: "session".into(),
            }),
            true,
        );
        tick(&mut rt);
        assert_eq!(shared.borrow().missions.pinned_directory(), None);
        assert!(shared.borrow().missions.depth_disabled(true, true, None));

        // While session resolution is in flight, no PUT can be sent to the old worktree.
        let session_req = next_request(&listener, &mut rt).await;
        assert_eq!(
            session_req.first,
            "GET /workspaces/captured/instance/api/session/session HTTP/1.1"
        );
        shared
            .borrow_mut()
            .missions
            .choose_depth("4".into(), true, true, None);
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err(),
            "depth PUT must not target old worktree while location is resolving"
        );

        // Session resolves to /repo/wt-b -> catalog and depth must retarget /repo/wt-b.
        session_req
            .reply(
                200,
                json!({"data":{"id":"session","location":{"directory":"/repo/wt-b"}}}),
            )
            .await;
        drain_location_catalog_and_depth(
            &listener,
            &mut rt,
            "/repo/wt-b",
            "%2Frepo%2Fwt-b",
            Some(1),
            &exp_b,
            false,
        )
        .await;
        wait_until(|| {
            tick(&mut rt);
            shared.borrow().missions.pinned_directory() == Some("/repo/wt-b")
                && !shared
                    .borrow()
                    .missions
                    .depth_disabled(true, true, Some("/repo/wt-b"))
        })
        .await;

        // Writing depth now targets /repo/wt-b with exp_b.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);
        let put = next_request(&listener, &mut rt).await;
        assert_eq!(
            put.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(
            put.body,
            json!({
                "location": { "directory": "/repo/wt-b" },
                "depth": 4,
                "expectation": exp_b
            })
        );
        put.reply_no_content().await;
        let refresh_b = next_request(&listener, &mut rt).await;
        assert_eq!(
            refresh_b.first,
            "GET /api/workspaces/captured/subagent-depth?directory=%2Frepo%2Fwt-b HTTP/1.1"
        );
        let exp_b2 = "c".repeat(64);
        refresh_b
            .reply(200, depth_snapshot_json("/repo/wt-b", Some(4), &exp_b2))
            .await;
        wait_until(|| {
            tick(&mut rt);
            !shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-b"))
        })
        .await;

        // Same-address rebind must also clear pinned_directory and disallow writes until re-resolved.
        shared.borrow_mut().missions.rebind(true);
        assert_eq!(shared.borrow().missions.pinned_directory(), None);
        assert!(shared.borrow().missions.depth_disabled(true, true, None));
        assert!(
            shared
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-b"))
        );
    });
}

#[test]
fn missions_patch_and_depth_put_check_shared_authority_and_attestation_before_send() {
    platform::block_on(async {
        // 1. require_authentication revokes Preferences::authority right before Missions PATCH.
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        let (release_patch, patch_gate) = bounded(1);
        shared.borrow_mut().missions.set_pre_patch_gate(patch_gate);
        click(&mut rt, "mission-delete-sessions");
        tick(&mut rt);
        shared.borrow_mut().require_authentication();
        release_patch.send(()).await.unwrap();
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "Missions PATCH must abort before sending once require_authentication revokes authority"
        );

        // 2. require_authentication revokes Preferences::authority right before subagent-depth PUT.
        let (listener2, mut prefs2) = fixture().await;
        let backend2 = prefs2.backend.as_mut().unwrap();
        backend2.workspace = "captured".into();
        backend2.session = "session".into();
        let root2 = crate::init();
        let shared2 = root2.settings.shared.clone();
        prefs2.window_wake = Some(Arc::new(|| {}));
        *shared2.borrow_mut() = prefs2;
        let target2 = Target::capture(&root2).unwrap();
        {
            let mut prefs = shared2.borrow_mut();
            prefs
                .missions
                .capture_opener(Some("/repo/wt-a".into()), Some(&target2));
            prefs.provider_target = Some(target2);
        }
        let window2 = view::Window::new(shared2.clone(), Rc::new(Cell::new(false)));
        let mut rt2 = rune::Runtime::new(
            window2,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt2.frame(0.0);
        settle_meta(&listener2, &mut rt2).await;
        click(&mut rt2, "settings-missions");
        tick(&mut rt2);
        let exp = "d".repeat(64);
        drain_location_catalog_and_depth(
            &listener2,
            &mut rt2,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp,
            true,
        )
        .await;
        wait_until(|| {
            tick(&mut rt2);
            !shared2
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-a"))
        })
        .await;

        let (release_put, put_gate) = bounded(1);
        shared2
            .borrow_mut()
            .missions
            .set_pre_depth_put_gate(put_gate);
        click(&mut rt2, "mission-subagent-depth-trigger");
        click_option(&mut rt2, "mission-subagent-depth", "4");
        tick(&mut rt2);
        shared2.borrow_mut().require_authentication();
        release_put.send(()).await.unwrap();
        tick(&mut rt2);
        assert!(
            timeout(Duration::from_millis(120), listener2.accept())
                .await
                .is_err(),
            "depth PUT must abort before sending once require_authentication revokes authority"
        );

        // 3. Attested server identity mismatch blocks both Missions PATCH and depth PUT.
        let (listener3, mut prefs3) = fixture().await;
        let backend3 = prefs3.backend.as_mut().unwrap();
        backend3.workspace = "captured".into();
        backend3.session = "session".into();
        let attest_client = backend3.clone();
        let (attest_tx, attest_rx) = bounded(1);
        platform::spawn(async move {
            let _ = attest_tx.send(attest_client.attest_server().await).await;
        });
        let init_meta = request(&listener3).await;
        assert_eq!(init_meta.first, "GET /api/meta HTTP/1.1");
        init_meta
            .reply(
                200,
                json!({"apiContract":1,"serverId":"srv-original","capabilities":[]}),
            )
            .await;
        attest_rx.recv().await.unwrap().unwrap();

        let root3 = crate::init();
        let shared3 = root3.settings.shared.clone();
        prefs3.window_wake = Some(Arc::new(|| {}));
        *shared3.borrow_mut() = prefs3;
        let target3 = Target::capture(&root3).unwrap();
        {
            let mut prefs = shared3.borrow_mut();
            prefs
                .missions
                .capture_opener(Some("/repo/wt-a".into()), Some(&target3));
            prefs.provider_target = Some(target3);
        }
        let window3 = view::Window::new(shared3.clone(), Rc::new(Cell::new(false)));
        let mut rt3 = rune::Runtime::new(
            window3,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt3.frame(0.0);
        // Window's initial capability probe keeps the same serverId.
        let win_meta = next_request(&listener3, &mut rt3).await;
        assert_eq!(win_meta.first, "GET /api/meta HTTP/1.1");
        win_meta
            .reply(
                200,
                json!({"apiContract":1,"serverId":"srv-original","capabilities":[]}),
            )
            .await;
        click(&mut rt3, "settings-missions");
        tick(&mut rt3);
        drain_location_catalog_and_depth(
            &listener3,
            &mut rt3,
            "/repo/wt-a",
            "%2Frepo%2Fwt-a",
            Some(2),
            &exp,
            true,
        )
        .await;
        wait_until(|| {
            tick(&mut rt3);
            !shared3
                .borrow()
                .missions
                .depth_disabled(true, true, Some("/repo/wt-a"))
        })
        .await;

        // Swapping serverId on the pre-send attestation check must abort depth PUT.
        click(&mut rt3, "mission-subagent-depth-trigger");
        click_option(&mut rt3, "mission-subagent-depth", "5");
        tick(&mut rt3);
        let pre_put_meta = next_request(&listener3, &mut rt3).await;
        assert_eq!(pre_put_meta.first, "GET /api/meta HTTP/1.1");
        pre_put_meta
            .reply(
                200,
                json!({"apiContract":1,"serverId":"srv-restarted","capabilities":[]}),
            )
            .await;
        tick(&mut rt3);
        assert!(
            timeout(Duration::from_millis(120), listener3.accept())
                .await
                .is_err(),
            "depth PUT must never send when server attestation fails"
        );
        // With attestation now revoked, Missions PATCH must also refuse to send.
        click(&mut rt3, "mission-delete-sessions");
        tick(&mut rt3);
        assert!(
            timeout(Duration::from_millis(120), listener3.accept())
                .await
                .is_err(),
            "Missions PATCH must never send once backend attestation is revoked"
        );
    });
}

#[test]
fn missions_config_writes_serialize_with_document_and_publish_via_authoritative_read() {
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Stage a Document write and trigger a Missions write concurrently:
        // Document runs first while Missions waits.
        shared.borrow_mut().set_locale("fr");
        click(&mut rt, "mission-delete-sessions");
        tick(&mut rt);

        let first = next_request(&listener, &mut rt).await;
        assert_eq!(first.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(first.body, json!({"settings":{"locale":"fr"}}));
        // Missions must not overlap its PATCH while Document is in flight.
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "Missions PATCH must wait until in-flight Document PATCH completes"
        );
        first
            .reply(
                200,
                json!({"settings":{"locale":"fr","missionDeleteSessions":false}}),
            )
            .await;

        // Now Missions PATCH runs.
        let second = next_request(&listener, &mut rt).await;
        assert_eq!(
            second.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        assert_eq!(
            second.body["patch"]["settings"]["missionDeleteSessions"],
            json!(true)
        );

        // Stage another Document write while Missions PATCH is in flight:
        // Document must wait until Missions PATCH finishes and authoritative GET runs.
        shared.borrow_mut().set_contrast("on");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "Document PATCH must wait while Missions PATCH is in flight"
        );

        // Reply to Missions PATCH with a stale locale ("en"): it must NEVER overwrite Document's
        // confirmed "fr" snapshot directly; Document must publish via authoritative GET instead.
        second
            .reply(
                200,
                json!({"settings":{"locale":"en","missionDeleteSessions":true}}),
            )
            .await;

        let third = next_request(&listener, &mut rt).await;
        assert_eq!(
            third.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        assert_eq!(
            shared.borrow().locale(),
            Some("fr"),
            "stale Missions ACK must never clobber Document's confirmed locale"
        );
        third
            .reply(
                200,
                json!({"settings":{"locale":"fr","missionDeleteSessions":true}}),
            )
            .await;

        // After authoritative GET publishes both locale=fr and missionDeleteSessions=true,
        // Document sends the queued highContrast PATCH.
        let fourth = next_request(&listener, &mut rt).await;
        assert_eq!(fourth.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(fourth.body, json!({"settings":{"highContrast":"on"}}));
        fourth
            .reply(
                200,
                json!({"settings":{"locale":"fr","highContrast":"on","missionDeleteSessions":true}}),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            let prefs = shared.borrow();
            prefs.locale() == Some("fr")
                && prefs.contrast() == "on"
                && prefs
                    .saved(Owner::Config)
                    .is_some_and(|doc| doc["settings"]["missionDeleteSessions"] == true)
        })
        .await;
    });
}

#[test]
fn depth_put_aborts_when_session_moved_arrives_during_server_attestation() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();

        // Establish initial server attestation so subsequent writes call GET /api/meta before PUT.
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
                json!({"apiContract":1,"serverId":"srv-depth","capabilities":[]}),
            )
            .await;
        attest_rx.recv().await.unwrap().unwrap();

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

        let exp_a = "e".repeat(64);
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

        // Choose a new depth: the save task starts by requesting GET /api/meta attestation.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "4");
        tick(&mut rt);
        let attest_meta = next_request(&listener, &mut rt).await;
        assert_eq!(attest_meta.first, "GET /api/meta HTTP/1.1");

        // While GET /api/meta is held open, session.moved arrives and revokes location_token
        // synchronously, even before the next UI poll runs.
        crate::settings::connection_event(
            &root,
            &Event::Workspace(WorkspaceEvent::SessionMoved {
                workspace_id: "captured".into(),
                session_id: "session".into(),
            }),
            true,
        );
        attest_meta
            .reply(
                200,
                json!({"apiContract":1,"serverId":"srv-depth","capabilities":[]}),
            )
            .await;

        // The post-attestation check must abort before any PUT reaches /repo/wt-a.
        assert!(
            timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err(),
            "depth PUT must not be sent to worktree A after session.moved during attestation"
        );
    });
}

#[test]
fn authoritative_config_read_survives_sse_invalidation_ahead_of_queued_document_patch() {
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        click(&mut rt, "mission-delete-sessions");
        tick(&mut rt);
        let patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );

        // Queue a Document write while Missions PATCH is in flight.
        shared.borrow_mut().set_contrast("on");
        patch
            .reply(
                200,
                json!({"settings":{"locale":"en","missionDeleteSessions":true}}),
            )
            .await;

        // First authoritative GET starts.
        let first_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            first_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );

        // An invalidation arrives while the first authoritative GET is in flight,
        // causing its response to be discarded as stale.
        shared.borrow_mut().invalidate(Owner::Config);
        first_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionDeleteSessions":true}}),
            )
            .await;

        // The replacement authoritative GET must still run ahead of the queued contrast PATCH.
        let second_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            second_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        second_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionDeleteSessions":true}}),
            )
            .await;

        // Only after the authoritative GET publishes cleanly does Document send highContrast PATCH.
        let contrast_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            contrast_patch.first,
            "PATCH /api/storage/config/ui HTTP/1.1"
        );
        assert_eq!(
            contrast_patch.body,
            json!({"settings":{"highContrast":"on"}})
        );
        contrast_patch
            .reply(
                200,
                json!({"settings":{"locale":"en","highContrast":"on","missionDeleteSessions":true}}),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            let prefs = shared.borrow();
            prefs.contrast() == "on"
                && prefs
                    .saved(Owner::Config)
                    .is_some_and(|doc| doc["settings"]["missionDeleteSessions"] == true)
        })
        .await;
    });
}

#[test]
fn library_post_send_conflict_triggers_authoritative_read_ahead_of_queued_document_patch() {
    platform::block_on(async {
        let initial_model = json!({
            "version": 1,
            "id": "004633fb-53c4-477c-8b01-4cc5c177724b",
            "name": "Alpha",
            "objective": "Check alpha",
            "notes": "",
            "template": "custom"
        });
        let updated_model = json!({
            "version": 1,
            "id": "114633fb-53c4-477c-8b01-4cc5c177724b",
            "name": "Beta",
            "objective": "Check beta",
            "notes": "",
            "template": "custom"
        });
        let (listener, mut prefs) = fixture().await;
        prefs.apply_mission_config(json!({
            "settings": {
                "locale": "en",
                "missionModels": [initial_model]
            }
        }));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        click(&mut rt, "mission-model-library-trigger");
        click_option(&mut rt, "mission-model-library", "Alpha");
        click(&mut rt, "mission-models-remove");
        click(&mut rt, "file-decision-confirm");
        tick(&mut rt);

        let remove_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            remove_patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        assert_eq!(
            remove_patch.body["patch"]["settings"]["missionModels"],
            json!([])
        );

        // Queue a Document PATCH while the library PATCH is in flight.
        shared.borrow_mut().set_contrast("on");
        remove_patch.reply(409, json!({"error":"conflict"})).await;

        // Post-send 409 must trigger an authoritative GET before Document's queued PATCH
        // and must never replay the failed library PATCH.
        let reconcile_get = next_request(&listener, &mut rt).await;
        assert_eq!(
            reconcile_get.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        reconcile_get
            .reply(
                200,
                json!({"settings":{"locale":"en","missionModels":[updated_model]}}),
            )
            .await;

        let contrast_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            contrast_patch.first,
            "PATCH /api/storage/config/ui HTTP/1.1"
        );
        assert_eq!(
            contrast_patch.body,
            json!({"settings":{"highContrast":"on"}})
        );
        contrast_patch
            .reply(
                200,
                json!({"settings":{"locale":"en","highContrast":"on","missionModels":[updated_model]}}),
            )
            .await;

        wait_until(|| {
            tick(&mut rt);
            let prefs = shared.borrow();
            prefs.contrast() == "on"
                && prefs.saved(Owner::Config).is_some_and(|doc| {
                    doc["settings"]["missionModels"][0]["id"]
                        == "114633fb-53c4-477c-8b01-4cc5c177724b"
                })
                && prefs.missions.has_unconfirmed()
        })
        .await;
    });
}

#[test]
fn native_flush_exits_promptly_when_missions_queued_edit_cannot_start_after_transport_loss() {
    let (listener, shared, _rt) = platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Hold delete_flight at pre_patch_gate and queue a DefaultsEdit behind it.
        let (release_patch, patch_gate) = bounded(1);
        shared.borrow_mut().missions.set_pre_patch_gate(patch_gate);
        click(&mut rt, "mission-delete-sessions");
        tick(&mut rt);
        click(&mut rt, "mission-task-mode-trigger");
        click_option(&mut rt, "mission-task-mode", "Independent sessions");
        tick(&mut rt);
        assert!(
            shared.borrow().missions.defaults_writing(),
            "DefaultsEdit must be queued behind the gated delete_flight"
        );

        // Lose transport with no config GET scheduled and wait for the gated pre-send abort
        // to settle deterministically before exercising flush() outside block_on.
        shared.borrow_mut().mark_transport_lost();
        release_patch.send(()).await.unwrap();
        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().missions.config_write_in_flight()
        })
        .await;
        (listener, shared, rt)
    });

    let started = std::time::Instant::now();
    let flushed = shared.borrow_mut().flush();
    assert!(
        !flushed,
        "flush must report unconfirmed Missions writes when transport is lost"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "flush must not spin waiting for an unstartable Missions edit, took {:?}",
        started.elapsed()
    );
    platform::block_on(async {
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "no HTTP write may be sent during flush after transport loss"
        );
    });
}
