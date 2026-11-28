//! Copies of the application running from an install, which the setup and the uninstaller close
//! before they replace or remove its files (Windows locks a running program's files).

use std::path::Path;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible, PostMessageW,
    WM_CLOSE,
};
use windows::core::{BOOL, PWSTR};

/// Every other process whose program lives under `root`.
pub fn running_under(root: &Path) -> Vec<u32> {
    let prefix = format!(
        "{}\\",
        root.to_string_lossy().trim_end_matches('\\').to_lowercase()
    );
    // SAFETY: GetCurrentProcessId has no preconditions.
    let me = unsafe { GetCurrentProcessId() };
    let mut found = Vec::new();
    // SAFETY: walks a snapshot this function owns and closes; each entry is read into `entry`,
    // whose size field is set as the API asks.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return found;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snap, &mut entry).is_ok();
        while more {
            let pid = entry.th32ProcessID;
            if pid != me && image(pid).is_some_and(|p| p.to_lowercase().starts_with(&prefix)) {
                found.push(pid);
            }
            more = Process32NextW(snap, &mut entry).is_ok();
        }
        _ = CloseHandle(snap);
    }
    found
}

fn image(pid: u32) -> Option<String> {
    // SAFETY: a query-only handle, closed once; the buffer outlives the call.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        _ = CloseHandle(process);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// Asks every copy running from `root` to close, as its close button would (so it saves its
/// windows), and ends those still running after `grace`. True once none runs.
pub fn close_running(root: &Path, grace: Duration) -> bool {
    let pids = running_under(root);
    if pids.is_empty() {
        return true;
    }
    for hwnd in windows_of(&pids) {
        // SAFETY: posts a message to a window; a window that went meanwhile just fails the call.
        _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if running_under(root).is_empty() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    for pid in running_under(root) {
        // SAFETY: a terminate-only handle, closed once.
        unsafe {
            if let Ok(process) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                _ = TerminateProcess(process, 1);
                _ = CloseHandle(process);
            }
        }
    }
    std::thread::sleep(Duration::from_millis(500));
    running_under(root).is_empty()
}

/// The visible top-level windows of `pids` that no other window owns.
fn windows_of(pids: &[u32]) -> Vec<HWND> {
    struct Walk<'a> {
        pids: &'a [u32],
        found: Vec<HWND>,
    }
    unsafe extern "system" fn each(hwnd: HWND, walk: LPARAM) -> BOOL {
        // SAFETY: `walk` points at the `Walk` `windows_of` passed, alive for the enumeration.
        unsafe {
            let walk = &mut *(walk.0 as *mut Walk);
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
            if walk.pids.contains(&pid) && IsWindowVisible(hwnd).as_bool() && !owned {
                walk.found.push(hwnd);
            }
            BOOL(1)
        }
    }
    let mut walk = Walk {
        pids,
        found: Vec::new(),
    };
    // SAFETY: the callback only touches `walk`, which outlives the enumeration.
    _ = unsafe { EnumWindows(Some(each), LPARAM(&mut walk as *mut Walk as isize)) };
    walk.found
}
