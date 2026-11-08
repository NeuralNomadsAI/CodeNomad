//! Isolated real-engine harness: no backend, daemon or application commands.
//! Start fixture.py, then cargo run -p codenomad-webkit-capabilities-fixture.
#![allow(dead_code)]
#![cfg_attr(windows, windows_subsystem = "windows")]
#[path = "../../../src-tauri/src/embedded_view.rs"]
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
mod embedded_view;
#[path = "../../../src-tauri/src/menu_labels.rs"]
mod menu_labels;
struct AppState {
    menu_labels: menu_labels::MenuLabels,
}
#[cfg(windows)]
#[path = "../../../src-tauri/src/windows_browser_accelerators.rs"]
mod windows_browser_accelerators;

// The harness has one fixed local owner; production uses identity.rs.
mod identity {
    pub fn local_window_id(label: &str) -> Result<String, String> {
        (label == super::OWNER)
            .then(|| label.into())
            .ok_or_else(|| "Invalid fixture owner".into())
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
use tauri::Manager;
const OWNER: &str = "local-11111111-1111-4111-8111-111111111111";

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn main() {}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn main() {
    let root =
        std::env::var_os("CODENOMAD_PROFILE").expect("set an isolated CODENOMAD_PROFILE directory");
    let root = std::path::PathBuf::from(root);
    std::fs::create_dir_all(&root).unwrap();
    let log = root.join("stages.log");
    std::fs::write(&log, "main\n").unwrap();
    let panic_log = log.clone();
    std::panic::set_hook(Box::new(move |panic| {
        let _ = std::fs::write(&panic_log, panic.to_string());
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(embedded_view::StorageIdentity::new(
            root.to_string_lossy().into(),
            "capabilities-fixture".into(),
        ))
        .manage(embedded_view::EmbeddedViews::default())
        .on_menu_event(|app, event| {
            #[cfg(windows)]
            let _ = (app, event);
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if embedded_view::zoom::focused(app, event.id().0.as_str()) {
                return;
            }
            // Fixture-only primary fallback, so native menu routing can be qualified.
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if let Some(primary) = app.get_webview(OWNER) {
                if let Ok((current, device)) = embedded_view::mobile::scale(&primary) {
                    let next = match event.id().0.as_str() {
                        "zoom_in" => current / device + 0.2,
                        "zoom_out" => current / device - 0.2,
                        "reset_zoom" => 1.0,
                        _ => return,
                    };
                    let _ = primary.set_zoom(next.clamp(0.25, 5.0));
                }
            }
        })
        .setup(move |app| {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            {
                use tauri::menu::{Menu, MenuItem, Submenu};
                let zoom_in =
                    MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?;
                let zoom_out =
                    MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
                let zoom_reset =
                    MenuItem::with_id(app, "reset_zoom", "Reset Zoom", true, Some("CmdOrCtrl+0"))?;
                let view =
                    Submenu::with_items(app, "View", true, &[&zoom_in, &zoom_out, &zoom_reset])?;
                app.set_menu(Menu::with_items(app, &[&view])?)?;
            }
            std::fs::write(&log, "setup\n").unwrap();
            let window = tauri::WebviewWindowBuilder::new(
                app,
                OWNER,
                tauri::WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .title("WebKit capabilities fixture")
            .data_directory(root.join("renderer"))
            .on_page_load(|view, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    view.app_handle()
                        .state::<embedded_view::EmbeddedViews>()
                        .remove_owner(view.app_handle(), OWNER);
                }
            })
            .inner_size(900.0, 740.0)
            .build()?;
            std::fs::write(&log, "primary ready\n").unwrap();
            let views = app.state::<embedded_view::EmbeddedViews>();
            let guest = views.create(
                &window.as_ref().window(),
                "browser-fixture",
                root.join("browser"),
                embedded_view::Bounds {
                    x: 0,
                    y: 0,
                    width: 880,
                    height: 700,
                },
                |_, _| {},
                |_| true,
            )?;
            std::fs::write(&log, "guest ready\n").unwrap();
            #[cfg(windows)]
            {
                let events = root.join("events.log");
                guest.with_webview(move |platform| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    use webview2_com::{
                        NavigationStartingEventHandler, PermissionRequestedEventHandler,
                    };
                    let core = platform.controller().CoreWebView2().unwrap();
                    let permission_log = events.clone();
                    core.add_PermissionRequested(
                        &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                            if let Some(args) = args {
                                use std::io::Write;
                                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                                let mut state = COREWEBVIEW2_PERMISSION_STATE::default();
                                args.PermissionKind(&mut kind)?;
                                args.State(&mut state)?;
                                let _ = writeln!(
                                    std::fs::OpenOptions::new()
                                        .create(true)
                                        .append(true)
                                        .open(&permission_log)
                                        .unwrap(),
                                    "permission {} state {}",
                                    kind.0,
                                    state.0
                                );
                            }
                            Ok(())
                        })),
                        &mut 0,
                    )
                    .unwrap();
                    core.add_NavigationStarting(
                        &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                            if let Some(args) = args {
                                use std::io::Write;
                                let mut uri = windows_core::PWSTR::null();
                                args.Uri(&mut uri)?;
                                let mut cancelled = Default::default();
                                args.Cancel(&mut cancelled)?;
                                let uri = webview2_com::take_pwstr(uri);
                                let _ = writeln!(
                                    std::fs::OpenOptions::new()
                                        .create(true)
                                        .append(true)
                                        .open(&events)
                                        .unwrap(),
                                    "navigation {} cancelled={:?}",
                                    uri.chars().take(250).collect::<String>(),
                                    cancelled
                                );
                            }
                            Ok(())
                        })),
                        &mut 0,
                    )
                    .unwrap();
                })?;
            }
            guest.navigate(
                if std::env::var_os("CODENOMAD_FIXTURE_CONTROLS").is_some() {
                    "http://127.0.0.1:18741/controls"
                } else {
                    "http://127.0.0.1:18741/"
                }
                .parse()
                .unwrap(),
            )?;
            guest.show()?;
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if std::env::var_os("CODENOMAD_FIXTURE_ZOOM_EVIDENCE").is_some() {
                let primary: tauri::Webview = window.as_ref().clone();
                let preview = guest.clone();
                let output = root.join("native-zoom.log");
                std::thread::spawn(move || {
                    use std::io::Write;
                    let mut previous = None;
                    for _ in 0..3000 {
                        let Ok((app, device)) = embedded_view::mobile::scale(&primary) else {
                            break;
                        };
                        let Ok((guest, guest_device)) = embedded_view::mobile::scale(&preview)
                        else {
                            break;
                        };
                        let sample = (app / device, guest / guest_device);
                        if previous != Some(sample) {
                            writeln!(
                                std::fs::OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(&output)
                                    .unwrap(),
                                "app={:.6} guest={:.6}",
                                sample.0,
                                sample.1
                            )
                            .unwrap();
                            previous = Some(sample);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    }
                });
            }
            if let Ok(mode) = std::env::var("CODENOMAD_FIXTURE_LIFETIME") {
                assert!([
                    "opener-close",
                    "opener-reload",
                    "owner-destroy",
                    "renderer-reload"
                ]
                .contains(&mode.as_str()));
                // A hidden harness window keeps the event loop alive after owner destruction.
                let _sentinel = tauri::WebviewWindowBuilder::new(
                    app,
                    "fixture-sentinel",
                    tauri::WebviewUrl::External("about:blank".parse().unwrap()),
                )
                .visible(false)
                .build()?;
                let policy = views.inner().clone();
                let handle = app.handle().clone();
                let primary = window.clone();
                let target = guest.clone();
                let evidence = root.join(format!("lifetime-{mode}.txt"));
                std::thread::spawn(move || {
                    let trial = || -> Result<(), String> {
                        // The page and its child are activated with native fixture input.
                        let mut labels = Vec::new();
                        for _ in 0..1200 {
                            labels = handle
                                .windows()
                                .keys()
                                .filter(|label| label.starts_with("browser-popup-"))
                                .cloned()
                                .collect();
                            if labels.len() >= 2 {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        if labels.len() != 2 {
                            return Err(format!(
                                "expected two nested native popups, got {}",
                                labels.len()
                            ));
                        }
                        match mode.as_str() {
                            "opener-close" => policy.close(&handle, OWNER, "browser-fixture")?,
                            "opener-reload" => target.reload().map_err(|e| e.to_string())?,
                            "owner-destroy" => primary.destroy().map_err(|e| e.to_string())?,
                            "renderer-reload" => primary
                                .navigate(
                                    "http://127.0.0.1:18741/primary-replacement"
                                        .parse()
                                        .unwrap(),
                                )
                                .map_err(|e| e.to_string())?,
                            _ => unreachable!(),
                        }
                        let retained = mode == "opener-reload";
                        for _ in 0..200 {
                            if labels.iter().all(|label| {
                                handle.get_webview_window(label).is_none()
                                    && policy.navigation_allowed(
                                        label,
                                        &"https://example.com".parse().unwrap(),
                                    ) == Some(false)
                            }) && policy.navigation_allowed(
                                "browser-fixture",
                                &"https://example.com".parse().unwrap(),
                            ) == Some(retained)
                            {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        for label in &labels {
                            if handle.get_webview_window(label).is_some() {
                                return Err(format!("orphan native window {label}"));
                            }
                            if policy
                                .navigation_allowed(label, &"https://example.com".parse().unwrap())
                                != Some(false)
                            {
                                return Err(format!("orphan registry {label}"));
                            }
                        }
                        if policy.navigation_allowed(
                            "browser-fixture",
                            &"https://example.com".parse().unwrap(),
                        ) != Some(retained)
                        {
                            return Err("root registry mismatch".into());
                        }
                        Ok(())
                    };
                    let result = trial();
                    std::fs::write(evidence, format!("{mode}: {result:?}\n")).unwrap();
                    handle.exit(if result.is_ok() { 0 } else { 1 });
                });
            }
            if let Ok(seconds) = std::env::var("CODENOMAD_FIXTURE_CLOSE_AFTER")
                .unwrap_or_default()
                .parse::<u64>()
            {
                assert!((1..=60).contains(&seconds));
                let policy = views.inner().clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(seconds));
                    policy.close(&handle, OWNER, "browser-fixture").unwrap();
                    for _ in 0..100 {
                        if handle.get_webview("browser-fixture").is_none()
                            && handle
                                .windows()
                                .keys()
                                .all(|label| !label.starts_with("browser-popup-"))
                        {
                            eprintln!("opener and popup tree disposed");
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    panic!("opener or popup tree survived closure");
                });
            }
            let policy = views.inner().clone();
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    policy.remove_owner(&handle, OWNER);
                }
            });
            Ok(())
        })
        .run(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
}
