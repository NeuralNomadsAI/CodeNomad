//! `settings/service.ts` and `server/routes/settings.ts` for the owners the UI uses: `config.yaml`
//! owners and `state.yaml`'s `ui`, shared with the TypeScript server, and the OpenCode config files.
mod conditional;
pub mod config_files;
pub mod document;
mod normalize;
mod patches;
pub mod profile;
mod remote_project_history;

use std::sync::Mutex;

use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{App, Error, Shared, error, shared::fastify, unavailable};
use document::{Doc, Location, Unreadable, merge, owner};
use normalize::{
    assert_voice_conversation_patch, check_conversation_default, host_only, normalize_config, normalize_server,
    sanitize_server, speech_pairing,
};
use patches::{apply_secure_env_vars_mask, preserve_legacy_transcript_defaults, strip_new_object_nulls};

/// Multi-backend server profiles: guarded like `routes/settings.ts`'s `guardServerProfiles`.
const SERVER_PROFILES: &[&str] = &["remoteServers"];

pub struct Settings {
    pub location: Location,
    write: Mutex<()>,
    #[cfg(test)]
    write_enter: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    #[cfg(test)]
    write_exit: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    #[cfg(test)]
    desktop_voice_env: Mutex<Option<(Option<String>, String)>>,
    #[cfg(test)]
    speech_env: Mutex<Option<(Option<String>, Option<String>)>>,
}

