use super::*;
use serde_json::json;
use std::future::Future;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn block_on<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

async fn spawn_http(status: &str, body: String) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let status = status.to_owned();
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 16384];
        let n = socket.read(&mut buf).await.unwrap();
        let req = String::from_utf8_lossy(&buf[..n]).into_owned();
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(reply.as_bytes()).await.unwrap();
        req
    });
    (format!("http://{addr}/"), handle)
}

fn backend(base: String) -> Backend {
    let mut b = Backend::unauthenticated(&base).unwrap();
    b.workspace = "ws-1".into();
    b
}

fn target() -> LifecycleTarget {
    LifecycleTarget {
        mission: "msn_alpha123".into(),
        project: "prj_1".into(),
        canonical: "/repo".into(),
        coordinator: "ses_coord1".into(),
        coordinator_location: Some(("/repo".into(), None)),
    }
}

fn sample_mission(revision: u64, run_state: &str) -> Value {
    json!({
        "id": "msn_alpha123",
        "projectID": "prj_1",
        "projectCanonical": "/repo",
        "coordinatorSessionId": "ses_coord1",
        "revision": revision,
        "status": "active",
        "runState": run_state,
        "template": "custom",
        "taskMode": "native",
        "actors": [{
            "kind": "coordinator",
            "sessionId": "ses_coord1",
            "location": { "directory": "/repo" }
        }]
    })
}

#[test]
fn derives_single_line_clause_title_and_bounds_words() {
    assert_eq!(
        derive_mission_title("  \n  Fix login. Also clean up"),
        "Fix login"
    );
    assert_eq!(
        derive_mission_title("Ship feature; then monitor"),
        "Ship feature"
    );
    assert_eq!(derive_mission_title("Ready? Yes"), "Ready?");
    assert_eq!(derive_mission_title("   \n\t  "), "");
    let long = "Audit every single background synchronization task across the whole desktop client repository";
    let derived = derive_mission_title(long);
    assert!(utf16_len(&derived) <= MISSION_TITLE_MAX);
    assert!(derived.ends_with('…'));
    assert!(!derived.contains('\n'));
}

#[test]
fn validates_create_and_update_inputs() {
    assert!(
        CreateMissionRequest::new("   ", None, "", Template::Custom, TaskMode::Native).is_err()
    );
    assert!(
        CreateMissionRequest::new(
            "Valid objective",
            Some("Line 1\nLine 2"),
            "",
            Template::Custom,
            TaskMode::Native
        )
        .is_err()
    );
    assert!(
        CreateMissionRequest::new(
            "Valid objective",
            Some(&"x".repeat(MISSION_TITLE_MAX + 1)),
            "",
            Template::Custom,
            TaskMode::Native
        )
        .is_err()
    );
    assert!(
        CreateMissionRequest::new(
            "Valid objective",
            None,
            &"y".repeat(MISSION_TEXT_MAX + 1),
            Template::Custom,
            TaskMode::Native
        )
        .is_err()
    );
    let ok = CreateMissionRequest::new(
        "  Ship fix  ",
        Some("  My title  "),
        "Verbatim notes",
        Template::Debug,
        TaskMode::Independent,
    )
    .unwrap();
    assert_eq!(ok.objective, "Ship fix");
    assert_eq!(ok.title.as_deref(), Some("My title"));
    assert_eq!(ok.notes.as_deref(), Some("Verbatim notes"));

    assert!(UpdateMissionRequest::new(0, "Valid", "").is_err());
    assert!(UpdateMissionRequest::new(2, "   ", "").is_err());
    let upd = UpdateMissionRequest::new(3, " Updated ", "").unwrap();
    assert_eq!(upd.objective, "Updated");
    assert_eq!(upd.notes.as_deref(), Some(""));
}

#[test]
fn create_mission_fresh_ack_and_auto_start() {
    block_on(async {
        let body = json!({
            "acknowledgement": "fresh",
            "mission": sample_mission(1, "prepared"),
        });
        let (base, req_task) = spawn_http("200 OK", body.to_string()).await;
        let req = CreateMissionRequest::with_request_id(
            "req-1".into(),
            "Ship editor",
            Some("Editor"),
            "",
            Template::Custom,
            TaskMode::Native,
        )
        .unwrap();
        let outcome = backend(base).create_mission(&req).await;
        let received = req_task.await.unwrap();
        assert!(received.starts_with("POST /api/workspaces/ws-1/missions HTTP/1.1"));
        assert!(received.contains("\"requestId\":\"req-1\""));
        let CreateMissionOutcome::Created(created) = outcome else {
            panic!("expected Created, got {outcome:?}");
        };
        assert_eq!(created.id, "msn_alpha123");
        assert_eq!(created.revision, 1);
        assert!(created.can_auto_start());

        let mut started_mission = sample_mission(2, "running");
        let (start_base, start_task) = {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let handle = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 16384];
                let n = socket.read(&mut buf).await.unwrap();
                let raw = String::from_utf8_lossy(&buf[..n]).into_owned();
                let payload: Value =
                    serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                started_mission["control"] = json!({
                    "missionID": "msn_alpha123",
                    "requestID": payload["requestId"],
                    "expectedRevision": 1,
                    "completedRevision": 2,
                    "action": "start",
                    "pending": []
                });
                let reply_body = json!({ "mission": started_mission }).to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply_body}",
                    reply_body.len()
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
                raw
            });
            (format!("http://{addr}/"), handle)
        };
        let start_outcome = backend(start_base).start_created_mission(&created).await;
        assert_eq!(start_outcome, StartCreatedOutcome::Started(2));
        let start_req = start_task.await.unwrap();
        assert!(start_req.starts_with("POST /api/workspaces/ws-1/missions/msn_alpha123/control "));
    });
}

