//! Strict request/response schemas and Fastify body parsing for
//! `session-pruning/{preview,prune}` and `session-history/prune` (`pruneBatch`),
//! matching `opencode/session-pruning/contract.ts` and `history-contract.ts`.
use std::{collections::HashSet, time::Duration};

use axum::{
    Json,
    extract::Request,
    http::{HeaderValue, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde_json::{Map, Value, json};

use crate::{Error, auth::Principal, error};

const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;
const SINGLE_BODY_LIMIT: usize = 1024 * 1024;
const BATCH_BODY_LIMIT: usize = 16_384;
const SINGLE_TIMEOUT: Duration = Duration::from_secs(15);
const BATCH_TIMEOUT: Duration = Duration::from_secs(30);
const PREVIEW_RPC_BODY_LIMIT: usize = 16 * 1024 * 1024;
const MUTATION_RPC_BODY_LIMIT: usize = 256 * 1024;
const PREVIEW_RPC_NODE_LIMIT: usize = 1_000_000;
const MUTATION_RPC_NODE_LIMIT: usize = 10_000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Preview,
    Prune,
    Batch,
}

impl Action {
    pub(super) fn rpc_method(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Prune => "prune",
            Self::Batch => "pruneBatch",
        }
    }
    pub(super) fn body_limit(self) -> usize {
        match self {
            Self::Preview | Self::Prune => SINGLE_BODY_LIMIT,
            Self::Batch => BATCH_BODY_LIMIT,
        }
    }
    pub(super) fn timeout(self) -> Duration {
        match self {
            Self::Preview | Self::Prune => SINGLE_TIMEOUT,
            Self::Batch => BATCH_TIMEOUT,
        }
    }
    pub(super) fn rpc_body_limit(self) -> usize {
        match self {
            Self::Preview => PREVIEW_RPC_BODY_LIMIT,
            Self::Prune | Self::Batch => MUTATION_RPC_BODY_LIMIT,
        }
    }
    pub(super) fn rpc_node_limit(self) -> usize {
        match self {
            Self::Preview => PREVIEW_RPC_NODE_LIMIT,
            Self::Prune | Self::Batch => MUTATION_RPC_NODE_LIMIT,
        }
    }
    pub(super) fn invalid_error(self) -> Error {
        match self {
            Self::Preview | Self::Prune => error(Status::BAD_REQUEST, "Invalid pruning request"),
            Self::Batch => error(Status::BAD_REQUEST, "Invalid pruning batch"),
        }
    }
    pub(super) fn mutating(self) -> bool {
        !matches!(self, Self::Preview)
    }
}

#[derive(Clone)]
pub(super) struct BatchCandidate {
    pub(super) message_id: String,
    pub(super) expected_removed: Option<u64>,
}

#[derive(Clone)]
pub(super) enum ParsedKind {
    Preview,
    Prune { message_id: String, expected_removed: u64 },
    Batch { candidates: Vec<BatchCandidate> },
}

#[derive(Clone)]
pub(super) struct ParsedInput {
    pub(super) session_id: String,
    pub(super) rpc_input: Value,
    pub(super) kind: ParsedKind,
}

impl ParsedInput {
    pub(super) fn blocked_response(&self) -> Response {
        match &self.kind {
            ParsedKind::Preview | ParsedKind::Prune { .. } => {
                Json(json!({ "status": "blocked", "reason": "unavailable" })).into_response()
            }
            ParsedKind::Batch { candidates } => {
                let results: Vec<Value> = candidates
                    .iter()
                    .map(|c| {
                        json!({
                            "messageID": c.message_id,
                            "result": { "status": "blocked", "reason": "unavailable" }
                        })
                    })
                    .collect();
                Json(json!({ "results": results })).into_response()
            }
        }
    }
}

fn close_connection(err: Error) -> Response {
    let mut res = err.into_response();
    res.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
    res
}

fn fastify_too_large(close: bool) -> Response {
    let err = crate::shared::fastify::error(
        Status::PAYLOAD_TOO_LARGE,
        "FST_ERR_CTP_BODY_TOO_LARGE",
        "Request body is too large",
    );
    if close { close_connection(err) } else { err.into_response() }
}

fn fastify_unsupported_media() -> Response {
    crate::shared::fastify::error(
        Status::UNSUPPORTED_MEDIA_TYPE,
        "FST_ERR_CTP_INVALID_MEDIA_TYPE",
        "Unsupported Media Type",
    )
    .into_response()
}

