//! HTTP client operations for plugin controls, sources, and native package actions.
use super::{
    ActionError, MAX_RESPONSE_BYTES, MAX_SPEC_CHARS, REQUEST_TIMEOUT, RemovalTarget, Scope,
    Snapshot,
    parse::{parse_runtime_entries, parse_snapshot},
    valid_revision,
};
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde_json::{Value, json};

pub(crate) async fn route_unavailable(
    response: reqwest::Response,
) -> Result<Option<reqwest::Response>> {
    match response.status() {
        reqwest::StatusCode::NOT_IMPLEMENTED => Ok(None),
        reqwest::StatusCode::NOT_FOUND => {
            let text = read_bounded_utf8(response, 8 * 1024).await?;
            if is_route_not_found_body(&text) {
                return Ok(None);
            }
            if let Ok(value) = serde_json::from_str::<Value>(&text)
                && let Some(message) = value["error"]
                    .as_str()
                    .or_else(|| value["message"].as_str())
                    .filter(|msg| !msg.is_empty())
            {
                return Err(message.into());
            }
            Err("Resource not found".into())
        }
        _ => Ok(Some(response.error_for_status()?)),
    }
}

pub(crate) async fn classify_action_error(response: reqwest::Response) -> ActionError {
    let status = response.status();
    if status == reqwest::StatusCode::NOT_IMPLEMENTED {
        return ActionError::Unsupported;
    }
    let text = read_bounded_utf8(response, 8 * 1024)
        .await
        .unwrap_or_default();
    if status == reqwest::StatusCode::NOT_FOUND && is_route_not_found_body(&text) {
        return ActionError::Unsupported;
    }
    if let Ok(value) = serde_json::from_str::<Value>(&text)
        && let Some(code) = value["code"].as_str().filter(|c| !c.is_empty())
    {
        return ActionError::Code(code.to_owned());
    }
    match status {
        reqwest::StatusCode::FORBIDDEN => ActionError::Forbidden,
        reqwest::StatusCode::CONFLICT => ActionError::Conflict,
        reqwest::StatusCode::UNPROCESSABLE_ENTITY => ActionError::InvalidConfig,
        reqwest::StatusCode::SERVICE_UNAVAILABLE => ActionError::Unavailable,
        _ => ActionError::Failed,
    }
}

async fn read_bounded_utf8(response: reqwest::Response, limit: usize) -> Result<String> {
    use futures_lite::StreamExt;
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("Response body too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Invalid UTF-8 response".into())
}

pub(crate) fn is_route_not_found_body(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.eq_ignore_ascii_case("404 not found") {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };
    if let Some(object) = value.as_object()
        && object.len() == 1
        && (object
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|msg| msg.eq_ignore_ascii_case("Not Found"))
            || object
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|msg| msg.eq_ignore_ascii_case("Not Found")))
    {
        return true;
    }
    value["statusCode"].as_u64() == Some(404)
        && value["error"]
            .as_str()
            .is_some_and(|err| err.eq_ignore_ascii_case("Not Found"))
        && value["message"]
            .as_str()
            .is_some_and(|msg| msg.starts_with("Route "))
}

pub(crate) async fn resolve_directory(
    backend: &Backend,
    requested: Option<&str>,
) -> Result<(String, Option<Value>)> {
    if let Some(dir) = requested.or(backend.session_directory.as_deref()) {
        if !crate::absolute_server_path(dir) {
            return Err("Invalid plugin Location".into());
        }
        return Ok((dir.to_owned(), None));
    }
    if valid_id(&backend.session) {
        let dir = backend.prompt_directory().await?;
        if !crate::absolute_server_path(&dir) {
            return Err("Invalid session Location".into());
        }
        return Ok((dir, None));
    }
    let native = fetch_native_plugins(backend, None).await?;
    let Some(doc) = native else {
        return Err("Plugin inventory unavailable".into());
    };
    let dir = doc["location"]["directory"]
        .as_str()
        .filter(|p| crate::absolute_server_path(p))
        .ok_or("Invalid plugin Location")?;
    Ok((dir.to_owned(), Some(doc)))
}

