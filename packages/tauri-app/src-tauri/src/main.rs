#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod appimage_environment;
#[cfg(target_os = "linux")]
mod appimage_exit;
mod automation;
mod browser_controller;
#[allow(dead_code)]
mod cert_manager;
mod cli_manager;
mod clipboard_attachments;
mod client_state;
mod data_profile;
mod data_profile_cleanup;
mod developer_mode;
mod developer_relaunch;
mod device_speech;
mod device_speech_hex;
mod device_speech_ipc;
mod device_speech_worker;
mod embedded_view;
mod external_open;
mod identity;
mod launch;
#[cfg(target_os = "linux")]
mod linux_tls;
mod local_windows;
#[cfg(target_os = "macos")]
mod macos_relaunch;
mod managed_node;
mod menu_bar;
mod menu_labels;
mod native_request;
mod native_service_start;
mod notification_badge;
mod notification_badge_lifetime;
mod notification_click;
mod preferences_window;
mod profile_selection_dialog;
mod profile_transition;
mod remote_dictation;
mod shutdown;
mod title_bar;
mod update_releases;
mod updater_support;
mod view_menu;
mod desktop_updater;
#[cfg(test)]
mod desktop_updater_tests;
mod window_constraints;
mod window_zoom;
#[cfg(windows)]
mod windows_browser_accelerators;
#[cfg(windows)]
mod windows_notification_identity;
#[cfg(windows)]
mod windows_session_end;
mod workspace_open;

