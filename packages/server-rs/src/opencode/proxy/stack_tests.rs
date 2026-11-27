use super::relay;
use crate::{App, Workspace, auth::Principal, opencode::Native};
use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct MockState {
    root: PathBuf,
    linked: PathBuf,
    prompts: AtomicUsize,
}

async fn git_run(path: &Path, args: &[&str]) {
    let output = crate::git::command(path, args).output().await.unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

async fn fake_opencode(State(state): State<Arc<MockState>>, request: Request) -> Response {
    let path = request.uri().path();
    let json = |body: Value| Json(body).into_response();
    match (request.method().clone(), path) {
        (Method::GET, "/api/location") => {
            let requested = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
                .ok()
                .and_then(|url| {
                    url.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned())
                })
                .unwrap_or_else(|| state.root.to_string_lossy().into_owned());
            json(json!({
                "directory": requested,
                "project": {"id": "project_stack_test", "directory": state.root, "canonical": state.root}
            }))
        }
        (Method::GET, "/api/worktree") => json(json!([
            {"directory": state.root},
            {"directory": state.linked}
        ])),
        (Method::POST, "/api/worktree/refresh") => Status::NO_CONTENT.into_response(),
        (Method::GET, "/api/session/ses_linked") => json(json!({
            "data": {
                "id": "ses_linked",
                "projectID": "project_stack_test",
                "location": {"directory": state.linked},
                "title": "Stack Test",
                "time": {"created": 1}
            }
        })),
        (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => json(json!({"output": {"owned": false}})),
        (Method::PUT, "/api/session/ses_linked/environment") => Status::NO_CONTENT.into_response(),
        (Method::POST, "/api/session/ses_linked/prompt") => {
            state.prompts.fetch_add(1, Ordering::SeqCst);
            json(json!({"ok": true}))
        }
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

fn file_uri(path: &Path) -> String {
    reqwest::Url::from_file_path(path).unwrap().to_string()
}

#[test]
fn prompt_relay_with_http_read_fits_within_one_mib_current_thread_stack() {
    let handle = std::thread::Builder::new()
        .name("prompt-1mib-stack".into())
        .stack_size(1024 * 1024)
        .spawn(|| {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async {
                let dir = TempDir(crate::shared::test_dir("prompt-1mib-stack"));
                let root = dir.0.join("project");
                let linked = dir.0.join("review");
                std::fs::create_dir(&root).unwrap();
                git_run(&root, &["init", "--quiet"]).await;
                git_run(
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
                        "init",
                    ],
                )
                .await;
                git_run(&root, &["worktree", "add", "--quiet", "--detach", linked.to_str().unwrap()]).await;
                let root = dunce::canonicalize(&root).unwrap();
                let linked = dunce::canonicalize(&linked).unwrap();
                let attached = linked.join("note.txt");
                std::fs::write(&attached, "hello").unwrap();

                let mock =
                    Arc::new(MockState { root: root.clone(), linked: linked.clone(), prompts: AtomicUsize::new(0) });
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let native = Native::test_connection(listener.local_addr().unwrap());
                let server = tokio::spawn({
                    let mock = Arc::clone(&mock);
                    async move {
                        axum::serve(listener, Router::new().fallback(any(fake_opencode)).with_state(mock))
                            .await
                            .unwrap()
                    }
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

                // Verify the boxed async boundaries keep caller future sizes small in debug builds.
                {
                    let http_read_fut =
                        crate::worktrees::linked::http_read(&app, &ws, crate::worktrees::linked::ReadMode::Validated);
                    assert!(
                        std::mem::size_of_val(&http_read_fut) <= 4096,
                        "http_read future unexpectedly large: {} bytes",
                        std::mem::size_of_val(&http_read_fut)
                    );
                }

                let payload = json!({
                    "text": "check attachment",
                    "location": {"directory": linked},
                    "files": [
                        {"uri": file_uri(&attached)}
                    ]
                });
                let request = Request::builder()
                    .method(Method::POST)
                    .uri(format!("/workspaces/{id}/instance/api/session/ses_linked/prompt"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .extension(Principal(CancellationToken::new()))
                    .body(Body::from(payload.to_string()))
                    .unwrap();
                let relay_fut = relay(State(Arc::clone(&app)), request);
                assert!(
                    std::mem::size_of_val(&relay_fut) <= 4096,
                    "relay future unexpectedly large: {} bytes",
                    std::mem::size_of_val(&relay_fut)
                );
                let response = relay_fut.await.expect("prompt relay must succeed on 1 MiB stack");
                assert_eq!(response.status(), Status::OK);
                assert_eq!(mock.prompts.load(Ordering::SeqCst), 1);
                server.abort();
            });
        })
        .expect("spawn 1 MiB thread");
    handle.join().expect("prompt relay must not overflow a 1 MiB stack");
}
