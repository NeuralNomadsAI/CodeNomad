use super::*;

#[test]
fn confirmed_deleted_mission_stays_filtered_across_stale_summaries_refresh() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        panel.seed_summary_for_test("msn-gone");
        panel.seed_summary_for_test("msn-keep");
        panel.forget_deleted_mission("msn-gone");
        assert!(!panel.has_summary_for_test("msn-gone"));

        // A stale cached directory refresh still containing msn-gone must NOT resurrect it.
        let make_sum = |id: &str| codenomad_client::missions::Summary {
            id: id.into(),
            title: Some(id.into()),
            objective: id.into(),
            status: codenomad_client::missions::Status::Active,
            run_state: None,
            coordinator_session_id: "ses_c".into(),
            actor_count: 1,
            updated_at: 1.0,
            revision: 7,
            finish_sequence: None,
            task_count: None,
        };
        assert!(panel.accept_summaries_for_test(vec![make_sum("msn-gone"), make_sum("msn-keep")]));
        assert!(
            !panel.has_summary_for_test("msn-gone"),
            "stale summaries refresh must not resurrect a confirmed deleted mission"
        );
        assert!(panel.has_summary_for_test("msn-keep"));

        // Once the server catches up with a full-coverage page omitting msn-gone, tombstone clears.
        assert!(panel.accept_summaries_for_test(vec![make_sum("msn-keep")]));
        assert!(!panel.has_summary_for_test("msn-gone"));
    });
}

#[test]
fn live_flag_revoke_synchronously_blocks_commit_dispatch_before_poll() {
    let flag = LiveFlag::new(true);
    let phase = Arc::new(AtomicU8::new(PHASE_PREFLIGHT));
    let (_tx, rx) = bounded(1);
    assert!(flag.register(phase.clone(), rx.clone()));
    assert!(flag.is_live());

    // Revoking the flag synchronously flips phase to PHASE_CANCELLED and closes cancel before any poll().
    flag.revoke();
    assert!(!flag.is_live());
    assert_eq!(phase.load(Ordering::Acquire), PHASE_CANCELLED);
    assert!(rx.is_closed());
    assert!(
        !LiveFlag::commit_dispatch(&[&flag], &phase),
        "commit_dispatch must refuse to enter PHASE_DISPATCHED after revoke"
    );
}

#[test]
fn offline_cancel_discards_selected_and_orphaned_delete_intents_while_retry_stays_disabled() {
    use rune::{Env, Runtime};
    crate::platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let (wake, done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        let mut lifecycle = crate::missions::Lifecycle::default();
        let mut src = source("msn-offline");
        src.mission.server = "server".into();
        src.workspace = http.backend.workspace.clone();
        lifecycle.cleanup.start_delete(
            &src,
            "Offline mission".into(),
            3,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let del = http.accept().await;
        del.reply(500, json!({"error": "failed"})).await;
        let rec = http.accept().await;
        rec.reply(500, json!({"error": "failed"})).await;
        wait(done.recv()).await.unwrap();
        lifecycle.cleanup.poll();
        assert!(matches!(
            lifecycle.cleanup.delete_state(&src),
            Some(DeleteState::Failed(_))
        ));

        // Mount panel while offline: mounted_view_live / mounted_selection_live must remain live for local Cancel.
        panel.set_online(false);
        panel.show(true);
        assert!(!panel.view_live.is_live());
        assert!(!panel.selection_live.is_live());
        assert!(panel.mounted_view_live.is_live());
        assert!(panel.mounted_selection_live.is_live());

        // Orphaned Cancel works offline while Retry stays disabled and does not fire.
        struct Harness {
            panel: crate::missions::Panel,
            lifecycle: crate::missions::Lifecycle,
            cancelled: bool,
            retried: bool,
        }
        let mut rt = Runtime::new(
            Harness {
                panel,
                lifecycle,
                cancelled: false,
                retried: false,
            },
            |h, _| {
                crate::strings::with_locale("en", || {
                    rune_theme_codenomad::git_panel::scroll().child(
                        crate::missions::cleanup_view::cleanup_view::<Harness>(
                            &h.panel,
                            &h.lifecycle.cleanup,
                            "occ",
                            |_, _, _, _| {},
                            |s, _, _, _, _, retry| {
                                if retry {
                                    s.retried = true;
                                } else {
                                    s.cancelled = true;
                                }
                            },
                        ),
                    )
                })
            },
            (420.0, 320.0),
            Env::new(false, 1.0),
        );
        rt.frame(1.0 / 60.0);
        let (rx, ry) = rt
            .find("mission-delete-retry-msn-offline")
            .expect("retry button");
        rt.pointer_down(rx, ry);
        rt.pointer_up(rx, ry);
        rt.frame(1.0 / 60.0);
        assert!(!rt.state.retried, "offline Retry must not fire");

        let (cx, cy) = rt
            .find("mission-delete-cancel-msn-offline")
            .expect("cancel button");
        rt.pointer_down(cx, cy);
        rt.pointer_up(cx, cy);
        rt.frame(1.0 / 60.0);
        assert!(rt.state.cancelled, "offline Cancel must fire immediately");
    });
}