#[cfg(test)]
impl Settings {
    pub(crate) fn set_desktop_voice_env_for_test(&self, identity: Option<String>, channel: String) {
        *self.desktop_voice_env.lock().unwrap_or_else(|e| e.into_inner()) = Some((identity, channel));
    }
    pub(crate) fn desktop_voice_env_for_test(&self) -> Option<(Option<String>, String)> {
        self.desktop_voice_env.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub(crate) fn set_speech_env_for_test(&self, api_key: Option<&str>, base_url: Option<&str>) {
        *self.speech_env.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((api_key.map(str::to_owned), base_url.map(str::to_owned)));
    }
    pub(crate) fn speech_env_for_test(&self) -> Option<(Option<String>, Option<String>)> {
        self.speech_env.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub(crate) fn lock_write_for_test(&self) -> std::sync::MutexGuard<'_, ()> {
        self.write.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn arm_write_hooks(&self) -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Receiver<()>) {
        let (enter_tx, enter_rx) = tokio::sync::oneshot::channel();
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        *self.write_enter.lock().unwrap_or_else(|e| e.into_inner()) = Some(enter_tx);
        *self.write_exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(exit_tx);
        (enter_rx, exit_rx)
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Config,
    State,
}

pub enum Failure {
    Invalid(String),
    Unreadable,
    HostOnly,
    /// `MissionPreferenceConflictError`
    Conflict,
}
impl Failure {
    pub fn message(self) -> String {
        match self {
            Failure::Invalid(message) => message,
            Failure::Unreadable => "Settings document could not be read authoritatively".into(),
            Failure::HostOnly => "This setting can be changed on the host only".into(),
            Failure::Conflict => "Mission preferences changed; reload before saving".into(),
        }
    }
    fn response(self) -> Error {
        let status = match self {
            Failure::Invalid(_) => Status::BAD_REQUEST,
            Failure::Unreadable => Status::SERVICE_UNAVAILABLE,
            Failure::HostOnly => Status::FORBIDDEN,
            Failure::Conflict => Status::CONFLICT,
        };
        error(status, &self.message())
    }
}
impl From<Unreadable> for Failure {
    fn from(_: Unreadable) -> Self {
        Failure::Unreadable
    }
}

impl Settings {
    pub fn new(location: Location) -> Self {
        Settings {
            location,
            write: Mutex::new(()),
            #[cfg(test)]
            write_enter: Mutex::new(None),
            #[cfg(test)]
            write_exit: Mutex::new(None),
            #[cfg(test)]
            desktop_voice_env: Mutex::new(None),
            #[cfg(test)]
            speech_env: Mutex::new(None),
        }
    }
    fn file(&self, kind: Kind) -> &std::path::Path {
        if kind == Kind::Config { &self.location.config } else { &self.location.state }
    }

    /// `getServerId`: the persisted `server.serverId`, else a claimed identity saved there.
    pub fn server_id(&self) -> Result<Uuid, Box<dyn std::error::Error>> {
        let _write = self.write.lock().unwrap();
        let stored = |doc: &Doc| -> Result<Option<Uuid>, Box<dyn std::error::Error>> {
            match owner_strict(doc, "server").map_err(|_| "Invalid server settings")?.get("serverId") {
                None => Ok(None),
                Some(id) => Ok(Some(Uuid::try_parse(id.as_str().ok_or("Invalid server identity")?)?)),
            }
        };
        let unreadable = |_| "Settings document could not be read";
        if let Some(id) = stored(&document::read(&self.location.config).map_err(unreadable)?)? {
            return Ok(id);
        }
        let id = document::claim_identity(&self.location.config)?;
        let mut doc = document::read(&self.location.config).map_err(unreadable)?;
        if let Some(current) = stored(&doc)? {
            return if current == id { Ok(id) } else { Err("Conflicting persisted server identity".into()) };
        }
        let mut server = owner(doc.get("server"));
        server.insert("serverId".into(), json!(id));
        doc.insert("server".into(), Value::Object(server));
        document::write(&self.location.config, &doc)?;
        Ok(id)
    }

    /// `getDoc`: the display document (an unreadable one is empty); config is normalized,
    /// and repaired on disk only when it is read authoritatively.
    fn doc(&self, kind: Kind) -> Doc {
        let file = self.file(kind);
        if kind == Kind::State {
            let (mut current, order) = document::read_with_history_order(file).unwrap_or_default();
            remote_project_history::compact_doc(&mut current, None, &order);
            return current;
        }
        let current = document::read(file).unwrap_or_default();
        let normalized = normalize_config(current.clone());
        if normalized != current {
            let _write = self.write.lock().unwrap();
            if let Ok(fresh) = document::read(&self.location.config) {
                let repaired = normalize_config(fresh.clone());
                if repaired != fresh {
                    let _ = document::write(&self.location.config, &repaired);
                }
                return repaired;
            }
        }
        normalized
    }

    /// `getOwner`: a display owner (`server` normalized, anything else an empty mapping).
    pub fn owner(&self, kind: Kind, name: &str) -> Doc {
        let value = owner(self.doc(kind).get(name));
        if kind == Kind::Config && name == "server" { normalize_server(value) } else { value }
    }

    /// Reads the normalized `server` config owner under the settings write lock so derived state
    /// (such as the release feed monitor) updates strictly in commit order without inverting locks.
    pub fn with_server_owner_locked<T>(&self, f: impl FnOnce(&Doc) -> T) -> T {
        let _write = self.write.lock().unwrap();
        let current = document::read(&self.location.config).unwrap_or_default();
        let normalized = normalize_config(current.clone());
        if normalized != current {
            let _ = document::write(&self.location.config, &normalized);
        }
        let server = normalize_server(owner(normalized.get("server")));
        f(&server)
    }

    fn state_owner_with_order(&self, name: &str) -> (Doc, Vec<String>) {
        let file = self.file(Kind::State);
        let (mut current, mut order) = document::read_with_history_order(file).unwrap_or_default();
        if name == "ui"
            && let Some(compacted_order) = remote_project_history::compact_doc(&mut current, None, &order)
        {
            order = compacted_order;
        }
        (owner(current.get(name)), order)
    }

    /// `getRawConfigOwner`: fresh authority, without normalization or fallbacks.
    pub fn raw_config_owner(&self, name: &str) -> Result<Doc, Unreadable> {
        let value = owner_strict(&document::read(&self.location.config)?, name)?;
        if name == "ui" && value.get("settings").is_some_and(|s| !s.is_object()) {
            return Err(Unreadable);
        }
        Ok(value)
    }

    pub(crate) fn private_state_owner(&self, name: &str) -> Result<Doc, Unreadable> {
        self.private_state_owner_with_order(name).map(|(doc, _)| doc)
    }

    fn private_state_owner_with_order(&self, name: &str) -> Result<(Doc, Vec<String>), Unreadable> {
        let (mut doc, mut order) = document::read_with_history_order(&self.location.state)?;
        let _ = owner_strict(&doc, name)?;
        if name == "ui"
            && let Some(compacted_order) = remote_project_history::compact_doc(&mut doc, None, &order)
        {
            order = compacted_order;
        }
        Ok((owner_strict(&doc, name)?, order))
    }

    pub(crate) fn replace_private_state(
        &self,
        name: &str,
        key: &str,
        expected: Option<&Value>,
        value: Option<Value>,
    ) -> Result<bool, Unreadable> {
        let _write = self.write.lock().unwrap();
        let (mut doc, mut order) = document::read_with_history_order(&self.location.state)?;
        let history_order = remote_project_history::compact_doc(&mut doc, None, &order);
        if let Some(compacted) = &history_order {
            order = compacted.clone();
        }
        let mut owner = owner_strict(&doc, name)?;
        if owner.get(key) != expected {
            return Ok(false);
        }
        match value {
            Some(value) => owner.insert(key.to_owned(), value),
            None => owner.remove(key),
        };
        doc.insert(name.to_owned(), Value::Object(owner));
        let final_order = if !order.is_empty() { Some(order.as_slice()) } else { None };
        document::write_with_history_order(&self.location.state, &doc, final_order).map_err(|_| Unreadable)?;
        Ok(true)
    }

    /// `mergePatchOwner`: the merge starts from the document on disk now (an unreadable state
    /// document is refused rather than overwritten). Returns the saved owner.
    #[cfg(test)]
    pub fn patch(&self, kind: Kind, name: &str, patch: &Value) -> Result<Value, Failure> {
        self.patch_checked_with_order(kind, name, patch, &[], |_, _| Ok(())).map(|(saved, _)| saved)
    }
    pub(crate) fn patch_checked_committed(
        &self,
        kind: Kind,
        name: &str,
        patch: &Value,
        patch_history_order: &[String],
        mut check: impl FnMut(&Doc, &Doc) -> Result<(), Failure>,
        on_committed: impl FnOnce(&Value, &[String]),
    ) -> Result<(Value, Vec<String>), Failure> {
        if !patch.is_object() {
            return Err(Failure::Invalid("Patch must be a JSON object".into()));
        }
        #[cfg(test)]
        struct ExitSignal<'a>(&'a Mutex<Option<tokio::sync::oneshot::Sender<()>>>);
        #[cfg(test)]
        impl Drop for ExitSignal<'_> {
            fn drop(&mut self) {
                if let Some(tx) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = tx.send(());
                }
            }
        }
        #[cfg(test)]
        let _exit_signal = ExitSignal(&self.write_exit);
        #[cfg(test)]
        if let Some(tx) = self.write_enter.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(());
        }
        let _write = self.write.lock().unwrap();
        let file = self.file(kind);
        let (mut before, mut combined_order) = if kind == Kind::State {
            document::read_with_history_order(file)?
        } else {
            (document::read(file)?, Vec::new())
        };
        if kind == Kind::State
            && let Some(before_order) = remote_project_history::compact_doc(&mut before, None, &combined_order)
        {
            combined_order = before_order;
        }
        let effective = if kind == Kind::Config && name == "ui" {
            preserve_legacy_transcript_defaults(before.get("ui"), patch)
        } else if kind == Kind::Config && name == "server" {
            let current = owner_strict(&before, "server")?;
            let paired = speech_pairing(patch, &current);
            std::borrow::Cow::Owned(apply_secure_env_vars_mask(before.get("server"), &paired)?.into_owned())
        } else if kind == Kind::State && name != "sessionPermissionBlocks" {
            strip_new_object_nulls(before.get(name), patch)
        } else {
            std::borrow::Cow::Borrowed(patch)
        };
        let merged = owner(Some(&merge(&Value::Object(owner(before.get(name))), effective.as_ref())));
        let merged = if kind == Kind::Config && name == "server" { normalize_server(merged) } else { merged };
        let mut doc = before.clone();
        doc.insert(name.into(), Value::Object(merged));
        let history_order = if kind == Kind::State {
            let mut seen: std::collections::HashSet<String> = combined_order.iter().cloned().collect();
            for key in patch_history_order {
                if seen.insert(key.clone()) {
                    combined_order.push(key.clone());
                }
            }
            remote_project_history::compact_doc(&mut doc, Some(&before), &combined_order)
        } else {
            None
        };
        check(&before, &doc)?;
        let mut rename_failure: Option<Failure> = None;
        let write_result = document::write_with_history_order_checked(file, &doc, history_order.as_deref(), || {
            if let Err(failure) = check(&before, &doc) {
                rename_failure = Some(failure);
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "pre-rename check rejected"));
            }
            Ok(())
        });
        if let Some(failure) = rename_failure {
            return Err(failure);
        }
        write_result.map_err(|e| Failure::Invalid(e.to_string()))?;
        let final_order = history_order.unwrap_or(combined_order);
        let saved = Value::Object(owner(doc.get(name)));
        on_committed(&saved, &final_order);
        Ok((saved, final_order))
    }
    #[cfg(test)]
    fn patch_checked_with_order(
        &self,
        kind: Kind,
        name: &str,
        patch: &Value,
        patch_history_order: &[String],
        check: impl FnMut(&Doc, &Doc) -> Result<(), Failure>,
    ) -> Result<(Value, Vec<String>), Failure> {
        self.patch_checked_committed(kind, name, patch, patch_history_order, check, |_, _| {})
    }
}

