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

fn run() -> io::Result<i32> {
    #[cfg(target_os = "linux")]
    unsafe {
        // Adopt orphaned grandchildren so waitpid reaps them and family_is_empty observes clean exit.
        let _ = libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
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
        use std::io::Read;
        let mut token = [0u8; 1];
        let mut stdin = io::stdin().lock();
        if stdin.read(&mut token).unwrap_or(0) != 1 || token[0] != b'G' {
            return Ok(1);
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
        if !child.family_is_empty()? {
            child.terminate()?;
        }
        while !child.family_is_empty()? {
            let _ = child.try_wait();
            #[cfg(unix)]
            reap_children();
            if child.family_is_empty()? {
                break;
            }
            if Instant::now() >= total_deadline {
                std::mem::forget(child);
                return Err(io::Error::other("Fixture job did not finish terminating"));
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
