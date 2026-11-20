//! `server/routes/config-files.ts`: the raw editor of OpenCode's global `opencode.json(c)`; only the
//! listed files are reachable.
use axum::{
    Json, Router,
    body::Bytes,
    extract::Path,
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::{io, path::PathBuf};

use super::document::home;
use crate::{Error, Shared, error, shared::fastify};

struct File {
    id: &'static str,
    label: &'static str,
    shown: &'static str,
    name: &'static str,
    language: &'static str,
}

const FILES: [File; 2] = [
    File {
        id: "opencode-global-config",
        label: "OpenCode Global Config",
        shown: if cfg!(windows) {
            "%USERPROFILE%\\.config\\opencode\\opencode.json"
        } else {
            "~/.config/opencode/opencode.json"
        },
        name: "opencode.json",
        language: "json",
    },
    File {
        id: "opencode-global-config-jsonc",
        label: "OpenCode Global Config (JSONC)",
        shown: if cfg!(windows) {
            "%USERPROFILE%\\.config\\opencode\\opencode.jsonc"
        } else {
            "~/.config/opencode/opencode.jsonc"
        },
        name: "opencode.jsonc",
        language: "jsonc",
    },
];

fn absolute(file: &File) -> PathBuf {
    home().join(".config").join("opencode").join(file.name)
}
fn find(id: &str) -> Result<&'static File, Error> {
    FILES.iter().find(|f| f.id == id).ok_or_else(|| error(Status::NOT_FOUND, "Config file not found"))
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/config-files", get(list)).route("/api/config-files/{id}/content", get(read).put(save))
}

async fn list() -> Json<Value> {
    Json(json!(
        FILES
            .iter()
            .map(|f| json!({"id": f.id, "label": f.label, "path": f.shown, "language": f.language}))
            .collect::<Vec<_>>()
    ))
}

async fn read(Path(id): Path<String>) -> Result<Json<Value>, Error> {
    let file = find(&id)?;
    match tokio::fs::read(absolute(file)).await {
        Ok(bytes) => Ok(Json(
            json!({"id": file.id, "path": file.shown, "contents": String::from_utf8_lossy(&bytes), "exists": true}),
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            Ok(Json(json!({"id": file.id, "path": file.shown, "contents": "", "exists": false})))
        }
        Err(e) => Err(error(Status::BAD_REQUEST, &e.to_string())),
    }
}

/// `{ contents: string }` (other keys ignored), written in place like the reference; 204.
async fn save(Path(id): Path<String>, headers: HeaderMap, bytes: Bytes) -> Result<Response, Error> {
    let file = find(&id)?;
    let body = match fastify::body(&headers, &bytes)? {
        Some(fastify::Body::Json(body)) if !body.is_null() => body,
        Some(fastify::Body::Text(text)) => Value::String(text),
        _ => json!({}),
    };
    let Some(contents) = body.get("contents").and_then(Value::as_str) else {
        let (expected, path, value) = if body.is_object() {
            ("string", "[\n      \"contents\"\n    ]", body.get("contents"))
        } else {
            ("object", "[]", Some(&body))
        };
        let received = match value {
            None => "undefined",
            Some(Value::Null) => "null",
            Some(Value::Bool(_)) => "boolean",
            Some(Value::Number(_)) => "number",
            Some(Value::Array(_)) => "array",
            Some(Value::Object(_)) => "object",
            Some(Value::String(_)) => "string",
        };
        let message = format!(
            "[\n  {{\n    \"expected\": \"{expected}\",\n    \"code\": \"invalid_type\",\n    \"path\": {path},\n    \"message\": \"Invalid input: expected {expected}, received {received}\"\n  }}\n]"
        );
        return Err(error(Status::BAD_REQUEST, &message));
    };
    let target = absolute(file);
    let failed = |e: io::Error| error(Status::BAD_REQUEST, &e.to_string());
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(failed)?;
    }
    tokio::fs::write(&target, contents).await.map_err(failed)?;
    Ok(Status::NO_CONTENT.into_response())
}
