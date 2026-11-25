//! Native HTTP byte stream and frame dispatch.
#[cfg(not(test))]
use super::Backend;
#[cfg(test)]
use super::{Backend, Input, Result, Sender, State, dispatch, limits::reread, opened};
use super::{
    frames::{Parsed, Parser},
    hub::{Hub, SharedStream},
};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::SeqCst},
    },
    time::Duration,
};

struct ClearOnDrop(Arc<AtomicBool>);

impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        self.0.store(false, SeqCst);
    }
}

fn spawn_pong(
    b: &Backend,
    connection: &str,
    in_flight: &Arc<AtomicBool>,
    auth_failed: &crate::Sender<()>,
) {
    if in_flight
        .compare_exchange(false, true, SeqCst, SeqCst)
        .is_err()
    {
        return;
    }
    let b = b.clone();
    let connection = connection.to_owned();
    let in_flight = in_flight.clone();
    let auth_failed = auth_failed.clone();
    crate::runtime::spawn(async move {
        let _guard = ClearOnDrop(in_flight);
        let result = b
            .client
            .post(format!("{}api/client-connections/pong", b.base))
            .json(&json!({"clientId": b.client_id, "connectionId": connection}))
            .send()
            .await
            .and_then(|response| response.error_for_status());
        if let Err(err) = result
            && crate::http::authentication_expired(&err.into())
        {
            let _ = auth_failed.try_send(());
        }
    });
}

pub(super) async fn pump_shared(
    hub: Arc<Hub>,
    shared: Arc<SharedStream>,
    b: Backend,
    connection: String,
    stop_rx: crate::Receiver<()>,
) {
    use futures_lite::StreamExt;
    enum ConnectOutcome {
        Response(std::result::Result<reqwest::Response, reqwest::Error>),
        Stopped,
    }
    enum NextChunk<B> {
        Chunk(Option<std::result::Result<B, reqwest::Error>>),
        Stopped,
        AuthExpired,
    }
    let mut auth_expired = false;
    {
        let connected = futures_lite::future::race(
            async {
                let res = b
                    .client
                    .get(format!("{}api/events", b.base))
                    .query(&[
                        ("clientId", b.client_id.as_str()),
                        ("connectionId", connection.as_str()),
                        ("userFiles", crate::attachments::USER_FILES_REFERENCE),
                    ])
                    .timeout(Duration::from_secs(86400))
                    .send()
                    .await
                    .and_then(|response| response.error_for_status());
                ConnectOutcome::Response(res)
            },
            async {
                let _ = stop_rx.recv().await;
                ConnectOutcome::Stopped
            },
        )
        .await;
        let response = match connected {
            ConnectOutcome::Response(Ok(response)) => response,
            ConnectOutcome::Response(Err(err)) => {
                auth_expired = crate::http::authentication_expired(&err.into());
                shared.finish(&hub, auth_expired);
                return;
            }
            ConnectOutcome::Stopped => {
                shared.finish(&hub, false);
                return;
            }
        };
        if !response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| h.starts_with("text/event-stream"))
        {
            drop(response);
            shared.finish(&hub, false);
            return;
        }
        b.client.children().invalidate_all(&b);
        if !shared.mark_open() {
            drop(response);
            shared.finish(&hub, false);
            return;
        }
        let pong_in_flight = Arc::new(AtomicBool::new(false));
        let (pong_auth_tx, pong_auth_rx) = crate::bounded::<()>(1);
        let mut chunks = std::pin::pin!(response.bytes_stream());
        let mut parser = Parser::default();
        loop {
            if pong_auth_rx.try_recv().is_ok() {
                auth_expired = true;
                break;
            }
            let next = futures_lite::future::race(
                async { NextChunk::Chunk(chunks.next().await) },
                futures_lite::future::race(
                    async {
                        let _ = stop_rx.recv().await;
                        NextChunk::Stopped
                    },
                    async {
                        if pong_auth_rx.recv().await.is_ok() {
                            NextChunk::AuthExpired
                        } else {
                            std::future::pending().await
                        }
                    },
                ),
            )
            .await;
            let chunk = match next {
                NextChunk::Chunk(Some(Ok(bytes))) => bytes,
                NextChunk::Chunk(Some(Err(err))) => {
                    auth_expired = crate::http::authentication_expired(&err.into());
                    break;
                }
                NextChunk::Chunk(None) | NextChunk::Stopped => break,
                NextChunk::AuthExpired => {
                    auth_expired = true;
                    break;
                }
            };
            let quotas = shared.snapshot_quotas();
            let guards: Vec<_> = quotas
                .iter()
                .map(crate::provider_usage::Ingress::chunk)
                .collect();
            let mut parse_failed = false;
            for byte in chunk.as_ref() {
                match parser.byte(*byte) {
                    Ok(Some(Parsed::Data(kind, _))) if kind == "codenomad.client.ping" => {
                        spawn_pong(&b, &connection, &pong_in_flight, &pong_auth_tx);
                    }
                    Ok(Some(Parsed::Data(kind, data))) => {
                        if kind.is_empty() || kind == "message" {
                            for quota in &quotas {
                                quota.frame(&data);
                            }
                        }
                        shared.broadcast_frame(kind, data);
                    }
                    Ok(Some(Parsed::Skipped)) => {
                        b.client.children().invalidate_all(&b);
                        for quota in &quotas {
                            quota.skipped();
                        }
                        shared.broadcast_skipped();
                    }
                    Ok(None) => {}
                    Err(_) => {
                        parse_failed = true;
                        break;
                    }
                }
            }
            if parse_failed {
                drop(guards);
                break;
            }
            for guard in guards {
                guard.finish();
            }
        }
    }
    shared.finish(&hub, auth_expired);
}

