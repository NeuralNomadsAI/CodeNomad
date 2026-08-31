use crate::client_state::{self, ClientState, NavigationKind};
use crate::identity::{local_window_id, local_window_label};
use crate::launch::LaunchIntent;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const MAX_LOCAL_WINDOWS: usize = 16;
const MAX_FOLDER_ATTEMPTS: u8 = 3;
const LOCAL_WINDOW_CONTEXT_SCRIPT: &str =
    "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'local';";

#[derive(Clone, Debug)]
pub(crate) struct LocalWindowRecord {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) persisted: bool,
    pending_folders: VecDeque<PendingFolder>,
    renderer_ready: bool,
    workspace_menu_enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingFolder {
    path: String,
    attempts: u8,
}

#[derive(Default)]
struct Registry {
    records: HashMap<String, LocalWindowRecord>,
    mru: Vec<String>,
    backend_target: Option<String>,
}

impl Registry {
    fn add(&mut self, id: String, persisted: bool) -> Result<LocalWindowRecord, String> {
        let label = local_window_label(&id)?;
        if self.records.contains_key(&label) {
            return Err("Local window is already registered".to_string());
        }
        if self.records.len() >= MAX_LOCAL_WINDOWS {
            return Err("Too many local windows".to_string());
        }
        let record = LocalWindowRecord {
            id,
            label: label.clone(),
            persisted,
            pending_folders: VecDeque::new(),
            renderer_ready: false,
            workspace_menu_enabled: false,
        };
        self.records.insert(label.clone(), record.clone());
        self.mark_focused(&label);
        Ok(record)
    }

    fn remove(&mut self, label: &str) -> Option<LocalWindowRecord> {
        self.mru.retain(|candidate| candidate != label);
        self.records.remove(label)
    }

    fn mark_focused(&mut self, label: &str) -> Option<String> {
        let id = self.records.get(label)?.id.clone();
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
}

#[derive(Default)]
pub(crate) struct LocalWindows {
    registry: Mutex<Registry>,
}

impl LocalWindows {
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
        local_window_label(id).ok().is_some_and(|label| {
            self.registry
                .lock()
                .ok()
                .is_some_and(|registry| registry.records.contains_key(&label))
        })
    }

    pub(crate) fn mru_label(&self) -> Option<String> {
        self.registry.lock().ok()?.mru_label()
    }

    pub(crate) fn mark_focused(&self, app: &AppHandle, label: &str) {
        let id = self
            .registry
            .lock()
            .ok()
            .and_then(|mut registry| registry.mark_focused(label));
        if let (Some(id), Some(state)) = (id, app.try_state::<ClientState>()) {
            if let Err(error) = state.set_active_window(&id) {
                eprintln!("[client-state] failed to persist active window: {error}");
            }
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
        Ok(())
    }

    pub(crate) fn workspace_menu_enabled(&self, label: &str) -> bool {
        self.registry
            .lock()
            .ok()
            .and_then(|registry| {
                registry
                    .records
                    .get(label)
                    .map(|record| record.workspace_menu_enabled)
            })
            .unwrap_or(false)
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
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.emit("desktop:folders-pending", ());
            }
        }
        Ok(())
    }

    pub(crate) fn renderer_ready(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        let pending = {
            let mut registry = self.registry.lock().map_err(|error| error.to_string())?;
            let record = registry
                .records
                .get_mut(label)
                .ok_or_else(|| "Unknown local window".to_string())?;
            record.renderer_ready = true;
            !record.pending_folders.is_empty()
        };
        if pending {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.emit("desktop:folders-pending", ());
            }
        }
        Ok(())
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

pub(crate) fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
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

pub(crate) fn focused_local_window(app: &AppHandle) -> Option<WebviewWindow> {
    let focused = focused_window(app);
    let mru = app.state::<LocalWindows>().mru_label();
    let label = select_local_label(focused.as_ref().map(WebviewWindow::label), mru.as_deref())?;
    app.get_webview_window(&label)
}

pub(crate) fn targeted_window(app: &AppHandle) -> Option<WebviewWindow> {
    focused_window(app).or_else(|| {
        app.state::<LocalWindows>()
            .mru_label()
            .and_then(|label| app.get_webview_window(&label))
    })
}

pub(crate) fn focus(app: &AppHandle, label: &str) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        return false;
    };
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    app.state::<LocalWindows>().mark_focused(app, label);
    true
}

fn register(app: &AppHandle, id: String, persisted: bool) -> Result<LocalWindowRecord, String> {
    app.state::<LocalWindows>()
        .registry
        .lock()
        .map_err(|error| error.to_string())?
        .add(id, persisted)
}

