use super::*;
use crate::{
    auth::Principal,
    opencode::Native,
    worktrees::fence_test_trace::{REQUEST, Trace},
};
use axum::{
    Router,
    body::Body,
    extract::Request,
    http::Method,
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
    linked: Option<PathBuf>,
    session_dir: PathBuf,
    trace: Trace,
}

async fn git_fixture(path: &Path, args: &[&str]) {
    let output = crate::git::command(path, args).output().await.unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

async fn fake_native(State(f): State<Arc<Fixture>>, request: Request) -> Response {
    let path = request.uri().path();
    f.trace.lock().unwrap_or_else(|e| e.into_inner()).push(format!("native {} {path}", request.method()));
    let json = |body: Value| Json(body).into_response();
    match (request.method().clone(), path) {
        (Method::GET, "/api/location") => {
            let requested = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
                .ok()
                .and_then(|url| {
                    url.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned())
                })
                .unwrap_or_else(|| f.root.to_string_lossy().into_owned());
            json(json!({
                "directory": requested,
                "project": {"id": "project_root_probe", "directory": f.root, "canonical": f.root}
            }))
        }
        (Method::GET, "/api/worktree") => {
            let mut rows = vec![json!({"directory": f.root})];
            if let Some(linked) = &f.linked {
                rows.push(json!({"directory": linked}));
            }
            json(json!(rows))
        }
        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
        (Method::GET, "/api/session/ses_linked") => json(json!({
            "data": {
                "id": "ses_linked",
                "projectID": "project_root_probe",
                "location": {"directory": f.session_dir},
                "title": "Linked",
                "time": {"created": 1}
            }
        })),
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn encode_header_json(value: &Value) -> String {
    let mut out = String::new();
    for byte in value.to_string().bytes() {
        if byte.is_ascii_graphic() && byte != b'%' {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

struct Harness {
    _dir: TempDir,
    linked: Option<PathBuf>,
    trace: Trace,
    app: Shared,
    id: Uuid,
    ws: Workspace,
    http: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.http.abort();
    }
}

impl Harness {
    async fn new(label: &str, init_git: bool, with_linked: bool) -> Self {
        let dir = TempDir(crate::shared::test_dir(label));
        let root = dir.0.join("project");
        std::fs::create_dir(&root).unwrap();
        let linked = if with_linked { Some(dir.0.join("review")) } else { None };
        if init_git {
            git_fixture(&root, &["init", "--quiet"]).await;
            git_fixture(
                &root,
                &[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@invalid",
                    "commit",
                    "--quiet",
                    "--allow-empty",
                    "-m",
                    "fixture",
                ],
            )
            .await;
            if let Some(checkout) = &linked {
                git_fixture(&root, &["worktree", "add", "--quiet", "--detach", checkout.to_str().unwrap()]).await;
            }
        }
        let session_dir = linked.clone().unwrap_or_else(|| root.clone());
        let trace = Arc::new(Mutex::new(Vec::new()));
        let fixture =
            Arc::new(Fixture { root: root.clone(), linked: linked.clone(), session_dir, trace: trace.clone() });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = Native::test_connection(listener.local_addr().unwrap());
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(fixture)).await.unwrap()
        });
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
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.0.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.0.clone(),
            dir.0.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let id = Uuid::new_v4();
        let ws = Workspace {
            id,
            request_id: None,
            path: root.clone(),
            name: None,
            status: "running",
            proxy_path: format!("/workspaces/{id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": root}),
            temporary: None,
        };
        app.inner.lock().unwrap().workspaces.push(ws.clone());
        Self { _dir: dir, linked, trace, app, id, ws, http }
    }

    fn git_runs(&self, tag: &str) -> usize {
        let needle = format!("{tag} git semaphore held");
        self.trace.lock().unwrap().iter().filter(|line| line.as_str() == needle).count()
    }

    fn rev_parse_runs(&self, tag: &str) -> usize {
        let needle = format!("{tag} git command rev-parse");
        self.trace.lock().unwrap().iter().filter(|line| line.as_str() == needle).count()
    }

    fn native_calls(&self, needle: &str) -> usize {
        self.trace.lock().unwrap().iter().filter(|line| line.as_str() == needle).count()
    }
}

