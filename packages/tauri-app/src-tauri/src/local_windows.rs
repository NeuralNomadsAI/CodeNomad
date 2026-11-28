use crate::client_state::{self, ClientState, NavigationKind};
use crate::identity::{local_window_id, local_window_label};
use crate::launch::LaunchIntent;
use crate::shutdown::ShutdownCoordinator;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const MAX_LOCAL_WINDOWS: usize = 16;
const SHUTDOWN_IN_PROGRESS: &str = "Application shutdown is in progress";
const MAX_FOLDER_ATTEMPTS: u8 = 3;
#[cfg(target_os = "windows")]
const LOCAL_WINDOW_CONTEXT_SCRIPT: &str = "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'local'; window.__CODENOMAD_LOCAL_PATHS__ = true; window.__CODENOMAD_BROWSER_CAPABILITIES__ = Object.freeze({embedding:true,history:true,emulation:true,automation:true,ownership:true});";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const LOCAL_WINDOW_CONTEXT_SCRIPT: &str = "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'local'; window.__CODENOMAD_LOCAL_PATHS__ = true; window.__CODENOMAD_BROWSER_CAPABILITIES__ = Object.freeze({embedding:true,history:true,emulation:true,automation:true,ownership:true,reason:'webkit'});";
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
const LOCAL_WINDOW_CONTEXT_SCRIPT: &str = "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'local'; window.__CODENOMAD_LOCAL_PATHS__ = true; window.__CODENOMAD_BROWSER_CAPABILITIES__ = Object.freeze({embedding:false,history:false,emulation:false,automation:false,reason:'unsupported-platform'});";

/// Static boot splash injected into the initial `about:blank` document, before
/// any navigation can be gated on proxy/PAC resolution. See `boot_splash.js`.
const BOOT_SPLASH_SCRIPT: &str = include_str!("boot_splash.js");

/// The interactive loading page owning every non-backend CLI state (starting,
/// stopped, failed — where it displays the published error). Wry maps custom
/// protocol URLs only when constructing a webview; a runtime navigation on
/// Windows must use the mapped `http://tauri.localhost` form or WebView2
/// rejects the scheme and never leaves the current document. WebKit hosts
/// keep the custom scheme.
#[cfg(target_os = "windows")]
const LOADING_PAGE_URL: &str = "http://tauri.localhost/loading.html";
#[cfg(not(target_os = "windows"))]
const LOADING_PAGE_URL: &str = "tauri://localhost/loading.html";

/// The first document a local webview shows. `about:blank` is created without
/// network activity — on Windows even `tauri.localhost` and loopback requests
/// wait for proxy/PAC resolution — so the webview paints the boot splash at
/// once and the first navigation (loading.html, the app or a remote server)
/// replaces it.
fn local_window_initial_url() -> WebviewUrl {
    WebviewUrl::External(Url::parse("about:blank").expect("about:blank always parses"))
}

/// The initialization script every document of a local webview runs. The boot
/// splash guards itself to the top-level about:blank document.
fn local_window_initialization_script(id: &str, instance: &str) -> String {
    format!(
        "{LOCAL_WINDOW_CONTEXT_SCRIPT} window.__CODENOMAD_WINDOW_ID__ = {}; window.__CODENOMAD_WINDOW_INSTANCE__ = {};{BOOT_SPLASH_SCRIPT}",
        serde_json::to_string(id).unwrap(),
        serde_json::to_string(instance).unwrap()
    )
}

/// Where a freshly built local window navigates once its splash is up: the
/// ready backend when there is one, otherwise the loading page. A window
/// created while the CLI is starting, stopped, or failed would otherwise sit
/// on the static splash forever — nothing later navigates it — and a published
/// error would never be displayed.
fn local_window_initial_destination(backend_target: Option<&str>) -> String {
    backend_target
        .map(|target| target.to_string())
        .unwrap_or_else(|| LOADING_PAGE_URL.to_string())
}

#[derive(Clone, Debug)]
pub(crate) struct LocalWindowRecord {
    pub(crate) id: String,
    pub(crate) label: String,
    automation_instance: String,
    pub(crate) persisted: bool,
    pending_folders: VecDeque<PendingFolder>,
    pending_connections: VecDeque<PendingConnection>,
    /// Hidden window opened only to run a `--connect-server` launch. It holds no user window slot,
    /// is never an MRU or launch target, and closes once its connections settle.
    connect_only: bool,
    renderer_ready: bool,
    workspace_menu_enabled: bool,
    pub(crate) view_menu_state: Option<crate::view_menu::ViewMenuState>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingFolder {
    path: String,
    attempts: u8,
}

/// A `--connect-server` request for the renderer; `failure` is another window's message to show here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PendingConnection {
    target: String,
    failure: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingConnectionPayload {
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<String>,
    /// The hidden launch window: it never prompts or shows errors and hands both back.
    hidden: bool,
}

/// What a settled connection asks of its window.
#[derive(Debug, Eq, PartialEq)]
enum ConnectionSettlement {
    Keep,
    Close,
    /// The hidden launch could not finish: start normally and run or report these connections there.
    StartNormally(VecDeque<PendingConnection>),
}

/// A hidden launch window that has not settled by then starts normally, where the connection runs visibly.
const CONNECT_LAUNCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

impl Registry {
    fn queue_connection(
        &mut self,
        label: &str,
        target: String,
        failure: Option<String>,
    ) -> Result<bool, String> {
        let record = self
            .records
            .get_mut(label)
            .ok_or_else(|| "Unknown local window".to_string())?;
        record
            .pending_connections
            .push_back(PendingConnection { target, failure });
        Ok(record.renderer_ready)
    }

