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
    pub struct Store {
        files: std::sync::Arc<std::sync::Mutex<Files>>,
        staged: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    }
    impl Store {
        pub async fn open(directory: PathBuf) -> Result<Self> {
            let files = tokio::task::spawn_blocking(move || Files::open(directory)).await??;
            Ok(Self {
                files: std::sync::Arc::new(std::sync::Mutex::new(files)),
                staged: Default::default(),
            })
        }
        pub async fn load(&self) -> Result<Option<Vec<u8>>> {
            let files = self.files.clone();
            tokio::task::spawn_blocking(move || {
                files.lock().map_err(|_| "state store unavailable")?.load()
            })
            .await?
        }
        pub async fn save(&self, bytes: Vec<u8>) -> Result<()> {
            let files = self.files.clone();
            let staged = self.staged.clone();
            tokio::task::spawn_blocking(move || {
                let files = files.lock().map_err(|_| "state store unavailable")?;
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
}
#[cfg(not(target_arch = "wasm32"))]
pub use native::Store;

#[cfg(target_arch = "wasm32")]
#[derive(Clone)]
pub struct Store {
    storage: web_sys::Storage,
    staged: std::rc::Rc<BrowserStage>,
    _listener: std::rc::Rc<BrowserListener>,
}
#[cfg(target_arch = "wasm32")]
struct BrowserStage {
    window: web_sys::Window,
    storage: web_sys::Storage,
    payload: std::cell::RefCell<(Vec<u8>, Vec<(String, String)>)>,
    departing: std::cell::Cell<bool>,
}
#[cfg(target_arch = "wasm32")]
impl BrowserStage {
    fn depart(&self) {
        if self.departing.get() {
            return;
        }
        let Ok(current) = self.payload.try_borrow() else {
            return;
        };
        let Ok(text) = std::str::from_utf8(&current.0) else {
            return;
        };
        if current.0.is_empty() {
            return;
        }
        self.departing.set(true);
        if self.storage.set_item(Store::KEY, text).is_err()
            || self.storage.set_item(Store::RELEASED, "1").is_err()
        {
            return;
        }
        for (base, id) in &current.1 {
            let request = web_sys::RequestInit::new();
            request.set_method("DELETE");
            if js_sys::Reflect::set(request.as_ref(), &"keepalive".into(), &true.into()).ok()
                != Some(true)
            {
                continue;
            }
            request.set_credentials(web_sys::RequestCredentials::Include);
            let _ = self
                .window
                .fetch_with_str_and_init(&format!("{base}api/workspaces/{id}"), &request);
        }
    }
}
#[cfg(target_arch = "wasm32")]
struct BrowserListener {
    window: web_sys::Window,
    callback: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::PageTransitionEvent)>,
    staged: std::rc::Rc<BrowserStage>,
}
#[cfg(target_arch = "wasm32")]
impl Drop for BrowserListener {
    fn drop(&mut self) {
        use wasm_bindgen::JsCast;
        // Winit unload can drop the last Store before its pagehide callback runs.
        self.staged.depart();
        let _ = self.window.remove_event_listener_with_callback(
            "pagehide",
            self.callback.as_ref().unchecked_ref(),
        );
    }
}
#[cfg(target_arch = "wasm32")]
impl Store {
    const KEY: &'static str = "codenomad.rune.alpha.client-state.v1";
    const RELEASED: &'static str = "codenomad.rune.alpha.records-released";
    pub async fn open() -> Result<Self> {
        use wasm_bindgen::JsCast;
        let window = web_sys::window().ok_or("state store unavailable")?;
        let storage = window
            .session_storage()
            .map_err(|_| "state store unavailable")?
            .ok_or("state store unavailable")?;
        let staged = std::rc::Rc::new(BrowserStage {
            window: window.clone(),
            storage: storage.clone(),
            payload: Default::default(),
            departing: Default::default(),
        });
        let copy = staged.clone();
        let callback =
            wasm_bindgen::closure::Closure::new(move |event: web_sys::PageTransitionEvent| {
                if event.persisted() {
                    return;
                }
                copy.depart();
            });
        window
            .add_event_listener_with_callback("pagehide", callback.as_ref().unchecked_ref())
            .map_err(|_| "state lifecycle unavailable")?;
        Ok(Self {
            storage,
            staged: staged.clone(),
            _listener: std::rc::Rc::new(BrowserListener {
                window,
                callback,
                staged,
            }),
        })
    }
    pub async fn load(&self) -> Result<Option<Vec<u8>>> {
        let raw = self
            .storage
            .get_item(Self::KEY)
            .map_err(|_| "state read failed")?;
        if raw.as_ref().is_some_and(|v| v.len() > MAX_BYTES) {
            return Err("state too large".into());
        }
        Ok(raw.map(String::into_bytes))
    }
    pub async fn save(&self, bytes: Vec<u8>) -> Result<()> {
        if self.staged.payload.borrow().0 != bytes {
            return Ok(());
        }
        self.save_now(&bytes)
    }
    fn save_now(&self, bytes: &[u8]) -> Result<()> {
        if self.staged.departing.get() {
            return Err("window departing".into());
        }
        if bytes.len() > MAX_BYTES {
            return Err("state too large".into());
        }
        let value = std::str::from_utf8(&bytes)?;
        self.storage
            .set_item(Self::KEY, value)
            .map_err(|_| "state write failed")?;
        self.storage
            .remove_item(Self::RELEASED)
            .map_err(|_| "state write failed".into())
    }
    pub fn stage(&self, bytes: &[u8], records: &[(String, String)]) {
        *self.staged.payload.borrow_mut() = (bytes.to_vec(), records.to_vec());
    }
    pub fn save_exit(&self, bytes: Vec<u8>) -> Result<()> {
        self.save_now(&bytes)
    }
}

pub fn unix_millis() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis().min(9_007_199_254_740_991) as u64)
    }
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now().clamp(0.0, 9_007_199_254_740_991.0) as u64
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
