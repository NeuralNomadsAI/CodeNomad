//! Run a fixture with inherited stdio and contain its entire process family.
use codenomad_host_process::OwnedProcess;
use std::{
    ffi::OsString,
    io::{self, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

#[cfg(windows)]
struct ParentWatch(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ParentWatch {
    fn open() -> io::Result<Option<Self>> {
        let Some(raw) = std::env::var_os("CODENOMAD_FIXTURE_PARENT_PID") else {
            return Ok(None);
        };
        let pid: u32 = raw
            .to_string_lossy()
            .parse()
            .map_err(|_| io::Error::other("Invalid CODENOMAD_FIXTURE_PARENT_PID"))?;
        let handle = unsafe {
            windows_sys::Win32::System::Threading::OpenProcess(
                windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(io::Error::other(
                "Fixture parent process exited before job launch",
            ));
        }
        Ok(Some(Self(handle)))
    }

    fn exited(&self) -> bool {
        unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 0)
                != windows_sys::Win32::Foundation::WAIT_TIMEOUT
        }
    }
}

#[cfg(windows)]
impl Drop for ParentWatch {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(unix)]
static STOP_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn handle_stop_signal(_sig: libc::c_int) {
    STOP_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(unix)]
fn install_signal_handlers() {
    // SAFETY: handle_stop_signal only performs an async-signal-safe atomic store.
    unsafe {
        libc::signal(
            libc::SIGTERM,
            handle_stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            handle_stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGHUP,
            handle_stop_signal as *const () as libc::sighandler_t,
        );
    }
}

#[cfg(unix)]
struct ParentWatch(u32);

#[cfg(unix)]
impl ParentWatch {
    fn open() -> io::Result<Option<Self>> {
        let Some(raw) = std::env::var_os("CODENOMAD_FIXTURE_PARENT_PID") else {
            return Ok(None);
        };
        let pid: u32 = raw
            .to_string_lossy()
            .parse()
            .map_err(|_| io::Error::other("Invalid CODENOMAD_FIXTURE_PARENT_PID"))?;
        if pid == 0 {
            return Err(io::Error::other("Invalid CODENOMAD_FIXTURE_PARENT_PID"));
        }
        let watch = Self(pid);
        if watch.exited() {
            return Err(io::Error::other(
                "Fixture parent process exited before job launch",
            ));
        }
        Ok(Some(watch))
    }

    fn exited(&self) -> bool {
        // SAFETY: getppid and kill(pid, 0) only query process liveness.
        unsafe { libc::getppid() as u32 != self.0 || libc::kill(self.0 as libc::pid_t, 0) != 0 }
    }
}

#[cfg(unix)]
fn reap_children() {
    // Reap any orphaned grandchildren reparented to this supervisor so zombies cannot block family_is_empty.
    loop {
        let rc = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
        if rc <= 0 {
            break;
        }
    }
}

#[cfg(unix)]
fn grace_budget_ms() -> u64 {
    std::env::var("CODENOMAD_FIXTURE_GRACE_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&ms| ms >= 50 && ms <= 2000)
        .unwrap_or(400)
}

#[cfg(unix)]
fn prepare_pid_fd() -> io::Result<Option<libc::c_int>> {
    let Some(raw) = std::env::var_os("CODENOMAD_FIXTURE_PID_FD") else {
        return Ok(None);
    };
    let fd: libc::c_int = raw
        .to_string_lossy()
        .parse()
        .map_err(|_| io::Error::other("Invalid CODENOMAD_FIXTURE_PID_FD"))?;
    if fd <= 2 {
        return Err(io::Error::other("Invalid CODENOMAD_FIXTURE_PID_FD"));
    }
    // SAFETY: mark the private PID descriptor CLOEXEC before spawning so the child never inherits it.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(Some(fd))
}

fn write_pid_file(path: &PathBuf, pid: u32) -> io::Result<()> {
    let mut tmp = OsString::from(path.as_os_str());
    tmp.push(".tmp");
    let tmp_path = PathBuf::from(tmp);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)?;
    writeln!(file, "CODENOMAD_FIXTURE_PID={pid}")?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp_path, path)
}

fn report_pid(pid: u32, pid_file: Option<&PathBuf>, #[cfg(unix)] pid_fd: Option<libc::c_int>) {
    if let Some(path) = pid_file {
        let _ = write_pid_file(path, pid);
        return;
    }
    #[cfg(unix)]
    if let Some(fd) = pid_fd {
        let line = format!("CODENOMAD_FIXTURE_PID={pid}\n");
        let bytes = line.as_bytes();
        let mut written = 0;
        while written < bytes.len() {
            // SAFETY: fd is an open private pipe inherited from the launcher and marked CLOEXEC.
            let n =
                unsafe { libc::write(fd, bytes[written..].as_ptr().cast(), bytes.len() - written) };
            if n <= 0 {
                break;
            }
            written += n as usize;
        }
        unsafe {
            libc::close(fd);
        }
        return;
    }
    let mut stderr = io::stderr().lock();
    let _ = writeln!(stderr, "CODENOMAD_FIXTURE_PID={pid}");
    let _ = stderr.flush();
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(windows)]
fn probe_system_dir() -> io::Result<i32> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleW};
    let name: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
    // SAFETY: kernel32.dll is permanently loaded in every Win32 process.
    let module = unsafe { GetModuleHandleW(name.as_ptr()) };
    if module.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut buf = vec![0u16; 32768];
    // SAFETY: writing into our owned UTF-16 buffer of length buf.len().
    let len = unsafe { GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if len == 0 || len >= buf.len() {
        return Err(io::Error::last_os_error());
    }
    let dll_path = PathBuf::from(OsString::from_wide(&buf[..len]));
    let dir = dll_path
        .parent()
        .ok_or_else(|| io::Error::other("kernel32.dll path has no parent directory"))?;
    println!("{}", dir.to_string_lossy());
    Ok(0)
}

