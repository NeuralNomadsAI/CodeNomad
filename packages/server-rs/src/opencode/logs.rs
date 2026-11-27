//! `GET /api/opencode/logs`: bounded snapshot of the selected host OpenCode log (`opencode/logs.ts`,
//! `server/routes/opencode-logs.ts`).
use std::{future::Future, io::SeekFrom, path::Path, time::Duration};

use axum::{
    Json,
    extract::State,
    http::{StatusCode as Status, Uri, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

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

async fn selection(app: &crate::App) -> String {
    if let Some(binary) = launch::custom_binary(&app.settings) {
        return binary;
    }
    launch::resolve(&install::plan::resolve_default().await.0)
}

async fn discover_directory(binary: &str) -> Result<String, LogError> {
    if launch::wsl(binary) {
        return Err(LogError::Failed);
    }
    let spec = launch::spec(binary, &["debug", "paths", "log"]).map_err(|_| LogError::Failed)?;
    let output = daemon::execute(&spec, None, DISCOVERY_TIMEOUT).await.map_err(|_| LogError::Failed)?;
    Ok(output.stdout.trim().to_owned())
}

async fn read_log_file(directory: &str) -> Result<Value, LogError> {
    let dir = Path::new(directory);
    if !dir.is_absolute() || directory.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(LogError::Failed);
    }
    let file_path = dir.join("opencode.log");
    let mut file = tokio::fs::File::open(&file_path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound { LogError::Missing } else { LogError::Failed }
    })?;
    let meta = file.metadata().await.map_err(|_| LogError::Failed)?;
    if !meta.is_file() {
        return Err(LogError::Failed);
    }
    let size = meta.len();
    let limit = OPENCODE_LOG_BYTES as u64;
    let start = size.saturating_sub(limit);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await.map_err(|_| LogError::Failed)?;
    }
    let mut buf = Vec::with_capacity(size.min(limit) as usize);
    file.take(limit).read_to_end(&mut buf).await.map_err(|_| LogError::Failed)?;
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
}
