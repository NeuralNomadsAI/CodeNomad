use super::*;
use crate::{
    missions::{Lifecycle, Panel, editor_view},
    platform::reads::Reads,
    strings::t,
};
use codenomad_client::missions::{LifecycleOutcome, MapHeader, content_digest, utf16_len};
use rune::{Env, Runtime, edit::TextEdit};
use rune_theme_codenomad::layout::Layout;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
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

fn attested_backend(base: String) -> Backend {
    let mut b = Backend::unauthenticated(&base).unwrap();
    b.workspace = "ws-1".into();
    let cloned = b.clone();
    let id = crate::platform::block_on(async move { cloned.attest_server().await.unwrap() });
    assert_eq!(id, "fixture-server");
    b
}

fn unattested_backend(base: String) -> Backend {
    let mut b = Backend::unauthenticated(&base).unwrap();
    b.workspace = "ws-1".into();
    b
}

fn sample_header_for(
    mission_id: &str,
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
            "id": mission_id,
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
        "control": null
    }))
    .unwrap()
}

fn sample_header(
    revision: u64,
    objective: Option<&str>,
    notes: Option<&str>,
    run_state: &str,
) -> MapHeader {
    sample_header_for("msn_alpha123", revision, objective, notes, run_state)
}

fn mission_json_for(mission_id: &str, revision: u64, run_state: &str) -> Value {
    json!({
        "id": mission_id,
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
        }],
        "control": null
    })
}

fn mission_json(revision: u64, run_state: &str) -> Value {
    mission_json_for("msn_alpha123", revision, run_state)
}

async fn read_http_request(socket: &mut TcpStream) -> String {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let mut header_end = None;
    let mut content_length = 0usize;
    loop {
        let n = socket.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        if header_end.is_none()
            && let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n")
        {
            header_end = Some(pos + 4);
            let head = String::from_utf8_lossy(&raw[..pos]);
            for line in head.lines() {
                if let Some((k, v)) = line.split_once(':')
                    && k.trim().eq_ignore_ascii_case("content-length")
                {
                    content_length = v.trim().parse().unwrap_or(0);
                }
            }
        }
        if let Some(end) = header_end
            && raw.len() >= end + content_length
        {
            break;
        }
    }
    String::from_utf8_lossy(&raw).into_owned()
}

fn start_scripted_server<F>(handler: F) -> (String, Arc<AtomicUsize>)
where
    F: Fn(usize, String) -> (String, String) + Send + Sync + 'static,
{
    start_scripted_server_raw(move |idx, raw| {
        if raw.starts_with("GET /api/storage/config/ui") {
            ("200 OK".to_owned(), json!({"settings": {}}).to_string())
        } else {
            handler(idx, raw)
        }
    })
}

fn start_scripted_server_raw<F>(handler: F) -> (String, Arc<AtomicUsize>)
where
    F: Fn(usize, String) -> (String, String) + Send + Sync + 'static,
{
    let count = Arc::new(AtomicUsize::new(0));
    let count_bg = count.clone();
    let handler = Arc::new(handler);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let raw = read_http_request(&mut socket).await;
                let (status, body) = if raw.starts_with("GET /api/meta ") {
                    (
                        "200 OK".to_owned(),
                        json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                    )
                } else if raw.starts_with("GET /api/storage/config/ui") {
                    handler(count_bg.load(Ordering::SeqCst), raw)
                } else {
                    let idx = count_bg.fetch_add(1, Ordering::SeqCst);
                    handler(idx, raw)
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
    });
    let base = rx.recv().unwrap();
    (base, count)
}

fn open_create_ready(
    panel: &mut Panel,
    holds: &mut EditorHolds,
    lifecycle: &mut Lifecycle,
    return_focus: Option<String>,
) {
    panel.open_create_editor(holds, return_focus);
    wait_until(|| {
        poll_step(panel, "tab-1", holds, lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.defaults_state == DefaultsState::Ready)
    });
}

fn wait_until(mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("condition did not settle within deadline");
}

fn poll_step(
    panel: &mut Panel,
    occurrence: &str,
    holds: &mut EditorHolds,
    lifecycle: &mut Lifecycle,
) -> (
    Vec<Backend>,
    Vec<(
        super::super::lifecycle::MissionKey,
        LifecycleTarget,
        LifecycleOutcome,
    )>,
) {
    let lc_finished = lifecycle.poll();
    let mut auth = lifecycle.drain_auth_expired();
    if panel.take_editor_auto_start_revoked() {
        holds.revoke_auto_start_for_occurrence(occurrence);
    }
    panel.observe_editor_detail(holds);
    panel.poll();
    panel.observe_editor_detail(holds);
    auth.extend(panel.drain_auth_expired());
    let active = panel.active_editor(occurrence);
    let (_, events) = holds.poll(active, &auth, lifecycle);
    auth.extend(holds.drain_auth_expired());
    panel.commit_editor_submit(holds, &auth);
    panel.apply_editor_events(occurrence, &events);
    (auth, lc_finished)
}

#[test]
fn create_validation_blocks_empty_objective_multiline_title_and_compare() {
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let scope = CreationScopeKey::new(&backend, &backend.workspace);
    let mut holds = EditorHolds::default();
    let mut editor = Editor::default();
    editor.open_create(
        &scope,
        &backend,
        &mut holds,
        &Reads::default(),
        &noop_wake(),
        Some("missions-create".into()),
    );
    let form = editor.form.as_mut().unwrap();
    form.objective = TextEdit::new("Investigate flaky build");
    assert!(
        !form.can_submit(None, None),
        "cannot submit before mission defaults load"
    );

    form.defaults_state = DefaultsState::Ready;
    form.objective = TextEdit::new("");
    assert!(
        !form.can_submit(None, None),
        "empty objective cannot submit"
    );

    form.objective = TextEdit::new("Investigate flaky build");
    assert!(form.can_submit(None, None));
    assert_eq!(form.derived_title(), "Investigate flaky build");

    form.title = TextEdit::new("Line 1\nLine 2");
    assert!(title_limit_exceeded(&form.title.text));
    assert!(!form.can_submit(None, None));

    form.title = TextEdit::new("");
    form.select_template(Template::Compare);
    assert_eq!(
        form.compare_error(),
        Some("missions.compare.compare-models-required")
    );
    assert!(!form.can_submit(None, None));
}

#[test]
fn create_fresh_with_start_on_creation_uses_shared_lifecycle_and_retains_uncertain_play_identity() {
    let control_req_id = Arc::new(Mutex::new(String::new()));
    let control_req_bg = control_req_id.clone();
    let (base, calls) = start_scripted_server(move |idx, raw| {
        if idx == 0 {
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
            assert_eq!(body["action"], "start");
            *control_req_bg.lock().unwrap() = body["requestId"].as_str().unwrap().to_owned();
            // Simulate lost/uncertain Play response: shared Lifecycle MUST keep its identity.
            (
                "500 Internal Server Error".into(),
                json!({"error": "lost"}).to_string(),
            )
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Ship editor");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;
    panel.submit_editor("tab-1", &mut holds);

    let mut settled_play = None;
    wait_until(|| {
        let (_, finished) = poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        if let Some((_, _, outcome)) = finished.first() {
            settled_play = Some(*outcome);
        }
        !panel.has_editor() && settled_play.is_some()
    });
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(panel.selected.as_deref(), Some("msn_alpha123"));
    assert_eq!(settled_play, Some(LifecycleOutcome::Unconfirmed));

    // Shared Lifecycle retained the original Start request ID and blocks a duplicate Play.
    let header = sample_header(1, Some("Ship editor"), None, "prepared");
    let source = super::super::lifecycle::Source::new("tab-1", &backend, &header).unwrap();
    assert!(
        lifecycle.unresolved(&source, &header),
        "uncertain auto-start must remain held in shared Lifecycle"
    );
    assert!(
        !lifecycle.idle(&source, &header),
        "duplicate Play cannot overwrite the original Start intent"
    );
    assert!(!control_req_id.lock().unwrap().is_empty());
}

#[test]
fn same_cycle_patch_401_blocks_fresh_create_autostart() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (patch_seen_tx, patch_seen_rx) = std::sync::mpsc::channel();
    let patch_seen_tx = Arc::new(std::sync::Mutex::new(Some(patch_seen_tx)));
    let release_both = Arc::new(tokio::sync::Barrier::new(2));
    let release_both_bg = release_both.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let control_c = control_calls_bg.clone();
                let patch_seen = patch_seen_tx.clone();
                let release_b = release_both_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body): (&str, String) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_alpha123 ") {
                        if let Some(tx) = patch_seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        release_b.wait().await;
                        ("401 Unauthorized", "expired".into())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        release_b.wait().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_new1", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/control ") {
                        control_c.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", json!({}).to_string())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let (wake_tx, wake_rx) = bounded(16);
    let wake: Wake = Arc::new(move || {
        let _ = wake_tx.try_send(());
    });
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        wake.clone(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    // 1. Submit PATCH on msn_alpha123, then close Edit (PATCH stays in flight).
    let header = sample_header(2, Some("Original"), None, "running");
    let target = EditTarget::from_header(&header);
    let edit_req = UpdateMissionRequest::new(2, "Edited", "").unwrap();
    assert!(holds.start_edit(
        target.hold_key(&backend),
        target.target,
        edit_req,
        super::super::editor_holds::FormOrigin {
            occurrence: "tab-1".into(),
            generation: 1,
            backend: backend.clone(),
        },
        &backend,
        &wake,
    ));
    patch_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("PATCH must reach test server");

    // 2. Open Create with start_on_creation=true and submit; both PATCH 401 and Create fresh complete before poll!
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    wait_until(|| {
        panel.poll();
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.defaults_state == DefaultsState::Ready)
    });
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Fresh mission");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;
    while wake_rx.try_recv().is_ok() {}
    panel.submit_editor("tab-1", &mut holds);
    // Expect 3 wakes: 1 synchronous from submit_editor + 2 async (PATCH 401 + Create fresh).
    crate::platform::block_on(async {
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(3), wake_rx.recv())
                .await
                .expect("both PATCH 401 and Create fresh replies must arrive")
                .unwrap();
        }
    });
    let (auth, _) = poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
    assert_eq!(
        auth.len(),
        1,
        "PATCH 401 must surface in the same poll cycle"
    );
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "same-cycle PATCH 401 must prevent fresh Create from dispatching /control"
    );
}

#[test]
fn late_create_ack_invalidates_without_hijacking_selection_or_open_edit_form() {
    let release = Arc::new(std::sync::Barrier::new(2));
    let release_bg = release.clone();
    let (base, _calls) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            release_bg.wait();
            (
                "200 OK".into(),
                json!({
                    "acknowledgement": "fresh",
                    "mission": mission_json_for("msn_created_a", 1, "prepared")
                })
                .to_string(),
            )
        } else if raw.contains("/content?") && raw.contains("field=objective") {
            let text = "Mission B objective";
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_edit_b",
                    "revision": 2,
                    "content": {
                        "kind": "mission",
                        "field": "objective",
                        "digest": content_digest(text),
                        "offset": 0,
                        "characters": utf16_len(text),
                        "text": text,
                        "next": null
                    }
                })
                .to_string(),
            )
        } else {
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_edit_b",
                    "revision": 2,
                    "refused": "content-not-found"
                })
                .to_string(),
            )
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    // Start Create for A, then close it and open Edit for B before A's ACK returns.
    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Mission A");
    panel.submit_editor("tab-1", &mut holds);
    panel.close_reader();

    panel.selected = Some("msn_edit_b".into());
    let header_b = sample_header_for(
        "msn_edit_b",
        2,
        Some("Mission B objective"),
        None,
        "running",
    );
    let scope = panel.creation_scope_key();
    assert!(panel.editor.open_edit(
        &header_b,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        Some("mission-edit".into()),
    ));

    // Release delayed Create ACK for A.
    release.wait();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds.creation(&scope).is_none()
    });

    assert_eq!(
        panel.selected.as_deref(),
        Some("msn_edit_b"),
        "late Create ACK must never hijack selection away from B"
    );
    assert_eq!(
        panel.editor.editing_mission_id(),
        Some("msn_edit_b"),
        "late Create ACK must leave the open Edit form on B untouched"
    );
}

#[test]
fn independent_edit_holds_survive_switching_missions_and_tab_close() {
    let req_ids = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let req_ids_bg = req_ids.clone();
    let (base, _calls) = start_scripted_server(move |_idx, raw| {
        if raw.contains("/content?") && raw.contains("field=objective") {
            let mid = if raw.contains("msn_edit_a") {
                "msn_edit_a"
            } else {
                "msn_edit_b"
            };
            let text = if mid == "msn_edit_a" {
                "Objective A"
            } else {
                "Objective B"
            };
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": mid,
                    "revision": 2,
                    "content": {
                        "kind": "mission",
                        "field": "objective",
                        "digest": content_digest(text),
                        "offset": 0,
                        "characters": utf16_len(text),
                        "text": text,
                        "next": null
                    }
                })
                .to_string(),
            )
        } else if raw.contains("/content?") && raw.contains("field=notes") {
            let mid = if raw.contains("msn_edit_a") {
                "msn_edit_a"
            } else {
                "msn_edit_b"
            };
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": mid,
                    "revision": 2,
                    "refused": "content-not-found"
                })
                .to_string(),
            )
        } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/") {
            let mid = if raw.contains("msn_edit_a") {
                "msn_edit_a"
            } else {
                "msn_edit_b"
            };
            let body: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            req_ids_bg
                .lock()
                .unwrap()
                .push((mid.into(), body["requestId"].as_str().unwrap().into()));
            (
                "500 Internal Server Error".into(),
                json!({"error": "lost"}).to_string(),
            )
        } else if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_") {
            let mid = if raw.contains("msn_edit_a") {
                "msn_edit_a"
            } else {
                "msn_edit_b"
            };
            let rid = req_ids_bg
                .lock()
                .unwrap()
                .iter()
                .find(|(m, _)| m == mid)
                .map(|(_, id)| id.clone())
                .unwrap();
            let after = if mid == "msn_edit_a" {
                "Edited A"
            } else {
                "Edited B"
            };
            let mut m = mission_json_for(mid, 3, "running");
            m["history"] = json!([{
                "revision": 3,
                "source": "user",
                "requestID": rid,
                "objective": { "before": "Old", "after": after },
                "notes": { "before": "", "after": "" }
            }]);
            (
                "200 OK".into(),
                json!({"available": true, "mission": m}).to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    let header_a = sample_header_for("msn_edit_a", 2, Some("Objective A"), None, "running");
    let header_b = sample_header_for("msn_edit_b", 2, Some("Objective B"), None, "running");
    let key_a = EditHoldKey::new(&backend, "prj_1", "msn_edit_a");
    let key_b = EditHoldKey::new(&backend, "prj_1", "msn_edit_b");

    // Tab 1: uncertain edit on A, then switch to B and trigger uncertain edit on B.
    {
        let mut panel = Panel::new(
            backend.clone(),
            Some("prj_1".into()),
            Reads::default(),
            noop_wake(),
        )
        .with_owner_scope("/repo".into());
        let scope = panel.creation_scope_key();
        assert!(panel.editor.open_edit(
            &header_a,
            &scope,
            &backend,
            &mut holds,
            &panel.reads,
            &panel.wake,
            None
        ));
        wait_until(|| {
            poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
            panel
                .editor
                .form
                .as_ref()
                .is_some_and(|f| f.prefill == PrefillState::Ready)
        });
        panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Edited A");
        panel.submit_editor("tab-1", &mut holds);
        wait_until(|| {
            poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
            holds
                .edit(&key_a)
                .is_some_and(|h| h.state == HoldState::Uncertain)
        });
        panel.close_reader();

        assert!(panel.editor.open_edit(
            &header_b,
            &scope,
            &backend,
            &mut holds,
            &panel.reads,
            &panel.wake,
            None
        ));
        wait_until(|| {
            poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
            panel
                .editor
                .form
                .as_ref()
                .is_some_and(|f| f.prefill == PrefillState::Ready)
        });
        panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Edited B");
        panel.submit_editor("tab-1", &mut holds);
        wait_until(|| {
            poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
            holds
                .edit(&key_b)
                .is_some_and(|h| h.state == HoldState::Uncertain)
        });
    } // Tab 1 closed and Panel dropped!

    // Tab 2 reopened on the same project: BOTH A and B holds survived!
    assert!(
        holds.edit(&key_a).is_some(),
        "Mission A hold survived editing B and tab close"
    );
    assert!(
        holds.edit(&key_b).is_some(),
        "Mission B hold survived tab close"
    );

    let mut panel2 = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    )
    .with_owner_scope("/repo".into());
    let scope2 = panel2.creation_scope_key();
    assert!(panel2.editor.open_edit(
        &header_a,
        &scope2,
        &backend,
        &mut holds,
        &panel2.reads,
        &panel2.wake,
        None
    ));
    assert_eq!(
        panel2.editor.form.as_ref().unwrap().objective.text,
        "Edited A"
    );
    assert!(!panel2.editor.begin_reopen(&backend, &holds, 1));
    panel2.reconcile_editor_edit("tab-2", &mut holds);
    wait_until(|| {
        poll_step(&mut panel2, "tab-2", &mut holds, &mut lifecycle);
        holds.edit(&key_a).is_none()
    });
    assert!(
        holds.edit(&key_b).is_some(),
        "reconciling A keeps B hold intact"
    );
}

