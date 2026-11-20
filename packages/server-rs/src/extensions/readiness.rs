//! Pruning Location preparation v1, backend side, after the reference
//! `opencode/desktop-plugin-readiness.ts` (`ownReadiness`): a fresh challenge
//! `<lease>.prepare/<nonce>.json` = `{version:1,nonce,lease,directory,expires}`
//! is answered by the daemon-loaded follower with `<nonce>.ack` (the same fields
//! plus `incarnation`) once it registered for that exact Location, and an owned
//! `<incarnation>.scope` record `{version:1,directory,incarnation}` beside the
//! lease. Missing proof fails closed within the five-second budget.

use crate::extensions::artifact;
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

pub const WAIT: Duration = Duration::from_secs(5);
const MAX_BYTES: u64 = 8_192;
const MAX_PENDING: usize = 32;
const EXPIRY: Duration = Duration::from_secs(15);
const UNSUPPORTED: &str = "Pruning Location readiness timed out or unsupported";

fn now_ms() -> i64 {
    crate::shared::now_ms() as i64
}
pub fn uuid(value: &str) -> bool {
    let groups: Vec<_> = value.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
fn lease_name(name: &str) -> bool {
    name.strip_suffix(".lease").is_some_and(uuid)
}
/// `isReadinessDirectory`: non-empty, at most 4,096 UTF-8 bytes, no NUL, POSIX or Win32 absolute.
pub fn readiness_directory(directory: &str) -> bool {
    let bytes = directory.as_bytes();
    let win32 =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/')
            || directory.starts_with("\\\\")
            || directory.starts_with("//");
    !directory.is_empty()
        && bytes.len() <= 4096
        && !directory.contains('\0')
        && (directory.starts_with('/') || directory.starts_with('\\') || win32)
}
fn keys(value: &Value) -> Vec<String> {
    let mut k: Vec<_> = value.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    k.sort();
    k
}
/// `request(value)`: version 1, UUID nonce, lease name, Location and a live integer deadline.
fn request(value: &Value) -> bool {
    let now = now_ms();
    value.is_object()
        && value["version"] == 1
        && value["nonce"].as_str().is_some_and(uuid)
        && value["lease"].as_str().is_some_and(lease_name)
        && value["directory"].as_str().is_some_and(readiness_directory)
        && value["expires"]
            .as_i64()
            .is_some_and(|e| e.abs() < (1 << 53) && e > now && e <= now + WAIT.as_millis() as i64)
}

fn plain_directory(path: &Path) -> Result<(), String> {
    artifact::directory_identity(path).map(|_| ()).ok_or_else(|| "Invalid readiness directory".into())
}
fn live_lease(lease: &Path) -> bool {
    let Ok(Some(meta)) = artifact::single_regular(lease) else { return false };
    let Ok(modified) = meta.modified() else { return false };
    let now = SystemTime::now();
    match now.duration_since(modified) {
        Ok(age) => age < EXPIRY,
        // Tolerates a filesystem timestamp up to one second ahead.
        Err(ahead) => ahead.duration() <= Duration::from_secs(1),
    }
}
fn read(path: &Path) -> Option<Value> {
    serde_json::from_slice(&artifact::read_bounded(path, MAX_BYTES).ok()??).ok()
}

/// Exclusive creation acquires cleanup ownership through the retained handle.
struct Owned(PathBuf, File);
impl Owned {
    fn create(path: PathBuf, content: &str) -> io::Result<Self> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        let owned = Owned(path, file.try_clone()?);
        file.write_all(content.as_bytes())?;
        Ok(owned)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        // A replacement at the same name keeps its own owner.
        if artifact::names(&self.1, &self.0) {
            let _ = fs::remove_file(&self.0);
        }
    }
}

/// One owner per backend pruning lease; `close` drains requests before the lease goes.
pub struct Owner {
    lease: PathBuf,
    created: Mutex<Option<artifact::Identity>>,
    pending: AtomicUsize,
    closed: AtomicBool,
}

