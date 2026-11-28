//! Copies of the application running from an install, which the setup and the uninstaller close
//! before they replace or remove its files (Windows locks a running program's files).

use std::path::Path;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WAIT_OBJECT_0, WPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible, PostMessageW,
    WM_CLOSE,
};
use windows::core::{BOOL, PWSTR};

/// A process whose program lives under the install. Windows does not give its id to another
/// process while the handle is open, so what is asked of the id reaches this process only.
struct Running {
    pid: u32,
    handle: HANDLE,
    /// Whether the handle can wait for the process and end it.
    owned: bool,
}

impl Drop for Running {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by `under` and is closed once.
        _ = unsafe { CloseHandle(self.handle) };
    }
}

impl Running {
    fn exited(&self, wait: Duration) -> bool {
        let ms = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: waits on a handle this value owns.
        self.owned && unsafe { WaitForSingleObject(self.handle, ms) } == WAIT_OBJECT_0
    }
}

/// Every other process whose program lives under `root`, each held open.
fn under(root: &Path) -> Vec<Running> {
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
            if pid != me
                && let Some(running) = open(pid)
                && image(running.handle).is_some_and(|p| p.to_lowercase().starts_with(&prefix))
            {
                found.push(running);
            }
            more = Process32NextW(snap, &mut entry).is_ok();
        }
        _ = CloseHandle(snap);
    }
    found
}

/// Opens `pid` to read its program, wait for it and end it; to read its program only when
/// Windows refuses the rest (a process of another account).
fn open(pid: u32) -> Option<Running> {
    let all = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
    // SAFETY: opens handles that `Running` closes.
    unsafe {
        if let Ok(handle) = OpenProcess(all, false, pid) {
            return Some(Running {
                pid,
                handle,
                owned: true,
            });
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        Some(Running {
            pid,
            handle,
            owned: false,
        })
    }
}

fn image(process: HANDLE) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: the buffer outlives the call, which reads through a handle the caller holds.
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .ok()?;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// The id of every other process whose program lives under `root`.
pub fn running_under(root: &Path) -> Vec<u32> {
    under(root).iter().map(|running| running.pid).collect()
}

/// Asks every copy running from `root` to close, as its close button would (so it saves its
/// windows), and ends those still running after `grace`. True once none runs.
pub fn close_running(root: &Path, grace: Duration) -> bool {
    let running = under(root);
    if running.is_empty() {
        return true;
    }
    let pids: Vec<u32> = running.iter().map(|r| r.pid).collect();
    for hwnd in windows_of(&pids) {
        // SAFETY: posts a message to a window; a window that went meanwhile just fails the call.
        _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
    }
    let deadline = Instant::now() + grace;
    for process in &running {
        if !process.exited(deadline.saturating_duration_since(Instant::now())) && process.owned {
            // SAFETY: ends the process this handle has held since its program was checked.
            _ = unsafe { TerminateProcess(process.handle, 1) };
            process.exited(Duration::from_secs(2));
        }
    }
    drop(running);
    under(root).is_empty()
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