#[test]
fn uncertain_creation_holds_across_tab_close_and_reconciles_without_autostart() {
    let seen_req_id = Arc::new(Mutex::new(String::new()));
    let seen_bg = seen_req_id.clone();
    let (base, calls) = start_scripted_server(move |idx, raw| {
        if idx == 0 {
            let body: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            *seen_bg.lock().unwrap() = body["requestId"].as_str().unwrap().to_owned();
            (
                "409 Conflict".into(),
                json!({"error":"uncertain","code":"creation-uncertain"}).to_string(),
            )
        } else {
            let rid = seen_bg.lock().unwrap().clone();
            assert!(raw.starts_with(&format!(
                "GET /api/workspaces/ws-1/missions/creation/{rid} "
            )));
            (
                "200 OK".into(),
                json!({
                    "requestId": rid,
                    "state": "created",
                    "mission": { "id": "msn_recovered", "revision": 1 }
                })
                .to_string(),
            )
        }
    });
    let backend = attested_backend(base);
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    )
    .with_owner_scope("/repo".into());
    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Recover me");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;
    panel.submit_editor("tab-1", &mut holds);
    let scope = panel.creation_scope_key();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds
            .creation(&scope)
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });
    panel.close_reader();

    // Reopening Create in the same workspace occurrence adopts the uncertain CreationHold
    // and reconciles without auto-start.
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Recover me"
    );
    panel.reconcile_editor_creation("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        !panel.has_editor()
    });
    assert_eq!(panel.selected.as_deref(), Some("msn_recovered"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "reconciled creation never fires /control auto-start"
    );

    // A reopened tab with a new workspace UUID (ws-2) must NOT inherit ws-1's creation hold
    // (whose server receipt was bound to closed ws-1), preventing an unrecoverable `unknown` lock.
    let mut ws1_holds = EditorHolds::default();
    let (ws1_base, _) = start_scripted_server(|_idx, raw| {
        if raw.starts_with("POST ") {
            ("500 Internal Server Error".into(), "{}".into())
        } else {
            (
                "200 OK".into(),
                json!({"requestId": "x", "state": "unknown"}).to_string(),
            )
        }
    });
    let mut ws1_backend = attested_backend(ws1_base.clone());
    ws1_backend.workspace = "ws-1".into();
    let mut ws2_backend = attested_backend(ws1_base);
    ws2_backend.workspace = "ws-2".into();
    let mut old_panel = Panel::new(
        ws1_backend,
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    )
    .with_owner_scope("/repo".into());
    open_create_ready(&mut old_panel, &mut ws1_holds, &mut lifecycle, None);
    old_panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Closed workspace");
    old_panel.submit_editor("tab-old", &mut ws1_holds);
    let old_scope = old_panel.creation_scope_key();
    wait_until(|| {
        poll_step(&mut old_panel, "tab-old", &mut ws1_holds, &mut lifecycle);
        ws1_holds
            .creation(&old_scope)
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });
    drop(old_panel);
    let mut new_panel = Panel::new(
        ws2_backend,
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    )
    .with_owner_scope("/repo".into());
    new_panel.open_create_editor(&mut ws1_holds, None);
    assert!(
        new_panel
            .editor
            .active_hold(&new_panel.creation_scope_key(), &ws1_holds)
            .is_none(),
        "new workspace occurrence ws-2 must not be stuck on closed ws-1's server-inaccessible receipt"
    );
}

#[test]
fn closing_edit_cancels_queued_and_inflight_preview_slot_immediately() {
    let http_hits = Arc::new(AtomicUsize::new(0));
    let http_hits_bg = http_hits.clone();
    let (base, _) = start_scripted_server(move |_idx, _raw| {
        http_hits_bg.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_secs(3));
        ("200 OK".into(), "{}".into())
    });
    let backend = attested_backend(base);
    let reads = Reads::default();
    let wake = noop_wake();
    let header = sample_header(2, Some("Queued body"), None, "running");
    let scope = CreationScopeKey::new(&backend, &backend.workspace);
    let mut holds = EditorHolds::default();
    let mut editor = Editor::default();

    // Case 1: Preview permit held by another consumer -> open_edit queues -> close() cancels before permit releases -> 0 HTTP requests.
    let (_cancel_tx, alive) = bounded(1);
    let permit = crate::platform::block_on(reads.preview(&alive)).unwrap();
    assert!(editor.open_edit(&header, &scope, &backend, &mut holds, &reads, &wake, None));
    editor.close();
    drop(permit);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        http_hits.load(Ordering::SeqCst),
        0,
        "closing edit while queued for Reads::preview must cancel without issuing HTTP"
    );

    // Case 2: In-flight HTTP hanging while holding Reads::preview -> close() drops HTTP future and frees preview slot immediately.
    assert!(editor.open_edit(&header, &scope, &backend, &mut holds, &reads, &wake, None));
    wait_until(|| http_hits.load(Ordering::SeqCst) >= 1);
    editor.close();
    let reacquired = crate::platform::block_on(async {
        tokio::time::timeout(Duration::from_millis(300), reads.preview(&alive))
            .await
            .ok()
            .flatten()
    });
    assert!(
        reacquired.is_some(),
        "closing edit must immediately cancel in-flight prefill and release Reads::preview"
    );
}

#[test]
fn missing_objective_descriptor_refuses_prefill_without_exposing_excerpt() {
    let header = sample_header(2, None, None, "running");
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let scope = CreationScopeKey::new(&backend, &backend.workspace);
    let mut holds = EditorHolds::default();
    let mut editor = Editor::default();
    assert!(editor.open_edit(
        &header,
        &scope,
        &backend,
        &mut holds,
        &Reads::default(),
        &noop_wake(),
        None,
    ));
    wait_until(|| {
        editor.poll_prefill();
        editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Failed)
    });
    let form = editor.form.as_ref().unwrap();
    assert!(form.objective.text.is_empty());
    assert!(!form.can_submit(None, None));
}

#[test]
fn auth_401_retains_holds_and_lifecycle_play_as_uncertain_while_409_finished_releases_hold() {
    let post_calls = Arc::new(AtomicUsize::new(0));
    let post_calls_bg = post_calls.clone();
    let (base, _calls) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            post_calls_bg.fetch_add(1, Ordering::SeqCst);
            ("401 Unauthorized".into(), "expired".into())
        } else if let Some(rest) = raw.strip_prefix("GET /api/workspaces/ws-1/missions/creation/") {
            let req_id = rest.split_whitespace().next().unwrap_or("");
            (
                "200 OK".into(),
                json!({
                    "requestId": req_id,
                    "state": "created",
                    "mission": mission_json_for("msn_from_401", 1, "prepared")
                })
                .to_string(),
            )
        } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_alpha123 ")
            || raw.starts_with("POST /api/workspaces/ws-1/missions/msn_alpha123/control ")
        {
            ("401 Unauthorized".into(), "expired".into())
        } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_finished ") {
            (
                "409 Conflict".into(),
                json!({"error": "Only active missions can be edited", "code": "mission-finished"})
                    .to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    // 1. 401 on Create surfaces auth_expired, keeps CreationHold as Uncertain (with original ID),
    //    preserves draft, and reconciles via read-only receipt without replaying POST.
    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Keep draft");
    panel.submit_editor("tab-1", &mut holds);
    let scope = panel.creation_scope_key();
    let orig_create_id = holds.creation(&scope).unwrap().request.request_id.clone();
    let mut expired = Vec::new();
    wait_until(|| {
        let (auth, _) = poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        if !auth.is_empty() {
            expired = auth;
        }
        !expired.is_empty()
    });
    let held_create = holds
        .creation(&scope)
        .expect("401 on POST /missions must retain CreationHold as Uncertain");
    assert_eq!(held_create.state, HoldState::Uncertain);
    assert_eq!(held_create.request.request_id, orig_create_id);
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Keep draft"
    );
    // Reconciling via read-only creation receipt clears the hold without replaying POST.
    panel.reconcile_editor_creation("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds.creation(&scope).is_none()
    });
    assert_eq!(post_calls.load(Ordering::SeqCst), 1);

    // 2. 401 on PATCH surfaces auth_expired and retains EditHold as Uncertain with original ID.
    let header_401 = sample_header(2, Some("Original"), None, "running");
    assert!(panel.editor.open_edit(
        &header_401,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        None
    ));
    let form = panel.editor.form.as_mut().unwrap();
    form.prefill = PrefillState::Ready;
    form.has_loaded_draft = true;
    form.objective = TextEdit::new("Keep edit draft");
    panel.submit_editor("tab-1", &mut holds);
    let key_401 = EditHoldKey::new(&backend, "prj_1", "msn_alpha123");
    let orig_edit_id = holds.edit(&key_401).unwrap().request.request_id.clone();
    let mut edit_expired = Vec::new();
    wait_until(|| {
        let (auth, _) = poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        if !auth.is_empty() {
            edit_expired = auth;
        }
        !edit_expired.is_empty()
    });
    let held_edit = holds
        .edit(&key_401)
        .expect("401 on PATCH must retain EditHold as Uncertain");
    assert_eq!(held_edit.state, HoldState::Uncertain);
    assert_eq!(held_edit.request.request_id, orig_edit_id);
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Keep edit draft"
    );

    // 3. 401 on POST /control (Lifecycle Play) surfaces auth_expired and retains the Play intent.
    let prepared_header = sample_header(1, Some("Prepared"), None, "prepared");
    let source = super::super::lifecycle::Source::new("tab-1", &backend, &prepared_header).unwrap();
    let play_req = codenomad_client::missions::LifecycleRequest::new(
        codenomad_client::missions::LifecycleAction::Start,
        1,
        false,
    )
    .unwrap();
    lifecycle.start(&source, play_req, None, backend.clone(), noop_wake());
    let mut lc_expired = Vec::new();
    wait_until(|| {
        let (auth, _) = poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        if !auth.is_empty() {
            lc_expired = auth;
        }
        !lc_expired.is_empty()
    });
    assert!(
        lifecycle.unresolved(&source, &prepared_header),
        "401 on POST /control must retain Lifecycle Play intent as unresolved for reconciliation"
    );

    // 4. 409 mission-finished on Edit releases EditHold (definitive pre-write rejection) and preserves draft.
    let header_fin = sample_header_for("msn_finished", 2, Some("Original"), None, "running");
    assert!(panel.editor.open_edit(
        &header_fin,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        None
    ));
    let form = panel.editor.form.as_mut().unwrap();
    form.prefill = PrefillState::Ready;
    form.has_loaded_draft = true;
    form.objective = TextEdit::new("Attempt on finished");
    panel.submit_editor("tab-1", &mut holds);
    let key_fin = EditHoldKey::new(&backend, "prj_1", "msn_finished");
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.error.is_some())
    });
    assert!(
        holds.edit(&key_fin).is_none(),
        "409 mission-finished must release EditHold immediately"
    );
    assert_eq!(
        panel.editor.form.as_ref().unwrap().error,
        Some("missions.scheduling.lock.terminal")
    );
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Attempt on finished"
    );
}

#[test]
fn edit_conflict_reopen_preserves_draft_on_failure_and_keeps_copyable_previous_draft() {
    let obj_v2 = "Objective v2";
    let obj_v3 = "Objective v3";
    let header_v2 = sample_header(2, Some(obj_v2), None, "running");
    let header_v3 = sample_header(3, Some(obj_v3), None, "running");
    let v3_attempts = Arc::new(AtomicUsize::new(0));
    let v3_attempts_bg = v3_attempts.clone();
    let (base, _calls) = start_scripted_server(move |_idx, raw| {
        if raw.contains("/content?") && raw.contains("field=objective") {
            let is_v3 = raw.contains(&content_digest(obj_v3));
            if is_v3 && v3_attempts_bg.fetch_add(1, Ordering::SeqCst) == 0 {
                // First Reopen prefill fails: user's conflicted draft MUST stay intact!
                return (
                    "503 Service Unavailable".into(),
                    json!({"error": "down"}).to_string(),
                );
            }
            let text = if is_v3 { obj_v3 } else { obj_v2 };
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_alpha123",
                    "revision": if is_v3 { 3 } else { 2 },
                    "content": {
                        "kind": "mission",
                        "field": "objective",
                        "digest": content_digest(text),
                        "offset": 0,
                        "characters": utf16_len(text),
                        "text": text,
                        "next": null
                    }
                })
                .to_string(),
            )
        } else if raw.contains("/content?") && raw.contains("field=notes") {
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_alpha123",
                    "revision": 3,
                    "refused": "content-not-found"
                })
                .to_string(),
            )
        } else {
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
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    let scope = panel.creation_scope_key();

    assert!(panel.editor.open_edit(
        &header_v2,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        Some("mission-edit".into())
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("My conflicted draft");
    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.editor.form.as_ref().is_some_and(|f| f.edit_conflict)
    });

    // First Reopen fails prefill -> conflicted draft is NOT wiped!
    assert!(panel.editor.begin_reopen(&backend, &holds, 1));
    let snap_v3 = Snapshot::from_header_for_test(header_v3);
    assert!(panel.editor.observe_detail(
        Some(&snap_v3),
        2,
        0,
        &backend,
        &holds,
        &panel.reads,
        &panel.wake,
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.reopening.is_none())
    });
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "My conflicted draft",
        "failed Reopen must keep the user's conflicted draft untouched"
    );
    assert!(panel.editor.form.as_ref().unwrap().edit_conflict);

    // Second Reopen succeeds -> adopts v3 AND retains copyable previous_draft!
    assert!(panel.editor.begin_reopen(&backend, &holds, 2));
    assert!(panel.editor.observe_detail(
        Some(&snap_v3),
        3,
        0,
        &backend,
        &holds,
        &panel.reads,
        &panel.wake,
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| !f.edit_conflict && f.reopening.is_none())
    });
    let form = panel.editor.form.as_ref().unwrap();
    assert_eq!(form.objective.text, obj_v3);
    assert_eq!(
        form.previous_draft.as_deref(),
        Some("My conflicted draft"),
        "successful Reopen must keep the old conflicted draft copyable"
    );
}

