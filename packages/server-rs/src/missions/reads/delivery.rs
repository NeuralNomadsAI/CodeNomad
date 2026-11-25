use axum::response::{IntoResponse, Response};
use serde_json::Value;
use std::time::Duration;
use tokio::time::Instant;

pub(super) const LARGE_RESPONSE_THRESHOLD: usize = 4 * 1024 * 1024;
pub(super) const LARGE_RESPONSE_CHUNK: usize = 64 * 1024;
pub(in crate::missions) const LARGE_RESPONSE_BUDGET_UNITS: usize = 2048;
#[cfg(test)]
pub(super) const MUTATION_RESPONSE_BUDGET_UNITS: usize = LARGE_RESPONSE_BUDGET_UNITS * 2;
const LARGE_RESPONSE_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const LARGE_RESPONSE_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

pub(in crate::missions) async fn encode_json_bytes_holding<T: Send + 'static>(
    value: Value,
    hold: T,
    offload: bool,
    _compact_mission: bool,
) -> Result<(Vec<u8>, T), ()> {
    let encode = move || {
        let encoded = serde_json::to_vec(&value).map_err(|_| ());
        drop(value);
        encoded.map(|bytes| (bytes, hold))
    };
    if offload { tokio::task::spawn_blocking(encode).await.map_err(|_| ())? } else { encode() }
}

fn json_bytes_response(bytes: Vec<u8>) -> Response {
    use axum::http::{HeaderValue, header};
    let len = bytes.len();
    let mut response = axum::body::Body::from(bytes).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(value) = HeaderValue::from_str(&len.to_string()) {
        response.headers_mut().insert(header::CONTENT_LENGTH, value);
    }
    response
}

pub(super) fn stream_large_bytes(
    bytes: Vec<u8>,
    budget: tokio::sync::OwnedSemaphorePermit,
    chunk_timeout: Duration,
    total_timeout: Duration,
) -> Response {
    use axum::http::{HeaderValue, header};
    let len = bytes.len();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(2);
    tokio::spawn(async move {
        let total_deadline = Instant::now() + total_timeout;
        let mut offset = 0usize;
        while offset < bytes.len() {
            let remaining = total_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = tx.try_send(Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Mission response delivery exceeded total deadline",
                )));
                break;
            }
            let end = (offset + LARGE_RESPONSE_CHUNK).min(bytes.len());
            // Copy each 64 KiB slice so queued/in-flight chunks never retain the full buffer
            // after this task drops `bytes` and releases `budget`.
            let chunk = axum::body::Bytes::copy_from_slice(&bytes[offset..end]);
            match tokio::time::timeout(chunk_timeout.min(remaining), tx.send(Ok(chunk))).await {
                Ok(Ok(())) => offset = end,
                Ok(Err(_)) => break,
                Err(_) => {
                    let _ = tx.try_send(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Mission response delivery timed out",
                    )));
                    break;
                }
            }
        }
        drop(bytes);
        drop(budget);
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    let mut response = axum::body::Body::from_stream(stream).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(value) = HeaderValue::from_str(&len.to_string()) {
        response.headers_mut().insert(header::CONTENT_LENGTH, value);
    }
    response
}

pub(in crate::missions) fn deliver_json_bytes(app: &crate::App, bytes: Vec<u8>) -> Result<Response, ()> {
    if bytes.len() <= LARGE_RESPONSE_THRESHOLD {
        return Ok(json_bytes_response(bytes));
    }
    let units = bytes.len().div_ceil(LARGE_RESPONSE_CHUNK).min(LARGE_RESPONSE_BUDGET_UNITS) as u32;
    let budget = app.mission_large_response_budget.clone().try_acquire_many_owned(units).map_err(|_| ())?;
    Ok(stream_large_bytes(bytes, budget, LARGE_RESPONSE_CHUNK_TIMEOUT, LARGE_RESPONSE_TOTAL_TIMEOUT))
}

/// Deliver an already-admitted mutation response using its pre-reserved mutation delivery budget
/// (independent of `mission_control_slot` and read-side `mission_large_response_budget`).
/// Excess pre-reserved units are released immediately once the encoded size is known.
pub(in crate::missions) fn deliver_admitted_json_bytes(
    bytes: Vec<u8>,
    mut budget: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    if bytes.len() <= LARGE_RESPONSE_THRESHOLD {
        drop(budget);
        return json_bytes_response(bytes);
    }
    let units = bytes.len().div_ceil(LARGE_RESPONSE_CHUNK).min(LARGE_RESPONSE_BUDGET_UNITS);
    let keep = budget.split(units).unwrap_or(budget);
    stream_large_bytes(bytes, keep, LARGE_RESPONSE_CHUNK_TIMEOUT, LARGE_RESPONSE_TOTAL_TIMEOUT)
}