#[test]
fn create_mission_maps_uncertain_definitive_rejections_and_401() {
    block_on(async {
        let req = CreateMissionRequest::with_request_id(
            "req-2".into(),
            "Ship editor",
            None,
            "",
            Template::Custom,
            TaskMode::Native,
        )
        .unwrap();

        let (base, _t) = spawn_http(
            "409 Conflict",
            json!({"error":"uncertain","code":"creation-uncertain"}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).create_mission(&req).await,
            CreateMissionOutcome::Uncertain
        );

        let (base, _t) = spawn_http(
            "503 Service Unavailable",
            json!({"error":"unavailable","code":"creation-unavailable"}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).create_mission(&req).await,
            CreateMissionOutcome::Rejected(MutationCode::CreationUnavailable)
        );

        let (base, _t) = spawn_http(
            "500 Internal Server Error",
            json!({"error":"boom"}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).create_mission(&req).await,
            CreateMissionOutcome::Uncertain
        );

        let (base, _t) = spawn_http("401 Unauthorized", "expired".into()).await;
        assert_eq!(
            backend(base).create_mission(&req).await,
            CreateMissionOutcome::AuthExpired
        );
    });
}

#[test]
fn creation_receipt_reconciles_created_rejected_unknown_and_401() {
    block_on(async {
        let (base, req_task) = spawn_http(
            "200 OK",
            json!({"requestId":"req-9","state":"created","mission":{"id":"msn_alpha123","revision":1}})
                .to_string(),
        )
        .await;
        assert_eq!(
            backend(base).creation_receipt("req-9").await,
            CreationReceiptOutcome::Created {
                mission_id: "msn_alpha123".into(),
                revision: 1
            }
        );
        assert!(
            req_task
                .await
                .unwrap()
                .starts_with("GET /api/workspaces/ws-1/missions/creation/req-9 ")
        );

        let (base, _t) = spawn_http(
            "200 OK",
            json!({"requestId":"other","state":"created","mission":{"id":"msn_alpha123","revision":1}})
                .to_string(),
        )
        .await;
        assert_eq!(
            backend(base).creation_receipt("req-9").await,
            CreationReceiptOutcome::Unknown
        );

        let (base, _t) = spawn_http(
            "200 OK",
            json!({"requestId":"req-9","state":"rejected"}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).creation_receipt("req-9").await,
            CreationReceiptOutcome::Rejected
        );

        let (base, _t) = spawn_http("401 Unauthorized", "expired".into()).await;
        assert_eq!(
            backend(base).creation_receipt("req-9").await,
            CreationReceiptOutcome::AuthExpired
        );
    });
}

#[test]
fn update_mission_handles_success_conflict_and_401() {
    block_on(async {
        let t = target();
        let req =
            UpdateMissionRequest::with_request_id("upd-1".into(), 2, "New objective", "Notes")
                .unwrap();

        let (base, req_task) = spawn_http(
            "200 OK",
            json!({"mission": sample_mission(3, "running")}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).update_mission(&t, &req).await,
            UpdateMissionOutcome::Updated {
                mission_id: "msn_alpha123".into(),
                revision: 3
            }
        );
        let raw = req_task.await.unwrap();
        assert!(raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_alpha123 "));
        assert!(raw.contains("\"expectedRevision\":2"));

        let (base, _t) = spawn_http(
            "409 Conflict",
            json!({"error":"changed","code":"revision-conflict"}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).update_mission(&t, &req).await,
            UpdateMissionOutcome::RevisionConflict
        );

        let (base, _t) = spawn_http("401 Unauthorized", "expired".into()).await;
        assert_eq!(
            backend(base).update_mission(&t, &req).await,
            UpdateMissionOutcome::AuthExpired
        );
    });
}

#[test]
fn read_editor_body_verifies_digest_and_detects_change() {
    block_on(async {
        let text = "Full mission objective";
        let digest = content_digest(text);
        let descriptor = BodyDescriptor {
            characters: utf16_len(text) as u64,
            digest: digest.clone(),
        };
        let slice_body = json!({
            "available": true,
            "version": 1,
            "projectID": "prj_1",
            "missionID": "msn_alpha123",
            "revision": 2,
            "content": {
                "kind": "mission",
                "field": "objective",
                "digest": digest,
                "offset": 0,
                "characters": descriptor.characters,
                "text": text,
                "next": null
            }
        });
        let (base, _t) = spawn_http("200 OK", slice_body.to_string()).await;
        let outcome = backend(base)
            .read_editor_body(
                "prj_1",
                "msn_alpha123",
                &ContentSelector::mission("objective"),
                &descriptor,
            )
            .await;
        assert_eq!(outcome, EditorBodyOutcome::Ready(text.into()));

        let changed_body = json!({
            "available": true,
            "version": 1,
            "projectID": "prj_1",
            "missionID": "msn_alpha123",
            "revision": 3,
            "refused": "content-changed"
        });
        let (base, _t) = spawn_http("200 OK", changed_body.to_string()).await;
        let outcome = backend(base)
            .read_editor_body(
                "prj_1",
                "msn_alpha123",
                &ContentSelector::mission("objective"),
                &descriptor,
            )
            .await;
        assert_eq!(outcome, EditorBodyOutcome::Changed);
    });
}
