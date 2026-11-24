mod access;
mod commands;
mod cross_host;
mod envelope;
mod file_drafts;
mod initialization;
mod legacy;
mod navigation;
mod ipc_queue;
mod partitions;
mod process;
mod renderer_flush;
mod restorable;
mod startup_command;
mod window;
mod window_flush;
mod window_updates;

pub(crate) use commands::with_ordered_ipc;
pub(crate) use startup_command::{
    command_name as startup_state_command, run_in_local_window as run_startup_state_command,
    StartupStateSnapshot,
};
pub(crate) use restorable::{default_state_files, restorable_state_modified};
pub(crate) use cross_host::pid_is_alive;

/// `~/.codenomad/client-state`: the default profile's shared state (`v2/`) and its legacy file.
pub(crate) fn home_client_state_directory() -> Option<PathBuf> {
    cross_host::state_path()
        .ok()?
        .parent()?
        .parent()
        .map(Path::to_path_buf)
}
pub(crate) use navigation::{
    before_window_navigation, before_window_navigation_if, NavigationKind,
};
pub(crate) use ipc_queue::IpcQueue;
pub(crate) use renderer_flush::RendererFlushRequest;
pub use window::{
    capture_all_windows, capture_and_flush_window, capture_preferences_window, local_window_zoom,
    set_local_window_zoom, setup_local_window, DEFAULT_ZOOM_LEVEL, MIN_WINDOW_WIDTH,
};

use envelope::PersistedClientState;
use renderer_flush::RendererFlush;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use url::Url;

const CLIENT_STATE_FILENAME: &str = "client-state.json";
const MAX_CLIENT_SNAPSHOT_BYTES: usize = envelope::MAX_SNAPSHOT_BYTES;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStateLoadResult {
    is_primary: bool,
    restore_enabled: bool,
    snapshot: Value,
    partition_protocol_version: Option<u64>,
}

pub struct ClientState {
    state_path: PathBuf,
    process: process::ProcessState,
    state: Mutex<PersistedClientState>,
    zoom_levels: Mutex<HashMap<String, f64>>,
    write_lock: Mutex<()>,
    window_flush: window_flush::WindowFlushScheduler,
    pending_windows: Mutex<window_updates::WindowCaptures>,
    renderer_access: access::RendererAccess,
    ephemeral_windows: Mutex<HashSet<String>>,
    renderer_flush: RendererFlush,
    file_draft_readers: file_drafts::Readers,
    startup_commands: startup_command::StartupCommands,
    write_state: StateWriter,
    root_sync_pending: AtomicBool,
}

type StateWriter =
    std::sync::Arc<dyn Fn(&Path, &[u8], &dyn Fn() -> bool) -> Result<(), PublicationError> + Send + Sync>;

#[derive(Debug)]
enum PublicationError {
    BeforeRename(String),
    DirectorySync(String),
}

impl From<String> for PublicationError {
    fn from(error: String) -> Self {
        Self::BeforeRename(error)
    }
}

#[cfg(test)]
impl From<&str> for PublicationError {
    fn from(error: &str) -> Self {
        Self::BeforeRename(error.to_owned())
    }
}

impl From<PublicationError> for String {
    fn from(error: PublicationError) -> Self {
        match error {
            PublicationError::BeforeRename(error) => error,
            PublicationError::DirectorySync(error) => format!("Client state published; durability unconfirmed: {error}"),
        }
    }
}

impl ClientState {
    pub(crate) fn renderer_page_started(&self, window_id: &str, allowed_url: Option<&Url>) {
        self.renderer_access.page_started(window_id, allowed_url);
    }

    pub(crate) fn renderer_has_claimed(&self, window_id: &str) -> bool {
        self.renderer_access.is_claimed_for(window_id)
    }

    pub(crate) fn renderer_page_finished(&self, window_id: &str, webview: &tauri::Webview, url: &Url) {
        self.deliver_renderer_challenge(window_id, url, |script| { let _ = webview.eval(script); });
    }

    fn deliver_renderer_challenge(&self, window_id: &str, url: &Url, deliver: impl FnOnce(String)) {
        let Some(challenge) = self.renderer_access.document_challenge(window_id, url) else {
            return;
        };
        // Deliver into the committed document, never via an invoke that an
        // outgoing document could have queued before the navigation.
        deliver(format!(
            "window.__CODENOMAD_RESOLVE_CLIENT_STATE_DOCUMENT__?.('{challenge}');"
        ));
    }

