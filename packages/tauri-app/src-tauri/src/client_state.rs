mod access;
mod commands;
mod cross_host;
mod navigation;
mod process;
mod window;

#[doc(hidden)]
pub use commands::{
    __cmd__client_state_claim_access, __cmd__client_state_clear, __cmd__client_state_load,
    __cmd__client_state_navigation_flushed, __cmd__client_state_renderer_flushed,
    __cmd__client_state_save, __cmd__client_state_set_restore_enabled,
};
pub use commands::{
    client_state_claim_access, client_state_clear, client_state_load,
    client_state_navigation_flushed, client_state_renderer_flushed, client_state_save,
    client_state_set_restore_enabled,
};
pub(crate) use navigation::{before_main_window_navigation, NavigationKind};
pub use window::{
    capture_and_flush_main_window, main_window_zoom, set_main_window_zoom, setup_main_window,
    DEFAULT_ZOOM_LEVEL,
};

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use window::NativeWindowState;

const CLIENT_STATE_VERSION: u64 = 1;
const CLIENT_STATE_FILENAME: &str = "client-state.json";
const MAX_CLIENT_SNAPSHOT_BYTES: usize = 1024 * 1024;
const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RendererFlushRequest {
    pub(crate) generation: u64,
}

#[derive(Default)]
struct RendererFlush {
    request_lock: Mutex<()>,
    next_generation: AtomicU64,
    acknowledged_generation: AtomicU64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedClientState {
    version: u64,
    restore_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window: Option<NativeWindowState>,
    #[serde(skip)]
    unsupported_future_envelope: bool,
    #[serde(skip)]
    writes_enabled: bool,
}

impl Default for PersistedClientState {
    fn default() -> Self {
        Self {
            version: CLIENT_STATE_VERSION,
            restore_enabled: true,
            snapshot: None,
            window: None,
            unsupported_future_envelope: false,
            writes_enabled: true,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStateLoadResult {
    is_primary: bool,
    restore_enabled: bool,
    snapshot: Value,
}

pub struct ClientState {
    state_path: PathBuf,
    process: process::ProcessState,
    state: Mutex<PersistedClientState>,
    zoom_level: Mutex<f64>,
    write_lock: Mutex<()>,
    save_generation: AtomicU64,
    renderer_access: access::RendererAccess,
    renderer_flush: RendererFlush,
    write_state: StateWriter,
}

type StateWriter =
    std::sync::Arc<dyn Fn(&Path, &[u8], &dyn Fn() -> bool) -> Result<(), String> + Send + Sync>;

impl ClientState {
    pub fn initialize(app: &AppHandle) -> Self {
        match app.path().app_data_dir() {
            Ok(app_data_dir) => match cross_host::election_directory() {
                Ok(election_dir) => {
                    let legacy_electron = cross_host::legacy_electron_data_directory();
                    Self::initialize_managed_at_with_election(
                        &app_data_dir,
                        &election_dir,
                        legacy_electron.as_deref(),
                    )
                }
                Err(err) => {
                    eprintln!("[client-state] initialization failed; restore disabled: {err}");
                    Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
                }
            },
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
        legacy_electron_data_dir: Option<&Path>,
    ) -> Self {
        Self::initialize_at_with_writer_and_election(
            app_data_dir,
            election_dir,
            legacy_electron_data_dir,
            std::sync::Arc::new(write_atomically),
        )
        .unwrap_or_else(|err| {
            eprintln!("[client-state] initialization failed; restore disabled: {err}");
            Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
        })
    }

    fn disabled(state_path: PathBuf) -> Self {
        let state = PersistedClientState {
            restore_enabled: false,
            writes_enabled: false,
            ..PersistedClientState::default()
        };
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
        let zoom_level = state
            .restore_enabled
            .then(|| state.window.as_ref().map(|window| window.zoom_factor))
            .flatten()
            .unwrap_or(DEFAULT_ZOOM_LEVEL);
        Self {
            state_path,
            process,
            state: Mutex::new(state),
            zoom_level: Mutex::new(zoom_level),
            write_lock: Mutex::new(()),
            save_generation: AtomicU64::new(0),
            renderer_access: access::RendererAccess::default(),
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
            None,
            write_state,
        )
    }

    fn initialize_at_with_writer_and_election(
        app_data_dir: &Path,
        election_dir: &Path,
        legacy_electron_data_dir: Option<&Path>,
        write_state: StateWriter,
    ) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|err| {
            format!(
                "failed to create app data directory {}: {err}",
                app_data_dir.display()
            )
        })?;

        let state_path = app_data_dir.join(CLIENT_STATE_FILENAME);
        let registration = process::Registration::initialize(
            app_data_dir,
            election_dir,
            legacy_electron_data_dir,
        )?;
        let state = if registration.is_primary() {
            read_client_state(&state_path)
        } else {
            PersistedClientState::default()
        };
        let process = registration.finish();
        Ok(Self::new(state_path, process, state, write_state))
    }

    fn is_primary(&self) -> bool {
        self.process.is_primary()
    }

    fn load(&self) -> Result<ClientStateLoadResult, String> {
        let state = self.state.lock().map_err(|err| err.to_string())?;
        let is_primary = self.is_primary();
        Ok(ClientStateLoadResult {
            is_primary,
            restore_enabled: if is_primary || !self.process.is_registered() {
                state.restore_enabled
            } else {
                true
            },
            snapshot: if is_primary && state.restore_enabled {
                state.snapshot.clone().unwrap_or(Value::Null)
            } else {
                Value::Null
            },
        })
    }

    fn save_snapshot(&self, snapshot: Value) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        if self.normal_writes_suppressed()? {
            return Ok(true);
        }
        if serialized_value_size(&snapshot)? > MAX_CLIENT_SNAPSHOT_BYTES {
            return Err("Client snapshot exceeds the 1 MiB limit".to_string());
        }

        self.mutate_and_write(|state| state.snapshot = Some(snapshot))
    }

    fn set_restore_enabled(&self, enabled: bool) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
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
        self.mutate_and_write(|state| {
            state.restore_enabled = enabled;
            if !enabled {
                state.snapshot = None;
                state.window = None;
            }
            state.writes_enabled = enabled;
        })
    }