async fn fetch_native_plugins(backend: &Backend, directory: Option<&str>) -> Result<Option<Value>> {
    let mut request = backend
        .client
        .get(format!(
            "{}workspaces/{}/instance/api/plugin",
            backend.base, backend.workspace
        ))
        .timeout(REQUEST_TIMEOUT);
    if let Some(dir) = directory {
        request = request.query(&[("location[directory]", dir)]);
    }
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?;
    let Some(response) = route_unavailable(response).await? else {
        return Ok(None);
    };
    Ok(Some(read_json_limited(response, MAX_RESPONSE_BYTES).await?))
}

/// Loads full plugin controls from `/api/workspaces/:id/plugin-controls`, falling back to
/// read-only native `GET .../api/plugin` inventory when controls are unavailable (`501`/missing route).
pub async fn load(backend: &Backend, directory: Option<&str>) -> Result<Option<Snapshot>> {
    if !valid_id(&backend.workspace) {
        return Err("Invalid workspace identifier".into());
    }
    let (dir, cached_native) = resolve_directory(backend, directory).await?;
    let request = backend
        .client
        .get(format!(
            "{}api/workspaces/{}/plugin-controls",
            backend.base, backend.workspace
        ))
        .query(&[("directory", dir.as_str())])
        .timeout(REQUEST_TIMEOUT);
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?;
    if let Some(response) = route_unavailable(response).await? {
        let value = read_json_limited(response, MAX_RESPONSE_BYTES).await?;
        return Ok(Some(parse_snapshot(&value, &dir)?));
    }
    let native = match cached_native {
        Some(doc) => Some(doc),
        None => fetch_native_plugins(backend, Some(&dir)).await?,
    };
    let Some(doc) = native else {
        return Ok(None);
    };
    let returned_dir = doc["location"]["directory"]
        .as_str()
        .filter(|p| crate::absolute_server_path(p))
        .ok_or("Invalid plugin inventory Location")?;
    if !super::location_matches(&dir, returned_dir) {
        return Err("Plugin inventory Location mismatch".into());
    }
    let runtime = parse_runtime_entries(&doc["data"])?;
    Ok(Some(Snapshot {
        directory: returned_dir.to_owned(),
        controls_available: false,
        runtime,
        configured_rules: Vec::new(),
        configured_sources: Vec::new(),
        controls: Vec::new(),
        targets: Vec::new(),
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivationResult {
    pub snapshot: Snapshot,
    pub reload_pending: bool,
}

pub async fn set_activation(
    backend: &Backend,
    directory: &str,
    plugin_id: &str,
    scope: Scope,
    enabled: bool,
    managed_by_codenomad: bool,
) -> std::result::Result<ActivationResult, ActionError> {
    if !valid_id(&backend.workspace)
        || !crate::absolute_server_path(directory)
        || !valid_plugin_id(plugin_id)
    {
        return Err(ActionError::Failed);
    }
    let mut body = json!({
        "location": { "directory": directory },
        "pluginId": plugin_id,
        "scope": scope.as_str(),
        "enabled": enabled,
    });
    if managed_by_codenomad {
        body["managedBy"] = json!("codenomad");
    }
    let response = backend
        .client
        .patch(format!(
            "{}api/workspaces/{}/plugin-controls",
            backend.base, backend.workspace
        ))
        .json(&body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| ActionError::Failed)?;
    if !response.status().is_success() {
        return Err(classify_action_error(response).await);
    }
    let value = read_json_limited(response, MAX_RESPONSE_BYTES)
        .await
        .map_err(|_| ActionError::Failed)?;
    let snapshot =
        parse_snapshot(&value["snapshot"], directory).map_err(|_| ActionError::Failed)?;
    let reload_pending = value["reloadPending"] == Value::Bool(true);
    Ok(ActivationResult {
        snapshot,
        reload_pending,
    })
}

pub async fn add_source(
    backend: &Backend,
    directory: &str,
    scope: Scope,
    spec: &str,
) -> std::result::Result<String, ActionError> {
    add_source_with_timeout(backend, directory, scope, spec, super::ADD_SOURCE_TIMEOUT).await
}

pub(crate) async fn add_source_with_timeout(
    backend: &Backend,
    directory: &str,
    scope: Scope,
    spec: &str,
    timeout: std::time::Duration,
) -> std::result::Result<String, ActionError> {
    let trimmed = spec.trim();
    if !valid_id(&backend.workspace)
        || !crate::absolute_server_path(directory)
        || trimmed.is_empty()
        || trimmed.chars().count() > MAX_SPEC_CHARS
        || trimmed.bytes().any(|b| !(0x20..=0x7E).contains(&b))
    {
        return Err(ActionError::Code("invalid-spec".into()));
    }
    let response = backend
        .client
        .post(format!(
            "{}api/workspaces/{}/plugin-sources",
            backend.base, backend.workspace
        ))
        .json(&json!({
            "location": { "directory": directory },
            "scope": scope.as_str(),
            "spec": trimmed,
        }))
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ActionError::Failed)?;
    if !response.status().is_success() {
        return Err(classify_action_error(response).await);
    }
    let value = read_json_limited(response, 32 * 1024)
        .await
        .map_err(|_| ActionError::Failed)?;
    if value["scope"].as_str() != Some(scope.as_str())
        || value["reloadPending"] != Value::Bool(true)
    {
        return Err(ActionError::Failed);
    }
    Ok(value["spec"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_owned())
}

pub async fn remove_source(
    backend: &Backend,
    directory: &str,
    removal: &RemovalTarget,
) -> std::result::Result<(), ActionError> {
    if !valid_id(&backend.workspace)
        || !crate::absolute_server_path(directory)
        || removal.target.is_empty()
        || !valid_revision(&removal.expected_revision)
    {
        return Err(ActionError::Failed);
    }
    let payload = match removal.entry_index {
        Some(entry_index) => json!({
            "location": { "directory": directory },
            "scope": removal.scope.as_str(),
            "target": removal.target,
            "entryIndex": entry_index,
            "expectedRevision": removal.expected_revision,
        }),
        None => json!({
            "location": { "directory": directory },
            "scope": removal.scope.as_str(),
            "pluginId": removal.target,
            "expectedRevision": removal.expected_revision,
        }),
    };
    let response = backend
        .client
        .delete(format!(
            "{}api/workspaces/{}/plugin-sources",
            backend.base, backend.workspace
        ))
        .json(&payload)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| ActionError::Failed)?;
    if !response.status().is_success() {
        return Err(classify_action_error(response).await);
    }
    let value = read_json_limited(response, 32 * 1024)
        .await
        .map_err(|_| ActionError::Failed)?;
    if value["scope"].as_str() != Some(removal.scope.as_str())
        || value["spec"].as_str() != Some(removal.target.as_str())
        || value["reloadPending"] != Value::Bool(true)
    {
        return Err(ActionError::Failed);
    }
    Ok(())
}

pub async fn run_package_action(
    backend: &Backend,
    directory: &str,
    target: &str,
    update: bool,
) -> std::result::Result<(), ActionError> {
    if !valid_id(&backend.workspace)
        || !crate::absolute_server_path(directory)
        || target.is_empty()
        || target.chars().count() > MAX_SPEC_CHARS
        || target.chars().any(char::is_control)
    {
        return Err(ActionError::Failed);
    }
    let suffix = if update { "update" } else { "check" };
    let body = if update {
        json!({ "targets": [target] })
    } else {
        json!({ "target": target })
    };
    let response = backend
        .client
        .post(format!(
            "{}workspaces/{}/instance/api/plugin/{suffix}",
            backend.base, backend.workspace
        ))
        .query(&[("location[directory]", directory)])
        .json(&body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| ActionError::Failed)?;
    if !response.status().is_success() {
        return Err(classify_action_error(response).await);
    }
    Ok(())
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 256
        && !id.starts_with('-')
        && !id.contains('*')
        && !id.chars().any(char::is_control)
}
