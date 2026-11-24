//! Browser-owned EventSource. Recovery owns reconnect epochs and backoff.
use super::limits::{FRAME_LIMIT, reread};
use super::*;
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::{JsCast, closure::Closure};
use web_sys::{Event, EventSource, EventSourceInit, MessageEvent};

const BACKLOG_LIMIT: usize = 2 * FRAME_LIMIT;

enum Frame {
    Open,
    Data(String, String),
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
    let overflow = Rc::new(Cell::new(false));
    let queued_bytes = Rc::new(Cell::new(0usize));
    let quota = state.quota_ingress(b);
    let quota_open = quota.clone();
    let tx_open = tx.clone();
    let fail_open = overflow.clone();
    let close_open = source.clone();
    let on_open: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
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
    let message = |kind: &'static str| -> Closure<dyn FnMut(MessageEvent)> {
        let tx = tx.clone();
        let overflow = overflow.clone();
        let queued_bytes = queued_bytes.clone();
        let source = source.clone();
        let quota = quota.clone();
        Closure::new(move |event: MessageEvent| {
            let data = event.data().as_string().unwrap_or_default();
            let frame = if data.len() <= FRAME_LIMIT {
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
    let on_error: Closure<dyn FnMut(Event)> = Closure::new(move |_: Event| {
        if let Some(quota) = &quota {
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
    _source
        .source
        .add_event_listener_with_callback(
            "codenomad.client.ping",
            _source.ping.as_ref().unchecked_ref(),
        )
        .map_err(|_| "browser ping listener unavailable")?;
    loop {
        if state.cancelled.load(SeqCst) || out.is_closed() {
            return Ok(());
        }
        if overflow.get() {
            return Err("browser event queue budget reached".into());
        }
        match runtime::recv_timeout(&rx, Duration::from_millis(25)).await {
            Some(Frame::Open) => {
                b.client.children().invalidate(b, None);
                opened(epoch, out, state).await?;
            }
            Some(Frame::Data(kind, data)) => {
                queued_bytes.set(queued_bytes.get() - data.len());
                dispatch(b, epoch, out, state, &connection, &kind, &data).await?
            }
            Some(Frame::Skipped) => {
                b.client.children().invalidate(b, None);
                reread(epoch, out, state).await?;
            }
            Some(Frame::Closed) => return Err("browser event stream ended".into()),
            None => {}
        }
    }
}
