#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_manager;

use cli_manager::{CliProcessManager, CliStatus};
use keepawake::KeepAwake;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::Webview;
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
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

#[cfg(windows)]
const WINDOWS_APP_USER_MODEL_ID: &str = "ai.neuralnomads.codenomad.client";

pub struct AppState {
    pub manager: CliProcessManager,
    pub wake_lock: Mutex<Option<KeepAwake>>,
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

fn intercept_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    if should_allow_internal(url) {
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
        .plugin(tauri_plugin_notification::init())
        .plugin(navigation_guard)
        .manage(AppState {
            manager: CliProcessManager::new(),
            wake_lock: Mutex::new(None),
        })
        .setup(|app| {
            set_windows_app_user_model_id();
            build_menu(&app.handle())?;
            let _ = app
                .handle()
                .emit("perf:startup", json!({"stage": "tauri.setup.complete"}));
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
            wake_lock_stop
        ])
        .on_menu_event(|app_handle, event| {
            match event.id().0.as_str() {
                // File menu
                "new_instance" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("menu:newInstance", ());
                    }
                }
                "close" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.close();
                    }
                }
                "quit" => {
                    app_handle.exit(0);
                }

                // View menu
                "reload" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval("window.location.reload()");
                    }
                }
                "force_reload" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval("window.location.reload(true)");
                    }
                }
                "toggle_devtools" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        window.open_devtools();
                    }
                }

                "toggle_fullscreen" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
                    }
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

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_instance_item)
        .separator()
        .text(
            if is_mac { "close" } else { "quit" },
            if is_mac { "Close" } else { "Quit" },
        )
        .build()?;
    submenus.push(file_menu);

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
        .text("reload", "Reload")
        .text("force_reload", "Force Reload")
        .text("toggle_devtools", "Toggle Developer Tools")
        .separator()
        .separator()
        .text("toggle_fullscreen", "Toggle Full Screen")
        .build()?;
    submenus.push(view_menu);

    // Window menu
    let window_menu = SubmenuBuilder::new(app, "Window")
        .text("minimize", "Minimize")
        .text("zoom", "Zoom")
        .build()?;
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