#[test]
fn editor_view_exposes_accessible_controls_focuses_close_on_edit_and_hides_lock_behind_info_tip() {
    struct Host {
        panel: Panel,
        holds: EditorHolds,
        fallback: TextEdit,
        closed: bool,
    }
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let req = CreateMissionRequest::with_request_id(
        "req-hold".into(),
        "Held mission",
        None,
        "",
        Template::Custom,
        TaskMode::Native,
    )
    .unwrap();
    holds.fixture_set_creation_hold(panel.creation_scope_key(), req, HoldState::Uncertain);
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    assert_eq!(
        panel.take_editor_initial_focus(),
        Some("mission-editor-close"),
        "held create focuses enabled Close button"
    );

    let mut rt = Runtime::new(
        Host {
            panel,
            holds,
            fallback: TextEdit::new(""),
            closed: false,
        },
        |host, _| {
            let trigger = rune_theme_codenomad::layout::button_tx(
                t("missionsPanel.picker.edit"),
                false,
                |_: &mut Host, _| {},
            )
            .key("mission-edit");
            rune::col().full_width().child(trigger).child(editor_view(
                &host.panel,
                &host.holds,
                |h: &mut Host| (Some(&mut h.panel), &mut h.fallback),
                |_, _, _| {},
                |h: &mut Host, tx| {
                    h.closed = true;
                    if let Some(back) = h.panel.close_reader() {
                        tx.focus(back, true);
                    }
                },
            ))
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

    // Switch to Edit mode while prefilling: initial focus targets enabled Close button,
    // and structural lock prose is hidden behind the on-demand info_tip button (not inline note).
    let header = sample_header(2, Some("Objective"), None, "running");
    rt.update(|host, tx| {
        let scope = host.panel.creation_scope_key();
        assert!(host.panel.editor.open_edit(
            &header,
            &scope,
            &host.panel.backend,
            &mut host.holds,
            &host.panel.reads,
            &host.panel.wake,
            Some("mission-edit".into()),
        ));
        let focus = host.panel.take_editor_initial_focus();
        assert_eq!(
            focus,
            Some("mission-editor-close"),
            "edit open while prefilling must target enabled Close button, never disabled Objective"
        );
        tx.focus(focus.unwrap(), true);
        host.panel.editor.form.as_mut().unwrap().previous_draft = Some("Old draft text".into());
        host.panel.editor.form.as_mut().unwrap().previous_draft_open = true;
    });
    rt.frame(1.0 / 60.0);
    let mut active_focus = None;
    rt.update(|_, tx| {
        active_focus = tx.focused().map(str::to_owned);
    });
    assert_eq!(
        active_focus.as_deref(),
        Some("mission-editor-close"),
        "rendered edit view must actually focus the enabled Close button"
    );
    let edit_elements = rt.elements();
    assert!(
        edit_elements
            .iter()
            .any(|e| e.key.as_deref() == Some("mission-editor-lock-info")),
        "lock explanation lives behind on-demand info button"
    );
    assert!(
        !edit_elements
            .iter()
            .any(|e| e.text.as_deref() == Some(t("missions.scheduling.lock.launched-once"))),
        "lock explanation must not appear as inline prose"
    );
    assert!(
        edit_elements
            .iter()
            .any(|e| e.key.as_deref() == Some("mission-editor-copy-previous")),
        "reopened editor exposes copyable previous conflicted draft"
    );

    // Clicking the real Close button must close the editor and restore focus to the trigger.
    let (cx, cy) = rt
        .find("mission-editor-close")
        .expect("close button must be mounted");
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    rt.frame(2.0 / 60.0);
    assert!(
        rt.state.closed,
        "clicking Close must invoke editor close callback"
    );
    assert!(!rt.state.panel.has_editor(), "editor must be closed");
    let mut restored_focus = None;
    rt.update(|_, tx| {
        restored_focus = tx.focused().map(str::to_owned);
    });
    assert_eq!(
        restored_focus.as_deref(),
        Some("mission-edit"),
        "closing editor via Close button must restore actual keyboard focus to the trigger"
    );
}

#[test]
fn create_defaults_start_on_creation_off_and_never_dispatches_control() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            (
                "200 OK".into(),
                json!({
                    "acknowledgement": "fresh",
                    "mission": mission_json_for("msn_default_off", 1, "prepared")
                })
                .to_string(),
            )
        } else if raw.contains("/control ") {
            control_calls_bg.fetch_add(1, Ordering::SeqCst);
            ("200 OK".into(), json!({}).to_string())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    assert!(
        !panel.editor.form.as_ref().unwrap().start_on_creation,
        "Start automatically must default to off per MISSIONS.md"
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Paused by default");
    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        !panel.has_editor()
    });
    assert_eq!(panel.selected.as_deref(), Some("msn_default_off"));
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "default create without Start automatically opt-in must never send POST /control"
    );
}

#[test]
fn suspend_and_resume_on_same_connection_restarts_prefill_and_reopen() {
    let content_calls = Arc::new(AtomicUsize::new(0));
    let content_calls_bg = content_calls.clone();
    let (first_hit_tx, first_hit_rx) = std::sync::mpsc::channel();
    let first_hit_tx = Arc::new(std::sync::Mutex::new(Some(first_hit_tx)));
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let hits = content_calls_bg.clone();
                let hit_tx = first_hit_tx.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let body = if raw.starts_with("GET /api/meta ") {
                        json!({"apiContract": 1, "serverId": "fixture-server"}).to_string()
                    } else if raw.contains("/content?") && raw.contains("field=objective") {
                        let n = hits.fetch_add(1, Ordering::SeqCst);
                        if n == 0 {
                            if let Some(tx) = hit_tx.lock().unwrap().take() {
                                let _ = tx.send(());
                            }
                            tokio::time::sleep(Duration::from_secs(3)).await;
                        }
                        let text = "Resumed objective";
                        json!({
                            "available": true,
                            "version": 1,
                            "projectID": "prj_1",
                            "missionID": "msn_alpha123",
                            "revision": 2,
                            "content": {
                                "kind": "mission",
                                "field": "objective",
                                "digest": content_digest(text),
                                "offset": 0,
                                "characters": utf16_len(text),
                                "text": text,
                                "next": null
                            }
                        })
                        .to_string()
                    } else if raw.contains("/content?") && raw.contains("field=notes") {
                        json!({
                            "available": true,
                            "version": 1,
                            "projectID": "prj_1",
                            "missionID": "msn_alpha123",
                            "revision": 2,
                            "refused": "content-not-found"
                        })
                        .to_string()
                    } else {
                        "{}".into()
                    };
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    let header = sample_header(2, Some("Resumed objective"), None, "running");
    panel.fixture_ready_with_lookup(header, "tsk_1", "k1");
    panel.detail.cancel_lookup();

    assert!(panel.open_edit_editor(&mut holds, Some("mission-edit".into())));
    first_hit_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("initial prefill HTTP must start");
    panel.suspend();
    assert_eq!(
        panel.editor.form.as_ref().unwrap().prefill,
        PrefillState::Loading
    );

    // Returning to the same connection must resume prefill instead of staying stuck on Loading.
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Resumed objective"
    );
}

#[test]
fn finished_mission_with_uncertain_edit_hold_exposes_read_only_receipt_reconciliation() {
    let (base, calls) = start_scripted_server(|_idx, raw| {
        if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_alpha123 ") {
            ("500 Internal Server Error".into(), "{}".into())
        } else if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_alpha123 ") {
            let mut m = mission_json_for("msn_alpha123", 3, "completed");
            m["status"] = json!("completed");
            m["history"] = json!([{
                "revision": 3,
                "source": "user",
                "requestID": "req-finished",
                "objective": { "before": "Old", "after": "Edited before finish" },
                "notes": { "before": "", "after": "" }
            }]);
            (
                "200 OK".into(),
                json!({"available": true, "mission": m}).to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    // Create an uncertain EditHold, then close the editor and mark the Mission completed (non-editable).
    let running_header = sample_header(2, Some("Old"), None, "running");
    let target = EditTarget::from_header(&running_header);
    let key = target.hold_key(&backend);
    let req =
        UpdateMissionRequest::with_request_id("req-finished".into(), 2, "Edited before finish", "")
            .unwrap();
    assert!(holds.start_edit(
        key.clone(),
        target.target,
        req,
        super::super::editor_holds::FormOrigin {
            occurrence: "tab-1".into(),
            generation: 1,
            backend: backend.clone(),
        },
        &backend,
        &noop_wake(),
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds
            .edit(&key)
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });

    // Mission finishes -> can_edit_selected() becomes false, yet read-only receipt reconciliation stays accessible.
    let mut finished_header = sample_header(3, Some("Old"), None, "stopped");
    finished_header.root.status = codenomad_client::missions::Status::Completed;
    assert!(!finished_header.root.editable());
    panel.fixture_ready_with_lookup(finished_header, "tsk_1", "k1");
    assert!(!panel.can_edit_selected());
    assert!(panel.selected_edit_hold(&holds).is_some());

    // Render panel_body and verify the Read receipt button is present.
    struct PanelHost {
        panel: Panel,
        holds: EditorHolds,
        fallback: TextEdit,
    }
    let mut rt = Runtime::new(
        PanelHost {
            panel,
            holds,
            fallback: TextEdit::new(""),
        },
        |h, _| {
            crate::missions::panel_body(
                &h.panel,
                &h.holds,
                |s: &mut PanelHost| (Some(&mut s.panel), &mut s.fallback),
                rune::el(),
                None,
                |_, _| {},
                |_, _, _| {},
            )
        },
        (420.0, 640.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.key.as_deref() == Some("mission-edit-reconcile")),
        "finished Mission with uncertain EditHold must expose Read receipt control"
    );

    // Opening the read-only editor allows reconciling the receipt and releasing the hold.
    let PanelHost { panel, holds, .. } = &mut rt.state;
    assert!(panel.open_edit_editor(holds, Some("mission-edit-reconcile".into())));
    assert!(
        panel
            .editor
            .form
            .as_ref()
            .unwrap()
            .edit
            .as_ref()
            .unwrap()
            .read_only
    );
    panel.reconcile_editor_edit("tab-1", holds);
    wait_until(|| {
        poll_step(panel, "tab-1", holds, &mut lifecycle);
        holds.edit(&key).is_none()
    });
    assert!(!panel.has_editor());
    assert!(calls.load(Ordering::SeqCst) >= 2);
}

#[test]
fn reopen_ignores_pre_click_inflight_detail_read_and_waits_for_post_click_refresh() {
    let map_calls = Arc::new(AtomicUsize::new(0));
    let map_calls_bg = map_calls.clone();
    let (first_map_seen_tx, first_map_seen_rx) = std::sync::mpsc::channel();
    let first_map_seen_tx = Arc::new(std::sync::Mutex::new(Some(first_map_seen_tx)));
    let release_first_map = Arc::new(tokio::sync::Notify::new());
    let release_first_map_bg = release_first_map.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let calls = map_calls_bg.clone();
                let seen_tx = first_map_seen_tx.clone();
                let release = release_first_map_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let body = if raw.starts_with("GET /api/meta ") {
                        json!({"apiContract": 1, "serverId": "fixture-server"}).to_string()
                    } else if raw.contains("/missions/panel-page") && raw.contains("\"mission\"") {
                        let call = calls.fetch_add(1, Ordering::SeqCst);
                        if call == 0 {
                            if let Some(tx) = seen_tx.lock().unwrap().take() {
                                let _ = tx.send(());
                            }
                            release.notified().await;
                            // Stale pre-click response still at revision 2!
                            mission_page_envelope("msn_alpha123", 2, "Old text")
                        } else {
                            // Fresh post-click response at revision 4!
                            mission_page_envelope("msn_alpha123", 4, "Fresh text")
                        }
                    } else if raw.contains("/missions/panel-page") && raw.contains("\"tasks\"") {
                        tasks_page_envelope("msn_alpha123", 4)
                    } else if raw.contains("/content?") && raw.contains("field=objective") {
                        let text = "Fresh text";
                        json!({
                            "available": true,
                            "version": 1,
                            "projectID": "prj_1",
                            "missionID": "msn_alpha123",
                            "revision": 4,
                            "content": {
                                "kind": "mission",
                                "field": "objective",
                                "digest": content_digest(text),
                                "offset": 0,
                                "characters": utf16_len(text),
                                "text": text,
                                "next": null
                            }
                        })
                        .to_string()
                    } else if raw.contains("/content?") && raw.contains("field=notes") {
                        json!({
                            "available": true,
                            "version": 1,
                            "projectID": "prj_1",
                            "missionID": "msn_alpha123",
                            "revision": 4,
                            "refused": "content-not-found"
                        })
                        .to_string()
                    } else {
                        "{}".into()
                    };
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    let header_v2 = sample_header(2, Some("Old text"), None, "running");
    panel.fixture_ready_with_lookup(
        sample_header(2, Some("Old text"), None, "running"),
        "tsk_1",
        "k1",
    );
    panel.detail.cancel_lookup();
    // Simulate a pre-click detail refresh already in flight before the user clicks Reopen.
    panel.detail.refresh();
    poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
    first_map_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("pre-click detail read must be in flight");

    // Put the editor in edit-conflict state with a user draft, then click Reopen.
    let scope = panel.creation_scope_key();
    panel.editor.form = Some(Form {
        generation: 1,
        mode: Mode::Edit,
        objective: TextEdit::new("My unsaved draft"),
        title: TextEdit::new("Alpha"),
        notes: TextEdit::new(""),
        template: Template::Custom,
        task_mode: TaskMode::Native,
        custom_task_mode: true,
        defaults_state: DefaultsState::Ready,
        defaults_loaded: true,
        defaults: Vec::new(),
        profiles: None,
        catalog: None,
        start_on_creation: false,
        prefill: PrefillState::Ready,
        has_loaded_draft: true,
        initial_objective: "Old text".into(),
        initial_notes: String::new(),
        has_hold: false,
        catalog_rechecking: false,
        doc_rechecking: false,
        edit: Some(EditTarget::from_header(&header_v2)),
        reopening: None,
        reopen_target: None,
        previous_draft: None,
        previous_draft_open: false,
        lock_help_open: false,
        pending_leave: None,
        request_id: "req-1".into(),
        last_payload: String::new(),
        error: Some("missions.control.revisionConflict"),
        edit_conflict: true,
        return_focus: None,
        close: Default::default(),
    });
    let _ = scope;
    panel.reopen_editor(&holds);

    // Release the stale pre-click detail response (rev 2): Reopen MUST NOT adopt rev 2 or discard the draft!
    release_first_map.notify_one();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        map_calls.load(Ordering::SeqCst) >= 2
            && panel
                .editor
                .form
                .as_ref()
                .is_some_and(|f| f.reopening.is_none() && f.prefill == PrefillState::Ready)
    });
    let form = panel.editor.form.as_ref().unwrap();
    assert_eq!(
        form.edit.as_ref().unwrap().expected_revision,
        4,
        "Reopen must ignore pre-click rev 2 read and adopt post-click rev 4"
    );
    assert_eq!(form.objective.text, "Fresh text");
    assert_eq!(form.previous_draft.as_deref(), Some("My unsaved draft"));
}