use cli_manager::{CliProcessManager, CliStatus};
use keepawake::KeepAwake;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::menu::{
    MenuBuilder, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::{NewWindowResponse, PageLoadEvent, Webview};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{
    Code as ShortcutCode, GlobalShortcutExt, Shortcut, ShortcutState,
};
use url::Url;

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::iter;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

const ZOOM_STEP: f64 = 0.1;
const REMOTE_PROXY_CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const RELEASES_URL: &str = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest";
const RELEASES_LIST_URL: &str = "https://github.com/NeuralNomadsAI/CodeNomad/releases";
const HELP_URL: &str = "https://neuralnomadsai.github.io/CodeNomad/";
/// English page opened when no renderer can choose the UI locale (`helpUrl("en", "sponsor")`).
const SPONSOR_URL: &str = "https://neuralnomadsai.github.io/CodeNomad/en/sponsor.html";
const REMOTE_WINDOW_CONTEXT_SCRIPT: &str =
    "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'remote'; window.__CODENOMAD_REMOTE_DICTATION__ = true;";

pub struct AppState {
    pub manager: CliProcessManager,
    pub(crate) developer_mode: developer_mode::DeveloperMode,
    #[cfg(windows)]
    pub(crate) window_automation: automation::window::WindowAutomation,
    pub(crate) browser_controller: browser_controller::BrowserController,
    pub wake_lock: Mutex<WakeLockState>,
    #[cfg(not(windows))]
    wake_lock_worker: client_state::IpcQueue,
    remote_navigation: Mutex<HashMap<String, RemoteWindowMetadata>>,
    remote_navigation_generation: AtomicU64,
    remote_profiles: Mutex<HashMap<String, RemoteProfileIdentity>>,
    remote_window_operations: RemoteWindowOperationLocks,
    remote_proxy_cleanup_claims: Mutex<HashSet<String>>,
    approved_auxiliary_closes: Mutex<HashSet<String>>,
    pub remote_tls_handlers: Mutex<HashMap<String, u64>>,
    pub remote_zoom_levels: Mutex<HashMap<String, f64>>,
    pub workspace_menu_items: Mutex<Option<WorkspaceMenuItems>>,
    menu_labels: menu_labels::MenuLabels,
    native_menu_popup_active: AtomicBool,
    native_menu_popup_pending: Arc<AtomicBool>,
    pub webview_data_directory: std::path::PathBuf,
    pub developer_browser_arguments: Option<String>,
    pub scoped_profile: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteWindowMetadata {
    origin: String,
    dictation_destination: String,
    dictation_document: remote_dictation::RemoteDocument,
    title: String,
    allow_linux_tls_certificate: bool,
    generation: u64,
    window_generation: u64,
}

struct StagedRemoteWindowMetadata {
    generation: u64,
    window_generation: u64,
    previous: Option<RemoteWindowMetadata>,
}

#[derive(Default)]
struct RemoteWindowOperationLocks {
    values: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl RemoteWindowOperationLocks {
    fn for_label(&self, label: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        Ok(self
            .values
            .lock()
            .map_err(|err| err.to_string())?
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RemoteProfileIdentity {
    Direct,
    Proxy(String),
}

impl RemoteProfileIdentity {
    fn new(proxy_session_id: Option<&str>) -> Self {
        proxy_session_id
            .map(|value| Self::Proxy(value.to_string()))
            .unwrap_or(Self::Direct)
    }

    fn proxy_session_id(&self) -> Option<&str> {
        match self {
            Self::Direct => None,
            Self::Proxy(value) => Some(value),
        }
    }
}

fn should_recreate_remote_window(
    existing: Option<&RemoteProfileIdentity>,
    requested: &RemoteProfileIdentity,
) -> bool {
    existing != Some(requested)
}

#[derive(Default)]
pub struct WakeLockState {
    labels: HashSet<String>,
    handle: Option<KeepAwake>,
}

#[derive(Clone)]
pub struct WorkspaceMenuItems {
    folder: MenuItem<Wry>,
    terminal: MenuItem<Wry>,
    editor: Submenu<Wry>,
}

fn update_workspace_menu_state(app: &AppHandle) {
    let main_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || update_workspace_menu_state_on_main(&main_app)) {
        eprintln!("[menu] failed to schedule state refresh: {error}");
    }
}

// Resolve the target when the queued update runs, not on a worker before a
// possible focus change. Native menu APIs must never run under our mutexes.
fn update_workspace_menu_state_on_main(app: &AppHandle) {
    let state = app.state::<AppState>();
    // TrackPopupMenu dispatches nested focus/IPC callbacks while muda holds a
    // mutable submenu borrow. Keep renderer snapshots current, but defer native
    // traversal/mutation until the popup has returned and released that borrow.
    if state.native_menu_popup_active.load(Ordering::Relaxed) {
        return;
    }
    // Native menu tracking can temporarily take focus away from the window.
    // State and command dispatch must resolve the same focused-or-MRU target.
    let window = local_windows::focused_window(app);
    let (enabled, view_state) = app
        .state::<local_windows::LocalWindows>()
        .menu_state(window.as_ref().map(tauri::Webview::label));
    view_menu::update(app, view_state.as_ref());
    state
        .menu_labels
        .apply(view_state.as_ref().and_then(view_menu::ViewMenuState::menu_labels));
    let items = state
        .workspace_menu_items
        .lock()
        .ok()
        .and_then(|items| items.clone());
    if let Some(items) = items {
        let _ = items.folder.set_enabled(enabled);
        let _ = items.terminal.set_enabled(enabled);
        let _ = items.editor.set_enabled(enabled);
    }
}

fn is_asset_renderer_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    }
}

fn is_dev_renderer_origin(url: &Url) -> bool {
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port() == Some(1420)
}

fn same_origin(url: &Url, expected: Option<&str>) -> bool {
    expected
        .and_then(|value| Url::parse(value).ok())
        .is_some_and(|expected| url.origin() == expected.origin())
}

fn is_allowed_local_origin(url: &Url, managed_backend: Option<&str>) -> bool {
    is_asset_renderer_origin(url)
        || is_dev_renderer_origin(url)
        || same_origin(url, managed_backend)
}

/// Navigation policy for local and Preferences windows. `about:blank` is the
/// initial document carrying the boot splash: it holds no origin and grants no
/// IPC authority, so admitting it says nothing about trusted renderer origins.
fn is_navigable_local_origin(url: &Url, managed_backend: Option<&str>) -> bool {
    url.as_str() == "about:blank" || is_allowed_local_origin(url, managed_backend)
}

pub(crate) fn require_preferences_or_local_app_webview(
    webview: &tauri::Webview,
    state: &AppState,
) -> Result<Url, String> {
    if webview.label() != preferences_window::LABEL {
        return require_local_app_webview(webview, state);
    }
    let current = webview.url().map_err(|error| error.to_string())?;
    let status = state.manager.status();
    if is_allowed_local_origin(&current, status.url.as_deref())
        || preferences_window::is_trusted_renderer_origin(webview, &current)
    {
        Ok(current)
    } else {
        Err("Native application commands require a trusted preferences renderer origin".into())
    }
}

/// Runs synchronous native work off the async executor: Wry getters post to the native thread and
/// block until it answers, and certificate checks touch the disk, so neither may hold a Tokio worker.
pub(crate) async fn off_executor<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// `require_local_app_webview` for async commands, run off the async executor.
async fn require_local_app_webview_async(webview: &tauri::Webview) -> Result<Url, String> {
    let webview = webview.clone();
    off_executor(move || require_local_app_webview(&webview, &webview.state::<AppState>())).await
}

/// `require_preferences_or_local_app_webview` for async commands, run off the async executor.
async fn require_preferences_or_local_app_webview_async(webview: &tauri::Webview) -> Result<Url, String> {
    let webview = webview.clone();
    off_executor(move || {
        require_preferences_or_local_app_webview(&webview, &webview.state::<AppState>())
    })
    .await
}

pub(crate) fn require_local_app_webview(
    webview: &tauri::Webview,
    state: &AppState,
) -> Result<Url, String> {
    identity::local_window_id(webview.label())?;
    let current = webview.url().map_err(|error| error.to_string())?;
    let status = state.manager.status();
    if is_allowed_local_origin(&current, status.url.as_deref()) {
        Ok(current)
    } else {
        Err("Native application commands require a trusted local renderer origin".into())
    }
}

pub(crate) fn handle_native_request(
    app: &AppHandle,
    method: &str,
    params: Option<serde_json::Value>,
    deadline: u64,
    fence: native_request::RequestFence,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    match method {
        "browser.probe" | "browser.execute" | "browser.page.begin" | "browser.page.send"
        | "browser.page.check" | "browser.page.end" => state
            .browser_controller
            .handle_native(app, method, params, deadline, fence),
        "opencode.service.start" => native_service_start::start(params, deadline),
        "developer.status" | "developer.targets" => state
            .developer_mode
            .native_snapshot(app, params, method == "developer.targets"),
        #[cfg(windows)]
        "developer.execute" => state.window_automation.execute(
            app,
            state.developer_mode.run_id(),
            params,
            browser_controller::request_deadline(deadline)?,
            &fence,
        ),
        "developer.restartScope" => state.developer_mode.request_restart(app, params, fence),
        "developer.reconnect" => state.developer_mode.reconnect(app, params),
        _ => Err(format!("Unsupported native request: {method}")),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn profile_identifier(identity: &str) -> [u8; 16] {
    let digest = Sha256::digest(identity.as_bytes());
    let mut identifier = [0_u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier
}

#[tauri::command]
fn set_workspace_menu_enabled(
    webview: tauri::Webview,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
    view_state: Option<view_menu::ViewMenuState>,
) -> Result<(), String> {
    require_local_app_webview(&webview, &state)?;
    if let Some(view_state) = &view_state {
        view_state.validate()?;
    }
    if !enabled {
        app.state::<local_windows::LocalWindows>()
            .set_workspace_menu_enabled(webview.label(), false)?;
        app.state::<local_windows::LocalWindows>()
            .set_view_menu_state(webview.label(), view_state)?;
        update_workspace_menu_state(&app);
        return Ok(());
    }
    let config = state
        .manager
        .ready_local_access()
        .ok_or("Local CodeNomad server is unavailable")?;
    let expected = Url::parse(&config.base_url).map_err(|error| error.to_string())?;
    let current = webview.url().map_err(|error| error.to_string())?;
    if current.origin() != expected.origin() {
        return Err("Workspace menu updates require the local CodeNomad origin".into());
    }
    app.state::<local_windows::LocalWindows>()
        .set_workspace_menu_enabled(webview.label(), enabled)?;
    app.state::<local_windows::LocalWindows>()
        .set_view_menu_state(webview.label(), view_state)?;
    update_workspace_menu_state(&app);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteWindowPayload {
    id: String,
    name: String,
    base_url: String,
    entry_url: Option<String>,
    proxy_session_id: Option<String>,
    #[allow(dead_code)]
    skip_tls_verify: bool,
}

fn require_http_url(value: &str, name: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{name} must use HTTP or HTTPS"));
    }
    Ok(url)
}

fn claim_unowned_remote_proxy_session(
    profiles: &HashMap<String, RemoteProfileIdentity>,
    claims: &mut HashSet<String>,
    session_id: &str,
) -> bool {
    if profiles
        .values()
        .any(|profile| profile.proxy_session_id() == Some(session_id))
    {
        return false;
    }
    claims.insert(session_id.to_string())
}

fn claim_remote_proxy_session_cleanup(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<AppState>();
    let Ok(profiles) = state.remote_profiles.lock() else {
        return false;
    };
    let Ok(mut claims) = state.remote_proxy_cleanup_claims.lock() else {
        return false;
    };
    claim_unowned_remote_proxy_session(&profiles, &mut claims, session_id)
}

#[tauri::command]
async fn window_control(
    webview: tauri::Webview,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    action: String,
) -> Result<(), String> {
    require_preferences_or_local_app_webview_async(&webview).await?;
    let window = webview.window();
    match action.as_str() {
        "minimize" => {
            state.browser_controller.revoke_window_visibility(window.label());
            window.minimize()
        }
        "maximize" => {
            return off_executor(move || {
                if window.is_maximized().unwrap_or(false) {
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                .map_err(|error| error.to_string())
            })
            .await;
        }
        "close" => {
            if webview.label() == preferences_window::LABEL && !preferences_window::approve_close(&app).await? {
                return Ok(());
            }
            window.close()
        }
        _ => return Err("Invalid window control action".to_string()),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_native_window_drag(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    require_preferences_or_local_app_webview(&webview, &state)?;
    // AppKit needs the mouse event still being dispatched when the IPC arrives.
    webview.window().start_dragging().map_err(|error| error.to_string())
}

fn titlebar_menu_id(menu: &str) -> Option<&'static str> {
    match menu {
        "file" => Some("menu-file"),
        "edit" => Some("menu-edit"),
        "view" => Some("menu-view"),
        "window" => Some("menu-window"),
        "help" => Some("menu-help"),
        _ => None,
    }
}

struct NativeMenuAdmission(Arc<AtomicBool>);

impl Drop for NativeMenuAdmission {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
async fn popup_titlebar_menu(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    menu: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    identity::local_window_id(webview.label())?;
    // Reserve before any URL/native getter can wait behind an existing popup.
    // Admission spans queued work as well as tracking; dropping the closure on
    // scheduling failure also releases it. Tracking remains a separate flag so
    // the admitted request can apply its pre-popup refresh.
    state
        .native_menu_popup_pending
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "A native titlebar menu is already open".to_string())?;
    let admission = NativeMenuAdmission(Arc::clone(&state.native_menu_popup_pending));
    require_local_app_webview_async(&webview).await?;
    if !x.is_finite() || !y.is_finite() {
        return Err("Invalid titlebar menu position".into());
    }
    let id = titlebar_menu_id(&menu).ok_or_else(|| "Unknown titlebar menu".to_string())?;
    let app = webview.app_handle().clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.clone()
        .run_on_main_thread(move || {
            let admission = admission;
            let result = (|| {
                let state = app.state::<AppState>();
                require_local_app_webview(&webview, &state)?;
                if state.native_menu_popup_active.load(Ordering::Relaxed) {
                    return Err("A native titlebar menu is already open".to_string());
                }
                update_workspace_menu_state_on_main(&app);
                let app_menu = app
                    .menu()
                    .ok_or_else(|| "Application menu is unavailable".to_string())?;
                let item = app_menu
                    .get(id)
                    .ok_or_else(|| "Titlebar menu is unavailable".to_string())?;
                let submenu = item
                    .as_submenu()
                    .ok_or_else(|| "Titlebar menu is invalid".to_string())?;
                state.native_menu_popup_active.store(true, Ordering::Relaxed);
                let result = webview
                    .window()
                    .popup_menu_at(submenu, tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)))
                    .map_err(|error| error.to_string());
                state.native_menu_popup_active.store(false, Ordering::Relaxed);
                update_workspace_menu_state_on_main(&app);
                result
            })();
            drop(admission);
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn browser_target_register(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    payload: browser_controller::BrowserTargetRegistration,
) -> Result<(), String> {
    require_local_app_webview_async(&webview).await?;
    let window = webview.window();
    let controller = state.browser_controller.clone();
    tauri::async_runtime::spawn_blocking(move || controller.register(&window, payload))
        .await
        .map_err(|error| embedded_view::diagnostics::preview_error("dispatch registration", error))?
        .map_err(|error| embedded_view::diagnostics::preview_error("register target", error))
}

#[tauri::command]
async fn browser_target_update(
    webview: tauri::Webview,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    payload: browser_controller::BrowserTargetUpdate,
) -> Result<(), String> {
    require_local_app_webview_async(&webview).await?;
    let controller = state.browser_controller.clone();
    let owner = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || controller.update(&app, &owner, payload))
        .await
        .map_err(|error| embedded_view::diagnostics::preview_error("dispatch update", error))?
        .map_err(|error| embedded_view::diagnostics::preview_error("update target", error))
}

#[tauri::command]
async fn browser_target_action(
    webview: tauri::Webview,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    payload: browser_controller::BrowserTargetAction,
) -> Result<serde_json::Value, String> {
    require_local_app_webview_async(&webview).await?;
    let controller = state.browser_controller.clone();
    let owner = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || controller.action(&app, &owner, payload))
        .await
        .map_err(|error| embedded_view::diagnostics::preview_error("dispatch action", error))?
        .map_err(|error| embedded_view::diagnostics::preview_error("target action", error))
}

#[tauri::command(async)]
fn browser_target_unregister(
    webview: tauri::Webview,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    registration_id: String,
) -> Result<(), String> {
    require_local_app_webview(&webview, &state)?;
    state
        .browser_controller
        .unregister(&app, webview.label(), &registration_id)
        .map_err(|error| embedded_view::diagnostics::preview_error("unregister target", error))
}

#[tauri::command]
fn browser_target_claim_open(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    request_id: String,
    response: browser_controller::OpenResponse,
) -> Result<bool, String> {
    require_local_app_webview(&webview, &state)?;
    state
        .browser_controller
        .claim_open(webview.label(), &request_id, response)
}

#[tauri::command]
fn browser_target_ownership(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    input: browser_controller::OwnershipAction,
) -> Result<Option<serde_json::Value>, String> {
    require_local_app_webview(&webview, &state)?;
    state.browser_controller.change_ownership(webview.app_handle(), webview.label(), input)
}

#[tauri::command]
fn browser_target_release_open(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<bool, String> {
    require_local_app_webview(&webview, &state)?;
    Ok(state.browser_controller.release_open(
        webview.label(),
        &request_id,
    ))
}

fn release_remote_proxy_session_cleanup(app: &AppHandle, session_id: &str) {
    if let Ok(mut claims) = app.state::<AppState>().remote_proxy_cleanup_claims.lock() {
        claims.remove(session_id);
    }
}

async fn cleanup_remote_proxy_session_if_unowned(app: &AppHandle, session_id: &str) {
    if !claim_remote_proxy_session_cleanup(app, session_id) {
        return;
    }
    if let Err(err) = cleanup_remote_proxy_session(app, session_id).await {
        release_remote_proxy_session_cleanup(app, session_id);
        eprintln!(
            "[tauri] failed to clean up remote proxy session {}: {}",
            session_id, err
        );
    }
}

fn schedule_remote_proxy_session_cleanup(app: AppHandle, label: String, session_id: String) {
    tauri::async_runtime::spawn(async move {
        let Ok(operation) = app
            .state::<AppState>()
            .remote_window_operations
            .for_label(&label)
        else {
            return;
        };
        let _guard = operation.lock().await;
        cleanup_remote_proxy_session_if_unowned(&app, &session_id).await;
    });
}

fn schedule_remote_window_destroyed_cleanup(
    app: AppHandle,
    label: String,
    profile: RemoteProfileIdentity,
    window_generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        let Ok(operation) = app
            .state::<AppState>()
            .remote_window_operations
            .for_label(&label)
        else {
            return;
        };
        let _guard = operation.lock().await;
        clear_remote_window_metadata(&app, &label, &profile, window_generation);
        if let Some(session_id) = profile.proxy_session_id() {
            cleanup_remote_proxy_session_if_unowned(&app, session_id).await;
        }
    });
}

async fn cleanup_remote_proxy_session(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let status = app.state::<AppState>().manager.status();
    let Some(base_url) = status.url else {
        return Err("backend is unavailable".to_string());
    };

    let mut cleanup_url = Url::parse(&base_url).map_err(|err| err.to_string())?;
    cleanup_url.set_path(&format!("/api/remote-proxy/sessions/{session_id}"));
    cleanup_url.set_query(None);
    cleanup_url.set_fragment(None);

    let client = if cleanup_url.scheme() == "https" {
        let local_cert = cert_manager::ensure_local_cert()?;
        let ca_cert = reqwest::Certificate::from_der(&local_cert.ca_cert_der)
            .map_err(|err| err.to_string())?;
        reqwest::Client::builder()
            .add_root_certificate(ca_cert)
            .timeout(REMOTE_PROXY_CLEANUP_TIMEOUT)
            .build()
            .map_err(|err| err.to_string())?
    } else {
        reqwest::Client::builder()
            .timeout(REMOTE_PROXY_CLEANUP_TIMEOUT)
            .build()
            .map_err(|err| err.to_string())?
    };

    let response = client
        .delete(cleanup_url.as_str())
        .send()
        .await
        .map_err(|err| err.to_string())?;

    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }

    Err(format!("unexpected status {}", response.status()))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WakeLockConfig {
    display: bool,
    idle: bool,
    sleep: bool,
}

const DEFAULT_WAKE_LOCK_CONFIG: WakeLockConfig = WakeLockConfig {
    display: false,
    idle: true,
    sleep: false,
};

#[tauri::command(async)]
fn cli_get_status(
    webview: tauri::Webview,
    state: tauri::State<AppState>,
) -> Result<CliStatus, String> {
    require_preferences_or_local_app_webview(&webview, &state)?;
    Ok(state.manager.status())
}

#[tauri::command]
async fn cli_renew_managed_session(
    webview: tauri::Webview,
    app: AppHandle,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    require_preferences_or_local_app_webview_async(&webview).await?;
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.renew_managed_session(&app))
        .await
        .map_err(|_| "Session renewal unavailable".to_string())?
        .map_err(|_| "Session renewal unavailable".to_string())
}

#[tauri::command]
async fn cli_restart(
    webview: tauri::Webview,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<CliStatus, String> {
    require_preferences_or_local_app_webview_async(&webview).await?;
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Admit before stopping, without holding the coordinator across the
        // wait. start_checked rechecks admission before starting a replacement.
        shutdown::with_navigation_authority(&app, || ())
            .ok_or("Application shutdown is in progress")?;
        let generation = manager
            .stop_until_generation(Instant::now() + Duration::from_secs(2))
            .map_err(|error| error.to_string())?;
        manager
            .start_checked(app, is_dev_mode(), Some(generation))
            .map_err(|error| error.to_string())?;
        Ok(manager.status())
    })
    .await
    .map_err(|error| error.to_string())?
}

// Windows keepawake uses SetThreadExecutionState: acquire, release and window
// destruction must use the same thread. Unix uses OS service requests instead.
#[cfg(windows)]
#[tauri::command]
fn wake_lock_start(
    webview: tauri::Webview,
    state: tauri::State<AppState>,
    config: Option<WakeLockConfig>,
) -> Result<(), String> {
    require_local_app_webview(&webview, &state)?;
    apply_wake_lock(webview.app_handle(), webview.label(), Some(config.unwrap_or(DEFAULT_WAKE_LOCK_CONFIG)))
}

#[cfg(not(windows))]
#[tauri::command]
async fn wake_lock_start(
    webview: tauri::Webview,
    config: Option<WakeLockConfig>,
) -> Result<(), String> {
    require_local_app_webview_async(&webview).await?;
    change_wake_lock(webview.app_handle(), webview.label(), Some(config.unwrap_or(DEFAULT_WAKE_LOCK_CONFIG))).await
}

fn acquire_wake_lock(state: &mut WakeLockState, label: &str, config: WakeLockConfig) -> Result<(), String> {
    let mut builder = keepawake::Builder::default();
    builder
        .display(config.display)
        .idle(config.idle)
        .sleep(config.sleep)
        .reason("CodeNomad keeps the computer awake")
        .app_name("CodeNomad")
        .app_reverse_domain("ai.neuralnomads.codenomad.client");

    if state.handle.is_none() {
        state.handle = Some(builder.create().map_err(|err| err.to_string())?);
    }
    state.labels.insert(label.to_string());
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
fn wake_lock_stop(webview: tauri::Webview, state: tauri::State<AppState>) -> Result<(), String> {
    require_local_app_webview(&webview, &state)?;
    apply_wake_lock(webview.app_handle(), webview.label(), None)
}

#[cfg(not(windows))]
#[tauri::command]
async fn wake_lock_stop(webview: tauri::Webview) -> Result<(), String> {
    require_local_app_webview_async(&webview).await?;
    change_wake_lock(webview.app_handle(), webview.label(), None).await
}

fn apply_wake_lock(app: &AppHandle, label: &str, config: Option<WakeLockConfig>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut wake = state.wake_lock.lock().map_err(|err| err.to_string())?;
    if let Some(config) = config {
        if app.state::<local_windows::LocalWindows>().record(label).is_none() {
            return Err("Window is no longer available".into());
        }
        return acquire_wake_lock(&mut wake, label, config);
    }
    wake.labels.remove(label);
    if wake.labels.is_empty() {
        wake.handle.take();
    }
    Ok(())
}

#[cfg(not(windows))]
async fn change_wake_lock(app: &AppHandle, label: &str, config: Option<WakeLockConfig>) -> Result<(), String> {
    let worker = app.clone();
    let label = label.to_owned();
    let (done, reply) = tokio::sync::oneshot::channel();
    app.state::<AppState>().wake_lock_worker.enqueue(Box::new(move || {
        let _ = done.send(apply_wake_lock(&worker, &label, config));
    }))?;
    reply.await.map_err(|err| err.to_string())?
}

fn release_destroyed_window_wake_lock(app: &AppHandle, label: &str) {
    #[cfg(windows)]
    let _ = apply_wake_lock(app, label, None);
    #[cfg(not(windows))]
    {
        let worker = app.clone();
        let label = label.to_owned();
        let _ = app.state::<AppState>().wake_lock_worker.enqueue(Box::new(move || {
            let _ = apply_wake_lock(&worker, &label, None);
        }));
    }
}

fn is_dev_mode() -> bool {
    cfg!(debug_assertions) || std::env::var("TAURI_DEV").is_ok()
}

fn should_allow_internal(url: &Url) -> bool {
    is_asset_renderer_origin(url) || is_dev_renderer_origin(url) || url.as_str() == "about:blank"
}

fn should_allow_window_origin<R: Runtime>(
    app_handle: &AppHandle<R>,
    window_label: &str,
    url: &Url,
) -> bool {
    let state = app_handle.state::<AppState>();
    if identity::local_window_id(window_label).is_ok() || window_label == preferences_window::LABEL
    {
        let status = state.manager.status();
        return is_navigable_local_origin(url, status.url.as_deref());
    }
    let Ok(allowed) = state.remote_navigation.lock() else {
        return false;
    };
    should_allow_registered_origin(
        allowed
            .get(window_label)
            .map(|metadata| metadata.origin.as_str()),
        url,
    )
}

fn should_allow_registered_origin(registered_origin: Option<&str>, url: &Url) -> bool {
    if let Some(origin) = registered_origin {
        return (matches!(url.scheme(), "http" | "https")
            && origin == url.origin().ascii_serialization())
            || url.as_str() == "about:blank";
    }
    should_allow_internal(url)
}

fn should_open_external_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// The renderer's system opener (application and Preferences windows).
#[tauri::command(async)]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|error| error.to_string())?;
    if !should_open_external_url(&url) {
        return Err(format!("{} links do not open externally", url.scheme()));
    }
    external_open::open_url(&app, url.as_str())
}

// Remote documents have no opener IPC capability. Only this owned policy may
// hand the public help site to the system browser; never create a native guest.
fn open_remote_external_url(url: &Url, open: impl FnOnce(&Url)) -> bool {
    if url.scheme() != "https"
        || url.host_str() != Some("neuralnomadsai.github.io")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with("/CodeNomad/")
        || url.path().contains('%')
    {
        return false;
    }
    open(url);
    true
}

fn intercept_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    let window_label = webview.label().to_string();
    if remote_dictation::is_sheet(&window_label) {
        // The registered sheet's own builder enforces its one-document policy.
        return true;
    }
    if let Some(allowed) = webview.app_handle()
        .state::<embedded_view::EmbeddedViews>()
        .navigation_allowed(&window_label, url)
    {
        return allowed;
    }
    if should_allow_window_origin(&webview.app_handle(), &window_label, url) {
        if window_label.starts_with("remote-") {
            remote_dictation::remote_navigation_pending(webview.app_handle(), &window_label, None);
        }
        return true;
    }

    let open = |url: &Url| {
        if let Err(err) = external_open::open_url(webview.app_handle(), url.as_str()) {
            eprintln!("[tauri] failed to open external link {}: {}", url, err);
        }
    };
    if window_label.starts_with("remote-") {
        open_remote_external_url(url, open);
    } else if should_open_external_url(url) {
        open(url);
    }
    false
}

fn apply_remote_window_title(app_handle: &AppHandle, window_label: &str) {
    let Some(title) = app_handle
        .state::<AppState>()
        .remote_navigation
        .lock()
        .ok()
        .and_then(|values| {
            values
                .get(window_label)
                .map(|metadata| metadata.title.clone())
        })
    else {
        return;
    };

    if let Some(webview) = app_handle.get_webview(window_label) {
        let _ = webview.window().set_title(&title);
    }
}

async fn open_remote_window_impl(
    app: AppHandle,
    payload: RemoteWindowPayload,
) -> Result<(), String> {
    let label = format!("remote-{}", payload.id);
    let requested_profile = RemoteProfileIdentity::new(payload.proxy_session_id.as_deref());
    let operation = app
        .state::<AppState>()
        .remote_window_operations
        .for_label(&label)?;
    let _guard = operation.lock().await;
    let result = open_remote_window_locked(
        app.clone(),
        payload,
        label.clone(),
        requested_profile.clone(),
    );
    if result.is_err() {
        if let Some(session_id) = requested_profile.proxy_session_id() {
            schedule_remote_proxy_session_cleanup(app, label, session_id.to_string());
        }
    }
    result
}

fn open_remote_window_locked(
    app: AppHandle,
    payload: RemoteWindowPayload,
    label: String,
    requested_profile: RemoteProfileIdentity,
) -> Result<(), String> {
    let base_url = require_http_url(&payload.base_url, "baseUrl")?;
    let entry_url = payload
        .entry_url
        .as_deref()
        .unwrap_or(payload.base_url.as_str());
    let parsed = require_http_url(entry_url, "entryUrl")?;
    let title = format!("{} - {}", payload.name, payload.base_url);

    let window_url = parsed.clone();

    let allow_linux_tls_certificate = parsed.scheme() == "https"
        && (payload.proxy_session_id.is_some() || payload.skip_tls_verify);

    let mut previous_profile = None;

    if let Some(existing) = app.get_webview_window(&label) {
        remote_dictation::remote_navigation_pending(&app, &label, None);
        previous_profile = app
            .state::<AppState>()
            .remote_profiles
            .lock()
            .map_err(|err| err.to_string())?
            .get(&label)
            .cloned();
        if should_recreate_remote_window(previous_profile.as_ref(), &requested_profile) {
            app.state::<AppState>()
                .remote_profiles
                .lock()
                .map_err(|err| err.to_string())?
                .insert(label.clone(), requested_profile.clone());
            if let Err(error) = existing.destroy() {
                let state = app.state::<AppState>();
                let mut profiles = state
                    .remote_profiles
                    .lock()
                    .map_err(|err| err.to_string())?;
                if let Some(previous) = previous_profile.as_ref() {
                    profiles.insert(label.clone(), previous.clone());
                } else {
                    profiles.remove(&label);
                }
                return Err(error.to_string());
            }
            if let Ok(mut handlers) = app.state::<AppState>().remote_tls_handlers.lock() {
                handlers.remove(&label);
            }
        } else {
            let staged = set_remote_window_metadata(
                &app,
                &label,
                &window_url,
                &base_url,
                &title,
                allow_linux_tls_certificate,
                false,
            )?;
            #[cfg(target_os = "linux")]
            if let Err(error) = linux_tls::ensure_remote_window_tls_handler(
                &existing,
                &app,
                &label,
                staged.window_generation,
            ) {
                restore_remote_window_metadata(&app, &label, staged);
                return Err(error);
            }
            apply_remote_window_title(&app, &label);
            if let Err(error) = existing.navigate(window_url.clone()) {
                if restore_remote_window_metadata(&app, &label, staged) {
                    apply_remote_window_title(&app, &label);
                }
                return Err(error.to_string());
            }
            apply_remote_window_title(&app, &label);
            let _ = existing.show();
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            return Ok(());
        }
    } else {
        app.state::<AppState>()
            .remote_profiles
            .lock()
            .map_err(|err| err.to_string())?
            .insert(label.clone(), requested_profile.clone());
    }

    let staged = match set_remote_window_metadata(
        &app,
        &label,
        &window_url,
        &base_url,
        &title,
        allow_linux_tls_certificate,
        true,
    ) {
        Ok(staged) => staged,
        Err(error) => {
            clear_remote_profile(&app, &label, &requested_profile);
            if let Some(session_id) = previous_profile
                .as_ref()
                .and_then(RemoteProfileIdentity::proxy_session_id)
            {
                schedule_remote_proxy_session_cleanup(
                    app.clone(),
                    label.clone(),
                    session_id.to_string(),
                );
            }
            return Err(error);
        }
    };

    let window_generation = staged.window_generation;

    #[cfg(target_os = "linux")]
    let initial_url =
        if linux_tls::should_bootstrap_tls_navigation(&window_url, allow_linux_tls_certificate) {
            Url::parse("about:blank").expect("about:blank is a valid URL")
        } else {
            window_url.clone()
        };

    #[cfg(not(target_os = "linux"))]
    let initial_url = window_url.clone();

    let profile_key = match requested_profile.proxy_session_id() {
        Some(session_id) => format!("{}\0{session_id}", payload.id),
        None => payload.id.clone(),
    };
    let profile_hash = Sha256::digest(profile_key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let data_directory = app
        .state::<AppState>()
        .webview_data_directory
        .join("remote")
        .join(profile_hash);
    let badge_binding = notification_badge::prepare_window(&app, &label);
    let external_app = app.clone();
    let external_label = label.clone();
    let builder = WebviewWindowBuilder::new(
        &app,
        label.clone(),
        WebviewUrl::External(initial_url.clone()),
    )
    .data_directory(data_directory)
    .incognito(requested_profile.proxy_session_id().is_some())
    .initialization_script(REMOTE_WINDOW_CONTEXT_SCRIPT)
    .on_new_window(move |url, _| {
        let current = external_app
            .state::<AppState>()
            .remote_navigation
            .lock()
            .ok()
            .and_then(|entries| entries.get(&external_label).map(|entry| entry.window_generation));
        if current == Some(window_generation) {
            open_remote_external_url(&url, |url| {
                if let Err(error) = external_open::open_url(&external_app, url.as_str()) {
                    eprintln!("[tauri] failed to open help: {error}");
                    tauri_plugin_dialog::DialogExt::dialog(&external_app)
                        .message("Could not open help in your browser. Visit https://neuralnomadsai.github.io/CodeNomad/ manually.")
                        .title("CodeNomad Help")
                        .show(|_| {});
                }
            });
        }
        NewWindowResponse::Deny
    })
    .on_page_load(move |window, payload| {
        remote_dictation::remote_page_load(
            window.app_handle(), window.label(), window_generation, payload.event(), payload.url(),
        );
        if payload.event() == PageLoadEvent::Started {
            notification_badge::page_started(window.as_ref(), badge_binding);
        }
    })
    .title(title)
    .inner_size(1400.0, 900.0)
    .min_inner_size(client_state::MIN_WINDOW_WIDTH as f64, 600.0);
    #[cfg(not(target_os = "linux"))]
    let builder = builder.on_permission_request(move |webview, kind| {
        if kind == tauri::webview::PermissionKind::Microphone {
            let authorized =
                remote_dictation::authorize_renderer_microphone(&webview, window_generation);
            // WebKit can complete macOS system consent before asking the webview delegate.
            // WebView2 asks before its default prompt and can persist a Deny in the profile.
            if cfg!(target_os = "macos") && !authorized {
                return tauri::webview::PermissionResponse::Deny;
            }
        }
        tauri::webview::PermissionResponse::Default
    });
    let builder = window_zoom::configure(builder);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(profile_identifier(&profile_key));
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            notification_badge::remove_window(&app, &label, badge_binding);
            cleanup_failed_remote_window(
                &app,
                None,
                &label,
                &requested_profile,
                previous_profile.as_ref(),
                window_generation,
            );
            return Err(error.to_string());
        }
    };

    #[cfg(windows)]
    windows_browser_accelerators::bind(window.as_ref());
    notification_badge::bind_webview(window.as_ref(), badge_binding);
    #[cfg(target_os = "linux")]
    device_speech_ipc::bind_microphone(&window, true);
    window_constraints::register(&window.as_ref().window(), 1.0);
    #[cfg(windows)]
    window_constraints::register_remote_zoom(&window, &app);
    #[cfg(windows)]
    if let Err(error) = shutdown::schedule_windows_session_end_handler(&window) {
        cleanup_failed_remote_window(
            &app,
            Some(&window),
            &label,
            &requested_profile,
            previous_profile.as_ref(),
            window_generation,
        );
        return Err(error);
    }

    #[cfg(target_os = "linux")]
    {
        let setup =
            linux_tls::ensure_remote_window_tls_handler(&window, &app, &label, window_generation)
                .and_then(|()| {
                    if initial_url == window_url {
                        Ok(())
                    } else {
                        window
                            .navigate(window_url.clone())
                            .map_err(|err| err.to_string())
                    }
                });
        if let Err(error) = setup {
            cleanup_failed_remote_window(
                &app,
                Some(&window),
                &label,
                &requested_profile,
                previous_profile.as_ref(),
                window_generation,
            );
            return Err(error);
        }
    }

    if let Some(session_id) = previous_profile
        .as_ref()
        .filter(|profile| *profile != &requested_profile)
        .and_then(RemoteProfileIdentity::proxy_session_id)
    {
        schedule_remote_proxy_session_cleanup(app.clone(), label.clone(), session_id.to_string());
    }

    let app_handle = app.clone();
    let label_for_cleanup = label.clone();
    let profile_for_cleanup = requested_profile.clone();
    remote_dictation::bind_termination(window.as_ref(), Some(window_generation));
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(_)) {
            update_workspace_menu_state(&app_handle);
        }
        if let WindowEvent::Destroyed = event {
            remote_dictation::remote_unloading(&app_handle, &label_for_cleanup, Some(window_generation));
            schedule_remote_window_destroyed_cleanup(
                app_handle.clone(),
                label_for_cleanup.clone(),
                profile_for_cleanup.clone(),
                window_generation,
            );
        }
    });

    Ok(())
}

