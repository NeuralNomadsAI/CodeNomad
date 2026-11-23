//! Owned process containment for the native desktop host.
//!
//! Mirrors the desktop host's kill-on-close Windows job / POSIX process group.
//! A Windows child is suspended until it belongs to its job. No process lookup
//! by name or PID enumeration participates in ownership.
#![deny(unsafe_op_in_unsafe_fn)]

use std::{
    io,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus},
};
#[cfg(windows)]
mod date;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use date::{local_month_day, local_short_date_time};
#[cfg(unix)]
use unix::Family;
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
    child: Child,
    family: Family,
}
impl OwnedProcess {
    /// Spawn only after configuring this child's containment boundary.
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
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
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
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
