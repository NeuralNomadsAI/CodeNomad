#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[allow(dead_code)]
mod cert_manager;
mod cli_manager;
mod client_state;
mod developer_mode;
mod identity;
mod launch;
#[cfg(target_os = "linux")]
mod linux_tls;
mod local_windows;
mod managed_node;
mod native_request;
mod preferences_window;
mod shutdown;
mod windows_update;
mod workspace_open;

use cli_manager::{CliProcessManager, CliStatus};
use keepawake::KeepAwake;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
#[cfg(any(windows, test))]
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::{PageLoadEvent, Webview};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{
    Code as ShortcutCode, GlobalShortcutExt, Shortcut, ShortcutState,
};
use tauri_plugin_opener::OpenerExt;
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
const REMOTE_WINDOW_CONTEXT_SCRIPT: &str =
    "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'remote';";

pub struct AppState {
    pub manager: CliProcessManager,
    pub(crate) developer_mode: developer_mode::DeveloperMode,
    pub wake_lock: Mutex<WakeLockState>,
    remote_navigation: Mutex<HashMap<String, RemoteWindowMetadata>>,
    remote_navigation_generation: AtomicU64,
    remote_profiles: Mutex<HashMap<String, RemoteProfileIdentity>>,
    remote_window_operations: RemoteWindowOperationLocks,
    remote_proxy_cleanup_claims: Mutex<HashSet<String>>,
    pub remote_tls_handlers: Mutex<HashMap<String, u64>>,
    pub remote_zoom_levels: Mutex<HashMap<String, f64>>,
    pub workspace_menu_items: Mutex<Option<WorkspaceMenuItems>>,
    pub webview_data_directory: std::path::PathBuf,
    pub developer_browser_arguments: Option<String>,
    pub scoped_profile: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteWindowMetadata {
    origin: String,
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

pub struct WorkspaceMenuItems {
    folder: MenuItem<Wry>,
    terminal: MenuItem<Wry>,
    editor: Submenu<Wry>,
}

fn update_workspace_menu_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let enabled = local_windows::focused_window(app)
        .filter(|window| identity::local_window_id(window.label()).is_ok())
        .is_some_and(|window| {
            app.state::<local_windows::LocalWindows>()
                .workspace_menu_enabled(window.label())
        });
    if let Ok(items) = state.workspace_menu_items.lock() {
        if let Some(items) = items.as_ref() {
            let _ = items.folder.set_enabled(enabled);
            let _ = items.terminal.set_enabled(enabled);
            let _ = items.editor.set_enabled(enabled);
        }
    };
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

pub(crate) fn require_local_app_window(
    window: &tauri::WebviewWindow,
    state: &AppState,
) -> Result<Url, String> {
    identity::local_window_id(window.label())?;
    let current = window.url().map_err(|error| error.to_string())?;
    let status = state.manager.status();
    if is_allowed_local_origin(&current, status.url.as_deref()) {
        Ok(current)
    } else {
        Err("Native application commands require a trusted local renderer origin".into())
    }
}

pub(crate) fn require_preferences_or_local_app_window(
    window: &tauri::WebviewWindow,
    state: &AppState,
) -> Result<Url, String> {
    if window.label() != preferences_window::LABEL {
        return require_local_app_window(window, state);
    }
    let current = window.url().map_err(|error| error.to_string())?;
    let status = state.manager.status();
    if is_allowed_local_origin(&current, status.url.as_deref())
        || preferences_window::is_trusted_renderer_origin(window, &current)
    {
        Ok(current)
    } else {
        Err("Native application commands require a trusted preferences renderer origin".into())
    }
}

pub(crate) fn handle_native_request(
    app: &AppHandle,
    method: &str,
    _params: Option<serde_json::Value>,
    _deadline: u64,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    match method {
        "developer.status" => Ok(state.developer_mode.native_snapshot(app)),
        "developer.restart" => state.developer_mode.request_restart(app),
        _ => Err(format!("Unsupported native developer request: {method}")),
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
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    require_local_app_window(&window, &state)?;
    if !enabled {
        app.state::<local_windows::LocalWindows>()
            .set_workspace_menu_enabled(window.label(), false)?;
        update_workspace_menu_state(&app);
        return Ok(());
    }
    let config = state
        .manager
        .local_cli_access()
        .ok_or("Local CodeNomad server is unavailable")?;
    let expected = Url::parse(&config.base_url).map_err(|error| error.to_string())?;
    let current = window.url().map_err(|error| error.to_string())?;
    if current.origin() != expected.origin() {
        return Err("Workspace menu updates require the local CodeNomad origin".into());
    }
    app.state::<local_windows::LocalWindows>()
        .set_workspace_menu_enabled(window.label(), enabled)?;
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
fn developer_mode_get(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<developer_mode::DeveloperModeState, String> {
    require_local_app_window(&window, &state)?;
    Ok(state.developer_mode.state())
}

#[tauri::command]
fn developer_mode_set(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<developer_mode::DeveloperModeState, String> {
    require_local_app_window(&window, &state)?;
    state
        .developer_mode
        .set_enabled(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn window_control(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    action: String,
) -> Result<(), String> {
    require_preferences_or_local_app_window(&window, &state)?;
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "drag" => window.start_dragging(),
        "close" => {
            if window.label() == preferences_window::LABEL {
                preferences_window::approve_close(&app)?;
            }
            window.close()
        }
        _ => return Err("Invalid window control action".to_string()),
    }
    .map_err(|error| error.to_string())
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

#[tauri::command]
async fn popup_titlebar_menu(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    menu: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    require_local_app_window(&window, &state)?;
    if !x.is_finite() || !y.is_finite() {
        return Err("Invalid titlebar menu position".into());
    }
    let id = titlebar_menu_id(&menu).ok_or_else(|| "Unknown titlebar menu".to_string())?;
    let app_menu = window
        .app_handle()
        .menu()
        .ok_or_else(|| "Application menu is unavailable".to_string())?;
    let item = app_menu
        .get(id)
        .ok_or_else(|| "Titlebar menu is unavailable".to_string())?;
    let submenu = item
        .as_submenu()
        .ok_or_else(|| "Titlebar menu is invalid".to_string())?;
    window
        .popup_menu_at(submenu, tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)))
        .map_err(|error| error.to_string())
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

#[tauri::command]
fn cli_get_status(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Result<CliStatus, String> {
    require_preferences_or_local_app_window(&window, &state)?;
    Ok(state.manager.status())
}

#[tauri::command]
fn cli_restart(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<CliStatus, String> {
    require_preferences_or_local_app_window(&window, &state)?;
    shutdown::with_navigation_authority(&app, || {
        let dev_mode = is_dev_mode();
        state
            .manager
            .stop_until(Instant::now() + Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        state
            .manager
            .start(app.clone(), dev_mode)
            .map_err(|e| e.to_string())?;
        Ok(state.manager.status())
    })
    .unwrap_or_else(|| Err("Application shutdown is in progress".to_string()))
}

#[tauri::command]
fn wake_lock_start(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    config: Option<WakeLockConfig>,
) -> Result<(), String> {
    require_local_app_window(&window, &state)?;
    let config = config.unwrap_or(WakeLockConfig {
        display: false,
        idle: true,
        sleep: false,
    });

    let mut builder = keepawake::Builder::default();
    builder
        .display(config.display)
        .idle(config.idle)
        .sleep(config.sleep)
        .reason("CodeNomad active session")
        .app_name("CodeNomad")
        .app_reverse_domain("ai.neuralnomads.codenomad.client");

    let mut state_lock = state.wake_lock.lock().map_err(|err| err.to_string())?;
    state_lock.labels.insert(window.label().to_string());
    if state_lock.handle.is_none() {
        state_lock.handle = Some(builder.create().map_err(|err| err.to_string())?);
    }
    Ok(())
}

#[tauri::command]
fn wake_lock_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    require_local_app_window(&window, &state)?;
    let mut state_lock = state.wake_lock.lock().map_err(|err| err.to_string())?;
    state_lock.labels.remove(window.label());
    if state_lock.labels.is_empty() {
        state_lock.handle.take();
    }
    Ok(())
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
        return is_allowed_local_origin(url, status.url.as_deref());
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

fn intercept_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    let window_label = webview.label().to_string();
    if should_allow_window_origin(&webview.app_handle(), &window_label, url) {
        return true;
    }

    if should_open_external_url(url) {
        if let Err(err) = webview
            .app_handle()
            .opener()
            .open_url(url.as_str(), None::<&str>)
        {
            eprintln!("[tauri] failed to open external link {}: {}", url, err);
        }
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

    if let Some(window) = app_handle.get_webview_window(window_label) {
        let _ = window.set_title(&title);
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
    require_http_url(&payload.base_url, "baseUrl")?;
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
    let builder = WebviewWindowBuilder::new(
        &app,
        label.clone(),
        WebviewUrl::External(initial_url.clone()),
    )
    .data_directory(data_directory)
    .incognito(requested_profile.proxy_session_id().is_some())
    .initialization_script(REMOTE_WINDOW_CONTEXT_SCRIPT)
    .title(title)
    .inner_size(1400.0, 900.0)
    .min_inner_size(800.0, 600.0);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(profile_identifier(&profile_key));
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
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
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(_)) {
            update_workspace_menu_state(&app_handle);
        }
        if let WindowEvent::Destroyed = event {
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
            title: title.to_string(),
            allow_linux_tls_certificate,
            generation,
            window_generation,
        },
    );
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
    navigation.remove(label);
    if let Ok(mut values) = state.remote_tls_handlers.lock() {
        clear_remote_tls_handler(&mut values, label, window_generation);
    }
    true
}

#[tauri::command]
fn needs_local_certificate_install(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Result<bool, String> {
    require_preferences_or_local_app_window(&window, &state)?;
    #[cfg(not(target_os = "linux"))]
    {
        let local_cert = cert_manager::ensure_local_cert().map_err(|err| {
            format!("Failed to load the local HTTPS certificate for the remote proxy window: {err}")
        })?;
        return cert_manager::needs_trust_in_store(&local_cert.ca_cert_der).map_err(|err| {
            format!("Failed to inspect the local CodeNomad certificate trust state: {err}")
        });
    }

    #[cfg(target_os = "linux")]
    {
        Ok(false)
    }
}

#[tauri::command]
async fn open_remote_window(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    payload: RemoteWindowPayload,
) -> Result<(), String> {
    require_preferences_or_local_app_window(&window, &state)?;
    #[cfg(not(target_os = "linux"))]
    {
        let entry_url = payload
            .entry_url
            .as_deref()
            .unwrap_or(payload.base_url.as_str());
        require_http_url(&payload.base_url, "baseUrl")?;
        let parsed = require_http_url(entry_url, "entryUrl")?;
        if payload.proxy_session_id.is_some() && parsed.scheme() == "https" {
            let local_cert = cert_manager::ensure_local_cert().map_err(|err| {
                format!(
                    "Failed to load the local HTTPS certificate for the remote proxy window: {err}"
                )
            })?;
            if let Err(err) = cert_manager::trust_cert_in_store(&local_cert.ca_cert_der) {
                return Err(format!(
                    "Failed to trust the local CodeNomad CA certificate. Accept the certificate installation prompt and try again: {err}"
                ));
            }
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

fn emit_window_event(app_handle: &AppHandle, window_label: &str, event_name: &str) {
    if let Some(window) = app_handle.get_webview_window(window_label) {
        let _ = window.emit(event_name, ());
    }
}

fn emit_folder_drop_event(
    app_handle: &AppHandle,
    window_label: &str,
    event_name: &str,
    paths: &[std::path::PathBuf],
) {
    let directories = collect_directory_paths(paths);

    if directories.is_empty() {
        return;
    }

    if let Some(window) = app_handle.get_webview_window(window_label) {
        let _ = window.emit(event_name, json!({ "paths": directories }));
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
            app.get_webview_window(&target_label)
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
                .get_webview_window(&target_label)
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
    if let Some(window) = local_windows::targeted_window(app_handle) {
        let next_fullscreen = !window.is_fullscreen().unwrap_or(false);
        let _ = window.set_fullscreen(next_fullscreen);
        if cfg!(not(target_os = "macos")) {
            let _ = window.hide_menu();
        }
    }
}

fn set_target_zoom(app: &AppHandle, window: &tauri::WebviewWindow, zoom: f64) {
    if identity::local_window_id(window.label()).is_ok() {
        client_state::set_local_window_zoom(app, window.label(), zoom);
        return;
    }
    let zoom = zoom.clamp(0.25, 5.0);
    if window.set_zoom(zoom).is_ok() {
        if let Ok(mut levels) = app.state::<AppState>().remote_zoom_levels.lock() {
            levels.insert(window.label().to_string(), zoom);
        }
    }
}

fn target_zoom(app: &AppHandle, window: &tauri::WebviewWindow) -> f64 {
    if identity::local_window_id(window.label()).is_ok() {
        client_state::local_window_zoom(app, window.label())
    } else {
        app.state::<AppState>()
            .remote_zoom_levels
            .lock()
            .ok()
            .and_then(|levels| levels.get(window.label()).copied())
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
    let local_focused = app.webview_windows().into_values().any(|window| {
        identity::local_window_id(window.label()).is_ok() && window.is_focused().unwrap_or(false)
    });
    if local_focused {
        let _ = app.global_shortcut().register(shortcut);
    } else {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

#[cfg(windows)]
fn set_windows_app_user_model_id(identifier: &str) {
    let app_id: Vec<u16> = OsStr::new(identifier)
        .encode_wide()
        .chain(iter::once(0))
        .collect();

    let result = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
    if result < 0 {
        eprintln!("[tauri] failed to set AppUserModelID: {result}");
    }
}

#[cfg(not(windows))]
fn set_windows_app_user_model_id(_identifier: &str) {}

#[cfg(windows)]
fn configure_developer_webview(
    scope: &identity::IdentityScope,
    active: bool,
) -> std::io::Result<(
    Option<std::path::PathBuf>,
    std::path::PathBuf,
    Option<String>,
)> {
    let developer_profile = scope.webview_data_directory.join("developer-mode");
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
    let profile = if active {
        developer_profile
    } else {
        scope.webview_data_directory.clone()
    };
    let devtools_active_port = active.then(|| {
        profile
            .join("local")
            .join("EBWebView")
            .join("DevToolsActivePort")
    });
    let developer_browser_arguments =
        active.then(|| developer_mode::webview2_arguments(None, Some(0)));
    Ok((devtools_active_port, profile, developer_browser_arguments))
}

#[cfg(not(windows))]
fn configure_developer_webview(
    scope: &identity::IdentityScope,
    _active: bool,
) -> std::io::Result<(
    Option<std::path::PathBuf>,
    std::path::PathBuf,
    Option<String>,
)> {
    Ok((None, scope.webview_data_directory.clone(), None))
}

fn configure_developer_environment(active: bool) {
    if active {
        std::env::set_var("RUST_BACKTRACE", "1");
        std::env::set_var(
            "NODE_OPTIONS",
            developer_mode::append_node_option(
                std::env::var("NODE_OPTIONS").ok().as_deref(),
                "--enable-source-maps",
            ),
        );
        std::env::set_var("CODENOMAD_DEVELOPER_MODE", "1");
    } else {
        std::env::remove_var("CODENOMAD_DEVELOPER_MODE");
    }
}

fn schedule_launch_drain(app: AppHandle, queue: Arc<launch::LaunchQueue>) {
    let dispatch = app.clone();
    let _ = app.run_on_main_thread(move || {
        for intent in queue.drain() {
            if let Err(error) = local_windows::handle_intent(&dispatch, intent) {
                eprintln!("[tauri-startup] launch intent failed: {error}");
            }
        }
    });
}

fn is_final_application_window<'a>(
    closing_label: &str,
    mut labels: impl Iterator<Item = &'a str>,
) -> bool {
    !labels.any(|label| label != closing_label && label != preferences_window::LABEL)
}

fn main() {
    #[cfg(windows)]
    if let Some(code) = cli_manager::run_windows_cli_launcher_if_requested() {
        std::process::exit(code);
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let cwd = std::env::current_dir().unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_else(|| cwd.clone());
    let local_data = dirs::data_local_dir().unwrap_or_else(|| home.clone());
    let scope = identity::resolve_scope(
        std::env::var("CODENOMAD_UPDATE_CHANNEL").ok().as_deref(),
        std::env::var("CLI_CONFIG").ok().as_deref(),
        env!("CARGO_PKG_VERSION"),
        !is_dev_mode(),
        &cwd,
        &home,
        &local_data,
    );
    let developer_marker_path = developer_mode::marker_path(&home);
    let developer_mode_active = developer_mode::read_enabled(&developer_marker_path);
    configure_developer_environment(developer_mode_active);
    let (devtools_active_port, webview_data_directory, developer_browser_arguments) =
        configure_developer_webview(&scope, developer_mode_active)
            .expect("configure Developer Mode browser profile");
    let executable = std::env::current_exe()
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path))
        .unwrap_or_default();
    let developer_identity =
        Sha256::digest(format!("{}\0{}", scope.identifier, executable.display()).as_bytes())[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
    let developer_mode = developer_mode::DeveloperMode::new(
        developer_mode_active,
        format!("tauri:{developer_identity}"),
        devtools_active_port,
        developer_marker_path,
    );

    let launch_queue = Arc::new(launch::LaunchQueue::default());
    launch_queue.enqueue(launch::parse_launch_intent(
        &std::env::args().skip(1).collect::<Vec<_>>(),
        &cwd,
    ));
    let singleton_queue = Arc::clone(&launch_queue);
    let second_launch_config = std::path::PathBuf::from(&scope.config_identity);
    let single_instance = tauri_plugin_single_instance::init(move |app, args, callback_cwd| {
        let cwd = std::path::PathBuf::from(callback_cwd);
        let arguments = args.into_iter().skip(1).collect::<Vec<_>>();
        #[cfg(windows)]
        let intent = launch::parse_windows_forwarded_launch_intent(&arguments, &cwd);
        #[cfg(not(windows))]
        let intent = launch::parse_launch_intent(&arguments, &cwd);
        singleton_queue.enqueue(launch::prepare_second_launch_intent(
            intent,
            &second_launch_config,
        ));
        schedule_launch_drain(app.clone(), Arc::clone(&singleton_queue));
    });

    let navigation_guard: TauriPlugin<Wry, ()> = PluginBuilder::new("external-link-guard")
        .on_navigation(|webview, url| intercept_navigation(webview, url))
        .build();

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = scope.identifier.clone();
    let setup_scope = scope.clone();
    let setup_queue = Arc::clone(&launch_queue);

    tauri::Builder::default()
        .plugin(single_instance)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    if fullscreen_shortcut().as_ref() == Some(shortcut) {
                        toggle_fullscreen_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(navigation_guard)
        .manage(local_windows::LocalWindows::default())
        .manage(preferences_window::PreferencesWindow::default())
        .manage(AppState {
            manager: CliProcessManager::new(),
            developer_mode,
            wake_lock: Mutex::new(WakeLockState::default()),
            remote_navigation: Mutex::new(HashMap::new()),
            remote_navigation_generation: AtomicU64::new(0),
            remote_profiles: Mutex::new(HashMap::new()),
            remote_window_operations: RemoteWindowOperationLocks::default(),
            remote_proxy_cleanup_claims: Mutex::new(HashSet::new()),
            remote_tls_handlers: Mutex::new(HashMap::new()),
            remote_zoom_levels: Mutex::new(HashMap::new()),
            workspace_menu_items: Mutex::new(None),
            webview_data_directory,
            developer_browser_arguments,
            scoped_profile: setup_scope.scoped,
        })
        .on_page_load(|webview, payload| {
            if identity::local_window_id(webview.label()).is_ok()
                && payload.event() == PageLoadEvent::Started
            {
                let app = webview.app_handle();
                let managed_backend = app.state::<AppState>().manager.status().url;
                if is_allowed_local_origin(payload.url(), managed_backend.as_deref()) {
                    if let (Ok(window_id), Some(state)) = (
                        identity::local_window_id(webview.label()),
                        app.try_state::<client_state::ClientState>(),
                    ) {
                        if let Err(error) =
                            state.stage_renderer_page_load(&window_id, payload.url())
                        {
                            eprintln!("[client-state] failed to stage renderer page load: {error}");
                        }
                    }
                }
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
            set_windows_app_user_model_id(&setup_scope.identifier);
            let client_state = client_state::ClientState::initialize(
                &app.handle(),
                setup_scope.client_state_directory.as_deref(),
            );
            app.manage(client_state);
            app.manage(shutdown::ShutdownCoordinator::default());
            build_menu(&app.handle())?;
            local_windows::restore_windows(&app.handle())
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
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
        .invoke_handler(tauri::generate_handler![
            cli_get_status,
            cli_restart,
            wake_lock_start,
            wake_lock_stop,
            needs_local_certificate_install,
            preferences_window::open_preferences_window,
            preferences_window::preferences_window_ready,
            preferences_window::preferences_get_request,
            preferences_window::preferences_accept_request,
            preferences_window::preferences_resolve_transition,
            window_control,
            popup_titlebar_menu,
            open_remote_window,
            client_state::client_state_claim_access,
            client_state::client_state_load,
            client_state::client_state_save,
            client_state::client_state_commit_partitions,
            client_state::client_state_load_partition,
            client_state::client_state_set_restore_enabled,
            client_state::client_state_clear,
            client_state::client_state_renderer_flushed,
            client_state::client_state_navigation_flushed,
            local_windows::desktop_launch_ready,
            local_windows::desktop_launch_next_folder,
            local_windows::desktop_launch_acknowledge_folder,
            windows_update::install_stable_update,
            workspace_open::open_workspace_target,
            set_workspace_menu_enabled,
            developer_mode_get,
            developer_mode_set
        ])
        .on_menu_event(|app_handle, event| {
            match event.id().0.as_str() {
                // File menu
                action @ ("new-instance"
                | "open-command-palette"
                | "open-workspace-folder"
                | "open-workspace-terminal"
                | "open-workspace-editor-vscode"
                | "open-workspace-editor-cursor"
                | "open-workspace-editor-zed"
                | "open-workspace-editor-vscodium") => {
                    if let Some(window) = local_windows::focused_local_window(app_handle) {
                        let _ = window.emit("menu:action", action);
                    }
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
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        let _ = window.minimize();
                    }
                }
                "zoom" => {
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        let _ = window.maximize();
                    }
                }
                "close_window" => {
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        let _ = window.close();
                    }
                }

                "get_updates" | "help_get_updates" => {
                    #[cfg(windows)]
                    {
                        let app_handle = app_handle.clone();
                        tauri::async_runtime::spawn(run_update_with_fallback(
                            windows_update::install_stable_update_impl(),
                            move || open_releases_page(&app_handle),
                        ));
                    }

                    #[cfg(not(windows))]
                    open_releases_page(app_handle);
                }
                // App menu (macOS)
                "hide" => {
                    if let Some(window) = local_windows::targeted_window(app_handle) {
                        let _ = window.hide();
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
                if shutdown::exit_allowed(&app_handle) {
                    return;
                }
                api.prevent_exit();
                shutdown::request(app_handle.clone());
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { paths, .. }),
                ..
            } => {
                emit_folder_drop_event(&app_handle, &label, "desktop:folder-drag-enter", &paths);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
                ..
            } => {
                emit_folder_drop_event(&app_handle, &label, "desktop:folder-drop", &paths);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave),
                ..
            } => {
                emit_window_event(&app_handle, &label, "desktop:folder-drag-leave");
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
                if label == preferences_window::LABEL {
                    if shutdown::exit_allowed(&app_handle) {
                        return;
                    }
                    if preferences_window::intercept_close(&app_handle) {
                        api.prevent_close();
                        return;
                    }
                    if let Err(error) = app_handle
                        .state::<client_state::ClientState>()
                        .set_preferences(None)
                    {
                        eprintln!("[client-state] failed to close Preferences: {error}");
                        api.prevent_close();
                    }
                    return;
                }
                if shutdown::exit_allowed(&app_handle) {
                    return;
                }
                let local_window = identity::local_window_id(&label).is_ok();
                if local_window {
                    match shutdown::consume_local_window_close(&app_handle, &label) {
                        Some(true) => return,
                        Some(false) => {
                            api.prevent_close();
                            return;
                        }
                        None => {}
                    }
                }
                let windows = app_handle.webview_windows();
                let final_window =
                    is_final_application_window(&label, windows.keys().map(String::as_str));
                if final_window {
                    api.prevent_close();
                    shutdown::request(app_handle.clone());
                    return;
                }
                if local_window {
                    api.prevent_close();
                    shutdown::request_local_window_close(app_handle.clone(), label);
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                if let Ok(window_id) = identity::local_window_id(&label) {
                    app_handle
                        .state::<local_windows::LocalWindows>()
                        .remove_runtime(&label);
                    if let Some(state) = app_handle.try_state::<client_state::ClientState>() {
                        state.unregister_window(&window_id);
                    }
                }
                if let Ok(mut wake) = app_handle.state::<AppState>().wake_lock.lock() {
                    wake.labels.remove(&label);
                    if wake.labels.is_empty() {
                        wake.handle.take();
                    }
                }
                if let Ok(mut zoom) = app_handle.state::<AppState>().remote_zoom_levels.lock() {
                    zoom.remove(&label);
                }
                update_workspace_menu_state(&app_handle);
                update_fullscreen_shortcut(&app_handle);
                if !app_handle.webview_windows().is_empty() {
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
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let is_mac = cfg!(target_os = "macos");
    let is_linux = cfg!(target_os = "linux");

    // Create submenus
    let mut submenus = Vec::new();
    let about_item = PredefinedMenuItem::about(
        app,
        Some("About CodeNomad"),
        Some(build_about_metadata(
            &app.package_info().version.to_string(),
            cfg!(target_os = "linux"),
        )),
    )?;
    let get_updates_item =
        MenuItem::with_id(app, "get_updates", "Get Updates...", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit CodeNomad", true, Some("CmdOrCtrl+Q"))?;

    // App menu (macOS only)
    if is_mac {
        let app_menu = SubmenuBuilder::new(app, "CodeNomad")
            .item(&about_item)
            .item(&get_updates_item)
            .separator()
            .text("hide", "Hide CodeNomad")
            .text("hide_others", "Hide Others")
            .text("show_all", "Show All")
            .separator()
            .item(&quit_item)
            .build()?;
        submenus.push(app_menu);
    }

    let new_window_item = MenuItem::with_id(
        app,
        "new-window",
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_instance_item = MenuItem::with_id(
        app,
        "new-instance",
        "New Instance",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let open_folder_item = MenuItem::with_id(
        app,
        "open-workspace-folder",
        "Open Project Folder",
        true,
        None::<&str>,
    )?;
    let open_terminal_item = MenuItem::with_id(
        app,
        "open-workspace-terminal",
        "Open Terminal Here",
        true,
        None::<&str>,
    )?;
    let open_editor_menu = SubmenuBuilder::new(app, "Open Project In")
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
        SubmenuBuilder::with_id(app, "menu-file", "File")
            .item(&open_folder_item)
            .item(&open_terminal_item)
            .item(&open_editor_menu)
            .separator()
            .close_window()
            .build()?
    } else {
        SubmenuBuilder::with_id(app, "menu-file", "File")
            .item(&open_folder_item)
            .item(&open_terminal_item)
            .item(&open_editor_menu)
            .separator()
            .text("quit", "Quit")
            .build()?
    };
    submenus.push(file_menu);

    let reload_item = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let force_reload_item = MenuItem::with_id(
        app,
        "force_reload",
        "Force Reload",
        true,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    let toggle_devtools_item = MenuItem::with_id(
        app,
        "toggle_devtools",
        "Toggle Developer Tools",
        true,
        Some("Alt+CmdOrCtrl+I"),
    )?;
    let reset_zoom_item =
        MenuItem::with_id(app, "reset_zoom", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let zoom_in_item = MenuItem::with_id(
        app,
        "zoom_in",
        if is_mac { "Zoom In" } else { "Zoom In\tCtrl++" },
        true,
        None::<&str>,
    )?;
    let zoom_out_item = MenuItem::with_id(
        app,
        "zoom_out",
        if is_mac {
            "Zoom Out"
        } else {
            "Zoom Out\tCtrl+-"
        },
        true,
        None::<&str>,
    )?;
    let toggle_fullscreen_item = MenuItem::with_id(
        app,
        "toggle_fullscreen",
        if is_mac {
            "Toggle Full Screen"
        } else {
            "Toggle Full Screen\tF11"
        },
        true,
        if is_mac {
            Some("Ctrl+Cmd+F")
        } else {
            None::<&str>
        },
    )?;
    let close_window_item =
        MenuItem::with_id(app, "close_window", "Close", true, Some("CmdOrCtrl+W"))?;
    let command_palette_item = MenuItem::with_id(
        app,
        "open-command-palette",
        "Command Palette",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?;

    // Edit menu with predefined items for standard functionality
    let edit_menu = SubmenuBuilder::with_id(app, "menu-edit", "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()?;
    submenus.push(edit_menu);

    // View menu
    let view_menu = SubmenuBuilder::with_id(app, "menu-view", "View")
        .item(&reload_item)
        .item(&force_reload_item)
        .item(&toggle_devtools_item)
        .separator()
        .item(&reset_zoom_item)
        .item(&zoom_in_item)
        .item(&zoom_out_item)
        .separator()
        .item(&toggle_fullscreen_item)
        .build()?;
    submenus.push(view_menu);

    // Window menu
    let window_menu = if is_linux {
        SubmenuBuilder::with_id(app, "menu-window", "Window")
            .item(&new_window_item)
            .item(&new_instance_item)
            .item(&command_palette_item)
            .separator()
            .text("minimize", "Minimize")
            .text("zoom", "Zoom")
            .separator()
            .item(&close_window_item)
            .build()?
    } else if is_mac {
        SubmenuBuilder::with_id(app, "menu-window", "Window")
            .item(&new_window_item)
            .item(&new_instance_item)
            .item(&command_palette_item)
            .separator()
            .minimize()
            .maximize()
            .build()?
    } else {
        SubmenuBuilder::with_id(app, "menu-window", "Window")
            .item(&new_window_item)
            .item(&new_instance_item)
            .item(&command_palette_item)
            .separator()
            .minimize()
            .maximize()
            .separator()
            .close_window()
            .build()?
    };
    submenus.push(window_menu);

    let help_menu = if is_mac {
        let help_updates_item = MenuItem::with_id(
            app,
            "help_get_updates",
            "Get Updates...",
            true,
            None::<&str>,
        )?;
        let help_about_item = PredefinedMenuItem::about(
            app,
            Some("About CodeNomad"),
            Some(build_about_metadata(
                &app.package_info().version.to_string(),
                false,
            )),
        )?;
        SubmenuBuilder::with_id(app, "menu-help", "Help")
            .item(&help_updates_item)
            .separator()
            .item(&help_about_item)
            .build()?
    } else {
        SubmenuBuilder::with_id(app, "menu-help", "Help")
            .item(&get_updates_item)
            .separator()
            .item(&about_item)
            .build()?
    };
    submenus.push(help_menu);

    // Build the main menu with all submenus
    let submenu_refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = submenus
        .iter()
        .map(|s| s as &dyn tauri::menu::IsMenuItem<_>)
        .collect();
    let menu = MenuBuilder::new(app).items(&submenu_refs).build()?;

    app.set_menu(menu)?;
    Ok(())
}

#[cfg(any(windows, test))]
async fn run_update_with_fallback(
    update: impl Future<Output = Result<(), String>>,
    fallback: impl FnOnce(),
) {
    if let Err(err) = update.await {
        eprintln!("[tauri] WinGet update failed, opening the releases page: {err}");
        fallback();
    }
}

fn open_releases_page(app_handle: &AppHandle) {
    if let Err(err) = app_handle.opener().open_url(RELEASES_URL, None::<&str>) {
        eprintln!("[tauri] failed to open the CodeNomad releases page: {err}");
    }
}

fn build_about_metadata(version: &str, include_update_link: bool) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("CodeNomad".to_string()),
        version: Some(version.to_string()),
        authors: Some(vec!["Neural Nomads AI".to_string()]),
        comments: Some("A desktop workspace for OpenCode.".to_string()),
        license: Some("MIT".to_string()),
        website: include_update_link.then(|| RELEASES_URL.to_string()),
        website_label: include_update_link.then(|| "Get updates".to_string()),
        ..Default::default()
    }
}

#[cfg(test)]
mod menu_tests {
    use super::{
        build_about_metadata, claim_unowned_remote_proxy_session, clear_remote_tls_handler,
        is_allowed_local_origin, is_final_application_window, require_http_url,
        rollback_remote_window_metadata, run_update_with_fallback, should_allow_registered_origin,
        should_open_external_url, should_recreate_remote_window, titlebar_menu_id,
        RemoteProfileIdentity, RemoteWindowMetadata, RemoteWindowOperationLocks, WakeLockState,
        RELEASES_URL, REMOTE_WINDOW_CONTEXT_SCRIPT,
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use url::Url;

    #[test]
    fn preferences_does_not_keep_the_last_application_window_alive() {
        assert!(is_final_application_window(
            "local-a",
            ["local-a", "preferences"].into_iter(),
        ));
        assert!(!is_final_application_window(
            "local-a",
            ["local-a", "preferences", "local-b"].into_iter(),
        ));
        assert!(!is_final_application_window(
            "local-a",
            ["local-a", "preferences", "remote-a"].into_iter(),
        ));
    }

    #[test]
    fn titlebar_menu_ids_are_restricted_to_application_submenus() {
        assert_eq!(titlebar_menu_id("file"), Some("menu-file"));
        assert_eq!(titlebar_menu_id("help"), Some("menu-help"));
        assert_eq!(titlebar_menu_id("preferences"), None);
    }

    #[test]
    fn failed_update_uses_release_fallback() {
        let fallback_called = AtomicBool::new(false);

        tauri::async_runtime::block_on(run_update_with_fallback(
            async { Err("update failed".to_string()) },
            || fallback_called.store(true, Ordering::Relaxed),
        ));

        assert!(fallback_called.load(Ordering::Relaxed));
    }

    #[test]
    fn about_metadata_includes_version_and_supported_update_link() {
        let metadata = build_about_metadata("1.2.3", true);

        assert_eq!(metadata.name.as_deref(), Some("CodeNomad"));
        assert_eq!(metadata.version.as_deref(), Some("1.2.3"));
        assert_eq!(metadata.website.as_deref(), Some(RELEASES_URL));
        assert_eq!(metadata.website_label.as_deref(), Some("Get updates"));
    }

    #[test]
    fn about_metadata_omits_unsupported_update_link() {
        let metadata = build_about_metadata("1.2.3", false);

        assert_eq!(metadata.website, None);
        assert_eq!(metadata.website_label, None);
    }

    #[test]
    fn remote_windows_identify_as_remote_tauri_windows() {
        assert!(REMOTE_WINDOW_CONTEXT_SCRIPT.contains("__CODENOMAD_RUNTIME_HOST__ = 'tauri'"));
        assert!(REMOTE_WINDOW_CONTEXT_SCRIPT.contains("__CODENOMAD_WINDOW_CONTEXT__ = 'remote'"));

        let capability: serde_json::Value = serde_json::from_str(include_str!(
            "../capabilities/remote-window-notifications.json"
        ))
        .unwrap();
        assert_eq!(capability["local"], false);
        assert_eq!(
            capability["remote"]["urls"],
            json!(["http://*:*", "https://*:*"])
        );
        assert_eq!(capability["windows"], json!(["remote-*"]));
        assert_eq!(
            capability["permissions"],
            json!([
                "notification:allow-is-permission-granted",
                "notification:allow-request-permission",
                "notification:allow-notify"
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
        assert_eq!(local["windows"], json!(["local-*"]));
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
                .is_some_and(|value| value.starts_with("allow-cli"))));
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
            title: "Old title".into(),
            allow_linux_tls_certificate: false,
            generation: 4,
            window_generation: 2,
        };
        let mut values = std::collections::HashMap::from([(
            "remote-a".to_string(),
            RemoteWindowMetadata {
                origin: "https://new.example".into(),
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
    fn renderer_opener_permission_excludes_tel_and_unscoped_access() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        let opener = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|permission| permission["identifier"] == "opener:allow-open-url")
            .unwrap();

        assert_eq!(
            opener["allow"],
            json!([
                { "url": "http://*" },
                { "url": "https://*" },
                { "url": "mailto:*" }
            ])
        );
        assert!(!capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|permission| permission == "opener:allow-default-urls"
                || permission == "opener:allow-open-url"));
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