    fn next_connection(&self, label: &str) -> Result<Option<PendingConnectionPayload>, String> {
        let record = self
            .records
            .get(label)
            .ok_or_else(|| "Unknown local window".to_string())?;
        Ok(record
            .pending_connections
            .front()
            .map(|pending| PendingConnectionPayload {
                target: pending.target.clone(),
                failure: pending.failure.clone(),
                hidden: record.connect_only,
            }))
    }

    /// Settles the delivered connection. A hidden launch window closes once nothing is left to
    /// connect; a failure or hand-off there starts normally with this connection and every one queued.
    fn acknowledge_connection(
        &mut self,
        label: &str,
        target: &str,
        failure: Option<String>,
        hand_off: bool,
    ) -> Result<ConnectionSettlement, String> {
        let record = self
            .records
            .get_mut(label)
            .ok_or_else(|| "Unknown local window".to_string())?;
        if record
            .pending_connections
            .front()
            .map(|pending| pending.target.as_str())
            != Some(target)
        {
            return Err("Pending connection acknowledgement is out of order".to_string());
        }
        let settled = record.pending_connections.pop_front().unwrap();
        if !record.connect_only {
            return Ok(ConnectionSettlement::Keep);
        }
        if failure.is_none() && !hand_off {
            return Ok(if record.pending_connections.is_empty() {
                ConnectionSettlement::Close
            } else {
                ConnectionSettlement::Keep
            });
        }
        let mut connections = std::mem::take(&mut record.pending_connections);
        connections.push_front(PendingConnection {
            target: settled.target,
            failure: if hand_off { None } else { failure },
        });
        Ok(ConnectionSettlement::StartNormally(connections))
    }

    /// Takes every connection a hidden launch window still holds, to run in a visible window instead.
    fn abandon_connections(&mut self, label: &str) -> VecDeque<PendingConnection> {
        self.records
            .get_mut(label)
            .filter(|record| record.connect_only)
            .map(|record| std::mem::take(&mut record.pending_connections))
            .unwrap_or_default()
    }

    /// Turns a hidden launch window into an ordinary one, the last resort when a normal start fails.
    fn promote(&mut self, label: &str) {
        if let Some(record) = self.records.get_mut(label) {
            record.connect_only = false;
            self.mark_focused(label);
        }
    }
}

#[derive(Default)]
struct Registry {
    records: HashMap<String, LocalWindowRecord>,
    pending: HashSet<String>,
    mru: Vec<String>,
    backend_target: Option<String>,
}

impl Registry {
    fn add(&mut self, id: String, persisted: bool) -> Result<LocalWindowRecord, String> {
        self.add_window(id, persisted, false)
    }

    fn add_window(
        &mut self,
        id: String,
        persisted: bool,
        connect_only: bool,
    ) -> Result<LocalWindowRecord, String> {
        let label = local_window_label(&id)?;
        if self.records.contains_key(&label) || self.pending.contains(&id) {
            return Err("Local window is already registered".to_string());
        }
        if !connect_only && !self.has_user_window_capacity() {
            return Err("Too many local windows".to_string());
        }
        let record = LocalWindowRecord {
            id,
            label: label.clone(),
            persisted,
            pending_folders: VecDeque::new(),
            pending_connections: VecDeque::new(),
            connect_only,
            renderer_ready: false,
            automation_instance: uuid::Uuid::new_v4().to_string(),
            workspace_menu_enabled: false,
            view_menu_state: None,
        };
        self.records.insert(label.clone(), record.clone());
        self.mark_focused(&label);
        Ok(record)
    }

    /// The 16-window limit counts user windows only: hidden launch windows hold no slot.
    fn has_user_window_capacity(&self) -> bool {
        self.records
            .values()
            .filter(|record| !record.connect_only)
            .count()
            + self.pending.len()
            < MAX_LOCAL_WINDOWS
    }

    fn contains_id(&self, id: &str) -> bool {
        self.pending.contains(id)
            || local_window_label(id).is_ok_and(|label| self.records.contains_key(&label))
    }

    fn reserve_new_window(&mut self, saved: Vec<String>) -> Result<(String, bool), String> {
        if !self.has_user_window_capacity() {
            return Err("Too many local windows".into());
        }
        let (id, existing) = saved
            .into_iter()
            .find(|id| !self.contains_id(id))
            .map(|id| (id, true))
            .unwrap_or_else(|| (uuid::Uuid::new_v4().to_string(), false));
        self.pending.insert(id.clone());
        Ok((id, existing))
    }

    fn remove(&mut self, label: &str) -> Option<LocalWindowRecord> {
        self.mru.retain(|candidate| candidate != label);
        self.records.remove(label)
    }

