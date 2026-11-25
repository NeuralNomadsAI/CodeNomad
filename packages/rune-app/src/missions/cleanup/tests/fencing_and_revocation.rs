use super::*;

#[test]
fn sse_loss_and_view_revocation_abort_retry_before_and_after_delete() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let mut panel = Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        panel.view_live = live_flag();
        panel.selection_live = live_flag();

        // 1. SSE loss during reconciliation GET aborts before sending DELETE.
        let src = source("msn-sse");
        let mut owner = CleanupOwner::default();
        owner.deletes.insert(
            (src.workspace_scope(), src.mission.clone()),
            DeleteIntent {
                scope: src.workspace_scope(),
                title: "SSE".into(),
                target: src.target.clone(),
                request: DeletionRequest::new(7, false).unwrap(),
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
        let req = owner.delete_request_id(&src).unwrap_or_default();
        owner.retry_delete(
            &src,
            &req,
            panel.selection_live.clone(),
            http.backend.clone(),
            wake.clone(),
        );
        let held_get = http.accept().await;
        assert!(held_get.header.starts_with("GET /api/workspaces/"));
        panel.set_online(false);
        held_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                    "mission": {"id": "msn-sse", "projectID": "project", "revision": 7},
                    "cleanups": []
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        http.quiet().await;

        // 2. View revocation while cleanup DELETE is in flight skips post-409 GET and error.
        let sc = scope();
        let row = cleanup_row(0, true);
        let view_live = live_flag();
        let row_live = live_flag();
        owner.start_cleanup_retry(
            sc.clone(),
            row,
            view_live.clone(),
            row_live,
            http.backend.clone(),
            wake,
        );
        let pre_get = http.accept().await;
        pre_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [cleanup_json(0, true)]
                }),
            )
            .await;
        let held_del = http.accept().await;
        assert!(held_del.header.starts_with("DELETE /api/workspaces/"));
        view_live.revoke();
        held_del
            .reply(409, json!({"code": "request-conflict"}))
            .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        http.quiet().await;
        assert_eq!(owner.cleanup_error(&sc), None);
        assert!(!owner.cleanup_busy(&sc));
    });
}

#[test]
fn document_cleanup_rejects_omitted_document_pending_in_get_and_delete() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let row = cleanup_row(0, true);
        let mut owner = CleanupOwner::default();

        // Case 1: reconciliation GET returns pending:0 with omitted documentPending -> unconfirmed.
        let mut omitted = cleanup_json(0, false);
        omitted.as_object_mut().unwrap().remove("documentPending");
        owner.start_cleanup_retry(
            sc.clone(),
            row.clone(),
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        let get1 = http.accept().await;
        get1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [omitted]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );
        http.quiet().await;

        // Case 2: DELETE returns deleted:true with cleanup missing documentPending -> unconfirmed.
        owner.start_cleanup_retry(
            sc.clone(),
            row,
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake,
        );
        let get2 = http.accept().await;
        get2.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [cleanup_json(0, true)]
            }),
        )
        .await;
        let del = http.accept().await;
        del.reply(200, json!({"deleted": true, "cleanup": omitted}))
            .await;
        let rec = http.accept().await;
        rec.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                "cleanups": [omitted]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );
    });
}

#[test]
fn confirmed_delete_and_settled_cleanup_update_paginated_panel_immediately() {
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

        let (wake, _) = witness();
        let mut panel = Panel::new(
            backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        let sc = panel.cleanup_scope().unwrap();
        panel.summaries = (0..52)
            .map(|i| codenomad_client::missions::Summary {
                id: format!("msn-{i}"),
                title: Some(format!("Mission {i}")),
                objective: format!("Mission {i}"),
                status: codenomad_client::missions::Status::Active,
                run_state: None,
                coordinator_session_id: "ses_c".into(),
                actor_count: 1,
                updated_at: 1.0,
                revision: 7,
                finish_sequence: None,
                task_count: None,
            })
            .collect();
        panel.select("msn-0");
        assert_eq!(panel.selected.as_deref(), Some("msn-0"));

        // Confirmed deletion immediately removes msn-0 and clears selection without loading page 2.
        panel.forget_deleted_mission("msn-0");
        assert!(panel.selected.is_none());
        assert!(!panel.summaries.iter().any(|row| row.id == "msn-0"));

        // Confirmed cleanup immediately adopts authoritative receipt (counts + reasons),
        // cancels any in-flight cleanups read, and blocks stale callbacks.
        let mut row = cleanup_row(1, true);
        row.mission_id = "old".into();
        row.retained = 0;
        row.reasons.clear();
        panel.cleanups = vec![row.clone()];
        let mut settled = cleanup_row(0, false);
        settled.mission_id = "old".into();
        settled.retained = 1;
        settled.reasons = vec!["children".into()];
        panel.adopt_settled_cleanup(settled);
        assert!(!panel.cleanups[0].is_pending());
        assert_eq!(panel.cleanups[0].retained, 1);
        assert_eq!(panel.cleanups[0].reasons, vec!["children".to_string()]);
        let mut lifecycle = crate::missions::Lifecycle::default();
        panel.retry_cleanup(&mut lifecycle, &sc, row);
        assert!(!lifecycle.cleanup.cleanup_busy(&sc));
        http.quiet().await;
    });
}

