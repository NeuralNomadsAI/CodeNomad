//! Unit, HTTP route, agent `mission.program` bridge, and Remote Control tests
//! for programmed Mission calendars (`missions/calendars.rs` + `calendars_native.rs`).
use super::{
    calendars_native::{
        MISSION_CALENDAR_CARRIER, MISSION_CALENDAR_CODE, NativeCalendars, Unsupported, carrier_session_id,
        mission_calendar_automations,
    },
    configuration,
    creation_admission::Scope,
    run,
};
use crate::{App, Workspace, auth, auth::devices, auth::remote, auth::tls, missions};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{HeaderValue, Method, StatusCode as Status, header},
    middleware::{Next, from_fn, from_fn_with_state},
    response::IntoResponse,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct FakeNative {
    project_id: String,
    dir: String,
    sessions: HashMap<String, Value>,
    automations: Vec<Value>,
    missions: HashMap<String, Value>,
    legacy: Vec<Value>,
    retired_legacy: Vec<String>,
    legacy_reads: usize,
    next_aut: usize,
    fail_create_from: Option<usize>,
    fail_create_coordinator: HashSet<String>,
    calls: Vec<String>,
}

impl FakeNative {
    fn new(dir: String) -> Self {
        Self { project_id: "prj_cal".into(), dir, ..Default::default() }
    }
}