    fn mark_focused(&mut self, label: &str) -> Option<String> {
        let record = self
            .records
            .get(label)
            .filter(|record| !record.connect_only)?;
        let id = record.id.clone();
        self.mru.retain(|candidate| candidate != label);
        self.mru.insert(0, label.to_string());
        Some(id)
    }

    fn mru_label(&self) -> Option<String> {
        self.mru
            .iter()
            .find(|label| self.records.contains_key(*label))
            .cloned()
    }

    fn automation_labels(&self, focused: Option<&str>) -> Vec<(String, String)> {
        let mut windows = self
            .mru
            .iter()
            .filter_map(|label| {
                self.records
                    .get(label)
                    .filter(|record| record.renderer_ready && !record.connect_only)
                    .map(|record| (label.clone(), record.automation_instance.clone()))
            })
            .collect::<Vec<_>>();
        if let Some(index) =
            focused.and_then(|focused| windows.iter().position(|(label, _)| label == focused))
        {
            windows[..=index].rotate_right(1);
        }
        windows
    }
}

#[derive(Default)]
pub(crate) struct LocalWindows {
    registry: Mutex<Registry>,
    launch_dispatch: Mutex<LaunchDispatch>,
    /// A connect-only launch defers the saved Preferences window until it falls back to a normal start.
    startup_restore_deferred: std::sync::atomic::AtomicBool,
}

struct PendingNewWindow {
    id: String,
    existing: bool,
}

impl PendingNewWindow {
    fn construct(
        self,
        windows: &LocalWindows,
        shutdown: &ShutdownCoordinator,
        persisted: bool,
        build: impl FnOnce(LocalWindowRecord, bool) -> Result<LocalWindowRecord, String>,
    ) -> Result<LocalWindowRecord, String> {
        // Convert the reservation directly into a shutdown-visible record.
        let admitted = shutdown.admit_local_window_build(|| {
            let mut registry = windows.registry.lock().map_err(|error| error.to_string())?;
            registry.pending.remove(&self.id);
            registry.add(self.id.clone(), persisted)
        });
        match admitted {
            Some(result) => {
                let (record, _building) = result?;
                build(record, !self.existing)
            }
            None => {
                windows.release_new_window(&self.id);
                Err(SHUTDOWN_IN_PROGRESS.into())
            }
        }
    }
}

#[derive(Default)]
struct LaunchDispatch {
    pending: VecDeque<LaunchIntent>,
    draining: bool,
}

impl LocalWindows {
    fn schedule_new_window(
        &self,
        shutdown: &ShutdownCoordinator,
        saved: Vec<String>,
        enqueue: impl FnOnce(PendingNewWindow) -> Result<(), String>,
    ) -> Result<(), String> {
        let (id, existing) = shutdown
            .with_navigation_authority(|| {
                self.registry
                    .lock()
                    .map_err(|error| error.to_string())?
                    .reserve_new_window(saved)
            })
            .ok_or(SHUTDOWN_IN_PROGRESS)??;
        let enqueued = enqueue(PendingNewWindow {
            id: id.clone(),
            existing,
        });
        if enqueued.is_err() {
            self.release_new_window(&id);
        }
        enqueued
    }

