use super::{FILE_DRAFT_BYTES, MAX_BYTES, OUTLINE_BYTES, Result};

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
    departing: std::cell::Cell<bool>,
    openings: std::cell::RefCell<Option<crate::workspace::opening::Openings>>,
}
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
        if bytes.len() > FILE_DRAFT_BYTES {
            return Err("file draft store too large".into());
        }
        self.storage
            .set_item(Self::FILE_DRAFTS, std::str::from_utf8(bytes)?)
            .map_err(|_| "file draft write failed".into())
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
    pub async fn save_outlines(&self, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > OUTLINE_BYTES || self.staged.departing.get() {
            return Err("outline store unavailable".into());
        }
        self.storage
            .set_item(Self::OUTLINES, std::str::from_utf8(&bytes)?)
            .map_err(|_| "outline write failed".into())
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
        let value = std::str::from_utf8(bytes)?;
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
