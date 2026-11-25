use super::*;
use crate::{missions::editor_view, platform::reads::Reads, strings::t};
use codenomad_client::missions::{MapHeader, content_digest, utf16_len};
use rune::{Env, Runtime, edit::TextEdit};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

fn noop_wake() -> Wake {
    Arc::new(|| {})
}

fn test_backend(base: String) -> Backend {
    let mut b = Backend::unauthenticated(&base).unwrap();
    b.workspace = "ws-1".into();
    b
}

fn sample_header(
    revision: u64,
    objective: Option<&str>,
    notes: Option<&str>,
    run_state: &str,
) -> MapHeader {
    let mut bodies = serde_json::Map::new();
    if let Some(obj) = objective {
        bodies.insert(
            "objective".into(),
            json!({
                "characters": utf16_len(obj),
                "digest": content_digest(obj),
            }),
        );
    }
    if let Some(n) = notes {
        bodies.insert(
            "notes".into(),
            json!({
                "characters": utf16_len(n),
                "digest": content_digest(n),
            }),
        );
    }
    serde_json::from_value(json!({
        "root": {
            "id": "msn_alpha123",
            "title": "Existing title",
            "excerpt": objective.unwrap_or("Truncated excerpt"),
            "status": "active",
            "runState": run_state,
            "revision": revision,
            "projectID": "prj_1",
            "projectCanonical": "/repo",
            "coordinatorSessionId": "ses_coord1",
            "version": 1,
            "template": "debug",
            "taskMode": "independent",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "historyTruncated": false,
            "bodies": bodies
        },
        "tasks": {
            "page": {
                "order": "a".repeat(64),
                "offset": 0,
                "end": 0,
                "total": 0,
                "counts": {},
                "reports": 0,
                "attention": null
            },
            "pins": [],
            "reportPins": [],
            "version": "1"
        },
        "collections": {},
        "coordinator": {
            "kind": "coordinator",
            "sessionId": "ses_coord1",
            "location": { "directory": "/repo" }
        },
        "control": null
    }))
    .unwrap()
}

fn mission_json(revision: u64, run_state: &str) -> Value {
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

async fn read_http_request(socket: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut header_end = None;
    let mut content_len = 0usize;
    loop {
        let n = socket.read(&mut chunk).await.unwrap_or(0);
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

fn start_scripted_server(
    handler: impl Fn(usize, String) -> (String, String) + Send + Sync + 'static,
) -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_bg = calls.clone();
    let handler = Arc::new(handler);
    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            addr_tx.send(listener.local_addr().unwrap()).unwrap();
            while let Ok((mut socket, _)) = listener.accept().await {
                let n = calls_bg.fetch_add(1, Ordering::SeqCst);
                let handler = handler.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = handler(n, raw);
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let addr = addr_rx.recv().unwrap();
    (format!("http://{addr}/"), calls)
}

fn wait_until(mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for editor settlement"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn create_validation_blocks_empty_objective_multiline_title_and_compare() {
    let backend = test_backend("http://127.0.0.1:9/".into());
    let mut editor = Editor::default();
    editor.open_create(&backend, Some("missions-create".into()));
    let form = editor.form.as_mut().unwrap();
    assert!(
        !form.can_submit(None, None),
        "empty objective cannot submit"
    );

    form.objective = TextEdit::new("Deliver one-time editor");
    assert!(form.can_submit(None, None));

    form.title = TextEdit::new("Line 1\nLine 2");
    assert!(
        !form.can_submit(None, None),
        "multiline title must be rejected"
    );

    form.title = TextEdit::new("Valid title");
    form.template = Template::Compare;
    assert_eq!(
        form.compare_error(),
        Some("missions.compare.compare-models-required")
    );
    assert!(!form.can_submit(None, None));
}

#[test]
fn create_fresh_with_start_on_creation_dispatches_single_start_and_selects_mission() {
    let (base, calls) = start_scripted_server(|step, raw| {
        if step == 0 {
            assert!(raw.starts_with("POST /api/workspaces/ws-1/missions "));
            (
                "200 OK".into(),
                json!({
                    "acknowledgement": "fresh",
                    "mission": mission_json(1, "prepared")
                })
                .to_string(),
            )
        } else {
            assert!(raw.starts_with("POST /api/workspaces/ws-1/missions/msn_alpha123/control "));
            let body: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            let mut m = mission_json(2, "running");
            m["control"] = json!({
                "missionID": "msn_alpha123",
                "requestID": body["requestId"],
                "expectedRevision": 1,
                "completedRevision": 2,
                "action": "start",
                "pending": []
            });
            ("200 OK".into(), json!({ "mission": m }).to_string())
        }
    });
    let backend = test_backend(base);
    let wake = noop_wake();
    let mut editor = Editor::default();
    editor.open_create(&backend, Some("missions-create".into()));
    {
        let form = editor.form.as_mut().unwrap();
        form.objective = TextEdit::new("Ship feature");
        form.start_on_creation = true;
    }
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor.saved.is_some()
    });
    let saved = editor.take_saved().unwrap();
    assert_eq!(saved.mission_id, "msn_alpha123");
    assert_eq!(saved.revision, 2);
    assert!(saved.select);
    assert!(saved.closed_form);
    assert!(!editor.is_open());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn closing_or_auth_blocked_cancels_auto_start_and_preserves_later_draft() {
    let (base, calls) = start_scripted_server(|_step, raw| {
        assert!(raw.starts_with("POST /api/workspaces/ws-1/missions "));
        std::thread::sleep(Duration::from_millis(60));
        (
            "200 OK".into(),
            json!({
                "acknowledgement": "fresh",
                "mission": mission_json(1, "prepared")
            })
            .to_string(),
        )
    });
    let backend = test_backend(base.clone());
    let wake = noop_wake();
    let mut editor = Editor::default();
    editor.open_create(&backend, Some("missions-create".into()));
    {
        let form = editor.form.as_mut().unwrap();
        form.objective = TextEdit::new("First draft");
        form.start_on_creation = true;
    }
    assert!(editor.submit(&backend, &wake));
    // Closing revokes auto_start; reopening creates a newer form generation.
    editor.close();
    editor.open_create(&backend, None);
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor.saved.is_some()
    });
    let saved = editor.take_saved().unwrap();
    assert_eq!(saved.revision, 1);
    assert!(!saved.closed_form, "late ACK must not close the newer form");
    assert!(editor.is_open());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "must not POST /control after close"
    );

    // Same-tick 401 from reader/detail (`auth_blocked = true`) also blocks auto-start.
    let mut editor2 = Editor::default();
    editor2.open_create(&backend, None);
    {
        let form = editor2.form.as_mut().unwrap();
        form.objective = TextEdit::new("Blocked by 401");
        form.start_on_creation = true;
    }
    assert!(editor2.submit(&backend, &wake));
    wait_until(|| {
        editor2.poll(&backend, &wake, true);
        editor2.saved.is_some()
    });
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "must not POST /control when auth_blocked"
    );
}

