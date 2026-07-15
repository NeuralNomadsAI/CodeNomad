use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) const PRIMARY_LOCK_FILENAME: &str = "client-state.primary.lock";
const REGISTRATION_LOCK_FILENAME: &str = "client-state.registration.lock";
const REGISTRATION_OWNER_FILENAME: &str = "client-state.registration.owner";
const REGISTRATION_LOCK_TIMEOUT: Duration = Duration::from_millis(250);
const REGISTRATION_LOCK_RETRY_DELAY: Duration = Duration::from_millis(10);
pub(super) const RUNNING_MARKER_PREFIX: &str = "client-state.running.";
pub(super) const RUNNING_MARKER_SUFFIX: &str = ".lock";

static NEXT_RUNNING_MARKER_ID: AtomicU64 = AtomicU64::new(0);

pub(super) struct ProcessState {
    primary_lock: Mutex<Option<File>>,
    running_marker: Mutex<Option<RunningMarker>>,
    registration_file: Option<File>,
}

pub(super) struct Registration {
    primary_lock: Option<File>,
    running_marker: RunningMarker,
    registration_file: File,
    holds_registration_lock: bool,
}

impl Registration {
    pub(super) fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        let registration_path = app_data_dir.join(REGISTRATION_LOCK_FILENAME);
        let registration_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&registration_path)
            .map_err(|err| {
                format!(
                    "failed to open registration lock {}: {err}",
                    registration_path.display()
                )
            })?;
        let has_registration_lock =
            try_acquire_registration_lock(&registration_file, REGISTRATION_LOCK_TIMEOUT)?;
        if !has_registration_lock {
            eprintln!(
                "[client-state] registration lock timed out; continuing as a secondary client"
            );
        }

        let registration_id = create_registration_id();
        let registration_owner_path = app_data_dir.join(REGISTRATION_OWNER_FILENAME);
        let acknowledged_registration = if has_registration_lock {
            record_registration_owner(&registration_owner_path, &registration_id)?;
            None
        } else {
            read_registration_owner(&registration_owner_path)
        };
        let running_marker =
            create_running_marker(app_data_dir, acknowledged_registration.as_deref())?;
        let lock_path = app_data_dir.join(PRIMARY_LOCK_FILENAME);
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&lock_path)
            .map_err(|err| format!("failed to open primary lock {}: {err}", lock_path.display()))?;

        let primary_lock = if !has_registration_lock {
            None
        } else {
            match FileExt::try_lock_exclusive(&lock_file) {
                Ok(()) => {
                    match has_other_live_running_markers(
                        app_data_dir,
                        &running_marker.path,
                        &registration_id,
                    ) {
                        Ok(false) => Some(lock_file),
                        Ok(true) => {
                            release_primary_file(&lock_file);
                            None
                        }
                        Err(err) => {
                            eprintln!("[client-state] failed to inspect running markers: {err}");
                            release_primary_file(&lock_file);
                            None
                        }
                    }
                }
                Err(err) => {
                    if !is_lock_contended(&err) {
                        eprintln!("[client-state] failed to acquire primary lock: {err}");
                    }
                    None
                }
            }
        };

        Ok(Self {
            primary_lock,
            running_marker,
            registration_file,
            holds_registration_lock: has_registration_lock,
        })
    }

    pub(super) fn is_primary(&self) -> bool {
        self.primary_lock.is_some()
    }

    pub(super) fn finish(self) -> ProcessState {
        if self.holds_registration_lock {
            if let Err(err) = FileExt::unlock(&self.registration_file) {
                eprintln!("[client-state] failed to release registration lock: {err}");
            }
        }
        ProcessState {
            primary_lock: Mutex::new(self.primary_lock),
            running_marker: Mutex::new(Some(self.running_marker)),
            registration_file: Some(self.registration_file),
        }
    }
}

fn try_acquire_registration_lock(file: &File, timeout: Duration) -> Result<bool, String> {
    let started_at = Instant::now();
    loop {
        match FileExt::try_lock_exclusive(file) {
            Ok(()) => return Ok(true),
            Err(err) if is_lock_contended(&err) => {
                if started_at.elapsed() >= timeout {
                    return Ok(false);
                }
                std::thread::sleep(REGISTRATION_LOCK_RETRY_DELAY);
            }
            Err(err) => return Err(format!("failed to acquire registration lock: {err}")),
        }
    }
}

