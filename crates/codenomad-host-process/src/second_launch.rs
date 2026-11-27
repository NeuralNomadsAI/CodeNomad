//! Profile-scoped Windows second-launch coordinator.
//!
//! Each live desktop window registers a background takeover worker on a per-session,
//! per-user, per-scope named mutex secured to the current user's SID. The current mutex
//! owner serves a user-only named pipe (`FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED`):
//! - Both sides mutually verify the peer's kernel-attested PID, user SID and Windows session ID
//!   (`GetNamedPipeServerProcessId` / `GetNamedPipeClientProcessId`), and clients connect with
//!   `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` so a server cannot impersonate them.
//! - When `focus_existing` is `false`, the owner replies `OPEN\n` and the new launch continues
//!   opening its own window with its own arguments and environment.
//! - When `focus_existing` is `true`, the owner replies `FOCUS <pid>\n`; the new launch verifies
//!   `<pid>` matches the pipe server PID, calls `AllowSetForegroundWindow(pid)`, writes `OK\n`,
//!   and exits only after the owner invokes `on_focus()` and replies `DONE\n`.
//! - When the owning window closes or crashes, any surviving window for the same scope acquires
//!   the mutex (`WAIT_OBJECT_0` / `WAIT_ABANDONED_0`) and takes over serving.
use std::sync::{Arc, atomic::AtomicBool};

