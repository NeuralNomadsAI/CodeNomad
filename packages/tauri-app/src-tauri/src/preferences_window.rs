use crate::{
    cli_manager::LocalCliAccess,
    AppState,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;
pub(crate) mod memory_cleanup;
pub(crate) mod server_selection;

pub(crate) const LABEL: &str = "preferences";
pub(crate) const SECTION_EVENT: &str = "preferences:section";
const DEFAULT_SECTION: &str = "general";
const CONTEXT_SCRIPT: &str = "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'preferences';";

const SECTIONS: &[&str] = &[
    "general",
    "chat",
    "hotkeys",
    "notifications",
    "speech",
    "remote",
    "servers",
    "opencode",
    "providers",
    "missions",
    "usage",
    "sidecars",
    "config-files",
    "advanced",
    "info",
];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreferencesLocation {
    pub(crate) directory: String,
    #[serde(rename = "workspaceID", skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreferencesRequest {
    pub(crate) section: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scroll_top: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) location: Option<PreferencesLocation>,
}

/// Host-observed local window label that opened Preferences, never renderer-supplied.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PreferencesOpener {
    label: Option<String>,
    epoch: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenerStartupStateResult {
    epoch: u64,
    state: Option<crate::client_state::StartupStateSnapshot>,
    applied: bool,
}

#[derive(Debug)]
struct PreferencesState {
    request: PreferencesRequest,
    opener: PreferencesOpener,
    renderer_ready: bool,
    incarnation: u64,
    close: PreferencesClose,
    transition_id: u64,
    pending_transition: Option<(u64, PreferencesTransition)>,
    trusted_origins: Vec<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
enum PreferencesClose {
    #[default]
    Open,
    Persisting { shutdown_generation: Option<u64> },
    Approved,
}

pub(crate) enum ShutdownPrepare {
    Renderer,
    JoinClose,
    Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreferencesTransition {
    Loading,
    Backend,
}

#[derive(Clone, Serialize)]
struct PreferencesTransitionRequest {
    id: u64,
}

pub(crate) struct PreferencesWindow {
    selection: server_selection::SelectionCommands,
    cleanup: memory_cleanup::CleanupCommands,
    operation: Mutex<()>,
    // Serialize restore-record writes and incarnation replacement without
    // holding the state lock while the filesystem responds.
    persistence: Mutex<()>,
    state: Mutex<PreferencesState>,
}

impl Default for PreferencesWindow {
    fn default() -> Self {
        Self {
            selection: server_selection::SelectionCommands::default(),
            cleanup: memory_cleanup::CleanupCommands::default(),
            operation: Mutex::new(()),
            persistence: Mutex::new(()),
            state: Mutex::new(PreferencesState {
                request: PreferencesRequest {
                    section: DEFAULT_SECTION.to_string(),
                    scroll_top: None,
                    instance_id: None,
                    server_id: None,
                    workspace_path: None,
                    location: None,
                },
                opener: PreferencesOpener::default(),
                renderer_ready: false,
                incarnation: 0,
                close: PreferencesClose::Open,
                transition_id: 0,
                pending_transition: None,
                trusted_origins: Vec::new(),
            }),
        }
    }
}

impl PreferencesWindow {
    fn new_incarnation(&self, request: PreferencesRequest) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.incarnation += 1;
        state.close = PreferencesClose::Open;
        state.renderer_ready = false;
        state.pending_transition = None;
        state.request = request;
        state.incarnation
    }

    fn save_request(
        &self,
        incarnation: u64,
        request: PreferencesRequest,
        persist: impl FnOnce(&PreferencesRequest) -> Result<(), String>,
    ) -> Result<bool, String> {
        let _write = self.persistence.lock().unwrap_or_else(|error| error.into_inner());
        {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.incarnation != incarnation || state.close == PreferencesClose::Approved {
                return Ok(false);
            }
        }
        persist(&request)?;
        self.state.lock().unwrap_or_else(|error| error.into_inner()).request = request;
        Ok(true)
    }

    fn incarnation(&self) -> u64 {
        self.state.lock().unwrap_or_else(|error| error.into_inner()).incarnation
    }

    fn admit_close(
        &self,
        incarnation: u64,
        enqueue: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<bool, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.incarnation != incarnation || state.close != PreferencesClose::Open {
            return Ok(false);
        }
        enqueue()?;
        state.close = PreferencesClose::Persisting { shutdown_generation: None };
        Ok(true)
    }

    #[cfg(test)]
    fn begin_close(&self, incarnation: u64) -> bool {
        self.admit_close(incarnation, || Ok(())).unwrap()
    }

    fn persist_close(
        &self,
        incarnation: u64,
        persist: impl FnOnce() -> Result<(), String>,
    ) -> Option<(Result<(), String>, Option<u64>)> {
        let _write = self.persistence.lock().unwrap_or_else(|error| error.into_inner());
        {
            let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.incarnation != incarnation || !matches!(state.close, PreferencesClose::Persisting { .. }) {
                return None;
            }
        }
        let result = persist();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let previous = std::mem::replace(&mut state.close, if result.is_ok() {
            PreferencesClose::Approved
        } else {
            PreferencesClose::Open
        });
        let PreferencesClose::Persisting { shutdown_generation } = previous else {
            unreachable!("a close holds persistence authority until its result is published");
        };
        Some((result, shutdown_generation))
    }

