use std::collections::BTreeMap;
mod cache;
pub(crate) mod opening;
mod persistence;
mod state;
pub(crate) use persistence::finish;
pub(crate) use state::{
    Ui, bound, capture, close, connected, draft_changed, input_ready, new_tab, opened, poll,
    prepare_open, resume, retry, select, status, strip,
};

use serde_json::{Map, Value, json};

pub(crate) const MAX_BYTES: usize = 1024 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_TABS: usize = 32;
const MAX_DRAFTS: usize = 24;
const MAX_DRAFT: usize = 32 * 1024;
const MAX_STRINGS: usize = 96 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub revision: u64,
    pub saved_at: u64,
    pub tabs: Vec<Tab>,
    pub active: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tab {
    Blank,
    Workspace(Workspace),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub backend_id: Option<String>,
    pub server_id: Option<String>,
    pub folder: String,
    pub occurrence: u64,
    pub workspace_id: Option<String>,
    pub active_session_id: Option<String>,
    pub drafts: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Malformed,
    Unsupported,
    Limit,
}

// Text-only v1 subset of stores/client-state-codec.ts and local-draft-ids.ts.
// An alpha-owned store rejects unsupported data instead of importing a partial Tauri state.
pub fn decode(bytes: &[u8]) -> Result<Snapshot, Error> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::Limit);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::Malformed)?;
    let root = object(&value)?;
    fields(
        root,
        &["version", "revision", "savedAt", "layout", "session"],
    )?;
    if integer(root.get("version"))? != 1 {
        return Err(Error::Unsupported);
    }
    empty_map(root.get("layout"))?;
    let revision = integer(root.get("revision"))?;
    let saved_at = integer(root.get("savedAt"))?;
    let (tabs, active) = if root.get("session") == Some(&Value::Null) {
        (Vec::new(), None)
    } else {
        let session = object(required(root, "session")?)?;
        fields(session, &["tabs", "activeTabIndex"])?;
        let raw_tabs = required(session, "tabs")?
            .as_array()
            .ok_or(Error::Malformed)?;
        if raw_tabs.len() > MAX_TABS {
            return Err(Error::Limit);
        }
        let tabs = raw_tabs.iter().map(tab).collect::<Result<Vec<_>, _>>()?;
        let index = required(session, "activeTabIndex")?;
        let active = if index.as_f64() == Some(-1.0) {
            None
        } else {
            Some(usize::try_from(integer(Some(index))?).map_err(|_| Error::Limit)?)
        };
        (tabs, active)
    };
    let snapshot = Snapshot {
        revision,
        saved_at,
        tabs,
        active,
    };
    validate(&snapshot)?;
    Ok(snapshot)
}

pub fn encode(snapshot: &Snapshot) -> Result<Vec<u8>, Error> {
    validate(snapshot)?;
    let tabs: Vec<Value> = snapshot
        .tabs
        .iter()
        .map(|tab| match tab {
            Tab::Blank => json!({"kind": "blank"}),
            Tab::Workspace(workspace) => {
                let mut value = json!({
                    "kind": "workspace", "folder": workspace.folder,
                    "occurrence": workspace.occurrence, "drafts": workspace.drafts,
                    "attachments": {}, "scrollSnapshots": {}, "unseenIdleSince": {},
                    "generationRecovery": {},
                });
                for (key, entry) in [
                    ("backendId", &workspace.backend_id),
                    ("serverId", &workspace.server_id),
                    ("workspaceId", &workspace.workspace_id),
                    ("activeSessionId", &workspace.active_session_id),
                ] {
                    if let Some(entry) = entry {
                        value[key] = Value::String(entry.clone());
                    }
                }
                value
            }
        })
        .collect();
    let active = snapshot.active.map(|index| index as i64).unwrap_or(-1);
    let value = json!({"version": 1, "revision": snapshot.revision, "savedAt": snapshot.saved_at,
        "layout": {}, "session": {"tabs": tabs, "activeTabIndex": active}});
    let bytes = serde_json::to_vec(&value).map_err(|_| Error::Malformed)?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::Limit);
    }
    Ok(bytes)
}

