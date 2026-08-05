use parking_lot::Mutex;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Listener, Manager, Url};

mod assembler;
mod stream;
mod transport;

use stream::*;
use transport::*;

const EVENT_BATCH_NAME: &str = "desktop:event-batch";
const EVENT_STATUS_NAME: &str = "desktop:event-stream-status";
const EVENT_REPLAY_RESET_NAME: &str = "desktop:event-replay-reset";
const EVENT_ACK_NAME: &str = "desktop:event-ack";
const FLUSH_INTERVAL_MS: u64 = 16;
const DELTA_STREAM_WINDOW_MS: u64 = 48;
const MAX_BATCH_EVENTS: usize = 256;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS: u64 = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS: u64 = 10_000;
const DEFAULT_RECONNECT_MULTIPLIER: f64 = 2.0;
const STREAM_CONNECT_TIMEOUT_MS: u64 = 5_000;
const STREAM_TCP_KEEPALIVE_MS: u64 = 30_000;
const STREAM_STALL_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Debug)]
pub struct DesktopEventStreamConfig {
    pub base_url: String,
    pub events_url: String,
    pub client_id: String,
    pub connection_id: String,
    pub cookie_name: String,
    pub session_cookie: Option<String>,
    pub(crate) authority_generation: u64,
    pub(crate) authority: Arc<AtomicU64>,
}

