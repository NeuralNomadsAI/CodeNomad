use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", windows))]
use std::process::{Command, Stdio};
use std::sync::OnceLock;
#[cfg(any(target_os = "macos", windows))]
use std::time::{Duration, Instant};

const OWNER_DIRECTORY: &str = "primary.owner.json";
const OWNER_FILENAME: &str = "owner.json";
const PARTICIPANT_PREFIX: &str = "participant.";
const PARTICIPANT_SUFFIX: &str = ".json";
const RECOVERY_PREFIX: &str = "recovery.";
const RECOVERY_SUFFIX: &str = ".claim";
const RETIRED_PREFIX: &str = "retired.";
const RETIRED_PARTICIPANT_PREFIX: &str = "retired.participant.";
const RETIRED_PARTICIPANT_SUFFIX: &str = ".json";
const ACQUIRE_ATTEMPTS: usize = 10;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    pid: u32,
    run_token: String,
    process_start_identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    machine_identity: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyOwner {
    pid: u32,
    run_token: String,
    process_start_identity: Option<String>,
}

#[derive(Clone, Copy)]
enum LegacyElectronStatus {
    Clear,
    Blocked,
    PublishingParticipant,
}

pub(super) struct Registration {
    election_directory: PathBuf,
    participant_path: PathBuf,
    owner: Owner,
    legacy_electron_data: Option<PathBuf>,
    known_upgraded: RefCell<Vec<Owner>>,
    retry_candidate: Cell<bool>,
    primary: Cell<bool>,
    released: bool,
}

pub(super) fn election_directory() -> Result<PathBuf, String> {
    resolve_election_directory_for(
        std::env::consts::OS,
        |name| std::env::var_os(name),
        dirs::home_dir().as_deref(),
    )
    .map(PathBuf::from)
    .ok_or_else(|| "user home directory is unavailable".to_string())
}

pub(super) fn state_path() -> Result<PathBuf, String> {
    resolve_state_path_for(
        std::env::consts::OS,
        |name| std::env::var_os(name),
        dirs::home_dir().as_deref(),
    )
    .map(PathBuf::from)
    .ok_or_else(|| "user home directory is unavailable".to_string())
}

pub(super) fn legacy_electron_data_directory() -> Option<PathBuf> {
    resolve_legacy_electron_data_directory_for(
        std::env::consts::OS,
        |name| std::env::var_os(name),
        dirs::home_dir().as_deref(),
    )
    .map(PathBuf::from)
}

