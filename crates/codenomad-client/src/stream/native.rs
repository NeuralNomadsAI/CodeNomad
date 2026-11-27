//! Native HTTP byte stream and frame dispatch.
use super::{
    Backend,
    frames::{Parsed, Parser},
    hub::{Hub, SharedStream},
    staleness::{Clock, ProbeSource, STALE_THRESHOLD, Watchdog},
};
#[cfg(test)]
use super::{
    Input, Result, Sender, State, limits::reread_marked, opened, routing::dispatch_marked,
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering::SeqCst},
};

#[cfg(test)]
enum Next<T> {
    Ready(T),
    Stale,
}

#[cfg(test)]
struct QuotaGuard(Option<crate::provider_usage::Ingress>);

#[cfg(test)]
impl Drop for QuotaGuard {
    fn drop(&mut self) {
        if let Some(quota) = &self.0 {
            quota.transport(false);
        }
    }
}

struct ClearOnDrop(Arc<AtomicBool>);

impl Drop for ClearOnDrop {
    fn drop(&mut self) {
        self.0.store(false, SeqCst);
    }
}

fn spawn_pong<C: Clock + Clone + Send + Sync + 'static>(
    b: &Backend,
    connection: &str,
    in_flight: &Arc<AtomicBool>,
    watchdog: &Arc<Watchdog<C>>,
    probes: &ProbeSource,
    cancel_rx: &crate::Receiver<()>,
    abort_tx: &crate::Sender<bool>,
) -> Option<crate::Receiver<()>> {
    if in_flight
        .compare_exchange(false, true, SeqCst, SeqCst)
        .is_err()
    {
        return None;
    }
    let (done_tx, done_rx) = crate::bounded(1);
    let b = b.clone();
    let connection = connection.to_owned();
    let in_flight = in_flight.clone();
    let watchdog = watchdog.clone();
    let pong_watchdog = watchdog.fork();
    let pong_probe = probes.subscribe();
    let cancel_rx = cancel_rx.clone();
    let abort_tx = abort_tx.clone();
    crate::runtime::spawn(async move {
        let _done = done_tx;
        let _guard = ClearOnDrop(in_flight);
        let pong_probe = pong_probe;
        enum PongStep {
            Done(std::result::Result<reqwest::Response, reqwest::Error>),
            Stale,
            Cancelled,
        }
        let step = futures_lite::future::or(
            async {
                futures_lite::future::or(
                    async {
                        let _ = cancel_rx.recv().await;
                        PongStep::Cancelled
                    },
                    async {
                        pong_watchdog.wait_until_stale(&pong_probe, None).await;
                        PongStep::Stale
                    },
                )
                .await
            },
            async {
                let res = b
                    .client
                    .post(format!("{}api/client-connections/pong", b.base))
                    .json(&json!({"clientId": b.client_id, "connectionId": connection}))
                    .send()
                    .await
                    .and_then(|response| response.error_for_status());
                PongStep::Done(res)
            },
        )
        .await;
        match step {
            PongStep::Done(Ok(_)) => watchdog.activity(),
            PongStep::Done(Err(err)) => {
                let expired = crate::http::authentication_expired(&err.into());
                let _ = abort_tx.try_send(expired);
            }
            PongStep::Stale => {
                let _ = abort_tx.try_send(false);
            }
            PongStep::Cancelled => {}
        }
        drop(pong_probe);
        drop(_guard);
        drop(_done);
    });
    Some(done_rx)
}

pub(super) async fn pump_shared(
    hub: Arc<Hub>,
    shared: Arc<SharedStream>,
    b: Backend,
    connection: String,
    stop_rx: crate::Receiver<()>,
) {
    pump_shared_with(
        hub,
        shared,
        b,
        connection,
        stop_rx,
        Arc::new(Watchdog::new(STALE_THRESHOLD)),
        ProbeSource::global(),
    )
    .await;
}

