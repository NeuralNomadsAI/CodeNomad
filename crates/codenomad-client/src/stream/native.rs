//! Native HTTP byte stream and frame dispatch.
use super::{
    Backend, Input, Result, Sender, State, dispatch,
    frames::{Parsed, Parser},
    limits::reread,
    opened,
    staleness::{Clock, ProbeSubscription, STALE_THRESHOLD, Watchdog},
};

enum Next<T> {
    Ready(T),
    Stale,
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
        Watchdog::new(STALE_THRESHOLD),
        ProbeSubscription::register(),
    )
    .await
}

pub(super) async fn read_native_with<C: Clock>(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    mut watchdog: Watchdog<C>,
    probe: ProbeSubscription,
) -> Result<()> {
    let connection = format!("stream-{epoch}");
    let request = b
        .client
        .stream_get(format!("{}api/events", b.base))
        .query(&[
            ("clientId", b.client_id.as_str()),
            ("connectionId", connection.as_str()),
            ("userFiles", crate::attachments::USER_FILES_REFERENCE),
        ]);
    let response =
        match futures_lite::future::race(async { Next::Ready(request.send().await) }, async {
            watchdog.wait_until_stale(&probe).await;
            Next::Stale
        })
        .await
        {
            Next::Ready(response) => response?.error_for_status()?,
            Next::Stale => return Err("event stream stale".into()),
        };
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
        probe,
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
        Watchdog::new(STALE_THRESHOLD),
        ProbeSubscription::register(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn read_frames_with<B: AsRef<[u8]>, C: Clock>(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    chunks: impl futures_lite::Stream<Item = std::result::Result<B, reqwest::Error>>,
    mut watchdog: Watchdog<C>,
    probe: ProbeSubscription,
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
            loop {
                match futures_lite::future::race(
                    async { Next::Ready(chunks.next().await) },
                    async {
                        watchdog.wait_until_stale(&probe).await;
                        Next::Stale
                    },
                )
                .await
                {
                    Next::Ready(Some(chunk)) => {
                        let chunk = chunk?;
                        let bytes = chunk.as_ref();
                        if !bytes.is_empty() {
                            watchdog.activity();
                            receive_chunk(&mut parser, bytes, quota.as_ref(), &send).await?;
                        }
                    }
                    Next::Ready(None) => return Err("event stream ended".into()),
                    Next::Stale => return Err("event stream stale".into()),
                }
            }
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
