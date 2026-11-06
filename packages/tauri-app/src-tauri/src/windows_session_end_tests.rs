use super::*;
use std::cell::RefCell;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, SendMessageW, WNDCLASSEXW,
    WS_POPUP,
};

thread_local! {
    /// Handler and window-procedure calls on this test thread, in order.
    static LOG: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
}

fn record(entry: &'static str) {
    LOG.with(|log| log.borrow_mut().push(entry));
}

fn take_log() -> Vec<&'static str> {
    LOG.with(|log| std::mem::take(&mut *log.borrow_mut()))
}

unsafe extern "system" fn recording_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_QUERYENDSESSION => record("window-query"),
        WM_ENDSESSION => record("window-end"),
        _ => {}
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

/// A never-shown top-level window on the calling test thread.
fn hidden_window(class: &str) -> HWND {
    let class: Vec<u16> = class.encode_utf16().chain(Some(0)).collect();
    let window_class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(recording_proc),
        lpszClassName: class.as_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    unsafe { RegisterClassExW(&window_class) };
    let hwnd = unsafe {
        CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_POPUP, 0, 0, 0, 0,
            std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
    };
    assert!(!hwnd.is_null(), "create hidden test window");
    hwnd
}

fn recorder(forward_end: bool) -> SessionEndHandler {
    SessionEndHandler {
        query: Box::new(|| record("query")),
        end: Box::new(|ending| record(if ending { "flush" } else { "cancel" })),
        forward_end,
    }
}

#[test]
fn tao_event_target_receives_session_end_only_after_the_flush() {
    let hwnd = hidden_window("CodeNomadSessionEndForwardTest");
    install(hwnd, recorder(true)).unwrap();
    take_log();
    assert_eq!(unsafe { SendMessageW(hwnd, WM_QUERYENDSESSION, 0, 0) }, 1);
    unsafe { SendMessageW(hwnd, WM_ENDSESSION, 1, 0) };
    assert_eq!(take_log(), ["query", "flush", "window-end"]);
    unsafe { DestroyWindow(hwnd) };
}

#[test]
fn application_windows_consume_session_end() {
    let hwnd = hidden_window("CodeNomadSessionEndConsumeTest");
    install(hwnd, recorder(false)).unwrap();
    take_log();
    unsafe {
        assert_eq!(SendMessageW(hwnd, WM_QUERYENDSESSION, 0, 0), 1);
        SendMessageW(hwnd, WM_ENDSESSION, 0, 0);
        SendMessageW(hwnd, WM_ENDSESSION, 1, 0);
    }
    assert_eq!(take_log(), ["query", "cancel", "flush"]);
    unsafe { DestroyWindow(hwnd) };
}

#[test]
fn finds_only_this_threads_window_of_the_requested_class() {
    const CLASS: &str = "CodeNomadSessionEndLookupTest";
    let other_thread = std::thread::spawn(|| hidden_window(CLASS) as usize).join().unwrap();
    assert_eq!(current_thread_window_of_class(CLASS), None);
    let hwnd = hidden_window(CLASS);
    assert_ne!(hwnd as usize, other_thread);
    assert_eq!(current_thread_window_of_class(CLASS), Some(hwnd));
    unsafe { DestroyWindow(hwnd) };
}

/// The source directory of the Tao the application resolves: the vendored copy
/// selected by `[patch.crates-io]`, or the registry crate without it.
fn resolved_tao_directory() -> std::path::PathBuf {
    let output = std::process::Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(["metadata", "--locked", "--format-version", "1"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run cargo metadata");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let tao: Vec<_> = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|package| package["name"] == "tao")
        .collect();
    assert_eq!(tao.len(), 1, "the application resolves one Tao");
    std::path::Path::new(tao[0]["manifest_path"].as_str().unwrap())
        .parent()
        .unwrap()
        .to_path_buf()
}

#[test]
fn resolved_tao_still_exits_from_the_named_event_target() {
    // The forwarding exists for this upstream behavior; re-evaluate it whenever
    // Tao renames the window class or changes its WM_ENDSESSION handling.
    let source = std::fs::read_to_string(resolved_tao_directory().join("src/platform_impl/windows/event_loop.rs")).unwrap();
    assert!(source.contains(&format!("w!(\"{TAO_EVENT_TARGET_CLASS}\")")));
    let session_end = &source[source.find("win32wm::WM_ENDSESSION =>").expect("Tao WM_ENDSESSION handler")..];
    assert!(session_end[..session_end.find("LRESULT(0)").unwrap()].contains("std::process::exit(0)"));
}
