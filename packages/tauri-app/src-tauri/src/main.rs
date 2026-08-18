#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[allow(dead_code)]
mod cert_manager;
mod cli_manager;
mod client_state;
#[cfg(target_os = "linux")]
mod linux_tls;
mod managed_node;
mod shutdown;
mod windows_update;
mod workspace_open;

use cli_manager::{CliProcessManager, CliStatus};
use keepawake::KeepAwake;
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
#[cfg(any(windows, test))]
use std::future::Future;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
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
const RELEASES_URL: &str = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest";
const LOCAL_WINDOW_CONTEXT_SCRIPT: &str = "window.__CODENOMAD_WINDOW_CONTEXT__ = 'local';";
const REMOTE_WINDOW_CONTEXT_SCRIPT: &str =
    "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'remote';";

#[cfg(windows)]
const WINDOWS_APP_USER_MODEL_ID: &str = "ai.neuralnomads.codenomad.client";

pub struct AppState {
    pub manager: CliProcessManager,
    pub wake_lock: Mutex<Option<KeepAwake>>,
    pub remote_origins: Mutex<HashMap<String, String>>,
    pub remote_proxy_sessions: Mutex<HashMap<String, String>>,
    pub remote_skip_tls_verify: Mutex<HashMap<String, bool>>,
    pub remote_tls_handlers: Mutex<HashSet<String>>,
    pub remote_titles: Mutex<HashMap<String, String>>,
    pub workspace_menu_items: Mutex<Option<WorkspaceMenuItems>>,
    pub workspace_menu_requested_enabled: Mutex<bool>,
}

pub struct WorkspaceMenuItems {
    folder: MenuItem<Wry>,
    terminal: MenuItem<Wry>,
    editor: Submenu<Wry>,
}

fn update_workspace_menu_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let requested = state
        .workspace_menu_requested_enabled
        .lock()
        .map(|value| *value)
        .unwrap_or(false);
    let focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if let Ok(items) = state.workspace_menu_items.lock() {
        if let Some(items) = items.as_ref() {
            let enabled = requested && focused;
            let _ = items.folder.set_enabled(enabled);
            let _ = items.terminal.set_enabled(enabled);
            let _ = items.editor.set_enabled(enabled);
        }
    };
}

#[tauri::command]
fn set_workspace_menu_enabled(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Workspace menu updates are limited to the local main window".into());
    }
    if !enabled {
        *state
            .workspace_menu_requested_enabled
            .lock()
            .map_err(|error| error.to_string())? = false;
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
    *state
        .workspace_menu_requested_enabled
        .lock()
        .map_err(|error| error.to_string())? = enabled;
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

fn schedule_remote_proxy_session_cleanup(app: AppHandle, session_id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = cleanup_remote_proxy_session(&app, &session_id).await {
            eprintln!(
                "[tauri] failed to clean up remote proxy session {}: {}",
                session_id, err
            );
        }
    });
}

async fn cleanup_remote_proxy_session(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let status = app.state::<AppState>().manager.status();
    let Some(base_url) = status.url else {
        return Ok(());
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
            .build()
            .map_err(|err| err.to_string())?
    } else {
        reqwest::Client::new()
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
fn cli_get_status(state: tauri::State<AppState>) -> CliStatus {
    state.manager.status()
}

#[tauri::command]
fn cli_restart(app: AppHandle, state: tauri::State<AppState>) -> Result<CliStatus, String> {
    let dev_mode = is_dev_mode();
    state.manager.stop().map_err(|e| e.to_string())?;
    state
        .manager
        .start(app, dev_mode)
        .map_err(|e| e.to_string())?;
    Ok(state.manager.status())
}

#[tauri::command]
fn wake_lock_start(
    state: tauri::State<AppState>,
    config: Option<WakeLockConfig>,
) -> Result<(), String> {
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

    let wake_lock = builder.create().map_err(|err| err.to_string())?;
    let mut state_lock = state.wake_lock.lock().map_err(|err| err.to_string())?;
    *state_lock = Some(wake_lock);
    Ok(())
}

#[tauri::command]
fn wake_lock_stop(state: tauri::State<AppState>) -> Result<(), String> {
    let mut state_lock = state.wake_lock.lock().map_err(|err| err.to_string())?;
    state_lock.take();
    Ok(())
}

fn is_dev_mode() -> bool {
    cfg!(debug_assertions) || std::env::var("TAURI_DEV").is_ok()
}

fn should_allow_internal(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "file" | "about" => true,
        // On Windows/WebView2, Tauri serves the app assets from `tauri.localhost`.
        // This must be treated as an internal origin or the navigation guard will
        // redirect it to the system browser and the app will appear blank.
        "http" | "https" => matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "tauri.localhost")
        ),
        _ => false,
    }
}

