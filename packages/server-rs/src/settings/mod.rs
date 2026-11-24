//! `settings/service.ts` and `server/routes/settings.ts` for the owners the UI uses: `config.yaml`
//! owners and `state.yaml`'s `ui`, shared with the TypeScript server, and the OpenCode config files.
mod conditional;
pub mod config_files;
pub mod document;
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

/// Multi-backend server profiles: guarded like `routes/settings.ts`'s `guardServerProfiles`.
const SERVER_PROFILES: &[&str] = &["remoteServers"];

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

/// `normalizeServerConfigOwner`.
fn normalize_server(mut server: Doc) -> Doc {
    if let Some(level) = server.get("logLevel") {
        let canonical = level.as_str().map(|s| js_trim(s).to_uppercase());
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

/// ECMAScript `String.prototype.trim()` whitespace (excludes U+0085 NEL, includes U+FEFF BOM).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
}

/// `voice-conversation-config.ts`: shared JS-trim and field validation.
fn vc_trimmed(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).map(js_trim)
}
fn vc_valid_api_key(v: Option<&Value>) -> bool {
    vc_trimmed(v).is_some_and(|s| !s.is_empty() && s.len() <= 4096 && s.bytes().all(|b| (0x21..=0x7e).contains(&b)))
}
fn vc_valid_model(v: Option<&Value>) -> Option<&str> {
    vc_trimmed(v).filter(|s| {
        !s.is_empty()
            && s.len() <= 256
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
    })
}
fn vc_valid_voice(v: Option<&Value>) -> Option<&str> {
    vc_trimmed(v).filter(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}
fn vc_valid_provider_patch(raw: &Doc) -> bool {
    raw.keys().all(|k| matches!(k.as_str(), "apiKey" | "model" | "voice"))
        && raw.get("apiKey").is_none_or(|v| v.is_null() || vc_valid_api_key(Some(v)))
        && raw.get("model").is_none_or(|v| v.is_null() || vc_valid_model(Some(v)).is_some())
        && raw.get("voice").is_none_or(|v| v.is_null() || vc_valid_voice(Some(v)).is_some())
}

/// `assertVoiceConversationPatch` (`packages/server/src/speech/voice-conversation-config.ts`).
fn assert_voice_conversation_patch(patch: &Value) -> Result<(), Failure> {
    let Some(vc) = patch.as_object().and_then(|o| o.get("voiceConversation")) else {
        return Ok(());
    };
    if vc.is_null() {
        return Ok(());
    }
    let valid = vc.as_object().is_some_and(|obj| {
        obj.keys().all(|k| matches!(k.as_str(), "geminiLive" | "openaiRealtime"))
            && obj.values().all(|v| v.is_null() || v.as_object().is_some_and(vc_valid_provider_patch))
    });
    if valid { Ok(()) } else { Err(Failure::Invalid("Invalid voice conversation settings patch".into())) }
}

/// `checkConversationDefault` (`packages/server/src/server/routes/settings.ts`).
fn check_conversation_default(before: &Doc, after: &Doc) -> Result<(), Failure> {
    fn mode(doc: &Doc) -> Option<&Value> {
        doc.get("ui")
            .and_then(Value::as_object)
            .and_then(|ui| ui.get("settings"))
            .and_then(Value::as_object)
            .and_then(|s| s.get("newConversationPermissions"))
    }
    let next = mode(after);
    if next != mode(before) {
        let valid = match next {
            None => true,
            Some(Value::String(s)) if s == "autonomous" || s == "supervised" => true,
            _ => false,
        };
        if !valid {
            return Err(Failure::Invalid("Invalid new conversation permissions".into()));
        }
    }
    Ok(())
}

/// `publicVoiceConversationConfig` (`packages/server/src/speech/voice-conversation-config.ts`).
fn sanitize_voice_conversation(value: &Value) -> Option<Value> {
    let vc = value.as_object()?;
    let secrets: Vec<&str> = ["geminiLive", "openaiRealtime"]
        .into_iter()
        .filter_map(|p| vc.get(p).and_then(Value::as_object).and_then(|o| vc_trimmed(o.get("apiKey"))))
        .collect();
    let project = |provider: &str| {
        let Some(raw) = vc.get(provider).and_then(Value::as_object) else {
            return json!({ "hasApiKey": false });
        };
        let mut out = Doc::new();
        out.insert("hasApiKey".into(), json!(vc_valid_api_key(raw.get("apiKey"))));
        if let Some(model) = vc_valid_model(raw.get("model"))
            && !secrets.contains(&model)
        {
            out.insert("model".into(), json!(model));
        }
        if let Some(voice) = vc_valid_voice(raw.get("voice"))
            && vc_valid_provider_patch(raw)
            && !secrets.contains(&voice)
        {
            out.insert("voice".into(), json!(voice));
        }
        Value::Object(out)
    };
    Some(json!({
        "geminiLive": project("geminiLive"),
        "openaiRealtime": project("openaiRealtime"),
    }))
}

/// `sanitizeServerOwner`: speech and voiceConversation keys are replaced by `hasApiKey`.
fn sanitize_server(mut server: Doc) -> Doc {
    if let Some(vc) = server.remove("voiceConversation").and_then(|v| sanitize_voice_conversation(&v)) {
        server.insert("voiceConversation".into(), vc);
    }
    let hide = |owner: &mut Doc| {
        let key = owner.remove("apiKey");
        owner.insert(
            "hasApiKey".into(),
            json!(key.as_ref().and_then(Value::as_str).is_some_and(|s| !js_trim(s).is_empty())),
        );
    };
    let Some(Value::Object(speech)) = server.get_mut("speech") else {
        server.remove("speech");
        return server;
    };
    hide(speech);
    for direction in ["stt", "tts"] {
        if let Some(Value::Object(sub)) = speech.get_mut(direction) {
            hide(sub);
        } else {
            speech.remove(direction);
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
        check: impl FnOnce(&Doc, &Doc) -> Result<(), Failure>,
        on_committed: impl FnOnce(&Value, &[String]),
    ) -> Result<(Value, Vec<String>), Failure> {
        if !patch.is_object() {
            return Err(Failure::Invalid("Patch must be a JSON object".into()));
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
        document::write_with_history_order(file, &doc, history_order.as_deref())
            .map_err(|e| Failure::Invalid(e.to_string()))?;
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
        check: impl FnOnce(&Doc, &Doc) -> Result<(), Failure>,
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
    if kind == Kind::Config && matches!(name, "server" | "*") {
        app.releases.update_feed(&app.settings);
    }
    let (event_type, value) = match kind {
        Kind::Config => ("storage.configChanged", sanitized(name, value)),
        Kind::State => ("storage.stateChanged", value),
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
    let (saved, _) = app.settings.patch_checked_committed(
        kind,
        name,
        &patch,
        &[],
        |_, _| Ok(()),
        |saved, order| publish_with_order(app, kind, name, saved.clone(), order),
    )?;
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
        if let Some(Value::Object(fields)) = speech.get_mut(direction)
            && fields.contains_key("baseUrl")
            && !fields.contains_key("apiKey")
            && unpaired(fields, current.and_then(|c| c.get(direction)).and_then(Value::as_object))
        {
            fields.insert("apiKey".into(), Value::Null);
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
    let mut refresh_login = false;
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
                            refresh_login =
                                patch.get("opencodeBinary").is_some_and(|binary| Some(binary) != before_bin);
                        }
                        Ok(())
                    },
                    |saved, _| publish(&app, Kind::Config, &name, saved.clone()),
                )
                .map(|(saved, _)| saved)
        }
    };
    let saved = saved.map_err(Failure::response)?;
    if refresh_login {
        crate::opencode::login_start::refresh(&app);
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

const CONFIGURABLE_TOOLS: [&str; 15] = [
    "bash",
    "read",
    "write",
    "edit",
    "patch",
    "webfetch",
    "websearch",
    "glob",
    "grep",
    "task",
    "execute",
    "skill",
    "question",
    "invalid",
    "other",
];

fn tool_default_for_preset(
    preset: Option<&str>,
    tool: &str,
    base_tools: Option<&serde_json::Map<String, Value>>,
    base_tool_output: Option<&str>,
) -> &'static str {
    let other = base_tools.and_then(|t| t.get("other")).and_then(Value::as_str).and_then(|v| match v {
        "hidden" => Some("hidden"),
        "collapsed" => Some("collapsed"),
        "expanded" => Some("expanded"),
        _ => None,
    });
    match preset {
        Some("nothing") => "hidden",
        Some("everything") => "expanded",
        Some("minimal") => "collapsed",
        Some("detailed") => {
            if matches!(tool, "read" | "skill" | "invalid") {
                "collapsed"
            } else {
                other.unwrap_or("expanded")
            }
        }
        Some("custom") => other.unwrap_or_else(|| match base_tool_output {
            Some("collapsed") => "collapsed",
            _ => "expanded",
        }),
        _ => {
            if matches!(tool, "bash" | "write" | "edit" | "patch" | "task" | "execute" | "question") {
                "expanded"
            } else {
                "collapsed"
            }
        }
    }
}

fn transcript_preset_fallbacks(preset: Option<&str>) -> (&'static str, &'static str) {
    let groups = if preset == Some("everything") { "expanded" } else { "collapsed" };
    let usage = if matches!(preset, Some("everything" | "custom" | "detailed")) { "expanded" } else { "collapsed" };
    (groups, usage)
}

fn strip_null_entries_for_new_objects(base: Option<&Doc>, patch: &mut Doc) -> bool {
    let mut changed = false;
    if base.is_none() {
        let before = patch.len();
        patch.retain(|_, value| !value.is_null());
        changed |= patch.len() != before;
    }
    for (key, value) in patch.iter_mut() {
        if let Some(child) = value.as_object_mut() {
            let child_base = base.and_then(|map| map.get(key)).and_then(Value::as_object);
            changed |= strip_null_entries_for_new_objects(child_base, child);
        }
    }
    changed
}

const NOTIFICATION_CATEGORIES: [&str; 9] =
    ["needsInput", "sessionDone", "updates", "files", "projects", "sessions", "opencode", "copy", "settings"];
const NOTIFICATION_DESTINATIONS: [&str; 3] = ["screen", "history", "system"];

fn seed_notification_routing(base: Option<&Doc>, patch_routing: &Doc) -> Doc {
    let os_enabled = base.and_then(|s| s.get("osNotificationsEnabled")) != Some(&json!(false));
    let notify_input = base.and_then(|s| s.get("notifyOnNeedsInput")) != Some(&json!(false));
    let notify_idle = base.and_then(|s| s.get("notifyOnIdle")) != Some(&json!(false));
    let mut seeded = Doc::new();
    for category in NOTIFICATION_CATEGORIES {
        if patch_routing.get(category) == Some(&Value::Null) {
            continue;
        }
        let mut row = patch_routing.get(category).and_then(Value::as_object).cloned().unwrap_or_default();
        let screen = !matches!(category, "needsInput" | "sessionDone");
        let history = matches!(category, "updates" | "files" | "projects" | "opencode");
        let system = matches!(category, "needsInput" | "sessionDone" | "updates")
            && os_enabled
            && match category {
                "needsInput" => notify_input,
                "sessionDone" => notify_idle,
                _ => true,
            };
        for (dest, default) in NOTIFICATION_DESTINATIONS.into_iter().zip([screen, history, system]) {
            row.entry(dest.to_owned()).or_insert_with(|| json!(default));
        }
        seeded.insert(category.into(), Value::Object(row));
    }
    for (key, value) in patch_routing {
        seeded.entry(key.clone()).or_insert_with(|| value.clone());
    }
    seeded
}

fn strip_new_object_nulls<'a>(before: Option<&Value>, patch: &'a Value) -> std::borrow::Cow<'a, Value> {
    let Some(changes) = patch.as_object() else {
        return std::borrow::Cow::Borrowed(patch);
    };
    let mut next = changes.clone();
    if strip_null_entries_for_new_objects(before.and_then(Value::as_object), &mut next) {
        std::borrow::Cow::Owned(Value::Object(next))
    } else {
        std::borrow::Cow::Borrowed(patch)
    }
}