    fn is_primary(&self) -> bool {
        self.process.is_primary()
    }

    pub(crate) fn is_primary_process(&self) -> bool {
        self.is_primary()
    }

    pub(crate) fn window_ids(&self) -> Vec<String> {
        self.state
            .lock()
            .map(|state| state.window_order.clone())
            .unwrap_or_default()
    }

    pub(crate) fn preferences(&self) -> Option<crate::preferences_window::PreferencesRequest> {
        if !self.is_primary() {
            return None;
        }
        self.state.lock().ok().and_then(|state| {
            (!state.unsupported_future_envelope)
                .then(|| state.preferences.clone())
                .flatten()
        })
    }

    pub(crate) fn set_preferences(
        &self,
        request: Option<crate::preferences_window::PreferencesRequest>,
    ) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        let clearing = request.is_none();
        let previous = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            if state.unsupported_future_envelope {
                return Ok(false);
            }
            if state.preferences == request && request.is_some() && !self.root_sync_pending.load(Ordering::Relaxed) {
                return Ok(true);
            }
            self.apply_window_captures(&mut state)?;
            let previous = (state.preferences.clone(), state.last_preferences.clone());
            if let Some(request) = &request {
                state.last_preferences = Some(crate::preferences_window::PreferencesRequest {
                    section: request.section.clone(),
                    scroll_top: request.scroll_top,
                    instance_id: None,
                    server_id: None,
                    workspace_path: None,
                    location: None,
                });
            }
            state.preferences = request;
            previous
        };
        if let Err(error) = self.write_current_state_guarded(&|| true) {
            if matches!(error, PublicationError::BeforeRename(_)) {
                let mut state = self.state.lock().map_err(|err| err.to_string())?;
                state.preferences = previous.0;
                state.last_preferences = previous.1;
            } else if clearing {
                // The close already removed the restore record from the published root.
                eprintln!("[client-state] {}", String::from(error));
                return Ok(true);
            }
            return Err(error.into());
        }
        Ok(true)
    }

    pub(crate) fn last_preferences(&self) -> Option<crate::preferences_window::PreferencesRequest> {
        if !self.is_primary() {
            return None;
        }
        self.state.lock().ok().and_then(|state| {
            (!state.unsupported_future_envelope)
                .then(|| state.last_preferences.clone())
                .flatten()
        })
    }

    pub(crate) fn active_window_id(&self) -> Result<String, String> {
        self.state
            .lock()
            .map(|state| state.active_window_id.clone())
            .map_err(|err| err.to_string())
    }

    fn claim_renderer_access(
        &self,
        window_id: &str,
        document: u64,
        access_token: &str,
        renderer_url: &Url,
    ) -> Result<(), String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        let persisted = self
            .state
            .lock()
            .map_err(|err| err.to_string())?
            .record(window_id)
            .is_ok();
        let ephemeral = self
            .ephemeral_windows
            .lock()
            .map_err(|err| err.to_string())?
            .contains(window_id);
        if !persisted && !ephemeral {
            return Err("Unknown client state window".to_string());
        }
        self.renderer_access
            .claim_in_document(window_id, document, access_token, renderer_url)
    }

    fn load(&self) -> Result<ClientStateLoadResult, String> {
        let window_id = self.active_window_id()?;
        self.load_window(&window_id)
    }

    fn load_window(&self, window_id: &str) -> Result<ClientStateLoadResult, String> {
        // Ownership validation reads the election files. Do not make native
        // capture wait for that I/O through the shared in-memory state mutex.
        let is_primary = self.is_primary();
        let state = self.state.lock().map_err(|err| err.to_string())?;
        let record = match state.record(window_id) {
            Ok(record) => record,
            Err(_error)
                if self
                    .ephemeral_windows
                    .lock()
                    .map_err(|err| err.to_string())?
                    .contains(window_id) =>
            {
                return Ok(ClientStateLoadResult {
                    is_primary: false,
                    restore_enabled: false,
                    snapshot: Value::Null,
                    partition_protocol_version: Some(partitions::PROTOCOL_VERSION),
                });
            }
            Err(error) => return Err(error),
        };
        Ok(ClientStateLoadResult {
            is_primary,
            restore_enabled: if is_primary || !self.process.is_registered() {
                record.restore_enabled
            } else {
                false
            },
            snapshot: if is_primary && record.restore_enabled {
                record.snapshot.clone().unwrap_or(Value::Null)
            } else {
                Value::Null
            },
            partition_protocol_version: Some(partitions::PROTOCOL_VERSION),
        })
    }

    #[cfg(test)]
    fn load_partition_guarded(
        &self,
        key: &str,
        access_valid: impl Fn() -> bool,
    ) -> Result<Option<String>, String> {
        let window_id = self.active_window_id()?;
        self.load_partition_guarded_for(&window_id, key, access_valid)
    }

    fn load_partition_guarded_for(
        &self,
        window_id: &str,
        key: &str,
        access_valid: impl Fn() -> bool,
    ) -> Result<Option<String>, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err(
                "Client state renderer authority changed before partition read".to_string(),
            );
        }
        if !partitions::valid_key(key) {
            return Err("Invalid client state partition key".to_string());
        }
        if !self.is_primary() {
            return Ok(None);
        }
        let state = self.state.lock().map_err(|err| err.to_string())?;
        let record = state.record(window_id)?;
        if !record.restore_enabled
            || !record.partition_root_supported
            || !record
                .partition_keys
                .as_ref()
                .is_some_and(|keys| keys.iter().any(|candidate| candidate == key))
        {
            return Ok(None);
        }
        drop(state);
        self.partition_store()
            .load(key, &|| self.is_primary() && access_valid())
    }

    #[cfg(test)]
    fn save_snapshot(&self, snapshot: Value) -> Result<bool, String> {
        let window_id = self.active_window_id()?;
        self.save_snapshot_guarded_for(&window_id, snapshot, || true)
    }

    fn save_snapshot_guarded(
        &self,
        snapshot: Value,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let window_id = self.active_window_id()?;
        self.save_snapshot_guarded_for(&window_id, snapshot, access_valid)
    }

    fn save_snapshot_guarded_for(
        &self,
        window_id: &str,
        snapshot: Value,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err("Client state renderer authority changed before mutation".to_string());
        }
        if !self.is_primary() {
            return Ok(false);
        }
        if self.normal_writes_suppressed(window_id)? {
            return Ok(true);
        }
        if serialized_value_size(&snapshot)? > MAX_CLIENT_SNAPSHOT_BYTES {
            return Err("Client snapshot exceeds the 1 MiB limit".to_string());
        }

        let result = self.mutate_and_write(
            window_id,
            |state| {
                let record = state.record_mut(window_id)?;
                record.snapshot = Some(snapshot);
                record.partition_protocol_version = None;
                record.partition_keys = None;
                record.partition_root_supported = false;
                Ok(())
            },
            &access_valid,
        )?;
        self.collect_partitions(&access_valid);
        Ok(result)
    }

    #[cfg(test)]
    fn commit_partitions_guarded(
        &self,
        payload: partitions::PartitionCommit,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let window_id = self.active_window_id()?;
        self.commit_partitions_guarded_for(&window_id, payload, access_valid)
    }

    fn commit_partitions_guarded_for(
        &self,
        window_id: &str,
        payload: partitions::PartitionCommit,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err("Client state renderer authority changed before mutation".to_string());
        }
        let commit = payload.validate()?;
        if !self.is_primary() {
            return Ok(false);
        }
        if self.normal_writes_suppressed(window_id)? {
            return Ok(true);
        }
        self.partition_store()
            .prepare(&commit, &|| self.is_primary() && access_valid())?;
        let snapshot = commit.snapshot.clone();
        let partition_keys = commit.partition_keys.clone();
        let result = self.mutate_and_write(
            window_id,
            |state| {
                let record = state.record_mut(window_id)?;
                record.snapshot = Some(snapshot);
                record.partition_protocol_version = Some(partitions::PROTOCOL_VERSION);
                record.partition_keys = Some(partition_keys);
                record.partition_root_supported = true;
                Ok(())
            },
            &access_valid,
        )?;
        self.collect_partitions(&access_valid);
        Ok(result)
    }

    fn collect_partitions(&self, access_valid: &dyn Fn() -> bool) {
        let Ok(retained) = self
            .state
            .lock()
            .map(|state| state.retained_partition_keys())
        else {
            return;
        };
        if let Err(err) = self
            .partition_store()
            .sweep(&retained, &|| self.is_primary() && access_valid())
        {
            eprintln!("[client-state] failed to sweep partitions: {err}");
        }
    }

    #[cfg(test)]
    fn set_restore_enabled(&self, enabled: bool) -> Result<bool, String> {
        let window_id = self.active_window_id()?;
        self.set_restore_enabled_guarded(&window_id, enabled, || true)
    }

    fn set_restore_enabled_guarded(
        &self,
        window_id: &str,
        enabled: bool,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err("Client state renderer authority changed before mutation".to_string());
        }
        if !self.is_primary() {
            return Ok(false);
        }
        if self
            .state
            .lock()
            .map_err(|err| err.to_string())?
            .unsupported_future_envelope
        {
            return Ok(false);
        }
        let result = self.mutate_and_write(
            window_id,
            |state| {
                let record = state.record_mut(window_id)?;
                record.restore_enabled = enabled;
                if !enabled {
                    record.snapshot = None;
                    record.window = None;
                    record.partition_protocol_version = None;
                    record.partition_keys = None;
                    record.partition_root_supported = false;
                }
                record.writes_enabled = enabled;
                Ok(())
            },
            &access_valid,
        )?;
        if !enabled {
            self.collect_partitions(&access_valid);
        }
        Ok(result)
    }

    #[cfg(test)]
    fn clear(&self) -> Result<bool, String> {
        let window_id = self.active_window_id()?;
        self.clear_guarded(&window_id, || true)
    }

    fn clear_guarded(
        &self,
        window_id: &str,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err("Client state renderer authority changed before mutation".to_string());
        }
        if !self.is_primary() {
            return Ok(false);
        }
        let result = self.mutate_and_write(
            window_id,
            |state| {
                let clearing_unsupported = state.unsupported_future_envelope;
                state.unsupported_future_envelope = false;
                let record = state.record_mut(window_id)?;
                if clearing_unsupported {
                    record.snapshot = None;
                    record.window = None;
                    record.partition_protocol_version = None;
                    record.partition_keys = None;
                    record.partition_root_supported = false;
                    record.writes_enabled = true;
                } else {
                    record.snapshot = None;
                    record.window = None;
                    record.partition_protocol_version = None;
                    record.partition_keys = None;
                    record.partition_root_supported = false;
                    record.writes_enabled = false;
                }
                Ok(())
            },
            &access_valid,
        )?;
        self.collect_partitions(&access_valid);
        Ok(result)
    }

    fn flush(&self) -> Result<(), String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if self.window_captures_stopped()? {
            return Ok(());
        }
        let unsupported = self
            .state
            .lock()
            .map_err(|err| err.to_string())?
            .unsupported_future_envelope;
        if self.is_primary() && !unsupported {
            {
                let mut state = self.state.lock().map_err(|err| err.to_string())?;
                self.apply_window_captures(&mut state)?;
            }
            self.write_current_state()?;
        }
        Ok(())
    }

    fn schedule_window_flush(&self, app: &AppHandle) {
        let app = app.clone();
        if let Err(error) = self.window_flush.schedule(move || {
            // Only persist captured data; never dispatch native getters from this worker.
            if let Some(state) = app.try_state::<ClientState>() {
                if let Err(error) = state.flush() {
                    eprintln!("[client-state] failed to save window state: {error}");
                }
            }
        }) {
            eprintln!("[client-state] failed to schedule window-state flush: {error}");
        }
    }

    fn normal_writes_suppressed(&self, window_id: &str) -> Result<bool, String> {
        let state = self.state.lock().map_err(|err| err.to_string())?;
        Ok(state.unsupported_future_envelope || !state.record(window_id)?.writes_enabled)
    }

    fn partition_store(&self) -> partitions::PartitionStore {
        partitions::PartitionStore::new(self.state_path.parent().unwrap_or(Path::new("")))
    }

    fn write_current_state(&self) -> Result<(), String> {
        self.write_current_state_guarded(&|| true).map_err(Into::into)
    }

    fn write_current_state_guarded(
        &self,
        replacement_valid: &dyn Fn() -> bool,
    ) -> Result<(), PublicationError> {
        let envelope = self.state.lock().map_err(|err| err.to_string())?.clone();
        let bytes = serde_json::to_vec(&envelope).map_err(|err| err.to_string())?;
        self.publish_root(&bytes, replacement_valid)?;
        // New events may already be queued, but only this serialized writer can
        // have merged captures into the state we just published.
        self.window_captures_published();
        Ok(())
    }

    // The writer lock serializes publication, durability repair and GC.
    fn publish_root(&self, bytes: &[u8], replacement_valid: &dyn Fn() -> bool) -> Result<(), PublicationError> {
        let result = (self.write_state)(&self.state_path, bytes, &|| self.is_primary() && replacement_valid());
        match result {
            Ok(()) => self.root_sync_pending.store(false, Ordering::Relaxed),
            Err(PublicationError::DirectorySync(_)) => self.root_sync_pending.store(true, Ordering::Relaxed),
            Err(PublicationError::BeforeRename(_)) => {}
        }
        result
    }

    fn mutate_and_write(
        &self,
        window_id: &str,
        mutate: impl FnOnce(&mut PersistedClientState) -> Result<(), String>,
        replacement_valid: &dyn Fn() -> bool,
    ) -> Result<bool, String> {
        let previous_state = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            // Preserve captures in rollback; arrivals during I/O stay in the mailbox.
            self.apply_window_captures(&mut state)?;
            let previous = state.clone();
            mutate(&mut state)?;
            self.preserve_window_capture_policy(&previous, window_id);
            previous
        };

        let result = self.write_current_state_guarded(replacement_valid);
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if matches!(result, Err(PublicationError::BeforeRename(_))) {
            *state = previous_state;
        }
        self.finish_window_capture_policy(&state, window_id);
        result.map(|()| true).map_err(Into::into)
    }

    pub(crate) fn can_register_window(&self) -> bool {
        self.process.has_primary_lock()
            && self.state.lock().is_ok_and(|state| !state.unsupported_future_envelope)
    }

    // The renderer FIFO is sealed before this final, fallible publication.
    pub(crate) fn prepare_ownership_release(&self) -> Result<(), String> {
        self.set_window_captures_stopped(true);
        self.window_flush.stop();
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        self.flush_pending_window_captures()
    }

    pub(crate) fn resume_window_captures(&self) {
        self.window_flush.resume();
        self.set_window_captures_stopped(false);
    }

    pub(crate) fn queue_new_window(app: &AppHandle, window_id: String) -> Result<(), String> {
        let worker = app.clone();
        app.state::<IpcQueue>()
            .enqueue(Box::new(move || {
                let state = worker.state::<Self>();
                match state.add_window(window_id.clone()) {
                    Ok(true) => {}
                    Ok(false) => state.discard_new_window_capture(&window_id),
                    Err(error) => {
                        // A directory-sync error has already promoted the record.
                        state.discard_new_window_capture(&window_id);
                        eprintln!("[client-state] failed to persist a new window: {error}");
                    }
                }
            }))
            .map_err(str::to_string)
    }

    pub(crate) fn remove_window_in_order(app: &AppHandle, window_id: String) -> Result<bool, String> {
        let worker = app.clone();
        let (done, reply) = std::sync::mpsc::sync_channel(1);
        app.state::<IpcQueue>().enqueue(Box::new(move || {
            let _ = done.send(worker.state::<Self>().remove_window(&window_id));
        }))?;
        reply.recv().map_err(|error| error.to_string())?
    }

    fn add_window(&self, window_id: String) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        let mut next = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            if state.unsupported_future_envelope {
                return Ok(false);
            }
            self.apply_window_captures(&mut state)?;
            state.clone()
        };
        // Keep the tentative record and serialization off the lock used by native window setup.
        next.add_window(window_id.clone())?;
        self.snapshot_new_window_capture(&mut next, &window_id)?;
        let bytes = serde_json::to_vec(&next).map_err(|err| err.to_string())?;
        let result = self.publish_root(&bytes, &|| true);
        if matches!(result, Err(PublicationError::BeforeRename(_))) {
            return result.map(|()| false).map_err(Into::into);
        }
        {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            *state = next;
            self.finish_new_window_capture(&state, &window_id);
        }
        if result.is_ok() {
            self.window_captures_published();
        }
        self.zoom_levels
            .lock()
            .map_err(|err| err.to_string())?
            .entry(window_id).or_insert(DEFAULT_ZOOM_LEVEL);
        result.map(|()| true).map_err(Into::into)
    }

    pub(crate) fn register_ephemeral_window(&self, window_id: String) {
        if let Ok(mut windows) = self.ephemeral_windows.lock() {
            windows.insert(window_id);
        }
    }

    pub(crate) fn unregister_window(&self, window_id: &str) {
        self.discard_new_window_capture(window_id);
        self.renderer_access.remove(window_id);
        if let Ok(mut readers) = self.file_draft_readers.lock() {
            readers.remove(window_id);
        }
        if let Ok(mut windows) = self.ephemeral_windows.lock() {
            windows.remove(window_id);
        }
        if let Ok(mut flushes) = self.renderer_flush.windows.lock() {
            flushes.remove(window_id);
        }
    }

    pub(crate) fn remove_window(&self, window_id: &str) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if self.state.lock().map_err(|err| err.to_string())?.record(window_id).is_err()
            && self.ephemeral_windows.lock().map_err(|err| err.to_string())?.contains(window_id)
        {
            return Ok(true);
        }
        if !self.is_primary() {
            return Ok(false);
        }
        let previous = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            if state.unsupported_future_envelope {
                return Ok(false);
            }
            self.apply_window_captures(&mut state)?;
            let previous = state.clone();
            if !state.remove_window(window_id)? {
                return Ok(false);
            }
            self.preserve_window_capture_policy(&previous, window_id);
            previous
        };
        let result = self.write_current_state_guarded(&|| true);
        {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            if matches!(result, Err(PublicationError::BeforeRename(_))) {
                *state = previous;
            }
            self.finish_window_capture_policy(&state, window_id);
        }
        if let Err(PublicationError::BeforeRename(error)) = result {
            return Err(error);
        }
        if let Ok(mut readers) = self.file_draft_readers.lock() {
            if let Some((generation, _)) = readers.get_mut(window_id) {
                // The renderer survives record removal while its workspace release runs.
                *generation = None;
            }
        }
        self.renderer_access.remove(window_id);
        self.zoom_levels
            .lock()
            .map_err(|err| err.to_string())?
            .remove(window_id);
        match result {
            Ok(()) => self.collect_partitions(&|| true),
            Err(error) => eprintln!("[client-state] {}", String::from(error)),
        }
        Ok(true)
    }

    fn release_locks(&self) {
        // Best effort when the state is being dropped outside orderly shutdown.
        if let Err(error) = self.prepare_ownership_release() {
            eprintln!("[client-state] failed to drain final window state: {error}");
        }
        self.finish_ownership_release();
    }

    fn finish_ownership_release(&self) {
        // Lock order fences takeover until root publication and partition GC leave write_lock.
        let _write = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        self.process.release_locks();
    }


}

