use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{Router, http::StatusCode as Status};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::{App, auth, files, meta, opencode, settings};

fn scratch(name: &str) -> PathBuf {
    let dir = crate::shared::test_dir(name);
    fs::create_dir_all(dir.join("state")).unwrap();
    fs::create_dir_all(dir.join("config")).unwrap();
    dir
}

struct FakeDaemon {
    url: String,
    reloads: Arc<AtomicUsize>,
}

async fn spawn_daemon(version: &'static str, pid: u64, with_reload: bool) -> FakeDaemon {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let reloads = Arc::new(AtomicUsize::new(0));
    let reload_counter = reloads.clone();
    let auth =
        format!("basic {}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "opencode:secret"));
    let body = |field: &str| json!({"requestBody": {"content": {"application/json": {"schema": {"properties": {field: {}}}}}}});
    let mut paths = json!({
        "/api/session/{sessionID}": {"patch": {}},
        "/api/form": {"get": {}},
        "/api/session/{sessionID}/form/{formID}": {"delete": {}},
        "/api/experimental/session/{sessionID}/wait": {"post": {}},
        "/api/session/{sessionID}/fork": {"post": body("before")},
        "/api/session/{sessionID}/command": {"post": body("name")},
        "/api/session/{sessionID}/permission/{requestID}/reply": {"post": body("decision")},
        "/api/session/{sessionID}/environment": {"put": {"requestBody": {"content": {"application/json":
            {"schema": {"$ref": "#/components/schemas/Env"}}}}}},
    });
    if with_reload {
        paths["/api/location/reload"] = json!({"post": {}});
    }
    let openapi = json!({
        "paths": paths,
        "components": {"schemas": {
            "Env": {"properties": {"variables": {}}},
            "Session.Inbox.User": {"properties": {"time": {}}},
            "Session.Message.Assistant.Text": {"properties": {"native": {}}},
            "Session.Message.Compaction.Completed": {"properties": {"metadata": {}}},
        }},
    })
    .to_string();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && socket.read(&mut byte).await.is_ok_and(|n| n == 1) {
                head.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
            let (status, body) = if !head.contains(&auth.to_ascii_lowercase()) {
                ("401 Unauthorized", String::new())
            } else if head.starts_with("get /api/info ") {
                ("200 OK", json!({"version": version, "pid": pid, "urls": []}).to_string())
            } else if head.starts_with("get /openapi.json ") {
                ("200 OK", openapi.clone())
            } else if head.starts_with("post /api/location/reload ") {
                reload_counter.fetch_add(1, Ordering::SeqCst);
                ("200 OK", json!({"ok": true}).to_string())
            } else {
                ("404 Not Found", String::new())
            };
            let reply = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    });
    FakeDaemon { url, reloads }
}