#[tokio::test]
async fn root_only_uses_shared_git_runner_and_classifies_git_and_non_git() {
    let _git = crate::git::test_git_serial().await;
    let git_h = Harness::new("root-only-git", true, false).await;
    let res = REQUEST.scope(("root-only", git_h.trace.clone()), root_only(&git_h.ws)).await.unwrap();
    assert_eq!(res, None, "Git checkout must be recognized as Git");
    assert_eq!(git_h.git_runs("root-only"), 1, "root_only must run through git::run semaphore");
    assert_eq!(git_h.rev_parse_runs("root-only"), 1);

    let non_git = Harness::new("root-only-non-git", false, false).await;
    let res = REQUEST.scope(("root-only", non_git.trace.clone()), root_only(&non_git.ws)).await.unwrap();
    assert_eq!(res, Some(true), "non-Git folder must be recognized as directory-only");
    assert_eq!(non_git.git_runs("root-only"), 1, "non-Git root_only must run through git::run semaphore");
    assert_eq!(non_git.rev_parse_runs("root-only"), 1);

    // Broken gitfile ("fatal: not a git repository: ..."): display list falls back to isGitRepo=false
    // (TS native-worktree-fallback.test.ts), while authority checks fail closed (503) and strict
    // readable_checkout returns false (no departure verdict).
    let broken = Harness::new("root-only-broken-gitfile", false, false).await;
    std::fs::write(broken.ws.path.join(".git"), "gitdir: ./missing-admin\n").unwrap();
    let broken_list = REQUEST
        .scope(
            ("broken-list", broken.trace.clone()),
            list(
                State(broken.app.clone()),
                Path(broken.id.to_string()),
                Ok(Query(Input { fresh: Some("false".into()) })),
            ),
        )
        .await
        .unwrap();
    assert_eq!(broken_list.status(), Status::OK);
    let broken_body = axum::body::to_bytes(broken_list.into_body(), 64 * 1024).await.unwrap();
    let broken_json: Value = serde_json::from_slice(&broken_body).unwrap();
    assert_eq!(broken_json["isGitRepo"], false);
    assert_eq!(broken.rev_parse_runs("broken-list"), 1);
    assert_eq!(root_only(&broken.ws).await.unwrap_err().0, Status::SERVICE_UNAVAILABLE);
    assert_eq!(exact_root_supported(&broken.app, &broken.ws).await.unwrap_err().0, Status::SERVICE_UNAVAILABLE);
    assert!(!linked::readable_checkout(&broken.ws.path).await);

    // Invalid gitfile format (exit 128 without "not a git repository"): display list falls back to
    // isGitRepo=false (TS git-worktrees.ts:14-22), while authority checks fail closed.
    let invalid_gitfile = Harness::new("root-only-invalid-gitfile", false, false).await;
    std::fs::write(invalid_gitfile.ws.path.join(".git"), "not-a-gitdir-header\n").unwrap();
    let invalid_list = REQUEST
        .scope(
            ("invalid-list", invalid_gitfile.trace.clone()),
            list(
                State(invalid_gitfile.app.clone()),
                Path(invalid_gitfile.id.to_string()),
                Ok(Query(Input { fresh: Some("false".into()) })),
            ),
        )
        .await
        .unwrap();
    assert_eq!(invalid_list.status(), Status::OK);
    let invalid_body = axum::body::to_bytes(invalid_list.into_body(), 64 * 1024).await.unwrap();
    let invalid_json: Value = serde_json::from_slice(&invalid_body).unwrap();
    assert_eq!(invalid_json["isGitRepo"], false);
    assert_eq!(root_only(&invalid_gitfile.ws).await.unwrap_err().0, Status::SERVICE_UNAVAILABLE);
    assert_eq!(
        exact_root_supported(&invalid_gitfile.app, &invalid_gitfile.ws).await.unwrap_err().0,
        Status::SERVICE_UNAVAILABLE
    );
    assert!(strict_non_git_workspace(&invalid_gitfile.ws).await.is_err());
    assert!(!linked::readable_checkout(&invalid_gitfile.ws.path).await);
}

