use parking_lot::Mutex;
use reqwest::StatusCode;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Url};

mod assembler;
mod stream;
mod transport;

use stream::*;
use transport::*;

const EVENT_BATCH_NAME: &str = "desktop:event-batch";
const EVENT_STATUS_NAME: &str = "desktop:event-stream-status";
const FLUSH_INTERVAL_MS: u64 = 16;
const DELTA_STREAM_WINDOW_MS: u64 = 48;
const MAX_BATCH_EVENTS: usize = 256;
const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS: u64 = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS: u64 = 10_000;
const DEFAULT_RECONNECT_MULTIPLIER: f64 = 2.0;
const STREAM_CONNECT_TIMEOUT_MS: u64 = 5_000;
const STREAM_TCP_KEEPALIVE_MS: u64 = 30_000;
const STREAM_READ_TIMEOUT_MS: u64 = 30_000;
const STREAM_STALL_TIMEOUT_MS: u64 = 35_000;
const SSE_READ_BUFFER_BYTES: usize = 8 * 1024;
const SERVER_MAX_EVENT_CHARACTERS: usize = 16 * 1024 * 1024;
const MAX_UTF8_BYTES_PER_CHARACTER: usize = 4;
const MAX_WORKSPACE_EVENT_ENVELOPE_BYTES: usize = 64 * 1024;
const MAX_SSE_LINE_BYTES: usize =
    SERVER_MAX_EVENT_CHARACTERS * MAX_UTF8_BYTES_PER_CHARACTER + MAX_WORKSPACE_EVENT_ENVELOPE_BYTES;
