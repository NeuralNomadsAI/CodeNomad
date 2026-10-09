//! Lists and deletes the desktop data profiles other than the open one, mirrored by Electron's
//! `data-profile-cleanup.ts` (see dev-docs/DESKTOP_DATA_PROFILES.md). Both hosts enumerate the same
//! folders and apply the same in-use rules, because a profile can be open in either host. The
//! renderer only sends IDs returned by the listing: every deletion re-enumerates, re-validates and
//! rechecks activity here. Only direct children of known roots with the expected names are
//! removed, never through a symlink or junction, and never a root.
use crate::data_profile::{profile_display_name, profile_scope, DEFAULT_PROFILE_KEY};
use crate::identity::STABLE_IDENTIFIER;
use crate::profile_transition::{
    choice_key, forget_choices, selection_directory, ForgetOutcome, ForgottenChoices,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

const MAX_SCOPE_ENTRIES: usize = 512;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_SIZE_ENTRIES: usize = 20_000;
const MAX_SIZE_DEPTH: usize = 32;
const MAX_KEPT_REPORTED: usize = 32;
const MAX_KEY_LENGTH: usize = 200;
/// Default-profile children each host creates; anything else is kept and reported.
const DEFAULT_ELECTRON_DIRECTORIES: [&str; 1] = ["developer-mode-browser-v2"];
const DEFAULT_ELECTRON_FILES: [&str; 1] = ["client-state.json"];
const DEFAULT_WEBVIEW_CHILDREN: [&str; 4] = ["developer-mode", "local", "remote", "browser"];
const ELECTRON_BOOKKEEPING: [&str; 8] = [
    "scopes",
    "profile-selection",
    "client-state.primary.lock",
    "client-state.registration.lock",
    "lockfile",
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
];
const TAURI_BOOKKEEPING: [&str; 4] = [
    "client-state.primary.lock",
    "client-state.registration.lock",
    "client-state.registration.owner",
    ".cross-host-election",
];
const MARKER_PREFIX: &str = "client-state.running.";

#[derive(Clone, Debug)]
pub(crate) struct ProfileRoots {
    /// `<appData>/CodeNomad`: Electron's default userData, parent of `scopes/` and `profile-selection/`.
    pub(crate) electron_base: PathBuf,
    /// `<localData>/ai.neuralnomads.codenomad.client-v2`: Tauri's default WebView data, parent of `scopes/`.
    pub(crate) webview_root: PathBuf,
    /// Parent of Tauri's app data directories (`<identifier>` and `<identifier>.scope.s<hash>`).
    pub(crate) tauri_data_parent: PathBuf,
    /// `~/.codenomad/client-state`: the default profile's shared client state (`v2/`) and legacy file.
    pub(crate) home_client_state: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct CurrentProfile {
    pub(crate) key: String,
    pub(crate) config_identity: String,
    pub(crate) default_identity: String,
}

struct ContextInner {
    roots: ProfileRoots,
    current: CurrentProfile,
    /// Operations run one at a time so a listing never observes a half-finished deletion.
    operation: Mutex<()>,
}

/// Managed state: fixed at startup from the resolved scope, never from renderer input.
#[derive(Clone)]
pub(crate) struct CleanupContext(Arc<ContextInner>);

impl CleanupContext {
    pub(crate) fn new(roots: ProfileRoots, current: CurrentProfile) -> Self {
        Self(Arc::new(ContextInner {
            roots,
            current,
            operation: Mutex::new(()),
        }))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProfileKind {
    Scope,
    Default,
    Orphan,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProfileStatus {
    Available,
    InUse,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtherProfile {
    pub(crate) id: String,
    pub(crate) kind: ProfileKind,
    pub(crate) name: String,
    pub(crate) other_configuration: bool,
    pub(crate) size_bytes: u64,
    pub(crate) size_complete: bool,
    pub(crate) status: ProfileStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtherProfilesListing {
    pub(crate) profiles: Vec<OtherProfile>,
    /// macOS only: Tauri keeps web storage in WebKit's store, shared by every scoped profile (one
    /// fixed data-store identifier) or WebKit's default store for the default profile. No profile
    /// owns it, so it is never deleted and the confirmation must say so.
    pub(crate) shared_web_kit_storage: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DeletionOutcome {
    Deleted,
    Incomplete,
    InUse,
    Unknown,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ProfileDeletion {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) outcome: DeletionOutcome,
    /// Paths of this profile that still exist afterwards.
    pub(crate) remaining: Vec<String>,
    /// Unrecognized default-profile entries that were deliberately left in place.
    pub(crate) kept: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct DeleteOtherProfilesResult {
    pub(crate) results: Vec<ProfileDeletion>,
    pub(crate) choices: ForgetOutcome,
}

pub(crate) struct Dependencies<'a> {
    pub(crate) pid_alive: &'a dyn Fn(u32) -> bool,
    pub(crate) now: &'a dyn Fn() -> SystemTime,
    /// Entries visited per profile when measuring its size.
    pub(crate) size_entries: usize,
    pub(crate) remove: &'a dyn Fn(&Path, bool) -> std::io::Result<()>,
    /// Host name compared with Chromium's POSIX `SingletonLock` target.
    pub(crate) hostname: &'a dyn Fn() -> Option<String>,
    pub(crate) macos: bool,
}

#[cfg(unix)]
fn system_hostname() -> Option<String> {
    let mut buffer = [0_u8; 256];
    // SAFETY: the buffer outlives the call and its length is passed; the result is NUL-terminated
    // or truncated, and only the bytes before the first NUL are read.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if result != 0 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0)?;
    String::from_utf8(buffer[..end].to_vec()).ok()
}

/// Chromium creates no `SingletonLock` on Windows; any such link there is unknown.
#[cfg(not(unix))]
fn system_hostname() -> Option<String> {
    None
}

fn remove_path(path: &Path, directory: bool) -> std::io::Result<()> {
    // remove_dir_all removes links (including junctions) without following them.
    if directory {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn system_time() -> SystemTime {
    SystemTime::now()
}

pub(crate) const SYSTEM: Dependencies<'static> = Dependencies {
    pid_alive: &crate::client_state::pid_is_alive,
    now: &system_time,
    size_entries: MAX_SIZE_ENTRIES,
    remove: &remove_path,
    hostname: &system_hostname,
    macos: cfg!(target_os = "macos"),
};

#[derive(Clone, Debug, PartialEq)]
struct Target {
    root: PathBuf,
    name: String,
    directory: bool,
}

impl Target {
    fn path(&self) -> PathBuf {
        self.root.join(&self.name)
    }
}

#[derive(Clone, Debug, Default)]
struct Probe {
    electron_data: Option<PathBuf>,
    election: Option<PathBuf>,
    tauri_data: Option<PathBuf>,
    webview: Option<PathBuf>,
}

struct Candidate {
    id: String,
    kind: ProfileKind,
    key: Option<String>,
    name: String,
    other_configuration: bool,
    targets: Vec<Target>,
    probe: Probe,
    kept_roots: Vec<(PathBuf, HashSet<String>)>,
}

/// `Some(entries)` (empty for a missing folder) or `None` when the folder cannot be read. Bounded;
/// shared roots such as `%APPDATA%` hold many unrelated entries, so callers filter before capping.
fn entries(directory: &Path) -> Option<Vec<String>> {
    match fs::read_dir(directory) {
        Ok(read) => Some(
            read.filter_map(Result::ok)
                .take(MAX_DIRECTORY_ENTRIES)
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect(),
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => Some(Vec::new()),
        Err(_) => None,
    }
}

fn plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

fn exists(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != ErrorKind::NotFound,
    }
}

/// `<key>-<16 hex>` with a key from the profile/alias alphabet.
fn parse_scope_name(name: &str) -> Option<(&str, &str)> {
    let (key, suffix) = name.rsplit_once('-')?;
    let valid_suffix = suffix.len() == 16
        && suffix
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    let valid_key = !key.is_empty()
        && key.len() <= MAX_KEY_LENGTH
        && key
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'));
    (valid_suffix && valid_key).then_some((key, suffix))
}

fn tauri_scope_prefix() -> String {
    format!("{STABLE_IDENTIFIER}.scope.s")
}

fn parse_tauri_scope(name: &str) -> Option<&str> {
    let suffix = name.strip_prefix(&tauri_scope_prefix())?;
    (suffix.len() == 16
        && suffix
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    .then_some(suffix)
}

/// Scope folders under a `scopes/` root; nothing is returned through a link.
fn scope_names(root: &Path) -> BTreeSet<String> {
    if !plain_directory(root) {
        return BTreeSet::new();
    }
    entries(root)
        .unwrap_or_default()
        .into_iter()
        .filter(|name| parse_scope_name(name).is_some() && plain_directory(&root.join(name)))
        .take(MAX_SCOPE_ENTRIES)
        .collect()
}

fn candidates(roots: &ProfileRoots, current: &CurrentProfile) -> Vec<Candidate> {
    let current_scope = profile_scope(
        &current.key,
        &current.config_identity,
        &current.default_identity,
    );
    let electron_scopes = roots.electron_base.join("scopes");
    let webview_scopes = roots.webview_root.join("scopes");
    let electron_names = scope_names(&electron_scopes);
    let webview_names = scope_names(&webview_scopes);
    let mut scopes: BTreeSet<String> = electron_names.union(&webview_names).cloned().collect();
    if current_scope.scoped {
        scopes.remove(&current_scope.scope_name);
    }
    let tauri_scopes: BTreeSet<String> = entries(&roots.tauri_data_parent)
        .unwrap_or_default()
        .iter()
        .filter_map(|name| {
            let suffix = parse_tauri_scope(name)?;
            plain_directory(&roots.tauri_data_parent.join(name)).then(|| suffix.to_string())
        })
        .take(MAX_SCOPE_ENTRIES)
        .collect();
    let mut claimed: HashSet<String> = HashSet::new();
    if current_scope.scoped {
        claimed.insert(current_scope.suffix.clone());
    }
    let mut result = Vec::new();
    for scope_name in &scopes {
        let (key, suffix) = parse_scope_name(scope_name).expect("validated scope name");
        claimed.insert(suffix.to_string());
        let tauri_name = format!("{}{suffix}", tauri_scope_prefix());
        let mut targets = Vec::new();
        if electron_names.contains(scope_name) {
            targets.push(Target {
                root: electron_scopes.clone(),
                name: scope_name.clone(),
                directory: true,
            });
        }
        if webview_names.contains(scope_name) {
            targets.push(Target {
                root: webview_scopes.clone(),
                name: scope_name.clone(),
                directory: true,
            });
        }
        if tauri_scopes.contains(suffix) {
            targets.push(Target {
                root: roots.tauri_data_parent.clone(),
                name: tauri_name.clone(),
                directory: true,
            });
        }
        let electron_data = electron_scopes.join(scope_name);
        result.push(Candidate {
            id: format!("scope:{scope_name}"),
            kind: ProfileKind::Scope,
            key: Some(key.to_string()),
            name: profile_display_name(key).to_string(),
            other_configuration: profile_scope(key, &current.config_identity, "").suffix != suffix,
            targets,
            probe: Probe {
                election: Some(electron_data.join("client-state").join("election")),
                electron_data: Some(electron_data),
                tauri_data: Some(roots.tauri_data_parent.join(&tauri_name)),
                webview: Some(webview_scopes.join(scope_name)),
            },
            kept_roots: Vec::new(),
        });
    }
    for suffix in &tauri_scopes {
        if claimed.contains(suffix) {
            continue;
        }
        let name = format!("{}{suffix}", tauri_scope_prefix());
        result.push(Candidate {
            id: format!("orphan:{suffix}"),
            kind: ProfileKind::Orphan,
            key: None,
            name: format!("s{suffix}"),
            other_configuration: false,
            targets: vec![Target {
                root: roots.tauri_data_parent.clone(),
                name: name.clone(),
                directory: true,
            }],
            probe: Probe {
                tauri_data: Some(roots.tauri_data_parent.join(name)),
                ..Probe::default()
            },
            kept_roots: Vec::new(),
        });
    }
    if current_scope.scoped {
        if let Some(candidate) = default_profile_candidate(roots, current) {
            result.insert(0, candidate);
        }
    }
    result
}

/// The default profile owns its roots' own children only; `scopes/` and the selection folder are never its data.
fn default_profile_candidate(roots: &ProfileRoots, current: &CurrentProfile) -> Option<Candidate> {
    let tauri_default = roots.tauri_data_parent.join(STABLE_IDENTIFIER);
    let shared_state = roots.home_client_state.join("v2");
    let target = |root: &Path, name: &str, directory: bool| Target {
        root: root.to_path_buf(),
        name: name.to_string(),
        directory,
    };
    let mut planned = Vec::new();
    planned.extend(
        DEFAULT_ELECTRON_DIRECTORIES
            .iter()
            .map(|name| target(&roots.electron_base, name, true)),
    );
    planned.extend(
        DEFAULT_ELECTRON_FILES
            .iter()
            .map(|name| target(&roots.electron_base, name, false)),
    );
    planned.push(target(&shared_state, "client-state.json", false));
    planned.push(target(&shared_state, "partitions", true));
    planned.push(target(&roots.home_client_state, "client-state.json", false));
    planned.extend(
        DEFAULT_WEBVIEW_CHILDREN
            .iter()
            .map(|name| target(&roots.webview_root, name, true)),
    );
    planned.push(target(&tauri_default, "client-state.json", false));
    let targets: Vec<Target> = planned
        .into_iter()
        .filter(|target| exists(&target.path()))
        .collect();
    if targets.is_empty() {
        return None;
    }
    let owned = |root: &Path| -> Vec<String> {
        targets
            .iter()
            .filter(|target| target.root == root)
            .map(|target| target.name.clone())
            .collect()
    };
    let ignore = |root: &Path, fixed: &[&str]| -> (PathBuf, HashSet<String>) {
        let mut names: HashSet<String> = fixed.iter().map(|name| name.to_string()).collect();
        names.extend(owned(root));
        (root.to_path_buf(), names)
    };
    let kept_roots = vec![
        ignore(&roots.electron_base, &ELECTRON_BOOKKEEPING),
        ignore(&roots.webview_root, &["scopes"]),
        ignore(&shared_state, &["election"]),
        ignore(&tauri_default, &TAURI_BOOKKEEPING),
    ];
    Some(Candidate {
        id: "default".to_string(),
        kind: ProfileKind::Default,
        key: Some(DEFAULT_PROFILE_KEY.to_string()),
        name: profile_display_name(DEFAULT_PROFILE_KEY).to_string(),
        other_configuration: current.config_identity != current.default_identity,
        targets,
        probe: Probe {
            electron_data: Some(roots.electron_base.clone()),
            election: Some(shared_state.join("election")),
            tauri_data: Some(tauri_default),
            webview: Some(roots.webview_root.clone()),
        },
        kept_roots,
    })
}

/// Entries of the default profile's roots that no host code identifies; reported, never deleted.
fn kept_entries(candidate: &Candidate) -> Vec<String> {
    let mut kept = Vec::new();
    for (root, ignore) in &candidate.kept_roots {
        for name in entries(root).unwrap_or_default() {
            if ignore.contains(&name)
                || name.starts_with(MARKER_PREFIX)
                || name.starts_with(".client-state.running.")
            {
                continue;
            }
            if kept.len() < MAX_KEPT_REPORTED {
                kept.push(root.join(name).to_string_lossy().into_owned());
            }
        }
    }
    kept
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Activity {
    Idle,
    InUse,
    Unknown,
}

fn combine(left: Activity, right: Activity) -> Activity {
    match (left, right) {
        (Activity::InUse, _) | (_, Activity::InUse) => Activity::InUse,
        (Activity::Unknown, _) | (_, Activity::Unknown) => Activity::Unknown,
        _ => Activity::Idle,
    }
}

fn pid_activity(pid: Option<u32>, dependencies: &Dependencies) -> Activity {
    match pid {
        Some(pid) if pid > 0 => {
            if (dependencies.pid_alive)(pid) {
                Activity::InUse
            } else {
                Activity::Idle
            }
        }
        _ => Activity::Unknown,
    }
}

fn owner_file_activity(path: &Path, dependencies: &Dependencies) -> Activity {
    match fs::read_to_string(path) {
        Ok(text) => pid_activity(
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| value["pid"].as_u64())
                .and_then(|pid| u32::try_from(pid).ok()),
            dependencies,
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => Activity::Idle,
        Err(_) => Activity::Unknown,
    }
}

/// Markers carry the owning PID in their name; a live PID (even a reused one) counts as in use.
fn marker_activity(directory: &Path, suffix: &str, dependencies: &Dependencies) -> Activity {
    let Some(names) = entries(directory) else {
        return Activity::Unknown;
    };
    names
        .iter()
        .filter_map(|name| name.strip_prefix(MARKER_PREFIX))
        .map(|rest| {
            let pid = rest
                .strip_suffix(suffix)
                .and_then(|value| value.split_once('.'))
                .filter(|(pid, token)| {
                    !pid.is_empty()
                        && pid.bytes().all(|byte| byte.is_ascii_digit())
                        && !token.is_empty()
                })
                .and_then(|(pid, _)| pid.parse::<u32>().ok());
            pid_activity(pid, dependencies)
        })
        .fold(Activity::Idle, combine)
}

/// Electron's `requestSingleInstanceLock()` runs while userData is still the profile folder
/// (Chromium storage moves to `developer-mode-browser-v2` only afterwards), so Chromium's process
/// singleton lives directly in the profile folder. Windows: `lockfile`, opened delete-on-close, so
/// it exists only while held. POSIX: `SingletonLock` is a (dangling) symlink to `<hostname>-<pid>`;
/// `SingletonSocket`/`SingletonCookie` carry no ownership. A lock of this host with a live PID is
/// in use, with a dead PID is stale; another host's lock or an unreadable one is unknown.
fn chromium_singleton_activity(directory: &Path, dependencies: &Dependencies) -> Activity {
    if exists(&directory.join("lockfile")) {
        return Activity::InUse;
    }
    let link = match fs::read_link(directory.join("SingletonLock")) {
        Ok(link) => link.to_string_lossy().into_owned(),
        Err(error) if error.kind() == ErrorKind::NotFound => return Activity::Idle,
        Err(_) => return Activity::Unknown,
    };
    let Some((host, pid)) = link.rsplit_once('-') else {
        return Activity::Unknown;
    };
    let pid = (!pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| pid.parse::<u32>().ok())
        .flatten();
    match pid {
        Some(pid) if !host.is_empty() && (dependencies.hostname)().as_deref() == Some(host) => {
            pid_activity(Some(pid), dependencies)
        }
        _ => Activity::Unknown,
    }
}

fn election_activity(directory: &Path, dependencies: &Dependencies) -> Activity {
    let owner = owner_file_activity(
        &directory.join("primary.owner.json").join("owner.json"),
        dependencies,
    );
    let Some(names) = entries(directory) else {
        return Activity::Unknown;
    };
    names
        .iter()
        .filter(|name| name.starts_with("participant.") && name.ends_with(".json"))
        .map(|name| owner_file_activity(&directory.join(name), dependencies))
        .fold(owner, combine)
}

/// Electron or Tauri may hold the profile: Electron markers/locks and Chromium singleton, the
/// cross-host election, Tauri markers and WebView2 locks.
fn probe_activity(probe: &Probe, dependencies: &Dependencies) -> Activity {
    let mut activity = Activity::Idle;
    if let Some(data) = &probe.electron_data {
        activity = combine(activity, marker_activity(data, ".json", dependencies));
        for lock in [
            "client-state.primary.lock",
            "client-state.registration.lock",
        ] {
            activity = combine(
                activity,
                owner_file_activity(&data.join(lock), dependencies),
            );
        }
        activity = combine(activity, chromium_singleton_activity(data, dependencies));
    }
    if let Some(election) = &probe.election {
        activity = combine(activity, election_activity(election, dependencies));
    }
    if let Some(data) = &probe.tauri_data {
        activity = combine(activity, marker_activity(data, ".lock", dependencies));
    }
    if let Some(webview) = &probe.webview {
        for nested in [
            webview.join("developer-mode").join("local"),
            webview.join("local"),
            webview.clone(),
        ] {
            if exists(&nested.join("EBWebView").join("lockfile")) {
                activity = combine(activity, Activity::InUse);
            }
        }
    }
    activity
}

/// Bounded walk over symlink metadata; links are counted as entries, never followed.
fn measure(targets: &[Target], limit: usize) -> (u64, bool) {
    let mut bytes = 0_u64;
    let mut budget = limit;
    let mut complete = true;
    let mut stack: Vec<(PathBuf, usize)> = targets
        .iter()
        .rev()
        .map(|target| (target.path(), 0))
        .collect();
    while let Some((path, depth)) = stack.pop() {
        if budget == 0 {
            complete = false;
            break;
        }
        budget -= 1;
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bytes += metadata.len();
            continue;
        }
        if depth >= MAX_SIZE_DEPTH {
            complete = false;
            continue;
        }
        match fs::read_dir(&path) {
            Ok(read) => {
                for entry in read.filter_map(Result::ok) {
                    stack.push((entry.path(), depth + 1));
                }
            }
            Err(_) => complete = false,
        }
    }
    (bytes, complete)
}

pub(crate) fn list_other_profiles(
    roots: &ProfileRoots,
    current: &CurrentProfile,
    dependencies: &Dependencies,
) -> OtherProfilesListing {
    let profiles = candidates(roots, current)
        .into_iter()
        .map(|candidate| {
            let (size_bytes, size_complete) =
                measure(&candidate.targets, dependencies.size_entries);
            OtherProfile {
                status: match probe_activity(&candidate.probe, dependencies) {
                    Activity::Idle => ProfileStatus::Available,
                    Activity::InUse => ProfileStatus::InUse,
                    Activity::Unknown => ProfileStatus::Unknown,
                },
                id: candidate.id,
                kind: candidate.kind,
                name: candidate.name,
                other_configuration: candidate.other_configuration,
                size_bytes,
                size_complete,
            }
        })
        .collect();
    OtherProfilesListing {
        profiles,
        shared_web_kit_storage: dependencies.macos,
    }
}

/// A target is removable only as a plain, link-free direct child of a link-free root with the planned name.
fn valid_target(target: &Target) -> bool {
    let path = target.path();
    let name_is_plain = !target.name.is_empty()
        && target.name != "."
        && target.name != ".."
        && !target.name.contains(['/', '\\']);
    if !name_is_plain
        || path.parent() != Some(target.root.as_path())
        || path.file_name().and_then(|name| name.to_str()) != Some(target.name.as_str())
        || !plain_directory(&target.root)
    {
        return false;
    }
    fs::symlink_metadata(&path).is_ok_and(|metadata| {
        !metadata.file_type().is_symlink()
            && if target.directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            }
    })
}

fn activity_outcome(activity: Activity) -> DeletionOutcome {
    if activity == Activity::InUse {
        DeletionOutcome::InUse
    } else {
        DeletionOutcome::Unknown
    }
}

fn delete_candidate(candidate: &Candidate, dependencies: &Dependencies) -> ProfileDeletion {
    let report = |outcome, remaining, kept| ProfileDeletion {
        id: candidate.id.clone(),
        name: candidate.name.clone(),
        outcome,
        remaining,
        kept,
    };
    let initial = probe_activity(&candidate.probe, dependencies);
    if initial != Activity::Idle {
        return report(activity_outcome(initial), Vec::new(), Vec::new());
    }
    let kept = if candidate.kind == ProfileKind::Default {
        kept_entries(candidate)
    } else {
        Vec::new()
    };
    let mut remaining = Vec::new();
    let mut stopped = None;
    for target in &candidate.targets {
        let path = target.path();
        // Recheck immediately before each removal: the profile may have been opened meanwhile.
        if stopped.is_none() {
            let activity = probe_activity(&candidate.probe, dependencies);
            if activity != Activity::Idle {
                stopped = Some(activity);
            }
        }
        if stopped.is_none() && valid_target(target) {
            if let Err(error) = (dependencies.remove)(&path, target.directory) {
                eprintln!(
                    "[data-profiles] failed to remove {}: {error}",
                    path.display()
                );
            }
        }
        if exists(&path) {
            remaining.push(path.to_string_lossy().into_owned());
        }
    }
    if remaining.is_empty() {
        return report(DeletionOutcome::Deleted, remaining, kept);
    }
    let outcome = match stopped {
        Some(activity) if remaining.len() == candidate.targets.len() => activity_outcome(activity),
        _ => DeletionOutcome::Incomplete,
    };
    report(outcome, remaining, kept)
}

fn keys_still_present(roots: &ProfileRoots) -> HashSet<String> {
    scope_names(&roots.electron_base.join("scopes"))
        .union(&scope_names(&roots.webview_root.join("scopes")))
        .filter_map(|name| parse_scope_name(name).map(|(key, _)| key.to_string()))
        .collect()
}

pub(crate) fn delete_other_profiles(
    roots: &ProfileRoots,
    current: &CurrentProfile,
    ids: &[String],
    dependencies: &Dependencies,
) -> DeleteOtherProfilesResult {
    let mut fresh: BTreeMap<String, Candidate> = candidates(roots, current)
        .into_iter()
        .map(|candidate| (candidate.id.clone(), candidate))
        .collect();
    let mut results = Vec::new();
    let mut deleted_keys = BTreeSet::new();
    let current_choice = choice_key(&current.config_identity);
    let mut current_entries: Vec<(String, String)> = Vec::new();
    for id in ids {
        let Some(candidate) = fresh.remove(id) else {
            results.push(ProfileDeletion {
                id: id.clone(),
                name: id.clone(),
                outcome: DeletionOutcome::Missing,
                remaining: Vec::new(),
                kept: Vec::new(),
            });
            continue;
        };
        let result = delete_candidate(&candidate, dependencies);
        if result.outcome == DeletionOutcome::Deleted && candidate.kind == ProfileKind::Scope {
            if let Some(key) = candidate.key.filter(|key| key != DEFAULT_PROFILE_KEY) {
                // The open configuration's choice key is known: a choice naming the profile just
                // deleted for it goes.
                if !candidate.other_configuration {
                    current_entries.push((
                        current_choice.clone(),
                        profile_display_name(&key).to_string(),
                    ));
                }
                deleted_keys.insert(key);
            }
        }
        results.push(result);
    }
    // Other configurations' keys cannot be mapped back to a scope: their choice of a name is
    // forgotten only when no folder of that profile remains for any configuration.
    let present = if deleted_keys.is_empty() {
        HashSet::new()
    } else {
        keys_still_present(roots)
    };
    let forgotten: Vec<String> = deleted_keys
        .into_iter()
        .filter(|key| !present.contains(key))
        .map(|key| profile_display_name(&key).to_string())
        .collect();
    let choices = forget_choices(
        &selection_directory(&roots.electron_base),
        &ForgottenChoices {
            names: &forgotten,
            entries: &current_entries,
        },
        (dependencies.now)(),
    );
    DeleteOtherProfilesResult { results, choices }
}

/// Only identifiers of the listing's shape are accepted from the renderer; duplicates collapse.
pub(crate) fn require_profile_ids(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.is_empty() || ids.len() > MAX_SCOPE_ENTRIES {
        return Err("Invalid profile list".to_string());
    }
    let mut unique = Vec::new();
    for id in ids {
        let valid = id == "default"
            || id
                .strip_prefix("scope:")
                .is_some_and(|name| parse_scope_name(name).is_some())
            || id.strip_prefix("orphan:").is_some_and(|suffix| {
                suffix.len() == 16
                    && suffix
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            });
        if !valid {
            return Err("Invalid profile identifier".to_string());
        }
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    Ok(unique)
}

fn run<T: Send + 'static>(
    context: &CleanupContext,
    operation: impl FnOnce(&ProfileRoots, &CurrentProfile) -> T + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let shared = Arc::clone(&context.0);
    async move {
        tauri::async_runtime::spawn_blocking(move || {
            let _serialized = shared
                .operation
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            operation(&shared.roots, &shared.current)
        })
        .await
        .map_err(|error| format!("Data profile operation failed: {error}"))
    }
}

#[tauri::command]
pub(crate) async fn data_profiles_list_others(
    webview: tauri::Webview,
    app_state: tauri::State<'_, crate::AppState>,
    context: tauri::State<'_, CleanupContext>,
) -> Result<OtherProfilesListing, String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    run(&context, |roots, current| {
        list_other_profiles(roots, current, &SYSTEM)
    })
    .await
}

#[tauri::command]
pub(crate) async fn data_profiles_delete_others(
    webview: tauri::Webview,
    app_state: tauri::State<'_, crate::AppState>,
    context: tauri::State<'_, CleanupContext>,
    ids: Vec<String>,
) -> Result<DeleteOtherProfilesResult, String> {
    crate::require_preferences_or_local_app_webview(&webview, &app_state)?;
    let ids = require_profile_ids(ids)?;
    run(&context, move |roots, current| {
        delete_other_profiles(roots, current, &ids, &SYSTEM)
    })
    .await
}

#[cfg(test)]
#[path = "data_profile_cleanup_tests.rs"]
mod tests;
