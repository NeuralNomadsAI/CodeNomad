use super::*;
use crate::files::test_http::{Http, wait};
use codenomad_client::missions::MapHeader;
use serde_json::json;

fn source(mission_id: &str) -> Source {
    let header: MapHeader = serde_json::from_value(json!({
        "root": {
            "version": 1, "id": mission_id, "projectID": "project", "projectCanonical": "/fixture",
            "excerpt": "Fixture", "template": "custom", "status": "active",
            "coordinatorSessionId": "ses_coord", "revision": 7,
            "createdAt": 1, "updatedAt": 1, "historyTruncated": false, "bodies": {}
        },
        "collections": {},
        "tasks": {"page": {"order": "", "offset": 0, "end": 0, "total": 0, "counts": {}, "reports": 0},
            "pins": [], "reportPins": [], "version": ""}
    }))
    .unwrap();
    Source {
        occurrence: "occ".into(),
        workspace: "ws".into(),
        mission: MissionKey {
            server: "server".into(),
            id: mission_id.into(),
        },
        target: header.lifecycle_target(),
    }
}

fn scope() -> WorkspaceScope {
    WorkspaceScope {
        server: "server".into(),
        workspace: "ws".into(),
        project: "project".into(),
    }
}

fn cleanup_json(pending: u64, document_pending: bool) -> serde_json::Value {
    json!({
        "missionID": "old", "deletionID": "del-1", "requestID": "req-1",
        "expectedRevision": 3, "deleteManagedSessions": false,
        "objective": "Old mission", "createdAt": 1,
        "removed": 0, "retained": 1, "pending": pending,
        "reasons": ["children"], "documentPending": document_pending
    })
}

fn cleanup_row(pending: u64, document_pending: bool) -> Cleanup {
    serde_json::from_value(cleanup_json(pending, document_pending)).unwrap()
}

fn live_flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

fn witness() -> (Wake, Receiver<()>) {
    let (send, done) = bounded(4);
    (
        std::sync::Arc::new(move || {
            let _ = send.try_send(());
        }),
        done,
    )
}

#[test]
fn mission_delete_freezes_intent_reconciles_lost_ack_and_reuses_exact_request_on_retry() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-del");
        let mut owner = CleanupOwner::default();

        owner.start_delete(
            &src,
            "Delete target".into(),
            7,
            true,
            http.backend.clone(),
            wake.clone(),
        );
        assert_eq!(owner.delete_state(&src), Some(DeleteState::Busy));
        let first = http.accept().await;
        assert!(first.header.starts_with("DELETE /api/workspaces/"));
        assert!(first.header.contains("/missions/msn-del "));
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        assert_eq!(first.body["expectedRevision"], 7);
        assert_eq!(first.body["deleteManagedSessions"], true);
        first.reply(503, json!({"code": "cleanup-pending"})).await;

        let reconcile = http.accept().await;
        assert!(reconcile.header.starts_with("GET /api/workspaces/"));
        assert!(reconcile.header.contains("/missions/msn-del "));
        reconcile
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [{
                        "missionID": "msn-del", "deletionID": "del-9", "requestID": request_id,
                        "expectedRevision": 7, "deleteManagedSessions": true,
                        "objective": "Obj", "createdAt": 2, "removed": 0, "retained": 0,
                        "pending": 1, "reasons": [], "documentPending": false
                    }]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert_eq!(polled.refreshed_missions.len(), 1);
        assert_eq!(polled.refreshed_scopes, vec![scope()]);
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.pending"))
        );

        // Retry reconciles first, then reuses the exact frozen requestId and option.
        owner.retry_delete(&src, live_flag(), http.backend.clone(), wake.clone());
        assert_eq!(owner.delete_state(&src), Some(DeleteState::Busy));
        let pre_retry = http.accept().await;
        assert!(pre_retry.header.starts_with("GET /api/workspaces/"));
        pre_retry
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                    "cleanups": [{
                        "missionID": "msn-del", "deletionID": "del-9", "requestID": request_id,
                        "expectedRevision": 7, "deleteManagedSessions": true,
                        "objective": "Obj", "createdAt": 2, "removed": 0, "retained": 0,
                        "pending": 1, "reasons": [], "documentPending": false
                    }]
                }),
            )
            .await;
        let second = http.accept().await;
        assert!(second.header.starts_with("DELETE /api/workspaces/"));
        assert_eq!(second.body["requestId"], request_id);
        assert_eq!(second.body["expectedRevision"], 7);
        assert_eq!(second.body["deleteManagedSessions"], true);
        second
            .reply(
                200,
                json!({
                    "deleted": true,
                    "cleanup": {
                        "missionID": "msn-del", "deletionID": "del-9", "requestID": request_id,
                        "expectedRevision": 7, "deleteManagedSessions": true,
                        "objective": "Obj", "createdAt": 2, "removed": 1, "retained": 0,
                        "pending": 0, "reasons": [], "documentPending": false
                    }
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert_eq!(polled.refreshed_missions.len(), 1);
        assert_eq!(polled.refreshed_scopes, vec![scope()]);
        assert_eq!(owner.delete_state(&src), None);
        assert!(owner.can_delete(&src));
    });
}

