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

/// Key of a remembered choice. Windows config identities are case-insensitive but each host folds
/// them differently (Electron: Unicode, Tauri: ASCII), and scope hashes must keep that historical
/// fold. The choices file is new, so its key folds Unicode case on Windows on both hosts
/// (idempotent over either host's identity) and a choice is shared even for paths such as
/// `C:\Users\Émile`. No folder depends on this key. Other platforms stay case-sensitive.
pub(crate) fn choice_key_for(config_identity: &str, windows: bool) -> String {
    let identity = if windows {
        config_identity.to_lowercase()
    } else {
        config_identity.to_string()
    };
    Sha256::digest(identity.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn choice_key(config_identity: &str) -> String {
    choice_key_for(config_identity, cfg!(windows))
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

/// A remembered named profile must still exist for this configuration: both hosts create
/// `scopes/<scope>` under the userData base when they open a scoped profile (Electron's userData,
/// Tauri's client-state). A deleted one is ignored so detection runs again instead of silently
/// opening an empty profile. The default profile always exists. Mirrors Electron's
/// `rememberedProfileState`; both run the shared `rememberedProfileStates` vectors.
///
/// Unlike deletion, which never follows links, this check follows a symlink/junction: the hosts
/// open a relocated profile through it.
/// - `Present`: a folder, also through a link; an unreadable entry or any other error keeps the
///   choice.
/// - `Missing`: a definite absence of a plain entry (not found, not a directory). Detection reruns
///   and its result replaces the remembered choice.
/// - `Unavailable`: the entry is a link whose target is missing or not a folder, e.g. a
///   disconnected removable or network drive. Detection reruns for this launch only; the choice is
///   kept, so the profile is used again once its target returns.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RememberedProfileState {
    Present,
    Missing,
    Unavailable,
}

pub(crate) fn remembered_profile_state(
    key: &str,
    context: &TransitionContext,
) -> RememberedProfileState {
    remembered_profile_state_with(
        key,
        context,
        |path| fs::symlink_metadata(path).map(|metadata| metadata.file_type().is_symlink()),
        |path| fs::metadata(path).map(|metadata| metadata.is_dir()),
    )
}

/// `is_link` inspects the entry itself (symlink metadata); `is_directory` follows links.
pub(crate) fn remembered_profile_state_with(
    key: &str,
    context: &TransitionContext,
    is_link: impl Fn(&Path) -> std::io::Result<bool>,
    is_directory: impl Fn(&Path) -> std::io::Result<bool>,
) -> RememberedProfileState {
    use RememberedProfileState::*;
    if key == DEFAULT_PROFILE_KEY {
        return Present;
    }
    let scope = profile_scope(key, &context.config_identity, &context.default_identity);
    if !scope.scoped {
        return Present;
    }
    let absent = |error: &std::io::Error| {
        matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        )
    };
    let path = context.user_data_base.join("scopes").join(scope.scope_name);
    let unusable = match is_link(&path) {
        Ok(true) => Unavailable,
        Ok(false) => Missing,
        Err(error) if absent(&error) => return Missing,
        Err(_) => return Present,
    };
    match is_directory(&path) {
        Ok(true) => Present,
        Ok(false) => unusable,
        Err(error) if absent(&error) => unusable,
        Err(_) => Present,
    }
}

fn remembered_key(directory: &Path, context: &TransitionContext) -> Option<String> {
    let choices = read_choices(directory).choices();
    let key = parse_profile_name(
        choices
            .get(&choice_key(&context.config_identity))?
            .as_str()?,
    )
    .ok()?;
    (remembered_profile_state(&key, context) == RememberedProfileState::Present).then_some(key)
}

/// Stores the profile name (never a path); a valid existing choice for this config is never replaced,
/// unless it names a profile that is definitely missing for this config (an unavailable linked
/// profile keeps its choice, so that launch is unremembered). Remembering is best effort: an
/// I/O failure (antivirus EPERM/EBUSY, full disk, read-only profile) only means the transition runs
/// again next launch, so it never prevents startup.
fn write_choice(directory: &Path, context: &TransitionContext, key: &str) -> bool {
    match try_write_choice(directory, context, key) {
        Ok(stored) => stored,
        Err(error) => {
            eprintln!("[profile-transition] {error}");
            false
        }
    }
}

fn try_write_choice(
    directory: &Path,
    context: &TransitionContext,
    key: &str,
) -> Result<bool, String> {
    let file = read_choices(directory);
    if file == ChoicesFile::Future {
        return Ok(false);
    }
    let mut choices = file.choices();
    let id = choice_key(&context.config_identity);
    let existing_is_kept = choices
        .get(&id)
        .and_then(Value::as_str)
        .and_then(|name| parse_profile_name(name).ok())
        .is_some_and(|existing| {
            remembered_profile_state(&existing, context) != RememberedProfileState::Missing
        });
    if existing_is_kept || (!choices.contains_key(&id) && choices.len() >= MAX_CHOICES) {
        return Ok(false);
    }
    choices.insert(id, Value::String(profile_display_name(key).to_string()));
    write_choices_file(directory, choices)
        .map(|_| true)
        .map_err(|error| format!("failed to remember the profile choice: {error}"))
}

/// Atomic replacement: exclusive temporary file, fsync, rename.
fn write_choices_file(directory: &Path, choices: Map<String, Value>) -> Result<(), String> {
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
    result.map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ForgetOutcome {
    Updated,
    Unchanged,
    Busy,
    Failed,
}

pub(crate) struct ForgottenChoices<'a> {
    /// Forgotten for every configuration.
    pub(crate) names: &'a [String],
    /// Forgotten only for one configuration: `(choice key, deleted profile name)`.
    pub(crate) entries: &'a [(String, String)],
}

/// Drops remembered choices that name deleted profiles, under the selection lock. A held lock
/// (a launch is choosing right now) leaves the file untouched; a newer or corrupt file is never
/// rewritten. The next launch for an affected config then runs the transition again. Mirrors
/// Electron's `forgetChoices`.
pub(crate) fn forget_choices(
    directory: &Path,
    forgotten: &ForgottenChoices,
    now: SystemTime,
) -> ForgetOutcome {
    if (forgotten.names.is_empty() && forgotten.entries.is_empty())
        || !directory.join(CHOICES_FILENAME).exists()
    {
        return ForgetOutcome::Unchanged;
    }
    let lock = match SelectionLock::try_acquire(directory, now) {
        Ok(Some(lock)) => lock,
        Ok(None) => return ForgetOutcome::Busy,
        Err(_) => return ForgetOutcome::Failed,
    };
    let ChoicesFile::Valid(choices) = read_choices(directory) else {
        lock.release();
        return ForgetOutcome::Unchanged;
    };
    let kept: Map<String, Value> = choices
        .iter()
        .filter(|(key, name)| {
            let Some(name) = name.as_str() else {
                return true;
            };
            !forgotten.names.iter().any(|forgotten| forgotten == name)
                && !forgotten
                    .entries
                    .iter()
                    .any(|(entry_key, entry_name)| entry_key == *key && entry_name == name)
        })
        .map(|(key, name)| (key.clone(), name.clone()))
        .collect();
    let outcome = if kept.len() == choices.len() {
        ForgetOutcome::Unchanged
    } else {
        match write_choices_file(directory, kept) {
            Ok(()) => ForgetOutcome::Updated,
            Err(error) => {
                eprintln!("[profile-transition] failed to forget deleted profile choices: {error}");
                ForgetOutcome::Failed
            }
        }
    };
    lock.release();
    outcome
}

/// Cross-process selection lock: exclusive create, kept alive by heartbeats, stolen only when stale.
/// When the lock cannot be used at all (I/O errors other than contention), detection, which is
/// read-only, proceeds without it: concurrent first launches may then each ask, and the first
/// remembered answer wins for later launches.
#[derive(Debug)]
pub(crate) struct SelectionLock {
    directory: PathBuf,
    /// `None` for an unguarded lock that owns no file.
    token: Option<String>,
    released: bool,
}

impl SelectionLock {
    /// A lock that guards nothing; used only when the lock file itself is unusable.
    fn unguarded(directory: &Path) -> Self {
        Self {
            directory: directory.to_path_buf(),
            token: None,
            released: false,
        }
    }

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
                    token: Some(token),
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
        // Accepted race (no cross-host primitive closes it): if a third launcher creates a new lock
        // between our rename and the restoring link, the link fails and two holders may both ask.
        // The outcome is bounded: the first remembered answer wins, the other applies to its launch.
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

    /// Keeps the lock fresh while a dialog blocks the calling thread. Dropping the guard stops and
    /// joins the thread, so no heartbeat thread outlives the question.
    pub(crate) fn start_heartbeat(&self) -> HeartbeatGuard {
        let stop = Arc::new(AtomicBool::new(false));
        let path = self.token.as_ref().map(|_| self.lock_path());
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                if let Some(Ok(handle)) = path
                    .as_ref()
                    .map(|path| OpenOptions::new().write(true).open(path))
                {
                    let _ = handle.set_modified(SystemTime::now());
                }
                std::thread::park_timeout(LOCK_HEARTBEAT);
            }
        });
        HeartbeatGuard {
            stop,
            thread: Some(thread),
        }
    }

    /// Records the user's answer while still holding the lock; false when it could not be remembered.
    pub(crate) fn commit(&self, context: &TransitionContext, key: &str) -> bool {
        write_choice(&self.directory, context, key)
    }

    pub(crate) fn release(mut self) {
        self.release_now();
    }

    fn release_now(&mut self) {
        if std::mem::replace(&mut self.released, true) {
            return;
        }
        let Some(token) = self.token.as_deref() else {
            return;
        };
        let path = self.lock_path();
        let owned = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| value["token"].as_str() == Some(token));
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

