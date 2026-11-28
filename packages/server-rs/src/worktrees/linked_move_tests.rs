//! Tests for OpenCode 2.4.2+ cascading `Session.move` grouping and rollback in `worktrees::linked`.
use super::*;
use axum::{Router, extract::Request, response::IntoResponse, routing::any};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

fn session_row(id: &str, parent: Option<&str>, dir: &str) -> Value {
    let mut row = json!({
        "id": id,
        "projectID": "prj_cascade",
        "location": { "directory": dir },
    });
    if let Some(parent_id) = parent {
        row["parentID"] = json!(parent_id);
    }
    row
}

#[test]
fn same_location_groups_splits_on_location_boundaries_and_preserves_ancestry() {
    let same = vec![
        session_row("ses_root", None, "/repo/a"),
        session_row("ses_child", Some("ses_root"), "/repo/a"),
        session_row("ses_grand", Some("ses_child"), "/repo/a"),
    ];
    let groups = same_location_groups(&same).unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].0["id"], "ses_root");
    let ids: Vec<&str> = groups[0].1.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["ses_root", "ses_child", "ses_grand"]);

    let split = vec![
        session_row("ses_root", None, "/repo/a"),
        session_row("ses_sibling", Some("ses_root"), "/repo/a"),
        session_row("ses_child", Some("ses_root"), "/repo/b"),
        session_row("ses_grand", Some("ses_child"), "/repo/b"),
    ];
    let groups = same_location_groups(&split).unwrap();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].0["id"], "ses_root");
    assert_eq!(
        groups[0].1.iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["ses_root", "ses_sibling"]
    );
    assert_eq!(groups[1].0["id"], "ses_child");
    assert_eq!(
        groups[1].1.iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["ses_child", "ses_grand"]
    );

    // Grandchild back in root's directory across a differently located parent is its own subtree root.
    let reentry = vec![
        session_row("ses_root", None, "/repo/a"),
        session_row("ses_child", Some("ses_root"), "/repo/b"),
        session_row("ses_grand", Some("ses_child"), "/repo/a"),
    ];
    let groups = same_location_groups(&reentry).unwrap();
    let roots: Vec<&str> = groups.iter().map(|(r, _)| r["id"].as_str().unwrap()).collect();
    assert_eq!(roots, vec!["ses_root", "ses_child", "ses_grand"]);
}

struct CascadeHarness {
    root: PathBuf,
    feature: PathBuf,
    other: PathBuf,
    sessions: Arc<Mutex<Vec<Value>>>,
    move_calls: Arc<Mutex<Vec<String>>>,
    fail_move: Arc<Mutex<Option<(String, usize)>>>,
}

impl CascadeHarness {
    fn dir_of(&self, id: &str) -> String {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .and_then(|s| s["location"]["directory"].as_str())
            .unwrap()
            .to_owned()
    }
}