#[test]
fn uncertain_creation_holds_request_across_close_reopen_and_reconciles_without_autostart() {
    let (base, calls) = start_scripted_server(|step, raw| {
        if step == 0 {
            assert!(raw.starts_with("POST /api/workspaces/ws-1/missions "));
            (
                "409 Conflict".into(),
                json!({"error":"uncertain","code":"creation-uncertain"}).to_string(),
            )
        } else {
            assert!(raw.starts_with("GET /api/workspaces/ws-1/missions/creation/"));
            (
                "200 OK".into(),
                json!({
                    "requestId": raw
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .rsplit('/')
                        .next()
                        .unwrap(),
                    "state": "created",
                    "mission": { "id": "msn_alpha123", "revision": 1 }
                })
                .to_string(),
            )
        }
    });
    let backend = test_backend(base);
    let wake = noop_wake();
    let mut editor = Editor::default();
    editor.open_create(&backend, Some("missions-create".into()));
    {
        let form = editor.form.as_mut().unwrap();
        form.objective = TextEdit::new("Keep idempotent");
        form.start_on_creation = true;
    }
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor
            .active_hold(&backend)
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });

    editor.close();
    assert!(!editor.is_open());
    assert!(editor.active_hold(&backend).is_some());
    editor.open_create(&backend, Some("missions-create".into()));
    assert_eq!(
        editor.form.as_ref().unwrap().objective.text,
        "Keep idempotent"
    );
    assert!(
        !editor.submit(&backend, &wake),
        "cannot submit while uncertain hold is active"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    assert!(editor.reconcile_creation(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor.saved.is_some()
    });
    let saved = editor.take_saved().unwrap();
    assert_eq!(saved.mission_id, "msn_alpha123");
    assert_eq!(saved.revision, 1);
    assert!(editor.active_hold(&backend).is_none());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "must not POST /control on recovered receipt"
    );
}