async fn spawn_fake_native(state: Arc<Mutex<FakeNative>>) -> std::net::SocketAddr {
    let app = Router::new()
        .route(
            "/api/location",
            get(|State(st): State<Arc<Mutex<FakeNative>>>| async move {
                let g = st.lock().unwrap();
                Json(json!({
                    "directory": g.dir,
                    "project": { "id": g.project_id, "directory": g.dir, "canonical": g.dir }
                }))
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
            get(|State(st): State<Arc<Mutex<FakeNative>>>, Path(id): Path<String>| async move {
                let g = st.lock().unwrap();
                match g.sessions.get(&id) {
                    Some(row) => (Status::OK, Json(json!({ "data": row }))).into_response(),
                    None => (Status::NOT_FOUND, Json(json!({ "_tag": "SessionNotFoundError", "sessionID": id })))
                        .into_response(),
                }
            }),
        )
        .route(
            "/api/session",
            post(|State(st): State<Arc<Mutex<FakeNative>>>, Json(input): Json<Value>| async move {
                let mut g = st.lock().unwrap();
                let id = input["id"].as_str().unwrap_or("ses_new").to_owned();
                let mut row = input.clone();
                row["projectID"] = json!(g.project_id);
                row["parentID"] = Value::Null;
                row["time"] = json!({ "created": 100 });
                g.calls.push(format!("session {id}"));
                g.sessions.insert(id, row.clone());
                (Status::OK, Json(json!({ "data": row }))).into_response()
            }),
        )
        .route(
            "/api/experimental/automation",
            get(|State(st): State<Arc<Mutex<FakeNative>>>, Query(q): Query<HashMap<String, String>>| async move {
                let g = st.lock().unwrap();
                let sid = q.get("sessionID").cloned().unwrap_or_default();
                if !g.sessions.contains_key(&sid) {
                    return (Status::NOT_FOUND, Json(json!({ "_tag": "SessionNotFoundError", "sessionID": sid })))
                        .into_response();
                }
                let rows: Vec<Value> = g.automations.iter().filter(|a| a["sessionID"] == sid).cloned().collect();
                (Status::OK, Json(json!({ "data": rows }))).into_response()
            })
            .post(|State(st): State<Arc<Mutex<FakeNative>>>, Json(input): Json<Value>| async move {
                let mut g = st.lock().unwrap();
                g.next_aut += 1;
                if g.fail_create_from.is_some_and(|n| g.next_aut >= n) {
                    return (Status::INTERNAL_SERVER_ERROR, Json(json!({ "error": "refused" }))).into_response();
                }
                let id = format!("aut_{}", g.next_aut);
                let mut row = input;
                row["id"] = json!(id);
                row["tz"] = json!("UTC");
                row["status"] = json!("active");
                row["runCount"] = json!(0);
                g.calls.push(format!("create {id}"));
                g.automations.push(row.clone());
                (Status::OK, Json(json!({ "data": row }))).into_response()
            }),
        )
        .route(
            "/api/experimental/automation/{id}",
            axum::routing::delete(|State(st): State<Arc<Mutex<FakeNative>>>, Path(id): Path<String>| async move {
                let mut g = st.lock().unwrap();
                if let Some(pos) = g.automations.iter().position(|a| a["id"] == id) {
                    g.automations.remove(pos);
                    g.calls.push(format!("delete {id}"));
                    Status::NO_CONTENT.into_response()
                } else {
                    (Status::NOT_FOUND, Json(json!({ "error": "Automation not found" }))).into_response()
                }
            }),
        )
        .route(
            "/api/experimental/automation/{id}/{action}",
            post(|State(st): State<Arc<Mutex<FakeNative>>>, Path((id, action)): Path<(String, String)>| async move {
                let mut g = st.lock().unwrap();
                let Some(idx) = g.automations.iter().position(|a| a["id"] == id) else {
                    return (Status::NOT_FOUND, Json(json!({ "error": "Automation not found" }))).into_response();
                };
                match action.as_str() {
                    "pause" => {
                        g.automations[idx]["status"] = json!("paused");
                        g.calls.push(format!("pause {id}"));
                    }
                    "resume" => {
                        g.automations[idx]["status"] = json!("active");
                        g.calls.push(format!("resume {id}"));
                    }
                    _ => return Status::NOT_FOUND.into_response(),
                }
                (Status::OK, Json(json!({ "data": g.automations[idx].clone() }))).into_response()
            }),
        )
        .route(
            "/api/rpc/codenomad.missions/{method}",
            post(|State(st): State<Arc<Mutex<FakeNative>>>, Path(method): Path<String>, Json(body): Json<Value>| async move {
                let input = body["input"].clone();
                let mut g = st.lock().unwrap();
                match method.as_str() {
                    "documentCapabilities" => Json(json!({
                        "output": { "version": 1, "automaticStart": true, "rootPermissions": true }
                    }))
                    .into_response(),
                    "legacySchedules" => {
                        g.legacy_reads += 1;
                        Json(json!({ "output": { "schedules": g.legacy.clone() } })).into_response()
                    }
                    "retireLegacySchedule" => {
                        let id = input["id"].as_str().unwrap_or_default().to_owned();
                        g.legacy.retain(|s| s["id"] != id);
                        g.retired_legacy.push(id);
                        Json(json!({ "output": { "retired": true } })).into_response()
                    }
                    "mission" => {
                        let mid = input["missionID"].as_str().unwrap_or_default();
                        let m = g.missions.get(mid).cloned().unwrap_or(Value::Null);
                        Json(json!({ "output": { "mission": m } })).into_response()
                    }
                    "create" => {
                        let req = input["requestID"].as_str().unwrap_or_default();
                        let mid = format!("msn_{}", run::token(&format!("{}\0{req}", g.project_id), 24));
                        if let Some(explicit) = input["coordinatorSessionID"].as_str()
                            && g.fail_create_coordinator.contains(explicit)
                        {
                            return (
                                Status::BAD_REQUEST,
                                Json(json!({
                                    "type": "mission.rejected",
                                    "message": "Coordinator profile mismatch",
                                    "data": { "code": "invalid-execution", "noEffect": { "requestID": req, "missionID": mid } }
                                })),
                            )
                                .into_response();
                        }
                        let co = input["coordinatorSessionID"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("ses_{}", run::token(&format!("{mid}\0coordinator"), 26)));
                        let loc = input["expectedCoordinatorLocation"].clone();
                        let mission = json!({
                            "id": mid,
                            "projectID": g.project_id,
                            "template": input["template"],
                            "title": input["title"],
                            "objective": input["objective"],
                            "status": "active",
                            "runState": "prepared",
                            "revision": 1,
                            "taskMode": input["taskMode"],
                            "profiles": input["profiles"],
                            "coordinatorGoal": input["coordinatorGoal"],
                            "coordinatorSessionId": co,
                            "actors": [{ "sessionId": co, "kind": "coordinator", "location": loc }],
                        });
                        g.missions.insert(mid.clone(), mission.clone());
                        Json(json!({ "output": { "acknowledgement": "fresh", "mission": mission } })).into_response()
                    }
                    "delete" => {
                        let mid = input["missionID"].as_str().unwrap_or_default();
                        g.missions.remove(mid);
                        Json(json!({ "output": { "deleted": true } })).into_response()
                    }
                    _ => Json(json!({ "output": {} })).into_response(),
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

fn build_fixture(name: &str) -> (PathBuf, String, Arc<Mutex<FakeNative>>) {
    let dir = dunce::canonicalize(crate::shared::test_dir(name)).unwrap();
    let dir_str = dir.to_string_lossy().into_owned();
    let state = Arc::new(Mutex::new(FakeNative::new(dir_str.clone())));
    (dir, dir_str, state)
}

async fn start_app(dir: &PathBuf, dir_str: &str, addr: std::net::SocketAddr) -> (Arc<App>, String, String) {
    let auth = auth::Auth::new(auth::Settings {
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
    let secret = "cal-bridge-secret".to_owned();
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
    (Arc::new(app), wid.to_string(), secret)
}

async fn spawn_http(app: Arc<App>) -> (String, tokio::task::JoinHandle<()>) {
    let router = missions::routes()
        .layer(from_fn(|mut req: Request, next: Next| async move {
            req.extensions_mut().insert(auth::Principal(CancellationToken::new()));
            next.run(req).await
        }))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, task)
}

fn profile() -> Value {
    json!({ "agent": "build", "model": { "providerID": "provider", "id": "model" } })
}

fn sample_config(objective: &str, launch: Value) -> Value {
    json!({
        "title": "Sync",
        "objective": objective,
        "template": "custom",
        "taskMode": "native",
        "profiles": { "coordinator": profile(), "roles": { "specialist": profile() } },
        "watchedConversationIDs": [],
        "launch": launch,
    })
}

fn full_config(launch: Value, extra: &[(&str, Value)]) -> Value {
    let mut c = sample_config("Review what changed", launch);
    let obj = c.as_object_mut().unwrap();
    obj.insert("profileID".into(), json!("profile"));
    obj.insert("executionHost".into(), json!("local"));
    obj.insert("roots".into(), json!([{ "mode": "directory-only", "directory": "D:\\project" }]));
    for (k, v) in extra {
        obj.insert((*k).into(), v.clone());
    }
    configuration::normalize(&c).expect("valid full config")
}

async fn bridge_program(app: &Arc<App>, secret: &str, session_id: &str, program: Value) -> Result<Value, (Status, Json<Value>)> {
    let payload = serde_json::to_vec(&json!({
        "mode": "mission-input",
        "sessionID": session_id,
        "command": { "kind": "schedule", "input": { "program": program } },
    }))
    .unwrap();
    let req = Request::builder()
        .method(Method::POST)
        .uri("/internal/codenomad/automation")
        .header(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .header("x-codenomad-automation-token", HeaderValue::from_str(secret).unwrap())
        .body(Body::from(payload))
        .unwrap();
    run::dispatch(State(app.clone()), req).await.map(|Json(v)| v["result"].clone())
}

#[test]
fn automations_conversion_matches_ts_rules_and_unsupported_reasons() {
    let commits = json!({
        "kind": "remote-branch-commits", "provider": "github", "host": "github.com",
        "repository": "owner/repo", "ref": "refs/heads/dev"
    });
    let pulls = json!({
        "kind": "repository-activity", "provider": "github", "host": "github.com",
        "repository": "owner/repo", "event": "pull-request-created", "author": "dependabot[bot]"
    });
    let morning = json!({ "kind": "cron", "expression": "0 9 * * 1-5", "zone": "Europe/Paris" });
    let evening = json!({ "kind": "cron", "expression": "0 18 * * *", "zone": "Europe/Paris" });

    // Events alone -> single 15-minute automation carrying coordinatorGoal, coordinatorSessionID, prepared.
    let cfg = full_config(
        json!({ "when": [commits, pulls] }),
        &[("coordinatorSessionID", json!("ses_co")), ("coordinatorGoal", json!(true))],
    );
    let list = mission_calendar_automations(&cfg, "cal_sync", Some("msn_prep")).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].trigger, json!({ "type": "every", "every": "15 minutes" }));
    assert_eq!(list[0].action["code"], MISSION_CALENDAR_CODE);
    assert_eq!(list[0].action["args"]["calendar"], "cal_sync");
    assert_eq!(list[0].action["args"]["coordinatorGoal"], true);
    assert_eq!(list[0].action["args"]["coordinatorSessionID"], "ses_co");
    assert_eq!(list[0].action["args"]["prepared"], "msn_prep");
    assert_eq!(list[0].action["args"]["when"], json!([commits, pulls]));

    // Multiple crons with trailing condition -> one automation per cron sharing `when`.
    let conditioned = full_config(json!({ "when": [morning, evening, commits] }), &[]);
    let rules = mission_calendar_automations(&conditioned, "cal_sync", None).unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0].trigger, json!({ "type": "cron", "cron": "0 9 * * 1-5", "tz": "Europe/Paris" }));
    assert_eq!(rules[1].trigger, json!({ "type": "cron", "cron": "0 18 * * *", "tz": "Europe/Paris" }));
    assert_eq!(rules[0].action["args"]["when"], json!([commits]));
    assert_eq!(rules[1].action["args"]["when"], json!([commits]));

    // Plain cron omits `when`.
    let plain = full_config(json!({ "when": [morning] }), &[]);
    let plain_rules = mission_calendar_automations(&plain, "cal_sync", None).unwrap();
    assert!(plain_rules[0].action["args"].get("when").is_none());

    // Legacy `every` with no ending -> `{ type: "every", every: "<ms> millis" }`.
    let legacy_every = full_config(
        json!({ "timing": { "kind": "every", "intervalMs": 900_000 }, "condition": null, "ends": { "maxLaunches": null, "afterMs": null, "at": null } }),
        &[],
    );
    let every_rules = mission_calendar_automations(&legacy_every, "cal_ev", None).unwrap();
    assert_eq!(every_rules[0].trigger, json!({ "type": "every", "every": "900000 millis" }));

    // All 5 unsupported reasons.
    assert_eq!(
        mission_calendar_automations(&full_config(json!({ "when": [] }), &[]), "cal_sync", None).unwrap_err(),
        Unsupported::OneTime
    );
    assert_eq!(
        mission_calendar_automations(&full_config(json!({ "when": [commits, morning] }), &[]), "cal_sync", None)
            .unwrap_err(),
        Unsupported::FallbackSchedule
    );
    let ending = full_config(
        json!({ "timing": { "kind": "every", "intervalMs": 900_000 }, "condition": null, "ends": { "maxLaunches": 3, "afterMs": null, "at": null } }),
        &[],
    );
    assert_eq!(mission_calendar_automations(&ending, "cal_sync", None).unwrap_err(), Unsupported::Ending);
    assert_eq!(
        mission_calendar_automations(
            &full_config(json!({ "when": [morning] }), &[("watchedConversationIDs", json!(["ses_followed"]))]),
            "cal_sync",
            None
        )
        .unwrap_err(),
        Unsupported::FollowedConversations
    );
    assert_eq!(
        mission_calendar_automations(
            &full_config(json!({ "when": [{ "kind": "mission-completed", "missionID": "msn_other" }] }), &[]),
            "cal_sync",
            None
        )
        .unwrap_err(),
        Unsupported::Event
    );
}

#[tokio::test]
async fn native_calendars_carrier_rollback_last_and_paused_replace() {
    let (dir, dir_str, state) = build_fixture("missions-cal-native");
    let addr = spawn_fake_native(state.clone()).await;
    let (app, wid, _) = start_app(&dir, &dir_str, addr).await;
    let ws = app.workspace(&wid).unwrap();
    let scope = Scope::open(&app, ws, None).await.unwrap();
    let native = NativeCalendars::new(&app, &scope);

    // Listing/pausing before carrier exists creates nothing.
    assert!(native.list().await.unwrap().is_empty());
    assert!(native.pause("cal_sync").await.is_err());
    assert!(native.delete("cal_sync").await.is_err());
    assert!(state.lock().unwrap().calls.is_empty());

    let cfg = full_config(
        json!({ "when": [
            { "kind": "cron", "expression": "0 9 * * *", "zone": "UTC" },
            { "kind": "cron", "expression": "0 18 * * *", "zone": "UTC" }
        ]}),
        &[],
    );
    let rules = mission_calendar_automations(&cfg, "cal_sync", Some("msn_prep")).unwrap();
    native.save("cal_sync", &rules, false).await.unwrap();
    assert_eq!(native.carrier, carrier_session_id("prj_cal", &dir_str));
    assert_eq!(
        state.lock().unwrap().sessions.get(&native.carrier).unwrap()["metadata"][MISSION_CALENDAR_CARRIER]["version"],
        1
    );

    // Foreign automation in same carrier is ignored; latest run state across rules wins.
    {
        let mut g = state.lock().unwrap();
        g.automations.push(json!({
            "id": "aut_other", "name": "Other", "sessionID": native.carrier, "tz": "UTC",
            "status": "active", "runCount": 0, "trigger": { "type": "every", "every": "1 hour" },
            "action": { "type": "prompt", "prompt": "Hello" }
        }));
        g.automations[0]["lastRunAt"] = json!(40);
        g.automations[0]["state"] = json!({ "last": json!({ "outcome": "launched", "missionID": "msn_old", "history": [] }).to_string() });
        g.automations[1]["lastRunAt"] = json!(50);
        g.automations[1]["state"] = json!({ "last": json!({
            "outcome": "waiting", "missionID": "msn_running", "status": "active",
            "coordinatorSessionID": "ses_1", "history": [{ "at": 10, "outcome": "completed" }], "launches": 24
        }).to_string() });
    }
    let views = native.list().await.unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].id, "cal_sync");
    assert_eq!(views[0].mission_id.as_deref(), Some("msn_running"));
    let last = views[0].last.as_ref().unwrap().to_json();
    assert_eq!(last["outcome"], "waiting");
    assert_eq!(last["launches"], 24);
    assert_eq!(last["at"], 50);

    // Pause -> replace keeps paused state; failed create rolls back leaving previous intact.
    native.pause("cal_sync").await.unwrap();
    let one = mission_calendar_automations(
        &full_config(json!({ "when": [{ "kind": "cron", "expression": "0 10 * * *", "zone": "UTC" }] }), &[]),
        "cal_sync",
        Some("msn_prep2"),
    )
    .unwrap();
    native.save("cal_sync", &one, false).await.unwrap();
    let after_edit = native.list().await.unwrap();
    assert!(after_edit[0].paused);
    assert_eq!(after_edit[0].rules.len(), 1);
    assert_eq!(after_edit[0].mission_id.as_deref(), Some("msn_prep2"));

    state.lock().unwrap().fail_create_from = Some(5); // aut_4 succeeds, aut_5 fails -> rollback aut_4
    assert!(native.save("cal_sync", &rules, false).await.is_err());
    let still = native.list().await.unwrap();
    assert_eq!(still[0].rules.len(), 1);
    assert_eq!(still[0].rules[0]["automationID"], "aut_3");
}

#[tokio::test]
async fn http_routes_lifecycle_profile_refusal_legacy_takeover_and_restore() {
    let (dir, dir_str, state) = build_fixture("missions-cal-http");
    let addr = spawn_fake_native(state.clone()).await;
    let (app, wid, secret) = start_app(&dir, &dir_str, addr).await;
    let (base, server_task) = spawn_http(app.clone()).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let root = format!("{base}/api/workspaces/{wid}/missions/calendars");
    let cron = json!({ "when": [{ "kind": "cron", "expression": "0 9 * * 1-5", "zone": "Europe/Paris" }] });

    // 1. Invalid inputs return 400 calendar-input-invalid.
    let bad_id = client.delete(format!("{root}/x")).send().await.unwrap();
    assert_eq!(bad_id.status(), Status::BAD_REQUEST);
    assert_eq!(bad_id.json::<Value>().await.unwrap()["code"], "calendar-input-invalid");

    let bad_query = client.get(format!("{root}?unknown=1")).send().await.unwrap();
    assert_eq!(bad_query.status(), Status::BAD_REQUEST);

    let mut forbidden_cfg = sample_config("x", cron.clone());
    forbidden_cfg["roots"] = json!([{ "mode": "directory-only", "directory": dir_str }]);
    let bad_body = client.put(format!("{root}/cal_a")).json(&json!({ "configuration": forbidden_cfg })).send().await.unwrap();
    assert_eq!(bad_body.status(), Status::BAD_REQUEST);
    assert_eq!(bad_body.json::<Value>().await.unwrap()["code"], "calendar-input-invalid");

    // 2. Unsupported criteria -> 422 calendar-unsupported with exact reason.
    let unsup = client
        .put(format!("{root}/cal_a"))
        .json(&json!({ "configuration": sample_config("One-time", json!({ "when": [] })) }))
        .send()
        .await
        .unwrap();
    assert_eq!(unsup.status(), Status::UNPROCESSABLE_ENTITY);
    let unsup_body: Value = unsup.json().await.unwrap();
    assert_eq!(unsup_body["code"], "calendar-unsupported");
    assert_eq!(unsup_body["reason"], "one-time");

    // 3. Coordinator profile mismatch -> 422 calendar-coordinator-profile with zero side effects.
    state.lock().unwrap().sessions.insert(
        "ses_named".into(),
        json!({
            "id": "ses_named", "projectID": "prj_cal", "parentID": null,
            "location": { "directory": dir_str },
            "agent": "build", "model": { "providerID": "provider", "id": "model", "variant": "high" }
        }),
    );
    let mut named_cfg = sample_config("Named", cron.clone());
    named_cfg["coordinatorSessionID"] = json!("ses_named");
    let mismatch = client
        .put(format!("{root}/cal_named"))
        .json(&json!({ "configuration": named_cfg }))
        .send()
        .await
        .unwrap();
    assert_eq!(mismatch.status(), Status::UNPROCESSABLE_ENTITY);
    assert_eq!(mismatch.json::<Value>().await.unwrap()["code"], "calendar-coordinator-profile");
    assert!(state.lock().unwrap().automations.is_empty());
    assert!(state.lock().unwrap().missions.is_empty());

    // Agent bridge returns refusal object directly (not error).
    state.lock().unwrap().sessions.insert(
        "ses_agent".into(),
        json!({ "id": "ses_agent", "projectID": "prj_cal", "parentID": null, "location": { "directory": dir_str } }),
    );
    let agent_refused = bridge_program(
        &app,
        &secret,
        "ses_agent",
        json!({ "action": "save", "id": "cal_named", "configuration": named_cfg }),
    )
    .await
    .unwrap();
    assert_eq!(agent_refused, json!({ "refused": "calendar-coordinator-profile" }));

    // 4. Matching coordinator profile saves, prepares Mission, and edits replace pristine Mission reusing coordinator.
    state.lock().unwrap().sessions.insert(
        "ses_named".into(),
        json!({
            "id": "ses_named", "projectID": "prj_cal", "parentID": null,
            "location": { "directory": dir_str },
            "agent": "build", "model": { "providerID": "provider", "id": "model" }
        }),
    );
    let saved: Value = client
        .put(format!("{root}/cal_named"))
        .json(&json!({ "configuration": named_cfg }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let first_mid = saved["calendars"][0]["missionID"].as_str().unwrap().to_owned();
    assert_eq!(state.lock().unwrap().missions.get(&first_mid).unwrap()["coordinatorSessionId"], "ses_named");

    // Edit before first launch deletes old pristine Mission and creates a new one in the same conversation.
    let edited: Value = client
        .put(format!("{root}/cal_named"))
        .json(&json!({ "configuration": sample_config("Updated", cron.clone()) }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second_mid = edited["calendars"][0]["missionID"].as_str().unwrap().to_owned();
    assert_ne!(second_mid, first_mid);
    assert!(!state.lock().unwrap().missions.contains_key(&first_mid));
    assert_eq!(state.lock().unwrap().missions.get(&second_mid).unwrap()["coordinatorSessionId"], "ses_named");

    // 5. Pause -> delete underlying Mission -> coordinator model changes -> GET restores paused calendar in new conversation!
    let paused: Value = client.post(format!("{root}/cal_named/pause")).send().await.unwrap().json().await.unwrap();
    assert_eq!(paused["calendars"][0]["paused"], true);
    state.lock().unwrap().missions.remove(&second_mid);
    // Simulate named coordinator failing create on restore -> falls back to new coordinator.
    state.lock().unwrap().fail_create_coordinator.insert("ses_named".into());
    // Also save cal_named with coordinatorSessionID so restore exercises the fallback.
    state.lock().unwrap().automations[0]["action"]["args"]["coordinatorSessionID"] = json!("ses_named");

    let restored: Value = client.get(&root).send().await.unwrap().json().await.unwrap();
    let third_mid = restored["calendars"][0]["missionID"].as_str().unwrap().to_owned();
    assert_ne!(third_mid, second_mid);
    assert_eq!(restored["calendars"][0]["paused"], true);
    assert_eq!(restored["calendars"][0]["mission"]["coordinatorSessionID"], "ses_named");
    assert_ne!(state.lock().unwrap().missions.get(&third_mid).unwrap()["coordinatorSessionId"], "ses_named");

    // 6. Resume, agent bridge `list`/`pause`/`resume`/`delete`, and 404 missing.
    state.lock().unwrap().automations[0]["nextDueAt"] = json!(1_700_000_000_000u64);
    let resumed: Value = client.post(format!("{root}/cal_named/resume")).send().await.unwrap().json().await.unwrap();
    assert_eq!(resumed["calendars"][0]["paused"], false);

    let programs = bridge_program(&app, &secret, "ses_agent", json!({ "action": "list" })).await.unwrap();
    assert_eq!(programs["programs"][0]["id"], "cal_named");
    assert_eq!(programs["programs"][0]["nextDueAt"], 1_700_000_000_000u64);

    let agent_paused =
        bridge_program(&app, &secret, "ses_agent", json!({ "action": "pause", "id": "cal_named" })).await.unwrap();
    assert_eq!(agent_paused["programs"][0]["paused"], true);
    assert!(agent_paused["programs"][0].get("nextDueAt").is_none());

    // Agent rejects legacy launch policy shape.
    let legacy_cfg = sample_config(
        "Legacy",
        json!({ "timing": { "kind": "every", "intervalMs": 900_000 }, "condition": null, "ends": { "maxLaunches": null, "afterMs": null, "at": null } }),
    );
    let err = bridge_program(
        &app,
        &secret,
        "ses_agent",
        json!({ "action": "save", "id": "cal_leg", "configuration": legacy_cfg }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, Status::BAD_REQUEST);

    let agent_deleted =
        bridge_program(&app, &secret, "ses_agent", json!({ "action": "delete", "id": "cal_named" })).await.unwrap();
    assert_eq!(agent_deleted["programs"], json!([]));

    let agent_missing =
        bridge_program(&app, &secret, "ses_agent", json!({ "action": "pause", "id": "cal_named" })).await.unwrap();
    assert_eq!(agent_missing, json!({ "refused": "calendar-missing" }));

    let http_missing = client.post(format!("{root}/cal_named/pause")).send().await.unwrap();
    assert_eq!(http_missing.status(), Status::NOT_FOUND);
    assert_eq!(http_missing.json::<Value>().await.unwrap()["code"], "calendar-missing");

    server_task.abort();
}

#[tokio::test]
async fn legacy_schedule_takeover_migrates_running_paused_busy_and_unsupported_once() {
    let (dir, dir_str, state) = build_fixture("missions-cal-legacy");
    let cron = json!({ "when": [{ "kind": "cron", "expression": "0 9 * * *", "zone": "UTC" }] });
    {
        let mut g = state.lock().unwrap();
        let mut running_cfg = sample_config("Old running", cron.clone());
        running_cfg["coordinatorSessionID"] = json!("ses_deleted");
        g.legacy = vec![
            json!({ "id": "msn_run", "configuration": running_cfg, "running": true, "busy": false, "automations": ["aut_old_1"], "carriers": [] }),
            json!({ "id": "msn_pause", "configuration": sample_config("Old paused", cron.clone()), "running": false, "busy": false, "automations": [], "carriers": [] }),
            json!({ "id": "msn_busy", "configuration": sample_config("Busy one", cron.clone()), "running": true, "busy": true, "automations": [], "carriers": [] }),
            json!({ "id": "msn_unsup", "configuration": sample_config("Old unsup", json!({ "when": [{ "kind": "mission-completed", "missionID": "msn_src" }] })), "running": false, "busy": false, "automations": [], "carriers": [] }),
        ];
        g.automations.push(json!({ "id": "aut_old_1", "sessionID": "ses_old", "status": "active", "action": { "type": "prompt", "prompt": "wake" } }));
    }
    let addr = spawn_fake_native(state.clone()).await;
    let (app, wid, _) = start_app(&dir, &dir_str, addr).await;
    let (base, server_task) = spawn_http(app.clone()).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let root = format!("{base}/api/workspaces/{wid}/missions/calendars");

    // First GET migrates running (resumed, stripped deleted coordinator), paused (stays paused),
    // converts unsupported to ordinary prepared Mission, and skips busy.
    let first: Value = client.get(&root).send().await.unwrap().json().await.unwrap();
    let cals = first["calendars"].as_array().unwrap();
    assert_eq!(cals.len(), 2);
    let by_id: HashMap<&str, &Value> = cals.iter().map(|c| (c["id"].as_str().unwrap(), c)).collect();
    assert_eq!(by_id["msn_run"]["paused"], false);
    assert!(by_id["msn_run"]["mission"].get("coordinatorSessionID").is_none());
    assert_eq!(by_id["msn_pause"]["paused"], true);
    {
        let g = state.lock().unwrap();
        assert!(g.retired_legacy.contains(&"msn_run".to_owned()));
        assert!(g.retired_legacy.contains(&"msn_pause".to_owned()));
        assert!(g.retired_legacy.contains(&"msn_unsup".to_owned()));
        assert!(!g.retired_legacy.contains(&"msn_busy".to_owned()));
        assert!(!g.automations.iter().any(|a| a["id"] == "aut_old_1"));
        assert!(g.missions.values().any(|m| m["objective"] == "Old unsup" && m["runState"] == "prepared"));
    }

    // Once busy clears, next GET finishes takeover; subsequent GET does not re-read legacySchedules.
    state.lock().unwrap().legacy[0]["busy"] = json!(false);
    let second: Value = client.get(&root).send().await.unwrap().json().await.unwrap();
    assert_eq!(second["calendars"].as_array().unwrap().len(), 3);
    // Next GET observes empty legacy list and marks directory taken over.
    let _ = client.get(&root).send().await.unwrap();
    let reads_before = state.lock().unwrap().legacy_reads;
    let _ = client.get(&root).send().await.unwrap();
    assert_eq!(state.lock().unwrap().legacy_reads, reads_before, "taken over once per connection+directory");

    server_task.abort();
}

#[tokio::test]
async fn remote_control_admits_calendar_routes_and_rejects_unlisted_actions() {
    let (dir, dir_str, state) = build_fixture("missions-cal-remote");
    let addr = spawn_fake_native(state.clone()).await;
    let host = "192.168.1.42:9898";
    let origin = format!("https://{host}");
    let dev_store = devices::open_for_test(&dir, origin.clone(), vec![origin.clone()]);
    let auth_cfg = auth::Auth::new(auth::Settings {
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
    let app = Arc::new(App::new(
        auth_cfg,
        0,
        dir.clone(),
        dir.clone(),
        false,
        settings,
        Value::Null,
        crate::opencode::Native::test_connection(addr),
        PathBuf::new(),
        Some(dev_store),
        crate::files::watch::Watches::new(tx),
        None,
    ));
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

    let origin_ext = origin.clone();
    let router = auth::remote_routes()
        .merge(missions::routes())
        .layer(from_fn_with_state((app.clone(), None), remote::admit))
        .layer(from_fn(move |mut req: Request, next: Next| {
            let origin = origin_ext.clone();
            async move {
                req.extensions_mut().insert(tls::Channel {
                    origin: origin.clone(),
                    origins: Arc::from(vec![origin]),
                    ingress: false,
                    socket: CancellationToken::new(),
                    principal: Arc::new(Mutex::new(None)),
                });
                next.run(req).await
            }
        }))
        .with_state(app.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    // Pair a server device and a browser device using the real pairing routes.
    let issued = devices::issue(State(app.clone()), axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))).await;
    assert_eq!(issued.status(), Status::OK);
    let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
    let link: Value = serde_json::from_slice(&body).unwrap();
    let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();
    let pair_res = client
        .post(format!("{base}/api/remote-control/server-pair"))
        .header(header::HOST, host)
        .header("x-codenomad-server-pairing", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(json!({ "code": code, "hostName": "remote-test" }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(pair_res.status(), Status::OK);
    let pair_payload: Value = pair_res.json().await.unwrap();
    let cookie = format!("{}={}", devices::COOKIE, pair_payload["credential"].as_str().unwrap());

    let issued_b =
        devices::issue(State(app.clone()), axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))).await;
    assert_eq!(issued_b.status(), Status::OK);
    let body_b = axum::body::to_bytes(issued_b.into_body(), 4096).await.unwrap();
    let link_b: Value = serde_json::from_slice(&body_b).unwrap();
    let code_b = link_b["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();
    let pair_b = client
        .post(format!("{base}/api/remote-control/pair"))
        .header(header::HOST, host)
        .header(header::ORIGIN, &origin)
        .json(&json!({ "code": code_b }))
        .send()
        .await
        .unwrap();
    assert_eq!(pair_b.status(), Status::OK);
    let browser_cookie = pair_b.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();

    let cal_root = format!("{base}/api/workspaces/{wid}/missions/calendars");
    // Paired browser admitted on GET /calendars.
    let browser_get = client
        .get(&cal_root)
        .header(header::HOST, host)
        .header(header::ORIGIN, &origin)
        .header(header::COOKIE, &browser_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(browser_get.status(), Status::OK);
    // Unauthenticated rejected with 401.
    let unauth = client
        .get(&cal_root)
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), Status::UNAUTHORIZED);

    // Paired server device admitted on GET, PUT, POST /{pause|resume}, DELETE.
    let get_res = client
        .get(&cal_root)
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(get_res.status(), Status::OK);

    let cron = json!({ "when": [{ "kind": "cron", "expression": "0 9 * * *", "zone": "UTC" }] });
    let put_res = client
        .put(format!("{cal_root}/cal_remote"))
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &cookie)
        .json(&json!({ "configuration": sample_config("Remote", cron) }))
        .send()
        .await
        .unwrap();
    assert_eq!(put_res.status(), Status::OK);

    let pause_res = client
        .post(format!("{cal_root}/cal_remote/pause"))
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(pause_res.status(), Status::OK);

    let resume_res = client
        .post(format!("{cal_root}/cal_remote/resume"))
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(resume_res.status(), Status::OK);

    // Unknown action & unlisted method rejected by Remote Control catalog with 404.
    let bad_action = client
        .post(format!("{cal_root}/cal_remote/unknown"))
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(bad_action.status(), Status::NOT_FOUND);

    let bad_method = client
        .post(&cal_root)
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(bad_method.status(), Status::NOT_FOUND);

    let del_res = client
        .delete(format!("{cal_root}/cal_remote"))
        .header(header::HOST, host)
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(del_res.status(), Status::OK);

    task.abort();
}
