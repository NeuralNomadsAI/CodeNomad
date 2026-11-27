use super::*;
use crate::{
    auth::Principal,
    opencode::Native,
    worktrees::fence_test_trace::{
        AFTER_PROMPT_RESOLVE, AFTER_RECHECK_BEFORE_ADMIT, BEFORE_ADMISSION, Pause, REQUEST, Trace,
    },
};
use axum::{
    Router,
    body::Body,
    extract::Request,
    response::{IntoResponse, Response},
    routing::any,
};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
    checkout: PathBuf,
    session: String,
    trace: Trace,
}

async fn git_fixture(path: &Path, args: &[&str]) {
    let output = crate::git::command(path, args).output().await.unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

async fn fake(State(f): State<Arc<Fixture>>, request: Request) -> Response {
    let path = request.uri().path();
    let session = json!({
        "id":&f.session, "projectID":"project_fixture", "location":{"directory":f.root},
        "title":"Fixture prompt", "time":{"created":1}
    });
    let json = |body: Value| Json(body).into_response();
    let session_path = format!("/api/session/{}", f.session);
    let env_path = format!("{session_path}/environment");
    let prompt_path = format!("{session_path}/prompt");
    let terminal_path = format!("/api/experimental/session/{}/terminal", f.session);
    f.trace.lock().unwrap_or_else(|e| e.into_inner()).push(format!("native {} {path}", request.method()));
    match (request.method().clone(), path) {
        (Method::GET, p) if p == session_path => json(json!({"data":session})),
        (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => json(json!({"output":{"owned":false}})),
        (Method::PUT, p) if p == env_path => Status::NO_CONTENT.into_response(),
        (Method::POST, p) if p == prompt_path => json(json!({"data":{"type":"user"}})),
        (Method::GET, "/api/location") => {
            let requested = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
                .ok()
                .and_then(|url| {
                    url.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned())
                })
                .unwrap_or_else(|| f.root.to_string_lossy().into_owned());
            json(json!({
                "directory": requested, "project":{"id":"project_fixture","directory":f.root,"canonical":f.root}
            }))
        }
        (Method::GET, "/api/worktree") => json(if f.checkout.exists() {
            json!([{"directory":f.root},{"directory":f.checkout}])
        } else {
            json!([{"directory":f.root}])
        }),
        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
        (Method::GET, "/api/debug/location" | "/api/project") => json(json!([])),
        (Method::GET, "/api/session") => {
            let matching = request.uri().query().unwrap_or_default().contains("project=project_fixture");
            json(json!({"data":if matching { vec![session] } else { vec![] }, "cursor":{}}))
        }
        (Method::GET, "/api/shell" | "/api/pty") => json(json!({"data":[]})),
        (Method::GET, p) if p == terminal_path => json(json!({"data":[]})),
        (Method::DELETE, "/api/worktree") => {
            git_fixture(&f.root, &["worktree", "remove", f.checkout.to_str().unwrap()]).await;
            Status::NO_CONTENT.into_response()
        }
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

async fn bounded<T>(trace: &Trace, phase: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), future).await.unwrap_or_else(|_| {
        panic!("{phase} timed out:\n{}", trace.lock().unwrap_or_else(|e| e.into_inner()).join("\n"))
    })
}

struct Harness {
    dir: PathBuf,
    root: PathBuf,
    checkout: PathBuf,
    session: String,
    trace: Trace,
    app: Shared,
    id: Uuid,
    ws: Workspace,
    target: String,
    http: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.http.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Harness {
    async fn new(label: &str) -> Self {
        Self::with_layout(label, false).await
    }

    async fn with_managed_checkout(label: &str) -> Self {
        Self::with_layout(label, true).await
    }

    async fn with_layout(label: &str, managed: bool) -> Self {
        let dir = crate::shared::test_dir(label);
        let root = dir.join("project");
        let checkout =
            if managed { root.join(".codenomad").join("worktrees").join("linked") } else { dir.join("linked") };
        std::fs::create_dir(&root).unwrap();
        if let Some(parent) = checkout.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
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
        git_fixture(&root, &["worktree", "add", "--quiet", "--detach", checkout.to_str().unwrap()]).await;

        let trace = Arc::new(Mutex::new(Vec::new()));
        let session = format!("ses_probe_{}", label.replace('-', "_"));
        let f = Arc::new(Fixture {
            root: root.clone(),
            checkout: checkout.clone(),
            session: session.clone(),
            trace: trace.clone(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = Native::test_connection(listener.local_addr().unwrap());
        let fixture = f.clone();
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake)).with_state(fixture)).await.unwrap()
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
            dir.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            files::watch::Watches::new(tx),
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
            location: json!({"directory":root}),
            temporary: None,
        };
        app.inner.lock().unwrap().workspaces.push(ws.clone());
        let catalogue = catalogue(&app, &ws, false).await.unwrap();
        let target = catalogue.trees.iter().find(|t| t.registered() == checkout).unwrap().slug.clone();
        Self { dir, root, checkout, session, trace, app, id, ws, target, http }
    }

    fn prompt_trace(&self) -> String {
        format!("native POST /api/session/{}/prompt", self.session)
    }

    fn prompt_request(&self, principal: &Principal, directory: PathBuf) -> Request {
        let body = json!({"text":"synthetic","directory":directory});
        let mut request = Request::builder()
            .method(Method::POST)
            .uri(format!("{}/api/session/{}/prompt", self.ws.proxy_path, self.session))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        request.extensions_mut().insert(principal.clone());
        request
    }

    async fn wait_paused(
        &self,
        phase: &str,
        pause: &Pause,
        prompt: &mut tokio::task::JoinHandle<Result<Response, Error>>,
    ) {
        let result = tokio::time::timeout(Duration::from_secs(60), async {
            tokio::select! {
                reached = pause.reached.acquire() => reached.unwrap().forget(),
                result = &mut *prompt => panic!(
                    "prompt finished before the injection: {result:?}\n{}",
                    self.trace.lock().unwrap_or_else(|e| e.into_inner()).join("\n")
                ),
            }
        })
        .await;
        if result.is_err() {
            prompt.abort();
            panic!("{phase} timed out:\n{}", self.trace.lock().unwrap_or_else(|e| e.into_inner()).join("\n"));
        }
    }

    async fn delete_checkout(&self, principal: Principal) {
        let deletion = REQUEST.scope(
            ("DELETE", self.trace.clone()),
            remove_owned(self.app.clone(), self.id.to_string(), self.target.clone(), principal),
        );
        let deleted = bounded(&self.trace, "DELETE while prompt is paused", deletion).await;
        assert!(matches!(deleted, Ok(Status::NO_CONTENT)), "{deleted:?}\n{:?}", self.trace.lock().unwrap());
        assert!(!self.checkout.exists());
    }
}

fn new_pause() -> Arc<Pause> {
    Arc::new(Pause { reached: Semaphore::new(0), release: Semaphore::new(0) })
}

async fn rejected_before_dispatch(outcome: Result<axum::response::Response, crate::Error>) -> (Status, Value) {
    let response = outcome.expect("send_input pre-dispatch refusal must return a marked HTTP response");
    assert_eq!(
        response.headers().get("x-codenomad-before-dispatch").and_then(|v| v.to_str().ok()),
        Some("1"),
        "send_input pre-dispatch refusal must carry x-codenomad-before-dispatch: 1"
    );
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    (status, body)
}

#[tokio::test]
async fn deletion_finishes_while_a_prospective_prompt_is_held_before_admission() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("mutation-race").await;
    let principal = Principal(CancellationToken::new());
    let request = h.prompt_request(&principal, h.checkout.join("future").join("nested"));
    let pause = new_pause();
    let mut prompt = tokio::spawn(REQUEST.scope(
        ("prompt", h.trace.clone()),
        BEFORE_ADMISSION.scope(pause.clone(), proxy::relay(State(h.app.clone()), request)),
    ));
    h.wait_paused("before-admission hook", &pause, &mut prompt).await;

    // An unadmitted prompt holds no checkout permit; TS drains admitted writes
    // only (worktree-session-evacuation.ts:65–78), then re-resolves the selector
    // immediately before admission (http-server.ts:1435–1453).
    h.delete_checkout(principal).await;
    pause.release.add_permits(1);
    let rejected =
        rejected_before_dispatch(bounded(&h.trace, "release prompt after deletion", prompt).await.unwrap()).await;
    let lines = h.trace.lock().unwrap().clone();
    assert_eq!(rejected.0, Status::FORBIDDEN, "{rejected:?}\n{lines:?}");
    assert_eq!(rejected.1, json!({"error":"Location does not belong to workspace"}));
    assert!(lines.iter().any(|line| line == "DELETE checkout fence drained"), "{lines:?}");
    let sent = h.prompt_trace();
    assert!(
        !lines.iter().any(|line| line.starts_with("prompt checkout fence")
            || line.starts_with("prompt session reservation")
            || line.starts_with("prompt environment semaphore")
            || line == &sent),
        "{lines:?}"
    );
}