/// `getAuthoritativeOwner`: a present owner that is not a mapping is unreadable.
fn owner_strict(doc: &Doc, name: &str) -> Result<Doc, Unreadable> {
    match doc.get(name) {
        None => Ok(Doc::new()),
        Some(Value::Object(value)) => Ok(value.clone()),
        Some(_) => Err(Unreadable),
    }
}

/// `SettingsService.publish` for an owner write.
fn publish(app: &App, kind: Kind, name: &str, value: Value) {
    publish_with_order(app, kind, name, value, &[]);
}

fn publish_with_order(app: &App, kind: Kind, name: &str, value: Value, history_order: &[String]) {
    if kind == Kind::Config
        && name == "server"
        && let Some(map) = value.as_object()
    {
        app.releases.set_feed(crate::meta::update_feed(map));
    }
    let (event_type, value) = match kind {
        Kind::Config => ("storage.configChanged", sanitized(name, value)),
        Kind::State => (
            "storage.stateChanged",
            if matches!(name, "sessionFavorites" | "sessionPermissionBlocks") { json!({}) } else { value },
        ),
    };
    let event = json!({"type": event_type, "owner": name, "value": value});
    if kind == Kind::State
        && name == "ui"
        && !history_order.is_empty()
        && let Some(map) = event["value"].as_object()
    {
        #[derive(serde::Serialize)]
        struct OrderedEvent<'a> {
            #[serde(rename = "type")]
            event_type: &'a str,
            owner: &'a str,
            value: remote_project_history::OrderedStateOwner<'a>,
        }
        if let Ok(text) = serde_json::to_string(&OrderedEvent {
            event_type,
            owner: name,
            value: remote_project_history::OrderedStateOwner(map, history_order),
        }) {
            app.emit_serialized(event, text);
            return;
        }
    }
    app.emit(event);
}
fn sanitized(name: &str, value: Value) -> Value {
    match value {
        Value::Object(server) if name == "server" => Value::Object(sanitize_server(server)),
        value => value,
    }
}