#[test]
fn selected_mission_detail_observation_and_control_field_401_trigger_auth_expired() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        panel.seed_summary_for_test("msn-401");
        panel.show(true);
        panel.select("msn-401");

        // Reply 200 to summaries & cleanups, 401 to selected mission detail read, then authenticated: false on /api/auth/status.
        let mut got_detail = false;
        let mut got_auth_probe = false;
        for _ in 0..8 {
            panel.poll();
            if panel.take_auth_expired().is_some() {
                break;
            }
            let req = http.accept().await;
            if req.header.contains("/api/auth/status") {
                req.reply(200, json!({"authenticated": false})).await;
                got_auth_probe = true;
                break;
            } else if req.body["source"] == "mission" {
                req.reply(401, json!({"error": "unauthorized"})).await;
                got_detail = true;
            } else {
                let source = req.body["source"].as_str().unwrap_or("summaries");
                let mut body = json!({
                    "available": true, "version": 1, "projectID": "project", "source": source,
                    "window": {"order": "a".repeat(43), "offset": 0, "end": 0, "total": 0},
                    "page": {"digest": "b".repeat(43), "total": 0, "pieces": []}
                });
                if source == "summaries" {
                    body["finishHighWater"] = json!(0);
                }
                req.reply(200, body).await;
            }
        }
        assert!(got_detail, "expected mission detail request");
        assert!(got_auth_probe, "expected /api/auth/status probe after 401");
        let mut expired = false;
        for _ in 0..40 {
            panel.poll();
            if panel.take_auth_expired().is_some() {
                expired = true;
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            expired,
            "confirmed 401 on selected-mission detail read must surface auth_expired"
        );
    });
}

#[test]
fn direct_delete_revoked_view_skips_post_failure_reconciliation_and_keeps_retryable_intent() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-fenced-direct");
        let live = LiveFlag::new(true);
        let mut owner = CleanupOwner::default();

        owner.start_delete(
            &src,
            "Direct fenced".into(),
            7,
            false,
            live.clone(),
            http.backend.clone(),
            wake.clone(),
        );
        let del = http.accept().await;
        assert!(del.header.starts_with("DELETE "));
        // Revoke the originating selection before the DELETE failure settles.
        live.revoke();
        del.reply(503, json!({"error": "unavailable"})).await;

        wait(done.recv()).await.unwrap();
        // No reconciliation GET may be sent after the originating view was revoked.
        let unexpected =
            tokio::time::timeout(std::time::Duration::from_millis(80), http.accept()).await;
        assert!(
            unexpected.is_err(),
            "revoked direct delete must not issue post-failure reconciliation GET"
        );
        let polled = owner.poll_deletes();
        assert!(polled.changed);
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
        );
    });
}

#[test]
fn offline_panel_blocks_confirm_stop_and_readback_resend() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        let mut lifecycle = crate::missions::Lifecycle::default();
        let hdr = serde_json::from_value::<codenomad_client::missions::MapHeader>(json!({
            "root":{"version":1,"id":"msn-offline-stop","projectID":"project","projectCanonical":"/fixture",
                "excerpt":"Fixture","template":"custom","status":"active","runState":"running",
                "coordinatorSessionId":"session","revision":7,"createdAt":1,"updatedAt":1,
                "historyTruncated":false,"bodies":{}},
            "collections":{},
            "coordinator":{"kind":"coordinator","sessionId":"session","location":{"directory":"/fixture"}},
            "tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
                "pins":[],"reportPins":[],"version":""},
        }))
        .unwrap();
        panel.detail.snapshot = Some(crate::missions::detail::Snapshot {
            header: hdr,
            tasks: std::rc::Rc::new(crate::missions::task_rows::TaskRows::new(vec![])),
            end: 0,
            attention_end: 0,
        });
        panel.set_online(false);
        let mut src = source("msn-offline-stop");
        src.occurrence = "occ".into();
        src.workspace = http.backend.workspace.clone();
        lifecycle.confirmation = Some(crate::missions::lifecycle::StopConfirmation {
            id: 1,
            source: src.clone(),
            revision: 7,
            live: LiveFlag::new(true),
        });
        panel.control(
            "occ",
            &mut lifecycle,
            &src,
            crate::missions::Gesture::ConfirmStop(1, true),
        );
        let unexpected =
            tokio::time::timeout(std::time::Duration::from_millis(60), http.accept()).await;
        assert!(
            unexpected.is_err(),
            "offline ConfirmStop must never send Stop"
        );
    });
}

