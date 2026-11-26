use super::{ClearOutcome, FILE_DRAFT_BYTES, MAX_BYTES, OUTLINE_BYTES, RestoreMode, Result};

#[derive(Clone)]
pub struct Store {
    storage: web_sys::Storage,
    staged: std::rc::Rc<BrowserStage>,
    _listener: std::rc::Rc<BrowserListener>,
}
struct BrowserStage {
    window: web_sys::Window,
    storage: web_sys::Storage,
    payload: std::cell::RefCell<(Vec<u8>, Vec<(String, String)>)>,
    pending_file_drafts: std::cell::RefCell<Option<Vec<u8>>>,
    restore: std::cell::Cell<RestoreMode>,
    snapshot_suppressed: std::cell::Cell<bool>,
    frozen: std::cell::Cell<bool>,
    generation: std::cell::Cell<u64>,
    departing: std::cell::Cell<bool>,
    openings: std::cell::RefCell<Option<crate::workspace::opening::Openings>>,
}
impl BrowserStage {
    fn admit(&self) -> Option<u64> {
        (!self.frozen.get() && self.restore.get() == RestoreMode::Enabled)
            .then(|| self.generation.get())
    }
    fn allows(&self, generation: u64) -> bool {
        !self.frozen.get()
            && self.restore.get() == RestoreMode::Enabled
            && self.generation.get() == generation
    }
    fn bump_generation(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
    }
    fn depart(&self) {
        if self.departing.replace(true) {
            return;
        }
        if !self.frozen.get()
            && self.restore.get() == RestoreMode::Enabled
            && let Ok(pending) = self.pending_file_drafts.try_borrow()
            && let Some(bytes) = pending.as_ref()
            && bytes.len() <= FILE_DRAFT_BYTES
            && let Ok(text) = std::str::from_utf8(bytes)
        {
            let _ = self.storage.set_item(Store::FILE_DRAFTS, text);
        }
        let current = self.payload.try_borrow();
        let release_records = if self.frozen.get() || self.restore.get() == RestoreMode::Unknown {
            // An unconfirmed startup-state mutation or unreadable preference must keep records.
            false
        } else if self.restore.get() == RestoreMode::Enabled && !self.snapshot_suppressed.get() {
            current.as_ref().ok().is_some_and(|current| {
                !current.0.is_empty()
                    && std::str::from_utf8(&current.0).is_ok_and(|text| {
                        self.storage.set_item(Store::KEY, text).is_ok()
                            && self.storage.set_item(Store::RELEASED, "1").is_ok()
                    })
            })
        } else {
            true
        };
        if let Ok(openings) = self.openings.try_borrow() {
            if let Some(openings) = openings.as_ref() {
                cancel_openings(openings);
            }
        }
        if !release_records {
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
struct BrowserListener {
    window: web_sys::Window,
    callback: wasm_bindgen::closure::Closure<dyn FnMut(web_sys::PageTransitionEvent)>,
    staged: std::rc::Rc<BrowserStage>,
}
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
impl Store {
    const KEY: &'static str = "codenomad.rune.alpha.client-state.v1";
    const FILE_DRAFTS: &'static str = "codenomad.rune.alpha.workspace-file-drafts.v1";
    const OUTLINES: &'static str = "codenomad.rune.alpha.outlines.v1";
    const RELEASED: &'static str = "codenomad.rune.alpha.records-released";
    const RESTORE_DISABLED: &'static str = "codenomad.rune.alpha.restore-disabled";
    pub async fn open() -> Result<Self> {
        use wasm_bindgen::JsCast;
        let window = web_sys::window().ok_or("state store unavailable")?;
        let storage = window
            .session_storage()
            .map_err(|_| "state store unavailable")?
            .ok_or("state store unavailable")?;
        let restore = match storage.get_item(Self::RESTORE_DISABLED) {
            Ok(None) => RestoreMode::Enabled,
            Ok(Some(v)) if v == "true" => RestoreMode::Disabled,
            Ok(Some(_)) | Err(_) => RestoreMode::Unknown,
        };
        let staged = std::rc::Rc::new(BrowserStage {
            window: window.clone(),
            storage: storage.clone(),
            payload: Default::default(),
            pending_file_drafts: Default::default(),
            restore: std::cell::Cell::new(restore),
            snapshot_suppressed: std::cell::Cell::new(false),
            frozen: std::cell::Cell::new(false),
            generation: std::cell::Cell::new(0),
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
    pub async fn restore_enabled(&self) -> Result<bool> {
        let disabled = match self.storage.get_item(Self::RESTORE_DISABLED) {
            Ok(value) => value,
            Err(_) => {
                self.staged.restore.set(RestoreMode::Unknown);
                return Err("state read failed".into());
            }
        };
        let (mode, enabled) = match disabled.as_deref() {
            None => (RestoreMode::Enabled, true),
            Some("true") => (RestoreMode::Disabled, false),
            Some(_) => {
                self.staged.restore.set(RestoreMode::Unknown);
                return Err("invalid restore preference".into());
            }
        };
        self.staged.restore.set(mode);
        Ok(enabled)
    }
    pub fn begin_startup_mutation(&self) {
        self.staged.frozen.set(true);
        self.staged.bump_generation();
        self.staged.payload.borrow_mut().0.clear();
        self.staged.pending_file_drafts.borrow_mut().take();
    }
    pub fn stage_pending_file_drafts(&self, bytes: Option<Vec<u8>>) {
        *self.staged.pending_file_drafts.borrow_mut() = bytes;
    }
    pub async fn set_restore_enabled(&self, enabled: bool) -> Result<bool> {
        self.staged.frozen.set(true);
        self.staged.bump_generation();
        self.staged.pending_file_drafts.borrow_mut().take();
        if enabled {
            // Only purge leftover startup keys when transitioning from a confirmed Disabled state;
            // an unreadable/malformed preference must not erase user data on enable.
            if self.staged.restore.get() == RestoreMode::Disabled
                && !self.remove_startup_keys().all_ok()
            {
                self.staged.frozen.set(false);
                return Err("startup state cleanup failed".into());
            }
            if self.storage.remove_item(Self::RESTORE_DISABLED).is_err() {
                self.staged.frozen.set(false);
                return Err("state write failed".into());
            }
            self.staged.restore.set(RestoreMode::Enabled);
            self.staged.snapshot_suppressed.set(false);
            self.staged.bump_generation();
            self.staged.frozen.set(false);
            Ok(true)
        } else {
            if self
                .storage
                .set_item(Self::RESTORE_DISABLED, "true")
                .is_err()
            {
                self.staged.frozen.set(false);
                return Err("state write failed".into());
            }
            self.staged.restore.set(RestoreMode::Disabled);
            self.staged.snapshot_suppressed.set(false);
            self.staged.bump_generation();
            self.staged.payload.borrow_mut().0.clear();
            let cleanup_ok = self.remove_startup_keys().all_ok();
            self.staged.frozen.set(false);
            Ok(cleanup_ok)
        }
    }
    pub async fn clear_startup_state(&self) -> Result<ClearOutcome> {
        self.staged.frozen.set(true);
        self.staged.bump_generation();
        self.staged.payload.borrow_mut().0.clear();
        let outcome = self.remove_startup_keys();
        if outcome.state_ok {
            self.staged.snapshot_suppressed.set(true);
        }
        self.staged.frozen.set(false);
        Ok(outcome)
    }
    fn remove_startup_keys(&self) -> ClearOutcome {
        let key_ok = self.storage.remove_item(Self::KEY).is_ok();
        let released_ok = self.storage.remove_item(Self::RELEASED).is_ok();
        let drafts_ok = self.storage.remove_item(Self::FILE_DRAFTS).is_ok();
        let outlines_ok = self.storage.remove_item(Self::OUTLINES).is_ok();
        ClearOutcome {
            state_ok: key_ok && released_ok,
            outlines_ok,
            drafts_ok,
        }
    }
    pub async fn load_file_drafts(&self) -> Result<Option<Vec<u8>>> {
        let raw = self
            .storage
            .get_item(Self::FILE_DRAFTS)
            .map_err(|_| "file draft read failed")?;
        if raw
            .as_ref()
            .is_some_and(|text| text.len() > FILE_DRAFT_BYTES)
        {
            return Err("file draft store too large".into());
        }
        Ok(raw.map(String::into_bytes))
    }
    pub fn save_file_drafts(&self, bytes: &[u8]) -> Result<()> {
        if self.staged.frozen.get() || self.staged.restore.get() != RestoreMode::Enabled {
            return Ok(());
        }
        if bytes.len() > FILE_DRAFT_BYTES {
            return Err("file draft store too large".into());
        }
        self.storage
            .set_item(Self::FILE_DRAFTS, std::str::from_utf8(bytes)?)
            .map_err(|_| "file draft write failed")?;
        self.staged.pending_file_drafts.borrow_mut().take();
        Ok(())
    }
    pub async fn load_outlines(&self) -> Result<Option<Vec<u8>>> {
        let raw = self
            .storage
            .get_item(Self::OUTLINES)
            .map_err(|_| "outline read failed")?;
        Ok(raw
            .filter(|text| text.len() <= OUTLINE_BYTES)
            .map(String::into_bytes))
    }
    pub fn start_save_outlines(
        &self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<()>> + 'static {
        self.start_save_outlines_with(move || bytes)
    }
    pub fn start_save_outlines_with(
        &self,
        encode: impl FnOnce() -> Vec<u8> + 'static,
    ) -> impl std::future::Future<Output = Result<()>> + 'static {
        let generation = self.staged.admit();
        let storage = self.storage.clone();
        let staged = self.staged.clone();
        async move {
            let Some(generation) = generation else {
                return Ok(());
            };
            if !staged.allows(generation) {
                return Ok(());
            }
            let bytes = encode();
            if bytes.len() > OUTLINE_BYTES || staged.departing.get() {
                return Err("outline store unavailable".into());
            }
            storage
                .set_item(Self::OUTLINES, std::str::from_utf8(&bytes)?)
                .map_err(|_| "outline write failed".into())
        }
    }
    pub async fn save_outlines(&self, bytes: Vec<u8>) -> Result<()> {
        self.start_save_outlines(bytes).await
    }
    pub fn start_save(
        &self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<()>> + 'static {
        let generation = self.staged.admit();
        let store = self.clone();
        async move {
            let Some(generation) = generation else {
                return Ok(());
            };
            if !store.staged.allows(generation) || store.staged.payload.borrow().0 != bytes {
                return Ok(());
            }
            store.save_now(&bytes)
        }
    }
    pub async fn save(&self, bytes: Vec<u8>) -> Result<()> {
        self.start_save(bytes).await
    }
    fn save_now(&self, bytes: &[u8]) -> Result<()> {
        if self.staged.frozen.get() || self.staged.restore.get() != RestoreMode::Enabled {
            return Ok(());
        }
        if self.staged.departing.get() {
            return Err("window departing".into());
        }
        if bytes.len() > MAX_BYTES {
            return Err("state too large".into());
        }
        let value = std::str::from_utf8(bytes)?;
        self.storage
            .set_item(Self::KEY, value)
            .map_err(|_| "state write failed")?;
        self.storage
            .remove_item(Self::RELEASED)
            .map_err(|_| "state write failed".into())
    }
    pub fn stage(&self, bytes: &[u8], records: &[(String, String)]) {
        let mut payload = self.staged.payload.borrow_mut();
        payload.1 = records.to_vec();
        if bytes.is_empty() {
            payload.0.clear();
        } else if !self.staged.frozen.get() && self.staged.restore.get() == RestoreMode::Enabled {
            payload.0 = bytes.to_vec();
            self.staged.snapshot_suppressed.set(false);
        }
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