pub(crate) struct HeartbeatGuard {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

pub(crate) fn resolve_transition_profile(
    context: &TransitionContext,
    now: impl Fn() -> SystemTime,
    mut sleep: impl FnMut(Duration),
) -> Result<TransitionResult, String> {
    let directory = selection_directory(&context.user_data_base);
    if let Some(key) = remembered_key(&directory, context) {
        return Ok(TransitionResult::Resolved {
            key,
            reason: Reason::Remembered,
        });
    }
    let lock_usable = match fs::create_dir_all(&directory) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "[profile-transition] selection directory unavailable; continuing without remembering: {error}"
            );
            false
        }
    };
    // Concurrent first launches wait here: only the lock holder detects, asks and records.
    loop {
        let acquired = if lock_usable {
            SelectionLock::try_acquire(&directory, now()).unwrap_or_else(|error| {
                eprintln!("[profile-transition] selection lock unavailable; continuing unguarded: {error}");
                Some(SelectionLock::unguarded(&directory))
            })
        } else {
            Some(SelectionLock::unguarded(&directory))
        };
        let Some(lock) = acquired else {
            sleep(LOCK_POLL);
            if let Some(key) = remembered_key(&directory, context) {
                return Ok(TransitionResult::Resolved {
                    key,
                    reason: Reason::Remembered,
                });
            }
            continue;
        };
        if let Some(key) = remembered_key(&directory, context) {
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
        let stored = write_choice(&directory, context, &key);
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