    /// A new Preferences window always starts a new opener epoch; reuse rotates
    /// it only when another local window asks for Preferences.
    fn set_opener(&self, label: Option<String>, new_window: bool) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if new_window || (label.is_some() && label != state.opener.label) {
            state.opener = PreferencesOpener {
                label,
                epoch: state.opener.epoch.wrapping_add(1),
            };
        }
    }

    fn opener(&self) -> PreferencesOpener {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .opener
            .clone()
    }

    fn request(&self) -> PreferencesRequest {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .request
            .clone()
    }

    pub(crate) fn prepare_shutdown(&self, generation: u64) -> ShutdownPrepare {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let renderer_ready = state.renderer_ready;
        match &mut state.close {
            PreferencesClose::Persisting { shutdown_generation } => {
                *shutdown_generation = Some(shutdown_generation.unwrap_or_default().max(generation));
                ShutdownPrepare::JoinClose
            }
            PreferencesClose::Open if renderer_ready => ShutdownPrepare::Renderer,
            _ => ShutdownPrepare::Skip,
        }
    }
}

fn save_request(
    app: &AppHandle,
    preferences: &PreferencesWindow,
    incarnation: u64,
    request: PreferencesRequest,
) -> Result<bool, String> {
    let (done, reply) = std::sync::mpsc::sync_channel(1);
    if !enqueue_request(app, preferences, incarnation, request, move |result| {
        let _ = done.send(result);
    })? {
        return Ok(false);
    }
    reply.recv().map_err(|error| error.to_string())?
}

fn enqueue_request<R: tauri::Runtime>(
    app: &AppHandle<R>,
    preferences: &PreferencesWindow,
    incarnation: u64,
    request: PreferencesRequest,
    complete: impl FnOnce(Result<bool, String>) + Send + 'static,
) -> Result<bool, String> {
    let state = preferences.state.lock().unwrap_or_else(|error| error.into_inner());
    if state.incarnation != incarnation || state.close != PreferencesClose::Open {
        return Ok(false);
    }
    let worker = app.clone();
    app.state::<crate::client_state::IpcQueue>().enqueue(Box::new(move || {
        complete(worker.state::<PreferencesWindow>().save_request(incarnation, request, |request| {
            worker.state::<crate::client_state::ClientState>()
                .set_preferences(Some(request.clone()))
                .map(|_| ())
        }));
    }))?;
    Ok(true)
}

fn validate_section(section: &str) -> Result<(), String> {
    SECTIONS
        .contains(&section)
        .then_some(())
        .ok_or_else(|| "Invalid preferences section".to_string())
}

pub(crate) fn validate_request(request: PreferencesRequest) -> Result<PreferencesRequest, String> {
    validate_section(&request.section)?;
    if request.server_id.as_ref().is_some_and(|value| value.is_empty() || value.len() > 512) {
        return Err("Invalid Preferences server ID".to_string());
    }
    if request.scroll_top.is_some_and(|top| top > 10_000_000) {
        return Err("Invalid Preferences scroll position".to_string());
    }
    if request
        .instance_id
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 512)
    {
        return Err("Invalid Preferences instance ID".to_string());
    }
    if request
        .workspace_path
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 32768 || value.contains('\0'))
    {
        return Err("Invalid Preferences workspace path".to_string());
    }
    if let Some(location) = &request.location {
        if location.directory.is_empty() || location.directory.len() > 32768 {
            return Err("Invalid Preferences directory".to_string());
        }
        if location
            .workspace_id
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 512)
        {
            return Err("Invalid Preferences workspace ID".to_string());
        }
    }
    Ok(request)
}

fn target_url(base_url: &str, section: &str) -> Result<Url, String> {
    let mut target = Url::parse(base_url).map_err(|error| error.to_string())?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("Preferences backend URL must use HTTP or HTTPS".to_string());
    }
    target.query_pairs_mut().append_pair("preferences", section);
    Ok(target)
}

fn focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn navigate_authenticated(
    window: &tauri::WebviewWindow,
    access: &LocalCliAccess,
    section: &str,
) -> Result<(), String> {
    let origin = Url::parse(&access.base_url)
        .map_err(|error| error.to_string())?
        .origin()
        .ascii_serialization();
    let preferences = window.app_handle().state::<PreferencesWindow>();
    let mut state = preferences
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state
        .trusted_origins
        .retain(|candidate| candidate != &origin);
    state.trusted_origins.push(origin);
    if state.trusted_origins.len() > 2 {
        state.trusted_origins.remove(0);
    }
    drop(state);
    window.app_handle().state::<AppState>().manager
        .install_local_window_cookie(window.as_ref(), &access.base_url)
        .map_err(|error| error.to_string())?;
    window
        .navigate(target_url(&access.base_url, section)?)
        .map_err(|error| error.to_string())
}

