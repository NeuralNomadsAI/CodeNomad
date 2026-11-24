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

        owner.start_delete(&src, 7, true, http.backend.clone(), wake.clone());
        assert_eq!(owner.delete_state(&src), Some(DeleteState::Busy));
        let first = http.accept().await;
        assert!(first.header.starts_with("DELETE /api/workspaces/"));
        assert!(first.header.contains("/missions/msn-del "));
        let request_id = first.body["requestId"].as_str().unwrap().to_owned();
        assert_eq!(first.body["expectedRevision"], 7);
        assert_eq!(first.body["deleteManagedSessions"], true);
        first.reply(503, json!({"code": "cleanup-pending"})).await;

        // Failure triggers read-only reconciliation before surfacing the error.
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
        assert_eq!(
            owner.delete_state(&src),
            Some(DeleteState::Failed("missions.cleanup.error.pending"))
        );

        // Retry reconciles first, then reuses the exact frozen requestId and option.
        owner.retry_delete(&src, http.backend.clone(), wake.clone());
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
        assert_eq!(owner.delete_state(&src), None);
        assert!(owner.can_delete(&src));
    });
}

#[test]
fn retry_delete_stops_without_sending_when_reconciliation_shows_revision_conflict_or_completion() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-conflict");
        let mut owner = CleanupOwner::default();

        owner.start_delete(&src, 7, false, http.backend.clone(), wake.clone());
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
        owner.retry_delete(&src, http.backend.clone(), wake.clone());
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
        owner.retry_delete(&src, http.backend.clone(), wake.clone());
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
fn cleanup_retry_reconciles_before_delete_and_settles_409_when_cleanup_already_finished() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let sc = scope();
        let row = cleanup_row(0, true);
        let mut owner = CleanupOwner::default();

        // Missing cleanup in reconciliation refuses without calling DELETE.
        owner.start_cleanup_retry(sc.clone(), row.clone(), http.backend.clone(), wake.clone());
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

        // Matching pending cleanup issues DELETE; 409 reconciles and succeeds if settled.
        owner.start_cleanup_retry(sc.clone(), row.clone(), http.backend.clone(), wake.clone());
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
    });
}

#[test]
fn cleanup_view_shows_pending_title_retained_reasons_policy_and_disables_retry_while_busy() {
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
    let mut panel = Panel::new(backend, Some("project".into()), Default::default(), wake);
    panel.cleanups = vec![cleanup_row(0, true)];
    let owner = CleanupOwner::default();
    let sc = panel.cleanup_scope().unwrap();
    let (_out, inbox) = bounded(1);

    let mut rt = Runtime::new(
        (panel, owner),
        |(panel, owner), _| {
            crate::strings::with_locale("en", || {
                cleanup_view::<(Panel, CleanupOwner)>(panel, owner, |_, _| {})
            })
        },
        (400.0, 500.0),
        Env::new(false, 1.0),
    );
    rt.frame(1.0 / 60.0);
    let tree = rt.accessibility_json();
    let text = tree.to_string();
    assert!(text.contains("Conversation cleanup"));
    assert!(text.contains("Kept because the conversation has child conversations."));
    assert!(text.contains("Counts cover managed cleanup targets only."));
    assert!(text.contains("Try again"));
    assert!(!has_state(
        &tree,
        "mission-cleanup-retry-old-del-1",
        "disabled"
    ));

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