#[test]
fn selecting_another_mission_closes_create_form_revokes_autostart_and_keeps_receipt() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel();
    let post_seen_tx = Arc::new(std::sync::Mutex::new(Some(post_seen_tx)));
    let release_post = Arc::new(tokio::sync::Notify::new());
    let release_post_bg = release_post.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let control_c = control_calls_bg.clone();
                let seen = post_seen_tx.clone();
                let release = release_post_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let body = if raw.starts_with("GET /api/meta ") {
                        json!({"apiContract": 1, "serverId": "fixture-server"}).to_string()
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        json!({"settings": {}}).to_string()
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        release.notified().await;
                        json!({
                            "acknowledgement": "fresh",
                            "mission": mission_json_for("msn_created_late", 1, "prepared")
                        })
                        .to_string()
                    } else if raw.contains("/control ") {
                        control_c.fetch_add(1, Ordering::SeqCst);
                        json!({}).to_string()
                    } else {
                        "{}".into()
                    };
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    panel.summaries = vec![
        serde_json::from_value(json!({
            "id": "msn_existing",
            "title": "Existing",
            "objective": "Existing",
            "status": "active",
            "runState": "running",
            "coordinatorSessionId": "ses_coord_existing",
            "actorCount": 1,
            "revision": 2,
            "updatedAt": 1.0
        }))
        .unwrap(),
    ];

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Created then left");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;
    panel.submit_editor("tab-1", &mut holds);
    post_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("POST must reach server");

    // User clicks another Mission in the docked list while POST is in flight.
    panel.select("msn_existing");
    assert!(
        !panel.has_editor(),
        "selecting another Mission must close the open Create form"
    );
    assert!(
        panel.take_editor_auto_start_revoked(),
        "selecting another Mission must flag auto-start revocation"
    );
    holds.revoke_auto_start_for_occurrence("tab-1");
    let scope = panel.creation_scope_key();
    assert!(
        holds.creation(&scope).is_some(),
        "creation hold must remain retained until receipt settles"
    );

    // Late fresh ACK settles: must neither hijack selection nor fire /control.
    release_post.notify_one();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds.creation(&scope).is_none()
    });
    assert_eq!(panel.selected.as_deref(), Some("msn_existing"));
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "selecting another Mission must prevent late Create ACK from sending POST /control"
    );
}

#[test]
fn same_cycle_directory_summary_401_blocks_fresh_create_autostart() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (dir_seen_tx, dir_seen_rx) = std::sync::mpsc::channel();
    let dir_seen_tx = Arc::new(std::sync::Mutex::new(Some(dir_seen_tx)));
    let release_both = Arc::new(tokio::sync::Barrier::new(2));
    let release_both_bg = release_both.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let control_c = control_calls_bg.clone();
                let seen = dir_seen_tx.clone();
                let barrier = release_both_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body): (&str, String) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.contains("/missions/panel-page") && raw.contains("\"summaries\"") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        barrier.wait().await;
                        ("401 Unauthorized", "expired".into())
                    } else if raw.contains("/missions/panel-page") {
                        ("500 Internal Server Error", "{}".into())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        barrier.wait().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_dir_401", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/control ") {
                        control_c.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", json!({}).to_string())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let (wake_tx, wake_rx) = bounded(16);
    let wake: Wake = Arc::new(move || {
        let _ = wake_tx.try_send(());
    });
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), wake);
    let holds = EditorHolds::default();

    // Trigger Summaries read (which will return 401 simultaneously with Create fresh ACK).
    panel.show(true);
    dir_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("summaries read must reach server");
    // Drain the companion Cleanups failure before synchronizing Summaries 401 + Create fresh.
    wait_until(|| {
        panel.poll();
        panel.failed(super::super::directory::Kind::Cleanups)
    });

    let state = crate::workspace::test_state_with_mission_panel(panel, holds);
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    // Open Create with start_on_creation=true and submit; wait for BOTH Summaries 401 and Create
    // fresh replies to land in their channels, then hide the panel before workspace::poll runs.
    // Real workspace::poll must still observe the hidden Summaries 401 and block /control.
    rt.update(|s, _| {
        let (_, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
        panel.open_create_editor(mission_editor, Some("missions-create".into()));
    });
    wait_until(|| {
        let mut ready = false;
        rt.update(|s, _| {
            let (_, panel, _) = crate::workspace::test_mission_entry_mut(s, 0);
            panel.poll();
            ready = panel
                .editor
                .form
                .as_ref()
                .is_some_and(|f| f.defaults_state == DefaultsState::Ready);
        });
        ready
    });
    rt.update(|s, _| {
        let (tab_key, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
        panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Create vs dir 401");
        panel.editor.form.as_mut().unwrap().start_on_creation = true;
        while wake_rx.try_recv().is_ok() {}
        panel.submit_editor(&tab_key, mission_editor);
    });
    crate::platform::block_on(async {
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(3), wake_rx.recv())
                .await
                .expect("summaries 401 and Create fresh must both arrive")
                .unwrap();
        }
    });
    rt.update(|s, tx| {
        let (_, panel, _) = crate::workspace::test_mission_entry_mut(s, 0);
        panel.show(false);
        crate::workspace::poll(s, 1.0, tx);
    });
    assert!(
        rt.state
            .screen
            .launcher()
            .is_some_and(|l| l.authentication_required),
        "real workspace::poll must propagate hidden directory 401 into authentication recovery"
    );
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "same-cycle directory 401 must block Create auto-start /control"
    );
}

#[test]
fn open_mission_editor_blocks_global_shortcuts_while_allowing_escape() {
    use rune::{Key, KeyEvent, Mods};
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let mut mission_editor = EditorHolds::default();
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    panel.open_create_editor(&mut mission_editor, Some("missions-create".into()));
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Unsaved draft");
    let state = crate::workspace::test_state_with_mission_panel(panel, mission_editor);

    let ctrl_w = KeyEvent {
        key: Key::Command('w'),
        mods: Mods {
            ctrl: true,
            ..Mods::default()
        },
    };
    let esc = KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    };
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (800.0, 600.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let mut blocked_ctrl_w = false;
    let mut escape_handled = false;
    let mut editor_still_open = true;
    rt.update(|s, tx| {
        blocked_ctrl_w = crate::shell::shortcut_blocked(s, &ctrl_w, tx);
        // With an unsaved draft, Escape prompts before discarding instead of wiping the draft.
        escape_handled = crate::shell::keys(s, &esc, tx);
        editor_still_open = crate::workspace::mission_has_editor(s);
    });
    assert!(
        blocked_ctrl_w,
        "global shortcuts such as Ctrl+W must be blocked while Mission editor is open"
    );
    assert!(
        escape_handled,
        "Escape must be handled by the Mission editor"
    );
    assert!(
        editor_still_open,
        "Escape on an unsaved draft must prompt instead of silently wiping the draft"
    );
    // Second Escape cancels the discard prompt; clearing the draft lets Escape close immediately.
    rt.update(|s, tx| {
        assert!(crate::shell::keys(s, &esc, tx));
        let (_, panel, _) = crate::workspace::test_mission_entry_mut(s, 0);
        assert_eq!(panel.editor.form.as_ref().unwrap().pending_leave, None);
        panel.editor.form.as_mut().unwrap().objective = TextEdit::new("");
        assert!(crate::shell::keys(s, &esc, tx));
        editor_still_open = crate::workspace::mission_has_editor(s);
    });
    assert!(
        !editor_still_open,
        "clean Mission editor must close immediately on Escape"
    );
}

#[test]
fn create_with_empty_title_sends_derived_title_in_post_body() {
    let captured_post = Arc::new(std::sync::Mutex::new(None::<String>));
    let captured_post_bg = captured_post.clone();
    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            *captured_post_bg.lock().unwrap() = Some(raw.to_owned());
            (
                "200 OK".into(),
                json!({
                    "acknowledgement": "fresh",
                    "mission": mission_json_for("msn_derived", 1, "prepared")
                })
                .to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective =
        TextEdit::new("Fix the retry loop. Keep existing tests.");
    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        !panel.has_editor()
    });
    let post = captured_post
        .lock()
        .unwrap()
        .clone()
        .expect("POST /missions must be sent");
    let body: Value = serde_json::from_str(post.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body["title"].as_str(),
        Some("Fix the retry loop"),
        "empty title field must send derived first-clause title like Solid"
    );
}

#[test]
fn document_lock_via_schedule_blocks_edit_while_preserving_existing_hold() {
    let patch_calls = Arc::new(AtomicUsize::new(0));
    let patch_calls_bg = patch_calls.clone();
    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_doclock/schedule ") {
            (
                "200 OK".into(),
                json!({
                    "pending": false,
                    "document": {
                        "id": "msn_doclock",
                        "kind": "one-time",
                        "configuration": { "roots": [{ "mode": "directory-only", "directory": "/repo" }] },
                        "preparation": { "pending": true },
                        "edit": { "structural": false, "reason": "uncertain" }
                    }
                })
                .to_string(),
            )
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/location") {
            (
                "200 OK".into(),
                json!({ "directory": "/repo", "project": { "id": "prj_1" } }).to_string(),
            )
        } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_doclock ") {
            patch_calls_bg.fetch_add(1, Ordering::SeqCst);
            ("500 Internal Server Error".into(), "{}".into())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);

    // Header carrying dormant document is immediately non-editable.
    let dormant_header: MapHeader = serde_json::from_value(json!({
        "root": {
            "version": 1,
            "id": "msn_dormant",
            "projectID": "prj_1",
            "projectCanonical": "/repo",
            "title": "Dormant",
            "excerpt": "Dormant",
            "template": "custom",
            "taskMode": "native",
            "status": "active",
            "runState": "prepared",
            "revision": 2,
            "coordinatorSessionId": "ses_coord",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "historyTruncated": false,
            "bodies": {},
            "document": { "revision": 2, "state": "active", "dormant": true }
        },
        "collections": {
            "actors": { "characters": 0, "digest": "", "total": 0, "array": true },
            "history": { "characters": 0, "digest": "", "total": 0, "array": true },
            "reports": { "characters": 0, "digest": "", "total": 0, "array": true }
        },
        "tasks": {
            "version": "",
            "page": { "order": "", "offset": 0, "end": 0, "total": 0, "reports": 0, "counts": {} },
            "pins": [],
            "reportPins": []
        }
    }))
    .unwrap();
    assert!(
        !dormant_header.root.editable(),
        "dormant unified document must not advertise Edit"
    );

    // Active unified document whose /schedule reports preparation.pending locks Edit without PATCH.
    let obj = "Current objective";
    let doc_header: MapHeader = serde_json::from_value(json!({
        "root": {
            "version": 1,
            "id": "msn_doclock",
            "projectID": "prj_1",
            "projectCanonical": "/repo",
            "title": "DocLocked",
            "excerpt": obj,
            "template": "custom",
            "taskMode": "native",
            "status": "active",
            "runState": "prepared",
            "revision": 2,
            "coordinatorSessionId": "ses_coord",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "historyTruncated": false,
            "bodies": {
                "objective": {
                    "characters": utf16_len(obj),
                    "digest": content_digest(obj)
                }
            },
            "document": { "revision": 2, "state": "active" }
        },
        "collections": {
            "actors": { "characters": 0, "digest": "", "total": 0, "array": true },
            "history": { "characters": 0, "digest": "", "total": 0, "array": true },
            "reports": { "characters": 0, "digest": "", "total": 0, "array": true }
        },
        "tasks": {
            "version": "",
            "page": { "order": "", "offset": 0, "end": 0, "total": 0, "reports": 0, "counts": {} },
            "pins": [],
            "reportPins": []
        }
    }))
    .unwrap();
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    let scope = panel.creation_scope_key();
    assert!(panel.editor.open_edit(
        &doc_header,
        &scope,
        &panel.backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        Some("mission-edit".into()),
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.editor.form.as_ref().is_some_and(|f| {
            f.prefill == PrefillState::DocumentLocked("missions.scheduling.lock.uncertain")
        })
    });
    let form = panel.editor.form.as_ref().unwrap();
    assert!(
        !form.can_submit(None, None),
        "locked document must disable Save"
    );
    panel.submit_editor("tab-1", &mut holds);
    assert_eq!(
        patch_calls.load(Ordering::SeqCst),
        0,
        "locked document must never send PATCH"
    );
}

#[test]
fn observation_401_propagates_across_cancel_and_drain() {
    let (obs_seen_tx, obs_seen_rx) = std::sync::mpsc::channel();
    let obs_seen_tx = Arc::new(std::sync::Mutex::new(Some(obs_seen_tx)));
    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.contains("/missions/panel-page") && raw.contains("\"activity\"") {
            if let Some(tx) = obs_seen_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
            ("401 Unauthorized".into(), "expired".into())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let (wake_tx, wake_rx) = bounded(8);
    let wake: Wake = Arc::new(move || {
        let _ = wake_tx.try_send(());
    });
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        wake,
    );
    panel.observation.refresh();
    assert!(panel.observation.poll(
        &backend,
        "prj_1",
        "msn_obs_401",
        2,
        &Reads::default(),
        &panel.wake,
    ));
    obs_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("activity read must reach server");
    crate::platform::block_on(async {
        tokio::time::timeout(Duration::from_secs(3), wake_rx.recv())
            .await
            .expect("observation 401 reply must arrive")
            .unwrap();
    });
    // Even if cancel() runs before settle(), the arrived 401 must not be dropped.
    panel.observation.cancel();
    let expired = panel.drain_auth_expired();
    assert_eq!(
        expired.len(),
        1,
        "Observation 401 must survive cancel() and surface through Panel::drain_auth_expired"
    );
}