pub(crate) fn create_local_window(
    app: &AppHandle,
    id: String,
    persisted: bool,
) -> Result<LocalWindowRecord, String> {
    let record = register(app, id.clone(), persisted)?;
    let script = format!(
        "{LOCAL_WINDOW_CONTEXT_SCRIPT} window.__CODENOMAD_WINDOW_ID__ = {};",
        serde_json::to_string(&id).unwrap()
    );
    let data_directory = app
        .state::<crate::AppState>()
        .webview_data_directory
        .join("local");
    let builder =
        WebviewWindowBuilder::new(app, &record.label, WebviewUrl::App("loading.html".into()))
            .data_directory(data_directory)
            .initialization_script(script);
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
    let result = builder
        .title("CodeNomad")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        .decorations(true)
        .background_color(tauri::window::Color(26, 26, 26, 255))
        .zoom_hotkeys_enabled(true)
        .visible(false)
        .build();
    let window = match result {
        Ok(window) => window,
        Err(error) => {
            app.state::<LocalWindows>().remove_runtime(&record.label);
            return Err(error.to_string());
        }
    };
    if let Err(error) = client_state::setup_local_window(app, &window, &id, persisted) {
        app.state::<LocalWindows>().remove_runtime(&record.label);
        if let Some(state) = app.try_state::<ClientState>() {
            state.unregister_window(&id);
        }
        let _ = window.destroy();
        return Err(error);
    }
    #[cfg(windows)]
    if let Err(error) = crate::shutdown::schedule_windows_session_end_handler(&window) {
        app.state::<LocalWindows>().remove_runtime(&record.label);
        if let Some(state) = app.try_state::<ClientState>() {
            state.unregister_window(&id);
        }
        let _ = window.destroy();
        return Err(error);
    }
    if let Some(target) = app.state::<LocalWindows>().backend_target() {
        navigate_window(app, &record.label, &target, NavigationKind::Cli);
    }
    Ok(record)
}

pub(crate) fn create_new_window(app: &AppHandle) -> Result<LocalWindowRecord, String> {
    let state = app.state::<ClientState>();
    if let Some(id) = state
        .window_ids()
        .into_iter()
        .find(|id| !app.state::<LocalWindows>().contains_id(id))
    {
        return create_local_window(app, id, state.is_primary_process());
    }
    if app.state::<LocalWindows>().records().len() >= MAX_LOCAL_WINDOWS {
        return Err("Too many local windows".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let persisted = match state.add_window(id.clone()) {
        Ok(persisted) => persisted,
        Err(error) => {
            eprintln!(
                "[client-state] failed to persist a new window; using an ephemeral window: {error}"
            );
            false
        }
    };
    create_local_window(app, id, persisted)
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

pub(crate) fn handle_intent(app: &AppHandle, intent: LaunchIntent) -> Result<(), String> {
    let record = if intent.new_window {
        create_new_window(app)?
    } else if let Some(label) = app.state::<LocalWindows>().mru_label() {
        app.state::<LocalWindows>()
            .record(&label)
            .ok_or_else(|| "MRU local window disappeared".to_string())?
    } else {
        create_new_window(app)?
    };
    for folder in intent.folders {
        app.state::<LocalWindows>()
            .queue_folder(app, &record.label, folder)?;
    }
    focus(app, &record.label);
    Ok(())
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
            app.get_webview_window(&label_for_navigation)
                .ok_or_else(|| "local window not found for navigation".to_string())?
                .navigate(url)
                .map_err(|error| error.to_string())
        },
    );
}

pub(crate) fn show_loading_all(app: &AppHandle) {
    app.state::<LocalWindows>().set_backend_target(None);
    for record in app.state::<LocalWindows>().records() {
        navigate_window(
            app,
            &record.label,
            "tauri://localhost/loading.html",
            NavigationKind::Cli,
        );
    }
}

pub(crate) fn emit_all(app: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    for record in app.state::<LocalWindows>().records() {
        if let Some(window) = app.get_webview_window(&record.label) {
            let _ = window.emit(event, payload.clone());
        }
    }
}

#[tauri::command]
pub(crate) fn desktop_launch_ready(
    window: WebviewWindow,
    app: AppHandle,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    crate::require_local_app_window(&window, &state)?;
    windows.renderer_ready(&app, window.label())
}

#[tauri::command]
pub(crate) fn desktop_launch_next_folder(
    window: WebviewWindow,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Option<String>, String> {
    crate::require_local_app_window(&window, &state)?;
    windows.next_folder(window.label())
}

#[tauri::command]
pub(crate) fn desktop_launch_acknowledge_folder(
    window: WebviewWindow,
    windows: tauri::State<'_, LocalWindows>,
    state: tauri::State<'_, crate::AppState>,
    folder: String,
    opened: bool,
) -> Result<(), String> {
    crate::require_local_app_window(&window, &state)?;
    windows.acknowledge_folder(window.label(), &folder, opened)
}

#[cfg(test)]
#[path = "local_windows_tests.rs"]
mod tests;
