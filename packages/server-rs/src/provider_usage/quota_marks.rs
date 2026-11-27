//! Per-connection reactive quota exhaustion marks and native event attribution bookkeeping.
use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::shared::now_ms;

const MAX_MARKS: usize = 256;
const MAX_STEPS: usize = 512;
const MAX_SEEN: usize = 1024;
pub(super) const MAX_PENDING: usize = 8;
const FAILURE_DEDUPE_MS: f64 = 10_000.0;
const HOUR_MS: u64 = 3_600_000;
/// Attribution window when the failing step's start was not observed (e.g. after reconnect).
const UNOBSERVED_STEP_MS: f64 = 60_000.0;
const MAX_BODY_UTF16: usize = 65_536;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct QuotaFailure {
    pub session_id: String,
    /// Native event time (daemon clock, milliseconds).
    pub failed_at: f64,
    /// Go's `metadata.limitName`: "5 hour", "weekly" or "monthly".
    pub limit_name: Option<String>,
    /// Switch watermark captured when the failure was received from the relay.
    pub watermark: Option<u64>,
}

#[derive(Clone, Debug)]
struct SwitchRecord {
    at: f64,
    seq: u64,
    credential_id: Option<Option<String>>,
}

#[derive(Clone, Debug)]
struct StepRecord {
    at: f64,
    provider_id: Option<String>,
}

/// OpenCode keeps no reset time for `provider.quota` failures. A rolling 5-hour
/// limit expires after 5 h; weekly, monthly and unknown limits are rechecked
/// after 24 h rather than parked for their whole window.
pub(super) fn quota_mark_ttl(limit_name: Option<&str>) -> u64 {
    let Some(raw) = limit_name else {
        return 24 * HOUR_MS;
    };
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix('5') {
        let rest = rest.trim_start();
        if rest.eq_ignore_ascii_case("h") || rest.eq_ignore_ascii_case("hour") || rest.eq_ignore_ascii_case("hours") {
            return 5 * HOUR_MS;
        }
    }
    24 * HOUR_MS
}

pub(super) fn parse_quota_failure(event: &Value) -> Option<QuotaFailure> {
    let kind = event["type"].as_str()?;
    if kind != "session.step.failed" && kind != "session.execution.failed" {
        return None;
    }
    let data = event.get("data")?;
    let error = data.get("error")?;
    if error["type"].as_str() != Some("provider.quota") {
        return None;
    }
    let session_id = data["sessionID"].as_str()?;
    if session_id.is_empty() || session_id.encode_utf16().count() > 512 {
        return None;
    }
    let failed_at = event["created"].as_f64().filter(|v| v.is_finite() && *v >= 0.0).unwrap_or_else(|| now_ms() as f64);
    let limit_name = parse_limit_name(error.get("response").and_then(|r| r.get("body")));
    Some(QuotaFailure { session_id: session_id.to_owned(), failed_at, limit_name, watermark: None })
}

fn parse_limit_name(body: Option<&Value>) -> Option<String> {
    let raw = body?.as_str()?;
    if raw.encode_utf16().count() > MAX_BODY_UTF16 {
        return None;
    }
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let name = parsed["metadata"]["limitName"].as_str()?;
    (name.encode_utf16().count() <= 64).then(|| name.to_owned())
}

struct BoundedMap<K, V> {
    entries: HashMap<K, V>,
    order: VecDeque<K>,
}

impl<K, V> Default for BoundedMap<K, V> {
    fn default() -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new() }
    }
}

impl<K: Eq + std::hash::Hash + Clone, V> BoundedMap<K, V> {
    fn get(&self, key: &K) -> Option<&V> {
        self.entries.get(key)
    }

