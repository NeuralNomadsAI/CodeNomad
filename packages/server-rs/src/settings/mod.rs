//! `settings/service.ts` and `server/routes/settings.ts` for the owners the UI uses: `config.yaml`
//! owners and `state.yaml`'s `ui`, shared with the TypeScript server, and the OpenCode config files.
mod conditional;
pub mod config_files;
pub mod document;

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

/// Multi-backend profiles and their history: not served by this host, never rewritten here.
const SERVER_PROFILES: &[&str] =
    &["remoteServers", "remoteProjectHistory", "remoteProjectRecents", "remoteProjectHistoryExplicitOnly"];

pub struct Settings {
    pub location: Location,
    write: Mutex<()>,
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
    fn response(self) -> Error {
        match self {
            Failure::Invalid(message) => error(Status::BAD_REQUEST, &message),
            Failure::Unreadable => {
                error(Status::SERVICE_UNAVAILABLE, "Settings document could not be read authoritatively")
            }
            Failure::HostOnly => error(Status::FORBIDDEN, "This setting can be changed on the host only"),
            Failure::Conflict => error(Status::CONFLICT, "Mission preferences changed; reload before saving"),
        }
    }
}
impl From<Unreadable> for Failure {
    fn from(_: Unreadable) -> Self {
        Failure::Unreadable
    }
}

/// `normalizeServerConfigOwner`.
fn normalize_server(mut server: Doc) -> Doc {
    if let Some(level) = server.get("logLevel") {
        let canonical = level.as_str().map(|s| s.trim().to_uppercase());
        let valid = canonical.filter(|s| ["DEBUG", "INFO", "WARN", "ERROR"].contains(&s.as_str()));
        server.insert("logLevel".into(), json!(valid.unwrap_or_else(|| "DEBUG".into())));
    }
    if server.get("updateFeed").is_some_and(|feed| feed != "stable" && feed != "preview") {
        server.remove("updateFeed");
    }
    if server.get("opencodeBinary").is_some_and(|binary| binary == "opencode") {
        server.insert("opencodeBinary".into(), json!("opencode2"));
    }
    server
}
fn normalize_config(mut doc: Doc) -> Doc {
    if let Some(Value::Object(server)) = doc.get_mut("server") {
        *server = normalize_server(std::mem::take(server));
    }
    doc
}

/// `sanitizeServerOwner`: speech keys are replaced by `hasApiKey`.
fn sanitize_server(mut server: Doc) -> Doc {
    let Some(Value::Object(speech)) = server.get_mut("speech") else { return server };
    let hide = |owner: &mut Doc| {
        if owner.get("apiKey").and_then(Value::as_str).is_some_and(|key| !key.trim().is_empty()) {
            owner.remove("apiKey");
            owner.insert("hasApiKey".into(), json!(true));
        } else if !owner.contains_key("hasApiKey") {
            owner.insert("hasApiKey".into(), json!(false));
        }
    };
    hide(speech);
    for direction in ["stt", "tts"] {
        if let Some(Value::Object(sub)) = speech.get_mut(direction) {
            hide(sub);
        }
    }
    server
}