#[test]
fn delete_intent_persists_document_cleanup_requirement_across_retries() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-doc");
        let mut owner = CleanupOwner::default();

        owner.start_delete(
            &src,
            "Doc".into(),
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
                    "missionID": "msn-doc", "deletionID": "del-doc", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Doc", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 0, "reasons": [], "documentPending": true
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.documentPending"))
        );

        // Retry gets a row with pending:0 but omitted documentPending -> must stay unconfirmed.
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake);
        }
        let rec2 = http.accept().await;
        rec2.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [{
                    "missionID": "msn-doc", "deletionID": "del-doc", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Doc", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 0, "reasons": []
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.unconfirmed"))
        );
        http.quiet().await;
    });
}

#[test]
fn revoking_view_during_post_409_get_releases_busy_without_settling_or_refreshing() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let row = cleanup_row(0, true);
        let view_live = live_flag();
        let mut owner = CleanupOwner::default();
        owner.start_cleanup_retry(
            sc.clone(),
            row,
            view_live.clone(),
            live_flag(),
            http.backend.clone(),
            wake,
        );
        let pre_get = http.accept().await;
        pre_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                    "cleanups": [cleanup_json(0, true)]
                }),
            )
            .await;
        let del = http.accept().await;
        del.reply(409, json!({"code": "request-conflict"})).await;
        let post_get = http.accept().await;
        assert!(post_get.header.starts_with("GET /api/workspaces/"));
        // Revoke the view while post-409 GET is held, then return a settled row.
        view_live.revoke();
        post_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [cleanup_json(0, false)]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert!(!owner.cleanup_busy(&sc));
        assert_eq!(owner.cleanup_error(&sc), None);
        assert!(
            polled.settled_cleanups.is_empty(),
            "revoked view must not publish settled receipt directly into a replacement view"
        );
        assert!(
            polled.refreshed_scopes.is_empty(),
            "refused 409 DELETE with a revoked view must not schedule a refresh"
        );
    });
}

#[test]
fn cleanup_retry_fences_selection_change_and_pending_row_set_change() {
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
            backend,
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        panel.show(true);
        let empty_digest = "XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc";
        for _ in 0..2 {
            let req = http.accept().await;
            assert!(req.header.starts_with("POST /api/workspaces/"));
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
            if !panel.busy(crate::missions::directory::Kind::Summaries)
                && !panel.busy(crate::missions::directory::Kind::Cleanups)
            {
                break;
            }
            crate::platform::sleep(std::time::Duration::from_millis(5)).await;
        }
        while done.try_recv().is_ok() {}
        let make_summary = |id: &str| codenomad_client::missions::Summary {
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
        panel.summaries = vec![make_summary("msn-a"), make_summary("msn-b")];
        panel.select("msn-a");
        let row_a = cleanup_row(1, false);
        let mut row_b = cleanup_row(1, false);
        row_b.mission_id = "other".into();
        row_b.deletion_id = "del-2".into();
        assert!(panel.accept_cleanups_for_test(vec![row_a.clone(), row_b.clone()]));

        let sc = panel.cleanup_scope().unwrap();
        let mut lifecycle = crate::missions::Lifecycle::default();

        // 1. Selecting an unrelated mission while GET is in flight must NOT cancel cleanup retry.
        panel.retry_cleanup(&mut lifecycle, &sc, row_a.clone());
        let get1 = http.accept().await;
        assert!(get1.header.starts_with("GET /api/workspaces/"));
        panel.select("msn-b");
        get1.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [cleanup_json(1, false)]
            }),
        )
        .await;
        let del1 = http.accept().await;
        assert!(
            del1.header.starts_with("DELETE /api/workspaces/"),
            "selecting another mission must not cancel an explicit cleanup retry"
        );
        del1.reply(
            200,
            json!({
                "deleted": true,
                "cleanup": cleanup_json(0, false)
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let polled = lifecycle.cleanup.poll();
        assert_eq!(polled.settled_cleanups.len(), 1);
        assert_eq!(polled.settled_cleanups[0].1.deletion_id, "del-1");

        // 2a. Passive list reload keeping the same pending cleanup set (even with a new settled row)
        // must preserve an in-flight explicit retry for row_b.
        let mut settled_c = cleanup_row(0, false);
        settled_c.mission_id = "third-settled".into();
        settled_c.deletion_id = "del-3-settled".into();
        assert!(panel.accept_cleanups_for_test(vec![row_b.clone()]));
        panel.retry_cleanup(&mut lifecycle, &sc, row_b.clone());
        let get2 = http.accept().await;
        assert!(get2.header.starts_with("GET /api/workspaces/"));
        assert!(panel.accept_cleanups_for_test(vec![row_b.clone(), settled_c]));
        let mut row_b_json = cleanup_json(1, false);
        row_b_json["missionID"] = json!("other");
        row_b_json["deletionID"] = json!("del-2");
        get2.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "cleanups": [row_b_json]
            }),
        )
        .await;
        let del2 = http.accept().await;
        assert!(
            del2.header.starts_with("DELETE /api/workspaces/"),
            "passive reload with unchanged pending set must preserve an explicit retry"
        );
        let mut settled_b = cleanup_json(0, false);
        settled_b["missionID"] = json!("other");
        settled_b["deletionID"] = json!("del-2");
        del2.reply(200, json!({"deleted": true, "cleanup": settled_b}))
            .await;
        wait(done.recv()).await.unwrap();
        let polled = lifecycle.cleanup.poll();
        assert_eq!(polled.settled_cleanups.len(), 1);
        assert_eq!(polled.settled_cleanups[0].1.deletion_id, "del-2");

        // 2b. Adding a new PENDING cleanup row changes the pending cleanup set and revokes
        // cleanup_view_live (mirroring Solid MissionCleanupPanel captureView fence).
        let mut row_d = cleanup_row(1, false);
        row_d.mission_id = "fourth".into();
        row_d.deletion_id = "del-4".into();
        let mut row_e = cleanup_row(1, false);
        row_e.mission_id = "fifth".into();
        row_e.deletion_id = "del-5".into();
        assert!(panel.accept_cleanups_for_test(vec![row_d.clone()]));
        panel.retry_cleanup(&mut lifecycle, &sc, row_d.clone());
        let get3 = http.accept().await;
        assert!(get3.header.starts_with("GET /api/workspaces/"));
        assert!(panel.accept_cleanups_for_test(vec![row_d, row_e]));
        let mut row_d_json = cleanup_json(1, false);
        row_d_json["missionID"] = json!("fourth");
        row_d_json["deletionID"] = json!("del-4");
        get3.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                "cleanups": [row_d_json]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        http.quiet().await;
        let polled = lifecycle.cleanup.poll();
        assert!(
            polled.settled_cleanups.is_empty(),
            "new pending row must revoke cleanup view fence before DELETE"
        );
    });
}