#[test]
fn hiding_view_during_reconciliation_cancels_both_retry_paths_before_sending_delete() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-fenced");
        let mut owner = CleanupOwner::default();

        // 1. Delete retry fenced by view_live.
        owner.start_delete(
            &src,
            "Fenced".into(),
            7,
            false,
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        first.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec = http.accept().await;
        rec.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "cleanups": [{
                    "missionID": "msn-fenced", "deletionID": "del-f", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Fenced", "createdAt": 1, "removed": 0, "retained": 0,
                    "pending": 1, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        let live = live_flag();
        owner.retry_delete(&src, live.clone(), http.backend.clone(), wake.clone());
        let held_get = http.accept().await;
        assert!(held_get.header.starts_with("GET /api/workspaces/"));
        // Hide the view while GET reconciliation is still in flight.
        live.store(false, Ordering::Release);
        held_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [{
                        "missionID": "msn-fenced", "deletionID": "del-f", "requestID": request_id,
                        "expectedRevision": 7, "deleteManagedSessions": false,
                        "objective": "Fenced", "createdAt": 1, "removed": 0, "retained": 0,
                        "pending": 1, "reasons": [], "documentPending": false
                    }]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        http.quiet().await;
        // Original failed intent stays intact for a future explicit retry.
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.pending"))
        );

        // 2. Cleanup row retry fenced by view_live.
        let sc = scope();
        let row = cleanup_row(0, true);
        let live2 = live_flag();
        let row_live = live_flag();
        owner.start_cleanup_retry(
            sc.clone(),
            row,
            live2.clone(),
            row_live,
            http.backend.clone(),
            wake,
        );
        let held_cleanup_get = http.accept().await;
        assert!(held_cleanup_get.header.starts_with("GET /api/workspaces/"));
        live2.store(false, Ordering::Release);
        held_cleanup_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                    "cleanups": [cleanup_json(0, true)]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        http.quiet().await;
        assert!(!owner.cleanup_busy(&sc));
        assert_eq!(owner.cleanup_error(&sc), None);
    });
}

#[test]
fn retry_delete_stops_without_sending_when_reconciliation_shows_revision_conflict_or_completion() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-conflict");
        let mut owner = CleanupOwner::default();

        owner.start_delete(
            &src,
            "Conflict".into(),
            7,
            false,
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
                "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                "mission": {"id": "msn-conflict", "projectID": "project", "revision": 7},
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

        // Retry sees mission revision advanced to 8 -> reports revisionConflict without DELETE.
        owner.retry_delete(&src, live_flag(), http.backend.clone(), wake.clone());
        let rec2 = http.accept().await;
        assert!(rec2.header.starts_with("GET /api/workspaces/"));
        rec2.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                "mission": {"id": "msn-conflict", "projectID": "project", "revision": 8},
                "cleanups": []
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed(
                "missions.cleanup.error.revisionConflict"
            ))
        );
        http.quiet().await;

        // If reconciliation instead shows the saved intent settled, retry completes without DELETE.
        owner.retry_delete(&src, live_flag(), http.backend.clone(), wake.clone());
        let rec3 = http.accept().await;
        rec3.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 4,
                "cleanups": [{
                    "missionID": "msn-conflict", "deletionID": "del-2", "requestID": request_id,
                    "expectedRevision": 7, "deleteManagedSessions": false,
                    "objective": "Obj", "createdAt": 4, "removed": 1, "retained": 0,
                    "pending": 0, "reasons": [], "documentPending": false
                }]
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        assert_eq!(owner.delete_state(&src), None);
        http.quiet().await;
    });
}

