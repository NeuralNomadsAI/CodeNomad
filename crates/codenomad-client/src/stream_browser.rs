//! Browser-owned EventSource. Recovery owns reconnect epochs and backoff.
use super::{
    Backend,
    hub::{Hub, SharedStream},
    limits::FRAME_LIMIT,
    staleness::{ProbeSource, STALE_THRESHOLD, Watchdog, probe_stale},
};
use serde_json::json;
use std::{
    cell::Cell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::SeqCst},
    },
};
use wasm_bindgen::{JsCast, closure::Closure};
use web_sys::{
    Document, Event, EventSource, EventSourceInit, MessageEvent, VisibilityState, Window,
};

const BACKLOG_LIMIT: usize = 2 * FRAME_LIMIT;

enum Frame {
    Open,
    Data(String, String),
    Ping,
    Skipped,
    Closed,
}

struct WakeListeners {
    window: Window,
    online: Option<Closure<dyn FnMut(Event)>>,
    document: Option<(Document, Closure<dyn FnMut(Event)>)>,
}

impl WakeListeners {
    fn attach() -> Option<Self> {
        let window = web_sys::window()?;
        let online_cb: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
            probe_stale();
        });
        let online = window
            .add_event_listener_with_callback("online", online_cb.as_ref().unchecked_ref())
            .is_ok()
            .then_some(online_cb);
        let document = window.document().and_then(|doc| {
            let visible_doc = doc.clone();
            let visible_cb: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
                if visible_doc.visibility_state() == VisibilityState::Visible {
                    probe_stale();
                }
            });
            doc.add_event_listener_with_callback(
                "visibilitychange",
                visible_cb.as_ref().unchecked_ref(),
            )
            .is_ok()
            .then_some((doc, visible_cb))
        });
        Some(Self {
            window,
            online,
            document,
        })
    }
}

impl Drop for WakeListeners {
    fn drop(&mut self) {
        if let Some(online) = &self.online {
            let _ = self
                .window
                .remove_event_listener_with_callback("online", online.as_ref().unchecked_ref());
        }
        if let Some((document, visible)) = &self.document {
            let _ = document.remove_event_listener_with_callback(
                "visibilitychange",
                visible.as_ref().unchecked_ref(),
            );
        }
    }
}

struct Source {
    source: EventSource,
    _open: Closure<dyn FnMut(Event)>,
    _message: Closure<dyn FnMut(MessageEvent)>,
    ping: Closure<dyn FnMut(MessageEvent)>,
    _error: Closure<dyn FnMut(Event)>,
    _wake: Option<WakeListeners>,
}

impl Drop for Source {
    fn drop(&mut self) {
        self.source.close();
        self.source.set_onopen(None);
        self.source.set_onmessage(None);
        self.source.set_onerror(None);
        let _ = self.source.remove_event_listener_with_callback(
            "codenomad.client.ping",
            self.ping.as_ref().unchecked_ref(),
        );
    }
}

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
    watchdog: &Arc<Watchdog>,
    cancel_rx: &crate::Receiver<()>,
    abort_tx: &crate::Sender<bool>,
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
    let watchdog = watchdog.clone();
    let pong_watchdog = watchdog.fork();
    let pong_probe = ProbeSource::global().subscribe();
    let cancel_rx = cancel_rx.clone();
    let abort_tx = abort_tx.clone();
    crate::runtime::spawn(async move {
        let _guard = ClearOnDrop(in_flight);
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
    });
}

