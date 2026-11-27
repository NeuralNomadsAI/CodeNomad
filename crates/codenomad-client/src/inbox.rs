//! Session prompt queue (`session.inbox`) contract and mutation calls.
use crate::{
    Message,
    backend::{Backend, read_json_limited},
    content::{self, Part},
    history::{Result, valid_id},
    prompt::Delivery,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering::SeqCst},
    },
    time::Duration,
};

/// Result of checking a live authoritative inbox publication fence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FenceState {
    /// Wire ingress matches the captured revision and no received SSE chunk is mid-parse.
    Valid,
    /// A received native SSE chunk is still being classified; hold publication until wake.
    Deferred,
    /// Wire ingress moved past the captured revision or has unapplied events; reject snapshot.
    Invalid,
}

/// Captured inbox wire coordinates (`local_epoch`, `ingress`) for admission and UI fences.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct InboxStamp {
    pub(crate) local_epoch: u64,
    pub(crate) ingress: u64,
}

#[derive(Default)]
struct InboxWireInner {
    local_epoch: u64,
    ingress: u64,
    applied: u64,
    chunk_active: bool,
    publication_waiting: bool,
    wake: Option<crate::Wake>,
}

#[derive(Clone, Default)]
pub(crate) struct InboxWire {
    inner: Arc<Mutex<InboxWireInner>>,
}

impl std::fmt::Debug for InboxWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock().unwrap();
        f.debug_struct("InboxWire")
            .field("local_epoch", &inner.local_epoch)
            .field("ingress", &inner.ingress)
            .field("applied", &inner.applied)
            .field("chunk_active", &inner.chunk_active)
            .finish()
    }
}

impl InboxWire {
    pub(crate) fn with_wake(wake: crate::Wake) -> Self {
        Self {
            inner: Arc::new(Mutex::new(InboxWireInner {
                wake: Some(wake),
                ..InboxWireInner::default()
            })),
        }
    }

    fn bump_ingress(inner: &mut InboxWireInner) -> u64 {
        inner.ingress = inner.ingress.wrapping_add(1);
        if inner.ingress == 0 {
            inner.ingress = 1;
        }
        inner.ingress
    }

    #[cfg(test)]
    pub(crate) fn ingress(&self) -> u64 {
        self.inner.lock().unwrap().ingress
    }

    pub(crate) fn current_ingress(&self) -> u64 {
        self.inner.lock().unwrap().ingress
    }

    pub(crate) fn capture(&self) -> InboxStamp {
        let inner = self.inner.lock().unwrap();
        InboxStamp {
            local_epoch: inner.local_epoch,
            ingress: inner.ingress,
        }
    }

    pub(crate) fn record_ingress(&self) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        Self::bump_ingress(&mut inner)
    }

    pub(crate) fn advance_applied(&self, mark: u64) {
        if mark == 0 {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        if mark > inner.applied {
            inner.applied = mark;
        }
    }

    /// Invalidates already-published snapshots without advancing the SSE `applied` watermark past
    /// unapplied frames still queued at the hub or transport channel.
    pub(crate) fn invalidate_published(&self) {
        let wake = {
            let mut inner = self.inner.lock().unwrap();
            inner.local_epoch = inner.local_epoch.wrapping_add(1);
            std::mem::take(&mut inner.publication_waiting)
                .then(|| inner.wake.clone())
                .flatten()
        };
        if let Some(wake) = wake {
            wake();
        }
    }

    pub(crate) fn invalidate_closed(&self) {
        let wake = {
            let mut inner = self.inner.lock().unwrap();
            Self::bump_ingress(&mut inner);
            inner.chunk_active = false;
            std::mem::take(&mut inner.publication_waiting)
                .then(|| inner.wake.clone())
                .flatten()
        };
        if let Some(wake) = wake {
            wake();
        }
    }

    /// Holds snapshot publication while complete SSE frames in a received HTTP chunk are
    /// classified (matching `provider_usage::Ingress`); ends on chunk finish so continuous
    /// unrelated streams cannot starve unaffected conversations.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn begin_chunk(&self) {
        self.inner.lock().unwrap().chunk_active = true;
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn end_chunk_quiet(&self, clean: bool) -> Option<crate::Wake> {
        let mut inner = self.inner.lock().unwrap();
        if !clean {
            Self::bump_ingress(&mut inner);
        }
        inner.chunk_active = false;
        std::mem::take(&mut inner.publication_waiting)
            .then(|| inner.wake.clone())
            .flatten()
    }

    pub(crate) fn applied_caught_up(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.applied >= inner.ingress
    }

    pub(crate) fn is_admissible(&self, captured: InboxStamp) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.local_epoch == captured.local_epoch
            && inner.ingress == captured.ingress
            && inner.applied >= captured.ingress
    }

    pub(crate) fn check(&self, captured: InboxStamp) -> FenceState {
        let mut inner = self.inner.lock().unwrap();
        if inner.local_epoch != captured.local_epoch
            || inner.ingress != captured.ingress
            || inner.applied < captured.ingress
        {
            return FenceState::Invalid;
        }
        if inner.chunk_active {
            inner.publication_waiting = true;
            return FenceState::Deferred;
        }
        FenceState::Valid
    }

    pub(crate) fn fence(&self, captured: InboxStamp, sync_epoch: u64) -> InboxFence {
        InboxFence {
            backing: FenceBacking::Wire(self.clone()),
            captured,
            sync_epoch,
        }
    }
}