#[test]
fn cleanup_row_retry_reconciles_lost_ack_503_and_settles_off_page_row() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-offpage-503");
        let sc = src.workspace_scope();
        let mut saved = cleanup_row(1, false);
        saved.mission_id = "msn-offpage-503".into();
        saved.deletion_id = "del-offpage-503".into();

        let mut owner = CleanupOwner::default();
        owner.start_cleanup_retry(
            sc.clone(),
            saved.clone(),
            LiveFlag::new(true),
            LiveFlag::new(true),
            http.backend.clone(),
            wake,
        );
        // 1. Preflight GET shows row still pending.
        let pre = http.accept().await;
        assert!(pre.header.starts_with("GET /api/workspaces/"));
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [{
                    "missionID": "msn-offpage-503", "deletionID": "del-offpage-503",
                    "requestID": saved.request_id, "expectedRevision": saved.expected_revision,
                    "deleteManagedSessions": saved.delete_managed_sessions,
                    "objective": "Off-page", "createdAt": saved.created_at,
                    "pending": 1, "removed": 0, "retained": 0, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        // 2. DELETE commits on server, but response is 503 (lost acknowledgement).
        let del = http.accept().await;
        assert!(del.header.starts_with("DELETE /api/workspaces/"));
        del.reply(503, json!({"error": "upstream dropped"})).await;
        // 3. Post-dispatch reconciliation GET runs automatically and confirms settlement.
        let rec = http.accept().await;
        assert!(rec.header.starts_with("GET /api/workspaces/"));
        rec.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [{
                    "missionID": "msn-offpage-503", "deletionID": "del-offpage-503",
                    "requestID": saved.request_id, "expectedRevision": saved.expected_revision,
                    "deleteManagedSessions": saved.delete_managed_sessions,
                    "objective": "Off-page", "createdAt": saved.created_at,
                    "pending": 0, "removed": 1, "retained": 0, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;

        wait(done.recv()).await.unwrap();
        let polled = owner.poll_retries();
        assert_eq!(
            polled.settled_cleanups.len(),
            1,
            "lost-ack 503 after committed cleanup-row DELETE must settle via exact reconciliation"
        );
        assert_eq!(polled.settled_cleanups[0].1.deletion_id, "del-offpage-503");
        assert!(owner.cleanup_error(&sc).is_none());
    });
}

#[test]
fn cleanup_order_change_pagination_avoids_repeated_tail_rescans() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        let make_row = |prefix: &str, idx: u64| {
            let mut r = cleanup_row(1, false);
            r.mission_id = format!("{prefix}-m-{idx}");
            r.deletion_id = format!("{prefix}-d-{idx}");
            r
        };
        // Load 1,500 pending rows in order A.
        for page in 0..30u64 {
            let offset = page * 50;
            assert!(panel.accept_more_cleanups_for_test(
                "order-a",
                offset,
                1_500,
                (0..50).map(|i| make_row("old", offset + i)).collect()
            ));
        }
        // Order change to order B with disjoint first page keeps 1,500 old rows as tail.
        assert!(panel.accept_more_cleanups_for_test(
            "order-b",
            0,
            2_000,
            (0..50).map(|i| make_row("new", i)).collect()
        ));
        panel.reset_cleanup_tail_visits();
        // Paginate 20 disjoint replacement pages: zero tail rescans should occur!
        for page in 1..21u64 {
            let offset = page * 50;
            assert!(panel.accept_more_cleanups_for_test(
                "order-b",
                offset,
                2_000,
                (0..50).map(|i| make_row("new", offset + i)).collect()
            ));
        }
        assert_eq!(
            panel.cleanup_tail_visits(),
            0,
            "disjoint replacement pages must not rescan the retained tail"
        );
        // Order C collides with 1,000 retained tail rows across 20 pages: each collision must be
        // removed in O(1) without rescanning the tail (<= 1,000 visits total, not O(pages * tail)).
        assert!(panel.accept_more_cleanups_for_test(
            "order-c",
            0,
            2_000,
            (0..50).map(|i| make_row("c-head", i)).collect()
        ));
        panel.reset_cleanup_tail_visits();
        for page in 0..20u64 {
            let offset = (page + 1) * 50;
            assert!(panel.accept_more_cleanups_for_test(
                "order-c",
                offset,
                2_000,
                (0..50).map(|i| make_row("new", page * 50 + i)).collect()
            ));
        }
        assert!(
            panel.cleanup_tail_visits() <= 1_000,
            "colliding replacement pages must evict tail rows in O(1) without rescanning: visits={}",
            panel.cleanup_tail_visits()
        );
        let (disp_len, seen_len, meta_len, pending_len) = panel.cleanup_index_counts();
        assert!(
            disp_len <= 2_000 && seen_len <= 2_000 && meta_len <= 2_000 && pending_len <= 2_000
        );
    });
}
