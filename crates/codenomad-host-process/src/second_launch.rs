//! Profile-scoped Windows second-launch coordinator.
//!
//! Each live desktop window registers a background takeover worker on a per-session,
//! per-user, per-scope named mutex. The current mutex owner serves a named pipe:
//! - When `focus_existing` is `false`, the owner replies `OPEN\n` and the new launch
//!   continues opening its own window with its own arguments and environment.
//! - When `focus_existing` is `true`, the owner replies `FOCUS <pid>\n`; the new launch
//!   grants foreground permission (`AllowSetForegroundWindow(pid)`), replies `OK\n` and
//!   exits while the owner brings its window to the front.
//! - When the owning window closes or crashes, any surviving window for the same scope
//!   acquires the mutex (`WAIT_OBJECT_0` / `WAIT_ABANDONED_0`) and takes over serving.
use std::sync::{Arc, atomic::AtomicBool};

#[cfg(windows)]
mod win {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING,
            ERROR_MORE_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
            GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_ABANDONED_0, WAIT_OBJECT_0,
            WAIT_TIMEOUT,
        },
        Security::{GetLengthSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser},
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
            PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
        },
        System::{
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
                PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT, WaitNamedPipeW,
            },
            RemoteDesktop::ProcessIdToSessionId,
            Threading::{
                CreateEventW, CreateMutexW, GetCurrentProcess, GetCurrentProcessId, INFINITE,
                OpenProcessToken, ReleaseMutex, SetEvent, WaitForMultipleObjects,
                WaitForSingleObject,
            },
        },
        UI::WindowsAndMessaging::AllowSetForegroundWindow,
    };

    const CONNECT_DEADLINE: Duration = Duration::from_millis(1000);
    const IO_TIMEOUT: Duration = Duration::from_millis(500);
    const PIPE_RETRY_LIMIT: usize = 50;
    const PIPE_RETRY_DELAY_MS: u32 = 10;

    struct OwnedHandle(HANDLE);

    // SAFETY: Win32 kernel handles (pipes, events, mutexes) are process-wide references
    // safely closed once on drop; mutex ownership stays strictly on the worker thread.
    unsafe impl Send for OwnedHandle {}
    // SAFETY: Event signalling and waiting APIs are thread-safe on Win32 handles.
    unsafe impl Sync for OwnedHandle {}

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Option<Self> {
            (!handle.is_null() && handle != INVALID_HANDLE_VALUE).then_some(Self(handle))
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: Handle was validated in `new` and is closed exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    struct MutexGuard<'a>(&'a OwnedHandle);

    impl Drop for MutexGuard<'_> {
        fn drop(&mut self) {
            // SAFETY: Held by the calling thread after WaitForMultipleObjects returned
            // WAIT_OBJECT_0 + 1 or WAIT_ABANDONED_0 + 1.
            unsafe {
                ReleaseMutex(self.0.raw());
            }
        }
    }

    fn create_event(manual_reset: bool) -> Option<OwnedHandle> {
        // SAFETY: Unnamed Win32 event with default security; closed via OwnedHandle.
        let handle = unsafe {
            CreateEventW(
                std::ptr::null(),
                i32::from(manual_reset),
                0,
                std::ptr::null(),
            )
        };
        OwnedHandle::new(handle)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn user_sid_hex() -> String {
        let mut token = std::ptr::null_mut();
        let mut buf = [0u64; 64];
        let mut len = 0u32;
        // SAFETY: Queries the current process token into an 8-byte aligned stack buffer
        // and copies only the SID's reported byte length before closing the token.
        unsafe {
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return String::new();
            }
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr().cast(),
                std::mem::size_of_val(&buf) as u32,
                &mut len,
            ) != 0;
            CloseHandle(token);
            if !ok {
                return String::new();
            }
            let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
            let bytes = std::slice::from_raw_parts(sid as *const u8, GetLengthSid(sid) as usize);
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        }
    }

    fn session_id() -> u32 {
        let mut session = 0u32;
        // SAFETY: Writes the current process's session ID into `session`.
        unsafe {
            ProcessIdToSessionId(GetCurrentProcessId(), &mut session);
        }
        session
    }

    fn sanitize(value: &str) -> String {
        value
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .take(96)
            .collect()
    }

    fn object_names(scope_id: &str) -> (Vec<u16>, Vec<u16>) {
        let tag = format!("{}-{}-{}", session_id(), user_sid_hex(), sanitize(scope_id));
        let mutex = format!(r"Local\codenomad-rune-owner-{tag}");
        let pipe = format!(r"\\.\pipe\codenomad-rune-launch-{tag}");
        (
            wide(&mutex.chars().take(240).collect::<String>()),
            wide(&pipe.chars().take(240).collect::<String>()),
        )
    }

    fn wait_overlapped(
        pipe: HANDLE,
        overlapped: &mut OVERLAPPED,
        io_event: HANDLE,
        stop_event: Option<HANDLE>,
        timeout_ms: u32,
    ) -> Option<u32> {
        let waited = if let Some(stop) = stop_event {
            let handles = [stop, io_event];
            // SAFETY: Both handles stay valid across the wait.
            unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout_ms) }
        } else {
            // SAFETY: `io_event` stays valid across the wait.
            unsafe { WaitForSingleObject(io_event, timeout_ms) }
        };
        let completed = if stop_event.is_some() {
            waited == WAIT_OBJECT_0 + 1
        } else {
            waited == WAIT_OBJECT_0
        };
        let mut transferred = 0u32;
        if completed {
            // SAFETY: I/O completed; `overlapped` is valid for the duration of this call.
            let ok = unsafe { GetOverlappedResult(pipe, overlapped, &mut transferred, 0) != 0 };
            return ok.then_some(transferred);
        }
        // Cancel pending I/O and block until the kernel releases `overlapped` and its buffer.
        // SAFETY: `pipe` and `overlapped` remain live until GetOverlappedResult returns.
        unsafe {
            CancelIoEx(pipe, overlapped);
            let _ = GetOverlappedResult(pipe, overlapped, &mut transferred, 1);
        }
        None
    }

    fn read_overlapped(
        pipe: HANDLE,
        buf: &mut [u8],
        stop_event: Option<HANDLE>,
        timeout: Duration,
    ) -> Option<usize> {
        let io_event = create_event(true)?;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = io_event.raw();
        let mut read = 0u32;
        // SAFETY: `buf` and `overlapped` remain live until I/O completes or CancelIoEx drains.
        let ok = unsafe {
            ReadFile(
                pipe,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut read,
                &mut overlapped,
            )
        };
        if ok != 0 {
            return Some(read as usize);
        }
        let err = unsafe { GetLastError() };
        if err == ERROR_MORE_DATA {
            return Some(read as usize);
        }
        if err != ERROR_IO_PENDING {
            return None;
        }
        wait_overlapped(
            pipe,
            &mut overlapped,
            io_event.raw(),
            stop_event,
            timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32,
        )
        .map(|n| n as usize)
    }

    fn write_overlapped(
        pipe: HANDLE,
        data: &[u8],
        stop_event: Option<HANDLE>,
        timeout: Duration,
    ) -> bool {
        let Some(io_event) = create_event(true) else {
            return false;
        };
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = io_event.raw();
        let mut written = 0u32;
        // SAFETY: `data` and `overlapped` remain live until I/O completes or CancelIoEx drains.
        let ok = unsafe {
            WriteFile(
                pipe,
                data.as_ptr(),
                data.len() as u32,
                &mut written,
                &mut overlapped,
            )
        };
        if ok != 0 {
            return written as usize == data.len();
        }
        let err = unsafe { GetLastError() };
        if err != ERROR_IO_PENDING {
            return false;
        }
        wait_overlapped(
            pipe,
            &mut overlapped,
            io_event.raw(),
            stop_event,
            timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32,
        )
        .is_some_and(|n| n as usize == data.len())
    }

    fn connect_client(pipe: HANDLE, stop_event: HANDLE) -> Option<bool> {
        let io_event = create_event(true)?;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = io_event.raw();
        // SAFETY: `pipe` and `overlapped` stay valid until completion or cancellation drain.
        let ok = unsafe { ConnectNamedPipe(pipe, &mut overlapped) };
        if ok != 0 {
            return Some(true);
        }
        let err = unsafe { GetLastError() };
        if err == ERROR_PIPE_CONNECTED {
            return Some(true);
        }
        if err != ERROR_IO_PENDING {
            return Some(false);
        }
        let handles = [stop_event, io_event.raw()];
        // SAFETY: Both handles remain valid across the wait.
        let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        if waited == WAIT_OBJECT_0 {
            let mut transferred = 0u32;
            // SAFETY: Cancel and drain before `overlapped` leaves scope.
            unsafe {
                CancelIoEx(pipe, &overlapped);
                let _ = GetOverlappedResult(pipe, &overlapped, &mut transferred, 1);
            }
            return None;
        }
        let mut transferred = 0u32;
        // SAFETY: `io_event` signalled completion of ConnectNamedPipe.
        let connected = unsafe { GetOverlappedResult(pipe, &overlapped, &mut transferred, 0) != 0 };
        Some(connected)
    }

    fn create_pipe(pipe_name: &[u16], stop_event: HANDLE) -> Option<OwnedHandle> {
        for _ in 0..PIPE_RETRY_LIMIT {
            // SAFETY: `pipe_name` is NUL-terminated; default ACL restricts access to this user.
            let raw = unsafe {
                CreateNamedPipeW(
                    pipe_name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    64,
                    64,
                    IO_TIMEOUT.as_millis() as u32,
                    std::ptr::null(),
                )
            };
            if let Some(handle) = OwnedHandle::new(raw) {
                return Some(handle);
            }
            let err = unsafe { GetLastError() };
            if err != ERROR_ACCESS_DENIED {
                return None;
            }
            // Wait briefly for a departing owner's pipe handle to finish closing.
            // SAFETY: `stop_event` stays valid across the wait.
            if unsafe { WaitForSingleObject(stop_event, PIPE_RETRY_DELAY_MS) } != WAIT_TIMEOUT {
                return None;
            }
        }
        None
    }

    fn serve_client(
        pipe: HANDLE,
        stop_event: HANDLE,
        focus_existing: &AtomicBool,
        on_focus: &dyn Fn(),
    ) {
        let mut req = [0u8; 16];
        let Some(n) = read_overlapped(pipe, &mut req, Some(stop_event), IO_TIMEOUT) else {
            return;
        };
        if !req[..n].starts_with(b"ASK\n") {
            return;
        }
        if !focus_existing.load(Ordering::Acquire) {
            if write_overlapped(pipe, b"OPEN\n", Some(stop_event), IO_TIMEOUT) {
                // Bounded wait for client close so OPEN\n is read before DisconnectNamedPipe.
                let mut eof = [0u8; 4];
                let _ = read_overlapped(pipe, &mut eof, Some(stop_event), IO_TIMEOUT);
            }
            return;
        }
        // SAFETY: Returns the current process ID.
        let pid = unsafe { GetCurrentProcessId() };
        let reply = format!("FOCUS {pid}\n");
        if !write_overlapped(pipe, reply.as_bytes(), Some(stop_event), IO_TIMEOUT) {
            return;
        }
        // Wait briefly for the client's ACK after it calls AllowSetForegroundWindow(pid).
        let mut ack = [0u8; 8];
        let _ = read_overlapped(pipe, &mut ack, Some(stop_event), IO_TIMEOUT);
        on_focus();
    }

    pub fn try_focus_existing(scope_id: &str) -> bool {
        let (_, pipe_name) = object_names(scope_id);
        let deadline = Instant::now() + CONNECT_DEADLINE;
        let pipe = loop {
            // SAFETY: `pipe_name` is NUL-terminated.
            let raw = unsafe {
                CreateFileW(
                    pipe_name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    std::ptr::null_mut(),
                )
            };
            if let Some(handle) = OwnedHandle::new(raw) {
                break handle;
            }
            let err = unsafe { GetLastError() };
            if err == ERROR_FILE_NOT_FOUND {
                return false;
            }
            if err != ERROR_PIPE_BUSY {
                return false;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let wait_ms = remaining.as_millis().clamp(1, 200) as u32;
            // SAFETY: `pipe_name` is NUL-terminated.
            unsafe {
                WaitNamedPipeW(pipe_name.as_ptr(), wait_ms);
            }
        };
        if !write_overlapped(pipe.raw(), b"ASK\n", None, IO_TIMEOUT) {
            return false;
        }
        let mut buf = [0u8; 64];
        let Some(n) = read_overlapped(pipe.raw(), &mut buf, None, IO_TIMEOUT) else {
            return false;
        };
        let Ok(text) = std::str::from_utf8(&buf[..n]) else {
            return false;
        };
        let Some(rest) = text.strip_prefix("FOCUS ") else {
            return false;
        };
        let Some(pid_text) = rest.lines().next() else {
            return false;
        };
        let Ok(pid) = pid_text.trim().parse::<u32>() else {
            return false;
        };
        // SAFETY: Grants foreground activation rights to the confirmed existing owner process.
        unsafe {
            let _ = AllowSetForegroundWindow(pid);
        }
        let _ = write_overlapped(pipe.raw(), b"OK\n", None, IO_TIMEOUT);
        true
    }

    #[cfg(test)]
    pub(super) fn pipe_ready(scope_id: &str) -> bool {
        let (_, pipe_name) = object_names(scope_id);
        // SAFETY: `pipe_name` is NUL-terminated; WaitNamedPipeW with 0 checks pipe existence.
        if unsafe { WaitNamedPipeW(pipe_name.as_ptr(), 0) } != 0 {
            return true;
        }
        // SAFETY: Reads the last Win32 error from WaitNamedPipeW.
        unsafe { GetLastError() != ERROR_FILE_NOT_FOUND }
    }

    pub struct Coordinator {
        stop: Arc<OwnedHandle>,
        thread: Option<JoinHandle<()>>,
    }

    impl Coordinator {
        pub fn start(
            scope_id: &str,
            focus_existing: Arc<AtomicBool>,
            on_focus: impl Fn() + Send + 'static,
        ) -> Option<Self> {
            let stop = Arc::new(create_event(true)?);
            let worker_stop = Arc::clone(&stop);
            let (mutex_name, pipe_name) = object_names(scope_id);
            let thread = thread::Builder::new()
                .name("codenomad-launch-owner".into())
                .spawn(move || {
                    // SAFETY: `mutex_name` is NUL-terminated; initial ownership is false so
                    // acquisition is synchronized with `stop` via WaitForMultipleObjects.
                    let Some(mutex) = OwnedHandle::new(unsafe {
                        CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr())
                    }) else {
                        return;
                    };
                    let handles = [worker_stop.raw(), mutex.raw()];
                    // SAFETY: Both handles stay valid across the wait.
                    let waited =
                        unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
                    if waited != WAIT_OBJECT_0 + 1 && waited != WAIT_ABANDONED_0 + 1 {
                        return;
                    }
                    let _owned_mutex = MutexGuard(&mutex);
                    let Some(pipe) = create_pipe(&pipe_name, worker_stop.raw()) else {
                        return;
                    };
                    loop {
                        match connect_client(pipe.raw(), worker_stop.raw()) {
                            None => break,
                            Some(false) => {
                                // SAFETY: Reset pipe instance after a failed connect.
                                unsafe {
                                    DisconnectNamedPipe(pipe.raw());
                                }
                                continue;
                            }
                            Some(true) => {
                                serve_client(
                                    pipe.raw(),
                                    worker_stop.raw(),
                                    &focus_existing,
                                    &on_focus,
                                );
                                // SAFETY: Disconnect completed client before accepting the next one.
                                unsafe {
                                    DisconnectNamedPipe(pipe.raw());
                                }
                            }
                        }
                    }
                })
                .ok()?;
            Some(Self {
                stop,
                thread: Some(thread),
            })
        }
    }

    impl Drop for Coordinator {
        fn drop(&mut self) {
            // SAFETY: Signalling the manual-reset stop event wakes the worker thread.
            unsafe {
                SetEvent(self.stop.raw());
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

pub struct LaunchCoordinator {
    #[cfg(windows)]
    _inner: win::Coordinator,
}

impl LaunchCoordinator {
    pub fn try_focus_existing(scope_id: &str) -> bool {
        #[cfg(windows)]
        {
            win::try_focus_existing(scope_id)
        }
        #[cfg(not(windows))]
        {
            let _ = scope_id;
            false
        }
    }

    pub fn start(
        scope_id: &str,
        focus_existing: Arc<AtomicBool>,
        on_focus: impl Fn() + Send + 'static,
    ) -> Option<Self> {
        #[cfg(windows)]
        {
            win::Coordinator::start(scope_id, focus_existing, on_focus)
                .map(|_inner| Self { _inner })
        }
        #[cfg(not(windows))]
        {
            let _ = (scope_id, focus_existing, on_focus);
            None
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    fn unique_scope(tag: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("test-{tag}-{}-{nanos}", std::process::id())
    }

    fn wait_for_pipe(scope: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !win::pipe_ready(scope) {
            assert!(
                Instant::now() < deadline,
                "owner pipe did not become ready in time"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn no_running_owner_returns_false_immediately() {
        let scope = unique_scope("empty");
        assert!(!LaunchCoordinator::try_focus_existing(&scope));
    }

    #[test]
    fn coordinator_respects_live_toggle_and_transfers_ownership_on_close() {
        let scope = unique_scope("handoff");
        let focus_a = Arc::new(AtomicBool::new(false));
        let hits_a = Arc::new(AtomicUsize::new(0));
        let hits_a_cb = Arc::clone(&hits_a);
        let owner_a = LaunchCoordinator::start(&scope, Arc::clone(&focus_a), move || {
            hits_a_cb.fetch_add(1, Ordering::SeqCst);
        })
        .expect("primary coordinator must start");

        // Wait until owner A has opened the pipe by flipping briefly or polling.
        wait_for_pipe(&scope);

        // Default false: second launch receives OPEN and does not focus A.
        assert!(!LaunchCoordinator::try_focus_existing(&scope));
        assert_eq!(hits_a.load(Ordering::SeqCst), 0);

        // Enable focusExistingWindowOnSecondLaunch on A: second launch focuses A.
        focus_a.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut focused = false;
        while Instant::now() < deadline {
            if LaunchCoordinator::try_focus_existing(&scope) {
                focused = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(focused, "second launch must focus A once enabled");
        let deadline = Instant::now() + Duration::from_secs(2);
        while hits_a.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(hits_a.load(Ordering::SeqCst), 1);

        // Start surviving secondary window B on the same scope.
        let focus_b = Arc::new(AtomicBool::new(true));
        let hits_b = Arc::new(AtomicUsize::new(0));
        let hits_b_cb = Arc::clone(&hits_b);
        let owner_b = LaunchCoordinator::start(&scope, Arc::clone(&focus_b), move || {
            hits_b_cb.fetch_add(1, Ordering::SeqCst);
        })
        .expect("secondary coordinator must start");

        // Close window A: window B must acquire ownership and receive the next launch.
        drop(owner_a);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut focused_b = false;
        while Instant::now() < deadline {
            if LaunchCoordinator::try_focus_existing(&scope) {
                focused_b = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        assert!(
            focused_b,
            "surviving window B must take over after A closes"
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while hits_b.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(hits_b.load(Ordering::SeqCst), 1);
        assert_eq!(hits_a.load(Ordering::SeqCst), 1);

        // After B closes too, no owner remains.
        drop(owner_b);
        assert!(!LaunchCoordinator::try_focus_existing(&scope));
    }
}
