use super::*;

#[test]
fn cleanup_directory_failure_revokes_retry_fence_and_disables_retry() {
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
        assert!(panel.accept_cleanups_for_test(vec![cleanup_row(1, false)]));
        panel.show(true);
        // Accept the initial summaries & cleanups directory reads.
        let r1 = http.accept().await;
        let r2 = http.accept().await;
        let (sum_req, clean_req) = if r1.body["source"] == "cleanups" {
            (r2, r1)
        } else {
            (r1, r2)
        };
        let empty_digest = "XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc";
        sum_req
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "source": "summaries", "projectID": "project",
                    "finishHighWater": 0,
                    "discardedEvents": 0, "controlUnavailable": false,
                    "notificationUnavailable": false, "cleanupUnavailable": false,
                    "window": {"order": empty_digest, "offset": 0, "end": 0, "total": 0},
                    "page": {"digest": empty_digest, "total": 0, "pieces": []}
                }),
            )
            .await;
        let mut lifecycle = crate::missions::Lifecycle::default();
        let sc = panel.cleanup_scope().unwrap();
        panel.retry_cleanup(&mut lifecycle, &sc, cleanup_row(1, false));
        let held_get = http.accept().await;
        assert!(held_get.header.starts_with("GET /api/workspaces/"));

        // Fail the cleanup directory refresh while point GET is held.
        clean_req.reply(503, json!({"available": false})).await;
        for _ in 0..100 {
            if panel.poll() && panel.cleanups_unavailable() {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(panel.cleanups_unavailable());
        assert!(!panel.cleanup_view_live.is_live());

        // Releasing the point GET with a matching pending row must NOT send DELETE.
        held_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [cleanup_json(1, false)]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let _ = lifecycle.poll_all();
        http.quiet().await;

        // Rendered cleanup retry button must be disabled while cleanups_unavailable.
        let mut rt = Runtime::new(
            (panel, lifecycle.cleanup),
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
    });
}

#[test]
fn revoked_delete_retry_never_publishes_readonly_failure() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-revoked-fail");
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Revoked fail".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        first.reply(503, json!({})).await;
        let rec1 = http.accept().await;
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "mission": {"id": "msn-revoked-fail", "projectID": "project", "revision": 7},
                "cleanups": []
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
        );

        // Queue a revision-conflict failure from a retry GET, hide panel before poll().
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
                    "mission": {"id": "msn-revoked-fail", "projectID": "project", "revision": 8},
                    "cleanups": []
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        live.revoke();
        let polled = owner.poll();
        assert!(polled.refreshed_missions.is_empty());
        assert!(polled.refreshed_scopes.is_empty());
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed")),
            "revoked read-only retry failure must not overwrite the previous error"
        );
    });
}

#[test]
fn cleanup_row_retry_rejects_ambiguous_reconciliation_in_preflight_and_409() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let mut owner = CleanupOwner::default();
        let row = cleanup_row(1, false);
        let mut sibling = cleanup_json(0, false);
        sibling["deletionID"] = json!("del-2");

        // 1. Ambiguous preflight GET (two distinct deletionIDs for the same frozen request)
        // must NOT dispatch DELETE.
        owner.start_cleanup_retry(
            sc.clone(),
            row.clone(),
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        let pre1 = http.accept().await;
        pre1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [cleanup_json(1, false), sibling.clone()]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let polled1 = owner.poll();
        assert!(polled1.settled_cleanups.is_empty());
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );

        // 2. Ambiguous post-409 reconciliation must NOT settle the row.
        owner.start_cleanup_retry(
            sc.clone(),
            row,
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
                "cleanups": [cleanup_json(1, false)]
            }),
        )
        .await;
        let del = http.accept().await;
        del.reply(409, json!({"code": "request-conflict"})).await;
        let after = http.accept().await;
        after
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                    "cleanups": [cleanup_json(0, false), sibling]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let polled2 = owner.poll();
        assert!(polled2.settled_cleanups.is_empty());
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.requestConflict")
        );
    });
}

