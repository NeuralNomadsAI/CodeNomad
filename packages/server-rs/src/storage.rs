//! Per-instance documents (`storage/instance-store.ts`) beside the settings, and the bounded
//! JSON reads and atomic writes shared with the other stores.
pub fn routes() -> axum::Router<Shared> {
    axum::Router::new().route("/api/storage/instances/{id}", axum::routing::any(instance))
}

const INSTANCE_BYTES: usize = 8 * 1024 * 1024;
const HISTORY_BYTES: usize = 128 * 1024;
const HISTORY_ENTRIES: usize = 100;

use axum::{
    Json,
    extract::{FromRequest, Path as Param, Request, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
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
    read_bounded(file, default, INSTANCE_BYTES)
}

pub fn read_bounded(file: &Path, default: Value, max: usize) -> Result<Value, Error> {
    use std::io::Read;
    match fs::File::open(file) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take((max + 1) as u64).read_to_end(&mut bytes).map_err(|_| failed())?;
            if bytes.len() > max { Err(failed()) } else { serde_json::from_slice(&bytes).map_err(|_| failed()) }
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

#[derive(Deserialize)]
struct HistoryAppend {
    text: String,
}

fn append_history(file: &Path, text: String) -> Result<Value, Error> {
    if text.is_empty() || text.len() > HISTORY_BYTES {
        return Err(error(Status::BAD_REQUEST, "Invalid prompt history entry"));
    }
    let mut data = read(file, json!(Instance::default()))?;
    let fields = data.as_object_mut().ok_or_else(failed)?;
    fields.entry("agentModelSelections").or_insert_with(|| json!({}));
    let history = fields.entry("messageHistory").or_insert_with(|| json!([]));
    let history = history.as_array_mut().ok_or_else(failed)?;
    if !history.iter().all(Value::is_string) {
        return Err(failed());
    }
    history.insert(0, Value::String(text));
    history.truncate(HISTORY_ENTRIES);
    let mut size = data.to_string().len();
    let history = data["messageHistory"].as_array_mut().ok_or_else(failed)?;
    while size > INSTANCE_BYTES {
        if history.len() == 1 {
            return Err(failed());
        }
        let tail = history.pop().ok_or_else(failed)?;
        size -= tail.to_string().len() + 1;
    }
    write(file, &data)?;
    Ok(data)
}

/// `InstanceStore.sanitizeId`: the file name the reference derives from the storage key.
fn file_name(key: &str) -> String {
    let mut name = String::new();
    for c in key.chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '.' | '-') { c } else { '_' };
        if !(c == '_' && name.ends_with('_')) {
            name.push(c);
        }
    }
    let name = name.strip_prefix('_').unwrap_or(&name);
    name.strip_suffix('_').unwrap_or(name).to_lowercase()
}

/// The storage key is an open workspace's folder, found by ID or by folder.
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
    let instances = &app.settings.location.instances;
    fs::create_dir_all(instances).map_err(|_| failed())?;
    Ok(instances.join(format!("{}.json", file_name(&workspace.path.to_string_lossy()))))
}

pub async fn instance(
    State(app): State<Shared>,
    Param(id): Param<String>,
    request: Request,
) -> Result<Response, Error> {
    let file = instance_file(&app, &id)?;
    let empty = || json!(Instance::default());
    let value = match *request.method() {
        Method::GET => {
            // `{ ...DEFAULT_INSTANCE_DATA, ...parsed }`
            let mut data = empty();
            if let Value::Object(stored) = read(&file, json!({}))? {
                data.as_object_mut().unwrap().extend(stored);
            }
            return Ok(Json(data).into_response());
        }
        Method::PUT => {
            let Json(data) = Json::<Instance>::from_request(request, &app).await.map_err(
                |_: axum::extract::rejection::JsonRejection| error(Status::BAD_REQUEST, "Invalid instance data"),
            )?;
            instance_file(&app, &id)?;
            let value = json!(data);
            write(&file, &value)?;
            value
        }
        Method::POST => {
            let Json(entry) = Json::<HistoryAppend>::from_request(request, &app).await.map_err(
                |_: axum::extract::rejection::JsonRejection| error(Status::BAD_REQUEST, "Invalid prompt history entry"),
            )?;
            // Resolve the live occurrence again after reading the body. The shared
            // current-thread router does not yield between the read and replacement.
            app.workspace(&id)?;
            append_history(&instance_file(&app, &id)?, entry.text)?
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
    fn instance_files_follow_the_reference_names() {
        assert_eq!(file_name(r"C:\Users\Ana\Mon Projet"), "c_users_ana_mon_projet");
        assert_eq!(file_name("/home/ana/étude__x/"), "home_ana_tude_x");
        assert_eq!(file_name("a.b-c"), "a.b-c");
    }

    #[test]
    fn append_keeps_other_fields_and_the_latest_hundred_entries_on_disk() {
        let dir = crate::shared::test_dir("history-append");
        let file = dir.join("project.json");
        let model = json!({"build": {"providerId": "provider", "modelId": "model"}});
        let original = json!({
            "messageHistory": (0..100).map(|i| i.to_string()).collect::<Vec<_>>(),
            "agentModelSelections": model,
            "other": true,
        });
        write(&file, &original).unwrap();
        append_history(&file, "essai 🦀".into()).unwrap();
        let reopened = read(&file, Value::Null).unwrap();
        assert_eq!(reopened["messageHistory"].as_array().unwrap().len(), 100);
        assert_eq!(reopened["messageHistory"][0], "essai 🦀");
        assert_eq!(reopened["messageHistory"][99], "98");
        assert_eq!(reopened["agentModelSelections"], model);
        assert_eq!(reopened["other"], true);
        assert!(append_history(&file, "x".repeat(HISTORY_BYTES + 1)).is_err());
        assert_eq!(read(&file, Value::Null).unwrap(), reopened);
        fs::remove_dir_all(dir).unwrap();
    }
}
