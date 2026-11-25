//! Plugin-contributed provider usage RPC: bounded transport and error classification.
#[path = "plugin_parse.rs"]
mod parse;

use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use serde_json::{json, value::RawValue};
use tokio::time::Instant;

use self::parse::{RawObject, parse_output_raw, parse_raw_object, parse_raw_string};
pub(super) use self::parse::{rpc_id, unavailable_raw};
use super::{Owned, Refusal, plans};
use crate::shared::{js_trim, now_ms};

pub(super) const RPC_METHOD: &str = "read";
pub(super) const MAX_RESPONSE_BYTES: usize = 256 * 1024;

fn is_json_response(response: &reqwest::Response) -> bool {
    let Some(raw) = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let media_type = raw.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    media_type == "application/json" || media_type.ends_with("+json")
}

enum BoundedJson {
    Ok(Box<RawValue>),
    NonJson,
    Overflow,
    Malformed,
}

enum ReadError {
    TimedOut,
    Retired,
    Transport,
}

async fn read_bounded_json(
    mut response: reqwest::Response,
    owned: &Owned<'_>,
    quota_until: Instant,
) -> Result<BoundedJson, ReadError> {
    if !is_json_response(&response) {
        return Ok(BoundedJson::NonJson);
    }
    if let Some(len) =
        response.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<u64>().ok())
        && len > MAX_RESPONSE_BYTES as u64
    {
        return Ok(BoundedJson::Overflow);
    }
    let mut bytes = Vec::new();
    loop {
        if !owned.app.native.current(&owned.endpoint) {
            return Err(ReadError::Retired);
        }
        if Instant::now() >= quota_until {
            return Err(ReadError::TimedOut);
        }
        let next = tokio::select! {
            biased;
            _ = owned.app.native.wait_retired(&owned.endpoint) => return Err(ReadError::Retired),
            chunk = tokio::time::timeout_at(quota_until, response.chunk()) => chunk,
        };
        match next {
            Err(_) => return Err(ReadError::TimedOut),
            Ok(Err(_)) => return Err(ReadError::Transport),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Ok(BoundedJson::Overflow);
                }
                bytes.extend_from_slice(&chunk);
            }
        }
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(BoundedJson::Malformed);
    };
    // Match `TextDecoder("utf-8", { fatal: true })`, which strips one leading UTF-8 BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    match serde_json::from_str::<Box<RawValue>>(text) {
        Ok(value) => Ok(BoundedJson::Ok(value)),
        Err(_) => Ok(BoundedJson::Malformed),
    }
}

fn is_absent_rpc_error(body: &RawObject) -> bool {
    body.len() == 3
        && body.get("_tag").and_then(parse_raw_string).as_deref() == Some("RpcError")
        && matches!(
            body.get("type").and_then(parse_raw_string).as_deref(),
            Some("rpc.unavailable" | "rpc.method_not_found")
        )
        && body
            .get("message")
            .and_then(parse_raw_string)
            .is_some_and(|m| (1..=4096).contains(&m.encode_utf16().count()))
}

// OpenCode reserves `rpc.`; plugin failures are its other system codes or custom unprefixed types.
fn is_registered_rpc_error(body: &RawObject) -> bool {
    body.keys().all(|k| matches!(k, "_tag" | "type" | "message" | "data"))
        && body.get("_tag").and_then(parse_raw_string).as_deref() == Some("RpcError")
        && body.get("type").and_then(parse_raw_string).is_some_and(|t| {
            !t.starts_with("rpc.") || matches!(t.as_str(), "rpc.invalid_input" | "rpc.invalid_output" | "rpc.internal")
        })
        && body.get("message").and_then(parse_raw_string).is_some()
}

fn is_registered_rpc_internal_error(body: &RawObject) -> bool {
    body.keys().all(|k| matches!(k, "_tag" | "type" | "message" | "data"))
        && body.get("_tag").and_then(parse_raw_string).as_deref() == Some("RpcInternalError")
        && matches!(body.get("type").and_then(parse_raw_string).as_deref(), Some("rpc.internal" | "rpc.invalid_output"))
        && body.get("message").and_then(parse_raw_string).is_some()
}

fn quota_deadline_fallback(
    requested_provider_id: &str,
    model_id: Option<&str>,
    until: Instant,
) -> Result<Option<Box<RawValue>>, Refusal> {
    if Instant::now() >= until {
        Err(Refusal::Unavailable)
    } else {
        Ok(Some(unavailable_raw(requested_provider_id, model_id)))
    }
}

