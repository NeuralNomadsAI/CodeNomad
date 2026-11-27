//! Bound retained mutation bytes; briefly drain a small overrun before refusing,
//! so an HTTP/1 peer can receive the 413 instead of a reset while still writing.
use axum::{body::Body, http::StatusCode as Status};
use futures_util::StreamExt;
use std::time::Duration;
use tokio::time::Instant;

use crate::Error;

const DRAIN_SLACK: usize = 64 * 1024;
const DRAIN_TIME: Duration = Duration::from_secs(2);

pub(crate) fn too_large() -> Error {
    crate::shared::fastify::error(Status::PAYLOAD_TOO_LARGE, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")
}

pub(crate) async fn read(body: Body, limit: usize, declared: Option<usize>) -> Result<Vec<u8>, Error> {
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    let mut total = 0usize;
    let mut deadline = declared.filter(|size| *size > limit).map(|_| Instant::now() + DRAIN_TIME);
    loop {
        let next = match deadline {
            Some(end) => tokio::time::timeout_at(end, stream.next()).await.map_err(|_| too_large())?,
            None => stream.next().await,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| too_large())?;
        total = total.saturating_add(chunk.len());
        if total > limit {
            bytes.clear();
            deadline.get_or_insert_with(|| Instant::now() + DRAIN_TIME);
        }
        if total > limit.saturating_add(DRAIN_SLACK) {
            return Err(too_large());
        }
        if deadline.is_none() {
            bytes.extend_from_slice(&chunk);
        }
    }
    if deadline.is_some() { Err(too_large()) } else { Ok(bytes) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retains_exact_limit_and_drains_near_overrun() {
        assert_eq!(read(Body::from("abcd"), 4, Some(4)).await.unwrap(), b"abcd");
        for declared in [None, Some(5)] {
            let error = read(Body::from("abcde"), 4, declared).await.unwrap_err();
            assert_eq!(error.0, Status::PAYLOAD_TOO_LARGE);
            assert_eq!(error.1.0["code"], "FST_ERR_CTP_BODY_TOO_LARGE");
        }
    }

    #[tokio::test]
    async fn overrun_drain_has_a_byte_bound() {
        let bytes = vec![0; DRAIN_SLACK + 5];
        assert_eq!(read(Body::from(bytes), 4, None).await.unwrap_err().0, Status::PAYLOAD_TOO_LARGE);
    }
}
