//! Owned process containment for the native desktop host.
//!
//! Mirrors the desktop host's kill-on-close Windows job / POSIX process group.
//! Windows assigns the job as part of process creation. No process lookup
//! by name or PID enumeration participates in ownership.
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(unix)]
use std::process::{Child, Stdio};
use std::{
    io,
    process::{Command, ExitStatus},
};
#[cfg(windows)]
mod date;
#[cfg(unix)]
#[path = "date/unix.rs"]
mod date;
#[cfg(any(unix, test))]
#[path = "date/posix.rs"]
mod posix_date;
pub mod procargs;
mod second_launch;
#[cfg(unix)]
mod unix;
#[cfg(any(unix, test))]
mod unix_signal;
mod wake_lock;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use date::{local_clock, local_month_day};
pub use date::{local_date_time, local_time_zone};
pub use second_launch::LaunchCoordinator;
#[cfg(unix)]
use unix::Family;
pub use wake_lock::WakeLock;
#[cfg(windows)]
use windows::Family;

#[cfg(unix)]
pub fn local_clock(seconds: i64) -> Option<(i32, i32, i32, i32, i32)> {
    let time = libc::time_t::try_from(seconds).ok()?;
    let mut out = std::mem::MaybeUninit::<libc::tm>::uninit();
    // localtime_r writes the caller's buffer on success without sharing mutable calendar state.
    let local = unsafe {
        if libc::localtime_r(&time, out.as_mut_ptr()).is_null() {
            return None;
        }
        out.assume_init()
    };
    Some((
        local.tm_year + 1900,
        local.tm_mon + 1,
        local.tm_mday,
        local.tm_hour,
        local.tm_min,
    ))
}

pub struct OwnedProcess {
    #[cfg(unix)]
    child: Option<Child>,
    #[cfg(windows)]
    child: windows::Process,
    family: Family,
}
impl OwnedProcess {
    /// Start a managed backend with piped stdio and only the environment on `command`.
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        return windows::launch(command, None, false);
        #[cfg(unix)]
        {
            let envs: Vec<_> = command
                .get_envs()
                .filter_map(|(key, value)| Some((key.to_os_string(), value?.to_os_string())))
                .collect();
            Self::spawn_unix(
                command
                    .env_clear()
                    .envs(envs)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped()),
            )
        }
    }

    /// Start a fixture in the launcher's working directory, environment and stdio.
    pub fn spawn_inherited(command: &mut Command, started: impl FnOnce(u32)) -> io::Result<Self> {
        Self::spawn_inherited_with_console(command, false, started)
    }

    /// Start a fixture attached to the launcher's console (e.g. a headless ConPTY).
    pub fn spawn_inherited_console(
        command: &mut Command,
        started: impl FnOnce(u32),
    ) -> io::Result<Self> {
        Self::spawn_inherited_with_console(command, true, started)
    }

    fn spawn_inherited_with_console(
        command: &mut Command,
        inherit_console: bool,
        started: impl FnOnce(u32),
    ) -> io::Result<Self> {
        #[cfg(windows)]
        return windows::launch(command, Some(Box::new(started)), inherit_console);
        #[cfg(unix)]
        {
            let _ = inherit_console;
            let process = Self::spawn_unix(command)?;
            started(process.id());
            Ok(process)
        }
    }

    #[cfg(unix)]
    fn spawn_unix(command: &mut Command) -> io::Result<Self> {
        let marker = Family::prepare(command);
        let spawn_result = command.spawn();
        Family::cleanup_command(command, marker.as_ref());
        let mut child = spawn_result?;
        match Family::adopt(&mut child, marker) {
            Ok(family) => Ok(Self {
                child: Some(child),
                family,
            }),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }
    pub fn id(&self) -> u32 {
        #[cfg(unix)]
        return self.child.as_ref().map_or(0, Child::id);
        #[cfg(windows)]
        return self.child.id();
    }
    pub fn take_stdin(&mut self) -> Option<impl io::Write + Send + use<>> {
        #[cfg(unix)]
        return self.child.as_mut()?.stdin.take();
        #[cfg(windows)]
        return self.child.stdin.take();
    }
    pub fn take_stdout(&mut self) -> Option<impl io::Read + Send + use<>> {
        #[cfg(unix)]
        return self.child.as_mut()?.stdout.take();
        #[cfg(windows)]
        return self.child.stdout.take();
    }
    pub fn take_stderr(&mut self) -> Option<impl io::Read + Send + use<>> {
        #[cfg(unix)]
        return self.child.as_mut()?.stderr.take();
        #[cfg(windows)]
        return self.child.stderr.take();
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        #[cfg(unix)]
        return match self.child.as_mut() {
            Some(child) => {
                let status = child.try_wait()?;
                if status.is_some() {
                    self.family.mark_leader_reaped();
                }
                Ok(status)
            }
            None => Ok(None),
        };
        #[cfg(windows)]
        return self.child.try_wait();
    }
    #[cfg(target_os = "linux")]
    pub fn track_subreaper(&mut self) {
        self.family.track_subreaper();
    }
    #[cfg(unix)]
    pub fn refresh_descendants(&self) {
        self.family.sample_descendants();
    }
    /// Includes remaining owned descendants after the direct child has exited.
    pub fn family_is_empty(&self) -> io::Result<bool> {
        self.family.empty()
    }
    pub fn terminate(&mut self) -> io::Result<()> {
        self.family.terminate()
    }
    #[cfg(unix)]
    pub fn request_terminate(&mut self) -> io::Result<()> {
        self.family.signal_term()
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // The child is a direct Rust executable; the family handle owns only
        // this spawn, never an independently installed OpenCode daemon.
        if !self.family.empty().unwrap_or(false) {
            let _ = self.family.terminate();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        while std::time::Instant::now() < deadline {
            if matches!(self.try_wait(), Ok(Some(_)) | Err(_)) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        #[cfg(unix)]
        if let Some(mut child) = self.child.take() {
            // Transfer reaping off the host thread so a slow-exiting child never remains a zombie.
            let _ = std::thread::Builder::new()
                .name("codenomad-reaper".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

#[cfg(test)]
mod tests;