#[test]
fn document_pending_cache_retains_65_rows_across_empty_gap_and_isolates_created_at() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        // Load 65 document-only pending rows.
        let rows: Vec<Cleanup> = (0..65)
            .map(|i| {
                let mut r = cleanup_row(0, true);
                r.mission_id = format!("msn-{i}");
                r.deletion_id = format!("del-{i}");
                r
            })
            .collect();
        assert!(panel.accept_cleanups_for_test(rows.clone()));
        assert_eq!(panel.cleanups.len(), 65);
        // Complete empty refresh gap:
        assert!(panel.accept_cleanups_for_test(vec![]));
        assert!(panel.cleanups.is_empty());
        // Returning a row with a different createdAt and documentPending: false must NOT clear
        // the original createdAt: 1.0 obligation.
        let mut different_lifetime = rows[0].clone();
        different_lifetime.created_at = 2.0;
        different_lifetime.document_pending = Some(false);
        assert!(panel.accept_cleanups_for_test(vec![different_lifetime]));
        assert!(panel.accept_cleanups_for_test(vec![]));
        // Returning all 65 original rows with pending: 0 and documentPending omitted must keep
        // EVERY single one of the 65 rows pending!
        let omitted: Vec<Cleanup> = rows
            .into_iter()
            .map(|mut r| {
                r.document_pending = None;
                r
            })
            .collect();
        assert!(panel.accept_cleanups_for_test(omitted));
        assert_eq!(panel.cleanups.len(), 65);
        assert!(
            panel
                .cleanups
                .iter()
                .all(|row| row.document_pending == Some(true) && row.is_pending()),
            "all 65 document-pending rows must stay pending across an empty gap"
        );
    });
}

#[test]
fn cleanup_pagination_stays_within_2000_row_display_and_seen_cap() {
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
        let mut panel =
            crate::missions::Panel::new(backend, Some("project".into()), Default::default(), wake);
        panel.show(true);
        let empty_digest = "XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc";
        for _ in 0..2 {
            let req = http.accept().await;
            let source = req.body["source"]
                .as_str()
                .unwrap_or("summaries")
                .to_owned();
            let mut page = json!({
                "available": true, "version": 1, "source": source, "projectID": "project",
                "discardedEvents": 0, "controlUnavailable": false,
                "notificationUnavailable": false, "cleanupUnavailable": false,
                "window": {"order": empty_digest, "offset": 0, "end": 0, "total": 0},
                "page": {"digest": empty_digest, "total": 0, "pieces": []}
            });
            if source == "summaries" {
                page["finishHighWater"] = json!(0);
            }
            req.reply(200, page).await;
        }
        for _ in 0..50 {
            panel.poll();
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }

        // Serve 2,001 pending rows with a document-only cleanup last. After loading 2,000,
        // continuation must stay available, the 2,001st row must become reachable and retryable,
        // and resident display + seen stay capped at 2,000.
        let total = 2_001u64;
        for page in 0..40u64 {
            let offset = page * 50;
            let rows: Vec<Cleanup> = (0..50)
                .map(|i| {
                    let idx = offset + i;
                    let mut r = cleanup_row(1, false);
                    r.mission_id = format!("msn-{idx}");
                    r.deletion_id = format!("del-{idx}");
                    r
                })
                .collect();
            assert!(
                panel.accept_more_cleanups_for_test("stable-order", offset, total, rows),
                "page {page} should be accepted"
            );
        }
        assert_eq!(panel.cleanups.len(), 2_000);
        assert_eq!(panel.cleanup_seen_count(), 2_000);
        assert!(
            panel.has_more(crate::missions::directory::Kind::Cleanups),
            "Load more must remain available at row 2,000 when row 2,001 exists"
        );
        let mut last_doc = cleanup_row(0, true);
        last_doc.mission_id = "msn-2000".into();
        last_doc.deletion_id = "del-2000".into();
        assert!(panel.accept_more_cleanups_for_test(
            "stable-order",
            2_000,
            total,
            vec![last_doc.clone()]
        ));
        let (disp_len, seen_len, meta_len, pending_len) = panel.cleanup_index_counts();
        assert_eq!(disp_len, 2_000);
        assert_eq!(seen_len, 2_000);
        assert!(meta_len <= 2_000);
        assert!(pending_len <= 2_000);
        assert!(!panel.has_more(crate::missions::directory::Kind::Cleanups));
        assert!(
            panel.cleanups.iter().any(|r| r.deletion_id == "del-2000"),
            "the 2,001st pending cleanup must be reachable in the sliding resident window"
        );
        // Adopting a separate settled receipt while at the 2,000 cap must display the new receipt
        // at index 0 without growing past 2,000 or evicting the newly loaded row.
        let mut separate_settled = cleanup_row(0, false);
        separate_settled.mission_id = "msn-separate".into();
        separate_settled.deletion_id = "del-separate".into();
        panel.adopt_settled_cleanup(separate_settled);
        assert_eq!(
            panel.cleanups[0].deletion_id, "del-separate",
            "newly adopted settled receipt must not evict itself at the 2,000 cap"
        );
        assert_eq!(panel.cleanups.len(), 2_000);
        assert!(panel.cleanups.iter().any(|r| r.deletion_id == "del-2000"));

        let mut lifecycle = crate::missions::Lifecycle::default();
        let sc = panel.cleanup_scope().unwrap();
        while done.try_recv().is_ok() {}
        panel.retry_cleanup(&mut lifecycle, &sc, last_doc);
        let pre = http.accept().await;
        assert!(pre.header.contains("/missions/msn-2000"));
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [{
                    "missionID": "msn-2000", "deletionID": "del-2000", "requestID": "req-1",
                    "expectedRevision": 3, "deleteManagedSessions": false,
                    "objective": "Old", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 0, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let settled = lifecycle.poll_after_deletes();
        assert_eq!(settled.cleanup.settled_cleanups.len(), 1);
        assert_eq!(
            settled.cleanup.settled_cleanups[0].1.deletion_id,
            "del-2000"
        );
        // First row (del-0) was evicted when the 2,000-row sliding window advanced to del-2000.
        // A passive refresh with unchanged order/total must NOT rewind the pagination cursor,
        // while an explicit manual refresh navigates back to page 0 and makes del-0 retryable again.
        assert!(!panel.cleanups.iter().any(|r| r.deletion_id == "del-0"));
        let mut row0 = cleanup_row(1, false);
        row0.mission_id = "msn-0".into();
        row0.deletion_id = "del-0".into();
        assert!(panel.accept_more_cleanups_for_test("stable-order", 0, total, vec![row0.clone()]));
        assert!(
            !panel.cleanups.iter().any(|r| r.deletion_id == "del-0"),
            "passive unchanged-order refresh must not rewind past-cap cleanup pagination"
        );
        assert!(panel.accept_manual_refresh_cleanups_for_test("stable-order", total, vec![row0]));
        assert_eq!(panel.cleanups.len(), 2_000);
        let first_row = panel
            .cleanups
            .iter()
            .find(|r| r.deletion_id == "del-0")
            .unwrap()
            .clone();
        while done.try_recv().is_ok() {}
        panel.retry_cleanup(&mut lifecycle, &sc, first_row);
        let pre_first = http.accept().await;
        assert!(pre_first.header.contains("/missions/msn-0"));
        pre_first
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [{
                        "missionID": "msn-0", "deletionID": "del-0", "requestID": "req-1",
                        "expectedRevision": 3, "deleteManagedSessions": false,
                        "objective": "Old", "createdAt": 1, "removed": 1, "retained": 0,
                        "pending": 0, "reasons": [], "documentPending": false
                    }]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let settled_first = lifecycle.poll_after_deletes();
        assert_eq!(settled_first.cleanup.settled_cleanups.len(), 1);
        assert_eq!(
            settled_first.cleanup.settled_cleanups[0].1.deletion_id,
            "del-0"
        );
    });
}