#[cfg(windows)]
mod win {
    use std::{
        cell::UnsafeCell,
        mem::{size_of, size_of_val, zeroed},
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
            ERROR_MORE_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_ALL, GENERIC_READ,
            GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_ABANDONED_0,
            WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        Security::{
            ACL, ACL_REVISION, AddAccessAllowedAce, GetLengthSid, GetTokenInformation,
            InitializeAcl, InitializeSecurityDescriptor, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
            SetSecurityDescriptorDacl, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
            PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
            WriteFile,
        },
        System::{
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
                GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
                PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT, WaitNamedPipeW,
            },
            RemoteDesktop::ProcessIdToSessionId,
            Threading::{
                CreateEventW, CreateMutexW, GetCurrentProcess, GetCurrentProcessId, INFINITE,
                OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, ReleaseMutex,
                SetEvent, WaitForMultipleObjects, WaitForSingleObject,
            },
        },
        UI::WindowsAndMessaging::AllowSetForegroundWindow,
    };

    const CONNECT_DEADLINE: Duration = Duration::from_millis(1000);
    const IO_TIMEOUT: Duration = Duration::from_millis(500);
    const PIPE_RETRY_LIMIT: usize = 50;
    const PIPE_RETRY_DELAY_MS: u32 = 10;
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

    struct OwnedHandle(HANDLE);

    // SAFETY: Win32 kernel handles (pipes, events, mutexes, processes, tokens) are process-wide
    // references safely closed once on drop; mutex ownership stays strictly on the worker thread.
    unsafe impl Send for OwnedHandle {}
    // SAFETY: Event signalling and waiting APIs are thread-safe on Win32 handles.
    unsafe impl Sync for OwnedHandle {}

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Option<Self> {
            // Lazy closure avoids constructing and dropping Self(INVALID_HANDLE_VALUE),
            // which would call CloseHandle on an invalid handle and overwrite GetLastError.
            (!handle.is_null() && handle != INVALID_HANDLE_VALUE).then(|| Self(handle))
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

    /// Runs `f` with an explicit `SECURITY_ATTRIBUTES` granting `GENERIC_ALL` only to the
    /// current user's SID. All backing buffers stay pinned on this stack frame until `f` returns.
    fn with_user_security<R>(f: impl FnOnce(&SECURITY_ATTRIBUTES) -> R) -> Option<R> {
        let sid = current_user_sid()?;
        if sid.is_empty() {
            return None;
        }
        let mut acl = [0u64; 32];
        // SAFETY: Zero-initialized SECURITY_DESCRIPTOR populated below and never moved.
        let mut sd: SECURITY_DESCRIPTOR = unsafe { zeroed() };
        let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
        let acl_len = size_of_val(&acl) as u32;
        let sd_ptr = (&mut sd as *mut SECURITY_DESCRIPTOR).cast();
        // SAFETY: `acl`, `sd` and `sid` stay alive and unmoved across `f(&sa)`.
        unsafe {
            if InitializeSecurityDescriptor(sd_ptr, SECURITY_DESCRIPTOR_REVISION) == 0
                || InitializeAcl(acl_ptr, acl_len, ACL_REVISION) == 0
                || AddAccessAllowedAce(
                    acl_ptr,
                    ACL_REVISION,
                    GENERIC_ALL,
                    sid.as_ptr().cast_mut().cast(),
                ) == 0
                || SetSecurityDescriptorDacl(sd_ptr, 1, acl_ptr, 0) == 0
            {
                return None;
            }
        }
        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_ptr,
            bInheritHandle: 0,
        };
        Some(f(&sa))
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

    fn token_sid_bytes(token: HANDLE) -> Option<Vec<u8>> {
        let mut buf = [0u64; 64];
        let mut len = 0u32;
        // SAFETY: Queries TokenUser into an 8-byte aligned stack buffer and copies only
        // the SID's reported byte length before returning.
        unsafe {
            if GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr().cast(),
                size_of_val(&buf) as u32,
                &mut len,
            ) == 0
            {
                return None;
            }
            let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
            if sid.is_null() {
                return None;
            }
            let sid_len = GetLengthSid(sid) as usize;
            if sid_len == 0 || sid_len > size_of_val(&buf) {
                return None;
            }
            Some(std::slice::from_raw_parts(sid as *const u8, sid_len).to_vec())
        }
    }

    fn current_user_sid() -> Option<Vec<u8>> {
        let mut token = std::ptr::null_mut();
        // SAFETY: Opens current process token for query and wraps it in OwnedHandle.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = OwnedHandle::new(token)?;
        token_sid_bytes(token.raw())
    }

    fn process_user_sid(pid: u32) -> Option<Vec<u8>> {
        // SAFETY: Opens peer process with minimal query rights; closed via OwnedHandle.
        let proc_handle =
            OwnedHandle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
        let mut token = std::ptr::null_mut();
        // SAFETY: Opens peer token for SID query; closed via OwnedHandle.
        if unsafe { OpenProcessToken(proc_handle.raw(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = OwnedHandle::new(token)?;
        token_sid_bytes(token.raw())
    }

    fn session_id_of(pid: u32) -> Option<u32> {
        let mut session = 0u32;
        // SAFETY: Writes the process's Terminal Services session ID into `session`.
        let ok = unsafe { ProcessIdToSessionId(pid, &mut session) != 0 };
        ok.then_some(session)
    }

    fn peer_matches_current_user(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        // SAFETY: Reads the current process ID.
        let my_pid = unsafe { GetCurrentProcessId() };
        let Some(my_session) = session_id_of(my_pid) else {
            return false;
        };
        if session_id_of(pid) != Some(my_session) {
            return false;
        }
        let Some(my_sid) = current_user_sid() else {
            return false;
        };
        process_user_sid(pid).is_some_and(|peer_sid| !my_sid.is_empty() && peer_sid == my_sid)
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

    fn object_names(scope_id: &str) -> Option<(Vec<u16>, Vec<u16>)> {
        // SAFETY: Reads the current process ID.
        let session = session_id_of(unsafe { GetCurrentProcessId() })?;
        let sid_hex: String = current_user_sid()?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let tag = format!("{session}-{sid_hex}-{}", sanitize(scope_id));
        let mutex = format!(r"Local\codenomad-rune-owner-{tag}");
        let pipe = format!(r"\\.\pipe\codenomad-rune-launch-{tag}");
        Some((
            wide(&mutex.chars().take(240).collect::<String>()),
            wide(&pipe.chars().take(240).collect::<String>()),
        ))
    }

    /// Waits for an in-flight overlapped operation using the exact raw `*mut OVERLAPPED` pointer
    /// passed to Win32, without forming any Rust reference until `GetOverlappedResult` completes.
    ///
    /// # Safety
    /// `overlapped` must point to a valid, pinned `UnsafeCell<OVERLAPPED>` that stays alive until
    /// this function returns, and `pipe` / `io_event` / `stop_event` must remain valid handles.
    unsafe fn wait_overlapped(
        pipe: HANDLE,
        overlapped: *mut OVERLAPPED,
        io_event: HANDLE,
        stop_event: Option<HANDLE>,
        timeout_ms: u32,
    ) -> Option<u32> {
        let waited = if let Some(stop) = stop_event {
            let handles = [stop, io_event];
            // SAFETY: Caller guarantees both handles remain valid across the wait.
            unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout_ms) }
        } else {
            // SAFETY: Caller guarantees `io_event` remains valid across the wait.
            unsafe { WaitForSingleObject(io_event, timeout_ms) }
        };
        let completed = if stop_event.is_some() {
            waited == WAIT_OBJECT_0 + 1
        } else {
            waited == WAIT_OBJECT_0
        };
        let mut transferred = 0u32;
        if completed {
            // SAFETY: Event signalled completion; `overlapped` is valid for this call.
            let ok = unsafe { GetOverlappedResult(pipe, overlapped, &mut transferred, 0) != 0 };
            return ok.then_some(transferred);
        }
        // Cancel pending I/O and block until the kernel releases `overlapped` and its I/O buffer.
        // SAFETY: `pipe` and `overlapped` stay live until GetOverlappedResult returns.
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
        // SAFETY: Zeroed OVERLAPPED is valid; UnsafeCell preserves raw pointer provenance.
        let overlapped = UnsafeCell::new(unsafe { zeroed::<OVERLAPPED>() });
        let ov_ptr = overlapped.get();
        // SAFETY: No I/O has started yet; set hEvent via raw pointer.
        unsafe {
            (*ov_ptr).hEvent = io_event.raw();
        }
        let mut read = 0u32;
        let buf_ptr = buf.as_mut_ptr();
        let buf_len = buf.len() as u32;
        // SAFETY: `buf_ptr` and `ov_ptr` stay valid and unaliased until I/O finishes or drains.
        let ok = unsafe { ReadFile(pipe, buf_ptr, buf_len, &mut read, ov_ptr) };
        if ok != 0 {
            return Some(read as usize);
        }
        // SAFETY: Reads last Win32 error immediately after ReadFile failed.
        let err = unsafe { GetLastError() };
        if err == ERROR_MORE_DATA {
            return Some(read as usize);
        }
        if err != ERROR_IO_PENDING {
            return None;
        }
        let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        // SAFETY: `overlapped` and `buf` outlive `wait_overlapped`, which drains any cancel.
        unsafe { wait_overlapped(pipe, ov_ptr, io_event.raw(), stop_event, timeout_ms) }
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
        // SAFETY: Zeroed OVERLAPPED is valid; UnsafeCell preserves raw pointer provenance.
        let overlapped = UnsafeCell::new(unsafe { zeroed::<OVERLAPPED>() });
        let ov_ptr = overlapped.get();
        // SAFETY: No I/O has started yet; set hEvent via raw pointer.
        unsafe {
            (*ov_ptr).hEvent = io_event.raw();
        }
        let mut written = 0u32;
        // SAFETY: `data` and `ov_ptr` stay valid until I/O finishes or drains.
        let ok = unsafe { WriteFile(pipe, data.as_ptr(), data.len() as u32, &mut written, ov_ptr) };
        if ok != 0 {
            return written as usize == data.len();
        }
        // SAFETY: Reads last Win32 error immediately after WriteFile failed.
        let err = unsafe { GetLastError() };
        if err != ERROR_IO_PENDING {
            return false;
        }
        let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        // SAFETY: `overlapped` and `data` outlive `wait_overlapped`, which drains any cancel.
        unsafe { wait_overlapped(pipe, ov_ptr, io_event.raw(), stop_event, timeout_ms) }
            .is_some_and(|n| n as usize == data.len())
    }

    fn connect_client(pipe: HANDLE, stop_event: HANDLE) -> Option<bool> {
        let io_event = create_event(true)?;
        // SAFETY: Zeroed OVERLAPPED is valid; UnsafeCell preserves raw pointer provenance.
        let overlapped = UnsafeCell::new(unsafe { zeroed::<OVERLAPPED>() });
        let ov_ptr = overlapped.get();
        // SAFETY: No I/O has started yet; set hEvent via raw pointer.
        unsafe {
            (*ov_ptr).hEvent = io_event.raw();
        }
        // SAFETY: `pipe` and `ov_ptr` stay valid until completion or cancellation drain.
        let ok = unsafe { ConnectNamedPipe(pipe, ov_ptr) };
        if ok != 0 {
            return Some(true);
        }
        // SAFETY: Reads last Win32 error immediately after ConnectNamedPipe failed.
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
        let mut transferred = 0u32;
        if waited == WAIT_OBJECT_0 + 1 {
            // SAFETY: `io_event` signalled completion; check result via the same raw `ov_ptr`.
            let connected = unsafe { GetOverlappedResult(pipe, ov_ptr, &mut transferred, 0) != 0 };
            return Some(connected);
        }
        // Cancel and drain on BOTH stop_event (WAIT_OBJECT_0) and WAIT_FAILED before
        // `overlapped` and `io_event` leave scope.
        // SAFETY: `pipe` and `ov_ptr` stay valid until GetOverlappedResult returns.
        unsafe {
            CancelIoEx(pipe, ov_ptr);
            let _ = GetOverlappedResult(pipe, ov_ptr, &mut transferred, 1);
        }
        if waited == WAIT_OBJECT_0 {
            None
        } else {
            Some(false)
        }
    }

    fn create_pipe(pipe_name: &[u16], stop_event: HANDLE) -> Option<OwnedHandle> {
        with_user_security(|sa| {
            for _ in 0..PIPE_RETRY_LIMIT {
                // SAFETY: `pipe_name` is NUL-terminated and `sa` stays valid on caller's stack.
                let raw = unsafe {
                    CreateNamedPipeW(
                        pipe_name.as_ptr(),
                        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                        PIPE_TYPE_BYTE
                            | PIPE_READMODE_BYTE
                            | PIPE_WAIT
                            | PIPE_REJECT_REMOTE_CLIENTS,
                        1,
                        64,
                        64,
                        IO_TIMEOUT.as_millis() as u32,
                        sa,
                    )
                };
                if let Some(handle) = OwnedHandle::new(raw) {
                    return Some(handle);
                }
                // SAFETY: Reads last Win32 error; OwnedHandle::new did not clobber it.
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
        })
        .flatten()
    }

    fn serve_client(
        pipe: HANDLE,
        stop_event: HANDLE,
        focus_existing: &AtomicBool,
        on_focus: &dyn Fn(),
    ) {
        let mut client_pid = 0u32;
        // SAFETY: Queries the kernel-attested PID of the connected local pipe client.
        if unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) } == 0
            || !peer_matches_current_user(client_pid)
        {
            return;
        }
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
        // Focus only after the client confirms AllowSetForegroundWindow via OK\n,
        // then send DONE\n so the client never exits if this owner closed mid-handshake.
        let mut ack = [0u8; 8];
        let Some(ack_len) = read_overlapped(pipe, &mut ack, Some(stop_event), IO_TIMEOUT) else {
            return;
        };
        if !ack[..ack_len].starts_with(b"OK\n") {
            return;
        }
        on_focus();
        if write_overlapped(pipe, b"DONE\n", Some(stop_event), IO_TIMEOUT) {
            let mut eof = [0u8; 4];
            let _ = read_overlapped(pipe, &mut eof, Some(stop_event), IO_TIMEOUT);
        }
    }

    pub fn try_focus_existing(scope_id: &str) -> bool {
        let Some((_, pipe_name)) = object_names(scope_id) else {
            return false;
        };
        let deadline = Instant::now() + CONNECT_DEADLINE;
        let pipe = loop {
            // SAFETY: `pipe_name` is NUL-terminated; SQOS_IDENTIFICATION prevents impersonation.
            let raw = unsafe {
                CreateFileW(
                    pipe_name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    std::ptr::null_mut(),
                )
            };
            if let Some(handle) = OwnedHandle::new(raw) {
                break handle;
            }
            // SAFETY: Reads last Win32 error; OwnedHandle::new did not clobber it.
            let err = unsafe { GetLastError() };
            if err == ERROR_FILE_NOT_FOUND || err != ERROR_PIPE_BUSY {
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
        let mut server_pid = 0u32;
        // SAFETY: Queries the kernel-attested PID of the pipe server before sending anything.
        if unsafe { GetNamedPipeServerProcessId(pipe.raw(), &mut server_pid) } == 0
            || !peer_matches_current_user(server_pid)
        {
            return false;
        }
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
        let Ok(announced_pid) = pid_text.trim().parse::<u32>() else {
            return false;
        };
        if announced_pid != server_pid {
            return false;
        }
        // SAFETY: Grants foreground rights strictly to the kernel-verified pipe server PID.
        unsafe {
            let _ = AllowSetForegroundWindow(server_pid);
        }
        if !write_overlapped(pipe.raw(), b"OK\n", None, IO_TIMEOUT) {
            return false;
        }
        let mut done = [0u8; 16];
        let Some(done_len) = read_overlapped(pipe.raw(), &mut done, None, IO_TIMEOUT) else {
            return false;
        };
        done[..done_len].starts_with(b"DONE\n")
    }

    #[cfg(test)]
    pub(super) fn pipe_ready(scope_id: &str) -> bool {
        let Some((_, pipe_name)) = object_names(scope_id) else {
            return false;
        };
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
            let (mutex_name, pipe_name) = object_names(scope_id)?;
            let thread = thread::Builder::new()
                .name("codenomad-launch-owner".into())
                .spawn(move || {
                    let Some(mutex) = with_user_security(|sa| {
                        // SAFETY: `mutex_name` is NUL-terminated and `sa` stays valid for the call.
                        OwnedHandle::new(unsafe { CreateMutexW(sa, 0, mutex_name.as_ptr()) })
                    })
                    .flatten() else {
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

        wait_for_pipe(&scope);

        // Default false: second launch receives OPEN and does not focus A.
        assert!(!LaunchCoordinator::try_focus_existing(&scope));
        assert_eq!(hits_a.load(Ordering::SeqCst), 0);

        // Enable focusExistingWindowOnSecondLaunch on A: second launch focuses A.
        focus_a.store(true, Ordering::Release);
        assert!(
            LaunchCoordinator::try_focus_existing(&scope),
            "second launch must focus A once enabled"
        );
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
        assert_eq!(hits_b.load(Ordering::SeqCst), 1);
        assert_eq!(hits_a.load(Ordering::SeqCst), 1);

        // After B closes too, no owner remains.
        drop(owner_b);
        assert!(!LaunchCoordinator::try_focus_existing(&scope));
    }
}
