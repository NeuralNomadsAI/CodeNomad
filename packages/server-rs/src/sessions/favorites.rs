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
use std::{collections::BTreeMap, sync::atomic::Ordering::Relaxed, time::Duration};

type Entries = BTreeMap<String, Vec<String>>;
type Store = BTreeMap<String, Entries>;
const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_FAVORITES: usize = 512;

fn id_ok(id: &str) -> bool {
    id.starts_with("ses")
        && !id.starts_with("ses_cn_schedule_")
        && (4..=514).contains(&id.len())
        && id.bytes().all(|v| v.is_ascii_alphanumeric() || matches!(v, b'_' | b'-'))
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
    let data = storage::read_bounded(&app.data.join("session-favorites.json"), json!({}), MAX_FILE)
        .map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    let state: Store = serde_json::from_value(data).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    if !state.iter().all(|(scope, entries)| {
        scope.len() == 64
            && scope.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
            && entries.len() <= MAX_FAVORITES
            && entries
                .iter()
                .all(|(id, ancestors)| id_ok(id) && ancestors.len() <= 64 && ancestors.iter().all(|id| id_ok(id)))
    }) {
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
            let _cleanup_guard = app.session_cleanup.enter_mutation(&target).ok_or(Status::CONFLICT)?;
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
            let mut store = read(&app)?;
            let entries = store.entry(key.clone()).or_default();
            if entries.len() == MAX_FAVORITES && !entries.contains_key(&target) {
                return Err(Status::CONFLICT);
            }
            entries.insert(target, parents);
            save(&app, &store)?;
            Ok(display(&app, &store, &key, false))
        } else {
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

pub fn is_protected(app: &App, session_id: &str) -> bool {
    let Ok(state) = read(app) else { return true };
    state.values().any(|entries| {
        entries.contains_key(session_id)
            || entries.values().any(|parents| parents.iter().any(|parent| parent == session_id))
    })
}

pub fn deleted(app: &App, event: &Value) {
    if event["type"] != "session.deleted" {
        return;
    }
    let Some(target) = event["data"]["sessionID"].as_str().filter(|s| id_ok(s)) else { return };
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
