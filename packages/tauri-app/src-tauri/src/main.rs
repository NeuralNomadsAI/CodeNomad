#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_manager;

use cli_manager::{CliProcessManager, CliStatus};
use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::Webview;
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[derive(Clone)]
pub struct AppState {
    pub manager: CliProcessManager,
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

fn is_dev_mode() -> bool {
    cfg!(debug_assertions) || std::env::var("TAURI_DEV").is_ok()
}

fn should_allow_internal(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "file" => true,
        "http" | "https" => matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
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

fn main() {
    let navigation_guard: TauriPlugin<Wry, ()> = PluginBuilder::new("external-link-guard")
        .on_navigation(|webview, url| intercept_navigation(webview, url))
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_guard)
        .manage(AppState {
            manager: CliProcessManager::new(),
        })
        .setup(|app| {
            build_menu(&app.handle())?;
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
        .invoke_handler(tauri::generate_handler![cli_get_status, cli_restart])
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
            tauri::RunEvent::ExitRequested { .. } => {
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.manager.stop();
                    }
                    app.exit(0);
                });
            }
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                if app_handle.webview_windows().len() <= 1 {
                    let app = app_handle.clone();
                    std::thread::spawn(move || {
                        if let Some(state) = app.try_state::<AppState>() {
                            let _ = state.manager.stop();
                        }
                        app.exit(0);
                    });
                }
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
        Some("CmdOrCtrl+N")
    )?;
    
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_instance_item)
        .separator()
        .text(if is_mac { "close" } else { "quit" }, if is_mac { "Close" } else { "Quit" })
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
    let submenu_refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = submenus.iter().map(|s| s as &dyn tauri::menu::IsMenuItem<_>).collect();
    let menu = MenuBuilder::new(app).items(&submenu_refs).build()?;
    
    app.set_menu(menu)?;
    Ok(())
}
