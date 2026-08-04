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
pub(crate) use navigation::{
    before_main_window_navigation, before_main_window_navigation_if, NavigationKind,
};
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
use url::Url;
use window::NativeWindowState;

const CLIENT_STATE_VERSION: u64 = 1;
const CLIENT_STATE_FILENAME: &str = "client-state.json";
const CLIENT_STATE_OWNERSHIP_CHANGED_EVENT: &str = "client-state:ownership-changed";
const MAX_CLIENT_SNAPSHOT_BYTES: usize = 1024 * 1024;
const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
const OWNERSHIP_POLL_INTERVAL: Duration = Duration::from_millis(250);

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
    migration_paths: Option<(PathBuf, Option<PathBuf>)>,
    process: process::ProcessState,
    state: Mutex<PersistedClientState>,
    zoom_level: Mutex<f64>,
    write_lock: Mutex<()>,
    primary_loaded: std::sync::atomic::AtomicBool,
    renderer_reload_pending: std::sync::atomic::AtomicBool,
    renderer_reconciliation_pending: std::sync::atomic::AtomicBool,
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
            Ok(app_data_dir) => {
                match (cross_host::election_directory(), cross_host::state_path()) {
                    (Ok(election_dir), Ok(state_path)) => {
                        let legacy_electron = cross_host::legacy_electron_data_directory();
                        Self::initialize_managed_at_with_election(
                            &app_data_dir,
                            &election_dir,
                            &state_path,
                            legacy_electron.as_deref(),
                        )
                    }
                    (Err(err), _) | (_, Err(err)) => {
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
        legacy_electron_data_dir: Option<&Path>,
    ) -> Self {
        Self::initialize_at_with_writer_and_election(
            app_data_dir,
            election_dir,
            state_path,
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
            None,
            process::ProcessState::disabled(),
            state,
            false,
            std::sync::Arc::new(write_atomically),
        )
    }

    fn new(
        state_path: PathBuf,
        migration_paths: Option<(PathBuf, Option<PathBuf>)>,
        process: process::ProcessState,
        state: PersistedClientState,
        primary_loaded: bool,
        write_state: StateWriter,
    ) -> Self {
        let zoom_level = state
            .restore_enabled
            .then(|| state.window.as_ref().map(|window| window.zoom_factor))
            .flatten()
            .unwrap_or(DEFAULT_ZOOM_LEVEL);
        Self {
            state_path,
            migration_paths,
            process,
            state: Mutex::new(state),
            zoom_level: Mutex::new(zoom_level),
            write_lock: Mutex::new(()),
            primary_loaded: std::sync::atomic::AtomicBool::new(primary_loaded),
            renderer_reload_pending: std::sync::atomic::AtomicBool::new(false),
            renderer_reconciliation_pending: std::sync::atomic::AtomicBool::new(false),
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
            &app_data_dir.join(CLIENT_STATE_FILENAME),
            None,
            write_state,
        )
    }

    fn initialize_at_with_writer_and_election(
        app_data_dir: &Path,
        election_dir: &Path,
        state_path: &Path,
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
        let primary = registration.is_primary();
        let state = if primary {
            load_primary_state(state_path, app_data_dir, legacy_electron_data_dir, &|| {
                registration.ownership_valid()
            })?
        } else {
            PersistedClientState::default()
        };
        let process = registration.finish();
        Ok(Self::new(
            state_path.to_path_buf(),
            Some((
                app_data_dir.to_path_buf(),
                legacy_electron_data_dir.map(Path::to_path_buf),
            )),
            process,
            state,
            primary,
            write_state,
        ))
    }

    fn is_primary(&self) -> bool {
        let primary = self.process.is_primary();
        if !primary {
            self.primary_loaded.store(false, Ordering::SeqCst);
        }
        primary
    }

    fn refresh_primary_locked(
        &self,
        _write: &std::sync::MutexGuard<'_, ()>,
    ) -> Result<bool, String> {
        if !self.process.refresh_primary() {
            self.primary_loaded.store(false, Ordering::SeqCst);
            return Ok(false);
        }
        if !self.primary_loaded.load(Ordering::SeqCst) {
            let state = if let Some((tauri_data_dir, electron_data_dir)) = &self.migration_paths {
                load_primary_state(
                    &self.state_path,
                    tauri_data_dir,
                    electron_data_dir.as_deref(),
                    &|| self.process.is_primary(),
                )
            } else {
                read_client_state(&self.state_path)
            };
            let state = match state {
                Ok(state) => state,
                Err(err) => {
                    self.process.defer_primary();
                    return Err(err);
                }
            };
            let zoom_level = state
                .restore_enabled
                .then(|| state.window.as_ref().map(|window| window.zoom_factor))
                .flatten()
                .unwrap_or(DEFAULT_ZOOM_LEVEL);
            *self.state.lock().map_err(|err| err.to_string())? = state;
            *self.zoom_level.lock().map_err(|err| err.to_string())? = zoom_level;
            self.primary_loaded.store(true, Ordering::SeqCst);
            self.renderer_reload_pending.store(true, Ordering::SeqCst);
            self.renderer_reconciliation_pending
                .store(true, Ordering::SeqCst);
        }
        Ok(true)
    }

    fn refresh_primary_for_watcher(&self) -> Result<bool, String> {
        let write = self.write_lock.lock().map_err(|err| err.to_string())?;
        let was_loaded = self.primary_loaded.load(Ordering::SeqCst);
        Ok(self.refresh_primary_locked(&write)? && !was_loaded)
    }

    fn take_renderer_reload(&self) -> bool {
        self.renderer_reload_pending.swap(false, Ordering::SeqCst)
    }

    fn claim_renderer_access(&self, access_token: &str, renderer_url: &Url) -> Result<(), String> {
        self.renderer_access.claim(access_token, renderer_url)
    }

    fn begin_renderer_document(&self, renderer_url: &Url) -> Result<(), String> {
        self.renderer_access
            .begin_navigation(Some(renderer_url))
            .map(drop)
    }

    fn load(&self) -> Result<ClientStateLoadResult, String> {
        let write = self.write_lock.lock().map_err(|err| err.to_string())?;
        let is_primary = self.refresh_primary_locked(&write)?;
        let state = self.state.lock().map_err(|err| err.to_string())?;
        let result = ClientStateLoadResult {
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
        };
        if is_primary {
            self.renderer_reconciliation_pending
                .store(false, Ordering::SeqCst);
        }
        Ok(result)
    }

    #[cfg(test)]
    fn save_snapshot(&self, snapshot: Value) -> Result<bool, String> {
        self.save_snapshot_guarded(snapshot, || true)
    }

    fn save_snapshot_guarded(
        &self,
        snapshot: Value,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err("Client state renderer authority changed before mutation".to_string());
        }
        let was_loaded = self.primary_loaded.load(Ordering::SeqCst);
        if !self.refresh_primary_locked(&write)? {
            return Ok(false);
        }
        if !was_loaded {
            return Ok(false);
        }
        if self.renderer_reconciliation_pending.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if self.normal_writes_suppressed()? {
            return Ok(true);
        }
        if serialized_value_size(&snapshot)? > MAX_CLIENT_SNAPSHOT_BYTES {
            return Err("Client snapshot exceeds the 1 MiB limit".to_string());
        }

        self.mutate_and_write(|state| state.snapshot = Some(snapshot), &access_valid)
    }

    #[cfg(test)]
    fn set_restore_enabled(&self, enabled: bool) -> Result<bool, String> {
        self.set_restore_enabled_guarded(enabled, || true)
    }

    fn set_restore_enabled_guarded(
        &self,
        enabled: bool,
        access_valid: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err("Client state renderer authority changed before mutation".to_string());
        }
        let was_loaded = self.primary_loaded.load(Ordering::SeqCst);
        if !self.refresh_primary_locked(&write)? {
            return Ok(false);
        }
        if !was_loaded {
            return Ok(false);
        }
        if self.renderer_reconciliation_pending.load(Ordering::SeqCst) {
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
        self.mutate_and_write(
            |state| {
                state.restore_enabled = enabled;
                if !enabled {
                    state.snapshot = None;
                    state.window = None;
                }
                state.writes_enabled = enabled;
            },
            &access_valid,
        )
    }

    #[cfg(test)]
    fn clear(&self) -> Result<bool, String> {
        self.clear_guarded(|| true)
    }

    fn clear_guarded(&self, access_valid: impl Fn() -> bool) -> Result<bool, String> {
        let write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if !access_valid() {
            return Err("Client state renderer authority changed before mutation".to_string());
        }
        let was_loaded = self.primary_loaded.load(Ordering::SeqCst);
        if !self.refresh_primary_locked(&write)? {
            return Ok(false);
        }
        if !was_loaded {
            return Ok(false);
        }
        if self.renderer_reconciliation_pending.load(Ordering::SeqCst) {
            return Ok(false);
        }
        self.mutate_and_write(
            |state| {
                if state.unsupported_future_envelope {
                    *state = PersistedClientState::default();
                } else {
                    state.snapshot = None;
                    state.window = None;
                    state.writes_enabled = false;
                }
            },
            &access_valid,
        )
    }

    fn flush(&self) -> Result<(), String> {
        let write = self.write_lock.lock().map_err(|err| err.to_string())?;
        if self.refresh_primary_locked(&write)? && !self.normal_writes_suppressed()? {
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
            self.process.is_primary() && replacement_valid()
        })?;
        Ok(())
    }

    fn mutate_and_write(
        &self,
        mutate: impl FnOnce(&mut PersistedClientState),
        replacement_valid: &dyn Fn() -> bool,
    ) -> Result<bool, String> {
        let previous_state = {
            let mut state = self.state.lock().map_err(|err| err.to_string())?;
            let previous = state.clone();
            mutate(&mut state);
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

pub fn start_primary_watcher(app: &AppHandle) {
    let Some(client_state) = app.try_state::<ClientState>() else {
        return;
    };
    if !client_state.process.retains_local_candidacy() {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(OWNERSHIP_POLL_INTERVAL);
        let Some(client_state) = app.try_state::<ClientState>() else {
            return;
        };
        if !client_state.process.retains_local_candidacy() {
            return;
        }
        match client_state.refresh_primary_for_watcher() {
            Ok(true) => {
                window::reconcile_main_window(&app);
                if client_state.take_renderer_reload() {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit(CLIENT_STATE_OWNERSHIP_CHANGED_EVENT, ());
                    }
                }
            }
            Ok(false) => {}
            Err(err) => eprintln!("[client-state] ownership poll failed: {err}"),
        }
    });
}

