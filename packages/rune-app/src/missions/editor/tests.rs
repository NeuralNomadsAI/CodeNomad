use super::*;
use crate::{
    missions::{Lifecycle, Panel, editor_view},
    platform::reads::Reads,
    strings::t,
};
use codenomad_client::missions::{LifecycleOutcome, MapHeader, content_digest, utf16_len};
use rune::{Env, Runtime, edit::TextEdit};
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
    panel.poll();
    panel.observe_editor_detail(holds);
    auth.extend(panel.drain_auth_expired());
    let active = panel.active_editor(occurrence);
    let (_, events) = holds.poll(active, &auth, lifecycle);
    auth.extend(holds.drain_auth_expired());
    panel.apply_editor_events(occurrence, &events);
    (auth, lc_finished)
}

#[test]
fn create_validation_blocks_empty_objective_multiline_title_and_compare() {
    let backend = unattested_backend("http://127.0.0.1:9/".into());
    let scope = CreationScopeKey::new(&backend, &backend.workspace);
    let mut holds = EditorHolds::default();
    let mut editor = Editor::default();
    editor.open_create(&scope, &mut holds, Some("missions-create".into()));
    let form = editor.form.as_mut().unwrap();
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
    form.template = Template::Compare;
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

    panel.open_create_editor(&mut holds, Some("missions-create".into()));
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
        },
        &backend,
        &wake,
    ));
    patch_seen_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("PATCH must reach test server");

    // 2. Open Create with start_on_creation=true and submit; both PATCH 401 and Create fresh complete before poll!
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
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
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
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

    {
        let mut panel = Panel::new(
            backend.clone(),
            Some("prj_1".into()),
            Reads::default(),
            noop_wake(),
        )
        .with_owner_scope("/repo".into());
        panel.open_create_editor(&mut holds, Some("missions-create".into()));
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
    } // Tab closed!

    // New tab on the same project folder adopts the uncertain CreationHold.
    let mut panel2 = Panel::new(
        backend.clone(),
        Some("prj_1".into()),
        Reads::default(),
        noop_wake(),
    )
    .with_owner_scope("/repo".into());
    panel2.open_create_editor(&mut holds, Some("missions-create".into()));
    assert_eq!(
        panel2.editor.form.as_ref().unwrap().objective.text,
        "Recover me"
    );
    panel2.reconcile_editor_creation("tab-2", &mut holds);
    wait_until(|| {
        poll_step(&mut panel2, "tab-2", &mut holds, &mut lifecycle);
        !panel2.has_editor()
    });
    assert_eq!(panel2.selected.as_deref(), Some("msn_recovered"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "reconciled creation never fires /control auto-start"
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
fn create_401_and_mission_finished_release_holds_and_preserve_draft() {
    let (base, _calls) = start_scripted_server(|_idx, raw| {
        if raw.starts_with("POST /api/workspaces/ws-1/missions ") {
            ("401 Unauthorized".into(), "expired".into())
        } else {
            (
                "409 Conflict".into(),
                json!({"error": "Only active missions can be edited", "code": "mission-finished"})
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

    // 401 on Create releases CreationHold, preserves draft, and surfaces auth_expired.
    panel.open_create_editor(&mut holds, Some("missions-create".into()));
    panel.editor.form.as_mut().unwrap().objective = TextEdit::new("Keep draft");
    panel.submit_editor("tab-1", &mut holds);
    let mut expired = Vec::new();
    wait_until(|| {
        let (auth, _) = poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        if !auth.is_empty() {
            expired = auth;
        }
        !expired.is_empty()
    });
    assert!(holds.creation(&panel.creation_scope_key()).is_none());
    assert_eq!(
        panel.editor.form.as_ref().unwrap().objective.text,
        "Keep draft"
    );

    // 409 mission-finished on Edit releases EditHold (definitive rejection) and preserves draft.
    let header = sample_header(2, Some("Original"), None, "running");
    let scope = panel.creation_scope_key();
    assert!(panel.editor.open_edit(
        &header,
        &scope,
        &backend,
        &mut holds,
        &panel.reads,
        &panel.wake,
        None
    ));
    let form = panel.editor.form.as_mut().unwrap();
    form.prefill = PrefillState::Ready;
    form.objective = TextEdit::new("Attempt on finished");
    panel.submit_editor("tab-1", &mut holds);
    let key = EditHoldKey::new(&backend, "prj_1", "msn_alpha123");
    wait_until(|| {
        poll_step(&mut panel, "tab-1", &mut holds, &mut lifecycle);
        panel
            .editor
            .form
            .as_ref()
            .is_some_and(|f| f.error.is_some())
    });
    assert!(
        holds.edit(&key).is_none(),
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
        false,
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
        false,
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
            editor_view(
                &host.panel,
                &host.holds,
                |h: &mut Host| (Some(&mut h.panel), &mut h.fallback),
                |_, _, _| {},
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
}
