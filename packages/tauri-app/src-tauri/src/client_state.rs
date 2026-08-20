mod access;
mod commands;
mod cross_host;
mod envelope;
mod navigation;
mod partitions;
mod process;
mod window;

#[doc(hidden)]
pub use commands::{
    __cmd__client_state_claim_access, __cmd__client_state_clear,
    __cmd__client_state_commit_partitions, __cmd__client_state_load,
    __cmd__client_state_load_partition, __cmd__client_state_navigation_flushed,
    __cmd__client_state_renderer_flushed, __cmd__client_state_save,
    __cmd__client_state_set_restore_enabled,
};
pub use commands::{
    client_state_claim_access, client_state_clear, client_state_commit_partitions,
    client_state_load, client_state_load_partition, client_state_navigation_flushed,
    client_state_renderer_flushed, client_state_save, client_state_set_restore_enabled,
};
pub(crate) use navigation::{
    before_window_navigation, before_window_navigation_if, NavigationKind,
};
pub use window::{
    capture_and_flush_all_windows, capture_and_flush_window, local_window_zoom,
    set_local_window_zoom, setup_local_window, DEFAULT_ZOOM_LEVEL,
};

use envelope::PersistedClientState;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

const CLIENT_STATE_FILENAME: &str = "client-state.json";
const MAX_CLIENT_SNAPSHOT_BYTES: usize = envelope::MAX_SNAPSHOT_BYTES;
const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RendererFlushRequest {
    pub(crate) generation: u64,
}

#[derive(Default)]
struct RendererFlush {
    request_lock: Mutex<()>,
    windows: Mutex<HashMap<String, (u64, u64)>>,
}

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
    save_generation: AtomicU64,
    renderer_access: access::RendererAccess,
    ephemeral_windows: Mutex<HashSet<String>>,
    renderer_flush: RendererFlush,
    write_state: StateWriter,
}

type StateWriter =
    std::sync::Arc<dyn Fn(&Path, &[u8], &dyn Fn() -> bool) -> Result<(), String> + Send + Sync>;

impl ClientState {
    pub(crate) fn stage_renderer_page_load(
        &self,
        window_id: &str,
        url: &Url,
    ) -> Result<(), String> {
        self.renderer_access
            .begin_navigation_for(window_id, Some(url))
            .map(|_| ())
    }

    pub fn initialize(app: &AppHandle, scoped_client_state_directory: Option<&Path>) -> Self {
        match app.path().app_data_dir() {
            Ok(app_data_dir) => {
                let paths = scoped_client_state_directory
                    .map(|directory| {
                        (
                            Ok(directory.join("election")),
                            Ok(directory.join(CLIENT_STATE_FILENAME)),
                            Ok(None),
                        )
                    })
                    .unwrap_or_else(|| {
                        (
                            cross_host::election_directory(),
                            cross_host::state_path(),
                            cross_host::legacy_state_path().map(Some),
                        )
                    });
                match paths {
                    (Ok(election_dir), Ok(state_path), Ok(legacy_state_path)) => {
                        let legacy_electron = scoped_client_state_directory
                            .is_none()
                            .then(cross_host::legacy_electron_data_directory)
                            .flatten();
                        Self::initialize_managed_at_with_election(
                            &app_data_dir,
                            &election_dir,
                            &state_path,
                            legacy_state_path.as_deref(),
                            legacy_electron.as_deref(),
                        )
                    }
                    (Err(err), _, _) | (_, Err(err), _) | (_, _, Err(err)) => {
                        eprintln!("[client-state] initialization failed; restore disabled: {err}");
                        Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
                    }
                }
            }
            Err(err) => {
                eprintln!("[client-state] initialization failed; restore disabled: {err}");
                Self::disabled(PathBuf::new())
            }
        }
    }

    #[cfg(test)]
    fn initialize_managed_at(app_data_dir: &Path) -> Self {
        Self::initialize_at(app_data_dir).unwrap_or_else(|err| {
            eprintln!("[client-state] initialization failed; restore disabled: {err}");
            Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
        })
    }

    fn initialize_managed_at_with_election(
        app_data_dir: &Path,
        election_dir: &Path,
        state_path: &Path,
        legacy_shared_state_path: Option<&Path>,
        legacy_electron_data_dir: Option<&Path>,
    ) -> Self {
        Self::initialize_at_with_writer_and_election(
            app_data_dir,
            election_dir,
            state_path,
            legacy_shared_state_path,
            legacy_electron_data_dir,
            std::sync::Arc::new(write_atomically),
        )
        .unwrap_or_else(|err| {
            eprintln!("[client-state] initialization failed; restore disabled: {err}");
            Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
        })
    }