fn set_remote_window_metadata(
    app: &AppHandle,
    label: &str,
    url: &Url,
    base_url: &Url,
    title: &str,
    allow_linux_tls_certificate: bool,
    new_window: bool,
) -> Result<StagedRemoteWindowMetadata, String> {
    let state = app.state::<AppState>();
    let generation = state
        .remote_navigation_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let mut values = state
        .remote_navigation
        .lock()
        .map_err(|err| err.to_string())?;
    let previous = values.get(label).cloned();
    let window_generation = if new_window {
        generation
    } else {
        previous
            .as_ref()
            .map(|metadata| metadata.window_generation)
            .unwrap_or(generation)
    };
    values.insert(
        label.to_string(),
        RemoteWindowMetadata {
            origin: url.origin().ascii_serialization(),
            dictation_destination: base_url.origin().ascii_serialization(),
            dictation_document: Default::default(),
            title: title.to_string(),
            allow_linux_tls_certificate,
            generation,
            window_generation,
        },
    );
    drop(values);
    remote_dictation::remote_navigation_pending(app, label, Some(window_generation));
    Ok(StagedRemoteWindowMetadata {
        generation,
        window_generation,
        previous,
    })
}

fn clear_remote_tls_handler(
    handlers: &mut HashMap<String, u64>,
    label: &str,
    window_generation: u64,
) -> bool {
    if handlers.get(label).copied() != Some(window_generation) {
        return false;
    }
    handlers.remove(label);
    true
}

fn rollback_remote_window_metadata(
    values: &mut HashMap<String, RemoteWindowMetadata>,
    label: &str,
    failed_generation: u64,
    previous: Option<RemoteWindowMetadata>,
) -> bool {
    if values.get(label).map(|metadata| metadata.generation) != Some(failed_generation) {
        return false;
    }
    match previous {
        Some(previous) => {
            values.insert(label.to_string(), previous);
        }
        None => {
            values.remove(label);
        }
    }
    true
}

