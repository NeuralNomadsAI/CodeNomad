use super::*;

#[test]
fn delete_intent_pins_observed_deletion_id_across_retry_and_passive_retirement() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-pin");
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Pin target".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        first.reply(503, json!({"code": "cleanup-pending"})).await;
        // Post-503 reconciliation observes deletionID "del-a" pending.
        let rec1 = http.accept().await;
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [{
                    "missionID": "msn-pin", "deletionID": "del-a", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Pin", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 1, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        // Passive retirement with a substituted deletionID "del-b" must NOT retire the intent.
        let substituted_json = json!({
            "missionID": "msn-pin", "deletionID": "del-b", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "Pin", "createdAt": 2, "removed": 1, "retained": 0,
            "pending": 0, "reasons": [], "documentPending": false
        });
        let substituted: Cleanup = serde_json::from_value(substituted_json.clone()).unwrap();
        owner.retire_settled_cleanups(&src.workspace_scope(), &[substituted], true);
        assert!(owner.delete_state(&src).is_some());

        // Explicit retry observing a contradictory deletionID "del-b" on preflight GET must
        // stop before sending a second DELETE and keep the pinned "del-a" intent unconfirmed.
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake);
        }
        let pre_get = http.accept().await;
        pre_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [substituted_json]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let polled = owner.poll();
        assert!(polled.deleted_missions.is_empty());
        assert!(polled.settled_cleanups.is_empty());
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
        );
    });
}

#[test]
fn cleanup_retry_preserves_preflight_document_pending_across_failed_attempt_and_directory_refresh()
{
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let mut owner = CleanupOwner::default();

        // Start with a directory row whose documentPending was omitted (None).
        let mut omitted_row = cleanup_row(1, false);
        omitted_row.document_pending = None;
        owner.start_cleanup_retry(
            sc.clone(),
            omitted_row.clone(),
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        // Preflight GET reveals documentPending: true, then DELETE fails with 503.
        let pre1 = http.accept().await;
        pre1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [cleanup_json(1, true)]
            }),
        )
        .await;
        let del1 = http.accept().await;
        del1.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec1 = http.accept().await;
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [cleanup_json(1, true)]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let polled1 = owner.poll();
        assert_eq!(
            polled1.document_pending_rows,
            vec![(
                sc.clone(),
                crate::missions::directory::cleanup_identity(&omitted_row)
            )]
        );

        // Even if a subsequent directory refresh still omits documentPending, Panel preserves true
        // once notified and the next retry still requires explicit documentPending: false.
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        assert!(panel.accept_cleanups_for_test(vec![omitted_row.clone()]));
        panel.mark_cleanup_document_pending(&crate::missions::directory::cleanup_identity(
            &omitted_row,
        ));
        assert_eq!(panel.cleanups[0].document_pending, Some(true));
        assert!(panel.accept_cleanups_for_test(vec![omitted_row.clone()]));
        assert_eq!(panel.cleanups[0].document_pending, Some(true));

        owner.start_cleanup_retry(
            sc.clone(),
            omitted_row,
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake,
        );
        let pre2 = http.accept().await;
        pre2.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [{
                    "missionID": "old", "deletionID": "del-1", "requestID": "req-1",
                    "expectedRevision": 3, "deleteManagedSessions": false,
                    "objective": "Old mission", "createdAt": 1,
                    "removed": 1, "retained": 0, "pending": 0, "reasons": []
                }]
            }),
        )
        .await;
        // Must refuse to settle on preflight GET without sending DELETE because remembered
        // documentPending: true was not explicitly confirmed false.
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let polled2 = owner.poll();
        assert!(polled2.settled_cleanups.is_empty());
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );
    });
}