    fn disabled(state_path: PathBuf) -> Self {
        let mut state = PersistedClientState::default();
        let record = state.active_mut();
        record.restore_enabled = false;
        record.writes_enabled = false;
        Self::new(
            state_path,
            process::ProcessState::disabled(),
            state,
            std::sync::Arc::new(write_atomically),
        )
    }

    fn new(
        state_path: PathBuf,
        process: process::ProcessState,
        state: PersistedClientState,
        write_state: StateWriter,
    ) -> Self {
        let zoom_levels = state
            .window_order
            .iter()
            .map(|id| {
                let record = state.windows.get(id).expect("validated window order");
                let zoom = record
                    .restore_enabled
                    .then(|| record.window.as_ref().map(|window| window.zoom_factor))
                    .flatten()
                    .unwrap_or(DEFAULT_ZOOM_LEVEL);
                (id.clone(), zoom)
            })
            .collect();
        Self {
            state_path,
            process,
            state: Mutex::new(state),
            zoom_levels: Mutex::new(zoom_levels),
            write_lock: Mutex::new(()),
            save_generation: AtomicU64::new(0),
            renderer_access: access::RendererAccess::default(),
            ephemeral_windows: Mutex::new(HashSet::new()),
            renderer_flush: RendererFlush::default(),
            write_state,
        }
    }

    #[cfg(test)]
    fn initialize_at(app_data_dir: &Path) -> Result<Self, String> {
        Self::initialize_at_with_writer(app_data_dir, std::sync::Arc::new(write_atomically))
    }

    #[cfg(test)]
    fn initialize_at_with_writer(
        app_data_dir: &Path,
        write_state: StateWriter,
    ) -> Result<Self, String> {
        Self::initialize_at_with_writer_and_election(
            app_data_dir,
            &app_data_dir.join(".cross-host-election"),
            &app_data_dir.join(CLIENT_STATE_FILENAME),
            None,
            None,
            write_state,
        )
    }

