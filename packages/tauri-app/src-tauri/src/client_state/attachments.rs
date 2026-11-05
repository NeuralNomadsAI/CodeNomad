use super::{envelope::WindowRecord, partitions, ClientState};
use crate::local_windows::LocalWindows;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

pub(super) struct AttachmentState {
    pub(super) epoch: String,
    pub(super) publication_unknown: bool,
    publications: HashSet<String>,
    #[cfg(test)]
    after_admission: Option<Box<dyn FnOnce() + Send>>,
    captured: Option<(String, String, String)>,
    owners: HashMap<String, String>,
    tabs: HashMap<String, (String, usize)>,
    backend_generation: Option<u64>,
}

impl Default for AttachmentState {
    fn default() -> Self {
        Self { epoch: uuid::Uuid::new_v4().to_string(), publication_unknown: false, publications: HashSet::new(),
            #[cfg(test)] after_admission: None,
            captured: None, owners: HashMap::new(), tabs: HashMap::new(), backend_generation: None }
    }
}

pub(super) struct PublicationAdmission<'a> {
    state: &'a Mutex<AttachmentState>,
    owner: String,
}

impl Drop for PublicationAdmission<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.publications.remove(&self.owner);
            state.epoch = uuid::Uuid::new_v4().to_string();
        }
    }
}

pub(super) struct PublicationGuard<'a> {
    _admission: PublicationAdmission<'a>,
    _write: MutexGuard<'a, ()>,
}

// Read only the accepted tab manifest; workspace/session/blob partitions remain unopened.
fn project_metadata(record: &WindowRecord, load: impl Fn(&str) -> Option<String>) -> Option<Vec<Value>> {
    if !record.restore_enabled { return Some(vec![]); }
    let root = record.snapshot.as_ref()?.as_object()?;
    let partitioned = record.partition_protocol_version == Some(1);
    let manifest;
    let session = if partitioned {
        partitions::validate_root(record.snapshot.as_ref()?)?;
        let key = root.get("sessionPartition")?.as_str()?;
        if !record.partition_keys.as_ref()?.iter().any(|value| value == key) { return None; }
        manifest = serde_json::from_str::<Value>(&load(key)?).ok()?;
        if manifest.get("format")?.as_u64()? != 2 || !manifest.as_object()?.keys().all(|key| ["format", "session"].contains(&key.as_str())) { return None; }
        manifest.get("session")?
    } else {
        if root.get("version").is_some_and(|version| version.as_u64() != Some(1)) { return None; }
        root.get("session")?
    };
    if session.is_null() { return Some(vec![]); }
    let session = session.as_object()?;
    if !session.keys().all(|key| ["tabs", "activeTabIndex", "homeActive"].contains(&key.as_str())) { return None; }
    let tabs = session.get("tabs")?.as_array()?;
    if tabs.len() > 32 { return None; }
    let active = session.get("activeTabIndex")?.as_i64()?;
    if active < -1 || active >= tabs.len() as i64 || session.get("homeActive").is_some_and(|value| !value.is_boolean()) { return None; }
    let mut result = Vec::new();
    for (index, raw) in tabs.iter().enumerate() {
        let tab = raw.as_object()?;
        let kind = tab.get("kind").or_else(|| tab.get("type"))?.as_str()?;
        if kind == "sidecar" {
            let id = tab.get("sidecarId")?.as_str()?;
            if id.is_empty() || id.encode_utf16().count() > 512 { return None; }
            continue;
        }
        if kind != "workspace" && (partitioned || kind != "instance") { return None; }
        let directory = tab.get("folder")?.as_str()?;
        if directory.trim().is_empty() || directory.encode_utf16().count() > 4096 || directory.contains('\0') { return None; }
        let server_id = match tab.get("serverId") { Some(value) => value.as_str()?, None => "local-shared" };
        if server_id.is_empty() || server_id.len() > 128 || !server_id.as_bytes()[0].is_ascii_alphanumeric()
            || !server_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') { return None; }
        if let Some(value) = tab.get("occurrence") {
            if value.as_u64()? >= 32 { return None; }
        }
        if partitioned {
            let key = tab.get("workspacePartition")?.as_str()?;
            if !partitions::valid_key(key) || !record.partition_keys.as_ref()?.iter().any(|value| value == key) { return None; }
        }
        result.push(json!({ "index": index, "serverId": server_id, "directory": directory }));
    }
    Some(result)
}

impl ClientState {
    pub(crate) fn bind_attachment_backend(&self, generation: u64) {
        if let Ok(mut state) = self.attachment_state.lock() {
            if state.backend_generation != Some(generation) {
                state.backend_generation = Some(generation);
                state.epoch = uuid::Uuid::new_v4().to_string();
                state.captured = None;
                state.owners.clear(); state.tabs.clear();
            }
        }
    }
    pub(super) fn attachments_changed(&self) {
        if let Ok(mut state) = self.attachment_state.lock() { state.epoch = uuid::Uuid::new_v4().to_string(); }
    }