    fn release_new_window(&self, id: &str) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.pending.remove(id);
        }
    }

    pub(crate) fn defer_startup_restore(&self) {
        self.startup_restore_deferred
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn startup_restore_deferred(&self) -> bool {
        self.startup_restore_deferred
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn release_startup_restore(&self) {
        self.startup_restore_deferred
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn records(&self) -> Vec<LocalWindowRecord> {
        self.registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .records
            .values()
            .cloned()
            .collect()
    }

    pub(crate) fn record(&self, label: &str) -> Option<LocalWindowRecord> {
        self.registry.lock().ok()?.records.get(label).cloned()
    }

    pub(crate) fn contains_id(&self, id: &str) -> bool {
        self.registry
            .lock()
            .is_ok_and(|registry| registry.contains_id(id))
    }

    pub(crate) fn mru_label(&self) -> Option<String> {
        self.registry.lock().ok()?.mru_label()
    }

    pub(crate) fn automation_labels(&self) -> Vec<(String, String)> {
        let Ok(registry) = self.registry.lock() else {
            return Vec::new();
        };
        registry.automation_labels(None)
    }

    pub(crate) fn automation_window_current(&self, label: &str, incarnation: &str) -> bool {
        self.registry.lock().is_ok_and(|registry| {
            registry.records.get(label).is_some_and(|record| {
                record.renderer_ready
                    && !record.connect_only
                    && record.automation_instance == incarnation
            })
        })
    }

    #[cfg(windows)]
    pub(crate) fn automation_matches(&self, label: &str, instance: &str) -> bool {
        self.registry.lock().ok().is_some_and(|registry| {
            registry.records.get(label).is_some_and(|record| {
                !record.connect_only && record.renderer_ready && record.automation_instance == instance
            })
        })
    }

    pub(crate) fn mark_focused(&self, app: &AppHandle, label: &str) {
        let id = self
            .registry
            .lock()
            .ok()
            .and_then(|mut registry| registry.mark_focused(label));
        if let (Some(id), Some(state)) = (id, app.try_state::<ClientState>()) {
            state.queue_active_window(app, id);
        }
    }

    pub(crate) fn remove_runtime(&self, label: &str) -> Option<LocalWindowRecord> {
        self.registry.lock().ok()?.remove(label)
    }

    pub(crate) fn set_workspace_menu_enabled(
        &self,
        label: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
        let record = registry
            .records
            .get_mut(label)
            .ok_or_else(|| "Unknown local window".to_string())?;
        record.workspace_menu_enabled = enabled;
        if !enabled {
            record.view_menu_state = None;
        }
        Ok(())
    }

    pub(crate) fn set_view_menu_state(
        &self,
        label: &str,
        state: Option<crate::view_menu::ViewMenuState>,
    ) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
        let record = registry
            .records
            .get_mut(label)
            .ok_or("Unknown local window")?;
        record.view_menu_state = state;
        Ok(())
    }

    pub(crate) fn menu_state(
        &self,
        focused: Option<&str>,
    ) -> (bool, Option<crate::view_menu::ViewMenuState>) {
        let Ok(registry) = self.registry.lock() else {
            return (false, None);
        };
        let label = select_local_label(focused, registry.mru_label().as_deref());
        let record = label.as_ref().and_then(|label| registry.records.get(label));
        record
            .map(|record| {
                (
                    record.workspace_menu_enabled,
                    record.view_menu_state.clone(),
                )
            })
            .unwrap_or_default()
    }

    pub(crate) fn set_backend_target(&self, target: Option<String>) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.backend_target = target;
        }
    }

    fn backend_target(&self) -> Option<String> {
        self.registry.lock().ok()?.backend_target.clone()
    }

    pub(crate) fn queue_folder(
        &self,
        app: &AppHandle,
        label: &str,
        folder: String,
    ) -> Result<(), String> {
        let ready = {
            let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
            let record = registry
                .records
                .get_mut(label)
                .ok_or_else(|| "Unknown local window".to_string())?;
            record.pending_folders.push_back(PendingFolder {
                path: folder,
                attempts: 0,
            });
            record.renderer_ready
        };
        if ready {
            if let Some(webview) = app.get_webview(label) {
                let _ = webview.emit("desktop:folders-pending", ());
            }
        }
        Ok(())
    }

    pub(crate) fn renderer_ready(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        let (folders, connections) = {
            let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
            let record = registry
                .records
                .get_mut(label)
                .ok_or_else(|| "Unknown local window".to_string())?;
            record.renderer_ready = true;
            (
                !record.pending_folders.is_empty(),
                !record.pending_connections.is_empty(),
            )
        };
        if let Some(webview) = app.get_webview(label) {
            if folders {
                let _ = webview.emit("desktop:folders-pending", ());
            }
            if connections {
                let _ = webview.emit("desktop:connections-pending", ());
            }
        }
        Ok(())
    }

    pub(crate) fn queue_connection(
        &self,
        app: &AppHandle,
        label: &str,
        target: String,
        failure: Option<String>,
    ) -> Result<(), String> {
        let ready = self
            .registry
            .lock()
            .map_err(|error| error.to_string())?
            .queue_connection(label, target, failure)?;
        if ready {
            if let Some(webview) = app.get_webview(label) {
                let _ = webview.emit("desktop:connections-pending", ());
            }
        }
        Ok(())
    }

    fn next_connection(&self, label: &str) -> Result<Option<PendingConnectionPayload>, String> {
        self.registry
            .lock()
            .map_err(|error| error.to_string())?
            .next_connection(label)
    }

    fn acknowledge_connection(
        &self,
        label: &str,
        target: &str,
        failure: Option<String>,
        hand_off: bool,
    ) -> Result<ConnectionSettlement, String> {
        self.registry
            .lock()
            .map_err(|error| error.to_string())?
            .acknowledge_connection(label, target, failure, hand_off)
    }

    fn abandon_connections(&self, label: &str) -> VecDeque<PendingConnection> {
        self.registry
            .lock()
            .map(|mut registry| registry.abandon_connections(label))
            .unwrap_or_default()
    }

    fn promote(&self, label: &str) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.promote(label);
        }
    }

    #[cfg(test)]
    fn has_user_window_capacity(&self) -> bool {
        self.registry
            .lock()
            .is_ok_and(|registry| registry.has_user_window_capacity())
    }

    /// The windows whose renderer state a shutdown preserves: hidden launch windows hold none.
    pub(crate) fn user_window_labels(&self) -> Vec<String> {
        self.registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .records
            .values()
            .filter(|record| !record.connect_only)
            .map(|record| record.label.clone())
            .collect()
    }

    pub(crate) fn is_connect_only(&self, label: &str) -> bool {
        self.record(label).is_some_and(|record| record.connect_only)
    }

    pub(crate) fn connect_only_labels(&self) -> Vec<String> {
        self.records()
            .into_iter()
            .filter(|record| record.connect_only)
            .map(|record| record.label)
            .collect()
    }

    pub(crate) fn next_folder(&self, label: &str) -> Result<Option<String>, String> {
        let registry = self.registry.lock().map_err(|error| error.to_string())?;
        Ok(registry
            .records
            .get(label)
            .ok_or_else(|| "Unknown local window".to_string())?
            .pending_folders
            .front()
            .map(|pending| pending.path.clone()))
    }

    pub(crate) fn acknowledge_folder(
        &self,
        label: &str,
        folder: &str,
        opened: bool,
    ) -> Result<(), String> {
        let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
        let record = registry
            .records
            .get_mut(label)
            .ok_or_else(|| "Unknown local window".to_string())?;
        if record
            .pending_folders
            .front()
            .map(|pending| pending.path.as_str())
            != Some(folder)
        {
            return Err("Pending folder acknowledgement is out of order".to_string());
        }
        let mut pending = record.pending_folders.pop_front().unwrap();
        if !opened {
            pending.attempts += 1;
            if pending.attempts < MAX_FOLDER_ATTEMPTS {
                record.pending_folders.push_back(pending);
            }
        }
        Ok(())
    }
}