fn valid_home(value: OsString, platform: &str) -> Option<String> {
    let value = value.into_string().ok()?;
    let valid = if platform == "windows" {
        let bytes = value.as_bytes();
        (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
            || value.starts_with("\\\\")
    } else {
        value.starts_with('/')
    };
    valid.then_some(value)
}

fn configured_home(
    platform: &str,
    environment: &impl Fn(&str) -> Option<OsString>,
    fallback_home: Option<&Path>,
) -> Option<String> {
    let configured = if platform == "windows" {
        environment("USERPROFILE")
            .and_then(|value| valid_home(value, platform))
            .or_else(|| environment("HOME").and_then(|value| valid_home(value, platform)))
    } else {
        environment("HOME").and_then(|value| valid_home(value, platform))
    };
    configured.or_else(|| fallback_home.map(|path| path.to_string_lossy().into_owned()))
}

fn resolve_election_directory_for(
    platform: &str,
    environment: impl Fn(&str) -> Option<OsString>,
    fallback_home: Option<&Path>,
) -> Option<String> {
    let home = configured_home(platform, &environment, fallback_home)?;
    Some(if platform == "windows" {
        format!(
            "{}\\.codenomad\\client-state\\election",
            home.trim_end_matches(['\\', '/'])
        )
    } else {
        format!(
            "{}/.codenomad/client-state/election",
            home.trim_end_matches('/')
        )
    })
}

fn resolve_state_path_for(
    platform: &str,
    environment: impl Fn(&str) -> Option<OsString>,
    fallback_home: Option<&Path>,
) -> Option<String> {
    let home = configured_home(platform, &environment, fallback_home)?;
    Some(if platform == "windows" {
        format!(
            "{}\\.codenomad\\client-state\\client-state.json",
            home.trim_end_matches(['\\', '/'])
        )
    } else {
        format!(
            "{}/.codenomad/client-state/client-state.json",
            home.trim_end_matches('/')
        )
    })
}

fn resolve_legacy_electron_data_directory_for(
    platform: &str,
    environment: impl Fn(&str) -> Option<OsString>,
    fallback_home: Option<&Path>,
) -> Option<String> {
    let home = configured_home(platform, &environment, fallback_home)?;
    if platform == "windows" {
        let root = environment("APPDATA")
            .and_then(|value| valid_home(value, platform))
            .unwrap_or_else(|| format!("{}\\AppData\\Roaming", home.trim_end_matches(['\\', '/'])));
        Some(format!("{}\\CodeNomad", root.trim_end_matches(['\\', '/'])))
    } else if platform == "macos" {
        Some(format!(
            "{}/Library/Application Support/CodeNomad",
            home.trim_end_matches('/')
        ))
    } else {
        let root = environment("XDG_CONFIG_HOME")
            .and_then(|value| valid_home(value, platform))
            .unwrap_or_else(|| format!("{}/.config", home.trim_end_matches('/')));
        Some(format!("{}/CodeNomad", root.trim_end_matches('/')))
    }
}

impl Registration {
    pub(super) fn register(
        election_directory: &Path,
        primary_candidate: bool,
        legacy_electron_data: Option<&Path>,
    ) -> Result<Option<Self>, String> {
        let Some(current_identity) = process_start_identity(std::process::id()) else {
            return Ok(None);
        };
        let Some(machine_identity) = machine_identity() else {
            return Ok(None);
        };
        Self::register_with_legacy(
            election_directory,
            Owner {
                pid: std::process::id(),
                run_token: uuid::Uuid::new_v4().to_string(),
                process_start_identity: current_identity,
                machine_identity: Some(machine_identity),
            },
            primary_candidate,
            legacy_electron_data,
            pid_is_alive,
            process_start_identity,
            expected_electron_process,
        )
    }

    #[cfg(test)]
    fn register_with(
        election_directory: &Path,
        owner: Owner,
        primary_candidate: bool,
        pid_alive: impl Fn(u32) -> bool + Copy,
        identity: impl Fn(u32) -> Option<String> + Copy,
    ) -> Result<Option<Self>, String> {
        Self::register_with_legacy(
            election_directory,
            owner,
            primary_candidate,
            None,
            pid_alive,
            identity,
            |_| Some(false),
        )
    }

    fn register_with_legacy(
        election_directory: &Path,
        owner: Owner,
        primary_candidate: bool,
        legacy_electron_data: Option<&Path>,
        pid_alive: impl Fn(u32) -> bool + Copy,
        identity: impl Fn(u32) -> Option<String> + Copy,
        expected_electron: impl Fn(u32) -> Option<bool> + Copy,
    ) -> Result<Option<Self>, String> {
        if !valid_token(&owner.run_token)
            || owner.process_start_identity.is_empty()
            || owner
                .machine_identity
                .as_deref()
                .map_or(true, str::is_empty)
        {
            return Ok(None);
        }
        fs::create_dir_all(election_directory)
            .map_err(|err| format!("failed to create cross-host election directory: {err}"))?;
        let participant_path = participant_path(election_directory, &owner);
        publish_participant(&participant_path, &owner)?;
        let mut known_upgraded = Vec::new();

        let result = (|| {
            let legacy_status = legacy_electron_data
                .filter(|_| primary_candidate)
                .map(|path| {
                    legacy_electron_status_with(
                        path,
                        election_directory,
                        &mut known_upgraded,
                        pid_alive,
                        identity,
                        expected_electron,
                    )
                })
                .transpose()?
                .unwrap_or(LegacyElectronStatus::Clear);
            let primary =
                if primary_candidate && matches!(legacy_status, LegacyElectronStatus::Clear) {
                    acquire_owner(election_directory, &owner, pid_alive, identity)?
                } else {
                    false
                };
            let retry_candidate = primary_candidate
                && !primary
                && (legacy_electron_data.is_some() || !known_upgraded.is_empty());
            Ok(Some(Self {
                election_directory: election_directory.to_path_buf(),
                participant_path: participant_path.clone(),
                owner: owner.clone(),
                legacy_electron_data: legacy_electron_data.map(Path::to_path_buf),
                known_upgraded: RefCell::new(known_upgraded),
                retry_candidate: Cell::new(retry_candidate),
                primary: Cell::new(primary),
                released: false,
            }))
        })();
        if result.is_err() {
            let _ = remove_participant_if_owned(&participant_path, &owner);
            let _ = fs::remove_file(recovery_path(election_directory, &owner));
        }
        result
    }

    pub(super) fn is_primary(&self) -> bool {
        self.is_primary_with(
            pid_is_alive,
            process_start_identity,
            expected_electron_process,
        )
    }

    pub(super) fn ownership_valid(&self) -> bool {
        self.primary_with(
            false,
            pid_is_alive,
            process_start_identity,
            expected_electron_process,
        )
    }

    pub(super) fn retains_local_candidacy(&self) -> bool {
        !self.released && (self.primary.get() || self.retry_candidate.get())
    }

    pub(super) fn retain_local_candidacy(&self) {
        if !self.released {
            self.retry_candidate.set(true);
        }
    }

    pub(super) fn defer_primary(&self) {
        self.primary.set(false);
        self.retry_candidate.set(true);
        let _ = retire_owner_if_owned(&self.election_directory, &self.owner);
    }

    pub(super) fn defer_to_local_holder(&self) {
        if self.released {
            return;
        }
        let _ = remove_participant_if_owned(&self.participant_path, &self.owner);
        let _ = fs::remove_file(recovery_path(&self.election_directory, &self.owner));
    }

    fn is_primary_with(
        &self,
        pid_alive: impl Fn(u32) -> bool + Copy,
        identity: impl Fn(u32) -> Option<String> + Copy,
        expected_electron: impl Fn(u32) -> Option<bool> + Copy,
    ) -> bool {
        self.primary_with(true, pid_alive, identity, expected_electron)
    }

    fn primary_with(
        &self,
        retry: bool,
        pid_alive: impl Fn(u32) -> bool + Copy,
        identity: impl Fn(u32) -> Option<String> + Copy,
        expected_electron: impl Fn(u32) -> Option<bool> + Copy,
    ) -> bool {
        if self.released {
            return false;
        }
        if self.primary.get() {
            let shared = read_if_exists(&owner_path(&self.election_directory))
                .ok()
                .flatten()
                .and_then(|value| parse_owner(&value))
                .is_some_and(|owner| owner == self.owner);
            let legacy_clear = self
                .legacy_electron_data
                .as_deref()
                .map(|path| {
                    legacy_electron_status_with(
                        path,
                        &self.election_directory,
                        &mut self.known_upgraded.borrow_mut(),
                        pid_alive,
                        identity,
                        expected_electron,
                    )
                })
                .transpose()
                .map(|status| {
                    matches!(
                        status.unwrap_or(LegacyElectronStatus::Clear),
                        LegacyElectronStatus::Clear
                    )
                })
                .unwrap_or(false);
            if shared && legacy_clear {
                return true;
            }
            self.primary.set(false);
            self.retry_candidate.set(true);
            return false;
        }
        if !retry || !self.retry_candidate.get() {
            return false;
        }
        if publish_participant(&self.participant_path, &self.owner).is_err() {
            return false;
        }
        let _ = remove_retired_participant_if_owned(&self.election_directory, &self.owner);
        let legacy_status = self
            .legacy_electron_data
            .as_deref()
            .map(|path| {
                legacy_electron_status_with(
                    path,
                    &self.election_directory,
                    &mut self.known_upgraded.borrow_mut(),
                    pid_alive,
                    identity,
                    expected_electron,
                )
            })
            .transpose()
            .unwrap_or(Some(LegacyElectronStatus::Blocked))
            .unwrap_or(LegacyElectronStatus::Clear);
        if !matches!(legacy_status, LegacyElectronStatus::Clear) {
            return false;
        }
        let primary = acquire_owner(&self.election_directory, &self.owner, pid_alive, identity)
            .unwrap_or(false);
        self.retry_candidate.set(!primary);
        self.primary.set(primary);
        primary
    }

    pub(super) fn release(&mut self) -> Result<bool, String> {
        if self.released {
            return Ok(false);
        }
        retire_owner_if_owned(&self.election_directory, &self.owner)?;
        remove_participant_if_owned(&self.participant_path, &self.owner)?;
        remove_retired_participant_if_owned(&self.election_directory, &self.owner)?;
        match fs::remove_file(recovery_path(&self.election_directory, &self.owner)) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("failed to remove recovery claim: {err}")),
        }
        self.primary.set(false);
        self.released = true;
        Ok(true)
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Err(err) = self.release() {
            eprintln!("[client-state] failed to release cross-host registration: {err}");
        }
    }
}

fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn serialize_owner(owner: &Owner) -> Result<String, String> {
    serde_json::to_string(owner).map_err(|err| err.to_string())
}

fn parse_owner(value: &str) -> Option<Owner> {
    let owner = serde_json::from_str::<Owner>(value).ok()?;
    (owner.pid > 0 && valid_token(&owner.run_token) && !owner.process_start_identity.is_empty())
        .then_some(owner)
}

fn owner_path(directory: &Path) -> PathBuf {
    directory.join(OWNER_DIRECTORY).join(OWNER_FILENAME)
}

fn participant_path(directory: &Path, owner: &Owner) -> PathBuf {
    directory.join(format!(
        "{PARTICIPANT_PREFIX}{}.{}{PARTICIPANT_SUFFIX}",
        owner.pid, owner.run_token
    ))
}

fn recovery_path(directory: &Path, owner: &Owner) -> PathBuf {
    directory.join(format!(
        "{RECOVERY_PREFIX}{}.{}{RECOVERY_SUFFIX}",
        owner.pid, owner.run_token
    ))
}

