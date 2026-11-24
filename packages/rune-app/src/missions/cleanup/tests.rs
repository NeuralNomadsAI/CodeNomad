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
        second.reply(200, json!({"deleted": true})).await;
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
        owner.start_cleanup_retry(sc.clone(), row, live2.clone(), http.backend.clone(), wake);
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
            old_src.mission.clone(),
            DeleteIntent {
                scope: sc.clone(),
                title: "Old mission".into(),
                target: old_src.target.clone(),
                request: DeletionRequest::from_cleanup(&row).unwrap(),
                flight: None,
                error: Some("missions.cleanup.documentPending"),
            },
        );
        assert!(!owner.can_delete(&old_src));

        // Missing cleanup in reconciliation refuses without calling DELETE.
        owner.start_cleanup_retry(
            sc.clone(),
            row.clone(),
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
        gone.mission.clone(),
        DeleteIntent {
            scope: sc.clone(),
            title: "Gone mission".into(),
            target: gone.target.clone(),
            request: DeletionRequest::new(7, false).unwrap(),
            flight: None,
            error: Some("missions.cleanup.error.unconfirmed"),
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
        owner
            .retries
            .insert(sc.clone(), CleanupRetry { key, flight: inbox });
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