impl DesktopEventStreamConfig {
    pub(crate) fn is_authorized(&self) -> bool {
        self.authority.load(Ordering::SeqCst) == self.authority_generation
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopEventsStartRequest {
    pub reconnect: Option<DesktopEventReconnectPolicy>,
    pub last_event_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopEventReconnectPolicy {
    pub initial_delay_ms: Option<u64>,
    pub max_delay_ms: Option<u64>,
    pub multiplier: Option<f64>,
    pub max_attempts: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEventsStartResult {
    pub started: bool,
    pub generation: Option<u64>,
    pub lease_id: Option<u64>,
    pub last_event_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEventAckPayload {
    generation: u64,
    last_event_id: String,
}

#[derive(Clone, Debug, PartialEq)]
struct ResolvedDesktopEventReconnectPolicy {
    initial_delay_ms: u64,
    max_delay_ms: u64,
    multiplier: f64,
    max_attempts: Option<u32>,
}

impl ResolvedDesktopEventReconnectPolicy {
    fn resolve(policy: Option<&DesktopEventReconnectPolicy>) -> Self {
        let initial_delay_ms = policy
            .and_then(|value| value.initial_delay_ms)
            .unwrap_or(DEFAULT_RECONNECT_INITIAL_DELAY_MS)
            .max(1);
        let max_delay_ms = policy
            .and_then(|value| value.max_delay_ms)
            .unwrap_or(DEFAULT_RECONNECT_MAX_DELAY_MS)
            .max(initial_delay_ms);
        let multiplier = policy
            .and_then(|value| value.multiplier)
            .filter(|value| value.is_finite() && *value >= 1.0)
            .unwrap_or(DEFAULT_RECONNECT_MULTIPLIER);
        let max_attempts = policy
            .and_then(|value| value.max_attempts)
            .filter(|value| *value > 0);

        Self {
            initial_delay_ms,
            max_delay_ms,
            multiplier,
            max_attempts,
        }
    }
}

#[derive(Clone, Debug)]
struct DesktopEventTransportConfig {
    stream: DesktopEventStreamConfig,
    reconnect: ResolvedDesktopEventReconnectPolicy,
}

impl DesktopEventTransportConfig {
    fn new(stream: DesktopEventStreamConfig, request: &DesktopEventsStartRequest) -> Self {
        Self {
            stream,
            reconnect: ResolvedDesktopEventReconnectPolicy::resolve(request.reconnect.as_ref()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEventBatchPayload {
    generation: u64,
    sequence: u64,
    emitted_at: u128,
    events: Vec<Value>,
    last_event_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEventReplayResetPayload {
    generation: u64,
    details: Value,
    last_event_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEventStreamStatusPayload {
    generation: u64,
    state: &'static str,
    reconnect_attempt: u32,
    terminal: bool,
    reason: Option<String>,
    next_delay_ms: Option<u64>,
    status_code: Option<u16>,
    stats: DesktopEventTransportStats,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopEventTransportStats {
    raw_events: u64,
    emitted_events: u64,
    emitted_batches: u64,
    delta_coalesces: u64,
    snapshot_coalesces: u64,
    status_coalesces: u64,
    superseded_deltas_dropped: u64,
}

struct DesktopEventTransportState {
    stop: Option<Arc<AtomicBool>>,
    config: Option<DesktopEventTransportConfig>,
}

pub struct DesktopEventTransportManager {
    state: Arc<Mutex<DesktopEventTransportState>>,
    generation: Arc<AtomicU64>,
    operation_fence: Arc<Mutex<()>>,
    lease: AtomicU64,
    last_event_id: Arc<Mutex<Option<String>>>,
}

enum ReaderMessage {
    Activity,
    Cursor(String),
    Event { event: Value, id: Option<String> },
    Ping(Value),
    ReplayReset { details: Value, id: Option<String> },
    End(Option<String>),
}

enum PendingEntry {
    Delta {
        key: String,
        scope: String,
        event: Value,
        started_at: Instant,
    },
    Status {
        key: String,
        event: Value,
    },
    Snapshot {
        key: String,
        event: Value,
    },
    Event(Value),
}

enum EventDeliveryPolicy {
    CoalesceDelta(String),
    CoalesceStatus(String),
    CoalesceSnapshot(String),
    Passthrough,
}

enum OpenStreamErrorKind {
    Unauthorized,
    Http,
    Transport,
}

struct OpenStreamError {
    kind: OpenStreamErrorKind,
    message: String,
    status_code: Option<u16>,
}

#[derive(Default)]
struct PendingBatch {
    events: Vec<PendingEntry>,
    last_event_id: Option<String>,
}

impl DesktopEventTransportManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(DesktopEventTransportState {
                stop: None,
                config: None,
            })),
            generation: Arc::new(AtomicU64::new(0)),
            operation_fence: Arc::new(Mutex::new(())),
            lease: AtomicU64::new(0),
            last_event_id: Arc::new(Mutex::new(None)),
        }
    }

    pub fn start(
        &self,
        app: AppHandle,
        stream_config: Option<DesktopEventStreamConfig>,
        request: Option<DesktopEventsStartRequest>,
    ) -> DesktopEventsStartResult {
        let Some(stream_config) = stream_config else {
            return DesktopEventsStartResult {
                started: false,
                generation: None,
                lease_id: None,
                last_event_id: None,
                reason: Some("desktop event stream unavailable".to_string()),
            };
        };

        let request = request.unwrap_or_default();
        let transport_config = DesktopEventTransportConfig::new(stream_config, &request);

        let mut state = self.state.lock();
        let operation_fence = self.operation_fence.lock();
        if !transport_config.stream.is_authorized() {
            return DesktopEventsStartResult {
                started: false,
                generation: None,
                lease_id: None,
                last_event_id: None,
                reason: Some("desktop event stream endpoint revoked".to_string()),
            };
        }
        let lease_id = self.lease.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(stop) = state.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
        let endpoint_changed = state.config.as_ref().is_some_and(|current| {
            current.stream.events_url != transport_config.stream.events_url
                || current.stream.client_id != transport_config.stream.client_id
        });
        if endpoint_changed {
            *self.last_event_id.lock() = None;
        } else if request.last_event_id.is_some() {
            *self.last_event_id.lock() = request.last_event_id.clone();
        }
        let accepted_event_id = self.last_event_id.lock().clone();

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        state.stop = Some(stop.clone());
        state.config = Some(transport_config.clone());
        let shared_generation = self.generation.clone();
        let shared_operation_fence = self.operation_fence.clone();
        let last_event_id = self.last_event_id.clone();

        let ack_generation = shared_generation.clone();
        let acknowledged_event_id = last_event_id.clone();
        let ack_listener = app.listen(EVENT_ACK_NAME, move |event| {
            if !generation_matches(&ack_generation, generation) {
                return;
            }
            let Ok(ack) = serde_json::from_str::<DesktopEventAckPayload>(event.payload()) else {
                return;
            };
            if ack.generation == generation && !ack.last_event_id.is_empty() {
                *acknowledged_event_id.lock() = Some(ack.last_event_id);
            }
        });

        thread::spawn(move || {
            let listener_app = app.clone();
            run_transport_loop(
                app,
                shared_generation,
                generation,
                stop,
                shared_operation_fence,
                transport_config,
                last_event_id,
            );
            listener_app.unlisten(ack_listener);
        });
        drop(operation_fence);
        drop(state);

        DesktopEventsStartResult {
            started: true,
            generation: Some(generation),
            lease_id: Some(lease_id),
            last_event_id: accepted_event_id,
            reason: None,
        }
    }

    pub fn stop(&self) {
        let mut state = self.state.lock();
        self.lease.fetch_add(1, Ordering::SeqCst);
        self.stop_locked(&mut state);
    }

    pub fn revoke_endpoint(&self) {
        let mut state = self.state.lock();
        self.lease.fetch_add(1, Ordering::SeqCst);
        self.stop_locked(&mut state);
        *self.last_event_id.lock() = None;
    }

    pub fn stop_lease(&self, lease_id: u64) {
        let mut state = self.state.lock();
        if self.lease.load(Ordering::SeqCst) != lease_id {
            return;
        }
        self.stop_locked(&mut state);
    }

    fn stop_locked(&self, state: &mut DesktopEventTransportState) {
        if let Some(stop) = state.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
        state.config = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _operation = self.operation_fence.lock();
    }
}

fn classify_event(event: &Value) -> EventDeliveryPolicy {
    if let Some(key) = delta_key(event) {
        return EventDeliveryPolicy::CoalesceDelta(key);
    }

    if let Some(key) = status_key(event) {
        return EventDeliveryPolicy::CoalesceStatus(key);
    }

    if let Some(key) = snapshot_key(event) {
        return EventDeliveryPolicy::CoalesceSnapshot(key);
    }

    EventDeliveryPolicy::Passthrough
}

fn coalesced_payload_event<'a>(event: &'a Value) -> &'a Value {
    if event.get("type").and_then(Value::as_str) == Some("instance.event") {
        event.get("event").unwrap_or(event)
    } else {
        event
    }
}

fn coalesced_instance_id(event: &Value) -> &str {
    event
        .get("instanceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn snapshot_key(event: &Value) -> Option<String> {
    let instance_id = coalesced_instance_id(event);
    let inner = coalesced_payload_event(event);
    let inner_type = inner.get("type")?.as_str()?;
    let props = inner.get("properties")?;

    match inner_type {
        "message.part.updated" => {
            let session_id = props
                .get("part")
                .and_then(|part| part.get("sessionID").or_else(|| part.get("sessionId")))
                .and_then(Value::as_str)?;
            let message_id = props
                .get("part")
                .and_then(|part| part.get("messageID").or_else(|| part.get("messageId")))
                .and_then(Value::as_str)?;
            let part_id = props
                .get("part")
                .and_then(|part| part.get("id"))
                .and_then(Value::as_str)?;

            Some(format!(
                "message.part.updated:{}:{}:{}:{}",
                instance_id, session_id, message_id, part_id
            ))
        }
        "message.updated" => {
            let info = props.get("info")?;
            let session_id = info
                .get("sessionID")
                .or_else(|| info.get("sessionId"))
                .and_then(Value::as_str)?;
            let message_id = info.get("id").and_then(Value::as_str)?;

            Some(format!(
                "message.updated:{}:{}:{}",
                instance_id, session_id, message_id
            ))
        }
        "session.updated" | "session.status" => {
            let session_id = props
                .get("info")
                .and_then(|info| info.get("id"))
                .and_then(Value::as_str)
                .or_else(|| {
                    props
                        .get("sessionID")
                        .or_else(|| props.get("sessionId"))
                        .and_then(Value::as_str)
                })?;

            Some(format!("{}:{}:{}", inner_type, instance_id, session_id))
        }
        _ => None,
    }
}

fn delta_scope(event: &Value) -> Option<String> {
    let instance_id = coalesced_instance_id(event);
    let inner = coalesced_payload_event(event);
    if inner.get("type")?.as_str()? != "message.part.delta" {
        return None;
    }

    let props = inner.get("properties")?;
    let session_id = props
        .get("sessionID")
        .or_else(|| props.get("sessionId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message_id = props
        .get("messageID")
        .or_else(|| props.get("messageId"))
        .and_then(Value::as_str)?;
    let part_id = props
        .get("partID")
        .or_else(|| props.get("partId"))
        .and_then(Value::as_str)?;

    Some(format!(
        "message.part:{}:{}:{}:{}",
        instance_id, session_id, message_id, part_id
    ))
}

fn delta_key(event: &Value) -> Option<String> {
    let scope = delta_scope(event)?;
    let props = coalesced_payload_event(event).get("properties")?;
    let field = props.get("field")?.as_str()?;

    Some(format!("{}:{}", scope, field))
}

fn snapshot_superseded_delta_scope(event: &Value) -> Option<String> {
    let instance_id = coalesced_instance_id(event);
    let inner = coalesced_payload_event(event);
    if inner.get("type")?.as_str()? != "message.part.updated" {
        return None;
    }

    let part = inner.get("properties")?.get("part")?;
    let session_id = part
        .get("sessionID")
        .or_else(|| part.get("sessionId"))
        .and_then(Value::as_str)?;
    let message_id = part
        .get("messageID")
        .or_else(|| part.get("messageId"))
        .and_then(Value::as_str)?;
    let part_id = part.get("id")?.as_str()?;

    Some(format!(
        "message.part:{}:{}:{}:{}",
        instance_id, session_id, message_id, part_id
    ))
}

fn append_delta(target: &mut Value, event: &Value) {
    let next_delta = coalesced_payload_event(event)
        .get("properties")
        .and_then(|value| value.get("delta"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    if let Some(existing_delta) = coalesced_payload_event_mut(target)
        .and_then(|event| event.get_mut("properties"))
        .and_then(Value::as_object_mut)
        .and_then(|props| props.get_mut("delta"))
    {
        let combined = existing_delta.as_str().unwrap_or_default().to_string() + next_delta;
        *existing_delta = Value::String(combined);
    }
}

fn coalesced_payload_event_mut(event: &mut Value) -> Option<&mut serde_json::Map<String, Value>> {
    if event.get("type").and_then(Value::as_str) == Some("instance.event") {
        event.get_mut("event").and_then(Value::as_object_mut)
    } else {
        event.as_object_mut()
    }
}

fn status_key(event: &Value) -> Option<String> {
    match event.get("type")?.as_str()? {
        "instance.eventStatus" => Some(coalesced_instance_id(event).to_string()),
        "session.status" => snapshot_key(event),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