pub(crate) fn is_trusted_renderer_origin(webview: &tauri::Webview, url: &Url) -> bool {
    webview
        .app_handle()
        .state::<PreferencesWindow>()
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .trusted_origins
        .contains(&url.origin().ascii_serialization())
}

#[tauri::command]
pub(crate) async fn open_preferences_window(
    webview: tauri::Webview,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    request: PreferencesRequest,
    toggle: Option<bool>,
    resume: Option<bool>,
) -> Result<(), String> {
    crate::require_local_app_webview(&webview, &app_state)?;
    let mut request = validate_request(request)?;
    let opener = webview.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        if resume.unwrap_or(false) {
            if let Some(last) = app.state::<crate::client_state::ClientState>().last_preferences() {
                request.section = last.section;
                request.scroll_top = last.scroll_top;
            }
        }
        open_preferences(&app, &app.state::<AppState>(), &app.state::<PreferencesWindow>(),
            request, toggle.unwrap_or(false), Some(opener))
    }).await.map_err(|error| error.to_string())?
}

pub(crate) fn open_speech(app: &AppHandle) -> Result<(), String> {
    open_preferences(
        app,
        &app.state::<AppState>(),
        &app.state::<PreferencesWindow>(),
        PreferencesRequest {
            section: "speech".into(),
            scroll_top: None,
            instance_id: None,
            server_id: None,
            workspace_path: None,
            location: None,
        },
        false,
        None,
    )
}

