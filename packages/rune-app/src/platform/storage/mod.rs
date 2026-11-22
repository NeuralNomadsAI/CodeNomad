use crate::history::Result;
use crate::workspace::MAX_BYTES;

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;
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
            let path = self.directory.join("state.json");
            plain(&path, false)?;
            let file = match File::open(path) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            if file.metadata()?.len() > MAX_BYTES as u64 {
                return Err("state too large".into());
            }
            let mut bytes = Vec::new();
            file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > MAX_BYTES {
                return Err("state too large".into());
            }
            Ok(Some(bytes))
        }
        pub fn save(&self, bytes: &[u8]) -> Result<()> {
            if bytes.len() > MAX_BYTES {
                return Err("state too large".into());
            }
            let destination = self.directory.join("state.json");
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
                fs::rename(&temporary, &destination)?;
                #[cfg(unix)]
                File::open(&self.directory)?.sync_all()?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(temporary);
            }
            result
        }
    }
    #[derive(Clone)]
    pub struct Store(std::sync::Arc<std::sync::Mutex<Files>>);
    impl Store {
        pub async fn open(directory: PathBuf) -> Result<Self> {
            let files = tokio::task::spawn_blocking(move || Files::open(directory)).await??;
            Ok(Self(std::sync::Arc::new(std::sync::Mutex::new(files))))
        }
        pub async fn load(&self) -> Result<Option<Vec<u8>>> {
            let files = self.0.clone();
            tokio::task::spawn_blocking(move || {
                files.lock().map_err(|_| "state store unavailable")?.load()
            })
            .await?
        }
        pub async fn save(&self, bytes: Vec<u8>) -> Result<()> {
            let files = self.0.clone();
            tokio::task::spawn_blocking(move || {
                files
                    .lock()
                    .map_err(|_| "state store unavailable")?
                    .save(&bytes)
            })
            .await?
        }
    }
}
#[cfg(not(target_arch = "wasm32"))]
pub use native::Store;

#[cfg(target_arch = "wasm32")]
#[derive(Clone)]
pub struct Store(web_sys::Storage);
#[cfg(target_arch = "wasm32")]
impl Store {
    const KEY: &'static str = "codenomad.rune.alpha.client-state.v1";
    pub async fn open() -> Result<Self> {
        web_sys::window()
            .and_then(|w| w.session_storage().ok().flatten())
            .map(Self)
            .ok_or_else(|| "state store unavailable".into())
    }
    pub async fn load(&self) -> Result<Option<Vec<u8>>> {
        let raw = self
            .0
            .get_item(Self::KEY)
            .map_err(|_| "state read failed")?;
        if raw.as_ref().is_some_and(|v| v.len() > MAX_BYTES) {
            return Err("state too large".into());
        }
        Ok(raw.map(String::into_bytes))
    }
    pub async fn save(&self, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > MAX_BYTES {
            return Err("state too large".into());
        }
        let value = std::str::from_utf8(&bytes)?;
        self.0
            .set_item(Self::KEY, value)
            .map_err(|_| "state write failed".into())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