pub(super) async fn parse_request(
    principal: &Principal,
    action: Action,
    req: Request,
) -> Result<ParsedInput, Box<Response>> {
    let (parts, body) = req.into_parts();
    let content_length = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .and_then(|s| s.parse::<u64>().ok());

    match parts.headers.get(header::CONTENT_TYPE) {
        Some(kind) => {
            let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if !matches!(essence.as_str(), "application/json" | "text/plain") {
                return Err(Box::new(fastify_unsupported_media()));
            }
        }
        None => {
            // Fastify `handleRequest.js:33-41`: without Content-Type, Transfer-Encoding or a
            // non-zero Content-Length enters the content-type parser with `""` -> 415.
            let has_te = parts.headers.contains_key(header::TRANSFER_ENCODING);
            let non_zero_cl =
                parts.headers.get(header::CONTENT_LENGTH).is_some_and(|v| v.to_str().ok().map(str::trim) != Some("0"));
            if has_te || non_zero_cl {
                return Err(Box::new(fastify_unsupported_media()));
            }
            return Err(Box::new(action.invalid_error().into_response()));
        }
    }

    let limit = action.body_limit();
    if content_length.is_some_and(|len| len > limit as u64) {
        return Err(Box::new(fastify_too_large(true)));
    }

    let mut bytes = Vec::with_capacity(content_length.map_or(0, |n| (n as usize).min(limit)));
    let mut stream = body.into_data_stream();
    loop {
        let next = tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(Box::new(crate::auth::unauthorized().into_response())),
            frame = stream.next() => frame,
        };
        match next {
            Some(Ok(chunk)) => {
                if bytes.len().saturating_add(chunk.len()) > limit {
                    return Err(Box::new(fastify_too_large(true)));
                }
                bytes.extend_from_slice(&chunk);
            }
            Some(Err(_)) => {
                return Err(Box::new(close_connection(crate::shared::fastify::error(
                    Status::BAD_REQUEST,
                    "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
                    "Request body size did not match Content-Length",
                ))));
            }
            None => break,
        }
    }

    if let Some(expected) = content_length
        && bytes.len() as u64 != expected
    {
        return Err(Box::new(close_connection(crate::shared::fastify::error(
            Status::BAD_REQUEST,
            "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
            "Request body size did not match Content-Length",
        ))));
    }

    let value = match crate::shared::fastify::body(&parts.headers, &bytes).map_err(|e| Box::new(close_connection(e)))? {
        Some(crate::shared::fastify::Body::Json(value)) => value,
        Some(crate::shared::fastify::Body::Text(_)) | None => {
            return Err(Box::new(action.invalid_error().into_response()));
        }
    };
    validate_input(action, &value).ok_or_else(|| Box::new(action.invalid_error().into_response()))
}

fn valid_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        let len = s.encode_utf16().count();
        (1..=256).contains(&len)
    })
}

fn valid_revision(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f')))
}

fn exact_int_in(value: &Value, min: u64, max: u64) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        (min..=max).contains(&n).then_some(n)
    } else if let Some(n) = value.as_f64() {
        (n.is_finite() && n.fract() == 0.0 && n >= min as f64 && n <= max as f64 && n <= MAX_SAFE_INT as f64)
            .then_some(n as u64)
    } else {
        None
    }
}

fn validate_input(action: Action, value: &Value) -> Option<ParsedInput> {
    let obj = value.as_object()?;
    match action {
        Action::Preview => {
            if obj.len() != 2 {
                return None;
            }
            let session_id = valid_id(obj.get("sessionID")?)?.to_owned();
            let message_id = valid_id(obj.get("messageID")?)?.to_owned();
            let rpc_input = json!({ "sessionID": session_id, "messageID": message_id });
            Some(ParsedInput { session_id, rpc_input, kind: ParsedKind::Preview })
        }
        Action::Prune => {
            if obj.len() != 4 {
                return None;
            }
            let session_id = valid_id(obj.get("sessionID")?)?.to_owned();
            let message_id = valid_id(obj.get("messageID")?)?.to_owned();
            let revision = valid_revision(obj.get("revision")?)?.to_owned();
            let raw_indexes = obj.get("indexes")?.as_array()?;
            if raw_indexes.is_empty() || raw_indexes.len() > 100_001 {
                return None;
            }
            let mut indexes = Vec::with_capacity(raw_indexes.len());
            let mut seen = HashSet::with_capacity(raw_indexes.len());
            for item in raw_indexes {
                let idx = exact_int_in(item, 0, 100_000)?;
                if !seen.insert(idx) {
                    return None;
                }
                indexes.push(idx);
            }
            let expected_removed = indexes.len() as u64;
            let rpc_input = json!({
                "sessionID": session_id,
                "messageID": message_id,
                "revision": revision,
                "indexes": indexes,
            });
            Some(ParsedInput { session_id, rpc_input, kind: ParsedKind::Prune { message_id, expected_removed } })
        }
        Action::Batch => {
            if obj.len() != 2 {
                return None;
            }
            let session_id = valid_id(obj.get("sessionID")?)?.to_owned();
            let raw_candidates = obj.get("candidates")?.as_array()?;
            if raw_candidates.is_empty() || raw_candidates.len() > 16 {
                return None;
            }
            let mut candidates = Vec::with_capacity(raw_candidates.len());
            let mut rpc_candidates = Vec::with_capacity(raw_candidates.len());
            let mut seen = HashSet::with_capacity(raw_candidates.len());
            for item in raw_candidates {
                let c = item.as_object()?;
                if c.len() != 4 {
                    return None;
                }
                let message_id = valid_id(c.get("messageID")?)?.to_owned();
                let revision = valid_revision(c.get("revision")?)?.to_owned();
                let tool_count = exact_int_in(c.get("toolCount")?, 0, MAX_SAFE_INT)?;
                let reasoning_count = exact_int_in(c.get("reasoningCount")?, 0, MAX_SAFE_INT)?;
                if !seen.insert(message_id.clone()) {
                    return None;
                }
                rpc_candidates.push(json!({
                    "messageID": message_id,
                    "revision": revision,
                    "toolCount": tool_count,
                    "reasoningCount": reasoning_count,
                }));
                candidates
                    .push(BatchCandidate { message_id, expected_removed: tool_count.checked_add(reasoning_count) });
            }
            let rpc_input = json!({ "sessionID": session_id, "candidates": rpc_candidates });
            Some(ParsedInput { session_id, rpc_input, kind: ParsedKind::Batch { candidates } })
        }
    }
}

