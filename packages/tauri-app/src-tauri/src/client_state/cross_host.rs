use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", windows))]
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
#[cfg(any(target_os = "macos", windows))]
use std::time::Instant;

const OWNER_FILENAME: &str = "primary.owner.json";
const PARTICIPANT_PREFIX: &str = "participant.";
const PARTICIPANT_SUFFIX: &str = ".json";
const REMOVAL_CLAIM_PREFIX: &str = "removed.";
const REMOVAL_CLAIM_SUFFIX: &str = ".claim";
const ACQUIRE_ATTEMPTS: usize = 10;
const PROTOCOL_LOCK_DIRECTORY: &str = "protocol.lock";
const PROTOCOL_LOCK_OWNER_FILENAME: &str = "owner.json";
const RETIRED_LOCK_PREFIX: &str = "retired.";
const RETIRED_LOCK_SUFFIX: &str = ".lock";
const PROTOCOL_LOCK_ATTEMPTS: usize = 500;
const PROTOCOL_LOCK_RETRY: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    pid: u32,
    run_token: String,
    process_start_identity: String,
}

pub(super) struct Registration {
    election_directory: PathBuf,
    owner_path: PathBuf,
    participant_path: PathBuf,
    owner: Owner,
    legacy_electron_data: Option<PathBuf>,
    primary: bool,
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
    if platform == "windows" {
        Some(format!(
            "{}\\.codenomad\\client-state\\election",
            home.trim_end_matches(['\\', '/'])
        ))
    } else {
        Some(format!(
            "{}/.codenomad/client-state/election",
            home.trim_end_matches('/')
        ))
    }
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
        let Some(start_identity) = process_start_identity(std::process::id()) else {
            return Ok(None);
        };
        let owner = Owner {
            pid: std::process::id(),
            run_token: uuid::Uuid::new_v4().to_string(),
            process_start_identity: start_identity,
        };
        let legacy_blocked = match legacy_electron_data.filter(|_| primary_candidate) {
            Some(path) => has_live_legacy_electron(path)?,
            None => false,
        };
        let mut registration = Self::register_with(
            election_directory,
            owner,
            primary_candidate && !legacy_blocked,
            pid_is_alive,
            process_start_identity,
        )?;
        if let Some(registration) = registration.as_mut() {
            registration.legacy_electron_data = legacy_electron_data.map(Path::to_path_buf);
        }
        Ok(registration)
    }

    fn register_with(
        election_directory: &Path,
        owner: Owner,
        primary_candidate: bool,
        pid_alive: impl Fn(u32) -> bool + Copy,
        identity: impl Fn(u32) -> Option<String> + Copy,
    ) -> Result<Option<Self>, String> {
        fs::create_dir_all(election_directory).map_err(|err| {
            format!(
                "failed to create cross-host election directory {}: {err}",
                election_directory.display()
            )
        })?;
        let Some(protocol_lock_owner) =
            acquire_protocol_lock(election_directory, &owner, pid_alive, identity)?
        else {
            return Ok(None);
        };
        let result = (|| -> Result<Option<Self>, String> {
            let owner_path = election_directory.join(OWNER_FILENAME);
            let participant_path = participant_path(election_directory, &owner)?;
            let serialized = serialize_owner(&owner)?;
            let mut primary = false;

            if primary_candidate {
                match publish(&owner_path, serialized.as_bytes()) {
                    Ok(()) => primary = true,
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(err) => return Err(format!("failed to publish cross-host owner: {err}")),
                }
            }

            if primary_candidate && !primary {
                for _ in 0..ACQUIRE_ATTEMPTS {
                    match publish(&owner_path, serialized.as_bytes()) {
                        Ok(()) => {
                            primary = true;
                            break;
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(err) => {
                            return Err(format!("failed to publish cross-host owner: {err}"))
                        }
                    }

                    let Some(observed) = read_if_exists(&owner_path)? else {
                        continue;
                    };
                    let Some(existing) = parse_owner(&observed) else {
                        break;
                    };
                    if existing == owner {
                        primary = true;
                        break;
                    }
                    let stale = owner_is_stale(&existing, pid_alive, identity);
                    let Some(stale) = stale else {
                        break;
                    };
                    if !stale
                        || has_other_live_participants(
                            election_directory,
                            &owner,
                            pid_alive,
                            identity,
                        )?
                    {
                        break;
                    }
                    if !remove_observed_owner(
                        election_directory,
                        &owner_path,
                        &observed,
                        &existing,
                        &owner,
                    )? {
                        continue;
                    }
                }
            }

            if let Err(err) = publish_participant(&participant_path, &serialized) {
                if primary {
                    if let Some(observed) = read_if_exists(&owner_path)? {
                        if parse_owner(&observed).as_ref() == Some(&owner) {
                            let _ = remove_observed_owner(
                                election_directory,
                                &owner_path,
                                &observed,
                                &owner,
                                &owner,
                            );
                        }
                    }
                }
                return Err(err);
            }

            Ok(Some(Self {
                election_directory: election_directory.to_path_buf(),
                owner_path,
                participant_path,
                owner: owner.clone(),
                legacy_electron_data: None,
                primary,
                released: false,
            }))
        })();
        release_protocol_lock(election_directory, &protocol_lock_owner)?;
        result
    }

    pub(super) fn is_primary(&self) -> bool {
        if self.released || !self.primary {
            return false;
        }
        let shared_owner = read_if_exists(&self.owner_path)
            .ok()
            .flatten()
            .and_then(|value| parse_owner(&value))
            .is_some_and(|owner| owner == self.owner);
        let legacy_clear = self
            .legacy_electron_data
            .as_deref()
            .map(has_live_legacy_electron)
            .transpose()
            .map(|value| !value.unwrap_or(false))
            .unwrap_or(false);
        shared_owner && legacy_clear
    }

    pub(super) fn release(&mut self) -> Result<bool, String> {
        self.release_with(pid_is_alive, process_start_identity)
    }

    fn release_with(
        &mut self,
        pid_alive: impl Fn(u32) -> bool + Copy,
        identity: impl Fn(u32) -> Option<String> + Copy,
    ) -> Result<bool, String> {
        if self.released {
            return Ok(false);
        }
        let Some(protocol_lock_owner) =
            acquire_protocol_lock(&self.election_directory, &self.owner, pid_alive, identity)?
        else {
            return Ok(false);
        };
        let result = (|| -> Result<bool, String> {
            let mut removed = false;
            if self.is_primary()
                && !has_other_live_participants(
                    &self.election_directory,
                    &self.owner,
                    pid_alive,
                    identity,
                )?
            {
                if let Some(observed) = read_if_exists(&self.owner_path)? {
                    if parse_owner(&observed).as_ref() == Some(&self.owner) {
                        removed = remove_observed_owner(
                            &self.election_directory,
                            &self.owner_path,
                            &observed,
                            &self.owner,
                            &self.owner,
                        )?;
                    }
                }
            }
            remove_participant_if_owned(&self.participant_path, &self.owner)?;
            self.primary = false;
            self.released = true;
            Ok(removed)
        })();
        release_protocol_lock(&self.election_directory, &protocol_lock_owner)?;
        result
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Err(err) = self.release() {
            eprintln!("[client-state] failed to release cross-host registration: {err}");
        }
    }
}