fn open_preferences(
    app: &AppHandle,
    app_state: &AppState,
    preferences: &PreferencesWindow,
    request: PreferencesRequest,
    toggle: bool,
    opener: Option<String>,
) -> Result<(), String> {
    let request = validate_request(request)?;
    let _operation = preferences
        .operation
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(existing) = app.get_webview_window(LABEL) {
        if toggle {
            existing.close().map_err(|error| error.to_string())?;
            return Ok(());
        }
        let renderer_ready = preferences
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .renderer_ready;
        if !renderer_ready {
            save_request(app, preferences, preferences.incarnation(), request.clone())?;
        }
        // Startup state follows the newest opener even while other drafts are guarded.
        preferences.set_opener(opener.clone(), false);
        if existing.emit(SECTION_EVENT, &request).is_ok() && focus(&existing).is_ok() {
            return Ok(());
        }
        let _ = existing.destroy();
    }

    app_state.manager.ready_local_access().ok_or("Local CodeNomad server is unavailable")?;
    let incarnation = {
        let _write = preferences.persistence.lock().unwrap_or_else(|error| error.into_inner());
        crate::shutdown::with_navigation_authority(app, || preferences.new_incarnation(request.clone()))
            .ok_or("The CodeNomad host is shutting down")?
    };
    preferences.set_opener(opener, true);
    let data_directory = app_state.webview_data_directory.join("local");
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("loading.html".into()))
        .data_directory(data_directory)
        .initialization_script(CONTEXT_SCRIPT)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let zoom = crate::client_state::local_window_zoom(window.app_handle(), LABEL);
                crate::title_bar::publish_page_zoom(window.as_ref(), zoom);
            }
        });
    #[cfg(windows)]
    let developer_browser_arguments = app_state.developer_browser_arguments.clone();
    #[cfg(windows)]
    let builder = if let Some(arguments) = developer_browser_arguments.as_deref() {
        builder.additional_browser_args(arguments)
    } else {
        builder
    };
    #[cfg(target_os = "macos")]
    let builder = if app_state.scoped_profile {
        builder.data_store_identifier(crate::profile_identifier("local"))
    } else {
        builder
    };
    let preferences_window = crate::title_bar::configure(crate::window_zoom::configure(builder))
        .title("Preferences")
        .inner_size(1100.0, 760.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .fullscreen(false)
        .background_color(tauri::window::Color(26, 26, 26, 255))
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    crate::menu_bar::hide(&preferences_window.as_ref().window());
    crate::remote_dictation::bind_termination(preferences_window.as_ref(), None);
    #[cfg(target_os = "linux")]
    crate::device_speech_ipc::bind_microphone(&preferences_window, false);

    if let Err(error) =
        crate::client_state::setup_local_window(app, &preferences_window, LABEL, true, true)
    {
        let _ = preferences_window.destroy();
        return Err(error);
    }

    let navigation = app_state.manager.ready_local_access().ok_or_else(|| "Local CodeNomad server is unavailable".to_string())
        .and_then(|access| navigate_authenticated(&preferences_window, &access, &request.section));
    if let Err(error) = navigation {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    #[cfg(windows)]
    if let Err(error) = crate::shutdown::schedule_windows_session_end_handler(&preferences_window) {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    if let Err(error) = focus(&preferences_window) {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    if let Err(error) = save_request(app, preferences, incarnation, request) {
        let _ = preferences_window.destroy();
        return Err(error);
    }
    Ok(())
}

pub(crate) fn navigate_backend(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_none() {
        // A connect-only launch keeps the saved request pending; its normal-start fallback restores it.
        if app
            .state::<crate::local_windows::LocalWindows>()
            .startup_restore_deferred()
        {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            if let Some(request) = app
                .try_state::<crate::client_state::ClientState>()
                .and_then(|state| state.preferences())
            {
                let app_state = app.state::<AppState>();
                let preferences = app.state::<PreferencesWindow>();
                // A restored window has no host-observed opener.
                if let Err(error) =
                    open_preferences(&app, &app_state, &preferences, request, false, None)
                {
                    eprintln!("[tauri] failed to restore preferences window: {error}");
                }
            }
        });
        return;
    }
    if request_transition(app, PreferencesTransition::Backend) {
        return;
    }
    let dispatch = app.clone();
    let _ = app.run_on_main_thread(move || navigate_backend_now(&dispatch));
}

fn navigate_backend_now(app: &AppHandle) {
    if crate::shutdown::with_navigation_authority(app, || ()).is_none() {
        return;
    }
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let Some(access) = app.state::<AppState>().manager.ready_local_access() else {
        return;
    };
    let preferences = app.state::<PreferencesWindow>();
    let request = preferences.request();
    if let Err(error) = navigate_authenticated(&window, &access, &request.section) {
        eprintln!("[tauri] failed to navigate preferences window: {error}");
    }
}

pub(crate) fn emit_section(app: &AppHandle) {
    let request = app.state::<PreferencesWindow>().request();
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit(SECTION_EVENT, request);
    }
}

#[tauri::command]
pub(crate) fn preferences_window_ready(
    webview: tauri::Webview,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
) -> Result<(), String> {
    let incarnation = preferences.incarnation();
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    if webview.label() != LABEL {
        return Err("Preferences readiness requires the Preferences window".to_string());
    }
    let mut state = preferences.state.lock().unwrap_or_else(|error| error.into_inner());
    if state.incarnation == incarnation {
        state.renderer_ready = true;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn preferences_get_request(
    webview: tauri::Webview,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
) -> Result<PreferencesRequest, String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    if webview.label() != LABEL {
        return Err("Preferences request access requires the Preferences window".to_string());
    }
    Ok(preferences.request())
}

pub(crate) fn admit_accept_request(invoke: tauri::ipc::Invoke<tauri::Wry>) {
    reply_to_accept_request(
        invoke,
        |webview| {
            crate::require_preferences_or_local_app_webview(
                webview,
                &webview.app_handle().state::<AppState>(),
            )
            .map(|_| ())
        },
        crate::shutdown::preferences_renderer_flushed,
    );
}

fn reply_to_accept_request<R: tauri::Runtime>(
    invoke: tauri::ipc::Invoke<R>,
    authorize: impl FnOnce(&tauri::Webview<R>) -> Result<(), String>,
    renderer_flushed: impl FnOnce(AppHandle<R>, u64) + Send + 'static,
) {
    #[derive(Deserialize)]
    struct Args {
        request: PreferencesRequest,
        generation: Option<u64>,
    }
    let webview = invoke.message.webview_ref();
    let app = webview.app_handle();
    let preferences = app.state::<PreferencesWindow>();
    let resolver = invoke.resolver;
    let result = (|| {
        if webview.label() != LABEL {
            return Err("Preferences request acceptance requires the Preferences window".to_string());
        }
        let incarnation = preferences.incarnation();
        authorize(webview)?;
        let tauri::ipc::InvokeBody::Json(body) = invoke.message.payload() else {
            return Err("Invalid Preferences request body".into());
        };
        let Args { request, generation } = Args::deserialize(body).map_err(|error| error.to_string())?;
        let request = validate_request(request)?;
        let worker = app.clone();
        let reply = resolver.clone();
        enqueue_request(app, &preferences, incarnation, request, move |result| {
            if let Some(generation) = generation.filter(|_| matches!(result, Ok(true))) {
                renderer_flushed(worker, generation);
            }
            match result {
                Ok(_) => reply.resolve(()),
                Err(error) => reply.reject(error),
            }
        })
    })();
    match result {
        Ok(true) => {}
        Ok(false) => resolver.resolve(()),
        Err(error) => resolver.reject(error),
    }
}

/// A mutation prepared against an older opener degrades to a read of the
/// current one, so a change is never applied to a window the user did not see.
fn effective_startup_command(
    opener: &PreferencesOpener,
    command: &'static str,
    expected_epoch: Option<u64>,
) -> &'static str {
    if command != "read" && expected_epoch != Some(opener.epoch) {
        "read"
    } else {
        command
    }
}

/// Prefer the original opener over a more recently used window.
fn opener_or_recent(
    opener: Option<String>,
    is_live: impl Fn(&str) -> bool,
    recent: impl FnOnce() -> Option<String>,
) -> Option<String> {
    opener
        .filter(|label| is_live(label))
        .or_else(|| recent().filter(|label| is_live(label)))
}

#[tauri::command]
pub(crate) async fn preferences_opener_startup_state(
    webview: tauri::Webview,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    command: String,
    epoch: Option<u64>,
) -> Result<OpenerStartupStateResult, String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    if webview.label() != LABEL {
        return Err("Opener startup state requires the Preferences window".to_string());
    }
    let command = crate::client_state::startup_state_command(&command)?;
    let current = preferences.opener();
    let target = opener_or_recent(
        current.label.clone(),
        |label| app.get_webview_window(label).is_some(),
        || {
            app.state::<crate::local_windows::LocalWindows>()
                .mru_label()
        },
    );
    if target.is_some() && target != current.label {
        preferences.set_opener(target, false);
    }
    let opener = preferences.opener();
    let effective = effective_startup_command(&opener, command, epoch);
    let state = match opener.label.as_deref() {
        Some(label) => {
            crate::client_state::run_startup_state_command(&app, label, effective).await?
        }
        None => None,
    };
    Ok(OpenerStartupStateResult {
        epoch: opener.epoch,
        state,
        applied: effective != "read" && state.is_some(),
    })
}