fn retired_participant_path(directory: &Path, owner: &Owner) -> PathBuf {
    directory.join(format!(
        "{RETIRED_PARTICIPANT_PREFIX}{}.{}{RETIRED_PARTICIPANT_SUFFIX}",
        owner.pid, owner.run_token
    ))
}

fn read_if_exists(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!(
            "failed to read cross-host path {}: {err}",
            path.display()
        )),
    }
}

fn sync(file: &fs::File) -> std::io::Result<()> {
    match file.sync_all() {
        Ok(()) => Ok(()),
        Err(err) if is_unsupported_sync_error(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

fn publish_file(path: &Path, value: &str, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|err| format!("failed to create cross-host {label}: {err}"))?;
    temporary
        .write_all(value.as_bytes())
        .and_then(|_| sync(temporary.as_file()))
        .map_err(|err| format!("failed to write cross-host {label}: {err}"))?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if read_if_exists(path)?.as_deref() == Some(value) {
                Ok(())
            } else {
                Err(format!(
                    "cross-host {label} path belongs to another process"
                ))
            }
        }
        Err(err) => Err(format!(
            "failed to publish cross-host {label}: {}",
            err.error
        )),
    }
}

fn publish_participant(path: &Path, owner: &Owner) -> Result<(), String> {
    publish_file(path, &serialize_owner(owner)?, "participant")
}

fn publish_owner(directory: &Path, owner: &Owner) -> Result<bool, String> {
    let temporary = tempfile::Builder::new()
        .prefix(".owner.")
        .tempdir_in(directory)
        .map_err(|err| format!("failed to prepare cross-host owner: {err}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary.path().join(OWNER_FILENAME))
        .map_err(|err| format!("failed to prepare cross-host owner: {err}"))?;
    file.write_all(serialize_owner(owner)?.as_bytes())
        .and_then(|_| sync(&file))
        .map_err(|err| format!("failed to prepare cross-host owner: {err}"))?;
    drop(file);
    match fs::rename(temporary.path(), directory.join(OWNER_DIRECTORY)) {
        Ok(()) => {
            let _ = temporary.keep();
            Ok(true)
        }
        Err(err)
            if err.kind() == std::io::ErrorKind::AlreadyExists
                || directory.join(OWNER_DIRECTORY).exists() =>
        {
            Ok(false)
        }
        Err(err) => Err(format!("failed to publish cross-host owner: {err}")),
    }
}

fn acquire_owner(
    directory: &Path,
    owner: &Owner,
    pid_alive: impl Fn(u32) -> bool + Copy,
    identity: impl Fn(u32) -> Option<String> + Copy,
) -> Result<bool, String> {
    for _ in 0..ACQUIRE_ATTEMPTS {
        if publish_owner(directory, owner)? {
            return Ok(true);
        }
        let Some(observed) = read_if_exists(&owner_path(directory))? else {
            continue;
        };
        let Some(existing) = parse_owner(&observed) else {
            break;
        };
        if existing == *owner {
            return Ok(true);
        }
        if owner_is_stale(&existing, owner, pid_alive, identity) == Some(true) {
            publish_recovery_claim(directory, owner, &observed)?;
        }
        if !retire_owner(directory, &observed, &existing, owner, pid_alive, identity)? {
            break;
        }
    }
    Ok(false)
}

fn publish_recovery_claim(directory: &Path, owner: &Owner, observed: &str) -> Result<(), String> {
    let claim = recovery_path(directory, owner);
    if read_if_exists(&claim)?.as_deref() == Some(observed) {
        return Ok(());
    }
    match fs::remove_file(&claim) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("failed to replace recovery claim: {err}")),
    }
    publish_file(&claim, observed, "recovery claim")
}

fn owner_is_stale(
    owner: &Owner,
    local: &Owner,
    pid_alive: impl Fn(u32) -> bool,
    identity: impl Fn(u32) -> Option<String>,
) -> Option<bool> {
    let local_record = owner
        .machine_identity
        .as_ref()
        .zip(local.machine_identity.as_ref())
        .map(|(owner, local)| owner == local)
        .unwrap_or_else(|| legacy_owner_is_local(owner, local));
    if !local_record {
        return None;
    }
    if !pid_alive(owner.pid) {
        return Some(true);
    }
    identity(owner.pid).map(|live| live != owner.process_start_identity)
}

fn legacy_owner_is_local(owner: &Owner, local: &Owner) -> bool {
    fn linux_boot(identity: &str) -> Option<&str> {
        identity
            .strip_prefix("linux:")?
            .rsplit_once(':')
            .map(|value| value.0)
    }
    owner.machine_identity.is_none()
        && linux_boot(&owner.process_start_identity) == linux_boot(&local.process_start_identity)
        && linux_boot(&owner.process_start_identity).is_some()
}

fn participants(directory: &Path) -> Result<Vec<(PathBuf, Owner)>, String> {
    let mut participants = Vec::new();
    for entry in
        fs::read_dir(directory).map_err(|err| format!("failed to read participants: {err}"))?
    {
        let entry = entry.map_err(|err| format!("failed to read participant: {err}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PARTICIPANT_PREFIX) || !name.ends_with(PARTICIPANT_SUFFIX) {
            continue;
        }
        let Some(value) = read_if_exists(&entry.path())? else {
            continue;
        };
        let owner = parse_owner(&value)
            .ok_or_else(|| "cross-host participant is incomplete".to_string())?;
        participants.push((entry.path(), owner));
    }
    Ok(participants)
}

fn recovery_claimants(
    directory: &Path,
    current: &Owner,
    observed_owner: &str,
    pid_alive: impl Fn(u32) -> bool + Copy,
    identity: impl Fn(u32) -> Option<String> + Copy,
) -> Result<Option<Vec<Owner>>, String> {
    let mut claimants = vec![current.clone()];
    for (path, participant) in participants(directory)? {
        if participant == *current {
            continue;
        }
        if owner_is_stale(&participant, current, pid_alive, identity) == Some(true) {
            remove_participant_if_owned(&path, &participant)?;
            match fs::remove_file(recovery_path(directory, &participant)) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("failed to remove stale recovery claim: {err}")),
            }
            continue;
        }
        let claim_path = recovery_path(directory, &participant);
        let mut claim = read_if_exists(&claim_path)?;
        for _ in 0..20 {
            if claim.as_deref() == Some(observed_owner) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
            claim = read_if_exists(&claim_path)?;
        }
        if claim.as_deref() != Some(observed_owner) {
            return Ok(None);
        }
        claimants.push(participant);
    }
    Ok(Some(claimants))
}

