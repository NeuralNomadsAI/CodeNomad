//! Streaming deferred-media projection for GET /api/session/:id/message.
use std::{path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Json,
    body::Body,
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

use super::guards::{foreign, is_json_content_type, is_transport_json_content_type, relayed};
use crate::opencode::{Endpoint, NativeBody, upstream_error};
use crate::{Error, Shared, Workspace, error, not_found};

pub(super) struct DeferContext<'a> {
    pub app: &'a Shared,
    pub workspace: &'a Workspace,
    pub endpoint: &'a Arc<Endpoint>,
    pub principal: &'a crate::auth::Principal,
    pub id: &'a str,
    pub route: &'a str,
    pub session: &'a str,
    pub native_directory: Option<&'a str>,
    pub initial_identity: &'a Option<(PathBuf, PathBuf, String)>,
    pub input_checkout: &'a Option<crate::worktrees::ownership::DirectoryProof>,
    pub upstream: reqwest::RequestBuilder,
}

pub(super) async fn stream_deferred_message_list(ctx: DeferContext<'_>) -> Result<Response, Error> {
    let DeferContext {
        app,
        workspace,
        endpoint,
        principal,
        id,
        route,
        session,
        native_directory,
        initial_identity,
        input_checkout,
        upstream,
    } = ctx;
    let workspace_closed = || async {
        loop {
            let notified = app.workspace_closed.notified();
            if !app.workspace(id).is_ok_and(|current| current.id == workspace.id && current.path == workspace.path) {
                return;
            }
            notified.await;
        }
    };
    // Banker's admission budget for deadlock-free concurrency: `ResponsePool::List` is 256 MiB,
    // `DEFER_SLOTS = 4` (acquired before `upstream.send()` and held across building + draining),
    // `FAIR_LIST_SHARE = 32 MiB`, and `OUTPUT_LIMIT = 160 MiB`. Up to 3 other active/draining
    // requests hold at most `3 * 32 = 96 MiB`, leaving the full `160 MiB` guaranteed for the
    // single `LARGE_DEFER_SLOT` holder (`96 + 160 = 256 MiB`).
    static DEFER_SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    static LARGE_DEFER_SLOT: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let defer_slots =
        || std::sync::Arc::clone(DEFER_SLOTS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4))));
    let large_defer_slot =
        || std::sync::Arc::clone(LARGE_DEFER_SLOT.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1))));
    const FAIR_LIST_SHARE: usize = 32 * 1024 * 1024;
    let interrupted = || error(Status::BAD_GATEWAY, "OpenCode response was interrupted");
    if !app.native.current(endpoint) || !crate::sessions::permission_mode::workspace_current(app, workspace) {
        return Err(upstream_error());
    }
    principal.live()?;
    // Acquire a concurrency slot BEFORE sending upstream so at most 4 deferred `message.list`
    // requests exist simultaneously across upstream I/O, projection, and downstream draining.
    let slot = match defer_slots().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = workspace_closed() => return Err(not_found()),
            _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
            permit = tokio::time::timeout(crate::opencode::PROXY_IDLE, defer_slots().acquire_owned()) => {
                permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
            }
        },
    };
    if !app.native.current(endpoint) || !crate::sessions::permission_mode::workspace_current(app, workspace) {
        return Err(upstream_error());
    }
    principal.live()?;
    // Recheck local checkout ownership after waiting for `DEFER_SLOTS` so a worktree removed
    // or replaced while queued cannot dispatch an upstream list request.
    let slot = if let (Some(proof), Some((resolved, _, _)), Some(raw_dir)) =
        (&input_checkout, &initial_identity, native_directory)
    {
        let scope = app.scope.clone();
        let raw_dir = raw_dir.to_owned();
        let resolved = resolved.clone();
        let proof = proof.clone();
        let (live, returned_slot) = tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = workspace_closed() => return Err(not_found()),
            _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
            res = tokio::time::timeout(
                crate::opencode::PROXY_IDLE,
                tokio::task::spawn_blocking(move || {
                    let live = crate::worktrees::ownership::resolve_media_path(&scope, &raw_dir)
                        .map(|(p, _)| p)
                        .as_ref()
                        == Some(&resolved)
                        && proof.live(&resolved);
                    (live, slot)
                }),
            ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
        };
        if !live {
            return Err(foreign());
        }
        if !app.native.current(endpoint) || !crate::sessions::permission_mode::workspace_current(app, workspace) {
            return Err(upstream_error());
        }
        returned_slot
    } else {
        slot
    };
    // Once dispatched, TS (`proxy.ts:37-115`, `http-server.ts:261-273`) binds `message.list`
    // only to client disconnect (principal revocation) and OpenCode connection retirement.
    let mut response = tokio::select! {
        biased;
        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
        _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
        sent = tokio::time::timeout(crate::opencode::PROXY_IDLE, upstream.send()) => match sent {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                app.native.invalidate(endpoint);
                return Err(upstream_error());
            }
            Err(_) => return Err(interrupted()),
        }
    };
    if response.status().is_success() && is_json_content_type(response.headers()) {
        let status = response.status();
        let headers: Vec<(&'static str, axum::http::HeaderValue)> =
            ["content-type", "cache-control", "etag", "last-modified"]
                .into_iter()
                .filter_map(|name| {
                    let mut values = response.headers().get_all(name).iter();
                    let first = values.next()?;
                    let Some(second) = values.next() else {
                        return Some((name, first.clone()));
                    };
                    // Match Fetch `Headers.get()` (TS `compatibility/proxy.ts:73-79`): combine
                    // repeated response headers (e.g. multiple `Cache-Control` lines) with `, `.
                    let mut combined = Vec::new();
                    combined.extend_from_slice(first.as_bytes());
                    combined.extend_from_slice(b", ");
                    combined.extend_from_slice(second.as_bytes());
                    for val in values {
                        combined.extend_from_slice(b", ");
                        combined.extend_from_slice(val.as_bytes());
                    }
                    axum::http::HeaderValue::from_bytes(&combined).ok().map(|v| (name, v))
                })
                .collect();
        let mut stream = crate::sessions::media_stream::MessageListStream::new(id, session);
        let mut slot = Some(slot);
        let mut large_slot: Option<tokio::sync::OwnedSemaphorePermit> = None;
        let mut mem: Option<tokio::sync::OwnedSemaphorePermit> = None;
        let mut held_units: u32 = 0;
        let fair_units = crate::shared::response_memory_units(crate::shared::ResponsePool::List, FAIR_LIST_SHARE);
        // Bound total deferred build time (120 s) so a trickle upstream cannot hold
        // `LARGE_DEFER_SLOT` or `DEFER_SLOTS` indefinitely while sending periodic chunks.
        const LIST_BUILD_MAX: Duration = Duration::from_secs(120);
        let build_deadline = tokio::time::Instant::now() + LIST_BUILD_MAX;
        let step_timeout = || {
            let left = build_deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() { None } else { Some(crate::opencode::PROXY_IDLE.min(left)) }
        };
        loop {
            let timeout = step_timeout().ok_or_else(interrupted)?;
            let chunk = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                next = tokio::time::timeout(timeout, response.chunk()) => {
                    next.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                }
            };
            let Some(chunk) = chunk else {
                break;
            };
            // Clamp pre-reservation to `OUTPUT_LIMIT` (160 MiB) so the `LARGE_DEFER_SLOT`
            // holder never requests more than its guaranteed `256 - 3*32 = 160 MiB` budget,
            // accounting for both the live `chunk` and its copy inside `out`/`item`.
            let pre_needed = crate::shared::response_memory_units(
                crate::shared::ResponsePool::List,
                stream
                    .retained_bytes()
                    .saturating_add(chunk.len().saturating_mul(2))
                    .saturating_add(2 * crate::shared::RESPONSE_CHUNK)
                    .min(crate::sessions::media_stream::OUTPUT_LIMIT),
            );
            if pre_needed > fair_units && large_slot.is_none() {
                let timeout = step_timeout().ok_or_else(interrupted)?;
                large_slot = Some(tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                    permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                        permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                    }
                });
            }
            if pre_needed > held_units {
                let timeout = step_timeout().ok_or_else(interrupted)?;
                let extra = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                    permit = tokio::time::timeout(
                        timeout,
                        crate::shared::acquire_response_units(
                            crate::shared::ResponsePool::List,
                            pre_needed - held_units,
                        ),
                    ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                };
                match &mut mem {
                    Some(existing) => existing.merge(extra),
                    None => mem = Some(extra),
                }
                held_units = pre_needed;
            }
            let mut pos = 0;
            while let Some(mut pending) = stream.feed(&chunk, &mut pos).map_err(|_| interrupted())? {
                // Only reserve the 2x + 8 MiB projection/undo overhead when `project_item`
                // will actually attempt deferral (`len <= MESSAGE_LIMIT` and `data:image`
                // present). Offload multi-hundred-KiB scans onto `spawn_blocking` so the
                // single-thread Tokio executor never stalls scanning 16 MiB messages.
                let may_defer = if pending.bytes.len() > crate::sessions::media::MESSAGE_LIMIT {
                    false
                } else if pending.bytes.len() <= 256 * 1024 {
                    crate::sessions::media_stream::may_contain_image_uri(&pending.bytes)
                } else {
                    let held = slot.take().ok_or_else(interrupted)?;
                    let held_large = large_slot.take();
                    let held_mem = mem.take();
                    let raw = pending.bytes;
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    let (found, raw_back, returned, returned_large, returned_mem) = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                        res = tokio::time::timeout(
                            timeout,
                            tokio::task::spawn_blocking(move || {
                                let found = crate::sessions::media_stream::may_contain_image_uri(&raw);
                                (found, raw, held, held_large, held_mem)
                            }),
                        ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                    };
                    pending.bytes = raw_back;
                    slot = Some(returned);
                    large_slot = returned_large;
                    mem = returned_mem;
                    found
                };
                let item_peak = if may_defer {
                    pending.bytes.capacity().saturating_mul(2).saturating_add(8 * 1024 * 1024)
                } else {
                    pending.bytes.capacity()
                };
                stream.evict_undo_if_needed(item_peak);
                let peak_bytes = stream.retained_bytes().saturating_add(item_peak);
                if peak_bytes > crate::sessions::media_stream::OUTPUT_LIMIT {
                    return Err(interrupted());
                }
                let needed = crate::shared::response_memory_units(crate::shared::ResponsePool::List, peak_bytes);
                if needed > fair_units && large_slot.is_none() {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    large_slot = Some(tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                            permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                        }
                    });
                }
                if needed > held_units {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    let extra = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(
                            timeout,
                            crate::shared::acquire_response_units(
                                crate::shared::ResponsePool::List,
                                needed - held_units,
                            ),
                        ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                    };
                    match &mut mem {
                        Some(existing) => existing.merge(extra),
                        None => mem = Some(extra),
                    }
                    held_units = needed;
                }
                let (ws, ses) = stream.ids().ok_or_else(interrupted)?;
                let (ws, ses) = (ws.to_owned(), ses.to_owned());
                let held = slot.take().ok_or_else(interrupted)?;
                let held_large = large_slot.take();
                let held_mem = mem.take();
                let raw = pending.bytes;
                let delimiter = pending.delimiter;
                let moved_stream = stream;
                let timeout = step_timeout().ok_or_else(interrupted)?;
                // Move `slot`, `large_slot`, and `mem` into `spawn_blocking` so cancellation
                // never releases permits or `LARGE_DEFER_SLOT` while a detached worker holds memory.
                let (returned_stream, commit_res, returned, returned_large, returned_mem) = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                    res = tokio::time::timeout(
                        timeout,
                        tokio::task::spawn_blocking(move || {
                            let mut s = moved_stream;
                            let (out, undo) = crate::sessions::media_stream::project_item(&ws, &ses, raw);
                            let commit_res = s.commit_item(out, undo, delimiter);
                            (s, commit_res, held, held_large, held_mem)
                        }),
                    ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                };
                stream = returned_stream;
                slot = Some(returned);
                large_slot = returned_large;
                mem = returned_mem;
                commit_res.map_err(|_| interrupted())?;
                // Before resuming `stream.feed` on the remainder of the current chunk, keep
                // permits >= `retained_bytes + live chunk + remaining copy` (never shrink mid-chunk).
                let rem_bytes = stream
                    .retained_bytes()
                    .saturating_add(chunk.len())
                    .saturating_add(chunk.len().saturating_sub(pos))
                    .min(crate::sessions::media_stream::OUTPUT_LIMIT);
                let rem_needed = crate::shared::response_memory_units(crate::shared::ResponsePool::List, rem_bytes);
                if rem_needed > fair_units && large_slot.is_none() {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    large_slot = Some(tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                            permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                        }
                    });
                }
                if rem_needed > held_units {
                    let timeout = step_timeout().ok_or_else(interrupted)?;
                    let extra = tokio::select! {
                        biased;
                        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                        _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                        permit = tokio::time::timeout(
                            timeout,
                            crate::shared::acquire_response_units(
                                crate::shared::ResponsePool::List,
                                rem_needed - held_units,
                            ),
                        ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                    };
                    match &mut mem {
                        Some(existing) => existing.merge(extra),
                        None => mem = Some(extra),
                    }
                    held_units = rem_needed;
                }
            }
            let retained = stream.retained_bytes();
            if retained > crate::sessions::media_stream::OUTPUT_LIMIT {
                return Err(interrupted());
            }
            let needed = crate::shared::response_memory_units(crate::shared::ResponsePool::List, retained);
            if needed > fair_units && large_slot.is_none() {
                let timeout = step_timeout().ok_or_else(interrupted)?;
                large_slot = Some(tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                    permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                        permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                    }
                });
            }
            if needed > held_units {
                let timeout = step_timeout().ok_or_else(interrupted)?;
                let extra = tokio::select! {
                    biased;
                    _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                    _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                    permit = tokio::time::timeout(
                        timeout,
                        crate::shared::acquire_response_units(
                            crate::shared::ResponsePool::List,
                            needed - held_units,
                        ),
                    ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
                };
                match &mut mem {
                    Some(existing) => existing.merge(extra),
                    None => mem = Some(extra),
                }
                held_units = needed;
            } else if held_units > needed {
                if needed == 0 {
                    mem = None;
                } else if let Some(existing) = &mut mem {
                    let _ = existing.split((held_units - needed) as usize);
                }
                held_units = needed;
            }
            if held_units <= fair_units {
                large_slot = None;
            }
        }
        let (payload, payload_len, backing_len, _changed) = if stream.needs_blocking_finish() {
            let held = slot.take().ok_or_else(interrupted)?;
            let held_large = large_slot.take();
            let held_mem = mem.take();
            let timeout = step_timeout().ok_or_else(interrupted)?;
            let (finished, returned, returned_large, returned_mem) = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                res = tokio::time::timeout(
                    timeout,
                    tokio::task::spawn_blocking(move || (stream.finish(), held, held_large, held_mem)),
                ) => res.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
            };
            slot = Some(returned);
            large_slot = returned_large;
            mem = returned_mem;
            finished.map_err(|_| interrupted())?
        } else {
            stream.finish().map_err(|_| interrupted())?
        };
        if backing_len > crate::sessions::media_stream::OUTPUT_LIMIT {
            return Err(interrupted());
        }
        let final_units = if backing_len == 0 {
            0
        } else {
            crate::shared::response_memory_units(crate::shared::ResponsePool::List, backing_len)
        };
        if final_units > fair_units && large_slot.is_none() {
            let timeout = step_timeout().ok_or_else(interrupted)?;
            large_slot = Some(tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                permit = tokio::time::timeout(timeout, large_defer_slot().acquire_owned()) => {
                    permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?
                }
            });
        }
        if final_units > held_units {
            let timeout = step_timeout().ok_or_else(interrupted)?;
            let extra = tokio::select! {
                biased;
                _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
                _ = app.native.wait_retired(endpoint) => return Err(upstream_error()),
                permit = tokio::time::timeout(
                    timeout,
                    crate::shared::acquire_response_units(
                        crate::shared::ResponsePool::List,
                        final_units - held_units,
                    ),
                ) => permit.map_err(|_| interrupted())?.map_err(|_| interrupted())?,
            };
            match &mut mem {
                Some(existing) => existing.merge(extra),
                None => mem = Some(extra),
            }
        } else if held_units > final_units
            && let Some(existing) = &mut mem
        {
            let _ = existing.split((held_units - final_units) as usize);
        }
        if final_units == 0 {
            mem = None;
        } else if mem.is_none() {
            return Err(interrupted());
        }
        // Keep `slot` and `large_slot` attached to the draining response so at most 4
        // deferred responses exist globally (building OR draining) and at most one holds >32 MiB.
        let drain_large = if final_units > fair_units {
            large_slot.take().map(|p| (p, FAIR_LIST_SHARE))
        } else {
            drop(large_slot);
            None
        };
        let drain_slot = if final_units > 0 {
            slot.take()
        } else {
            drop(slot);
            None
        };
        if !app.native.current(endpoint) {
            return Err(upstream_error());
        }
        principal.live()?;
        // Preserve upstream `etag` and omit extra `Vary` to match TS `compatibility/proxy.ts:76-94`.
        let length = axum::http::HeaderValue::from(payload_len);
        // Bound total response-drain lifetime (120 s) so a trickle reader cannot pin
        // `ResponsePool::List` permits indefinitely; once materialized and validated, do not
        // truncate on daemon rotation (TS `compatibility/proxy.ts:81-94`).
        const LIST_STREAM_MAX: Duration = Duration::from_secs(120);
        let abort = crate::shared::materialized_stream_abort(principal.0.clone(), LIST_STREAM_MAX);
        let write_abort = crate::shared::materialized_stream_abort(principal.0.clone(), LIST_STREAM_MAX);
        let builder = headers
            .into_iter()
            .fold(Response::builder().status(status), |builder, (name, value)| builder.header(name, value))
            .header(header::CONTENT_LENGTH, length);
        return builder
            .extension(NativeBody)
            .extension(crate::shared::CancelWrite::new(write_abort))
            .body(crate::shared::permit_body_chunks(payload, mem, drain_slot, drain_large, abort))
            .map_err(|_| upstream_error());
    }
    let status = response.status();
    // Fetch `redirect: "error"` rejects only redirect status codes (301/302/303/307/308),
    // letting 300 Multiple Choices pass through to the contract-error handler; TS invalidates
    // the connection and propagates the fetch error to Fastify's 500 handler (`transport.ts:45-65`).
    if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
        app.native.invalidate(endpoint);
        return Err((
            Status::INTERNAL_SERVER_ERROR,
            Json(json!({"statusCode": 500, "error": "Internal Server Error", "message": "fetch failed"})),
        ));
    }
    let unauthorized = status == Status::UNAUTHORIZED;
    if !status.is_success() && !is_transport_json_content_type(response.headers()) {
        drop(response);
        if status == Status::NOT_MODIFIED {
            // Match TS `transport.ts:59-65`, where `Response.json(..., { status: 304 })` throws
            // and `proxy.ts` converts it to 502 and invalidates the connection.
            app.native.invalidate(endpoint);
            return Err(upstream_error());
        }
        if unauthorized {
            app.native.invalidate(endpoint);
        }
        let version = if endpoint.version.is_empty() { "v2" } else { endpoint.version.as_str() };
        return Ok((
            status,
            Json(json!({
                "_tag": "OpenCodeContractError",
                "message": format!("OpenCode {version}: GET {route} returned HTTP {}", status.as_u16()),
                "status": status.as_u16(),
                "profile": "modern",
                "method": "GET",
                "path": route,
            })),
        )
            .into_response());
    }
    if status.is_success() {
        if !app.native.current(endpoint) {
            return Err(upstream_error());
        }
        principal.live()?;
    }
    struct InvalidateOnDrop {
        app: Shared,
        endpoint: std::sync::Arc<Endpoint>,
    }
    impl Drop for InvalidateOnDrop {
        fn drop(&mut self) {
            self.app.native.invalidate(&self.endpoint);
        }
    }
    let builder = relayed(&response);
    use futures_util::StreamExt;
    let cancelled = Box::pin(principal.0.clone().cancelled_owned());
    let app_retire = app.clone();
    let endpoint_retire = endpoint.clone();
    // Matches TS `proxy.ts:33-35`: invalidate a 401 connection only after the native
    // 401 error body finishes streaming downstream, so retiring it does not truncate the body.
    let invalidate = unauthorized.then(|| InvalidateOnDrop { app: app.clone(), endpoint: endpoint.clone() });
    let bytes = futures_util::stream::unfold(
        (response.bytes_stream(), cancelled, app_retire, endpoint_retire, unauthorized, invalidate, false),
        |(mut inner, mut cancelled, app_retire, endpoint_retire, unauthorized, invalidate, done)| async move {
            if done {
                return None;
            }
            let next = tokio::select! {
                biased;
                _ = &mut cancelled => {
                    return Some((
                        Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                        (inner, cancelled, app_retire, endpoint_retire, unauthorized, invalidate, true),
                    ));
                }
                _ = app_retire.native.wait_retired(&endpoint_retire), if !unauthorized => {
                    return Some((
                        Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "upstream stream aborted")),
                        (inner, cancelled, app_retire, endpoint_retire, unauthorized, invalidate, true),
                    ));
                }
                item = inner.next() => item,
            };
            next.map(|chunk| {
                (
                    chunk.map_err(std::io::Error::other),
                    (inner, cancelled, app_retire, endpoint_retire, unauthorized, invalidate, false),
                )
            })
        },
    );
    let cancel_write = if unauthorized {
        crate::shared::CancelWrite::token(principal.0.clone())
    } else {
        crate::shared::CancelWrite::new(crate::shared::proxy_stream_abort(
            app.clone(),
            endpoint.clone(),
            principal.0.clone(),
            None,
        ))
    };
    return builder
        .extension(NativeBody)
        .extension(cancel_write)
        .body(Body::from_stream(bytes))
        .map_err(|_| upstream_error());
}
