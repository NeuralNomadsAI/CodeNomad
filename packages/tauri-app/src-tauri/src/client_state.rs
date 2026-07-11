mod access;
mod commands;
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use url::Url;
use window::NativeWindowState;

const CLIENT_STATE_VERSION: u64 = 1;
const CLIENT_STATE_FILENAME: &str = "client-state.json";
const MAX_CLIENT_SNAPSHOT_BYTES: usize = 1024 * 1024;

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
}

impl Default for PersistedClientState {
    fn default() -> Self {
        Self {
            version: CLIENT_STATE_VERSION,
            restore_enabled: true,
            snapshot: None,
            window: None,
            unsupported_future_envelope: false,
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
    persistence_suppressed: AtomicBool,
    renderer_access: access::RendererAccess,
    write_state: StateWriter,
}

type StateWriter = std::sync::Arc<dyn Fn(&Path, &[u8]) -> Result<(), String> + Send + Sync>;

impl ClientState {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
        Self::initialize_at(&app_data_dir)
    }

    fn initialize_at(app_data_dir: &Path) -> Result<Self, String> {
        Self::initialize_at_with_writer(app_data_dir, std::sync::Arc::new(write_atomically))
    }

    fn initialize_at_with_writer(
        app_data_dir: &Path,
        write_state: StateWriter,
    ) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|err| {
            format!(
                "failed to create app data directory {}: {err}",
                app_data_dir.display()
            )
        })?;

        let state_path = app_data_dir.join(CLIENT_STATE_FILENAME);
        let registration = process::Registration::initialize(app_data_dir)?;
        let state = if registration.is_primary() {
            read_client_state(&state_path)
        } else {
            PersistedClientState::default()
        };
        let zoom_level = if state.restore_enabled {
            state
                .window
                .as_ref()
                .map(|window| window.zoom_factor)
                .unwrap_or(DEFAULT_ZOOM_LEVEL)
        } else {
            DEFAULT_ZOOM_LEVEL
        };
        let process = registration.finish();

        Ok(Self {
            state_path,
            process,
            state: Mutex::new(state),
            zoom_level: Mutex::new(zoom_level),
            write_lock: Mutex::new(()),
            save_generation: AtomicU64::new(0),
            persistence_suppressed: AtomicBool::new(false),
            renderer_access: access::RendererAccess::default(),
            write_state,
        })
    }

    fn is_primary(&self) -> bool {
        self.process.is_primary()
    }

    fn load(&self) -> Result<ClientStateLoadResult, String> {
        if !self.is_primary() {
            return Ok(ClientStateLoadResult {
                is_primary: false,
                restore_enabled: true,
                snapshot: Value::Null,
            });
        }

        let state = self.state.lock().map_err(|err| err.to_string())?;
        Ok(ClientStateLoadResult {
            is_primary: true,
            restore_enabled: state.restore_enabled,
            snapshot: if state.restore_enabled {
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

        self.state.lock().map_err(|err| err.to_string())?.snapshot = Some(snapshot);
        self.write_current_state()
    }

    fn set_restore_enabled(&self, enabled: bool) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !self.is_primary() {
            return Ok(false);
        }
        if self.has_unsupported_future_envelope()? {
            return Ok(false);
        }
        self.mutate_and_write(|state| {
            state.restore_enabled = enabled;
            if !enabled {
                state.snapshot = None;
                state.window = None;
            }
            self.persistence_suppressed
                .store(!enabled, Ordering::SeqCst);
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
                self.persistence_suppressed.store(false, Ordering::SeqCst);
            } else {
                state.snapshot = None;
                state.window = None;
                self.persistence_suppressed.store(true, Ordering::SeqCst);
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

    fn has_unsupported_future_envelope(&self) -> Result<bool, String> {
        self.state
            .lock()
            .map(|state| state.unsupported_future_envelope)
            .map_err(|err| err.to_string())
    }

    fn normal_writes_suppressed(&self) -> Result<bool, String> {
        Ok(self.persistence_suppressed.load(Ordering::SeqCst)
            || self.has_unsupported_future_envelope()?)
    }

    fn claim_renderer_access(&self, access_token: &str, renderer_url: &Url) -> Result<(), String> {
        self.renderer_access.claim(access_token, renderer_url)
    }

    fn validate_renderer_access(
        &self,
        access_token: &str,
        renderer_url: &Url,
    ) -> Result<(), String> {
        self.renderer_access.validate(access_token, renderer_url)
    }

    fn renderer_origin_can_claim(&self, renderer_url: &Url) -> bool {
        self.renderer_access.allows_claim_origin(renderer_url)
    }

    fn begin_renderer_navigation(&self, target_url: Option<&Url>) -> Result<(), String> {
        self.renderer_access.begin_navigation(target_url)
    }

    fn cancel_renderer_navigation(&self) {
        self.renderer_access.cancel_navigation();
    }

    fn renderer_access_is_claimed(&self) -> bool {
        self.renderer_access.is_claimed()
    }

    fn write_current_state(&self) -> Result<bool, String> {
        let bytes = {
            let state = self.state.lock().map_err(|err| err.to_string())?;
            serde_json::to_vec(&*state).map_err(|err| err.to_string())?
        };
        (self.write_state)(&self.state_path, &bytes)?;
        Ok(true)
    }

    fn mutate_and_write(
        &self,
        mutate: impl FnOnce(&mut PersistedClientState),
    ) -> Result<bool, String> {
        let previous_persistence_suppressed = self.persistence_suppressed.load(Ordering::SeqCst);
        let previous_state = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            let previous = state.clone();
            mutate(&mut state);
            previous
        };

        match self.write_current_state() {
            Ok(written) => Ok(written),
            Err(err) => {
                *self.state.lock().map_err(|lock_err| lock_err.to_string())? = previous_state;
                self.persistence_suppressed
                    .store(previous_persistence_suppressed, Ordering::SeqCst);
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
    }
}

fn serialized_value_size(value: &Value) -> Result<usize, String> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|err| err.to_string())
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("state path has no parent: {}", path.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|err| format!("failed to create temporary state file: {err}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|err| format!("failed to write temporary state file: {err}"))?;
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
