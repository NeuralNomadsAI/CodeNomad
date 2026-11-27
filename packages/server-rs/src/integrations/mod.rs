//! OpenCode integrations catalog, installation and native host attachment routes:
//! - `GET /api/workspaces/:id/integrations` (`routes/integrations.ts`)
//! - `POST /api/workspaces/:id/integrations/:integrationId/install` (`routes/integration-install.ts`)
//! - `GET /api/workspaces/:id/integrations/:integrationId/hosts` (`routes/integration-attachments.ts`)
//! - `GET /api/workspaces/:id/integrations/:integrationId/binding` (`routes/integration-attachments.ts`)
//! - `POST /api/workspaces/:id/integrations/:integrationId/install-host` (`routes/integration-attachments.ts`)
//! - `POST /api/workspaces/:id/integrations/:integrationId/attach` (`routes/integration-attachments.ts`)
//! - `POST /api/workspaces/:id/integrations/:integrationId/detach` (`routes/integration-attachments.ts`)

pub(crate) mod attachments;
pub(crate) mod contract;
pub(crate) mod install;
pub(crate) mod reader;
pub(crate) mod recognition;

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, RawQuery, State, rejection::PathRejection},
    http::{HeaderMap, HeaderValue, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::{
    Shared,
    auth::Principal,
    opencode_settings::{Scope, close_response, decode_query, location_directory, principal_token},
    plugin_controls::{catalog::valid_integration_id, snapshot::ControlLocation},
    shared::fastify,
    subagent_depth::Fail,
};

use self::{
    attachments::AttachmentError,
    contract::{valid_native_session_id, valid_offer_id},
    install::InstallError,
};

const BODY_LIMIT: usize = 1024 * 1024;
const INVALID_READ: &str = "Invalid integrations request";
const INVALID_INSTALL: &str = "Invalid integration install request";
const INVALID_ATTACHMENT: &str = "Invalid integration attachment request";

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/{id}/integrations", get(get_integrations).fallback(not_found))
        .route("/api/workspaces/{id}/integrations/", any(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}", any(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/", any(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/install", post(post_install).fallback(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/hosts", get(get_hosts).fallback(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/binding", get(get_binding).fallback(not_found))
        .route(
            "/api/workspaces/{id}/integrations/{integrationId}/install-host",
            post(post_install_host).fallback(not_found),
        )
        .route("/api/workspaces/{id}/integrations/{integrationId}/attach", post(post_attach).fallback(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/detach", post(post_detach).fallback(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/{action}", any(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/{action}/", any(not_found))
        .route("/api/workspaces/{id}/integrations/{integrationId}/{action}/{*rest}", any(not_found))
}

fn decode_segment(seg: &str) -> Option<std::borrow::Cow<'_, str>> {
    percent_encoding::percent_decode_str(seg).decode_utf8().ok()
}

/// True for any path under `/api/workspaces/:id/integrations` (including percent-encoded prefix
/// segments, `;` query delimiters like Fastify/find-my-way, and unmatched subpaths), used to
/// enforce `Cache-Control: no-store` on admission refusals and trace redaction.
pub(crate) fn is_integrations_path(path: &str) -> bool {
    let path = path.split_once(';').map_or(path, |(head, _)| head);
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let mut parts = rest.split('/');
    let (Some(api), Some(workspaces), Some(ws), Some(integrations)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    !ws.is_empty()
        && decode_segment(api).is_some_and(|s| s == "api")
        && decode_segment(workspaces).is_some_and(|s| s == "workspaces")
        && decode_segment(integrations).is_some_and(|s| s == "integrations")
}

/// Strict native JSON response Content-Type check (`application/json` or `application/*+json`).
pub(crate) fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| {
        let essence = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        essence == "application/json" || (essence.starts_with("application/") && essence.ends_with("+json"))
    })
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn not_found() -> Response {
    no_store((Status::NOT_FOUND, Json(json!({ "message": "Not Found" }))).into_response())
}

fn invalid_install() -> Response {
    no_store((Status::BAD_REQUEST, Json(json!({ "error": INVALID_INSTALL, "code": "invalid" }))).into_response())
}

fn invalid_attachment() -> Response {
    no_store((Status::BAD_REQUEST, Json(json!({ "error": INVALID_ATTACHMENT, "code": "invalid" }))).into_response())
}

fn install_error_response(err: InstallError) -> Response {
    if err == InstallError::Unauthorized {
        return no_store(crate::auth::unauthorized().into_response());
    }
    let code = err.code();
    no_store(
        (err.status(), Json(json!({ "error": format!("Integration install {code}"), "code": code }))).into_response(),
    )
}

fn attachment_error_response(err: AttachmentError) -> Response {
    if err == AttachmentError::Unauthorized {
        return no_store(crate::auth::unauthorized().into_response());
    }
    let code = err.code();
    no_store(
        (err.status(), Json(json!({ "error": format!("Integration attachment {code}"), "code": code })))
            .into_response(),
    )
}

fn decode_query_strict(raw: &str) -> Option<String> {
    let plus = raw.replace('+', " ");
    percent_encoding::percent_decode_str(&plus).decode_utf8().ok().map(|c| c.into_owned())
}

fn strict_directory(value: &str) -> Option<String> {
    let len = value.encode_utf16().count();
    if !(1..=32_768).contains(&len) || crate::shared::js_trim(value) != value || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_owned())
}

fn parse_directory_only_query(raw: Option<&str>) -> Option<String> {
    let mut directory: Option<String> = None;
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if decode_query_strict(key)?.as_str() != "directory" || directory.is_some() {
            return None;
        }
        directory = Some(strict_directory(&decode_query_strict(value)?)?);
    }
    directory
}

fn parse_binding_query(raw: Option<&str>) -> Option<(String, String)> {
    let mut directory: Option<String> = None;
    let mut session_id: Option<String> = None;
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match decode_query_strict(key)?.as_str() {
            "directory" if directory.is_none() => directory = Some(strict_directory(&decode_query_strict(value)?)?),
            "sessionID" if session_id.is_none() => {
                let decoded = decode_query_strict(value)?;
                if !valid_native_session_id(&decoded) {
                    return None;
                }
                session_id = Some(decoded);
            }
            _ => return None,
        }
    }
    Some((directory?, session_id?))
}

fn parse_read_query(raw: Option<&str>) -> Option<ControlLocation> {
    let mut directory: Option<String> = None;
    let mut workspace_id: Option<String> = None;
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match decode_query(key).as_str() {
            "directory" if directory.is_none() => directory = Some(location_directory(&decode_query(value))?),
            "workspaceID" if workspace_id.is_none() => {
                let trimmed = crate::shared::js_trim(&decode_query(value)).to_owned();
                if !(1..=1_024).contains(&trimmed.encode_utf16().count()) {
                    return None;
                }
                workspace_id = Some(trimmed);
            }
            _ => return None,
        }
    }
    Some(ControlLocation::new(directory?, workspace_id))
}

fn valid_params(workspace_id: &str, integration_id: &str) -> bool {
    (1..=512).contains(&workspace_id.encode_utf16().count()) && valid_integration_id(integration_id)
}

async fn read_post_json(headers: &HeaderMap, body: Body, invalid: fn() -> Response) -> Result<Value, Box<Response>> {
    let raw_content_length = headers.get(header::CONTENT_LENGTH);
    let declared_len = raw_content_length.and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok());
    let has_transfer_encoding = headers.contains_key(header::TRANSFER_ENCODING);
    let media_error = || {
        Box::new(no_store(
            fastify::error(Status::UNSUPPORTED_MEDIA_TYPE, "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type")
                .into_response(),
        ))
    };
    let too_large = || {
        Box::new(no_store(close_response(
            fastify::error(Status::PAYLOAD_TOO_LARGE, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
                .into_response(),
        )))
    };

    match headers.get(header::CONTENT_TYPE) {
        None => {
            if has_transfer_encoding || raw_content_length.is_some_and(|v| v.as_bytes() != b"0") {
                return Err(media_error());
            }
            // Empty body without Content-Type -> `request.body === undefined` -> 400 invalid.
            let mut stream = body.into_data_stream();
            while let Some(chunk) = stream.next().await {
                let Ok(chunk) = chunk else {
                    return Err(Box::new(no_store(close_response(Status::BAD_REQUEST.into_response()))));
                };
                if !chunk.is_empty() {
                    return Err(media_error());
                }
            }
            return Err(Box::new(invalid()));
        }
        Some(kind) => {
            let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if !matches!(essence.as_str(), "application/json" | "text/plain") {
                return Err(media_error());
            }
        }
    }

    if declared_len.is_some_and(|n| n > BODY_LIMIT as u64) {
        return Err(too_large());
    }

    let mut bytes = Vec::new();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return Err(Box::new(no_store(close_response(Status::BAD_REQUEST.into_response()))));
        };
        if bytes.len().saturating_add(chunk.len()) > BODY_LIMIT {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    match fastify::body(headers, &bytes) {
        Ok(Some(fastify::Body::Json(value))) => Ok(value),
        Ok(_) => Err(Box::new(invalid())),
        Err(err) => {
            let close = err.0 == Status::BAD_REQUEST;
            let resp = no_store(err.into_response());
            Err(Box::new(if close { close_response(resp) } else { resp }))
        }
    }
}

const FASTIFY_MAX_PARAM_LEN: usize = 100;

/// Fastify 5 (`find-my-way` `maxParamLength: 100`) checks parameter length AFTER percent-decoding
/// and leaves any route whose decoded parameter exceeds 100 UTF-16 code units unmatched (`404`).
fn param_exceeds_fastify_limit(params: &[&str]) -> bool {
    params.iter().any(|p| p.encode_utf16().count() > FASTIFY_MAX_PARAM_LEN)
}

async fn get_integrations(
    State(app): State<Shared>,
    workspace: Result<Path<String>, PathRejection>,
    RawQuery(raw): RawQuery,
    principal: Option<Extension<Principal>>,
) -> Response {
    let Ok(Path(workspace_id)) = workspace else {
        return no_store((Status::BAD_REQUEST, Json(json!({ "error": INVALID_READ }))).into_response());
    };
    if param_exceeds_fastify_limit(&[&workspace_id]) {
        return not_found().await;
    }
    let Some(location) = parse_read_query(raw.as_deref()) else {
        return no_store((Status::BAD_REQUEST, Json(json!({ "error": INVALID_READ }))).into_response());
    };
    match reader::read(&app, &workspace_id, &location, principal_token(principal).as_ref()).await {
        Ok(view) => no_store((Status::OK, Json(view)).into_response()),
        Err(Fail::Status(status, message)) => no_store((status, Json(json!({ "error": message }))).into_response()),
        Err(Fail::Generic) => no_store(
            (Status::INTERNAL_SERVER_ERROR, Json(json!({ "error": "OpenCode integrations read failed" })))
                .into_response(),
        ),
    }
}

async fn post_install(
    State(app): State<Shared>,
    params: Result<Path<(String, String)>, PathRejection>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let Ok(Path((workspace_id, integration_id))) = params else {
        return invalid_install();
    };
    if param_exceeds_fastify_limit(&[&workspace_id, &integration_id]) {
        return not_found().await;
    }
    let parsed_body = match read_post_json(&headers, body, invalid_install).await {
        Ok(val) => val,
        Err(resp) => return *resp,
    };
    if !valid_params(&workspace_id, &integration_id) {
        return invalid_install();
    }
    let Some(directory) = parse_directory_only_query(raw.as_deref()) else {
        return invalid_install();
    };
    let Some(scope) = parse_install_body(&parsed_body) else {
        return invalid_install();
    };
    match install::install(&app, &workspace_id, &integration_id, &directory, scope, principal_token(principal)).await {
        Ok(result) => no_store((Status::OK, Json(result)).into_response()),
        Err(err) => install_error_response(err),
    }
}

fn parse_install_body(value: &Value) -> Option<Scope> {
    let obj = value.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    match obj.get("scope")?.as_str()? {
        "global" => Some(Scope::Global),
        "project" => Some(Scope::Project),
        _ => None,
    }
}

async fn get_hosts(
    State(app): State<Shared>,
    params: Result<Path<(String, String)>, PathRejection>,
    RawQuery(raw): RawQuery,
    principal: Option<Extension<Principal>>,
) -> Response {
    let Ok(Path((workspace_id, integration_id))) = params else {
        return invalid_attachment();
    };
    if param_exceeds_fastify_limit(&[&workspace_id, &integration_id]) {
        return not_found().await;
    }
    if !valid_params(&workspace_id, &integration_id) {
        return invalid_attachment();
    }
    let Some(directory) = parse_directory_only_query(raw.as_deref()) else {
        return invalid_attachment();
    };
    match attachments::hosts(&app, &workspace_id, &integration_id, &directory, principal_token(principal)).await {
        Ok(result) => no_store((Status::OK, Json(result)).into_response()),
        Err(err) => attachment_error_response(err),
    }
}

async fn get_binding(
    State(app): State<Shared>,
    params: Result<Path<(String, String)>, PathRejection>,
    RawQuery(raw): RawQuery,
    principal: Option<Extension<Principal>>,
) -> Response {
    let Ok(Path((workspace_id, integration_id))) = params else {
        return invalid_attachment();
    };
    if param_exceeds_fastify_limit(&[&workspace_id, &integration_id]) {
        return not_found().await;
    }
    if !valid_params(&workspace_id, &integration_id) {
        return invalid_attachment();
    }
    let Some((directory, session_id)) = parse_binding_query(raw.as_deref()) else {
        return invalid_attachment();
    };
    match attachments::binding_read(
        &app,
        &workspace_id,
        &integration_id,
        &directory,
        &session_id,
        principal_token(principal),
    )
    .await
    {
        Ok(result) => no_store((Status::OK, Json(result)).into_response()),
        Err(err) => attachment_error_response(err),
    }
}

async fn post_install_host(
    State(app): State<Shared>,
    params: Result<Path<(String, String)>, PathRejection>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let Ok(Path((workspace_id, integration_id))) = params else {
        return invalid_attachment();
    };
    if param_exceeds_fastify_limit(&[&workspace_id, &integration_id]) {
        return not_found().await;
    }
    let parsed_body = match read_post_json(&headers, body, invalid_attachment).await {
        Ok(val) => val,
        Err(resp) => return *resp,
    };
    if !valid_params(&workspace_id, &integration_id) || !parsed_body.as_object().is_some_and(serde_json::Map::is_empty)
    {
        return invalid_attachment();
    }
    let Some(directory) = parse_directory_only_query(raw.as_deref()) else {
        return invalid_attachment();
    };
    match attachments::install_host(&app, &workspace_id, &integration_id, &directory, principal_token(principal)).await
    {
        Ok(result) => no_store((Status::OK, Json(result)).into_response()),
        Err(err) => attachment_error_response(err),
    }
}

async fn post_attach(
    State(app): State<Shared>,
    params: Result<Path<(String, String)>, PathRejection>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let Ok(Path((workspace_id, integration_id))) = params else {
        return invalid_attachment();
    };
    if param_exceeds_fastify_limit(&[&workspace_id, &integration_id]) {
        return not_found().await;
    }
    let parsed_body = match read_post_json(&headers, body, invalid_attachment).await {
        Ok(val) => val,
        Err(resp) => return *resp,
    };
    if !valid_params(&workspace_id, &integration_id) {
        return invalid_attachment();
    }
    let Some(directory) = parse_directory_only_query(raw.as_deref()) else {
        return invalid_attachment();
    };
    let Some((offer_id, session_id)) = parse_attach_body(&parsed_body) else {
        return invalid_attachment();
    };
    match attachments::attach(
        &app,
        &workspace_id,
        &integration_id,
        &directory,
        offer_id,
        session_id,
        principal_token(principal),
    )
    .await
    {
        Ok(result) => no_store((Status::OK, Json(result)).into_response()),
        Err(err) => attachment_error_response(err),
    }
}

fn parse_attach_body(value: &Value) -> Option<(&str, &str)> {
    let obj = value.as_object()?;
    if obj.len() != 2 {
        return None;
    }
    let offer_id = obj.get("offerID")?.as_str().filter(|s| valid_offer_id(s))?;
    let session_id = obj.get("sessionID")?.as_str().filter(|s| valid_native_session_id(s))?;
    Some((offer_id, session_id))
}

async fn post_detach(
    State(app): State<Shared>,
    params: Result<Path<(String, String)>, PathRejection>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let Ok(Path((workspace_id, integration_id))) = params else {
        return invalid_attachment();
    };
    if param_exceeds_fastify_limit(&[&workspace_id, &integration_id]) {
        return not_found().await;
    }
    let parsed_body = match read_post_json(&headers, body, invalid_attachment).await {
        Ok(val) => val,
        Err(resp) => return *resp,
    };
    if !valid_params(&workspace_id, &integration_id) {
        return invalid_attachment();
    }
    let Some(directory) = parse_directory_only_query(raw.as_deref()) else {
        return invalid_attachment();
    };
    let Some(session_id) = parse_detach_body(&parsed_body) else {
        return invalid_attachment();
    };
    match attachments::detach(&app, &workspace_id, &integration_id, &directory, session_id, principal_token(principal))
        .await
    {
        Ok(result) => no_store((Status::OK, Json(result)).into_response()),
        Err(err) => attachment_error_response(err),
    }
}

fn parse_detach_body(value: &Value) -> Option<&str> {
    let obj = value.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    obj.get("sessionID")?.as_str().filter(|s| valid_native_session_id(s))
}

pub(crate) use crate::plugin_controls::engine::LocationPin;

pub(crate) async fn owns_location(
    app: &crate::App,
    workspace: &crate::Workspace,
    directory: &str,
    pin: &LocationPin,
) -> bool {
    if !crate::files::paths::under(&app.scope, std::path::Path::new(directory)) {
        return false;
    }
    let dir = directory.to_owned();
    let root = workspace.path.clone();
    let scope = app.scope.clone();
    let pin_clone = pin.clone();
    let checked = tokio::task::spawn_blocking(move || {
        if !crate::plugin_controls::engine::pin_still_live_sync(&root, &dir, &pin_clone) {
            return Some(false);
        }
        if let crate::plugin_controls::engine::PinnedTarget::Existing { ref canonical, .. } = pin_clone.target {
            if !canonical.starts_with(&scope) {
                return Some(false);
            }
            if canonical == &root {
                return Some(true);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    match checked {
        Some(owned) => owned,
        None => {
            crate::worktrees::ownership::resolve(app, workspace, directory)
                .await
                .is_some_and(|owned| owned.directory == directory)
                && crate::plugin_controls::engine::pin_still_live(workspace, directory, pin).await
        }
    }
}

#[cfg(test)]
mod tests;