#[test]
fn pairing_required_and_tab_stash_suspend_missions_and_revoke_autostart() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel();
    let post_seen_tx = Arc::new(std::sync::Mutex::new(Some(post_seen_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_bg = release.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let seen = post_seen_tx.clone();
                let gate = release_bg.clone();
                let controls = control_calls_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        gate.notified().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_pairing", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/control ") {
                        controls.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", "{}".into())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let state = crate::workspace::test_state_with_mission_panel(panel, EditorHolds::default());
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);

    // Open Create with start_on_creation=true, submit, then block context (auth/launcher takeover).
    rt.update(|s, _| {
        let (_, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
        panel.open_create_editor(mission_editor, Some("missions-create".into()));
    });
    wait_until(|| {
        let mut ready = false;
        rt.update(|s, _| {
            let (_, panel, _) = crate::workspace::test_mission_entry_mut(s, 0);
            panel.poll();
            ready = panel
                .editor
                .form
                .as_ref()
                .is_some_and(|f| f.defaults_state == DefaultsState::Ready);
        });
        ready
    });
    rt.update(|s, _| {
        let (tab_key, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
        panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Context guard");
        panel.editor.form.as_mut().unwrap().start_on_creation = true;
        panel.submit_editor(&tab_key, mission_editor);
    });
    post_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("POST /missions must reach server");

    rt.update(|s, tx| {
        s.screen.launcher_mut().unwrap().authentication_required = true;
        assert!(
            !crate::workspace::mission_has_editor(s),
            "blocked project context must hide Mission editor"
        );
        assert!(
            !crate::workspace::mission_has_reader(s),
            "blocked project context must hide Mission reader"
        );
        crate::workspace::poll(s, 1.0, tx);
    });

    // Release POST /missions while blocked; auto-start must already be revoked.
    release.notify_one();
    wait_until(|| {
        let mut done = false;
        rt.update(|s, tx| {
            crate::workspace::poll(s, 2.0, tx);
            let (_, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
            let scope = panel.creation_scope_key();
            done = mission_editor.creation(&scope).is_none();
        });
        done
    });
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "blocked project context must revoke auto-start so no POST /control fires"
    );

    // Restore context and verify immediate tab switch (workspace::new_tab -> stash) suspends panel before any poll.
    rt.update(|s, tx| {
        s.screen.launcher_mut().unwrap().authentication_required = false;
        {
            let (_, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
            panel.show(true);
            panel.open_create_editor(mission_editor, Some("missions-create".into()));
            panel.editor.form.as_mut().unwrap().start_on_creation = true;
        }
        crate::workspace::new_tab(s, tx);
    });
    let stashed_panel = crate::workspace::test_mission_panel(&rt.state, 0);
    assert!(
        !stashed_panel.busy(super::super::directory::Kind::Summaries),
        "tabs::stash must immediately cancel active directory reads without waiting for poll"
    );
}

#[test]
fn reconnect_same_server_advances_generation_so_old_ack_does_not_close_or_hijack_form() {
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel();
    let post_seen_tx = Arc::new(std::sync::Mutex::new(Some(post_seen_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_bg = release.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let seen = post_seen_tx.clone();
                let gate = release_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        gate.notified().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_old_conn", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let conn1 = attested_backend(base.clone());
    let conn2 = attested_backend(base);
    assert!(
        !conn1.client.same_connection(&conn2.client),
        "reconnected client must have a distinct connection identity"
    );
    let mut panel = Panel::new(conn1, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Created before reconnect");
    panel.submit_editor("tab-1", &mut holds);
    post_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("POST /missions on conn1 must reach server");

    // Reconnect to the same server/workspace with conn2 while POST on conn1 is still in flight.
    panel.rebind(conn2);
    panel.rebind_editor(&mut holds);

    // Late ACK from conn1 arrives; hold settles, but restored form stays open and selection stays None.
    release.notify_one();
    let scope = panel.creation_scope_key();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds.creation(&scope).is_none()
    });
    assert!(
        panel.has_editor(),
        "late ACK from previous connection must not close the reconnected form"
    );
    assert_eq!(
        panel.selected, None,
        "late ACK from previous connection must not hijack Mission selection"
    );
}

#[test]
fn cross_cycle_401_permanently_revokes_create_autostart() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel();
    let post_seen_tx = Arc::new(std::sync::Mutex::new(Some(post_seen_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_bg = release.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let seen = post_seen_tx.clone();
                let gate = release_bg.clone();
                let controls = control_calls_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        gate.notified().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_cross_401", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/control ") {
                        controls.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", "{}".into())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Cross-cycle 401");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;
    panel.submit_editor("tab-1", &mut holds);
    post_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("POST /missions must reach server");

    // Poll cycle 1 observes a 401 on the same connection while POST /missions is still in flight.
    let active = panel.active_editor("tab-1");
    let _ = holds.poll(active, std::slice::from_ref(&backend), &mut lifecycle);
    let _ = holds.drain_auth_expired();

    // Poll cycle 2 has NO fresh 401 in external_auth_expired (e.g. web pairing check still async),
    // yet auto-start must remain permanently revoked when the fresh Create ACK settles.
    release.notify_one();
    let scope = panel.creation_scope_key();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds.creation(&scope).is_none()
    });
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "prior-cycle 401 on the connection must permanently veto Create auto-start"
    );
}

#[test]
fn ready_edit_revalidates_schedule_503_before_patch_and_on_resume_without_losing_draft() {
    let lock_active = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let lock_active_bg = lock_active.clone();
    let schedule_hits = Arc::new(AtomicUsize::new(0));
    let schedule_hits_bg = schedule_hits.clone();
    let patch_calls = Arc::new(AtomicUsize::new(0));
    let patch_calls_bg = patch_calls.clone();
    let orig_obj = "Documented objective";
    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_doc503/schedule ") {
            schedule_hits_bg.fetch_add(1, Ordering::SeqCst);
            if lock_active_bg.load(Ordering::SeqCst) {
                (
                    "503 Service Unavailable".into(),
                    json!({
                        "missionID": "msn_doc503",
                        "pending": true,
                        "code": "schedule-pending"
                    })
                    .to_string(),
                )
            } else {
                (
                    "200 OK".into(),
                    json!({
                        "pending": false,
                        "document": {
                            "id": "msn_doc503",
                            "kind": "one-time",
                            "configuration": { "roots": [{ "mode": "directory-only", "directory": "/repo" }] },
                            "edit": { "structural": false, "reason": "launched-once" }
                        }
                    })
                    .to_string(),
                )
            }
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/location") {
            (
                "200 OK".into(),
                json!({ "directory": "/repo", "project": { "id": "prj_1" } }).to_string(),
            )
        } else if raw.contains("/content?") && raw.contains("field=objective") {
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_doc503",
                    "revision": 2,
                    "content": {
                        "kind": "mission",
                        "field": "objective",
                        "digest": content_digest(orig_obj),
                        "offset": 0,
                        "characters": utf16_len(orig_obj),
                        "text": orig_obj,
                        "next": null
                    }
                })
                .to_string(),
            )
        } else if raw.contains("/content?") && raw.contains("field=notes") {
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_doc503",
                    "revision": 2,
                    "refused": "content-not-found"
                })
                .to_string(),
            )
        } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_doc503 ") {
            patch_calls_bg.fetch_add(1, Ordering::SeqCst);
            ("500 Internal Server Error".into(), "{}".into())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    let header = sample_doc_header_for("msn_doc503", 2, orig_obj);
    let scope = panel.creation_scope_key();
    assert!(panel.editor.open_edit(
        &header,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        Some("mission-edit".into()),
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    assert_eq!(schedule_hits.load(Ordering::SeqCst), 1);

    // User edits draft, then schedule becomes 503 schedule-pending before Save.
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("My edited draft");
    lock_active.store(true, Ordering::SeqCst);
    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.editor.form.as_ref().is_some_and(|f| {
            f.prefill == PrefillState::DocumentLocked("missions.scheduling.lock.uncertain")
        })
    });
    let edit_key = EditHoldKey::new(&backend, "prj_1", "msn_doc503");
    assert_eq!(
        patch_calls.load(Ordering::SeqCst),
        0,
        "pre-PATCH 503 schedule-pending must block PATCH"
    );
    assert!(
        holds.edit(&edit_key).is_none(),
        "pre-PATCH 503 schedule-pending must not create an EditHold"
    );
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "My edited draft",
        "locking must preserve user draft"
    );

    // Unlock and Retry: rechecks /schedule without overwriting the edited draft.
    lock_active.store(false, Ordering::SeqCst);
    panel.retry_editor_prefill();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "My edited draft",
        "Retry after DocumentLocked must keep user's loaded draft intact"
    );

    // Suspend while Ready, engage 503 schedule-pending, resume: non-destructive recheck locks without losing draft.
    panel.suspend();
    lock_active.store(true, Ordering::SeqCst);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.editor.form.as_ref().is_some_and(|f| {
            f.prefill == PrefillState::DocumentLocked("missions.scheduling.lock.uncertain")
        })
    });
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "My edited draft",
        "resume recheck hitting 503 schedule-pending must preserve draft"
    );
    assert_eq!(patch_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn reopen_hitting_document_lock_retains_reopen_target_and_preserves_draft_on_retry_and_second_reopen()
 {
    let lock_active = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let lock_active_bg = lock_active.clone();
    let rev_served = Arc::new(AtomicUsize::new(3));
    let rev_served_bg = rev_served.clone();
    let obj_v2 = "Objective v2";
    let obj_v3 = "Objective v3";
    let obj_v4 = "Objective v4";

    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_reopen_lock/schedule ") {
            if lock_active_bg.load(Ordering::SeqCst) {
                (
                    "503 Service Unavailable".into(),
                    json!({
                        "missionID": "msn_reopen_lock",
                        "pending": true,
                        "code": "schedule-pending"
                    })
                    .to_string(),
                )
            } else {
                (
                    "200 OK".into(),
                    json!({
                        "pending": false,
                        "document": {
                            "id": "msn_reopen_lock",
                            "kind": "one-time",
                            "configuration": { "roots": [{ "mode": "directory-only", "directory": "/repo" }] },
                            "edit": { "structural": false, "reason": "launched-once" }
                        }
                    })
                    .to_string(),
                )
            }
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/location") {
            (
                "200 OK".into(),
                json!({ "directory": "/repo", "project": { "id": "prj_1" } }).to_string(),
            )
        } else if raw.contains("/missions/panel-page") && raw.contains("\"mission\"") {
            let rev = rev_served_bg.load(Ordering::SeqCst) as u64;
            let text = if rev >= 4 { obj_v4 } else { obj_v3 };
            (
                "200 OK".into(),
                mission_doc_page_envelope("msn_reopen_lock", rev, text),
            )
        } else if raw.contains("/missions/panel-page") && raw.contains("\"tasks\"") {
            let rev = rev_served_bg.load(Ordering::SeqCst) as u64;
            ("200 OK".into(), tasks_page_envelope("msn_reopen_lock", rev))
        } else if raw.contains("/content?") && raw.contains("field=objective") {
            let (rev, text) = if raw.contains(&content_digest(obj_v4)) {
                (4, obj_v4)
            } else if raw.contains(&content_digest(obj_v3)) {
                (3, obj_v3)
            } else {
                (2, obj_v2)
            };
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_reopen_lock",
                    "revision": rev,
                    "content": {
                        "kind": "mission",
                        "field": "objective",
                        "digest": content_digest(text),
                        "offset": 0,
                        "characters": utf16_len(text),
                        "text": text,
                        "next": null
                    }
                })
                .to_string(),
            )
        } else if raw.contains("/content?") && raw.contains("field=notes") {
            (
                "200 OK".into(),
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "prj_1",
                    "missionID": "msn_reopen_lock",
                    "revision": 3,
                    "refused": "content-not-found"
                })
                .to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    panel.select("msn_reopen_lock");

    // 1. Open Edit at rev 2 and edit the draft, then simulate a 409 conflict.
    let header_v2 = sample_doc_header_for("msn_reopen_lock", 2, obj_v2);
    let scope = panel.creation_scope_key();
    assert!(panel.editor.open_edit(
        &header_v2,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        None,
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Conflicted draft v2");
    panel.editor.form.as_mut().unwrap().edit_conflict = true;

    // 2. Reopen toward rev 3 while /schedule returns 503 schedule-pending.
    lock_active.store(true, Ordering::SeqCst);
    panel.reopen_editor(&holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.editor.form.as_ref().is_some_and(|f| {
            f.prefill == PrefillState::DocumentLocked("missions.scheduling.lock.uncertain")
        })
    });
    {
        let form = panel.editor.form.as_ref().unwrap();
        assert_eq!(
            form.reopen_target.as_ref().map(|t| t.expected_revision),
            Some(3),
            "DocumentLocked during Reopen must retain reopen_target rev 3"
        );
        assert_eq!(form.objective.text, "Conflicted draft v2");
        assert!(form.has_loaded_draft);
    }

    // 3. Unlock and click Retry: must resume reopen_target (rev 3, NOT old rev 2) and copy previous draft.
    lock_active.store(false, Ordering::SeqCst);
    panel.retry_editor_prefill();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready && f.reopen_target.is_none())
    });
    {
        let form = panel.editor.form.as_ref().unwrap();
        assert_eq!(
            form.edit.as_ref().map(|e| e.expected_revision),
            Some(3),
            "Retry must load the retained reopen_target rev 3"
        );
        assert_eq!(form.objective.text, obj_v3);
        assert!(
            form.previous_draft
                .as_deref()
                .is_some_and(|prev| prev.contains("Conflicted draft v2")),
            "Retry completing Reopen must preserve the user's draft in previous_draft"
        );
    }

    // 4. Hit DocumentLocked during another Reopen, then trigger a SECOND Reopen (rev 4):
    //    has_loaded_draft must still copy the user's edited draft into previous_draft even from DocumentLocked.
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Conflicted draft v3");
    panel.editor.form.as_mut().unwrap().previous_draft = None;
    panel.editor.form.as_mut().unwrap().edit_conflict = true;
    lock_active.store(true, Ordering::SeqCst);
    panel.reopen_editor(&holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.editor.form.as_ref().is_some_and(|f| {
            f.prefill == PrefillState::DocumentLocked("missions.scheduling.lock.uncertain")
        })
    });
    rev_served.store(4, Ordering::SeqCst);
    lock_active.store(false, Ordering::SeqCst);
    panel.reopen_editor(&holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.editor.form.as_ref().is_some_and(|f| {
            f.prefill == PrefillState::Ready
                && f.edit.as_ref().map(|e| e.expected_revision) == Some(4)
        })
    });
    let form = panel.editor.form.as_ref().unwrap();
    assert_eq!(form.objective.text, obj_v4);
    assert!(
        form.previous_draft
            .as_deref()
            .is_some_and(|prev| prev.contains("Conflicted draft v3")),
        "second Reopen from DocumentLocked must still preserve loaded draft in previous_draft"
    );
}

