use super::*;

#[test]
fn pinned_deletion_id_does_not_hide_ambiguous_wire_matches() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-pin-amb");
        let sc = src.workspace_scope();
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Pin amb".into(),
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
        let row_a_pending = json!({
            "missionID": "msn-pin-amb", "deletionID": "del-a", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "A", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 1, "reasons": [], "documentPending": false
        });
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [row_a_pending]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        // Passive retirement with settled A + conflicting B (same wire intent, different deletionID)
        // must NOT retire the frozen intent.
        let mut row_a_settled = row_a_pending.clone();
        row_a_settled["pending"] = json!(0);
        row_a_settled["removed"] = json!(1);
        let row_b = json!({
            "missionID": "msn-pin-amb", "deletionID": "del-b", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "B", "createdAt": 2, "removed": 0, "retained": 0,
            "pending": 1, "reasons": [], "documentPending": false
        });
        let a_cleanup: Cleanup = serde_json::from_value(row_a_settled.clone()).unwrap();
        let b_cleanup: Cleanup = serde_json::from_value(row_b.clone()).unwrap();
        owner.retire_settled_cleanups(&sc, &[a_cleanup, b_cleanup], true);
        assert!(
            owner.delete_state(&src).is_some(),
            "passive retirement must reject ambiguous wire matches even when pinned A is settled"
        );

        // Retry preflight returning settled A + conflicting B must neither DELETE nor retire.
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake);
        }
        let pre = http.accept().await;
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [row_a_settled, row_b]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let polled = owner.poll();
        assert!(polled.deleted_missions.is_empty());
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
        );
    });
}

#[test]
fn adopted_off_page_receipt_preserves_pagination_prefix_and_deduplicates() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        let make_row = |idx: u64| {
            let mut r = cleanup_row(0, false);
            r.mission_id = format!("msn-{idx}");
            r.deletion_id = format!("del-{idx}");
            r
        };
        assert!(panel.accept_more_cleanups_for_test(
            "order-1",
            0,
            110,
            (0..50).map(make_row).collect()
        ));
        assert!(panel.accept_more_cleanups_for_test(
            "order-1",
            50,
            110,
            (50..100).map(make_row).collect()
        ));
        // Adopt off-page receipt for row 105, then deliver same-order refresh (0..50) and page 100..110.
        panel.adopt_settled_cleanup(make_row(105));
        assert!(panel.accept_more_cleanups_for_test(
            "order-1",
            0,
            110,
            (0..50).map(make_row).collect()
        ));
        assert!(panel.accept_more_cleanups_for_test(
            "order-1",
            100,
            110,
            (100..110).map(make_row).collect()
        ));
        assert_eq!(panel.cleanups.len(), 110);
        let unique: std::collections::HashSet<&str> = panel
            .cleanups
            .iter()
            .map(|r| r.deletion_id.as_str())
            .collect();
        assert_eq!(unique.len(), 110, "all 110 rows must appear exactly once");
        for idx in 0..110 {
            assert!(
                unique.contains(format!("del-{idx}").as_str()),
                "row {idx} must not be lost"
            );
        }
    });
}

#[test]
fn revoked_post_409_get_settlement_neither_publishes_nor_retires_delete_intent() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("old");
        let sc = src.workspace_scope();
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "Old".into(),
            1,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        first.reply(503, json!({})).await;
        let rec1 = http.accept().await;
        let pending_json = json!({
            "missionID": "old", "deletionID": "del-1", "requestID": request_id,
            "expectedRevision": 1, "deleteManagedSessions": false,
            "objective": "Old", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 1, "reasons": [], "documentPending": false
        });
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [pending_json.clone()]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert!(owner.delete_state(&src).is_some());

        // Start a cleanup row retry for the matching row; 409 DELETE followed by settled GET.
        let row: Cleanup = serde_json::from_value(pending_json.clone()).unwrap();
        let view = live_flag();
        owner.start_cleanup_retry(
            sc.clone(),
            row,
            view.clone(),
            live_flag(),
            http.backend.clone(),
            wake,
        );
        let pre = http.accept().await;
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [pending_json.clone()]
            }),
        )
        .await;
        let del = http.accept().await;
        del.reply(409, json!({"code": "request-conflict"})).await;
        let post = http.accept().await;
        let mut settled_json = pending_json;
        settled_json["pending"] = json!(0);
        settled_json["removed"] = json!(1);
        post.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                "cleanups": [settled_json]
            }),
        )
        .await;
        // Wait for the settled post-409 result to queue, then revoke the view BEFORE polling.
        wait(done.recv()).await.unwrap();
        view.revoke();
        let polled = owner.poll_retries();
        assert!(!owner.cleanup_busy(&sc));
        assert!(polled.settled_cleanups.is_empty());
        assert!(polled.refreshed_scopes.is_empty());
        assert!(
            owner.delete_state(&src).is_some(),
            "revoked post-409 GET must not retire the frozen delete intent"
        );
    });
}

