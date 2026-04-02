#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_manager;

use cli_manager::{CliProcessManager, CliStatus};
use keepawake::KeepAwake;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::Webview;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
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

static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);
const DEFAULT_ZOOM_LEVEL: f64 = 1.0;
const ZOOM_STEP: f64 = 0.2;
const MIN_ZOOM_LEVEL: f64 = 0.2;
const MAX_ZOOM_LEVEL: f64 = 5.0;

#[cfg(windows)]
const WINDOWS_APP_USER_MODEL_ID: &str = "ai.neuralnomads.codenomad.client";

pub struct AppState {
    pub manager: CliProcessManager,
    pub wake_lock: Mutex<Option<KeepAwake>>,
    pub zoom_level: Mutex<f64>,
    pub remote_origins: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteWindowPayload {
    id: String,
    name: String,
    base_url: String,
    skip_tls_verify: bool,
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
        display: true,
        idle: false,
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
        "tauri" | "asset" | "file" => true,
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

fn should_allow_window_origin<R: Runtime>(app_handle: &AppHandle<R>, window_label: &str, url: &Url) -> bool {
    if should_allow_internal(url) {
        return true;
    }

    let state = app_handle.state::<AppState>();
    let Ok(allowed) = state.remote_origins.lock() else {
        return false;
    };
    if let Some(origin) = allowed.get(window_label) {
        return origin == &url.origin().ascii_serialization();
    }

    false
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

#[tauri::command]
fn open_remote_window(app: AppHandle, payload: RemoteWindowPayload) -> Result<(), String> {
    if payload.skip_tls_verify && payload.base_url.starts_with("https://") {
        return Err(
            "Tauri cannot bypass self-signed HTTPS certificates automatically yet. Trust the certificate in your OS first, then reconnect."
                .to_string(),
        );
    }

    let parsed = Url::parse(&payload.base_url).map_err(|err| err.to_string())?;
    let label = format!("remote-{}", payload.id);
    let title = format!("{} - {}", payload.name, parsed.host_str().unwrap_or(payload.base_url.as_str()));

    app.state::<AppState>()
        .remote_origins
        .lock()
        .map_err(|err| err.to_string())?
        .insert(label.clone(), parsed.origin().ascii_serialization());

    let window = WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::External(parsed.clone()))
        .title(title)
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .build()
        .map_err(|err| err.to_string())?;

    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if let Ok(mut origins) = app_handle.state::<AppState>().remote_origins.lock() {
                origins.remove(&label);
            }
        }
    });

    Ok(())
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

fn clamp_zoom_level(value: f64) -> f64 {
    value.clamp(MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL)
}

fn set_main_window_zoom(app_handle: &AppHandle, next_zoom: f64) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let normalized = clamp_zoom_level(next_zoom);
        if window.set_zoom(normalized).is_ok() {
            if let Ok(mut zoom_level) = app_handle.state::<AppState>().zoom_level.lock() {
                *zoom_level = normalized;
            }
        }
    }
}

fn reload_main_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.reload();
    }
}

fn force_reload_main_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
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

                let _ = window.navigate(url);
                return;
            }
        }

        let _ = window.reload();
    }
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

fn main() {
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
            zoom_level: Mutex::new(DEFAULT_ZOOM_LEVEL),
            remote_origins: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            set_windows_app_user_model_id();
            build_menu(&app.handle())?;
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
            open_remote_window
        ])
        .on_menu_event(|app_handle, event| {
            match event.id().0.as_str() {
                // File menu
                "new_instance" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("menu:newInstance", ());
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
                    set_main_window_zoom(app_handle, DEFAULT_ZOOM_LEVEL);
                }
                "zoom_in" => {
                    if let Ok(zoom_level) = app_handle.state::<AppState>().zoom_level.lock() {
                        set_main_window_zoom(app_handle, *zoom_level + ZOOM_STEP);
                    }
                }
                "zoom_out" => {
                    if let Ok(zoom_level) = app_handle.state::<AppState>().zoom_level.lock() {
                        set_main_window_zoom(app_handle, *zoom_level - ZOOM_STEP);
                    }
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

                // App menu (macOS)
                "about" => {
                    // TODO: Implement about dialog
                    println!("About menu item clicked");
                }
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
                // `app_handle.exit(0)` triggers another `ExitRequested`. Without a guard, we can
                // prevent exit forever and the app never quits (Cmd+Q / Quit menu appears stuck).
                if QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.manager.stop();
                    }
                    app.exit(0);
                });
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
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                // Ensure we have time to stop the CLI process before the app exits.
                if QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.manager.stop();
                    }
                    app.exit(0);
                });
            }
            _ => {}
        });
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let is_mac = cfg!(target_os = "macos");
    let is_linux = cfg!(target_os = "linux");

    // Create submenus
    let mut submenus = Vec::new();

    // App menu (macOS only)
    if is_mac {
        let app_menu = SubmenuBuilder::new(app, "CodeNomad")
            .text("about", "About CodeNomad")
            .separator()
            .text("hide", "Hide CodeNomad")
            .text("hide_others", "Hide Others")
            .text("show_all", "Show All")
            .separator()
            .text("quit", "Quit CodeNomad")
            .build()?;
        submenus.push(app_menu);
    }

    // File menu - create New Instance with accelerator
    let new_instance_item = MenuItem::with_id(
        app,
        "new_instance",
        "New Instance",
        true,
        Some("CmdOrCtrl+N"),
    )?;

    let file_menu = if is_mac {
        SubmenuBuilder::new(app, "File")
            .item(&new_instance_item)
            .separator()
            .close_window()
            .build()?
    } else {
        SubmenuBuilder::new(app, "File")
            .item(&new_instance_item)
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

    // Build the main menu with all submenus
    let submenu_refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = submenus
        .iter()
        .map(|s| s as &dyn tauri::menu::IsMenuItem<_>)
        .collect();
    let menu = MenuBuilder::new(app).items(&submenu_refs).build()?;

    app.set_menu(menu)?;
    Ok(())
}
