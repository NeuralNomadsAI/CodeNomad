//! Owner-fenced native child views. Business/session state belongs to consumers.
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime};

#[cfg(any(windows, target_os = "linux", target_os = "macos", test))]
#[path = "embedded_view/browser.rs"]
mod browser;
#[path = "embedded_view/fullscreen.rs"]
mod fullscreen;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "embedded_view/input.rs"]
pub(crate) mod input;
#[cfg(target_os = "linux")]
#[path = "embedded_view/linux.rs"]
mod linux;
#[cfg(target_os = "macos")]
#[path = "embedded_view/macos.rs"]
mod macos;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "embedded_view/mobile.rs"]
pub(crate) mod mobile;
#[cfg(windows)]
#[path = "embedded_view/windows.rs"]
mod windows;
#[path = "embedded_view/zoom.rs"]
pub(crate) mod zoom;

/// Full, normalized desktop identity. The caller resolves config aliases before startup.
pub(crate) struct StorageIdentity {
    profile: String,
    config: String,
}

impl StorageIdentity {
    pub(crate) fn new(profile: String, config: String) -> Self {
        Self { profile, config }
    }

    pub(crate) fn identifier(&self, domain: &str) -> [u8; 16] {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        for part in [domain, self.profile.as_str(), self.config.as_str()] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        hash.finalize()[..16]
            .try_into()
            .expect("16-byte store identifier")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct Bounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn validate_bounds(bounds: Bounds) -> Result<(), String> {
    if bounds.width == 0 || bounds.height == 0 || bounds.width > 16_384 || bounds.height > 16_384 {
        return Err("Invalid browser target bounds".to_string());
    }
    Ok(())
}

pub(crate) fn is_allowed_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub(crate) fn private_preview_url(url: &tauri::Url) -> bool {
    url.host_str()
        .is_some_and(|host| host.ends_with(".preview.localhost"))
}

fn site_url_allowed(url: &tauri::Url, origin: Option<&str>) -> bool {
    is_allowed_url(url)
        || (url.scheme() == "about" && url.path() == "blank")
        || (url.scheme() == "blob"
            && tauri::Url::parse(url.path()).is_ok_and(|inner| {
                is_allowed_url(&inner)
                    && Some(inner.origin().ascii_serialization().as_str()) == origin
            }))
}

pub(crate) fn browser_storage(profile: &Path) -> PathBuf {
    profile.join("shared-v1")
}

/// The directory selects file-backed stores; the domain separates macOS stores.
pub(crate) struct Storage {
    pub(crate) directory: PathBuf,
    pub(crate) domain: String,
}

impl From<PathBuf> for Storage {
    fn from(directory: PathBuf) -> Self {
        Self {
            directory,
            domain: "browser/shared-v1".into(),
        }
    }
}

fn reserved_label(label: &str) -> bool {
    label.starts_with("browser-") || label.starts_with("embedded-remote-")
}

#[derive(Default)]
struct Inner {
    records: HashMap<String, Record>,
    sequence: u64,
    fullscreen_windows: HashSet<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct Record {
    logical_address: Option<String>,
    owner: String,
    token: u64,
    document: u64,
    preparing: bool,
    opener: Option<String>,
    origin: Option<String>,
    bounds: Option<Bounds>,
    fullscreen: Option<bool>,
}

#[derive(Clone, Default)]
pub(crate) struct EmbeddedViews(Arc<Mutex<Inner>>);

impl EmbeddedViews {
    pub(crate) fn restricted_browser(&self, label: &str) -> bool {
        self.0.lock().is_ok_and(|inner| {
            inner
                .records
                .get(label)
                .is_some_and(|record| record.logical_address.is_some())
        })
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    pub(crate) fn configure_browser_presentation<R: Runtime>(
        &self,
        view: &tauri::Webview<R>,
        source: &tauri::Url,
        logical: Option<&str>,
    ) -> Result<(), String> {
        let record = self.owned(view.window().label(), view.label())?;
        let address = if let Some(value) = logical {
            let parsed = tauri::Url::parse(value).map_err(|_| "Invalid logical browser address")?;
            if !is_allowed_url(&parsed) || private_preview_url(&parsed) {
                return Err("Invalid logical browser address".into());
            }
            Some(parsed.origin().ascii_serialization())
        } else if private_preview_url(source) {
            Some("CodeNomad".into())
        } else {
            record.logical_address.clone()
        };
        let restricted = address.is_some();
        if restricted != record.logical_address.is_some() {
            #[cfg(windows)]
            windows::privacy(view, restricted)?;
            #[cfg(target_os = "linux")]
            linux::privacy(view, restricted)?;
            #[cfg(target_os = "macos")]
            macos::privacy(view, restricted)?;
        }
        let mut inner = self.0.lock().map_err(|error| error.to_string())?;
        inner
            .records
            .get_mut(view.label())
            .filter(|current| current.token == record.token)
            .ok_or("Expired browser view")?
            .logical_address = address;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn for_test(owner: &str, label: &str) -> Self {
        let views = Self::default();
        let record = views.reserve(owner, label).unwrap();
        views.finish_creation(label, &record).unwrap();
        views
    }

    fn reserve(&self, owner: &str, label: &str) -> Result<Record, String> {
        crate::identity::local_window_id(owner)?;
        if !reserved_label(label) || label.ends_with('-') {
            return Err("Invalid embedded view label".into());
        }
        let mut inner = self.0.lock().map_err(|error| error.to_string())?;
        if inner.records.contains_key(label) {
            return Err("Embedded view already exists".into());
        }
        inner.sequence = inner.sequence.wrapping_add(1);
        let record = Record {
            logical_address: None,
            owner: owner.into(),
            token: inner.sequence,
            document: 0,
            preparing: true,
            opener: None,
            origin: None,
            bounds: None,
            fullscreen: None,
        };
        inner.records.insert(label.into(), record.clone());
        Ok(record)
    }

    fn owned(&self, owner: &str, label: &str) -> Result<Record, String> {
        crate::identity::local_window_id(owner)?;
        let inner = self.0.lock().map_err(|error| error.to_string())?;
        let record = inner
            .records
            .get(label)
            .ok_or("Embedded view is no longer available")?;
        if record.owner != owner {
            return Err("Embedded view belongs to another window".into());
        }
        Ok(record.clone())
    }

    fn remove_exact(&self, label: &str, record: &Record) -> bool {
        let Ok(mut inner) = self.0.lock() else {
            return false;
        };
        if inner
            .records
            .get(label)
            .is_some_and(|current| current.token == record.token)
        {
            inner.records.remove(label);
            return true;
        }
        false
    }

    fn finish_creation(&self, label: &str, record: &Record) -> Result<(), String> {
        let mut inner = self.0.lock().map_err(|error| error.to_string())?;
        let current = inner
            .records
            .get_mut(label)
            .filter(|current| current.token == record.token)
            .ok_or("Embedded view changed during creation")?;
        current.preparing = false;
        Ok(())
    }

    /// A reserved child always produces a decision, including when its record is missing.
    /// Only the initial neutral document is allowed while native protections are installed.
    pub(crate) fn navigation_allowed(&self, label: &str, url: &tauri::Url) -> Option<bool> {
        let inner = self.0.lock().ok();
        if let Some(record) = inner.as_ref().and_then(|inner| inner.records.get(label)) {
            let allowed = if label.starts_with("browser-") {
                site_url_allowed(url, record.origin.as_deref())
            } else {
                is_allowed_url(url) || (record.preparing && url.as_str() == "about:blank")
            };
            return Some(allowed);
        }
        reserved_label(label).then_some(false)
    }

    fn current(&self, label: &str, token: u64) -> bool {
        self.0.lock().is_ok_and(|inner| {
            inner
                .records
                .get(label)
                .is_some_and(|record| record.token == token)
        })
    }

    fn token(&self, label: &str) -> Option<u64> {
        self.0
            .lock()
            .ok()?
            .records
            .get(label)
            .map(|record| record.token)
    }

    fn observe_origin(&self, label: &str, token: u64, url: &tauri::Url) {
        if is_allowed_url(url) {
            if let Ok(mut inner) = self.0.lock() {
                if let Some(record) = inner
                    .records
                    .get_mut(label)
                    .filter(|record| record.token == token)
                {
                    record.origin = Some(url.origin().ascii_serialization());
                }
            }
        }
    }

    /// Invalidate the whole tree before native destruction dispatches callbacks.
    fn take_tree(
        inner: &mut Inner,
        label: &str,
        token: u64,
        include_root: bool,
    ) -> Vec<(String, Record)> {
        let Some(root) = inner
            .records
            .get(label)
            .filter(|record| record.token == token)
        else {
            return Vec::new();
        };
        let owner = root.owner.clone();
        let mut labels = HashSet::from([label.to_string()]);
        // ponytail: scan per tree depth; index parents if preview trees become large.
        loop {
            let count = labels.len();
            for (child, record) in &inner.records {
                if record.owner == owner
                    && record
                        .opener
                        .as_ref()
                        .is_some_and(|parent| labels.contains(parent))
                {
                    labels.insert(child.clone());
                }
            }
            if labels.len() == count {
                break;
            }
        }
        if !include_root {
            labels.remove(label);
        }
        labels
            .into_iter()
            .filter_map(|label| inner.records.remove(&label).map(|record| (label, record)))
            .collect()
    }

    fn dispose_records<R: Runtime>(
        app: &AppHandle<R>,
        records: Vec<(String, Record)>,
    ) -> Result<(), String> {
        let mut failure = None;
        for (label, record) in records {
            if let Some(before) = record.fullscreen {
                if let Some(view) = app.get_webview(&label) {
                    let _ = view.window().set_fullscreen(before);
                }
            }
            let result = if record.opener.is_some() {
                app.get_webview_window(&label)
                    .map(|window| window.destroy())
            } else {
                app.get_webview(&label).map(|view| view.close())
            };
            if let Some(Err(error)) = result {
                eprintln!("[browser-cleanup] {label}: {error}");
                failure.get_or_insert_with(|| error.to_string());
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn dispose_tree<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
        token: u64,
    ) -> Result<(), String> {
        let records = self
            .0
            .lock()
            .map(|mut inner| Self::take_tree(&mut inner, label, token, true))
            .unwrap_or_default();
        Self::dispose_records(app, records)
    }

    fn page_load<R: Runtime>(
        &self,
        view: &tauri::Webview<R>,
        token: u64,
        payload: &tauri::webview::PageLoadPayload<'_>,
    ) -> bool {
        let Ok(mut inner) = self.0.lock() else {
            return false;
        };
        let Some(record) = inner
            .records
            .get_mut(view.label())
            .filter(|record| record.token == token)
        else {
            return false;
        };
        let records = if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            record.document = record.document.wrapping_add(1);
            Self::take_tree(&mut inner, view.label(), token, false)
        } else {
            Vec::new()
        };
        drop(inner);
        let _ = Self::dispose_records(view.app_handle(), records);
        self.observe_origin(view.label(), token, payload.url());
        self.current(view.label(), token)
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    pub(crate) fn create(
        &self,
        window: &tauri::Window,
        label: &str,
        storage: impl Into<Storage>,
        bounds: Bounds,
        on_page_load: impl Fn(tauri::Webview, tauri::webview::PageLoadPayload<'_>)
            + Send
            + Sync
            + 'static,
        on_navigation: impl Fn(&tauri::Url) -> bool + Send + Sync + 'static,
    ) -> Result<tauri::Webview, String> {
        self.create_with(
            window,
            label,
            storage,
            bounds,
            on_page_load,
            on_navigation,
            {
                #[cfg(windows)]
                {
                    windows::install
                }
                #[cfg(target_os = "linux")]
                {
                    linux::install
                }
                #[cfg(target_os = "macos")]
                {
                    macos::install
                }
            },
        )
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos", test))]
    fn create_with<R: Runtime>(
        &self,
        window: &tauri::Window<R>,
        label: &str,
        storage: impl Into<Storage>,
        bounds: Bounds,
        on_page_load: impl Fn(tauri::Webview<R>, tauri::webview::PageLoadPayload<'_>)
            + Send
            + Sync
            + 'static,
        on_navigation: impl Fn(&tauri::Url) -> bool + Send + Sync + 'static,
        install: impl FnOnce(&tauri::Webview<R>) -> Result<(), String>,
    ) -> Result<tauri::Webview<R>, String> {
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        use tauri::webview::NewWindowResponse;
        use tauri::webview::WebviewBuilder;
        let storage = storage.into();
        validate_bounds(bounds)?;
        #[cfg(target_os = "macos")]
        let storage_identifier = window
            .app_handle()
            .try_state::<StorageIdentity>()
            .ok_or("Embedded view storage identity is unavailable")?
            .identifier(&storage.domain);
        if !window
            .app_handle()
            .get_webview(window.label())
            .is_some_and(|primary| primary.window().label() == window.label())
        {
            return Err("Embedded view requires a local primary renderer".into());
        }
        // Register before add_child: the host navigation interceptor runs during creation.
        let record = self.reserve(window.label(), label)?;
        if label.starts_with("browser-") {
            self.install_fullscreen_window(window);
        }
        let policy = self.clone();
        let navigation_label = label.to_string();
        let page_policy = self.clone();
        let token = record.token;
        let builder = WebviewBuilder::new(
            label,
            tauri::WebviewUrl::External("about:blank".parse().expect("static neutral URL")),
        )
        .data_directory(storage.directory.clone())
        .focused(false)
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(cfg!(windows))
        .on_page_load(move |view, payload| {
            if page_policy.page_load(&view, token, &payload) {
                on_page_load(view, payload);
            }
        })
        .on_navigation(move |url| {
            let allowed = policy.current(&navigation_label, token)
                && policy.navigation_allowed(&navigation_label, url) == Some(true);
            allowed && on_navigation(url)
        })
        .on_permission_request({
            let permissions = self.clone();
            let permission_label = label.to_string();
            move |view, kind| {
                if permissions.current(&permission_label, token) {
                    browser::permission(view, kind)
                } else {
                    tauri::webview::PermissionResponse::Deny
                }
            }
        });
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        let builder = builder
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false);
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        let builder = {
            let views = self.clone();
            let app = window.app_handle().clone();
            let owner = window.label().to_string();
            let opener = label.to_string();
            let browser = label.starts_with("browser-");
            let downloads = self.clone();
            let download_label = label.to_string();
            builder
                .on_download(move |webview, event| {
                    browser
                        && downloads.current(&download_label, token)
                        && browser::download(webview, event)
                })
                .on_new_window(move |url, features| {
                    if !views.current(&opener, token) {
                        return tauri::webview::NewWindowResponse::Deny;
                    }
                    views.open_popup(&app, &owner, &opener, &storage, url, features)
                })
        };
        #[cfg(target_os = "macos")]
        let builder = builder.data_store_identifier(storage_identifier);
        // Tauri has no hidden-child builder flag. Keep the neutral child off-canvas
        // until hide completes, then apply its real physical bounds while hidden.
        let result = window
            .add_child(
                builder,
                PhysicalPosition::new(-32_768, -32_768),
                PhysicalSize::new(1, 1),
            )
            .map_err(|error| format!("failed to create browser preview: {error}"));
        let webview = match result {
            Ok(webview) => webview,
            Err(error) => {
                self.remove_exact(label, &record);
                return Err(error);
            }
        };
        let configured = webview
            .hide()
            .map_err(|error| error.to_string())
            .and_then(|()| install(&webview))
            .and_then(|()| self.set_bounds(window.app_handle(), window.label(), label, bounds))
            .and_then(|()| self.finish_creation(label, &record));
        if let Err(error) = configured {
            self.remove_exact(label, &record);
            let _ = webview.close();
            return Err(error);
        }
        Ok(webview)
    }

    pub(crate) fn set_bounds<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        owner: &str,
        label: &str,
        bounds: Bounds,
    ) -> Result<(), String> {
        validate_bounds(bounds)?;
        let webview = self.webview(app, owner, label)?;
        if let Ok(mut inner) = self.0.lock() {
            if let Some(record) = inner.records.get_mut(label) {
                if record.fullscreen.is_some() {
                    return Ok(());
                }
                record.bounds = Some(bounds);
            }
        }
        webview
            .set_position(PhysicalPosition::new(bounds.x, bounds.y))
            .and_then(|()| webview.set_size(PhysicalSize::new(bounds.width, bounds.height)))
            .map_err(|error| error.to_string())
    }

    pub(crate) fn set_visible<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        owner: &str,
        label: &str,
        visible: bool,
    ) -> Result<(), String> {
        let webview = self.webview(app, owner, label)?;
        if !visible {
            let _ = self.set_fullscreen(app, label, false);
        }
        if visible {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|error| error.to_string())
    }

    fn webview<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        owner: &str,
        label: &str,
    ) -> Result<tauri::Webview<R>, String> {
        self.owned(owner, label)?;
        let webview = app
            .get_webview(label)
            .ok_or("Embedded view is no longer available")?;
        if webview.window().label() != owner {
            return Err("Embedded view belongs to another window".into());
        }
        Ok(webview)
    }

    pub(crate) fn close<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        owner: &str,
        label: &str,
    ) -> Result<(), String> {
        crate::identity::local_window_id(owner)?;
        // Read once so concurrent closes stay idempotent.
        let record = {
            let inner = self.0.lock().map_err(|error| error.to_string())?;
            let Some(record) = inner.records.get(label) else {
                return Ok(());
            };
            if record.owner != owner {
                return Err("Embedded view belongs to another window".into());
            }
            record.clone()
        };
        let webview = app.get_webview(label);
        if webview
            .as_ref()
            .is_some_and(|webview| webview.window().label() != owner)
        {
            return Err("Embedded view belongs to another window".into());
        }
        self.dispose_tree(app, label, record.token)
    }

    pub(crate) fn remove_owner<R: Runtime>(&self, app: &AppHandle<R>, owner: &str) {
        let labels = if let Ok(mut inner) = self.0.lock() {
            let labels = inner
                .records
                .iter()
                .filter(|(_, record)| record.owner == owner)
                .map(|(label, record)| (label.clone(), record.clone()))
                .collect::<Vec<_>>();
            for (label, _) in &labels {
                inner.records.remove(label);
            }
            labels
        } else {
            Vec::new()
        };
        let _ = Self::dispose_records(app, labels);
    }
}

#[cfg(test)]
#[path = "embedded_view_tests.rs"]
mod tests;