#[test]
fn cleanup_pagination_continues_after_order_change_refresh_at_2000_cap() {
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
            let mut r = cleanup_row(0, false);
            r.mission_id = format!("{prefix}-m-{idx}");
            r.deletion_id = format!("{prefix}-d-{idx}");
            r
        };
        for page in 0..40u64 {
            let offset = page * 50;
            assert!(panel.accept_more_cleanups_for_test(
                "order-old",
                offset,
                2_000,
                (0..50).map(|i| make_row("old", offset + i)).collect()
            ));
        }
        assert_eq!(panel.cleanups.len(), 2_000);

        // Repeated order changes with brand-new first-page rows must keep display capped at 2,000.
        for round in 0..5u64 {
            let mut page1: Vec<Cleanup> = (0..10)
                .map(|j| make_row(&format!("new-{round}"), j))
                .collect();
            page1.extend((0..40).map(|i| make_row("old", i)));
            assert!(panel.accept_more_cleanups_for_test(
                &format!("order-new-{round}"),
                0,
                2_000,
                page1
            ));
            assert_eq!(panel.cleanups.len(), 2_000);
            assert_eq!(panel.cleanup_seen_count(), 50);
            assert!(
                panel.has_more(crate::missions::directory::Kind::Cleanups),
                "Load more must stay available for the new order"
            );
        }
        // Page 2 (offset 50) of the latest order must be accepted while staying <= 2,000.
        let page2: Vec<Cleanup> = (40..90).map(|i| make_row("old", i)).collect();
        assert!(panel.accept_more_cleanups_for_test("order-new-4", 50, 2_000, page2));
        assert_eq!(panel.cleanups.len(), 2_000);
        assert_eq!(panel.cleanup_seen_count(), 100);
    });
}

#[test]
fn remembered_document_pending_overflow_never_marks_journal_only_receipt_pending() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        // Feed > 2000 distinct documentPending: true rows across refreshes to fill the cache.
        for batch in 0..42u64 {
            let rows: Vec<Cleanup> = (0..50)
                .map(|i| {
                    let idx = batch * 50 + i;
                    let mut r = cleanup_row(0, true);
                    r.mission_id = format!("doc-m-{idx}");
                    r.deletion_id = format!("doc-d-{idx}");
                    r
                })
                .collect();
            assert!(panel.accept_cleanups_for_test(rows));
        }
        // Now return an unrelated journal-only receipt with pending: 0 and omitted documentPending.
        let mut journal_only: Cleanup = serde_json::from_value(json!({
            "missionID": "journal-only", "deletionID": "del-journal-only", "requestID": "req-j",
            "expectedRevision": 1, "deleteManagedSessions": false,
            "objective": "Journal only", "createdAt": 99, "removed": 1, "retained": 0,
            "pending": 0, "reasons": []
        }))
        .unwrap();
        assert_eq!(journal_only.document_pending, None);
        assert!(panel.accept_cleanups_for_test(vec![journal_only.clone()]));
        assert_eq!(panel.cleanups.len(), 1);
        assert_eq!(
            panel.cleanups[0].document_pending, None,
            "unrelated journal-only receipt must never gain a synthetic documentPending warning"
        );
        assert!(!panel.cleanups[0].is_pending());
        // Adopting an unrelated journal-only receipt must also keep document_pending: None.
        journal_only.deletion_id = "del-journal-only-2".into();
        panel.adopt_settled_cleanup(journal_only);
        assert_eq!(panel.cleanups[0].document_pending, None);
        assert!(!panel.cleanups[0].is_pending());
    });
}