pub fn begin_main_window_document(app: &AppHandle, label: &str, url: &Url) {
    if label != "main" {
        return;
    }
    if let Some(state) = app.try_state::<ClientState>() {
        if let Err(err) = state.begin_renderer_document(url) {
            eprintln!("[client-state] failed to rotate renderer access for page load: {err}");
        }
    }
}

impl Drop for ClientState {
    fn drop(&mut self) {
        self.release_locks();
    }
}

fn read_client_state(path: &Path) -> Result<PersistedClientState, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(parse_client_state(&bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(PersistedClientState::default())
        }
        Err(err) => Err(format!(
            "failed to read authoritative client state {}: {err}",
            path.display()
        )),
    }
}

fn load_primary_state(
    state_path: &Path,
    tauri_data_dir: &Path,
    electron_data_dir: Option<&Path>,
    ownership_valid: &dyn Fn() -> bool,
) -> Result<PersistedClientState, String> {
    let missing = match fs::metadata(state_path) {
        Ok(_) => false,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
        Err(err) => {
            return Err(format!(
                "failed to inspect authoritative client state {}: {err}",
                state_path.display()
            ))
        }
    };
    if missing {
        if has_future_legacy_state(tauri_data_dir, electron_data_dir) {
            return Ok(PersistedClientState {
                restore_enabled: false,
                unsupported_future_envelope: true,
                writes_enabled: false,
                ..PersistedClientState::default()
            });
        }
        migrate_legacy_state(
            state_path,
            tauri_data_dir,
            electron_data_dir,
            ownership_valid,
        )?;
    }
    read_client_state(state_path)
}

