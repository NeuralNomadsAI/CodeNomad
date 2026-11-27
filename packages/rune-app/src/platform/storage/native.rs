mod file_drafts;

use super::*;
use file_drafts::FileDraftQueue;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub struct Files {
    directory: PathBuf,
    _lock: File,
}
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn plain(path: &Path, directory: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta)
            if !linked(&meta)
                && if directory {
                    meta.is_dir()
                } else {
                    meta.is_file()
                } =>
        {
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !directory => Ok(()),
        _ => Err("invalid state storage path".into()),
    }
}
impl Files {
    // The host supplies its owned profile directory after successful bootstrap.
    pub fn open(directory: PathBuf) -> Result<Self> {
        if !directory.is_absolute() {
            return Err("absolute state directory required".into());
        }
        plain(directory.parent().ok_or("missing state parent")?, true)?;
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        plain(&directory, true)?;
        let path = directory.join("state.lock");
        plain(&path, false)?;
        #[allow(clippy::suspicious_open_options)]
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)?;
        lock.try_lock()?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }
    pub fn load(&self) -> Result<Option<Vec<u8>>> {
        self.load_file("state.json", MAX_BYTES)
    }
    fn load_file(&self, name: &str, limit: usize) -> Result<Option<Vec<u8>>> {
        let path = self.directory.join(name);
        plain(&path, false)?;
        let file = match File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if file.metadata()?.len() > limit as u64 {
            return Err("state too large".into());
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err("state too large".into());
        }
        Ok(Some(bytes))
    }
    pub fn save(&self, bytes: &[u8]) -> Result<()> {
        self.save_file("state.json", MAX_BYTES, bytes)
    }
    pub(super) fn remove_file(&self, name: &str) -> Result<()> {
        let path = self.directory.join(name);
        plain(&path, false)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    pub(super) fn restore_enabled(&self) -> Result<bool> {
        let Some(bytes) = self.load_file("restore-enabled.json", 128)? else {
            return Ok(true);
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        value
            .get("restoreEnabled")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| "invalid restore preference".into())
    }
    fn save_restore_enabled_with_sync(
        &self,
        enabled: bool,
        sync_dir: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<SaveStage> {
        let bytes = serde_json::to_vec(&serde_json::json!({ "restoreEnabled": enabled }))?;
        self.save_file_inner(
            "restore-enabled.json",
            128,
            &bytes,
            || true,
            |temporary, destination| {
                fs::rename(temporary, destination)?;
                Ok(true)
            },
            sync_dir,
        )
    }
    fn save_file(&self, name: &str, limit: usize, bytes: &[u8]) -> Result<()> {
        self.save_file_with(
            name,
            limit,
            bytes,
            || true,
            |temporary, destination| {
                fs::rename(temporary, destination)?;
                Ok(true)
            },
        )
        .map(|_| ())
    }
    pub(super) fn save_file_with(
        &self,
        name: &str,
        limit: usize,
        bytes: &[u8],
        still_current: impl Fn() -> bool,
        publish: impl FnOnce(&Path, &Path) -> Result<bool>,
    ) -> Result<bool> {
        match self.save_file_inner(name, limit, bytes, still_current, publish, sync_directory)? {
            SaveStage::Published => Ok(true),
            SaveStage::Skipped => Ok(false),
            SaveStage::PublishedDirSyncFailed(err) => Err(err),
        }
    }
    fn save_file_inner(
        &self,
        name: &str,
        limit: usize,
        bytes: &[u8],
        still_current: impl Fn() -> bool,
        publish: impl FnOnce(&Path, &Path) -> Result<bool>,
        sync_dir: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<SaveStage> {
        if bytes.len() > limit {
            return Err("state too large".into());
        }
        if !still_current() {
            return Ok(SaveStage::Skipped);
        }
        let destination = self.directory.join(name);
        plain(&destination, false)?;
        let temporary = self.directory.join(format!(
            ".state-{}.tmp",
            codenomad_client::http::client_id()?
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let published = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            publish(&temporary, &destination)
        })();
        match published {
            Ok(true) => match sync_dir(&self.directory) {
                Ok(()) => Ok(SaveStage::Published),
                Err(err) => Ok(SaveStage::PublishedDirSyncFailed(err.into())),
            },
            Ok(false) => {
                let _ = fs::remove_file(temporary);
                Ok(SaveStage::Skipped)
            }
            Err(err) => {
                let _ = fs::remove_file(temporary);
                Err(err)
            }
        }
    }
}

enum SaveStage {
    Skipped,
    Published,
    PublishedDirSyncFailed(Box<dyn std::error::Error + Send + Sync>),
}

fn sync_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(directory)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn reconcile_restore_marker(
    stage: Result<SaveStage>,
    actual: RestoreMode,
    expected: RestoreMode,
) -> Result<()> {
    match stage {
        Ok(SaveStage::Published | SaveStage::PublishedDirSyncFailed(_)) if actual == expected => {
            Ok(())
        }
        Ok(SaveStage::PublishedDirSyncFailed(err)) => Err(err),
        Ok(SaveStage::Published | SaveStage::Skipped) => {
            Err("restore preference verification failed".into())
        }
        Err(err) => Err(err),
    }
}

pub(super) struct WriteGate {
    pub(super) generation: u64,
    pub(super) restore: RestoreMode,
    pub(super) frozen: bool,
}

impl WriteGate {
    fn new(restore: RestoreMode) -> Self {
        Self {
            generation: 0,
            restore,
            frozen: false,
        }
    }

    pub(super) fn admit(&self) -> Option<u64> {
        (!self.frozen && self.restore == RestoreMode::Enabled).then_some(self.generation)
    }

    pub(super) fn allows(&self, generation: u64) -> bool {
        !self.frozen && self.restore == RestoreMode::Enabled && self.generation == generation
    }
}

#[derive(Clone)]
pub struct Store {
    files: std::sync::Arc<Files>,
    state_lock: std::sync::Arc<std::sync::Mutex<()>>,
    file_drafts_lock: std::sync::Arc<std::sync::Mutex<()>>,
    #[cfg(target_os = "windows")]
    preferences_frame_lock: std::sync::Arc<std::sync::Mutex<()>>,
    staged: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    file_drafts_queue: std::sync::Arc<std::sync::Mutex<FileDraftQueue>>,
    pub(super) gate: std::sync::Arc<std::sync::Mutex<WriteGate>>,
}
impl Store {
    pub(crate) fn memory_seen(&self) -> Result<std::collections::BTreeMap<String, i64>> {
        let _guard = self
            .state_lock
            .lock()
            .map_err(|_| "state store unavailable")?;
        memory_seen(&self.files)
    }

    pub(crate) async fn mark_memory_seen(&self, key: String, at: i64) -> Result<()> {
        if key.len() > 1024 {
            return Err("Invalid memory consultation key".into());
        }
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            let mut marks = memory_seen(&files)?;
            if marks.len() >= 256 && !marks.contains_key(&key) {
                if let Some(oldest) = marks
                    .iter()
                    .min_by_key(|(_, at)| *at)
                    .map(|(key, _)| key.clone())
                {
                    marks.remove(&oldest);
                }
            }
            let mark = marks.entry(key).or_default();
            *mark = (*mark).max(at);
            files.save_file("memory-seen.json", 320 * 1024, &serde_json::to_vec(&marks)?)
        })
        .await?
    }
    #[cfg(target_os = "windows")]
    pub(crate) fn preferences_frame(&self) -> Option<Vec<u8>> {
        let _guard = self.preferences_frame_lock.lock().ok()?;
        self.files.load_file("preferences.json", 512).ok().flatten()
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn save_preferences_frame(&self, bytes: &[u8]) -> Result<()> {
        let _guard = self
            .preferences_frame_lock
            .lock()
            .map_err(|_| "state store unavailable")?;
        self.files.save_file("preferences.json", 512, bytes)
    }

    pub async fn open(directory: PathBuf) -> Result<Self> {
        let (files, restore) = tokio::task::spawn_blocking(move || {
            let files = Files::open(directory)?;
            // Only an absent marker defaults to enabled; unreadable/malformed files stay Unknown
            // so writes stay blocked without being mistaken for an explicit Disable.
            let restore = match files.restore_enabled() {
                Ok(true) => RestoreMode::Enabled,
                Ok(false) => RestoreMode::Disabled,
                Err(_) => RestoreMode::Unknown,
            };
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>((files, restore))
        })
        .await??;
        Ok(Self {
            files: std::sync::Arc::new(files),
            state_lock: Default::default(),
            file_drafts_lock: Default::default(),
            #[cfg(target_os = "windows")]
            preferences_frame_lock: Default::default(),
            staged: Default::default(),
            file_drafts_queue: Default::default(),
            gate: std::sync::Arc::new(std::sync::Mutex::new(WriteGate::new(restore))),
        })
    }
    pub async fn load(&self) -> Result<Option<Vec<u8>>> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            files.load()
        })
        .await?
    }
    pub async fn restore_enabled(&self) -> Result<bool> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let gate = self.gate.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            let result = files.restore_enabled();
            if let Ok(mut gate) = gate.lock() {
                gate.restore = match &result {
                    Ok(true) => RestoreMode::Enabled,
                    Ok(false) => RestoreMode::Disabled,
                    Err(_) => RestoreMode::Unknown,
                };
            }
            result
        })
        .await?
    }
    pub fn begin_startup_mutation(&self) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.frozen = true;
            gate.generation = gate.generation.wrapping_add(1);
        }
        if let Ok(mut staged) = self.staged.lock() {
            *staged = None;
        }
        self.cancel_file_drafts_save();
    }
    fn remove_startup_files(
        files: &Files,
        state_lock: &std::sync::Mutex<()>,
        file_drafts_lock: &std::sync::Mutex<()>,
        staged: &std::sync::Mutex<Option<Vec<u8>>>,
        queue: &std::sync::Mutex<FileDraftQueue>,
    ) -> ClearOutcome {
        let (state_ok, outlines_ok) = match state_lock.lock() {
            Ok(_guard) => {
                if let Ok(mut staged) = staged.lock() {
                    *staged = None;
                }
                let state_ok = files.remove_file("state.json").is_ok();
                let outlines_ok = files.remove_file("outlines-v1.json").is_ok();
                (state_ok, outlines_ok)
            }
            Err(_) => (false, false),
        };
        // Release state_lock before waiting for file_drafts_lock so startup-state
        // reads and writes are never blocked behind a slow file-draft sync.
        if let Ok(mut state) = queue.lock() {
            state.cancel_all();
        }
        let drafts_ok = match file_drafts_lock.lock() {
            Ok(_drafts) => files.remove_file("workspace-file-drafts.json").is_ok(),
            Err(_) => false,
        };
        ClearOutcome {
            state_ok,
            outlines_ok,
            drafts_ok,
        }
    }
    pub async fn set_restore_enabled(&self, enabled: bool) -> Result<bool> {
        self.set_restore_enabled_with_sync(enabled, sync_directory)
            .await
    }
    async fn set_restore_enabled_with_sync(
        &self,
        enabled: bool,
        sync_dir: impl FnOnce(&Path) -> std::io::Result<()> + Send + 'static,
    ) -> Result<bool> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let file_drafts_lock = self.file_drafts_lock.clone();
        let staged = self.staged.clone();
        let queue = self.file_drafts_queue.clone();
        let gate = self.gate.clone();
        tokio::task::spawn_blocking(move || {
            let previous = if let Ok(mut gate) = gate.lock() {
                gate.frozen = true;
                gate.generation = gate.generation.wrapping_add(1);
                gate.restore
            } else {
                return Err("state store unavailable".into());
            };
            if let Ok(mut state) = queue.lock() {
                state.cancel_all();
            }
            let expected = if enabled {
                RestoreMode::Enabled
            } else {
                RestoreMode::Disabled
            };
            if enabled {
                // Only purge leftover files when transitioning from a confirmed Disabled state;
                // an unreadable/malformed preference must not erase user files on enable.
                if previous == RestoreMode::Disabled {
                    let cleaned = Self::remove_startup_files(
                        &files,
                        &state_lock,
                        &file_drafts_lock,
                        &staged,
                        &queue,
                    );
                    if !cleaned.all_ok() {
                        if let Ok(mut gate) = gate.lock() {
                            gate.frozen = false;
                        }
                        return Err("startup state cleanup failed".into());
                    }
                }
                let saved = match state_lock.lock() {
                    Ok(_guard) => {
                        let stage = files.save_restore_enabled_with_sync(true, sync_dir);
                        let actual = match files.restore_enabled() {
                            Ok(true) => RestoreMode::Enabled,
                            Ok(false) => RestoreMode::Disabled,
                            Err(_) => RestoreMode::Unknown,
                        };
                        if let Ok(mut gate) = gate.lock() {
                            gate.restore = actual;
                            gate.generation = gate.generation.wrapping_add(1);
                            gate.frozen = false;
                        }
                        reconcile_restore_marker(stage, actual, expected)
                    }
                    Err(_) => {
                        if let Ok(mut gate) = gate.lock() {
                            gate.frozen = false;
                        }
                        Err("state store unavailable".into())
                    }
                };
                saved?;
                return Ok(true);
            }
            let saved = match state_lock.lock() {
                Ok(_guard) => {
                    let stage = files.save_restore_enabled_with_sync(false, sync_dir);
                    let actual = match files.restore_enabled() {
                        Ok(true) => RestoreMode::Enabled,
                        Ok(false) => RestoreMode::Disabled,
                        Err(_) => RestoreMode::Unknown,
                    };
                    if let Ok(mut gate) = gate.lock() {
                        gate.restore = actual;
                        gate.generation = gate.generation.wrapping_add(1);
                    }
                    reconcile_restore_marker(stage, actual, expected)
                }
                Err(_) => Err("state store unavailable".into()),
            };
            if let Err(err) = saved {
                if let Ok(mut gate) = gate.lock() {
                    gate.frozen = false;
                }
                return Err(err);
            }
            let cleaned =
                Self::remove_startup_files(&files, &state_lock, &file_drafts_lock, &staged, &queue);
            if let Ok(mut gate) = gate.lock() {
                gate.frozen = false;
            }
            Ok(cleaned.all_ok())
        })
        .await?
    }
    pub async fn clear_startup_state(&self) -> Result<ClearOutcome> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let file_drafts_lock = self.file_drafts_lock.clone();
        let staged = self.staged.clone();
        let queue = self.file_drafts_queue.clone();
        let gate = self.gate.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(mut gate) = gate.lock() {
                gate.frozen = true;
                gate.generation = gate.generation.wrapping_add(1);
            }
            if let Ok(mut state) = queue.lock() {
                state.cancel_all();
            }
            let outcome =
                Self::remove_startup_files(&files, &state_lock, &file_drafts_lock, &staged, &queue);
            if let Ok(mut gate) = gate.lock() {
                gate.frozen = false;
            }
            Ok(outcome)
        })
        .await?
    }
    pub async fn load_outlines(&self) -> Result<Option<Vec<u8>>> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            files.load_file("outlines-v1.json", OUTLINE_BYTES)
        })
        .await?
    }
    pub fn start_save_outlines(
        &self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        self.start_save_outlines_with(move || bytes)
    }
    pub fn start_save_outlines_with(
        &self,
        encode: impl FnOnce() -> Vec<u8> + Send + 'static,
    ) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        // Capture generation synchronously at admission so a task polled after Clear cannot pass,
        // while keeping outline serialization and hashing off the UI thread.
        let generation = self.gate.lock().ok().and_then(|g| g.admit());
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let gate = self.gate.clone();
        async move {
            let Some(generation) = generation else {
                return Ok(());
            };
            tokio::task::spawn_blocking(move || {
                if !gate
                    .lock()
                    .map_err(|_| "state store unavailable")?
                    .allows(generation)
                {
                    return Ok(());
                }
                let bytes = encode();
                let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
                if !gate
                    .lock()
                    .map_err(|_| "state store unavailable")?
                    .allows(generation)
                {
                    return Ok(());
                }
                files.save_file("outlines-v1.json", OUTLINE_BYTES, &bytes)
            })
            .await?
        }
    }
    pub async fn save_outlines(&self, bytes: Vec<u8>) -> Result<()> {
        self.start_save_outlines(bytes).await
    }
    pub fn start_save(
        &self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        // Capture generation synchronously at admission so a task polled after Clear cannot pass.
        let generation = self.gate.lock().ok().and_then(|g| g.admit());
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let staged = self.staged.clone();
        let gate = self.gate.clone();
        async move {
            let Some(generation) = generation else {
                return Ok(());
            };
            tokio::task::spawn_blocking(move || {
                let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
                if !gate
                    .lock()
                    .map_err(|_| "state store unavailable")?
                    .allows(generation)
                {
                    return Ok(());
                }
                if staged
                    .lock()
                    .map_err(|_| "state store unavailable")?
                    .as_ref()
                    .is_some_and(|latest| *latest != bytes)
                {
                    return Ok(());
                }
                files.save(&bytes)
            })
            .await?
        }
    }
    pub async fn save(&self, bytes: Vec<u8>) -> Result<()> {
        self.start_save(bytes).await
    }
    pub fn stage(&self, bytes: &[u8], _: &[(String, String)]) {
        if let Ok(mut staged) = self.staged.lock() {
            if bytes.is_empty() {
                *staged = None;
            } else if self.gate.lock().is_ok_and(|g| g.admit().is_some()) {
                *staged = Some(bytes.to_vec());
            }
        }
    }
    pub fn save_exit(&self, bytes: Vec<u8>) -> Result<()> {
        if self.gate.lock().ok().and_then(|g| g.admit()).is_none() {
            return Ok(());
        }
        self.stage(&bytes, &[]);
        crate::platform::block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(5), self.save(bytes)).await?
        })
    }
}

