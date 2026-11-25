//! `memory/lock.ts` with `host-lifetime/process-identity.ts`: an atomically published,
//! populated `memory.lock/` directory beside the repository.
//!
//! Owner record: `{"pid","startIdentity","nonce","host","platform"}`. Process
//! generations: Linux boot ID and start ticks, Windows creation time in .NET ticks
//! (`win32:<ticks>`, what the reference reads through PowerShell, here through
//! `GetProcessTimes`). Other hosts, and an unavailable own identity, use a private
//! `memory-self:<uuid>` nonce exactly as the reference. The host name is
//! `COMPUTERNAME` on Windows (the reference reads `os.hostname()`): every process
//! sharing one repository is this binary, which reads the same value.

use super::model::{Code, MemoryError, Result, fail};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(30);
const STEP: Duration = Duration::from_millis(20);

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Live(String),
    Dead,
    Unknown,
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}
pub fn host() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length; gethostname NUL-terminates or truncates.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        if ok { String::from_utf8_lossy(&buf[..end]).into_owned() } else { String::new() }
    }
}

#[cfg(windows)]
fn lookup_native(pid: u32) -> State {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, GetLastError, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    // SAFETY: plain Win32 calls on a handle owned and closed here.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return if GetLastError() == ERROR_INVALID_PARAMETER { State::Dead } else { State::Unknown };
        }
        let mut code = 0u32;
        let mut times = [FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }; 4];
        let [created, exited, kernel, user] = &mut times;
        let state = if GetExitCodeProcess(handle, &mut code) == 0 {
            State::Unknown
        } else if code != STILL_ACTIVE as u32 {
            State::Dead
        } else if GetProcessTimes(handle, created, exited, kernel, user) == 0 {
            State::Unknown
        } else {
            let filetime = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            // .NET DateTime ticks: 100 ns since 0001-01-01; FILETIME counts from 1601-01-01.
            State::Live(format!("win32:{}", filetime + 504_911_232_000_000_000))
        };
        CloseHandle(handle);
        state
    }
}
#[cfg(target_os = "linux")]
fn lookup_native(pid: u32) -> State {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => s,
        Err(e) => {
            return if e.kind() == io::ErrorKind::NotFound { State::Dead } else { State::Unknown };
        }
    };
    let ticks = stat.rfind(')').and_then(|i| stat[i + 1..].split_whitespace().nth(19).map(str::to_owned));
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok().map(|b| b.trim().to_owned());
    match (ticks, boot) {
        (Some(t), Some(b)) if !t.is_empty() && !b.is_empty() => State::Live(format!("linux:{b}:{t}")),
        _ => State::Unknown,
    }
}
#[cfg(not(any(windows, target_os = "linux")))]
fn lookup_native(_pid: u32) -> State {
    State::Unknown
}

pub fn lookup(pid: i64) -> State {
    if pid <= 0 || pid > u32::MAX as i64 { State::Unknown } else { lookup_native(pid as u32) }
}

/// `process.kill(pid, 0)` answering ESRCH: a confirmed absence.
pub(crate) fn confirmed_absent(pid: i64) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only probes existence.
        pid > 0
            && pid <= i32::MAX as i64
            && unsafe { libc::kill(pid as i32, 0) } != 0
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        lookup(pid) == State::Dead
    }
}

fn self_state() -> &'static str {
    static SELF: OnceLock<String> = OnceLock::new();
    SELF.get_or_init(|| match lookup(std::process::id() as i64) {
        State::Live(identity) => identity,
        _ => format!("memory-self:{}", uuid::Uuid::new_v4()),
    })
}

