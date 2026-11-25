use super::*;
use crate::{missions::editor_view, platform::reads::Reads, strings::t};
use codenomad_client::missions::{ContentSelector, MapHeader, content_digest, utf16_len};
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
    net::TcpListener,
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
    objective: &str,
    notes: Option<&str>,
    run_state: &str,
) -> MapHeader {
    let mut bodies = serde_json::Map::new();
    bodies.insert(
        "objective".into(),
        json!({
            "characters": utf16_len(objective),
            "digest": content_digest(objective),
        }),
    );
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
            "excerpt": objective,
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
                    let mut buf = vec![0u8; 32768];
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    let raw = String::from_utf8_lossy(&buf[..read]).into_owned();
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
    assert!(!form.can_submit(None), "empty objective cannot submit");

    form.objective = TextEdit::new("Deliver one-time editor");
    assert!(form.can_submit(None));

    form.title = TextEdit::new("Line 1\nLine 2");
    assert!(!form.can_submit(None), "multiline title must be rejected");

    form.title = TextEdit::new("Valid title");
    form.template = Template::Compare;
    assert_eq!(
        form.compare_error(),
        Some("missions.compare.compare-models-required")
    );
    assert!(!form.can_submit(None));
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
        editor.poll(&backend, &wake);
        editor.saved.is_some()
    });
    let saved = editor.take_saved().unwrap();
    assert_eq!(saved.mission_id, "msn_alpha123");
    assert_eq!(saved.revision, 2);
    assert!(saved.select);
    assert!(!editor.is_open());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
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
        editor.poll(&backend, &wake);
        editor
            .active_hold(&backend)
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });

    // Closing visually retains the uncertain hold; reopening adopts the exact request and blocks new submit.
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

    // Explicit reconciliation settles via GET /creation/{request} and never continues auto-start.
    assert!(editor.reconcile_creation(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake);
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
        editor.poll(&backend, &wake);
        editor.auth_expired.is_some()
    });
    assert!(editor.take_auth_expired().is_some());
    assert!(editor.active_hold(&backend).is_none());
    assert_eq!(editor.form.as_ref().unwrap().objective.text, "Need sign-in");
}

#[test]
fn edit_prefills_from_content_and_handles_revision_conflict_and_success() {
    let obj = "Full objective body";
    let notes = "Original notes";
    let header = sample_header(2, obj, Some(notes), "running");
    let obj_digest = content_digest(obj);
    let notes_digest = content_digest(notes);
    let (base, _calls) = start_scripted_server(move |_step, raw| {
        if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_alpha123/content") {
            let (field, text, digest) = if raw.contains("field=objective") {
                ("objective", obj, obj_digest.as_str())
            } else {
                ("notes", notes, notes_digest.as_str())
            };
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
            if raw.contains("trigger-conflict") {
                (
                    "409 Conflict".into(),
                    json!({"error":"changed","code":"revision-conflict"}).to_string(),
                )
            } else {
                (
                    "200 OK".into(),
                    json!({"mission": mission_json(3, "running")}).to_string(),
                )
            }
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
        editor.poll(&backend, &wake);
        editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    assert_eq!(editor.form.as_ref().unwrap().objective.text, obj);
    assert_eq!(editor.form.as_ref().unwrap().notes.text, notes);

    // 409 revision-conflict locks edit until reopened.
    editor.form.as_mut().unwrap().objective = TextEdit::new("trigger-conflict");
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake);
        editor.form.as_ref().is_some_and(|f| f.edit_conflict)
    });
    assert_eq!(
        editor.form.as_ref().unwrap().error,
        Some("missions.control.mutation.conflict")
    );
    assert!(!editor.submit(&backend, &wake));

    // Reopen fresh edit and save cleanly.
    let _ = ContentSelector::mission("objective");
    assert!(editor.open_edit(
        &header,
        &backend,
        &reads,
        &wake,
        Some("mission-edit".into())
    ));
    wait_until(|| {
        editor.poll(&backend, &wake);
        editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    editor.form.as_mut().unwrap().objective = TextEdit::new("Updated body");
    assert!(editor.submit(&backend, &wake));
    wait_until(|| {
        editor.poll(&backend, &wake);
        editor.saved.is_some()
    });
    let saved = editor.take_saved().unwrap();
    assert_eq!(saved.mission_id, "msn_alpha123");
    assert_eq!(saved.revision, 3);
    assert!(!saved.select);
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
