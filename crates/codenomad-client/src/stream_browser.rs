//! Browser-owned EventSource. Recovery owns reconnect epochs and backoff.
use super::{
    limits::{FRAME_LIMIT, reread},
    staleness::{ProbeSource, STALE_THRESHOLD, Watchdog},
    *,
};
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::{JsCast, closure::Closure};
use web_sys::{
    Document, Event, EventSource, EventSourceInit, MessageEvent, VisibilityState, Window,
};

const BACKLOG_LIMIT: usize = 2 * FRAME_LIMIT;

enum Frame {
    Open,
    Data(String, String),
    Skipped,
    Closed,
}
struct WakeListeners {
    window: Window,
    online: Option<Closure<dyn FnMut(Event)>>,
    document: Option<(Document, Closure<dyn FnMut(Event)>)>,
}
impl WakeListeners {
    fn attach(probe: &Sender<()>) -> Option<Self> {
        let window = web_sys::window()?;
        let online_tx = probe.clone();
        let online_cb: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
            let _ = online_tx.try_send(());
        });
        let online = window
            .add_event_listener_with_callback("online", online_cb.as_ref().unchecked_ref())
            .is_ok()
            .then_some(online_cb);
        let document = window.document().and_then(|doc| {
            let visible_tx = probe.clone();
            let visible_doc = doc.clone();
            let visible_cb: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
                if visible_doc.visibility_state() == VisibilityState::Visible {
                    let _ = visible_tx.try_send(());
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

pub(super) async fn read(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
) -> Result<()> {
    let connection = format!("stream-{epoch}");
    let mut url = reqwest::Url::parse(&format!("{}api/events", b.base))?;
    url.query_pairs_mut()
        .append_pair("clientId", &b.client_id)
        .append_pair("connectionId", &connection)
        .append_pair("userFiles", crate::attachments::USER_FILES_REFERENCE);
    let options = EventSourceInit::new();
    options.set_with_credentials(true);
    let source = EventSource::new_with_event_source_init_dict(url.as_str(), &options)
        .map_err(|_| "browser event stream unavailable")?;
    let (tx, rx) = crate::bounded(128);
    let (wake_tx, wake_rx) = crate::bounded(1);
    let global_probe = ProbeSource::global().subscribe();
    let wake_listeners = WakeListeners::attach(&wake_tx);
    let watchdog = Arc::new(Watchdog::new(STALE_THRESHOLD));
    let overflow = Rc::new(Cell::new(false));
    let queued_bytes = Rc::new(Cell::new(0usize));
    let quota = state.quota_ingress(b);
    struct QuotaGuard(Option<crate::provider_usage::Ingress>);
    impl Drop for QuotaGuard {
        fn drop(&mut self) {
            if let Some(quota) = &self.0 {
                quota.transport(false);
            }
        }
    }
    let _quota_guard = QuotaGuard(quota.clone());
    let quota_open = quota.clone();
    let tx_open = tx.clone();
    let fail_open = overflow.clone();
    let close_open = source.clone();
    let watchdog_open = watchdog.clone();
    let on_open: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
        watchdog_open.activity();
        if tx_open.try_send(Frame::Open).is_err() {
            fail_open.set(true);
            close_open.close();
            if let Some(quota) = &quota_open {
                quota.transport(false);
            }
        } else if let Some(quota) = &quota_open {
            quota.transport(true);
        }
    });
    let session_delete = state.session_delete_observer(b);
    let message = |kind: &'static str| -> Closure<dyn FnMut(MessageEvent)> {
        let tx = tx.clone();
        let overflow = overflow.clone();
        let queued_bytes = queued_bytes.clone();
        let source = source.clone();
        let quota = quota.clone();
        let session_delete = session_delete.clone();
        let watchdog = watchdog.clone();
        Closure::new(move |event: MessageEvent| {
            watchdog.activity();
            let data = event.data().as_string().unwrap_or_default();
            let frame = if data.len() <= FRAME_LIMIT {
                if let Some(observer) = &session_delete {
                    observer.observe(kind, &data);
                }
                if kind == "message"
                    && let Some(quota) = &quota
                {
                    quota.frame(&data);
                }
                Frame::Data(kind.into(), data)
            } else {
                if let Some(quota) = &quota {
                    quota.skipped();
                }
                Frame::Skipped
            };
            let bytes = match &frame {
                Frame::Data(_, data) => data.len(),
                _ => 0,
            };
            let total = queued_bytes.get() + bytes;
            if total > BACKLOG_LIMIT || tx.try_send(frame).is_err() {
                overflow.set(true);
                source.close();
                if let Some(quota) = &quota {
                    quota.transport(false);
                }
            } else {
                queued_bytes.set(total);
            }
        })
    };
    let on_message = message("message");
    let ping = message("codenomad.client.ping");
    let tx_error = tx.clone();
    let fail_error = overflow.clone();
    let close_error = source.clone();
    let quota_error = quota.clone();
    let on_error: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
        if let Some(quota) = &quota_error {
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
    _source
        .source
        .add_event_listener_with_callback(
            "codenomad.client.ping",
            _source.ping.as_ref().unchecked_ref(),
        )
        .map_err(|_| "browser ping listener unavailable")?;
    enum Next<T> {
        Ready(T),
        Stale,
    }
    loop {
        if state.cancelled.load(SeqCst) || out.is_closed() {
            return Ok(());
        }
        if overflow.get() {
            return Err("browser event queue budget reached".into());
        }
        // Activity is timestamped on EventSource arrival, so a pre-sleep buffered frame cannot
        // mask a stream that has already gone silent past the threshold.
        if watchdog.is_stale() {
            return Err("browser event stream stale".into());
        }
        let frame = match rx.try_recv() {
            Ok(frame) => Some(frame),
            Err(_) => {
                futures_lite::future::or(
                    async {
                        futures_lite::future::or(
                            futures_lite::future::or(
                                async {
                                    let _ = wake_rx.recv().await;
                                },
                                global_probe.wait(),
                            ),
                            runtime::sleep(Duration::from_millis(25)),
                        )
                        .await;
                        None
                    },
                    async { rx.recv().await.ok() },
                )
                .await
            }
        };
        // Re-check after awaiting rx so a frame queued before sleep cannot mask staleness.
        if watchdog.is_stale() {
            return Err("browser event stream stale".into());
        }
        match frame {
            Some(Frame::Open) => {
                let _pause = watchdog.pause();
                b.client.children().invalidate_all(b);
                opened(epoch, out, state).await?;
            }
            Some(Frame::Data(kind, data)) if kind == "codenomad.client.ping" => {
                queued_bytes.set(queued_bytes.get() - data.len());
                // Pong POST is an independent network wait: keep staleness active so a dead link cuts it.
                let pong_watchdog = watchdog.fork();
                match futures_lite::future::or(
                    async {
                        pong_watchdog
                            .wait_until_stale(&global_probe, Some(&wake_rx))
                            .await;
                        Next::Stale
                    },
                    async {
                        Next::Ready(dispatch(b, epoch, out, state, &connection, &kind, &data).await)
                    },
                )
                .await
                {
                    Next::Ready(result) => {
                        result?;
                        watchdog.activity();
                    }
                    Next::Stale => return Err("browser event stream stale".into()),
                }
            }
            Some(Frame::Data(kind, data)) => {
                let _pause = watchdog.pause();
                queued_bytes.set(queued_bytes.get() - data.len());
                dispatch(b, epoch, out, state, &connection, &kind, &data).await?
            }
            Some(Frame::Skipped) => {
                let _pause = watchdog.pause();
                b.client.children().invalidate_all(b);
                reread(epoch, out, state).await?;
            }
            Some(Frame::Closed) => return Err("browser event stream ended".into()),
            None => {}
        }
    }
}