fn owner_state(owner: &Value, local: &dyn Fn(i64) -> State) -> &'static str {
    let pid = owner["pid"].as_i64().unwrap_or(0);
    match &owner["startIdentity"] {
        Value::String(identity) => match local(pid) {
            State::Live(found) if &found == identity => "live",
            State::Live(found) if found.starts_with("memory-self:") || identity.starts_with("memory-self:") => {
                "unknown"
            }
            State::Live(_) => "dead",
            State::Dead => "dead",
            State::Unknown => "unknown",
        },
        _ => {
            if local(pid) == State::Dead {
                "dead"
            } else {
                "unknown"
            }
        }
    }
}
fn valid_owner(owner: &Value) -> bool {
    owner["pid"].as_i64().is_some_and(|p| p >= 1 && p <= 9_007_199_254_740_991)
        && owner["pid"].is_i64()
        && match &owner["startIdentity"] {
            Value::Null => owner.get("startIdentity").is_none(),
            Value::String(s) => !s.is_empty() && s.encode_utf16().count() <= 512,
            _ => false,
        }
}
fn nonce_name(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
}
fn sharing(e: &io::Error) -> bool {
    if matches!(e.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy) {
        return true;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};
        matches!(e.raw_os_error(), Some(code) if code == ERROR_SHARING_VIOLATION as i32 || code == ERROR_LOCK_VIOLATION as i32)
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn conflict(message: &'static str) -> MemoryError {
    fail(Code::Conflict, message)
}

/// `pruneRecoveryMarkers`: after publication, before admitting the writer.
fn prune(lock: &Path, local: &dyn Fn(i64) -> State) -> io::Result<()> {
    let parent = lock.parent().ok_or_else(|| io::Error::other("no parent"))?;
    let base = lock.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::other("name"))?.to_owned();
    let names: Vec<String> = fs::read_dir(parent)?.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    for name in names.iter().filter(|n| n.strip_prefix(&format!("{base}.")).is_some_and(nonce_name)) {
        let directory = parent.join(name);
        let check = (|| -> io::Result<bool> {
            let info = fs::symlink_metadata(&directory)?;
            if !info.is_dir() || info.file_type().is_symlink() {
                return Ok(false);
            }
            let owner: Value =
                serde_json::from_str(&fs::read_to_string(directory.join("owner"))?).map_err(io::Error::other)?;
            if owner["nonce"].as_str() != Some(&name[base.len() + 1..])
                || !valid_owner(&owner)
                || owner["host"].as_str() != Some(&host())
                || owner["platform"].as_str() != Some(platform())
            {
                return Ok(false);
            }
            Ok(owner_state(&owner, local) == "dead")
        })();
        match check {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Ok(()),
        }
    }
    for name in &names {
        let Some(rest) = name.strip_prefix(&format!("{base}.dead-")) else { continue };
        if !nonce_name(rest) {
            continue;
        }
        let directory = parent.join(name);
        let info = fs::symlink_metadata(&directory)?;
        if info.is_dir() && !info.file_type().is_symlink() {
            let _ = fs::remove_dir_all(&directory);
        }
    }
    Ok(())
}

pub struct Guard {
    lock: PathBuf,
    candidate: PathBuf,
    owner: String,
    released: bool,
}
impl Guard {
    /// The release: verify the nonce, retire the public name, then clean up privately.
    pub async fn release(mut self) -> Result<()> {
        self.released = true;
        let deadline = Instant::now() + WAIT;
        loop {
            let attempt = (|| -> io::Result<()> {
                if fs::read_to_string(self.lock.join("owner"))? != self.owner {
                    return Err(io::Error::other("ownership changed"));
                }
                fs::rename(&self.lock, &self.candidate)
            })();
            match attempt {
                Ok(()) => break,
                Err(e) if sharing(&e) && Instant::now() < deadline => tokio::time::sleep(STEP).await,
                Err(_) => return Err(fail(Code::Unreadable, "Memory repository lock could not be released")),
            }
        }
        for _ in 0..10 {
            if fs::remove_dir_all(&self.candidate).is_ok() || !self.candidate.exists() {
                break;
            }
            tokio::time::sleep(STEP).await;
        }
        Ok(())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        // A dropped guard (cancelled future) still retires its own lock.
        if !self.released
            && fs::read_to_string(self.lock.join("owner")).is_ok_and(|o| o == self.owner)
            && fs::rename(&self.lock, &self.candidate).is_ok()
        {
            let _ = fs::remove_dir_all(&self.candidate);
        }
    }
}