#[tauri::command]
pub(crate) fn preferences_resolve_transition(
    webview: tauri::Webview,
    app: AppHandle,
    app_state: tauri::State<'_, AppState>,
    preferences: tauri::State<'_, PreferencesWindow>,
    id: u64,
    approved: bool,
) -> Result<(), String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    if webview.label() != LABEL {
        return Err("Preferences transition response requires the Preferences window".to_string());
    }
    let transition = {
        let mut state = preferences
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.pending_transition.as_ref().map(|pending| pending.0) != Some(id) {
            return Ok(());
        }
        state.pending_transition.take().map(|pending| pending.1)
    };
    if !approved {
        // The kept page still owns an update it started; report its failure now.
        crate::desktop_updater::notify_preferences_failure(&app);
        return Ok(());
    }
    match transition {
        Some(PreferencesTransition::Loading) => show_loading_now(&app),
        Some(PreferencesTransition::Backend) => {
            suspend_guard(&app);
            navigate_backend_now(&app);
        }
        None => {}
    }
    Ok(())
}

fn request_transition(app: &AppHandle, transition: PreferencesTransition) -> bool {
    let preferences = app.state::<PreferencesWindow>();
    let id = {
        let mut state = preferences
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.renderer_ready {
            return false;
        }
        if state
            .pending_transition
            .as_ref()
            .is_some_and(|pending| pending.1 == transition)
        {
            return true;
        }
        state.transition_id = state.transition_id.wrapping_add(1);
        let id = state.transition_id;
        state.pending_transition = Some((id, transition));
        id
    };
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit(
            "preferences:transition-requested",
            PreferencesTransitionRequest { id },
        );
    }
    true
}

pub(crate) fn suspend_guard(app: &AppHandle) {
    let preferences = app.state::<PreferencesWindow>();
    let mut state = preferences
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state.renderer_ready = false;
    state.pending_transition = None;
}

pub(crate) async fn approve_close(app: &AppHandle) -> Result<bool, String> {
    let incarnation = app.state::<PreferencesWindow>().incarnation();
    let (done, reply) = tokio::sync::oneshot::channel();
    // Capturing the window geometry waits on the native thread: keep it off the executor.
    let worker = app.clone();
    let admitted = crate::off_executor(move || {
        enqueue_close(&worker, incarnation, move |result| {
            let _ = done.send(result);
        })
    })
    .await?;
    if !admitted {
        return Ok(false);
    }
    reply.await.map_err(|error| error.to_string())?
}

fn enqueue_close(
    app: &AppHandle,
    incarnation: u64,
    complete: impl FnOnce(Result<bool, String>) + Send + 'static,
) -> Result<bool, String> {
    // The close is only admitted once its last native inputs are captured.
    crate::client_state::capture_preferences_window(app);
    let worker = app.clone();
    let preferences = app.state::<PreferencesWindow>();
    crate::shutdown::with_navigation_authority(app, || {
        preferences.admit_close(incarnation, || {
            app.state::<crate::client_state::IpcQueue>().enqueue(Box::new(move || {
                complete(finish_close(&worker, incarnation));
            }))
        })
    }).unwrap_or(Ok(false))
}

fn finish_close(app: &AppHandle, incarnation: u64) -> Result<bool, String> {
    let Some((result, generation)) = persist_close_request(app, incarnation) else {
        return Ok(false);
    };
    if let Some(generation) = generation {
        let dispatch = app.clone();
        let saved = result.is_ok();
        let _ = app.run_on_main_thread(move || {
            crate::shutdown::preferences_close_settled(&dispatch, generation, saved);
        });
    }
    result.map(|()| true)
}

fn persist_close_request<R: tauri::Runtime>(
    app: &AppHandle<R>,
    incarnation: u64,
) -> Option<(Result<(), String>, Option<u64>)> {
    app.state::<PreferencesWindow>().persist_close(incarnation, || {
        app.state::<crate::client_state::ClientState>()
            .set_preferences(None)
            .map(|_| ())
    })
}