fn retire_owner(
    directory: &Path,
    observed: &str,
    owner: &Owner,
    claimant: &Owner,
    pid_alive: impl Fn(u32) -> bool + Copy,
    identity: impl Fn(u32) -> Option<String> + Copy,
) -> Result<bool, String> {
    if owner_is_stale(owner, claimant, pid_alive, identity) != Some(true) {
        return Ok(false);
    }
    let Some(mut claimants) =
        recovery_claimants(directory, claimant, observed, pid_alive, identity)?
    else {
        return Ok(false);
    };
    claimants.sort_by_key(|candidate| serialize_owner(candidate).unwrap_or_default());
    if claimants.first() != Some(claimant)
        || read_if_exists(&owner_path(directory))?.as_deref() != Some(observed)
    {
        return Ok(false);
    }
    let retired = directory.join(format!("{RETIRED_PREFIX}{}.{}", owner.pid, owner.run_token));
    match fs::rename(directory.join(OWNER_DIRECTORY), &retired) {
        Ok(()) => Ok(true),
        Err(err)
            if err.kind() == std::io::ErrorKind::NotFound
                || err.kind() == std::io::ErrorKind::AlreadyExists
                || retired.exists() =>
        {
            Ok(false)
        }
        Err(err) => Err(format!("failed to retire stale cross-host owner: {err}")),
    }
}

fn remove_participant_if_owned(path: &Path, owner: &Owner) -> Result<(), String> {
    if read_if_exists(path)?
        .as_deref()
        .and_then(parse_owner)
        .as_ref()
        != Some(owner)
    {
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to remove cross-host participant: {err}")),
    }
}

fn remove_retired_participant_if_owned(directory: &Path, owner: &Owner) -> Result<(), String> {
    remove_participant_if_owned(&retired_participant_path(directory, owner), owner)
}

fn retire_owner_if_owned(directory: &Path, owner: &Owner) -> Result<(), String> {
    retire_owner_if_owned_with(directory, owner, || {}, || {})
}

fn retire_owner_if_owned_with(
    directory: &Path,
    owner: &Owner,
    on_checked: impl FnOnce(),
    on_retired: impl FnOnce(),
) -> Result<(), String> {
    let Some(observed) = read_if_exists(&owner_path(directory))? else {
        return Ok(());
    };
    if parse_owner(&observed).as_ref() != Some(owner) {
        return Ok(());
    }
    on_checked();
    if read_if_exists(&owner_path(directory))?.as_deref() != Some(&observed) {
        return Ok(());
    }
    let retired = directory.join(format!("{RETIRED_PREFIX}{}.{}", owner.pid, owner.run_token));
    match fs::rename(directory.join(OWNER_DIRECTORY), &retired) {
        Ok(()) => {}
        Err(err)
            if err.kind() == std::io::ErrorKind::NotFound
                || err.kind() == std::io::ErrorKind::AlreadyExists
                || retired.exists() =>
        {
            return Ok(());
        }
        Err(err) => return Err(format!("failed to retire owned cross-host owner: {err}")),
    }
    on_retired();
    let result: Result<(), String> = (|| {
        for entry in
            fs::read_dir(directory).map_err(|err| format!("failed to read participants: {err}"))?
        {
            let entry = entry.map_err(|err| format!("failed to read participant: {err}"))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(PARTICIPANT_PREFIX) || !name.ends_with(PARTICIPANT_SUFFIX) {
                continue;
            }
            let path = entry.path();
            let Some(observed_participant) = read_if_exists(&path)? else {
                continue;
            };
            if let Some(participant) = parse_owner(&observed_participant) {
                publish_file(
                    &retired_participant_path(directory, &participant),
                    &observed_participant,
                    "retired participant",
                )?;
                remove_participant_if_owned(&path, &participant)?;
                let _ = fs::remove_file(recovery_path(directory, &participant));
            } else if read_if_exists(&path)?.as_deref() == Some(&observed_participant) {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => {
                        return Err(format!(
                            "failed to remove malformed cross-host participant: {err}"
                        ))
                    }
                }
            }
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(retired);
    result
}

fn legacy_electron_status_with(
    directory: &Path,
    election_directory: &Path,
    known_upgraded: &mut Vec<Owner>,
    pid_alive: impl Fn(u32) -> bool,
    identity: impl Fn(u32) -> Option<String>,
    expected_electron: impl Fn(u32) -> Option<bool>,
) -> Result<LegacyElectronStatus, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LegacyElectronStatus::Clear)
        }
        Err(err) => return Err(format!("failed to inspect legacy Electron markers: {err}")),
    };
    let upgraded: Vec<Owner> = participants(election_directory)?
        .into_iter()
        .map(|(_, owner)| owner)
        .collect();
    for owner in &upgraded {
        if !known_upgraded.contains(owner) {
            known_upgraded.push(owner.clone());
        }
    }
    let mut publishing_participant = false;
    for entry in entries {
        let entry =
            entry.map_err(|err| format!("failed to inspect legacy Electron marker: {err}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(value) = name
            .strip_prefix("client-state.running.")
            .and_then(|value| value.strip_suffix(".json"))
        else {
            continue;
        };
        let Some((pid, run_token)) = value.split_once('.') else {
            return Ok(LegacyElectronStatus::Blocked);
        };
        let Ok(pid) = pid.parse::<u32>() else {
            return Ok(LegacyElectronStatus::Blocked);
        };
        if !pid_alive(pid) {
            continue;
        }
        let Some(marker) = read_if_exists(&entry.path())? else {
            continue;
        };
        let Ok(marker) = serde_json::from_str::<LegacyOwner>(&marker) else {
            return Ok(LegacyElectronStatus::Blocked);
        };
        if marker.pid != pid || marker.run_token != run_token {
            return Ok(LegacyElectronStatus::Blocked);
        }
        let live_identity = identity(pid);
        if let Some(marker_identity) = marker.process_start_identity.as_deref() {
            let Some(live_identity) = live_identity.as_deref() else {
                return Ok(LegacyElectronStatus::Blocked);
            };
            if live_identity != marker_identity {
                continue;
            }
            if known_upgraded.iter().any(|owner| {
                owner.pid == pid
                    && owner.run_token == run_token
                    && owner.process_start_identity == live_identity
            }) || read_if_exists(&retired_participant_path(
                election_directory,
                &Owner {
                    pid,
                    run_token: run_token.to_string(),
                    process_start_identity: live_identity.to_string(),
                    machine_identity: None,
                },
            ))?
            .as_deref()
            .and_then(parse_owner)
            .is_some_and(|owner| {
                owner.pid == pid
                    && owner.run_token == run_token
                    && owner.process_start_identity == live_identity
            }) {
                continue;
            }
            publishing_participant = true;
            continue;
        }
        match expected_electron(pid) {
            Some(false) => continue,
            Some(true) | None => return Ok(LegacyElectronStatus::Blocked),
        }
    }
    Ok(if publishing_participant {
        LegacyElectronStatus::PublishingParticipant
    } else {
        LegacyElectronStatus::Clear
    })
}

fn expected_electron_process(pid: u32) -> Option<bool> {
    let executable = process_executable(pid)?;
    let current = std::env::current_exe().ok()?;
    if paths_equal(&executable, &current) {
        return Some(false);
    }
    let name = executable
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    Some(matches!(
        name.as_str(),
        "codenomad" | "codenomad.exe" | "electron" | "electron.exe"
    ))
}

#[cfg(target_os = "linux")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    command_value("ps", &["-p", &pid.to_string(), "-o", "comm="]).map(PathBuf::from)
}