fn create_registration_id() -> String {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{}.{}.{}",
        std::process::id(),
        started_at,
        NEXT_RUNNING_MARKER_ID.fetch_add(1, Ordering::Relaxed)
    )
}

impl ProcessState {
    pub(super) fn disabled() -> Self {
        Self {
            primary_lock: Mutex::new(None),
            running_marker: Mutex::new(None),
            registration_file: None,
        }
    }

    pub(super) fn is_primary(&self) -> bool {
        self.primary_lock
            .lock()
            .map(|lock| lock.is_some())
            .unwrap_or(false)
    }

    pub(super) fn release_locks(&self) {
        let Some(registration_file) = &self.registration_file else {
            return;
        };
        match try_acquire_registration_lock(registration_file, REGISTRATION_LOCK_TIMEOUT) {
            Ok(true) => {}
            Ok(false) => {
                eprintln!(
                    "[client-state] registration lock timed out; retaining ownership until process exit"
                );
                return;
            }
            Err(err) => {
                eprintln!("[client-state] failed to serialize lock release: {err}");
                return;
            }
        }
        let running_marker = self
            .running_marker
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take();
        drop(running_marker);

        let primary_lock = self
            .primary_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take();
        if let Some(file) = primary_lock {
            release_primary_file(&file);
        }
        if let Err(err) = FileExt::unlock(registration_file) {
            eprintln!("[client-state] failed to release registration lock: {err}");
        }
    }
}

struct RunningMarker {
    path: PathBuf,
    file: Option<File>,
}

impl Drop for RunningMarker {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            if let Err(err) = FileExt::unlock(&file) {
                eprintln!("[client-state] failed to release running marker: {err}");
            }
            drop(file);
        }
        if let Err(err) = fs::remove_file(&self.path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[client-state] failed to remove running marker: {err}");
            }
        }
    }
}

fn create_running_marker(
    app_data_dir: &Path,
    acknowledged_registration: Option<&str>,
) -> Result<RunningMarker, String> {
    loop {
        let marker = tempfile::Builder::new()
            .prefix(".client-state.running.pending.")
            .tempfile_in(app_data_dir)
            .map_err(|err| format!("failed to create running marker: {err}"))?;
        FileExt::try_lock_exclusive(marker.as_file())
            .map_err(|err| format!("failed to lock running marker: {err}"))?;
        let marker_id = NEXT_RUNNING_MARKER_ID.fetch_add(1, Ordering::Relaxed);
        let acknowledgement = acknowledged_registration
            .map(|registration_id| format!(".acknowledges.{registration_id}"))
            .unwrap_or_default();
        let path = app_data_dir.join(format!(
            "{RUNNING_MARKER_PREFIX}{}.{marker_id}{acknowledgement}{RUNNING_MARKER_SUFFIX}",
            std::process::id()
        ));
        match marker.persist_noclobber(&path) {
            Ok(file) => {
                return Ok(RunningMarker {
                    path,
                    file: Some(file),
                });
            }
            Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(format!("failed to publish running marker: {}", err.error));
            }
        }
    }
}

fn has_other_live_running_markers(
    app_data_dir: &Path,
    current_marker_path: &Path,
    registration_id: &str,
) -> Result<bool, String> {
    let entries = fs::read_dir(app_data_dir)
        .map_err(|err| format!("failed to read {}: {err}", app_data_dir.display()))?;
    let mut has_live_marker = false;

    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if path == current_marker_path
            || !name.starts_with(RUNNING_MARKER_PREFIX)
            || !name.ends_with(RUNNING_MARKER_SUFFIX)
        {
            continue;
        }

        let file = match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                return Err(format!(
                    "failed to open running marker {}: {err}",
                    path.display()
                ));
            }
        };
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                if let Err(err) = FileExt::unlock(&file) {
                    eprintln!("[client-state] failed to unlock stale running marker: {err}");
                }
                drop(file);
                if let Err(err) = fs::remove_file(&path) {
                    if err.kind() != std::io::ErrorKind::NotFound {
                        eprintln!("[client-state] failed to remove stale running marker: {err}");
                    }
                }
            }
            Err(err) if is_lock_contended(&err) => {
                if !name.ends_with(&format!(
                    ".acknowledges.{registration_id}{RUNNING_MARKER_SUFFIX}"
                )) {
                    has_live_marker = true;
                }
            }
            Err(err) => {
                return Err(format!(
                    "failed to inspect running marker {}: {err}",
                    path.display()
                ));
            }
        }
    }

    Ok(has_live_marker)
}