fn apply_secure_env_vars_mask<'a>(
    before: Option<&Value>,
    patch: &'a Value,
) -> Result<std::borrow::Cow<'a, Value>, Failure> {
    let Some(changes) = patch.as_object() else {
        return Ok(std::borrow::Cow::Borrowed(patch));
    };
    let before_obj = before.and_then(Value::as_object);
    let mut next = changes.clone();
    let mut modified = false;
    if let Some(mask_value) = changes.get("secureEnvVarsMask") {
        let Some(mask) = mask_value.as_object() else {
            return Err(Failure::Invalid("Invalid secureEnvVarsMask".into()));
        };
        if mask.values().any(|value| !value.is_boolean()) {
            return Err(Failure::Invalid("Invalid secureEnvVarsMask".into()));
        }
        next.remove("secureEnvVarsMask");
        modified = true;
        let mut surviving_env_keys: std::collections::HashSet<String> = before_obj
            .and_then(|s| s.get("environmentVariables"))
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, _)| k.clone())
            .collect();
        let mut deleted_env_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Some(env_patch) = changes.get("environmentVariables") {
            if env_patch.is_null() {
                deleted_env_keys.extend(surviving_env_keys.drain());
            } else if let Some(env_obj) = env_patch.as_object() {
                for (k, v) in env_obj {
                    if v.is_null() {
                        surviving_env_keys.remove(k);
                        deleted_env_keys.insert(k.clone());
                    } else {
                        surviving_env_keys.insert(k.clone());
                    }
                }
            }
        }
        let env_key_eq = |a: &str, b: &str| {
            if a.is_ascii() && b.is_ascii() { a.eq_ignore_ascii_case(b) } else { a.to_uppercase() == b.to_uppercase() }
        };
        let has_case_sibling = |name: &str| surviving_env_keys.iter().any(|k| k != name && env_key_eq(k, name));
        let mut masked: Vec<String> = if changes.get("secureEnvVars").is_some_and(Value::is_null) {
            Vec::new()
        } else {
            let source = changes
                .get("secureEnvVars")
                .and_then(Value::as_array)
                .or_else(|| before.and_then(|s| s.get("secureEnvVars")).and_then(Value::as_array));
            source.into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
        };
        let mut entries: Vec<(&String, bool)> =
            mask.iter().filter_map(|(name, value)| value.as_bool().map(|want| (name, want))).collect();
        entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        for (name, want_masked) in &entries {
            if !*want_masked {
                // Deleting one POSIX case-variant must not unmask a surviving sibling with another casing.
                if deleted_env_keys.contains(*name) && has_case_sibling(name) {
                    continue;
                }
                masked.retain(|existing| !env_key_eq(existing, name));
            }
        }
        for (name, want_masked) in &entries {
            if *want_masked {
                masked.retain(|existing| !env_key_eq(existing, name));
                masked.push((*name).clone());
            }
        }
        next.insert("secureEnvVars".into(), json!(masked));
    }
    let stripped = strip_null_entries_for_new_objects(before_obj, &mut next);
    if !modified && !stripped {
        return Ok(std::borrow::Cow::Borrowed(patch));
    }
    Ok(std::borrow::Cow::Owned(Value::Object(next)))
}