#[derive(Clone, Debug)]
enum FenceBacking {
    Wire(InboxWire),
    Atomic(Arc<AtomicU64>),
}

/// Live invalidation fence carried by authoritative [`crate::transport::Event::Inbox`] snapshots.
#[derive(Clone, Debug)]
pub struct InboxFence {
    backing: FenceBacking,
    captured: InboxStamp,
    sync_epoch: u64,
}

impl InboxFence {
    pub fn from_revision(current: Arc<AtomicU64>, captured: u64) -> Self {
        Self {
            backing: FenceBacking::Atomic(current),
            captured: InboxStamp {
                local_epoch: 0,
                ingress: captured,
            },
            sync_epoch: 0,
        }
    }

    pub fn with_sync_epoch(mut self, sync_epoch: u64) -> Self {
        self.sync_epoch = sync_epoch;
        self
    }

    pub fn sync_epoch(&self) -> u64 {
        self.sync_epoch
    }

    pub fn check(&self) -> FenceState {
        match &self.backing {
            FenceBacking::Wire(wire) => wire.check(self.captured),
            FenceBacking::Atomic(current) => {
                if current.load(SeqCst) == self.captured.ingress {
                    FenceState::Valid
                } else {
                    FenceState::Invalid
                }
            }
        }
    }

    pub fn is_valid(&self) -> bool {
        self.check() == FenceState::Valid
    }
}

/// Incremental non-authoritative inbox delta applied to existing UI rows without replacing the list.
#[derive(Clone, Debug, PartialEq)]
pub enum InboxDelta {
    Upsert(QueuedPrompt),
    Delivery { id: String, delivery: Delivery },
    Removed(String),
}

const DEADLINE: Duration = Duration::from_secs(15);
pub const MAX_ITEMS: usize = 256;
const MAX_TEXT_BYTES: usize = 256 * 1024;
/// Accommodates a legal 20 MiB base64 attachment bundle (~26.7 MiB) plus JSON envelope overhead.
const MAX_INBOX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct QueuedPrompt {
    pub id: String,
    pub delivery: Delivery,
    pub text: String,
    pub parts: Vec<Part>,
    pub created: Option<u64>,
    pub editable: bool,
}

impl QueuedPrompt {
    pub fn into_message(&self) -> Message {
        Message {
            id: self.id.clone(),
            role: "user".into(),
            completed: true,
            body: self.text.clone(),
            usage: None,
            parts: self.parts.clone(),
        }
    }
}

#[derive(Debug)]
pub struct InboxUnavailable;

impl std::fmt::Display for InboxUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("prompt queue actions are unavailable on this server")
    }
}

impl std::error::Error for InboxUnavailable {}

fn parse_delivery(value: &Value) -> Option<Delivery> {
    match value.as_str()? {
        "queue" => Some(Delivery::Queue),
        "steer" => Some(Delivery::Steer),
        _ => None,
    }
}

fn delivery_str(delivery: Delivery) -> &'static str {
    match delivery {
        Delivery::Queue => "queue",
        Delivery::Steer => "steer",
    }
}

