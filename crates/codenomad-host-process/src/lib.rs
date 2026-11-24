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
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use date::local_month_day;
pub use date::{local_date_time, local_time_zone};
#[cfg(unix)]
use unix::Family;
#[cfg(windows)]
use windows::Family;

pub struct OwnedProcess {
    #[cfg(unix)]
    child: Child,
    #[cfg(windows)]
    child: windows::Process,
    family: Family,
}
impl OwnedProcess {
    /// Start a managed backend with piped stdio and only the environment on `command`.
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        return windows::launch(command, None);
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
        #[cfg(windows)]
        return windows::launch(command, Some(Box::new(started)));
        #[cfg(unix)]
        {
            let process = Self::spawn_unix(command)?;
            started(process.id());
            Ok(process)
        }
    }

    #[cfg(unix)]
    fn spawn_unix(command: &mut Command) -> io::Result<Self> {
        Family::prepare(command);
        let mut child = command.spawn()?;
        match Family::adopt(&mut child) {
            Ok(family) => Ok(Self { child, family }),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }
    pub fn id(&self) -> u32 {
        self.child.id()
    }
    pub fn take_stdin(&mut self) -> Option<impl io::Write + Send + use<>> {
        self.child.stdin.take()
    }
    pub fn take_stdout(&mut self) -> Option<impl io::Read + Send + use<>> {
        self.child.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<impl io::Read + Send + use<>> {
        self.child.stderr.take()
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }
    /// Includes remaining owned descendants after the direct child has exited.
    pub fn family_is_empty(&self) -> io::Result<bool> {
        self.family.empty()
    }
    pub fn terminate(&mut self) -> io::Result<()> {
        self.family.terminate()
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // The child is a direct Rust executable; the family handle owns only
        // this spawn, never an independently installed OpenCode daemon.
        if !self.family.empty().unwrap_or(false) {
            let _ = self.family.terminate();
        }
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests;