#[test]
fn cleanup_retry_reconciles_before_delete_settles_409_and_retires_matching_delete_intent() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let row = cleanup_row(0, true);
        let mut owner = CleanupOwner::default();

        // Seed a failed DeleteIntent matching the exact same saved cleanup intent.
        let old_src = source("old");
        owner.deletes.insert(
            (sc.clone(), old_src.mission.clone()),
            DeleteIntent {
                scope: sc.clone(),
                title: "Old mission".into(),
                target: old_src.target.clone(),
                request: DeletionRequest::from_cleanup(&row).unwrap(),
                flight: None,
                error: Some("missions.cleanup.documentPending"),
                document_cleanup: true,
                retired: false,
            },
        );
        assert!(!owner.can_delete(&old_src));

        // Missing cleanup in reconciliation refuses without calling DELETE.
        owner.start_cleanup_retry(
            sc.clone(),
            row.clone(),
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        assert!(owner.cleanup_busy(&sc));
        let rec = http.accept().await;
        assert!(rec.header.starts_with("GET /api/workspaces/"));
        assert!(rec.header.contains("/missions/old "));
        rec.reply(
            200,
            json!({"available": true, "version": 1, "projectID": "project", "generatedAt": 1, "cleanups": []}),
        )
        .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert_eq!(polled.refreshed_scopes, vec![sc.clone()]);
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );
        http.quiet().await;

        // Matching pending cleanup issues DELETE; 409 reconciles, succeeds and retires the DeleteIntent slot.
        owner.start_cleanup_retry(
            sc.clone(),
            row.clone(),
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        let rec_pending = http.accept().await;
        rec_pending
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [cleanup_json(0, true)]
                }),
            )
            .await;
        let del = http.accept().await;
        assert!(del.header.starts_with("DELETE /api/workspaces/"));
        assert_eq!(
            del.body,
            json!({"expectedRevision": 3, "requestId": "req-1", "deleteManagedSessions": false})
        );
        del.reply(409, json!({"code": "request-conflict"})).await;
        let rec_after = http.accept().await;
        assert!(rec_after.header.starts_with("GET /api/workspaces/"));
        rec_after
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                    "cleanups": [cleanup_json(0, false)]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert_eq!(polled.refreshed_scopes, vec![sc.clone()]);
        assert_eq!(owner.cleanup_error(&sc), None);
        assert!(!owner.cleanup_busy(&sc));
        assert!(
            owner.can_delete(&old_src),
            "settling via cleanup row must release the original DeleteIntent slot"
        );
    });
}

#[test]
fn cleanup_view_keeps_tombstoned_delete_reachable_and_fences_stale_scope_retry() {
    use rune::{Env, Runtime};
    let http = crate::platform::block_on(Http::new());
    let backend = http.backend.clone();
    let attest = std::thread::spawn(move || {
        crate::platform::block_on(async {
            let meta = http.accept().await;
            meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                .await;
        });
    });
    crate::platform::block_on(backend.attest_server()).unwrap();
    attest.join().unwrap();

    let (wake, _) = witness();
    let mut panel = Panel::new(
        backend.clone(),
        Some("project".into()),
        Default::default(),
        wake,
    );
    panel.cleanups = vec![cleanup_row(0, true)];
    let sc = panel.cleanup_scope().unwrap();
    let mut owner = CleanupOwner::default();

    // Tombstoned mission: not selected and not in summaries or cleanups, yet Retry/Cancel remain reachable.
    let gone = source("tombstoned");
    owner.deletes.insert(
        (sc.clone(), gone.mission.clone()),
        DeleteIntent {
            scope: sc.clone(),
            title: "Gone mission".into(),
            target: gone.target.clone(),
            request: DeletionRequest::new(7, false).unwrap(),
            flight: None,
            error: Some("missions.cleanup.error.unconfirmed"),
            document_cleanup: false,
            retired: false,
        },
    );

    let (_out, inbox) = bounded(1);
    let mut rt = Runtime::new(
        (panel, owner),
        |(panel, owner), _| {
            crate::strings::with_locale("en", || {
                cleanup_view::<(Panel, CleanupOwner)>(
                    panel,
                    owner,
                    "occ",
                    |_, _, _, _| {},
                    |_, _, _, _, _| {},
                )
            })
        },
        (400.0, 600.0),
        Env::new(false, 1.0),
    );
    rt.frame(1.0 / 60.0);
    let tree = rt.accessibility_json();
    let text = tree.to_string();
    assert!(text.contains("Gone mission"));
    assert!(rt.find("mission-delete-retry-tombstoned").is_some());
    assert!(rt.find("mission-delete-cancel-tombstoned").is_some());
    assert!(text.contains("Conversation cleanup"));
    assert!(text.contains("Kept because the conversation has child conversations."));
    assert!(text.contains("Counts cover managed cleanup targets only."));
    assert!(!has_state(
        &tree,
        "mission-cleanup-retry-old-del-1",
        "disabled"
    ));

    // A retry invoked with a foreign scope must never start on this panel.
    let mut lifecycle = super::super::Lifecycle::default();
    let foreign = WorkspaceScope {
        server: "other-server".into(),
        workspace: sc.workspace.clone(),
        project: sc.project.clone(),
    };
    rt.state
        .0
        .retry_cleanup(&mut lifecycle, &foreign, cleanup_row(0, true));
    assert!(!lifecycle.cleanup.cleanup_busy(&sc));
    assert!(!lifecycle.cleanup.cleanup_busy(&foreign));

    rt.update(|(panel, owner), _| {
        let key = CleanupKey::new(sc.clone(), &panel.cleanups[0]);
        owner.retries.insert(
            sc.clone(),
            CleanupRetry {
                key,
                flight: inbox,
                retired: false,
            },
        );
    });
    rt.frame(1.0 / 60.0);
    let busy_tree = rt.accessibility_json();
    assert!(busy_tree.to_string().contains("Retrying cleanup"));
    assert!(has_state(
        &busy_tree,
        "mission-cleanup-retry-old-del-1",
        "disabled"
    ));
}

