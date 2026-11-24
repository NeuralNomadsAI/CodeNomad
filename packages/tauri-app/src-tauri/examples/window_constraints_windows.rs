//! Isolated, real Tauri/Wry/WebView2 Windows regression. No backend, singleton,
//! application profile, network navigation, or shared OpenCode service is used.
//! Run: cargo run --example window_constraints_windows
//! Add -- --baseline to demonstrate the original state-changing native setter.

use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(windows)]
static POSITION_CHANGES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(windows)]
unsafe extern "system" fn position_probe(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    _data: usize,
) -> isize {
    if message == windows_sys::Win32::UI::WindowsAndMessaging::WM_WINDOWPOSCHANGED {
        POSITION_CHANGES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    windows_sys::Win32::UI::Shell::DefSubclassProc(hwnd, message, wparam, lparam)
}

#[cfg(windows)]
fn control_wheel(window: &tauri::Window) {
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::*,
    };
    unsafe extern "system" fn find_renderer(hwnd: HWND, data: LPARAM) -> i32 {
        let mut name = [0u16; 128];
        let length = GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32);
        if String::from_utf16_lossy(&name[..length as usize]) == "Chrome_RenderWidgetHostHWND"
            && IsWindowVisible(hwnd) != 0
        {
            *(data as *mut usize) = hwnd as usize;
            return 0;
        }
        1
    }
    let hwnd = window.hwnd().unwrap().0 as usize;
    window
        .run_on_main_thread(move || unsafe {
            let mut renderer = 0usize;
            EnumChildWindows(
                hwnd as HWND,
                Some(find_renderer),
                &mut renderer as *mut usize as isize,
            );
            assert_ne!(renderer, 0, "native Chromium input target missing");
            let mut rect = std::mem::zeroed();
            assert_ne!(GetWindowRect(renderer as HWND, &mut rect), 0);
            let point = (((rect.top + 50) as u32) << 16) | ((rect.left + 50) as u32 & 0xffff);
            // Target only this isolated renderer HWND. No SendInput, global key
            // state or user-window input is modified.
            SendMessageW(
                renderer as HWND,
                WM_MOUSEWHEEL,
                (120 << 16) | 0x0008,
                point as isize,
            );
        })
        .unwrap();
}

mod client_state {
    pub const MIN_WINDOW_WIDTH: i32 = 390;
}
mod preferences_window {
    pub const LABEL: &str = "preferences";
}
struct AppState {
    remote_zoom_levels: Mutex<HashMap<String, f64>>,
}
mod window_constraints {
    include!("../src/window_constraints.rs");

