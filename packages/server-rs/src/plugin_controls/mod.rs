//! Plugin controls and sources HTTP routes (`server/routes/plugin-controls.ts`,
//! `server/routes/plugin-sources.ts`):
//! - `GET`/`PATCH /api/workspaces/:id/plugin-controls`
//! - `POST`/`DELETE /api/workspaces/:id/plugin-sources`

pub(crate) mod catalog;
mod discovery;
mod doc;
pub(crate) mod engine;
mod json_utf16;
mod order;
pub(crate) mod snapshot;
pub(crate) mod sources;
pub(crate) mod spec;

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::{
    Shared,
    auth::Principal,
    opencode_settings::{
        Scope, bad_request, close_response, decode_query, location_directory, principal_token, read_body_bytes,
    },
    shared::fastify,
    subagent_depth::Fail,
};

use self::{
    engine::ActivationMutationRequest,
    json_utf16::{JsVal, eq_ascii, js_trim_u16, parse_strict_json},
    order::valid_plugin_id,
    snapshot::ControlLocation,
    sources::{SourceAddRequest, SourceError, SourceRemoveRequest, SourceRemoveTarget, is_expected_revision},
    spec::{PLUGIN_SOURCE_MAX_SPEC_LENGTH, validate_plugin_source_spec},
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
    Some(ControlLocation::new(directory?, workspace_id))
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
    Some(ControlLocation::new(directory, workspace_id))
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
    Some(ActivationMutationRequest { location, plugin_id: Some(plugin_id), scope, enabled, managed_by })
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
    match err {
        SourceError::Refused { status, code } => {
            let body = match code {
                Some(code) => json!({ "error": "Plugin source update refused", "code": code }),
                None => json!({ "error": "Plugin source update refused" }),
            };
            (status, Json(body)).into_response()
        }
        SourceError::Failed => {
            (Status::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Plugin source update failed" }))).into_response()
        }
    }
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

enum JsonBody {
    Utf8(Value),
    Utf16(JsVal),
}

async fn read_plugin_json_body(
    headers: &HeaderMap,
    body: Body,
    invalid_message: &'static str,
) -> Result<JsonBody, Box<Response>> {
    let bytes = read_body_bytes(headers, body, invalid_message).await?;
    match fastify::body(headers, &bytes) {
        Ok(Some(fastify::Body::Json(value))) => Ok(JsonBody::Utf8(value)),
        Ok(_) => Err(Box::new(bad_request(invalid_message))),
        Err(err) => {
            let is_json = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"))
                .unwrap_or(false);
            if err.0 == Status::BAD_REQUEST
                && is_json
                && !bytes.is_empty()
                && let Some(js) = parse_strict_json(&bytes)
            {
                // If the final deduplicated object (last-key-wins) is losslessly UTF-8 (e.g. an
                // earlier lone surrogate was shadowed by a later key), take the normal UTF-8 path.
                return Ok(match js.to_utf8_json() {
                    Some(val) => JsonBody::Utf8(val),
                    None => JsonBody::Utf16(js),
                });
            }
            let close = err.0 == Status::BAD_REQUEST;
            let response = err.into_response();
            Err(Box::new(if close { close_response(response) } else { response }))
        }
    }
}

fn parse_location_u16(val: &JsVal) -> Option<ControlLocation> {
    let entries = val.as_object()?;
    for (k, _) in entries {
        if !eq_ascii(k, "directory") && !eq_ascii(k, "workspaceID") {
            return None;
        }
    }
    let dir_u16 = js_trim_u16(val.get_ascii("directory")?.as_u16_str()?);
    if !(1..=32_768).contains(&dir_u16.len()) {
        return None;
    }
    let (directory, unrepresentable_directory) = match String::from_utf16(dir_u16) {
        Ok(dir) => (dir, false),
        // Preserve NUL presence (`422` before daemon check) while keeping `unrepresentable_directory`
        // distinct so ownership fails closed (`403`) only after daemon availability (`503`).
        Err(_) => (if dir_u16.contains(&0) { "\0".to_owned() } else { "x".to_owned() }, true),
    };
    let (workspace_id, unrepresentable_workspace_id) = match val.get_ascii("workspaceID") {
        None => (None, false),
        Some(v) => {
            let w = js_trim_u16(v.as_u16_str()?);
            if !(1..=1_024).contains(&w.len()) {
                return None;
            }
            match String::from_utf16(w) {
                Ok(id) => (Some(id), false),
                Err(_) => (None, true),
            }
        }
    };
    Some(ControlLocation { directory, workspace_id, unrepresentable_directory, unrepresentable_workspace_id })
}

fn parse_scope_u16(val: Option<&JsVal>) -> Option<Scope> {
    let s = val?.as_u16_str()?;
    if eq_ascii(s, "global") {
        Some(Scope::Global)
    } else if eq_ascii(s, "project") {
        Some(Scope::Project)
    } else {
        None
    }
}

fn valid_plugin_id_u16(raw: &[u16]) -> bool {
    let trimmed = js_trim_u16(raw);
    if !(1..=256).contains(&trimmed.len()) || trimmed[0] == u16::from(b'-') {
        return false;
    }
    !trimmed.iter().any(|&u| u <= 0x1f || u == 0x7f || u == u16::from(b'*'))
}

async fn patch_controls(
    State(app): State<Shared>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let parsed = match read_plugin_json_body(&headers, body, INVALID_ACTIVATION).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match parsed {
        JsonBody::Utf8(value) => {
            let Some(req) = parse_activation_mutation(&value) else {
                return bad_request(INVALID_ACTIVATION);
            };
            match engine::mutate(&app, &workspace_id, req, principal_token(principal)).await {
                Ok(result) => (Status::OK, Json(result)).into_response(),
                Err(err) => controls_error(err),
            }
        }
        JsonBody::Utf16(js) => {
            let Some(entries) = js.as_object() else { return bad_request(INVALID_ACTIVATION) };
            for (k, _) in entries {
                if !eq_ascii(k, "location")
                    && !eq_ascii(k, "pluginId")
                    && !eq_ascii(k, "scope")
                    && !eq_ascii(k, "enabled")
                    && !eq_ascii(k, "managedBy")
                {
                    return bad_request(INVALID_ACTIVATION);
                }
            }
            let Some(location) = js.get_ascii("location").and_then(parse_location_u16) else {
                return bad_request(INVALID_ACTIVATION);
            };
            let Some(pid_u16) = js.get_ascii("pluginId").and_then(JsVal::as_u16_str) else {
                return bad_request(INVALID_ACTIVATION);
            };
            let Some(scope) = parse_scope_u16(js.get_ascii("scope")) else {
                return bad_request(INVALID_ACTIVATION);
            };
            let Some(enabled) = js.get_ascii("enabled").and_then(JsVal::as_bool) else {
                return bad_request(INVALID_ACTIVATION);
            };
            if !valid_plugin_id_u16(pid_u16) {
                return bad_request(INVALID_ACTIVATION);
            }
            let managed_by = match js.get_ascii("managedBy") {
                None => None,
                Some(mb) if mb.as_u16_str().is_some_and(|u| eq_ascii(u, "codenomad")) => Some("codenomad".to_owned()),
                Some(_) => return bad_request(INVALID_ACTIVATION),
            };
            let plugin_id = String::from_utf16(js_trim_u16(pid_u16)).ok();
            let req = ActivationMutationRequest { location, plugin_id, scope, enabled, managed_by };
            match engine::mutate(&app, &workspace_id, req, principal_token(principal)).await {
                Ok(result) => (Status::OK, Json(result)).into_response(),
                Err(err) => controls_error(err),
            }
        }
    }
}

async fn post_source(
    State(app): State<Shared>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let parsed = match read_plugin_json_body(&headers, body, INVALID_SOURCE).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match parsed {
        JsonBody::Utf8(value) => {
            let Some(req) = parse_source_add(&value) else {
                return bad_request(INVALID_SOURCE);
            };
            match sources::add(&app, &workspace_id, req, principal_token(principal)).await {
                Ok(result) => (Status::OK, Json(result)).into_response(),
                Err(err) => sources_error(err),
            }
        }
        JsonBody::Utf16(js) => {
            let Some(entries) = js.as_object() else { return bad_request(INVALID_SOURCE) };
            for (k, _) in entries {
                if !eq_ascii(k, "location") && !eq_ascii(k, "scope") && !eq_ascii(k, "spec") {
                    return bad_request(INVALID_SOURCE);
                }
            }
            let Some(location) = js.get_ascii("location").and_then(parse_location_u16) else {
                return bad_request(INVALID_SOURCE);
            };
            let Some(scope) = parse_scope_u16(js.get_ascii("scope")) else {
                return bad_request(INVALID_SOURCE);
            };
            let Some(spec_u16) = js.get_ascii("spec").and_then(JsVal::as_u16_str) else {
                return bad_request(INVALID_SOURCE);
            };
            if !(1..=PLUGIN_SOURCE_MAX_SPEC_LENGTH).contains(&spec_u16.len()) {
                return bad_request(INVALID_SOURCE);
            }
            // Spec validation runs before any workspace or location lookup (`plugin-sources.ts:49-53`).
            let Ok(spec_str) = String::from_utf16(spec_u16) else {
                return sources_error(SourceError::with_code(Status::UNPROCESSABLE_ENTITY, "invalid-spec"));
            };
            if let Err((code, _)) = validate_plugin_source_spec(&spec_str) {
                return sources_error(SourceError::with_code(Status::UNPROCESSABLE_ENTITY, code.as_str()));
            }
            let req = SourceAddRequest { location, scope, spec: spec_str };
            match sources::add(&app, &workspace_id, req, principal_token(principal)).await {
                Ok(result) => (Status::OK, Json(result)).into_response(),
                Err(err) => sources_error(err),
            }
        }
    }
}

async fn delete_source(
    State(app): State<Shared>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let parsed = match read_plugin_json_body(&headers, body, INVALID_SOURCE).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match parsed {
        JsonBody::Utf8(value) => {
            let Some(req) = parse_source_remove(&value) else {
                return bad_request(INVALID_SOURCE);
            };
            match sources::remove(&app, &workspace_id, req, principal_token(principal)).await {
                Ok(result) => (Status::OK, Json(result)).into_response(),
                Err(err) => sources_error(err),
            }
        }
        JsonBody::Utf16(js) => {
            let Some(entries) = js.as_object() else { return bad_request(INVALID_SOURCE) };
            let Some(location) = js.get_ascii("location").and_then(parse_location_u16) else {
                return bad_request(INVALID_SOURCE);
            };
            let Some(scope) = parse_scope_u16(js.get_ascii("scope")) else {
                return bad_request(INVALID_SOURCE);
            };
            let Some(rev_u16) = js.get_ascii("expectedRevision").and_then(JsVal::as_u16_str) else {
                return bad_request(INVALID_SOURCE);
            };
            let Ok(rev) = String::from_utf16(rev_u16) else {
                return bad_request(INVALID_SOURCE);
            };
            if !is_expected_revision(&rev) {
                return bad_request(INVALID_SOURCE);
            }
            if let Some(target_u16) = js.get_ascii("target").and_then(JsVal::as_u16_str) {
                for (k, _) in entries {
                    if !eq_ascii(k, "location")
                        && !eq_ascii(k, "scope")
                        && !eq_ascii(k, "expectedRevision")
                        && !eq_ascii(k, "target")
                        && !eq_ascii(k, "entryIndex")
                    {
                        return bad_request(INVALID_SOURCE);
                    }
                }
                let Some(idx) = js.get_ascii("entryIndex").and_then(JsVal::as_f64) else {
                    return bad_request(INVALID_SOURCE);
                };
                if !(1..=32_768).contains(&target_u16.len()) || idx.fract() != 0.0 || !(0.0..=100_000.0).contains(&idx)
                {
                    return bad_request(INVALID_SOURCE);
                }
            } else if let Some(pid_u16) = js.get_ascii("pluginId").and_then(JsVal::as_u16_str) {
                for (k, _) in entries {
                    if !eq_ascii(k, "location")
                        && !eq_ascii(k, "scope")
                        && !eq_ascii(k, "expectedRevision")
                        && !eq_ascii(k, "pluginId")
                    {
                        return bad_request(INVALID_SOURCE);
                    }
                }
                if !(1..=256).contains(&pid_u16.len()) {
                    return bad_request(INVALID_SOURCE);
                }
            } else {
                return bad_request(INVALID_SOURCE);
            }
            // Reuse the full ordinary DELETE pipeline (queues, daemon availability, scope, ownership,
            // worktree fence, revision confirmation) and fail as `409 stale` at comparison time.
            let req = SourceRemoveRequest {
                location,
                scope,
                expected_revision: rev,
                kind: SourceRemoveTarget::Unrepresentable,
            };
            match sources::remove(&app, &workspace_id, req, principal_token(principal)).await {
                Ok(result) => (Status::OK, Json(result)).into_response(),
                Err(err) => sources_error(err),
            }
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_http;
