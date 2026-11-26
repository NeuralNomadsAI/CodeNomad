//! Provider account display metadata and opt-in automatic account selection policy.
//! Credential exports never cross the broker.
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::time::Duration;

use super::{Endpoint, plans, selection};
use crate::{App, Error, Shared, auth::Principal, error, shared::now_ms};

const MAX_WRITE_BODY: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadInput {
    directory: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteInput {
    directory: String,
    enabled: bool,
}

struct Snapshot {
    supported: bool,
    enabled: bool,
    logins: Map<String, Value>,
}

pub(super) async fn get_route(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((workspace, integration)): Path<(String, String)>,
    query: Result<Query<ReadInput>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let invalid = || error(Status::BAD_REQUEST, "Invalid provider accounts request");
    let work = async {
        let Query(input) = query.map_err(|_| invalid())?;
        validate_params(&workspace, &integration, &input.directory)?;
        let snapshot = read_snapshot(&app, &workspace, &integration, &input.directory, false).await?;
        principal.live()?;
        Ok(Json(json!({
            "supported": snapshot.supported,
            "enabled": snapshot.enabled,
            "logins": snapshot.logins,
        })))
    };
    let result = tokio::select! {
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15), work) => result.unwrap_or_else(|_| Err(unavailable())),
    };
    ([(header::CACHE_CONTROL, "no-store")], result).into_response()
}

pub(super) async fn put_route(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((workspace, integration)): Path<(String, String)>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let invalid = || error(Status::BAD_REQUEST, "Invalid provider accounts request");
    let work = async {
        if bytes.len() > MAX_WRITE_BODY || !is_json_header(&headers) {
            return Err(invalid());
        }
        let input: WriteInput = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        validate_params(&workspace, &integration, &input.directory)?;
        let result = write_policy(&app, &principal, &workspace, &integration, &input).await?;
        principal.live()?;
        Ok(Json(result))
    };
    let result = tokio::select! {
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15), work) => result.unwrap_or_else(|_| Err(unavailable())),
    };
    ([(header::CACHE_CONTROL, "no-store")], result).into_response()
}

fn is_json_header(headers: &HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| {
        let b = ct.as_bytes();
        b.len() >= 16
            && b[..16].eq_ignore_ascii_case(b"application/json")
            && b.get(16).is_none_or(|&c| !(c.is_ascii_alphanumeric() || c == b'_'))
    })
}

fn validate_params(workspace: &str, integration: &str, directory: &str) -> Result<(), Error> {
    if ![workspace, integration].iter().all(|id| !id.is_empty() && id.encode_utf16().count() <= 256)
        || directory.is_empty()
        || directory.encode_utf16().count() > 4096
        || directory.contains('\0')
    {
        return Err(error(Status::BAD_REQUEST, "Invalid provider accounts request"));
    }
    Ok(())
}

fn unavailable() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Provider accounts unavailable")
}

async fn native(app: &App, endpoint: &Endpoint, url: reqwest::Url) -> Result<Value, Error> {
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .send()
        .await
        .map_err(|_| unavailable())?;
    if response.status() != Status::OK {
        return Err(unavailable());
    }
    crate::opencode::read_json(response, 8 * 1024 * 1024).await.map_err(|_| unavailable())
}

async fn write_policy(
    app: &App,
    principal: &Principal,
    workspace_id: &str,
    integration: &str,
    input: &WriteInput,
) -> Result<Value, Error> {
    let workspace = app.workspace(workspace_id).map_err(|_| error(Status::NOT_FOUND, "Workspace not found"))?;
    let endpoint =
        app.native.acquire(tokio::time::Instant::now() + Duration::from_secs(15)).await.map_err(|_| unavailable())?;
    let foreign = || error(Status::FORBIDDEN, "Location does not belong to workspace");
    let owned = crate::worktrees::ownership::resolve(app, &workspace, &input.directory).await.ok_or_else(foreign)?;
    let _fence = crate::worktrees::fence::admit(&[crate::worktrees::fence::identity(&owned.checkout)])?;
    let snapshot =
        snapshot_for_owned(app, &workspace, &endpoint, integration, &owned.directory, &owned.checkout).await?;
    principal.live()?;
    if !selection::supports(integration) || (input.enabled && !snapshot.supported) {
        return Err(error(Status::CONFLICT, "Automatic account selection unavailable"));
    }
    crate::settings::patch_owner(
        app,
        crate::settings::Kind::Config,
        "providerAccounts",
        json!({ "autoSelect": { integration: input.enabled } }),
    )
    .map_err(|_| unavailable())?;
    app.provider_usage.accounts.note_policy_change();
    Ok(json!({
        "supported": snapshot.supported,
        "enabled": input.enabled,
        "logins": snapshot.logins,
    }))
}