#[test]
fn cleanup_retry_rejects_settlement_when_document_pending_learned_during_preflight() {
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
        let mut panel =
            crate::missions::Panel::new(backend, Some("project".into()), Default::default(), wake);
        panel.show(true);
        let empty_digest = "XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc";
        for _ in 0..2 {
            let req = http.accept().await;
            let source = req.body["source"]
                .as_str()
                .unwrap_or("summaries")
                .to_owned();
            let mut page = json!({
                "available": true, "version": 1, "source": source, "projectID": "project",
                "discardedEvents": 0, "controlUnavailable": false,
                "notificationUnavailable": false, "cleanupUnavailable": false,
                "window": {"order": empty_digest, "offset": 0, "end": 0, "total": 0},
                "page": {"digest": empty_digest, "total": 0, "pieces": []}
            });
            if source == "summaries" {
                page["finishHighWater"] = json!(0);
            }
            req.reply(200, page).await;
        }
        for _ in 0..50 {
            panel.poll();
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }

        let mut initial: Cleanup = serde_json::from_value(json!({
            "missionID": "old", "deletionID": "del-1", "requestID": "req-1",
            "expectedRevision": 1, "deleteManagedSessions": false,
            "objective": "Old", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 1, "reasons": []
        }))
        .unwrap();
        assert_eq!(initial.document_pending, None);
        assert!(panel.accept_cleanups_for_test(vec![initial.clone()]));

        let mut lifecycle = crate::missions::Lifecycle::default();
        let sc = panel.cleanup_scope().unwrap();
        panel.retry_cleanup(&mut lifecycle, &sc, initial.clone());
        let held_get = http.accept().await;
        assert!(held_get.header.starts_with("GET /api/workspaces/"));

        // While preflight GET is held, the directory learns documentPending: true for the same row.
        let retry_row_token = panel.cleanup_row_live("old", "del-1");
        let retry_view_token = panel.cleanup_view_live.clone();
        initial.document_pending = Some(true);
        assert!(panel.accept_cleanups_for_test(vec![initial]));
        panel.observe_cleanups(&mut lifecycle);
        assert!(
            !retry_row_token.is_live(),
            "learning documentPending: true must revoke that row's stale retry token"
        );
        assert!(
            retry_view_token.is_live(),
            "learning documentPending: true on one row must not cancel unrelated cleanup retries"
        );
        assert!(
            !lifecycle.cleanup.cleanup_busy(&sc),
            "revoked preflight must immediately stop reporting busy"
        );

        // Preflight GET now replies with pending: 0 and omitted documentPending.
        held_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [{
                        "missionID": "old", "deletionID": "del-1", "requestID": "req-1",
                        "expectedRevision": 1, "deleteManagedSessions": false,
                        "objective": "Old", "createdAt": 1, "removed": 1, "retained": 0,
                        "pending": 0, "reasons": []
                    }]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let settled = lifecycle.poll_after_deletes();
        assert!(
            settled.cleanup.settled_cleanups.is_empty(),
            "retry must not publish settlement without explicit documentPending: false"
        );
        assert!(settled.cleanup.deleted_missions.is_empty());
    });
}