#[test]
fn uncertain_edit_persists_hold_across_close_and_reconciles_via_history_receipt() {
    let obj = "Full objective body";
    let header = sample_header(2, Some(obj), None, "running");
    let obj_digest = content_digest(obj);
    let req_id_seen = Arc::new(std::sync::Mutex::new(String::new()));
    let req_id_bg = req_id_seen.clone();
    let (base, _calls) = start_scripted_server(move |_step, raw| {
        if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_alpha123/content") {
            if raw.contains("field=objective") {
                (
                    "200 OK".into(),
                    json!({
                        "available": true,
                        "version": 1,
                        "projectID": "prj_1",
                        "missionID": "msn_alpha123",
                        "revision": 2,
                        "content": {
                            "kind": "mission",
                            "field": "objective",
                            "digest": obj_digest,
                            "offset": 0,
                            "characters": utf16_len(obj),
                            "text": obj,
                            "next": null
                        }
                    })
                    .to_string(),
                )
            } else {
                // Positive absence proof for notes.
                (
                    "200 OK".into(),
                    json!({
                        "available": true,
                        "version": 1,
                        "projectID": "prj_1",
                        "missionID": "msn_alpha123",
                        "revision": 2,
                        "refused": "content-not-found"
                    })
                    .to_string(),
                )
            }
        } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_alpha123 ") {
            let body: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            *req_id_bg.lock().unwrap() = body["requestId"].as_str().unwrap().to_owned();
            (
                "500 Internal Server Error".into(),
                json!({"error":"lost"}).to_string(),
            )
        } else {
            assert!(raw.starts_with("GET /api/workspaces/ws-1/missions/msn_alpha123 "));
            let rid = req_id_bg.lock().unwrap().clone();
            let mut m = mission_json(3, "running");
            m["history"] = json!([{
                "revision": 3,
                "source": "user",
                "requestID": rid,
                "objective": { "before": obj, "after": "Edited once" },
                "notes": { "before": "", "after": "" }
            }]);
            (
                "200 OK".into(),
                json!({"available": true, "mission": m}).to_string(),
            )
        }
    });
    let backend = test_backend(base);
    let reads = Reads::default();
    let wake = noop_wake();
    let mut editor = Editor::default();
    assert!(editor.open_edit(
        &header,
        &backend,
        &reads,
        &wake,
        Some("mission-edit".into())
    ));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    editor.form.as_mut().unwrap().objective = TextEdit::new("Edited once");
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor
            .active_edit_hold(&backend, "msn_alpha123")
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });

    // Closing visually keeps the EditHold; reopening adopts it and forbids Reopen or new submit.
    editor.close();
    assert!(editor.active_edit_hold(&backend, "msn_alpha123").is_some());
    assert!(editor.open_edit(
        &header,
        &backend,
        &reads,
        &wake,
        Some("mission-edit".into())
    ));
    assert_eq!(editor.form.as_ref().unwrap().objective.text, "Edited once");
    assert!(
        !editor.begin_reopen(&backend, 1),
        "cannot reopen while EditHold is active"
    );
    assert!(
        !editor.submit(&backend, &wake),
        "cannot submit second PATCH while EditHold is active"
    );

    // Reconciling against the exact history entry settles and releases EditHold.
    assert!(editor.reconcile_edit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor.saved.is_some()
    });
    let saved = editor.take_saved().unwrap();
    assert_eq!(saved.mission_id, "msn_alpha123");
    assert_eq!(saved.revision, 3);
    assert!(editor.active_edit_hold(&backend, "msn_alpha123").is_none());
}

#[test]
fn missing_objective_descriptor_refuses_prefill_without_exposing_excerpt() {
    let header = sample_header(2, None, None, "running");
    let backend = test_backend("http://127.0.0.1:9/".into());
    let reads = Reads::default();
    let wake = noop_wake();
    let mut editor = Editor::default();
    assert!(editor.open_edit(&header, &backend, &reads, &wake, None));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Failed)
    });
    let form = editor.form.as_ref().unwrap();
    assert!(
        form.objective.text.is_empty(),
        "excerpt must never be copied into objective field"
    );
    assert!(!form.can_submit(None, None));
}

#[test]
fn create_401_releases_hold_preserves_draft_and_surfaces_auth_expired() {
    let (base, _calls) =
        start_scripted_server(|_, _| ("401 Unauthorized".into(), "expired".into()));
    let backend = test_backend(base);
    let wake = noop_wake();
    let mut editor = Editor::default();
    editor.open_create(&backend, None);
    editor.form.as_mut().unwrap().objective = TextEdit::new("Need sign-in");
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor.auth_expired.is_some()
    });
    assert!(editor.take_auth_expired().is_some());
    assert!(editor.active_hold(&backend).is_none());
    assert_eq!(editor.form.as_ref().unwrap().objective.text, "Need sign-in");
}