fn is_primary_webview_label(webview_label: &str, window_label: &str) -> bool {
    webview_label == window_label
}

fn is_primary_webview(webview: &Webview) -> bool {
    is_primary_webview_label(webview.label(), webview.window().label())
}

pub(crate) fn focused_window(app: &AppHandle) -> Option<Webview> {
    app.webviews()
        .into_values()
        .filter(is_primary_webview)
        .find(|webview| webview.window().is_focused().unwrap_or(false))
}

fn select_local_label(focused: Option<&str>, mru: Option<&str>) -> Option<String> {
    match focused {
        Some(label) if local_window_id(label).is_ok() => Some(label.to_string()),
        Some(_) => None,
        None => mru
            .filter(|label| local_window_id(label).is_ok())
            .map(str::to_string),
    }
}

pub(crate) fn focused_local_window(app: &AppHandle) -> Option<Webview> {
    let focused = focused_window(app);
    let mru = app.state::<LocalWindows>().mru_label();
    let label = select_local_label(focused.as_ref().map(Webview::label), mru.as_deref())?;
    app.get_webview(&label)
}

pub(crate) fn browser_open_candidates(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let focused = focused_window(app);
    let windows = app.state::<LocalWindows>();
    let registry = windows.registry.lock().map_err(|error| error.to_string())?;
    Ok(registry.automation_labels(focused.as_ref().map(Webview::label)))
}

pub(crate) fn browser_open_window_current(app: &AppHandle, label: &str, incarnation: &str) -> bool {
    app.state::<LocalWindows>()
        .automation_window_current(label, incarnation)
}

/// The update flow lives in application windows. Preferences and remote windows
/// hand it to the most recently used application window instead of skipping it.
fn select_update_label(focused: Option<&str>, mru: Option<&str>) -> Option<String> {
    select_local_label(focused, mru).or_else(|| select_local_label(None, mru))
}

pub(crate) fn update_flow_window(app: &AppHandle) -> Option<Webview> {
    let focused = focused_window(app);
    let mru = app.state::<LocalWindows>().mru_label();
    let label = select_update_label(focused.as_ref().map(Webview::label), mru.as_deref())?;
    app.get_webview(&label)
}

pub(crate) fn targeted_window(app: &AppHandle) -> Option<Webview> {
    focused_window(app).or_else(|| {
        app.state::<LocalWindows>()
            .mru_label()
            .and_then(|label| app.get_webview(&label))
    })
}

pub(crate) fn focus(app: &AppHandle, label: &str) -> bool {
    let Some(webview) = app.get_webview(label) else {
        return false;
    };
    let window = webview.window();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    app.state::<LocalWindows>().mark_focused(app, label);
    true
}

fn register(
    app: &AppHandle,
    id: String,
    persisted: bool,
    connect_only: bool,
) -> Result<LocalWindowRecord, String> {
    crate::shutdown::with_navigation_authority(app, || {
        app.state::<LocalWindows>()
            .registry
            .lock()
            .map_err(|error| error.to_string())?
            .add_window(id, persisted, connect_only)
    })
    .ok_or(SHUTDOWN_IN_PROGRESS)?
}

pub(crate) fn create_local_window(
    app: &AppHandle,
    id: String,
    persisted: bool,
) -> Result<LocalWindowRecord, String> {
    let record = register(app, id, persisted, false)?;
    build_local_window(app, record, false)
}

