use super::*;
use serde_json::json;
use std::future::Future;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

fn block_on<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

async fn read_http_request(socket: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut header_end = None;
    let mut content_len = 0usize;
    loop {
        let n = socket.read(&mut chunk).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if header_end.is_none()
            && let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n")
        {
            header_end = Some(pos + 4);
            let headers = String::from_utf8_lossy(&buf[..pos]);
            for line in headers.lines() {
                if let Some((name, val)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    content_len = val.trim().parse().unwrap_or(0);
                }
            }
        }
        if let Some(end) = header_end
            && buf.len() >= end + content_len
        {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

async fn spawn_http(status: &str, body: String) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let status = status.to_owned();
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let req = read_http_request(&mut socket).await;
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
fn derives_single_line_clause_title_with_js_trim_and_utf16_bounds() {
    assert_eq!(
        derive_mission_title("\u{feff}  \n  Fix login. Also clean up"),
        "Fix login"
    );
    assert_eq!(
        derive_mission_title("Ship feature; then monitor"),
        "Ship feature"
    );
    assert_eq!(derive_mission_title("Ready? Yes"), "Ready?");
    assert_eq!(derive_mission_title("\u{feff}   \n\t  "), "");
    // U+0085 is NOT JS whitespace and must not be trimmed away.
    assert_eq!(js_trim("\u{feff}abc\u{a0}"), "abc");
    assert_eq!(js_trim("\u{0085}abc"), "\u{0085}abc");
    let long = "Audit every single background synchronization task across the whole desktop client repository";
    let derived = derive_mission_title(long);
    assert!(utf16_len(&derived) <= MISSION_TITLE_MAX);
    assert!(derived.ends_with('…'));
    assert!(!derived.contains('\n'));
}

#[test]
fn validates_create_and_update_inputs_with_utf16_surrogates() {
    assert!(
        CreateMissionRequest::new("\u{feff}   ", None, "", Template::Custom, TaskMode::Native)
            .is_err()
    );
    // 31 emoji = 62 UTF-16 code units (> 60) even though chars().count() == 31.
    let emoji_title = "😀".repeat(31);
    assert!(!valid_title_input(&emoji_title));
    assert!(valid_title_input(&"😀".repeat(30)));
    assert!(
        CreateMissionRequest::new(
            "Valid objective",
            Some(&emoji_title),
            "",
            Template::Custom,
            TaskMode::Native
        )
        .is_err()
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
    assert!(!valid_notes_input(&"😀".repeat(10_001)));
    let ok = CreateMissionRequest::new(
        "\u{feff} Ship fix \u{a0}",
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
                let raw = read_http_request(&mut socket).await;
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
fn create_mission_maps_uncertain_definitive_rejections_and_unterminated_401() {
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

        // 401 whose body never finishes must still return AuthExpired immediately on status line.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _hold = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            let _ = socket
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 9999\r\n\r\npartial")
                .await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        assert_eq!(
            backend(format!("http://{addr}/"))
                .create_mission(&req)
                .await,
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
fn update_mission_and_reconcile_edit_verify_exact_history_entry() {
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

        // Reconcile edit matches exact history entry (requestID + expectedRevision + 1 + after bodies).
        let mut mission = sample_mission(3, "running");
        mission["history"] = json!([{
            "revision": 3,
            "source": "user",
            "requestID": "upd-1",
            "objective": { "before": "Old", "after": "New objective" },
            "notes": { "before": "", "after": "Notes" }
        }]);
        let (base, _t) = spawn_http(
            "200 OK",
            json!({"available": true, "mission": mission}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).reconcile_mission_edit(&t, &req).await,
            EditReceiptOutcome::Applied {
                mission_id: "msn_alpha123".into(),
                revision: 3
            }
        );

        // Unrelated revision advance with different requestID stays Unconfirmed.
        let mut other = sample_mission(3, "running");
        other["history"] = json!([{
            "revision": 3,
            "source": "user",
            "requestID": "other-req",
            "objective": { "before": "Old", "after": "Different" },
            "notes": { "before": "", "after": "" }
        }]);
        let (base, _t) = spawn_http(
            "200 OK",
            json!({"available": true, "mission": other}).to_string(),
        )
        .await;
        assert_eq!(
            backend(base).reconcile_mission_edit(&t, &req).await,
            EditReceiptOutcome::Unconfirmed
        );
    });
}

#[test]
fn read_editor_body_verifies_digest_and_confirms_absent_notes() {
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

        // Positive absence proof for notes (content-not-found -> Ready("")).
        let absent_body = json!({
            "available": true,
            "version": 1,
            "projectID": "prj_1",
            "missionID": "msn_alpha123",
            "revision": 2,
            "refused": "content-not-found"
        });
        let (base, _t) = spawn_http("200 OK", absent_body.to_string()).await;
        assert_eq!(
            backend(base)
                .confirm_absent_editor_body(
                    "prj_1",
                    "msn_alpha123",
                    &ContentSelector::mission("notes")
                )
                .await,
            EditorBodyOutcome::Ready(String::new())
        );

        let changed_body = json!({
            "available": true,
            "version": 1,
            "projectID": "prj_1",
            "missionID": "msn_alpha123",
            "revision": 3,
            "refused": "content-changed"
        });
        let (base, _t) = spawn_http("200 OK", changed_body.to_string()).await;
        assert_eq!(
            backend(base)
                .read_editor_body(
                    "prj_1",
                    "msn_alpha123",
                    &ContentSelector::mission("objective"),
                    &descriptor,
                )
                .await,
            EditorBodyOutcome::Changed
        );
    });
}