#[test]
fn cleanup_retry_revokes_on_created_at_change() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        panel.view_live = live_flag();
        panel.cleanup_view_live = live_flag();
        let row1 = cleanup_row(1, true);
        assert!(panel.accept_cleanups_for_test(vec![row1.clone()]));
        panel.cleanup_view_live = live_flag();
        let view_token = panel.cleanup_view_live.clone();
        assert!(view_token.is_live());

        let mut row2 = cleanup_row(1, false);
        row2.created_at = 2.0;
        assert!(
            !panel.accept_cleanups_for_test(vec![row2]),
            "contradictory createdAt for the same mission/deletion must be rejected"
        );
        assert_eq!(panel.cleanups.len(), 1);
        assert_eq!(panel.cleanups[0].created_at, 1.0);
        assert_eq!(panel.cleanups[0].document_pending, Some(true));
        assert!(
            !view_token.is_live(),
            "createdAt change must revoke cleanup_view_live"
        );
    });
}

#[test]
fn revoked_get_only_settlement_preserves_delete_intent_and_cleanup_tokens_cap_at_64() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut owner = CleanupOwner::default();
        let src = source("old");
        let sc = src.workspace_scope();
        owner.deletes.insert(
            (sc.clone(), src.mission.clone()),
            DeleteIntent {
                scope: sc.clone(),
                title: "Old".into(),
                target: src.target.clone(),
                request: DeletionRequest {
                    request_id: "req-1".into(),
                    expected_revision: 3,
                    delete_managed_sessions: false,
                },
                flight: None,
                flight_live: None,
                flight_cancel: None,
                flight_phase: None,
                error: Some("missions.cleanup.error.pending"),
                document_cleanup: false,
                deletion_id: Some("del-1".into()),
                created_at_bits: None,
                retired: false,
            },
        );
        let view_live = live_flag();
        let row_live = live_flag();
        view_live.revoke();
        let (out, inbox) = bounded(1);
        out.try_send(CleanupRetryResult::Settled {
            receipt: Box::new(cleanup_row(0, false)),
            mutated: false,
            document_cleanup: false,
        })
        .unwrap();
        owner.retries.insert(
            sc.clone(),
            CleanupRetry {
                key: CleanupKey::new(sc.clone(), &cleanup_row(1, false)),
                view_live,
                row_live,
                cancel: None,
                phase: Arc::new(AtomicU8::new(PHASE_PREFLIGHT)),
                flight: inbox,
                retired: false,
            },
        );
        let polled = owner.poll();
        assert!(polled.settled_cleanups.is_empty());
        assert!(polled.deleted_missions.is_empty());
        assert!(polled.refreshed_scopes.is_empty());
        assert!(
            owner.delete_state(&src).is_some(),
            "revoked GET-only settlement must not retire an existing DeleteIntent"
        );

        // Verify cleanup_tokens stays bounded to 64 entries even with 70 pending rows.
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        let rows: Vec<Cleanup> = (0..70)
            .map(|i| {
                let mut r = cleanup_row(1, false);
                r.mission_id = format!("msn-{i}");
                r.deletion_id = format!("del-{i}");
                r
            })
            .collect();
        assert!(panel.accept_cleanups_for_test(rows.clone()));
        let mut tokens = Vec::with_capacity(rows.len());
        for row in &rows {
            tokens.push(panel.cleanup_row_live(&row.mission_id, &row.deletion_id));
        }
        assert!(panel.cleanup_token_count() <= 64);
        assert!(
            tokens.iter().filter(|t| !t.is_live()).count() >= 6,
            "evicted cleanup tokens must be revoked"
        );
    });
}

