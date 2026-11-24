//! Run a fixture with inherited stdio and contain its entire process family.
use codenomad_host_process::OwnedProcess;
use std::{
    io,
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

fn run() -> io::Result<i32> {
    #[cfg(unix)]
    install_signal_handlers();
    let parent = ParentWatch::open()?;
    // SAFETY: single-threaded process before spawning the child; clears the internal
    // supervisor variable so inherited Windows/Unix child environments never receive it.
    unsafe { std::env::remove_var("CODENOMAD_FIXTURE_PARENT_PID") };
    let mut args = std::env::args_os().skip(1).peekable();
    let inherit_console = args.peek().is_some_and(|arg| arg == "--inherit-console");
    if inherit_console {
        args.next();
    }
    let program = args
        .next()
        .ok_or_else(|| io::Error::other("Expected a fixture executable and its arguments"))?;
    let mut command = Command::new(program);
    command
        .args(args)
        .env_remove("CODENOMAD_FIXTURE_PARENT_PID")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut child = if inherit_console {
        OwnedProcess::spawn_inherited_console(&mut command, |pid| {
            eprintln!("CODENOMAD_FIXTURE_PID={pid}")
        })?
    } else {
        OwnedProcess::spawn_inherited(&mut command, |pid| eprintln!("CODENOMAD_FIXTURE_PID={pid}"))?
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
        #[cfg(unix)]
        {
            // Give nested fixture supervisors enough time to stop their own subgroups before SIGKILL.
            child.request_terminate()?;
            let grace = Instant::now() + Duration::from_millis(800);
            while Instant::now() < grace {
                let _ = child.try_wait();
                if child.family_is_empty()? {
                    break;
                }
                sleep(pause);
            }
        }
        if !child.family_is_empty()? {
            child.terminate()?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child.family_is_empty()? {
            let _ = child.try_wait();
            if child.family_is_empty()? {
                break;
            }
            if Instant::now() >= deadline {
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