#[test]
fn stale_cleanup_directory_refresh_does_not_revert_adopted_settled_receipt() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        let pending_doc = cleanup_row(0, true);
        let settled_doc = cleanup_row(0, false);
        assert!(panel.accept_cleanups_for_test(vec![pending_doc.clone()]));
        assert!(panel.cleanups[0].is_pending());

        // Adopt exact settled receipt (e.g. from GET -> DELETE 409 -> GET).
        panel.adopt_settled_cleanup(settled_doc);
        assert!(!panel.cleanups[0].is_pending());

        // A lagging cleanup directory refresh returns the old documentPending: true row.
        assert!(panel.accept_cleanups_for_test(vec![pending_doc]));
        assert_eq!(panel.cleanups.len(), 1);
        assert!(
            !panel.cleanups[0].is_pending(),
            "stale directory refresh must not revert an adopted settled receipt back to pending"
        );
        assert_eq!(panel.cleanups[0].document_pending, Some(false));
    });
}

#[test]
fn remember_document_pending_is_linear_per_page_at_2000_rows() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        for page in 0..40u64 {
            let offset = page * 50;
            let rows: Vec<Cleanup> = (0..50)
                .map(|i| {
                    let idx = offset + i;
                    let mut r = cleanup_row(0, true);
                    r.mission_id = format!("old-m-{idx}");
                    r.deletion_id = format!("old-d-{idx}");
                    r
                })
                .collect();
            assert!(panel.accept_more_cleanups_for_test("order-1", offset, 2_000, rows));
        }
        assert_eq!(panel.cleanups.len(), 2_000);
        panel.doc_cache_lookups = 0;

        // Prepend 50 brand-new document-pending rows on a new order.
        let new_rows: Vec<Cleanup> = (0..50)
            .map(|i| {
                let mut r = cleanup_row(0, true);
                r.mission_id = format!("new-m-{i}");
                r.deletion_id = format!("new-d-{i}");
                r
            })
            .collect();
        assert!(panel.accept_more_cleanups_for_test("order-2", 0, 2_000, new_rows));
        assert!(
            panel.doc_cache_lookups <= 5_000,
            "document-pending cache maintenance must be O(N) per page, got {} lookups",
            panel.doc_cache_lookups
        );
    });
}

#[test]
fn document_pending_observed_during_delete_flight_blocks_bare_retry_settlement() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-doc-flight");
        let sc = src.workspace_scope();
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Doc flight".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let first_del = http.accept().await;
        let request_id = first_del.body["requestId"].as_str().unwrap().to_owned();

        // While the first DELETE is in flight, the directory observes its exact documentPending row
        // and then refreshes to an empty directory before the flight completes.
        let doc_row: Cleanup = serde_json::from_value(json!({
            "missionID": "msn-doc-flight", "deletionID": "del-doc-flight",
            "requestID": request_id, "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "Doc flight", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 0, "reasons": [], "documentPending": true
        }))
        .unwrap();
        owner.retire_settled_cleanups(&sc, &[doc_row], true);
        owner.retire_settled_cleanups(&sc, &[], true);

        // First DELETE fails with 503 and an empty reconciliation.
        first_del.reply(503, json!({})).await;
        let rec1 = http.accept().await;
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": []
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let _ = owner.poll();
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
        );

        // Retry against an empty preflight and a bare {deleted: true}: frozen intent must stay.
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake);
        }
        let pre = http.accept().await;
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": []
            }),
        )
        .await;
        let replay = http.accept().await;
        replay.reply(200, json!({"deleted": true})).await;
        let post = http.accept().await;
        post.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                "cleanups": []
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert!(polled.deleted_missions.is_empty());
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed")),
            "frozen intent must survive bare 200 after documentPending was observed during flight"
        );
    });
}
