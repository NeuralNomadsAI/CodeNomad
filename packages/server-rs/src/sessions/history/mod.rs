//! `POST /api/workspaces/:id/session-history/:action`: history navigation through the
//! session-pruning plugin, schema-checked both ways.
mod payload;
mod placement;

use super::{media, user_files};
use crate::{App, Error, Shared, auth::Principal, error, unavailable};
use axum::{
    Extension,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use payload::{blocked, parse_envelope, process_history_payload, raw_str_eq};
use placement::Recheck;
pub(super) use placement::{Placement, prepare};
use serde_json::{Value, json};
use std::time::Duration;
pub fn pending_valid(value: &Value) -> bool {
    crate::sessions::contracts::valid(crate::sessions::contracts::get("pending", true), value)
}

pub(super) async fn rpc(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
) -> Result<(Status, Bytes), ()> {
    rpc_with_timeout(app, endpoint, directory, method, input, Duration::from_secs(10)).await
}

pub(super) async fn rpc_with_timeout(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
    timeout: Duration,
) -> Result<(Status, Bytes), ()> {
    let (status, mut body) = rpc_with_limit(app, endpoint, directory, method, input, timeout, 24 * 1024 * 1024).await?;
    body.shrink_to_fit();
    Ok((status, body.into()))
}

async fn rpc_with_limit(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
    timeout: Duration,
    limit: usize,
) -> Result<(Status, Vec<u8>), ()> {
    let response = app
        .native
        .client
        .post(endpoint.url.join(&format!("/api/rpc/codenomad.session-pruning/{method}")).map_err(|_| ())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
        .json(&json!({"input": input}))
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ())?;
    let status = response.status();
    Ok((status, crate::opencode::read_bytes(response, limit).await?))
}

pub async fn handle(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, action)): Path<(String, String)>,
    req: Request,
) -> Result<Response, Error> {
    if matches!(action.as_str(), "query" | "ranked") {
        return super::history_search::handle(app, principal, id, &action, req).await;
    }
    if action == "prune" {
        return super::pruning::batch(app, principal, id, req).await;
    }
    let reference =
        action == "window" && req.headers().get("x-codenomad-user-files").is_some_and(|v| v == user_files::REFERENCE);
    let (method, limit) = match action.as_str() {
        "outline" => ("outlineLayout", 96 * 1024),
        "outlinePreview" => ("outlinePreview", 8192),
        "window" => (if reference { "windowUserFilesV1" } else { "window" }, 8192),
        _ => return Ok(unavailable()),
    };
    let defer = action == "window" && media::wants_deferred(req.headers());
    let invalid = || error(Status::BAD_REQUEST, "Invalid history navigation request");
    let (parts, body) = req.into_parts();
    if let Some(kind) = parts.headers.get(header::CONTENT_TYPE) {
        let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if !matches!(essence.as_str(), "application/json" | "text/plain") {
            return Err(crate::shared::fastify::error(
                Status::UNSUPPORTED_MEDIA_TYPE,
                "FST_ERR_CTP_INVALID_MEDIA_TYPE",
                "Unsupported Media Type",
            ));
        }
    }
    let bytes = tokio::select! {
        biased;
        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
        res = tokio::time::timeout(Duration::from_secs(15), to_bytes(body, limit)) => match res {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => return Err(crate::shared::fastify::error(
                Status::PAYLOAD_TOO_LARGE,
                "FST_ERR_CTP_BODY_TOO_LARGE",
                "Request body is too large",
            )),
            Err(_) => return Err(error(Status::REQUEST_TIMEOUT, "Request body timed out")),
        },
    };
    let parsed = match crate::shared::fastify::body(&parts.headers, &bytes)? {
        Some(crate::shared::fastify::Body::Json(value)) => Some(value),
        Some(crate::shared::fastify::Body::Text(_)) | None => None,
    };
    let schema = crate::sessions::contracts::get(&action, false);
    let input = parsed.filter(|i| crate::sessions::contracts::valid(schema, i)).ok_or_else(invalid)?;
    let session = input["sessionID"].as_str().ok_or_else(invalid)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let request = async {
        // Bound concurrent 16 MiB `session.get` admissions, 24 MiB RPC reads, and
        // `spawn_blocking` parses across all three navigation actions (`window`, `outline`,
        // `outlinePreview`).
        static HISTORY_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        let initial_workspace = match app.workspace(&id) {
            Ok(workspace) => workspace,
            Err(_) => return blocked("unavailable"),
        };
        let mut slot = {
            let workspace_closed = async {
                loop {
                    let notified = app.workspace_closed.notified();
                    if !app
                        .workspace(&id)
                        .is_ok_and(|w| w.id == initial_workspace.id && w.path == initial_workspace.path)
                    {
                        return;
                    }
                    notified.await;
                }
            };
            tokio::select! {
                biased;
                _ = workspace_closed => return blocked("unavailable"),
                permit = HISTORY_SLOTS.acquire() => match permit {
                    Ok(permit) => permit,
                    Err(_) => return blocked("unavailable"),
                }
            }
        };
        // Always capture deletion fences for history navigation (TS `session-navigation.ts:48-55`).
        let placement = match Placement::capture_with_media(&app, &id, session, defer, true).await {
            Ok(placement) => placement,
            Err((Status::FORBIDDEN, body)) => return (Status::FORBIDDEN, body).into_response(),
            Err(_) => return blocked("unavailable"),
        };
        let work = async {
            // Revalidate after admission while holding the navigation slot.
            let directory = match placement.ready(&app, &id, session).await {
                Ok(directory) => directory,
                Err(Recheck::Conflict) => return blocked("conflict"),
                Err(_) => return blocked("unavailable"),
            };
            if !placement.operation_current(&app, &id).await {
                return blocked("unavailable");
            }
            let rpc_limit = 24 * 1024 * 1024 + 64 * 1024;
            // Reserve `ResponsePool::History` (64 MiB) memory BEFORE reading the up-to-24 MiB RPC
            // payload: `outline`/`outlinePreview` expand JSON into a `serde_json::Value` tree, so
            // reserve 56 MiB to serialize concurrent full-size parses under the 64 MiB pool;
            // `window` projects bytes in-place (+ 8 MiB peak for one decoded deferred image URI),
            // then shrinks the permit down to the serialized payload size.
            let reserve_bytes =
                if action == "window" { rpc_limit + if defer { 8 * 1024 * 1024 } else { 0 } } else { 56 * 1024 * 1024 };
            let mut mem = {
                let workspace_closed = async {
                    loop {
                        let notified = app.workspace_closed.notified();
                        if !placement.operation_current_fast(&app, &id) {
                            return;
                        }
                        notified.await;
                    }
                };
                tokio::select! {
                    biased;
                    _ = workspace_closed => return blocked("unavailable"),
                    permit = crate::shared::reserve_response_memory(crate::shared::ResponsePool::History, reserve_bytes) => {
                        match permit {
                            Ok(permit) => Some(permit),
                            Err(_) => return blocked("unavailable"),
                        }
                    }
                }
            };
            let rpc_timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
            if rpc_timeout.is_zero() {
                return blocked("unavailable");
            }
            let Ok((mut status, mut body)) =
                rpc_with_limit(&app, &placement.endpoint, directory, method, &input, rpc_timeout, rpc_limit).await
            else {
                return blocked("unavailable");
            };
            if action == "outline" && status == Status::BAD_REQUEST {
                let fallback = if body.len() > 32 * 1024 {
                    let Ok((found, returned_body, returned_slot, returned_mem)) =
                        tokio::task::spawn_blocking(move || {
                            let found = parse_envelope(&body).is_some_and(|envelope| {
                                raw_str_eq(envelope.tag, "RpcError")
                                    && raw_str_eq(envelope.kind, "rpc.method_not_found")
                            });
                            (found, body, slot, mem)
                        })
                        .await
                    else {
                        return blocked("unavailable");
                    };
                    body = returned_body;
                    slot = returned_slot;
                    mem = returned_mem;
                    found
                } else {
                    parse_envelope(&body).is_some_and(|envelope| {
                        raw_str_eq(envelope.tag, "RpcError") && raw_str_eq(envelope.kind, "rpc.method_not_found")
                    })
                };
                if fallback {
                    // Release the first RPC buffer before reading the fallback so two ~24 MiB
                    // bodies never coexist under a single `ResponsePool::History` reservation.
                    body.clear();
                    body.shrink_to_fit();
                    match placement.current(&app, &id, session).await {
                        Recheck::Current => {}
                        Recheck::Conflict => return blocked("conflict"),
                        Recheck::Unavailable => return blocked("unavailable"),
                    }
                    let fallback_timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
                    let Ok(fallback) = rpc_with_limit(
                        &app,
                        &placement.endpoint,
                        directory,
                        "outline",
                        &input,
                        fallback_timeout,
                        24 * 1024 * 1024,
                    )
                    .await
                    else {
                        return blocked("unavailable");
                    };
                    (status, body) = fallback;
                }
            }
            let body_len = body.len();
            // Validate and project BEFORE final session/revert revalidation, moving both `slot`
            // and `mem` into `spawn_blocking` so client cancellation never releases pool permits
            // while a detached worker still holds `body`.
            let (projected, slot, mut mem) = if body_len > 32 * 1024 {
                let (action_owned, id_owned, session_owned) = (action.clone(), id.clone(), session.to_owned());
                match tokio::task::spawn_blocking(move || {
                    let result = process_history_payload(
                        status,
                        body,
                        &action_owned,
                        &id_owned,
                        &session_owned,
                        reference,
                        defer,
                    );
                    (result, slot, mem)
                })
                .await
                {
                    Ok(triple) => triple,
                    Err(_) => return blocked("unavailable"),
                }
            } else {
                (process_history_payload(status, body, &action, &id, session, reference, defer), slot, mem)
            };
            if defer || body_len > 32 * 1024 {
                let keep_bytes = projected.as_ref().map_or(0, |(p, _)| p.len().saturating_add(4096));
                let keep_units = if keep_bytes == 0 {
                    0
                } else {
                    crate::shared::response_memory_units(crate::shared::ResponsePool::History, keep_bytes) as usize
                };
                if keep_units == 0 {
                    mem = None;
                } else if let Some(permit) = &mut mem {
                    let excess = permit.num_permits().saturating_sub(keep_units);
                    if excess > 0 {
                        let _ = permit.split(excess);
                    }
                }
            } else {
                mem = None;
            }
            // Match TS `session-navigation.ts:86-91` exact error priority:
            // 1) RPC schema parse failure -> `blocked/unavailable`
            // 2) Final session/revert revalidation -> `blocked/conflict`
            // 3) Invalid `reference-v1` user files -> `blocked/unavailable`
            let (payload, refs_valid) = match projected {
                Ok(pair) => pair,
                Err(invalid_response) => return invalid_response,
            };
            match placement.current(&app, &id, session).await {
                Recheck::Current => {}
                Recheck::Conflict => return blocked("conflict"),
                Recheck::Unavailable => return blocked("unavailable"),
            }
            if !refs_valid {
                return blocked("unavailable");
            }
            drop(slot);
            if principal.live().is_err() {
                return crate::auth::unauthorized().into_response();
            }
            const HISTORY_STREAM_MAX: Duration = Duration::from_secs(120);
            let length = axum::http::HeaderValue::from(payload.len());
            let abort = crate::shared::materialized_stream_abort(principal.0.clone(), HISTORY_STREAM_MAX);
            let response_body = crate::shared::permit_body(payload, mem, abort);
            let mut response = (
                [
                    (header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/json")),
                    (header::CONTENT_LENGTH, length),
                ],
                response_body,
            )
                .into_response();
            let write_abort = crate::shared::materialized_stream_abort(principal.0.clone(), HISTORY_STREAM_MAX);
            response.extensions_mut().insert(crate::shared::CancelWrite::new(write_abort));
            response
        };
        tokio::select! {
            biased;
            _ = app.native.wait_retired(&placement.endpoint) => blocked("unavailable"),
            response = work => response,
        }
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout_at(deadline, request) => Ok(result.unwrap_or_else(|_| blocked("unavailable"))),
    }
}

fn valid_attachment_output(output: &Value) -> bool {
    let Some(obj) = output.as_object() else {
        return false;
    };
    match obj.get("status").and_then(Value::as_str) {
        Some("missing" | "too_large" | "current") => obj.len() == 1,
        Some("file") => {
            obj.len() == 2
                && obj
                    .get("data")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.len() <= user_files::FILE_BYTES.div_ceil(3) * 4)
        }
        Some("blocked") => {
            obj.len() == 2
                && obj.get("reason").and_then(Value::as_str).is_some_and(|r| {
                    matches!(
                        r,
                        "busy"
                            | "conflict"
                            | "unavailable"
                            | "maintenance_required"
                            | "not_deletable"
                            | "unsupported_storage"
                    )
                })
        }
        _ => false,
    }
}

