//! Plugin controls and sources HTTP routes (`server/routes/plugin-controls.ts`,
//! `server/routes/plugin-sources.ts`):
//! - `GET`/`PATCH /api/workspaces/:id/plugin-controls`
//! - `POST`/`DELETE /api/workspaces/:id/plugin-sources`

mod discovery;
mod doc;
mod engine;
mod order;
mod snapshot;
mod sources;
mod spec;

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::{
    Shared,
    auth::Principal,
    opencode_settings::{Scope, bad_request, decode_query, location_directory, principal_token, read_json_body},
    subagent_depth::Fail,
};

use self::{
    engine::ActivationMutationRequest,
    order::valid_plugin_id,
    snapshot::ControlLocation,
    sources::{SourceAddRequest, SourceError, SourceRemoveRequest, SourceRemoveTarget, is_expected_revision},
    spec::PLUGIN_SOURCE_MAX_SPEC_LENGTH,
};

const INVALID_ACTIVATION: &str = "Invalid plugin activation request";
const INVALID_SOURCE: &str = "Invalid plugin source request";

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/{id}/plugin-controls", get(get_controls).patch(patch_controls).fallback(not_found))
        .route("/api/workspaces/{id}/plugin-sources", post(post_source).delete(delete_source).fallback(not_found))
}

async fn not_found() -> Response {
    (Status::NOT_FOUND, Json(json!({ "message": "Not Found" }))).into_response()
}

fn workspace_id_field(raw: &str) -> Option<String> {
    let trimmed = crate::shared::js_trim(raw).to_owned();
    (1..=1_024).contains(&trimmed.encode_utf16().count()).then_some(trimmed)
}

/// Strict Zod `{ directory: trim 1..=32_768, workspaceID?: trim 1..=1_024 }` query parser.
fn parse_location_query(raw: Option<&str>) -> Option<ControlLocation> {
    let mut directory: Option<String> = None;
    let mut workspace_id: Option<String> = None;
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match decode_query(key).as_str() {
            "directory" if directory.is_none() => directory = Some(location_directory(&decode_query(value))?),
            "workspaceID" if workspace_id.is_none() => workspace_id = Some(workspace_id_field(&decode_query(value))?),
            _ => return None,
        }
    }
    Some(ControlLocation { directory: directory?, workspace_id })
}

fn parse_location_object(value: &Value) -> Option<ControlLocation> {
    let obj = value.as_object()?;
    for key in obj.keys() {
        if key != "directory" && key != "workspaceID" {
            return None;
        }
    }
    let directory = location_directory(obj.get("directory")?.as_str()?)?;
    let workspace_id = match obj.get("workspaceID") {
        None => None,
        Some(v) => Some(workspace_id_field(v.as_str()?)?),
    };
    Some(ControlLocation { directory, workspace_id })
}

fn parse_scope(value: Option<&Value>) -> Option<Scope> {
    match value?.as_str()? {
        "global" => Some(Scope::Global),
        "project" => Some(Scope::Project),
        _ => None,
    }
}

fn parse_activation_mutation(value: &Value) -> Option<ActivationMutationRequest> {
    let obj = value.as_object()?;
    for key in obj.keys() {
        if !matches!(key.as_str(), "location" | "pluginId" | "scope" | "enabled" | "managedBy") {
            return None;
        }
    }
    let location = parse_location_object(obj.get("location")?)?;
    let plugin_id = crate::shared::js_trim(obj.get("pluginId")?.as_str()?).to_owned();
    if !valid_plugin_id(&plugin_id) {
        return None;
    }
    let scope = parse_scope(obj.get("scope"))?;
    let enabled = obj.get("enabled")?.as_bool()?;
    let managed_by = match obj.get("managedBy") {
        None => None,
        Some(v) if v.as_str() == Some("codenomad") => Some("codenomad".to_owned()),
        Some(_) => return None,
    };
    Some(ActivationMutationRequest { location, plugin_id, scope, enabled, managed_by })
}