fn serialize_owner(owner: &Owner) -> Result<String, String> {
    serde_json::to_string(owner).map_err(|err| err.to_string())
}

fn parse_owner(value: &str) -> Option<Owner> {
    let owner = serde_json::from_str::<Owner>(value).ok()?;
    (owner.pid > 0 && !owner.run_token.is_empty() && !owner.process_start_identity.is_empty())
        .then_some(owner)
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn participant_path(election_directory: &Path, owner: &Owner) -> Result<PathBuf, String> {
    Ok(election_directory.join(format!(
        "{PARTICIPANT_PREFIX}{}{PARTICIPANT_SUFFIX}",
        digest(&serialize_owner(owner)?)
    )))
}

fn publish(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "publish path has no parent",
        )
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    if let Err(err) = temporary.as_file().sync_all() {
        if is_unsupported_sync_error(&err) {
            return fs::hard_link(temporary.path(), path);
        }
        return Err(err);
    }
    fs::hard_link(temporary.path(), path)
}

fn is_unsupported_sync_error(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    {
        return matches!(
            error.raw_os_error(),
            Some(libc::EINVAL) | Some(libc::ENOSYS) | Some(libc::ENOTSUP)
        );
    }
    #[cfg(not(unix))]
    false
}

fn publish_participant(path: &Path, serialized: &str) -> Result<(), String> {
    match publish(path, serialized.as_bytes()) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            if read_if_exists(path)?.as_deref() == Some(serialized) {
                Ok(())
            } else {
                Err("cross-host participant path is owned by another process".to_string())
            }
        }
        Err(err) => Err(format!("failed to publish cross-host participant: {err}")),
    }
}