pub(super) async fn pump_shared(
    hub: Arc<Hub>,
    shared: Arc<SharedStream>,
    b: Backend,
    connection: String,
    stop_rx: crate::Receiver<()>,
) {
    enum Step {
        Event(std::result::Result<Frame, async_channel::RecvError>),
        Stale,
        Stopped,
        PongAbort(bool),
    }
    let mut auth_expired = false;
    {
        let Ok(mut url) = reqwest::Url::parse(&format!("{}api/events", b.base)) else {
            shared.finish(&hub, false);
            return;
        };
        url.query_pairs_mut()
            .append_pair("clientId", &b.client_id)
            .append_pair("connectionId", &connection)
            .append_pair("userFiles", crate::attachments::USER_FILES_REFERENCE);
        let options = EventSourceInit::new();
        options.set_with_credentials(true);
        let Ok(source) = EventSource::new_with_event_source_init_dict(url.as_str(), &options)
        else {
            shared.finish(&hub, false);
            return;
        };
        let (tx, rx) = crate::bounded(128);
        let global_probe = ProbeSource::global().subscribe();
        let wake_listeners = WakeListeners::attach();
        let watchdog = Arc::new(Watchdog::new(STALE_THRESHOLD));
        let overflow = Rc::new(Cell::new(false));
        let queued_bytes = Rc::new(Cell::new(0usize));

        let tx_open = tx.clone();
        let fail_open = overflow.clone();
        let close_open = source.clone();
        let watchdog_open = watchdog.clone();
        let on_open: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
            watchdog_open.activity();
            if tx_open.try_send(Frame::Open).is_err() {
                fail_open.set(true);
                close_open.close();
            }
        });

        let tx_msg = tx.clone();
        let overflow_msg = overflow.clone();
        let queued_msg = queued_bytes.clone();
        let close_msg = source.clone();
        let shared_msg = shared.clone();
        let watchdog_msg = watchdog.clone();
        let on_message: Closure<dyn FnMut(MessageEvent)> =
            Closure::new(move |event: MessageEvent| {
                watchdog_msg.activity();
                let data = event.data().as_string().unwrap_or_default();
                let quotas = shared_msg.snapshot_quotas();
                let frame = if data.len() <= FRAME_LIMIT {
                    for quota in &quotas {
                        quota.frame(&data);
                    }
                    Frame::Data("message".into(), data)
                } else {
                    for quota in &quotas {
                        quota.skipped();
                    }
                    Frame::Skipped
                };
                let bytes = match &frame {
                    Frame::Data(_, data) => data.len(),
                    _ => 0,
                };
                let total = queued_msg.get().saturating_add(bytes);
                if total > BACKLOG_LIMIT || tx_msg.try_send(frame).is_err() {
                    overflow_msg.set(true);
                    close_msg.close();
                    for quota in &quotas {
                        quota.transport(false);
                    }
                } else {
                    queued_msg.set(total);
                }
            });

        let tx_ping = tx.clone();
        let watchdog_ping = watchdog.clone();
        let ping: Closure<dyn FnMut(MessageEvent)> = Closure::new(move |_: MessageEvent| {
            watchdog_ping.activity();
            let _ = tx_ping.try_send(Frame::Ping);
        });

        let tx_error = tx.clone();
        let fail_error = overflow.clone();
        let close_error = source.clone();
        let shared_error = shared.clone();
        let on_error: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
            for quota in shared_error.snapshot_quotas() {
                quota.transport(false);
            }
            close_error.close();
            if tx_error.try_send(Frame::Closed).is_err() {
                fail_error.set(true);
            }
        });

        source.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        source.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        source.set_onerror(Some(on_error.as_ref().unchecked_ref()));
        let _source = Source {
            source,
            _open: on_open,
            _message: on_message,
            ping,
            _error: on_error,
            _wake: wake_listeners,
        };
        if _source
            .source
            .add_event_listener_with_callback(
                "codenomad.client.ping",
                _source.ping.as_ref().unchecked_ref(),
            )
            .is_err()
        {
            drop(_source);
            shared.finish(&hub, false);
            return;
        }

        let pong_in_flight = Arc::new(AtomicBool::new(false));
        let (_pong_cancel_tx, pong_cancel_rx) = crate::bounded::<()>(1);
        let (pong_abort_tx, pong_abort_rx) = crate::bounded::<bool>(1);
        loop {
            if overflow.get() || watchdog.is_stale() {
                break;
            }
            if let Ok(expired) = pong_abort_rx.try_recv() {
                auth_expired = expired;
                break;
            }
            let step = match rx.try_recv() {
                Ok(frame) => Step::Event(Ok(frame)),
                Err(async_channel::TryRecvError::Closed) => {
                    Step::Event(Err(async_channel::RecvError))
                }
                Err(async_channel::TryRecvError::Empty) => {
                    futures_lite::future::or(
                        async {
                            futures_lite::future::or(
                                async {
                                    let _ = stop_rx.recv().await;
                                    Step::Stopped
                                },
                                futures_lite::future::or(
                                    async {
                                        if let Ok(expired) = pong_abort_rx.recv().await {
                                            Step::PongAbort(expired)
                                        } else {
                                            std::future::pending().await
                                        }
                                    },
                                    async {
                                        watchdog.wait_until_stale(&global_probe, None).await;
                                        Step::Stale
                                    },
                                ),
                            )
                            .await
                        },
                        async { Step::Event(rx.recv().await) },
                    )
                    .await
                }
            };
            // Re-check after awaiting rx so a frame queued before sleep cannot mask staleness.
            if watchdog.is_stale() {
                break;
            }
            match step {
                Step::Event(Ok(Frame::Open)) => {
                    b.client.children().invalidate_all(&b);
                    if !shared.mark_open() {
                        break;
                    }
                }
                Step::Event(Ok(Frame::Data(kind, data))) => {
                    queued_bytes.set(queued_bytes.get().saturating_sub(data.len()));
                    shared.broadcast_frame(kind, data);
                }
                Step::Event(Ok(Frame::Ping)) => {
                    spawn_pong(
                        &b,
                        &connection,
                        &pong_in_flight,
                        &watchdog,
                        &pong_cancel_rx,
                        &pong_abort_tx,
                    );
                }
                Step::Event(Ok(Frame::Skipped)) => {
                    b.client.children().invalidate_all(&b);
                    shared.broadcast_skipped();
                }
                Step::Event(Ok(Frame::Closed))
                | Step::Event(Err(_))
                | Step::Stale
                | Step::Stopped => break,
                Step::PongAbort(expired) => {
                    auth_expired = expired;
                    break;
                }
            }
        }
    }
    shared.finish(&hub, auth_expired);
}