fn restore_remote_window_metadata(
    app: &AppHandle,
    label: &str,
    staged: StagedRemoteWindowMetadata,
) -> bool {
    app.state::<AppState>()
        .remote_navigation
        .lock()
        .ok()
        .is_some_and(|mut values| {
            rollback_remote_window_metadata(&mut values, label, staged.generation, staged.previous)
        })
}

fn clear_remote_profile(app: &AppHandle, label: &str, profile: &RemoteProfileIdentity) -> bool {
    let state = app.state::<AppState>();
    let Ok(mut profiles) = state.remote_profiles.lock() else {
        return false;
    };
    if profiles.get(label) != Some(profile) {
        return false;
    }
    profiles.remove(label);
    true
}

fn cleanup_failed_remote_window(
    app: &AppHandle,
    window: Option<&tauri::WebviewWindow>,
    label: &str,
    profile: &RemoteProfileIdentity,
    previous_profile: Option<&RemoteProfileIdentity>,
    window_generation: u64,
) {
    if let Some(window) = window {
        let _ = window.destroy();
    }
    if clear_remote_window_metadata(app, label, profile, window_generation) {
        if let Some(session_id) = previous_profile.and_then(RemoteProfileIdentity::proxy_session_id)
        {
            schedule_remote_proxy_session_cleanup(
                app.clone(),
                label.to_string(),
                session_id.to_string(),
            );
        }
    }
}

fn clear_remote_window_metadata(
    app: &AppHandle,
    label: &str,
    profile: &RemoteProfileIdentity,
    window_generation: u64,
) -> bool {
    let state = app.state::<AppState>();
    let Ok(mut navigation) = state.remote_navigation.lock() else {
        return false;
    };
    if navigation
        .get(label)
        .map(|metadata| metadata.window_generation)
        != Some(window_generation)
    {
        return false;
    }
    let Ok(mut profiles) = state.remote_profiles.lock() else {
        return false;
    };
    if profiles.get(label) != Some(profile) {
        return false;
    }
    profiles.remove(label);
    app.state::<device_speech::DeviceSpeech>().revoke(Some(label));
    navigation.remove(label);
    if let Ok(mut values) = state.remote_tls_handlers.lock() {
        clear_remote_tls_handler(&mut values, label, window_generation);
    }
    true
}

#[tauri::command]
async fn needs_local_certificate_install(webview: tauri::Webview) -> Result<bool, String> {
    off_executor(move || {
        require_preferences_or_local_app_webview(&webview, &webview.state::<AppState>())?;
        #[cfg(not(target_os = "linux"))]
        {
            let local_cert = cert_manager::ensure_local_cert().map_err(|err| {
                format!(
                    "Failed to load the local HTTPS certificate for the remote proxy window: {err}"
                )
            })?;
            return cert_manager::needs_trust_in_store(&local_cert.ca_cert_der).map_err(|err| {
                format!("Failed to inspect the local CodeNomad certificate trust state: {err}")
            });
        }

        #[cfg(target_os = "linux")]
        {
            Ok(false)
        }
    })
    .await
}

#[tauri::command]
async fn open_remote_window(
    webview: tauri::Webview,
    app: AppHandle,
    payload: RemoteWindowPayload,
) -> Result<(), String> {
    require_preferences_or_local_app_webview_async(&webview).await?;
    #[cfg(not(target_os = "linux"))]
    {
        let entry_url = payload
            .entry_url
            .as_deref()
            .unwrap_or(payload.base_url.as_str());
        require_http_url(&payload.base_url, "baseUrl")?;
        let parsed = require_http_url(entry_url, "entryUrl")?;
        if payload.proxy_session_id.is_some() && parsed.scheme() == "https" {
            tauri::async_runtime::spawn_blocking(|| {
                let local_cert = cert_manager::ensure_local_cert().map_err(|err| {
                    format!(
                        "Failed to load the local HTTPS certificate for the remote proxy window: {err}"
                    )
                })?;
                cert_manager::trust_cert_in_store(&local_cert.ca_cert_der).map_err(|err| {
                    format!(
                        "Failed to trust the local CodeNomad CA certificate. Accept the certificate installation prompt and try again: {err}"
                    )
                })
            })
            .await
            .map_err(|error| error.to_string())??;
        }
    }

    open_remote_window_impl(app, payload).await
}

