//! Session favorites per workspace under the data folder, pruned when the daemon deletes a session.
use crate::{App, Shared, Workspace, auth::Principal, storage};
use axum::{
    Extension, Json,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Mutex, atomic::Ordering::Relaxed},
    time::Duration,
};

type Entries = BTreeMap<String, Vec<String>>;
type Store = BTreeMap<String, Entries>;
const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_FAVORITES: usize = 512;
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn any_session_id_ok(id: &str) -> bool {
    id.starts_with("ses")
        && (4..=514).contains(&id.len())
        && id.bytes().all(|v| v.is_ascii_alphanumeric() || matches!(v, b'_' | b'-'))
}
fn id_ok(id: &str) -> bool {
    any_session_id_ok(id) && !id.starts_with("ses_cn_schedule_")
}
fn valid_store(state: &Store, check_id: fn(&str) -> bool) -> bool {
    state.iter().all(|(scope, entries)| {
        scope.len() == 64
            && scope.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
            && entries.len() <= MAX_FAVORITES
            && entries
                .iter()
                .all(|(id, ancestors)| check_id(id) && ancestors.len() <= 64 && ancestors.iter().all(|id| check_id(id)))
    })
}
fn store_protects(state: &Store, session_id: &str) -> bool {
    state.values().any(|entries| {
        entries.contains_key(session_id)
            || entries.values().any(|parents| parents.iter().any(|parent| parent == session_id))
    })
}
fn belonging(session: &Value, workspace: &Workspace) -> bool {
    session["location"]["directory"] == workspace.location["directory"]
        && session["location"].get("workspaceID").is_none()
        && dunce::canonicalize(&workspace.path).ok().as_ref() == Some(&workspace.path)
}
fn key(workspace: &Workspace) -> String {
    let mut path = workspace.path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        path = path.to_lowercase();
    }
    format!("{:x}", Sha256::digest(path.as_bytes()))
}
fn read(app: &App) -> Result<Store, Status> {
    let path = app.data.join("session-favorites.json");
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::new()),
        Err(_) => return Err(Status::SERVICE_UNAVAILABLE),
        Ok(meta) if meta.file_type().is_symlink() && std::fs::metadata(&path).is_err() => {
            return Err(Status::SERVICE_UNAVAILABLE);
        }
        Ok(_) => {}
    }
    let data = storage::read_bounded(&path, json!({}), MAX_FILE).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    let state: Store = serde_json::from_value(data).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    if !valid_store(&state, id_ok) {
        return Err(Status::SERVICE_UNAVAILABLE);
    }
    Ok(state)
}
fn save(app: &App, store: &Store) -> Result<(), Status> {
    let value = json!(store);
    if value.to_string().len() > MAX_FILE {
        return Err(Status::CONFLICT);
    }
    storage::write(&app.data.join("session-favorites.json"), &value).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    app.favorite_revision.fetch_add(1, Relaxed);
    app.emit(json!({"type":"storage.stateChanged","owner":"sessionFavorites","value":{}}));
    Ok(())
}
fn display(app: &App, state: &Store, key: &str, cached: bool) -> Response {
    let records: BTreeMap<_, [String; 0]> =
        state.get(key).into_iter().flat_map(|rows| rows.keys().map(|id| (id, []))).collect();
    let out =
        Json(json!({"records":records,"source":app.favorite_source,"revision":app.favorite_revision.load(Relaxed)}));
    if cached { ([(header::CACHE_CONTROL, "no-store")], out).into_response() } else { out.into_response() }
}