fn build_local_window(
    app: &AppHandle,
    record: LocalWindowRecord,
    new_record: bool,
) -> Result<LocalWindowRecord, String> {
    let id = &record.id;
    let persisted = record.persisted;
    let script = local_window_initialization_script(id, &record.automation_instance);
    let data_directory = app
        .state::<crate::AppState>()
        .webview_data_directory
        .join("local");
    let badge_binding = crate::notification_badge::prepare_window(app, &record.label);
    let state = app.state::<ClientState>();
    if new_record && persisted {
        state.admit_new_window_capture(id.clone());
    }
    let builder = WebviewWindowBuilder::new(app, &record.label, local_window_initial_url())
        .data_directory(data_directory)
        .initialization_script(script)
        .on_page_load(move |window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                crate::notification_badge::page_started(window.as_ref(), badge_binding);
            }
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let zoom = client_state::local_window_zoom(window.app_handle(), window.label());
                crate::title_bar::publish_page_zoom(window.as_ref(), zoom);
            }
        });
    #[cfg(windows)]
    let developer_browser_arguments = app
        .state::<crate::AppState>()
        .developer_browser_arguments
        .clone();
    #[cfg(windows)]
    let builder = if let Some(arguments) = developer_browser_arguments.as_deref() {
        builder.additional_browser_args(arguments)
    } else {
        builder
    };
    #[cfg(target_os = "macos")]
    let builder = if app.state::<crate::AppState>().scoped_profile {
        builder.data_store_identifier(crate::profile_identifier("local"))
    } else {
        builder
    };
    let result = crate::title_bar::configure(crate::window_zoom::configure(builder))
        .title("CodeNomad")
        .inner_size(1400.0, 900.0)
        .min_inner_size(client_state::MIN_WINDOW_WIDTH as f64, 600.0)
        .resizable(true)
        .fullscreen(false)
        .background_color(tauri::window::Color(26, 26, 26, 255))
        .visible(false)
        .build();
    let window = match result {
        Ok(window) => window,
        Err(error) => {
            crate::notification_badge::remove_window(app, &record.label, badge_binding);
            app.state::<LocalWindows>().remove_runtime(&record.label);
            state.unregister_window(id);
            return Err(error.to_string());
        }
    };
    // The WebView2 controller's implicit document is already about:blank, so
    // the initial URL creates no new document and initialization scripts never
    // fire there. Evaluate the boot splash directly on that document instead;
    // its guard keeps it a no-op on every later page.
    let _ = window.eval(BOOT_SPLASH_SCRIPT);
    crate::menu_bar::hide(&window.as_ref().window());
    if let Err(error) =
        client_state::setup_local_window(app, &window, id, persisted, !record.connect_only)
    {
        app.state::<LocalWindows>().remove_runtime(&record.label);
        state.unregister_window(id);
        let _ = window.destroy();
        return Err(error);
    }
    crate::notification_badge::bind_webview(window.as_ref(), badge_binding);
    if let Err(error) = app
        .state::<crate::AppState>()
        .browser_controller
        .observe_owner(&window.as_ref().window())
    {
        eprintln!("[browser] could not schedule preview owner visibility observer: {error}");
    }
    crate::remote_dictation::bind_termination(window.as_ref(), None);
    #[cfg(target_os = "linux")]
    crate::device_speech_ipc::bind_microphone(&window, false);
    #[cfg(windows)]
    if let Err(error) = crate::shutdown::schedule_windows_session_end_handler(&window) {
        app.state::<LocalWindows>().remove_runtime(&record.label);
        state.unregister_window(id);
        let _ = window.destroy();
        return Err(error);
    }
    if new_record && persisted {
        state.register_ephemeral_window(id.clone());
        // Admit only after successful construction and before the first
        // renderer can claim its document. Shutdown drains this publication.
        if let Err(error) = ClientState::queue_new_window(app, id.clone()) {
            state.discard_new_window_capture(id);
            eprintln!("[client-state] failed to admit new window state: {error}");
        }
    }
    let backend_target = app.state::<LocalWindows>().backend_target();
    if let Some(target) = &backend_target {
        let result = app
            .state::<crate::AppState>()
            .manager
            .install_local_window_cookie(window.as_ref(), target);
        if let Err(error) = result {
            eprintln!("[tauri] failed to sign a new local window in to the local server: {error}");
        }
    }
    let destination = local_window_initial_destination(backend_target.as_deref());
    navigate_window(app, &record.label, &destination, NavigationKind::Cli);
    Ok(record)
}

pub(crate) fn create_new_window(app: &AppHandle) -> Result<(), String> {
    schedule_new_window(app, |_, result| {
        if let Err(error) = result {
            eprintln!("[tauri] failed to create local window: {error}");
        }
    })
}

fn schedule_new_window(
    app: &AppHandle,
    complete: impl FnOnce(&AppHandle, Result<LocalWindowRecord, String>) + Send + 'static,
) -> Result<(), String> {
    let saved = app.state::<ClientState>().window_ids();
    app.state::<LocalWindows>().schedule_new_window(
        &app.state::<ShutdownCoordinator>(),
        saved,
        |pending| {
            let dispatch = app.clone();
            app.run_on_main_thread(move || {
                let persisted = dispatch.state::<ClientState>().can_register_window();
                let result = pending.construct(
                    &dispatch.state::<LocalWindows>(),
                    &dispatch.state::<ShutdownCoordinator>(),
                    persisted,
                    |record, new_record| build_local_window(&dispatch, record, new_record),
                );
                complete(&dispatch, result);
            })
            .map_err(|error| error.to_string())
        },
    )
}

pub(crate) fn restore_windows(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ClientState>();
    let persisted = state.is_primary_process();
    let ids = state.window_ids();
    let active = state.active_window_id()?;
    drop(state);
    if ids.is_empty() {
        create_new_window(app)?;
        return Ok(());
    }
    for id in ids {
        create_local_window(app, id, persisted)?;
    }
    let label = local_window_label(&active)?;
    focus(app, &label);
    Ok(())
}

