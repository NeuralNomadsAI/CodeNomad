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
        Ok(value["restoreEnabled"].as_bool().unwrap_or(true))
    }
    pub(super) fn save_restore_enabled(&self, enabled: bool) -> Result<()> {
        let bytes = serde_json::to_vec(&serde_json::json!({ "restoreEnabled": enabled }))?;
        self.save_file("restore-enabled.json", 128, &bytes)
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
        if bytes.len() > limit {
            return Err("state too large".into());
        }
        if !still_current() {
            return Ok(false);
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
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            if !publish(&temporary, &destination)? {
                return Ok(false);
            }
            #[cfg(unix)]
            File::open(&self.directory)?.sync_all()?;
            Ok(true)
        })();
        if !matches!(result, Ok(true)) {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

#[derive(Clone)]
pub struct Store {
    files: std::sync::Arc<Files>,
    state_lock: std::sync::Arc<std::sync::Mutex<()>>,
    file_drafts_lock: std::sync::Arc<std::sync::Mutex<()>>,
    staged: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    file_drafts_queue: std::sync::Arc<std::sync::Mutex<FileDraftQueue>>,
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
        let _guard = self.state_lock.lock().ok()?;
        self.files.load_file("preferences.json", 512).ok().flatten()
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn save_preferences_frame(&self, bytes: &[u8]) -> Result<()> {
        let _guard = self
            .state_lock
            .lock()
            .map_err(|_| "state store unavailable")?;
        self.files.save_file("preferences.json", 512, bytes)
    }

    pub async fn open(directory: PathBuf) -> Result<Self> {
        let files = tokio::task::spawn_blocking(move || Files::open(directory)).await??;
        Ok(Self {
            files: std::sync::Arc::new(files),
            state_lock: Default::default(),
            file_drafts_lock: Default::default(),
            staged: Default::default(),
            file_drafts_queue: Default::default(),
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
        tokio::task::spawn_blocking(move || {
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            files.restore_enabled()
        })
        .await?
    }
    pub async fn set_restore_enabled(&self, enabled: bool) -> Result<()> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let file_drafts_lock = self.file_drafts_lock.clone();
        let staged = self.staged.clone();
        let queue = self.file_drafts_queue.clone();
        tokio::task::spawn_blocking(move || {
            if !enabled && let Ok(mut state) = queue.lock() {
                state.cancel_all();
            }
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            files.save_restore_enabled(enabled)?;
            if !enabled {
                if let Ok(mut staged) = staged.lock() {
                    *staged = None;
                }
                files.remove_file("state.json")?;
                files.remove_file("outlines-v1.json")?;
                let _drafts = file_drafts_lock
                    .lock()
                    .map_err(|_| "state store unavailable")?;
                files.remove_file("workspace-file-drafts.json")?;
            }
            Ok(())
        })
        .await?
    }
    pub async fn clear_startup_state(&self) -> Result<()> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let file_drafts_lock = self.file_drafts_lock.clone();
        let staged = self.staged.clone();
        let queue = self.file_drafts_queue.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(mut state) = queue.lock() {
                state.cancel_all();
            }
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            if let Ok(mut staged) = staged.lock() {
                *staged = None;
            }
            files.remove_file("state.json")?;
            files.remove_file("outlines-v1.json")?;
            let _drafts = file_drafts_lock
                .lock()
                .map_err(|_| "state store unavailable")?;
            files.remove_file("workspace-file-drafts.json")
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
    pub async fn save_outlines(&self, bytes: Vec<u8>) -> Result<()> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
            files.save_file("outlines-v1.json", OUTLINE_BYTES, &bytes)
        })
        .await?
    }
    pub async fn save(&self, bytes: Vec<u8>) -> Result<()> {
        let files = self.files.clone();
        let state_lock = self.state_lock.clone();
        let staged = self.staged.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = state_lock.lock().map_err(|_| "state store unavailable")?;
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
    pub fn stage(&self, bytes: &[u8], _: &[(String, String)]) {
        if let Ok(mut staged) = self.staged.lock() {
            *staged = Some(bytes.to_vec());
        }
    }
    pub fn save_exit(&self, bytes: Vec<u8>) -> Result<()> {
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
