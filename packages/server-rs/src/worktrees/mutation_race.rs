use super::*;
use crate::{
    auth::Principal,
    opencode::Native,
    worktrees::fence_test_trace::{BEFORE_ADMISSION, Pause, REQUEST, Trace},
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
    trace: Trace,
}

async fn git_fixture(path: &Path, args: &[&str]) {
    let output = crate::git::command(path, args).output().await.unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

async fn fake(State(f): State<Arc<Fixture>>, request: Request) -> Response {
    let path = request.uri().path();
    let session = json!({
        "id":"ses_probe", "projectID":"project_fixture", "location":{"directory":f.root},
        "title":"Fixture prompt", "time":{"created":1}
    });
    let json = |body: Value| Json(body).into_response();
    f.trace.lock().unwrap().push(format!("native {} {path}", request.method()));
    match (request.method().clone(), path) {
        (Method::GET, "/api/session/ses_probe") => json(json!({"data":session})),
        (Method::POST, "/api/rpc/codenomad.missions/scheduleCarrierRead") => json(json!({"output":{"owned":false}})),
        (Method::GET, "/api/location") => json(json!({
            "directory": f.root, "project":{"id":"project_fixture","directory":f.root,"canonical":f.root}
        })),
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
        (Method::GET, "/api/shell" | "/api/pty" | "/api/experimental/session/ses_probe/terminal") => {
            json(json!({"data":[]}))
        }
        (Method::DELETE, "/api/worktree") => {
            git_fixture(&f.root, &["worktree", "remove", f.checkout.to_str().unwrap()]).await;
            Status::NO_CONTENT.into_response()
        }
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

async fn bounded<T>(trace: &Trace, phase: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .unwrap_or_else(|_| panic!("{phase} timed out:\n{}", trace.lock().unwrap().join("\n")))
}

#[tokio::test]
async fn deletion_finishes_while_a_prospective_prompt_is_held_before_admission() {
    let dir = crate::shared::test_dir("mutation-race");
    let root = dir.join("project");
    let checkout = dir.join("linked");
    std::fs::create_dir(&root).unwrap();
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
    let f = Arc::new(Fixture { root: root.clone(), checkout: checkout.clone(), trace: trace.clone() });
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
    };
    app.inner.lock().unwrap().workspaces.push(ws.clone());
    let catalogue = catalogue(&app, &ws, false).await.unwrap();
    let target = catalogue.trees.iter().find(|t| t.registered() == checkout).unwrap().slug.clone();
    let principal = Principal(CancellationToken::new());
    let body = json!({"text":"synthetic","directory":checkout.join("future").join("nested")});
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(format!("{}/api/session/ses_probe/prompt", ws.proxy_path))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.extensions_mut().insert(principal.clone());
    let prompt_app = app.clone();
    let pause = Arc::new(Pause { reached: Semaphore::new(0), release: Semaphore::new(0) });
    let mut prompt = tokio::spawn(REQUEST.scope(
        ("prompt", trace.clone()),
        BEFORE_ADMISSION.scope(pause.clone(), proxy::relay(State(prompt_app), request)),
    ));
    bounded(&trace, "before-admission hook", async {
        tokio::select! {
            reached = pause.reached.acquire() => reached.unwrap().forget(),
            result = &mut prompt => panic!("prompt finished before the injection: {result:?}\n{}", trace.lock().unwrap().join("\n")),
        }
    }).await;

    // An unadmitted prompt holds no checkout permit; TS drains admitted writes
    // only (worktree-session-evacuation.ts:65–78), then re-resolves the selector
    // immediately before admission (http-server.ts:1435–1453).
    let deletion =
        REQUEST.scope(("DELETE", trace.clone()), remove_owned(app.clone(), id.to_string(), target, principal));
    let deleted = bounded(&trace, "DELETE while the prompt is held before admission", deletion).await;
    assert!(matches!(deleted, Ok(Status::NO_CONTENT)), "{deleted:?}\n{:?}", trace.lock().unwrap());
    assert!(!checkout.exists());
    pause.release.add_permits(1);
    let rejected = bounded(&trace, "release prompt after deletion", prompt).await.unwrap().unwrap_err();
    let lines = trace.lock().unwrap().clone();
    eprintln!("{}", lines.join("\n"));
    assert_eq!(rejected.0, Status::FORBIDDEN, "{rejected:?}\n{lines:?}");
    assert!(lines.iter().any(|line| line == "DELETE checkout fence drained"), "{lines:?}");
    assert!(
        !lines.iter().any(|line| line.starts_with("prompt checkout fence")
            || line.starts_with("prompt session reservation")
            || line.starts_with("prompt permission rules")
            || line.starts_with("prompt environment semaphore")
            || line == "native POST /api/session/ses_probe/prompt"),
        "{lines:?}"
    );
    http.abort();
    let _ = http.await;
    std::fs::remove_dir_all(dir).unwrap();
}