fn payload_is_plain_text(payload: &Value, display_text: &str) -> bool {
    let Some(map) = payload.as_object() else {
        return false;
    };
    let Some(submitted_text) = map.get("text").and_then(Value::as_str) else {
        return false;
    };
    if submitted_text.trim().is_empty() || submitted_text != display_text {
        return false;
    }
    for (key, value) in map {
        match key.as_str() {
            "text" => {}
            "files" | "attachments" | "skills" | "agents" => {
                if !(value.is_null() || value.as_array().is_some_and(Vec::is_empty)) {
                    return false;
                }
            }
            "metadata" => match value {
                Value::Null => {}
                Value::Object(meta) => {
                    if !meta
                        .iter()
                        .all(|(k, v)| k == "displayText" && v.as_str() == Some(submitted_text))
                    {
                        return false;
                    }
                }
                _ => return false,
            },
            "resume" => {
                if !(value.is_null() || value == &Value::Bool(false)) {
                    return false;
                }
            }
            "delivery" => {
                if !value.is_null() {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

fn decode_user_item(id: &str, item: &Value, created: Option<u64>) -> Result<Option<QueuedPrompt>> {
    if item["type"] != "user" {
        return Ok(None);
    }
    let delivery = parse_delivery(&item["delivery"]).ok_or("invalid inbox delivery")?;
    let payload = &item["payload"];
    if !payload.is_object() {
        return Err("invalid inbox payload".into());
    }
    let parts = content::decode_user_payload(id, payload)?;
    let text = payload["metadata"]["displayText"]
        .as_str()
        .filter(|text| !text.is_empty())
        .or_else(|| payload["text"].as_str())
        .or_else(|| (!parts.is_empty()).then_some(""))
        .ok_or("invalid inbox prompt text")?;
    if text.len() > MAX_TEXT_BYTES {
        return Err("inbox prompt text exceeds limit".into());
    }
    let editable = parts.is_empty() && payload_is_plain_text(payload, text);
    let created = created.or_else(|| item["time"]["created"].as_u64());
    Ok(Some(QueuedPrompt {
        id: id.into(),
        delivery,
        text: text.into(),
        parts,
        created,
        editable,
    }))
}

pub fn decode_list(value: &Value) -> Result<Vec<QueuedPrompt>> {
    let rows = value
        .get("data")
        .unwrap_or(value)
        .as_array()
        .filter(|rows| rows.len() <= MAX_ITEMS)
        .ok_or("invalid session inbox list")?;
    let mut seen = HashSet::with_capacity(rows.len());
    let mut items = Vec::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("invalid inbox item id")?;
        if !seen.insert(id) {
            return Err("duplicate inbox item id".into());
        }
        if let Some(prompt) = decode_user_item(id, row, None)? {
            items.push(prompt);
        }
    }
    Ok(items)
}

pub(crate) fn decode_enqueued(native: &Value) -> Option<QueuedPrompt> {
    let data = &native["data"];
    let item = &data["item"];
    let id = data["inboxID"]
        .as_str()
        .or_else(|| item["id"].as_str())
        .filter(|id| valid_id(id))?;
    decode_user_item(id, item, native["created"].as_u64())
        .ok()
        .flatten()
}

pub(crate) fn decode_delivery_changed(native: &Value) -> Option<(String, Delivery)> {
    let data = &native["data"];
    let id = data["inboxID"].as_str().filter(|id| valid_id(id))?;
    let delivery = parse_delivery(&data["delivery"])?;
    Some((id.into(), delivery))
}

pub(crate) fn decode_inbox_id(native: &Value) -> Option<&str> {
    native["data"]["inboxID"].as_str().filter(|id| valid_id(id))
}

impl Backend {
    fn inbox_url(&self) -> Result<String> {
        if !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid session inbox scope".into());
        }
        Ok(format!(
            "{}workspaces/{}/instance/api/session/{}/inbox",
            self.base, self.workspace, self.session
        ))
    }

    pub async fn session_inbox(&self) -> Result<Option<Vec<QueuedPrompt>>> {
        let response = self
            .client
            .get(self.inbox_url()?)
            .timeout(DEADLINE)
            .send()
            .await?;
        if matches!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::NOT_IMPLEMENTED
        ) {
            return Ok(None);
        }
        let value = read_json_limited(response.error_for_status()?, MAX_INBOX_BYTES).await?;
        decode_list(&value).map(Some)
    }

    pub async fn update_queued_prompt_delivery(
        &self,
        inbox_id: &str,
        delivery: Delivery,
    ) -> Result<()> {
        if !valid_id(inbox_id) {
            return Err("invalid inbox item id".into());
        }
        let response = self
            .client
            .patch(format!("{}/{inbox_id}", self.inbox_url()?))
            .timeout(DEADLINE)
            .json(&json!({ "delivery": delivery_str(delivery) }))
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
            return Err(InboxUnavailable.into());
        }
        response.error_for_status()?;
        Ok(())
    }

    pub async fn cancel_queued_prompt(&self, inbox_id: &str) -> Result<()> {
        if !valid_id(inbox_id) {
            return Err("invalid inbox item id".into());
        }
        let response = self
            .client
            .delete(format!("{}/{inbox_id}", self.inbox_url()?))
            .timeout(DEADLINE)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_IMPLEMENTED {
            return Err(InboxUnavailable.into());
        }
        response.error_for_status()?;
        Ok(())
    }
}
