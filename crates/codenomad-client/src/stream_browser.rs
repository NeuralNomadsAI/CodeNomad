//! Browser-owned EventSource. Recovery owns reconnect epochs and backoff.
use super::{
    Backend,
    hub::{Hub, SharedStream},
    limits::FRAME_LIMIT,
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
use web_sys::{Event, EventSource, EventSourceInit, MessageEvent};

const BACKLOG_LIMIT: usize = 2 * FRAME_LIMIT;

enum Frame {
    Open,
    Data(String, String),
    Ping,
    Skipped,
    Closed,
}

struct Source {
    source: EventSource,
    _open: Closure<dyn FnMut(Event)>,
    _message: Closure<dyn FnMut(MessageEvent)>,
    ping: Closure<dyn FnMut(MessageEvent)>,
    _error: Closure<dyn FnMut(Event)>,
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
    enum Step {
        Event(std::result::Result<Frame, async_channel::RecvError>),
        Stopped,
        AuthExpired,
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
        let overflow = Rc::new(Cell::new(false));
        let queued_bytes = Rc::new(Cell::new(0usize));

        let tx_open = tx.clone();
        let fail_open = overflow.clone();
        let close_open = source.clone();
        let on_open: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
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
        let on_message: Closure<dyn FnMut(MessageEvent)> =
            Closure::new(move |event: MessageEvent| {
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
        let ping: Closure<dyn FnMut(MessageEvent)> = Closure::new(move |_: MessageEvent| {
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
        let (pong_auth_tx, pong_auth_rx) = crate::bounded::<()>(1);
        loop {
            if overflow.get() {
                break;
            }
            if pong_auth_rx.try_recv().is_ok() {
                auth_expired = true;
                break;
            }
            let step = futures_lite::future::race(
                async { Step::Event(rx.recv().await) },
                futures_lite::future::race(
                    async {
                        let _ = stop_rx.recv().await;
                        Step::Stopped
                    },
                    async {
                        if pong_auth_rx.recv().await.is_ok() {
                            Step::AuthExpired
                        } else {
                            std::future::pending().await
                        }
                    },
                ),
            )
            .await;
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
                    spawn_pong(&b, &connection, &pong_in_flight, &pong_auth_tx);
                }
                Step::Event(Ok(Frame::Skipped)) => {
                    b.client.children().invalidate_all(&b);
                    shared.broadcast_skipped();
                }
                Step::Event(Ok(Frame::Closed)) | Step::Event(Err(_)) | Step::Stopped => break,
                Step::AuthExpired => {
                    auth_expired = true;
                    break;
                }
            }
        }
    }
    shared.finish(&hub, auth_expired);
}