#[cfg(test)]
pub(super) async fn read_frames<B: AsRef<[u8]>>(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    chunks: impl futures_lite::Stream<Item = std::result::Result<B, reqwest::Error>>,
) -> Result<()> {
    use futures_lite::StreamExt;
    let quota = state.quota_ingress(b);
    if let Some(quota) = &quota {
        quota.transport(true);
    }
    // One bounded frame of read-ahead keeps SSE authority ahead of transcript dispatch.
    let (send, receive) = crate::bounded(1);
    let read = async move {
        let result: Result<()> = async {
            let mut chunks = std::pin::pin!(chunks);
            let mut parser = Parser::default();
            while let Some(chunk) = chunks.next().await {
                receive_chunk(&mut parser, chunk?.as_ref(), quota.as_ref(), &send).await?;
            }
            Err("event stream ended".into())
        }
        .await;
        if let Some(quota) = &quota {
            quota.transport(false);
        }
        Ok::<_, crate::history::Error>(result)
    };
    let route = async move {
        opened(epoch, out, state).await?;
        while let Ok(frame) = receive.recv().await {
            match frame {
                Parsed::Data(kind, data) => {
                    dispatch(b, epoch, out, state, connection, &kind, &data).await?;
                }
                Parsed::Skipped => {
                    b.client.children().invalidate_all(b);
                    reread(epoch, out, state).await?;
                }
            }
        }
        Ok(())
    };
    let (read, ()) = futures_lite::future::try_zip(read, route).await?;
    read
}

#[cfg(test)]
async fn receive_chunk(
    parser: &mut Parser,
    chunk: &[u8],
    quota: Option<&crate::provider_usage::Ingress>,
    frames: &Sender<Parsed>,
) -> Result<()> {
    // Bytes already delivered by HTTP may still contain a revocation past the next queued frame.
    let unobserved = quota.map(crate::provider_usage::Ingress::chunk);
    for byte in chunk {
        if let Some(frame) = parser.byte(*byte)? {
            if let Some(quota) = quota {
                match &frame {
                    Parsed::Data(kind, data) if kind.is_empty() || kind == "message" => {
                        quota.frame(data)
                    }
                    Parsed::Skipped => quota.skipped(),
                    _ => {}
                }
            }
            frames.send(frame).await?;
        }
    }
    if let Some(chunk) = unobserved {
        chunk.finish();
    }
    Ok(())
}