pub(crate) fn handle_intents(app: &AppHandle, intents: Vec<LaunchIntent>) {
    {
        let windows = app.state::<LocalWindows>();
        let Ok(mut dispatch) = windows.launch_dispatch.lock() else {
            return;
        };
        dispatch.pending.extend(intents);
        if dispatch.draining {
            return;
        }
        dispatch.draining = true;
    }
    drain_intents(app);
}

fn drain_intents(app: &AppHandle) {
    loop {
        let allowed = crate::shutdown::with_navigation_authority(app, || ()).is_some();
        let intent = {
            let windows = app.state::<LocalWindows>();
            let Ok(mut dispatch) = windows.launch_dispatch.lock() else {
                return;
            };
            if !allowed {
                dispatch.pending.clear();
            }
            let Some(intent) = dispatch.pending.pop_front() else {
                dispatch.draining = false;
                return;
            };
            intent
        };
        match handle_intent(app, intent) {
            Ok(true) => return, // Resume when the new window has an MRU entry.
            Ok(false) => {}
            Err(error) => eprintln!("[tauri-startup] launch intent failed: {error}"),
        }
    }
}

fn handle_intent(app: &AppHandle, intent: LaunchIntent) -> Result<bool, String> {
    let windows = app.state::<LocalWindows>();
    if intent.is_connect_only() && windows.mru_label().is_none() {
        // Nothing to run the connection in: a hidden, unpersisted window runs it and closes once it settles.
        let record = register(app, uuid::Uuid::new_v4().to_string(), false, true)?;
        let record = build_local_window(app, record, false)?;
        windows.queue_connection(
            app,
            &record.label,
            intent.connect_server.unwrap_or_default(),
            None,
        )?;
        let timeout_app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(CONNECT_LAUNCH_TIMEOUT);
            let dispatch = timeout_app.clone();
            let _ = timeout_app
                .run_on_main_thread(move || abandon_launch_window(&dispatch, &record.label));
        });
        return Ok(false);
    }
    if !intent.new_window {
        if let Some(record) = windows.mru_label().and_then(|label| windows.record(&label)) {
            return deliver_intent(app, record, intent).map(|()| false);
        }
    }
    schedule_new_window(app, move |app, result| {
        if let Err(error) = result.and_then(|record| deliver_intent(app, record, intent)) {
            eprintln!("[tauri-startup] launch intent failed: {error}");
        }
        drain_intents(app);
    })?;
    Ok(true)
}

fn deliver_intent(
    app: &AppHandle,
    record: LocalWindowRecord,
    intent: LaunchIntent,
) -> Result<(), String> {
    let windows = app.state::<LocalWindows>();
    for folder in intent.folders {
        app.state::<LocalWindows>()
            .queue_folder(app, &record.label, folder)?;
    }
    if let Some(target) = intent.connect_server {
        windows.queue_connection(app, &record.label, target, None)?;
    }
    focus(app, &record.label);
    Ok(())
}

/// Opens saved windows beside a failed connect-only window, and returns the one to report in.
fn restore_normal_start(app: &AppHandle, persisted: bool) -> Result<Option<String>, String> {
    let state = app.state::<ClientState>();
    let windows = app.state::<LocalWindows>();
    for id in state.window_ids() {
        if !windows.contains_id(&id) {
            create_local_window(app, id, persisted)?;
        }
    }
    let usable = |label: &String| {
        windows
            .record(label)
            .is_some_and(|record| !record.connect_only)
    };
    let active = state
        .active_window_id()
        .ok()
        .and_then(|id| local_window_label(&id).ok())
        .filter(usable);
    Ok(active.or_else(|| {
        windows
            .records()
            .into_iter()
            .map(|record| record.label)
            .find(usable)
    }))
}

fn close_local_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
}

fn settle_connection(
    app: &AppHandle,
    label: &str,
    settlement: ConnectionSettlement,
) -> Result<(), String> {
    match settlement {
        ConnectionSettlement::Keep => {}
        ConnectionSettlement::Close => close_local_window(app, label),
        ConnectionSettlement::StartNormally(connections) => {
            let worker = app.clone();
            let label = label.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let persisted = worker.state::<ClientState>().is_primary_process();
                let dispatch = worker.clone();
                let _ = worker.run_on_main_thread(move || {
                    if crate::shutdown::with_navigation_authority(&dispatch, || ()).is_none() {
                        return;
                    }
                    match restore_normal_start(&dispatch, persisted) {
                        Ok(None) => {
                            let fallback_label = label.clone();
                            let fallback_connections = connections.clone();
                            if let Err(error) =
                                schedule_new_window(&dispatch, move |app, result| {
                                    finish_normal_start(
                                        app,
                                        &label,
                                        connections,
                                        result.map(|record| record.label),
                                    );
                                })
                            {
                                finish_normal_start(
                                    &dispatch,
                                    &fallback_label,
                                    fallback_connections,
                                    Err(error),
                                );
                            }
                        }
                        Ok(Some(target)) => {
                            finish_normal_start(&dispatch, &label, connections, Ok(target))
                        }
                        Err(error) => {
                            finish_normal_start(&dispatch, &label, connections, Err(error))
                        }
                    }
                });
            });
        }
    }
    Ok(())
}

