//! Owner-fenced native child views. Business/session state belongs to consumers.
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime};

#[cfg(windows)]
mod windows;

#[derive(Clone, Copy, Debug, Deserialize)]
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

pub(crate) fn browser_storage(profile: &Path) -> PathBuf {
    profile.join("shared-v1")
}

fn reserved_label(label: &str) -> bool {
    label.starts_with("browser-") || label.starts_with("remote-view-")
}

#[derive(Default)]
struct Inner {
    records: HashMap<String, Record>,
    sequence: u64,
}

#[derive(Clone, PartialEq, Eq)]
struct Record {
    owner: String,
    token: u64,
    preparing: bool,
}

#[derive(Clone, Default)]
pub(crate) struct EmbeddedViews(Arc<Mutex<Inner>>);

impl EmbeddedViews {
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
            owner: owner.into(),
            token: inner.sequence,
            preparing: true,
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
            return Some(
                is_allowed_url(url) || (record.preparing && url.as_str() == "about:blank"),
            );
        }
        reserved_label(label).then_some(false)
    }

    #[cfg(windows)]
    pub(crate) fn create(
        &self,
        window: &tauri::Window,
        label: &str,
        storage: PathBuf,
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
            windows::install,
        )
    }

    #[cfg(any(windows, test))]
    fn create_with<R: Runtime>(
        &self,
        window: &tauri::Window<R>,
        label: &str,
        storage: PathBuf,
        bounds: Bounds,
        on_page_load: impl Fn(tauri::Webview<R>, tauri::webview::PageLoadPayload<'_>)
            + Send
            + Sync
            + 'static,
        on_navigation: impl Fn(&tauri::Url) -> bool + Send + Sync + 'static,
        install: impl FnOnce(&tauri::Webview<R>) -> Result<(), String>,
    ) -> Result<tauri::Webview<R>, String> {
        use tauri::webview::{NewWindowResponse, WebviewBuilder};
        validate_bounds(bounds)?;
        if !window
            .app_handle()
            .get_webview(window.label())
            .is_some_and(|primary| primary.window().label() == window.label())
        {
            return Err("Embedded view requires a local primary renderer".into());
        }
        // Register before add_child: the host navigation interceptor runs during creation.
        let record = self.reserve(window.label(), label)?;
        let policy = self.clone();
        let navigation_label = label.to_string();
        let builder = WebviewBuilder::new(
            label,
            tauri::WebviewUrl::External("about:blank".parse().expect("static neutral URL")),
        )
        .data_directory(storage)
        .focused(false)
        .on_page_load(on_page_load)
        .on_navigation(move |url| {
            let allowed = policy.navigation_allowed(&navigation_label, url) == Some(true);
            allowed && on_navigation(url)
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
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
        if self.remove_exact(label, &record) {
            if let Some(webview) = webview {
                webview.close().map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub(crate) fn remove_owner<R: Runtime>(&self, app: &AppHandle<R>, owner: &str) {
        let labels = if let Ok(mut inner) = self.0.lock() {
            let labels = inner
                .records
                .iter()
                .filter(|(_, record)| record.owner == owner)
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            for label in &labels {
                inner.records.remove(label);
            }
            labels
        } else {
            Vec::new()
        };
        for label in labels {
            if let Some(webview) = app.get_webview(&label) {
                if webview.window().label() == owner {
                    let _ = webview.close();
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "embedded_view_tests.rs"]
mod tests;