    pub(super) fn attachment_publication_admission(&self) -> Result<PublicationAdmission<'_>, String> {
        let owner = uuid::Uuid::new_v4().to_string();
        self.attachment_state.lock().map_err(|_| "attachment_inventory_unavailable")?.publications.insert(owner.clone());
        Ok(PublicationAdmission { state: &self.attachment_state, owner })
    }

    pub(super) fn attachment_publication_guard(&self) -> Result<PublicationGuard<'_>, String> {
        // Each waiting writer keeps its own fence through publication and rollback.
        let admission = self.attachment_publication_admission()?;
        self.attachments_changed();
        #[cfg(test)]
        {
            let hook = self.attachment_state.lock().unwrap().after_admission.take();
            if let Some(hook) = hook { hook(); }
        }
        let write = self.write_lock.lock().map_err(|error| error.to_string())?;
        Ok(PublicationGuard { _admission: admission, _write: write })
    }

    fn attachment_epoch_current(&self, epoch: &str) -> bool {
        self.is_primary() && self.attachment_state.lock().is_ok_and(|state| state.epoch == epoch && !state.publication_unknown)
    }

    pub(crate) fn attachment_inventory(&self, windows: &LocalWindows) -> Result<Value, String> {
        let epoch = self.attachment_state.lock().map_err(|_| "attachment_inventory_unavailable")?.epoch.clone();
        let (window_epoch, live) = windows.attachment_membership()?;
        // Publication and rollback share this lock. Never project tentative state.
        let _write = self.write_lock.lock().map_err(|_| "attachment_inventory_unavailable")?;
        let state = self.state.lock().map_err(|_| "attachment_inventory_unavailable")?;
        let receipt = uuid::Uuid::new_v4().to_string();
        {
            let mut handles = self.attachment_state.lock().map_err(|_| "attachment_inventory_unavailable")?;
            handles.captured = Some((receipt.clone(), epoch.clone(), window_epoch.clone()));
            handles.owners.clear(); handles.tabs.clear();
        }
        let unknown = || json!({ "receipt": receipt, "status": "unknown", "retainedStatus": "unknown", "owners": [], "refs": [] });
        if state.unsupported_future_envelope || !self.attachment_epoch_current(&epoch) { return Ok(unknown()); }
        let ids: HashSet<_> = live.iter().chain(state.window_order.iter()).collect();
        let mut owners = vec![];
        let mut refs = vec![];
        let mut owner_handles = HashMap::new();
        let mut tab_handles = HashMap::new();
        let mut complete = true;
        for id in ids {
            let owner_id = uuid::Uuid::new_v4().to_string();
            owner_handles.insert(owner_id.clone(), id.clone());
            let record = state.windows.get(id);
            owners.push(json!({ "ownerId": owner_id, "live": live.contains(id), "retained": record.is_some() }));
            if let Some(record) = record {
                let tabs = project_metadata(record, |key| self.partition_store().load(key, &|| self.attachment_epoch_current(&epoch)).ok().flatten());
                match tabs {
                    Some(tabs) => for tab in tabs {
                        let tab_id = uuid::Uuid::new_v4().to_string();
                        tab_handles.insert(tab_id.clone(), (id.clone(), tab["index"].as_u64().unwrap_or(0) as usize));
                        refs.push(json!({ "ownerId": owner_id, "tabId": tab_id, "source": "retained", "serverId": tab["serverId"], "directory": tab["directory"] }));
                    },
                    None => complete = false,
                }
            }
        }
        if !self.attachment_epoch_current(&epoch) || windows.attachment_membership()?.0 != window_epoch { return Ok(unknown()); }
        {
            let mut handles = self.attachment_state.lock().map_err(|_| "attachment_inventory_unavailable")?;
            handles.owners = owner_handles;
            handles.tabs = tab_handles;
        }
        // Live tab reports and browser participation require their own attestation path.
        Ok(json!({ "receipt": receipt, "status": "unknown", "retainedStatus": if complete { "complete" } else { "unknown" }, "owners": owners, "refs": refs }))
    }

    pub(crate) fn attachment_receipt_current(&self, receipt: &str, windows: &LocalWindows) -> bool {
        let captured = self.attachment_state.lock().ok().and_then(|state| state.captured.clone());
        captured.is_some_and(|(current, epoch, window_epoch)| current == receipt && self.is_primary()
            && self.attachment_state.lock().is_ok_and(|state| state.epoch == epoch && !state.publication_unknown && state.publications.is_empty())
            && windows.attachment_membership().is_ok_and(|current| current.0 == window_epoch))
    }
}

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;