fn finish_normal_start(
    app: &AppHandle,
    label: &str,
    connections: VecDeque<PendingConnection>,
    fallback: Result<String, String>,
) {
    if crate::shutdown::with_navigation_authority(app, || ()).is_none() {
        return;
    }
    let windows = app.state::<LocalWindows>();
    let fallback = match fallback {
        Ok(fallback) => {
            windows.release_startup_restore();
            if windows.backend_target().is_some() {
                crate::preferences_window::navigate_backend(app);
            }
            fallback
        }
        Err(error) => {
            // Keep the hidden launch's work reachable if a normal window cannot be built.
            eprintln!("[tauri-startup] normal start after a launch connection failed: {error}");
            windows.promote(label);
            label.to_string()
        }
    };
    for pending in connections {
        if let Err(error) =
            windows.queue_connection(app, &fallback, pending.target, pending.failure)
        {
            eprintln!("[tauri-startup] launch connection failed: {error}");
            return;
        }
    }
    focus(app, &fallback);
    if fallback != label {
        close_local_window(app, label);
    }
}

/// Hands a hidden launch window's connections to a normal start (backend failure or timeout).
fn abandon_launch_window(app: &AppHandle, label: &str) {
    let connections = app.state::<LocalWindows>().abandon_connections(label);
    if connections.is_empty() {
        return;
    }
    if let Err(error) =
        settle_connection(app, label, ConnectionSettlement::StartNormally(connections))
    {
        eprintln!("[tauri-startup] launch connection failed: {error}");
    }
}

/// A hidden launch window cannot show a backend failure: a normal start does.
fn schedule_abandon_launch_windows(app: &AppHandle) {
    let labels = app.state::<LocalWindows>().connect_only_labels();
    if labels.is_empty() {
        return;
    }
    let dispatch = app.clone();
    let _ = app.run_on_main_thread(move || {
        for label in labels {
            abandon_launch_window(&dispatch, &label);
        }
    });
}

pub(crate) fn navigate_window(app: &AppHandle, label: &str, target: &str, kind: NavigationKind) {
    let Ok(url) = Url::parse(target) else {
        return;
    };
    let label_for_navigation = label.to_string();
    client_state::before_window_navigation(
        app,
        label.to_string(),
        kind,
        Some(url.clone()),
        move |app| {
            app.get_webview(&label_for_navigation)
                .ok_or_else(|| "local window not found for navigation".to_string())?
                .navigate(url)
                .map_err(|error| error.to_string())
        },
    );
}

pub(crate) fn show_loading_all(app: &AppHandle) {
    app.state::<LocalWindows>().set_backend_target(None);
    for record in app.state::<LocalWindows>().records() {
        navigate_window(app, &record.label, LOADING_PAGE_URL, NavigationKind::Cli);
    }
}

pub(crate) fn emit_all(app: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    if event == "cli:error" {
        schedule_abandon_launch_windows(app);
    }
    for record in app.state::<LocalWindows>().records() {
        if let Some(webview) = app.get_webview(&record.label) {
            let _ = webview.emit(event, payload.clone());
        }
    }
    if let Some(window) = app.get_webview_window(crate::preferences_window::LABEL) {
        let _ = window.emit(event, payload);
    }
}

#[tauri::command]
pub(crate) fn desktop_launch_ready(
    webview: Webview,
    app: AppHandle,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    crate::require_local_app_webview(&webview, &state)?;
    windows.renderer_ready(&app, webview.label())
}

#[tauri::command]
pub(crate) fn desktop_launch_next_folder(
    webview: Webview,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Option<String>, String> {
    crate::require_local_app_webview(&webview, &state)?;
    windows.next_folder(webview.label())
}

#[tauri::command]
pub(crate) fn desktop_launch_acknowledge_folder(
    webview: Webview,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
    folder: String,
    opened: bool,
) -> Result<(), String> {
    crate::require_local_app_webview(&webview, &state)?;
    windows.acknowledge_folder(webview.label(), &folder, opened)
}

#[tauri::command]
pub(crate) fn desktop_launch_next_connection(
    webview: Webview,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Option<PendingConnectionPayload>, String> {
    crate::require_local_app_webview(&webview, &state)?;
    windows.next_connection(webview.label())
}

#[tauri::command]
pub(crate) fn desktop_launch_acknowledge_connection(
    webview: Webview,
    app: AppHandle,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
    target: String,
    failure: Option<String>,
    hand_off: bool,
) -> Result<(), String> {
    crate::require_local_app_webview(&webview, &state)?;
    let label = webview.label().to_string();
    let settlement = windows.acknowledge_connection(&label, &target, failure, hand_off)?;
    if settlement == ConnectionSettlement::Keep {
        return Ok(());
    }
    // Windows are created and closed from the event loop, never inside a command.
    let dispatch = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = settle_connection(&dispatch, &label, settlement) {
            eprintln!("[tauri-startup] launch connection failed: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "local_windows_tests.rs"]
mod tests;