    fn initialize_at_with_writer_and_election(
        app_data_dir: &Path,
        election_dir: &Path,
        state_path: &Path,
        legacy_shared_state_path: Option<&Path>,
        legacy_electron_data_dir: Option<&Path>,
        write_state: StateWriter,
    ) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|err| {
            format!(
                "failed to create app data directory {}: {err}",
                app_data_dir.display()
            )
        })?;

        let registration = process::Registration::initialize(
            app_data_dir,
            election_dir,
            legacy_electron_data_dir,
        )?;
        if registration.is_primary() && !state_path.exists() {
            if let Some(legacy_path) = legacy_shared_state_path {
                copy_legacy_shared_state(legacy_path, state_path, &|| registration.is_primary())?;
            }
        }
        let future_legacy =
            !state_path.exists() && has_future_legacy_state(app_data_dir, legacy_electron_data_dir);
        if registration.is_primary() && !state_path.exists() && !future_legacy {
            migrate_legacy_state(state_path, app_data_dir, legacy_electron_data_dir, &|| {
                registration.is_primary()
            })?;
        }
        let state = if registration.is_primary() {
            if future_legacy {
                envelope::unsupported()
            } else {
                read_client_state(state_path)
            }
        } else {
            PersistedClientState::default()
        };
        let process = registration.finish();
        Ok(Self::new(
            state_path.to_path_buf(),
            process,
            state,
            write_state,
        ))
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

    pub(crate) fn set_active_window(&self, window_id: &str) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        let previous = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            if state.unsupported_future_envelope || state.active_window_id == window_id {
                return Ok(!state.unsupported_future_envelope);
            }
            state.record(window_id)?;
            let previous = state.active_window_id.clone();
            state.active_window_id = window_id.to_string();
            previous
        };
        if let Err(error) = self.write_current_state() {
            self.state
                .lock()
                .map_err(|err| err.to_string())?
                .active_window_id = previous;
            return Err(error);
        }
        Ok(true)
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
            .claim_for(window_id, access_token, renderer_url)
    }

    fn load(&self) -> Result<ClientStateLoadResult, String> {
        let window_id = self.active_window_id()?;
        self.load_window(&window_id)
    }

    fn load_window(&self, window_id: &str) -> Result<ClientStateLoadResult, String> {
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
        let is_primary = self.is_primary();
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
        let retained = self
            .state
            .lock()
            .map(|state| state.retained_partition_keys())
            .unwrap_or_default();
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
        let unsupported = self
            .state
            .lock()
            .map_err(|err| err.to_string())?
            .unsupported_future_envelope;
        if self.is_primary() && !unsupported {
            self.write_current_state()?;
        }
        Ok(())
    }

    fn normal_writes_suppressed(&self, window_id: &str) -> Result<bool, String> {
        let state = self.state.lock().map_err(|err| err.to_string())?;
        Ok(state.unsupported_future_envelope || !state.record(window_id)?.writes_enabled)
    }

    fn partition_store(&self) -> partitions::PartitionStore {
        partitions::PartitionStore::new(self.state_path.parent().unwrap_or(Path::new("")))
    }

    fn write_current_state(&self) -> Result<(), String> {
        self.write_current_state_guarded(&|| true)
    }

    fn write_current_state_guarded(
        &self,
        replacement_valid: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        let bytes = {
            let state = self.state.lock().map_err(|err| err.to_string())?;
            serde_json::to_vec(&*state).map_err(|err| err.to_string())?
        };
        (self.write_state)(&self.state_path, &bytes, &|| {
            self.is_primary() && replacement_valid()
        })?;
        Ok(())
    }

    fn mutate_and_write(
        &self,
        _window_id: &str,
        mutate: impl FnOnce(&mut PersistedClientState) -> Result<(), String>,
        replacement_valid: &dyn Fn() -> bool,
    ) -> Result<bool, String> {
        let previous_state = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            let previous = state.clone();
            mutate(&mut state)?;
            previous
        };

        match self.write_current_state_guarded(replacement_valid) {
            Ok(()) => Ok(true),
            Err(err) => {
                *self.state.lock().map_err(|lock_err| lock_err.to_string())? = previous_state;
                Err(err)
            }
        }
    }

    pub(crate) fn add_window(&self, window_id: String) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        let previous = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            if state.unsupported_future_envelope {
                return Ok(false);
            }
            let previous = state.clone();
            state.add_window(window_id.clone())?;
            previous
        };
        if let Err(err) = self.write_current_state() {
            *self.state.lock().map_err(|lock_err| lock_err.to_string())? = previous;
            return Err(err);
        }
        self.zoom_levels
            .lock()
            .map_err(|err| err.to_string())?
            .insert(window_id, DEFAULT_ZOOM_LEVEL);
        Ok(true)
    }

    pub(crate) fn register_ephemeral_window(&self, window_id: String) {
        if let Ok(mut windows) = self.ephemeral_windows.lock() {
            windows.insert(window_id);
        }
    }

    pub(crate) fn unregister_window(&self, window_id: &str) {
        self.renderer_access.remove(window_id);
        if let Ok(mut windows) = self.ephemeral_windows.lock() {
            windows.remove(window_id);
        }
        if let Ok(mut flushes) = self.renderer_flush.windows.lock() {
            flushes.remove(window_id);
        }
    }

    pub(crate) fn remove_window(&self, window_id: &str) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        let previous = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            if state.unsupported_future_envelope {
                return Ok(false);
            }
            let previous = state.clone();
            if !state.remove_window(window_id)? {
                return Ok(false);
            }
            previous
        };
        if let Err(err) = self.write_current_state() {
            *self.state.lock().map_err(|lock_err| lock_err.to_string())? = previous;
            return Err(err);
        }
        self.renderer_access.remove(window_id);
        self.zoom_levels
            .lock()
            .map_err(|err| err.to_string())?
            .remove(window_id);
        self.collect_partitions(&|| true);
        Ok(true)
    }

    fn release_locks(&self) {
        // Lock order fences takeover until root publication and partition GC leave write_lock.
        let _write = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        self.process.release_locks();
    }

    pub(crate) fn wait_for_renderer_flush(
        &self,
        app: &AppHandle,
        window_label: &str,
        window_id: &str,
        require_claim: bool,
    ) {
        let _request = self
            .renderer_flush
            .request_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if require_claim && !self.renderer_access.is_claimed_for(window_id) {
            return;
        }
        let Some(window) = app.get_webview_window(window_label) else {
            return;
        };
        let generation = {
            let mut windows = self
                .renderer_flush
                .windows
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let state = windows.entry(window_id.to_string()).or_default();
            state.0 += 1;
            state.0
        };
        if let Err(err) = window.emit(
            "client-state:navigation-flush-requested",
            RendererFlushRequest { generation },
        ) {
            eprintln!("[client-state] failed to request renderer flush: {err}");
            return;
        }

        let deadline = Instant::now() + RENDERER_FLUSH_TIMEOUT;
        while self
            .renderer_flush
            .windows
            .lock()
            .ok()
            .and_then(|windows| windows.get(window_id).copied())
            .is_some_and(|state| state.0 == generation && state.1 != generation)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn acknowledge_renderer_flush(&self, window_id: &str, generation: u64) {
        if let Ok(mut windows) = self.renderer_flush.windows.lock() {
            if let Some(state) = windows.get_mut(window_id) {
                if state.0 == generation {
                    state.1 = generation;
                }
            }
        }
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

fn legacy_candidate(
    path: &Path,
    host: &'static str,
) -> Option<(PersistedClientState, bool, i64, &'static str)> {
    let bytes = fs::read(path).ok()?;
    let Value::Object(value) = serde_json::from_slice::<Value>(&bytes).ok()? else {
        return None;
    };
    if value
        .get("version")
        .and_then(envelope::exact_nonnegative_safe_integer)
        != Some(envelope::LEGACY_MONOLITHIC_VERSION)
    {
        return None;
    }
    let saved_at = value
        .get("snapshot")
        .and_then(Value::as_object)
        .and_then(|snapshot| snapshot.get("savedAt"))
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    let mut parsed = parse_client_state(&bytes);
    if parsed.unsupported_future_envelope {
        return None;
    }
    parsed.active_mut().window = None;
    Some((parsed, value.contains_key("snapshot"), saved_at, host))
}

fn has_future_legacy_state(tauri_data_dir: &Path, electron_data_dir: Option<&Path>) -> bool {
    [
        electron_data_dir.map(|path| path.join(CLIENT_STATE_FILENAME)),
        Some(tauri_data_dir.join(CLIENT_STATE_FILENAME)),
    ]
    .into_iter()
    .flatten()
    .any(|path| {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("version")
                    .and_then(envelope::exact_nonnegative_safe_integer)
            })
            .is_some_and(|version| version > envelope::LEGACY_MONOLITHIC_VERSION)
    })
}