fn collect_directory_paths(paths: &[std::path::PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_dir() => Some(path.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

type FolderDropEvent = (tauri::Webview, &'static str, Option<Vec<std::path::PathBuf>>);

struct FolderDropEvents(std::sync::mpsc::Sender<FolderDropEvent>);

impl FolderDropEvents {
    fn new() -> Self {
        let (sender, queue) = std::sync::mpsc::channel::<FolderDropEvent>();
        std::thread::spawn(move || {
            for (webview, event, paths) in queue {
                if let Some(paths) = paths {
                    let directories = collect_directory_paths(&paths);
                    if !directories.is_empty() {
                        let _ = webview.emit(event, json!({ "paths": directories }));
                    }
                } else {
                    let _ = webview.emit(event, ());
                }
            }
        });
        Self(sender)
    }

    fn send(app: &AppHandle, label: &str, event: &'static str, paths: Option<Vec<std::path::PathBuf>>) {
        if let Some(webview) = app.get_webview(label) {
            let _ = app.state::<Self>().0.send((webview, event, paths));
        }
    }
}

fn reload_target_window(app_handle: &AppHandle) {
    let Some(window) = local_windows::targeted_window(app_handle) else {
        return;
    };
    let label = window.label().to_string();
    if identity::local_window_id(&label).is_err() {
        let _ = window.reload();
        return;
    }
    let target_label = label.clone();
    client_state::before_window_navigation(
        app_handle,
        label,
        client_state::NavigationKind::Reload,
        None,
        move |app| {
            app.get_webview(&target_label)
                .ok_or_else(|| "local window not found for reload".to_string())?
                .reload()
                .map_err(|err| format!("failed to reload local window: {err}"))
        },
    );
}

fn force_reload_target_window(app_handle: &AppHandle) {
    let Some(window) = local_windows::targeted_window(app_handle) else {
        return;
    };
    let label = window.label().to_string();
    if identity::local_window_id(&label).is_err() {
        let _ = window.reload();
        return;
    }
    let target_label = label.clone();
    client_state::before_window_navigation(
        app_handle,
        label,
        client_state::NavigationKind::ForceReload,
        None,
        move |app| {
            let window = app
                .get_webview(&target_label)
                .ok_or_else(|| "local window not found for force reload".to_string())?;
            if let Ok(mut url) = window.url() {
                if should_allow_internal(&url) {
                    let reload_token = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                        .to_string();

                    let existing_pairs: Vec<(String, String)> = url
                        .query_pairs()
                        .into_owned()
                        .filter(|(key, _)| key != "__codenomad_force_reload")
                        .collect();

                    {
                        let mut pairs = url.query_pairs_mut();
                        pairs.clear();
                        for (key, value) in existing_pairs {
                            pairs.append_pair(&key, &value);
                        }
                        pairs.append_pair("__codenomad_force_reload", &reload_token);
                    }

                    return window
                        .navigate(url)
                        .map_err(|err| format!("failed to force reload main window: {err}"));
                }
            }

            window
                .reload()
                .map_err(|err| format!("failed to force reload main window: {err}"))
        },
    );
}

fn toggle_fullscreen_window(app_handle: &AppHandle) {
    if let Some(webview) = local_windows::targeted_window(app_handle) {
        let window = webview.window();
        let next_fullscreen = !window.is_fullscreen().unwrap_or(false);
        let _ = window.set_fullscreen(next_fullscreen);
        menu_bar::hide(&window);
    }
}

fn set_target_zoom(app: &AppHandle, webview: &tauri::Webview, zoom: f64) {
    if identity::local_window_id(webview.label()).is_ok()
        || webview.label() == preferences_window::LABEL
    {
        client_state::set_local_window_zoom(app, webview.label(), zoom);
        return;
    }
    let zoom = zoom.clamp(0.25, 5.0);
    if webview.set_zoom(zoom).is_ok() {
        window_constraints::apply(&webview.window(), zoom);
        if let Ok(mut levels) = app.state::<AppState>().remote_zoom_levels.lock() {
            levels.insert(webview.label().to_string(), zoom);
        }
    }
}

fn target_zoom(app: &AppHandle, webview: &tauri::Webview) -> f64 {
    if identity::local_window_id(webview.label()).is_ok()
        || webview.label() == preferences_window::LABEL
    {
        client_state::local_window_zoom(app, webview.label())
    } else {
        app.state::<AppState>()
            .remote_zoom_levels
            .lock()
            .ok()
            .and_then(|levels| levels.get(webview.label()).copied())
            .unwrap_or(client_state::DEFAULT_ZOOM_LEVEL)
    }
}

fn fullscreen_shortcut() -> Option<Shortcut> {
    if cfg!(target_os = "macos") {
        None
    } else {
        Some(Shortcut::new(None, ShortcutCode::F11))
    }
}

fn update_fullscreen_shortcut(app: &AppHandle) {
    let Some(shortcut) = fullscreen_shortcut() else {
        return;
    };
    let local_focused = app.webviews().into_values().any(|webview| {
        identity::local_window_id(webview.label()).is_ok()
            && webview.label() == webview.window().label()
            && webview.window().is_focused().unwrap_or(false)
    });
    if local_focused {
        let _ = app.global_shortcut().register(shortcut);
    } else {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

#[cfg(windows)]
fn set_windows_app_user_model_id(identifier: &str) -> bool {
    let app_id: Vec<u16> = OsStr::new(identifier)
        .encode_wide()
        .chain(iter::once(0))
        .collect();

    let result = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
    if result < 0 {
        eprintln!("[tauri] failed to set AppUserModelID: {result}");
    }
    let registered = windows_notification_identity::register(identifier);
    result >= 0 && registered
}

/// `in_process`: the Rust server, whose automation this host serves itself: no debugging port.
#[cfg(windows)]
fn configure_developer_webview(
    scope: &identity::IdentityScope,
    in_process: bool,
) -> std::io::Result<(
    Option<std::path::PathBuf>,
    std::path::PathBuf,
    Option<String>,
)> {
    let profile = scope.webview_data_directory.join("developer-mode");
    let arguments = developer_mode::webview2_arguments(
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .ok()
            .as_deref(),
        None,
    );
    if arguments.is_empty() {
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    } else {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments);
    }

    std::env::remove_var("WEBVIEW2_USER_DATA_FOLDER");
    if in_process {
        return Ok((None, profile, None));
    }
    let devtools_active_port = Some(
        profile
            .join("local")
            .join("EBWebView")
            .join("DevToolsActivePort"),
    );
    let developer_browser_arguments = Some(developer_mode::webview2_arguments(None, Some(0)));
    Ok((devtools_active_port, profile, developer_browser_arguments))
}

#[cfg(not(windows))]
fn configure_developer_webview(
    scope: &identity::IdentityScope,
    _in_process: bool,
) -> std::io::Result<(
    Option<std::path::PathBuf>,
    std::path::PathBuf,
    Option<String>,
)> {
    Ok((None, scope.webview_data_directory.clone(), None))
}

fn configure_developer_environment() {
    std::env::set_var("RUST_BACKTRACE", "1");
    std::env::set_var(
        "NODE_OPTIONS",
        developer_mode::append_node_option(
            std::env::var("NODE_OPTIONS").ok().as_deref(),
            "--enable-source-maps",
        ),
    );
}

fn schedule_launch_drain(app: AppHandle, queue: Arc<launch::LaunchQueue>) {
    let dispatch = app.clone();
    let _ = app.run_on_main_thread(move || {
        local_windows::handle_intents(&dispatch, queue.drain());
    });
}

/// `launch_windows` are the hidden windows a `--connect-server` launch runs in: like Preferences, they never keep CodeNomad alive.
fn is_final_application_window<'a>(
    closing_label: &str,
    mut labels: impl Iterator<Item = &'a str>,
    launch_windows: &[String],
) -> bool {
    !labels.any(|label| {
        label != closing_label
            && label != preferences_window::LABEL
            && !remote_dictation::is_sheet(label)
            && !label.starts_with("browser-popup-")
            && !launch_windows.iter().any(|launch| launch == label)
    })
}

fn consume_approved_auxiliary_close(app: &AppHandle, label: &str) -> bool {
    app.state::<AppState>()
        .approved_auxiliary_closes
        .lock()
        .ok()
        .is_some_and(|mut labels| labels.remove(label))
}

fn dispatch_approved_auxiliary_close(app: &AppHandle, label: &str) {
    let approved = app
        .state::<AppState>()
        .approved_auxiliary_closes
        .lock()
        .ok()
        .is_some_and(|mut labels| labels.insert(label.to_string()));
    if !approved {
        return;
    }
    let dispatched = app
        .get_webview_window(label)
        .is_some_and(|window| window.close().is_ok());
    if !dispatched {
        let _ = consume_approved_auxiliary_close(app, label);
    }
}

fn request_final_application_window_close(app: AppHandle, label: String, local_window: bool) {
    tauri::async_runtime::spawn(async move {
        let windows = app.webview_windows();
        let still_final = is_final_application_window(
            &label,
            windows
                .keys()
                .filter(|candidate| !shutdown::local_window_close_in_flight(&app, candidate))
                .map(String::as_str),
            &app.state::<local_windows::LocalWindows>()
                .connect_only_labels(),
        );
        // Closing the last window quits CodeNomad, Remote Control included; it
        // resumes at the next launch.
        if still_final {
            shutdown::request(app);
        } else if local_window || label.starts_with("remote-") {
            shutdown::request_local_window_close(app, label);
        } else {
            dispatch_approved_auxiliary_close(&app, &label);
        }
    });
}

#[derive(Debug, PartialEq, Eq)]
enum LocalCloseEventAction {
    Allow,
    Prevent,
    Continue,
}

/// A hidden `--connect-server` launch window holds no user state: it closes at once, without the
/// renderer flush whose acknowledgement a renderer that never started cannot send.
fn local_close_event_action(
    approved: Option<bool>,
    launch_window: bool,
) -> LocalCloseEventAction {
    if launch_window {
        return LocalCloseEventAction::Allow;
    }
    match approved {
        Some(true) => LocalCloseEventAction::Allow,
        Some(false) => LocalCloseEventAction::Prevent,
        None => LocalCloseEventAction::Continue,
    }
}

/// Resolves the data profile before the identifier, singleton or WebView storage exists. An
/// invalid explicit profile fails visibly.
fn resolve_launch_profile_or_exit(
    cli_config: Option<&str>,
    cwd: &std::path::Path,
    home: &std::path::Path,
) -> identity::LaunchProfile {
    identity::resolve_launch_profile(
        std::env::var(data_profile::PROFILE_ENVIRONMENT).ok().as_deref(),
        std::env::var(data_profile::LEGACY_CHANNEL_ENVIRONMENT).ok().as_deref(),
        cli_config,
        !is_dev_mode(),
        cwd,
        home,
    )
    .unwrap_or_else(|message| {
        eprintln!("[startup] {message}");
        profile_selection_dialog::show_startup_error(&message);
        std::process::exit(1);
    })
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    // On macOS this macro emits a fixed symbol for the embedded Info.plist.
    tauri::generate_context!()
}

fn main() {
    let started_at = Instant::now();
    #[cfg(windows)]
    if let Some(code) = cli_manager::run_windows_cli_launcher_if_requested() {
        std::process::exit(code);
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let cwd = std::env::current_dir().unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_else(|| cwd.clone());
    let local_data = dirs::data_local_dir().unwrap_or_else(|| home.clone());
    let launch_arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let handoff = match developer_relaunch::Handoff::take(&launch_arguments) {
        Ok(handoff) if cfg!(windows) || handoff.is_none() => handoff,
        _ => {
            eprintln!("[tauri] invalid CodeNomad automation relaunch");
            std::process::exit(1);
        }
    };
    let backend_config = if let Some(ref handoff) = handoff {
        handoff.config.clone()
    } else {
        identity::resolve_selected_config(std::env::var("CLI_CONFIG").ok().as_deref(), &cwd, &home)
    };
    // Native listening/certificate readers and every backend spawn must select
    // this same ORIGINAL source, resolved before any startup cwd can change.
    // Process-wide set_var happens while the process is still single-threaded: before the startup
    // error dialog may start dialog-toolkit threads. Only the Windows-only WebView2 variables
    // below follow it, where environment access is OS-synchronized.
    if let Some(config) = backend_config.as_deref() {
        std::env::set_var("CLI_CONFIG", config);
    } else {
        std::env::remove_var("CLI_CONFIG");
    }
    configure_developer_environment();
    #[cfg(target_os = "linux")]
    appimage_environment::prefer_x11_display();
    let launch_profile = handoff.as_ref().map_or_else(
        || resolve_launch_profile_or_exit(backend_config.as_deref(), &cwd, &home),
        |handoff| identity::LaunchProfile {
            key: handoff.profile.clone(),
            pinned: handoff.pinned,
        },
    );
    let profile_pinned = launch_profile.pinned;
    let scope = identity::resolve_scope(
        &launch_profile.key,
        backend_config.as_deref(),
        &cwd,
        &home,
        &local_data,
    );
    let executable = std::env::current_exe()
        .ok()
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path));
    let developer_identity = executable.as_deref().map_or_else(String::new, |path| {
        developer_relaunch::native_identity(
            &scope.profile,
            &scope.config_identity,
            backend_config.as_deref(),
            path,
        )
    });
    if handoff
        .as_ref()
        .is_some_and(|handoff| handoff.restart.native_identity != developer_identity)
    {
        eprintln!("[tauri] CodeNomad automation relaunch scope changed");
        std::process::exit(1);
    }
    let in_process_automation = cli_manager::uses_rust_server(
        std::env::var("CODENOMAD_SERVER_IMPL").ok().as_deref(),
        cli_manager::configured_implementation().as_deref(),
    );
    let (devtools_active_port, webview_data_directory, developer_browser_arguments) =
        configure_developer_webview(&scope, in_process_automation)
            .expect("configure native automation browser profile");
    let developer_mode = developer_mode::DeveloperMode::new(
        developer_identity,
        devtools_active_port,
        in_process_automation,
    )
    .with_launch_scope(
        executable,
        launch_profile,
        backend_config.clone(),
        handoff.map(|handoff| (handoff.restart, started_at)),
    );

    // Before the single-instance plugin can forward a `|` that would split into other arguments.
    #[cfg(windows)]
    if let Some(message) = launch::pipe_argument_error(&launch_arguments) {
        eprintln!("[startup] {message}");
        profile_selection_dialog::show_startup_error(&message);
        std::process::exit(2);
    }
    let launch_queue = Arc::new(launch::LaunchQueue::default());
    let first_intent = launch::parse_launch_intent(&launch_arguments, &cwd);
    // A launch that only connects to a server restores the local windows only if the connection fails.
    let restore_on_start = !first_intent.is_connect_only();
    launch_queue.enqueue(first_intent);
    let singleton_queue = Arc::clone(&launch_queue);
    let second_launch_config = std::path::PathBuf::from(&scope.config_identity);
    // The singleton callback runs on the native thread (inside WM_COPYDATA on Windows): it only
    // hands the raw launch to one ordered worker, which checks folders and reads the config.
    let (forward_launch, forwarded_launches) =
        std::sync::mpsc::channel::<(AppHandle, Vec<String>, std::path::PathBuf)>();
    std::thread::Builder::new()
        .name("forwarded-launch".into())
        .spawn(move || {
            for (app, arguments, cwd) in forwarded_launches {
                #[cfg(windows)]
                let intent = launch::parse_windows_forwarded_launch_intent(&arguments, &cwd);
                #[cfg(not(windows))]
                let intent = launch::parse_launch_intent(&arguments, &cwd);
                singleton_queue.enqueue(launch::prepare_second_launch_intent(
                    intent,
                    &second_launch_config,
                ));
                schedule_launch_drain(app, Arc::clone(&singleton_queue));
            }
        })
        .expect("start the forwarded launch worker");
    let single_instance = tauri_plugin_single_instance::init(move |app, args, callback_cwd| {
        let arguments = args.into_iter().skip(1).collect::<Vec<_>>();
        if arguments == [developer_relaunch::MARKER] {
            return;
        }
        let _ = forward_launch.send((app.clone(), arguments, callback_cwd.into()));
    });

    let navigation_guard: TauriPlugin<Wry, ()> = PluginBuilder::new("external-link-guard")
        .on_navigation(|webview, url| intercept_navigation(webview, url))
        .build();

    let mut context = app_context();
    context.config_mut().identifier = scope.identifier.clone();
    let setup_scope = scope.clone();
    let setup_queue = Arc::clone(&launch_queue);
    // This root outlives app.run; managed state/native handlers hold only Weak.
    let notification_badge_host = Arc::new(Mutex::new(None::<Arc<AppHandle>>));
    let setup_notification_badge_host = Arc::clone(&notification_badge_host);

    let browser_controller = browser_controller::BrowserController::new(
        setup_scope.webview_data_directory.join("browser"),
    );
    let builder = tauri::Builder::default().append_invoke_initialization_script(
        "window.__CODENOMAD_CLIENT_STATE_DOCUMENT__ = new Promise(resolve => { window.__CODENOMAD_RESOLVE_CLIENT_STATE_DOCUMENT__ = resolve; });",
    );
    #[cfg(target_os = "macos")]
    let builder = builder.append_invoke_initialization_script(
        "window.__CODENOMAD_NOTIFICATION_PERMISSION__ = true;",
    );
    desktop_updater::register(builder, context.config())
        .append_invoke_initialization_script("window.__CODENOMAD_NOTIFICATION_ACTIONS__ = true;")
        .plugin(single_instance)
        .plugin(tauri_plugin_dialog::init())
        // Opens links outside Linux (external_open). The renderer's own click
        // handler (lib/native/external-link-clicks.ts) replaces the plugin's.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    if fullscreen_shortcut().as_ref() == Some(shortcut) {
                        // Linux calls this on the shortcut thread, which the main
                        // thread can be waiting on to re-register F11 as focus
                        // changes: queue the toggle instead of blocking on the window.
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || toggle_fullscreen_window(&handle));
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(navigation_guard)
        .manage(browser_controller.embedded_views.clone())
        .manage(embedded_view::StorageIdentity::new(
            scope.profile.clone(),
            scope.config_identity.clone(),
        ))
        .manage(local_windows::LocalWindows::default())
        .manage(notification_badge::NotificationBadge::default())
        .manage(notification_click::NotificationClicks::default())
        .manage(window_constraints::WindowConstraints::default())
        .manage(preferences_window::PreferencesWindow::default())
        .manage(data_profile_cleanup::CleanupContext::new(
            data_profile_cleanup::ProfileRoots {
                electron_base: identity::electron_user_data_base(&home),
                webview_root: local_data.join(format!("{}-v2", identity::STABLE_IDENTIFIER)),
                tauri_data_parent: dirs::data_dir().unwrap_or_else(|| home.clone()),
                home_client_state: client_state::home_client_state_directory()
                    .unwrap_or_else(|| home.join(".codenomad").join("client-state")),
                default_state_files: client_state::default_state_files(
                    &identity::electron_user_data_base(&home),
                ),
            },
            data_profile_cleanup::CurrentProfile {
                key: scope.profile.clone(),
                config_identity: scope.config_identity.clone(),
                default_identity: identity::normalize_config_identity(None, &cwd, &home),
                pinned: profile_pinned,
            },
        ))
        .manage(
            device_speech::DeviceSpeech::new(
                identity::electron_user_data_base(&home)
                    .join("device-speech")
                    .join("choice.json"),
                None,
            )
            .with_hex(
                if cfg!(windows) {
                    dirs::data_local_dir()
                        .map(|path| path.join("CodeNomad"))
                        .unwrap_or_else(|| identity::electron_user_data_base(&home))
                } else {
                    identity::electron_user_data_base(&home)
                }
                .join("device-speech"),
            ),
        )
        .manage(remote_dictation::RemoteDictation::default())
        .manage(AppState {
            manager: CliProcessManager::with_profile(
                setup_scope.profile.clone(),
                setup_scope.config_identity.clone(),
                backend_config.clone(),
            ),
            developer_mode,
            #[cfg(windows)]
            window_automation: Default::default(),
            browser_controller,
            wake_lock: Mutex::new(WakeLockState::default()),
            #[cfg(not(windows))]
            wake_lock_worker: client_state::IpcQueue::named("wake-lock"),
            remote_navigation: Mutex::new(HashMap::new()),
            remote_navigation_generation: AtomicU64::new(0),
            remote_profiles: Mutex::new(HashMap::new()),
            remote_window_operations: RemoteWindowOperationLocks::default(),
            remote_proxy_cleanup_claims: Mutex::new(HashSet::new()),
            approved_auxiliary_closes: Mutex::new(HashSet::new()),
            remote_tls_handlers: Mutex::new(HashMap::new()),
            remote_zoom_levels: Mutex::new(HashMap::new()),
            workspace_menu_items: Mutex::new(None),
            menu_labels: Default::default(),
            native_menu_popup_active: AtomicBool::new(false),
            native_menu_popup_pending: Arc::new(AtomicBool::new(false)),
            webview_data_directory,
            developer_browser_arguments,
            scoped_profile: setup_scope.scoped,
        })
        .manage(client_state::IpcQueue::new())
        .manage(FolderDropEvents::new())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let app = webview.app_handle();
                if let (Ok(window_id), Some(state)) = (
                    identity::local_window_id(webview.label()),
                    app.try_state::<client_state::ClientState>(),
                ) {
                    let managed_backend = app.state::<AppState>().manager.status().url;
                    if is_allowed_local_origin(payload.url(), managed_backend.as_deref()) {
                        state.renderer_page_finished(&window_id, webview, payload.url());
                    }
                }
            }
            if payload.event() == PageLoadEvent::Started {
                let app = webview.app_handle();
                if let (Ok(window_id), Some(state)) = (
                    identity::local_window_id(webview.label()),
                    app.try_state::<client_state::ClientState>(),
                ) {
                    let managed_backend = app.state::<AppState>().manager.status().url;
                    let allowed = is_allowed_local_origin(payload.url(), managed_backend.as_deref());
                    state.renderer_page_started(&window_id, allowed.then_some(payload.url()));
                }
                webview.app_handle().state::<notification_click::NotificationClicks>()
                    .forget_window(webview.label());
                if !webview.label().starts_with("remote-") {
                    webview.app_handle().state::<device_speech::DeviceSpeech>().revoke(Some(webview.label()));
                }
                webview
                    .app_handle()
                    .state::<AppState>()
                    .browser_controller
                    .renderer_page_started(webview);
            }
            if identity::local_window_id(webview.label()).is_ok()
                && payload.event() == PageLoadEvent::Started
            {
                let _ = webview
                    .app_handle()
                    .state::<local_windows::LocalWindows>()
                    .set_workspace_menu_enabled(webview.label(), false);
                update_workspace_menu_state(&webview.app_handle());
            }
            if matches!(
                payload.event(),
                PageLoadEvent::Started | PageLoadEvent::Finished
            ) {
                apply_remote_window_title(&webview.app_handle(), webview.label());
            }
            if webview.label() == preferences_window::LABEL
                && payload.event() == PageLoadEvent::Finished
            {
                preferences_window::emit_section(&webview.app_handle());
            }
        })
        .setup(move |app| {
            let badge_host = Arc::new(app.handle().clone());
            app.state::<notification_badge::NotificationBadge>()
                .set_host(&badge_host);
            app.state::<remote_dictation::RemoteDictation>()
                .set_host(&badge_host);
            notification_click::install(&badge_host);
            *setup_notification_badge_host
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(badge_host);
            app.state::<AppState>().developer_mode.prepare_profile()?;
            eprintln!(
                "[tauri-startup] in-place updates supported on this installation: {}",
                updater_support::current_platform_support()
            );
            let client_state = client_state::ClientState::initialize(
                &app.handle(),
                setup_scope.client_state_directory.as_deref(),
            );
            app.manage(client_state);
            app.manage(shutdown::ShutdownCoordinator::default());
            app.manage(desktop_updater::UpdateState::default());
            build_menu(&app.handle())?;
            if restore_on_start {
                local_windows::restore_windows(&app.handle())
                    .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
            } else {
                app.state::<local_windows::LocalWindows>()
                    .defer_startup_restore();
            }
            schedule_launch_drain(app.handle().clone(), Arc::clone(&setup_queue));
            update_fullscreen_shortcut(&app.handle());

            let dev_mode = is_dev_mode();
            let app_handle = app.handle().clone();
            let manager = app.state::<AppState>().manager.clone();
            std::thread::spawn(move || {
                if let Err(err) = manager.start(app_handle.clone(), dev_mode) {
                    local_windows::emit_all(
                        &app_handle,
                        "cli:error",
                        json!({"message": err.to_string()}),
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(remote_dictation::with_relay(client_state::with_ordered_ipc(device_speech_ipc::with_document_ingress(tauri::generate_handler![
            clipboard_attachments::read_clipboard_attachments,
            cli_get_status,
            cli_renew_managed_session,
            cli_restart,
            wake_lock_start,
            wake_lock_stop,
            notification_badge::notification_badge_set,
            notification_click::notification_permission,
            notification_click::notification_show,
            needs_local_certificate_install,
            preferences_window::open_preferences_window,
            preferences_window::preferences_window_ready,
            preferences_window::preferences_get_request,
            preferences_window::preferences_resolve_transition,
            preferences_window::preferences_opener_startup_state,
            preferences_window::memory_cleanup::preferences_memory_cleanup,
            preferences_window::server_selection::preferences_select_server,
            preferences_window::server_selection::server_selection_result,
            preferences_window::memory_cleanup::memory_cleanup_result,
            preferences_window::memory_cleanup::memory_cleanup_claim,
            window_control,
            start_native_window_drag,
            window_zoom::owned_webview_zoom,
            popup_titlebar_menu,
            open_remote_window,
            open_external_url,
            data_profile_cleanup::data_profiles_list_others,
            data_profile_cleanup::data_profiles_delete_others,
            data_profile_cleanup::data_profiles_set_next_launch,
            data_profile_cleanup::data_profiles_relaunch,
            local_windows::desktop_launch_ready,
            local_windows::desktop_launch_next_folder,
            local_windows::desktop_launch_acknowledge_folder,
            local_windows::desktop_launch_next_connection,
            local_windows::desktop_launch_acknowledge_connection,
            desktop_updater::check_desktop_update,
            desktop_updater::install_desktop_update,
            desktop_updater::take_desktop_update_failure,
            workspace_open::open_workspace_target,
            workspace_open::open_local_path,
            set_workspace_menu_enabled,
            browser_target_register,
            browser_target_update,
            browser_target_action,
            browser_target_unregister,
            browser_target_claim_open,
            browser_target_ownership,
            browser_target_release_open
        ]))))
        .on_menu_event(|app_handle, event| {
            if embedded_view::zoom::focused(app_handle, event.id().0.as_str()) {
                return;
            }
            match event.id().0.as_str() {
                // File menu
                action @ ("new-instance"
                | "open-command-palette"
                | "open-workspace-folder"
                | "open-workspace-terminal"
                | "open-workspace-editor-vscode"
                | "open-workspace-editor-cursor"
                | "open-workspace-editor-zed"
                | "open-workspace-editor-vscodium"
                | "view-left-panel"
                | "view-right-panel"
                | "view-timeline") => {
                    emit_menu_action(app_handle, action);
                }
                "new-window" => {
                    if let Err(error) = local_windows::create_new_window(app_handle) {
                        eprintln!("[tauri] failed to create local window: {error}");
                    }
                }
                "quit" => {
                    shutdown::request(app_handle.clone());
                }

                // View menu
                "reload" => {
                    reload_target_window(app_handle);
                }
                "force_reload" => {
                    force_reload_target_window(app_handle);
                }
                "toggle_devtools" => {
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        if window.is_devtools_open() {
                            window.close_devtools();
                        } else {
                            window.open_devtools();
                        }
                    }
                }
                "reset_zoom" => {
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        set_target_zoom(app_handle, &window, client_state::DEFAULT_ZOOM_LEVEL);
                    }
                }
                "zoom_in" => {
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        let zoom = target_zoom(app_handle, &window);
                        set_target_zoom(app_handle, &window, zoom + ZOOM_STEP);
                    }
                }
                "zoom_out" => {
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        let zoom = target_zoom(app_handle, &window);
                        set_target_zoom(app_handle, &window, zoom - ZOOM_STEP);
                    }
                }

                "toggle_fullscreen" => {
                    toggle_fullscreen_window(app_handle);
                }

                // Window menu
                "minimize" => {
                    if let Some(webview) = local_windows::targeted_window(app_handle) {
                        app_handle.state::<AppState>().browser_controller.revoke_window_visibility(webview.window().label());
                        let _ = webview.window().minimize();
                    }
                }
                "zoom" => {
                    if let Some(webview) = local_windows::targeted_window(app_handle) {
                        let _ = webview.window().maximize();
                    }
                }
                "close_window" => {
                    if let Some(webview) = local_windows::targeted_window(app_handle) {
                        let _ = webview.window().close();
                    }
                }

                "open-help" => {
                    if !emit_menu_action(app_handle, "open-help") {
                        if let Err(err) = external_open::open_url(app_handle, HELP_URL) {
                            eprintln!("[tauri] failed to open CodeNomad help: {err}");
                            rfd::MessageDialog::new()
                                .set_title("CodeNomad Help")
                                .set_description("Could not open help in your browser. Visit https://neuralnomadsai.github.io/CodeNomad/ manually.")
                                .set_level(rfd::MessageLevel::Error)
                                .show();
                        }
                    }
                }
                "open-sponsor" => {
                    if !emit_menu_action(app_handle, "open-sponsor") {
                        if let Err(err) = external_open::open_url(app_handle, SPONSOR_URL) {
                            eprintln!("[tauri] failed to open the Support CodeNomad page: {err}");
                            rfd::MessageDialog::new()
                                .set_title("Support CodeNomad")
                                .set_description(format!("Could not open the Support CodeNomad page in your browser. Visit {SPONSOR_URL} manually."))
                                .set_level(rfd::MessageLevel::Error)
                                .show();
                        }
                    }
                }
                "open-about" | "help_open_about" => {
                    // About opens Settings → Info → About from the most recently used
                    // application window, which brings the Preferences window forward.
                    let delivered = local_windows::update_flow_window(app_handle)
                        .is_some_and(|window| emit_menu_action_to(app_handle, &window, "open-about"));
                    if !delivered {
                        rfd::MessageDialog::new()
                            .set_title("About CodeNomad")
                            .set_description(about_fallback_text(&app_handle.package_info().version.to_string()))
                            .set_level(rfd::MessageLevel::Info)
                            .show();
                    }
                }
                "get_updates" | "help_get_updates" => {
                    // Preferences and remote windows have no update flow: the most
                    // recently used application window runs it and comes forward.
                    let delivered = local_windows::update_flow_window(app_handle).is_some_and(|window| {
                        let delivered = emit_menu_action_to(app_handle, &window, "get-updates");
                        if delivered && !window.window().is_focused().unwrap_or(false) {
                            local_windows::focus(app_handle, window.label());
                        }
                        delivered
                    });
                    if !delivered {
                        open_releases_page(app_handle);
                    }
                }
                // App menu (macOS)
                "hide" => {
                    if let Some(webview) = local_windows::targeted_window(app_handle) {
                        let _ = app_handle.state::<AppState>().browser_controller.hide_owner(&webview.window());
                    }
                }
                "hide_others" => {
                    // TODO: Hide other app windows
                    println!("Hide Others menu item clicked");
                }
                "show_all" => {
                    // TODO: Show all app windows
                    println!("Show All menu item clicked");
                }

                _ => {
                    println!("Unhandled menu event: {}", event.id().0);
                }
            }
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                remote_dictation::revoke(&app_handle, None);
                app_handle.state::<device_speech::DeviceSpeech>().revoke(None);
                if shutdown::exit_allowed(&app_handle) {
                    return;
                }
                api.prevent_exit();
                shutdown::request(app_handle.clone());
            }
            #[cfg(target_os = "linux")]
            tauri::RunEvent::Exit => appimage_exit::stop_mounted_children(),
            #[cfg(windows)]
            tauri::RunEvent::Exit => {
                if let Some(plan) = shutdown::take_automation_restart(app_handle) {
                    plan.relaunch_and_exit(app_handle);
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Exit if shutdown::restart_on_exit() => {
                macos_relaunch::relaunch_and_exit(&app_handle)
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { paths, .. }),
                ..
            } => {
                FolderDropEvents::send(&app_handle, &label, "desktop:folder-drag-enter", Some(paths));
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
                ..
            } => {
                FolderDropEvents::send(&app_handle, &label, "desktop:folder-drop", Some(paths));
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave),
                ..
            } => {
                FolderDropEvents::send(&app_handle, &label, "desktop:folder-drag-leave", None);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(focused),
                ..
            } => {
                if focused && identity::local_window_id(&label).is_ok() {
                    app_handle
                        .state::<local_windows::LocalWindows>()
                        .mark_focused(&app_handle, &label);
                }
                update_workspace_menu_state(&app_handle);
                update_fullscreen_shortcut(&app_handle);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if remote_dictation::is_sheet(&label) {
                    remote_dictation::revoke(&app_handle, Some(&label));
                    return;
                }
                if label.starts_with("remote-") {
                    remote_dictation::remote_navigation_pending(&app_handle, &label, None);
                }
                if label == preferences_window::LABEL {
                    if shutdown::exit_allowed(&app_handle) {
                        return;
                    }
                    if preferences_window::intercept_close(&app_handle) {
                        api.prevent_close();
                    }
                    return;
                }
                if shutdown::exit_allowed(&app_handle) {
                    return;
                }
                let local_window = identity::local_window_id(&label).is_ok();
                if local_window || label.starts_with("remote-") {
                    let approved = shutdown::local_window_close_status(&app_handle, &label);
                    let launch_window = local_window && app_handle
                        .state::<local_windows::LocalWindows>()
                        .is_connect_only(&label);
                    match local_close_event_action(approved, launch_window) {
                        LocalCloseEventAction::Allow => return,
                        LocalCloseEventAction::Prevent => {
                            api.prevent_close();
                            return;
                        }
                        LocalCloseEventAction::Continue => {}
                    }
                } else if consume_approved_auxiliary_close(&app_handle, &label) {
                    return;
                }
                let windows = app_handle.windows();
                let final_window =
                    is_final_application_window(
                        &label,
                        windows.keys().map(String::as_str),
                        &app_handle
                            .state::<local_windows::LocalWindows>()
                            .connect_only_labels(),
                    );
                if final_window {
                    api.prevent_close();
                    request_final_application_window_close(app_handle.clone(), label, local_window);
                    return;
                }
                if local_window || label.starts_with("remote-") {
                    api.prevent_close();
                    shutdown::request_local_window_close(app_handle.clone(), label);
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                app_handle.state::<notification_click::NotificationClicks>().forget_window(&label);
                if remote_dictation::is_sheet(&label) {
                    remote_dictation::revoke(&app_handle, Some(&label));
                    remote_dictation::retired(&app_handle, &label);
                }
                if !label.starts_with("remote-") {
                    app_handle.state::<device_speech::DeviceSpeech>().revoke(Some(&label));
                }
                let _ = consume_approved_auxiliary_close(&app_handle, &label);
                app_handle
                    .state::<AppState>()
                    .browser_controller
                    .remove_window(&app_handle, &label);
                if let Ok(window_id) = identity::local_window_id(&label) {
                    app_handle
                        .state::<local_windows::LocalWindows>()
                        .remove_runtime(&label);
                    if let Some(state) = app_handle.try_state::<client_state::ClientState>() {
                        state.unregister_window(&window_id);
                    }
                }
                shutdown::local_window_destroyed(&app_handle, &label);
                release_destroyed_window_wake_lock(&app_handle, &label);
                if let Ok(mut zoom) = app_handle.state::<AppState>().remote_zoom_levels.lock() {
                    zoom.remove(&label);
                }
                update_workspace_menu_state(&app_handle);
                update_fullscreen_shortcut(&app_handle);
                if !app_handle.windows().is_empty() {
                    return;
                }

                // Stop the CLI only when the final window is gone and the app is
                // truly exiting.
                shutdown::request(app_handle.clone());
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let reopened = app_handle
                    .state::<local_windows::LocalWindows>()
                    .mru_label()
                    .is_some_and(|label| local_windows::focus(app_handle, &label));
                if !reopened {
                    if let Err(error) = local_windows::create_new_window(app_handle) {
                        eprintln!("[tauri] failed to create local window on reopen: {error}");
                    }
                }
            }
            _ => {}
        });
    drop(notification_badge_host);
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    use menu_labels::label;
    let is_mac = cfg!(target_os = "macos");
    let is_linux = cfg!(target_os = "linux");

    // Every translatable element is kept so renderer locale reports can retitle it.
    let mut labelled: Vec<(&'static str, MenuItemKind<Wry>)> = Vec::new();
    let item = |id: &str, key: &'static str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, label(key), true, accelerator)
    };
    let mut submenus = Vec::new();
    let about_item = item("open-about", "about", None)?;
    let get_updates_item = item("get_updates", "getUpdates", None)?;

    // App menu (macOS only)
    if is_mac {
        let hide_item = item("hide", "hide", None)?;
        let hide_others_item = item("hide_others", "hideOthers", None)?;
        let show_all_item = item("show_all", "showAll", None)?;
        let quit_item = item("quit", "quit", Some("CmdOrCtrl+Q"))?;
        let app_menu = SubmenuBuilder::new(app, "CodeNomad")
            .item(&about_item)
            .item(&get_updates_item)
            .separator()
            .item(&hide_item)
            .item(&hide_others_item)
            .item(&show_all_item)
            .separator()
            .item(&quit_item)
            .build()?;
        for (key, entry) in [("hide", hide_item), ("hideOthers", hide_others_item), ("showAll", show_all_item), ("quit", quit_item)] {
            labelled.push((key, MenuItemKind::MenuItem(entry)));
        }
        submenus.push(app_menu);
    }

    let new_window_item = item("new-window", "newWindow", Some("CmdOrCtrl+Shift+N"))?;
    let new_instance_item = item("new-instance", "newInstance", Some("CmdOrCtrl+N"))?;
    let open_folder_item = item("open-workspace-folder", "openFolder", None)?;
    let open_terminal_item = item("open-workspace-terminal", "openTerminal", None)?;
    let open_editor_menu = SubmenuBuilder::new(app, label("openIn"))
        .text("open-workspace-editor-vscode", "VS Code")
        .text("open-workspace-editor-cursor", "Cursor")
        .text("open-workspace-editor-zed", "Zed")
        .text("open-workspace-editor-vscodium", "VSCodium")
        .build()?;
    open_folder_item.set_enabled(false)?;
    open_terminal_item.set_enabled(false)?;
    open_editor_menu.set_enabled(false)?;
    if let Ok(mut items) = app.state::<AppState>().workspace_menu_items.lock() {
        *items = Some(WorkspaceMenuItems {
            folder: open_folder_item.clone(),
            terminal: open_terminal_item.clone(),
            editor: open_editor_menu.clone(),
        });
    }

    let file_menu = if is_mac {
        let close_item = PredefinedMenuItem::close_window(app, Some(label("closeWindow")))?;
        labelled.push(("closeWindow", MenuItemKind::Predefined(close_item.clone())));
        SubmenuBuilder::with_id(app, "menu-file", label("file"))
            .item(&open_folder_item)
            .item(&open_terminal_item)
            .item(&open_editor_menu)
            .separator()
            .item(&close_item)
            .build()?
    } else {
        let quit_item = item("quit", "quit", None)?;
        labelled.push(("quit", MenuItemKind::MenuItem(quit_item.clone())));
        SubmenuBuilder::with_id(app, "menu-file", label("file"))
            .item(&open_folder_item)
            .item(&open_terminal_item)
            .item(&open_editor_menu)
            .separator()
            .item(&quit_item)
            .build()?
    };

    let reload_item = item("reload", "reload", Some("CmdOrCtrl+R"))?;
    let force_reload_item = item("force_reload", "forceReload", Some("CmdOrCtrl+Shift+R"))?;
    let toggle_devtools_item = item("toggle_devtools", "devTools", Some("Alt+CmdOrCtrl+I"))?;
    let reset_zoom_item = item("reset_zoom", "actualSize", Some("CmdOrCtrl+0"))?;
    let zoom_in_item = item("zoom_in", "zoomIn", None)?;
    let zoom_out_item = item("zoom_out", "zoomOut", None)?;
    let toggle_fullscreen_item = item(
        "toggle_fullscreen",
        "fullScreen",
        if is_mac { Some("Ctrl+Cmd+F") } else { None },
    )?;
    let command_palette_item = item("open-command-palette", "commandPalette", Some("CmdOrCtrl+Shift+P"))?;

    // Edit menu with predefined items for standard functionality
    let undo_item = PredefinedMenuItem::undo(app, Some(label("undo")))?;
    let redo_item = PredefinedMenuItem::redo(app, Some(label("redo")))?;
    let cut_item = PredefinedMenuItem::cut(app, Some(label("cut")))?;
    let copy_item = PredefinedMenuItem::copy(app, Some(label("copy")))?;
    let paste_item = PredefinedMenuItem::paste(app, Some(label("paste")))?;
    let select_all_item = PredefinedMenuItem::select_all(app, Some(label("selectAll")))?;
    let edit_menu = SubmenuBuilder::with_id(app, "menu-edit", label("edit"))
        .item(&undo_item)
        .item(&redo_item)
        .separator()
        .item(&cut_item)
        .item(&copy_item)
        .item(&paste_item)
        .separator()
        .item(&select_all_item)
        .build()?;
    for (key, entry) in [
        ("undo", undo_item),
        ("redo", redo_item),
        ("cut", cut_item),
        ("copy", copy_item),
        ("paste", paste_item),
        ("selectAll", select_all_item),
    ] {
        labelled.push((key, MenuItemKind::Predefined(entry)));
    }

    // View menu
    let view_menu = SubmenuBuilder::with_id(app, "menu-view", label("view")).build()?;
    view_menu::append(app, &view_menu)?;
    view_menu.append_items(&[
        &reload_item,
        &force_reload_item,
        &toggle_devtools_item,
        &PredefinedMenuItem::separator(app)?,
        &reset_zoom_item,
        &zoom_in_item,
        &zoom_out_item,
        &PredefinedMenuItem::separator(app)?,
        &toggle_fullscreen_item,
    ])?;

    // Window menu
    let window_menu = if is_linux {
        let minimize_item = item("minimize", "minimize", None)?;
        let zoom_item = item("zoom", "zoom", None)?;
        let close_window_item = item("close_window", "closeWindow", Some("CmdOrCtrl+W"))?;
        let menu = SubmenuBuilder::with_id(app, "menu-window", label("window"))
            .item(&new_window_item)
            .item(&new_instance_item)
            .item(&command_palette_item)
            .separator()
            .item(&minimize_item)
            .item(&zoom_item)
            .separator()
            .item(&close_window_item)
            .build()?;
        for (key, entry) in [("minimize", minimize_item), ("zoom", zoom_item), ("closeWindow", close_window_item)] {
            labelled.push((key, MenuItemKind::MenuItem(entry)));
        }
        menu
    } else {
        let minimize_item = PredefinedMenuItem::minimize(app, Some(label("minimize")))?;
        // macOS names the window maximize command "Zoom".
        let maximize_key = if is_mac { "zoom" } else { "maximize" };
        let maximize_item = PredefinedMenuItem::maximize(app, Some(label(maximize_key)))?;
        let mut builder = SubmenuBuilder::with_id(app, "menu-window", label("window"))
            .item(&new_window_item)
            .item(&new_instance_item)
            .item(&command_palette_item)
            .separator()
            .item(&minimize_item)
            .item(&maximize_item);
        if !is_mac {
            let close_item = PredefinedMenuItem::close_window(app, Some(label("closeWindow")))?;
            builder = builder.separator().item(&close_item);
            labelled.push(("closeWindow", MenuItemKind::Predefined(close_item)));
        }
        labelled.push(("minimize", MenuItemKind::Predefined(minimize_item)));
        labelled.push((maximize_key, MenuItemKind::Predefined(maximize_item)));
        builder.build()?
    };

    let help_item = item("open-help", "codenomadHelp", None)?;
    let sponsor_item = item("open-sponsor", "sponsor", None)?;
    let help_menu = if is_mac {
        let help_updates_item = item("help_get_updates", "getUpdates", None)?;
        let help_about_item = item("help_open_about", "about", None)?;
        let menu = SubmenuBuilder::with_id(app, "menu-help", label("help"))
            .item(&help_item)
            .item(&sponsor_item)
            .item(&help_updates_item)
            .separator()
            .item(&help_about_item)
            .build()?;
        labelled.push(("getUpdates", MenuItemKind::MenuItem(help_updates_item)));
        labelled.push(("about", MenuItemKind::MenuItem(help_about_item)));
        menu
    } else {
        SubmenuBuilder::with_id(app, "menu-help", label("help"))
            .item(&help_item)
            .item(&sponsor_item)
            .item(&get_updates_item)
            .separator()
            .item(&about_item)
            .build()?
    };

    for (key, entry) in [
        ("about", about_item),
        ("getUpdates", get_updates_item),
        ("newWindow", new_window_item),
        ("newInstance", new_instance_item),
        ("openFolder", open_folder_item),
        ("openTerminal", open_terminal_item),
        ("reload", reload_item),
        ("forceReload", force_reload_item),
        ("devTools", toggle_devtools_item),
        ("actualSize", reset_zoom_item),
        ("zoomIn", zoom_in_item),
        ("zoomOut", zoom_out_item),
        ("fullScreen", toggle_fullscreen_item),
        ("commandPalette", command_palette_item),
        ("codenomadHelp", help_item),
        ("sponsor", sponsor_item),
    ] {
        labelled.push((key, MenuItemKind::MenuItem(entry)));
    }
    for (key, entry) in [
        ("openIn", &open_editor_menu),
        ("file", &file_menu),
        ("edit", &edit_menu),
        ("view", &view_menu),
        ("window", &window_menu),
        ("help", &help_menu),
    ] {
        labelled.push((key, MenuItemKind::Submenu(entry.clone())));
    }
    submenus.extend([file_menu, edit_menu, view_menu, window_menu, help_menu]);

    // Build the main menu with all submenus
    let submenu_refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = submenus
        .iter()
        .map(|s| s as &dyn tauri::menu::IsMenuItem<_>)
        .collect();
    let menu = MenuBuilder::new(app).items(&submenu_refs).build()?;

    app.set_menu(menu)?;
    app.state::<AppState>().menu_labels.replace_targets(labelled);
    Ok(())
}

/// Delivers a menu action to the focused local window only. Untargeted JS
/// listeners receive every event, so renderers listen on their own webview.
/// Loading, sign-in and pairing documents have no menu listener, so they receive nothing.
fn emit_menu_action(app_handle: &AppHandle, action: &str) -> bool {
    local_windows::focused_local_window(app_handle)
        .is_some_and(|window| emit_menu_action_to(app_handle, &window, action))
}

fn emit_menu_action_to(app_handle: &AppHandle, window: &tauri::Webview, action: &str) -> bool {
    window.url().is_ok_and(|url| !is_listenerless_document(&url))
        && app_handle
            .emit_to(EventTarget::webview(window.label()), "menu:action", action)
            .is_ok()
}

/// Native loading page and the server's non-application pages; the server
/// serves the application for every other path.
fn is_listenerless_document(url: &url::Url) -> bool {
    url.as_str() == "about:blank"
        || matches!(url.path(), "/loading.html" | "/login" | "/remote-pair")
        || url.path().starts_with("/auth/")
}

/// The latest-release page omits prereleases. Without access to the saved feed,
/// native fallbacks derive it from the installed build label.
fn releases_page(version: &str) -> &'static str {
    match update_releases::UpdateFeed::resolve(None, version) {
        update_releases::UpdateFeed::Preview => RELEASES_LIST_URL,
        update_releases::UpdateFeed::Stable => RELEASES_URL,
    }
}