struct Pending<'a>(&'a AtomicUsize);
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Owner {
    pub fn new(lease: PathBuf) -> Self {
        Owner { lease, created: Mutex::new(None), pending: AtomicUsize::new(0), closed: AtomicBool::new(false) }
    }
    fn folder(&self) -> PathBuf {
        let mut name = self.lease.as_os_str().to_owned();
        name.push(".prepare");
        name.into()
    }

    /// A fresh challenge for one caller-authorized Location; returns the echoed ACK.
    pub async fn prepare(&self, location: &str, deadline: tokio::time::Instant) -> Result<Value, String> {
        let expires_at = deadline.min(tokio::time::Instant::now() + WAIT);
        let check = || {
            if self.closed.load(Ordering::SeqCst) {
                return Err("Readiness lease closed".to_owned());
            }
            if tokio::time::Instant::now() >= expires_at { Err(UNSUPPORTED.to_owned()) } else { Ok(()) }
        };
        check()?;
        if self.pending.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            return Err("Too many readiness requests".into());
        }
        let _pending = Pending(&self.pending);
        let nonce = uuid::Uuid::new_v4().to_string();
        let lease = self.lease.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
        let expires = now_ms() + expires_at.saturating_duration_since(tokio::time::Instant::now()).as_millis() as i64;
        let value = json!({"version":1,"nonce":nonce,"lease":lease,"directory":location,"expires":expires});
        if !request(&value) {
            return Err("Invalid readiness Location".into());
        }
        // The reference's JSON.stringify field order.
        let content = format!(
            "{{\"version\":1,\"nonce\":{},\"lease\":{},\"directory\":{},\"expires\":{expires}}}",
            json!(nonce),
            json!(lease),
            json!(location)
        );
        if content.len() as u64 > MAX_BYTES {
            return Err("Readiness Location exceeds limit".into());
        }
        let folder = self.folder();
        plain_directory(self.lease.parent().ok_or("Invalid readiness directory")?)?;
        match fs::create_dir(&folder) {
            Ok(()) => *self.created.lock().unwrap() = artifact::directory_identity(&folder),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        plain_directory(&folder)?;
        if !live_lease(&self.lease) {
            return Err("Readiness lease expired".into());
        }
        check()?;
        let _owned = Owned::create(folder.join(format!("{nonce}.json")), &content).map_err(|e| e.to_string())?;
        let ack_file = folder.join(format!("{nonce}.ack"));
        loop {
            check()?;
            if !live_lease(&self.lease) {
                return Err("Readiness lease expired".into());
            }
            if let Some(ack) = read(&ack_file)
                && keys(&ack) == ["directory", "expires", "incarnation", "lease", "nonce", "version"]
                && request(&ack)
                && ack["incarnation"].as_str().is_some_and(uuid)
                && ["version", "nonce", "lease", "directory", "expires"].iter().all(|k| ack[k] == value[k])
            {
                let incarnation = ack["incarnation"].as_str().unwrap();
                let scope = self.lease.with_file_name(format!("{incarnation}.scope"));
                if let Some(scope) = read(&scope)
                    && keys(&scope) == ["directory", "incarnation", "version"]
                    && scope["version"] == 1
                    && scope["incarnation"] == incarnation
                    && scope["directory"] == location
                {
                    return Ok(ack);
                }
            }
            if now_ms() >= expires {
                return Err(UNSUPPORTED.into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Stops admission, joins pending requests, then removes our own empty folder.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for _ in 0..120 {
            if self.pending.load(Ordering::SeqCst) == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let folder = self.folder();
        let created = *self.created.lock().unwrap();
        if created.is_some() && artifact::directory_identity(&folder) == created {
            let _ = fs::remove_dir(&folder);
        }
    }
}

#[cfg(test)]
#[path = "readiness_tests.rs"]
mod tests;