const MAX_SSE_FRAME_BYTES: usize = MAX_SSE_LINE_BYTES + MAX_WORKSPACE_EVENT_ENVELOPE_BYTES;
const MAX_COALESCED_DELTA_BYTES: usize = 1024 * 1024;
const READER_CHANNEL_CAPACITY: usize = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopEventStreamConfig {
    pub base_url: String,
    pub events_url: String,
    pub client_id: String,
    pub connection_id: String,
    pub cookie_name: String,
    pub session_cookie: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopEventsStartRequest {
    pub reconnect: Option<DesktopEventReconnectPolicy>,
    pub logical_start_epoch: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEventsStartReservation {
    pub logical_start_epoch: u64,
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
    pub lease: Option<u64>,
    pub reason: Option<String>,
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

#[derive(Clone, Debug, PartialEq)]
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

    fn is_equivalent_start(&self, other: &Self) -> bool {
        self.reconnect == other.reconnect
            && self.stream.base_url == other.stream.base_url
            && self.stream.events_url == other.stream.events_url
            && self.stream.client_id == other.stream.client_id
            && self.stream.cookie_name == other.stream.cookie_name
            && self.stream.session_cookie == other.stream.session_cookie
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEventBatchPayload {
    generation: u64,
    sequence: u64,
    emitted_at: u128,
    events: Vec<Value>,
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
    lease: Option<u64>,
    latest_reserved_start_epoch: u64,
}

pub struct DesktopEventTransportManager {
    state: Arc<Mutex<DesktopEventTransportState>>,
    generation: Arc<AtomicU64>,
    lease: AtomicU64,
}

enum ReaderMessage {
    Activity,
    Event(Value),
    Ping(Value),
    End(Option<String>),
}

enum PendingEntry {
    Delta {
        key: String,
        scope: String,
        event: Value,
        serialized_bytes: usize,
        delta_bytes: usize,
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

#[derive(Debug)]
enum OpenStreamErrorKind {
    Unauthorized,
    Http,
    Transport,
}

#[derive(Debug)]
struct OpenStreamError {
    kind: OpenStreamErrorKind,
    message: String,
    status_code: Option<u16>,
}

#[derive(Default)]
struct PendingBatch {
    events: Vec<PendingEntry>,
    estimated_bytes: usize,
}

impl DesktopEventTransportManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(DesktopEventTransportState {
                stop: None,
                config: None,
                lease: None,
                latest_reserved_start_epoch: 0,
            })),
            generation: Arc::new(AtomicU64::new(0)),
            lease: AtomicU64::new(0),
        }
    }

    pub fn reserve_start(&self) -> Result<DesktopEventsStartReservation, String> {
        let mut state = self.state.lock();
        let logical_start_epoch = state
            .latest_reserved_start_epoch
            .checked_add(1)
            .ok_or_else(|| "desktop event start epoch exhausted".to_string())?;
        state.latest_reserved_start_epoch = logical_start_epoch;
        Ok(DesktopEventsStartReservation {
            logical_start_epoch,
        })
    }

    pub fn start(
        &self,
        app: AppHandle,
        stream_config: Option<DesktopEventStreamConfig>,
        request: DesktopEventsStartRequest,
    ) -> DesktopEventsStartResult {
        let Some(stream_config) = stream_config else {
            return DesktopEventsStartResult {
                started: false,
                generation: None,
                lease: None,
                reason: Some("desktop event stream unavailable".to_string()),
            };
        };

        let transport_config = DesktopEventTransportConfig::new(stream_config, &request);

        let mut state = self.state.lock();
        let Some(lease) = self.claim_start_lease(&mut state, request.logical_start_epoch) else {
            return DesktopEventsStartResult {
                started: false,
                generation: None,
                lease: None,
                reason: Some("stale logical desktop event start".to_string()),
            };
        };
        if state
            .config
            .as_ref()
            .is_some_and(|config| config.is_equivalent_start(&transport_config))
        {
            if let Some(stop) = &state.stop {
                if !stop.load(Ordering::SeqCst) {
                    return DesktopEventsStartResult {
                        started: true,
                        generation: Some(self.generation.load(Ordering::SeqCst)),
                        lease: Some(lease),
                        reason: None,
                    };
                }
            }
        }

        if let Some(stop) = state.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        state.stop = Some(stop.clone());
        state.config = Some(transport_config.clone());
        let shared_generation = self.generation.clone();
        drop(state);

        thread::spawn(move || {
            run_transport_loop(app, shared_generation, generation, stop, transport_config)
        });

        DesktopEventsStartResult {
            started: true,
            generation: Some(generation),
            lease: Some(lease),
            reason: None,
        }
    }

    fn claim_start_lease(
        &self,
        state: &mut DesktopEventTransportState,
        logical_start_epoch: u64,
    ) -> Option<u64> {
        if logical_start_epoch != state.latest_reserved_start_epoch {
            return None;
        }

        let lease = self.lease.fetch_add(1, Ordering::SeqCst) + 1;
        state.lease = Some(lease);
        Some(lease)
    }

    pub fn stop(&self) {
        self.stop_current(None);
    }

    pub fn stop_lease(&self, lease: u64) -> bool {
        self.stop_current(Some(lease))
    }

    fn stop_current(&self, expected_lease: Option<u64>) -> bool {
        let mut state = self.state.lock();
        if expected_lease.is_some_and(|lease| state.lease != Some(lease)) {
            return false;
        }
        if let Some(stop) = state.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
        state.config = None;
        state.lease = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
        true
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

fn coalesced_instance_id(event: &Value) -> String {
    let instance_id = event
        .get("instanceId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let stream_id = event
        .get("streamId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!("{}@{}", instance_id, stream_id)
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
        "session.updated" => {
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

fn delta_payload(event: &Value) -> &str {
    coalesced_payload_event(event)
        .get("properties")
        .and_then(|value| value.get("delta"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn append_delta(target: &mut Value, next_delta: &str, delta_bytes: &mut usize) -> bool {
    let Some(combined_len) = delta_bytes.checked_add(next_delta.len()) else {
        return false;
    };
    if combined_len > MAX_COALESCED_DELTA_BYTES {
        return false;
    }

    let Some(Value::String(existing_delta)) = coalesced_payload_event_mut(target)
        .and_then(|event| event.get_mut("properties"))
        .and_then(Value::as_object_mut)
        .and_then(|props| props.get_mut("delta"))
    else {
        return false;
    };

    existing_delta.push_str(next_delta);
    *delta_bytes = combined_len;
    true
}

fn serialized_json_bytes<T: Serialize + ?Sized>(value: &T) -> usize {
    struct Counter(usize);

    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).map_or(usize::MAX, |_| counter.0)
}

fn serialized_value_bytes(value: &Value) -> usize {
    serialized_json_bytes(value)
}

fn serialized_string_content_bytes(value: &str) -> usize {
    serialized_json_bytes(value).saturating_sub(2)
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
        "instance.eventStatus" => Some(format!(
            "{}:{}",
            coalesced_instance_id(event),
            event
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