fn read_if_exists(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!(
            "failed to read cross-host file {}: {err}",
            path.display()
        )),
    }
}

fn owner_is_stale(
    owner: &Owner,
    pid_alive: impl Fn(u32) -> bool,
    identity: impl Fn(u32) -> Option<String>,
) -> Option<bool> {
    if !pid_alive(owner.pid) {
        return Some(true);
    }
    identity(owner.pid).map(|live| live != owner.process_start_identity)
}

fn protocol_lock_owner_path(lock_directory: &Path) -> PathBuf {
    lock_directory.join(PROTOCOL_LOCK_OWNER_FILENAME)
}

fn retire_protocol_lock(election_directory: &Path, observed: &str) -> Result<bool, String> {
    let lock_directory = election_directory.join(PROTOCOL_LOCK_DIRECTORY);
    if read_if_exists(&protocol_lock_owner_path(&lock_directory))?.as_deref() != Some(observed) {
        return Ok(false);
    }
    let retired = election_directory.join(format!(
        "{RETIRED_LOCK_PREFIX}{}{RETIRED_LOCK_SUFFIX}",
        digest(observed)
    ));
    if retired.exists() {
        return Ok(false);
    }
    match fs::rename(&lock_directory, &retired) {
        Ok(()) => {
            // ponytail: immutable retirement directories accumulate; clean them only if directory growth becomes material.
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound || retired.exists() => Ok(false),
        Err(err) => Err(format!("failed to retire cross-host protocol lock: {err}")),
    }
}

fn publish_protocol_lock_owner(path: &Path, serialized: &str) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|err| format!("failed to publish cross-host protocol lock owner: {err}"))?;
    if let Err(err) = file.write_all(serialized.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!(
            "failed to publish cross-host protocol lock owner: {err}"
        ));
    }
    if let Err(err) = file.sync_all() {
        if !is_unsupported_sync_error(&err) {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(format!(
                "failed to publish cross-host protocol lock owner: {err}"
            ));
        }
    }
    Ok(())
}

fn acquire_protocol_lock(
    election_directory: &Path,
    owner: &Owner,
    pid_alive: impl Fn(u32) -> bool + Copy,
    identity: impl Fn(u32) -> Option<String> + Copy,
) -> Result<Option<Owner>, String> {
    let lock_directory = election_directory.join(PROTOCOL_LOCK_DIRECTORY);
    let lock_owner = Owner {
        pid: owner.pid,
        run_token: format!("{}.{}", owner.run_token, uuid::Uuid::new_v4()),
        process_start_identity: owner.process_start_identity.clone(),
    };
    let serialized = serialize_owner(&lock_owner)?;
    for attempt in 0..PROTOCOL_LOCK_ATTEMPTS {
        match fs::create_dir(&lock_directory) {
            Ok(()) => {
                if let Err(err) = publish_protocol_lock_owner(
                    &protocol_lock_owner_path(&lock_directory),
                    &serialized,
                ) {
                    let _ = fs::remove_dir(&lock_directory);
                    return Err(err);
                }
                return Ok(Some(lock_owner));
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(format!("failed to acquire cross-host protocol lock: {err}")),
        }

        let observed = read_if_exists(&protocol_lock_owner_path(&lock_directory))?;
        let Some(existing) = observed.as_deref().and_then(parse_owner) else {
            if observed.is_some() && attempt >= ACQUIRE_ATTEMPTS - 1 {
                return Ok(None);
            }
            thread::sleep(PROTOCOL_LOCK_RETRY);
            continue;
        };
        match owner_is_stale(&existing, pid_alive, identity) {
            Some(true) => {
                retire_protocol_lock(election_directory, observed.as_deref().unwrap())?;
            }
            Some(false) | None => thread::sleep(PROTOCOL_LOCK_RETRY),
        }
    }
    Ok(None)
}

fn release_protocol_lock(election_directory: &Path, owner: &Owner) -> Result<(), String> {
    let lock_directory = election_directory.join(PROTOCOL_LOCK_DIRECTORY);
    let Some(observed) = read_if_exists(&protocol_lock_owner_path(&lock_directory))? else {
        return Ok(());
    };
    if parse_owner(&observed).as_ref() == Some(owner) {
        retire_protocol_lock(election_directory, &observed)?;
    }
    Ok(())
}

fn remove_observed_owner(
    election_directory: &Path,
    path: &Path,
    observed: &str,
    owner: &Owner,
    claimant: &Owner,
) -> Result<bool, String> {
    let claim = election_directory.join(format!(
        "{REMOVAL_CLAIM_PREFIX}{}{REMOVAL_CLAIM_SUFFIX}",
        digest(observed)
    ));
    match publish(&claim, serialize_owner(claimant)?.as_bytes()) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(err) => return Err(format!("failed to claim stale cross-host owner: {err}")),
    }
    let Some(current) = read_if_exists(path)? else {
        return Ok(false);
    };
    if current != observed || parse_owner(&current).as_ref() != Some(owner) {
        return Ok(false);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!("failed to remove cross-host owner: {err}")),
    }
}