#[test]
fn revoked_direct_delete_post_delete_reconciliation_aborts_without_publishing_settled_receipt() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-post-del-cancel");
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src,
            "PostDel".into(),
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
        let pending_json = json!({
            "missionID": "msn-post-del-cancel", "deletionID": "del-1", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "PostDel", "createdAt": 1, "removed": 0, "retained": 0,
            "pending": 1, "reasons": [], "documentPending": false
        });
        rec1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [pending_json.clone()]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert!(owner.delete_state(&src).is_some());

        // Retry delete: preflight GET succeeds, DELETE returns 409, post-DELETE GET starts.
        let view = live_flag();
        owner.retry_delete(&src, &request_id, view.clone(), http.backend.clone(), wake);
        let pre = http.accept().await;
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [pending_json]
            }),
        )
        .await;
        let del = http.accept().await;
        assert!(del.header.starts_with("DELETE /api/workspaces/"));
        del.reply(409, json!({"code": "request-conflict"})).await;
        let _post_get = http.accept().await;

        // Hide the view while the post-DELETE reconciliation GET is hung: cancel aborts it
        // immediately without waiting for the hung socket, and publishes no settled receipt.
        view.revoke();
        wait(done.recv()).await.unwrap();
        let polled = owner.poll_deletes();
        assert!(
            polled.settled_cleanups.is_empty(),
            "revoked post-DELETE reconciliation must not publish a settled receipt"
        );
        assert!(
            !matches!(owner.delete_state(&src), Some(DeleteState::Busy)),
            "revoked post-DELETE reconciliation must release the busy flight immediately"
        );
    });
}

#[test]
fn partial_cleanup_refresh_preserves_loaded_pending_rows_beyond_cap_and_reauth_carries_rows() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        let make_row = |prefix: &str, idx: u64, pending: u64| {
            let mut r = cleanup_row(pending, false);
            r.mission_id = format!("{prefix}-m-{idx}");
            r.deletion_id = format!("{prefix}-d-{idx}");
            r
        };
        // Load 2,000 rows where the very last row (index 1,999) is PENDING.
        for page in 0..40u64 {
            let offset = page * 50;
            let rows = (0..50)
                .map(|i| {
                    let idx = offset + i;
                    make_row("old", idx, u64::from(idx == 1_999))
                })
                .collect();
            assert!(panel.accept_more_cleanups_for_test("order-old", offset, 2_000, rows));
        }
        assert_eq!(panel.cleanups.len(), 2_000);
        // Partial refresh in a new order with 50 brand-new settled rows must NOT drop pending 1,999.
        let new_page: Vec<Cleanup> = (0..50).map(|i| make_row("new", i, 0)).collect();
        assert!(panel.accept_more_cleanups_for_test("order-new", 0, 2_050, new_page));
        assert_eq!(panel.cleanups.len(), 2_000);
        assert!(
            panel
                .cleanups
                .iter()
                .any(|row| row.deletion_id == "old-d-1999" && row.is_pending()),
            "partial refresh in a new order must never drop already-loaded pending cleanup rows"
        );

        // Same-workspace reauth carries last known summaries and cleanups into the fresh Panel.
        panel.summaries.push(codenomad_client::missions::Summary {
            id: "msn-keep".into(),
            title: Some("Keep".into()),
            objective: "Keep".into(),
            status: codenomad_client::missions::Status::Active,
            run_state: None,
            coordinator_session_id: "ses_coord".into(),
            actor_count: 1,
            updated_at: 1.0,
            revision: 3,
            finish_sequence: None,
            task_count: None,
        });
        let mut reauthed = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        reauthed.carry_same_workspace_from(&panel);
        assert_eq!(reauthed.summaries.len(), 1);
        assert_eq!(reauthed.summaries[0].id, "msn-keep");
        assert_eq!(reauthed.cleanups.len(), 2_000);
        assert!(reauthed.has_pending_cleanups());
    });
}

#[test]
fn cleanup_retry_blocks_settlement_after_direct_delete_learned_document_pending() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-doc-cross");
        let sc = src.workspace_scope();
        let mut owner = CleanupOwner::default();

        // Direct delete fails with 503; reconciliation learns documentPending: true.
        owner.start_delete(
            &src,
            "Cross".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let del_req = http.accept().await;
        let request_id = del_req.body["requestId"].as_str().unwrap().to_owned();
        del_req.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec_req = http.accept().await;
        rec_req
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                    "cleanups": [{
                        "missionID": "msn-doc-cross", "deletionID": "del-cross", "requestID": request_id,
                        "expectedRevision": 7, "deleteManagedSessions": false,
                        "objective": "Cross", "createdAt": 10, "removed": 0, "retained": 0,
                        "pending": 1, "reasons": [], "documentPending": true
                    }]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll_deletes();
        assert!(!polled.document_pending_rows.is_empty());

        // Lagging directory publishes the matching row WITHOUT documentPending.
        let lagging_row: Cleanup = serde_json::from_value(json!({
            "missionID": "msn-doc-cross", "deletionID": "del-cross", "requestID": request_id,
            "expectedRevision": 7, "deleteManagedSessions": false,
            "objective": "Cross", "createdAt": 10, "removed": 0, "retained": 0,
            "pending": 1, "reasons": []
        }))
        .unwrap();
        assert_eq!(lagging_row.document_pending, None);

        // Retry Cleanup receives a preflight GET with pending: 0 and omitted documentPending.
        // Because direct delete already learned documentPending: true, Retry must NOT settle.
        owner.start_cleanup_retry(
            sc.clone(),
            lagging_row,
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake,
        );
        let pre = http.accept().await;
        pre.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [{
                    "missionID": "msn-doc-cross", "deletionID": "del-cross", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Cross", "createdAt": 10, "removed": 1, "retained": 0,
                    "pending": 0, "reasons": []
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let retry_polled = owner.poll_retries();
        assert!(
            retry_polled.settled_cleanups.is_empty(),
            "cleanup retry must not publish settlement without explicit documentPending: false after direct delete learned true"
        );
        assert!(owner.delete_state(&src).is_some());
    });
}