#[test]
fn offline_panel_disables_cleanup_and_orphaned_delete_retry_buttons() {
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
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        assert!(panel.accept_cleanups_for_test(vec![cleanup_row(1, false)]));
        let mut owner = CleanupOwner::default();
        let sc = panel.cleanup_scope().unwrap();
        let mut orphan = source("msn-orphan");
        orphan.workspace = sc.workspace.clone();
        owner.deletes.insert(
            (sc.clone(), orphan.mission.clone()),
            DeleteIntent {
                scope: sc,
                title: "Orphan".into(),
                target: orphan.target.clone(),
                request: DeletionRequest::new(3, false).unwrap(),
                flight: None,
                flight_live: None,
                flight_cancel: None,
                flight_phase: None,
                error: Some("missions.cleanup.error.unconfirmed"),
                document_cleanup: false,
                deletion_id: None,
                created_at_bits: None,
                retired: false,
            },
        );
        panel.set_online(false);

        let mut rt = Runtime::new(
            (panel, owner),
            |(panel, owner), _| {
                crate::strings::with_locale("en", || {
                    rune_theme_codenomad::git_panel::scroll().child(cleanup_view::<(
                        Panel,
                        CleanupOwner,
                    )>(
                        panel,
                        owner,
                        "occ",
                        |_, _, _, _| {},
                        |_, _, _, _, _, _| {},
                    ))
                })
            },
            (420.0, 640.0),
            Env::new(false, 1.0),
        );
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json();
        assert!(has_state(
            &tree,
            "mission-cleanup-retry-old-del-1",
            "disabled"
        ));
        assert!(has_state(
            &tree,
            "mission-delete-retry-msn-orphan",
            "disabled"
        ));
    });
}

#[test]
fn pinned_tombstone_refuses_delete_when_reconciliation_returns_live_mission() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-live-after-tomb");
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Live contradiction".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        first.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec1 = http.accept().await;
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [{
                    "missionID": "msn-live-after-tomb", "deletionID": "del-a", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Live", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 1, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        // Retry reconciliation returns a live Mission at the original revision with no cleanups.
        // Because del-a was already pinned, we must NOT dispatch DELETE against the live Mission.
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake);
        }
        let pre_get = http.accept().await;
        pre_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "mission": {"id": "msn-live-after-tomb", "projectID": "project", "revision": 7},
                    "cleanups": []
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let polled = owner.poll();
        assert!(polled.deleted_missions.is_empty());
        assert!(polled.settled_cleanups.is_empty());
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
        );
    });
}

#[test]
fn ambiguous_cleanup_rows_never_settle_or_authorize_delete() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-amb");
        let sc = src.workspace_scope();
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Ambiguous".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        first.reply(503, json!({})).await;
        let rec1 = http.accept().await;
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "mission": {"id": "msn-amb", "projectID": "project", "revision": 7},
                "cleanups": []
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        let settled_row = json!({
            "missionID": "msn-amb", "deletionID": "del-1", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "Ambiguous", "createdAt": 1, "removed": 1, "retained": 0,
            "pending": 0, "reasons": [], "documentPending": false
        });
        let pending_row = json!({
            "missionID": "msn-amb", "deletionID": "del-2", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "Ambiguous", "createdAt": 2, "removed": 0, "retained": 0,
            "pending": 0, "reasons": [], "documentPending": true
        });
        // Passive retirement with two distinct IDs for the same frozen intent must not settle.
        let r1: Cleanup = serde_json::from_value(settled_row.clone()).unwrap();
        let r2: Cleanup = serde_json::from_value(pending_row.clone()).unwrap();
        owner.retire_settled_cleanups(&sc, &[r1.clone(), r2.clone()], true);
        assert!(owner.delete_state(&src).is_some());
        owner.retire_settled_cleanups(&sc, &[r2, r1], true);
        assert!(owner.delete_state(&src).is_some());

        // Reconciliation with two distinct IDs must stay unconfirmed without dispatching DELETE.
        for pair in [
            vec![settled_row.clone(), pending_row.clone()],
            vec![pending_row, settled_row],
        ] {
            {
                let req = owner.delete_request_id(&src).unwrap_or_default();
                owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake.clone());
            }
            let pre_get = http.accept().await;
            pre_get
                .reply(
                    200,
                    json!({
                        "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                        "cleanups": pair
                    }),
                )
                .await;
            wait(done.recv()).await.unwrap();
            http.quiet().await;
            let polled = owner.poll();
            assert!(polled.deleted_missions.is_empty());
            assert!(polled.settled_cleanups.is_empty());
            assert_eq!(
                owner.delete_state(&src),
                Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
            );
        }
    });
}