pub(super) async fn pump_shared_with<C: Clock + Clone + Send + Sync + 'static>(
    hub: Arc<Hub>,
    shared: Arc<SharedStream>,
    b: Backend,
    connection: String,
    stop_rx: crate::Receiver<()>,
    watchdog: Arc<Watchdog<C>>,
    probes: ProbeSource,
) {
    use futures_lite::StreamExt;
    enum ConnectOutcome {
        Response(std::result::Result<reqwest::Response, reqwest::Error>),
        Stale,
        Stopped,
    }
    enum NextChunk<B> {
        Chunk(Option<std::result::Result<B, reqwest::Error>>),
        Stale,
        Stopped,
        PongAbort(bool),
    }
    let mut auth_expired = false;
    let mut pong_done: Option<crate::Receiver<()>> = None;
    {
        let handshake_probe = probes.subscribe();
        let request = b
            .client
            .stream_get(format!("{}api/events", b.base))
            .query(&[
                ("clientId", b.client_id.as_str()),
                ("connectionId", connection.as_str()),
                ("userFiles", crate::attachments::USER_FILES_REFERENCE),
            ]);
        let connected = futures_lite::future::or(
            async {
                futures_lite::future::or(
                    async {
                        let _ = stop_rx.recv().await;
                        ConnectOutcome::Stopped
                    },
                    async {
                        watchdog.wait_until_stale(&handshake_probe, None).await;
                        ConnectOutcome::Stale
                    },
                )
                .await
            },
            async {
                let res = request
                    .send()
                    .await
                    .and_then(|response| response.error_for_status());
                ConnectOutcome::Response(res)
            },
        )
        .await;
        drop(handshake_probe);
        let response = match connected {
            ConnectOutcome::Response(Ok(response)) => response,
            ConnectOutcome::Response(Err(err)) => {
                auth_expired = crate::http::authentication_expired(&err.into());
                shared.finish(&hub, auth_expired);
                return;
            }
            ConnectOutcome::Stale | ConnectOutcome::Stopped => {
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
        watchdog.activity();
        b.client.children().invalidate_all(&b);
        if !shared.mark_open() {
            drop(response);
            shared.finish(&hub, false);
            return;
        }
        let read_probe = probes.subscribe();
        let pong_in_flight = Arc::new(AtomicBool::new(false));
        let (pong_cancel_tx, pong_cancel_rx) = crate::bounded::<()>(1);
        let (pong_abort_tx, pong_abort_rx) = crate::bounded::<bool>(1);
        let mut chunks = std::pin::pin!(response.bytes_stream());
        let mut parser = Parser::default();
        loop {
            if let Ok(expired) = pong_abort_rx.try_recv() {
                auth_expired = expired;
                break;
            }
            let next = futures_lite::future::or(
                async {
                    futures_lite::future::or(
                        async {
                            let _ = stop_rx.recv().await;
                            NextChunk::Stopped
                        },
                        futures_lite::future::or(
                            async {
                                if let Ok(expired) = pong_abort_rx.recv().await {
                                    NextChunk::PongAbort(expired)
                                } else {
                                    std::future::pending().await
                                }
                            },
                            async {
                                watchdog.wait_until_stale(&read_probe, None).await;
                                NextChunk::Stale
                            },
                        ),
                    )
                    .await
                },
                async { NextChunk::Chunk(chunks.next().await) },
            )
            .await;
            let chunk = match next {
                NextChunk::Chunk(Some(Ok(bytes))) => bytes,
                NextChunk::Chunk(Some(Err(err))) => {
                    auth_expired = crate::http::authentication_expired(&err.into());
                    break;
                }
                NextChunk::Chunk(None) | NextChunk::Stale | NextChunk::Stopped => break,
                NextChunk::PongAbort(expired) => {
                    auth_expired = expired;
                    break;
                }
            };
            if chunk.as_ref().is_empty() {
                continue;
            }
            watchdog.activity();
            let chunk_guard = shared.begin_chunk();
            let mut parse_failed = false;
            for byte in chunk.as_ref() {
                match parser.byte(*byte) {
                    Ok(Some(Parsed::Data(kind, _))) if kind == "codenomad.client.ping" => {
                        if let Some(done) = spawn_pong(
                            &b,
                            &connection,
                            &pong_in_flight,
                            &watchdog,
                            &probes,
                            &pong_cancel_rx,
                            &pong_abort_tx,
                        ) {
                            pong_done = Some(done);
                        }
                    }
                    Ok(Some(Parsed::Data(kind, data))) => {
                        shared.broadcast_frame(&hub, kind, data);
                    }
                    Ok(Some(Parsed::Skipped)) => {
                        b.client.children().invalidate_all(&b);
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
                drop(chunk_guard);
                break;
            }
            chunk_guard.finish();
        }
        drop(pong_cancel_tx);
        drop(read_probe);
    }
    shared.begin_close(&hub);
    if let Some(done) = pong_done {
        let _ = done.recv().await;
    }
    shared.finish(&hub, auth_expired);
}

#[cfg(test)]
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

#[cfg(test)]
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
                            receive_chunk(&mut parser, bytes, quota.as_ref(), b, state, &send).await
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
        while let Ok((frame, mark)) = receive.recv().await {
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
                                dispatch_marked(
                                    b, epoch, out, state, connection, &kind, &data, mark,
                                )
                                .await,
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
                    dispatch_marked(b, epoch, out, state, connection, &kind, &data, mark).await?;
                }
                Parsed::Skipped => {
                    let _pause = watchdog.pause();
                    b.client.children().invalidate_all(b);
                    reread_marked(epoch, out, state, mark).await?;
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
    b: &Backend,
    state: &State,
    frames: &Sender<(Parsed, u64)>,
) -> Result<()> {
    // Bytes already delivered by HTTP may still contain a session deletion or revocation past
    // the next queued frame. Observe deletion hooks across the whole chunk before awaiting the
    // bounded frame queue, while keeping quota and inbox ingress aligned with each queued frame.
    let unobserved = quota.map(crate::provider_usage::Ingress::chunk);
    struct InboxChunk<'a>(Option<&'a crate::inbox::InboxWire>);
    impl InboxChunk<'_> {
        fn finish(mut self) {
            if let Some(inbox) = self.0.take()
                && let Some(wake) = inbox.end_chunk_quiet(true)
            {
                wake();
            }
        }
    }
    impl Drop for InboxChunk<'_> {
        fn drop(&mut self) {
            if let Some(inbox) = self.0.take()
                && let Some(wake) = inbox.end_chunk_quiet(false)
            {
                wake();
            }
        }
    }
    let inbox_chunk = state.catalogue.is_none().then(|| {
        state.inbox.begin_chunk();
        InboxChunk(Some(&state.inbox))
    });
    let mut parsed = Vec::new();
    let mut parse_err = None;
    for byte in chunk {
        match parser.byte(*byte) {
            Ok(Some(frame)) => {
                if let Parsed::Data(kind, data) = &frame {
                    state.observe_frame(b, kind, data);
                }
                parsed.push(frame);
            }
            Ok(None) => {}
            Err(err) => {
                if let Some(quota) = quota {
                    quota.skipped();
                }
                parse_err = Some(err);
                break;
            }
        }
    }
    for frame in parsed {
        let mark = match &frame {
            Parsed::Data(kind, data) if kind != "codenomad.client.ping" => {
                if (kind.is_empty() || kind == "message")
                    && let Some(quota) = quota
                {
                    quota.frame(data);
                }
                if state.catalogue.is_none() {
                    super::sessions::note_inbox_frame(
                        &b.workspace,
                        &b.session,
                        &state.inbox,
                        Some(state.history_revision.as_ref()),
                        Some(state.upstream.as_ref()),
                        Some(state.disconnect_mark.as_ref()),
                        data,
                    )
                } else {
                    0
                }
            }
            Parsed::Skipped => {
                if let Some(quota) = quota {
                    quota.skipped();
                }
                if state.catalogue.is_none() {
                    state.history_revision.fetch_add(1, SeqCst);
                    state.inbox.record_ingress()
                } else {
                    0
                }
            }
            _ => 0,
        };
        frames.send((frame, mark)).await?;
    }
    if let Some(err) = parse_err {
        return Err(err);
    }
    if let Some(chunk) = inbox_chunk {
        chunk.finish();
    }
    if let Some(chunk) = unobserved {
        chunk.finish();
    }
    Ok(())
}