impl Drop for ClientState {
    fn drop(&mut self) {
        self.release_locks();
    }
}

fn read_client_state(path: &Path) -> PersistedClientState {
    match fs::read(path) {
        Ok(bytes) => parse_client_state(&bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => PersistedClientState::default(),
        Err(err) => {
            eprintln!("[client-state] failed to read state: {err}");
            envelope::unsupported()
        }
    }
}

fn parse_client_state(bytes: &[u8]) -> PersistedClientState {
    envelope::parse(bytes)
}

fn serialized_value_size(value: &Value) -> Result<usize, String> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|err| err.to_string())
}

fn write_atomically(
    path: &Path,
    bytes: &[u8],
    ownership_valid: &dyn Fn() -> bool,
) -> Result<(), PublicationError> {
    write_atomically_with_sync(path, bytes, ownership_valid, partitions::sync_directory)
}

fn write_atomically_with_sync(
    path: &Path,
    bytes: &[u8],
    ownership_valid: &dyn Fn() -> bool,
    sync_directory: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), PublicationError> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("state path has no parent: {}", path.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|err| format!("failed to create temporary state file: {err}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|err| format!("failed to write temporary state file: {err}"))?;
    if !ownership_valid() {
        return Err("Client state ownership changed before atomic replacement".to_string().into());
    }
    temporary
        .persist(path)
        .map_err(|err| format!("failed to replace state file: {}", err.error))?;
    sync_directory(parent).map_err(PublicationError::DirectorySync)
}

pub fn release(app: &AppHandle) {
    if let Some(state) = app.try_state::<ClientState>() {
        state.finish_ownership_release();
    }
}

#[cfg(test)]
mod tests;
