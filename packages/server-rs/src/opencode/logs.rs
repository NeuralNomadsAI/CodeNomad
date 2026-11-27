//! `GET /api/opencode/logs`: bounded snapshot of the selected host OpenCode log (`opencode/logs.ts`,
//! `server/routes/opencode-logs.ts`).
use std::{
    future::Future,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::Duration,
};

use axum::{
    Json,
    extract::State,
    http::{StatusCode as Status, Uri, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::{daemon, install, launch};
use crate::Shared;

pub(crate) const OPENCODE_LOG_BYTES: usize = 128 * 1024;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);

enum LogError {
    Missing,
    Failed,
}

fn reply(status: Status, body: Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

async fn selection_with<F, Fut>(app: &crate::App, resolve_default: F) -> String
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = String>,
{
    if let Some(binary) = launch::custom_binary(&app.settings) {
        return binary;
    }
    let resolved = resolve_default().await;
    // Re-read configured `opencodeBinary` after async default resolution so a concurrent
    // settings update is never shadowed by a stale resolved default.
    launch::custom_binary(&app.settings).unwrap_or(resolved)
}

async fn selection(app: &crate::App) -> String {
    selection_with(app, || async { launch::resolve(&install::plan::resolve_default().await.0) }).await
}

async fn discover_directory(binary: &str) -> Result<String, LogError> {
    if launch::wsl(binary) {
        return Err(LogError::Failed);
    }
    let spec = launch::spec(binary, &["debug", "paths", "log"]).map_err(|_| LogError::Failed)?;
    let output = daemon::execute(&spec, None, DISCOVERY_TIMEOUT).await.map_err(|err| {
        if err.code.is_none() && err.detail.starts_with("code ENOENT:") { LogError::Missing } else { LogError::Failed }
    })?;
    Ok(output.stdout.trim().to_owned())
}

fn read_log_file_blocking(file_path: &Path) -> Result<Value, LogError> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Never block a worker thread on a FIFO or acquire a controlling terminal on a TTY.
        opts.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let mut file = opts.open(file_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound { LogError::Missing } else { LogError::Failed }
    })?;
    let meta = file.metadata().map_err(|_| LogError::Failed)?;
    if !meta.is_file() {
        return Err(LogError::Failed);
    }
    let size = meta.len();
    let limit = OPENCODE_LOG_BYTES as u64;
    let start = size.saturating_sub(limit);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).map_err(|_| LogError::Failed)?;
    }
    let mut buf = Vec::with_capacity(size.min(limit) as usize);
    file.take(limit).read_to_end(&mut buf).map_err(|_| LogError::Failed)?;
    let mut offset = 0usize;
    if start > 0 {
        if let Some(newline) = buf.iter().position(|&b| b == b'\n') {
            offset = newline + 1;
        } else {
            while offset < buf.len() && (buf[offset] & 0xc0) == 0x80 {
                offset += 1;
            }
        }
    }
    let text = String::from_utf8_lossy(&buf[offset..]).into_owned();
    Ok(json!({
        "path": file_path.to_string_lossy(),
        "text": text,
        "truncated": start > 0,
    }))
}

async fn read_log_file(directory: &str) -> Result<Value, LogError> {
    let dir = Path::new(directory);
    if !dir.is_absolute() || directory.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(LogError::Failed);
    }
    let file_path = dir.join("opencode.log");
    tokio::task::spawn_blocking(move || read_log_file_blocking(&file_path)).await.map_err(|_| LogError::Failed)?
}