#[cfg(windows)]
fn probe_pid(pid: u32) -> io::Result<i32> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, GetLastError,
        STILL_ACTIVE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, WaitForSingleObject,
    };

    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: i32,
        peb_base_address: *mut core::ffi::c_void,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }
    type NtQueryInfoFn = unsafe extern "system" fn(
        windows_sys::Win32::Foundation::HANDLE,
        u32,
        *mut core::ffi::c_void,
        u32,
        *mut u32,
    ) -> i32;

    if pid == 0 {
        println!(r#"{{"status":"dead"}}"#);
        return Ok(0);
    }
    let mut has_sync = true;
    // SAFETY: read-only process handle query for the requested PID.
    let mut handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        has_sync = false;
        handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    }
    if handle.is_null() {
        let err = unsafe { GetLastError() };
        if err == ERROR_INVALID_PARAMETER {
            println!(r#"{{"status":"dead"}}"#);
        } else if err == ERROR_ACCESS_DENIED {
            println!(r#"{{"status":"unknown"}}"#);
        } else {
            println!(r#"{{"status":"unknown"}}"#);
        }
        return Ok(0);
    }
    struct HandleGuard(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let _guard = HandleGuard(handle);
    if has_sync {
        // SAFETY: zero-timeout wait checks signaled termination without colliding with exit code 259.
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == WAIT_OBJECT_0 {
            println!(r#"{{"status":"dead"}}"#);
            return Ok(0);
        }
        if wait != WAIT_TIMEOUT {
            println!(r#"{{"status":"unknown"}}"#);
            return Ok(0);
        }
    } else {
        let mut exit_code: u32 = 0;
        // SAFETY: fallback exit code check when PROCESS_SYNCHRONIZE is unavailable.
        if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
            println!(r#"{{"status":"unknown"}}"#);
            return Ok(0);
        }
        if exit_code != STILL_ACTIVE as u32 {
            println!(r#"{{"status":"dead"}}"#);
            return Ok(0);
        }
    }
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    // SAFETY: querying process timestamps into stack FILETIME structs.
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        println!(r#"{{"status":"unknown"}}"#);
        return Ok(0);
    }
    let ticks_100ns = ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);

    // Query native parent PID via ntdll!NtQueryInformationProcess(ProcessBasicInformation).
    let ppid_json = {
        let ntdll_wide: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
        // SAFETY: ntdll.dll is loaded in every Windows process.
        let ntdll = unsafe { GetModuleHandleW(ntdll_wide.as_ptr()) };
        let proc = if !ntdll.is_null() {
            unsafe { GetProcAddress(ntdll, b"NtQueryInformationProcess\0".as_ptr()) }
        } else {
            None
        };
        if let Some(func) = proc {
            let query: NtQueryInfoFn = unsafe { core::mem::transmute(func) };
            let mut pbi = ProcessBasicInformation {
                exit_status: 0,
                peb_base_address: core::ptr::null_mut(),
                affinity_mask: 0,
                base_priority: 0,
                unique_process_id: 0,
                inherited_from_unique_process_id: 0,
            };
            let mut ret_len: u32 = 0;
            // SAFETY: ProcessBasicInformation (0) writes into stack-allocated ProcessBasicInformation.
            let status = unsafe {
                query(
                    handle,
                    0,
                    (&mut pbi as *mut ProcessBasicInformation).cast(),
                    core::mem::size_of::<ProcessBasicInformation>() as u32,
                    &mut ret_len,
                )
            };
            if status >= 0 && pbi.inherited_from_unique_process_id <= u32::MAX as usize {
                format!("{}", pbi.inherited_from_unique_process_id)
            } else {
                "null".to_owned()
            }
        } else {
            "null".to_owned()
        }
    };

    let mut image_buf = vec![0u16; 32768];
    let mut image_len = image_buf.len() as u32;
    // SAFETY: querying Win32 image path into owned UTF-16 buffer.
    let exe =
        if unsafe { QueryFullProcessImageNameW(handle, 0, image_buf.as_mut_ptr(), &mut image_len) }
            != 0
            && (image_len as usize) < image_buf.len()
        {
            Some(
                OsString::from_wide(&image_buf[..image_len as usize])
                    .to_string_lossy()
                    .into_owned(),
            )
        } else {
            None
        };
    let exe_json = match exe {
        Some(path) => json_escape(&path),
        None => "null".to_owned(),
    };
    println!(
        r#"{{"status":"ok","ppid":{ppid_json},"startId":"{ticks_100ns}","createdAt":"{ticks_100ns}","exe":{exe_json}}}"#
    );
    Ok(0)
}

#[cfg(target_os = "macos")]
fn probe_pid(pid: u32) -> io::Result<i32> {
    let Ok(pid_i32) = i32::try_from(pid) else {
        println!(r#"{{"status":"dead"}}"#);
        return Ok(0);
    };
    if pid_i32 <= 0 {
        println!(r#"{{"status":"dead"}}"#);
        return Ok(0);
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let expected_size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: querying read-only proc_bsdinfo for pid_i32 into stack struct.
    let rc = unsafe {
        libc::proc_pidinfo(
            pid_i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            expected_size,
        )
    };
    if rc <= 0 {
        let err = io::Error::last_os_error().raw_os_error();
        if err == Some(libc::ESRCH) {
            println!(r#"{{"status":"dead"}}"#);
        } else {
            println!(r#"{{"status":"unknown"}}"#);
        }
        return Ok(0);
    }
    if rc != expected_size {
        println!(r#"{{"status":"unknown"}}"#);
        return Ok(0);
    }
    let ppid = info.pbi_ppid;
    let start_us = (info.pbi_start_tvsec as i128) * 1_000_000 + (info.pbi_start_tvusec as i128);
    let mut arg_mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid_i32];
    let mut arg_size: usize = 256 * 1024;
    let mut buf = vec![0u8; arg_size];
    let (exe_json, argv_json) = if unsafe {
        libc::sysctl(
            arg_mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut arg_size,
            std::ptr::null_mut(),
            0,
        )
    } == 0
        && arg_size > 0
    {
        if let Some((exec_path, argv)) =
            codenomad_host_process::procargs::parse_procargs2_exec_and_argv(
                &buf[..arg_size.min(buf.len())],
            )
        {
            let args_encoded: Vec<String> = argv.iter().map(|a| json_escape(a)).collect();
            (
                json_escape(&exec_path),
                format!("[{}]", args_encoded.join(",")),
            )
        } else {
            ("null".to_owned(), "null".to_owned())
        }
    } else {
        ("null".to_owned(), "null".to_owned())
    };
    println!(
        r#"{{"status":"ok","ppid":{ppid},"startId":"{start_us}","createdAt":"{start_us}","exe":{exe_json},"argv":{argv_json}}}"#
    );
    Ok(0)
}

#[cfg(target_os = "linux")]
fn probe_pid(pid: u32) -> io::Result<i32> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            println!(r#"{{"status":"dead"}}"#);
            return Ok(0);
        }
        Err(_) => {
            println!(r#"{{"status":"unknown"}}"#);
            return Ok(0);
        }
    };
    let Some(rparen) = stat.rfind(')') else {
        println!(r#"{{"status":"unknown"}}"#);
        return Ok(0);
    };
    let fields: Vec<&str> = stat[rparen + 1..].split_whitespace().collect();
    let (Some(ppid), Some(start_id)) = (
        fields.get(1).and_then(|v| v.parse::<i32>().ok()),
        fields.get(19),
    ) else {
        println!(r#"{{"status":"unknown"}}"#);
        return Ok(0);
    };
    let exe_json = std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|p| json_escape(&p.to_string_lossy()))
        .unwrap_or_else(|| "null".to_owned());
    let cwd_json = std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| json_escape(&p.to_string_lossy()))
        .unwrap_or_else(|| "null".to_owned());
    let argv_json = std::fs::read(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|bytes| {
            let mut parts: Vec<String> = bytes
                .split(|&b| b == 0)
                .map(|slice| String::from_utf8_lossy(slice).into_owned())
                .collect();
            while parts.last().is_some_and(String::is_empty) {
                parts.pop();
            }
            let encoded: Vec<String> = parts.iter().map(|a| json_escape(a)).collect();
            format!("[{}]", encoded.join(","))
        })
        .unwrap_or_else(|| "null".to_owned());
    println!(
        r#"{{"status":"ok","ppid":{ppid},"startId":{},"createdAt":{},"exe":{exe_json},"cwd":{cwd_json},"argv":{argv_json}}}"#,
        json_escape(start_id),
        json_escape(start_id)
    );
    Ok(0)
}

#[cfg(all(unix, not(target_os = "linux"), not(target_os = "macos")))]
fn probe_pid(_pid: u32) -> io::Result<i32> {
    println!(r#"{{"status":"unknown"}}"#);
    Ok(0)
}

fn run() -> io::Result<i32> {
    {
        let mut quick = std::env::args_os().skip(1);
        if let Some(first) = quick.next() {
            if first == "--probe-pid" {
                let raw = quick
                    .next()
                    .ok_or_else(|| io::Error::other("Expected PID after --probe-pid"))?;
                let pid: u32 = raw
                    .to_string_lossy()
                    .parse()
                    .map_err(|_| io::Error::other("Invalid PID for --probe-pid"))?;
                return probe_pid(pid);
            }
            #[cfg(windows)]
            if first == "--system-dir" {
                return probe_system_dir();
            }
        }
    }
    #[cfg(target_os = "linux")]
    unsafe {
        // Adopt orphaned grandchildren so waitpid reaps them and family_is_empty observes clean exit.
        if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(unix)]
    install_signal_handlers();
    let parent = ParentWatch::open()?;
    #[cfg(unix)]
    let pid_fd = prepare_pid_fd()?;
    // SAFETY: single-threaded process before spawning the child; clears the internal
    // supervisor variables so inherited Windows/Unix child environments never receive them.
    unsafe {
        std::env::remove_var("CODENOMAD_FIXTURE_PARENT_PID");
        std::env::remove_var("CODENOMAD_FIXTURE_PID_FD");
    }
    let mut args = std::env::args_os().skip(1).peekable();
    let mut inherit_console = false;
    let mut gate_stdin = false;
    let mut pid_file: Option<PathBuf> = None;
    while let Some(arg) = args.peek() {
        if arg == "--inherit-console" {
            inherit_console = true;
            args.next();
        } else if arg == "--gate-stdin" {
            gate_stdin = true;
            args.next();
        } else if arg == "--pid-file" {
            args.next();
            let path = args
                .next()
                .ok_or_else(|| io::Error::other("Expected path after --pid-file"))?;
            pid_file = Some(PathBuf::from(path));
        } else {
            break;
        }
    }
    if gate_stdin {
        #[cfg(unix)]
        {
            let mut pfd = libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            };
            loop {
                if STOP_REQUESTED.load(std::sync::atomic::Ordering::SeqCst)
                    || parent.as_ref().is_some_and(ParentWatch::exited)
                {
                    return Ok(1);
                }
                // SAFETY: poll on stdin descriptor 0 with a bounded 10ms timeout.
                let ready = unsafe { libc::poll(&mut pfd, 1, 10) };
                if ready > 0 {
                    let mut token = [0u8; 1];
                    // SAFETY: fd 0 is readable/closed; read exactly 1 byte into stack buffer.
                    let n = unsafe { libc::read(0, token.as_mut_ptr().cast(), 1) };
                    if n != 1 || token[0] != b'G' {
                        return Ok(1);
                    }
                    break;
                } else if ready < 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Ok(1);
                }
            }
        }
        #[cfg(not(unix))]
        {
            use std::io::Read;
            let mut token = [0u8; 1];
            let mut stdin = io::stdin().lock();
            if stdin.read(&mut token).unwrap_or(0) != 1 || token[0] != b'G' {
                return Ok(1);
            }
        }
    }
    let program = args
        .next()
        .ok_or_else(|| io::Error::other("Expected a fixture executable and its arguments"))?;
    let mut command = Command::new(program);
    #[cfg(unix)]
    let grace_ms = grace_budget_ms();
    command
        .args(args)
        .env_remove("CODENOMAD_FIXTURE_PARENT_PID")
        .env_remove("CODENOMAD_FIXTURE_PID_FD")
        .stdin(if gate_stdin {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    command.env(
        "CODENOMAD_FIXTURE_GRACE_MS",
        (grace_ms / 4).max(50).to_string(),
    );
    let mut child = if inherit_console {
        OwnedProcess::spawn_inherited_console(&mut command, |pid| {
            #[cfg(unix)]
            report_pid(pid, pid_file.as_ref(), pid_fd);
            #[cfg(not(unix))]
            report_pid(pid, pid_file.as_ref());
        })?
    } else {
        OwnedProcess::spawn_inherited(&mut command, |pid| {
            #[cfg(unix)]
            report_pid(pid, pid_file.as_ref(), pid_fd);
            #[cfg(not(unix))]
            report_pid(pid, pid_file.as_ref());
        })?
    };
    #[cfg(target_os = "linux")]
    child.track_subreaper();
    #[cfg(all(unix, not(target_os = "linux")))]
    let mut sample_ticks: u32 = 0;
    let pause = Duration::from_millis(10);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        #[cfg(unix)]
        if STOP_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
            break None;
        }
        if parent.as_ref().is_some_and(ParentWatch::exited) {
            break None;
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            sample_ticks = sample_ticks.wrapping_add(1);
            if sample_ticks % 20 == 1 {
                child.refresh_descendants();
            }
        }
        sleep(pause);
    };
    if status.is_none() || !child.family_is_empty()? {
        let total_deadline = Instant::now() + Duration::from_secs(5);
        #[cfg(unix)]
        {
            // Nested supervisors receive a strictly shorter grace window so inner groups escalate before outer SIGKILL.
            child.request_terminate()?;
            let grace_until =
                (Instant::now() + Duration::from_millis(grace_ms)).min(total_deadline);
            while Instant::now() < grace_until {
                let _ = child.try_wait();
                reap_children();
                if child.family_is_empty()? {
                    break;
                }
                sleep(pause);
            }
        }
        while !child.family_is_empty()? {
            let _ = child.terminate();
            let _ = child.try_wait();
            #[cfg(unix)]
            reap_children();
            if child.family_is_empty()? {
                break;
            }
            if Instant::now() >= total_deadline {
                std::mem::forget(child);
                eprintln!("Fixture job: did not finish terminating");
                return Ok(86);
            }
            sleep(pause);
        }
    }
    Ok(status.and_then(|value| value.code()).unwrap_or(1))
}

fn main() {
    std::process::exit(run().unwrap_or_else(|error| {
        eprintln!("Fixture job: {error}");
        1
    }));
}