#[derive(Deserialize)]
pub struct ReadQuery {
    reconcile: Option<String>,
}
pub async fn list(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(query): Query<ReadQuery>,
) -> Result<Response, Status> {
    let workspace = app.workspace(&id).map_err(|_| Status::NOT_FOUND)?;
    let key = key(&workspace);
    let store = read(&app)?;
    if query.reconcile.as_deref() == Some("1")
        && let Some(entries) = store.get(&key).filter(|x| !x.is_empty())
    {
        // One bounded scan across the prototype. Duplicate reads remain usable
        // while it runs; only authenticated exact 404s can remove an entry.
        if let Ok(permit) = app.favorite_scan.clone().try_acquire_owned() {
            let targets = entries.keys().cloned().collect::<Vec<_>>();
            let revision = app.favorite_revision.load(Relaxed);
            let (app, id, key) = (app.clone(), id.clone(), key.clone());
            tokio::spawn(async move {
                let _permit = permit;
                let mut absent = Vec::new();
                let scan = async {
                    for session in targets {
                        if app.workspace(&id).is_err() {
                            break;
                        }
                        if crate::opencode::session_record(&app, &session)
                            .await
                            .is_err_and(|(status, _)| status == Status::NOT_FOUND)
                        {
                            absent.push(session);
                        }
                    }
                };
                tokio::select! {
                    _=principal.0.cancelled()=>return,
                    _=tokio::time::timeout(Duration::from_secs(6),scan)=>{}
                }
                if absent.is_empty() || app.workspace(&id).is_err() || app.favorite_revision.load(Relaxed) != revision {
                    return;
                }
                let _lock = STORE_LOCK.lock().unwrap();
                if let Ok(mut state) = read(&app)
                    && let Some(rows) = state.get_mut(&key)
                {
                    for target in absent {
                        rows.remove(&target);
                    }
                    let _ = save(&app, &state);
                }
            });
        }
    }
    Ok(display(&app, &store, &key, true))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    favorite: bool,
}
pub async fn update(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, target)): Path<(String, String)>,
    input: Result<Json<Input>, JsonRejection>,
) -> Result<Response, Status> {
    let Json(input) = input.map_err(|_| Status::BAD_REQUEST)?;
    if !id_ok(&target) {
        return Err(Status::BAD_REQUEST);
    }
    let workspace = app.workspace(&id).map_err(|_| Status::NOT_FOUND)?;
    let key = key(&workspace);
    let operation = async {
        if input.favorite {
            let mut cleanup_guards = vec![app.session_cleanup.enter_mutation(&target).ok_or(Status::CONFLICT)?];
            let session = crate::opencode::session_record(&app, &target).await.map_err(|(status, _)| status)?;
            if session["id"] != target || !belonging(&session, &workspace) {
                return Err(Status::FORBIDDEN);
            }
            let mut parents = Vec::new();
            let mut parent = session["parentID"].as_str().map(str::to_owned);
            while let Some(current) = parent {
                if !id_ok(&current) || current == target || parents.contains(&current) || parents.len() == 64 {
                    return Err(Status::CONFLICT);
                }
                cleanup_guards.push(app.session_cleanup.enter_mutation(&current).ok_or(Status::CONFLICT)?);
                let record = crate::opencode::session_record(&app, &current).await.map_err(|(status, _)| status)?;
                if record["id"] != current {
                    return Err(Status::CONFLICT);
                }
                parent = record["parentID"].as_str().map(str::to_owned);
                parents.push(current);
            }
            let latest = crate::opencode::session_record(&app, &target).await.map_err(|(status, _)| status)?;
            if app.workspace(&id).is_err()
                || !belonging(&latest, &workspace)
                || latest["parentID"] != session["parentID"]
            {
                return Err(Status::CONFLICT);
            }
            let _lock = STORE_LOCK.lock().unwrap();
            let mut store = read(&app)?;
            let entries = store.entry(key.clone()).or_default();
            if entries.len() == MAX_FAVORITES && !entries.contains_key(&target) {
                return Err(Status::CONFLICT);
            }
            entries.insert(target, parents);
            save(&app, &store)?;
            drop(_lock);
            drop(cleanup_guards);
            Ok(display(&app, &store, &key, false))
        } else {
            let _lock = STORE_LOCK.lock().unwrap();
            let mut store = read(&app)?;
            if let Some(entries) = store.get_mut(&key)
                && entries.remove(&target).is_some()
            {
                save(&app, &store)?;
            }
            Ok(display(&app, &store, &key, false))
        }
    };
    tokio::select! {
        _=principal.0.cancelled()=>Err(Status::UNAUTHORIZED),
        output=tokio::time::timeout(Duration::from_secs(8),operation)=>output.unwrap_or(Err(Status::SERVICE_UNAVAILABLE)),
    }
}

fn state_yaml_stamp(state_path: &std::path::Path) -> Result<String, ()> {
    let link = match std::fs::symlink_metadata(state_path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(_) => return Err(()),
    };
    let meta = if link.file_type().is_symlink() { std::fs::metadata(state_path).map_err(|_| ())? } else { link };
    let identity = crate::files::host_identity(state_path).map_err(|_| ())?;
    let modified =
        meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos());
    let created = meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos());
    Ok(format!("{identity}:{}:{:?}:{:?}", meta.len(), modified, created))
}

fn state_yaml_protects(state_path: &std::path::Path, session_id: &str) -> bool {
    let Ok(before) = state_yaml_stamp(state_path) else {
        return true;
    };
    if before == "missing" {
        return false;
    }
    let Ok(doc) = crate::settings::document::read(state_path) else {
        return true;
    };
    let protected = match doc.get("sessionFavorites") {
        None => false,
        Some(raw) => {
            let Ok(yaml_state) = serde_json::from_value::<Store>(raw.clone()) else {
                return true;
            };
            if !valid_store(&yaml_state, any_session_id_ok) {
                return true;
            }
            store_protects(&yaml_state, session_id)
        }
    };
    if state_yaml_stamp(state_path).ok().as_deref() != Some(before.as_str()) {
        return true;
    }
    protected
}

pub fn is_protected(app: &App, session_id: &str) -> bool {
    let Ok(state) = read(app) else { return true };
    store_protects(&state, session_id) || state_yaml_protects(&app.settings.location.state, session_id)
}

pub fn deleted(app: &App, event: &Value) {
    if event["type"] != "session.deleted" {
        return;
    }
    let Some(target) = event["data"]["sessionID"].as_str().filter(|s| id_ok(s)) else { return };
    let _lock = STORE_LOCK.lock().unwrap();
    let Ok(mut state) = read(app) else { return };
    let mut changed = false;
    for entries in state.values_mut() {
        let count = entries.len();
        entries.retain(|id, parents| id != target && !parents.iter().any(|parent| parent == target));
        changed |= count != entries.len();
    }
    if changed {
        let _ = save(app, &state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_yaml_favorites_protect_targets_ancestors_and_fail_closed_on_corrupt_yaml() {
        let dir = std::env::temp_dir().join(format!("cn-fav-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state_path = dir.join("state.yaml");

        // Missing file protects nothing.
        assert!(!state_yaml_protects(&state_path, "ses_root"));

        // Valid state.yaml protects both direct favorite and its ancestor.
        let scope = "a".repeat(64);
        std::fs::write(&state_path, format!("sessionFavorites:\n  {scope}:\n    ses_child:\n      - ses_root\n"))
            .unwrap();
        assert!(state_yaml_protects(&state_path, "ses_child"));
        assert!(state_yaml_protects(&state_path, "ses_root"));
        assert!(!state_yaml_protects(&state_path, "ses_other"));

        // Corrupt state.yaml fails closed (protects everything).
        std::fs::write(&state_path, "sessionFavorites: [").unwrap();
        assert!(state_yaml_protects(&state_path, "ses_other"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