#[test]
fn selected_delete_retry_cancels_when_user_switches_mission_during_reconciliation() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let mut panel = Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        panel.selection_live = live_flag();
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
        panel.selected = Some("msn-a".into());

        let src_a = source("msn-a");
        let mut owner = CleanupOwner::default();
        owner.start_delete(
            &src_a,
            "Mission A".into(),
            7,
            false,
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
                "mission": {"id": "msn-a", "projectID": "project", "revision": 7},
                "cleanups": []
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        // Start retry fenced with panel.selection_live, then switch selection to B while GET is held.
        owner.retry_delete(
            &src_a,
            panel.selection_live.clone(),
            http.backend.clone(),
            wake,
        );
        let held_get = http.accept().await;
        assert!(held_get.header.starts_with("GET /api/workspaces/"));
        panel.select("msn-b");
        assert_eq!(panel.selected.as_deref(), Some("msn-b"));
        held_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "mission": {"id": "msn-a", "projectID": "project", "revision": 7},
                    "cleanups": []
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        http.quiet().await;
    });
}

#[test]
fn delete_intent_stays_isolated_to_its_origin_workspace_scope() {
    crate::platform::block_on(async {
        let http_a = Http::new().await;
        let http_b = Http::new().await;
        let (wake, done) = witness();
        let src_a = source("msn-shared");
        let mut src_b = source("msn-shared");
        src_b.workspace = "ws-other".into();
        let mut owner = CleanupOwner::default();

        owner.start_delete(
            &src_a,
            "Shared".into(),
            7,
            false,
            http_a.backend.clone(),
            wake.clone(),
        );
        let first = http_a.accept().await;
        first.reply(503, json!({})).await;
        let rec = http_a.accept().await;
        rec.reply(
            200,
            json!({
                "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                "mission": {"id": "msn-shared", "projectID": "project", "revision": 7},
                "cleanups": []
            }),
        )
        .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        assert!(owner.delete_state(&src_a).is_some());
        assert_eq!(owner.delete_state(&src_b), None);
        owner.cancel_delete(&src_b);
        assert!(
            owner.delete_state(&src_a).is_some(),
            "workspace B cannot cancel workspace A's delete intent"
        );
        owner.retry_delete(&src_b, live_flag(), http_b.backend.clone(), wake);
        http_b.quiet().await;
        http_a.quiet().await;
    });
}

