use super::super::Panel;
use super::super::cleanup_view::cleanup_view;
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

fn live_flag() -> LiveFlag {
    LiveFlag::new(true)
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
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake.clone());
        }
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
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live.clone(), http.backend.clone(), wake.clone());
        }
        let held_get = http.accept().await;
        assert!(held_get.header.starts_with("GET /api/workspaces/"));
        // Hide the view while GET reconciliation is still in flight.
        live.revoke();
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
        live2.revoke();
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
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake.clone());
        }
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
        {
            let req = owner.delete_request_id(&src).unwrap_or_default();
            owner.retry_delete(&src, &req, live_flag(), http.backend.clone(), wake.clone());
        }
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
                flight_live: None,
                flight_cancel: None,
                flight_phase: None,
                error: Some("missions.cleanup.documentPending"),
                document_cleanup: true,
                deletion_id: None,
                created_at_bits: None,
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

    let (_out, inbox) = bounded(1);
    let mut rt = Runtime::new(
        (panel, owner),
        |(panel, owner), _| {
            crate::strings::with_locale("en", || {
                rune_theme_codenomad::git_panel::scroll().child(
                    cleanup_view::<(Panel, CleanupOwner)>(
                        panel,
                        owner,
                        "occ",
                        |_, _, _, _| {},
                        |_, _, _, _, _, _| {},
                    ),
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
                view_live: live_flag(),
                row_live: live_flag(),
                cancel: None,
                phase: Arc::new(AtomicU8::new(PHASE_DISPATCHED)),
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
        let req_a = owner.delete_request_id(&src_a).unwrap_or_default();
        owner.retry_delete(
            &src_a,
            &req_a,
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

        let req_a = owner.delete_request_id(&src_a).unwrap();
        assert!(owner.delete_state(&src_a).is_some());
        assert_eq!(owner.delete_state(&src_b), None);
        owner.cancel_delete(&src_b, &req_a);
        assert!(
            owner.delete_state(&src_a).is_some(),
            "workspace B cannot cancel workspace A's delete intent"
        );
        owner.retry_delete(&src_b, &req_a, live_flag(), http_b.backend.clone(), wake);
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
                flight_live: None,
                flight_cancel: None,
                flight_phase: None,
                error: Some("missions.cleanup.documentPending"),
                document_cleanup: true,
                deletion_id: None,
                created_at_bits: None,
                retired: false,
            },
        );

        // Hold orphaned-delete retry GET; cleanup-row retry must refuse to start concurrently.
        owner.retry_delete_in_scope(
            &sc,
            &old_src.mission,
            &row.request_id,
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
            &row.request_id,
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
        out.try_send(CleanupRetryResult::Failed {
            key: "missions.cleanup.error.unconfirmed",
            mutated: false,
            document_cleanup: false,
        })
        .unwrap();
        owner.retries.insert(
            sc.clone(),
            CleanupRetry {
                key: CleanupKey::new(sc, &cleanup_row(0, true)),
                view_live: live_flag(),
                row_live: live_flag(),
                cancel: None,
                phase: Arc::new(AtomicU8::new(PHASE_DISPATCHED)),
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
        let mut panel = super::super::Panel::new(
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
            if !panel.busy(super::super::directory::Kind::Summaries)
                && !panel.busy(super::super::directory::Kind::Cleanups)
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
        let mut lifecycle = super::super::Lifecycle::default();

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
        wait(done.recv()).await.unwrap();
        let polled = owner.poll();
        assert!(polled.settled_cleanups.is_empty());
        assert_eq!(
            owner.cleanup_error(&sc),
            Some("missions.cleanup.error.unconfirmed")
        );

        // Passive directory refresh must also retain documentPending: true if omitted.
        let mut panel = super::super::Panel::new(
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
        wait(done.recv()).await.unwrap();
        let polled1 = owner.poll();
        assert_eq!(
            polled1.document_pending_rows,
            vec![(
                sc.clone(),
                super::super::directory::cleanup_identity(&omitted_row)
            )]
        );

        // Even if a subsequent directory refresh still omits documentPending, Panel preserves true
        // once notified and the next retry still requires explicit documentPending: false.
        let mut panel = super::super::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        assert!(panel.accept_cleanups_for_test(vec![omitted_row.clone()]));
        panel.mark_cleanup_document_pending(&super::super::directory::cleanup_identity(
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        assert!(panel.accept_cleanups_for_test(vec![omitted_row.clone()]));
        panel.mark_cleanup_document_pending(&super::super::directory::cleanup_identity(
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
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
        let mut lifecycle = super::super::Lifecycle::default();
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
        let mut panel = super::super::Panel::new(
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
            super::super::Panel::new(backend, Some("project".into()), Default::default(), wake);
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
            panel.has_more(super::super::directory::Kind::Cleanups),
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
        assert_eq!(panel.cleanups.len(), 2_001);
        assert_eq!(panel.cleanup_seen_count(), 2_001);
        assert!(!panel.has_more(super::super::directory::Kind::Cleanups));
        assert!(
            panel.cleanups.iter().any(|r| r.deletion_id == "del-0")
                && panel.cleanups.iter().any(|r| r.deletion_id == "del-2000"),
            "both the first and 2,001st pending cleanups must remain loaded and reachable"
        );
        // Adopting a separate settled receipt while 2,001 pending rows are loaded must
        // display the new receipt immediately without evicting it or any pending row.
        let mut separate_settled = cleanup_row(0, false);
        separate_settled.mission_id = "msn-separate".into();
        separate_settled.deletion_id = "del-separate".into();
        panel.adopt_settled_cleanup(separate_settled);
        assert_eq!(
            panel.cleanups[0].deletion_id, "del-separate",
            "newly adopted settled receipt must not evict itself at the 2,000+ display count"
        );
        assert!(panel.cleanups.iter().any(|r| r.deletion_id == "del-0"));
        assert!(panel.cleanups.iter().any(|r| r.deletion_id == "del-2000"));

        let mut lifecycle = super::super::Lifecycle::default();
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
        // First row (del-0) is also still retryable.
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
            super::super::Panel::new(backend, Some("project".into()), Default::default(), wake);
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

        let mut lifecycle = super::super::Lifecycle::default();
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
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
                panel.has_more(super::super::directory::Kind::Cleanups),
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
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
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
        let mut reauthed = super::super::Panel::new(
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

#[test]
fn confirmed_deleted_mission_stays_filtered_across_stale_summaries_refresh() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, _done) = witness();
        let mut panel = super::super::Panel::new(
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
        let mut panel = super::super::Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake.clone(),
        );
        let mut lifecycle = super::super::Lifecycle::default();
        let mut src = source("msn-offline");
        src.mission.server = "server".into();
        src.workspace = http.backend.workspace.clone();
        lifecycle.cleanup.start_delete(
            &src,
            "Offline mission".into(),
            3,
            false,
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
            panel: super::super::Panel,
            lifecycle: super::super::Lifecycle,
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
                        super::super::cleanup_view::cleanup_view::<Harness>(
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
        let mut panel = super::super::Panel::new(
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