fn open_releases_page(app_handle: &AppHandle) {
    let page = releases_page(&app_handle.package_info().version.to_string());
    if let Err(err) = external_open::open_url(app_handle, page) {
        eprintln!("[tauri] failed to open the CodeNomad releases page: {err}");
    }
}

/// Text of the native fallback when no application window can open Settings → Info.
fn about_fallback_text(version: &str) -> String {
    format!("CodeNomad {version}\nA desktop workspace for OpenCode.")
}

#[cfg(test)]
mod menu_tests {
    use super::{
        about_fallback_text, claim_unowned_remote_proxy_session, releases_page, clear_remote_tls_handler,
        is_allowed_local_origin, is_final_application_window, is_navigable_local_origin, local_close_event_action,
        require_http_url, rollback_remote_window_metadata, open_remote_external_url,
        should_allow_registered_origin, should_open_external_url, should_recreate_remote_window,
        titlebar_menu_id, LocalCloseEventAction,
        RemoteProfileIdentity, RemoteWindowMetadata, RemoteWindowOperationLocks, WakeLockState,
        HELP_URL, RELEASES_URL, REMOTE_WINDOW_CONTEXT_SCRIPT, SPONSOR_URL,
    };
    use serde_json::json;
    use url::Url;

    #[test]
    fn remote_help_policy_opens_only_allowlisted_https_in_system_browser() {
        let mut opened = Vec::new();
        for value in [HELP_URL, SPONSOR_URL, "https://neuralnomadsai.github.io/CodeNomad/fr/history.html#delete"] {
            let url = Url::parse(value).unwrap();
            assert!(open_remote_external_url(&url, |url| opened.push(url.to_string())));
        }
        assert_eq!(opened.len(), 3);
        for value in [
            "http://neuralnomadsai.github.io/CodeNomad/en/",
            "https://example.com/CodeNomad/",
            "https://neuralnomadsai.github.io.evil.example/CodeNomad/",
            "https://neuralnomadsai.github.io/other/",
            "https://neuralnomadsai.github.io/CodeNomad/../other/",
            "https://neuralnomadsai.github.io/CodeNomad/%2f..%2fother/",
            "https://neuralnomadsai.github.io:444/CodeNomad/",
            "https://user@neuralnomadsai.github.io/CodeNomad/",
            "mailto:help@example.com", "file:///CodeNomad/", "javascript:alert(1)",
        ] {
            assert!(!open_remote_external_url(&Url::parse(value).unwrap(), |_| panic!("denied URL reached the system opener: {value}")));
        }
    }

