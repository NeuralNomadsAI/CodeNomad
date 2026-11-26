//! Native HTTP byte stream and frame dispatch.
use super::{
    Backend, Input, Result, Sender, State, dispatch,
    frames::{Parsed, Parser},
    limits::reread,
    opened,
    staleness::{Clock, ProbeSource, STALE_THRESHOLD, Watchdog},
};
use std::sync::Arc;

enum Next<T> {
    Ready(T),
    Stale,
}

struct QuotaGuard(Option<crate::provider_usage::Ingress>);

impl Drop for QuotaGuard {
    fn drop(&mut self) {
        if let Some(quota) = &self.0 {
            quota.transport(false);
        }
    }
}

pub(super) async fn read_native(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
) -> Result<()> {
    read_native_with(
        b,
        epoch,
        out,
        state,
        Arc::new(Watchdog::new(STALE_THRESHOLD)),
        ProbeSource::global(),
    )
    .await
}

pub(super) async fn read_native_with<C: Clock + Clone>(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    watchdog: Arc<Watchdog<C>>,
    probes: ProbeSource,
) -> Result<()> {
    let connection = format!("stream-{epoch}");
    let handshake_probe = probes.subscribe();
    let request = b
        .client
        .stream_get(format!("{}api/events", b.base))
        .query(&[
            ("clientId", b.client_id.as_str()),
            ("connectionId", connection.as_str()),
            ("userFiles", crate::attachments::USER_FILES_REFERENCE),
        ]);
    let response = match futures_lite::future::or(
        async {
            watchdog.wait_until_stale(&handshake_probe, None).await;
            Next::Stale
        },
        async { Next::Ready(request.send().await) },
    )
    .await
    {
        Next::Ready(response) => response?.error_for_status()?,
        Next::Stale => return Err("event stream stale".into()),
    };
    drop(handshake_probe);
    if !response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("text/event-stream"))
    {
        return Err("expected event stream".into());
    }
    watchdog.activity();
    b.client.children().invalidate_all(b);
    read_frames_with(
        b,
        epoch,
        out,
        state,
        &connection,
        response.bytes_stream(),
        watchdog,
        probes,
    )
    .await
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
    read_frames_with(
        b,
        epoch,
        out,
        state,
        connection,
        chunks,
        Arc::new(Watchdog::new(STALE_THRESHOLD)),
        ProbeSource::global(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn read_frames_with<B: AsRef<[u8]>, C: Clock + Clone>(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    chunks: impl futures_lite::Stream<Item = std::result::Result<B, reqwest::Error>>,
    watchdog: Arc<Watchdog<C>>,
    probes: ProbeSource,
) -> Result<()> {
    use futures_lite::StreamExt;
    let quota = state.quota_ingress(b);
    if let Some(quota) = &quota {
        quota.transport(true);
    }
    // One bounded frame of read-ahead keeps SSE authority ahead of transcript dispatch.
    let (send, receive) = crate::bounded(1);
    let read_watchdog = watchdog.clone();
    let read_probe = probes.subscribe();
    let read = async move {
        // Owned by the reader so transport authority drops immediately on EOF/error before
        // route drains, and also on cancellation if route aborts on a stale pong.
        let _quota_guard = QuotaGuard(quota.clone());
        let mut chunks = std::pin::pin!(chunks);
        let mut parser = Parser::default();
        loop {
            match futures_lite::future::or(
                async {
                    read_watchdog.wait_until_stale(&read_probe, None).await;
                    Next::Stale
                },
                async { Next::Ready(chunks.next().await) },
            )
            .await
            {
                Next::Ready(Some(chunk)) => {
                    let chunk = match chunk {
                        Ok(chunk) => chunk,
                        Err(err) => return Ok(Err(err.into())),
                    };
                    let bytes = chunk.as_ref();
                    if !bytes.is_empty() {
                        read_watchdog.activity();
                        // Waiting on the bounded local channel is UI backpressure, not server silence.
                        let _pause = read_watchdog.pause();
                        if let Err(err) =
                            receive_chunk(b, state, &mut parser, bytes, quota.as_ref(), &send).await
                        {
                            return Ok(Err(err));
                        }
                    }
                }
                Next::Ready(None) => return Ok(Err("event stream ended".into())),
                Next::Stale => {
                    return Err::<Result<()>, crate::history::Error>("event stream stale".into());
                }
            }
        }
    };
    let route = async move {
        {
            let _pause = watchdog.pause();
            opened(epoch, out, state).await?;
        }
        while let Ok(frame) = receive.recv().await {
            match frame {
                Parsed::Data(kind, data) if kind == "codenomad.client.ping" => {
                    // Pong POST is an independent network wait: a forked watchdog ensures frames
                    // queued behind the ping in `read` cannot pause the pong deadline.
                    let pong_watchdog = watchdog.fork();
                    let pong_probe = probes.subscribe();
                    match futures_lite::future::or(
                        async {
                            pong_watchdog.wait_until_stale(&pong_probe, None).await;
                            Next::Stale
                        },
                        async {
                            Next::Ready(
                                dispatch(b, epoch, out, state, connection, &kind, &data).await,
                            )
                        },
                    )
                    .await
                    {
                        Next::Ready(result) => {
                            result?;
                            watchdog.activity();
                        }
                        Next::Stale => return Err("event stream stale".into()),
                    }
                }
                Parsed::Data(kind, data) => {
                    let _pause = watchdog.pause();
                    dispatch(b, epoch, out, state, connection, &kind, &data).await?;
                }
                Parsed::Skipped => {
                    let _pause = watchdog.pause();
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

async fn receive_chunk(
    b: &Backend,
    state: &State,
    parser: &mut Parser,
    chunk: &[u8],
    quota: Option<&crate::provider_usage::Ingress>,
    frames: &Sender<Parsed>,
) -> Result<()> {
    // Bytes already delivered by HTTP may still contain a session deletion or revocation past
    // the next queued frame. Observe deletion hooks across the whole chunk before awaiting the
    // bounded frame queue, while keeping quota ingress aligned with each queued frame.
    let unobserved = quota.map(crate::provider_usage::Ingress::chunk);
    let mut parsed = Vec::new();
    for byte in chunk {
        if let Some(frame) = parser.byte(*byte)? {
            if let Parsed::Data(kind, data) = &frame {
                state.observe_frame(b, kind, data);
            }
            parsed.push(frame);
        }
    }
    for frame in parsed {
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
    if let Some(chunk) = unobserved {
        chunk.finish();
    }
    Ok(())
}
