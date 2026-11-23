use crate::history::Result;
use crate::workspace::MAX_BYTES;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn configured_directory() -> Option<std::path::PathBuf> {
    crate::platform::setting("CODENOMAD_PROFILE")
        .filter(|profile| profile.starts_with("trial-"))?;
    crate::platform::setting("RUNE_STATE_DIR").map(std::path::PathBuf::from)
}

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
        fn save_file(&self, name: &str, limit: usize, bytes: &[u8]) -> Result<()> {
            if bytes.len() > limit {
                return Err("state too large".into());
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
        pub(crate) fn memory_seen(&self) -> Result<std::collections::BTreeMap<String, i64>> {
            let files = self.files.lock().map_err(|_| "state store unavailable")?;
            memory_seen(&files)
        }

        pub(crate) async fn mark_memory_seen(&self, key: String, at: i64) -> Result<()> {
            if key.len() > 1024 {
                return Err("Invalid memory consultation key".into());
            }
            let files = self.files.clone();
            tokio::task::spawn_blocking(move || {
                let files = files.lock().map_err(|_| "state store unavailable")?;
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
            self.files
                .lock()
                .ok()?
                .load_file("preferences.json", 512)
                .ok()
                .flatten()
        }

        #[cfg(target_os = "windows")]
        pub(crate) fn save_preferences_frame(&self, bytes: &[u8]) -> Result<()> {
            self.files
                .lock()
                .map_err(|_| "state store unavailable")?
                .save_file("preferences.json", 512, bytes)
        }

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
    openings: std::cell::RefCell<Option<crate::workspace::opening::Openings>>,
}
#[cfg(target_arch = "wasm32")]
impl BrowserStage {
    fn depart(&self) {
        if self.departing.replace(true) {
            return;
        }
        let current = self.payload.try_borrow();
        let saved = current.as_ref().ok().is_some_and(|current| {
            !current.0.is_empty()
                && std::str::from_utf8(&current.0).is_ok_and(|text| {
                    self.storage.set_item(Store::KEY, text).is_ok()
                        && self.storage.set_item(Store::RELEASED, "1").is_ok()
                })
        });
        if let Ok(openings) = self.openings.try_borrow() {
            if let Some(openings) = openings.as_ref() {
                cancel_openings(openings);
            }
        }
        if !saved {
            return;
        }
        let Ok(current) = current else {
            return;
        };
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
            openings: Default::default(),
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
    pub fn watch_openings(&self, openings: crate::workspace::opening::Openings) {
        *self.staged.openings.borrow_mut() = Some(openings);
    }
    pub fn depart(&self) {
        self.staged.depart();
    }
    pub fn save_exit(&self, bytes: Vec<u8>) -> Result<()> {
        self.save_now(&bytes)
    }
}

#[cfg(target_arch = "wasm32")]
pub fn cancel_openings(openings: &crate::workspace::opening::Openings) {
    let Some(window) = web_sys::window() else {
        return;
    };
    for claim in openings.departure() {
        let request = web_sys::RequestInit::new();
        request.set_method("POST");
        request.set_credentials(web_sys::RequestCredentials::Include);
        request.set_body(
            &serde_json::json!({"requestId":claim.request})
                .to_string()
                .into(),
        );
        let headers = js_sys::Object::new();
        if js_sys::Reflect::set(&headers, &"content-type".into(), &"application/json".into()).ok()
            != Some(true)
            || js_sys::Reflect::set(request.as_ref(), &"headers".into(), &headers).ok()
                != Some(true)
            || js_sys::Reflect::set(request.as_ref(), &"keepalive".into(), &true.into()).ok()
                != Some(true)
        {
            continue;
        }
        let _ = window.fetch_with_str_and_init(
            &format!("{}api/workspaces/creation/cancel", claim.backend.base),
            &request,
        );
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
