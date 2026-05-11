use parking_lot::Mutex;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
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
const ACTIVE_STREAM_DISPLAY_WINDOW_MS: u64 = 16;
const ACTIVE_STREAM_DISPLAY_CHUNK_MAX: usize = 96;
const ACTIVE_STREAM_STORE_WINDOW_MS: u64 = 250;
const ACTIVE_STREAM_SNAPSHOT_WINDOW_MS: u64 = 200;
const ACTIVE_STREAM_HOLD_WINDOW_MS: u64 = 12;
const ACTIVE_SESSION_MAX_BATCH_EVENTS: usize = 64;
const MAX_BATCH_EVENTS: usize = 256;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS: u64 = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS: u64 = 10_000;
const DEFAULT_RECONNECT_MULTIPLIER: f64 = 2.0;
const STREAM_CONNECT_TIMEOUT_MS: u64 = 5_000;
const STREAM_TCP_KEEPALIVE_MS: u64 = 30_000;
const STREAM_STALL_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopEventStreamConfig {
    pub base_url: String,
    pub events_url: String,
    pub client_id: String,
    pub cookie_name: String,
    pub session_cookie: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopEventsStartRequest {
    pub reconnect: Option<DesktopEventReconnectPolicy>,
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
    active_target: Option<ActiveSessionTarget>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ActiveSessionTarget {
    pub instance_id: String,
    pub session_id: String,
}

pub struct DesktopEventTransportManager {
    state: Arc<Mutex<DesktopEventTransportState>>,
    generation: Arc<AtomicU64>,
}

enum ReaderMessage {
    Activity,
    Event(Value),
    End(Option<String>),
}

enum PendingEntry {
    Delta {
        key: String,
        scope: String,
        instance_id: String,
        session_id: Option<String>,
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
}

#[derive(Clone)]
struct ActiveTextDelta {
    instance_id: String,
    session_id: String,
    message_id: String,
    part_id: String,
    delta: String,
}

struct ActiveTextPartBuffer {
    instance_id: String,
    session_id: String,
    message_id: String,
    part_id: String,
    display_pending: String,
    store_pending: String,
    last_display_emit: Instant,
    last_store_emit: Instant,
}

impl ActiveTextPartBuffer {
    fn new(delta: ActiveTextDelta, now: Instant) -> Self {
        Self {
            instance_id: delta.instance_id,
            session_id: delta.session_id,
            message_id: delta.message_id,
            part_id: delta.part_id,
            display_pending: delta.delta.clone(),
            store_pending: delta.delta,
            last_display_emit: now,
            last_store_emit: now,
        }
    }
}

#[derive(Clone)]
struct ActiveTextSnapshot {
    key: String,
    instance_id: String,
    session_id: String,
    message_id: String,
    part_id: String,
    event: Value,
}

struct BufferedTextSnapshot {
    instance_id: String,
    session_id: String,
    message_id: String,
    part_id: String,
    event: Value,
    buffered_at: Instant,
}

#[derive(Default)]
struct ActiveTextAssembler {
    parts: HashMap<String, ActiveTextPartBuffer>,
}

#[derive(Default)]
struct ActiveTextSnapshotBuffer {
    parts: HashMap<String, BufferedTextSnapshot>,
}

impl DesktopEventTransportManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(DesktopEventTransportState {
                stop: None,
                config: None,
                active_target: None,
            })),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_active_session_target(&self, target: Option<ActiveSessionTarget>) {
        let mut state = self.state.lock();
        state.active_target = target;
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
                reason: Some("desktop event stream unavailable".to_string()),
            };
        };

        let request = request.unwrap_or_default();
        let transport_config = DesktopEventTransportConfig::new(stream_config, &request);

        let mut state = self.state.lock();
        if state.config.as_ref() == Some(&transport_config) {
            if let Some(stop) = &state.stop {
                if !stop.load(Ordering::SeqCst) {
                    return DesktopEventsStartResult {
                        started: true,
                        generation: Some(self.generation.load(Ordering::SeqCst)),
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
        let shared_state = self.state.clone();
        let shared_generation = self.generation.clone();
        drop(state);

        thread::spawn(move || {
            run_transport_loop(
                app,
                shared_state,
                shared_generation,
                generation,
                stop,
                transport_config,
            )
        });

        DesktopEventsStartResult {
            started: true,
            generation: Some(generation),
            reason: None,
        }
    }

    pub fn stop(&self) {
        let mut state = self.state.lock();
        if let Some(stop) = state.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
        state.config = None;
        state.active_target = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
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

fn event_session_id(event: &Value) -> Option<&str> {
    let inner = coalesced_payload_event(event);
    let inner_type = inner.get("type")?.as_str()?;
    let props = inner.get("properties")?;

    match inner_type {
        "session.updated" => props
            .get("info")
            .and_then(|info| info.get("id"))
            .and_then(Value::as_str)
            .or_else(|| {
                props
                    .get("sessionID")
                    .or_else(|| props.get("sessionId"))
                    .and_then(Value::as_str)
            }),
        "message.updated" => props
            .get("info")
            .and_then(|info| info.get("sessionID").or_else(|| info.get("sessionId")))
            .and_then(Value::as_str),
        "message.part.updated" => props
            .get("part")
            .and_then(|part| part.get("sessionID").or_else(|| part.get("sessionId")))
            .and_then(Value::as_str),
        "message.part.delta"
        | "message.removed"
        | "message.part.removed"
        | "session.compacted"
        | "session.diff"
        | "session.idle"
        | "session.status" => props
            .get("sessionID")
            .or_else(|| props.get("sessionId"))
            .and_then(Value::as_str),
        _ => None,
    }
}

fn parse_active_text_delta(
    event: &Value,
    active_target: Option<&ActiveSessionTarget>,
) -> Option<ActiveTextDelta> {
    let active_target = active_target?;
    let instance_id = coalesced_instance_id(event);
    if instance_id != active_target.instance_id {
        return None;
    }
    let inner = coalesced_payload_event(event);
    if inner.get("type")?.as_str()? != "message.part.delta" {
        return None;
    }

    let props = inner.get("properties")?;
    let field = props.get("field")?.as_str()?;
    if field != "text" {
        return None;
    }

    let event_session = props
        .get("sessionID")
        .or_else(|| props.get("sessionId"))
        .and_then(Value::as_str)?;
    if event_session != active_target.session_id {
        return None;
    }

    Some(ActiveTextDelta {
        instance_id: instance_id.to_string(),
        session_id: event_session.to_string(),
        message_id: props
            .get("messageID")
            .or_else(|| props.get("messageId"))
            .and_then(Value::as_str)?
            .to_string(),
        part_id: props
            .get("partID")
            .or_else(|| props.get("partId"))
            .and_then(Value::as_str)?
            .to_string(),
        delta: props.get("delta")?.as_str()?.to_string(),
    })
}

fn make_assistant_stream_chunk_event(entry: &ActiveTextPartBuffer, delta: &str) -> Value {
    serde_json::json!({
        "type": "instance.event",
        "instanceId": entry.instance_id,
        "event": {
            "type": "assistant.stream.chunk",
            "properties": {
                "sessionID": entry.session_id,
                "messageID": entry.message_id,
                "partID": entry.part_id,
                "field": "text",
                "delta": delta,
            }
        }
    })
}

fn make_message_part_delta_event(entry: &ActiveTextPartBuffer, delta: &str) -> Value {
    serde_json::json!({
        "type": "instance.event",
        "instanceId": entry.instance_id,
        "event": {
            "type": "message.part.delta",
            "properties": {
                "sessionID": entry.session_id,
                "messageID": entry.message_id,
                "partID": entry.part_id,
                "field": "text",
                "delta": delta,
            }
        }
    })
}

fn parse_active_text_snapshot(
    event: &Value,
    active_target: Option<&ActiveSessionTarget>,
) -> Option<ActiveTextSnapshot> {
    let active_target = active_target?;
    let instance_id = coalesced_instance_id(event);
    if instance_id != active_target.instance_id {
        return None;
    }

    let inner = coalesced_payload_event(event);
    if inner.get("type")?.as_str()? != "message.part.updated" {
        return None;
    }

    let part = inner.get("properties")?.get("part")?;
    if part.get("type")?.as_str()? != "text" {
        return None;
    }
    if part.get("text")?.as_str().is_none() {
        return None;
    }

    let event_session = part
        .get("sessionID")
        .or_else(|| part.get("sessionId"))
        .and_then(Value::as_str)?;
    if event_session != active_target.session_id {
        return None;
    }

    let message_id = part
        .get("messageID")
        .or_else(|| part.get("messageId"))
        .and_then(Value::as_str)?;
    let part_id = part.get("id")?.as_str()?;

    Some(ActiveTextSnapshot {
        key: format!(
            "{}:{}:{}:{}",
            instance_id, event_session, message_id, part_id
        ),
        instance_id: instance_id.to_string(),
        session_id: event_session.to_string(),
        message_id: message_id.to_string(),
        part_id: part_id.to_string(),
        event: event.clone(),
    })
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