/// `mergePatchOwner` for other domains (memory, SideCars, Stats), published like the reference's.
pub fn patch_owner(app: &App, kind: Kind, name: &str, patch: Value) -> Result<Value, Failure> {
    patch_owner_checked(app, kind, name, patch, |_, _| Ok(()), || {})
}

/// `mergePatchOwner` with a pre-commit authorization check and post-commit hook executed under the
/// settings write lock.
pub fn patch_owner_checked(
    app: &App,
    kind: Kind,
    name: &str,
    patch: Value,
    check: impl FnMut(&Doc, &Doc) -> Result<(), Failure>,
    on_committed: impl FnOnce(),
) -> Result<Value, Failure> {
    let (saved, _) = app.settings.patch_checked_committed(kind, name, &patch, &[], check, |saved, order| {
        on_committed();
        publish_with_order(app, kind, name, saved.clone(), order);
    })?;
    Ok(saved)
}

pub fn routes() -> Router<Shared> {
    let unavailable = || async { unavailable() };
    Router::new()
        .route("/api/storage/config/{owner}", get(read_config).patch(patch_config).fallback(unavailable))
        .route("/api/storage/state/ui", get(read_state).patch(patch_state).fallback(unavailable))
        .merge(config_files::routes())
}

async fn read_config(
    State(app): State<Shared>,
    Path(name): Path<String>,
    Query(query): Query<Vec<(String, String)>>,
) -> Result<Response, Error> {
    let authoritative = query.iter().any(|(key, value)| key == "authoritative" && value == "1");
    Ok(match name.as_str() {
        "ui" => Json(app.settings.raw_config_owner("ui").map_err(|e| Failure::from(e).response())?).into_response(),
        "server" => {
            let server = if authoritative {
                normalize_server(app.settings.raw_config_owner("server").map_err(|e| Failure::from(e).response())?)
            } else {
                app.settings.owner(Kind::Config, "server")
            };
            Json(sanitize_server(server)).into_response()
        }
        _ => unavailable(),
    })
}