fn valid_blocked(obj: &Map<String, Value>) -> Option<Value> {
    if obj.len() != 2 || obj.get("status").and_then(Value::as_str) != Some("blocked") {
        return None;
    }
    let reason = obj.get("reason").and_then(Value::as_str)?;
    if matches!(reason, "unavailable" | "maintenance_required" | "conflict" | "not_deletable" | "unsupported_storage") {
        Some(json!({ "status": "blocked", "reason": reason }))
    } else {
        None
    }
}

fn validate_prune_result(value: &Value, expected_message_id: &str, expected_removed: Option<u64>) -> Option<Value> {
    let obj = value.as_object()?;
    if let Some(blocked) = valid_blocked(obj) {
        return Some(blocked);
    }
    if obj.len() != 4 || obj.get("status").and_then(Value::as_str) != Some("pruned") {
        return None;
    }
    let message_id = valid_id(obj.get("messageID")?)?;
    let revision = valid_revision(obj.get("revision")?)?;
    let removed_count = exact_int_in(obj.get("removedCount")?, 1, MAX_SAFE_INT)?;
    if message_id != expected_message_id || Some(removed_count) != expected_removed {
        return None;
    }
    Some(json!({
        "status": "pruned",
        "messageID": message_id,
        "revision": revision,
        "removedCount": removed_count,
    }))
}

pub(super) fn validate_output(parsed: &ParsedInput, output: &Value) -> Option<Value> {
    let obj = output.as_object()?;
    match &parsed.kind {
        ParsedKind::Preview => {
            if let Some(blocked) = valid_blocked(obj) {
                return Some(blocked);
            }
            if obj.len() != 4 || obj.get("status").and_then(Value::as_str) != Some("preview") {
                return None;
            }
            let revision = valid_revision(obj.get("revision")?)?;
            let live_mutation = obj.get("liveMutation")?.as_bool()?;
            let raw_parts = obj.get("parts")?.as_array()?;
            let mut parts = Vec::with_capacity(raw_parts.len());
            for part in raw_parts {
                let p = part.as_object()?;
                let index = exact_int_in(p.get("index")?, 0, MAX_SAFE_INT)?;
                let kind = p.get("type").and_then(Value::as_str).filter(|t| matches!(*t, "tool" | "reasoning"))?;
                let bytes = exact_int_in(p.get("bytes")?, 0, MAX_SAFE_INT)?;
                parts.push(json!({ "index": index, "type": kind, "bytes": bytes }));
            }
            Some(json!({
                "status": "preview",
                "revision": revision,
                "liveMutation": live_mutation,
                "parts": parts,
            }))
        }
        ParsedKind::Prune { message_id, expected_removed } => {
            validate_prune_result(output, message_id, Some(*expected_removed))
        }
        ParsedKind::Batch { candidates } => {
            if obj.len() != 1 {
                return None;
            }
            let raw_results = obj.get("results")?.as_array()?;
            if raw_results.len() != candidates.len() || raw_results.len() > 16 {
                return None;
            }
            let mut results = Vec::with_capacity(raw_results.len());
            for (entry, candidate) in raw_results.iter().zip(candidates.iter()) {
                let e = entry.as_object()?;
                if e.len() != 2 {
                    return None;
                }
                let entry_id = valid_id(e.get("messageID")?)?;
                if entry_id != candidate.message_id {
                    return None;
                }
                let result = validate_prune_result(e.get("result")?, entry_id, candidate.expected_removed)?;
                results.push(json!({ "messageID": entry_id, "result": result }));
            }
            Some(json!({ "results": results }))
        }
    }
}