#[test]
fn revoked_delete_retry_view_never_publishes_readonly_settlement() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-revoked-del");
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Revoked".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        first.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec1 = http.accept().await;
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [{
                    "missionID": "msn-revoked-del", "deletionID": "del-r", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Revoked", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 1, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        // Hold retry GET, let it return a settled row, then revoke view before poll().
        let live = live_flag();
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live.clone(), http.backend.clone(), wake);
        }
        let pre_get = http.accept().await;
        pre_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [{
                        "missionID": "msn-revoked-del", "deletionID": "del-r", "requestID": request_id,
                        "expectedRevision": 7, "deleteManagedSessions": false,
                        "objective": "Revoked", "createdAt": 1, "removed": 1, "retained": 0,
                        "pending": 0, "reasons": [], "documentPending": false
                    }]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        // Revoke the view after the read-only settlement was already queued.
        live.revoke();
        let polled = owner.poll();
        assert!(polled.deleted_missions.is_empty());
        assert!(polled.settled_cleanups.is_empty());
        assert!(polled.refreshed_scopes.is_empty());
        assert!(
            owner.delete_state(&src).is_some(),
            "revoked read-only delete retry must not retire the intent"
        );
    });
}

#[test]
fn remembered_document_pending_survives_empty_directory_refresh_and_obsolete_retry_does_not_publish()
 {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let mut owner = CleanupOwner::default();

        // 1. Obsolete read-only cleanup retry (view revoked while GET held) must NOT publish documentPending.
        let mut omitted_row = cleanup_row(1, false);
        omitted_row.document_pending = None;
        let view_live = live_flag();
        owner.start_cleanup_retry(
            sc.clone(),
            omitted_row.clone(),
            view_live.clone(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        let held_get = http.accept().await;
        view_live.revoke();
        held_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                    "cleanups": [cleanup_json(1, true)]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let polled = owner.poll();
        assert!(
            polled.document_pending_rows.is_empty(),
            "obsolete read-only cleanup retry must not publish documentPending"
        );

        // 2. Remembered documentPending on Panel survives an empty directory refresh gap.
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        assert!(panel.accept_cleanups_for_test(vec![omitted_row.clone()]));
        panel.mark_cleanup_document_pending(&crate::missions::directory::cleanup_identity(
            &omitted_row,
        ));
        assert_eq!(panel.cleanups[0].document_pending, Some(true));
        // Empty directory gap:
        assert!(panel.accept_cleanups_for_test(vec![]));
        assert!(panel.cleanups.is_empty());
        // Returning row with pending: 0 and omitted documentPending must still be marked pending!
        let mut returned = cleanup_row(0, false);
        returned.document_pending = None;
        assert!(panel.accept_cleanups_for_test(vec![returned]));
        assert_eq!(panel.cleanups[0].document_pending, Some(true));
        assert!(panel.cleanups[0].is_pending());
        // Explicit documentPending: false finally clears it.
        assert!(panel.accept_cleanups_for_test(vec![cleanup_row(0, false)]));
        assert_eq!(panel.cleanups[0].document_pending, Some(false));
        assert!(!panel.cleanups[0].is_pending());
    });
}

#[test]
fn cleanup_delete_receipt_rejects_mismatched_created_at_and_adopt_caps_at_2000() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let mut owner = CleanupOwner::default();
        let row = cleanup_row(1, false);
        owner.start_cleanup_retry(
            sc.clone(),
            row,
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        let pre = http.accept().await;
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [cleanup_json(1, false)]
            }),
        )
        .await;
        let del = http.accept().await;
        let mut mismatched = cleanup_json(0, false);
        mismatched["createdAt"] = json!(2);
        del.reply(200, json!({"deleted": true, "cleanup": mismatched}))
            .await;
        let rec = http.accept().await;
        rec.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [mismatched]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert!(
            polled.settled_cleanups.is_empty(),
            "DELETE receipt with mismatched createdAt must not settle the row"
        );
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );

        // Adopt > 2000 distinct settled receipts and verify Panel::cleanups stays bounded.
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        for i in 0..2_050 {
            let mut r = cleanup_row(0, false);
            r.mission_id = format!("msn-{i}");
            r.deletion_id = format!("del-{i}");
            panel.adopt_settled_cleanup(r);
        }
        assert!(panel.cleanups.len() <= 2_000);
    });
}