/// `PATCH /api/storage/config/:owner`, or `?conditional=missions-v1` for the Missions preferences.
async fn patch_config(
    State(app): State<Shared>,
    Path(name): Path<String>,
    Query(query): Query<Vec<(String, String)>>,
    channel: Option<Extension<crate::auth::tls::Channel>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Response, Error> {
    let patch = match fastify::body(&headers, &bytes)? {
        None => json!({}),
        Some(fastify::Body::Json(value)) => value,
        Some(fastify::Body::Text(text)) => Value::String(text),
    };
    let mut conditionals = query.into_iter().filter_map(|(key, mode)| (key == "conditional").then_some(mode));
    let conditional = match (conditionals.next(), conditionals.next()) {
        (None, _) => None,
        (Some(mode), None) => Some(mode),
        (Some(_), Some(_)) => return Err(Failure::Invalid("Unknown conditional patch mode".into()).response()),
    };
    let mut binary_changed = false;
    let saved = match conditional.as_deref() {
        Some("missions-v1") => conditional::apply_committed(&app.settings, &name, &patch, |saved| {
            publish(&app, Kind::Config, &name, saved.clone());
        }),
        Some(mode) if mode != "atomic-v1" => Err(Failure::Invalid("Unknown conditional patch mode".into())),
        None | Some(_) => {
            let patch = if patch.is_null() { json!({}) } else { patch };
            if name == "server" {
                assert_voice_conversation_patch(&patch).map_err(Failure::response)?;
            }
            // Requests through the HTTPS listener are never local.
            let remote = channel.is_some();
            app.settings
                .patch_checked_committed(
                    Kind::Config,
                    &name,
                    &patch,
                    &[],
                    |before, after| {
                        if remote {
                            host_only(before, after)?;
                        }
                        if name == "ui" {
                            check_conversation_default(before, after)?;
                        }
                        if name == "server" {
                            let before_bin = before.get("server").and_then(|s| s.get("opencodeBinary"));
                            let after_bin = after.get("server").and_then(|s| s.get("opencodeBinary"));
                            binary_changed = before_bin != after_bin;
                        }
                        Ok(())
                    },
                    |saved, _| publish(&app, Kind::Config, &name, saved.clone()),
                )
                .map(|(saved, _)| saved)
        }
    };
    let saved = saved.map_err(Failure::response)?;
    if binary_changed {
        let app_adopt = app.clone();
        // Detach so cancelling this HTTP request (e.g. remote device revocation) never leaves
        // the active binary selection behind the already-committed profile change.
        let _ = tokio::spawn(async move {
            crate::opencode::adopt_configured_binary(&app_adopt).await;
            crate::opencode::login_start::refresh(&app_adopt);
        })
        .await;
    }
    Ok(Json(sanitized(&name, saved)).into_response())
}

async fn read_state(State(app): State<Shared>, Query(query): Query<Vec<(String, String)>>) -> Result<Response, Error> {
    let authoritative = query.iter().any(|(key, value)| key == "authoritative" && value == "1");
    let (doc, order) = if authoritative {
        let _write = app.settings.write.lock().unwrap();
        app.settings.private_state_owner_with_order("ui").map_err(|e| Failure::from(e).response())?
    } else {
        app.settings.state_owner_with_order("ui")
    };
    Ok(Json(remote_project_history::OrderedStateOwner(&doc, &order)).into_response())
}
async fn patch_state(State(app): State<Shared>, request: axum::extract::Request) -> Result<Response, Error> {
    let allow_profiles = crate::previews::backend::enabled(&app)
        && crate::auth::tls::https_only(&request).is_none()
        && request.extensions().get::<crate::auth::Principal>().is_some_and(|p| !p.0.is_cancelled());
    let (head, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .map_err(|_| error(Status::PAYLOAD_TOO_LARGE, "Request body is too large"))?;
    // Fastify's parsers, then `request.body ?? {}`.
    let patch = match fastify::body(&head.headers, &bytes)? {
        None | Some(fastify::Body::Json(Value::Null)) => json!({}),
        Some(fastify::Body::Json(value)) => value,
        Some(fastify::Body::Text(text)) => Value::String(text),
    };
    let profiles = patch.get("remoteServers").is_some();
    if patch.as_object().is_some_and(|ui| SERVER_PROFILES.iter().any(|key| ui.contains_key(*key))) && !allow_profiles {
        return Ok(unavailable());
    }
    let history_order = remote_project_history::json_history_key_order(&bytes);
    let (saved, final_order) = app
        .settings
        .patch_checked_committed(
            Kind::State,
            "ui",
            &patch,
            &history_order,
            |_, _| Ok(()),
            |saved, order| publish_with_order(&app, Kind::State, "ui", saved.clone(), order),
        )
        .map_err(Failure::response)?;
    if profiles {
        app.previews.owners.reconcile(&app);
    }
    Ok(match saved.as_object() {
        Some(map) => Json(remote_project_history::OrderedStateOwner(map, &final_order)).into_response(),
        None => Json(saved).into_response(),
    })
}

#[cfg(test)]
mod tests;