#[cfg(windows)]
fn process_executable(pid: u32) -> Option<PathBuf> {
    command_value(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction Stop).Path"),
        ],
    )
    .map(PathBuf::from)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn is_unsupported_sync_error(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(
            error.raw_os_error(),
            Some(libc::EINVAL) | Some(libc::ENOSYS) | Some(libc::ENOTSUP)
        )
    }
    #[cfg(not(unix))]
    false
}

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(target_os = "linux")]
fn machine_identity_uncached() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| {
            fs::read_to_string(path)
                .ok()
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
        })
        .map(|value| format!("linux:{value}"))
}

#[cfg(target_os = "macos")]
fn machine_identity_uncached() -> Option<String> {
    let value = command_value("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?;
    let marker = "\"IOPlatformUUID\"";
    let value = value.lines().find(|line| line.contains(marker))?;
    let uuid = value.split('=').nth(1)?.trim().trim_matches('"');
    (!uuid.is_empty()).then(|| format!("darwin:{}", uuid.to_ascii_lowercase()))
}

#[cfg(windows)]
fn machine_identity_uncached() -> Option<String> {
    command_value(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid.ToString().ToLowerInvariant()",
        ],
    )
    .map(|value| format!("win32:{value}"))
}

fn machine_identity() -> Option<String> {
    static IDENTITY: OnceLock<Option<String>> = OnceLock::new();
    IDENTITY.get_or_init(machine_identity_uncached).clone()
}

#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return windows_sys::Win32::Foundation::GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut exit_code = 0;
        let alive =
            GetExitCodeProcess(process, &mut exit_code) == 0 || exit_code == STILL_ACTIVE as u32;
        CloseHandle(process);
        alive
    }
}

#[cfg(target_os = "linux")]
fn process_start_identity(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let command_end = stat.rfind(')')?;
    let start_ticks = stat[command_end + 1..].split_whitespace().nth(19)?;
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot_id = boot_id.trim();
    (!boot_id.is_empty()).then(|| format!("linux:{boot_id}:{start_ticks}"))
}