fn remove_participant_if_owned(path: &Path, owner: &Owner) -> Result<(), String> {
    let Some(value) = read_if_exists(path)? else {
        return Ok(());
    };
    if parse_owner(&value).as_ref() != Some(owner) {
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to remove cross-host participant: {err}")),
    }
}

fn has_other_live_participants(
    election_directory: &Path,
    current_owner: &Owner,
    pid_alive: impl Fn(u32) -> bool + Copy,
    identity: impl Fn(u32) -> Option<String> + Copy,
) -> Result<bool, String> {
    for entry in fs::read_dir(election_directory)
        .map_err(|err| format!("failed to read cross-host participants: {err}"))?
    {
        let entry = entry.map_err(|err| format!("failed to read cross-host participant: {err}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PARTICIPANT_PREFIX) || !name.ends_with(PARTICIPANT_SUFFIX) {
            continue;
        }
        let Some(value) = read_if_exists(&entry.path())? else {
            continue;
        };
        let Some(participant) = parse_owner(&value) else {
            return Ok(true);
        };
        if participant == *current_owner {
            continue;
        }
        let Some(stale) = owner_is_stale(&participant, pid_alive, identity) else {
            return Ok(true);
        };
        if !stale {
            return Ok(true);
        }
        remove_participant_if_owned(&entry.path(), &participant)?;
    }
    Ok(false)
}

fn has_live_legacy_electron(directory: &Path) -> Result<bool, String> {
    has_live_legacy_electron_with(
        directory,
        std::process::id(),
        pid_is_alive,
        process_start_identity,
    )
}

fn has_live_legacy_electron_with(
    directory: &Path,
    current_pid: u32,
    pid_alive: impl Fn(u32) -> bool,
    identity: impl Fn(u32) -> Option<String>,
) -> Result<bool, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("failed to inspect legacy Electron markers: {err}")),
    };
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
            return Ok(true);
        };
        let Ok(pid) = pid.parse::<u32>() else {
            return Ok(true);
        };
        if pid == current_pid || !pid_alive(pid) {
            continue;
        }
        let marker = read_if_exists(&entry.path())?;
        let Some(marker_owner) = marker.as_deref().and_then(parse_owner) else {
            return Ok(true);
        };
        if marker_owner.pid != pid || marker_owner.run_token != run_token {
            return Ok(true);
        }
        let Some(identity) = identity(pid) else {
            return Ok(true);
        };
        if identity == marker_owner.process_start_identity {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
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

#[cfg(target_os = "macos")]
fn process_start_identity(pid: u32) -> Option<String> {
    command_identity("ps", &["-p", &pid.to_string(), "-o", "lstart="], "darwin")
}

#[cfg(windows)]
fn process_start_identity(pid: u32) -> Option<String> {
    command_identity(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks"),
        ],
        "win32",
    )
}

#[cfg(any(target_os = "macos", windows))]
fn command_identity(command: &str, args: &[&str], prefix: &str) -> Option<String> {
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
            if child.stdout.take()?.read_to_string(&mut value).is_ok() {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(format!("{prefix}:{value}"));
                }
            }
        }
    }
    None
}