fn write_fake_cli(dir: &Path, name: &str, version: &str) -> String {
    #[cfg(windows)]
    {
        let script = dir.join(format!("{name}.cmd"));
        fs::write(
            &script,
            format!(
                "@echo off\r\n\
                 if \"%1\"==\"--version\" (echo {version}& exit /b 0)\r\n\
                 if \"%1 %2\"==\"service stop\" ((echo stop)>>\"%~dp0stop.log\" & (echo stopped)>\"%~dp0status.txt\" & exit /b 0)\r\n\
                 if \"%1 %2\"==\"service status\" (type \"%~dp0status.txt\" & exit /b 0)\r\n\
                 if \"%1 %2 %3\"==\"service get password\" (type \"%~dp0password.txt\" & exit /b 0)\r\n\
                 if \"%1 %2\"==\"service start\" ((echo start)>>\"%~dp0start.log\" & copy /y \"%~dp0start.txt\" \"%~dp0status.txt\" >nul & type \"%~dp0start.txt\" & exit /b 0)\r\n\
                 if \"%1 %2 %3\"==\"debug paths state\" (echo %~dp0state& exit /b 0)\r\n\
                 if \"%1 %2 %3\"==\"debug paths config\" (echo %~dp0config& exit /b 0)\r\n\
                 exit /b 3\r\n"
            ),
        )
        .unwrap();
        script.to_string_lossy().into_owned()
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        let d = dir.display();
        fs::write(
            &script,
            format!(
                "#!/bin/sh\ncase \"$*\" in\n\
                 '--version') echo '{version}';;\n\
                 'service stop') echo stop >> '{d}/stop.log'; echo stopped > '{d}/status.txt';;\n\
                 'service status') cat '{d}/status.txt';;\n\
                 'service get password') cat '{d}/password.txt';;\n\
                 'service start') echo start >> '{d}/start.log'; cp '{d}/start.txt' '{d}/status.txt'; cat '{d}/start.txt';;\n\
                 'debug paths state') echo '{d}/state';;\n\
                 'debug paths config') echo '{d}/config';;\n\
                 *) exit 3;;\nesac\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    }
}

fn test_app(dir: &Path, binary: &str) -> (Arc<App>, Router) {
    let config_path = dir.join("config.yaml");
    fs::write(&config_path, format!("server:\n  opencodeBinary: {}\n", serde_json::to_string(binary).unwrap()))
        .unwrap();
    let settings = settings::Settings::new(settings::document::Location::resolve(config_path.to_str().unwrap()));
    let auth = auth::Auth::new(auth::Settings {
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
    let native = opencode::Native::connect(binary).unwrap();
    let app = Arc::new(App::new(
        auth,
        0,
        dir.to_path_buf(),
        dir.to_path_buf(),
        false,
        settings,
        json!({"serverVersion": "0.10.0"}),
        native,
        PathBuf::from(binary),
        None,
        files::watch::Watches::new(tx),
        None,
    ));
    let router = Router::new()
        .merge(opencode::routes())
        .merge(opencode::install::routes())
        .merge(settings::routes())
        .merge(meta::routes())
        .with_state(app.clone());
    (app, router)
}

async fn start_server(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (base, task)
}

async fn send_json(base: &str, method: Method, uri: &str, body: Option<Value>) -> (Status, Value) {
    let client = Client::builder().no_proxy().build().unwrap();
    let mut req = client.request(method, format!("{base}{uri}"));
    if let Some(value) = body {
        req = req.header("content-type", "application/json").body(value.to_string());
    }
    let response = req.send().await.unwrap();
    let status = Status::from_u16(response.status().as_u16()).unwrap();
    let bytes = response.bytes().await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn service_route_starts_restarts_reloads_validates_and_coalesces() {
    let dir = scratch("service-route");
    let first = spawn_daemon("2.5.0", 101, true).await;
    let second = spawn_daemon("2.5.0", 202, true).await;
    let no_reload = spawn_daemon("2.5.0", 303, false).await;
    let cli = write_fake_cli(&dir, "opencode-svc", "2.5.0");
    fs::write(dir.join("config").join("service.json"), r#"{"password":"secret"}"#).unwrap();
    fs::write(dir.join("password.txt"), "secret\n").unwrap();
    fs::write(dir.join("status.txt"), "stopped\n").unwrap();
    fs::write(dir.join("start.txt"), format!("{}\n", first.url)).unwrap();
    let (app, router) = test_app(&dir, &cli);
    let (base, server) = start_server(router).await;

    // Invalid payloads -> 400 invalid_service_action.
    for bad in [
        json!({"restart": true, "reload": true}),
        json!({"extra": true}),
        json!({"restart": "yes"}),
        json!(["restart"]),
    ] {
        let (status, body) = send_json(&base, Method::POST, "/api/opencode/service", Some(bad)).await;
        assert_eq!(status, Status::BAD_REQUEST);
        assert_eq!(body, json!({"error": "invalid_service_action"}));
    }

    // Empty body starts the stopped daemon and exposes real canRestart & canReload.
    let (status, body) = send_json(&base, Method::POST, "/api/opencode/service", None).await;
    assert_eq!(status, Status::OK);
    assert_eq!(body["serviceState"], "ready");
    assert_eq!(body["canRestart"], true);
    assert_eq!(body["canReload"], true);
    assert_eq!(body["daemonVersion"], "2.5.0");
    assert_eq!(app.native.endpoint().unwrap().pid, 101);

    // Explicit reload calls POST /api/location/reload without stopping the daemon.
    let (status, body) = send_json(&base, Method::POST, "/api/opencode/service", Some(json!({"reload": true}))).await;
    assert_eq!(status, Status::OK);
    assert_eq!(body["serviceState"], "ready");
    assert_eq!(first.reloads.load(Ordering::SeqCst), 1);
    assert!(!dir.join("stop.log").exists());

    // Explicit restart stops and reconnects to the restarted daemon.
    fs::write(dir.join("start.txt"), format!("{}\n", second.url)).unwrap();
    let (status, body) = send_json(&base, Method::POST, "/api/opencode/service", Some(json!({"restart": true}))).await;
    assert_eq!(status, Status::OK);
    assert_eq!(body["serviceState"], "ready");
    assert_eq!(body["canRestart"], true);
    assert_eq!(fs::read_to_string(dir.join("stop.log")).unwrap().lines().count(), 1);
    assert_eq!(app.native.endpoint().unwrap().pid, 202);

    // Daemon without /api/location/reload reports canReload: false and refuses reload with 502.
    fs::write(dir.join("status.txt"), format!("{}\n", no_reload.url)).unwrap();
    let (status, body) = send_json(&base, Method::GET, "/api/opencode/update", None).await;
    assert_eq!(status, Status::OK);
    assert_eq!(body["canReload"], false);
    assert_eq!(body["canRestart"], true);
    let (status, body) = send_json(&base, Method::POST, "/api/opencode/service", Some(json!({"reload": true}))).await;
    assert_eq!(status, Status::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "service_activation_failed"}));

    // Downgrade refusal: CLI 2.4.2 cannot restart a running 2.5.0 daemon.
    let older_cli = write_fake_cli(&dir, "opencode-old", "2.4.2");
    let (status, _) =
        send_json(&base, Method::PATCH, "/api/storage/config/server", Some(json!({"opencodeBinary": older_cli}))).await;
    assert_eq!(status, Status::OK);
    let (status, body) = send_json(&base, Method::GET, "/api/opencode/update", None).await;
    assert_eq!(status, Status::OK);
    assert_eq!(body["canRestart"], false);
    let (status, body) = send_json(&base, Method::POST, "/api/opencode/service", Some(json!({"restart": true}))).await;
    assert_eq!(status, Status::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "service_activation_failed"}));
    assert_eq!(fs::read_to_string(dir.join("stop.log")).unwrap().lines().count(), 1);

    server.abort();
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn server_config_patch_hot_adopts_opencode_binary_without_restarting_daemon() {
    let dir_a = scratch("hot-adopt-a");
    let dir_b = scratch("hot-adopt-b");
    let daemon_a = spawn_daemon("2.5.0", 11, true).await;
    let daemon_b = spawn_daemon("2.5.0", 22, true).await;
    let cli_a = write_fake_cli(&dir_a, "opencode-a", "2.5.0");
    let cli_b = write_fake_cli(&dir_b, "opencode-b", "2.5.0");
    for (dir, daemon) in [(&dir_a, &daemon_a), (&dir_b, &daemon_b)] {
        fs::write(dir.join("password.txt"), "secret\n").unwrap();
        fs::write(dir.join("status.txt"), format!("{}\n", daemon.url)).unwrap();
        fs::write(dir.join("start.txt"), format!("{}\n", daemon.url)).unwrap();
    }
    let (app, router) = test_app(&dir_a, &cli_a);
    let (base, server) = start_server(router).await;
    let ep_a = app.native.acquire(tokio::time::Instant::now() + opencode::daemon::TIMEOUT).await.unwrap();
    assert_eq!(ep_a.pid, 11);

    let (status, _) =
        send_json(&base, Method::PATCH, "/api/storage/config/server", Some(json!({"opencodeBinary": cli_b}))).await;
    assert_eq!(status, Status::OK);
    assert_eq!(app.native.binary().as_deref(), Some(cli_b.as_str()));
    assert_eq!(app.current_binary(), PathBuf::from(&cli_b));
    assert!(!dir_a.join("stop.log").exists(), "PATCH must never implicitly stop or restart the daemon");
    assert!(!dir_b.join("stop.log").exists());

    // Next acquire uses the newly adopted binary immediately.
    let ep_b = app.native.acquire(tokio::time::Instant::now() + opencode::daemon::TIMEOUT).await.unwrap();
    assert_eq!(ep_b.pid, 22);

    server.abort();
    let _ = fs::remove_dir_all(dir_a);
    let _ = fs::remove_dir_all(dir_b);
}

#[tokio::test]
async fn meta_exposes_latest_stable_server_version_on_stable_feed() {
    let dir = scratch("meta-stable");
    let cli = write_fake_cli(&dir, "opencode-meta", "2.5.0");
    let config_path = dir.join("config.yaml");
    fs::write(&config_path, "server:\n  updateFeed: stable\n").unwrap();
    let settings = settings::Settings::new(settings::document::Location::resolve(config_path.to_str().unwrap()));
    let auth = auth::Auth::new(auth::Settings {
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
    let native = opencode::Native::connect(&cli).unwrap();
    let app = Arc::new(App::new(
        auth,
        0,
        dir.clone(),
        dir.clone(),
        false,
        settings,
        json!({"serverVersion": "0.10.0"}),
        native,
        PathBuf::from(&cli),
        None,
        files::watch::Watches::new(tx),
        None,
    ));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port());
    let hits = Arc::new(AtomicUsize::new(0));
    let hit_counter = hits.clone();
    let latest_payload = json!({
        "tag_name": "v2.5.0",
        "prerelease": false,
        "draft": false,
        "published_at": "2026-11-24T00:00:00Z",
        "html_url": "https://example.invalid/v2.5.0"
    })
    .to_string();
    // Simulate a repository whose first 30 releases are all prereleases; `/releases/latest` still resolves v2.5.0.
    let list_payload = json!([
        {"tag_name": "v9.9.9-dev.1", "prerelease": true, "draft": false, "published_at": "2026-11-25T00:00:00Z"}
    ])
    .to_string();
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 2048];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            hit_counter.fetch_add(1, Ordering::SeqCst);
            let body = if head.contains("/releases/latest ") { &latest_payload } else { &list_payload };
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    });

    let shutdown = CancellationToken::new();
    let monitor = tokio::spawn(meta::releases::run_with_base(
        app.clone(),
        shutdown.clone(),
        reqwest::Url::parse(&origin).unwrap(),
        "NeuralNomadsAI/CodeNomad".into(),
    ));
    let router = meta::routes().with_state(app.clone());
    let (base, api_server) = start_server(router).await;
    let mut latest = None;
    for _ in 0..40 {
        let (status, body) = send_json(&base, Method::GET, "/api/meta", None).await;
        assert_eq!(status, Status::OK);
        assert_eq!(body["updateFeed"], "stable");
        assert_eq!(body["update"], Value::Null);
        if body["support"]["latestServerVersion"].is_string() {
            latest = Some(body);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let meta = latest.expect("support.latestServerVersion must populate on stable feed");
    assert_eq!(meta["support"]["supported"], true);
    assert_eq!(meta["support"]["latestServerVersion"], "2.5.0");
    assert_eq!(meta["support"]["latestServerUrl"], "https://example.invalid/v2.5.0");
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    shutdown.cancel();
    let _ = monitor.await;
    api_server.abort();
    server.abort();
    let _ = fs::remove_dir_all(dir);

    // Switching preview -> stable while the initial preview lookup is in flight must not
    // trigger an extra /releases/latest request, must keep update == null, and must still
    // populate support.latestServerVersion once the in-flight response arrives.
    let dir = scratch("meta-preview-to-stable");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port());
    let latest_hits = Arc::new(AtomicUsize::new(0));
    let latest_hits_srv = latest_hits.clone();
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<()>();
    let seen_tx = Arc::new(std::sync::Mutex::new(Some(seen_tx)));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let latest_hits_srv = latest_hits_srv.clone();
            let seen_tx = seen_tx.clone();
            let release_rx = release_rx.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let first = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_owned();
                let (status, body) = if first.starts_with("GET /repos/NeuralNomadsAI/CodeNomad/releases?per_page=30 ") {
                    if let Some(tx) = seen_tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    if let Some(rx) = release_rx.lock().await.take() {
                        let _ = rx.await;
                    }
                    (
                        "200 OK",
                        json!([
                            {
                                "tag_name": "v9.2.0-dev-1",
                                "prerelease": true,
                                "draft": false,
                                "published_at": "2026-06-02T00:00:00Z",
                                "assets": [{"name": "latest.json"}],
                                "html_url": "https://example.invalid/v9.2.0-dev-1"
                            },
                            {
                                "tag_name": "v2.6.0",
                                "prerelease": false,
                                "draft": false,
                                "published_at": "2026-06-01T00:00:00Z",
                                "assets": [{"name": "latest.json"}],
                                "html_url": "https://example.invalid/v2.6.0"
                            }
                        ])
                        .to_string(),
                    )
                } else if first.starts_with("GET /repos/NeuralNomadsAI/CodeNomad/releases/latest ") {
                    latest_hits_srv.fetch_add(1, Ordering::SeqCst);
                    ("404 Not Found", "{}".into())
                } else {
                    ("404 Not Found", "{}".into())
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    let (app, _) = test_app(&dir, "opencode");
    app.releases.set_feed("preview");
    assert_eq!(app.releases.snapshot().0, "preview");
    let shutdown = CancellationToken::new();
    let monitor = tokio::spawn(meta::releases::run_with_base(
        app.clone(),
        shutdown.clone(),
        reqwest::Url::parse(&origin).unwrap(),
        "NeuralNomadsAI/CodeNomad".into(),
    ));
    tokio::time::timeout(Duration::from_secs(5), seen_rx).await.unwrap().unwrap();
    app.releases.set_feed("stable");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(latest_hits.load(Ordering::SeqCst), 0, "preview->stable switch must not fire /releases/latest");
    let _ = release_tx.send(());
    let router = meta::routes().with_state(app.clone());
    let (base, api_server) = start_server(router).await;
    let mut populated = None;
    for _ in 0..40 {
        let (status, body) = send_json(&base, Method::GET, "/api/meta", None).await;
        assert_eq!(status, Status::OK);
        assert_eq!(body["updateFeed"], "stable");
        assert_eq!(body["update"], Value::Null);
        if body["support"]["latestServerVersion"] == "2.6.0" {
            populated = Some(body);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let meta = populated.expect("in-flight preview lookup must still populate latestServerVersion after switch");
    assert_eq!(meta["support"]["latestServerUrl"], "https://example.invalid/v2.6.0");
    assert_eq!(latest_hits.load(Ordering::SeqCst), 0);

    shutdown.cancel();
    let _ = monitor.await;
    api_server.abort();
    server.abort();
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn service_route_coalesces_identical_actions_and_rejects_conflicting_concurrent_actions() {
    let dir = scratch("service-coalesce");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let reloads = Arc::new(AtomicUsize::new(0));
    let reload_counter = reloads.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let entered_tx = Arc::new(std::sync::Mutex::new(Some(entered_tx)));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
    let auth =
        format!("basic {}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "opencode:secret"));
    let body = |field: &str| json!({"requestBody": {"content": {"application/json": {"schema": {"properties": {field: {}}}}}}});
    let openapi = json!({
        "paths": {
            "/api/session/{sessionID}": {"patch": {}},
            "/api/form": {"get": {}},
            "/api/session/{sessionID}/form/{formID}": {"delete": {}},
            "/api/experimental/session/{sessionID}/wait": {"post": {}},
            "/api/session/{sessionID}/fork": {"post": body("before")},
            "/api/session/{sessionID}/command": {"post": body("name")},
            "/api/session/{sessionID}/permission/{requestID}/reply": {"post": body("decision")},
            "/api/session/{sessionID}/environment": {"put": {"requestBody": {"content": {"application/json":
                {"schema": {"$ref": "#/components/schemas/Env"}}}}}},
            "/api/location/reload": {"post": {}},
        },
        "components": {"schemas": {
            "Env": {"properties": {"variables": {}}},
            "Session.Inbox.User": {"properties": {"time": {}}},
            "Session.Message.Assistant.Text": {"properties": {"native": {}}},
            "Session.Message.Compaction.Completed": {"properties": {"metadata": {}}},
        }},
    })
    .to_string();

    let daemon = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let auth = auth.clone();
            let openapi = openapi.clone();
            let reload_counter = reload_counter.clone();
            let entered_tx = entered_tx.clone();
            let release_rx = release_rx.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && socket.read(&mut byte).await.is_ok_and(|n| n == 1) {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
                let (status, body) = if !head.contains(&auth.to_ascii_lowercase()) {
                    ("401 Unauthorized", String::new())
                } else if head.starts_with("get /api/info ") {
                    ("200 OK", json!({"version": "2.5.0", "pid": 555, "urls": []}).to_string())
                } else if head.starts_with("get /openapi.json ") {
                    ("200 OK", openapi)
                } else if head.starts_with("post /api/location/reload ") {
                    reload_counter.fetch_add(1, Ordering::SeqCst);
                    if let Some(tx) = entered_tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    let rx = release_rx.lock().await.take();
                    if let Some(rx) = rx {
                        let _ = rx.await;
                    }
                    ("200 OK", json!({"ok": true}).to_string())
                } else {
                    ("404 Not Found", String::new())
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });

    let cli = write_fake_cli(&dir, "opencode-coal", "2.5.0");
    fs::write(dir.join("password.txt"), "secret\n").unwrap();
    fs::write(dir.join("status.txt"), format!("{url}\n")).unwrap();
    fs::write(dir.join("start.txt"), format!("{url}\n")).unwrap();
    let (app, router) = test_app(&dir, &cli);
    let (base, server) = start_server(router).await;

    let b1 = base.clone();
    let first_reload = tokio::spawn(async move {
        send_json(&b1, Method::POST, "/api/opencode/service", Some(json!({"reload": true}))).await
    });
    tokio::time::timeout(Duration::from_secs(20), entered_rx).await.unwrap().unwrap();

    // Same action joins the in-flight reload; conflicting action fails immediately with 502.
    let b2 = base.clone();
    let second_reload = tokio::spawn(async move {
        send_json(&b2, Method::POST, "/api/opencode/service", Some(json!({"reload": true}))).await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while app.service_activation.coalesced_count() == 0 {
        assert!(tokio::time::Instant::now() < deadline, "second reload never joined active flight");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (conflict_status, conflict_body) =
        send_json(&base, Method::POST, "/api/opencode/service", Some(json!({"restart": true}))).await;
    assert_eq!(conflict_status, Status::BAD_GATEWAY);
    assert_eq!(conflict_body, json!({"error": "service_activation_failed"}));

    let _ = release_tx.send(());
    let (s1, b1) = first_reload.await.unwrap();
    let (s2, b2) = second_reload.await.unwrap();
    assert_eq!(s1, Status::OK);
    assert_eq!(s2, Status::OK);
    assert_eq!(b1["serviceState"], "ready");
    assert_eq!(b2["serviceState"], "ready");
    assert_eq!(reloads.load(Ordering::SeqCst), 1);

    server.abort();
    daemon.abort();
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn service_and_update_enforce_fastify_1mib_limit_reject_3xx_reload_and_honor_pinned_binary() {
    let dir = scratch("service-guards");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let auth =
        format!("basic {}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "opencode:secret"));
    let body = |field: &str| json!({"requestBody": {"content": {"application/json": {"schema": {"properties": {field: {}}}}}}});
    let openapi = json!({
        "paths": {
            "/api/session/{sessionID}": {"patch": {}},
            "/api/form": {"get": {}},
            "/api/session/{sessionID}/form/{formID}": {"delete": {}},
            "/api/experimental/session/{sessionID}/wait": {"post": {}},
            "/api/session/{sessionID}/fork": {"post": body("before")},
            "/api/session/{sessionID}/command": {"post": body("name")},
            "/api/session/{sessionID}/permission/{requestID}/reply": {"post": body("decision")},
            "/api/session/{sessionID}/environment": {"put": {"requestBody": {"content": {"application/json":
                {"schema": {"$ref": "#/components/schemas/Env"}}}}}},
            "/api/location/reload": {"post": {}},
        },
        "components": {"schemas": {
            "Env": {"properties": {"variables": {}}},
            "Session.Inbox.User": {"properties": {"time": {}}},
            "Session.Message.Assistant.Text": {"properties": {"native": {}}},
            "Session.Message.Compaction.Completed": {"properties": {"metadata": {}}},
        }},
    })
    .to_string();
    let daemon = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && socket.read(&mut byte).await.is_ok_and(|n| n == 1) {
                head.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
            let reply = if !head.contains(&auth.to_ascii_lowercase()) {
                "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned()
            } else if head.starts_with("get /api/info ") {
                let body = json!({"version": "2.5.0", "pid": 888, "urls": []}).to_string();
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else if head.starts_with("get /openapi.json ") {
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{openapi}",
                    openapi.len()
                )
            } else if head.starts_with("post /api/location/reload ") {
                "HTTP/1.1 302 Found\r\nlocation: /elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    .to_owned()
            } else {
                "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned()
            };
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    });

    let pinned_cli = write_fake_cli(&dir, "opencode-pinned", "2.5.0");
    let other_cli = write_fake_cli(&dir, "opencode-other", "2.4.2");
    fs::write(dir.join("password.txt"), "secret\n").unwrap();
    fs::write(dir.join("status.txt"), format!("{redirect_url}\n")).unwrap();
    let (app, router) = test_app(&dir, &pinned_cli);
    app.native.pin_binary();
    let (base, server) = start_server(router).await;

    // 1. Unsupported media type rejects with 415 BEFORE 413 even above 1 MiB, matching Fastify order.
    let huge = format!("{{{}}}", " ".repeat(1024 * 1024 + 16));
    let client = Client::builder().no_proxy().build().unwrap();
    for route in ["/api/opencode/service", "/api/opencode/update"] {
        let resp_415 = client
            .post(format!("{base}{route}"))
            .header("content-type", "application/octet-stream")
            .body(huge.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(resp_415.status().as_u16(), 415, "{route} octet-stream >1 MiB");
        let body_415: Value = resp_415.json().await.unwrap();
        assert_eq!(body_415["code"], "FST_ERR_CTP_INVALID_MEDIA_TYPE", "{route}");

        let resp = client
            .post(format!("{base}{route}"))
            .header("content-type", "application/json")
            .body(huge.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 413, "{route}");
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["code"], "FST_ERR_CTP_BODY_TOO_LARGE", "{route}");

        // Empty chunked body without Content-Type must also return 415 per Fastify framing rules.
        let addr = base.trim_start_matches("http://");
        let mut raw = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req_bytes = format!(
            "POST {route} HTTP/1.1\r\nHost: {addr}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n"
        );
        raw.write_all(req_bytes.as_bytes()).await.unwrap();
        let mut raw_resp = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut raw, &mut raw_resp).await.unwrap();
        assert!(raw_resp.starts_with("HTTP/1.1 415 "), "{route} empty chunked without content-type: {raw_resp}");
        assert!(raw_resp.contains("FST_ERR_CTP_INVALID_MEDIA_TYPE"), "{route}: {raw_resp}");
    }

    // 2. 302 redirect on /api/location/reload fails activation with 502.
    let (status, body) = send_json(&base, Method::POST, "/api/opencode/service", Some(json!({"reload": true}))).await;
    assert_eq!(status, Status::BAD_GATEWAY);
    assert_eq!(body, json!({"error": "service_activation_failed"}));

    // 3. Pinned binary stays authoritative even when settings pick a different opencodeBinary.
    let (status, _) =
        send_json(&base, Method::PATCH, "/api/storage/config/server", Some(json!({"opencodeBinary": other_cli}))).await;
    assert_eq!(status, Status::OK);
    let (status, body) = send_json(&base, Method::GET, "/api/opencode/update", None).await;
    assert_eq!(status, Status::OK);
    assert_eq!(body["binaryPath"], pinned_cli);
    assert_eq!(body["currentVersion"], "2.5.0");

    server.abort();
    daemon.abort();
    let _ = fs::remove_dir_all(dir);
}