#[test]
fn edit_conflict_reopens_from_newer_snapshot_and_saves() {
    let obj_v2 = "Objective v2";
    let obj_v3 = "Objective v3";
    let notes = "Original notes";
    let header_v2 = sample_header(2, Some(obj_v2), Some(notes), "running");
    let header_v3 = sample_header(3, Some(obj_v3), Some(notes), "running");
    let d_v2 = content_digest(obj_v2);
    let d_v3 = content_digest(obj_v3);
    let d_notes = content_digest(notes);
    let (base, _calls) = start_scripted_server(move |_step, raw| {
        if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_alpha123/content") {
            let (field, text, digest, rev) = if raw.contains(&d_v3) {
                ("objective", obj_v3, d_v3.as_str(), 3)
            } else if raw.contains("field=objective") {
                ("objective", obj_v2, d_v2.as_str(), 2)
            } else {
                ("notes", notes, d_notes.as_str(), 3)
            };
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_alpha123",
                    "revision": rev,
                    "content": {
                        "kind": "mission",
                        "field": field,
                        "digest": digest,
                        "offset": 0,
                        "characters": utf16_len(text),
                        "text": text,
                        "next": null
                    }
                })
                .to_string(),
            )
        } else {
            assert!(raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_alpha123 "));
            if raw.contains("\"expectedRevision\":2") {
                (
                    "409 Conflict".into(),
                    json!({"error":"changed","code":"revision-conflict"}).to_string(),
                )
            } else {
                (
                    "200 OK".into(),
                    json!({"mission": mission_json(4, "running")}).to_string(),
                )
            }
        }
    });
    let backend = test_backend(base);
    let reads = Reads::default();
    let wake = noop_wake();
    let mut editor = Editor::default();
    assert!(editor.open_edit(
        &header_v2,
        &backend,
        &reads,
        &wake,
        Some("mission-edit".into())
    ));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    assert_eq!(editor.form.as_ref().unwrap().objective.text, obj_v2);

    editor.form.as_mut().unwrap().objective = TextEdit::new("Stale edit");
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor.form.as_ref().is_some_and(|f| f.edit_conflict)
    });

    // Real Reopen flow: begin_reopen -> observe newer snapshot at revision 3 -> prefill v3 -> save v4.
    assert!(editor.begin_reopen(&backend, 1));
    let snap_v3 = Snapshot::from_header_for_test(header_v3);
    assert!(editor.observe_detail(Some(&snap_v3), 2, false, &backend, &reads, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    assert_eq!(editor.form.as_ref().unwrap().objective.text, obj_v3);
    editor.form.as_mut().unwrap().objective = TextEdit::new("Updated v4");
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake, false);
        editor.saved.is_some()
    });
    let saved = editor.take_saved().unwrap();
    assert_eq!(saved.revision, 4);
    assert!(saved.closed_form);
}

#[test]
fn editor_view_exposes_accessible_controls_and_uncertain_reconcile_button() {
    struct Host {
        panel: crate::missions::Panel,
        fallback: TextEdit,
        closed: bool,
    }
    let backend = test_backend("http://127.0.0.1:9/".into());
    let mut panel = crate::missions::Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let req = CreateMissionRequest::with_request_id(
        "req-hold".into(),
        "Held mission",
        None,
        "",
        Template::Custom,
        TaskMode::Native,
    )
    .unwrap();
    panel
        .editor
        .fixture_set_creation_hold(&backend, req, HoldState::Uncertain);
    panel.open_create_editor(Some("missions-create".into()));

    let mut rt = Runtime::new(
        Host {
            panel,
            fallback: TextEdit::new(""),
            closed: false,
        },
        |host, _| {
            editor_view(
                &host.panel,
                |h: &mut Host| (Some(&mut h.panel), &mut h.fallback),
                |h: &mut Host, _| {
                    h.closed = true;
                },
            )
        },
        (900.0, 700.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let elements = rt.elements();
    assert!(
        elements
            .iter()
            .any(|e| e.role == "region" && e.label.as_deref() == Some(t("missions.control.create")))
    );
    assert!(elements.iter().any(
        |e| e.role == "alert" && e.text.as_deref() == Some(t("missions.scheduling.uncertain"))
    ));
    assert!(
        elements.iter().any(
            |e| e.role == "button" && e.label.as_deref() == Some(t("missions.control.refresh"))
        )
    );
    assert!(
        elements
            .iter()
            .any(|e| e.role == "button" && e.label.as_deref() == Some(t("missions.control.cancel")))
    );
}