fn parse_client_state(bytes: &[u8]) -> PersistedClientState {
    let Ok(Value::Object(value)) = serde_json::from_slice::<Value>(bytes) else {
        return PersistedClientState::default();
    };
    let version = value.get("version").and_then(Value::as_u64);
    if version.is_some_and(|version| version > CLIENT_STATE_VERSION) {
        return PersistedClientState {
            restore_enabled: false,
            unsupported_future_envelope: true,
            writes_enabled: false,
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
    let restore_enabled = value
        .get("restoreEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    PersistedClientState {
        version: CLIENT_STATE_VERSION,
        restore_enabled,
        snapshot,
        window: value.get("window").and_then(window::normalize_window_state),
        unsupported_future_envelope: false,
        writes_enabled: restore_enabled,
    }
}

fn legacy_candidate(
    path: &Path,
    host: &'static str,
) -> Option<(PersistedClientState, bool, i64, &'static str)> {
    let bytes = fs::read(path).ok()?;
    let Value::Object(value) = serde_json::from_slice::<Value>(&bytes).ok()? else {
        return None;
    };
    if value.get("version").and_then(Value::as_u64) != Some(CLIENT_STATE_VERSION) {
        return None;
    }
    let saved_at = value
        .get("snapshot")
        .and_then(Value::as_object)
        .and_then(|snapshot| snapshot.get("savedAt"))
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    let mut parsed = parse_client_state(&bytes);
    parsed.window = None;
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
            .and_then(|value| value.get("version").and_then(Value::as_u64))
            .is_some_and(|version| version > CLIENT_STATE_VERSION)
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
            .restore_enabled
            .cmp(&right.0.restore_enabled)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| right.3.cmp(left.3))
    });
    let Some((state, _, _, _)) = candidates.first() else {
        return Ok(());
    };
    let bytes = serde_json::to_vec(state).map_err(|err| err.to_string())?;
    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create shared client-state directory: {err}"))?;
    }
    write_atomically(state_path, &bytes, ownership_valid)?;
    for path in [
        electron_data_dir.map(|path| path.join(CLIENT_STATE_FILENAME)),
        Some(tauri_data_dir.join(CLIENT_STATE_FILENAME)),
    ]
    .into_iter()
    .flatten()
    {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "failed to remove migrated legacy client state: {err}"
                ))
            }
        }
    }
    Ok(())
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