/// `lockMemoryRepository(directory, lookupProcess, signal)`.
pub async fn acquire(directory: &Path, cancel: Option<&CancellationToken>) -> Result<Guard> {
    let cancelled = || cancel.is_some_and(|c| c.is_cancelled());
    if cancelled() {
        return Err(fail(Code::Unreadable, "Memory request cancelled"));
    }
    let mut lock_name = directory.as_os_str().to_owned();
    lock_name.push(".lock");
    let lock = PathBuf::from(lock_name);
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut candidate_name = lock.as_os_str().to_owned();
    candidate_name.push(format!(".{nonce}"));
    let candidate = PathBuf::from(candidate_name);
    let identity = self_state().to_owned();
    let pid = std::process::id() as i64;
    // `JSON.stringify` key order (serde_json maps here sort their keys).
    let owner = super::store::ordered_json(&[
        ("pid", json!(pid)),
        ("startIdentity", json!(identity)),
        ("nonce", json!(nonce)),
        ("host", json!(host())),
        ("platform", json!(platform())),
    ]);
    let local = move |p: i64| -> State {
        if p == pid {
            return State::Live(self_state().to_owned());
        }
        if confirmed_absent(p) { State::Dead } else { lookup(p) }
    };
    let unavailable = |_| fail(Code::Unreadable, "Memory storage is unavailable");
    super::store::private_dir(&candidate, false).map_err(unavailable)?;
    let cleanup = |c: &Path| {
        let _ = fs::remove_dir_all(c);
    };
    if super::store::create_new(&candidate.join("owner"), owner.as_bytes()).is_err() {
        cleanup(&candidate);
        return Err(fail(Code::Unreadable, "Memory storage is unavailable"));
    }
    let deadline = Instant::now() + WAIT;
    let mut checked: Option<(String, Instant, &'static str)> = None;
    let outcome = loop {
        if cancelled() {
            break Err(fail(Code::Unreadable, "Memory request cancelled"));
        }
        if Instant::now() >= deadline {
            break Err(conflict("Memory repository is busy"));
        }
        if fs::rename(&candidate, &lock).is_ok() {
            let _ = prune(&lock, &local);
            break Ok(Guard {
                lock: lock.clone(),
                candidate: candidate.clone(),
                owner: owner.clone(),
                released: false,
            });
        }
        let inspected = (|| -> std::result::Result<(Value, String), io::Error> {
            let info = fs::symlink_metadata(&lock)?;
            if !info.is_dir() || info.file_type().is_symlink() {
                return Err(io::Error::other("Invalid lock"));
            }
            let text = fs::read_to_string(lock.join("owner"))?;
            let previous: Value = serde_json::from_str(&text).map_err(io::Error::other)?;
            if !valid_owner(&previous) || !previous["nonce"].as_str().is_some_and(nonce_name) {
                return Err(io::Error::other("Invalid owner"));
            }
            Ok((previous, text))
        })();
        let (previous, text) = match inspected {
            Ok(v) => v,
            Err(e) if e.kind() == io::ErrorKind::NotFound || sharing(&e) => {
                tokio::time::sleep(STEP).await;
                continue;
            }
            Err(_) => break Err(conflict("Memory repository lock is unavailable")),
        };
        if previous.get("host").is_some()
            && (previous["host"].as_str() != Some(&host()) || previous["platform"].as_str() != Some(platform()))
        {
            break Err(conflict("Memory repository owner is on another host"));
        }
        let nonce_seen = previous["nonce"].as_str().unwrap_or_default().to_owned();
        if checked.as_ref().is_none_or(|(n, at, _)| *n != nonce_seen || at.elapsed() >= Duration::from_secs(1)) {
            checked = Some((nonce_seen.clone(), Instant::now(), owner_state(&previous, &local)));
        }
        // The observed owner may have released (and a successor published) meanwhile.
        if fs::read_to_string(lock.join("owner")).ok().as_deref() != Some(text.as_str()) {
            continue;
        }
        let state = checked.as_ref().map(|c| c.2).unwrap_or("unknown");
        if state == "unknown" {
            break Err(conflict("Memory repository owner is unavailable"));
        }
        if state == "dead" {
            let mut tomb = lock.as_os_str().to_owned();
            tomb.push(format!(".dead-{nonce_seen}"));
            let _ = fs::rename(&lock, PathBuf::from(tomb));
        }
        if Instant::now() >= deadline {
            break Err(conflict("Memory repository is busy"));
        }
        tokio::time::sleep(STEP).await;
    };
    if outcome.is_err() {
        cleanup(&candidate);
    }
    outcome
}