#[test]
fn cleanup_retry_fences_publication_at_poll_time_even_when_queued_before_hide() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let mut owner = CleanupOwner::default();
        let sc = scope();
        let view_live = live_flag();
        let row_live = live_flag();
        owner.start_cleanup_retry(
            sc.clone(),
            cleanup_row(1, false),
            view_live.clone(),
            row_live,
            http.backend.clone(),
            wake,
        );
        let get = http.accept().await;
        get.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [cleanup_json(1, false)]
            }),
        )
        .await;
        let del = http.accept().await;
        del.reply(
            200,
            json!({"deleted": true, "cleanup": cleanup_json(0, false)}),
        )
        .await;
        // Wait for the worker to queue its Settled result BEFORE revoking the view.
        wait(done.recv()).await.unwrap();
        view_live.revoke();
        let polled = owner.poll();
        assert!(
            polled.settled_cleanups.is_empty(),
            "revoking the view before poll() must block direct publication into a replacement view"
        );
        assert_eq!(
            polled.refreshed_scopes,
            vec![sc],
            "a mutated DELETE still schedules a fresh read for a reopened panel"
        );
    });
}

#[test]
fn cleanup_retry_and_directory_preserve_document_pending_without_explicit_false() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let mut owner = CleanupOwner::default();
        let sc = scope();
        let mut saved = cleanup_row(1, false);
        saved.document_pending = None;
        owner.start_cleanup_retry(
            sc.clone(),
            saved,
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        // GET reveals documentPending: true for the first time.
        let get = http.accept().await;
        get.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [cleanup_json(1, true)]
            }),
        )
        .await;
        // DELETE returns pending: 0 but omits documentPending -> must NOT settle.
        let del = http.accept().await;
        del.reply(
            200,
            json!({
                "deleted": true,
                "cleanup": {
                    "missionID": "old", "deletionID": "del-1", "requestID": "req-1",
                    "expectedRevision": 3, "deleteManagedSessions": false,
                    "objective": "Old mission", "createdAt": 1,
                    "removed": 1, "retained": 0, "pending": 0, "reasons": []
                }
            }),
        )
        .await;
        let rec = http.accept().await;
        rec.reply(
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
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert!(polled.settled_cleanups.is_empty());
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );

        // Passive directory refresh must also retain documentPending: true if omitted.
        let mut panel = crate::missions::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        assert!(panel.accept_cleanups_for_test(vec![cleanup_row(0, true)]));
        assert!(panel.cleanups[0].is_pending());
        let mut omitted = cleanup_row(0, false);
        omitted.document_pending = None;
        assert!(panel.accept_cleanups_for_test(vec![omitted]));
        assert_eq!(panel.cleanups[0].document_pending, Some(true));
        assert!(panel.cleanups[0].is_pending());
        // Explicit documentPending: false finally settles the row.
        assert!(panel.accept_cleanups_for_test(vec![cleanup_row(0, false)]));
        assert_eq!(panel.cleanups[0].document_pending, Some(false));
        assert!(!panel.cleanups[0].is_pending());
    });
}
