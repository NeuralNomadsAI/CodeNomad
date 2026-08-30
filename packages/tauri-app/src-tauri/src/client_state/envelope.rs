use super::{partitions, window};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub(super) const VERSION: u64 = 3;
pub(super) const LEGACY_MONOLITHIC_VERSION: u64 = 1;
const LEGACY_PARTITION_VERSION: u64 = 2;
const MAX_WINDOWS: usize = 16;
pub(super) const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowRecord {
    pub(super) restore_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) snapshot: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) window: Option<window::NativeWindowState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) partition_protocol_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) partition_keys: Option<Vec<String>>,
    #[serde(skip)]
    pub(super) partition_root_supported: bool,
    #[serde(skip)]
    pub(super) writes_enabled: bool,
}

impl Default for WindowRecord {
    fn default() -> Self {
        Self {
            restore_enabled: true,
            snapshot: None,
            window: None,
            partition_protocol_version: None,
            partition_keys: None,
            partition_root_supported: false,
            writes_enabled: true,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PersistedClientState {
    version: u64,
    pub(super) active_window_id: String,
    pub(super) window_order: Vec<String>,
    pub(super) windows: HashMap<String, WindowRecord>,
    #[serde(skip)]
    pub(super) unsupported_future_envelope: bool,
}

impl Default for PersistedClientState {
    fn default() -> Self {
        Self::with_window_id(uuid::Uuid::new_v4().to_string())
    }
}

impl PersistedClientState {
    fn with_window_id(window_id: String) -> Self {
        Self {
            version: VERSION,
            active_window_id: window_id.clone(),
            window_order: vec![window_id.clone()],
            windows: HashMap::from([(window_id, WindowRecord::default())]),
            unsupported_future_envelope: false,
        }
    }

    pub(super) fn active(&self) -> &WindowRecord {
        self.windows
            .get(&self.active_window_id)
            .expect("validated client state has an active window")
    }

    pub(super) fn active_mut(&mut self) -> &mut WindowRecord {
        self.windows
            .get_mut(&self.active_window_id)
            .expect("validated client state has an active window")
    }

    pub(super) fn record(&self, window_id: &str) -> Result<&WindowRecord, String> {
        self.windows
            .get(window_id)
            .ok_or_else(|| "Unknown client state window".to_string())
    }

    pub(super) fn record_mut(&mut self, window_id: &str) -> Result<&mut WindowRecord, String> {
        self.windows
            .get_mut(window_id)
            .ok_or_else(|| "Unknown client state window".to_string())
    }

    pub(super) fn retained_partition_keys(&self) -> Vec<String> {
        let mut keys = self
            .window_order
            .iter()
            .filter_map(|id| self.windows.get(id))
            .flat_map(|record| record.partition_keys.iter().flatten().cloned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    pub(super) fn add_window(&mut self, window_id: String) -> Result<(), String> {
        if !valid_window_id(&window_id) {
            return Err("Invalid client state window ID".to_string());
        }
        if self.window_order.len() >= MAX_WINDOWS {
            return Err("Too many client state windows".to_string());
        }
        if self.windows.contains_key(&window_id) {
            return Err("Client state window already exists".to_string());
        }
        if self.window_order.is_empty() {
            self.active_window_id = window_id.clone();
        }
        self.window_order.push(window_id.clone());
        self.windows.insert(window_id, WindowRecord::default());
        Ok(())
    }

    pub(super) fn remove_window(&mut self, window_id: &str) -> Result<bool, String> {
        if !self.windows.contains_key(window_id) {
            return Err("Unknown client state window".to_string());
        }
        self.window_order.retain(|id| id != window_id);
        self.windows.remove(window_id);
        if self.active_window_id == window_id && !self.window_order.is_empty() {
            self.active_window_id = self.window_order[0].clone();
        }
        Ok(true)
    }
}

pub(super) fn valid_window_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
        && uuid::Uuid::parse_str(value)
            .map(|uuid| uuid.to_string() == value)
            .unwrap_or(false)
}

fn has_only_keys(value: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    value.keys().all(|key| allowed.contains(&key.as_str()))
}

fn value_size(value: &Value) -> Option<usize> {
    serde_json::to_vec(value).ok().map(|bytes| bytes.len())
}

pub(super) fn exact_nonnegative_safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_number()?.as_f64()?;
    (number.is_finite() && number >= 0.0 && number <= MAX_SAFE_INTEGER && number.fract() == 0.0)
        .then_some(number as u64)
}

fn parse_record(value: &Value) -> Option<WindowRecord> {
    let value = value.as_object()?;
    if !has_only_keys(
        value,
        &[
            "restoreEnabled",
            "snapshot",
            "window",
            "partitionProtocolVersion",
            "partitionKeys",
        ],
    ) {
        return None;
    }
    let restore_enabled = value.get("restoreEnabled")?.as_bool()?;
    let snapshot = value.get("snapshot").cloned();
    let window = if value.contains_key("window") {
        Some(window::normalize_window_state(value.get("window")?)?)
    } else {
        None
    };
    let has_protocol = value.contains_key("partitionProtocolVersion");
    let has_keys = value.contains_key("partitionKeys");
    let (partition_protocol_version, partition_keys, partition_root_supported) = if has_protocol
        || has_keys
    {
        if !has_protocol
            || !has_keys
            || exact_nonnegative_safe_integer(value.get("partitionProtocolVersion")?)?
                != partitions::PROTOCOL_VERSION
        {
            return None;
        }
        let keys = partitions::validate_keys(value.get("partitionKeys")?)?;
        let root = snapshot.as_ref().and_then(partitions::validate_root)?;
        if root != keys || snapshot.as_ref().and_then(value_size)? > partitions::MAX_ROOT_BYTES {
            return None;
        }
        (Some(partitions::PROTOCOL_VERSION), Some(keys), true)
    } else {
        if snapshot
            .as_ref()
            .and_then(value_size)
            .is_some_and(|size| size > MAX_SNAPSHOT_BYTES)
        {
            return None;
        }
        (None, None, false)
    };
    Some(WindowRecord {
        restore_enabled,
        snapshot,
        window,
        partition_protocol_version,
        partition_keys,
        partition_root_supported,
        writes_enabled: restore_enabled,
    })
}

fn parse_v3(value: &serde_json::Map<String, Value>) -> Option<PersistedClientState> {
    if !has_only_keys(
        value,
        &["version", "activeWindowId", "windowOrder", "windows"],
    ) {
        return None;
    }
    let active_window_id = value.get("activeWindowId")?.as_str()?.to_string();
    if !valid_window_id(&active_window_id) {
        return None;
    }
    let order = value.get("windowOrder")?.as_array()?;
    if order.len() > MAX_WINDOWS {
        return None;
    }
    let mut seen = HashSet::new();
    let mut window_order = Vec::with_capacity(order.len());
    for id in order {
        let id = id.as_str()?;
        if !valid_window_id(id) || !seen.insert(id) {
            return None;
        }
        window_order.push(id.to_string());
    }
    if !window_order.is_empty() && !seen.contains(active_window_id.as_str()) {
        return None;
    }
    let source = value.get("windows")?.as_object()?;
    if source.len() != window_order.len() || source.keys().any(|id| !seen.contains(id.as_str())) {
        return None;
    }
    let mut windows = HashMap::with_capacity(window_order.len());
    for id in &window_order {
        windows.insert(id.clone(), parse_record(source.get(id)?)?);
    }
    Some(PersistedClientState {
        version: VERSION,
        active_window_id,
        window_order,
        windows,
        unsupported_future_envelope: false,
    })
}

fn parse_legacy(
    value: &serde_json::Map<String, Value>,
    bytes: &[u8],
) -> Option<PersistedClientState> {
    let version = exact_nonnegative_safe_integer(value.get("version")?)?;
    let mut state = PersistedClientState::with_window_id(deterministic_legacy_window_id(bytes));
    let record = if version == LEGACY_PARTITION_VERSION {
        if !has_only_keys(
            value,
            &[
                "version",
                "restoreEnabled",
                "snapshot",
                "window",
                "protocolVersion",
                "partitionKeys",
            ],
        ) {
            return None;
        }
        let restore_enabled = value.get("restoreEnabled")?.as_bool()?;
        let snapshot = value.get("snapshot")?.clone();
        let keys = partitions::validate_keys(value.get("partitionKeys")?)?;
        if exact_nonnegative_safe_integer(value.get("protocolVersion")?)?
            != partitions::PROTOCOL_VERSION
            || partitions::validate_root(&snapshot)? != keys
            || value_size(&snapshot)? > partitions::MAX_ROOT_BYTES
        {
            return None;
        }
        WindowRecord {
            restore_enabled,
            snapshot: Some(snapshot),
            window: if value.contains_key("window") {
                Some(window::normalize_window_state(value.get("window")?)?)
            } else {
                None
            },
            partition_protocol_version: Some(partitions::PROTOCOL_VERSION),
            partition_keys: Some(keys),
            partition_root_supported: true,
            writes_enabled: restore_enabled,
        }
    } else if version == LEGACY_MONOLITHIC_VERSION {
        if !has_only_keys(value, &["version", "restoreEnabled", "snapshot", "window"]) {
            return None;
        }
        let restore_enabled = match value.get("restoreEnabled") {
            Some(value) => value.as_bool()?,
            None => true,
        };
        let snapshot = value.get("snapshot").cloned();
        if snapshot
            .as_ref()
            .and_then(value_size)
            .is_some_and(|size| size > MAX_SNAPSHOT_BYTES)
        {
            return None;
        }
        WindowRecord {
            restore_enabled,
            snapshot,
            window: if value.contains_key("window") {
                Some(window::normalize_window_state(value.get("window")?)?)
            } else {
                None
            },
            writes_enabled: restore_enabled,
            ..WindowRecord::default()
        }
    } else {
        return None;
    };
    *state.active_mut() = record;
    Some(state)
}

pub(super) fn deterministic_legacy_window_id(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut id = [0_u8; 16];
    id.copy_from_slice(&digest[..16]);
    id[6] = (id[6] & 0x0f) | 0x50;
    id[8] = (id[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(id).to_string()
}

pub(super) fn parse(bytes: &[u8]) -> PersistedClientState {
    let Ok(Value::Object(value)) = serde_json::from_slice::<Value>(bytes) else {
        return unsupported();
    };
    let version = value
        .get("version")
        .and_then(exact_nonnegative_safe_integer);
    let parsed = if version == Some(VERSION) {
        parse_v3(&value)
    } else {
        parse_legacy(&value, bytes)
    };
    parsed.unwrap_or_else(unsupported)
}

pub(super) fn unsupported() -> PersistedClientState {
    let mut state = PersistedClientState::default();
    let record = state.active_mut();
    record.restore_enabled = false;
    record.writes_enabled = false;
    state.unsupported_future_envelope = true;
    state
}