    #[test]
    fn about_blank_boot_document_navigates_but_never_becomes_a_trusted_origin() {
        let backend = "http://127.0.0.1:43123/";
        let blank = Url::parse("about:blank").unwrap();
        assert!(
            is_navigable_local_origin(&blank, Some(backend)),
            "the initial boot splash document must be navigable in local windows"
        );
        assert!(
            !is_allowed_local_origin(&blank, Some(backend)),
            "about:blank never gains IPC or renderer authority"
        );
        assert!(is_navigable_local_origin(
            &Url::parse(backend).unwrap(),
            Some(backend)
        ));
        assert!(!is_navigable_local_origin(
            &Url::parse("https://example.com/").unwrap(),
            Some(backend)
        ));
    }

    #[test]
    fn preferences_does_not_keep_the_last_application_window_alive() {
        assert!(is_final_application_window(
            "local-a",
            ["local-a", "preferences"].into_iter(),
            &[],
        ));
        assert!(!is_final_application_window(
            "local-a",
            ["local-a", "preferences", "local-b"].into_iter(),
            &[],
        ));
        assert!(!is_final_application_window(
            "local-a",
            ["local-a", "preferences", "remote-a"].into_iter(),
            &[],
        ));
    }

    #[test]
    fn webkit_popups_follow_the_last_application_window_lifetime() {
        assert_eq!(
            is_final_application_window(
                "local-a",
                ["local-a", "browser-popup-a"].into_iter(),
                &[],
            ),
            true,
        );
        assert!(!is_final_application_window(
            "local-a",
            ["local-a", "browser-popup-a", "local-b"].into_iter(),
            &[],
        ));
    }