pub(crate) fn intercept_close(app: &AppHandle) -> bool {
    let preferences = app.state::<PreferencesWindow>();
    let (incarnation, ready) = {
        let state = preferences.state.lock().unwrap_or_else(|error| error.into_inner());
        match state.close {
            PreferencesClose::Approved => return false,
            PreferencesClose::Persisting { .. } => return true,
            PreferencesClose::Open => (state.incarnation, state.renderer_ready),
        }
    };
    let Some(window) = app.get_webview_window(LABEL) else {
        return true;
    };
    if ready {
        if crate::shutdown::with_navigation_authority(app, || ()).is_some() {
            let _ = window.emit("preferences:close-requested", ());
        }
    } else {
        let dispatch = app.clone();
        if let Err(error) = enqueue_close(app, incarnation, move |result| match result {
            Ok(true) => {
                let _ = dispatch.run_on_main_thread(move || { let _ = window.close(); });
            }
            Ok(false) => {}
            Err(error) => eprintln!("[client-state] failed to close Preferences: {error}"),
        }) {
            eprintln!("[client-state] failed to admit Preferences close: {error}");
        }
    }
    true
}

pub(crate) fn show_loading(app: &AppHandle) {
    if request_transition(app, PreferencesTransition::Loading) {
        return;
    }
    show_loading_now(app);
}

