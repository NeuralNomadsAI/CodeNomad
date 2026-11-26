//! OpenCode integrations catalog, host installation and per-session attachment client.
use crate::{
    backend::{Backend, read_json},
    history::valid_id,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MAX_INTEGRATIONS: usize = 64;
const MAX_OFFERS: usize = 16;
const MAX_SUMMARIES: usize = 16;
const MAX_NOTICES: usize = 8;
const DOCS_PREFIX_TREE: &str =
    "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/";
const DOCS_PREFIX_BLOB: &str =
    "https://github.com/NeuralNomadsAI/opencode-integrations/blob/main/integrations/";
const DOCS_README_SUFFIX: &str = "/plugin/README.md";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegrationFamily {
    Native,
    VendorMcp,
    Api,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogState {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogStatus {
    Preview,
    Stable,
    Deprecated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegrationScope {
    Global,
    Project,
}

impl IntegrationScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginRuntime {
    Loaded,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeState {
    Absent,
    Inactive,
    Failed,
    Unsupported,
    NonConforming,
    Unknown,
    Ok,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostState {
    Absent,
    Incompatible,
    Outdated,
    Ok,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostAction {
    Install,
    Update,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostStatus {
    pub state: HostState,
    pub part_version: Option<String>,
    pub expected_range: Option<String>,
    pub app_version: Option<String>,
    pub action: Option<HostAction>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    None,
    Connected,
    SignedOut,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionView {
    pub offers: Option<u32>,
    pub state: Option<ConnectionState>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrationStatus {
    pub version: String,
    pub host: Option<HostStatus>,
    pub connection: Option<ConnectionView>,
    pub notices: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrationApp {
    pub name: String,
    pub versions: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrationPlugin {
    pub declared: bool,
    pub runtime: Option<PluginRuntime>,
    pub runtime_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrationView {
    pub id: String,
    pub display_name: String,
    pub family: IntegrationFamily,
    pub summary: BTreeMap<String, String>,
    pub app: IntegrationApp,
    pub docs: Option<String>,
    pub catalog_status: CatalogStatus,
    pub configured: bool,
    pub plugin: IntegrationPlugin,
    pub ambiguous: bool,
    pub scopes: Vec<IntegrationScope>,
    pub version: Option<String>,
    pub outdated: bool,
    pub state: RuntimeState,
    pub status: Option<IntegrationStatus>,
}

impl IntegrationView {
    pub fn installable(&self) -> bool {
        !self.ambiguous && !self.plugin.declared && self.plugin.runtime.is_none()
    }

    pub fn recognized(&self) -> bool {
        self.configured || self.plugin.declared || self.plugin.runtime.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrationsSnapshot {
    pub directory: String,
    pub catalog_state: CatalogState,
    pub fetched_at: Option<String>,
    pub integrations: Vec<IntegrationView>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostOffer {
    pub offer_id: String,
    pub label: String,
    pub document: Option<String>,
    pub app_version: Option<String>,
    pub protocol_ok: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindingState {
    None,
    Unknown,
    Attached(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed,
    Updated,
    Unchanged,
    Refused,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachOutcome {
    Attached,
    Busy,
    Gone,
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetachOutcome {
    Detached,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntegrationError {
    RouteUnsupported,
    Code(String),
    Failed,
}

pub type IntegrationResult<T> = std::result::Result<T, IntegrationError>;

pub fn valid_integration_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub fn valid_docs_url(url: &str, id: &str) -> bool {
    if !valid_integration_id(id) {
        return false;
    }
    url.strip_prefix(DOCS_PREFIX_TREE) == Some(id)
        || url
            .strip_prefix(DOCS_PREFIX_BLOB)
            .and_then(|rest| rest.strip_suffix(DOCS_README_SUFFIX))
            == Some(id)
}

pub fn is_integration_refresh_event(event_type: &str) -> bool {
    if matches!(event_type, "plugin.updated" | "config.updated") {
        return true;
    }
    let Some(rest) = event_type.strip_prefix("rpc.neuralnomads.") else {
        return false;
    };
    let Some((id, suffix)) = rest.split_once('.') else {
        return false;
    };
    valid_integration_id(id) && matches!(suffix, "status_changed" | "hosts_changed")
}

pub(crate) fn session_stream_event(frame: &Value) -> Option<(&str, Option<&str>)> {
    if frame["type"] != "instance.event" {
        return None;
    }
    let id = frame["instanceId"].as_str().filter(|id| valid_id(id))?;
    let event_type = frame["event"]["type"].as_str()?;
    if is_integration_refresh_event(event_type) || event_type == "server.connected" {
        Some((id, None))
    } else if matches!(event_type, "session.updated" | "session.deleted") {
        let session = frame["event"]["data"]["sessionID"]
            .as_str()
            .filter(|ses| valid_id(ses))?;
        Some((id, Some(session)))
    } else {
        None
    }
}

pub(crate) fn change_event(frame: &Value) -> Option<(&str, Option<&str>)> {
    let kind = frame["type"].as_str()?;
    let id = frame["instanceId"].as_str().filter(|id| valid_id(id))?;
    match kind {
        "instance.eventStatus" if frame["status"] == "connected" => Some((id, None)),
        "instance.event" => {
            let event_type = frame["event"]["type"].as_str()?;
            if is_integration_refresh_event(event_type) || event_type == "server.connected" {
                Some((id, None))
            } else if matches!(
                event_type,
                "session.updated" | "session.deleted" | "session.moved"
            ) {
                let session = frame["event"]["data"]["sessionID"]
                    .as_str()
                    .filter(|ses| valid_id(ses))?;
                Some((id, Some(session)))
            } else {
                None
            }
        }
        _ => None,
    }
}

pub async fn resolve_directory(
    backend: &Backend,
    workspace: &str,
    session: Option<&str>,
) -> IntegrationResult<String> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err(IntegrationError::Failed);
    }
    if let Some(session) = session {
        return super::session_directory(backend, workspace, session)
            .await
            .map_err(|_| IntegrationError::Failed);
    }
    let projects = backend
        .projects()
        .await
        .map_err(|_| IntegrationError::Failed)?;
    projects
        .into_iter()
        .find(|project| project.id == workspace)
        .map(|project| project.path)
        .filter(|path| crate::absolute_server_path(path))
        .ok_or(IntegrationError::Failed)
}

pub async fn load(
    backend: &Backend,
    workspace: &str,
    directory: &str,
) -> IntegrationResult<IntegrationsSnapshot> {
    if !valid_id(workspace) || !valid_directory(directory) {
        return Err(IntegrationError::Failed);
    }
    let url = format!("{}api/workspaces/{workspace}/integrations", backend.base);
    let response = send_get(backend, &url, &[("directory", directory)]).await?;
    let value = parse_ok_json(response).await?;
    parse_snapshot(&value, directory)
}

pub async fn install_catalog(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    scope: IntegrationScope,
) -> IntegrationResult<()> {
    if !valid_id(workspace) || !valid_directory(directory) || !valid_integration_id(integration_id)
    {
        return Err(IntegrationError::Failed);
    }
    let url = format!(
        "{}api/workspaces/{workspace}/integrations/{integration_id}/install",
        backend.base
    );
    let value = send_post_json(
        backend,
        &url,
        &[("directory", directory)],
        &json!({ "scope": scope.as_str() }),
    )
    .await?;
    let Some(map) = value.as_object() else {
        return Err(IntegrationError::Failed);
    };
    let valid = map.len() == 3
        && map.get("scope").and_then(Value::as_str) == Some(scope.as_str())
        && map
            .get("spec")
            .and_then(Value::as_str)
            .is_some_and(|spec| !spec.is_empty())
        && map.get("reloadPending") == Some(&Value::Bool(true));
    if valid {
        Ok(())
    } else {
        Err(IntegrationError::Failed)
    }
}

pub async fn install_host(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
) -> IntegrationResult<InstallOutcome> {
    if !valid_id(workspace) || !valid_directory(directory) || !valid_integration_id(integration_id)
    {
        return Err(IntegrationError::Failed);
    }
    let url = format!(
        "{}api/workspaces/{workspace}/integrations/{integration_id}/install-host",
        backend.base
    );
    let value = send_post_json(backend, &url, &[("directory", directory)], &json!({})).await?;
    match value.get("outcome").and_then(Value::as_str) {
        Some("installed") => Ok(InstallOutcome::Installed),
        Some("updated") => Ok(InstallOutcome::Updated),
        Some("unchanged") => Ok(InstallOutcome::Unchanged),
        Some("refused") => Ok(InstallOutcome::Refused),
        Some("failed") => Ok(InstallOutcome::Failed),
        _ => Err(IntegrationError::Failed),
    }
}

pub async fn read_binding(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    session_id: &str,
) -> BindingState {
    if !valid_id(workspace)
        || !valid_directory(directory)
        || !valid_integration_id(integration_id)
        || !valid_session_id(session_id)
    {
        return BindingState::Unknown;
    }
    let url = format!(
        "{}api/workspaces/{workspace}/integrations/{integration_id}/binding",
        backend.base
    );
    let Ok(response) = send_get(
        backend,
        &url,
        &[("directory", directory), ("sessionID", session_id)],
    )
    .await
    else {
        return BindingState::Unknown;
    };
    if !response.status().is_success() {
        return BindingState::Unknown;
    }
    match read_json(response).await {
        Ok(value) => parse_binding(&value),
        Err(_) => BindingState::Unknown,
    }
}

pub async fn list_hosts(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
) -> IntegrationResult<Vec<HostOffer>> {
    if !valid_id(workspace) || !valid_directory(directory) || !valid_integration_id(integration_id)
    {
        return Err(IntegrationError::Failed);
    }
    let url = format!(
        "{}api/workspaces/{workspace}/integrations/{integration_id}/hosts",
        backend.base
    );
    let response = send_get(backend, &url, &[("directory", directory)]).await?;
    let value = parse_ok_json(response).await?;
    parse_hosts(&value)
}

pub async fn attach_host(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    session_id: &str,
    offer_id: &str,
) -> IntegrationResult<AttachOutcome> {
    if !valid_id(workspace)
        || !valid_directory(directory)
        || !valid_integration_id(integration_id)
        || !valid_session_id(session_id)
        || !valid_offer_id(offer_id)
    {
        return Err(IntegrationError::Failed);
    }
    let url = format!(
        "{}api/workspaces/{workspace}/integrations/{integration_id}/attach",
        backend.base
    );
    let value = send_post_json(
        backend,
        &url,
        &[("directory", directory)],
        &json!({ "sessionID": session_id, "offerID": offer_id }),
    )
    .await?;
    match value.get("outcome").and_then(Value::as_str) {
        Some("attached") => Ok(AttachOutcome::Attached),
        Some("busy") => Ok(AttachOutcome::Busy),
        Some("gone") => Ok(AttachOutcome::Gone),
        Some("refused") => Ok(AttachOutcome::Refused),
        _ => Err(IntegrationError::Failed),
    }
}

pub async fn detach_host(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    session_id: &str,
) -> IntegrationResult<DetachOutcome> {
    if !valid_id(workspace)
        || !valid_directory(directory)
        || !valid_integration_id(integration_id)
        || !valid_session_id(session_id)
    {
        return Err(IntegrationError::Failed);
    }
    let url = format!(
        "{}api/workspaces/{workspace}/integrations/{integration_id}/detach",
        backend.base
    );
    let value = send_post_json(
        backend,
        &url,
        &[("directory", directory)],
        &json!({ "sessionID": session_id }),
    )
    .await?;
    match value.get("outcome").and_then(Value::as_str) {
        Some("detached") => Ok(DetachOutcome::Detached),
        Some("none") => Ok(DetachOutcome::None),
        _ => Err(IntegrationError::Failed),
    }
}

async fn send_get(
    backend: &Backend,
    url: &str,
    query: &[(&str, &str)],
) -> IntegrationResult<reqwest::Response> {
    let request = backend
        .client
        .get(url)
        .query(query)
        .header(reqwest::header::CACHE_CONTROL, "no-store");
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    request.send().await.map_err(|_| IntegrationError::Failed)
}

#[cfg(not(target_arch = "wasm32"))]
async fn send_post_json(
    backend: &Backend,
    url: &str,
    query: &[(&str, &str)],
    body: &Value,
) -> IntegrationResult<Value> {
    let request = backend
        .client
        .post(url)
        .query(query)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .json(body);
    let response = request.send().await.map_err(|_| IntegrationError::Failed)?;
    parse_ok_json(response).await
}

#[cfg(target_arch = "wasm32")]
async fn send_post_json(
    _backend: &Backend,
    url: &str,
    query: &[(&str, &str)],
    body: &Value,
) -> IntegrationResult<Value> {
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{AbortController, Headers, Request, RequestCredentials, RequestInit, Response};

    struct AbortGuard {
        controller: AbortController,
        window: web_sys::Window,
        timer: i32,
        _on_timeout: Closure<dyn FnMut()>,
    }
    impl Drop for AbortGuard {
        fn drop(&mut self) {
            self.window.clear_timeout_with_handle(self.timer);
            self.controller.abort();
        }
    }

    let mut full_url = reqwest::Url::parse(url).map_err(|_| IntegrationError::Failed)?;
    {
        let mut pairs = full_url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    let window = web_sys::window().ok_or(IntegrationError::Failed)?;
    let controller = AbortController::new().map_err(|_| IntegrationError::Failed)?;
    let deadline = controller.clone();
    let on_timeout = Closure::wrap(Box::new(move || deadline.abort()) as Box<dyn FnMut()>);
    let timer = window
        .set_timeout_with_callback_and_timeout_and_arguments_0(
            on_timeout.as_ref().unchecked_ref(),
            crate::http::REQUEST_TIMEOUT.as_millis() as i32,
        )
        .map_err(|_| IntegrationError::Failed)?;
    let abort = AbortGuard {
        controller,
        window,
        timer,
        _on_timeout: on_timeout,
    };
    let headers = Headers::new().map_err(|_| IntegrationError::Failed)?;
    headers
        .set("content-type", "application/json")
        .map_err(|_| IntegrationError::Failed)?;
    headers
        .set("cache-control", "no-store")
        .map_err(|_| IntegrationError::Failed)?;
    let payload = serde_json::to_string(body).map_err(|_| IntegrationError::Failed)?;
    let init = RequestInit::new();
    init.set_method("POST");
    init.set_credentials(RequestCredentials::SameOrigin);
    init.set_headers(&headers);
    init.set_body(&JsValue::from_str(&payload));
    init.set_signal(Some(&abort.controller.signal()));
    // Reject HTTP redirects (including 307/308) so single-shot mutations are never replayed.
    js_sys::Reflect::set(
        &init,
        &JsValue::from_str("redirect"),
        &JsValue::from_str("error"),
    )
    .map_err(|_| IntegrationError::Failed)?;
    js_sys::Reflect::set(
        &init,
        &JsValue::from_str("cache"),
        &JsValue::from_str("no-store"),
    )
    .map_err(|_| IntegrationError::Failed)?;
    let request = Request::new_with_str_and_init(full_url.as_str(), &init)
        .map_err(|_| IntegrationError::Failed)?;
    let response: Response = JsFuture::from(abort.window.fetch_with_request(&request))
        .await
        .and_then(JsCast::dyn_into)
        .map_err(|_| IntegrationError::Failed)?;
    let status =
        reqwest::StatusCode::from_u16(response.status()).map_err(|_| IntegrationError::Failed)?;
    let text = JsFuture::from(response.text().map_err(|_| IntegrationError::Failed)?)
        .await
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default();
    let parsed = (text.len() <= 1_048_576)
        .then(|| serde_json::from_str::<Value>(&text).ok())
        .flatten();
    classify_json_response(status, parsed)
}

async fn parse_ok_json(response: reqwest::Response) -> IntegrationResult<Value> {
    let status = response.status();
    let body = read_json(response).await.ok();
    classify_json_response(status, body)
}

fn classify_json_response(
    status: reqwest::StatusCode,
    body: Option<Value>,
) -> IntegrationResult<Value> {
    if status.is_success() {
        return body.ok_or(IntegrationError::Failed);
    }
    if status == reqwest::StatusCode::METHOD_NOT_ALLOWED
        || status == reqwest::StatusCode::NOT_IMPLEMENTED
    {
        return Err(IntegrationError::RouteUnsupported);
    }
    if let Some(code) = body
        .as_ref()
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty() && code.len() <= 32)
    {
        return Err(IntegrationError::Code(code.to_owned()));
    }
    if status == reqwest::StatusCode::NOT_FOUND && is_missing_route_body(body.as_ref()) {
        return Err(IntegrationError::RouteUnsupported);
    }
    Err(IntegrationError::Failed)
}

fn is_missing_route_body(body: Option<&Value>) -> bool {
    let Some(value) = body else {
        return true;
    };
    let Some(map) = value.as_object() else {
        return true;
    };
    match map.get("error").and_then(Value::as_str) {
        None => true,
        Some(message) => message.eq_ignore_ascii_case("not found") || message.starts_with("Route "),
    }
}

fn valid_directory(directory: &str) -> bool {
    crate::absolute_server_path(directory)
        && directory.trim() == directory
        && directory.len() <= 32_768
        && !directory.chars().any(char::is_control)
}

fn valid_display(value: &str, max_chars: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max_chars
        && !value
            .chars()
            .any(|ch| ch == '/' || ch == '\\' || ch.is_control())
}

fn valid_plain_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max_chars && !value.chars().any(char::is_control)
}

fn valid_offer_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_session_id(value: &str) -> bool {
    value.starts_with("ses")
        && (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn parse_binding(value: &Value) -> BindingState {
    let Some(map) = value.as_object() else {
        return BindingState::Unknown;
    };
    match (map.len(), map.get("state").and_then(Value::as_str)) {
        (1, Some("none")) => BindingState::None,
        (1, Some("unknown")) => BindingState::Unknown,
        (2, Some("attached")) => match map.get("label").and_then(Value::as_str) {
            Some(label) if valid_display(label, 120) => BindingState::Attached(label.to_owned()),
            _ => BindingState::Unknown,
        },
        _ => BindingState::Unknown,
    }
}

fn parse_hosts(value: &Value) -> IntegrationResult<Vec<HostOffer>> {
    let items = value
        .get("offers")
        .and_then(Value::as_array)
        .filter(|list| list.len() <= MAX_OFFERS)
        .ok_or(IntegrationError::Failed)?;
    let mut offers = Vec::with_capacity(items.len());
    for item in items {
        let offer_id = item
            .get("offerID")
            .and_then(Value::as_str)
            .filter(|id| valid_offer_id(id))
            .ok_or(IntegrationError::Failed)?;
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .filter(|label| valid_display(label, 120))
            .ok_or(IntegrationError::Failed)?;
        let document = match item.get("document") {
            None | Some(Value::Null) => None,
            Some(Value::String(doc)) if valid_display(doc, 120) => Some(doc.clone()),
            _ => return Err(IntegrationError::Failed),
        };
        let app_version = match item.get("appVersion") {
            None | Some(Value::Null) => None,
            Some(Value::String(ver)) if valid_display(ver, 64) => Some(ver.clone()),
            _ => return Err(IntegrationError::Failed),
        };
        let protocol_ok = match item.get("protocol").and_then(Value::as_str) {
            Some("ok") => true,
            Some("incompatible") => false,
            _ => return Err(IntegrationError::Failed),
        };
        offers.push(HostOffer {
            offer_id: offer_id.to_owned(),
            label: label.to_owned(),
            document,
            app_version,
            protocol_ok,
        });
    }
    Ok(offers)
}

fn parse_snapshot(value: &Value, requested_dir: &str) -> IntegrationResult<IntegrationsSnapshot> {
    let received_dir = value["location"]["directory"]
        .as_str()
        .filter(|dir| {
            crate::absolute_server_path(dir) && crate::same_server_path(dir, requested_dir)
        })
        .ok_or(IntegrationError::Failed)?;
    let catalog_state = match value["catalog"]["state"].as_str() {
        Some("fresh") => CatalogState::Fresh,
        Some("stale") => CatalogState::Stale,
        Some("unavailable") => CatalogState::Unavailable,
        _ => return Err(IntegrationError::Failed),
    };
    let fetched_at = value["catalog"]["fetchedAt"]
        .as_str()
        .filter(|s| valid_plain_text(s, 64))
        .map(str::to_owned);
    let items = value["integrations"]
        .as_array()
        .filter(|list| list.len() <= MAX_INTEGRATIONS)
        .ok_or(IntegrationError::Failed)?;
    let mut integrations = Vec::with_capacity(items.len());
    for item in items {
        integrations.push(parse_entry(item)?);
    }
    Ok(IntegrationsSnapshot {
        directory: received_dir.to_owned(),
        catalog_state,
        fetched_at,
        integrations,
    })
}

fn parse_entry(item: &Value) -> IntegrationResult<IntegrationView> {
    let id = item["id"]
        .as_str()
        .filter(|id| valid_integration_id(id))
        .ok_or(IntegrationError::Failed)?;
    let display_name = item["displayName"]
        .as_str()
        .filter(|name| valid_plain_text(name, 80))
        .ok_or(IntegrationError::Failed)?;
    let family = match item["family"].as_str() {
        Some("native") => IntegrationFamily::Native,
        Some("vendor-mcp") => IntegrationFamily::VendorMcp,
        Some("api") => IntegrationFamily::Api,
        _ => return Err(IntegrationError::Failed),
    };
    let mut summary = BTreeMap::new();
    if let Some(map) = item["summary"].as_object() {
        for (locale, text) in map.iter().take(MAX_SUMMARIES) {
            if let Some(value) = text.as_str().filter(|t| valid_plain_text(t, 300)) {
                summary.insert(locale.clone(), value.to_owned());
            }
        }
    }
    let app_name = item["app"]["name"]
        .as_str()
        .filter(|name| valid_plain_text(name, 60))
        .ok_or(IntegrationError::Failed)?;
    let app_versions = item["app"]["versions"]
        .as_str()
        .filter(|ver| valid_plain_text(ver, 64))
        .map(str::to_owned);
    let docs = item["docs"]
        .as_str()
        .filter(|url| valid_docs_url(url, id))
        .map(str::to_owned);
    let catalog_status = match item["catalogStatus"].as_str() {
        Some("preview") => CatalogStatus::Preview,
        Some("stable") => CatalogStatus::Stable,
        Some("deprecated") => CatalogStatus::Deprecated,
        _ => return Err(IntegrationError::Failed),
    };
    let configured = item["configured"]
        .as_bool()
        .ok_or(IntegrationError::Failed)?;
    let plugin = IntegrationPlugin {
        declared: item["plugin"]["declared"]
            .as_bool()
            .ok_or(IntegrationError::Failed)?,
        runtime: match item["plugin"].get("runtime") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s == "loaded" => Some(PluginRuntime::Loaded),
            Some(Value::String(s)) if s == "failed" => Some(PluginRuntime::Failed),
            _ => return Err(IntegrationError::Failed),
        },
        runtime_id: item["plugin"]["runtimeId"]
            .as_str()
            .filter(|s| valid_plain_text(s, 128))
            .map(str::to_owned),
    };
    let ambiguous = item.get("ambiguous") == Some(&Value::Bool(true));
    let mut scopes = Vec::new();
    if let Some(list) = item["scopes"].as_array() {
        for scope in list {
            match scope.as_str() {
                Some("global") if !scopes.contains(&IntegrationScope::Global) => {
                    scopes.push(IntegrationScope::Global)
                }
                Some("project") if !scopes.contains(&IntegrationScope::Project) => {
                    scopes.push(IntegrationScope::Project)
                }
                _ => {}
            }
        }
    }
    let version = item["version"]
        .as_str()
        .filter(|ver| valid_plain_text(ver, 64))
        .map(str::to_owned);
    let outdated = item.get("outdated") == Some(&Value::Bool(true));
    let state = match item["state"].as_str() {
        Some("absent") => RuntimeState::Absent,
        Some("inactive") => RuntimeState::Inactive,
        Some("failed") => RuntimeState::Failed,
        Some("unsupported") => RuntimeState::Unsupported,
        Some("non-conforming") => RuntimeState::NonConforming,
        Some("unknown") => RuntimeState::Unknown,
        Some("ok") => RuntimeState::Ok,
        _ => return Err(IntegrationError::Failed),
    };
    let status = if state == RuntimeState::Ok {
        item.get("status")
            .filter(|v| !v.is_null())
            .map(parse_status)
            .transpose()?
    } else {
        None
    };
    Ok(IntegrationView {
        id: id.to_owned(),
        display_name: display_name.to_owned(),
        family,
        summary,
        app: IntegrationApp {
            name: app_name.to_owned(),
            versions: app_versions,
        },
        docs,
        catalog_status,
        configured,
        plugin,
        ambiguous,
        scopes,
        version,
        outdated,
        state,
        status,
    })
}

fn parse_status(value: &Value) -> IntegrationResult<IntegrationStatus> {
    let version = value["version"]
        .as_str()
        .filter(|ver| valid_plain_text(ver, 64))
        .ok_or(IntegrationError::Failed)?
        .to_owned();
    let host = value
        .get("host")
        .filter(|v| !v.is_null())
        .map(|host| {
            let state = match host["state"].as_str() {
                Some("absent") => HostState::Absent,
                Some("incompatible") => HostState::Incompatible,
                Some("outdated") => HostState::Outdated,
                Some("ok") => HostState::Ok,
                Some("unknown") => HostState::Unknown,
                Some("unsupported") => HostState::Unsupported,
                _ => return Err(IntegrationError::Failed),
            };
            let action = match host.get("action") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s == "install" => Some(HostAction::Install),
                Some(Value::String(s)) if s == "update" => Some(HostAction::Update),
                _ => return Err(IntegrationError::Failed),
            };
            Ok(HostStatus {
                state,
                part_version: host["partVersion"]
                    .as_str()
                    .filter(|s| valid_plain_text(s, 64))
                    .map(str::to_owned),
                expected_range: host["expectedRange"]
                    .as_str()
                    .filter(|s| valid_plain_text(s, 64))
                    .map(str::to_owned),
                app_version: host["appVersion"]
                    .as_str()
                    .filter(|s| valid_display(s, 64))
                    .map(str::to_owned),
                action,
            })
        })
        .transpose()?;
    let connection = value
        .get("connection")
        .filter(|v| !v.is_null())
        .map(|conn| {
            let offers = match conn.get("offers") {
                None | Some(Value::Null) => None,
                Some(v) => {
                    let count = v
                        .as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .filter(|n| (*n as usize) <= MAX_OFFERS)
                        .ok_or(IntegrationError::Failed)?;
                    Some(count)
                }
            };
            let state = match conn.get("state") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(match s.as_str() {
                    "none" => ConnectionState::None,
                    "connected" => ConnectionState::Connected,
                    "signed_out" => ConnectionState::SignedOut,
                    "error" => ConnectionState::Error,
                    _ => return Err(IntegrationError::Failed),
                }),
                _ => return Err(IntegrationError::Failed),
            };
            Ok(ConnectionView { offers, state })
        })
        .transpose()?;
    let notices = value
        .get("notices")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(MAX_NOTICES)
                .filter_map(|v| v.as_str().filter(|s| valid_plain_text(s, 32)))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(IntegrationStatus {
        version,
        host,
        connection,
        notices,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn docs_url_only_accepts_canonical_integration_pages() {
        assert!(valid_docs_url(
            "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender",
            "blender"
        ));
        assert!(valid_docs_url(
            "https://github.com/NeuralNomadsAI/opencode-integrations/blob/main/integrations/blender/plugin/README.md",
            "blender"
        ));
        assert!(!valid_docs_url(
            "https://github.com/NeuralNomadsAI/opencode-integrations/blob/main/integrations/blender",
            "blender"
        ));
        assert!(!valid_docs_url(
            "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/godot",
            "blender"
        ));
        assert!(!valid_docs_url(
            "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender?ref=1",
            "blender"
        ));
        assert!(!valid_docs_url("javascript:alert(1)", "blender"));
    }

    #[test]
    fn binding_parser_fails_closed_on_extra_keys_or_bad_labels() {
        assert_eq!(
            parse_binding(&json!({ "state": "none" })),
            BindingState::None
        );
        assert_eq!(
            parse_binding(&json!({ "state": "unknown" })),
            BindingState::Unknown
        );
        assert_eq!(
            parse_binding(&json!({ "state": "attached", "label": "scene.blend" })),
            BindingState::Attached("scene.blend".into())
        );
        assert_eq!(
            parse_binding(&json!({ "state": "attached", "label": "a/b.blend" })),
            BindingState::Unknown
        );
        assert_eq!(
            parse_binding(&json!({ "state": "attached", "label": "scene.blend", "extra": 1 })),
            BindingState::Unknown
        );
        assert_eq!(
            parse_binding(&json!({ "state": "none", "extra": 1 })),
            BindingState::Unknown
        );
    }

    #[test]
    fn refresh_event_matcher_tracks_rpc_config_and_session_events() {
        assert!(is_integration_refresh_event(
            "rpc.neuralnomads.blender.status_changed"
        ));
        assert!(is_integration_refresh_event(
            "rpc.neuralnomads.blender.hosts_changed"
        ));
        assert!(is_integration_refresh_event("plugin.updated"));
        assert!(is_integration_refresh_event("config.updated"));
        assert!(!is_integration_refresh_event(
            "rpc.neuralnomads.blender.other"
        ));
        assert!(!is_integration_refresh_event(
            "rpc.other.blender.status_changed"
        ));
        assert_eq!(
            change_event(&json!({
                "type": "instance.event",
                "instanceId": "ws-1",
                "event": { "type": "rpc.neuralnomads.blender.hosts_changed" }
            })),
            Some(("ws-1", None))
        );
        assert_eq!(
            change_event(&json!({
                "type": "instance.event",
                "instanceId": "ws-1",
                "event": { "type": "session.moved", "data": { "sessionID": "ses_1" } }
            })),
            Some(("ws-1", Some("ses_1")))
        );
        assert_eq!(
            change_event(&json!({
                "type": "instance.eventStatus",
                "instanceId": "ws-1",
                "status": "connected"
            })),
            Some(("ws-1", None))
        );
    }

    #[test]
    fn hosts_parser_ignores_transport_fields_and_rejects_bad_offers() {
        let offers = parse_hosts(&json!({
            "offers": [{
                "offerID": "offer_123456",
                "label": "Blender — scene.blend",
                "document": "scene.blend",
                "appVersion": "4.3",
                "protocol": "ok",
                "token": "secret",
                "port": 9999
            }]
        }))
        .unwrap();
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].offer_id, "offer_123456");
        assert_eq!(offers[0].document.as_deref(), Some("scene.blend"));
        assert!(offers[0].protocol_ok);
        assert!(
            parse_hosts(&json!({
                "offers": [{ "offerID": "short", "label": "ok", "protocol": "ok" }]
            }))
            .is_err()
        );
    }

    fn block_on<F: std::future::Future<Output = ()>>(future: F) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future);
    }

    #[test]
    fn server_404_and_501_degrade_to_route_unsupported() {
        block_on(async {
            for reply in [
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
                "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 21\r\n\r\n{\"error\":\"Not found\"}",
                "HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\n\r\n",
            ] {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}/", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf).await;
                    stream.write_all(reply.as_bytes()).await.unwrap();
                });
                let backend = Backend::unauthenticated(&base).unwrap();
                assert_eq!(
                    load(&backend, "ws-1", "/repo").await,
                    Err(IntegrationError::RouteUnsupported)
                );
                server.await.unwrap();
            }
        });
    }

    #[test]
    fn business_error_code_is_preserved_over_404_and_409() {
        block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf).await;
                let body = r#"{"error":"Integration attachment unsupported","code":"unsupported"}"#;
                let response = format!(
                    "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let backend = Backend::unauthenticated(&base).unwrap();
            assert_eq!(
                install_host(&backend, "ws-1", "/repo", "blender").await,
                Err(IntegrationError::Code("unsupported".into()))
            );
            server.await.unwrap();
        });
    }
}
