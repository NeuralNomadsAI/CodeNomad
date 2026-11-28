//! Session favorites per workspace persisted in `state.yaml` under the `sessionFavorites` owner,
//! shared bidirectionally with the TypeScript server and pruned when the daemon deletes a session.
use crate::{
    App, Shared, Workspace,
    auth::Principal,
    settings::{Failure, Kind, document::Doc},
    storage,
};
use axum::{
    Extension, Json,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path as FsPath, sync::atomic::Ordering::Relaxed, time::Duration};

type Entries = BTreeMap<String, Vec<String>>;
type Store = BTreeMap<String, Entries>;
const OWNER: &str = "sessionFavorites";
const LEGACY_FILE: &str = "session-favorites.json";
const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_FAVORITES: usize = 512;

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
async fn belonging(app: &App, session: &Value, workspace: &Workspace) -> bool {
    if session["location"].get("workspaceID").is_some() {
        return false;
    }
    let Some(directory) = session["location"]["directory"].as_str() else {
        return false;
    };
    crate::worktrees::owns(app, workspace, directory).await
}
/// Matches TS `canonicalWorktreeIdentity(workspace.path)` hashed with SHA-256 hex.
fn key_for_path(path: &FsPath) -> String {
    let normalized = crate::files::node_path::Style::host().normalize(&path.to_string_lossy());
    let identity = if cfg!(windows) { normalized.to_lowercase() } else { normalized };
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}
fn key(workspace: &Workspace) -> String {
    key_for_path(&workspace.path)
}
fn parse_owner_value(raw: Option<&Value>) -> Result<Store, Status> {
    let Some(raw) = raw else {
        return Ok(Store::new());
    };
    let state: Store = serde_json::from_value(raw.clone()).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    if !valid_store(&state, any_session_id_ok) {
        return Err(Status::SERVICE_UNAVAILABLE);
    }
    Ok(state)
}
fn state_yaml_stamp(state_path: &FsPath) -> Result<String, ()> {
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
/// Reads `sessionFavorites` authoritatively from `state.yaml` with a before/after file stamp check.
/// Returns `Ok(None)` when `state.yaml` is missing or has no `sessionFavorites` key.
fn read_state_yaml(state_path: &FsPath) -> Result<Option<Store>, Status> {
    let before = state_yaml_stamp(state_path).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    if before == "missing" {
        return Ok(None);
    }
    let doc = crate::settings::document::read(state_path).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    let parsed = match doc.get(OWNER) {
        None => None,
        Some(raw) => Some(parse_owner_value(Some(raw))?),
    };
    if state_yaml_stamp(state_path).ok().as_deref() != Some(before.as_str()) {
        return Err(Status::SERVICE_UNAVAILABLE);
    }
    Ok(parsed)
}
fn read_legacy_json(path: &FsPath) -> Result<Option<(Store, bool)>, Status> {
    let is_symlink = match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Status::SERVICE_UNAVAILABLE),
        Ok(meta) if meta.file_type().is_symlink() => {
            if std::fs::metadata(path).is_err() {
                return Err(Status::SERVICE_UNAVAILABLE);
            }
            true
        }
        Ok(_) => false,
    };
    let data = storage::read_bounded(path, json!({}), MAX_FILE).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    let state: Store = serde_json::from_value(data).map_err(|_| Status::SERVICE_UNAVAILABLE)?;
    if !valid_store(&state, any_session_id_ok) {
        return Err(Status::SERVICE_UNAVAILABLE);
    }
    Ok(Some((state, is_symlink)))
}
fn read(app: &App) -> Result<Store, Status> {
    if let Some(state) = read_state_yaml(&app.settings.location.state)? {
        return Ok(state);
    }
    let legacy_path = app.data.join(LEGACY_FILE);
    let Some((legacy, is_symlink)) = read_legacy_json(&legacy_path)? else {
        return Ok(Store::new());
    };
    if legacy.is_empty() {
        if !is_symlink {
            let _ = std::fs::remove_file(&legacy_path);
        }
        return Ok(legacy);
    }
    let patch = json!(legacy);
    match app.settings.patch_checked_committed(
        Kind::State,
        OWNER,
        &patch,
        &[],
        |before, after| {
            // Never overwrite `sessionFavorites` that appeared concurrently (e.g. written by TS).
            if before.contains_key(OWNER) {
                return Err(Failure::Conflict);
            }
            if after.get(OWNER).is_some_and(|v| v.to_string().len() > MAX_FILE) {
                return Err(Failure::Conflict);
            }
            Ok(())
        },
        |_, _| {
            app.favorite_revision.fetch_add(1, Relaxed);
        },
    ) {
        Ok((saved, _)) => {
            if !is_symlink {
                let _ = std::fs::remove_file(&legacy_path);
            }
            parse_owner_value(Some(&saved))
        }
        Err(Failure::Conflict) => {
            // Another writer populated `sessionFavorites` in `state.yaml`; prefer it without overwriting.
            Ok(read_state_yaml(&app.settings.location.state)?.unwrap_or_default())
        }
        Err(_) => Err(Status::SERVICE_UNAVAILABLE),
    }
}
fn patch_favorites(
    app: &App,
    patch: Value,
    mut check_before: impl FnMut(&Store) -> Result<(), Failure>,
) -> Result<Store, Status> {
    let saved = crate::settings::patch_owner_checked(
        app,
        Kind::State,
        OWNER,
        patch,
        |before: &Doc, after: &Doc| {
            let current = parse_owner_value(before.get(OWNER)).map_err(|_| Failure::Unreadable)?;
            check_before(&current)?;
            if after.get(OWNER).is_some_and(|v| v.to_string().len() > MAX_FILE) {
                return Err(Failure::Conflict);
            }
            Ok(())
        },
        || {
            app.favorite_revision.fetch_add(1, Relaxed);
        },
    )
    .map_err(|failure| match failure {
        Failure::Conflict => Status::CONFLICT,
        _ => Status::SERVICE_UNAVAILABLE,
    })?;
    parse_owner_value(Some(&saved))
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
                let deletions: serde_json::Map<String, Value> =
                    absent.into_iter().map(|target| (target, Value::Null)).collect();
                let _ = patch_favorites(&app, json!({ key: deletions }), |_| Ok(()));
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
        // Ensure `state.yaml` is readable and any one-time legacy import has settled first.
        let store = read(&app)?;
        if input.favorite {
            let mut cleanup_guards = vec![app.session_cleanup.enter_mutation(&target).ok_or(Status::CONFLICT)?];
            let session = crate::opencode::session_record(&app, &target).await.map_err(|(status, _)| status)?;
            if session["id"] != target || !belonging(&app, &session, &workspace).await {
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
                || latest["id"] != target
                || latest["location"]["directory"] != session["location"]["directory"]
                || !belonging(&app, &latest, &workspace).await
                || latest["parentID"] != session["parentID"]
            {
                return Err(Status::CONFLICT);
            }
            let patch = json!({ &key: { &target: parents } });
            let saved = patch_favorites(&app, patch, |current| {
                let count = current.get(&key).map_or(0, BTreeMap::len);
                let exists = current.get(&key).is_some_and(|entries| entries.contains_key(&target));
                if !exists && count >= MAX_FAVORITES { Err(Failure::Conflict) } else { Ok(()) }
            })?;
            drop(cleanup_guards);
            Ok(display(&app, &saved, &key, false))
        } else if store.get(&key).is_some_and(|entries| entries.contains_key(&target)) {
            let saved = patch_favorites(&app, json!({ &key: { &target: Value::Null } }), |_| Ok(()))?;
            Ok(display(&app, &saved, &key, false))
        } else {
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
    store_protects(&state, session_id)
}

pub fn deleted(app: &App, event: &Value) {
    if event["type"] != "session.deleted" {
        return;
    }
    let Some(target) = event["data"]["sessionID"].as_str().filter(|s| id_ok(s)) else { return };
    let Ok(state) = read(app) else { return };
    let mut patch = serde_json::Map::new();
    for (scope, entries) in &state {
        let mut removed = serde_json::Map::new();
        for (id, parents) in entries {
            if id == target || parents.iter().any(|parent| parent == target) {
                removed.insert(id.clone(), Value::Null);
            }
        }
        if !removed.is_empty() {
            patch.insert(scope.clone(), Value::Object(removed));
        }
    }
    if !patch.is_empty() {
        let _ = patch_favorites(app, Value::Object(patch), |_| Ok(()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_app(root: &FsPath, native: crate::opencode::Native) -> Shared {
        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "opencode".into(),
            password: None,
            file: None,
            cookie: "cn".into(),
            token: false,
            skip: true,
            managed_local: false,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            root.join("config.yaml").to_str().unwrap(),
        ));
        std::sync::Arc::new(App::new(
            auth,
            0,
            root.to_path_buf(),
            root.to_path_buf(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ))
    }

    #[test]
    fn key_for_path_matches_ts_canonical_worktree_identity() {
        #[cfg(windows)]
        {
            let upper = key_for_path(FsPath::new(r"D:\CodeNomad\Repo"));
            let slash = key_for_path(FsPath::new("d:/codenomad/repo"));
            let expected = format!("{:x}", Sha256::digest(r"d:\codenomad\repo".as_bytes()));
            assert_eq!(upper, expected);
            assert_eq!(slash, expected);
        }
        #[cfg(not(windows))]
        {
            let k = key_for_path(FsPath::new("/private/var/repo"));
            let expected = format!("{:x}", Sha256::digest(b"/private/var/repo"));
            assert_eq!(k, expected);
        }
    }

    #[tokio::test]
    async fn state_yaml_favorites_round_trip_preserves_siblings_and_ts_format() {
        let dir = dunce::canonicalize(crate::shared::test_dir("favorites-state-yaml")).unwrap();
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_str = repo.to_string_lossy().into_owned();
        let scope = key_for_path(&repo);

        // Pre-populate `state.yaml` with sibling owners AND a TS-written favorite with ancestry.
        let state_path = dir.join("state.yaml");
        std::fs::write(
            &state_path,
            format!(
                "ui:\n  theme: dark\nsessionPermissionBlocks:\n  keep: true\nsessionFavorites:\n  {scope}:\n    ses_from_ts:\n      - ses_ts_parent\n"
            ),
        )
        .unwrap();

        let mock_router = axum::Router::new().route(
            "/api/session/{session_id}",
            axum::routing::get({
                let d = repo_str.clone();
                move |Path(sid): Path<String>| {
                    let d = d.clone();
                    async move {
                        match sid.as_str() {
                            "ses_rust_child" => Json(json!({
                                "id": "ses_rust_child",
                                "parentID": "ses_rust_root",
                                "location": { "directory": d }
                            }))
                            .into_response(),
                            "ses_rust_root" => Json(json!({
                                "id": "ses_rust_root",
                                "location": { "directory": d }
                            }))
                            .into_response(),
                            _ => Status::NOT_FOUND.into_response(),
                        }
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

        let app = test_app(&dir, crate::opencode::Native::test_connection(addr));
        let wid = uuid::Uuid::new_v4();
        app.inner.lock().unwrap().workspaces.push(Workspace {
            id: wid,
            request_id: None,
            path: repo.clone(),
            name: None,
            status: "ready",
            proxy_path: format!("/workspaces/{wid}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({ "directory": repo_str }),
            temporary: None,
        });
        let principal = Principal(tokio_util::sync::CancellationToken::new());

        // 1. Rust reads TS-written favorites from `state.yaml`, hides ancestry in HTTP response, and protects both.
        assert!(is_protected(&app, "ses_from_ts"));
        assert!(is_protected(&app, "ses_ts_parent"));
        assert!(!is_protected(&app, "ses_other"));
        let listed = list(
            State(app.clone()),
            Extension(principal.clone()),
            Path(wid.to_string()),
            Query(ReadQuery { reconcile: None }),
        )
        .await
        .unwrap();
        assert_eq!(listed.status(), Status::OK);
        let listed_body: Value =
            serde_json::from_slice(&axum::body::to_bytes(listed.into_body(), 64 * 1024).await.unwrap()).unwrap();
        assert_eq!(listed_body["records"], json!({ "ses_from_ts": [] }));

        // 2. Subscribe to SSE events to verify `storage.stateChanged` redacts `sessionFavorites` value to `{}`.
        let sub = app.events.subscribe();

        // 3. Adding a favorite writes `state.yaml` under `sessionFavorites` in TS schema without creating legacy JSON.
        let added = update(
            State(app.clone()),
            Extension(principal.clone()),
            Path((wid.to_string(), "ses_rust_child".into())),
            Ok(Json(Input { favorite: true })),
        )
        .await
        .unwrap();
        assert_eq!(added.status(), Status::OK);
        assert!(!dir.join(LEGACY_FILE).exists(), "must not create legacy session-favorites.json");
        assert!(is_protected(&app, "ses_rust_child"));
        assert!(is_protected(&app, "ses_rust_root"));

        let doc = crate::settings::document::read(&state_path).unwrap();
        assert_eq!(doc["ui"]["theme"], "dark");
        assert_eq!(doc["sessionPermissionBlocks"]["keep"], true);
        assert_eq!(doc[OWNER][&scope]["ses_from_ts"], json!(["ses_ts_parent"]));
        assert_eq!(doc[OWNER][&scope]["ses_rust_child"], json!(["ses_rust_root"]));

        let crate::events::Next::Frame(frame) = app.events.pop(&sub) else {
            panic!("storage.stateChanged not emitted");
        };
        let payload: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(payload, json!({ "type": "storage.stateChanged", "owner": OWNER, "value": {} }));
        app.events.unsubscribe(&sub);

        // 4. Unfavoriting removes the entry from `state.yaml` via merge patch.
        let removed = update(
            State(app.clone()),
            Extension(principal.clone()),
            Path((wid.to_string(), "ses_from_ts".into())),
            Ok(Json(Input { favorite: false })),
        )
        .await
        .unwrap();
        assert_eq!(removed.status(), Status::OK);
        assert!(!is_protected(&app, "ses_from_ts"));
        assert!(!is_protected(&app, "ses_ts_parent"));
        assert!(is_protected(&app, "ses_rust_child"));
        let doc_after = crate::settings::document::read(&state_path).unwrap();
        assert!(doc_after[OWNER][&scope].get("ses_from_ts").is_none());
        assert_eq!(doc_after[OWNER][&scope]["ses_rust_child"], json!(["ses_rust_root"]));

        // 5. Corrupt `state.yaml` fails closed on reads, protection checks, and writes.
        std::fs::write(&state_path, "sessionFavorites: [").unwrap();
        assert!(is_protected(&app, "ses_other"));
        assert_eq!(read(&app).unwrap_err(), Status::SERVICE_UNAVAILABLE);
        assert_eq!(
            update(
                State(app.clone()),
                Extension(principal),
                Path((wid.to_string(), "ses_rust_child".into())),
                Ok(Json(Input { favorite: false })),
            )
            .await
            .unwrap_err(),
            Status::SERVICE_UNAVAILABLE
        );
        assert_eq!(std::fs::read_to_string(&state_path).unwrap(), "sessionFavorites: [");

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_json_migrates_once_without_overwriting_existing_ts_favorites() {
        let dir = dunce::canonicalize(crate::shared::test_dir("favorites-legacy-migration")).unwrap();
        let scope_legacy = "a".repeat(64);
        let scope_ts = "b".repeat(64);

        // Case 1: `state.yaml` has `ui` but no `sessionFavorites`, and `session-favorites.json` exists -> migrate once.
        let app = test_app(&dir, crate::opencode::Native::connect("opencode").unwrap());
        let state_path = dir.join("state.yaml");
        let legacy_path = dir.join(LEGACY_FILE);
        std::fs::write(&state_path, "ui:\n  kept: true\n").unwrap();
        std::fs::write(&legacy_path, json!({ &scope_legacy: { "ses_old": ["ses_old_parent"] } }).to_string()).unwrap();

        let migrated = read(&app).unwrap();
        assert_eq!(migrated[&scope_legacy]["ses_old"], vec!["ses_old_parent".to_owned()]);
        assert!(!legacy_path.exists(), "legacy session-favorites.json should be removed after migration");
        let doc = crate::settings::document::read(&state_path).unwrap();
        assert_eq!(doc["ui"]["kept"], true);
        assert_eq!(doc[OWNER][&scope_legacy]["ses_old"], json!(["ses_old_parent"]));

        // Case 2: `state.yaml` already has `sessionFavorites` (TS data) and a legacy JSON file exists -> never overwrite.
        let dir2 = dunce::canonicalize(crate::shared::test_dir("favorites-no-overwrite")).unwrap();
        let app2 = test_app(&dir2, crate::opencode::Native::connect("opencode").unwrap());
        let state_path2 = dir2.join("state.yaml");
        let legacy_path2 = dir2.join(LEGACY_FILE);
        std::fs::write(&state_path2, format!("sessionFavorites:\n  {scope_ts}:\n    ses_ts: []\n")).unwrap();
        std::fs::write(&legacy_path2, json!({ &scope_legacy: { "ses_stale": [] } }).to_string()).unwrap();

        let kept = read(&app2).unwrap();
        assert!(kept.contains_key(&scope_ts));
        assert!(!kept.contains_key(&scope_legacy));
        let doc2 = crate::settings::document::read(&state_path2).unwrap();
        assert_eq!(doc2[OWNER][&scope_ts]["ses_ts"], json!([]));
        assert!(doc2[OWNER].get(&scope_legacy).is_none());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn state_yaml_favorites_protect_targets_ancestors_and_fail_closed_on_corrupt_yaml() {
        let dir = dunce::canonicalize(crate::shared::test_dir("favorites-fail-closed")).unwrap();
        let app = test_app(&dir, crate::opencode::Native::connect("opencode").unwrap());
        let state_path = dir.join("state.yaml");

        // Missing file protects nothing.
        assert!(!is_protected(&app, "ses_root"));

        // Valid state.yaml protects both direct favorite and its ancestor.
        let scope = "a".repeat(64);
        std::fs::write(&state_path, format!("sessionFavorites:\n  {scope}:\n    ses_child:\n      - ses_root\n"))
            .unwrap();
        assert!(is_protected(&app, "ses_child"));
        assert!(is_protected(&app, "ses_root"));
        assert!(!is_protected(&app, "ses_other"));

        // Corrupt state.yaml fails closed (protects everything).
        std::fs::write(&state_path, "sessionFavorites: [").unwrap();
        assert!(is_protected(&app, "ses_other"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn belonging_admits_root_and_linked_worktree_and_refuses_foreign_or_workspace_id() {
        let _serial = crate::git::test_git_serial().await;
        let root_base = dunce::canonicalize(crate::shared::test_dir("favorites-worktrees")).unwrap();
        let repo = root_base.join("repo");
        let linked = root_base.join("linked");
        let foreign = root_base.join("foreign");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&foreign).unwrap();

        let git = |dir: &std::path::Path, args: &[&str]| {
            let mut cmd = std::process::Command::new("git");
            cmd.current_dir(dir).args(args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            let out = cmd.output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "hello").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);
        git(&repo, &["worktree", "add", "-b", "wt", linked.to_str().unwrap()]);

        let repo_canon = dunce::canonicalize(&repo).unwrap();
        let linked_canon = dunce::canonicalize(&linked).unwrap();
        let foreign_canon = dunce::canonicalize(&foreign).unwrap();
        let repo_str = repo_canon.to_string_lossy().into_owned();
        let linked_str = linked_canon.to_string_lossy().into_owned();

        let mock_router = axum::Router::new()
            .route(
                "/api/location",
                axum::routing::get({
                    let d = repo_str.clone();
                    move || {
                        let d = d.clone();
                        async move {
                            Json(json!({
                                "directory": d,
                                "project": { "id": "prj_fav", "directory": d, "canonical": d }
                            }))
                        }
                    }
                }),
            )
            .route("/api/worktree/refresh", axum::routing::post(|| async { Json(json!({})) }))
            .route(
                "/api/worktree",
                axum::routing::get({
                    let r = repo_str.clone();
                    let l = linked_str.clone();
                    move || {
                        let r = r.clone();
                        let l = l.clone();
                        async move { Json(json!([{"directory": r}, {"directory": l}])) }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "opencode".into(),
            password: None,
            file: None,
            cookie: "cn".into(),
            token: false,
            skip: true,
            managed_local: false,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            root_base.join("config.yaml").to_str().unwrap(),
        ));
        let app = App::new(
            auth,
            0,
            root_base.clone(),
            root_base.clone(),
            false,
            settings,
            Value::Null,
            crate::opencode::Native::test_connection(addr),
            PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        );
        let wid = uuid::Uuid::new_v4();
        let workspace = Workspace {
            id: wid,
            request_id: None,
            path: repo_canon.clone(),
            name: None,
            status: "ready",
            proxy_path: format!("/workspaces/{wid}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({ "directory": repo_str }),
            temporary: None,
        };
        app.inner.lock().unwrap().workspaces.push(workspace.clone());

        let root_session = json!({ "id": "ses_root", "location": { "directory": repo_str } });
        let linked_session = json!({ "id": "ses_linked", "location": { "directory": linked_str } });
        let foreign_session =
            json!({ "id": "ses_foreign", "location": { "directory": foreign_canon.to_string_lossy() } });
        let scoped_session = json!({
            "id": "ses_ws",
            "location": { "directory": linked_str, "workspaceID": "ws_1" }
        });

        assert!(belonging(&app, &root_session, &workspace).await);
        assert!(belonging(&app, &linked_session, &workspace).await);
        assert!(!belonging(&app, &foreign_session, &workspace).await);
        assert!(!belonging(&app, &scoped_session, &workspace).await);
        server.abort();
        let _ = std::fs::remove_dir_all(&root_base);
    }
}