fn show_loading_now(app: &AppHandle) {
    suspend_guard(app);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window
            .navigate(Url::parse("tauri://localhost/loading.html").expect("loading URL is valid"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn admitted_preferences_ipc_replies_drain_without_native_dispatch() {
        use crate::client_state::{ClientState, IpcQueue};
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };
        use tauri::{
            ipc::{CallbackFn, InvokeResponse},
            test,
            webview::InvokeRequest,
        };

        let directory = tempfile::tempdir().unwrap();
        let (flushed, acknowledged) = mpsc::channel();
        let app = test::mock_builder()
            .manage(ClientState::initialize_at(directory.path()).unwrap())
            .manage(IpcQueue::new())
            .manage(PreferencesWindow::default())
            .invoke_handler(move |invoke| {
                assert_eq!(invoke.message.command(), "preferences_accept_request");
                let flushed = flushed.clone();
                reply_to_accept_request(invoke, |_| Ok(()), move |app, generation| {
                    flushed.send((generation, app.state::<ClientState>().preferences())).unwrap();
                });
                true
            })
            .build(test::mock_context(test::noop_assets())).unwrap();
        let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .build().unwrap();
        let url = window.url().unwrap();
        let state = app.state::<ClientState>();
        let preferences = app.state::<PreferencesWindow>();
        let queue = app.state::<IpcQueue>();
        let incarnation = preferences.new_incarnation(preferences.request());
        let request = PreferencesRequest { section: "speech".into(), ..preferences.request() };
        let (resume, gate) = mpsc::channel();
        queue.enqueue(Box::new(move || gate.recv_timeout(Duration::from_secs(5)).unwrap())).unwrap();
        let (reply, save_result) = mpsc::channel();
        window.as_ref().clone().on_message(
            InvokeRequest {
                cmd: "preferences_accept_request".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url,
                body: json!({ "request": request, "generation": 5 }).into(),
                headers: Default::default(),
                invoke_key: test::INVOKE_KEY.to_string(),
            },
            Box::new(move |_, _, result, _, _| { let _ = reply.send(result); }),
        );
        let worker = app.handle().clone();
        let (closed, close_result) = mpsc::channel();
        let expected = request.clone();
        assert!(preferences.admit_close(incarnation, || queue.enqueue(Box::new(move || {
            assert_eq!(worker.state::<ClientState>().preferences(), Some(expected));
            closed.send(persist_close_request(&worker, incarnation).unwrap()).unwrap();
        }))).unwrap());
        assert!(matches!(preferences.prepare_shutdown(6), ShutdownPrepare::JoinClose));
        // Keep this dispatch thread in the barrier instead of pumping native events.
        assert!(!queue.seal_and_drain_until(Instant::now() + Duration::from_millis(20)));
        assert!(matches!(save_result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(matches!(acknowledged.try_recv(), Err(mpsc::TryRecvError::Empty)));
        resume.send(()).unwrap();
        assert!(queue.seal_and_drain_until(Instant::now() + Duration::from_secs(5)));
        assert!(matches!(save_result.try_recv().unwrap(), InvokeResponse::Ok(_)));
        assert_eq!(acknowledged.try_recv().unwrap(), (5, Some(request)));
        assert_eq!(close_result.try_recv().unwrap(), (Ok(()), Some(6)));
        assert!(state.preferences().is_none());
    }

    #[test]
    fn quit_joins_the_only_preferences_close_write() {
        let preferences = PreferencesWindow::default();
        let incarnation = preferences.new_incarnation(preferences.request());
        assert!(preferences.begin_close(incarnation));
        std::thread::scope(|scope| {
            let (writing, started) = std::sync::mpsc::channel();
            let (finish, release) = std::sync::mpsc::channel();
            let preferences = &preferences;
            let worker = scope.spawn(move || preferences.persist_close(incarnation, || {
                writing.send(()).unwrap();
                release.recv().unwrap();
                Ok(())
            }));
            started.recv().unwrap();
            assert!(!preferences.begin_close(incarnation));
            assert!(matches!(preferences.prepare_shutdown(14), ShutdownPrepare::JoinClose));
            finish.send(()).unwrap();
            assert_eq!(worker.join().unwrap(), Some((Ok(()), Some(14))));
        });
        assert!(matches!(preferences.prepare_shutdown(15), ShutdownPrepare::Skip));
    }

    #[test]
    fn close_refuses_before_publication_but_approves_when_only_durability_is_pending() {
        use crate::client_state::ClientState;
        use std::sync::{
            atomic::{AtomicU8, Ordering},
            Arc,
        };

        let directory = tempfile::tempdir().unwrap();
        let failure = Arc::new(AtomicU8::new(0));
        let before_rename = failure.clone();
        let sync_directory = failure.clone();
        let state = ClientState::initialize_at_with_publication_checks(
            directory.path(),
            move || (before_rename.load(Ordering::Relaxed) != 1)
                .then_some(()).ok_or_else(|| "injected write failure".into()),
            move || (sync_directory.load(Ordering::Relaxed) != 2)
                .then_some(()).ok_or_else(|| "injected sync failure".into()),
        ).unwrap();
        let app = tauri::test::mock_builder()
            .manage(state)
            .manage(PreferencesWindow::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let preferences = app.state::<PreferencesWindow>();
        let state = app.state::<ClientState>();
        let incarnation = preferences.new_incarnation(preferences.request());
        preferences.state.lock().unwrap().renderer_ready = true;
        let request = preferences.request();
        assert!(state.set_preferences(Some(request.clone())).unwrap());
        let persisted = || -> serde_json::Value {
            let bytes = std::fs::read(directory.path().join("client-state.json")).unwrap();
            serde_json::from_slice(&bytes).unwrap()
        };

        failure.store(1, Ordering::Relaxed);
        assert!(preferences.begin_close(incarnation));
        assert!(matches!(preferences.prepare_shutdown(7), ShutdownPrepare::JoinClose));
        assert_eq!(
            persist_close_request(app.handle(), incarnation),
            Some((Err("injected write failure".into()), Some(7)))
        );
        assert_eq!(state.preferences(), Some(request.clone()));
        assert_eq!(persisted()["preferences"], json!(request));
        assert!(matches!(preferences.prepare_shutdown(7), ShutdownPrepare::Renderer));

        failure.store(2, Ordering::Relaxed);
        assert!(preferences.begin_close(incarnation));
        assert!(matches!(preferences.prepare_shutdown(8), ShutdownPrepare::JoinClose));
        assert_eq!(persist_close_request(app.handle(), incarnation), Some((Ok(()), Some(8))));
        assert!(state.preferences().is_none());
        assert!(persisted().get("preferences").is_none());
        assert_eq!(state.last_preferences(), Some(request));
        assert!(matches!(preferences.prepare_shutdown(8), ShutdownPrepare::Skip));
        assert!(state.prepare_ownership_release().unwrap_err().contains("injected sync failure"));
        failure.store(0, Ordering::Relaxed);
        state.prepare_ownership_release().unwrap();
    }

    #[test]
    fn stale_close_worker_cannot_clear_or_approve_a_replacement() {
        let preferences = PreferencesWindow::default();
        let first = preferences.new_incarnation(preferences.request());
        assert!(preferences.begin_close(first));
        let request = PreferencesRequest { section: "speech".into(), ..preferences.request() };
        let replacement = preferences.new_incarnation(request.clone());
        assert!(preferences.begin_close(replacement));
        assert!(preferences.persist_close(first, || panic!("stale write")).is_none());
        assert!(!preferences
            .save_request(first, request.clone(), |_| panic!("stale request write"))
            .unwrap());
        assert_eq!(preferences.request(), request);
        assert!(matches!(preferences.prepare_shutdown(3), ShutdownPrepare::JoinClose));
        assert_eq!(preferences.persist_close(replacement, || Ok(())), Some((Ok(()), Some(3))));
    }

    #[test]
    fn validates_sections_and_builds_an_explicit_preferences_target() {
        assert!(validate_section("general").is_ok());
        assert!(validate_section("speech").is_ok());
        assert!(validate_section("servers").is_ok());
        assert!(validate_section("workspace").is_err());

        let target = target_url("http://127.0.0.1:3000/", "chat").unwrap();
        assert_eq!(target.host_str(), Some("127.0.0.1"));
        assert!(target
            .query_pairs()
            .any(|(key, value)| key == "preferences" && value == "chat"));
        assert!(target_url("file:///tmp/preferences", "chat").is_err());
        let request = validate_request(PreferencesRequest {
            scroll_top: None,
            section: "providers".into(),
            instance_id: Some("remote~workspace-1".into()),
            server_id: Some("remote-server".into()),
            workspace_path: Some("C:\\repo".into()),
            location: Some(PreferencesLocation {
                directory: "/mnt/c/repo".into(),
                workspace_id: Some("worktree-1".into()),
            }),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&request).unwrap()["location"]["workspaceID"],
            "worktree-1"
        );
        let serialized = serde_json::to_value(&request).unwrap();
        assert_eq!(serialized["workspacePath"], "C:\\repo");
        assert_eq!(serialized["serverId"], "remote-server");
        assert_eq!(serialized["location"]["directory"], "/mnt/c/repo");
        assert_eq!(
            serde_json::from_value::<PreferencesRequest>(serialized).unwrap(),
            request
        );
        assert!(validate_request(PreferencesRequest {
            workspace_path: Some("bad\0path".into()),
            ..request
        })
        .is_err());
    }

    #[test]
    fn shared_local_session_cookie_remains_http_only() {
        let cookie =
            crate::cli_manager::local_session_cookie("http://127.0.0.1:3000", "codenomad_session_test", "secret")
                .unwrap();
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(
            cookie.same_site(),
            Some(tauri::webview::cookie::SameSite::Lax)
        );
    }

    #[test]
    fn preferences_capability_is_exact_and_excludes_workspace_state_authority() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/preferences-window.json")).unwrap();
        assert_eq!(capability["webviews"], json!([LABEL]));
        assert!(capability.get("windows").is_none());
        let permissions = capability["permissions"].as_array().unwrap();
        for excluded in [
            "client-state",
            "desktop-launch",
            "open-workspace-target",
            "set-workspace-menu-enabled",
            "wake-lock",
            "developer-",
        ] {
            assert!(!permissions.iter().any(|permission| permission
                .as_str()
                .is_some_and(|value| value.contains(excluded))));
        }
        for required in [
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "allow-preferences-window-ready",
            "allow-window-control",
        ] {
            assert!(permissions.contains(&json!(required)));
        }

        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        assert!(local["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-open-preferences-window")));
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("preferences-window")));
    }

    #[test]
    fn startup_state_follows_the_latest_opener_and_fences_stale_mutations() {
        let preferences = PreferencesWindow::default();
        let window_a = "local-11111111-2222-4333-8444-555555555555".to_string();
        let window_b = "local-66666666-2222-4333-8444-555555555555".to_string();
        preferences.set_opener(Some(window_a.clone()), true);
        let first = preferences.opener();
        assert_eq!(first.label.as_deref(), Some(window_a.as_str()));
        assert_eq!(
            effective_startup_command(&first, "disable-restore", Some(first.epoch)),
            "disable-restore"
        );
        assert_eq!(effective_startup_command(&first, "clear", None), "read");

        preferences.set_opener(Some(window_a.clone()), false);
        assert_eq!(preferences.opener(), first);
        preferences.set_opener(None, false);
        assert_eq!(preferences.opener(), first);
        preferences.set_opener(Some(window_b.clone()), false);
        let second = preferences.opener();
        assert_eq!(second.label.as_deref(), Some(window_b.as_str()));
        assert!(second.epoch > first.epoch);
        assert_eq!(
            effective_startup_command(&second, "enable-restore", Some(first.epoch)),
            "read"
        );

        // A restored Preferences window has no opener, even if one existed before.
        preferences.set_opener(None, true);
        let restored = preferences.opener();
        assert_eq!(restored.label, None);
        assert!(restored.epoch > second.epoch);
    }

    #[test]
    fn startup_state_targets_a_live_opener_otherwise_the_most_recent_window() {
        let live = |label: &str| label != "closed";
        let target = |opener: Option<&str>, recent: Option<&str>| {
            opener_or_recent(opener.map(str::to_string), live, || recent.map(str::to_string))
        };
        assert_eq!(
            target(Some("window-a"), Some("window-b")).as_deref(),
            Some("window-a")
        );
        assert_eq!(
            target(Some("closed"), Some("window-b")).as_deref(),
            Some("window-b")
        );
        assert_eq!(target(None, Some("window-b")).as_deref(), Some("window-b"));
        assert_eq!(target(None, None), None);

        // Adopting the target as opener rotates the epoch, fencing earlier changes.
        let preferences = PreferencesWindow::default();
        preferences.set_opener(None, true);
        let restored = preferences.opener();
        preferences.set_opener(target(restored.label.as_deref(), Some("window-b")), false);
        let adopted = preferences.opener();
        assert_eq!(adopted.label.as_deref(), Some("window-b"));
        assert!(adopted.epoch > restored.epoch);
        assert_eq!(
            effective_startup_command(&adopted, "clear", Some(restored.epoch)),
            "read"
        );
    }

    #[test]
    fn startup_state_capabilities_keep_preferences_non_authoritative() {
        let preferences: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/preferences-window.json")).unwrap();
        let preferences = preferences["permissions"].as_array().unwrap();
        assert!(preferences.contains(&json!("allow-preferences-opener-startup-state")));
        assert!(!preferences.contains(&json!("allow-client-state-startup-command-result")));
        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        let local = local["permissions"].as_array().unwrap();
        assert!(local.contains(&json!("allow-client-state-startup-command-result")));
        assert!(!local.contains(&json!("allow-preferences-opener-startup-state")));
    }

    #[test]
    fn preferences_context_is_not_a_local_window_context() {
        assert_eq!(LABEL, "preferences");
        assert!(!LABEL.starts_with("local-"));
        assert!(CONTEXT_SCRIPT.contains("__CODENOMAD_WINDOW_CONTEXT__ = 'preferences'"));
    }
}
