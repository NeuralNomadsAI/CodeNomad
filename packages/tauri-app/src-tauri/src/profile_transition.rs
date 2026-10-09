//! One-time transition for packaged launches without an explicit profile, mirrored by Electron's
//! `profile-transition.ts`. Older builds picked `dev`/`dev-v2` from their version label; we look
//! (read-only) for restorable client state in those profiles and the default one, ask only when
//! several qualify, and remember the result outside every profile. See
//! dev-docs/DESKTOP_DATA_PROFILES.md.
use crate::client_state::restorable_state_modified;
use crate::data_profile::{
    parse_profile_name, profile_display_name, profile_scope, DEFAULT_PROFILE_KEY,
    TRANSITION_PROFILE_KEYS,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub(crate) const SELECTION_DIRECTORY: &str = "profile-selection";
const CHOICES_FILENAME: &str = "choices.json";
const LOCK_FILENAME: &str = "choices.lock";
const CHOICES_VERSION: u64 = 1;
const MAX_CHOICES_BYTES: u64 = 64 * 1024;
const MAX_CHOICES: usize = 256;
pub(crate) const LOCK_HEARTBEAT: Duration = Duration::from_secs(2);
pub(crate) const LOCK_STALE: Duration = Duration::from_secs(15);
const LOCK_POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug)]
pub(crate) struct TransitionContext {
    pub(crate) config_identity: String,
    pub(crate) default_identity: String,
    /// `<appData>/CodeNomad`: parent of `scopes/` and of the selection directory.
    pub(crate) user_data_base: PathBuf,
    /// Default-profile client-state files in migration order (current shared file first).
    pub(crate) default_state_files: Vec<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Candidate {
    pub(crate) key: String,
    pub(crate) name: String,
    pub(crate) last_used: SystemTime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Reason {
    Remembered,
    None,
    Single,
    Unremembered,
}

#[derive(Debug)]
pub(crate) enum TransitionResult {
    Resolved {
        key: String,
        reason: Reason,
    },
    Ask {
        candidates: Vec<Candidate>,
        lock: SelectionLock,
    },
}

pub(crate) fn selection_directory(user_data_base: &Path) -> PathBuf {
    user_data_base.join(SELECTION_DIRECTORY)
}

pub(crate) fn profile_state_files(key: &str, context: &TransitionContext) -> Vec<PathBuf> {
    let scope = profile_scope(key, &context.config_identity, &context.default_identity);
    if scope.scoped {
        return vec![context
            .user_data_base
            .join("scopes")
            .join(scope.scope_name)
            .join("client-state")
            .join("client-state.json")];
    }
    // Legacy default files are migrated only while the current shared file does not exist.
    match context.default_state_files.split_first() {
        Some((current, _)) if current.exists() => vec![current.clone()],
        Some((_, legacy)) => legacy.to_vec(),
        None => Vec::new(),
    }
}

pub(crate) fn detect_candidates(context: &TransitionContext) -> Vec<Candidate> {
    let mut candidates = TRANSITION_PROFILE_KEYS
        .iter()
        .filter_map(|key| {
            let last_used = profile_state_files(key, context)
                .iter()
                .filter_map(|file| restorable_state_modified(file))
                .max()?;
            Some(Candidate {
                key: key.to_string(),
                name: profile_display_name(key).to_string(),
                last_used,
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.last_used.cmp(&left.last_used));
    candidates
}

pub(crate) fn choice_key(config_identity: &str) -> String {
    Sha256::digest(config_identity.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, PartialEq)]
pub(crate) enum ChoicesFile {
    Absent,
    Corrupt,
    Future,
    Valid(Map<String, Value>),
}

impl ChoicesFile {
    fn choices(&self) -> Map<String, Value> {
        match self {
            ChoicesFile::Valid(choices) => choices.clone(),
            _ => Map::new(),
        }
    }
}

pub(crate) fn read_choices(directory: &Path) -> ChoicesFile {
    let path = directory.join(CHOICES_FILENAME);
    let bytes = match fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ChoicesFile::Absent,
        Err(_) => return ChoicesFile::Corrupt,
        Ok(metadata) if metadata.len() > MAX_CHOICES_BYTES => return ChoicesFile::Corrupt,
        Ok(_) => match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ChoicesFile::Absent
            }
            Err(_) => return ChoicesFile::Corrupt,
        },
    };
    let Ok(Value::Object(value)) = serde_json::from_slice::<Value>(&bytes) else {
        return ChoicesFile::Corrupt;
    };
    match value.get("version").and_then(Value::as_u64) {
        Some(version) if version > CHOICES_VERSION => return ChoicesFile::Future,
        Some(CHOICES_VERSION) => {}
        _ => return ChoicesFile::Corrupt,
    }
    let Some(Value::Object(source)) = value.get("choices") else {
        return ChoicesFile::Corrupt;
    };
    let choices = source
        .iter()
        .take(MAX_CHOICES)
        .filter(|(key, name)| {
            key.len() == 64
                && key
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                && name
                    .as_str()
                    .is_some_and(|name| parse_profile_name(name).is_ok())
        })
        .map(|(key, name)| (key.clone(), name.clone()))
        .collect();
    ChoicesFile::Valid(choices)
}

fn remembered_key(directory: &Path, config_identity: &str) -> Option<String> {
    let choices = read_choices(directory).choices();
    parse_profile_name(choices.get(&choice_key(config_identity))?.as_str()?).ok()
}

/// Stores the profile name (never a path); a valid existing choice for this config is never replaced.
fn write_choice(directory: &Path, config_identity: &str, key: &str) -> Result<bool, String> {
    let file = read_choices(directory);
    if file == ChoicesFile::Future {
        return Ok(false);
    }
    let mut choices = file.choices();
    let id = choice_key(config_identity);
    if choices.contains_key(&id) || choices.len() >= MAX_CHOICES {
        return Ok(false);
    }
    choices.insert(id, Value::String(profile_display_name(key).to_string()));
    let content =
        serde_json::to_vec_pretty(&json!({ "version": CHOICES_VERSION, "choices": choices }))
            .map_err(|error| error.to_string())?;
    let temporary = directory.join(format!(
        ".{CHOICES_FILENAME}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        handle.write_all(&content)?;
        handle.write_all(b"\n")?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&temporary, directory.join(CHOICES_FILENAME))
    })();
    let _ = fs::remove_file(&temporary);
    result
        .map(|_| true)
        .map_err(|error| format!("failed to remember the profile choice: {error}"))
}

/// Cross-process selection lock: exclusive create, kept alive by heartbeats, stolen only when stale.
#[derive(Debug)]
pub(crate) struct SelectionLock {
    directory: PathBuf,
    token: String,
    released: bool,
}

impl SelectionLock {
    fn try_acquire(directory: &Path, now: SystemTime) -> Result<Option<Self>, String> {
        let path = directory.join(LOCK_FILENAME);
        let token = uuid::Uuid::new_v4().to_string();
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut handle) => {
                let content = json!({ "pid": std::process::id(), "token": token }).to_string();
                handle
                    .write_all(content.as_bytes())
                    .map_err(|error| error.to_string())?;
                return Ok(Some(Self {
                    directory: directory.to_path_buf(),
                    token,
                    released: false,
                }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "failed to create the profile selection lock: {error}"
                ))
            }
        }
        let modified = match fs::metadata(&path).and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if now.duration_since(modified).unwrap_or_default() <= LOCK_STALE {
            return Ok(None);
        }
        let Ok(observed) = fs::read(&path) else {
            return Ok(None);
        };
        // Move the stale lock aside atomically; restore it if a fresh holder replaced it meanwhile.
        let aside = directory.join(format!("{LOCK_FILENAME}.stale-{token}"));
        if fs::rename(&path, &aside).is_err() {
            return Ok(None);
        }
        if fs::read(&aside).ok().as_deref() != Some(observed.as_slice()) {
            let _ = fs::hard_link(&aside, &path);
        }
        let _ = fs::remove_file(&aside);
        Ok(None)
    }

    fn lock_path(&self) -> PathBuf {
        self.directory.join(LOCK_FILENAME)
    }

    /// Keeps the lock fresh while a dialog blocks the calling thread; stops when the guard drops.
    pub(crate) fn start_heartbeat(&self) -> HeartbeatGuard {
        let stop = Arc::new(AtomicBool::new(false));
        let path = self.lock_path();
        let thread_stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                if let Ok(handle) = OpenOptions::new().write(true).open(&path) {
                    let _ = handle.set_modified(SystemTime::now());
                }
                std::thread::sleep(LOCK_HEARTBEAT);
            }
        });
        HeartbeatGuard(stop)
    }

    /// Records the user's answer while still holding the lock.
    pub(crate) fn commit(&self, context: &TransitionContext, key: &str) -> Result<(), String> {
        write_choice(&self.directory, &context.config_identity, key).map(|_| ())
    }

    pub(crate) fn release(mut self) {
        self.release_now();
    }

    fn release_now(&mut self) {
        if std::mem::replace(&mut self.released, true) {
            return;
        }
        let path = self.lock_path();
        let owned = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| value["token"].as_str() == Some(self.token.as_str()));
        if owned {
            let _ = fs::remove_file(path);
        }
    }
}