#[cfg(any(target_os = "macos", windows))]
fn command_value(command: &str, args: &[&str]) -> Option<String> {
    for _ in 0..2 {
        let mut command = Command::new(command);
        command
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let Ok(mut child) = command.spawn() else {
            continue;
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        if status.is_some_and(|status| status.success()) {
            let mut value = String::new();
            use std::io::Read;
            if child.stdout.take()?.read_to_string(&mut value).is_ok() && !value.trim().is_empty() {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn process_start_identity(pid: u32) -> Option<String> {
    command_value("ps", &["-p", &pid.to_string(), "-o", "lstart="])
        .map(|value| format!("darwin:{value}"))
}

#[cfg(windows)]
fn process_start_identity(pid: u32) -> Option<String> {
    command_value(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction Stop).CreationDate.ToUniversalTime().Ticks"),
        ],
    )
    .map(|value| format!("win32:{value}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn owner(pid: u32, token: &str, identity: &str) -> Owner {
        Owner {
            pid,
            run_token: token.to_string(),
            process_start_identity: identity.to_string(),
            machine_identity: machine_identity(),
        }
    }

    fn node_host(
        election: &Path,
        start: &Path,
        mode: &str,
        user_data: Option<&Path>,
        legacy_tauri_data: Option<&Path>,
    ) -> std::process::Child {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let script =
            manifest.join("../../electron-app/electron/main/client-state-cross-host-child.ts");
        let mut command = Command::new("node");
        command
            .current_dir(manifest.join("../../.."))
            .args(["--import", "tsx"])
            .arg(script)
            .arg(election)
            .arg(start)
            .args(["", mode]);
        if let Some(user_data) = user_data {
            command.arg(user_data).args(["", ""]);
            if let Some(legacy) = legacy_tauri_data {
                command.arg(legacy);
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node and tsx are required for cross-language election tests")
    }

    fn node_primary(child: &mut std::process::Child) -> bool {
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert!(!line.is_empty());
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["acquired"]
            .as_bool()
            .unwrap()
    }

    fn stop_node(mut child: std::process::Child) {
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Node host failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn simultaneous_startup_elects_one_primary() {
        let directory = tempfile::tempdir().unwrap();
        let start = Arc::new(Barrier::new(5));
        let finish = Arc::new(Barrier::new(5));
        let handles: Vec<_> = (0..4)
            .map(|index| {
                let directory = directory.path().to_path_buf();
                let start = Arc::clone(&start);
                let finish = Arc::clone(&finish);
                thread::spawn(move || {
                    start.wait();
                    let registration = Registration::register_with(
                        &directory,
                        owner(
                            100 + index,
                            &format!("run-{index}"),
                            &format!("start-{index}"),
                        ),
                        true,
                        |_| true,
                        |pid| Some(format!("start-{}", pid - 100)),
                    )
                    .unwrap()
                    .unwrap();
                    let primary = registration.is_primary();
                    finish.wait();
                    primary
                })
            })
            .collect();
        start.wait();
        finish.wait();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|primary| *primary)
                .count(),
            1
        );
    }

    #[test]
    fn electron_and_tauri_simultaneous_startup_with_legacy_detection_elects_one() {
        use crate::client_state::process;

        let root = tempfile::tempdir().unwrap();
        let election = root.path().join("election");
        let node_data = root.path().join("electron");
        let rust_data = root.path().join("tauri");
        fs::create_dir_all(&rust_data).unwrap();
        let start = root.path().join("start");
        let mut node = node_host(
            &election,
            &start,
            "full",
            Some(&node_data),
            Some(&rust_data),
        );
        fs::write(&start, b"").unwrap();
        let rust = process::Registration::initialize(&rust_data, &election, Some(&node_data))
            .unwrap()
            .finish();
        let node_primary = node_primary(&mut node);
        assert_ne!(node_primary, rust.is_primary());
        rust.release_locks();
        stop_node(node);
    }

    #[test]
    fn electron_and_tauri_publish_the_same_machine_identity() {
        let directory = tempfile::tempdir().unwrap();
        let start = directory.path().join("start");
        let mut node = node_host(directory.path(), &start, "", None, None);
        fs::write(&start, b"").unwrap();
        assert!(node_primary(&mut node));
        let electron = parse_owner(&fs::read_to_string(owner_path(directory.path())).unwrap())
            .expect("Electron owner must use the Tauri-compatible schema");
        assert_eq!(electron.machine_identity, machine_identity());
        stop_node(node);
    }

    #[test]
    fn node_crash_points_leave_rust_a_safe_path_to_ownership() {
        let owner_crash = tempfile::tempdir().unwrap();
        let start = owner_crash.path().join("start");
        let mut node = node_host(owner_crash.path(), &start, "owner-crash", None, None);
        fs::write(&start, b"").unwrap();
        assert_eq!(node.wait().unwrap().code(), Some(91));
        let rust = Registration::register(owner_crash.path(), true, None)
            .unwrap()
            .unwrap();
        assert!(rust.is_primary());

        let retirement_crash = tempfile::tempdir().unwrap();
        publish_owner(
            retirement_crash.path(),
            &owner(4_000_000_000, "stale", "stale-start"),
        )
        .unwrap();
        let start = retirement_crash.path().join("start");
        let mut node = node_host(retirement_crash.path(), &start, "retire-crash", None, None);
        fs::write(&start, b"").unwrap();
        assert_eq!(node.wait().unwrap().code(), Some(91));
        let rust = Registration::register(retirement_crash.path(), true, None)
            .unwrap()
            .unwrap();
        assert!(rust.is_primary());
    }

    #[test]
    fn legacy_tauri_pid_reuse_does_not_veto_electron() {
        let root = tempfile::tempdir().unwrap();
        let election = root.path().join("election");
        let electron_data = root.path().join("electron");
        let legacy_tauri = root.path().join("tauri");
        fs::create_dir_all(&legacy_tauri).unwrap();
        fs::write(
            legacy_tauri.join(format!(
                "client-state.running.{}.legacy.lock",
                std::process::id()
            )),
            b"",
        )
        .unwrap();
        let start = root.path().join("start");
        let mut node = node_host(
            &election,
            &start,
            "full",
            Some(&electron_data),
            Some(&legacy_tauri),
        );
        fs::write(&start, b"").unwrap();
        assert!(node_primary(&mut node));
        stop_node(node);
    }

    #[test]
    fn crashed_node_primary_remains_fenced_by_rust_secondary() {
        let root = tempfile::tempdir().unwrap();
        let start = root.path().join("start");
        let mut node = node_host(root.path(), &start, "", None, None);
        fs::write(&start, b"").unwrap();
        assert!(node_primary(&mut node));
        let mut secondary = Registration::register(root.path(), true, None)
            .unwrap()
            .unwrap();
        assert!(!secondary.is_primary());
        node.kill().unwrap();
        node.wait().unwrap();

        let mut blocked = Registration::register(root.path(), true, None)
            .unwrap()
            .unwrap();
        assert!(!blocked.is_primary());
        secondary.release().unwrap();
        blocked.release().unwrap();
        let successor = Registration::register(root.path(), true, None)
            .unwrap()
            .unwrap();
        assert!(successor.is_primary());
    }

    #[test]
    fn owner_publication_crash_is_invisible() {
        let directory = tempfile::tempdir().unwrap();
        let pending = directory.path().join(".owner.crashed.tmp");
        fs::create_dir(&pending).unwrap();
        fs::write(pending.join(OWNER_FILENAME), b"partial").unwrap();
        let registration = Registration::register_with(
            directory.path(),
            owner(201, "winner", "winner-start"),
            true,
            |_| true,
            |_| Some("winner-start".to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(registration.is_primary());
    }

    #[test]
    fn stale_retirement_crash_leaves_successor_safe() {
        let directory = tempfile::tempdir().unwrap();
        let stale = owner(301, "stale", "stale-start");
        assert!(publish_owner(directory.path(), &stale).unwrap());
        let observed = fs::read_to_string(owner_path(directory.path())).unwrap();
        assert!(retire_owner(
            directory.path(),
            &observed,
            &stale,
            &owner(302, "claimant", "claimant-start"),
            |_| false,
            |_| None
        )
        .unwrap());
        let successor = Registration::register_with(
            directory.path(),
            owner(302, "successor", "successor-start"),
            true,
            |_| true,
            |_| Some("successor-start".to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(successor.is_primary());
        assert!(directory.path().join("retired.301.stale").exists());
    }

    #[test]
    fn stale_owner_retirement_is_identity_and_cohort_guarded() {
        for (alive, identity, recovered) in [
            (false, None, true),
            (true, Some("reused"), true),
            (true, Some("old-start"), false),
            (true, None, false),
        ] {
            let directory = tempfile::tempdir().unwrap();
            publish_owner(directory.path(), &owner(401, "old", "old-start")).unwrap();
            let registration = Registration::register_with(
                directory.path(),
                owner(402, "new", "new-start"),
                true,
                |_| alive,
                |_| identity.map(str::to_string),
            )
            .unwrap()
            .unwrap();
            assert_eq!(registration.is_primary(), recovered);
        }

        let directory = tempfile::tempdir().unwrap();
        publish_owner(directory.path(), &owner(501, "dead-primary", "old")).unwrap();
        publish_participant(
            &participant_path(
                directory.path(),
                &owner(502, "secondary", "secondary-start"),
            ),
            &owner(502, "secondary", "secondary-start"),
        )
        .unwrap();
        let identities = HashMap::from([(502, "secondary-start")]);
        let blocked = Registration::register_with(
            directory.path(),
            owner(503, "next", "next-start"),
            true,
            |pid| pid == 502,
            |pid| identities.get(&pid).map(|value| value.to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(!blocked.is_primary());
    }

    #[test]
    fn separate_machine_with_the_same_hostname_is_never_probed_or_reclaimed() {
        let directory = tempfile::tempdir().unwrap();
        let mut remote = owner(511, "remote", "remote-start");
        remote.machine_identity = Some("machine-b".to_string());
        let mut value = serde_json::to_value(&remote).unwrap();
        value["hostname"] = serde_json::Value::String("shared-name".to_string());
        fs::create_dir(directory.path().join(OWNER_DIRECTORY)).unwrap();
        fs::write(
            owner_path(directory.path()),
            serde_json::to_string(&value).unwrap(),
        )
        .unwrap();
        let probes = Cell::new(0);
        let registration = Registration::register_with(
            directory.path(),
            owner(512, "local", "local-start"),
            true,
            |_| {
                probes.set(probes.get() + 1);
                false
            },
            |_| {
                probes.set(probes.get() + 1);
                Some("reused".to_string())
            },
        )
        .unwrap()
        .unwrap();
        assert!(!registration.is_primary());
        assert_eq!(probes.get(), 0);
        assert_eq!(
            parse_owner(&fs::read_to_string(owner_path(directory.path())).unwrap())
                .unwrap()
                .run_token,
            "remote"
        );
    }

    #[test]
    fn legacy_records_fail_closed_unless_linux_boot_identity_proves_locality() {
        let remote_directory = tempfile::tempdir().unwrap();
        let mut legacy = owner(521, "legacy", "win32:old");
        legacy.machine_identity = None;
        publish_owner(remote_directory.path(), &legacy).unwrap();
        let blocked = Registration::register_with(
            remote_directory.path(),
            owner(522, "local", "local-start"),
            true,
            |_| false,
            |_| None,
        )
        .unwrap()
        .unwrap();
        assert!(!blocked.is_primary());

        let local_directory = tempfile::tempdir().unwrap();
        legacy.pid = 523;
        legacy.process_start_identity = "linux:boot-a:old".to_string();
        publish_owner(local_directory.path(), &legacy).unwrap();
        let recovered = Registration::register_with(
            local_directory.path(),
            owner(524, "local", "linux:boot-a:new"),
            true,
            |_| false,
            |_| None,
        )
        .unwrap()
        .unwrap();
        assert!(recovered.is_primary());
    }

    #[test]
    fn simultaneous_claimants_deterministically_recover_a_stale_owner() {
        let directory = tempfile::tempdir().unwrap();
        let stale = owner(601, "stale", "stale-start");
        let first = owner(602, "a", "a-start");
        let second = owner(603, "b", "b-start");
        publish_owner(directory.path(), &stale).unwrap();
        let observed = fs::read_to_string(owner_path(directory.path())).unwrap();
        publish_participant(&participant_path(directory.path(), &second), &second).unwrap();
        publish_file(
            &recovery_path(directory.path(), &second),
            &observed,
            "recovery claim",
        )
        .unwrap();
        let identities = HashMap::from([(602, "a-start"), (603, "b-start")]);
        let winner = Registration::register_with(
            directory.path(),
            first,
            true,
            |pid| pid != stale.pid,
            |pid| identities.get(&pid).map(|value| value.to_string()),
        )
        .unwrap()
        .unwrap();
        let loser = Registration::register_with(
            directory.path(),
            second,
            true,
            |pid| pid != stale.pid,
            |pid| identities.get(&pid).map(|value| value.to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(winner.is_primary());
        assert!(!loser.is_primary());
    }

    #[test]
    fn local_a_b_c_cohort_recovers_for_both_b_c_lexical_orders() {
        for (b_pid, c_pid) in [(802, 803), (803, 802)] {
            let directory = tempfile::tempdir().unwrap();
            let a = owner(801, "a", "a-start");
            let b_owner = owner(b_pid, "b", "b-start");
            let c_owner = owner(c_pid, "c", "c-start");
            publish_owner(directory.path(), &a).unwrap();
            let identities = HashMap::from([(b_pid, "b-start"), (c_pid, "c-start")]);
            let alive = |pid| pid != a.pid;
            let identity = |pid| identities.get(&pid).map(|value| value.to_string());

            let c = Registration::register_with(
                directory.path(),
                c_owner.clone(),
                false,
                alive,
                identity,
            )
            .unwrap()
            .unwrap();
            c.retain_local_candidacy();
            let b = Registration::register_with(
                directory.path(),
                b_owner.clone(),
                true,
                alive,
                identity,
            )
            .unwrap()
            .unwrap();
            b.retain_local_candidacy();
            assert!(!b.is_primary_with(alive, identity, |_| Some(false)));

            c.defer_to_local_holder();
            assert!(!c.primary.get());
            assert!(c.retry_candidate.get());
            assert!(!participant_path(directory.path(), &c_owner).exists());
            assert!(!recovery_path(directory.path(), &c_owner).exists());
            assert!(b.is_primary_with(alive, identity, |_| Some(false)));
            assert_eq!(
                parse_owner(&fs::read_to_string(owner_path(directory.path())).unwrap()),
                Some(b_owner)
            );
        }
    }

    #[test]
    fn graceful_primary_release_allows_a_successor_while_a_secondary_remains() {
        let directory = tempfile::tempdir().unwrap();
        let mut primary = Registration::register_with(
            directory.path(),
            owner(601, "primary", "primary-start"),
            true,
            |_| true,
            |_| Some("primary-start".to_string()),
        )
        .unwrap()
        .unwrap();
        let secondary = Registration::register_with(
            directory.path(),
            owner(602, "secondary", "secondary-start"),
            true,
            |_| true,
            |_| Some("primary-start".to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(!secondary.is_primary());

        assert!(primary.release().unwrap());
        let successor = Registration::register_with(
            directory.path(),
            owner(603, "successor", "successor-start"),
            true,
            |_| true,
            |_| Some("successor-start".to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(successor.is_primary());
    }

    #[test]
    fn graceful_handoff_retires_the_old_cohort_so_a_crashed_successor_can_recover() {
        let directory = tempfile::tempdir().unwrap();
        let secondary_owner = owner(622, "secondary", "secondary-start");
        let successor_owner = owner(623, "successor", "successor-start");
        let late_owner = owner(625, "late", "late-start");
        let primary = Registration::register_with(
            directory.path(),
            owner(621, "primary", "primary-start"),
            true,
            |_| true,
            |_| Some("primary-start".to_string()),
        )
        .unwrap()
        .unwrap();
        let _secondary = Registration::register_with(
            directory.path(),
            secondary_owner.clone(),
            true,
            |_| true,
            |_| Some("primary-start".to_string()),
        )
        .unwrap()
        .unwrap();

        let malformed = directory.path().join("participant.malformed.json");
        retire_owner_if_owned_with(
            directory.path(),
            &primary.owner,
            || {
                publish_participant(
                    &participant_path(directory.path(), &successor_owner),
                    &successor_owner,
                )
                .unwrap();
                publish_participant(
                    &participant_path(directory.path(), &late_owner),
                    &late_owner,
                )
                .unwrap();
                fs::write(&malformed, b"malformed").unwrap();
            },
            || assert!(publish_owner(directory.path(), &successor_owner).unwrap()),
        )
        .unwrap();
        assert!(!directory.path().join("retired.621.primary").exists());
        assert_eq!(
            parse_owner(&fs::read_to_string(owner_path(directory.path())).unwrap()),
            Some(successor_owner)
        );
        assert!(!participant_path(
            directory.path(),
            &owner(623, "successor", "successor-start")
        )
        .exists());
        assert!(!participant_path(directory.path(), &late_owner).exists());
        assert!(!malformed.exists());

        let claimant_owner = owner(624, "claimant", "claimant-start");
        let identities = HashMap::from([
            (secondary_owner.pid, secondary_owner.process_start_identity),
            (late_owner.pid, late_owner.process_start_identity),
            (
                claimant_owner.pid,
                claimant_owner.process_start_identity.clone(),
            ),
        ]);
        let claimant = Registration::register_with(
            directory.path(),
            claimant_owner,
            true,
            |pid| identities.contains_key(&pid),
            |pid| identities.get(&pid).cloned(),
        )
        .unwrap()
        .unwrap();
        assert!(claimant.is_primary());
    }

    #[test]
    fn non_owner_release_does_not_remove_a_live_owners_record() {
        let directory = tempfile::tempdir().unwrap();
        let primary_owner = owner(611, "primary", "primary-start");
        let primary = Registration::register_with(
            directory.path(),
            primary_owner.clone(),
            true,
            |_| true,
            |_| Some("primary-start".to_string()),
        )
        .unwrap()
        .unwrap();
        let mut secondary = Registration::register_with(
            directory.path(),
            owner(612, "secondary", "secondary-start"),
            true,
            |_| true,
            |_| Some("primary-start".to_string()),
        )
        .unwrap()
        .unwrap();

        assert!(secondary.release().unwrap());
        assert!(primary.is_primary());
        assert_eq!(
            parse_owner(&fs::read_to_string(owner_path(directory.path())).unwrap()),
            Some(primary_owner)
        );
    }

    #[test]
    fn upgraded_markers_do_not_veto_but_unmatched_legacy_does() {
        let election = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let upgraded = owner(701, "electron", "electron-start");
        let mut known_upgraded = Vec::new();
        publish_participant(&participant_path(election.path(), &upgraded), &upgraded).unwrap();
        fs::write(
            legacy.path().join("client-state.running.701.electron.json"),
            serialize_owner(&upgraded).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            legacy_electron_status_with(
                legacy.path(),
                election.path(),
                &mut known_upgraded,
                |_| true,
                |_| Some("electron-start".to_string()),
                |_| Some(true),
            )
            .unwrap(),
            LegacyElectronStatus::Clear
        ));
        fs::write(
            legacy.path().join("client-state.running.702.legacy.json"),
            r#"{"pid":702,"runToken":"legacy"}"#,
        )
        .unwrap();
        assert!(matches!(
            legacy_electron_status_with(
                legacy.path(),
                election.path(),
                &mut known_upgraded,
                |_| true,
                |_| None,
                |_| None,
            )
            .unwrap(),
            LegacyElectronStatus::Blocked
        ));
    }

    #[test]
    fn modern_participant_published_well_after_fifty_ms_allows_retry() {
        let election = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let upgraded = owner(703, "electron", "electron-start");
        let participant = participant_path(election.path(), &upgraded);
        fs::write(
            legacy.path().join("client-state.running.703.electron.json"),
            serialize_owner(&upgraded).unwrap(),
        )
        .unwrap();

        let registration = Registration::register_with_legacy(
            election.path(),
            owner(704, "tauri", "tauri-start"),
            true,
            Some(legacy.path()),
            |_| true,
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        )
        .unwrap()
        .unwrap();
        assert!(!registration.is_primary_with(
            |_| true,
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        ));

        thread::sleep(std::time::Duration::from_millis(100));
        publish_participant(&participant, &upgraded).unwrap();
        assert!(registration.is_primary_with(
            |_| true,
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        ));
    }

    #[test]
    fn producer_crash_before_participant_publication_allows_retry() {
        let election = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let producer = owner(705, "electron", "electron-start");
        let alive = std::cell::Cell::new(true);
        fs::write(
            legacy.path().join("client-state.running.705.electron.json"),
            serialize_owner(&producer).unwrap(),
        )
        .unwrap();

        let registration = Registration::register_with_legacy(
            election.path(),
            owner(706, "tauri", "tauri-start"),
            true,
            Some(legacy.path()),
            |_| alive.get(),
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        )
        .unwrap()
        .unwrap();
        assert!(!registration.is_primary_with(
            |_| alive.get(),
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        ));

        alive.set(false);
        assert!(registration.is_primary_with(
            |_| alive.get(),
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        ));
    }

    #[test]
    fn identity_less_legacy_exit_allows_late_promotion() {
        let election = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let alive = std::cell::Cell::new(true);
        fs::write(
            legacy.path().join("client-state.running.706.legacy.json"),
            r#"{"pid":706,"runToken":"legacy"}"#,
        )
        .unwrap();

        let registration = Registration::register_with_legacy(
            election.path(),
            owner(707, "tauri", "tauri-start"),
            true,
            Some(legacy.path()),
            |_| alive.get(),
            |_| None,
            |_| Some(true),
        )
        .unwrap()
        .unwrap();
        assert!(!registration.is_primary_with(|_| alive.get(), |_| None, |_| Some(true)));
        assert!(registration.retains_local_candidacy());

        alive.set(false);
        assert!(registration.is_primary_with(|_| alive.get(), |_| None, |_| Some(true)));
    }

    #[test]
    fn live_modern_marker_without_a_participant_returns_bounded() {
        let election = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let producer = owner(707, "electron", "electron-start");
        let probes = std::cell::Cell::new(0);
        fs::write(
            legacy.path().join("client-state.running.707.electron.json"),
            serialize_owner(&producer).unwrap(),
        )
        .unwrap();

        let registration = Registration::register_with_legacy(
            election.path(),
            owner(708, "tauri", "tauri-start"),
            true,
            Some(legacy.path()),
            |_| {
                probes.set(probes.get() + 1);
                true
            },
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        )
        .unwrap()
        .unwrap();
        assert_eq!(probes.get(), 1);
        assert!(registration.retains_local_candidacy());

        assert!(!registration.is_primary_with(
            |_| {
                probes.set(probes.get() + 1);
                true
            },
            |_| Some("electron-start".to_string()),
            |_| Some(true),
        ));
        assert_eq!(probes.get(), 2);
    }

    #[test]
    fn retired_modern_participant_remains_recognizable_to_new_candidate() {
        let election = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let current = owner(709, "current", "current-start");
        let producer = owner(710, "electron", "electron-start");
        let candidate = owner(711, "tauri", "tauri-start");
        let producer_participant = participant_path(election.path(), &producer);
        publish_owner(election.path(), &current).unwrap();
        publish_participant(&producer_participant, &producer).unwrap();
        fs::write(
            legacy.path().join("client-state.running.710.electron.json"),
            serialize_owner(&producer).unwrap(),
        )
        .unwrap();
        let identity = |pid| {
            Some(
                match pid {
                    709 => "current-start",
                    710 => "electron-start",
                    _ => "tauri-start",
                }
                .to_string(),
            )
        };

        retire_owner_if_owned(election.path(), &current).unwrap();
        assert!(!producer_participant.exists());
        assert!(retired_participant_path(election.path(), &producer).exists());

        let registration = Registration::register_with_legacy(
            election.path(),
            candidate.clone(),
            true,
            Some(legacy.path()),
            |_| true,
            identity,
            |_| Some(true),
        )
        .unwrap()
        .unwrap();
        assert!(registration.is_primary_with(|_| true, identity, |_| Some(true)));
    }

    #[test]
    fn platform_paths_match_electron() {
        let resolve = |platform: &str, values: HashMap<&str, &str>, fallback: &str| {
            resolve_election_directory_for(
                platform,
                |name| values.get(name).map(OsString::from),
                Some(Path::new(fallback)),
            )
            .unwrap()
        };
        assert_eq!(
            resolve("linux", HashMap::from([("HOME", "/home/dev")]), "/fallback"),
            "/home/dev/.codenomad/client-state/election"
        );
        assert_eq!(
            resolve(
                "windows",
                HashMap::from([("USERPROFILE", ""), ("HOME", "D:\\Home")]),
                "C:\\Fallback"
            ),
            "D:\\Home\\.codenomad\\client-state\\election"
        );
        let resolve_state = |platform: &str, values: HashMap<&str, &str>, fallback: &str| {
            resolve_state_path_for(
                platform,
                |name| values.get(name).map(OsString::from),
                Some(Path::new(fallback)),
            )
            .unwrap()
        };
        assert_eq!(
            resolve_state(
                "macos",
                HashMap::from([("HOME", "/Users/dev")]),
                "/fallback"
            ),
            "/Users/dev/.codenomad/client-state/client-state.json"
        );
        assert_eq!(
            resolve_state("linux", HashMap::from([("HOME", "/home/dev")]), "/fallback"),
            "/home/dev/.codenomad/client-state/client-state.json"
        );
        assert_eq!(
            resolve_state(
                "windows",
                HashMap::from([("USERPROFILE", ""), ("HOME", "D:\\Home")]),
                "C:\\Fallback"
            ),
            "D:\\Home\\.codenomad\\client-state\\client-state.json"
        );
    }
}