    pub fn snapshot(window: &tauri::Window) -> Option<(f64, f64, f64)> {
        use tauri::Manager;
        let registry = window.state::<WindowConstraints>();
        let entry = registry.0.lock().unwrap().get(window.label()).cloned()?;
        let updates = entry.updates.lock().unwrap();
        let minimum = updates.applied?;
        Some((updates.zoom, minimum.width, minimum.height))
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This fixture requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::{LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT};

    fn wait(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "constraint/state transition timed out"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn normal_rect(window: &tauri::Window) -> (i32, i32, i32, i32) {
        let hwnd = window.hwnd().unwrap().0;
        let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
        placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        assert_ne!(unsafe { GetWindowPlacement(hwnd, &mut placement) }, 0);
        let rect = placement.rcNormalPosition;
        (rect.left, rect.top, rect.right, rect.bottom)
    }
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(60));
        eprintln!("FAIL: isolated constraint fixture watchdog expired");
        std::process::exit(3);
    });
    let profile = tempfile::Builder::new()
        .prefix("tauri-window-constraints-")
        .tempdir_in(std::env::temp_dir().join("opencode"))
        .unwrap();
    let baseline = std::env::args().any(|arg| arg == "--baseline");
    tauri::Builder::default()
        .manage(window_constraints::WindowConstraints::default())
        .manage(AppState {
            remote_zoom_levels: Mutex::new(HashMap::new()),
        })
        .setup(move |app| {
            let app = app.handle().clone();
            // Local uses the same registered constraints but a separate zoom
            // persistence callback; remote exercises the actual COM zoom handler.
            let local = WebviewWindowBuilder::new(
                &app,
                "local-fixture",
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .data_directory(profile.path().join("local"))
            .title("CodeNomad isolated constraint regression")
            .inner_size(900.0, 700.0)
            .min_inner_size(390.0, 600.0)
            .decorations(false)
            .build()?;
            let remote = WebviewWindowBuilder::new(
                &app,
                "remote-fixture",
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .data_directory(profile.path().join("remote"))
                .title("CodeNomad isolated remote constraint regression")
                .zoom_hotkeys_enabled(true)
            .inner_size(900.0, 700.0)
            .min_inner_size(390.0, 600.0)
            .build()?;
            window_constraints::register(&local.as_ref().window(), 1.0);
            window_constraints::register(&remote.as_ref().window(), 1.0);
            window_constraints::register_remote_zoom(&remote, &app);
            remote.with_webview(|platform| {
                let html = webview2_com::CoTaskMemPWSTR::from("<!doctype html><title>Isolated zoom fixture</title><body>Native zoom regression</body>");
                unsafe { platform.controller().CoreWebView2().unwrap()
                    .NavigateToString(*html.as_ref().as_pcwstr()).unwrap() };
            })?;
            for window in [&local, &remote] {
                assert_ne!(unsafe { windows_sys::Win32::UI::Shell::SetWindowSubclass(
                    window.hwnd().unwrap().0, Some(position_probe), 0x434e, 0,
                ) }, 0);
            }
            let startup = WebviewWindowBuilder::new(&app, "startup-fixture", WebviewUrl::External("about:blank".parse().unwrap()))
                .data_directory(profile.path().join("startup"))
                .title("CodeNomad isolated maximized restore regression")
                .inner_size(900.0, 700.0).maximized(true).build()?;
            window_constraints::register(&startup.as_ref().window(), 5.0);
            thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    for webview in [&local, &remote] {
                        let window = webview.as_ref().window();
                        wait(|| window_constraints::snapshot(&window).is_some());
                        let normal = normal_rect(&window);
                        window.maximize().unwrap();
                        wait(|| window.is_maximized().unwrap());
                        if baseline {
                            window
                                .set_min_size(Some(LogicalSize::new(488.0, 750.0)))
                                .unwrap();
                            wait(|| !window.is_maximized().unwrap());
                            println!(
                                "BASELINE reproduced: set_min_size unmaximized {}",
                                window.label()
                            );
                            break;
                        }
                        // Native callback and successive queued writes must all
                        // leave maximize/fullscreen and normal placement intact.
                        for zoom in [1.25, 3.0, 0.5, 2.0] {
                            webview.set_zoom(zoom).unwrap();
                            // WebView2 explicitly does not fire its change event
                            // for an in-range programmatic setter. This mirrors
                            // the production menu/keyboard command path.
                            window_constraints::apply(&window, zoom);
                        }
                        thread::sleep(Duration::from_millis(800));
                        if window.label() == "remote-fixture" {
                            // WebView2 suppresses user zoom input while another
                            // native window (the startup fixture) owns focus.
                            window.set_focus().unwrap();
                            webview.with_webview(|platform| unsafe {
                                platform.controller().MoveFocus(
                                    webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
                                ).unwrap();
                            }).unwrap();
                            let deadline = Instant::now() + Duration::from_secs(5);
                            loop {
                                control_wheel(&window);
                                thread::sleep(Duration::from_millis(250));
                                if app.state::<AppState>().remote_zoom_levels.lock().unwrap()
                                    .get("remote-fixture").is_some_and(|zoom| *zoom > 2.0)
                                {
                                    break;
                                }
                                assert!(Instant::now() < deadline, "native Ctrl-wheel zoom callback timed out");
                            }
                            assert!(window.is_maximized().unwrap());
                            println!("PASS: remote native COM zoom callback while maximized");
                            webview.set_zoom(2.0).unwrap();
                            window_constraints::apply(&window, 2.0);
                        }
                        assert!(
                            window.is_maximized().unwrap(),
                            "zoom unmaximized {}",
                            window.label()
                        );
                        assert_eq!(
                            normal_rect(&window),
                            normal,
                            "zoom changed normal placement"
                        );
                        window.unmaximize().unwrap();
                        wait(|| !window.is_maximized().unwrap());
                        wait(|| {
                            window_constraints::snapshot(&window)
                                .is_some_and(|state| state.0 == 2.0)
                        });
                        let state = window_constraints::snapshot(&window).unwrap();
                        let scale = window.scale_factor().unwrap();
                        let size = window.inner_size().unwrap().to_logical::<f64>(scale);
                        assert!(size.width + 1.0 >= state.1 && size.height + 1.0 >= state.2);

                        window.set_fullscreen(true).unwrap();
                        wait(|| window.is_fullscreen().unwrap());
                        webview.set_zoom(0.5).unwrap();
                        window_constraints::apply(&window, 0.5);
                        thread::sleep(Duration::from_millis(800));
                        assert!(window.is_fullscreen().unwrap(), "zoom exited fullscreen");
                        window.set_fullscreen(false).unwrap();
                        wait(|| !window.is_fullscreen().unwrap());
                        wait(|| window_constraints::snapshot(&window) == Some((0.5, 195.0, 300.0)));
                        window.set_size(LogicalSize::new(250.0, 350.0)).unwrap();
                        wait(|| {
                            window
                                .inner_size()
                                .unwrap()
                                .to_logical::<f64>(window.scale_factor().unwrap())
                                .width
                                < 390.0
                        });
                        println!(
                            "PASS: {} maximize/fullscreen/latest-zoom/normal restore",
                            window.label()
                        );

                        // The environment refresh must work without a zoom event.
                        window_constraints::apply(&window, 5.0);
                        for monitor in window.available_monitors().unwrap() {
                            let work = monitor.work_area();
                            window
                                .set_position(PhysicalPosition::new(
                                    work.position.x + 20,
                                    work.position.y + 20,
                                ))
                                .unwrap();
                            thread::sleep(Duration::from_millis(800));
                            let state = window_constraints::snapshot(&window).unwrap();
                            let scale = window.scale_factor().unwrap();
                            let size = window.inner_size().unwrap();
                            let outer = window.outer_size().unwrap();
                            let current_monitor = window.current_monitor().unwrap().unwrap();
                            let area = current_monitor.work_area();
                            let max_width =
                                f64::from(area.size.width - outer.width.saturating_sub(size.width))
                                    / scale;
                            let max_height = f64::from(
                                area.size.height - outer.height.saturating_sub(size.height),
                            ) / scale;
                            assert!(
                                state.1 <= max_width && state.2 <= max_height,
                                "stale monitor cap"
                            );
                            println!(
                                "PASS: {} monitor {:?} scale {} cap {}x{}",
                                window.label(),
                                monitor.name(),
                                scale,
                                state.1,
                                state.2
                            );
                        }
                    }
                    if !baseline {
                        let window = startup.as_ref().window();
                        assert!(window.is_maximized().unwrap());
                        assert_eq!(window_constraints::snapshot(&window), None, "startup setter ran while maximized");
                        window.unmaximize().unwrap();
                        wait(|| window_constraints::snapshot(&window).is_some());
                        let minimum = window_constraints::snapshot(&window).unwrap();
                        assert_eq!(minimum.0, 5.0);
                        println!("PASS: initial maximized restore defers saved zoom until normal");
                        // Allow all initial writes to settle, then count real
                        // native geometry messages across fallback refreshes.
                        thread::sleep(Duration::from_millis(800));
                        let before = POSITION_CHANGES.load(std::sync::atomic::Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(1200));
                        assert_eq!(POSITION_CHANGES.load(std::sync::atomic::Ordering::SeqCst), before,
                            "unchanged constraints caused native resize recursion");
                        println!("PASS: unchanged fallback checks produce no native geometry writes");
                    }
                }));
                // Keep isolated WebView2 data alive until all test windows close.
                let _profile = profile;
                if result.is_err() {
                    eprintln!("FAIL: isolated Windows window constraints");
                    std::process::exit(2);
                } else {
                    println!("PASS: isolated Windows window constraints");
                    app.exit(0);
                }
            });
            Ok(())
        })
        .run(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("run isolated Tauri fixture");
}
