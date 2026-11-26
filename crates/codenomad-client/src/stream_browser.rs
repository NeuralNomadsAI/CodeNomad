//! Browser-owned EventSource. Recovery owns reconnect epochs and backoff.
use super::{
    Backend,
    hub::{Hub, SharedStream},
    limits::FRAME_LIMIT,
    staleness::{ProbeSource, STALE_THRESHOLD, Watchdog, probe_stale},
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering::SeqCst},
};
use wasm_bindgen::{JsCast, closure::Closure};
use web_sys::{
    Document, Event, EventSource, EventSourceInit, MessageEvent, VisibilityState, Window,
};

type DocumentListener = (Document, Closure<dyn FnMut(Event)>);

struct WakeListeners {
    window: Window,
    online: Option<Closure<dyn FnMut(Event)>>,
    document: Option<DocumentListener>,
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
    abort_tx: &crate::Sender<()>,
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
    let pong_probe = ProbeSource::global().subscribe();
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
            PongStep::Done(Err(_)) | PongStep::Stale => {
                let _ = abort_tx.try_send(());
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
    enum Signal {
        Ping,
        Closed,
    }
    enum Step {
        Signal(std::result::Result<Signal, async_channel::RecvError>),
        Stale,
        Stopped,
        PongAbort,
    }
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
        let (signal_tx, signal_rx) = crate::bounded(8);
        let global_probe = ProbeSource::global().subscribe();
        let wake_listeners = WakeListeners::attach();
        let watchdog = Arc::new(Watchdog::new(STALE_THRESHOLD));

        let tx_open = signal_tx.clone();
        let close_open = source.clone();
        let watchdog_open = watchdog.clone();
        let shared_open = shared.clone();
        let backend_open = b.clone();
        let on_open: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
            if watchdog_open.is_stale() {
                close_open.close();
                let _ = tx_open.try_send(Signal::Closed);
                return;
            }
            watchdog_open.activity();
            backend_open.client.children().invalidate_all(&backend_open);
            if !shared_open.mark_open() {
                close_open.close();
                let _ = tx_open.try_send(Signal::Closed);
            }
        });

        let tx_msg = signal_tx.clone();
        let close_msg = source.clone();
        let hub_msg = hub.clone();
        let shared_msg = shared.clone();
        let backend_msg = b.clone();
        let watchdog_msg = watchdog.clone();
        let on_message: Closure<dyn FnMut(MessageEvent)> =
            Closure::new(move |event: MessageEvent| {
                // Reject pre-sleep buffered frames if the stream has already crossed the silence threshold.
                if watchdog_msg.is_stale() {
                    close_msg.close();
                    let _ = tx_msg.try_send(Signal::Closed);
                    return;
                }
                watchdog_msg.activity();
                let data = event.data().as_string().unwrap_or_default();
                if data.len() <= FRAME_LIMIT {
                    shared_msg.broadcast_frame(&hub_msg, "message".into(), data);
                } else {
                    backend_msg.client.children().invalidate_all(&backend_msg);
                    shared_msg.broadcast_skipped();
                }
            });

        let tx_ping = signal_tx.clone();
        let close_ping = source.clone();
        let watchdog_ping = watchdog.clone();
        let ping: Closure<dyn FnMut(MessageEvent)> = Closure::new(move |_: MessageEvent| {
            if watchdog_ping.is_stale() {
                close_ping.close();
                let _ = tx_ping.try_send(Signal::Closed);
                return;
            }
            watchdog_ping.activity();
            let _ = tx_ping.try_send(Signal::Ping);
        });

        let tx_error = signal_tx.clone();
        let close_error = source.clone();
        let on_error: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
            close_error.close();
            let _ = tx_error.try_send(Signal::Closed);
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
        let (pong_cancel_tx, pong_cancel_rx) = crate::bounded::<()>(1);
        let (pong_abort_tx, pong_abort_rx) = crate::bounded::<()>(1);
        let mut pong_done: Option<crate::Receiver<()>> = None;
        loop {
            if watchdog.is_stale() || pong_abort_rx.try_recv().is_ok() {
                break;
            }
            let step = futures_lite::future::or(
                async {
                    futures_lite::future::or(
                        async {
                            let _ = stop_rx.recv().await;
                            Step::Stopped
                        },
                        futures_lite::future::or(
                            async {
                                if pong_abort_rx.recv().await.is_ok() {
                                    Step::PongAbort
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
                async { Step::Signal(signal_rx.recv().await) },
            )
            .await;
            if watchdog.is_stale() {
                break;
            }
            match step {
                Step::Signal(Ok(Signal::Ping)) => {
                    if let Some(done) = spawn_pong(
                        &b,
                        &connection,
                        &pong_in_flight,
                        &watchdog,
                        &pong_cancel_rx,
                        &pong_abort_tx,
                    ) {
                        pong_done = Some(done);
                    }
                }
                Step::Signal(Ok(Signal::Closed))
                | Step::Signal(Err(_))
                | Step::Stale
                | Step::Stopped
                | Step::PongAbort => break,
            }
        }
        drop(pong_cancel_tx);
        drop(global_probe);
        drop(_source);
        shared.begin_close(&hub);
        if let Some(done) = pong_done {
            let _ = done.recv().await;
        }
    }
    shared.finish(&hub, false);
}