async fn read_with<F, Fut>(app: &crate::App, uri: &Uri, discover: F) -> Response
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<String, LogError>>,
{
    if uri.query().is_some_and(|q| !q.is_empty()) {
        return reply(Status::BAD_REQUEST, json!({"error": "invalid_logs_request"}));
    }
    let binary = selection(app).await;
    let directory = match discover(binary.clone()).await {
        Ok(directory) => directory,
        Err(LogError::Missing) => return reply(Status::NOT_FOUND, json!({"error": "opencode_logs_missing"})),
        Err(LogError::Failed) => return reply(Status::BAD_GATEWAY, json!({"error": "opencode_logs_failed"})),
    };
    let result = match read_log_file(&directory).await {
        Ok(result) => result,
        Err(LogError::Missing) => return reply(Status::NOT_FOUND, json!({"error": "opencode_logs_missing"})),
        Err(LogError::Failed) => return reply(Status::BAD_GATEWAY, json!({"error": "opencode_logs_failed"})),
    };
    if binary != selection(app).await {
        return reply(Status::CONFLICT, json!({"error": "logs_source_changed"}));
    }
    reply(Status::OK, result)
}

pub(super) async fn read(State(app): State<Shared>, uri: Uri) -> Response {
    read_with(&app, &uri, |binary| async move { discover_directory(&binary).await }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cn-opencode-logs-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn reads_bounded_tail_and_skips_partial_first_line() {
        let dir = temp_dir("tail");
        let file = dir.join("opencode.log");
        let mut content = String::from("head-line\n");
        while content.len() <= OPENCODE_LOG_BYTES + 256 {
            content.push_str("0123456789abcdef\n");
        }
        content.push_str("final-tail-line\n");
        std::fs::write(&file, &content).unwrap();

        let body = read_log_file(dir.to_str().unwrap()).await.ok().unwrap();
        assert_eq!(body["truncated"], true);
        let text = body["text"].as_str().unwrap();
        assert!(text.len() <= OPENCODE_LOG_BYTES);
        assert!(text.ends_with("final-tail-line\n"));
        assert!(text.starts_with("0123456789abcdef\n"));
        assert!(!text.contains("head-line"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_file_and_invalid_directory_fail_cleanly() {
        let dir = temp_dir("missing");
        assert!(matches!(read_log_file(dir.to_str().unwrap()).await, Err(LogError::Missing)));
        assert!(matches!(read_log_file("relative/path").await, Err(LogError::Failed)));
        assert!(matches!(read_log_file(&format!("{}\n", dir.to_str().unwrap())).await, Err(LogError::Failed)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn route_enforces_query_no_store_and_binary_change() {
        let dir = temp_dir("route");
        std::fs::write(dir.join("opencode.log"), "hello log\n").unwrap();
        let data = temp_dir("data");
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
            data.join("config.yaml").to_str().unwrap(),
        ));
        let app = crate::App::new(
            auth,
            0,
            data.clone(),
            dir.clone(),
            true,
            settings,
            json!({}),
            crate::opencode::Native::test_connection("127.0.0.1:0".parse().unwrap()),
            "opencode2".into(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        );

        let bad_uri: Uri = "/api/opencode/logs?file=foo".parse().unwrap();
        let bad = read_with(&app, &bad_uri, |_| async { Ok(dir.to_string_lossy().into_owned()) }).await;
        assert_eq!(bad.status(), Status::BAD_REQUEST);
        assert_eq!(bad.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");

        let ok_uri: Uri = "/api/opencode/logs".parse().unwrap();
        let ok = read_with(&app, &ok_uri, |_| async { Ok(dir.to_string_lossy().into_owned()) }).await;
        assert_eq!(ok.status(), Status::OK);
        assert_eq!(ok.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
        let bytes = to_bytes(ok.into_body(), 64 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["text"], "hello log\n");
        assert_eq!(body["truncated"], false);

        // Changing opencodeBinary while logs are being read yields 409 logs_source_changed.
        let changed = read_with(&app, &ok_uri, |_| async {
            let _ = app.settings.patch(
                crate::settings::Kind::Config,
                "server",
                &json!({"opencodeBinary": "/other/opencode2"}),
            );
            Ok(dir.to_string_lossy().into_owned())
        })
        .await;
        assert_eq!(changed.status(), Status::CONFLICT);
        let bytes = to_bytes(changed.into_body(), 4096).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "logs_source_changed");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn selection_re_reads_custom_binary_after_default_resolution() {
        let data = temp_dir("selection-race");
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
            data.join("config.yaml").to_str().unwrap(),
        ));
        let app = crate::App::new(
            auth,
            0,
            data.clone(),
            data.clone(),
            true,
            settings,
            json!({}),
            crate::opencode::Native::test_connection("127.0.0.1:0".parse().unwrap()),
            "opencode2".into(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        );

        let selected = selection_with(&app, || async {
            let _ = app.settings.patch(
                crate::settings::Kind::Config,
                "server",
                &json!({"opencodeBinary": "/custom/updated-opencode"}),
            );
            "/stale/default-opencode".to_owned()
        })
        .await;
        assert_eq!(selected, "/custom/updated-opencode");

        let _ = std::fs::remove_dir_all(&data);
    }

    #[tokio::test]
    async fn missing_executable_maps_to_not_found() {
        let dir = temp_dir("missing-bin");
        let missing = dir.join("definitely-missing-opencode-binary");
        assert!(matches!(discover_directory(missing.to_str().unwrap()).await, Err(LogError::Missing)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn non_regular_log_entry_fails_cleanly() {
        let dir = temp_dir("non-regular");
        std::fs::create_dir_all(dir.join("opencode.log")).unwrap();
        assert!(matches!(read_log_file(dir.to_str().unwrap()).await, Err(LogError::Failed)));
        let _ = std::fs::remove_dir_all(&dir);

        #[cfg(unix)]
        {
            use std::ffi::CString;
            let fifo_dir = temp_dir("fifo");
            let fifo = fifo_dir.join("opencode.log");
            let c_path = CString::new(fifo.to_str().unwrap()).unwrap();
            let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
            assert_eq!(rc, 0, "mkfifo failed");
            let result = tokio::time::timeout(Duration::from_secs(2), read_log_file(fifo_dir.to_str().unwrap()))
                .await
                .expect("FIFO open must not block a worker thread");
            assert!(matches!(result, Err(LogError::Failed)));
            let _ = std::fs::remove_dir_all(&fifo_dir);
        }
    }

    #[tokio::test]
    async fn router_admits_local_logs_and_refuses_remote_before_discovery() {
        use axum::{Extension, Router, middleware::from_fn_with_state};
        use std::sync::Arc;
        use tokio_util::sync::CancellationToken;

        let dir = temp_dir("router");
        let logs_dir = dir.join("private-logs");
        let data = dir.join("data");
        std::fs::create_dir_all(&logs_dir).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let log_file = logs_dir.join("opencode.log");
        let marker = logs_dir.join("invoked");
        let sentinel = "secret-local-log-line\n";
        std::fs::write(&log_file, sentinel).unwrap();

        #[cfg(windows)]
        let binary = {
            let path = logs_dir.join("fake-opencode.cmd");
            std::fs::write(
                &path,
                format!("@echo off\r\necho hit>>\"{}\"\r\necho {}\r\n", marker.display(), logs_dir.display()),
            )
            .unwrap();
            path
        };
        #[cfg(not(windows))]
        let binary = {
            use std::os::unix::fs::PermissionsExt;
            let path = logs_dir.join("fake-opencode");
            let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"));
            std::fs::write(
                &path,
                format!("#!/bin/sh\nprintf 'hit\\n' >> {}\nprintf '%s\\n' {}\n", q(&marker), q(&logs_dir)),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path
        };

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
            data.join("config.yaml").to_str().unwrap(),
        ));
        settings
            .patch(crate::settings::Kind::Config, "server", &json!({"opencodeBinary": binary.to_string_lossy()}))
            .ok()
            .unwrap();
        let remote_origin = "https://10.0.0.5:9898";
        let devices =
            crate::auth::devices::open_for_test(&data, remote_origin.to_owned(), vec![remote_origin.to_owned()]);
        let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = local_listener.local_addr().unwrap();
        let app = Arc::new(crate::App::new(
            auth,
            local_addr.port(),
            data.clone(),
            dir.clone(),
            true,
            settings,
            json!({}),
            crate::opencode::Native::test_connection("127.0.0.1:0".parse().unwrap()),
            binary.clone(),
            Some(devices),
            crate::files::watch::Watches::new(tx),
            None,
        ));

        // 1. Remote router: authenticated paired device is refused BEFORE binary discovery.
        let issued = crate::auth::devices::issue(
            State(app.clone()),
            axum::body::Bytes::from(format!(r#"{{"origin":"{remote_origin}"}}"#)),
        )
        .await;
        assert_eq!(issued.status(), Status::OK);
        let link: Value = serde_json::from_slice(&to_bytes(issued.into_body(), 4096).await.unwrap()).unwrap();
        let code = link["url"].as_str().unwrap().strip_prefix(&format!("{remote_origin}/remote-pair#")).unwrap();

        let channel = crate::auth::tls::Channel {
            origin: remote_origin.to_owned(),
            origins: Arc::from(vec![remote_origin.to_owned()]),
            ingress: false,
            socket: CancellationToken::new(),
            principal: Arc::new(std::sync::Mutex::new(None)),
        };
        let remote_router = Router::new()
            .merge(crate::opencode::routes())
            .merge(crate::auth::remote_routes())
            .layer(from_fn_with_state((app.clone(), None), crate::auth::remote::admit))
            .layer(Extension(channel))
            .with_state(app.clone());
        let remote_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_addr = remote_listener.local_addr().unwrap();
        let remote_task = tokio::spawn(async move { axum::serve(remote_listener, remote_router).await.unwrap() });

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let paired = client
            .post(format!("http://{remote_addr}/api/remote-control/pair"))
            .header(header::HOST, "10.0.0.5:9898")
            .header(header::ORIGIN, remote_origin)
            .json(&json!({"code": code}))
            .send()
            .await
            .unwrap();
        assert_eq!(paired.status(), Status::OK);
        let cookie = paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();

        let remote_res = client
            .get(format!("http://{remote_addr}/api/opencode/logs"))
            .header(header::HOST, "10.0.0.5:9898")
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert!(matches!(remote_res.status(), Status::FORBIDDEN | Status::NOT_FOUND), "status {}", remote_res.status());
        let remote_body = remote_res.text().await.unwrap();
        assert!(!remote_body.contains("secret-local-log-line"));
        assert!(!marker.exists(), "remote request must be refused before spawning discovery");

        // 2. Local router: admits GET /api/opencode/logs and returns the host log with Cache-Control: no-store.
        let local_router = Router::new()
            .merge(crate::opencode::routes())
            .layer(from_fn_with_state(app.clone(), crate::auth::admit))
            .with_state(app.clone());
        let local_task = tokio::spawn(async move { axum::serve(local_listener, local_router).await.unwrap() });

        let local_res = client.get(format!("http://{local_addr}/api/opencode/logs")).send().await.unwrap();
        assert_eq!(local_res.status(), Status::OK);
        assert_eq!(local_res.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));
        let local_body: Value = local_res.json().await.unwrap();
        assert_eq!(local_body["text"], sentinel);
        assert_eq!(local_body["truncated"], false);
        assert!(marker.exists(), "local request must invoke discovery");

        // 3. Local router with missing binary maps ENOENT to 404 opencode_logs_missing.
        let missing_bin = logs_dir.join("no-such-opencode-exe");
        app.settings
            .patch(crate::settings::Kind::Config, "server", &json!({"opencodeBinary": missing_bin.to_string_lossy()}))
            .ok()
            .unwrap();
        let missing_res = client.get(format!("http://{local_addr}/api/opencode/logs")).send().await.unwrap();
        assert_eq!(missing_res.status(), Status::NOT_FOUND);
        let missing_body: Value = missing_res.json().await.unwrap();
        assert_eq!(missing_body["error"], "opencode_logs_missing");

        remote_task.abort();
        local_task.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