#[tokio::test]
async fn repo_target_and_worktrees_list_avoid_duplicate_root_probe() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("no-dup-root-probe", true, false).await;

    // 1. GET /worktrees?fresh=false on a 1-checkout repo: 1 rev-parse only (no duplicate root probe).
    let list_res = REQUEST
        .scope(
            ("list", h.trace.clone()),
            list(State(h.app.clone()), Path(h.id.to_string()), Ok(Query(Input { fresh: Some("false".into()) }))),
        )
        .await
        .unwrap();
    assert_eq!(list_res.status(), Status::OK);
    assert_eq!(
        h.rev_parse_runs("list"),
        1,
        "worktrees::list must run rev-parse once, not twice: {:?}",
        h.trace.lock().unwrap()
    );

    // 2. Warm git::repo hits the 10 s HTTP cache (0 rev-parse, 0 native HTTP worktree calls);
    //    after blocking invalidation, cold git::repo runs rev-parse once (no duplicate root probe).
    let worktree_gets_before = h.native_calls("native GET /api/worktree");
    let worktree_refreshes_before = h.native_calls("native POST /api/worktree/refresh");
    let warm_repo =
        REQUEST.scope(("repo-warm", h.trace.clone()), crate::git::repo(&h.app, &h.id.to_string(), "root")).await;
    if let Err(err) = warm_repo {
        panic!("warm repo_target must succeed: {err:?}");
    }
    assert_eq!(
        h.rev_parse_runs("repo-warm"),
        0,
        "warm git::repo_target must reuse the 10 s worktree cache: {:?}",
        h.trace.lock().unwrap()
    );
    assert_eq!(
        h.native_calls("native GET /api/worktree"),
        worktree_gets_before,
        "warm git::repo_target must not query native /api/worktree: {:?}",
        h.trace.lock().unwrap()
    );
    assert_eq!(
        h.native_calls("native POST /api/worktree/refresh"),
        worktree_refreshes_before,
        "warm git::repo_target must not trigger native /api/worktree/refresh: {:?}",
        h.trace.lock().unwrap()
    );
    linked::invalidate_blocking(&h.app);
    let repo_res = REQUEST.scope(("repo", h.trace.clone()), crate::git::repo(&h.app, &h.id.to_string(), "root")).await;
    if let Err(err) = repo_res {
        panic!("repo_target must succeed: {err:?}");
    }
    assert_eq!(
        h.rev_parse_runs("repo"),
        1,
        "git::repo_target must run rev-parse once, not twice: {:?}",
        h.trace.lock().unwrap()
    );

    // 3. exact_root_supported on a Git repo: 1 rev-parse only.
    assert!(
        REQUEST.scope(("exact-root", h.trace.clone()), exact_root_supported(&h.app, &h.ws)).await.unwrap(),
        "exact_root_supported must succeed on the opened Git checkout"
    );
    assert_eq!(h.rev_parse_runs("exact-root"), 1);

    // 4. Non-Git workspace still rejects with 400 and never hits native HTTP.
    let non_git = Harness::new("no-dup-non-git", false, false).await;
    let err = match REQUEST
        .scope(("non-git-repo", non_git.trace.clone()), crate::git::repo(&non_git.app, &non_git.id.to_string(), "root"))
        .await
    {
        Err(err) => err,
        Ok(_) => panic!("non-Git repo_target must fail"),
    };
    assert_eq!(err.0, Status::BAD_REQUEST);
    assert_eq!(err.1.0["error"], "Workspace is not a Git repository");
    assert_eq!(non_git.rev_parse_runs("non-git-repo"), 1);
    assert_eq!(non_git.git_runs("non-git-repo"), 1);
    assert_eq!(non_git.native_calls("native GET /api/location"), 0);
}

#[tokio::test]
async fn proxy_linked_session_reuses_placement_without_second_catalogue() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("proxy-linked-once", true, true).await;
    let linked = h.linked.clone().unwrap();
    let principal = Principal(CancellationToken::new());

    // 1. Session GET with placement header + matching x-codenomad-location: placement() verifies
    //    the linked checkout once; owns() and x-codenomad-location must NOT trigger a second/third catalogue().
    let location_header = encode_header_json(&json!({"directory": linked}));
    let mut req = Request::builder()
        .method(Method::GET)
        .uri(format!("{}/api/session/ses_linked", h.ws.proxy_path))
        .header(crate::opencode::SESSION_PLACEMENT_HEADER, "1")
        .header("x-codenomad-location", location_header)
        .body(Body::empty())
        .unwrap();
    req.extensions_mut().insert(principal.clone());
    let response = crate::opencode::proxy::relay(State(h.app.clone()), req).await.unwrap();
    assert_eq!(response.status(), Status::OK);
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert!(
        payload["data"]["listWorktreeSlug"].as_str().is_some_and(|slug| slug.starts_with("worktree-")),
        "expected linked worktree slug, got: {payload}"
    );
    assert_eq!(
        h.native_calls("native GET /api/location"),
        1,
        "linked session GET must enter catalogue once (not even a failed second /api/location): {:?}",
        h.trace.lock().unwrap()
    );
    assert_eq!(
        h.native_calls("native GET /api/worktree"),
        1,
        "linked session GET must run catalogue once, not repeat it in owns() or x-codenomad-location: {:?}",
        h.trace.lock().unwrap()
    );

    // 2. An existing foreign directory in x-codenomad-location outside app.scope is still refused with 403.
    let foreign_dir = TempDir(crate::shared::test_dir("outside-scope-dir"));
    let foreign_header = encode_header_json(&json!({"directory": foreign_dir.0}));
    let mut foreign_req = Request::builder()
        .method(Method::GET)
        .uri(format!("{}/api/session/ses_linked", h.ws.proxy_path))
        .header(crate::opencode::SESSION_PLACEMENT_HEADER, "1")
        .header("x-codenomad-location", foreign_header)
        .body(Body::empty())
        .unwrap();
    foreign_req.extensions_mut().insert(principal);
    let err = crate::opencode::proxy::relay(State(h.app.clone()), foreign_req).await.unwrap_err();
    assert_eq!(err.0, Status::FORBIDDEN);
}