#[cfg(any(target_os = "macos", windows))]
use std::io::Read;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    fn owner(pid: u32, host: &str, identity: &str) -> Owner {
        Owner {
            pid,
            run_token: format!("{host}-run"),
            process_start_identity: identity.to_string(),
        }
    }

    fn node_child_with(
        directory: &Path,
        start: &Path,
        user_data: Option<&Path>,
        pause: Option<(&Path, &Path)>,
    ) -> Child {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest.join("../../..");
        let script =
            manifest.join("../../electron-app/electron/main/client-state-cross-host-child.ts");
        let ready = start
            .parent()
            .unwrap()
            .join(format!("node-ready-{}", uuid::Uuid::new_v4()));
        let mut command = Command::new("node");
        command
            .current_dir(workspace)
            .args(["--import", "tsx"])
            .arg(script)
            .arg(directory)
            .arg(start)
            .arg(&ready);
        if let Some(user_data) = user_data {
            command.args(["full"]).arg(user_data);
            if let Some((participant_ready, participant_continue)) = pause {
                command.arg(participant_ready).arg(participant_continue);
            }
        }
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node and the workspace tsx dependency are required for cross-host interoperability tests");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            ready.exists(),
            "Node election child did not reach its startup barrier"
        );
        child
    }

    fn node_child(directory: &Path, start: &Path) -> Child {
        node_child_with(directory, start, None, None)
    }

    fn node_result(child: &mut Child) -> bool {
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert!(
            !line.is_empty(),
            "Node election child exited without a result"
        );
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["acquired"]
            .as_bool()
            .unwrap()
    }

    fn stop_node(mut child: Child) {
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Node election child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn both_host_orders_elect_only_the_first() {
        for order in [["electron", "tauri"], ["tauri", "electron"]] {
            let directory = tempfile::tempdir().unwrap();
            let identities = HashMap::from([(101, "first-start"), (102, "second-start")]);
            let mut first = Registration::register_with(
                directory.path(),
                owner(101, order[0], "first-start"),
                true,
                |_| true,
                |pid| identities.get(&pid).map(|value| value.to_string()),
            )
            .unwrap()
            .unwrap();
            let mut second = Registration::register_with(
                directory.path(),
                owner(102, order[1], "second-start"),
                true,
                |_| true,
                |pid| identities.get(&pid).map(|value| value.to_string()),
            )
            .unwrap()
            .unwrap();
            assert!(first.is_primary());
            assert!(!second.is_primary());
            second.release().unwrap();
            assert!(first.release().unwrap());
        }
    }

    #[test]
    fn simultaneous_acquisition_has_one_winner() {
        let directory = tempfile::tempdir().unwrap();
        let start = Arc::new(Barrier::new(5));
        let release = Arc::new(Barrier::new(5));
        let handles: Vec<_> = (0..4)
            .map(|index| {
                let path = directory.path().to_path_buf();
                let start = Arc::clone(&start);
                let release = Arc::clone(&release);
                thread::spawn(move || {
                    start.wait();
                    let mut registration = Registration::register_with(
                        &path,
                        owner(200 + index, "host", &format!("start-{index}")),
                        true,
                        |_| true,
                        |pid| Some(format!("start-{}", pid - 200)),
                    )
                    .unwrap()
                    .unwrap();
                    let acquired = registration.is_primary();
                    release.wait();
                    registration.release().unwrap();
                    acquired
                })
            })
            .collect();
        start.wait();
        release.wait();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|acquired| *acquired)
                .count(),
            1
        );
    }

    #[test]
    fn node_and_rust_interoperate_in_both_orders_and_simultaneously() {
        let node_first = tempfile::tempdir().unwrap();
        let start = node_first.path().join("start");
        fs::write(&start, b"").unwrap();
        let mut node = node_child(node_first.path(), &start);
        assert!(node_result(&mut node));
        let mut rust = Registration::register(node_first.path(), true, None)
            .unwrap()
            .unwrap();
        assert!(!rust.is_primary());
        rust.release().unwrap();
        stop_node(node);

        let rust_first = tempfile::tempdir().unwrap();
        let start = rust_first.path().join("start");
        let mut rust = Registration::register(rust_first.path(), true, None)
            .unwrap()
            .unwrap();
        assert!(rust.is_primary());
        fs::write(&start, b"").unwrap();
        let mut node = node_child(rust_first.path(), &start);
        assert!(!node_result(&mut node));
        stop_node(node);
        assert!(rust.release().unwrap());

        let simultaneous = tempfile::tempdir().unwrap();
        let start = simultaneous.path().join("start");
        let mut node = node_child(simultaneous.path(), &start);
        fs::write(&start, b"").unwrap();
        let mut rust = Registration::register(simultaneous.path(), true, None)
            .unwrap()
            .unwrap();
        let node_primary = node_result(&mut node);
        assert_ne!(node_primary, rust.is_primary());
        if node_primary {
            rust.release().unwrap();
            stop_node(node);
        } else {
            stop_node(node);
            assert!(rust.release().unwrap());
        }

        let stale_recovery = tempfile::tempdir().unwrap();
        let mut exited = Command::new("node").args(["-e", ""]).spawn().unwrap();
        let stale_pid = exited.id();
        assert!(exited.wait().unwrap().success());
        fs::write(
            stale_recovery.path().join(OWNER_FILENAME),
            serialize_owner(&owner(stale_pid, "stale", "stale-start")).unwrap(),
        )
        .unwrap();
        let start = stale_recovery.path().join("start");
        let mut node = node_child(stale_recovery.path(), &start);
        fs::write(&start, b"").unwrap();
        let mut rust = Registration::register(stale_recovery.path(), true, None)
            .unwrap()
            .unwrap();
        let node_primary = node_result(&mut node);
        assert_ne!(node_primary, rust.is_primary());
        if node_primary {
            rust.release().unwrap();
            stop_node(node);
        } else {
            stop_node(node);
            assert!(rust.release().unwrap());
        }
    }

    #[test]
    fn node_and_rust_full_hosts_serialize_startup_and_release_interleaving() {
        use crate::client_state::process;
        use std::sync::{mpsc, Arc};

        let simultaneous = tempfile::tempdir().unwrap();
        let election = simultaneous.path().join("election");
        let node_data = simultaneous.path().join("node");
        let rust_data = simultaneous.path().join("rust");
        fs::create_dir_all(&rust_data).unwrap();
        let start = simultaneous.path().join("start");
        let mut node = node_child_with(&election, &start, Some(&node_data), None);
        fs::write(&start, b"").unwrap();
        let rust = process::Registration::initialize(&rust_data, &election, None).unwrap();
        let node_primary = node_result(&mut node);
        assert_ne!(node_primary, rust.is_primary());
        let rust = rust.finish();
        if node_primary {
            rust.release_locks();
            stop_node(node);
        } else {
            stop_node(node);
            rust.release_locks();
        }

        let interleaving = tempfile::tempdir().unwrap();
        let election = interleaving.path().join("election");
        let rust_data = interleaving.path().join("rust");
        fs::create_dir_all(&rust_data).unwrap();
        let rust = process::Registration::initialize(&rust_data, &election, None)
            .unwrap()
            .finish();
        assert!(rust.is_primary());
        let rust = Arc::new(rust);
        let start = interleaving.path().join("start");
        let participant_ready = interleaving.path().join("participant-ready");
        let participant_continue = interleaving.path().join("participant-continue");
        let node_data = interleaving.path().join("node");
        let mut node = node_child_with(
            &election,
            &start,
            Some(&node_data),
            Some((&participant_ready, &participant_continue)),
        );
        fs::write(&start, b"").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !participant_ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(participant_ready.exists(), "Node participant did not pause");

        let releasing = Arc::clone(&rust);
        let (released_tx, released_rx) = mpsc::channel();
        let release = thread::spawn(move || {
            releasing.release_locks();
            released_tx.send(()).unwrap();
        });
        assert_eq!(
            released_rx.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        fs::write(&participant_continue, b"").unwrap();
        assert!(!node_result(&mut node));
        released_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        release.join().unwrap();
        assert!(election.join(OWNER_FILENAME).exists());
        stop_node(node);
    }

    #[test]
    fn stale_recovery_is_identity_guarded_and_cohort_aware() {
        for (alive, identity, recover) in [
            (false, None, true),
            (true, Some("reused-start"), true),
            (true, Some("old-start"), false),
            (true, None, false),
        ] {
            let directory = tempfile::tempdir().unwrap();
            fs::write(
                directory.path().join(OWNER_FILENAME),
                serialize_owner(&owner(301, "old", "old-start")).unwrap(),
            )
            .unwrap();
            let registration = Registration::register_with(
                directory.path(),
                owner(302, "new", "new-start"),
                true,
                |_| alive,
                |_| identity.map(str::to_string),
            )
            .unwrap()
            .unwrap();
            assert_eq!(registration.is_primary(), recover);
        }

        let directory = tempfile::tempdir().unwrap();
        let identities = HashMap::from([(401, "primary-start"), (402, "secondary-start")]);
        let mut primary = Registration::register_with(
            directory.path(),
            owner(401, "primary", "primary-start"),
            true,
            |_| true,
            |pid| identities.get(&pid).map(|value| value.to_string()),
        )
        .unwrap()
        .unwrap();
        let mut secondary = Registration::register_with(
            directory.path(),
            owner(402, "secondary", "secondary-start"),
            true,
            |_| true,
            |pid| identities.get(&pid).map(|value| value.to_string()),
        )
        .unwrap()
        .unwrap();
        assert!(!primary
            .release_with(
                |_| true,
                |pid| identities.get(&pid).map(|value| value.to_string()),
            )
            .unwrap());
        assert!(directory.path().join(OWNER_FILENAME).exists());
        secondary.release().unwrap();
    }

    #[test]
    fn immutable_removal_claim_prevents_delayed_stale_unlink() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(OWNER_FILENAME);
        let stale = owner(501, "stale", "stale-start");
        let observed = serialize_owner(&stale).unwrap();
        fs::write(&path, &observed).unwrap();
        let claimant = owner(503, "claimant", "claimant-start");
        assert!(
            remove_observed_owner(directory.path(), &path, &observed, &stale, &claimant,).unwrap()
        );
        let successor = owner(502, "successor", "successor-start");
        fs::write(&path, serialize_owner(&successor).unwrap()).unwrap();
        assert!(
            !remove_observed_owner(directory.path(), &path, &observed, &stale, &claimant,).unwrap()
        );
        assert_eq!(
            parse_owner(&fs::read_to_string(path).unwrap()),
            Some(successor)
        );
    }

    #[test]
    fn malformed_owner_fails_closed_and_release_is_owner_guarded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(OWNER_FILENAME);
        fs::write(&path, b"incomplete").unwrap();
        let registration = Registration::register_with(
            directory.path(),
            owner(601, "new", "new-start"),
            true,
            |_| false,
            |_| None,
        )
        .unwrap()
        .unwrap();
        assert!(!registration.is_primary());
        assert_eq!(fs::read_to_string(&path).unwrap(), "incomplete");
    }

    #[test]
    fn legacy_electron_markers_are_identity_guarded() {
        let directory = tempfile::tempdir().unwrap();
        let marker_owner = owner(701, "electron", "electron-start");
        fs::write(
            directory
                .path()
                .join("client-state.running.701.electron-run.json"),
            serialize_owner(&marker_owner).unwrap(),
        )
        .unwrap();
        assert!(has_live_legacy_electron_with(
            directory.path(),
            999,
            |_| true,
            |_| Some("electron-start".to_string()),
        )
        .unwrap());
        assert!(!has_live_legacy_electron_with(
            directory.path(),
            999,
            |_| true,
            |_| Some("reused-start".to_string()),
        )
        .unwrap());
    }

    #[test]
    fn platform_paths_match_electron_fallbacks() {
        let resolve = |platform: &str, values: HashMap<&str, &str>, fallback: &str| {
            resolve_election_directory_for(
                platform,
                |name| values.get(name).map(OsString::from),
                Some(Path::new(fallback)),
            )
            .unwrap()
        };
        assert_eq!(
            resolve(
                "macos",
                HashMap::from([("HOME", "/Users/dev")]),
                "/fallback"
            ),
            "/Users/dev/.codenomad/client-state/election"
        );
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
        assert_eq!(
            resolve(
                "windows",
                HashMap::from([("USERPROFILE", "\\Users\\Dev")]),
                "C:\\Fallback"
            ),
            "C:\\Fallback\\.codenomad\\client-state\\election"
        );
    }

    #[test]
    fn current_process_identity_is_available_and_stable() {
        let identity = process_start_identity(std::process::id()).unwrap();
        assert_eq!(process_start_identity(std::process::id()), Some(identity));
    }
}