    fn clear(&self) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        self.mutate_and_write(|state| {
            if state.unsupported_future_envelope {
                *state = PersistedClientState::default();
            } else {
                state.snapshot = None;
                state.window = None;
                state.writes_enabled = false;
            }
        })
    }

    fn flush(&self) -> Result<(), String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if self.is_primary() && !self.normal_writes_suppressed()? {
            self.write_current_state()?;
        }
        Ok(())
    }

    fn normal_writes_suppressed(&self) -> Result<bool, String> {
        self.state
            .lock()
            .map(|state| !state.writes_enabled || state.unsupported_future_envelope)
            .map_err(|err| err.to_string())
    }

    fn write_current_state(&self) -> Result<(), String> {
        let bytes = {
            let state = self.state.lock().map_err(|err| err.to_string())?;
            serde_json::to_vec(&*state).map_err(|err| err.to_string())?
        };
        (self.write_state)(&self.state_path, &bytes, &|| self.is_primary())?;
        Ok(())
    }

    fn mutate_and_write(
        &self,
        mutate: impl FnOnce(&mut PersistedClientState),
    ) -> Result<bool, String> {
        let previous_state = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            let previous = state.clone();
            mutate(&mut state);
            previous
        };

        match self.write_current_state() {
            Ok(()) => Ok(true),
            Err(err) => {
                *self.state.lock().map_err(|lock_err| lock_err.to_string())? = previous_state;
                Err(err)
            }
        }
    }

    fn release_locks(&self) {
        let _write = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        self.process.release_locks();
    }

    pub(crate) fn wait_for_renderer_flush(&self, app: &AppHandle, require_claim: bool) {
        let _request = self
            .renderer_flush
            .request_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if require_claim && !self.renderer_access.is_claimed() {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let generation = self
            .renderer_flush
            .next_generation
            .fetch_add(1, Ordering::SeqCst)
            + 1;
        if let Err(err) = window.emit(
            "client-state:navigation-flush-requested",
            RendererFlushRequest { generation },
        ) {
            eprintln!("[client-state] failed to request renderer flush: {err}");
            return;
        }

        let deadline = Instant::now() + RENDERER_FLUSH_TIMEOUT;
        while self.renderer_flush.next_generation.load(Ordering::SeqCst) == generation
            && self
                .renderer_flush
                .acknowledged_generation
                .load(Ordering::SeqCst)
                != generation
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn acknowledge_renderer_flush(&self, generation: u64) {
        if self.renderer_flush.next_generation.load(Ordering::SeqCst) == generation {
            self.renderer_flush
                .acknowledged_generation
                .store(generation, Ordering::SeqCst);
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
            PersistedClientState::default()
        }
    }
}

fn parse_client_state(bytes: &[u8]) -> PersistedClientState {
    let Ok(Value::Object(value)) = serde_json::from_slice::<Value>(bytes) else {
        return PersistedClientState::default();
    };
    let version = value.get("version").and_then(Value::as_u64);
    if version.is_some_and(|version| version > CLIENT_STATE_VERSION) {
        return PersistedClientState {
            unsupported_future_envelope: true,
            ..PersistedClientState::default()
        };
    }
    if version != Some(CLIENT_STATE_VERSION) {
        return PersistedClientState::default();
    }

    let snapshot = value.get("snapshot").cloned().filter(|snapshot| {
        serialized_value_size(snapshot)
            .map(|size| size <= MAX_CLIENT_SNAPSHOT_BYTES)
            .unwrap_or(false)
    });
    PersistedClientState {
        version: CLIENT_STATE_VERSION,
        restore_enabled: value
            .get("restoreEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        snapshot,
        window: value.get("window").and_then(window::normalize_window_state),
        unsupported_future_envelope: false,
        writes_enabled: value
            .get("restoreEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
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
    Ok(())
}

pub fn flush_and_release(app: &AppHandle) {
    window::capture_and_flush_main_window(app);
    if let Some(state) = app.try_state::<ClientState>() {
        state.release_locks();
    }
}

#[cfg(test)]
mod tests;
