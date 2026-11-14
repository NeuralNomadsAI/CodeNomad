use crate::embedded_view::{
    is_allowed_url, validate_bounds, Bounds as BrowserTargetBounds, EmbeddedViews,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Window};
#[cfg(test)]
use tauri::{PhysicalPosition, PhysicalSize};

#[cfg(windows)]
#[path = "browser_emulation.rs"]
mod emulation;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "browser_emulation_webkit.rs"]
mod emulation;
#[path = "browser_emulation_layout.rs"]
mod viewport;

#[path = "browser_controller_page.rs"]
mod page;

#[cfg(any(test, target_os = "linux", target_os = "macos"))]
#[path = "browser_history.rs"]
mod history_ids;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "browser_history_webkit.rs"]
mod webkit_history;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "browser_navigation_webkit.rs"]
mod webkit_navigation;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTargetRegistration {
    logical_address: Option<String>,
    session_id: String,
    registration_id: String,
    url: String,
    bounds: BrowserTargetBounds,
    visible: Option<bool>,
    presentation: Option<viewport::Presentation>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTargetUpdate {
    registration_id: String,
    bounds: Option<BrowserTargetBounds>,
    visible: Option<bool>,
    presentation: Option<viewport::Presentation>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTargetAction {
    logical_address: Option<String>,
    registration_id: String,
    action: String,
    url: Option<String>,
    preset: Option<String>,
    entry_id: Option<i64>,
    viewport: Option<viewport::Viewport>,
}

#[derive(Clone, PartialEq, Eq)]
struct Registration {
    session_id: String,
    registration_id: String,
    window_label: String,
    webview_label: String,
    generation: u64,
    visible: bool,
}

#[derive(Clone)]
struct PageLoadExpectation {
    sequence: u64,
    url: String,
    navigation_id: Option<u64>,
    result: Option<Result<(), String>>,
}

#[derive(Clone)]
struct OpenClaim {
    session_id: String,
    url: String,
    owner: Option<String>,
    failed_owners: HashSet<String>,
    fence: Option<crate::native_request::RequestFence>,
}

#[derive(Default)]
struct Inner {
    emulation_profiles: HashMap<String, String>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    canvases: HashMap<String, viewport::Canvas>,
    registrations: HashMap<String, Registration>,
    published_generations: HashMap<String, (String, u64)>,
    renderer_versions: HashMap<String, u64>,
    page_leases: HashMap<String, page::PageLease>,
    navigation_versions: HashMap<String, u64>,
    page_load_sequence: u64,
    page_load_expectations: HashMap<String, PageLoadExpectation>,
    open_claims: HashMap<String, OpenClaim>,
}

#[derive(Clone)]
pub(crate) struct BrowserController {
    emulation_lock: Arc<Mutex<()>>,
    inner: Arc<(Mutex<Inner>, Condvar)>,
    profile: Arc<std::path::PathBuf>,
    registration_sequence: Arc<AtomicU64>,
    run_id: Arc<String>,
    pub(crate) embedded_views: EmbeddedViews,
}

impl BrowserController {
    fn storage_directory(&self) -> std::path::PathBuf {
        crate::embedded_view::browser_storage(&self.profile)
    }

    pub(crate) fn new(profile: std::path::PathBuf) -> Self {
        Self {
            emulation_lock: Arc::new(Mutex::new(())),
            inner: Arc::new((Mutex::new(Inner::default()), Condvar::new())),
            profile: Arc::new(profile),
            registration_sequence: Arc::new(AtomicU64::new(1)),
            run_id: Arc::new(uuid::Uuid::new_v4().to_string()),
            embedded_views: EmbeddedViews::default(),
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    pub(crate) fn register(
        &self,
        window: &Window,
        input: BrowserTargetRegistration,
    ) -> Result<(), String> {
        validate_id(&input.session_id, 256)?;
        validate_id(&input.registration_id, 128)?;
        let url = allowed_url(&input.url)?;
        validate_bounds(input.bounds)?;
        let renderer_version = self.renderer_version(window.label())?;
        let registration_id = input.registration_id.clone();
        let generation = self.registration_sequence.fetch_add(1, Ordering::Relaxed);
        // Native labels are unique across replacements, including in-flight creations.
        let label = format!("browser-{}-{generation}", input.registration_id);
        let navigation_controller = self.clone();
        let navigation_registration_id = registration_id.clone();
        let policy_controller = self.clone();
        let policy_registration_id = registration_id.clone();
        // Every preview is a tab in the same browser profile. Its navigation
        // history and automation attachment remain owned by its session.
        let profile = self.storage_directory();
        let webview = self.embedded_views.create(
            window,
            &label,
            profile,
            input.bounds,
            move |webview, payload| {
                if payload.event() == PageLoadEvent::Started
                    && payload.url().as_str() != "about:blank"
                    && navigation_controller
                        .owned_registration(webview.window().label(), &navigation_registration_id)
                        .is_ok_and(|current| current.generation == generation)
                {
                    navigation_controller
                        .invalidate_page_for_generation(&navigation_registration_id, generation);
                    let _ = webview.window().emit(
                        "browser-target:navigated",
                        json!({ "registrationId": registration_id, "url": payload.url().as_str() }),
                    );
                }
            },
            move |_| {
                policy_controller
                    .invalidate_page_for_generation(&policy_registration_id, generation);
                true
            },
        )?;
        if let Err(error) = self.embedded_views.configure_browser_presentation(
            &webview,
            &url,
            input.logical_address.as_deref(),
        ) {
            let _ = self
                .embedded_views
                .close(window.app_handle(), window.label(), &label);
            return Err(error);
        }
        let registration = Registration {
            session_id: input.session_id,
            registration_id: input.registration_id.clone(),
            window_label: window.label().to_string(),
            webview_label: label.clone(),
            generation,
            visible: input.visible.unwrap_or(true),
        };
        #[cfg(windows)]
        let installed = install_webview2_handlers(
            &webview,
            self.clone(),
            input.registration_id.clone(),
            window.label().to_string(),
            generation,
        );
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let installed = webkit_history::install(&webview, self.clone(), registration.clone())
            .and_then(|()| webkit_navigation::install(&webview, self.clone(), registration.clone()))
            .and_then(|()| crate::embedded_view::input::install_read(&webview));
        if let Err(error) = installed {
            let _ = self
                .embedded_views
                .close(window.app_handle(), window.label(), &label);
            return Err(error);
        }

        #[cfg(target_os = "macos")]
        let observation = registration.clone();
        let previous = match self.publish_registration(registration, renderer_version, url.as_str())
        {
            Ok(previous) => previous,
            Err(error) => {
                let _ = self
                    .embedded_views
                    .close(window.app_handle(), window.label(), &label);
                return Err(error);
            }
        };
        if let Some(previous) = previous {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            webkit_history::remove(window.app_handle(), previous.webview_label.clone());
            let _ = self.embedded_views.close(
                window.app_handle(),
                &previous.window_label,
                &previous.webview_label,
            );
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let current = self.owned_registration(window.label(), &input.registration_id)?;
            if let Err(error) = self.resize_webkit(
                window.app_handle(),
                &current,
                input.bounds,
                input.presentation,
            ) {
                let _ = self.unregister_generation(
                    window.app_handle(),
                    window.label(),
                    &input.registration_id,
                    Some(generation),
                );
                return Err(error);
            }
        }
        if let Err(error) = webview.navigate(url) {
            let _ = self.unregister_generation(
                window.app_handle(),
                window.label(),
                &input.registration_id,
                Some(generation),
            );
            return Err(error.to_string());
        }
        let current = self.owned_registration(window.label(), &input.registration_id);
        match current {
            Ok(current) if current.generation == generation => {
                if let Err(error) = self.embedded_views.set_visible(
                    window.app_handle(),
                    window.label(),
                    &label,
                    current.visible,
                ) {
                    let _ = self.unregister_generation(
                        window.app_handle(),
                        window.label(),
                        &input.registration_id,
                        Some(generation),
                    );
                    return Err(error);
                }
            }
            _ => {
                let _ = self
                    .embedded_views
                    .close(window.app_handle(), window.label(), &label);
                return Err("Browser target changed during creation".into());
            }
        }
        #[cfg(target_os = "macos")]
        webkit_history::observe(window.app_handle().clone(), self.clone(), observation);
        Ok(())
    }

    fn renderer_version(&self, window_label: &str) -> Result<u64, String> {
        let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        Ok(inner
            .renderer_versions
            .get(window_label)
            .copied()
            .unwrap_or(0))
    }

    fn publish_registration(
        &self,
        registration: Registration,
        renderer_version: u64,
        url: &str,
    ) -> Result<Option<Registration>, String> {
        let (inner, ready) = &*self.inner;
        let mut inner = inner.lock().map_err(|error| error.to_string())?;
        if inner
            .renderer_versions
            .get(&registration.window_label)
            .copied()
            .unwrap_or(0)
            != renderer_version
        {
            return Err("Browser preview renderer is no longer current".to_string());
        }
        let id = registration.registration_id.clone();
        if inner
            .registrations
            .get(&id)
            .is_some_and(|current| current.window_label != registration.window_label)
        {
            return Err("Browser target belongs to another window".into());
        }
        if inner
            .published_generations
            .get(&id)
            .is_some_and(|(_, generation)| *generation > registration.generation)
        {
            return Err("Browser target changed during creation".into());
        }
        // Keep the high-water mark through unregister so an older in-flight
        // creation cannot resurrect a replacement that has already been closed.
        inner.published_generations.insert(
            id.clone(),
            (registration.window_label.clone(), registration.generation),
        );
        let previous = inner.registrations.insert(id.clone(), registration);
        inner.emulation_profiles.remove(&id);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        inner.canvases.remove(&id);
        inner
            .page_leases
            .retain(|_, lease| lease.registration.registration_id != id);
        inner.navigation_versions.insert(id.clone(), 0);
        inner.page_load_sequence = inner.page_load_sequence.wrapping_add(1);
        let sequence = inner.page_load_sequence;
        inner.page_load_expectations.insert(
            id,
            PageLoadExpectation {
                sequence,
                url: url.to_string(),
                navigation_id: None,
                result: None,
            },
        );
        drop(inner);
        ready.notify_all();
        Ok(previous)
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    pub(crate) fn register(
        &self,
        _window: &Window,
        _input: BrowserTargetRegistration,
    ) -> Result<(), String> {
        Err(unsupported())
    }

    pub(crate) fn update<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
        input: BrowserTargetUpdate,
    ) -> Result<(), String> {
        let registration = self.owned_registration(window_label, &input.registration_id)?;
        let visible = input.visible.unwrap_or(true);
        if visible {
            let bounds = input
                .bounds
                .ok_or_else(|| "Visible browser target bounds are required".to_string())?;
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            self.resize_webkit(app, &registration, bounds, input.presentation)?;
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            self.embedded_views.set_bounds(
                app,
                window_label,
                &registration.webview_label,
                bounds,
            )?;
            self.embedded_views.set_visible(
                app,
                window_label,
                &registration.webview_label,
                true,
            )?;
        } else {
            // Revoke authority before the native hide's UI-thread round trip.
            let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
            let current = inner
                .registrations
                .get_mut(&input.registration_id)
                .filter(|current| current.generation == registration.generation)
                .ok_or("Browser target changed before visibility update")?;
            current.visible = false;
            inner
                .page_leases
                .retain(|_, lease| lease.registration.registration_id != input.registration_id);
            drop(inner);
            self.embedded_views.set_visible(
                app,
                window_label,
                &registration.webview_label,
                false,
            )?;
        }
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if let Some(current) = inner.registrations.get_mut(&input.registration_id) {
            if current.generation == registration.generation {
                current.visible = visible;
            }
        }
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn action(
        &self,
        app: &AppHandle,
        window_label: &str,
        input: BrowserTargetAction,
    ) -> Result<Value, String> {
        let registration = self.owned_registration(window_label, &input.registration_id)?;
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
        if input.action == "history" || input.action == "history-go" {
            let deadline = Instant::now() + Duration::from_secs(5);
            let result = cdp(&webview, "Page.getNavigationHistory", json!({}), deadline)?;
            if input.action == "history-go" {
                let id = input.entry_id.ok_or("Browser history entry is required")?;
                let entry = result["entries"]
                    .as_array()
                    .and_then(|entries| {
                        entries
                            .iter()
                            .find(|entry| entry["id"].as_i64() == Some(id))
                    })
                    .ok_or("Invalid browser history entry")?;
                allowed_url(entry["url"].as_str().ok_or("Invalid browser history URL")?)?;
                if self
                    .owned_registration(window_label, &input.registration_id)?
                    .generation
                    != registration.generation
                {
                    return Err("Browser target changed before history navigation".to_string());
                }
                return cdp(
                    &webview,
                    "Page.navigateToHistoryEntry",
                    json!({ "entryId": id }),
                    deadline,
                );
            }
            return bounded_history(result);
        }
        if input.action == "navigate" {
            let url = allowed_url(
                input
                    .url
                    .as_deref()
                    .ok_or("Browser navigation URL is required")?,
            )?;
            self.embedded_views.configure_browser_presentation(
                &webview,
                &url,
                input.logical_address.as_deref(),
            )?;
        }
        match input.action.as_str() {
            "emulate" => self.emulate(app, window_label, &input),
            "back" => webview
                .eval("history.back()")
                .map_err(|error| error.to_string()),
            "reload" => webview.reload().map_err(|error| error.to_string()),
            "navigate" => webview
                .navigate(allowed_url(input.url.as_deref().ok_or_else(|| {
                    "Browser navigation URL is required".to_string()
                })?)?)
                .map_err(|error| error.to_string()),
            _ => Err("Unsupported browser target action".to_string()),
        }
        .map(|()| Value::Null)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn emit_webkit_navigation(&self, app: &AppHandle, registration: &Registration, url: &str) {
        if allowed_url(url).is_err()
            || !self
                .owned_registration(&registration.window_label, &registration.registration_id)
                .is_ok_and(|current| current.generation == registration.generation)
        {
            return;
        }
        // History sampling publishes URL metadata; navigation/load callbacks
        // own document fences, including while a new page lease is binding.
        if let Some(webview) = app.get_webview(&registration.window_label) {
            let _ = webview.emit(
                "browser-target:navigated",
                json!({ "registrationId": registration.registration_id, "url": url }),
            );
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(crate) fn action(
        &self,
        app: &AppHandle,
        window_label: &str,
        input: BrowserTargetAction,
    ) -> Result<Value, String> {
        let registration = self.owned_registration(window_label, &input.registration_id)?;
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or("Browser preview is no longer available")?;
        if input.action == "navigate" {
            let url = allowed_url(
                input
                    .url
                    .as_deref()
                    .ok_or("Browser navigation URL is required")?,
            )?;
            self.embedded_views.configure_browser_presentation(
                &webview,
                &url,
                input.logical_address.as_deref(),
            )?;
        }
        match input.action.as_str() {
            "emulate" => self
                .emulate(app, window_label, &input)
                .map(|()| Value::Null),
            "history" => webkit_history::action(self, &webview, &registration, None),
            "history-go" => webkit_history::action(
                self,
                &webview,
                &registration,
                Some(input.entry_id.ok_or("Browser history entry is required")?),
            ),
            "back" => webview
                .eval("history.back()")
                .map(|()| Value::Null)
                .map_err(|error| error.to_string()),
            "reload" => webview
                .reload()
                .map(|()| Value::Null)
                .map_err(|error| error.to_string()),
            "navigate" => webview
                .navigate(allowed_url(
                    input
                        .url
                        .as_deref()
                        .ok_or("Browser navigation URL is required")?,
                )?)
                .map(|()| Value::Null)
                .map_err(|error| error.to_string()),
            _ => Err("Unsupported browser target action".into()),
        }
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    pub(crate) fn action(
        &self,
        _app: &AppHandle,
        _window_label: &str,
        _input: BrowserTargetAction,
    ) -> Result<Value, String> {
        Err(unsupported())
    }

    pub(crate) fn unregister(
        &self,
        app: &AppHandle,
        window_label: &str,
        registration_id: &str,
    ) -> Result<(), String> {
        self.unregister_generation(app, window_label, registration_id, None)
    }

    fn unregister_generation(
        &self,
        app: &AppHandle,
        window_label: &str,
        registration_id: &str,
        generation: Option<u64>,
    ) -> Result<(), String> {
        let (inner, ready) = &*self.inner;
        let mut inner = inner.lock().map_err(|error| error.to_string())?;
        let Some(registration) = inner.registrations.get(registration_id) else {
            return Ok(());
        };
        if registration.window_label != window_label {
            return Err("Browser target belongs to another window".to_string());
        }
        if generation.is_some_and(|generation| generation != registration.generation) {
            return Ok(());
        }
        let registration = inner.registrations.remove(registration_id).unwrap();
        inner.emulation_profiles.remove(registration_id);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        inner.canvases.remove(registration_id);
        inner
            .page_leases
            .retain(|_, lease| lease.registration.registration_id != registration_id);
        inner.navigation_versions.remove(registration_id);
        inner.page_load_expectations.remove(registration_id);
        drop(inner);
        ready.notify_all();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        webkit_history::remove(app, registration.webview_label.clone());
        self.embedded_views
            .close(app, window_label, &registration.webview_label)?;
        Ok(())
    }

    pub(crate) fn claim_open(&self, window_label: &str, request_id: &str) -> bool {
        let Ok(mut inner) = self.inner.0.lock() else {
            return false;
        };
        let Some(claim) = inner.open_claims.get_mut(request_id) else {
            return false;
        };
        if claim
            .fence
            .as_ref()
            .is_some_and(|fence| fence.check().is_err())
        {
            return false;
        }
        if claim
            .owner
            .as_deref()
            .is_some_and(|owner| owner != window_label)
            || claim.failed_owners.contains(window_label)
        {
            return false;
        }
        claim.owner = Some(window_label.to_string());
        true
    }

    pub(crate) fn release_open(
        &self,
        app: &AppHandle,
        window_label: &str,
        request_id: &str,
    ) -> bool {
        let Some(claim) = self.release_claim(window_label, request_id) else {
            return false;
        };
        Self::emit_open_request(app, request_id, &claim);
        true
    }

    fn release_claim(&self, window_label: &str, request_id: &str) -> Option<OpenClaim> {
        let mut inner = self.inner.0.lock().ok()?;
        let claim = inner.open_claims.get_mut(request_id)?;
        if claim
            .fence
            .as_ref()
            .is_some_and(|fence| fence.check().is_err())
        {
            return None;
        }
        if claim.owner.as_deref() != Some(window_label) {
            return None;
        }
        claim.owner = None;
        claim.failed_owners.insert(window_label.to_string());
        Some(claim.clone())
    }

    pub(crate) fn renderer_page_started<R: tauri::Runtime>(&self, webview: &tauri::Webview<R>) {
        // A child navigation never ends the owning renderer's lifetime. A full
        // primary-renderer load does: its native children otherwise survive reload.
        if webview.label() == webview.window().label()
            && crate::identity::local_window_id(webview.label()).is_ok()
        {
            self.remove_window(webview.app_handle(), webview.label());
        }
    }

    pub(crate) fn remove_window<R: tauri::Runtime>(&self, app: &AppHandle<R>, window_label: &str) {
        let (retries, children) = if let Ok(mut inner) = self.inner.0.lock() {
            let version = inner
                .renderer_versions
                .entry(window_label.to_string())
                .or_default();
            *version = version.wrapping_add(1);
            inner
                .published_generations
                .retain(|_, (owner, _)| owner != window_label);
            let ids = inner
                .registrations
                .values()
                .filter(|registration| registration.window_label == window_label)
                .map(|registration| registration.registration_id.clone())
                .collect::<Vec<_>>();
            let children = ids
                .iter()
                .filter_map(|id| {
                    inner
                        .registrations
                        .get(id)
                        .map(|registration| registration.webview_label.clone())
                })
                .collect::<Vec<_>>();
            for id in ids {
                inner
                    .page_leases
                    .retain(|_, lease| lease.registration.registration_id != id);
                inner.navigation_versions.remove(&id);
                inner.page_load_expectations.remove(&id);
                inner.registrations.remove(&id);
                inner.emulation_profiles.remove(&id);
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                inner.canvases.remove(&id);
            }
            let retries = inner
                .open_claims
                .iter_mut()
                .filter_map(|(request_id, claim)| {
                    if claim.owner.as_deref() != Some(window_label) {
                        return None;
                    }
                    claim.owner = None;
                    claim.failed_owners.insert(window_label.to_string());
                    Some((request_id.clone(), claim.clone()))
                })
                .collect::<Vec<_>>();
            (retries, children)
        } else {
            (Vec::new(), Vec::new())
        };
        for child in children {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            webkit_history::remove(app, child);
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            let _ = child;
        }
        self.embedded_views.remove_owner(app, window_label);
        for (request_id, claim) in retries {
            Self::emit_open_request(app, &request_id, &claim);
        }
        self.inner.1.notify_all();
    }

    pub(crate) fn handle_native(
        &self,
        app: &AppHandle,
        method: &str,
        params: Option<Value>,
        deadline_ms: u64,
        fence: crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = (app, method, params, deadline_ms, fence);
            return Err(unsupported());
        }
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        {
            fence.check()?;
            let input = params.ok_or_else(|| "Invalid browser request".to_string())?;
            let deadline = request_deadline(deadline_ms)?;
            let session_id = input
                .get("sessionID")
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid browser request".to_string())?;
            match method {
                "browser.page.begin" | "browser.page.send" | "browser.page.check"
                | "browser.page.end" => self.page_request(app, method, &input, deadline, &fence),
                "browser.probe" => {
                    let registration = self.resolve(app, session_id)?;
                    self.check_target(app, &registration, deadline, &fence)?;
                    Ok(json!({ "available": true }))
                }
                "browser.execute" => self.execute(
                    app,
                    session_id,
                    input
                        .get("command")
                        .cloned()
                        .ok_or_else(|| "Invalid browser request".to_string())?,
                    deadline,
                    &fence,
                ),
                _ => Err(format!("Unsupported native method: {method}")),
            }
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn execute(
        &self,
        app: &AppHandle,
        session_id: &str,
        command: Value,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let action = command
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "Invalid browser command".to_string())?;
        if action == "open" {
            let url = command_url(&command)?;
            return self.open(app, session_id, url, deadline, fence);
        }
        let registration = self.resolve(app, session_id)?;
        if action == "navigate" {
            self.check_target_identity(app, &registration, deadline, fence)?;
        } else {
            self.check_target(app, &registration, deadline, fence)?;
        }
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
        match action {
            "navigate" => {
                let url = allowed_url(command_url(&command)?)?;
                self.navigate_and_wait(app, &registration, &webview, &url, deadline, fence)?;
                self.check_target(app, &registration, deadline, fence)?;
                Ok(json!({ "url": webview.url().map_err(|error| error.to_string())? }))
            }
            "screenshot" => {
                let document = self.document_version(&registration)?;
                #[cfg(windows)]
                let result = {
                    let controller = self.clone();
                    let expected = registration.clone();
                    let app = app.clone();
                    let fence = fence.clone();
                    cdp_guarded(
                        &webview,
                        "Page.captureScreenshot",
                        json!({ "format": "png", "fromSurface": true }),
                        deadline,
                        move || {
                            controller.check_target(&app, &expected, deadline, &fence)?;
                            if controller.document_version(&expected)? != document {
                                return Err("Browser document changed during capture".into());
                            }
                            Ok(())
                        },
                        24 * 1024 * 1024,
                    )?
                };
                #[cfg(windows)]
                let data = result
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|data| data.len() <= 16 * 1024 * 1024)
                    .ok_or_else(|| "Browser screenshot is unavailable or too large".to_string())?;
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                let data = {
                    use base64::Engine;
                    let controller = self.clone();
                    let expected = registration.clone();
                    let app = app.clone();
                    let fence = fence.clone();
                    let bytes = crate::embedded_view::input::read(
                        &webview,
                        crate::embedded_view::input::Read::Capture,
                        deadline,
                        move || {
                            controller.check_target(&app, &expected, deadline, &fence)?;
                            if controller.document_version(&expected)? != document {
                                return Err("Browser document changed during capture".into());
                            }
                            Ok(())
                        },
                    )?;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                    if encoded.len() > 16 * 1024 * 1024 {
                        return Err("Browser screenshot is unavailable or too large".into());
                    }
                    encoded
                };
                self.check_target(app, &registration, deadline, fence)?;
                if self.document_version(&registration)? != document {
                    return Err("Browser document changed during capture".into());
                }
                Ok(
                    json!({ "image": { "mime": "image/png", "data": data }, "url": webview.url().map_err(|error| error.to_string())? }),
                )
            }
            _ => Err("Invalid browser command".to_string()),
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn open(
        &self,
        app: &AppHandle,
        session_id: &str,
        raw_url: &str,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let url = allowed_url(raw_url)?;
        match self.resolve(app, session_id) {
            Ok(registration) => {
                let webview = app
                    .get_webview(&registration.webview_label)
                    .ok_or_else(|| "Browser preview is no longer available".to_string())?;
                self.navigate_and_wait(app, &registration, &webview, &url, deadline, fence)?;
                self.check_target(app, &registration, deadline, fence)?;
                return Ok(json!({ "url": webview.url().map_err(|error| error.to_string())? }));
            }
            Err(error) if error == no_browser_target_error() => {}
            Err(error) => return Err(error),
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let claim = OpenClaim {
            session_id: session_id.to_string(),
            url: raw_url.to_string(),
            owner: None,
            failed_owners: HashSet::new(),
            fence: Some(fence.clone()),
        };
        {
            let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
            inner.open_claims.insert(request_id.clone(), claim.clone());
        }
        Self::emit_open_request(app, &request_id, &claim);
        let result = (|| -> Result<Value, String> {
            let registration_deadline = deadline.min(Instant::now() + Duration::from_secs(10));
            let (inner, ready) = &*self.inner;
            let mut guard = inner.lock().map_err(|error| error.to_string())?;
            loop {
                drop(guard);
                fence.check()?;
                match self.resolve(app, session_id) {
                    Ok(registration) => {
                        let webview = app
                            .get_webview(&registration.webview_label)
                            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
                        if let Some(sequence) =
                            self.page_load_expectation(&registration.registration_id, url.as_str())?
                        {
                            self.wait_for_page_load(
                                &registration.registration_id,
                                sequence,
                                deadline,
                            )?;
                            self.check_target(app, &registration, deadline, fence)?;
                            return Ok(
                                json!({ "url": webview.url().map_err(|error| error.to_string())? }),
                            );
                        }
                    }
                    Err(error) if error == no_browser_target_error() => {}
                    Err(error) => return Err(error),
                }
                let remaining = registration_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(
                        "Timed out waiting for CodeNomad to open the browser preview".to_string(),
                    );
                }
                guard = ready
                    .wait_timeout(
                        inner.lock().map_err(|error| error.to_string())?,
                        remaining.min(Duration::from_millis(50)),
                    )
                    .map_err(|error| error.to_string())?
                    .0;
            }
        })();
        if let Ok(mut inner) = self.inner.0.lock() {
            inner.open_claims.remove(&request_id);
        }
        result
    }

    fn emit_open_request<R: tauri::Runtime>(
        app: &AppHandle<R>,
        request_id: &str,
        claim: &OpenClaim,
    ) {
        for record in app.state::<crate::local_windows::LocalWindows>().records() {
            if let Some(webview) = app.get_webview(&record.label) {
                let _ = webview.emit(
                    "browser-target:open",
                    json!({ "sessionID": claim.session_id, "url": claim.url, "requestID": request_id }),
                );
            }
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn resolve<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
    ) -> Result<Registration, String> {
        validate_id(session_id, 256)?;
        let registrations = self
            .inner
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .registrations
            .values()
            .filter(|registration| registration.session_id == session_id && registration.visible)
            .cloned()
            .collect::<Vec<_>>();
        let matches = registrations
            .into_iter()
            .filter(|registration| {
                app.get_window(&registration.window_label)
                    .is_some_and(|window| {
                        window.is_visible().unwrap_or(false)
                            && !window.is_minimized().unwrap_or(true)
                    })
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => Err(no_browser_target_error()),
            [registration] => Ok(registration.clone()),
            _ => Err("Multiple visible browser targets exist for this session".to_string()),
        }
    }

    #[cfg(windows)]
    fn navigate_and_wait(
        &self,
        app: &AppHandle,
        registration: &Registration,
        webview: &tauri::Webview,
        url: &tauri::Url,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<(), String> {
        self.check_target_identity(app, registration, deadline, fence)?;
        self.invalidate_page(&registration.registration_id);
        let sequence = self.prepare_page_load(&registration.registration_id, url.as_str())?;
        let controller = self.clone();
        let expected = registration.clone();
        let app = app.clone();
        let fence = fence.clone();
        let result = cdp_guarded(
            webview,
            "Page.navigate",
            json!({ "url": url.as_str() }),
            deadline,
            move || controller.check_target_identity(&app, &expected, deadline, &fence),
            24 * 1024 * 1024,
        )?;
        if let Some(error) = result
            .get("errorText")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Err(format!("Browser navigation failed: {error}"));
        }
        if result.get("loaderId").and_then(Value::as_str).is_none() {
            let current_url = webview.url().map_err(|error| error.to_string())?;
            self.complete_same_document_navigation(registration, sequence, current_url.as_str())?;
        }
        self.wait_for_page_load(&registration.registration_id, sequence, deadline)
    }

    fn owned_registration(&self, window_label: &str, id: &str) -> Result<Registration, String> {
        let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        let registration = inner
            .registrations
            .get(id)
            .ok_or_else(|| "Browser target is not registered".to_string())?;
        if registration.window_label != window_label {
            return Err("Browser target belongs to another window".to_string());
        }
        Ok(registration.clone())
    }

    fn document_version(&self, expected: &Registration) -> Result<u64, String> {
        let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if inner.registrations.get(&expected.registration_id) != Some(expected) {
            return Err("Browser target is no longer current".into());
        }
        inner
            .navigation_versions
            .get(&expected.registration_id)
            .copied()
            .ok_or_else(|| "Browser document is unavailable".into())
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn check_target<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        expected: &Registration,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<(), String> {
        self.check_target_identity(app, expected, deadline, fence)?;
        let view = app
            .get_webview(&expected.webview_label)
            .ok_or("Browser preview is no longer available")?;
        allowed_url(view.url().map_err(|error| error.to_string())?.as_str())?;
        self.document_version(expected)?;
        fence.check()
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn check_target_identity<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        expected: &Registration,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<(), String> {
        fence.check()?;
        if Instant::now() >= deadline {
            return Err("Native request expired before execution".into());
        }
        if self.resolve(app, &expected.session_id)? != *expected {
            return Err("Browser target is no longer current".into());
        }
        let view = app
            .get_webview(&expected.webview_label)
            .ok_or("Browser preview is no longer available")?;
        if view.window().label() != expected.window_label {
            return Err("Browser target belongs to another window".into());
        }
        self.document_version(expected)?;
        fence.check()
    }

    #[cfg(any(test, target_os = "linux", target_os = "macos"))]
    fn check_history_registration(&self, expected: &Registration) -> Result<(), String> {
        let current = self.owned_registration(&expected.window_label, &expected.registration_id)?;
        if current.generation != expected.generation
            || current.webview_label != expected.webview_label
        {
            return Err("Browser target changed during history request".into());
        }
        Ok(())
    }

    fn invalidate_page(&self, registration_id: &str) {
        if let Ok(mut inner) = self.inner.0.lock() {
            inner.page_leases.retain(|_, lease| {
                lease.registration.registration_id != registration_id || lease.document.is_some()
            });
            if let Some(version) = inner.navigation_versions.get_mut(registration_id) {
                *version = version.wrapping_add(1);
            }
        }
    }

    fn invalidate_page_for_generation(&self, registration_id: &str, generation: u64) {
        if let Ok(mut inner) = self.inner.0.lock() {
            if inner
                .registrations
                .get(registration_id)
                .map(|item| item.generation)
                != Some(generation)
            {
                return;
            }
            inner.page_leases.retain(|_, lease| {
                lease.registration.registration_id != registration_id || lease.document.is_some()
            });
            if let Some(version) = inner.navigation_versions.get_mut(registration_id) {
                *version = version.wrapping_add(1);
            }
        }
        self.inner.1.notify_all();
    }

    fn prepare_page_load(&self, registration_id: &str, url: &str) -> Result<u64, String> {
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if !inner.registrations.contains_key(registration_id) {
            return Err("Browser preview is no longer available".to_string());
        }
        inner.page_load_sequence = inner.page_load_sequence.wrapping_add(1);
        let sequence = inner.page_load_sequence;
        inner.page_load_expectations.insert(
            registration_id.to_string(),
            PageLoadExpectation {
                sequence,
                url: url.to_string(),
                navigation_id: None,
                result: None,
            },
        );
        Ok(sequence)
    }

    fn complete_same_document_navigation(
        &self,
        registration: &Registration,
        sequence: u64,
        current_url: &str,
    ) -> Result<(), String> {
        let (inner, ready) = &*self.inner;
        let mut inner = inner.lock().map_err(|error| error.to_string())?;
        if inner
            .registrations
            .get(&registration.registration_id)
            .map(|item| item.generation)
            != Some(registration.generation)
        {
            return Err("Browser preview navigation is no longer current".to_string());
        }
        let expectation = inner
            .page_load_expectations
            .get_mut(&registration.registration_id)
            .filter(|expectation| {
                expectation.sequence == sequence && expectation.url == current_url
            })
            .ok_or_else(|| "Browser preview navigation is no longer current".to_string())?;
        // Page.navigate omits loaderId for same-document navigation. WebView2
        // does not issue NavigationStarting/Completed for that operation.
        if expectation.navigation_id.is_none() {
            expectation.result = Some(Ok(()));
        }
        drop(inner);
        ready.notify_all();
        Ok(())
    }

    fn page_load_expectation(
        &self,
        registration_id: &str,
        url: &str,
    ) -> Result<Option<u64>, String> {
        let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        Ok(inner
            .page_load_expectations
            .get(registration_id)
            .filter(|expectation| expectation.url == url)
            .map(|expectation| expectation.sequence))
    }

    fn mark_page_started(
        &self,
        registration_id: &str,
        generation: u64,
        navigation_id: u64,
        url: String,
    ) {
        if let Ok(mut inner) = self.inner.0.lock() {
            if inner
                .registrations
                .get(registration_id)
                .map(|item| item.generation)
                == Some(generation)
            {
                if let Some(expectation) = inner.page_load_expectations.get_mut(registration_id) {
                    if expectation
                        .navigation_id
                        .is_some_and(|id| id != navigation_id)
                    {
                        expectation.result =
                            Some(Err("Browser preview navigation is no longer current".into()));
                    } else if expectation.url == url && expectation.navigation_id.is_none() {
                        expectation.navigation_id = Some(navigation_id);
                    }
                }
            }
        }
        self.inner.1.notify_all();
    }

    fn mark_page_finished(
        &self,
        registration_id: &str,
        generation: u64,
        navigation_id: u64,
        error: Option<String>,
    ) {
        if let Ok(mut inner) = self.inner.0.lock() {
            if inner
                .registrations
                .get(registration_id)
                .map(|item| item.generation)
                != Some(generation)
            {
                return;
            }
            if let Some(expectation) = inner.page_load_expectations.get_mut(registration_id) {
                if expectation.navigation_id == Some(navigation_id) && expectation.result.is_none()
                {
                    expectation.result = Some(error.map_or(Ok(()), Err));
                }
            }
        }
        self.inner.1.notify_all();
    }

    fn wait_for_page_load(
        &self,
        registration_id: &str,
        sequence: u64,
        request_deadline: Instant,
    ) -> Result<(), String> {
        let deadline = request_deadline.min(Instant::now() + Duration::from_secs(15));
        let (inner, ready) = &*self.inner;
        let mut guard = inner.lock().map_err(|error| error.to_string())?;
        loop {
            let expectation = guard
                .page_load_expectations
                .get(registration_id)
                .filter(|expectation| expectation.sequence == sequence)
                .ok_or_else(|| "Browser preview navigation is no longer current".to_string())?;
            if let Some(result) = &expectation.result {
                return result.clone();
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out waiting for the browser page to load".to_string());
            }
            guard = ready
                .wait_timeout(guard, remaining)
                .map_err(|error| error.to_string())?
                .0;
        }
    }
}

fn bounded_history(result: Value) -> Result<Value, String> {
    let index = result["currentIndex"]
        .as_u64()
        .ok_or("Invalid browser history cursor")? as usize;
    let source = result["entries"]
        .as_array()
        .ok_or("Invalid browser history entries")?;
    let current_id = source.get(index).and_then(|entry| entry["id"].as_i64());
    let entries = source
        .iter()
        .skip(index.saturating_sub(16))
        .take(32)
        .filter_map(|entry| {
            let url = entry["url"].as_str()?;
            if url.len() > 2048 || allowed_url(url).is_err() {
                return None;
            }
            Some(json!({ "id": entry["id"].as_i64()?, "url": url }))
        })
        .collect::<Vec<_>>();
    let index = entries
        .iter()
        .position(|entry| entry["id"].as_i64() == current_id)
        .map(|index| index as i64)
        .unwrap_or(-1);
    Ok(json!({ "entries": entries, "index": index }))
}

fn validate_id(value: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max
        || !value
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || "-_".contains(char))
    {
        return Err("Invalid browser target registration".to_string());
    }
    Ok(())
}

fn request_deadline(deadline_ms: u64) -> Result<Instant, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Native request expired before execution".to_string())?
        .as_millis() as u64;
    if deadline_ms <= now_ms {
        return Err("Native request expired before execution".to_string());
    }
    Instant::now()
        .checked_add(Duration::from_millis(deadline_ms - now_ms))
        .ok_or_else(|| "Invalid native request deadline".to_string())
}

fn allowed_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw).map_err(|_| navigation_error())?;
    is_allowed_url(&url)
        .then_some(url)
        .ok_or_else(navigation_error)
}

fn navigation_error() -> String {
    "Browser navigation requires a credential-free HTTP(S) URL".to_string()
}

fn no_browser_target_error() -> String {
    "No visible local browser target for this session".to_string()
}

#[cfg(any(test, not(windows)))]
fn unsupported() -> String {
    "Native browser previews are unavailable on this platform.".to_string()
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn command_url(command: &Value) -> Result<&str, String> {
    command
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Browser navigation URL is required".to_string())
}

#[cfg(windows)]
fn install_webview2_handlers(
    webview: &tauri::Webview,
    controller: BrowserController,
    registration_id: String,
    window_label: String,
    generation: u64,
) -> Result<(), String> {
    use std::sync::mpsc;
    use webview2_com::{
        CoTaskMemPWSTR, NavigationCompletedEventHandler, NavigationStartingEventHandler,
        SourceChangedEventHandler,
    };

    let app = webview.app_handle().clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let core = unsafe { platform.controller().CoreWebView2() }?;
                let started_controller = controller.clone();
                let started_registration_id = registration_id.clone();
                let started = NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut navigation_id = 0;
                    unsafe { args.NavigationId(&mut navigation_id)? };
                    let mut raw = Default::default();
                    unsafe { args.Uri(&mut raw)? };
                    started_controller.mark_page_started(
                        &started_registration_id,
                        generation,
                        navigation_id,
                        CoTaskMemPWSTR::from(raw).to_string(),
                    );
                    Ok(())
                }));
                let mut started_token = 0;
                unsafe { core.add_NavigationStarting(&started, &mut started_token)? };

                let completed_controller = controller.clone();
                let completed_registration_id = registration_id.clone();
                let completed_app = app.clone();
                let completed_window_label = window_label.clone();
                let completed =
                    NavigationCompletedEventHandler::create(Box::new(move |core, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut navigation_id = 0;
                        unsafe { args.NavigationId(&mut navigation_id)? };
                        let mut succeeded = Default::default();
                        unsafe { args.IsSuccess(&mut succeeded)? };
                        let error = if succeeded.as_bool() {
                            None
                        } else {
                            let mut status = Default::default();
                            unsafe { args.WebErrorStatus(&mut status)? };
                            Some(format!("Browser navigation failed: {status:?}"))
                        };
                        completed_controller.mark_page_finished(
                            &completed_registration_id,
                            generation,
                            navigation_id,
                            error,
                        );
                        if succeeded.as_bool() {
                            if let Some(core) = core {
                                let mut raw = Default::default();
                                unsafe { core.Source(&mut raw)? };
                                if let Some(webview) =
                                    completed_app.get_webview(&completed_window_label)
                                {
                                    let _ = webview.emit(
                                        "browser-target:navigated",
                                        json!({
                                            "registrationId": completed_registration_id,
                                            "url": CoTaskMemPWSTR::from(raw).to_string(),
                                        }),
                                    );
                                }
                            }
                        }
                        Ok(())
                    }));
                let mut completed_token = 0;
                unsafe { core.add_NavigationCompleted(&completed, &mut completed_token)? };

                let source = SourceChangedEventHandler::create(Box::new(move |core, _| {
                    let Some(core) = core else {
                        return Ok(());
                    };
                    let mut raw = Default::default();
                    unsafe { core.Source(&mut raw)? };
                    let url = CoTaskMemPWSTR::from(raw).to_string();
                    controller.invalidate_page_for_generation(&registration_id, generation);
                    if let Some(webview) = app.get_webview(&window_label) {
                        let _ = webview.emit(
                            "browser-target:navigated",
                            json!({ "registrationId": registration_id, "url": url }),
                        );
                    }
                    Ok(())
                }));
                let mut source_token = 0;
                unsafe { core.add_SourceChanged(&source, &mut source_token)? };
                Ok::<(), webview2_com::Error>(())
            })();
            let _ = sender.send(result.map_err(|error| error.to_string()));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out configuring WebView2 browser security".to_string())?
}

#[cfg(windows)]
fn run_before_deadline<T>(
    deadline: Instant,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if Instant::now() >= deadline {
        return Err("Native request expired before execution".to_string());
    }
    operation()
}

#[cfg(windows)]
fn cdp(
    webview: &tauri::Webview,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, String> {
    cdp_guarded(
        webview,
        method,
        params,
        deadline,
        || Ok(()),
        24 * 1024 * 1024,
    )
}

#[cfg(windows)]
fn cdp_guarded(
    webview: &tauri::Webview,
    method: &str,
    params: Value,
    deadline: Instant,
    guard: impl Fn() -> Result<(), String> + Send + 'static,
    response_limit: usize,
) -> Result<Value, String> {
    use std::sync::mpsc;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

    let (sender, receiver) = mpsc::sync_channel(1);
    let method = method.to_string();
    let params = params.to_string();
    guard()?;
    run_before_deadline(deadline, || {
        webview
            .with_webview(move |platform| {
                let core = match unsafe { platform.controller().CoreWebView2() } {
                    Ok(core) => core,
                    Err(error) => {
                        let _ = sender.send(Err(error.to_string()));
                        return;
                    }
                };
                let callback_sender = sender.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |error, result| {
                        let _ = callback_sender
                            .send(error.map(|()| result).map_err(|error| error.to_string()));
                        Ok(())
                    },
                ));
                let method = CoTaskMemPWSTR::from(method.as_str());
                let params = CoTaskMemPWSTR::from(params.as_str());
                // Dispatch can outlive the caller's wait. Fence the actual protocol
                // side effect too, not just the operation that queues this closure.
                if let Err(error) = run_before_deadline(deadline, || {
                    guard()?;
                    unsafe {
                        core.CallDevToolsProtocolMethod(
                            *method.as_ref().as_pcwstr(),
                            *params.as_ref().as_pcwstr(),
                            &handler,
                        )
                        .map_err(|error| error.to_string())
                    }
                }) {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())
    })?;
    let timeout = deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_secs(20));
    if timeout.is_zero() {
        return Err("Native request expired before execution".to_string());
    }
    let result = receiver
        .recv_timeout(timeout)
        .map_err(|_| "WebView2 browser command timed out".to_string())??;
    if result.len() > response_limit {
        return Err("Browser page response is too large".to_string());
    }
    serde_json::from_str(&result).map_err(|error| format!("Invalid WebView2 response: {error}"))
}

#[cfg(test)]
#[path = "browser_controller_regressions.rs"]
mod regressions;

#[cfg(test)]
mod tests {
    #[test]
    fn webkit_hosts_publish_native_browser_profiles_and_automation() {
        let source = include_str!("local_windows.rs");
        let webkit = source
            .lines()
            .find(|line| line.contains("reason:'webkit'"))
            .unwrap();
        assert!(webkit.contains("emulation:true,automation:true"));
        assert!(include_str!("cli_manager.rs")
            .contains("cfg!(any(windows, target_os = \"macos\", target_os = \"linux\"))"));
    }

    #[test]
    fn renderer_registration_can_require_hidden_creation() {
        let input: super::BrowserTargetRegistration = serde_json::from_value(serde_json::json!({
            "sessionId": "session", "registrationId": "registration", "url": "https://example.org",
            "bounds": { "x": 0, "y": 0, "width": 300, "height": 200 }, "visible": false
        }))
        .unwrap();
        assert_eq!(input.visible, Some(false));
    }
    use super::*;

    #[test]
    fn rejects_unsafe_browser_urls_and_bounds() {
        assert!(allowed_url("https://example.com/path").is_ok());
        assert!(allowed_url("http://localhost:3000").is_ok());
        assert!(allowed_url("http://127.0.0.1:3000").is_ok());
        for url in ["file:///tmp/a", "https://user:pass@example.com"] {
            assert!(allowed_url(url).is_err(), "accepted {url}");
        }
        assert!(validate_bounds(BrowserTargetBounds {
            x: 0,
            y: 0,
            width: 1,
            height: 1
        })
        .is_ok());
        assert!(validate_bounds(BrowserTargetBounds {
            x: 0,
            y: 0,
            width: 0,
            height: 1
        })
        .is_err());
    }

    #[test]
    fn browser_open_claims_have_one_window_owner() {
        let controller = BrowserController::new(std::path::PathBuf::new());
        controller.inner.0.lock().unwrap().open_claims.insert(
            "request".to_string(),
            OpenClaim {
                session_id: "session".to_string(),
                url: "https://example.com/".to_string(),
                owner: None,
                failed_owners: HashSet::new(),
                fence: None,
            },
        );

        assert!(controller.claim_open("window-1", "request"));
        assert!(controller.claim_open("window-1", "request"));
        assert!(!controller.claim_open("window-2", "request"));
        assert!(controller.release_claim("window-1", "request").is_some());
        assert!(!controller.claim_open("window-1", "request"));
        assert!(controller.claim_open("window-2", "request"));
        assert!(!controller.claim_open("window-1", "missing"));
    }

    #[test]
    fn ignores_a_registration_loading_an_old_open_url() {
        let controller = BrowserController::new(std::path::PathBuf::new());
        controller
            .inner
            .0
            .lock()
            .unwrap()
            .page_load_expectations
            .insert(
                "registration".to_string(),
                PageLoadExpectation {
                    sequence: 1,
                    url: "https://old.example.com/".to_string(),
                    navigation_id: None,
                    result: None,
                },
            );
        assert_eq!(
            controller
                .page_load_expectation("registration", "https://new.example.com/")
                .unwrap(),
            None
        );
    }

    #[test]
    fn failed_navigation_wakes_waiters_with_the_webview_error() {
        let controller = BrowserController::new(std::path::PathBuf::new());
        let registration = Registration {
            session_id: "session".to_string(),
            registration_id: "registration".to_string(),
            window_label: "window".to_string(),
            webview_label: "webview".to_string(),
            generation: 1,
            visible: true,
        };
        controller
            .inner
            .0
            .lock()
            .unwrap()
            .registrations
            .insert(registration.registration_id.clone(), registration);
        let sequence = controller
            .prepare_page_load("registration", "https://example.com/")
            .unwrap();
        controller.mark_page_started("registration", 1, 7, "https://example.com/".to_string());
        controller.mark_page_finished(
            "registration",
            1,
            7,
            Some("Browser navigation failed: ConnectionAborted".to_string()),
        );
        // WebKitGTK emits Finished after LoadFailed for the same load.
        controller.mark_page_finished("registration", 1, 7, None);
        assert_eq!(
            controller
                .wait_for_page_load(
                    "registration",
                    sequence,
                    Instant::now() + Duration::from_secs(1),
                )
                .unwrap_err(),
            "Browser navigation failed: ConnectionAborted"
        );
    }

    #[test]
    fn stale_navigation_completion_cannot_finish_the_latest_navigation() {
        let controller = BrowserController::new(std::path::PathBuf::new());
        let registration = Registration {
            session_id: "session".to_string(),
            registration_id: "registration".to_string(),
            window_label: "window".to_string(),
            webview_label: "webview".to_string(),
            generation: 1,
            visible: true,
        };
        controller
            .inner
            .0
            .lock()
            .unwrap()
            .registrations
            .insert(registration.registration_id.clone(), registration);
        let sequence = controller
            .prepare_page_load("registration", "https://example.com/new")
            .unwrap();
        controller.mark_page_started("registration", 1, 7, "about:blank".to_string());
        controller.mark_page_started("registration", 1, 8, "https://example.com/new".to_string());
        controller.mark_page_finished("registration", 1, 7, None);
        assert!(controller
            .inner
            .0
            .lock()
            .unwrap()
            .page_load_expectations
            .get("registration")
            .unwrap()
            .result
            .is_none());
        controller.mark_page_finished("registration", 1, 8, None);
        controller
            .wait_for_page_load(
                "registration",
                sequence,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
    }
}