async fn run_git(dir: &Path, args: &[&str]) {
    let out = crate::git::command(dir, args).output().await.unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

async fn setup_cascade_fixture(
    name: &str,
    initial_fn: impl FnOnce(&str, &str, &str) -> Vec<Value>,
    fail_move: Option<(&str, usize)>,
) -> (PathBuf, Arc<App>, Uuid, Arc<CascadeHarness>, tokio::task::JoinHandle<()>) {
    let dir = crate::shared::test_dir(name);
    let main_repo = dir.join("repo");
    std::fs::create_dir_all(&main_repo).unwrap();
    run_git(&main_repo, &["init"]).await;
    run_git(&main_repo, &["config", "user.email", "test@example.com"]).await;
    run_git(&main_repo, &["config", "user.name", "Test"]).await;
    std::fs::write(main_repo.join("README.md"), "ok\n").unwrap();
    run_git(&main_repo, &["add", "README.md"]).await;
    run_git(&main_repo, &["commit", "-m", "init"]).await;

    let feature_wt = dir.join("wt-feature");
    let other_wt = dir.join("wt-other");
    run_git(&main_repo, &["worktree", "add", "-b", "feature", feature_wt.to_str().unwrap()]).await;
    run_git(&main_repo, &["worktree", "add", "-b", "other", other_wt.to_str().unwrap()]).await;

    let main_canon = dunce::canonicalize(&main_repo).unwrap();
    let feature_canon = dunce::canonicalize(&feature_wt).unwrap();
    let other_canon = dunce::canonicalize(&other_wt).unwrap();
    let main_str = main_canon.to_string_lossy().into_owned();
    let feature_str = feature_canon.to_string_lossy().into_owned();
    let other_str = other_canon.to_string_lossy().into_owned();

    let initial = initial_fn(&main_str, &feature_str, &other_str);
    let harness = Arc::new(CascadeHarness {
        root: main_canon.clone(),
        feature: feature_canon.clone(),
        other: other_canon.clone(),
        sessions: Arc::new(Mutex::new(initial)),
        move_calls: Arc::new(Mutex::new(Vec::new())),
        fail_move: Arc::new(Mutex::new(fail_move.map(|(id, n)| (id.to_owned(), n)))),
    });

    let fake_router = Router::new().fallback(any({
        let h = harness.clone();
        move |req: Request| {
            let h = h.clone();
            async move {
                let method = req.method().clone();
                let path = req.uri().path().to_owned();
                let query = req.uri().query().unwrap_or_default().to_owned();
                let body = axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap();
                match (method, path.as_str()) {
                    (Method::GET, "/api/location") => {
                        let requested = reqwest::Url::parse(&format!("http://localhost/?{query}"))
                            .ok()
                            .and_then(|u| {
                                u.query_pairs()
                                    .find(|(k, _)| k == "location[directory]" || k == "directory")
                                    .map(|(_, v)| v.into_owned())
                            })
                            .unwrap_or_else(|| h.root.to_string_lossy().into_owned());
                        Json(json!({
                            "directory": requested,
                            "project": { "id": "prj_cascade", "directory": h.root, "canonical": h.root }
                        }))
                        .into_response()
                    }
                    (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
                    (Method::GET, "/api/worktree") => Json(json!([
                        { "directory": h.root },
                        { "directory": h.feature },
                        { "directory": h.other },
                    ]))
                    .into_response(),
                    (Method::GET, "/api/session") => {
                        let rows = h.sessions.lock().unwrap().clone();
                        Json(json!({ "data": rows, "cursor": {} })).into_response()
                    }
                    (Method::GET, "/api/session/active") => Json(json!({ "data": {} })).into_response(),
                    (Method::GET, "/api/plugin") => Json(json!([])).into_response(),
                    (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => {
                        Json(json!({ "output": { "owned": false } })).into_response()
                    }
                    (Method::GET, p) if p.starts_with("/api/session/") => {
                        let id = p.trim_start_matches("/api/session/");
                        let row = h.sessions.lock().unwrap().iter().find(|s| s["id"] == id).cloned();
                        match row {
                            Some(row) => Json(json!({ "data": row })).into_response(),
                            None => Status::NOT_FOUND.into_response(),
                        }
                    }
                    (Method::POST, p) if p.starts_with("/api/session/") && p.ends_with("/move") => {
                        let id = p.trim_start_matches("/api/session/").trim_end_matches("/move").to_owned();
                        let payload: Value = serde_json::from_slice(&body).unwrap();
                        let target_dir = payload["directory"].as_str().unwrap().to_owned();
                        let call_num = {
                            let mut calls = h.move_calls.lock().unwrap();
                            calls.push(id.clone());
                            calls.len()
                        };
                        if h.fail_move.lock().unwrap().as_ref().is_some_and(|(fid, n)| fid == &id && *n == call_num) {
                            return Status::INTERNAL_SERVER_ERROR.into_response();
                        }
                        // OpenCode 2.4.2+ cascading Session.move: move target session and all
                        // transitive descendants that currently share its exact directory.
                        let mut rows = h.sessions.lock().unwrap();
                        let prev_dir = rows
                            .iter()
                            .find(|s| s["id"] == id)
                            .and_then(|s| s["location"]["directory"].as_str())
                            .unwrap()
                            .to_owned();
                        let mut moving = HashSet::from([id]);
                        loop {
                            let mut grew = false;
                            for row in rows.iter() {
                                let rid = row["id"].as_str().unwrap();
                                if !moving.contains(rid)
                                    && row["location"]["directory"].as_str() == Some(prev_dir.as_str())
                                    && row["parentID"].as_str().is_some_and(|p| moving.contains(p))
                                {
                                    moving.insert(rid.to_owned());
                                    grew = true;
                                }
                            }
                            if !grew {
                                break;
                            }
                        }
                        for row in rows.iter_mut() {
                            if row["id"].as_str().is_some_and(|rid| moving.contains(rid)) {
                                row["location"]["directory"] = json!(target_dir);
                            }
                        }
                        Json(json!({ "ok": true })).into_response()
                    }
                    _ => Status::NOT_IMPLEMENTED.into_response(),
                }
            }
        }
    }));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let http = tokio::spawn(async move { axum::serve(listener, fake_router).await.unwrap() });

    let auth = crate::auth::Auth::new(crate::auth::Settings {
        username: "fixture".into(),
        password: None,
        file: None,
        cookie: "fixture".into(),
        token: false,
        managed_local: false,
        skip: true,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
        dir.join("config.yaml").to_str().unwrap(),
    ));
    let dir_canon = dunce::canonicalize(&dir).unwrap();
    let app = Arc::new(App::new(
        auth,
        0,
        dir.clone(),
        dir_canon,
        false,
        settings,
        Value::Null,
        crate::opencode::Native::test_connection(addr),
        PathBuf::new(),
        None,
        crate::files::watch::Watches::new(tx),
        None,
    ));
    let ws_id = Uuid::new_v4();
    let ws = Workspace {
        id: ws_id,
        request_id: None,
        path: main_canon.clone(),
        name: None,
        status: "ready",
        proxy_path: format!("/workspaces/{ws_id}/instance"),
        binary_id: PathBuf::new(),
        binary_label: String::new(),
        created_at: String::new(),
        updated_at: String::new(),
        location: json!({"directory": main_canon, "project": {"id": "prj_cascade", "directory": main_canon, "canonical": main_canon}}),
        temporary: None,
    };
    app.inner.lock().unwrap().workspaces.push(ws);
    (dir, app, ws_id, harness, http)
}

#[tokio::test]
async fn place_cascades_same_location_family_in_one_move() {
    let (dir, app, ws_id, harness, http) = setup_cascade_fixture(
        "cascade-single-move",
        |main, _feature, _other| {
            vec![
                session_row("ses_root", None, main),
                session_row("ses_child", Some("ses_root"), main),
                session_row("ses_grand", Some("ses_child"), main),
            ]
        },
        None,
    )
    .await;

    let feature_slug = catalogue(&app, &app.workspace(&ws_id.to_string()).unwrap(), false)
        .await
        .unwrap()
        .trees
        .iter()
        .find(|t| t.registered() == harness.feature)
        .unwrap()
        .slug
        .clone();
    let principal = crate::auth::Principal(tokio_util::sync::CancellationToken::new());
    let Json(result) = place(
        State(app.clone()),
        Route((ws_id.to_string(), "ses_child".into())),
        Extension(principal),
        Json(Move { worktree_slug: feature_slug.clone() }),
    )
    .await
    .unwrap();

    assert_eq!(result["rootSessionId"], "ses_root");
    assert_eq!(result["sessionIds"], json!(["ses_root", "ses_child", "ses_grand"]));
    assert_eq!(result["worktreeSlug"], feature_slug);
    assert_eq!(*harness.move_calls.lock().unwrap(), vec!["ses_root"]);
    let feature = harness.feature.to_string_lossy().into_owned();
    assert_eq!(harness.dir_of("ses_root"), feature);
    assert_eq!(harness.dir_of("ses_child"), feature);
    assert_eq!(harness.dir_of("ses_grand"), feature);

    http.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn place_rolls_back_split_locations_including_descendants_already_at_target() {
    // 1. Standard split rollback matching TS `project-session-families.test.ts`:
    //    root at main, child at other -> fail on child (call #2) -> moves: [root, child, root].
    let (dir, app, ws_id, harness, http) = setup_cascade_fixture(
        "cascade-split-rollback",
        |main, _feature, other| {
            vec![session_row("ses_root", None, main), session_row("ses_child", Some("ses_root"), other)]
        },
        Some(("ses_child", 2)),
    )
    .await;
    let feature_slug = catalogue(&app, &app.workspace(&ws_id.to_string()).unwrap(), false)
        .await
        .unwrap()
        .trees
        .iter()
        .find(|t| t.registered() == harness.feature)
        .unwrap()
        .slug
        .clone();
    let err = place(
        State(app.clone()),
        Route((ws_id.to_string(), "ses_root".into())),
        Extension(crate::auth::Principal(tokio_util::sync::CancellationToken::new())),
        Json(Move { worktree_slug: feature_slug }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, Status::BAD_GATEWAY);
    assert_eq!(*harness.move_calls.lock().unwrap(), vec!["ses_root", "ses_child", "ses_root"]);
    assert_eq!(harness.dir_of("ses_root"), harness.root.to_string_lossy());
    assert_eq!(harness.dir_of("ses_child"), harness.other.to_string_lossy());
    http.abort();
    let _ = std::fs::remove_dir_all(&dir);

    // 2. Cascading rollback across a descendant that originally sat at target (`wt-feature`),
    //    with a grandchild back in `main`: rolling `ses_root` back to `main` cascades `ses_mid`
    //    to `main`, which must then be restored to `wt-feature`, and `ses_leaf` back to `main`.
    let (dir2, app2, ws_id2, harness2, http2) = setup_cascade_fixture(
        "cascade-target-descendant-rollback",
        |main, feature, other| {
            vec![
                session_row("ses_root", None, main),
                session_row("ses_mid", Some("ses_root"), feature),
                session_row("ses_leaf", Some("ses_mid"), main),
                session_row("ses_fail", Some("ses_root"), other),
            ]
        },
        Some(("ses_fail", 2)),
    )
    .await;
    let feature_slug2 = catalogue(&app2, &app2.workspace(&ws_id2.to_string()).unwrap(), false)
        .await
        .unwrap()
        .trees
        .iter()
        .find(|t| t.registered() == harness2.feature)
        .unwrap()
        .slug
        .clone();
    let err = place(
        State(app2.clone()),
        Route((ws_id2.to_string(), "ses_root".into())),
        Extension(crate::auth::Principal(tokio_util::sync::CancellationToken::new())),
        Json(Move { worktree_slug: feature_slug2 }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.0, Status::BAD_GATEWAY);
    assert_eq!(*harness2.move_calls.lock().unwrap(), vec!["ses_root", "ses_fail", "ses_root", "ses_mid", "ses_leaf"]);
    assert_eq!(harness2.dir_of("ses_root"), harness2.root.to_string_lossy());
    assert_eq!(harness2.dir_of("ses_mid"), harness2.feature.to_string_lossy());
    assert_eq!(harness2.dir_of("ses_leaf"), harness2.root.to_string_lossy());
    assert_eq!(harness2.dir_of("ses_fail"), harness2.other.to_string_lossy());
    http2.abort();
    let _ = std::fs::remove_dir_all(&dir2);
}
