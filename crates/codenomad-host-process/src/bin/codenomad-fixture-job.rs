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

fn run() -> io::Result<i32> {
    #[cfg(windows)]
    let parent = ParentWatch::open()?;
    let mut args = std::env::args_os().skip(1);
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
    let mut child = OwnedProcess::spawn_inherited(&mut command, |pid| {
        eprintln!("CODENOMAD_FIXTURE_PID={pid}")
    })?;
    let pause = Duration::from_millis(10);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        #[cfg(windows)]
        if parent.as_ref().is_some_and(ParentWatch::exited) {
            break None;
        }
        sleep(pause);
    };
    if status.is_none() || !child.family_is_empty()? {
        child.terminate()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child.family_is_empty()? {
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