impl Settings {
    pub fn new(location: Location) -> Self {
        Settings { location, write: Mutex::new(()) }
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
        let current = document::read(self.file(kind)).unwrap_or_default();
        if kind == Kind::State {
            return current;
        }
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

    /// `getRawConfigOwner`: fresh authority, without normalization or fallbacks.
    pub fn raw_config_owner(&self, name: &str) -> Result<Doc, Unreadable> {
        let value = owner_strict(&document::read(&self.location.config)?, name)?;
        if name == "ui" && value.get("settings").is_some_and(|s| !s.is_object()) {
            return Err(Unreadable);
        }
        Ok(value)
    }

    /// `mergePatchOwner`: the merge starts from the document on disk now (an unreadable state
    /// document is refused rather than overwritten). Returns the saved owner.
    pub fn patch(&self, kind: Kind, name: &str, patch: &Value) -> Result<Value, Failure> {
        self.patch_checked(kind, name, patch, |_, _| Ok(()))
    }
    /// `mergePatchOwner` with its `ConfigWriteCheck`: `check` sees the document on disk and the result.
    pub fn patch_checked(
        &self,
        kind: Kind,
        name: &str,
        patch: &Value,
        check: impl FnOnce(&Doc, &Doc) -> Result<(), Failure>,
    ) -> Result<Value, Failure> {
        if !patch.is_object() {
            return Err(Failure::Invalid("Patch must be a JSON object".into()));
        }
        let _write = self.write.lock().unwrap();
        let file = self.file(kind);
        let before = document::read(file)?;
        let merged = owner(Some(&merge(&Value::Object(owner(before.get(name))), patch)));
        let merged = if kind == Kind::Config && name == "server" { normalize_server(merged) } else { merged };
        let mut doc = before.clone();
        doc.insert(name.into(), Value::Object(merged.clone()));
        check(&before, &doc)?;
        document::write(file, &doc).map_err(|e| Failure::Invalid(e.to_string()))?;
        Ok(Value::Object(merged))
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
    let (kind, value) = match kind {
        Kind::Config => ("storage.configChanged", sanitized(name, value)),
        Kind::State => ("storage.stateChanged", value),
    };
    app.emit(json!({"type": kind, "owner": name, "value": value}));
}
fn sanitized(name: &str, value: Value) -> Value {
    match value {
        Value::Object(server) if name == "server" => Value::Object(sanitize_server(server)),
        value => value,
    }
}

/// A configuration owner merge for other domains (memory), published like the reference's.
pub fn patch_owner(app: &App, name: &str, patch: Value) -> Result<Value, Failure> {
    let saved = app.settings.patch(Kind::Config, name, &patch)?;
    publish(app, Kind::Config, name, saved.clone());
    Ok(saved)
}

pub fn routes() -> Router<Shared> {
    let unavailable = || async { unavailable() };
    Router::new()
        .route("/api/storage/config/{owner}", get(read_config).patch(patch_config).fallback(unavailable))
        .route("/api/storage/state/ui", get(read_state).patch(patch_state).fallback(unavailable))
        .merge(config_files::routes())
}

async fn read_config(State(app): State<Shared>, Path(name): Path<String>) -> Result<Response, Error> {
    Ok(match name.as_str() {
        "ui" => Json(app.settings.raw_config_owner("ui").map_err(|e| Failure::from(e).response())?).into_response(),
        "server" => Json(sanitize_server(app.settings.owner(Kind::Config, "server"))).into_response(),
        _ => unavailable(),
    })
}
/// `HOST_ONLY_SERVER_KEYS` and `hostOnlyServerCheck`: a non-local request may not flip them.
const HOST_ONLY: &[&str] = &["sidecarsOverDirectHttps"];
fn host_only(before: &Doc, after: &Doc) -> Result<(), Failure> {
    let enabled = |doc: &Doc, key: &str| doc.get("server").and_then(|s| s.get(key)) == Some(&json!(true));
    match HOST_ONLY.iter().all(|key| enabled(before, key) == enabled(after, key)) {
        true => Ok(()),
        false => Err(Failure::HostOnly),
    }
}

/// `enforceSpeechCredentialPairing`: a changed base URL saved without its key clears the stored key.
fn speech_pairing(patch: &Value, current: &Doc) -> Value {
    let mut patch = patch.clone();
    let Some(Value::Object(speech)) = patch.get_mut("speech") else { return patch };
    let current = current.get("speech").and_then(Value::as_object);
    let current = current.and_then(|c| c.get("speech").and_then(Value::as_object)).or(current);
    let url = |o: Option<&Doc>| o.and_then(|o| o.get("baseUrl")).filter(|v| !v.is_null()).cloned().unwrap_or(json!(""));
    let unpaired = |patch: &Doc, current: Option<&Doc>| {
        patch.contains_key("baseUrl") && !patch.contains_key("apiKey") && url(Some(patch)) != url(current)
    };
    if unpaired(speech, current) {
        speech.insert("apiKey".into(), Value::Null);
    }
    for direction in ["stt", "tts"] {
        if let Some(sub) = speech.get_mut(direction) {
            let mut fields = sub.as_object().cloned().unwrap_or_default();
            if fields.contains_key("baseUrl") && !fields.contains_key("apiKey") {
                if unpaired(&fields, current.and_then(|c| c.get(direction)).and_then(Value::as_object)) {
                    fields.insert("apiKey".into(), Value::Null);
                }
                *sub = Value::Object(fields);
            }
        }
    }
    patch
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
    let mut patch = match fastify::body(&headers, &bytes)? {
        None => json!({}),
        Some(fastify::Body::Json(value)) => value,
        Some(fastify::Body::Text(text)) => Value::String(text),
    };
    let conditional = query.into_iter().find(|(key, _)| key == "conditional").map(|(_, mode)| mode);
    let saved = match conditional {
        Some(mode) if mode != "missions-v1" => Err(Failure::Invalid("Unknown conditional patch mode".into())),
        Some(_) => conditional::apply(&app.settings, &name, &patch),
        None => {
            if name == "server" {
                let current = app.settings.raw_config_owner("server").map_err(|e| Failure::from(e).response())?;
                patch = speech_pairing(&patch, &current);
            }
            // Requests through the HTTPS listener are never local.
            let remote = channel.is_some();
            app.settings.patch_checked(Kind::Config, &name, &patch, |before, after| match remote {
                true => host_only(before, after),
                false => Ok(()),
            })
        }
    };
    let saved = saved.map_err(Failure::response)?;
    publish(&app, Kind::Config, &name, saved.clone());
    Ok(Json(sanitized(&name, saved)).into_response())
}

async fn read_state(State(app): State<Shared>) -> Json<Doc> {
    Json(app.settings.owner(Kind::State, "ui"))
}
async fn patch_state(State(app): State<Shared>, headers: HeaderMap, bytes: Bytes) -> Result<Response, Error> {
    // Fastify's parsers, then `request.body ?? {}`.
    let patch = match fastify::body(&headers, &bytes)? {
        None => json!({}),
        Some(fastify::Body::Json(value)) => value,
        Some(fastify::Body::Text(text)) => Value::String(text),
    };
    if patch.as_object().is_some_and(|ui| SERVER_PROFILES.iter().any(|key| ui.contains_key(*key))) {
        return Ok(unavailable());
    }
    let saved = app.settings.patch(Kind::State, "ui", &patch).map_err(Failure::response)?;
    publish(&app, Kind::State, "ui", saved.clone());
    Ok(Json(saved).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_owner_is_normalized_and_sanitized() {
        let server = json!({"logLevel": " info ", "updateFeed": "dev", "opencodeBinary": "opencode",
            "speech": {"apiKey": " k ", "stt": {"apiKey": ""}, "tts": {"hasApiKey": true}}});
        let normalized = normalize_server(owner(Some(&server)));
        assert_eq!(
            Value::Object(normalized.clone()),
            json!({"logLevel": "INFO", "opencodeBinary": "opencode2",
            "speech": {"apiKey": " k ", "stt": {"apiKey": ""}, "tts": {"hasApiKey": true}}})
        );
        assert_eq!(normalize_server(owner(Some(&json!({"logLevel": 3}))))["logLevel"], "DEBUG");
        assert_eq!(
            Value::Object(sanitize_server(normalized))["speech"],
            json!({"hasApiKey": true,
            "stt": {"apiKey": "", "hasApiKey": false}, "tts": {"hasApiKey": true}})
        );
    }

    #[test]
    fn speech_keys_follow_their_base_url() {
        let current = owner(Some(&json!({"speech": {"baseUrl": "a", "stt": {"baseUrl": "s"}}})));
        let patch = json!({"speech": {"baseUrl": "b", "stt": {"baseUrl": "s"}, "tts": {"baseUrl": "t"}}});
        assert_eq!(
            speech_pairing(&patch, &current),
            json!({"speech": {"baseUrl": "b", "apiKey": null,
            "stt": {"baseUrl": "s"}, "tts": {"baseUrl": "t", "apiKey": null}}})
        );
        let kept = json!({"speech": {"baseUrl": "a", "apiKey": "new"}});
        assert_eq!(speech_pairing(&kept, &current), kept);
    }

    #[test]
    fn remote_writes_cannot_flip_host_only_settings() {
        let doc = |value: Value| owner(Some(&value));
        let (off, on) = (doc(json!({"server": {}})), doc(json!({"server": {"sidecarsOverDirectHttps": true}})));
        assert!(matches!(host_only(&off, &on), Err(Failure::HostOnly)));
        assert!(matches!(host_only(&on, &doc(json!({}))), Err(Failure::HostOnly)));
        assert!(host_only(&on, &doc(json!({"server": {"sidecarsOverDirectHttps": true, "x": 1}}))).is_ok());
    }

    #[test]
    fn owners_follow_the_reference_documents() {
        let dir = crate::shared::test_dir("settings-patch");
        let settings = Settings::new(Location::resolve(dir.join("config.yaml").to_str().unwrap()));
        let id = settings.server_id().unwrap();
        assert_eq!(settings.server_id().unwrap(), id);
        let saved = settings.patch(Kind::Config, "server", &json!({"logLevel": "warn", "x": null})).ok();
        assert_eq!(saved, Some(json!({"serverId": id, "logLevel": "WARN"})));
        assert!(matches!(settings.patch(Kind::Config, "ui", &json!([1])), Err(Failure::Invalid(_))));
        settings.patch(Kind::State, "ui", &json!({"recentFolders": [{"path": "p"}]})).ok().unwrap();
        assert_eq!(settings.owner(Kind::State, "ui")["recentFolders"][0]["path"], "p");
        // An unreadable document is displayed empty and never overwritten.
        std::fs::write(&settings.location.state, "a: [\n").unwrap();
        assert!(settings.owner(Kind::State, "ui").is_empty());
        assert!(matches!(settings.patch(Kind::State, "ui", &json!({"a": 1})), Err(Failure::Unreadable)));
        assert_eq!(std::fs::read_to_string(&settings.location.state).unwrap(), "a: [\n");
        // A legacy binary name is repaired on read; a malformed UI owner is unreadable.
        std::fs::write(&settings.location.config, "server:\n  opencodeBinary: opencode\nui:\n  settings: 1\n").unwrap();
        assert_eq!(Value::Object(settings.owner(Kind::Config, "server")), json!({"opencodeBinary": "opencode2"}));
        assert!(std::fs::read_to_string(&settings.location.config).unwrap().contains("opencode2"));
        assert_eq!(settings.raw_config_owner("ui"), Err(Unreadable));
        let _ = std::fs::remove_dir_all(dir);
    }
}