    #[test]
    fn hidden_launch_windows_do_not_keep_the_last_application_window_alive() {
        let launch = vec!["local-launch".to_string()];
        // Closing the last visible window quits even while a launch connection is pending.
        assert!(is_final_application_window(
            "local-a",
            ["local-a", "local-launch"].into_iter(),
            &launch,
        ));
        assert!(is_final_application_window(
            "remote-a",
            ["remote-a", "local-launch", "preferences"].into_iter(),
            &launch,
        ));
        // The launch window closing beside its remote window is an ordinary close.
        assert!(!is_final_application_window(
            "local-launch",
            ["local-launch", "remote-a"].into_iter(),
            &launch,
        ));
        assert!(!is_final_application_window(
            "local-a",
            ["local-a", "local-launch"].into_iter(),
            &[],
        ));
    }

    #[test]
    fn local_close_only_allows_an_approved_request() {
        assert_eq!(
            local_close_event_action(Some(true), false),
            LocalCloseEventAction::Allow
        );
        assert_eq!(
            local_close_event_action(Some(false), false),
            LocalCloseEventAction::Prevent
        );
        assert_eq!(
            local_close_event_action(None, false),
            LocalCloseEventAction::Continue
        );
    }

    #[test]
    fn hidden_launch_windows_close_without_a_renderer_flush() {
        // Continue would request the flush that a launch window still on loading.html never acknowledges.
        for approved in [None, Some(false), Some(true)] {
            assert_eq!(
                local_close_event_action(approved, true),
                LocalCloseEventAction::Allow
            );
        }
    }

    #[test]
    fn titlebar_menu_ids_are_restricted_to_application_submenus() {
        assert_eq!(titlebar_menu_id("file"), Some("menu-file"));
        assert_eq!(titlebar_menu_id("help"), Some("menu-help"));
        assert_eq!(titlebar_menu_id("preferences"), None);
    }

    #[test]
    fn help_root_matches_the_shared_renderer_url() {
        let shared = include_str!("../../../ui/src/lib/help-url.ts");
        assert!(shared.contains(&format!("export const HELP_BASE_URL = \"{HELP_URL}\"")));
        assert_eq!(titlebar_menu_id("help"), Some("menu-help"));
    }

    #[test]
    fn sponsor_fallback_is_the_english_help_page() {
        // The renderer's helpUrl("en", "sponsor") builds `${HELP_BASE_URL}en/sponsor.html`.
        assert_eq!(SPONSOR_URL, format!("{HELP_URL}en/sponsor.html"));
        assert_eq!(super::menu_labels::label("sponsor"), "Support CodeNomad");
    }

    #[test]
    fn menu_actions_skip_documents_without_the_application() {
        for page in [
            "tauri://localhost/loading.html",
            "https://tauri.localhost/loading.html",
            "http://127.0.0.1:9898/login",
            "http://127.0.0.1:9898/remote-pair",
            "http://127.0.0.1:9898/auth/token",
        ] {
            assert!(super::is_listenerless_document(&Url::parse(page).unwrap()), "{page}");
        }
        for page in ["http://127.0.0.1:9898/", "http://127.0.0.1:9898/?folder=x", "http://127.0.0.1:9898/login-help"] {
            assert!(!super::is_listenerless_document(&Url::parse(page).unwrap()), "{page}");
        }
    }

    #[test]
    fn about_fallback_names_the_installed_version() {
        assert!(about_fallback_text("1.2.3").starts_with("CodeNomad 1.2.3\n"));
    }

    #[test]
    fn release_fallbacks_follow_the_installed_build_label() {
        assert_eq!(releases_page("1.2.3"), RELEASES_URL);
        // Preview builds link to the full list, which includes prereleases.
        assert_eq!(releases_page("0.20.1-dev-20261013-031eb843"), "https://github.com/NeuralNomadsAI/CodeNomad/releases");
    }

    #[test]
    fn remote_windows_identify_as_remote_tauri_windows() {
        assert!(REMOTE_WINDOW_CONTEXT_SCRIPT.contains("__CODENOMAD_RUNTIME_HOST__ = 'tauri'"));
        assert!(REMOTE_WINDOW_CONTEXT_SCRIPT.contains("__CODENOMAD_WINDOW_CONTEXT__ = 'remote'"));
        assert!(REMOTE_WINDOW_CONTEXT_SCRIPT.contains("__CODENOMAD_REMOTE_DICTATION__ = true"));

        let capability: serde_json::Value = serde_json::from_str(include_str!(
            "../capabilities/remote-window-notifications.json"
        ))
        .unwrap();
        assert_eq!(capability["local"], false);
        assert_eq!(
            capability["remote"]["urls"],
            json!(["http://*:*", "https://*:*"])
        );
        assert_eq!(capability["webviews"], json!(["remote-*"]));
        assert!(capability["windows"].is_null());
        assert_eq!(
            capability["permissions"],
            json!([
                "notification:allow-is-permission-granted",
                "notification:allow-request-permission",
                "notification:allow-notify",
                "allow-notification-badge-set",
                "allow-client-state-renderer-flushed",
                "allow-notification-permission",
                "allow-notification-show"
            ])
        );

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("remote-window-notifications")));
        assert_eq!(config["app"]["windows"], json!([]));
        let local: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        assert_eq!(local["webviews"], json!(["local-*"]));
        assert!(local["windows"].is_null());
        assert!(local["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-cli-restart")));
        assert!(!capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|permission| permission
                .as_str()
                .is_some_and(|value| value.starts_with("allow-cli-"))));
    }

    #[test]
    fn wake_lock_request_labels_are_reference_counted() {
        let mut state = WakeLockState::default();
        state.labels.insert("local-a".into());
        state.labels.insert("local-b".into());
        state.labels.remove("local-a");
        assert_eq!(
            state.labels,
            std::collections::HashSet::from(["local-b".to_string()])
        );
    }

    #[test]
    fn remote_windows_stay_on_their_registered_http_origin() {
        let origin = "https://remote.example:9898";
        assert!(should_allow_registered_origin(
            Some(origin),
            &Url::parse("https://remote.example:9898/settings").unwrap()
        ));
        assert!(!should_allow_registered_origin(
            Some(origin),
            &Url::parse("http://localhost:9898/").unwrap()
        ));
        assert!(should_allow_registered_origin(
            Some(origin),
            &Url::parse("about:blank").unwrap()
        ));
    }

    #[test]
    fn failed_remote_navigation_restores_exact_previous_authority() {
        let previous = RemoteWindowMetadata {
            origin: "https://old.example".into(),
            dictation_destination: "https://old.example".into(),
            dictation_document: Default::default(),
            title: "Old title".into(),
            allow_linux_tls_certificate: false,
            generation: 4,
            window_generation: 2,
        };
        let mut values = std::collections::HashMap::from([(
            "remote-a".to_string(),
            RemoteWindowMetadata {
                origin: "https://new.example".into(),
                dictation_destination: "https://new.example".into(),
                dictation_document: Default::default(),
                title: "New title".into(),
                allow_linux_tls_certificate: true,
                generation: 5,
                window_generation: 2,
            },
        )]);

        assert!(rollback_remote_window_metadata(
            &mut values,
            "remote-a",
            5,
            Some(previous.clone()),
        ));
        assert_eq!(values.get("remote-a"), Some(&previous));
    }

    #[test]
    fn stale_remote_navigation_failure_cannot_rollback_newer_authority() {
        let current = RemoteWindowMetadata {
            origin: "https://newest.example".into(),
            dictation_destination: "https://newest.example".into(),
            dictation_document: Default::default(),
            title: "Newest title".into(),
            allow_linux_tls_certificate: true,
            generation: 6,
            window_generation: 3,
        };
        let mut values =
            std::collections::HashMap::from([("remote-a".to_string(), current.clone())]);

        assert!(!rollback_remote_window_metadata(
            &mut values,
            "remote-a",
            5,
            None,
        ));
        assert_eq!(values.get("remote-a"), Some(&current));
    }

    #[test]
    fn stale_window_cleanup_cannot_remove_replacement_tls_handler() {
        let mut handlers = std::collections::HashMap::from([("remote-a".to_string(), 2)]);

        assert!(!clear_remote_tls_handler(&mut handlers, "remote-a", 1));
        assert_eq!(handlers.get("remote-a"), Some(&2));
        assert!(clear_remote_tls_handler(&mut handlers, "remote-a", 2));
        assert!(!handlers.contains_key("remote-a"));
    }

    #[test]
    fn remote_window_urls_require_http_or_https() {
        assert_eq!(
            require_http_url("http://localhost:3000/app", "baseUrl")
                .unwrap()
                .scheme(),
            "http"
        );
        assert_eq!(
            require_http_url("https://example.com/app", "entryUrl")
                .unwrap()
                .scheme(),
            "https"
        );
        for value in [
            "file:///tmp/app",
            "data:text/html,hi",
            "javascript:alert(1)",
        ] {
            assert!(require_http_url(value, "baseUrl")
                .unwrap_err()
                .contains("must use HTTP or HTTPS"));
        }
    }

    #[test]
    fn external_navigation_allows_only_web_and_mail_urls() {
        for value in [
            "https://example.com",
            "http://example.com",
            "mailto:hello@example.com",
        ] {
            assert!(should_open_external_url(&Url::parse(value).unwrap()));
        }
        for value in [
            "vscode://file/C:/workspace",
            "ms-settings:privacy",
            "tel:+15551234567",
            "unknown:target",
        ] {
            assert!(!should_open_external_url(&Url::parse(value).unwrap()));
        }
    }

    #[test]
    fn renderer_links_open_only_through_the_owned_opener() {
        for source in [
            include_str!("../capabilities/main-window.json"),
            include_str!("../capabilities/preferences-window.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(source).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            // open_external_url applies should_open_external_url and, on Linux,
            // the host environment; the plugin's own command would bypass both.
            assert!(permissions.contains(&json!("allow-open-external-url")));
            assert!(!permissions.iter().any(|permission| {
                let identifier = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap_or_default();
                identifier.starts_with("opener:")
            }));
        }
    }

    #[test]
    fn remote_window_reuse_requires_exact_profile_identity() {
        let direct = RemoteProfileIdentity::Direct;
        let proxy_a = RemoteProfileIdentity::Proxy("a".into());
        let proxy_b = RemoteProfileIdentity::Proxy("b".into());
        assert!(!should_recreate_remote_window(Some(&direct), &direct));
        assert!(!should_recreate_remote_window(Some(&proxy_a), &proxy_a));
        assert!(should_recreate_remote_window(Some(&direct), &proxy_a));
        assert!(should_recreate_remote_window(Some(&proxy_a), &direct));
        assert!(should_recreate_remote_window(Some(&proxy_a), &proxy_b));
        assert!(should_recreate_remote_window(None, &direct));
    }

    #[test]
    fn remote_window_operations_serialize_only_matching_labels() {
        let operations = RemoteWindowOperationLocks::default();
        let first = operations.for_label("remote-a").unwrap();
        let same = operations.for_label("remote-a").unwrap();
        let other = operations.for_label("remote-b").unwrap();

        tauri::async_runtime::block_on(async {
            let _guard = first.lock().await;
            assert!(same.try_lock().is_err());
            assert!(other.try_lock().is_ok());
        });
    }

    #[test]
    fn proxy_cleanup_is_claimed_once_and_never_while_owned() {
        let mut profiles = std::collections::HashMap::from([(
            "remote-a".to_string(),
            RemoteProfileIdentity::Proxy("previous".into()),
        )]);
        let mut claims = std::collections::HashSet::new();

        assert!(!claim_unowned_remote_proxy_session(
            &profiles,
            &mut claims,
            "previous",
        ));
        profiles.insert(
            "remote-a".into(),
            RemoteProfileIdentity::Proxy("newer".into()),
        );
        assert!(claim_unowned_remote_proxy_session(
            &profiles,
            &mut claims,
            "previous",
        ));
        assert!(!claim_unowned_remote_proxy_session(
            &profiles,
            &mut claims,
            "previous",
        ));
        assert!(!claim_unowned_remote_proxy_session(
            &profiles,
            &mut claims,
            "newer",
        ));
    }

    #[test]
    fn local_navigation_rejects_remote_and_unrelated_loopback_origins() {
        let managed = "http://127.0.0.1:43123";
        assert!(is_allowed_local_origin(
            &Url::parse("http://127.0.0.1:43123/workspace").unwrap(),
            Some(managed),
        ));
        assert!(!is_allowed_local_origin(
            &Url::parse("http://127.0.0.1:43124/workspace").unwrap(),
            Some(managed),
        ));
        assert!(!is_allowed_local_origin(
            &Url::parse("https://remote.example/workspace").unwrap(),
            Some(managed),
        ));
    }
}