fn parse_source_add(value: &Value) -> Option<SourceAddRequest> {
    let obj = value.as_object()?;
    if obj.len() != 3 {
        return None;
    }
    let location = parse_location_object(obj.get("location")?)?;
    let scope = parse_scope(obj.get("scope"))?;
    // Exact string (no trimming): stored entry is exactly what was sent.
    let spec = obj.get("spec")?.as_str()?.to_owned();
    let len = spec.encode_utf16().count();
    if !(1..=PLUGIN_SOURCE_MAX_SPEC_LENGTH).contains(&len) {
        return None;
    }
    Some(SourceAddRequest { location, scope, spec })
}

fn parse_source_remove(value: &Value) -> Option<SourceRemoveRequest> {
    let obj = value.as_object()?;
    let location = parse_location_object(obj.get("location")?)?;
    let scope = parse_scope(obj.get("scope"))?;
    let expected_revision = obj.get("expectedRevision")?.as_str()?.to_owned();
    if !is_expected_revision(&expected_revision) {
        return None;
    }
    if obj.contains_key("target") {
        if obj.len() != 5 {
            return None;
        }
        let target = obj.get("target")?.as_str()?.to_owned();
        if !(1..=32_768).contains(&target.encode_utf16().count()) {
            return None;
        }
        let idx = obj.get("entryIndex")?.as_f64()?;
        if idx.fract() != 0.0 || !(0.0..=100_000.0).contains(&idx) {
            return None;
        }
        Some(SourceRemoveRequest {
            location,
            scope,
            expected_revision,
            kind: SourceRemoveTarget::Entry { target, entry_index: idx as usize },
        })
    } else if obj.contains_key("pluginId") {
        if obj.len() != 4 {
            return None;
        }
        let plugin_id = obj.get("pluginId")?.as_str()?.to_owned();
        if !(1..=256).contains(&plugin_id.encode_utf16().count()) {
            return None;
        }
        Some(SourceRemoveRequest { location, scope, expected_revision, kind: SourceRemoveTarget::Orphan { plugin_id } })
    } else {
        None
    }
}

fn controls_error(err: Fail) -> Response {
    match err {
        Fail::Status(status, message) => (status, Json(json!({ "error": message }))).into_response(),
        Fail::Generic => (Status::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Plugin activation controls failed" })))
            .into_response(),
    }
}

fn sources_error(err: SourceError) -> Response {
    let body = match err.code {
        Some(code) => json!({ "error": "Plugin source update refused", "code": code }),
        None => json!({ "error": "Plugin source update refused" }),
    };
    (err.status, Json(body)).into_response()
}

async fn get_controls(
    State(app): State<Shared>,
    Path(workspace_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    principal: Option<Extension<Principal>>,
) -> Response {
    let Some(location) = parse_location_query(raw_query.as_deref()) else {
        return bad_request(INVALID_ACTIVATION);
    };
    let principal = principal_token(principal);
    match engine::read(&app, &workspace_id, &location, principal.as_ref(), None).await {
        Ok(snapshot) => (Status::OK, Json(snapshot)).into_response(),
        Err(err) => controls_error(err),
    }
}

async fn patch_controls(
    State(app): State<Shared>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let value = match read_json_body(&headers, body, INVALID_ACTIVATION).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(req) = parse_activation_mutation(&value) else {
        return bad_request(INVALID_ACTIVATION);
    };
    match engine::mutate(&app, &workspace_id, req, principal_token(principal)).await {
        Ok(result) => (Status::OK, Json(result)).into_response(),
        Err(err) => controls_error(err),
    }
}

async fn post_source(
    State(app): State<Shared>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let value = match read_json_body(&headers, body, INVALID_SOURCE).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(req) = parse_source_add(&value) else {
        return bad_request(INVALID_SOURCE);
    };
    match sources::add(&app, &workspace_id, req, principal_token(principal)).await {
        Ok(result) => (Status::OK, Json(result)).into_response(),
        Err(err) => sources_error(err),
    }
}

async fn delete_source(
    State(app): State<Shared>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let value = match read_json_body(&headers, body, INVALID_SOURCE).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(req) = parse_source_remove(&value) else {
        return bad_request(INVALID_SOURCE);
    };
    match sources::remove(&app, &workspace_id, req, principal_token(principal)).await {
        Ok(result) => (Status::OK, Json(result)).into_response(),
        Err(err) => sources_error(err),
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_http;