pub(super) async fn read_rpc(
    owned: &Owned<'_>,
    rpc_id: &str,
    requested_provider_id: &str,
    model_id: Option<&str>,
    until: Instant,
    quota_until: Instant,
) -> Result<Option<Box<RawValue>>, Refusal> {
    owned.current()?;
    let now = Instant::now();
    if now >= until {
        return Err(Refusal::Unavailable);
    }
    if now >= quota_until {
        return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
    }
    let provider_id = js_trim(requested_provider_id);
    let mut url = owned
        .endpoint
        .url
        .join(&format!("/api/rpc/{}/{RPC_METHOD}", plans::encode(rpc_id)))
        .map_err(|_| Refusal::Unavailable)?;
    url.query_pairs_mut().append_pair("location[directory]", &owned.directory);
    let payload = match model_id.filter(|m| !m.is_empty()) {
        Some(model) => json!({ "input": { "modelId": model } }),
        None => json!({ "input": {} }),
    };
    let request = owned
        .app
        .native
        .client
        .post(url)
        .basic_auth("opencode", Some(&owned.endpoint.password))
        .header(CONTENT_TYPE, "application/json")
        .body(payload.to_string());
    let sent = tokio::select! {
        biased;
        _ = owned.app.native.wait_retired(&owned.endpoint) => return Err(Refusal::Unavailable),
        res = tokio::time::timeout_at(quota_until, request.send()) => res,
    };
    let response = match sent {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            if Instant::now() >= quota_until {
                return quota_deadline_fallback(requested_provider_id, model_id, until);
            }
            return Err(Refusal::Unavailable);
        }
        Err(_) => return quota_deadline_fallback(requested_provider_id, model_id, until),
    };
    if !owned.app.native.current(&owned.endpoint) {
        return Err(Refusal::Unavailable);
    }
    let now = Instant::now();
    if now >= until {
        return Err(Refusal::Unavailable);
    }
    if now >= quota_until {
        return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
    }
    let status = response.status().as_u16();
    if !matches!(status, 200 | 400 | 404 | 500) {
        return Err(Refusal::Unavailable);
    }
    let json = match read_bounded_json(response, owned, quota_until).await {
        Ok(parsed) => parsed,
        Err(ReadError::Retired) => return Err(Refusal::Unavailable),
        Err(ReadError::TimedOut) => return quota_deadline_fallback(requested_provider_id, model_id, until),
        Err(ReadError::Transport) => {
            if Instant::now() >= quota_until {
                return quota_deadline_fallback(requested_provider_id, model_id, until);
            }
            return Err(Refusal::Unavailable);
        }
    };
    if !owned.app.native.current(&owned.endpoint) || Instant::now() >= until {
        return Err(Refusal::Unavailable);
    }
    match status {
        200 => {
            if Instant::now() >= quota_until {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            }
            let BoundedJson::Ok(raw) = json else {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            };
            let Some(body) = parse_raw_object(raw.get()) else {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            };
            let Some(output) = body.get("output") else {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            };
            Ok(Some(
                parse_output_raw(output.get(), requested_provider_id, provider_id, model_id, now_ms())
                    .unwrap_or_else(|| unavailable_raw(requested_provider_id, model_id)),
            ))
        }
        400 => {
            // Past the quota deadline no fallback read may start.
            if Instant::now() >= quota_until {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            }
            let BoundedJson::Ok(raw) = json else {
                return Err(Refusal::Unavailable);
            };
            let Some(body) = parse_raw_object(raw.get()) else {
                return Err(Refusal::Unavailable);
            };
            if is_absent_rpc_error(&body) {
                return Ok(None);
            }
            if is_registered_rpc_error(&body) {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            }
            Err(Refusal::Unavailable)
        }
        404 => {
            if Instant::now() >= quota_until {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            }
            match json {
                BoundedJson::NonJson => Ok(None),
                BoundedJson::Overflow | BoundedJson::Malformed => Err(Refusal::Unavailable),
                BoundedJson::Ok(raw) => {
                    let raw_str = raw.get().trim_start();
                    if raw_str.starts_with('{') {
                        // Never treat an undecodable JSON object (e.g. unpaired UTF-16 surrogate in a key)
                        // as a generic missing-route body: it could mask a forbidden RPC/location error envelope.
                        let Some(obj) = parse_raw_object(raw_str) else {
                            return Err(Refusal::Unavailable);
                        };
                        let tag = obj.get("_tag").and_then(parse_raw_string);
                        // RPC envelopes never travel as 404: only generic missing-route bodies mean "absent".
                        if matches!(
                            tag.as_deref(),
                            Some("LocationNotFoundError" | "SessionNotFoundError" | "RpcError" | "RpcInternalError")
                        ) {
                            return Err(Refusal::Unavailable);
                        }
                    }
                    Ok(None)
                }
            }
        }
        500 => {
            let BoundedJson::Ok(raw) = json else {
                return Err(Refusal::Unavailable);
            };
            let Some(body) = parse_raw_object(raw.get()) else {
                return Err(Refusal::Unavailable);
            };
            if is_registered_rpc_internal_error(&body) {
                return Ok(Some(unavailable_raw(requested_provider_id, model_id)));
            }
            Err(Refusal::Unavailable)
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
#[path = "plugin_tests.rs"]
mod tests;