#[tokio::test]
async fn deletion_during_initial_prospective_resolution_is_rejected() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("mutation-race-initial").await;
    let principal = Principal(CancellationToken::new());
    let request = h.prompt_request(&principal, h.checkout.join("future").join("nested"));
    let pause = new_pause();
    let mut prompt = tokio::spawn(REQUEST.scope(
        ("prompt", h.trace.clone()),
        AFTER_PROMPT_RESOLVE.scope(pause.clone(), proxy::relay(State(h.app.clone()), request)),
    ));
    h.wait_paused("after-prompt-resolve hook", &pause, &mut prompt).await;

    h.delete_checkout(principal).await;
    pause.release.add_permits(1);
    let rejected = rejected_before_dispatch(
        bounded(&h.trace, "release prompt after initial resolution deletion", prompt).await.unwrap(),
    )
    .await;
    let lines = h.trace.lock().unwrap().clone();
    assert_eq!(rejected.0, Status::FORBIDDEN, "{rejected:?}\n{lines:?}");
    assert_eq!(rejected.1, json!({"error":"Location does not belong to workspace"}));
    assert!(!lines.iter().any(|line| line == &h.prompt_trace()), "{lines:?}");
}

#[tokio::test]
async fn unrelated_deletion_does_not_reject_a_live_root_prompt() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("mutation-race-root-live").await;
    let principal = Principal(CancellationToken::new());
    let request = h.prompt_request(&principal, h.root.join("future").join("nested"));
    let pause = new_pause();
    let mut prompt = tokio::spawn(REQUEST.scope(
        ("prompt", h.trace.clone()),
        BEFORE_ADMISSION.scope(pause.clone(), proxy::relay(State(h.app.clone()), request)),
    ));
    h.wait_paused("before-admission hook", &pause, &mut prompt).await;

    // Deleting `checkout` also blocks `root` (evacuation destination), flipping
    // `initial_live`. Revalidation still finds `root` live and admits the prompt.
    h.delete_checkout(principal).await;
    pause.release.add_permits(1);
    let response =
        bounded(&h.trace, "release live root prompt after unrelated deletion", prompt).await.unwrap().unwrap();
    let lines = h.trace.lock().unwrap().clone();
    assert_eq!(response.status(), Status::OK, "{lines:?}");
    assert!(lines.iter().any(|line| line == &h.prompt_trace()), "{lines:?}");
}