#[test]
fn suspend_and_return_invalidates_generation_so_late_ack_does_not_close_or_hijack() {
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel();
    let post_seen_tx = Arc::new(std::sync::Mutex::new(Some(post_seen_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_bg = release.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let seen = post_seen_tx.clone();
                let gate = release_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        gate.notified().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_after_stash", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    let gen_before = panel.editor.form.as_ref().unwrap().generation;
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Round-trip tab");
    panel.submit_editor("tab-1", &mut holds);
    post_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("POST /missions must reach server");

    // Simulate switching tab A -> B -> A before the ACK arrives.
    panel.suspend();
    let gen_after = panel.editor.form.as_ref().unwrap().generation;
    assert_ne!(
        gen_before, gen_after,
        "suspend() must advance form.generation"
    );
    // Resume on return to tab A (panel.observe_editor_detail resumes editor).
    poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
    let scope = panel.creation_scope_key();
    assert!(
        holds.creation(&scope).is_some(),
        "hold must remain retained across suspend/resume"
    );

    // Late ACK arrives AFTER returning to tab A: hold settles, form stays open, selection is NOT hijacked.
    release.notify_one();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds.creation(&scope).is_none()
    });
    assert!(
        panel.has_editor(),
        "late ACK delivered after A -> B -> A must not close the restored editor"
    );
    assert_eq!(
        panel.selected, None,
        "late ACK delivered after A -> B -> A must not hijack Mission selection"
    );
}

#[test]
fn create_loads_server_defaults_for_task_mode_and_compare_profiles() {
    let captured_post = Arc::new(std::sync::Mutex::new(None::<String>));
    let captured_post_bg = captured_post.clone();
    let (base, _) = start_scripted_server_raw(move |_idx, raw| {
        if raw.starts_with("GET /api/storage/config/ui") {
            (
                "200 OK".into(),
                json!({
                    "settings": {
                        "missionProfileDefaults": [
                            {
                                "template": "all",
                                "taskMode": "independent",
                                "profiles": {
                                    "coordinator": {
                                        "model": {
                                            "providerID": "anthropic",
                                            "id": "claude-sonnet-4",
                                            "variant": "default"
                                        }
                                    },
                                    "roles": {
                                        "specialist": { "agent": "general" }
                                    }
                                }
                            },
                            {
                                "template": "compare",
                                "profiles": {
                                    "roles": {
                                        "model-a": {
                                            "model": { "providerID": "openai", "id": "gpt-5" }
                                        },
                                        "model-b": {
                                            "model": { "providerID": "anthropic", "id": "claude-sonnet-4" }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                })
                .to_string(),
            )
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/agent") {
            (
                "200 OK".into(),
                json!({
                    "location": { "directory": "/repo" },
                    "data": [
                        { "id": "general", "mode": "all" }
                    ]
                })
                .to_string(),
            )
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/model") {
            (
                "200 OK".into(),
                json!({
                    "location": { "directory": "/repo" },
                    "data": [
                        {
                            "providerID": "openai",
                            "id": "gpt-5",
                            "enabled": true,
                            "capabilities": { "tools": true },
                            "variants": []
                        },
                        {
                            "providerID": "anthropic",
                            "id": "claude-sonnet-4",
                            "enabled": true,
                            "capabilities": { "tools": true },
                            "variants": [{ "id": "default" }]
                        }
                    ]
                })
                .to_string(),
            )
        } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            *captured_post_bg.lock().unwrap() = Some(raw.to_owned());
            let mut created = mission_json_for("msn_cmp_ok", 1, "prepared");
            created["template"] = json!("compare");
            (
                "200 OK".into(),
                json!({
                    "acknowledgement": "fresh",
                    "mission": created
                })
                .to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    {
        let form = panel.editor.form.as_mut().unwrap();
        assert_eq!(
            form.task_mode,
            TaskMode::Independent,
            "server missionProfileDefaults taskMode must initialize Create form"
        );
        // Selecting Compare enables Submit when two distinct models are configured.
        form.select_template(Template::Compare);
        assert_eq!(form.compare_error(), None);
        form.objective = TextEdit::new("Compare implementations");
        assert!(form.can_submit(None, None));
        // Explicit user task_mode selection is preserved across subsequent template switches.
        form.select_task_mode(TaskMode::Native);
        form.select_template(Template::Debug);
        assert_eq!(form.task_mode, TaskMode::Native);
        form.select_template(Template::Compare);
        assert_eq!(form.task_mode, TaskMode::Native);
    }

    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        !panel.has_editor()
    });
    let post = captured_post
        .lock()
        .unwrap()
        .clone()
        .expect("POST /missions must be sent for configured Compare");
    let body: Value = serde_json::from_str(post.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["template"], "compare");
    assert_eq!(body["taskMode"], "native");
    assert_eq!(body["profiles"]["roles"]["model-a"]["model"]["id"], "gpt-5");
    assert_eq!(
        body["profiles"]["roles"]["model-b"]["model"]["id"],
        "claude-sonnet-4"
    );
    assert_eq!(
        body["profiles"]["roles"]["comparator"]["model"]["id"],
        "claude-sonnet-4"
    );
    assert!(
        body["profiles"]["roles"]["comparator"]["model"]
            .get("variant")
            .is_none(),
        "default variant must be stripped from frozen comparator"
    );
}

#[test]
fn sse_reconnect_invalidates_generation_and_revokes_create_autostart() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel();
    let post_seen_tx = Arc::new(std::sync::Mutex::new(Some(post_seen_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_bg = release.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let seen = post_seen_tx.clone();
                let gate = release_bg.clone();
                let controls = control_calls_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        gate.notified().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_sse_reconn", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/control ") {
                        controls.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", "{}".into())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    let gen_before = panel.editor.form.as_ref().unwrap().generation;
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("SSE reconnect test");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;
    panel.submit_editor("tab-1", &mut holds);
    post_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("POST /missions must reach server");

    // SSE reconnect on the same HTTP client invalidates generation and revokes auto-start.
    panel.invalidate(None, 1.0);
    assert_ne!(
        panel.editor.form.as_ref().unwrap().generation,
        gen_before,
        "SSE reconnect must advance editor generation"
    );
    poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);

    // Late fresh ACK arrives after SSE reconnect: must not close form, hijack selection, or call /control.
    release.notify_one();
    let scope = panel.creation_scope_key();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds.creation(&scope).is_none()
    });
    assert!(panel.has_editor());
    assert_eq!(panel.selected, None);
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "SSE reconnect must prevent pre-disconnect Create ACK from dispatching /control"
    );
}

#[test]
fn same_tick_panel_401_blocks_pre_edit_doc_recheck_patch_dispatch() {
    let patch_calls = Arc::new(AtomicUsize::new(0));
    let patch_calls_bg = patch_calls.clone();
    let (dir_seen_tx, dir_seen_rx) = std::sync::mpsc::channel();
    let dir_seen_tx = Arc::new(std::sync::Mutex::new(Some(dir_seen_tx)));
    let schedule_count = Arc::new(AtomicUsize::new(0));
    let schedule_count_bg = schedule_count.clone();
    let release_both = Arc::new(tokio::sync::Barrier::new(2));
    let release_both_bg = release_both.clone();
    let orig_obj = "Doc objective";
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let patches = patch_calls_bg.clone();
                let seen = dir_seen_tx.clone();
                let sched_c = schedule_count_bg.clone();
                let barrier = release_both_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body): (&str, String) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.contains("/missions/panel-page") && raw.contains("\"summaries\"") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        barrier.wait().await;
                        ("401 Unauthorized", "expired".into())
                    } else if raw.contains("/missions/panel-page") {
                        ("500 Internal Server Error", "{}".into())
                    } else if raw.starts_with("GET /api/workspaces/ws-1/missions/msn_doc401/schedule ")
                    {
                        let n = sched_c.fetch_add(1, Ordering::SeqCst);
                        if n >= 1 {
                            barrier.wait().await;
                        }
                        (
                            "200 OK",
                            json!({
                                "pending": false,
                                "document": {
                                    "id": "msn_doc401",
                                    "kind": "one-time",
                                    "configuration": { "roots": [{ "mode": "directory-only", "directory": "/repo" }] },
                                    "edit": { "structural": false, "reason": "launched-once" }
                                }
                            })
                            .to_string(),
                        )
                    } else if raw.starts_with("GET /workspaces/ws-1/instance/api/location") {
                        (
                            "200 OK",
                            json!({ "directory": "/repo", "project": { "id": "prj_1" } }).to_string(),
                        )
                    } else if raw.contains("/content?") && raw.contains("field=objective") {
                        (
                            "200 OK",
                            json!({
                                "available": true,
                                "version": 1,
                                "projectID": "prj_1",
                                "missionID": "msn_doc401",
                                "revision": 2,
                                "content": {
                                    "kind": "mission",
                                    "field": "objective",
                                    "digest": content_digest(orig_obj),
                                    "offset": 0,
                                    "characters": utf16_len(orig_obj),
                                    "text": orig_obj,
                                    "next": null
                                }
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/content?") && raw.contains("field=notes") {
                        (
                            "200 OK",
                            json!({
                                "available": true,
                                "version": 1,
                                "projectID": "prj_1",
                                "missionID": "msn_doc401",
                                "revision": 2,
                                "refused": "content-not-found"
                            })
                            .to_string(),
                        )
                    } else if raw.starts_with("PATCH /api/workspaces/ws-1/missions/msn_doc401 ") {
                        patches.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", "{}".into())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let (wake_tx, wake_rx) = bounded(16);
    let wake: Wake = Arc::new(move || {
        let _ = wake_tx.try_send(());
    });
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        wake,
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    // Open Edit and finish initial prefill.
    let header = sample_doc_header_for("msn_doc401", 2, orig_obj);
    let scope = panel.creation_scope_key();
    assert!(panel.editor.open_edit(
        &header,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        None,
    ));
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.prefill == PrefillState::Ready)
    });
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Draft blocked by 401");

    // Start Summaries read (blocks on barrier to return 401 concurrently with pre-PATCH /schedule 200).
    panel.show(true);
    dir_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("summaries read must reach server");
    wait_until(|| {
        panel.poll();
        panel.failed(super::super::directory::Kind::Cleanups)
    });

    let state = crate::workspace::test_state_with_mission_panel(panel, holds);
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.update(|s, _| {
        let (tab_key, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
        while wake_rx.try_recv().is_ok() {}
        panel.submit_editor(&tab_key, mission_editor);
    });
    // Wait for submit wake + both async replies (Summaries 401 and /schedule 200).
    crate::platform::block_on(async {
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(3), wake_rx.recv())
                .await
                .expect("both Summaries 401 and /schedule 200 must arrive")
                .unwrap();
        }
    });
    rt.update(|s, tx| {
        crate::workspace::poll(s, 1.0, tx);
    });
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        patch_calls.load(Ordering::SeqCst),
        0,
        "same-tick panel 401 must block pre-edit /schedule from dispatching PATCH"
    );
    assert!(
        rt.state
            .screen
            .launcher()
            .is_some_and(|l| l.authentication_required),
        "panel 401 must trigger authentication recovery"
    );
    let panel_after = crate::workspace::test_mission_panel(&rt.state, 0);
    assert_eq!(
        panel_after.editor.form.as_ref().unwrap().objective.text,
        "Draft blocked by 401"
    );
}

#[test]
fn create_button_disabled_while_editor_open_and_open_create_preserves_draft() {
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();

    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Keep my unsaved draft");

    // Re-invoking open_create_editor while Create is already open must NOT reset the draft.
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Keep my unsaved draft"
    );

    // The right panel's Create button must render disabled and ignore clicks while the editor is open.
    struct PanelHost {
        panel: Panel,
        holds: EditorHolds,
        fallback: TextEdit,
        clicked: usize,
    }
    let mut rt = Runtime::new(
        PanelHost {
            panel,
            holds,
            fallback: TextEdit::new(""),
            clicked: 0,
        },
        |host, _| {
            super::super::view::panel_body(
                &host.panel,
                &host.holds,
                |h: &mut PanelHost| (Some(&mut h.panel), &mut h.fallback),
                rune::el(),
                None,
                |_, _| {},
                |h: &mut PanelHost, _, _| {
                    h.clicked += 1;
                },
            )
        },
        (400.0, 600.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let create_btn = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("missions-create"))
        .expect("Create button must be mounted");
    assert!(
        !create_btn.focusable,
        "Create button must be disabled (non-focusable) while Mission editor is open"
    );
    let (cx, cy) = rt
        .find("missions-create")
        .expect("Create button must be laid out");
    rt.pointer_down(cx, cy);
    rt.pointer_up(cx, cy);
    rt.frame(1.0 / 60.0);
    assert_eq!(
        rt.state.clicked, 0,
        "clicking disabled Create button must not fire OpenCreate"
    );
}

#[test]
fn pre_creation_summaries_refresh_cannot_clear_newly_created_selection() {
    let (list_seen_tx, list_seen_rx) = std::sync::mpsc::channel();
    let list_seen_tx = Arc::new(std::sync::Mutex::new(Some(list_seen_tx)));
    let release_list = Arc::new(tokio::sync::Notify::new());
    let release_list_bg = release_list.clone();
    let list_calls = Arc::new(AtomicUsize::new(0));
    let list_calls_bg = list_calls.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let seen = list_seen_tx.clone();
                let gate = release_list_bg.clone();
                let lc = list_calls_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.contains("/missions/panel-page") && raw.contains("\"summaries\"") {
                        let call_idx = lc.fetch_add(1, Ordering::SeqCst);
                        if call_idx == 0 {
                            if let Some(tx) = seen.lock().unwrap().take() {
                                let _ = tx.send(());
                            }
                            gate.notified().await;
                            // Pre-creation empty list covering total=0.
                            let order = "a".repeat(43);
                            (
                                "200 OK",
                                json!({
                                    "available": true,
                                    "version": 1,
                                    "projectID": "prj_1",
                                    "source": "summaries",
                                    "discardedEvents": 0,
                                    "controlUnavailable": false,
                                    "notificationUnavailable": false,
                                    "cleanupUnavailable": false,
                                    "finishHighWater": 0,
                                    "window": {
                                        "order": order,
                                        "offset": 0,
                                        "end": 0,
                                        "total": 0
                                    },
                                    "page": {
                                        "digest": content_digest("[]"),
                                        "total": 0,
                                        "pieces": []
                                    }
                                })
                                .to_string(),
                            )
                        } else {
                            // Post-creation list containing msn_fresh1.
                            let order = "b".repeat(43);
                            let row = json!({
                                "id": "msn_fresh1",
                                "title": "Fresh",
                                "objective": "Fresh",
                                "status": "active",
                                "runState": "prepared",
                                "coordinatorSessionId": "ses_coord1",
                                "actorCount": 1,
                                "revision": 1,
                                "updatedAt": 2.0
                            })
                            .to_string();
                            let digest = content_digest(&format!("[{row}]"));
                            (
                                "200 OK",
                                json!({
                                    "available": true,
                                    "version": 1,
                                    "projectID": "prj_1",
                                    "source": "summaries",
                                    "discardedEvents": 0,
                                    "controlUnavailable": false,
                                    "notificationUnavailable": false,
                                    "cleanupUnavailable": false,
                                    "finishHighWater": 0,
                                    "window": {
                                        "order": order,
                                        "offset": 0,
                                        "end": 1,
                                        "total": 1
                                    },
                                    "page": {
                                        "digest": digest,
                                        "total": 1,
                                        "pieces": [{
                                            "index": 0,
                                            "offset": 0,
                                            "characters": utf16_len(&row),
                                            "text": row
                                        }]
                                    }
                                })
                                .to_string(),
                            )
                        }
                    } else if raw.contains("/missions/panel-page") {
                        ("500 Internal Server Error", "{}".into())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_fresh1", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    // Start a pre-creation Summaries read.
    panel.show(true);
    list_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("pre-creation summaries read must reach server");

    // Create a new Mission while the stale Summaries read is in flight.
    open_create_ready(
        &mut panel,
        &mut holds,
        &mut lifecycle,
        Some("missions-create".into()),
    );
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Fresh");
    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        !panel.has_editor()
    });
    assert_eq!(panel.selected.as_deref(), Some("msn_fresh1"));

    // Release the pre-creation empty list response; it must be ignored and the new refresh must keep selection!
    release_list.notify_one();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel.summaries.iter().any(|row| row.id == "msn_fresh1")
    });
    assert_eq!(
        panel.selected.as_deref(),
        Some("msn_fresh1"),
        "pre-creation Summaries response must not clear newly created Mission selection"
    );
}

