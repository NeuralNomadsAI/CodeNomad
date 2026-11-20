//! UI preferences and per-instance documents under the data folder, bounded JSON reads
//! and atomic writes shared with the other stores.
pub fn routes() -> axum::Router<Shared> {
    axum::Router::new()
        .route("/api/storage/{family}/ui", axum::routing::any(preferences))
        .route("/api/storage/instances/{id}", axum::routing::any(instance))
}

use axum::{
    Json,
    extract::{FromRequest, Path as Param, Request, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

use crate::{Error, Shared, error, unavailable};

fn failed() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Storage unavailable")
}

pub fn read(file: &Path, default: Value) -> Result<Value, Error> {
    read_bounded(file, default, 8 * 1024 * 1024)
}

pub fn read_bounded(file: &Path, default: Value, max: usize) -> Result<Value, Error> {
    use std::io::Read;
    match fs::File::open(file) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take((max + 1) as u64).read_to_end(&mut bytes).map_err(|_| failed())?;
            if bytes.len() > max {
                return Err(failed());
            }
            serde_json::from_slice(&bytes).map_err(|_| failed())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(default),
        Err(_) => Err(failed()),
    }
}

pub fn write(file: &Path, data: &Value) -> Result<(), Error> {
    use std::io::Write;
    let temp = file.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut handle = fs::OpenOptions::new().create_new(true).write(true).open(&temp)?;
        handle.write_all(data.to_string().as_bytes())?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&temp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|_| failed())
}

fn merge(target: &mut Value, patch: Value) {
    if let Value::Object(patch) = patch {
        if !target.is_object() {
            *target = json!({});
        }
        let target = target.as_object_mut().unwrap();
        for (key, value) in patch {
            if value.is_null() {
                target.remove(&key);
            } else {
                merge(target.entry(key).or_insert(Value::Null), value);
            }
        }
    } else {
        *target = patch;
    }
}

/// A merged preferences document stays well below the read bound, so a patch
/// can never make the route unreadable (audit F4); the file is left intact.
pub const PREFERENCES_LIMIT: usize = 1024 * 1024;
fn bounded(document: &Value, previous: usize) -> Result<(), Error> {
    let size = document.to_string().len();
    // A document already past the bound can still shrink.
    if size > PREFERENCES_LIMIT && size > previous {
        return Err(error(Status::PAYLOAD_TOO_LARGE, "Preferences too large"));
    }
    Ok(())
}

pub async fn preferences(
    State(app): State<Shared>,
    Param(family): Param<String>,
    request: Request,
) -> Result<Response, Error> {
    if !matches!(family.as_str(), "config" | "state") {
        return Ok(unavailable());
    }
    let file = app.data.join(format!("{family}-ui.json"));
    let path = request.uri();
    if path.query().is_some() {
        return Ok(unavailable());
    }
    if request.method() == Method::GET {
        return Ok(Json(read(&file, json!({}))?).into_response());
    }
    if request.method() != Method::PATCH {
        return Ok(unavailable());
    }
    let Json(patch) = Json::<Value>::from_request(request, &app)
        .await
        .map_err(|_: axum::extract::rejection::JsonRejection| error(Status::BAD_REQUEST, "Invalid patch"))?;
    let patch: Value = patch;
    let Some(input) = patch.as_object() else { return Err(error(Status::BAD_REQUEST, "Invalid patch")) };
    // No changes to host-only flags, profiles, mission settings, or other unported features.
    let allowed: &[&str] = if family == "state" { &["recentFolders", "models"] } else { &[] };
    if input.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Ok(unavailable());
    }
    let mut updated = read(&file, json!({}))?;
    let previous = updated.to_string().len();
    merge(&mut updated, patch);
    bounded(&updated, previous)?;
    write(&file, &updated)?;
    app.emit(json!({"type":format!("storage.{family}Changed"),"owner":"ui","value":updated}));
    Ok(Json(updated).into_response())
}

#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    provider_id: String,
    model_id: String,
}
#[derive(serde::Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Instance {
    message_history: Vec<String>,
    agent_model_selections: std::collections::BTreeMap<String, Model>,
}

fn instance_file(app: &crate::App, id: &str) -> Result<PathBuf, Error> {
    let workspace = app.workspace(id).or_else(|_| {
        app.inner
            .lock()
            .unwrap()
            .workspaces
            .iter()
            .find(|w| w.path.to_str() == Some(id))
            .cloned()
            .ok_or_else(crate::not_found)
    })?;
    let digest = Sha256::digest(workspace.path.to_string_lossy().as_bytes());
    Ok(app.data.join(format!("instance-{digest:x}.json")))
}

pub async fn instance(
    State(app): State<Shared>,
    Param(id): Param<String>,
    request: Request,
) -> Result<Response, Error> {
    let file = instance_file(&app, &id)?;
    let empty = || json!(Instance::default());
    let value = match *request.method() {
        Method::GET => return Ok(Json(read(&file, empty())?).into_response()),
        Method::PUT => {
            let Json(data) = Json::<Instance>::from_request(request, &app).await.map_err(
                |_: axum::extract::rejection::JsonRejection| error(Status::BAD_REQUEST, "Invalid instance data"),
            )?;
            instance_file(&app, &id)?;
            let value = json!(data);
            write(&file, &value)?;
            value
        }
        Method::DELETE => {
            match fs::remove_file(file) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err(failed()),
            }
            empty()
        }
        _ => return Ok(unavailable()),
    };
    app.emit(json!({"type":"instance.dataChanged","instanceId":id,"data":value}));
    Ok(Status::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_never_grow_past_the_bound() {
        let mut document = json!({"recentFolders":["a"]});
        let previous = document.to_string().len();
        merge(&mut document, json!({"recentFolders":["x".repeat(PREFERENCES_LIMIT)]}));
        assert_eq!(bounded(&document, previous).unwrap_err().0, Status::PAYLOAD_TOO_LARGE);
        // An oversized document left by an earlier version can still shrink.
        let previous = document.to_string().len();
        merge(&mut document, json!({"recentFolders":["x".repeat(PREFERENCES_LIMIT - 64)]}));
        assert!(bounded(&document, previous).is_ok());
        merge(&mut document, json!({"recentFolders":[]}));
        assert!(bounded(&document, previous).is_ok());
    }
}