pub async fn attachment(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, session, message, index, sha)): Path<(String, String, String, String, String)>,
) -> Result<Response, Error> {
    let missing = || error(Status::NOT_FOUND, "Attachment not found");
    let invalid = || error(Status::BAD_REQUEST, "Invalid attachment reference");
    let canonical_decimal =
        !index.is_empty() && (index == "0" || (!index.starts_with('0') && index.bytes().all(|b| b.is_ascii_digit())));
    if [session.as_str(), message.as_str()].iter().any(|id| id.len() > 256 || !crate::opencode::valid_id(id))
        || !canonical_decimal
        || !user_files::valid_digest(&sha)
    {
        return Err(invalid());
    }
    let Some(index) = index.parse::<usize>().ok().filter(|&n| n < user_files::FILE_COUNT) else {
        return Err(error(Status::BAD_REQUEST, "Invalid history navigation request"));
    };
    let request = async {
        let placement = Placement::capture(&app, &id, &session, true)
            .await
            .map_err(|e| if e.0 == Status::FORBIDDEN { e } else { missing() })?;
        let after_capture = async {
            if !placement.operation_current(&app, &id).await {
                return Err(missing());
            }
            if !placement.live(&app, &id).await {
                return Err(error(Status::CONFLICT, "Session location changed"));
            }
            let directory = match placement.ready(&app, &id, &session).await {
                Ok(directory) => directory,
                Err(Recheck::Conflict) => return Err(error(Status::CONFLICT, "Session location changed")),
                Err(_) => return Err(missing()),
            };
            let mut input = json!({"sessionID":session,"messageID":message,"fileIndex":index,"sha256":sha});
            let (status, body) =
                rpc(&app, &placement.endpoint, directory, "sessionAttachment", &input).await.map_err(|_| missing())?;
            if !status.is_success() {
                return Err(missing());
            }
            let output: Value = serde_json::from_slice(&body).map_err(|_| missing())?;
            let output = &output["output"];
            if !valid_attachment_output(output) {
                return Err(missing());
            }
            match placement.current(&app, &id, &session).await {
                Recheck::Current => {}
                Recheck::Conflict => return Err(error(Status::CONFLICT, "Session location changed")),
                Recheck::Unavailable => return Err(missing()),
            }
            if output["status"] == "too_large" {
                return Err(error(Status::PAYLOAD_TOO_LARGE, "Attachment exceeds the size limit"));
            }
            if output["status"] != "file" {
                return Err(missing());
            }
            let bytes = user_files::inline(&output["data"])
                .filter(|bytes| user_files::digest(bytes) == sha)
                .ok_or_else(missing)?;
            input["confirm"] = true.into();
            let (status, reply) =
                rpc(&app, &placement.endpoint, directory, "sessionAttachment", &input).await.map_err(|_| missing())?;
            let reply: Value = serde_json::from_slice(&reply).map_err(|_| missing())?;
            if !status.is_success()
                || !valid_attachment_output(&reply["output"])
                || reply["output"]["status"] != "current"
            {
                return Err(missing());
            }
            if !placement.operation_current(&app, &id).await {
                return Err(missing());
            }
            if !placement.live(&app, &id).await {
                return Err(error(Status::CONFLICT, "Session location changed"));
            }
            principal.live()?;
            const ATTACHMENT_STREAM_MAX: Duration = Duration::from_secs(60);
            let length = axum::http::HeaderValue::from(bytes.len());
            let abort = crate::shared::materialized_stream_abort(principal.0.clone(), ATTACHMENT_STREAM_MAX);
            let write_abort = crate::shared::materialized_stream_abort(principal.0.clone(), ATTACHMENT_STREAM_MAX);
            let mut response = (
                [
                    (header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/octet-stream")),
                    (header::CONTENT_LENGTH, length),
                    (header::CACHE_CONTROL, axum::http::HeaderValue::from_static("private, no-store")),
                    (header::CONTENT_DISPOSITION, axum::http::HeaderValue::from_static("attachment")),
                    (header::X_CONTENT_TYPE_OPTIONS, axum::http::HeaderValue::from_static("nosniff")),
                ],
                crate::shared::permit_body(bytes.into(), None, abort),
            )
                .into_response();
            response.extensions_mut().insert(crate::shared::CancelWrite::new(write_abort));
            Ok(response)
        };
        tokio::select! {
            biased;
            _ = app.native.wait_retired(&placement.endpoint) => Err(missing()),
            result = after_capture => result,
        }
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15), request) => result.unwrap_or_else(|_| Err(missing())),
    }
}

#[test]
fn directory_anchor_accepts_existing_or_missing_descendant_and_rejects_files() {
    use crate::worktrees::ownership::directory_anchor;
    let dir = crate::shared::test_dir("media-anchor");
    let file = dir.join("leaf.txt");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(directory_anchor(&dir), Ok(Some(dir.as_path())));
    assert_eq!(directory_anchor(&dir.join("missing").join("nested")), Ok(Some(dir.as_path())));
    assert_eq!(directory_anchor(&file), Ok(None));
    assert_eq!(directory_anchor(&file.join("child")), Ok(None));
    std::fs::remove_dir_all(dir).unwrap();
}