#[test]
fn orphaned_delete_and_cleanup_row_retries_exclude_each_other_and_row_settlement_cancels_get() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let row = cleanup_row(0, true);
        let old_src = source("old");
        let mut owner = CleanupOwner::default();
        owner.deletes.insert(
            (sc.clone(), old_src.mission.clone()),
            DeleteIntent {
                scope: sc.clone(),
                title: "Old".into(),
                target: old_src.target.clone(),
                request: DeletionRequest::from_cleanup(&row).unwrap(),
                flight: None,
                error: Some("missions.cleanup.documentPending"),
                document_cleanup: true,
                retired: false,
            },
        );

        // Hold orphaned-delete retry GET; cleanup-row retry must refuse to start concurrently.
        owner.retry_delete_in_scope(
            &sc,
            &old_src.mission,
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        let held_get = http.accept().await;
        assert!(owner.has_active_delete_flight(&sc, "old"));
        owner.start_cleanup_retry(
            sc.clone(),
            row.clone(),
            live_flag(),
            live_flag(),
            http.backend.clone(),
            wake.clone(),
        );
        assert!(!owner.cleanup_busy(&sc));
        held_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 1,
                    "cleanups": [cleanup_json(0, true)]
                }),
            )
            .await;
        let del = http.accept().await;
        del.reply(503, json!({"code": "cleanup-pending"})).await;
        let rec_after = http.accept().await;
        rec_after
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 2,
                    "cleanups": [cleanup_json(0, true)]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        owner.poll();

        // Now start cleanup-row retry with a real per-row token, verify orphaned retry is blocked,
        // and settle the row while GET is in flight -> DELETE must not be sent.
        let mut panel = Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        panel.cleanups = vec![row.clone()];
        let row_live = panel.cleanup_row_live(&row.mission_id, &row.deletion_id);
        owner.start_cleanup_retry(
            sc.clone(),
            row.clone(),
            live_flag(),
            row_live,
            http.backend.clone(),
            wake.clone(),
        );
        let held_cleanup_get = http.accept().await;
        owner.retry_delete_in_scope(
            &sc,
            &old_src.mission,
            live_flag(),
            http.backend.clone(),
            wake,
        );
        assert!(!owner.has_active_delete_flight(&sc, "old"));

        // Panel receives a refresh marking the row settled while panel stays open.
        assert!(panel.accept_cleanups_for_test(vec![cleanup_row(0, false)]));
        held_cleanup_get
            .reply(
                200,
                json!({
                    "available": true, "version": 1, "projectID": "project", "generatedAt": 3,
                    "cleanups": [cleanup_json(0, true)]
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        owner.poll();
        http.quiet().await;
    });
}

#[test]
fn closing_workspaces_retires_failed_delete_intents_and_bounds_cleanup_errors() {
    let mut owner = CleanupOwner::default();
    for i in 0..CAPACITY {
        let mut src = source(&format!("msn-{i}"));
        src.workspace = format!("ws-{i}");
        let sc = src.workspace_scope();
        owner.deletes.insert(
            (sc.clone(), src.mission.clone()),
            DeleteIntent {
                scope: sc,
                title: format!("Mission {i}"),
                target: src.target.clone(),
                request: DeletionRequest::new(1, false).unwrap(),
                flight: None,
                error: Some("missions.cleanup.error.unconfirmed"),
                document_cleanup: false,
                retired: false,
            },
        );
    }
    let mut fresh = source("msn-fresh");
    fresh.workspace = "ws-fresh".into();
    assert!(!owner.can_delete(&fresh));

    for i in 0..CAPACITY {
        let sc = WorkspaceScope {
            server: "server".into(),
            workspace: format!("ws-{i}"),
            project: "project".into(),
        };
        owner.retire_scope(&sc);
    }
    assert!(owner.deletes.is_empty());
    assert!(owner.can_delete(&fresh));

    // Retry error map stays strictly bounded to CAPACITY across closed scopes.
    for i in 0..(CAPACITY + 10) {
        let sc = WorkspaceScope {
            server: "server".into(),
            workspace: format!("ws-err-{i}"),
            project: "project".into(),
        };
        let (out, inbox) = bounded(1);
        out.try_send(CleanupRetryResult::Failed(
            "missions.cleanup.error.unconfirmed",
        ))
        .unwrap();
        owner.retries.insert(
            sc.clone(),
            CleanupRetry {
                key: CleanupKey::new(sc, &cleanup_row(0, true)),
                flight: inbox,
                retired: false,
            },
        );
        owner.poll();
    }
    assert!(owner.retry_errors.len() <= CAPACITY);
}

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
                error: Some("missions.cleanup.error.unconfirmed"),
                document_cleanup: false,
                retired: false,
            },
        );
        owner.retry_delete(
            &src,
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
        view_live.store(false, Ordering::Release);
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
        let mut lifecycle = super::super::Lifecycle::default();
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
        owner.retry_delete(&src, live_flag(), http.backend.clone(), wake);
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
        view_live.store(false, Ordering::Release);
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
        assert!(polled.settled_cleanups.is_empty());
        assert!(polled.refreshed_scopes.is_empty());
    });
}

fn has_state(tree: &serde_json::Value, key: &str, state: &str) -> bool {
    if tree["key"].as_str() == Some(key) {
        return tree["states"]
            .as_array()
            .is_some_and(|states| states.contains(&serde_json::Value::from(state)));
    }
    tree["children"]
        .as_array()
        .is_some_and(|children| children.iter().any(|child| has_state(child, key, state)))
}