#[tokio::test]
async fn deletion_still_holding_fence_returns_409_for_prospective_prompt() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("mutation-race-409").await;
    let principal = Principal(CancellationToken::new());
    let request = h.prompt_request(&principal, h.checkout.join("future").join("nested"));
    let pause = new_pause();
    let mut prompt = tokio::spawn(REQUEST.scope(
        ("prompt", h.trace.clone()),
        BEFORE_ADMISSION.scope(pause.clone(), proxy::relay(State(h.app.clone()), request)),
    ));
    h.wait_paused("before-admission hook", &pause, &mut prompt).await;

    // Block only `checkout` (not `root`, where the session lives) and remove it
    // on disk as a deletion in progress does before releasing the fence.
    let _blocked = crate::worktrees::fence::block(&[crate::worktrees::fence::identity(&h.checkout)]).await.unwrap();
    git_fixture(&h.root, &["worktree", "remove", h.checkout.to_str().unwrap()]).await;
    pause.release.add_permits(1);
    let rejected =
        rejected_before_dispatch(bounded(&h.trace, "release prompt during active deletion", prompt).await.unwrap())
            .await;
    let lines = h.trace.lock().unwrap().clone();
    assert_eq!(rejected.0, Status::CONFLICT, "{rejected:?}\n{lines:?}");
    assert_eq!(rejected.1, json!({"error":"Worktree deletion is in progress"}));
    assert!(!lines.iter().any(|line| line == &h.prompt_trace()), "{lines:?}");
}