impl Drop for SelectionLock {
    fn drop(&mut self) {
        self.release_now();
    }
}

pub(crate) struct HeartbeatGuard(Arc<AtomicBool>);

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(crate) fn resolve_transition_profile(
    context: &TransitionContext,
    now: impl Fn() -> SystemTime,
    mut sleep: impl FnMut(Duration),
) -> Result<TransitionResult, String> {
    let directory = selection_directory(&context.user_data_base);
    if let Some(key) = remembered_key(&directory, &context.config_identity) {
        return Ok(TransitionResult::Resolved {
            key,
            reason: Reason::Remembered,
        });
    }
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
    // Concurrent first launches wait here: only the lock holder detects, asks and records.
    loop {
        let Some(lock) = SelectionLock::try_acquire(&directory, now())? else {
            sleep(LOCK_POLL);
            if let Some(key) = remembered_key(&directory, &context.config_identity) {
                return Ok(TransitionResult::Resolved {
                    key,
                    reason: Reason::Remembered,
                });
            }
            continue;
        };
        if let Some(key) = remembered_key(&directory, &context.config_identity) {
            return Ok(TransitionResult::Resolved {
                key,
                reason: Reason::Remembered,
            });
        }
        let candidates = detect_candidates(context);
        if candidates.len() > 1 {
            return Ok(TransitionResult::Ask { candidates, lock });
        }
        let key = candidates
            .first()
            .map(|candidate| candidate.key.clone())
            .unwrap_or_else(|| DEFAULT_PROFILE_KEY.to_string());
        let stored = write_choice(&directory, &context.config_identity, &key)?;
        let reason = match (stored, candidates.is_empty()) {
            (false, _) => Reason::Unremembered,
            (true, true) => Reason::None,
            (true, false) => Reason::Single,
        };
        return Ok(TransitionResult::Resolved { key, reason });
    }
}

#[cfg(test)]
#[path = "profile_transition_tests.rs"]
mod tests;