async fn read_snapshot(
    app: &App,
    workspace_id: &str,
    integration: &str,
    directory: &str,
    _write: bool,
) -> Result<Snapshot, Error> {
    let workspace = app.workspace(workspace_id).map_err(|_| error(Status::NOT_FOUND, "Workspace not found"))?;
    let endpoint =
        app.native.acquire(tokio::time::Instant::now() + Duration::from_secs(15)).await.map_err(|_| unavailable())?;
    let foreign = || error(Status::FORBIDDEN, "Location does not belong to workspace");
    let owned = crate::worktrees::ownership::resolve(app, &workspace, directory).await.ok_or_else(foreign)?;
    snapshot_for_owned(app, &workspace, &endpoint, integration, &owned.directory, &owned.checkout).await
}

async fn snapshot_for_owned(
    app: &App,
    workspace: &crate::Workspace,
    endpoint: &std::sync::Arc<Endpoint>,
    integration: &str,
    directory: &str,
    checkout: &std::path::Path,
) -> Result<Snapshot, Error> {
    let foreign = || error(Status::FORBIDDEN, "Location does not belong to workspace");
    if !crate::sessions::permission_mode::workspace_current(app, workspace) {
        return Err(foreign());
    }
    if !app.native.current(endpoint) {
        return Err(unavailable());
    }
    let Some(spec) = selection::adapter(integration) else {
        if !crate::worktrees::ownership::resolve(app, workspace, directory)
            .await
            .is_some_and(|latest| latest.directory == directory && latest.checkout == checkout)
            || !crate::sessions::permission_mode::workspace_current(app, workspace)
        {
            return Err(foreign());
        }
        if !app.native.current(endpoint) {
            return Err(unavailable());
        }
        return Ok(Snapshot { supported: false, enabled: false, logins: Map::new() });
    };
    let mut url =
        endpoint.url.join(&format!("/api/integration/{}", plans::encode(integration))).map_err(|_| unavailable())?;
    url.query_pairs_mut().append_pair("location[directory]", directory);
    let binding = native(app, endpoint, url).await?;
    if binding["location"]["directory"] != directory
        || binding["location"].get("workspaceID").is_some()
        || binding["data"]["id"] != integration
        || !app.native.current(endpoint)
    {
        return Err(unavailable());
    }
    let exports = native(app, endpoint, endpoint.url.join("/api/credential").map_err(|_| unavailable())?).await?;
    let entries = exports["data"].as_array().ok_or_else(unavailable)?;
    let connections = binding["data"]["connections"].as_array().ok_or_else(unavailable)?;
    let mut logins = Map::new();
    let mut eligible = 0usize;
    let now = now_ms();
    for item in connections.iter().take(128) {
        if item["type"] != "credential"
            || !item["method"].as_str().is_some_and(|method| selection::accepts_method(spec, method))
        {
            continue;
        }
        let Some(id) = item["id"].as_str().filter(|id| !id.is_empty() && id.encode_utf16().count() <= 256) else {
            continue;
        };
        let Some(entry) = entries.iter().find(|entry| entry["id"] == id && entry["integrationID"] == integration)
        else {
            continue;
        };
        let Some(cred) = selection::build_credential(spec, entry, now) else { continue };
        eligible += 1;
        if item["label"] == "default"
            && let Some(email) = cred.login
        {
            logins.insert(id.into(), json!(email));
        }
    }
    let enabled = app.provider_usage.accounts.is_enabled(app, integration);
    if !crate::worktrees::ownership::resolve(app, workspace, directory)
        .await
        .is_some_and(|latest| latest.directory == directory && latest.checkout == checkout)
        || !crate::sessions::permission_mode::workspace_current(app, workspace)
    {
        return Err(foreign());
    }
    if !app.native.current(endpoint) {
        return Err(unavailable());
    }
    Ok(Snapshot { supported: eligible >= 2, enabled, logins })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_display_keeps_only_a_bounded_email() {
        assert!(selection::display_email("fixture@example.test"));
        for invalid in ["fixture", "a@@example.test", "a@domain", "a\u{7f}@example.test", "a @example.test"] {
            assert!(!selection::display_email(invalid), "{invalid:?}");
        }
        assert!(!selection::display_email(&format!("{}@example.test", "a".repeat(250))));
        let entry = json!({
            "id": "cred_1",
            "integrationID": "anthropic",
            "value": {"type":"oauth","access":"fixture","metadata":{"email":"  claude@example.test  "}}
        });
        let spec = selection::adapter("anthropic").unwrap();
        assert_eq!(
            selection::build_credential(spec, &entry, now_ms()).unwrap().login.as_deref(),
            Some("claude@example.test")
        );
        let bad_console = json!({
            "id": "cred_2",
            "integrationID": "opencode",
            "value": {"type":"oauth","access":"fixture","metadata":{"email":"  claude@example.test  "}}
        });
        assert!(selection::build_credential(selection::adapter("opencode").unwrap(), &bad_console, now_ms()).is_none());
    }
}