fn tab(value: &Value) -> Result<Tab, Error> {
    let value = object(value)?;
    match required(value, "kind")?.as_str() {
        Some("blank") => {
            fields(value, &["kind"])?;
            Ok(Tab::Blank)
        }
        Some("workspace") => {
            fields(
                value,
                &[
                    "kind",
                    "backendId",
                    "serverId",
                    "folder",
                    "occurrence",
                    "workspaceId",
                    "activeSessionId",
                    "drafts",
                    "attachments",
                    "scrollSnapshots",
                    "unseenIdleSince",
                    "generationRecovery",
                    "seenInterruptions",
                    "expandedSessionIds",
                    "outlineIndexes",
                    "sessionCatalog",
                    "viewState",
                ],
            )?;
            for key in [
                "attachments",
                "scrollSnapshots",
                "unseenIdleSince",
                "generationRecovery",
                "seenInterruptions",
                "outlineIndexes",
                "viewState",
            ] {
                if value.contains_key(key) {
                    empty_map(value.get(key))?;
                }
            }
            for key in ["expandedSessionIds", "sessionCatalog"] {
                if let Some(entry) = value.get(key) {
                    if !entry.as_array().ok_or(Error::Malformed)?.is_empty() {
                        return Err(Error::Unsupported);
                    }
                }
            }
            let raw_drafts = object(required(value, "drafts")?)?;
            if raw_drafts.len() > MAX_DRAFTS {
                return Err(Error::Limit);
            }
            let drafts = raw_drafts
                .iter()
                .map(|(key, entry)| {
                    Ok((
                        key.clone(),
                        entry.as_str().ok_or(Error::Malformed)?.to_owned(),
                    ))
                })
                .collect::<Result<_, Error>>()?;
            Ok(Tab::Workspace(Workspace {
                backend_id: optional_string(value, "backendId")?,
                server_id: optional_string(value, "serverId")?,
                folder: required(value, "folder")?
                    .as_str()
                    .ok_or(Error::Malformed)?
                    .to_owned(),
                occurrence: value
                    .get("occurrence")
                    .map(|v| integer(Some(v)))
                    .transpose()?
                    .unwrap_or(0),
                workspace_id: optional_string(value, "workspaceId")?,
                active_session_id: optional_string(value, "activeSessionId")?,
                drafts,
            }))
        }
        Some(_) => Err(Error::Unsupported),
        None => Err(Error::Malformed),
    }
}

fn validate(snapshot: &Snapshot) -> Result<(), Error> {
    if snapshot.revision > MAX_SAFE
        || snapshot.saved_at > MAX_SAFE
        || snapshot.tabs.len() > MAX_TABS
    {
        return Err(Error::Limit);
    }
    match snapshot.active {
        None if snapshot.tabs.is_empty() => {}
        Some(index) if index < snapshot.tabs.len() => {}
        _ => return Err(Error::Malformed),
    }
    let mut remaining = MAX_STRINGS;
    for tab in &snapshot.tabs {
        let Tab::Workspace(workspace) = tab else {
            continue;
        };
        if workspace.occurrence >= MAX_TABS as u64 || workspace.drafts.len() > MAX_DRAFTS {
            return Err(Error::Limit);
        }
        take(&workspace.folder, 4096, false, &mut remaining)?;
        if !codenomad_client::absolute_server_path(&workspace.folder) {
            return Err(Error::Malformed);
        }
        if let Some(id) = &workspace.backend_id {
            take(id, 64, false, &mut remaining)?;
            if id == "local" || !safe_key(id) || !id.bytes().all(id_character) {
                return Err(Error::Malformed);
            }
        } else if workspace.server_id.is_some() {
            return Err(Error::Malformed);
        }
        for id in [
            &workspace.server_id,
            &workspace.workspace_id,
            &workspace.active_session_id,
        ]
        .into_iter()
        .flatten()
        {
            take(id, 512, false, &mut remaining)?;
            if !safe_key(id) {
                return Err(Error::Malformed);
            }
        }
        for (id, text) in &workspace.drafts {
            take(id, 256, false, &mut remaining)?;
            if !draft_id(id) {
                return Err(Error::Malformed);
            }
            take(text, MAX_DRAFT, true, &mut remaining)?;
        }
    }
    Ok(())
}

fn take(value: &str, max: usize, empty: bool, remaining: &mut usize) -> Result<(), Error> {
    let len = value.encode_utf16().count();
    if len > max || len > *remaining {
        return Err(Error::Limit);
    }
    if !empty && value.trim().is_empty() {
        return Err(Error::Malformed);
    }
    *remaining -= len;
    Ok(())
}

fn safe_key(value: &str) -> bool {
    !matches!(value, "__proto__" | "constructor" | "prototype")
}
fn id_character(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}
fn draft_id(value: &str) -> bool {
    if !safe_key(value) {
        return false;
    }
    if value == "__no_session_draft__" {
        return true;
    }
    if let Some(tail) = value.strip_prefix("__recovered_draft__") {
        return tail.len() == 36
            && tail
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-');
    }
    !value.is_empty() && value.len() <= 256 && value.bytes().all(id_character)
}
fn object(value: &Value) -> Result<&Map<String, Value>, Error> {
    value.as_object().ok_or(Error::Malformed)
}
fn required<'a>(value: &'a Map<String, Value>, key: &str) -> Result<&'a Value, Error> {
    value.get(key).ok_or(Error::Malformed)
}
fn optional_string(value: &Map<String, Value>, key: &str) -> Result<Option<String>, Error> {
    value
        .get(key)
        .map(|v| v.as_str().map(str::to_owned).ok_or(Error::Malformed))
        .transpose()
}
fn fields(value: &Map<String, Value>, allowed: &[&str]) -> Result<(), Error> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Error::Unsupported);
    }
    Ok(())
}
fn empty_map(value: Option<&Value>) -> Result<(), Error> {
    if !object(value.ok_or(Error::Malformed)?)?.is_empty() {
        return Err(Error::Unsupported);
    }
    Ok(())
}
fn integer(value: Option<&Value>) -> Result<u64, Error> {
    let value = value.and_then(Value::as_f64).ok_or(Error::Malformed)?;
    if value < 0.0 || value.fract() != 0.0 {
        return Err(Error::Malformed);
    }
    if value > MAX_SAFE as f64 {
        return Err(Error::Limit);
    }
    Ok(value as u64)
}

#[cfg(test)]
mod tests;
