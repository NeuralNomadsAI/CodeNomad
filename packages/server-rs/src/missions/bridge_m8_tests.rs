//! End-to-end bridge dispatch tests for the M8 Missions commands against a local fake native service.
use crate::{App, Workspace, missions::recurrence_contract::sign};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderValue, Method, Request, StatusCode, header},
    routing::{get, post, put},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
struct FakeState {
    prompted: Vec<(String, Value)>,
    interrupted: Vec<String>,
    control_calls: Vec<Value>,
    control_reply: Option<Value>,
    task_status: String,
}

async fn spawn_fake_native(dir: String, state: Arc<Mutex<FakeState>>) -> std::net::SocketAddr {
    let dir_loc = dir.clone();
    let app = Router::new()
        .route(
            "/api/location",
            get(move || {
                let d = dir_loc.clone();
                async move {
                    Json(json!({
                        "directory": d,
                        "project": { "id": "prj_test", "directory": d, "canonical": d }
                    }))
                }
            }),
        )
        .route(
            "/api/plugin",
            get(|| async {
                Json(json!({ "data": [{ "id": "codenomad.missions", "state": { "status": "active" } }] }))
            }),
        )
        .route(
            "/api/session/{id}",
            get({
                let d = dir.clone();
                move |Path(id): Path<String>| {
                    let d = d.clone();
                    async move {
                        let parent = if id == "ses_child" { json!("ses_co") } else { Value::Null };
                        Json(json!({
                            "data": {
                                "id": id,
                                "projectID": "prj_test",
                                "location": { "directory": d },
                                "parentID": parent,
                                "permissions": [],
                                "time": { "created": 1000 }
                            }
                        }))
                    }
                }
            }),
        )
        .route(
            "/api/session",
            get({
                let d = dir.clone();
                move |Query(q): Query<HashMap<String, String>>| {
                    let d = d.clone();
                    async move {
                        let parent = q.get("parentID").map(String::as_str);
                        let rows = if parent == Some("ses_co") {
                            vec![json!({
                                "id": "ses_child",
                                "title": "Task Child",
                                "projectID": "prj_test",
                                "location": { "directory": d },
                                "parentID": "ses_co"
                            })]
                        } else if parent == Some("ses_child") {
                            vec![]
                        } else {
                            vec![
                                json!({
                                    "id": "ses_co",
                                    "title": "Coordinator",
                                    "projectID": "prj_test",
                                    "location": { "directory": d },
                                    "parentID": null
                                }),
                                json!({
                                    "id": "ses_cn_schedule_hidden",
                                    "title": "Carrier",
                                    "projectID": "prj_test",
                                    "location": { "directory": d },
                                    "parentID": null
                                }),
                                json!({
                                    "id": "ses_sub",
                                    "title": "Subagent",
                                    "projectID": "prj_test",
                                    "location": { "directory": d },
                                    "parentID": "ses_co"
                                }),
                            ]
                        };
                        Json(json!({ "data": rows, "cursor": { "next": null } }))
                    }
                }
            }),
        )
        .route(
            "/api/session/{id}/message",
            get(|| async {
                Json(json!({
                    "data": [{
                        "type": "user",
                        "text": "# CodeNomad Mission Assignment\n\nYou are a native task actor in mission msn_test.\n\nPlaybook: Custom\nRole: Specialist\nTask key: task-a\nBlocked by: none"
                    }]
                }))
            }),
        )
        .route("/api/session/active", get(|| async { Json(json!({ "data": {} })) }))
        .route(
            "/api/session/{id}/inbox",
            get(|| async { Json(json!({ "data": [] })) }),
        )
        .route(
            "/api/session/{id}/interrupt",
            post(|State(st): State<Arc<Mutex<FakeState>>>, Path(id): Path<String>| async move {
                st.lock().unwrap().interrupted.push(id);
                Json(json!({ "data": { "interrupted": true } }))
            }),
        )
        .route(
            "/api/session/{id}/environment",
            put(|| async { Json(json!({ "ok": true })) }),
        )
        .route(
            "/api/session/{id}/prompt",
            post(|State(st): State<Arc<Mutex<FakeState>>>, Path(id): Path<String>, Json(body): Json<Value>| async move {
                st.lock().unwrap().prompted.push((id, body));
                Json(json!({ "ok": true }))
            }),
        )
        .route(
            "/api/rpc/codenomad.missions/{method}",
            post({
                let d = dir.clone();
                move |State(st): State<Arc<Mutex<FakeState>>>, Path(method): Path<String>, Json(body): Json<Value>| {
                    let d = d.clone();
                    async move {
                        let input = body["input"].clone();
                        match method.as_str() {
                            "snapshot" => {
                                let status = st.lock().unwrap().task_status.clone();
                                Json(json!({
                                    "output": {
                                        "projectID": "prj_test",
                                        "discardedEvents": 0,
                                        "controlUnavailable": false,
                                        "missions": [{
                                            "id": "msn_test",
                                            "projectID": "prj_test",
                                            "template": "custom",
                                            "taskMode": "native",
                                            "status": "active",
                                            "runState": "running",
                                            "revision": 3,
                                            "coordinatorSessionId": "ses_co",
                                            "actors": [{ "sessionId": "ses_co", "location": { "directory": d } }],
                                            "tasks": [{
                                                "key": "task-a",
                                                "status": status,
                                                "executionMode": { "kind": "native", "parentTaskKey": null }
                                            }]
                                        }]
                                    }
                                }))
                            }
                            "panelPage" => Json(json!({
                                "output": {
                                    "available": true,
                                    "version": 1,
                                    "projectID": "prj_test",
                                    "projectCanonical": d,
                                    "location": { "directory": d },
                                    "source": "summaries",
                                    "page": { "digest": "a".repeat(43), "total": 0, "pieces": [] }
                                }
                            })),
                            "projectControl" => {
                                let mut guard = st.lock().unwrap();
                                guard.control_calls.push(input);
                                let reply = guard
                                    .control_reply
                                    .clone()
                                    .unwrap_or_else(|| json!({ "receipt": { "state": "completed" } }));
                                Json(json!({ "output": { "json": reply.to_string() } }))
                            }
                            _ => Json(json!({ "output": {} })),
                        }
                    }
                }
            }),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn bridge_call(app: &Arc<App>, secret: &str, command: Value) -> Result<Value, (StatusCode, Json<Value>)> {
    let payload = serde_json::to_vec(&json!({
        "mode": "mission-input",
        "sessionID": "ses_co",
        "command": command,
    }))
    .unwrap();
    let mut req = Request::builder()
        .method(Method::POST)
        .uri("/internal/codenomad/automation")
        .header(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .header("x-codenomad-automation-token", HeaderValue::from_str(secret).unwrap())
        .body(Body::from(payload))
        .unwrap();
    let _ = req.headers_mut();
    super::run::dispatch(axum::extract::State(app.clone()), req).await.map(|Json(v)| v)
}

#[tokio::test]
async fn m8_bridge_commands_dispatch_end_to_end() {
    let dir = dunce::canonicalize(crate::shared::test_dir("missions-m8-bridge")).unwrap();
    let dir_str = dir.to_string_lossy().into_owned();
    let state = Arc::new(Mutex::new(FakeState { task_status: "withdrawn".into(), ..Default::default() }));
    let addr = spawn_fake_native(dir_str.clone(), state.clone()).await;

    let auth = crate::auth::Auth::new(crate::auth::Settings {
        username: "opencode".into(),
        password: None,
        file: None,
        cookie: "cn".into(),
        token: false,
        skip: true,
        managed_local: false,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
        dir.join("config.yaml").to_str().unwrap(),
    ));
    let mut app = App::new(
        auth,
        0,
        dir.clone(),
        dir.clone(),
        false,
        settings,
        Value::Null,
        crate::opencode::Native::test_connection(addr),
        PathBuf::new(),
        None,
        crate::files::watch::Watches::new(tx),
        None,
    );
    let secret = "test-bridge-secret".to_owned();
    app.mission_bridge = Some(secret.clone());
    let wid = uuid::Uuid::new_v4();
    app.inner.lock().unwrap().workspaces.push(Workspace {
        id: wid,
        request_id: None,
        path: dir.clone(),
        name: None,
        status: "ready",
        proxy_path: format!("/workspaces/{wid}/instance"),
        binary_id: PathBuf::new(),
        binary_label: String::new(),
        created_at: String::new(),
        updated_at: String::new(),
        location: json!({ "directory": dir_str }),
        temporary: None,
    });
    let app = Arc::new(app);

    // 1. configurations
    let configs = bridge_call(&app, &secret, json!({"kind":"configurations","input":{}})).await.unwrap();
    assert_eq!(configs["result"], json!([]));

    // 2. settings: read, save, conflict on stale expectation, invalid input -> 200 refused
    let read_pref = bridge_call(
        &app,
        &secret,
        json!({"kind":"settings","input":{"scope":"preferences","action":"read","field":"missionDeleteSessions"}}),
    )
    .await
    .unwrap();
    assert_eq!(read_pref["result"]["value"], false);
    let exp = read_pref["result"]["expectation"].as_str().unwrap().to_owned();
    let saved = bridge_call(
        &app,
        &secret,
        json!({"kind":"settings","input":{"scope":"preferences","action":"save","field":"missionDeleteSessions","deleteSessions":true,"expectation":exp}}),
    )
    .await
    .unwrap();
    assert_eq!(saved["result"]["saved"], true);
    let conflict = bridge_call(
        &app,
        &secret,
        json!({"kind":"settings","input":{"scope":"preferences","action":"save","field":"missionDeleteSessions","deleteSessions":false,"expectation":exp}}),
    )
    .await
    .unwrap();
    assert_eq!(conflict["result"], json!({"refused":true,"code":"settings-conflict"}));
    let invalid = bridge_call(&app, &secret, json!({"kind":"settings","input":{"scope":"depth","action":"reset"}}))
        .await
        .unwrap();
    assert_eq!(invalid["result"], json!({"refused":true,"code":"settings-invalid"}));

    // 3. project-read: playbook, coordinators source (filters schedule carrier & subagent), panel
    let pb = bridge_call(
        &app,
        &secret,
        json!({"kind":"project-read","input":{"kind":"playbook","template":"custom","taskMode":"independent"}}),
    )
    .await
    .unwrap();
    assert_eq!(pb["result"]["taskMode"], "independent");
    assert_eq!(pb["result"]["playbook"]["id"], "custom");

    let coords = bridge_call(
        &app,
        &secret,
        json!({"kind":"project-read","input":{"kind":"sources","source":"coordinators"}}),
    )
    .await
    .unwrap();
    assert_eq!(coords["result"]["sources"], json!([{"id":"ses_co","title":"Coordinator"}]));

    let panel = bridge_call(
        &app,
        &secret,
        json!({"kind":"project-read","input":{"kind":"panel","input":{"source":"summaries","initial":true}}}),
    )
    .await
    .unwrap();
    assert_eq!(panel["result"]["source"], "summaries");

    // 4. project-control: signs and forwards to projectControl RPC
    let ctrl = bridge_call(
        &app,
        &secret,
        json!({"kind":"project-control","input":{"tool":"control","input":{"missionID":"msn_test","action":"read"}}}),
    )
    .await
    .unwrap();
    assert_eq!(ctrl["result"]["receipt"]["state"], "completed");
    assert_eq!(state.lock().unwrap().control_calls.len(), 1);

    // 5. project-control-verify & 6. project-update
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    let unsigned = json!({
        "principal": { "kind": "agent", "sessionID": "ses_co" },
        "projectID": "prj_test",
        "directory": dir_str,
        "command": {
            "tool": "control",
            "input": { "missionID": "msn_test", "action": "request-update", "requestID": "req_brief_1", "expectedRevision": 3, "language": "fr" }
        },
        "issuedAt": now,
    });
    let mut signed = unsigned.clone();
    signed["proof"] = json!(sign(&unsigned, &secret));

    let verified = bridge_call(&app, &secret, json!({"kind":"project-control-verify","input":signed}))
        .await
        .unwrap();
    assert_eq!(verified["result"], json!({"verified":true}));

    let updated = bridge_call(&app, &secret, json!({"kind":"project-update","input":signed})).await.unwrap();
    assert_eq!(updated["result"]["admitted"], true);
    assert!(updated["result"]["messageID"].as_str().is_some_and(|s| s.starts_with("msg_")));
    assert_eq!(state.lock().unwrap().prompted.len(), 1);
    assert_eq!(state.lock().unwrap().prompted[0].1["delivery"], "steer");

    // 7. interrupt: stops retired native task root; refuses active task
    let intr = bridge_call(
        &app,
        &secret,
        json!({"kind":"interrupt","input":{"missionID":"msn_test","taskKey":"task-a"}}),
    )
    .await
    .unwrap();
    assert_eq!(intr["result"]["complete"], true);
    assert_eq!(intr["result"]["sessions"][0]["sessionID"], "ses_child");
    assert_eq!(intr["result"]["sessions"][0]["interrupted"], true);
    assert_eq!(state.lock().unwrap().interrupted, vec!["ses_child"]);

    state.lock().unwrap().task_status = "in-progress".into();
    let refused = bridge_call(
        &app,
        &secret,
        json!({"kind":"interrupt","input":{"missionID":"msn_test","taskKey":"task-a"}}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.0, StatusCode::CONFLICT);
    assert_eq!(refused.1.0["code"], "task-not-retired");
    let _ = std::fs::remove_dir_all(&dir);
}