#[test]
fn edit_button_disabled_while_editing_and_open_edit_preserves_same_mission_draft() {
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    panel.fixture_ready_with_lookup(
        sample_header(2, Some("Original"), None, "running"),
        "tsk_1",
        "k1",
    );
    panel.detail.cancel_lookup();

    assert!(panel.open_edit_editor(&mut holds, Some("mission-edit".into())));
    {
        let form = panel.editor.form.as_mut().unwrap();
        form.prefill = PrefillState::Ready;
        form.has_loaded_draft = true;
        form.objective = TextEdit::new("Keep my edited draft");
    }

    // Re-invoking open_edit_editor on the same Mission must not reset the draft.
    assert!(!panel.open_edit_editor(&mut holds, Some("mission-edit".into())));
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Keep my edited draft"
    );

    // The right panel's Edit button must render disabled and ignore clicks while the editor is open.
    struct PanelHost {
        panel: Panel,
        holds: EditorHolds,
        fallback: TextEdit,
        clicked: usize,
    }
    let mut rt = Runtime::new(
        PanelHost {
            panel,
            holds,
            fallback: TextEdit::new(""),
            clicked: 0,
        },
        |host, _| {
            super::super::view::panel_body(
                &host.panel,
                &host.holds,
                |h: &mut PanelHost| (Some(&mut h.panel), &mut h.fallback),
                rune::el(),
                None,
                |_, _| {},
                |h: &mut PanelHost, _, _| {
                    h.clicked += 1;
                },
            )
        },
        (400.0, 600.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let (ex, ey) = rt
        .find("mission-edit")
        .expect("Edit button must be laid out");
    rt.pointer_down(ex, ey);
    rt.pointer_up(ex, ey);
    rt.frame(1.0 / 60.0);
    assert_eq!(
        rt.state.clicked, 0,
        "clicking disabled Edit button while editing must not fire OpenEdit"
    );
}

#[test]
fn control_fields_401_propagates_through_panel_and_blocks_create_autostart() {
    let (cf_seen_tx, cf_seen_rx) = std::sync::mpsc::channel();
    let cf_seen_tx = Arc::new(std::sync::Mutex::new(Some(cf_seen_tx)));
    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.contains("/missions/panel-page") {
            if let Some(tx) = cf_seen_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
            ("401 Unauthorized".into(), "expired".into())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let (wake_tx, wake_rx) = bounded(8);
    let wake: Wake = Arc::new(move || {
        let _ = wake_tx.try_send(());
    });
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        wake,
    );
    let header_with_control: MapHeader = serde_json::from_value(json!({
        "root": {
            "version": 1,
            "id": "msn_cf_401",
            "projectID": "prj_1",
            "projectCanonical": "/repo",
            "title": "Alpha",
            "excerpt": "Objective",
            "template": "custom",
            "taskMode": "native",
            "status": "active",
            "runState": "running",
            "revision": 2,
            "coordinatorSessionId": "ses_coord",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "historyTruncated": false,
            "bodies": {}
        },
        "collections": {
            "actors": { "characters": 0, "digest": "", "total": 0, "array": true },
            "history": { "characters": 0, "digest": "", "total": 0, "array": true },
            "reports": { "characters": 0, "digest": "", "total": 0, "array": true }
        },
        "tasks": {
            "version": "",
            "page": { "order": "", "offset": 0, "end": 0, "total": 0, "reports": 0, "counts": {} },
            "pins": [],
            "reportPins": []
        },
        "control": {
            "id": "op_1",
            "requestID": "req_1",
            "action": "pause",
            "expectedRevision": 1,
            "pending": 1,
            "receipts": 1,
            "unconfirmedReceipts": 0,
            "partialDescendants": 0
        }
    }))
    .unwrap();
    panel.fixture_ready_with_lookup(header_with_control, "tsk_1", "k1");
    panel.detail.cancel_lookup();
    panel.read_control_field(codenomad_client::missions::ControlPart::Receipts, 0);
    cf_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("control-fields read must reach server");
    crate::platform::block_on(async {
        tokio::time::timeout(Duration::from_secs(3), wake_rx.recv())
            .await
            .expect("control-fields 401 reply must arrive")
            .unwrap();
    });
    // Even if cancel() runs before poll(), the arrived 401 must survive and surface via Panel::drain_auth_expired.
    panel.control_fields.cancel();
    assert_eq!(
        panel.drain_auth_expired().len(),
        1,
        "Control-fields 401 must survive cancel() and surface through Panel::drain_auth_expired"
    );

    // Same-tick control-fields 401 with an active Create ACK must block auto-start /control.
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let barrier_bg = barrier.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let gate = barrier_bg.clone();
                let controls = control_calls_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.contains("/missions/panel-page") {
                        gate.wait().await;
                        ("401 Unauthorized", "expired".into())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        gate.wait().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_cf_create", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/control ") {
                        controls.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", "{}".into())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base2 = rx.recv().unwrap();
    let backend2 = attested_backend(base2);
    let (wake2_tx, wake2_rx) = bounded(16);
    let wake2: Wake = Arc::new(move || {
        let _ = wake2_tx.try_send(());
    });
    let mut panel2 = Panel::new(backend2, Some("prj_1".into()), Reads::default(), wake2);
    let header2: MapHeader = serde_json::from_value(json!({
        "root": {
            "version": 1,
            "id": "msn_cf_402",
            "projectID": "prj_1",
            "projectCanonical": "/repo",
            "title": "Alpha",
            "excerpt": "Objective",
            "template": "custom",
            "taskMode": "native",
            "status": "active",
            "runState": "running",
            "revision": 2,
            "coordinatorSessionId": "ses_coord",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "historyTruncated": false,
            "bodies": {}
        },
        "collections": {
            "actors": { "characters": 0, "digest": "", "total": 0, "array": true },
            "history": { "characters": 0, "digest": "", "total": 0, "array": true },
            "reports": { "characters": 0, "digest": "", "total": 0, "array": true }
        },
        "tasks": {
            "version": "",
            "page": { "order": "", "offset": 0, "end": 0, "total": 0, "reports": 0, "counts": {} },
            "pins": [],
            "reportPins": []
        },
        "control": {
            "id": "op_2",
            "requestID": "req_2",
            "action": "pause",
            "expectedRevision": 1,
            "pending": 1,
            "receipts": 1,
            "unconfirmedReceipts": 0,
            "partialDescendants": 0
        }
    }))
    .unwrap();
    panel2.fixture_ready_with_lookup(header2, "tsk_1", "k1");
    panel2.detail.cancel_lookup();
    let mut holds2 = EditorHolds::default();
    let mut lifecycle2 = Lifecycle::default();
    open_create_ready(&mut panel2, &mut holds2, &mut lifecycle2, None);
    panel2.editor.form.as_mut().unwrap().objective = TextEdit::new("Blocked by control_fields 401");
    panel2.editor.form.as_mut().unwrap().start_on_creation = true;

    let state = crate::workspace::test_state_with_mission_panel(panel2, holds2);
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.update(|s, _| {
        let (tab_key, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
        while wake2_rx.try_recv().is_ok() {}
        panel.read_control_field(codenomad_client::missions::ControlPart::Receipts, 0);
        panel.submit_editor(&tab_key, mission_editor);
    });
    crate::platform::block_on(async {
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_secs(3), wake2_rx.recv())
                .await
                .expect("both control_fields 401 and Create ACK must arrive")
                .unwrap();
        }
    });
    rt.update(|s, tx| {
        crate::workspace::poll(s, 1.0, tx);
    });
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "control_fields 401 must block Create auto-start /control"
    );
    assert!(
        rt.state
            .screen
            .launcher()
            .is_some_and(|l| l.authentication_required),
        "control_fields 401 must trigger authentication recovery"
    );
}

#[test]
fn create_validates_default_profiles_against_native_catalog_for_removed_models_and_task_mode() {
    let include_gpt5 = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let include_gpt5_bg = include_gpt5.clone();
    let post_calls = Arc::new(AtomicUsize::new(0));
    let post_calls_bg = post_calls.clone();
    let (base, _) = start_scripted_server_raw(move |_idx, raw| {
        if raw.starts_with("GET /api/storage/config/ui") {
            (
                "200 OK".into(),
                json!({
                    "settings": {
                        "missionProfileDefaults": [{
                            "template": "all",
                            "taskMode": "native",
                            "profiles": {
                                "coordinator": {
                                    "agent": "build",
                                    "model": { "providerID": "openai", "id": "gpt-5" }
                                },
                                "roles": {
                                    "specialist": { "agent": "explore" }
                                }
                            }
                        }]
                    }
                })
                .to_string(),
            )
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/agent") {
            (
                "200 OK".into(),
                json!({
                    "location": { "directory": "/repo" },
                    "data": [
                        { "id": "build", "mode": "primary" },
                        { "id": "explore", "mode": "subagent" }
                    ]
                })
                .to_string(),
            )
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/model") {
            let models = if include_gpt5_bg.load(Ordering::SeqCst) {
                json!([{
                    "providerID": "openai",
                    "id": "gpt-5",
                    "enabled": true,
                    "capabilities": { "tools": true },
                    "variants": []
                }])
            } else {
                json!([])
            };
            (
                "200 OK".into(),
                json!({
                    "location": { "directory": "/repo" },
                    "data": models
                })
                .to_string(),
            )
        } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            post_calls_bg.fetch_add(1, Ordering::SeqCst);
            (
                "200 OK".into(),
                json!({
                    "acknowledgement": "fresh",
                    "mission": mission_json_for("msn_cat_ok", 1, "prepared")
                })
                .to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(&mut panel, &mut holds, &mut lifecycle, None);
    let scope = panel.creation_scope_key();
    {
        let form = panel.editor.form.as_mut().unwrap();
        form.objective = TextEdit::new("Validate native catalog");
        assert_eq!(form.task_mode, TaskMode::Native);
        assert_eq!(form.profile_catalog_error(), None);
        assert!(form.can_submit(None, None));

        // Switching to Independent invalidates the subagent-only specialist role before POST /missions.
        form.select_task_mode(TaskMode::Independent);
        assert_eq!(
            form.profile_catalog_error(),
            Some("missions.control.profiles.error")
        );
        assert!(!form.can_submit(None, None));
    }
    panel.submit_editor("tab-1", &mut holds);
    assert_eq!(post_calls.load(Ordering::SeqCst), 0);
    assert!(holds.creation(&scope).is_none());

    // Switching back to Native restores validity.
    {
        let form = panel.editor.form.as_mut().unwrap();
        form.select_task_mode(TaskMode::Native);
        assert_eq!(form.profile_catalog_error(), None);
        assert!(form.can_submit(None, None));
    }

    // Removing the saved default model from the native catalog blocks Submit without creating a hold.
    include_gpt5.store(false, Ordering::SeqCst);
    panel
        .editor
        .retry_defaults(&panel.backend, &panel.reads, &panel.wake);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.defaults_state == DefaultsState::Ready)
    });
    assert_eq!(
        panel.editor.form.as_ref().unwrap().profile_catalog_error(),
        Some("missions.control.profiles.error")
    );
    assert!(!panel.editor.form.as_ref().unwrap().can_submit(None, None));
    panel.submit_editor("tab-1", &mut holds);
    assert_eq!(post_calls.load(Ordering::SeqCst), 0);
    assert!(holds.creation(&scope).is_none());

    // Restoring the model and retrying defaults unblocks Submit.
    include_gpt5.store(true, Ordering::SeqCst);
    panel
        .editor
        .retry_defaults(&panel.backend, &panel.reads, &panel.wake);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.defaults_state == DefaultsState::Ready)
    });
    assert_eq!(
        panel.editor.form.as_ref().unwrap().profile_catalog_error(),
        None
    );
    assert!(panel.editor.form.as_ref().unwrap().can_submit(None, None));
}

#[test]
fn create_revalidates_native_catalog_at_submit_so_disabled_model_never_posts() {
    let include_gpt5 = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let include_gpt5_bg = include_gpt5.clone();
    let post_calls = Arc::new(AtomicUsize::new(0));
    let post_calls_bg = post_calls.clone();
    let (base, _) = start_scripted_server_raw(move |_idx, raw| {
        if raw.starts_with("GET /api/storage/config/ui") {
            (
                "200 OK".into(),
                json!({
                    "settings": {
                        "missionProfileDefaults": [{
                            "template": "all",
                            "taskMode": "native",
                            "profiles": {
                                "coordinator": {
                                    "model": { "providerID": "openai", "id": "gpt-5" }
                                }
                            }
                        }]
                    }
                })
                .to_string(),
            )
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/agent") {
            (
                "200 OK".into(),
                json!({ "location": { "directory": "/repo" }, "data": [] }).to_string(),
            )
        } else if raw.starts_with("GET /workspaces/ws-1/instance/api/model") {
            let models = if include_gpt5_bg.load(Ordering::SeqCst) {
                json!([{
                    "providerID": "openai",
                    "id": "gpt-5",
                    "enabled": true,
                    "capabilities": { "tools": true },
                    "variants": []
                }])
            } else {
                json!([])
            };
            (
                "200 OK".into(),
                json!({ "location": { "directory": "/repo" }, "data": models }).to_string(),
            )
        } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            post_calls_bg.fetch_add(1, Ordering::SeqCst);
            (
                "200 OK".into(),
                json!({
                    "acknowledgement": "fresh",
                    "mission": mission_json_for("msn_recheck_ok", 1, "prepared")
                })
                .to_string(),
            )
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();

    open_create_ready(&mut panel, &mut holds, &mut lifecycle, None);
    let scope = panel.creation_scope_key();
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Submit after disable");
    assert!(panel.editor.form.as_ref().unwrap().can_submit(None, None));

    // Model is disabled AFTER the Create form opened and BEFORE clicking Submit.
    include_gpt5.store(false, Ordering::SeqCst);
    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| !f.catalog_rechecking)
    });
    assert_eq!(
        panel.editor.form.as_ref().unwrap().profile_catalog_error(),
        Some("missions.control.profiles.error"),
        "submit-time catalog recheck must surface profile error when model disappeared"
    );
    assert_eq!(
        post_calls.load(Ordering::SeqCst),
        0,
        "stale model must be rejected before POST /missions"
    );
    assert!(
        holds.creation(&scope).is_none(),
        "stale model must never leave an uncertain creation hold"
    );

    // Re-enable model, retry defaults, and submit cleanly.
    include_gpt5.store(true, Ordering::SeqCst);
    panel
        .editor
        .retry_defaults(&panel.backend, &panel.reads, &panel.wake);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.defaults_state == DefaultsState::Ready)
    });
    panel.submit_editor("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        !panel.has_editor()
    });
    assert_eq!(post_calls.load(Ordering::SeqCst), 1);
    assert_eq!(panel.selected.as_deref(), Some("msn_recheck_ok"));
}