fn memory_seen(files: &Files) -> Result<std::collections::BTreeMap<String, i64>> {
    let marks: std::collections::BTreeMap<String, i64> = files
        .load_file("memory-seen.json", 320 * 1024)?
        .as_deref()
        .map(serde_json::from_slice)
        .transpose()?
        .unwrap_or_default();
    if marks.len() > 256 || marks.keys().any(|k| k.len() > 1024) {
        return Err("Invalid memory consultation state".into());
    }
    Ok(marks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/rune-native-storage-tests");
            fs::create_dir_all(&parent).unwrap();
            let dir = parent.join(format!(
                "trial-native-storage-{}",
                codenomad_client::http::client_id().unwrap()
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn preferences_frame_does_not_block_on_state_lock() {
        let dir = TestDir::new();
        let store = crate::platform::block_on(Store::open(dir.0.join("rune"))).unwrap();
        let _state_guard = store.state_lock.lock().unwrap();
        let pref_store = store.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let saved = pref_store.save_preferences_frame(br#"{"x":10}"#).is_ok();
            let loaded = pref_store.preferences_frame();
            let _ = tx.send((saved, loaded));
        });
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)),
            Ok((true, Some(br#"{"x":10}"#.to_vec())))
        );
    }

    #[test]
    fn dir_sync_failure_after_marker_rename_reconciles_state_and_cleanup() {
        let dir = TestDir::new();
        let rune_dir = dir.0.join("rune");
        crate::platform::block_on(async {
            let store = Store::open(rune_dir.clone()).await.unwrap();
            store.stage(b"workspace", &[]);
            store.save(b"workspace".to_vec()).await.unwrap();
            store.save_outlines(b"outlines".to_vec()).await.unwrap();
            store.save_file_drafts(b"drafts").unwrap();

            let disabled = store
                .set_restore_enabled_with_sync(false, |_| {
                    Err(std::io::Error::other("simulated dir sync failure"))
                })
                .await
                .unwrap();
            assert!(disabled);
            {
                let gate = store.gate.lock().unwrap();
                assert!(gate.restore == RestoreMode::Disabled);
                assert!(!gate.frozen);
            }
            assert!(!store.restore_enabled().await.unwrap());
            assert_eq!(store.load().await.unwrap(), None);
            assert_eq!(store.load_outlines().await.unwrap(), None);
            assert_eq!(store.load_file_drafts().await.unwrap(), None);
            store.stage(b"blocked", &[]);
            store.save(b"blocked".to_vec()).await.unwrap();
            assert_eq!(store.load().await.unwrap(), None);

            let enabled = store
                .set_restore_enabled_with_sync(true, |_| {
                    Err(std::io::Error::other("simulated dir sync failure"))
                })
                .await
                .unwrap();
            assert!(enabled);
            {
                let gate = store.gate.lock().unwrap();
                assert!(gate.restore == RestoreMode::Enabled);
                assert!(!gate.frozen);
            }
            assert!(store.restore_enabled().await.unwrap());
            store.stage(b"live", &[]);
            store.save(b"live".to_vec()).await.unwrap();
            assert_eq!(store.load().await.unwrap().as_deref(), Some(&b"live"[..]));
        });
        assert!(
            fs::read_dir(&rune_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp"))
        );
    }

    #[test]
    fn pre_rename_marker_failure_returns_error_without_removing_startup_files() {
        let dir = TestDir::new();
        let rune_dir = dir.0.join("rune");
        crate::platform::block_on(async {
            let store = Store::open(rune_dir.clone()).await.unwrap();
            store.stage(b"preserved", &[]);
            store.save(b"preserved".to_vec()).await.unwrap();
            fs::create_dir(rune_dir.join("restore-enabled.json")).unwrap();

            assert!(
                store
                    .set_restore_enabled_with_sync(false, |_| Ok(()))
                    .await
                    .is_err()
            );
            {
                let gate = store.gate.lock().unwrap();
                assert!(gate.restore == RestoreMode::Unknown);
                assert!(!gate.frozen);
            }
            assert_eq!(
                store.load().await.unwrap().as_deref(),
                Some(&b"preserved"[..])
            );
        });
    }
}