fn migrate_legacy_state(
    state_path: &Path,
    tauri_data_dir: &Path,
    electron_data_dir: Option<&Path>,
    ownership_valid: &dyn Fn() -> bool,
) -> Result<(), String> {
    let mut candidates = [
        electron_data_dir
            .and_then(|path| legacy_candidate(&path.join(CLIENT_STATE_FILENAME), "electron")),
        legacy_candidate(&tauri_data_dir.join(CLIENT_STATE_FILENAME), "tauri"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.0
            .active()
            .restore_enabled
            .cmp(&right.0.active().restore_enabled)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| right.3.cmp(left.3))
    });
    let Some((state, _, _, _)) = candidates.first() else {
        return Ok(());
    };
    let record = state.active();
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyState<'a> {
        version: u64,
        restore_enabled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<&'a Value>,
    }
    let bytes = serde_json::to_vec(&LegacyState {
        version: envelope::LEGACY_MONOLITHIC_VERSION,
        restore_enabled: record.restore_enabled,
        snapshot: record.snapshot.as_ref(),
    })
    .map_err(|err| err.to_string())?;
    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create shared client-state directory: {err}"))?;
    }
    write_atomically(state_path, &bytes, ownership_valid)?;
    Ok(())
}

fn copy_legacy_shared_state(
    legacy_path: &Path,
    state_path: &Path,
    ownership_valid: &dyn Fn() -> bool,
) -> Result<(), String> {
    if state_path.exists() {
        return Ok(());
    }
    let bytes = match fs::read(legacy_path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("failed to read legacy shared client state: {err}")),
    };
    let version = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("version")
                .and_then(envelope::exact_nonnegative_safe_integer)
        });
    if version != Some(envelope::LEGACY_MONOLITHIC_VERSION)
        || parse_client_state(&bytes).unsupported_future_envelope
    {
        return Ok(());
    }
    let parent = state_path
        .parent()
        .ok_or_else(|| format!("state path has no parent: {}", state_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create shared client-state directory: {err}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|err| format!("failed to create temporary state file: {err}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|err| format!("failed to copy legacy shared client state: {err}"))?;
    if !ownership_valid() {
        return Err("Client state ownership changed before atomic replacement".to_string());
    }
    match temporary.persist_noclobber(state_path) {
        Ok(_) => partitions::sync_directory(parent),
        Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(format!(
            "failed to publish copied legacy shared client state: {}",
            err.error
        )),
    }
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
) -> Result<(), String> {
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
        return Err("Client state ownership changed before atomic replacement".to_string());
    }
    temporary
        .persist(path)
        .map_err(|err| format!("failed to replace state file: {}", err.error))?;
    partitions::sync_directory(parent)?;
    Ok(())
}

pub fn release(app: &AppHandle) {
    if let Some(state) = app.try_state::<ClientState>() {
        state.release_locks();
    }
}

pub fn flush_and_release_without_window_capture(app: &AppHandle) {
    if let Some(state) = app.try_state::<ClientState>() {
        if let Err(err) = state.flush() {
            eprintln!("[client-state] failed to flush state: {err}");
        }
        state.release_locks();
    }
}

#[cfg(test)]
mod tests;