#[tokio::test]
async fn deletion_between_recheck_and_admit_rejects_prospective_prompt() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("mutation-race-aba").await;
    let principal = Principal(CancellationToken::new());
    let request = h.prompt_request(&principal, h.checkout.join("future").join("nested"));
    let pause = new_pause();
    let mut prompt = tokio::spawn(REQUEST.scope(
        ("prompt", h.trace.clone()),
        AFTER_RECHECK_BEFORE_ADMIT.scope(pause.clone(), proxy::relay(State(h.app.clone()), request)),
    ));
    h.wait_paused("after-recheck hook", &pause, &mut prompt).await;

    h.delete_checkout(principal).await;
    pause.release.add_permits(1);
    let rejected = rejected_before_dispatch(
        bounded(&h.trace, "release prompt after post-recheck deletion", prompt).await.unwrap(),
    )
    .await;
    let lines = h.trace.lock().unwrap().clone();
    assert_eq!(rejected.0, Status::FORBIDDEN, "{rejected:?}\n{lines:?}");
    assert_eq!(rejected.1, json!({"error":"Location does not belong to workspace"}));
    assert!(!lines.iter().any(|line| line == &h.prompt_trace()), "{lines:?}");
}

#[tokio::test]
async fn subfolder_sessions_and_nested_workspace_sources_are_resolved() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("mutation-race-nested").await;
    let nested_sub = h.checkout.join("apps").join("web");
    let root_sub = h.root.join("apps").join("web");
    std::fs::create_dir_all(&nested_sub).unwrap();
    std::fs::create_dir_all(&root_sub).unwrap();

    let cat = catalogue(&h.app, &h.ws, false).await.unwrap();
    let tree = cat.get(&h.target).unwrap();
    let sub_str = nested_sub.to_string_lossy().into_owned();
    assert_eq!(owner(&cat, &sub_str).map(|t| t.slug.as_str()), Some(tree.slug.as_str()));
    let paths =
        evacuation_paths(&cat, tree, &[vec![json!({"id":"ses_sub","location":{"directory":sub_str}})]]).unwrap();
    assert!(paths.contains(&crate::worktrees::fence::identity(tree.registered())));

    let mut nested_ws = h.ws.clone();
    nested_ws.path = root_sub.clone();
    nested_ws.location = json!({"directory":root_sub});
    let nested_cat = catalogue(&h.app, &nested_ws, false).await.unwrap();
    let nested_from = nested_cat.get("root").unwrap();
    assert!(!nested_from.nested_missing);
    assert!(nested_from.contains_live(&nested_from.path));
    assert!(!nested_from.contains_live(nested_from.registered()));

    // A deleted linked worktree under `<root>/.codenomad/worktrees/<slug>` must never fall back to `root`.
    let managed = h.root.join(".codenomad").join("worktrees").join("gone");
    assert!(owner(&cat, &managed.to_string_lossy()).is_none());

    // `checkout_root` resolves nested subfolders to their enclosing checkout root within scope.
    assert_eq!(crate::worktrees::fence::checkout_root(&h.dir, &nested_sub), h.checkout);
    assert_eq!(crate::worktrees::fence::checkout_root(&h.dir, &root_sub), h.root);
    let root_set = HashSet::from([crate::worktrees::fence::identity(&h.root)]);
    let child_set = HashSet::from([crate::worktrees::fence::identity(&managed)]);
    assert!(crate::worktrees::fence::covered(&root_set, &child_set));
    assert!(!crate::worktrees::fence::covered(&child_set, &root_set));

    // Deletion root reservation blocks overlapping deletions and opens under the target, never `root` or siblings.
    let target_id = crate::worktrees::fence::identity(&h.checkout);
    let _reserved = crate::worktrees::fence::reserve_deletion_root(&target_id).unwrap();
    assert_eq!(
        crate::worktrees::fence::reserve_deletion_root(&target_id).err(),
        Some("Worktree deletion is already in progress")
    );
    assert!(crate::worktrees::fence::is_deleting_root(&target_id));
    assert!(crate::worktrees::fence::is_deleting_root(&crate::worktrees::fence::identity(&nested_sub)));
    assert!(!crate::worktrees::fence::is_deleting_root(&crate::worktrees::fence::identity(&h.root)));

    // `topology()` preserves non-Git status codes (`409` for move, `400` for remove).
    // `TEMP` may lie inside the checkout (`validate-receipt.ps1`), so pick a temp base outside any `.git`.
    let has_git_ancestor = |path: &Path| path.ancestors().any(|a| a.join(".git").exists());
    let plain_base = [
        Some(std::env::temp_dir()),
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Temp")),
        cfg!(unix).then(|| PathBuf::from("/tmp")),
    ]
    .into_iter()
    .flatten()
    .find(|base| base.is_dir() && !has_git_ancestor(base))
    .expect("a temp directory outside any Git repository");
    let plain = plain_base.join(format!("cnrs-nongit-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&plain).unwrap();
    let plain = dunce::canonicalize(&plain).unwrap();
    struct RemoveDir(PathBuf);
    impl Drop for RemoveDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _plain_cleanup = RemoveDir(plain.clone());
    let plain_id = Uuid::new_v4();
    let mut plain_ws = h.ws.clone();
    plain_ws.id = plain_id;
    plain_ws.path = plain.clone();
    plain_ws.location = json!({"directory":plain});
    h.app.inner.lock().unwrap().workspaces.push(plain_ws);
    assert_eq!(topology(&h.app, &plain_id.to_string(), Status::CONFLICT).await.err().unwrap().0, Status::CONFLICT);
    assert_eq!(
        topology(&h.app, &plain_id.to_string(), Status::BAD_REQUEST).await.err().unwrap().0,
        Status::BAD_REQUEST
    );
}

#[tokio::test]
async fn managed_worktree_prospective_prompt_returns_409_during_deletion_and_200_after_git_remove() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::with_managed_checkout("mutation-race-managed-409").await;
    let principal = Principal(CancellationToken::new());
    let request = h.prompt_request(&principal, h.checkout.join("future").join("nested"));
    let pause = new_pause();
    let mut prompt = tokio::spawn(REQUEST.scope(
        ("prompt", h.trace.clone()),
        BEFORE_ADMISSION.scope(pause.clone(), proxy::relay(State(h.app.clone()), request)),
    ));
    h.wait_paused("before-admission hook (managed 409)", &pause, &mut prompt).await;

    let _blocked = crate::worktrees::fence::block(&[crate::worktrees::fence::identity(&h.checkout)]).await.unwrap();
    git_fixture(&h.root, &["worktree", "remove", h.checkout.to_str().unwrap()]).await;
    pause.release.add_permits(1);
    let rejected = rejected_before_dispatch(
        bounded(&h.trace, "release managed prompt during active deletion", prompt).await.unwrap(),
    )
    .await;
    let lines = h.trace.lock().unwrap().clone();
    assert_eq!(rejected.0, Status::CONFLICT, "{rejected:?}\n{lines:?}");
    assert_eq!(rejected.1, json!({"error":"Worktree deletion is in progress"}));
    assert!(!lines.iter().any(|line| line == &h.prompt_trace()), "{lines:?}");

    let h2 = Harness::with_managed_checkout("mutation-race-managed-git").await;
    let principal2 = Principal(CancellationToken::new());
    let request2 = h2.prompt_request(&principal2, h2.checkout.join("future").join("nested"));
    let pause2 = new_pause();
    let mut prompt2 = tokio::spawn(REQUEST.scope(
        ("prompt", h2.trace.clone()),
        BEFORE_ADMISSION.scope(pause2.clone(), proxy::relay(State(h2.app.clone()), request2)),
    ));
    h2.wait_paused("before-admission hook (managed git remove)", &pause2, &mut prompt2).await;

    git_fixture(&h2.root, &["worktree", "remove", h2.checkout.to_str().unwrap()]).await;
    pause2.release.add_permits(1);
    let response =
        bounded(&h2.trace, "release managed prompt after external git remove", prompt2).await.unwrap().unwrap();
    let lines2 = h2.trace.lock().unwrap().clone();
    assert_eq!(response.status(), Status::OK, "{lines2:?}");
    assert!(lines2.iter().any(|line| line == &h2.prompt_trace()), "{lines2:?}");
}