#[test]
fn sse_connection_lost_immediately_revokes_autostart_before_reconnect() {
    let control_calls = Arc::new(AtomicUsize::new(0));
    let control_calls_bg = control_calls.clone();
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel();
    let post_seen_tx = Arc::new(std::sync::Mutex::new(Some(post_seen_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let release_bg = release.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let _ = tx.send(format!("http://{addr}/"));
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let seen = post_seen_tx.clone();
                let gate = release_bg.clone();
                let controls = control_calls_bg.clone();
                tokio::spawn(async move {
                    let raw = read_http_request(&mut socket).await;
                    let (status, body) = if raw.starts_with("GET /api/meta ") {
                        (
                            "200 OK",
                            json!({"apiContract": 1, "serverId": "fixture-server"}).to_string(),
                        )
                    } else if raw.starts_with("GET /api/storage/config/ui") {
                        ("200 OK", json!({"settings": {}}).to_string())
                    } else if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
                        if let Some(tx) = seen.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        gate.notified().await;
                        (
                            "200 OK",
                            json!({
                                "acknowledgement": "fresh",
                                "mission": mission_json_for("msn_connlost", 1, "prepared")
                            })
                            .to_string(),
                        )
                    } else if raw.contains("/control ") {
                        controls.fetch_add(1, Ordering::SeqCst);
                        ("200 OK", "{}".into())
                    } else {
                        ("404 Not Found", "{}".into())
                    };
                    let reply = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
    });
    let base = rx.recv().unwrap();
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    open_create_ready(&mut panel, &mut holds, &mut lifecycle, None);
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Drop before ACK");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;

    let state = crate::workspace::test_state_with_mission_panel(panel, holds);
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.update(|s, _| {
        let (tab_key, panel, mission_editor) = crate::workspace::test_mission_entry_mut(s, 0);
        panel.submit_editor(&tab_key, mission_editor);
    });
    post_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("POST /missions must reach server");

    // SSE ConnectionLost arrives BEFORE any Reconnect event: must immediately advance generation and revoke auto-start.
    rt.update(|s, _| {
        crate::workspace::on_mission_transport_lost(s);
    });
    release.notify_one();
    wait_until(|| {
        rt.update(|s, tx| {
            crate::workspace::poll(s, 1.0, tx);
        });
        let (_, panel, mission_editor) = crate::workspace::test_mission_entry_mut(&mut rt.state, 0);
        let scope = panel.creation_scope_key();
        mission_editor.creation(&scope).is_none()
    });
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(
        control_calls.load(Ordering::SeqCst),
        0,
        "ConnectionLost must revoke auto-start before any Reconnect event arrives"
    );
    assert!(
        crate::workspace::test_mission_panel(&rt.state, 0).has_editor(),
        "late ACK after ConnectionLost must not close editor form"
    );
}

#[test]
fn managed_renewal_with_authentication_required_blocks_mission_editor() {
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    assert!(panel.has_editor());

    let mut state = crate::workspace::test_state_with_mission_panel(panel, holds);
    assert!(crate::workspace::mission_has_editor(&state));
    if let Some(launcher) = state.screen.launcher_mut() {
        launcher.authentication_required = true;
    }
    assert!(
        !crate::workspace::mission_has_editor(&state),
        "authentication_required must block Mission editor even when launcher does not replace project"
    );
    assert!(!crate::workspace::mission_has_reader(&state));
}

#[test]
fn tab_close_blocks_creation_hold_and_unsaved_draft_and_drains_401_when_closing() {
    // 1. Uncertain creation hold blocks tab close so workspace receipt is never destroyed.
    let (base, _) = start_scripted_server(|_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            ("500 Internal Server Error".into(), "{}".into())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    open_create_ready(&mut panel, &mut holds, &mut lifecycle, None);
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Hold tab open");
    panel.submit_editor("tab-1", &mut holds);
    let scope = panel.creation_scope_key();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds
            .creation(&scope)
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });
    panel.close_reader();

    let state = crate::workspace::test_state_with_mission_panel(panel, holds);
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let tab_key = crate::workspace::test_mission_entry_mut(&mut rt.state, 0).0;
    rt.update(|s, tx| {
        crate::workspace::close(s, &tab_key, tx);
    });
    assert_eq!(
        crate::workspace::test_mission_entry_mut(&mut rt.state, 0).0,
        tab_key,
        "tab with uncertain creation hold must refuse close"
    );

    // 2. Unsaved draft without hold also blocks tab close.
    let backend2 = unattested_backend("http://127.0.0.1:9/".into());
    let mut panel2 = Panel::new(
        backend2,
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds2 = EditorHolds::default();
    panel2.open_create_editor(&mut holds2, None);
    panel2.editor.form.as_mut().unwrap().objective = TextEdit::new("Unsaved work");
    let state2 = crate::workspace::test_state_with_mission_panel(panel2, holds2);
    let mut rt2 = Runtime::new(
        state2,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt2.frame(0.0);
    let tab_key2 = crate::workspace::test_mission_entry_mut(&mut rt2.state, 0).0;
    rt2.update(|s, tx| {
        crate::workspace::close(s, &tab_key2, tx);
    });
    assert_eq!(
        crate::workspace::test_mission_entry_mut(&mut rt2.state, 0).0,
        tab_key2,
        "tab with unsaved Mission editor draft must refuse close"
    );

    // 3. Closing a clean tab with an arrived 401 on its Mission panel drains the 401 into auth recovery.
    let (obs_seen_tx, obs_seen_rx) = std::sync::mpsc::channel();
    let obs_seen_tx = Arc::new(std::sync::Mutex::new(Some(obs_seen_tx)));
    let (base3, _) = start_scripted_server(move |_idx, raw| {
        if raw.contains("/missions/panel-page") {
            if let Some(tx) = obs_seen_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
            ("401 Unauthorized".into(), "expired".into())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend3 = attested_backend(base3);
    let (wake3_tx, wake3_rx) = bounded(8);
    let wake3: Wake = Arc::new(move || {
        let _ = wake3_tx.try_send(());
    });
    let mut panel3 = Panel::new(
        backend3.clone(),
        Some("prj_1".into()),
        Reads::default(),
        wake3,
    );
    panel3.observation.refresh();
    assert!(panel3.observation.poll(
        &backend3,
        "prj_1",
        "msn_tab_401",
        2,
        &Reads::default(),
        &panel3.wake,
    ));
    obs_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("activity read must reach server");
    crate::platform::block_on(async {
        tokio::time::timeout(Duration::from_secs(3), wake3_rx.recv())
            .await
            .expect("401 reply must arrive before tab close")
            .unwrap();
    });
    let state3 = crate::workspace::test_state_with_mission_panel(panel3, EditorHolds::default());
    let mut rt3 = Runtime::new(
        state3,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt3.frame(0.0);
    let tab_key3 = crate::workspace::test_mission_entry_mut(&mut rt3.state, 0).0;
    rt3.update(|s, tx| {
        crate::workspace::close(s, &tab_key3, tx);
    });
    assert!(
        rt3.state
            .screen
            .launcher()
            .is_some_and(|l| l.authentication_required),
        "closing a tab must drain pending Mission panel 401s into authentication recovery"
    );
}

#[test]
fn unsaved_editor_draft_prompts_before_navigation_or_close_and_discards_only_on_confirm() {
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let mut panel = Panel::new(backend, Some("prj_1".into()), Reads::default(), noop_wake());
    let mut holds = EditorHolds::default();
    panel.summaries = vec![
        serde_json::from_value(json!({
            "id": "msn_one",
            "title": "One",
            "objective": "First",
            "status": "active",
            "runState": "running",
            "coordinatorSessionId": "ses_1",
            "actorCount": 1,
            "revision": 1,
            "updatedAt": 1.0
        }))
        .unwrap(),
        serde_json::from_value(json!({
            "id": "msn_two",
            "title": "Two",
            "objective": "Second",
            "status": "active",
            "runState": "running",
            "coordinatorSessionId": "ses_2",
            "actorCount": 1,
            "revision": 1,
            "updatedAt": 2.0
        }))
        .unwrap(),
    ];
    panel.selected = Some("msn_one".into());

    // Open Create and type an unsaved draft.
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Unsaved instructions");

    // Clicking another Mission row must NOT wipe the draft; it arms pending_leave instead.
    panel.select("msn_two");
    assert!(panel.has_editor());
    assert_eq!(panel.selected.as_deref(), Some("msn_one"));
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Unsaved instructions"
    );
    assert_eq!(
        panel.editor.form.as_ref().unwrap().pending_leave,
        Some(LeaveIntent::SelectMission("msn_two".into()))
    );

    // Cancelling the discard prompt keeps the draft intact.
    panel.editor_gesture("tab-1", &mut holds, EditorGesture::CancelDiscard);
    assert_eq!(panel.editor.form.as_ref().unwrap().pending_leave, None);
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Unsaved instructions"
    );

    // Requesting close via Close button / Escape prompts instead of destroying the draft.
    assert_eq!(
        panel.request_close_surface(&holds, false),
        CloseSurface::PromptedDiscard
    );
    assert!(panel.has_editor());
    // Escape while prompt is open cancels the prompt and preserves the draft.
    assert_eq!(
        panel.request_close_surface(&holds, true),
        CloseSurface::CancelledPrompt
    );
    assert!(panel.has_editor());
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Unsaved instructions"
    );

    // Clicking overview eye on msn_two arms OpenOverview; confirming Discard switches & opens reader.
    assert!(!panel.toggle_overview("msn_two"));
    assert!(panel.has_editor());
    assert_eq!(
        panel.editor.form.as_ref().unwrap().pending_leave,
        Some(LeaveIntent::OpenOverview("msn_two".into()))
    );
    let confirmed = panel.confirm_discard_editor(&mut holds);
    assert_eq!(
        confirmed.map(|(intent, _)| intent),
        Some(LeaveIntent::OpenOverview("msn_two".into()))
    );
    assert!(!panel.has_editor());
    assert_eq!(panel.selected.as_deref(), Some("msn_two"));
    assert!(panel.has_reader());
}

#[test]
fn deferred_submits_do_not_dispatch_when_discard_prompt_or_preview_obscures_editor() {
    let posts = Arc::new(AtomicUsize::new(0));
    let posts_srv = posts.clone();
    let (base, _) = start_scripted_server(move |_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            posts_srv.fetch_add(1, Ordering::SeqCst);
        }
        ("500 Internal Server Error".into(), "{}".into())
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    open_create_ready(&mut panel, &mut holds, &mut lifecycle, None);
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Draft with deferred submit");
    panel.editor.form.as_mut().unwrap().start_on_creation = true;
    let submit_gen = panel.editor.form.as_ref().unwrap().generation;
    panel.editor.ready_create_submit = Some(("tab-1".into(), submit_gen, backend.clone()));

    // Opening the discard confirmation must cancel the deferred POST and hide active editor context.
    assert_eq!(
        panel.request_close_surface(&holds, false),
        CloseSurface::PromptedDiscard
    );
    assert!(
        panel.active_editor("tab-1").is_none(),
        "active editor context must be hidden while discard confirmation is open"
    );
    assert!(
        !panel.commit_editor_submit(&mut holds, &[]),
        "deferred POST must not dispatch while discard confirmation is open"
    );
    assert_eq!(posts.load(Ordering::SeqCst), 0);

    // Dismissing the prompt keeps the draft; obscuring behind a Git/Files preview cancels deferred POST.
    panel.editor_gesture("tab-1", &mut holds, EditorGesture::CancelDiscard);
    let gen2 = panel.editor.form.as_ref().unwrap().generation;
    panel.editor.ready_create_submit = Some(("tab-1".into(), gen2, backend));
    panel.close_reader_preserving_dirty_editor(&holds);
    assert!(panel.has_editor(), "dirty editor must remain preserved");
    assert!(
        !panel.commit_editor_submit(&mut holds, &[]),
        "obscuring the editor behind a preview must cancel any deferred POST"
    );
    assert_eq!(posts.load(Ordering::SeqCst), 0);
}

#[test]
fn tab_close_unblocks_after_unknown_creation_receipt_and_retires_hold() {
    let (base, _) = start_scripted_server(|_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            ("500 Internal Server Error".into(), "{}".into())
        } else if raw.contains("/missions/creation/") {
            ("200 OK".into(), json!({ "state": "unknown" }).to_string())
        } else {
            ("404 Not Found".into(), "{}".into())
        }
    });
    let backend = attested_backend(base);
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    let mut lifecycle = Lifecycle::default();
    open_create_ready(&mut panel, &mut holds, &mut lifecycle, None);
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Never reached server");
    panel.submit_editor("tab-1", &mut holds);
    let scope = panel.creation_scope_key();
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds
            .creation(&scope)
            .is_some_and(|h| h.state == HoldState::Uncertain)
    });

    // Before checking the receipt, closing the tab is blocked.
    assert!(holds.creation_blocks_tab_close(&scope));

    // User clicks Refresh -> server reports state: "unknown".
    panel.reconcile_editor_creation("tab-1", &mut holds);
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        holds
            .creation(&scope)
            .is_some_and(|h| h.state == HoldState::Uncertain && !h.checking)
    });
    // Hold stays active in-tab (still fences duplicate POSTs), but tab close is now allowed.
    assert!(holds.creation(&scope).is_some());
    assert!(!holds.creation_blocks_tab_close(&scope));
    assert!(!holds.has_blocking_creation_for_workspace(&backend));

    panel.close_reader();
    let state = crate::workspace::test_state_with_mission_panel(panel, holds);
    let mut rt = Runtime::new(
        state,
        |_, _| rune::el(),
        (1200.0, 800.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let tab_key = crate::workspace::test_mission_entry_mut(&mut rt.state, 0).0;
    rt.update(|s, tx| {
        crate::workspace::close(s, &tab_key, tx);
    });
    let (after_key, has_panel, holds_after) =
        crate::workspace::test_tab_state_and_holds(&rt.state, 0);
    assert_ne!(
        after_key, tab_key,
        "tab must close once creation receipt has been checked and returned unknown"
    );
    assert!(!has_panel, "replacement blank tab must not keep old panel");
    assert!(
        holds_after.creation(&scope).is_none(),
        "closing the tab must retire the dead workspace creation hold"
    );
}

#[test]
fn sse_reconnecting_preserves_pending_edit_recheck_while_connection_lost_cancels_it() {
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let mut panel = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    );
    let mut holds = EditorHolds::default();
    panel.open_create_editor(&mut holds, None);
    let submit_gen = panel.editor.form.as_ref().unwrap().generation;
    panel.editor.ready_create_submit = Some(("tab-1".into(), submit_gen, backend));

    let mut state = crate::workspace::test_state_with_mission_panel(panel, holds);
    let (evt_tx, evt_rx) = bounded(4);
    state.incoming = Some(evt_rx);

    // Event::Reconnecting (e.g. history refresh hint) must NOT cancel the pending submit.
    let _ = evt_tx.try_send(crate::transport::Event::Reconnecting);
    let _ = crate::chat::events::poll_chat(&mut state, 8);
    let (_, panel_after_reconnecting, _) = crate::workspace::test_mission_entry_mut(&mut state, 0);
    assert!(
        panel_after_reconnecting
            .editor
            .ready_create_submit
            .is_some(),
        "Event::Reconnecting alone must preserve deferred submit"
    );

    // Event::ConnectionLost MUST immediately cancel the deferred submit.
    let _ = evt_tx.try_send(crate::transport::Event::ConnectionLost);
    let _ = crate::chat::events::poll_chat(&mut state, 8);
    let (_, panel_after_lost, _) = crate::workspace::test_mission_entry_mut(&mut state, 0);
    assert!(
        panel_after_lost.editor.ready_create_submit.is_none(),
        "Event::ConnectionLost must cancel deferred submit immediately"
    );
}

fn sample_doc_header_for(mission_id: &str, revision: u64, objective: &str) -> MapHeader {
    serde_json::from_value(json!({
        "root": {
            "version": 1,
            "id": mission_id,
            "projectID": "prj_1",
            "projectCanonical": "/repo",
            "title": "Alpha",
            "excerpt": objective,
            "template": "custom",
            "taskMode": "native",
            "status": "active",
            "runState": "running",
            "revision": revision,
            "coordinatorSessionId": "ses_coord",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "historyTruncated": false,
            "bodies": {
                "objective": {
                    "characters": utf16_len(objective),
                    "digest": content_digest(objective)
                }
            },
            "document": { "revision": revision, "state": "active", "dormant": false }
        },
        "collections": {
            "actors": { "characters": 0, "digest": "", "total": 0, "array": true },
            "history": { "characters": 0, "digest": "", "total": 0, "array": true },
            "reports": { "characters": 0, "digest": "", "total": 0, "array": true }
        },
        "tasks": {
            "version": "",
            "page": { "order": "", "offset": 0, "end": 0, "total": 0, "reports": 0, "counts": {} },
            "pins": [],
            "reportPins": []
        }
    }))
    .unwrap()
}

fn mission_page_envelope(mission_id: &str, revision: u64, objective: &str) -> String {
    mission_page_envelope_impl(mission_id, revision, objective, false)
}

fn mission_doc_page_envelope(mission_id: &str, revision: u64, objective: &str) -> String {
    mission_page_envelope_impl(mission_id, revision, objective, true)
}

fn mission_page_envelope_impl(
    mission_id: &str,
    revision: u64,
    objective: &str,
    with_document: bool,
) -> String {
    let order = "a".repeat(43);
    let mut root = json!({
        "version": 1,
        "id": mission_id,
        "projectID": "prj_1",
        "projectCanonical": "/repo",
        "title": "Alpha",
        "excerpt": objective,
        "template": "custom",
        "taskMode": "native",
        "status": "active",
        "runState": "running",
        "revision": revision,
        "coordinatorSessionId": "ses_coord",
        "createdAt": 1.0,
        "updatedAt": 1.0,
        "historyTruncated": false,
        "bodies": {
            "objective": {
                "characters": utf16_len(objective),
                "digest": content_digest(objective)
            }
        }
    });
    if with_document {
        root["document"] = json!({ "revision": revision, "state": "active", "dormant": false });
    }
    let payload = json!({
        "root": root,
        "collections": {
            "actors": { "characters": 2, "digest": order, "total": 0, "array": true },
            "history": { "characters": 2, "digest": order, "total": 0, "array": true },
            "reports": { "characters": 2, "digest": order, "total": 0, "array": true }
        },
        "tasks": {
            "version": order,
            "page": {
                "order": order,
                "offset": 0,
                "end": 0,
                "total": 0,
                "reports": 0,
                "counts": {}
            },
            "pins": [],
            "reportPins": []
        }
    })
    .to_string();
    let digest = content_digest(&format!("[{payload}]"));
    json!({
        "available": true,
        "version": 1,
        "projectID": "prj_1",
        "source": "mission",
        "discardedEvents": 0,
        "controlUnavailable": false,
        "notificationUnavailable": false,
        "cleanupUnavailable": false,
        "missionID": mission_id,
        "revision": revision,
        "header": true,
        "page": {
            "digest": digest,
            "total": 1,
            "pieces": [{
                "index": 0,
                "offset": 0,
                "characters": utf16_len(&payload),
                "text": payload
            }]
        }
    })
    .to_string()
}

fn tasks_page_envelope(mission_id: &str, revision: u64) -> String {
    let order = "a".repeat(43);
    let payload = json!({
        "taskPage": {
            "order": order,
            "offset": 0,
            "end": 0,
            "total": 0,
            "reports": 0,
            "counts": {}
        },
        "tasks": [],
        "reports": []
    })
    .to_string();
    let digest = content_digest(&format!("[{payload}]"));
    json!({
        "available": true,
        "version": 1,
        "projectID": "prj_1",
        "source": "tasks",
        "discardedEvents": 0,
        "controlUnavailable": false,
        "notificationUnavailable": false,
        "cleanupUnavailable": false,
        "missionID": mission_id,
        "revision": revision,
        "page": {
            "digest": digest,
            "total": 1,
            "pieces": [{
                "index": 0,
                "offset": 0,
                "characters": utf16_len(&payload),
                "text": payload
            }]
        }
    })
    .to_string()
}