/// `preserveLegacyTranscriptDefaults` (`packages/server/src/settings/transcript-preset-defaults.ts`).
fn preserve_legacy_transcript_defaults<'a>(before: Option<&Value>, patch: &'a Value) -> std::borrow::Cow<'a, Value> {
    let Some(patch_obj) = patch.as_object() else {
        return std::borrow::Cow::Borrowed(patch);
    };
    let before_obj = before.and_then(Value::as_object);
    let Some(changes) = patch_obj.get("settings").and_then(Value::as_object) else {
        let mut next = patch_obj.clone();
        return if strip_null_entries_for_new_objects(before_obj, &mut next) {
            std::borrow::Cow::Owned(Value::Object(next))
        } else {
            std::borrow::Cow::Borrowed(patch)
        };
    };
    let base = before_obj.and_then(|owner| owner.get("settings")).and_then(Value::as_object);
    let base_defaults = base.and_then(|s| s.get("toolCallExpansionDefaults")).and_then(Value::as_object);
    let base_tools = base_defaults.and_then(|d| d.get("tools")).and_then(Value::as_object);
    let preset = base_defaults.and_then(|d| d.get("preset")).and_then(Value::as_str);
    let (inherited_groups, inherited_usage) = transcript_preset_fallbacks(preset);
    let (custom_groups, custom_usage) = transcript_preset_fallbacks(Some("custom"));
    let mut next_settings = changes.clone();
    let mut modified = false;

    if changes.get("showUsageMetrics").and_then(Value::as_bool) == Some(false)
        && !changes.contains_key("usageMetricsExpansion")
        && !matches!(
            base.and_then(|s| s.get("usageMetricsExpansion")).and_then(Value::as_str),
            Some("collapsed" | "expanded")
        )
    {
        next_settings.insert("usageMetricsExpansion".into(), json!(inherited_usage));
        modified = true;
    }

    if let Some(patch_defaults) = changes.get("toolCallExpansionDefaults").and_then(Value::as_object) {
        let mut next_defaults = patch_defaults.clone();
        let mut defaults_modified = false;
        if patch_defaults.get("preset").and_then(Value::as_str) == Some("custom") {
            for (key, inherited, custom, allow_hidden) in [
                ("toolGroupVisibility", inherited_groups, custom_groups, true),
                ("usageMetricsExpansion", inherited_usage, custom_usage, false),
            ] {
                if inherited == custom || changes.contains_key(key) || next_settings.contains_key(key) {
                    continue;
                }
                let saved = base.and_then(|s| s.get(key)).and_then(Value::as_str);
                if matches!(saved, Some("collapsed" | "expanded")) || (allow_hidden && saved == Some("hidden")) {
                    continue;
                }
                next_settings.insert(key.into(), json!(inherited));
                modified = true;
            }
            let explicit_non_object_tools = patch_defaults.get("tools").is_some_and(|v| !v.is_object());
            let touches_custom = patch_defaults.get("tools").is_some_and(Value::is_object)
                || changes.contains_key("showThinkingBlocks")
                || changes.contains_key("thinkingBlocksExpansion")
                || patch_defaults.contains_key("thinking");
            if touches_custom {
                let base_thinking = base_defaults.and_then(|d| d.get("thinking")).and_then(Value::as_str);
                if !patch_defaults.contains_key("thinking") && !matches!(base_thinking, Some("collapsed" | "expanded"))
                {
                    let source = if changes.contains_key("thinkingBlocksExpansion") {
                        changes.get("thinkingBlocksExpansion")
                    } else {
                        base.and_then(|s| s.get("thinkingBlocksExpansion"))
                    };
                    let legacy = source
                        .and_then(Value::as_str)
                        .filter(|v| matches!(*v, "collapsed" | "expanded"))
                        .unwrap_or("collapsed");
                    next_defaults.insert("thinking".into(), json!(legacy));
                    defaults_modified = true;
                }
            }
            let patch_tools = patch_defaults.get("tools").and_then(Value::as_object);
            let base_tool_output = base.and_then(|s| s.get("toolOutputExpansion")).and_then(Value::as_str);
            let next_other = if let Some(value) = patch_tools.and_then(|t| t.get("other")) {
                value.as_str().filter(|v| matches!(*v, "hidden" | "collapsed" | "expanded"))
            } else {
                base_tools
                    .and_then(|t| t.get("other"))
                    .and_then(Value::as_str)
                    .filter(|v| matches!(*v, "hidden" | "collapsed" | "expanded"))
            };
            let next_tool_output = if let Some(value) = changes.get("toolOutputExpansion") {
                value.as_str().filter(|v| matches!(*v, "collapsed" | "expanded"))
            } else {
                base_tool_output.filter(|v| matches!(*v, "collapsed" | "expanded"))
            };
            let custom_tool_fallback = next_other.or(next_tool_output).unwrap_or("expanded");
            let changes_any_tool = CONFIGURABLE_TOOLS.iter().any(|&tool| {
                let in_patch = patch_tools.is_some_and(|t| t.contains_key(tool));
                let in_base = base_tools
                    .and_then(|t| t.get(tool))
                    .and_then(Value::as_str)
                    .is_some_and(|v| matches!(v, "hidden" | "collapsed" | "expanded"));
                !in_patch
                    && !in_base
                    && tool_default_for_preset(preset, tool, base_tools, base_tool_output) != custom_tool_fallback
            });
            let should_materialize =
                !explicit_non_object_tools && ((preset != Some("custom") && touches_custom) || changes_any_tool);
            if should_materialize {
                let mut next_tools = patch_tools.cloned().unwrap_or_default();
                let mut added_tool = false;
                for tool in CONFIGURABLE_TOOLS {
                    let in_patch = patch_tools.is_some_and(|t| t.contains_key(tool));
                    let in_base = base_tools
                        .and_then(|t| t.get(tool))
                        .and_then(Value::as_str)
                        .is_some_and(|v| matches!(v, "hidden" | "collapsed" | "expanded"));
                    if in_patch || in_base {
                        continue;
                    }
                    next_tools.insert(
                        tool.into(),
                        json!(tool_default_for_preset(preset, tool, base_tools, base_tool_output)),
                    );
                    added_tool = true;
                }
                if added_tool {
                    next_defaults.insert("tools".into(), Value::Object(next_tools));
                    defaults_modified = true;
                }
            }
        }
        if defaults_modified {
            next_settings.insert("toolCallExpansionDefaults".into(), Value::Object(next_defaults));
            modified = true;
        }
    }
    if let Some(patch_routing) = changes.get("notificationRouting").and_then(Value::as_object)
        && base.and_then(|s| s.get("notificationRouting")).and_then(Value::as_object).is_none()
    {
        next_settings
            .insert("notificationRouting".into(), Value::Object(seed_notification_routing(base, patch_routing)));
        modified = true;
    }
    let mut next = patch_obj.clone();
    next.insert("settings".into(), Value::Object(next_settings));
    let stripped = strip_null_entries_for_new_objects(before_obj, &mut next);
    if !modified && !stripped {
        return std::borrow::Cow::Borrowed(patch);
    }
    std::borrow::Cow::Owned(Value::Object(next))
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
            "stt": {"hasApiKey": false}, "tts": {"hasApiKey": false}})
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

    #[test]
    fn legacy_transcript_defaults_derive_only_from_authoritative_absent_fields() {
        let dir = crate::shared::test_dir("settings-transcript-legacy");
        let settings = Settings::new(Location::resolve(dir.join("config.yaml").to_str().unwrap()));
        // Legacy Everything without saved toolGroupVisibility preserves expanded on switch to custom.
        settings
            .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "everything"}}}))
            .ok()
            .unwrap();
        let saved = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "collapsed"}}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(saved["settings"]["toolGroupVisibility"], "expanded");
        assert!(saved["settings"].get("usageMetricsExpansion").is_none());
        assert_eq!(saved["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");
        assert_eq!(saved["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "expanded");
        assert_eq!(saved["settings"]["toolCallExpansionDefaults"]["thinking"], "collapsed");

        // Balanced with thinkingBlocksExpansion: expanded and a concurrent skill edit keeps both.
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {
                    "showThinkingBlocks": true,
                    "thinkingBlocksExpansion": "expanded",
                    "toolCallExpansionDefaults": {"preset": "balanced", "thinking": null, "tools": null},
                    "toolGroupVisibility": "hidden"
                }}),
            )
            .ok()
            .unwrap();
        let first = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"skill": "hidden"}}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(first["settings"]["toolGroupVisibility"], "hidden");
        assert_eq!(first["settings"]["usageMetricsExpansion"], "collapsed");
        assert_eq!(first["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");
        assert_eq!(first["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "hidden");
        assert_eq!(first["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "expanded");
        assert_eq!(first["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");

        // A concurrent minimal patch for read arriving after skill:hidden keeps skill:hidden.
        let second = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "expanded"}}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(second["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "expanded");
        assert_eq!(second["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "hidden");

        // Retired detailed with other:hidden preserves hidden for unlisted tools like write.
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": null}}}),
            )
            .ok()
            .unwrap();
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": {"other": "hidden"}}}}),
            )
            .ok()
            .unwrap();
        let detailed = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "expanded"}}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(detailed["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "expanded");
        assert_eq!(detailed["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "hidden");
        assert_eq!(detailed["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "collapsed");

        // Retired detailed with tools.other: "hidden" switching to custom via thinking expansion alone
        // must still freeze read/skill/invalid at "collapsed" and other tools at "hidden".
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": null}}}),
            )
            .ok()
            .unwrap();
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": {"other": "hidden"}}}}),
            )
            .ok()
            .unwrap();
        let detailed_thinking = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"thinkingBlocksExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "thinking": "expanded"}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(detailed_thinking["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");
        assert_eq!(detailed_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");
        assert_eq!(detailed_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "hidden");

        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "thinking": null, "tools": null}}}),
            )
            .ok()
            .unwrap();
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed", "tools": {"other": "hidden"}}}}),
            )
            .ok()
            .unwrap();
        let detailed_legacy_thinking = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"thinkingBlocksExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom"}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(detailed_legacy_thinking["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");
        assert_eq!(detailed_legacy_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "collapsed");
        assert_eq!(detailed_legacy_thinking["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "hidden");

        // Partial custom hiding "other" freezes unlisted tools at their pre-patch effective value.
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolOutputExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "tools": null}}}),
            )
            .ok()
            .unwrap();
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"bash": "collapsed"}}}}),
            )
            .ok()
            .unwrap();
        let partial_custom = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"other": "hidden"}}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(partial_custom["settings"]["toolCallExpansionDefaults"]["tools"]["other"], "hidden");
        assert_eq!(partial_custom["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "collapsed");
        assert_eq!(partial_custom["settings"]["toolCallExpansionDefaults"]["tools"]["write"], "expanded");

        // Explicit tools: null deletion is honored rather than overwritten.
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "balanced", "tools": {"read": "hidden"}}}}),
            )
            .ok()
            .unwrap();
        let deleted = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"showThinkingBlocks": false, "toolCallExpansionDefaults": {"preset": "custom", "tools": null}}}),
            )
            .ok()
            .unwrap();
        assert!(deleted["settings"]["toolCallExpansionDefaults"].get("tools").is_none());

        // Explicit thinkingBlocksExpansion in the same PATCH is not clobbered by legacy fallback.
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"thinkingBlocksExpansion": "collapsed", "toolCallExpansionDefaults": {"preset": "balanced", "thinking": null, "tools": null}}}),
            )
            .ok()
            .unwrap();
        let explicit_thinking = settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"thinkingBlocksExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "expanded"}}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(explicit_thinking["settings"]["thinkingBlocksExpansion"], "expanded");
        assert_eq!(explicit_thinking["settings"]["toolCallExpansionDefaults"]["thinking"], "expanded");

        // Hiding Tokens on a partial detailed profile freezes implicit usageMetricsExpansion ("expanded"),
        // without clobbering an explicit concurrent usageMetricsExpansion ("collapsed").
        settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"usageMetricsExpansion": null, "toolCallExpansionDefaults": {"preset": "detailed"}}}),
            )
            .ok()
            .unwrap();
        let hidden_detailed_usage =
            settings.patch(Kind::Config, "ui", &json!({"settings": {"showUsageMetrics": false}})).ok().unwrap();
        assert_eq!(hidden_detailed_usage["settings"]["showUsageMetrics"], false);
        assert_eq!(hidden_detailed_usage["settings"]["usageMetricsExpansion"], "expanded");

        settings.patch(Kind::Config, "ui", &json!({"settings": {"usageMetricsExpansion": "collapsed"}})).ok().unwrap();
        let hidden_explicit_usage =
            settings.patch(Kind::Config, "ui", &json!({"settings": {"showUsageMetrics": false}})).ok().unwrap();
        assert_eq!(hidden_explicit_usage["settings"]["usageMetricsExpansion"], "collapsed");

        // Explicit null entries on a fresh empty profile strip nulls instead of storing null keys.
        let fresh_settings = Settings::new(Location::resolve(dir.join("fresh-config.yaml").to_str().unwrap()));
        let fresh_deleted = fresh_settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"showThinkingBlocks": false, "toolCallExpansionDefaults": {"preset": "custom", "thinking": null, "tools": null}}}),
            )
            .ok()
            .unwrap();
        assert!(fresh_deleted["settings"]["toolCallExpansionDefaults"].get("tools").is_none());
        assert!(fresh_deleted["settings"]["toolCallExpansionDefaults"].get("thinking").is_none());
        let fresh_usage_settings =
            Settings::new(Location::resolve(dir.join("fresh-usage-null.yaml").to_str().unwrap()));
        let fresh_usage_null = fresh_usage_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"showUsageMetrics": false, "usageMetricsExpansion": null}}))
            .ok()
            .unwrap();
        assert_eq!(fresh_usage_null["settings"]["showUsageMetrics"], false);
        assert!(fresh_usage_null["settings"].get("usageMetricsExpansion").is_none());
        let fresh_balanced_settings =
            Settings::new(Location::resolve(dir.join("fresh-balanced.yaml").to_str().unwrap()));
        let fresh_balanced = fresh_balanced_settings
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "balanced", "tools": null}}}),
            )
            .ok()
            .unwrap();
        assert!(fresh_balanced["settings"]["toolCallExpansionDefaults"].get("tools").is_none());

        // Pure preset:"custom" PATCH on a partial "nothing" profile preserves inherited hidden tools.
        let nothing_settings = Settings::new(Location::resolve(dir.join("nothing-config.yaml").to_str().unwrap()));
        nothing_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "nothing"}}}))
            .ok()
            .unwrap();
        let pure_custom = nothing_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom"}}}))
            .ok()
            .unwrap();
        assert_eq!(pure_custom["settings"]["usageMetricsExpansion"], "collapsed");
        assert_eq!(pure_custom["settings"]["toolCallExpansionDefaults"]["tools"]["read"], "hidden");
        assert_eq!(pure_custom["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "hidden");

        // Partial "detailed" profile without a tools object strips explicit read:null instead of persisting null.
        let detailed_null = Settings::new(Location::resolve(dir.join("detailed-null.yaml").to_str().unwrap()));
        detailed_null
            .patch(Kind::Config, "ui", &json!({"settings": {"toolCallExpansionDefaults": {"preset": "detailed"}}}))
            .ok()
            .unwrap();
        let detailed_deleted_read = detailed_null
            .patch(
                Kind::Config,
                "ui",
                &json!({"settings": {"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": null}}}}),
            )
            .ok()
            .unwrap();
        assert!(detailed_deleted_read["settings"]["toolCallExpansionDefaults"]["tools"].get("read").is_none());
        assert_eq!(detailed_deleted_read["settings"]["toolCallExpansionDefaults"]["tools"]["skill"], "collapsed");
        assert_eq!(detailed_deleted_read["settings"]["toolCallExpansionDefaults"]["tools"]["bash"], "expanded");

        // Deeply nested RFC 7396 nulls inside newly created containers under settings are stripped recursively.
        let nested_null_settings = Settings::new(Location::resolve(dir.join("nested-null.yaml").to_str().unwrap()));
        let nested_null = nested_null_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"sessionDone": {"system": null}}}}))
            .ok()
            .unwrap();
        assert_eq!(nested_null["settings"]["notificationRouting"]["sessionDone"]["screen"], false);
        assert!(nested_null["settings"]["notificationRouting"]["sessionDone"].get("system").is_none());

        // Top-level {settings: null} on an empty profile strips settings instead of storing null.
        let null_settings = Settings::new(Location::resolve(dir.join("null-settings.yaml").to_str().unwrap()));
        let stripped_ui = null_settings.patch(Kind::Config, "ui", &json!({"settings": null})).ok().unwrap();
        assert!(stripped_ui.get("settings").is_none());
        assert!(null_settings.raw_config_owner("ui").is_ok());

        // First notificationRouting migration seeds legacy flags under the write lock without clobbering concurrent cells.
        let routing_settings = Settings::new(Location::resolve(dir.join("routing.yaml").to_str().unwrap()));
        routing_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"osNotificationsEnabled": false, "notifyOnIdle": false}}))
            .ok()
            .unwrap();
        let routed1 = routing_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"copy": {"history": true}}}}))
            .ok()
            .unwrap();
        assert_eq!(routed1["settings"]["notificationRouting"]["copy"]["history"], true);
        assert_eq!(routed1["settings"]["notificationRouting"]["updates"]["system"], false);
        assert_eq!(routed1["settings"]["notificationRouting"]["sessionDone"]["system"], false);
        let routed2 = routing_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"files": {"screen": false}}}}))
            .ok()
            .unwrap();
        assert_eq!(routed2["settings"]["notificationRouting"]["copy"]["history"], true);
        assert_eq!(routed2["settings"]["notificationRouting"]["files"]["screen"], false);

        // Atomic secureEnvVarsMask merges concurrent secrets under the write lock without storing the transient key.
        let env_settings = Settings::new(Location::resolve(dir.join("env-mask.yaml").to_str().unwrap()));
        let first_env = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"SECRET_A": "1"}, "secureEnvVarsMask": {"SECRET_A": true}}),
            )
            .ok()
            .unwrap();
        assert_eq!(first_env["secureEnvVars"], json!(["SECRET_A"]));
        assert!(first_env.get("secureEnvVarsMask").is_none());
        let second_env = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"SECRET_B": "2"}, "secureEnvVarsMask": {"SECRET_B": true}}),
            )
            .ok()
            .unwrap();
        assert_eq!(second_env["secureEnvVars"], json!(["SECRET_A", "SECRET_B"]));
        let removed_env = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"SECRET_A": null}, "secureEnvVarsMask": {"SECRET_A": false}}),
            )
            .ok()
            .unwrap();
        assert_eq!(removed_env["secureEnvVars"], json!(["SECRET_B"]));

        // Unicode case-folding matches Solid's toUpperCase() (É_TOKEN and é_TOKEN share one mask entry).
        let accented1 = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"É_TOKEN": "1"}, "secureEnvVarsMask": {"É_TOKEN": true}}),
            )
            .ok()
            .unwrap();
        let accented2 = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"é_TOKEN": "2"}, "secureEnvVarsMask": {"é_TOKEN": true}}),
            )
            .ok()
            .unwrap();
        assert_eq!(accented1["secureEnvVars"], json!(["SECRET_B", "É_TOKEN"]));
        assert_eq!(accented2["secureEnvVars"], json!(["SECRET_B", "é_TOKEN"]));
        let conflict_mask = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"TOKEN": "3"}, "secureEnvVarsMask": {"token": false, "TOKEN": true}}),
            )
            .ok()
            .unwrap();
        assert_eq!(conflict_mask["secureEnvVars"], json!(["SECRET_B", "é_TOKEN", "TOKEN"]));

        // Deleting `token` while `TOKEN` survives keeps the case-insensitive mask intact.
        let lower_env = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"token": "lower"}, "secureEnvVarsMask": {"token": true}}),
            )
            .ok()
            .unwrap();
        assert_eq!(lower_env["secureEnvVars"], json!(["SECRET_B", "é_TOKEN", "token"]));
        let after_del = env_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"token": null}, "secureEnvVarsMask": {"token": false}}),
            )
            .ok()
            .unwrap();
        assert_eq!(after_del["secureEnvVars"], json!(["SECRET_B", "é_TOKEN", "token"]));
        assert_eq!(after_del["environmentVariables"]["TOKEN"], "3");
        assert!(after_del["environmentVariables"].get("token").is_none());

        // Explicit `secureEnvVars: null` resets prior masks before applying `secureEnvVarsMask`.
        let reset_mask = env_settings
            .patch(Kind::Config, "server", &json!({"secureEnvVars": null, "secureEnvVarsMask": {"NEW": true}}))
            .ok()
            .unwrap();
        assert_eq!(reset_mask["secureEnvVars"], json!(["NEW"]));

        // speech_pairing runs inside the write lock and preserves explicit null deletion for stt/tts.
        let speech_settings = Settings::new(Location::resolve(dir.join("speech-lock.yaml").to_str().unwrap()));
        speech_settings
            .patch(Kind::Config, "server", &json!({"speech": {"baseUrl": "https://a.example", "apiKey": "key-a"}}))
            .ok()
            .unwrap();
        let paired_drop = speech_settings
            .patch(Kind::Config, "server", &json!({"speech": {"baseUrl": "https://b.example"}}))
            .ok()
            .unwrap();
        assert!(paired_drop["speech"].get("apiKey").is_none());
        let mut speech_current = Doc::new();
        speech_current.insert("speech".into(), json!({"stt": {"baseUrl": "https://stt.example", "apiKey": "secret"}}));
        let cleared_patch = speech_pairing(&json!({"speech": {"stt": null}}), &speech_current);
        assert_eq!(cleared_patch, json!({"speech": {"stt": null}}));

        // sanitize_server redacts voiceConversation apiKeys like TS publicVoiceConversationConfig
        // (matching JS String.prototype.trim(): strips U+FEFF BOM, does NOT strip U+0085 NEL).
        let mut raw_server = Doc::new();
        raw_server.insert(
            "voiceConversation".into(),
            json!({
                "geminiLive": {"apiKey": "\u{feff}gem-secret", "model": "gem-secret", "voice": "Puck"},
                "openaiRealtime": {"apiKey": "oa-secret", "model": "gpt-realtime", "voice": "Alloy"}
            }),
        );
        raw_server.insert("speech".into(), json!({"apiKey": "\u{feff}"}));
        let clean = sanitize_server(raw_server);
        assert_eq!(clean["speech"], json!({"hasApiKey": false}));
        assert_eq!(
            clean["voiceConversation"],
            json!({
                "geminiLive": {"hasApiKey": true, "voice": "Puck"},
                "openaiRealtime": {"hasApiKey": true, "model": "gpt-realtime", "voice": "Alloy"}
            })
        );
        let mut non_obj_speech = Doc::new();
        non_obj_speech.insert("speech".into(), json!("not-an-object"));
        assert!(sanitize_server(non_obj_speech).get("speech").is_none());
        // assert_voice_conversation_patch & check_conversation_default reject invalid patches with 400.
        assert!(
            assert_voice_conversation_patch(&json!({"voiceConversation": {"geminiLive": {"apiKey": 123}}})).is_err()
        );
        assert!(
            assert_voice_conversation_patch(
                &json!({"voiceConversation": {"geminiLive": {"apiKey": "\u{0085}demo\u{0085}"}}})
            )
            .is_err()
        );
        assert!(
            assert_voice_conversation_patch(
                &json!({"voiceConversation": {"geminiLive": {"model": "gemini-live-2.5"}}})
            )
            .is_ok()
        );
        assert!(
            check_conversation_default(
                &Doc::new(),
                &json!({"ui": {"settings": {"newConversationPermissions": "invalid"}}}).as_object().unwrap().clone()
            )
            .is_err()
        );
        assert!(
            check_conversation_default(
                &Doc::new(),
                &json!({"ui": {"settings": {"newConversationPermissions": "supervised"}}}).as_object().unwrap().clone()
            )
            .is_ok()
        );

        // Editing TOKEN with mask=false removes legacy mixed-case ["Token"] even when both variants exist.
        let mixed_settings = Settings::new(Location::resolve(dir.join("mixed-mask.yaml").to_str().unwrap()));
        mixed_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"TOKEN": "old", "token": "other"}, "secureEnvVars": ["Token"]}),
            )
            .ok()
            .unwrap();
        let after_mixed = mixed_settings
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"TOKEN": "new"}, "secureEnvVarsMask": {"TOKEN": false}}),
            )
            .ok()
            .unwrap();
        assert_eq!(after_mixed["secureEnvVars"], json!([]));

        // Remote project history compaction matches TS: out-of-order access, profile purge, legacy delete.
        let rh_settings = Settings::new(Location::resolve(dir.join("remote-history.yaml").to_str().unwrap()));
        let first_p = json!({"id": "first", "baseUrl": "https://first.example", "skipTlsVerify": false});
        let second_p = json!({"id": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}});
        let key_first =
            serde_json::to_string(&json!(["first", "https://first.example", false, null, "/canonical"])).unwrap();
        let key_legacy =
            serde_json::to_string(&json!(["first", "https://first.example", false, null, "/legacy"])).unwrap();
        let _ = rh_settings
            .patch(
                Kind::State,
                "ui",
                &json!({
                    "remoteServers": [
                        {"id": "first", "name": "first", "baseUrl": "https://first.example", "skipTlsVerify": false},
                        {"id": "second", "name": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}}
                    ],
                    "remoteProjectRecents": [
                        {"policy": first_p, "path": "/legacy", "lastAccessed": 50}
                    ]
                }),
            )
            .ok()
            .unwrap();
        let after_legacy_del = rh_settings
            .patch(Kind::State, "ui", &json!({"remoteProjectHistory": {key_legacy.clone(): null}}))
            .ok()
            .unwrap();
        assert_eq!(after_legacy_del["remoteProjectHistory"], json!({}));
        assert!(after_legacy_del.get("remoteProjectRecents").is_none());
        let _ = rh_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"remoteProjectHistory": {key_first.clone(): {"policy": first_p, "path": "/canonical", "lastAccessed": 300}}}),
            )
            .ok()
            .unwrap();
        let after_older = rh_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"remoteProjectHistory": {key_first.clone(): {"policy": first_p, "path": "/canonical", "lastAccessed": 100}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(after_older["remoteProjectHistory"][&key_first]["lastAccessed"], 300);
        // Removing a profile purges its history entries.
        let after_profile_drop = rh_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"remoteServers": [{"id": "second", "name": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}}]}),
            )
            .ok()
            .unwrap();
        assert_eq!(after_profile_drop["remoteProjectHistory"], json!({}));

        // Equal-timestamp tie-breaking at the 20-entry limit matches JS wire insertion order (/z first, /a20 evicted).
        let mut raw_entries = Vec::new();
        let z_key = serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/z"])).unwrap();
        raw_entries.push(format!(
            "{}:{}",
            serde_json::to_string(&z_key).unwrap(),
            json!({"policy": second_p, "path": "/z", "lastAccessed": 500})
        ));
        for i in 1..=20usize {
            let path = format!("/a{i:02}");
            let key =
                serde_json::to_string(&json!(["second", "https://second.example", true, "remote", path])).unwrap();
            raw_entries.push(format!(
                "{}:{}",
                serde_json::to_string(&key).unwrap(),
                json!({"policy": second_p, "path": path, "lastAccessed": 500})
            ));
        }
        let raw_json = format!(r#"{{"remoteProjectHistory":{{{}}}}}"#, raw_entries.join(","));
        let wire_order = remote_project_history::json_history_key_order(raw_json.as_bytes());
        let parsed: Value = serde_json::from_str(&raw_json).unwrap();
        let (after_tied, tied_order) =
            rh_settings.patch_checked_with_order(Kind::State, "ui", &parsed, &wire_order, |_, _| Ok(())).ok().unwrap();
        let wire_reply = serde_json::to_string(&remote_project_history::OrderedStateOwner(
            after_tied.as_object().unwrap(),
            &tied_order,
        ))
        .unwrap();
        assert!(
            wire_reply.find("/z").unwrap() < wire_reply.find("/a01").unwrap(),
            "JSON wire response must preserve /z before /a01"
        );
        let kept = after_tied["remoteProjectHistory"].as_object().unwrap();
        assert_eq!(kept.len(), 20);
        assert!(kept.contains_key(&z_key), "first wire-order entry /z must survive equal-timestamp compaction");
        let dropped_key =
            serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/a20"])).unwrap();
        assert!(!kept.contains_key(&dropped_key), "21st wire-order entry /a20 must be deterministically evicted");
        // Subsequent PATCH adding a newer entry reads persisted YAML order (/z first, /a19 last) and evicts /a19, not /z.
        let newer_key =
            serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/newer"])).unwrap();
        let after_newer = rh_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"remoteProjectHistory": {newer_key.clone(): {"policy": second_p, "path": "/newer", "lastAccessed": 600}}}),
            )
            .ok()
            .unwrap();
        let kept2 = after_newer["remoteProjectHistory"].as_object().unwrap();
        let a19_key =
            serde_json::to_string(&json!(["second", "https://second.example", true, "remote", "/a19"])).unwrap();
        assert!(kept2.contains_key(&z_key), "persisted YAML order must keep /z on subsequent eviction");
        assert!(kept2.contains_key(&newer_key));
        assert!(!kept2.contains_key(&a19_key), "persisted YAML order must evict /a19 on subsequent newer entry");

        // Legacy remoteProjectRecents order is preserved across its first migration + newer entry,
        // and Windows paths under 4096 UTF-16 code units (>4096 UTF-8 bytes) survive compaction.
        let legacy_recents_path = dir.join("legacy-recents-state.yaml");
        let legacy_recents_settings = Settings::new(Location::resolve(legacy_recents_path.to_str().unwrap()));
        let mut legacy_items = vec![json!({"policy": second_p, "path": "/z", "lastAccessed": 500})];
        for i in 1..=19usize {
            legacy_items.push(json!({"policy": second_p, "path": format!("/a{i:02}"), "lastAccessed": 500}));
        }
        let mut legacy_doc = Doc::new();
        legacy_doc.insert(
            "ui".into(),
            json!({
                "remoteServers": [{"id": "second", "name": "second", "baseUrl": "https://second.example", "skipTlsVerify": true, "ssh": {"host": "remote"}}],
                "remoteProjectRecents": legacy_items,
            }),
        );
        document::write(&legacy_recents_settings.location.state, &legacy_doc).unwrap();
        let after_legacy_newer = legacy_recents_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"remoteProjectHistory": {newer_key.clone(): {"policy": second_p, "path": "/newer", "lastAccessed": 600}}}),
            )
            .ok()
            .unwrap();
        let kept_legacy = after_legacy_newer["remoteProjectHistory"].as_object().unwrap();
        assert!(kept_legacy.contains_key(&z_key), "legacy remoteProjectRecents order must keep /z");
        assert!(!kept_legacy.contains_key(&a19_key), "legacy remoteProjectRecents order must evict /a19");

        let unicode_win_path =
            format!("C:\\{}", std::iter::repeat_n("界".repeat(160), 10).collect::<Vec<_>>().join("\\"));
        assert!(unicode_win_path.len() > 4096 && unicode_win_path.encode_utf16().count() < 4096);
        let unicode_win_key = serde_json::to_string(&json!([
            "second",
            "https://second.example",
            true,
            "remote",
            unicode_win_path.replace('\\', "/").to_lowercase()
        ]))
        .unwrap();
        let after_utf16 = legacy_recents_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"remoteProjectHistory": {unicode_win_key.clone(): {"policy": second_p, "path": unicode_win_path, "lastAccessed": 700}}}),
            )
            .ok()
            .unwrap();
        assert!(
            after_utf16["remoteProjectHistory"].as_object().unwrap().contains_key(&unicode_win_key),
            "Windows Unicode path under 4096 UTF-16 units must survive compaction"
        );

        // Empty query (`?`) and legacy truthy `skipTlsVerify: "true"` match JS selection-policy.ts.
        let query_policy = json!({"id": "q", "baseUrl": "https://example.test/?", "skipTlsVerify": true});
        let query_key = serde_json::to_string(&json!(["q", "https://example.test/?", true, null, "/q"])).unwrap();
        let mut q_doc = Doc::new();
        q_doc.insert(
            "ui".into(),
            json!({
                "remoteServers": [{"id": "q", "name": "q", "baseUrl": "https://example.test/?", "skipTlsVerify": "true"}],
                "remoteProjectHistory": {
                    query_key.clone(): {"policy": query_policy, "path": "/q", "lastAccessed": 100}
                }
            }),
        );
        let q_settings = Settings::new(Location::resolve(dir.join("query-policy.yaml").to_str().unwrap()));
        document::write(&q_settings.location.state, &q_doc).unwrap();
        let after_q = q_settings.patch(Kind::State, "ui", &json!({"recentFolders": []})).ok().unwrap();
        assert!(
            after_q["remoteProjectHistory"].as_object().unwrap().contains_key(&query_key),
            "empty `?` baseUrl and legacy truthy skipTlsVerify must survive compaction"
        );

        // Unicode case-folding in secureEnvVarsMask matches Solid's toUpperCase().
        let unicode_env = Settings::new(Location::resolve(dir.join("unicode-env.yaml").to_str().unwrap()));
        let saved_u = unicode_env
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"É_TOKEN": "1", "é_TOKEN": "2"}, "secureEnvVars": ["É_TOKEN"]}),
            )
            .ok()
            .unwrap();
        assert_eq!(saved_u["secureEnvVars"], json!(["É_TOKEN"]));
        let after_del_one = unicode_env
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"é_TOKEN": null}, "secureEnvVarsMask": {"é_TOKEN": false}}),
            )
            .ok()
            .unwrap();
        assert_eq!(after_del_one["secureEnvVars"], json!(["É_TOKEN"]));
        let after_del_last = unicode_env
            .patch(
                Kind::Config,
                "server",
                &json!({"environmentVariables": {"É_TOKEN": null}, "secureEnvVarsMask": {"É_TOKEN": false}}),
            )
            .ok()
            .unwrap();
        assert_eq!(after_del_last["secureEnvVars"], json!([]));

        // Deleting a notification category, environment variable, or state/ui field on first creation leaves it absent.
        let deleted_cat_settings = Settings::new(Location::resolve(dir.join("deleted-cat.yaml").to_str().unwrap()));
        let deleted_cat = deleted_cat_settings
            .patch(Kind::Config, "ui", &json!({"settings": {"notificationRouting": {"sessionDone": null}}}))
            .ok()
            .unwrap();
        assert!(deleted_cat["settings"]["notificationRouting"].get("sessionDone").is_none());
        assert!(deleted_cat["settings"]["notificationRouting"].get("needsInput").is_some());

        let deleted_env_settings = Settings::new(Location::resolve(dir.join("deleted-env.yaml").to_str().unwrap()));
        let deleted_env = deleted_env_settings
            .patch(Kind::Config, "server", &json!({"environmentVariables": {"TOKEN": null}}))
            .ok()
            .unwrap();
        assert_eq!(deleted_env["environmentVariables"], json!({}));

        let deleted_state_settings = Settings::new(Location::resolve(dir.join("deleted-state.yaml").to_str().unwrap()));
        let deleted_state = deleted_state_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"appearancePreferences": {"light": {"presetId": null, "scheme": {"id": "linen"}}}}),
            )
            .ok()
            .unwrap();
        assert!(deleted_state["appearancePreferences"]["light"].get("presetId").is_none());
        assert_eq!(deleted_state["appearancePreferences"]["light"]["scheme"]["id"], "linen");

        // JS trim parity (`\u{0085}` is non-whitespace in ECMAScript), exact float_roundtrip
        // (`1700000000000.0003` vs `.0004`), and replace_private_state compacting legacy recents.
        let nel_settings = Settings::new(Location::resolve(dir.join("nel-float.yaml").to_str().unwrap()));
        let nel_policy = json!({"id": "nel", "baseUrl": "https://nel.example", "skipTlsVerify": false});
        let nel_key_old = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, "/old"])).unwrap();
        let nel_key_new = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, "/new"])).unwrap();
        let mut nel_doc = Doc::new();
        nel_doc.insert(
            "ui".into(),
            json!({
                "remoteServers": [{"id": "nel", "name": "\u{0085}", "baseUrl": "https://nel.example", "skipTlsVerify": false}],
                "remoteProjectRecents": [{"policy": nel_policy, "path": "/legacy", "lastAccessed": 100}]
            }),
        );
        document::write(&nel_settings.location.state, &nel_doc).unwrap();
        assert!(
            nel_settings
                .replace_private_state("sessionPermissionBlocks", "ses-1", None, Some(json!({"blocked": true})))
                .unwrap()
        );
        let after_private = document::read(&nel_settings.location.state).unwrap();
        assert!(
            after_private["ui"].get("remoteProjectRecents").is_none()
                && after_private["ui"]["remoteProjectHistory"].as_object().is_some_and(|m| m.len() == 1),
            "replace_private_state must compact legacy remoteProjectRecents and keep \\u{{0085}} profile"
        );
        let mut float_entries = vec![
            format!(
                "{}:{}",
                serde_json::to_string(&nel_key_old).unwrap(),
                r#"{"policy":{"id":"nel","baseUrl":"https://nel.example","skipTlsVerify":false},"path":"/old","lastAccessed":1700000000000.0003}"#
            ),
            format!(
                "{}:{}",
                serde_json::to_string(&nel_key_new).unwrap(),
                r#"{"policy":{"id":"nel","baseUrl":"https://nel.example","skipTlsVerify":false},"path":"/new","lastAccessed":1700000000000.0004}"#
            ),
        ];
        for i in 1..=19usize {
            let path = format!("/p{i:02}");
            let key = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, path])).unwrap();
            float_entries.push(format!(
                "{}:{}",
                serde_json::to_string(&key).unwrap(),
                json!({"policy": nel_policy, "path": path, "lastAccessed": 1700000000001.0 + i as f64})
            ));
        }
        let float_json = format!(r#"{{"remoteProjectHistory":{{{}}}}}"#, float_entries.join(","));
        let float_order = remote_project_history::json_history_key_order(float_json.as_bytes());
        let float_patch: Value = serde_json::from_str(&float_json).unwrap();
        let (after_float, _) = nel_settings
            .patch_checked_with_order(Kind::State, "ui", &float_patch, &float_order, |_, _| Ok(()))
            .ok()
            .unwrap();
        let kept_float = after_float["remoteProjectHistory"].as_object().unwrap();
        assert!(kept_float.contains_key(&nel_key_new), "float_roundtrip must keep .0004 over .0003");
        assert!(!kept_float.contains_key(&nel_key_old), "float_roundtrip must evict .0003");

        // Large JS integer timestamps (>= 2^64) written by TS as unquoted YAML integers must remain
        // readable by Rust and never saturate to u64::MAX on direct Rust PATCH.
        let big_ts_settings = Settings::new(Location::resolve(dir.join("big-ts.yaml").to_str().unwrap()));
        let big_key = serde_json::to_string(&json!(["nel", "https://nel.example", false, null, "/big"])).unwrap();
        let big_yaml = format!(
            "ui:\n  remoteServers:\n    - id: nel\n      name: nel\n      baseUrl: https://nel.example\n      skipTlsVerify: false\n  remoteProjectHistory:\n    {}: \n      policy:\n        id: nel\n        baseUrl: https://nel.example\n        skipTlsVerify: false\n      path: /big\n      lastAccessed: 18446744073709552000\n",
            serde_json::to_string(&big_key).unwrap()
        );
        std::fs::write(&big_ts_settings.location.state, big_yaml).unwrap();
        let read_big = big_ts_settings.private_state_owner("ui").unwrap();
        assert_eq!(read_big["remoteProjectHistory"][&big_key]["lastAccessed"].as_f64(), Some(18446744073709551616.0));
        let patched_big = big_ts_settings
            .patch(
                Kind::State,
                "ui",
                &json!({"remoteProjectHistory": {big_key.clone(): {"policy": nel_policy, "path": "/big", "lastAccessed": 18446744073709551616.0}}}),
            )
            .ok()
            .unwrap();
        assert_eq!(
            patched_big["remoteProjectHistory"][&big_key]["lastAccessed"].as_f64(),
            Some(18446744073709551616.0),
            "2^64 lastAccessed must not saturate to u64::MAX"
        );

        // Non-finite YAML floats (.nan / .inf) in an invalid history entry must only drop that
        // entry instead of failing authoritative reads with 503.
        let nan_settings = Settings::new(Location::resolve(dir.join("nan-state.yaml").to_str().unwrap()));
        let nan_yaml = format!(
            "ui:\n  keep: true\n  note: !keep exemple\n  123: old\n  \"123\": note\n  remoteServers:\n    - id: nel\n      name: nel\n      baseUrl: https://nel.example\n      skipTlsVerify: false\n  remoteProjectHistory:\n    {}:\n      policy:\n        id: nel\n        baseUrl: https://nel.example\n        skipTlsVerify: false\n      path: /big\n      lastAccessed: .nan\n",
            serde_json::to_string(&big_key).unwrap()
        );
        std::fs::write(&nan_settings.location.state, nan_yaml).unwrap();
        let read_nan = nan_settings.private_state_owner("ui").unwrap();
        assert_eq!(read_nan["keep"], true);
        assert_eq!(read_nan["note"], "exemple");
        assert_eq!(read_nan["123"], "note");
        assert_eq!(read_nan["remoteProjectHistory"], json!({}));

        // Invalid non-boolean secureEnvVarsMask is rejected cleanly without saving the secret unmasked.
        assert!(
            env_settings
                .patch(
                    Kind::Config,
                    "server",
                    &json!({"environmentVariables": {"BAD_MASK": "secret"}, "secureEnvVarsMask": {"BAD_MASK": "true"}}),
                )
                .is_err()
        );
        // Duplicate remoteProjectHistory JSON key where the first is a non-object still preserves the last map's wire order.
        let dup_json = br#"{"remoteProjectHistory":[1],"remoteProjectHistory":{"/z":{},"a":{}}}"#;
        assert_eq!(remote_project_history::json_history_key_order(dup_json), vec!["/z", "a"]);

        // Corrupt config.yaml and non-object server owner fail authoritative reads and patches.
        let corrupt_path = dir.join("corrupt-server.yaml");
        std::fs::write(&corrupt_path, "server: [unclosed").unwrap();
        let corrupt_settings = Settings::new(Location::resolve(corrupt_path.to_str().unwrap()));
        assert!(corrupt_settings.raw_config_owner("server").is_err());
        let list_server_path = dir.join("list-server.yaml");
        std::fs::write(&list_server_path, "server:\n  - a\n  - b\n").unwrap();
        let list_server = Settings::new(Location::resolve(list_server_path.to_str().unwrap()));
        assert!(list_server.patch(Kind::Config, "server", &json!({"logLevel": "INFO"})).is_err());
        assert_eq!(std::fs::read_to_string(&list_server_path).unwrap(), "server:\n  - a\n  - b\n");

        // Indented blank line inside a multi-line plain scalar starting with 0b10, literal U+2028/U+2029
        // inside double-quoted scalars, and ECMAScript js_trim on logLevel (BOM trimmed, NEL kept).
        let yaml_edge_path = dir.join("yaml-edge.yaml");
        std::fs::write(
            &yaml_edge_path,
            "server:\n  environmentVariables:\n    CODE: 0b10\n      \n      suffix\n    LS: \"a\u{2028}b\"\n    PS: \"c\u{2029}d\"\n",
        )
        .unwrap();
        let yaml_edge = Settings::new(Location::resolve(yaml_edge_path.to_str().unwrap()));
        let read_edge = yaml_edge.raw_config_owner("server").unwrap();
        assert_eq!(read_edge["environmentVariables"]["CODE"], "0b10\nsuffix");
        assert_eq!(read_edge["environmentVariables"]["LS"], "a\u{2028}b");
        assert_eq!(read_edge["environmentVariables"]["PS"], "c\u{2029}d");
        let bom_level = yaml_edge.patch(Kind::Config, "server", &json!({"logLevel": "\u{feff}INFO"})).ok().unwrap();
        assert_eq!(bom_level["logLevel"], "INFO");
        let nel_level = yaml_edge.patch(Kind::Config, "server", &json!({"logLevel": "\u{0085}INFO"})).ok().unwrap();
        assert_eq!(nel_level["logLevel"], "DEBUG");
        let _ = std::fs::remove_dir_all(dir);
    }
}