    fn insert(&mut self, key: K, value: V, limit: usize) {
        if self.entries.remove(&key).is_some() {
            self.order.retain(|existing| existing != &key);
        }
        while self.entries.len() >= limit {
            let Some(oldest) = self.order.pop_front() else { break };
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }

    fn remove(&mut self, key: &K) {
        if self.entries.remove(key).is_some() {
            self.order.retain(|existing| existing != key);
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}

pub(super) struct QuotaMarks {
    marks: BoundedMap<(String, String), u64>,
    switches: BoundedMap<String, SwitchRecord>,
    steps: BoundedMap<String, StepRecord>,
    manual_at: f64,
    manual_seq: u64,
    sequence: u64,
}

impl Default for QuotaMarks {
    fn default() -> Self {
        Self {
            marks: BoundedMap::default(),
            switches: BoundedMap::default(),
            steps: BoundedMap::default(),
            manual_at: f64::NEG_INFINITY,
            manual_seq: 0,
            sequence: 0,
        }
    }
}

impl QuotaMarks {
    pub(super) fn mark(&mut self, integration_id: &str, credential_id: &str, limit_name: Option<&str>, now: u64) {
        let key = (integration_id.to_owned(), credential_id.to_owned());
        self.marks.insert(key, now.saturating_add(quota_mark_ttl(limit_name)), MAX_MARKS);
    }

    pub(super) fn has(&mut self, integration_id: &str, credential_id: &str, now: u64) -> bool {
        let key = (integration_id.to_owned(), credential_id.to_owned());
        let Some(&expires_at) = self.marks.get(&key) else {
            return false;
        };
        if expires_at > now {
            return true;
        }
        self.marks.remove(&key);
        false
    }

    pub(super) fn clear(&mut self, integration_id: &str, credential_id: &str) {
        let key = (integration_id.to_owned(), credential_id.to_owned());
        self.marks.remove(&key);
    }

    pub(super) fn manual_change(&mut self, now: u64) {
        self.marks.clear();
        self.manual_at = now as f64;
        self.sequence = self.sequence.saturating_add(1);
        self.manual_seq = self.sequence;
    }

    /// `credential_id`: `Some(Some(id))` = known active ID, `Some(None)` = known none, `None` = preserve prior.
    pub(super) fn switched(&mut self, integration_id: &str, at: f64, credential_id: Option<Option<String>>) {
        if !at.is_finite() {
            return;
        }
        let key = integration_id.to_owned();
        let previous = self.switches.get(&key).cloned();
        self.sequence = self.sequence.saturating_add(1);
        let merged_at = previous.as_ref().map_or(at, |p| p.at.max(at));
        let merged_cred = match credential_id {
            Some(explicit) => Some(explicit),
            None => previous.and_then(|p| p.credential_id),
        };
        // Preserve insertion order on update like JS Map.set, evict oldest only when new key exceeds MAX_MARKS.
        if let Some(existing) = self.switches.entries.get_mut(&key) {
            existing.at = merged_at;
            existing.seq = self.sequence;
            existing.credential_id = merged_cred;
        } else {
            self.switches.insert(
                key,
                SwitchRecord { at: merged_at, seq: self.sequence, credential_id: merged_cred },
                MAX_MARKS,
            );
        }
    }

    /// A failed or ambiguous activation: the active credential is no longer known.
    pub(super) fn active_unknown(&mut self, integration_id: &str) {
        if let Some(existing) = self.switches.entries.get_mut(integration_id) {
            existing.credential_id = None;
        }
    }

    pub(super) fn switched_since(&self, integration_id: &str, at: f64) -> bool {
        let switched_at = self.switches.get(&integration_id.to_owned()).map_or(f64::NEG_INFINITY, |r| r.at);
        switched_at.max(self.manual_at) >= at
    }

    pub(super) fn watermark(&self) -> u64 {
        self.sequence
    }

    pub(super) fn changed_after(&self, integration_id: &str, watermark: u64) -> bool {
        let switch_seq = self.switches.get(&integration_id.to_owned()).map_or(0, |r| r.seq);
        switch_seq.max(self.manual_seq) > watermark
    }

    /// Returns `Some(Some(id))` or `Some(None)` when the active credential at `<= at` is known,
    /// or `None` when unknown.
    pub(super) fn active_at(&self, integration_id: &str, at: f64) -> Option<Option<&str>> {
        let latest = self.switches.get(&integration_id.to_owned())?;
        if latest.at <= at { latest.credential_id.as_ref().map(|inner| inner.as_deref()) } else { None }
    }

    pub(super) fn step_started(&mut self, session_id: &str, at: f64, provider_id: Option<String>) {
        if !at.is_finite() {
            return;
        }
        self.steps.insert(session_id.to_owned(), StepRecord { at, provider_id }, MAX_STEPS);
    }

    pub(super) fn step_for(&self, session_id: &str, failed_at: f64) -> (f64, Option<String>) {
        if let Some(step) = self.steps.get(&session_id.to_owned())
            && step.at <= failed_at
        {
            return (step.at, step.provider_id.clone());
        }
        (failed_at - UNOBSERVED_STEP_MS, None)
    }
}

#[derive(Default)]
pub(super) struct EventDedupe {
    seen: BoundedMap<String, ()>,
    recent: BoundedMap<String, f64>,
}

impl EventDedupe {
    pub(super) fn once(&mut self, id: Option<&str>) -> bool {
        let Some(id) = id else { return true };
        let key = id.to_owned();
        if self.seen.get(&key).is_some() {
            return false;
        }
        self.seen.insert(key, (), MAX_SEEN);
        true
    }

    pub(super) fn accept_failure(&mut self, session_id: &str, failed_at: f64) -> bool {
        let key = session_id.to_owned();
        if let Some(&previous) = self.recent.get(&key)
            && (failed_at - previous).abs() < FAILURE_DEDUPE_MS
        {
            return false;
        }
        self.recent.insert(key, failed_at, MAX_SEEN);
        true
    }
}