fn should_allow_window_origin<R: Runtime>(
    app_handle: &AppHandle<R>,
    window_label: &str,
    url: &Url,
) -> bool {
    let state = app_handle.state::<AppState>();
    let Ok(allowed) = state.remote_origins.lock() else {
        return false;
    };
    should_allow_registered_origin(allowed.get(window_label).map(String::as_str), url)
}

fn should_allow_registered_origin(registered_origin: Option<&str>, url: &Url) -> bool {
    if let Some(origin) = registered_origin {
        if matches!(url.scheme(), "http" | "https") {
            return origin == url.origin().ascii_serialization();
        }
    }
    should_allow_internal(url)
}

fn intercept_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    let window_label = webview.label().to_string();
    if should_allow_window_origin(&webview.app_handle(), &window_label, url) {
        return true;
    }

    if let Err(err) = webview
        .app_handle()
        .opener()
        .open_url(url.as_str(), None::<&str>)
    {
        eprintln!("[tauri] failed to open external link {}: {}", url, err);
    }
    false
}

fn apply_remote_window_title(app_handle: &AppHandle, window_label: &str) {
    let Some(title) = app_handle
        .state::<AppState>()
        .remote_titles
        .lock()
        .ok()
        .and_then(|titles| titles.get(window_label).cloned())
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
    let entry_url = payload
        .entry_url
        .as_deref()
        .unwrap_or(payload.base_url.as_str());
    let parsed = Url::parse(entry_url).map_err(|err| err.to_string())?;
    let label = format!("remote-{}", payload.id);
    let title = format!("{} - {}", payload.name, payload.base_url);

    let window_url = parsed.clone();

    let allow_linux_tls_certificate = parsed.scheme() == "https"
        && (payload.proxy_session_id.is_some() || payload.skip_tls_verify);

    app.state::<AppState>()
        .remote_origins
        .lock()
        .map_err(|err| err.to_string())?
        .insert(label.clone(), window_url.origin().ascii_serialization());
    app.state::<AppState>()
        .remote_skip_tls_verify
        .lock()
        .map_err(|err| err.to_string())?
        .insert(label.clone(), allow_linux_tls_certificate);
    app.state::<AppState>()
        .remote_titles
        .lock()
        .map_err(|err| err.to_string())?
        .insert(label.clone(), title.clone());

    let replaced_session = {
        let state = app.state::<AppState>();
        let mut sessions = state
            .remote_proxy_sessions
            .lock()
            .map_err(|err| err.to_string())?;
        match payload.proxy_session_id.clone() {
            Some(session_id) => sessions.insert(label.clone(), session_id),
            None => sessions.remove(&label),
        }
    };

    if let Some(previous) = replaced_session {
        if payload.proxy_session_id.as_deref() != Some(previous.as_str()) {
            schedule_remote_proxy_session_cleanup(app.clone(), previous);
        }
    }

    if let Some(existing) = app.get_webview_window(&label) {
        #[cfg(target_os = "linux")]
        linux_tls::ensure_remote_window_tls_handler(&existing, &app, &label)?;

        let _ = existing.set_title(&title);
        let _ = existing.navigate(window_url.clone());
        apply_remote_window_title(&app, &label);
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    let initial_url =
        if linux_tls::should_bootstrap_tls_navigation(&window_url, allow_linux_tls_certificate) {
            Url::parse("about:blank").map_err(|err| err.to_string())?
        } else {
            window_url.clone()
        };

    #[cfg(not(target_os = "linux"))]
    let initial_url = window_url.clone();

    let window = WebviewWindowBuilder::new(
        &app,
        label.clone(),
        WebviewUrl::External(initial_url.clone()),
    )
    .initialization_script(REMOTE_WINDOW_CONTEXT_SCRIPT)
    .title(title)
    .inner_size(1400.0, 900.0)
    .min_inner_size(800.0, 600.0)
    .build()
    .map_err(|err| err.to_string())?;

    #[cfg(windows)]
    shutdown::schedule_windows_session_end_handler(&window)?;

    #[cfg(target_os = "linux")]
    {
        linux_tls::ensure_remote_window_tls_handler(&window, &app, &label)?;
        if initial_url != window_url {
            let _ = window.navigate(window_url.clone());
        }
    }

    let app_handle = app.clone();
    let label_for_cleanup = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(_)) {
            update_workspace_menu_state(&app_handle);
        }
        if let WindowEvent::Destroyed = event {
            if let Ok(mut origins) = app_handle.state::<AppState>().remote_origins.lock() {
                origins.remove(&label_for_cleanup);
            }
            if let Ok(mut sessions) = app_handle.state::<AppState>().remote_proxy_sessions.lock() {
                if let Some(session_id) = sessions.remove(&label_for_cleanup) {
                    schedule_remote_proxy_session_cleanup(app_handle.clone(), session_id);
                }
            }
            if let Ok(mut values) = app_handle.state::<AppState>().remote_skip_tls_verify.lock() {
                values.remove(&label_for_cleanup);
            }
            if let Ok(mut handlers) = app_handle.state::<AppState>().remote_tls_handlers.lock() {
                handlers.remove(&label_for_cleanup);
            }
            if let Ok(mut titles) = app_handle.state::<AppState>().remote_titles.lock() {
                titles.remove(&label_for_cleanup);
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn needs_local_certificate_install() -> Result<bool, String> {
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
async fn open_remote_window(app: AppHandle, payload: RemoteWindowPayload) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let entry_url = payload
            .entry_url
            .as_deref()
            .unwrap_or(payload.base_url.as_str());
        let parsed = Url::parse(entry_url).map_err(|err| err.to_string())?;
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

fn reload_main_window(app_handle: &AppHandle) {
    client_state::before_main_window_navigation(
        app_handle,
        client_state::NavigationKind::Reload,
        None,
        |app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window not found for reload".to_string())?;
            window
                .reload()
                .map_err(|err| format!("failed to reload main window: {err}"))
        },
    );
}

fn force_reload_main_window(app_handle: &AppHandle) {
    client_state::before_main_window_navigation(
        app_handle,
        client_state::NavigationKind::ForceReload,
        None,
        |app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window not found for force reload".to_string())?;
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
    if let Some(window) = app_handle.get_webview_window("main") {
        let next_fullscreen = !window.is_fullscreen().unwrap_or(false);
        let _ = window.set_fullscreen(next_fullscreen);
        if cfg!(not(target_os = "macos")) {
            if next_fullscreen {
                let _ = window.hide_menu();
            } else {
                let _ = window.show_menu();
            }
        }
    }
}

fn fullscreen_shortcut() -> Option<Shortcut> {
    if cfg!(target_os = "macos") {
        None
    } else {
        Some(Shortcut::new(None, ShortcutCode::F11))
    }
}

#[cfg(windows)]
fn set_windows_app_user_model_id() {
    let app_id: Vec<u16> = OsStr::new(WINDOWS_APP_USER_MODEL_ID)
        .encode_wide()
        .chain(iter::once(0))
        .collect();

    let result = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
    if result < 0 {
        eprintln!("[tauri] failed to set AppUserModelID: {result}");
    }
}

#[cfg(not(windows))]
fn set_windows_app_user_model_id() {}

#[cfg(windows)]
fn isolate_windows_webview_profile() {
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return;
    }
    if let Some(root) = dirs::data_local_dir() {
        std::env::set_var(
            "WEBVIEW2_USER_DATA_FOLDER",
            root.join("ai.neuralnomads.codenomad.client-v2"),
        );
    }
}

fn main() {
    #[cfg(windows)]
    if let Some(code) = cli_manager::run_windows_cli_launcher_if_requested() {
        std::process::exit(code);
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    #[cfg(windows)]
    isolate_windows_webview_profile();

    let navigation_guard: TauriPlugin<Wry, ()> = PluginBuilder::new("external-link-guard")
        .on_navigation(|webview, url| intercept_navigation(webview, url))
        .build();

    tauri::Builder::default()
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
        .manage(AppState {
            manager: CliProcessManager::new(),
            wake_lock: Mutex::new(None),
            remote_origins: Mutex::new(HashMap::new()),
            remote_proxy_sessions: Mutex::new(HashMap::new()),
            remote_skip_tls_verify: Mutex::new(HashMap::new()),
            remote_tls_handlers: Mutex::new(HashSet::new()),
            remote_titles: Mutex::new(HashMap::new()),
            workspace_menu_items: Mutex::new(None),
            workspace_menu_requested_enabled: Mutex::new(false),
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
                if let Ok(mut enabled) = webview
                    .app_handle()
                    .state::<AppState>()
                    .workspace_menu_requested_enabled
                    .lock()
                {
                    *enabled = false;
                }
                update_workspace_menu_state(&webview.app_handle());
            }
            if matches!(
                payload.event(),
                PageLoadEvent::Started | PageLoadEvent::Finished
            ) {
                apply_remote_window_title(&webview.app_handle(), webview.label());
            }
        })
        .setup(|app| {
            set_windows_app_user_model_id();
            let client_state = client_state::ClientState::initialize(&app.handle());
            app.manage(client_state);
            app.manage(shutdown::ShutdownCoordinator::default());
            build_menu(&app.handle())?;
            client_state::setup_main_window(&app.handle())
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(windows)]
                shutdown::schedule_windows_session_end_handler(&window)
                    .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
                let _ = window.eval(LOCAL_WINDOW_CONTEXT_SCRIPT);
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Focused(_)) {
                        update_workspace_menu_state(&app_handle);
                    }
                });
            }
            if let Some(shortcut) = fullscreen_shortcut() {
                let shortcut_manager = app.handle().global_shortcut();
                let _ = shortcut_manager.register(shortcut.clone());

                if let Some(window) = app.get_webview_window("main") {
                    let app_handle = app.handle().clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::Focused(focused) = event {
                            let shortcut_manager = app_handle.global_shortcut();
                            if *focused {
                                let _ = shortcut_manager.register(shortcut.clone());
                            } else {
                                let _ = shortcut_manager.unregister(shortcut.clone());
                            }
                        }
                    });
                }
            }

            let dev_mode = is_dev_mode();
            let app_handle = app.handle().clone();
            let manager = app.state::<AppState>().manager.clone();
            std::thread::spawn(move || {
                if let Err(err) = manager.start(app_handle.clone(), dev_mode) {
                    let _ = app_handle.emit("cli:error", json!({"message": err.to_string()}));
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
            open_remote_window,
            client_state::client_state_claim_access,
            client_state::client_state_load,
            client_state::client_state_save,
            client_state::client_state_set_restore_enabled,
            client_state::client_state_clear,
            client_state::client_state_renderer_flushed,
            client_state::client_state_navigation_flushed,
            windows_update::install_stable_update,
            workspace_open::open_workspace_target,
            set_workspace_menu_enabled
        ])
        .on_menu_event(|app_handle, event| {
            match event.id().0.as_str() {
                // File menu
                action @ ("new-instance"
                | "open-workspace-folder"
                | "open-workspace-terminal"
                | "open-workspace-editor-vscode"
                | "open-workspace-editor-cursor"
                | "open-workspace-editor-zed"
                | "open-workspace-editor-vscodium") => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if action.starts_with("open-workspace-")
                            && !window.is_focused().unwrap_or(false)
                        {
                            return;
                        }
                        let _ = window.emit("menu:action", action);
                    }
                }
                "quit" => {
                    app_handle.exit(0);
                }

                // View menu
                "reload" => {
                    reload_main_window(app_handle);
                }
                "force_reload" => {
                    force_reload_main_window(app_handle);
                }
                "toggle_devtools" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if window.is_devtools_open() {
                            window.close_devtools();
                        } else {
                            window.open_devtools();
                        }
                    }
                }
                "reset_zoom" => {
                    client_state::set_main_window_zoom(
                        app_handle,
                        client_state::DEFAULT_ZOOM_LEVEL,
                    );
                }
                "zoom_in" => {
                    let zoom_level = client_state::main_window_zoom(app_handle);
                    client_state::set_main_window_zoom(app_handle, zoom_level + ZOOM_STEP);
                }
                "zoom_out" => {
                    let zoom_level = client_state::main_window_zoom(app_handle);
                    client_state::set_main_window_zoom(app_handle, zoom_level - ZOOM_STEP);
                }

                "toggle_fullscreen" => {
                    toggle_fullscreen_window(app_handle);
                }

                // Window menu
                "minimize" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.minimize();
                    }
                }
                "zoom" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.maximize();
                    }
                }
                "close_window" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.close();
                    }
                }

                "get_updates" => {
                    #[cfg(windows)]
                    {
                        let app_handle = app_handle.clone();
                        tauri::async_runtime::spawn(run_update_with_fallback(
                            windows_update::install_stable_update(),
                            move || open_releases_page(&app_handle),
                        ));
                    }

                    #[cfg(not(windows))]
                    open_releases_page(app_handle);
                }
                // App menu (macOS)
                "hide" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
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
        .build(tauri::generate_context!())
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
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if label == "main" {
                    if shutdown::main_window_close_allowed(&app_handle) {
                        return;
                    }
                    let final_window = app_handle.webview_windows().len() == 1;
                    if shutdown::exit_allowed(&app_handle) {
                        return;
                    }
                    api.prevent_close();
                    if final_window {
                        shutdown::request(app_handle.clone());
                    } else {
                        shutdown::request_main_window_close(app_handle.clone());
                    }
                    return;
                }
                // Let windows close normally. App shutdown is handled only after the
                // last window is actually gone so remote windows can outlive `main`.
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                if label == "main" {
                    shutdown::main_window_destroyed(app_handle.clone());
                }
                if !app_handle.webview_windows().is_empty() {
                    return;
                }

                // Stop the CLI only when the final window is gone and the app is
                // truly exiting.
                shutdown::request(app_handle.clone());
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

    // File menu - create New Instance with accelerator
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
        SubmenuBuilder::new(app, "File")
            .item(&new_instance_item)
            .separator()
            .item(&open_folder_item)
            .item(&open_terminal_item)
            .item(&open_editor_menu)
            .separator()
            .close_window()
            .build()?
    } else {
        SubmenuBuilder::new(app, "File")
            .item(&new_instance_item)
            .separator()
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

    // Edit menu with predefined items for standard functionality
    let edit_menu = SubmenuBuilder::new(app, "Edit")
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
    let view_menu = SubmenuBuilder::new(app, "View")
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
        SubmenuBuilder::new(app, "Window")
            .text("minimize", "Minimize")
            .text("zoom", "Zoom")
            .separator()
            .item(&close_window_item)
            .build()?
    } else if is_mac {
        SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .build()?
    } else {
        SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .close_window()
            .build()?
    };
    submenus.push(window_menu);

    if !is_mac {
        let help_menu = SubmenuBuilder::new(app, "Help")
            .item(&get_updates_item)
            .separator()
            .item(&about_item)
            .build()?;
        submenus.push(help_menu);
    }

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
        build_about_metadata, run_update_with_fallback, should_allow_registered_origin,
        RELEASES_URL, REMOTE_WINDOW_CONTEXT_SCRIPT,
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use url::Url;

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
}