fn record_registration_owner(path: &Path, registration_id: &str) -> Result<(), String> {
    fs::write(path, registration_id)
        .map_err(|err| format!("failed to record registration owner: {err}"))
}

fn read_registration_owner(path: &Path) -> Option<String> {
    let owner = fs::read_to_string(path).ok()?;
    (!owner.is_empty()).then_some(owner)
}

fn release_primary_file(file: &File) {
    if let Err(err) = FileExt::unlock(file) {
        eprintln!("[client-state] failed to release primary lock: {err}");
    }
}

fn is_lock_contended(error: &std::io::Error) -> bool {
    let expected = fs2::lock_contended_error();
    error.kind() == std::io::ErrorKind::WouldBlock
        || (error.raw_os_error().is_some() && error.raw_os_error() == expected.raw_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_lock_contention_times_out() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(REGISTRATION_LOCK_FILENAME);
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .unwrap();
        FileExt::lock_exclusive(&owner).unwrap();
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();

        let started_at = Instant::now();
        assert!(!try_acquire_registration_lock(&contender, Duration::from_millis(20)).unwrap());
        assert!(started_at.elapsed() < Duration::from_secs(1));

        FileExt::unlock(&owner).unwrap();
    }

    #[test]
    fn registration_timeout_initializes_a_secondary_process() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(REGISTRATION_LOCK_FILENAME);
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .unwrap();
        FileExt::lock_exclusive(&owner).unwrap();
        let registration_id = "registering-process";
        record_registration_owner(
            &directory.path().join(REGISTRATION_OWNER_FILENAME),
            registration_id,
        )
        .unwrap();

        let started_at = Instant::now();
        let registration = Registration::initialize(directory.path()).unwrap();
        assert!(!registration.is_primary());
        assert!(started_at.elapsed() < Duration::from_secs(2));
        let marker_name = registration
            .running_marker
            .path
            .file_name()
            .unwrap()
            .to_string_lossy();
        assert!(marker_name.contains(&format!(".acknowledges.{registration_id}")));

        FileExt::unlock(&owner).unwrap();
        registration.finish().release_locks();
    }

    #[test]
    fn process_release_waits_for_registration_election() {
        use std::sync::{mpsc, Arc};

        let directory = tempfile::tempdir().unwrap();
        let registration = Registration::initialize(directory.path()).unwrap();
        assert!(registration.is_primary());
        let process = Arc::new(registration.finish());
        let registration_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.path().join(REGISTRATION_LOCK_FILENAME))
            .unwrap();
        FileExt::lock_exclusive(&registration_file).unwrap();

        let releasing_process = Arc::clone(&process);
        let (released_tx, released_rx) = mpsc::channel();
        let release = std::thread::spawn(move || {
            releasing_process.release_locks();
            released_tx.send(()).unwrap();
        });
        assert_eq!(
            released_rx.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );

        FileExt::unlock(&registration_file).unwrap();
        released_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        release.join().unwrap();
        assert!(!process.is_primary());
    }

    #[test]
    fn registering_process_ignores_timeout_marker_that_acknowledges_it() {
        let directory = tempfile::tempdir().unwrap();
        let registration_id = "registering-process";
        let registering_marker = create_running_marker(directory.path(), None).unwrap();
        let timeout_marker =
            create_running_marker(directory.path(), Some(registration_id)).unwrap();

        assert!(!has_other_live_running_markers(
            directory.path(),
            &registering_marker.path,
            registration_id,
        )
        .unwrap());

        drop(timeout_marker);
        drop(registering_marker);
    }
}