#[test]
fn stale_retry_and_cancel_callbacks_cannot_act_on_a_replacement_delete_intent() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-stale-cb");
        let mut owner = CleanupOwner::default();

        // Intent A (deleteManagedSessions: false) fails and is cancelled.
        owner.start_delete(
            &src,
            "Intent A".into(),
            7,
            false,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let del_a = http.accept().await;
        let req_a = del_a.body["requestId"].as_str().unwrap().to_owned();
        del_a.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec_a = http.accept().await;
        rec_a.reply(503, json!({})).await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(
            owner.delete_request_id(&src).as_deref(),
            Some(req_a.as_str())
        );
        owner.cancel_delete(&src, &req_a);
        assert_eq!(owner.delete_state(&src), None);

        // Intent B (deleteManagedSessions: true) for the same mission becomes unconfirmed.
        owner.start_delete(
            &src,
            "Intent B".into(),
            7,
            true,
            LiveFlag::new(true),
            http.backend.clone(),
            wake.clone(),
        );
        let del_b = http.accept().await;
        let req_b = del_b.body["requestId"].as_str().unwrap().to_owned();
        assert_ne!(req_a, req_b);
        del_b.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec_b = http.accept().await;
        rec_b.reply(503, json!({})).await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        // Stale Retry and Cancel callbacks carrying Intent A's request_id must be ignored.
        owner.retry_delete(
            &src,
            &req_a,
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        owner.retry_delete_in_scope(
            &src.workspace_scope(),
            &src.mission,
            &req_a,
            live_flag(),
            http.backend.clone(),
            wake,
        );
        owner.cancel_delete(&src, &req_a);
        owner.cancel_delete_in_scope(&src.workspace_scope(), &src.mission, &req_a);
        http.quiet().await;
        assert_eq!(
            owner.delete_request_id(&src).as_deref(),
            Some(req_b.as_str()),
            "intent B must remain intact and un-replayed against stale intent A callbacks"
        );
    });
}

#[test]
fn hiding_view_during_hung_cleanup_preflight_frees_workspace_retry_slot_immediately() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let sc = scope();
        let mut owner = CleanupOwner::default();
        let row1 = cleanup_row(1, false);
        let mut row2 = cleanup_row(1, false);
        row2.mission_id = "other".into();
        row2.deletion_id = "del-2".into();

        // Start retry on row 1 and keep its preflight GET stalled (never replied to).
        let view1 = live_flag();
        owner.start_cleanup_retry(
            sc.clone(),
            row1,
            view1.clone(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        let _hung_get = http.accept().await;
        assert!(owner.cleanup_busy(&sc));

        // Hide the pane -> revoking view1 must immediately free the workspace retry slot.
        view1.revoke();
        assert!(
            !owner.cleanup_busy(&sc),
            "revoked preflight must immediately stop reporting the workspace retry slot as busy"
        );

        // Reopen and retry row 2 immediately while row 1's server socket is still stalled.
        owner.start_cleanup_retry(
            sc.clone(),
            row2,
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake,
        );
        let row2_get = http.accept().await;
        assert!(
            row2_get.header.contains("/missions/other "),
            "second cleanup retry must dispatch immediately without waiting for hung preflight"
        );
        row2_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [{
                        "missionID": "other", "deletionID": "del-2", "requestID": "req-1",
                        "expectedRevision": 3, "deleteManagedSessions": false,
                        "objective": "Other", "createdAt": 1, "removed": 1, "retained": 0,
                        "pending": 0, "reasons": [], "documentPending": false
                    }]
                }),
            )
            .await;
    });
}
