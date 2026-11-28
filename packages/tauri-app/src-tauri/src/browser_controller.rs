use crate::embedded_view::diagnostics::preview_error;
use crate::embedded_view::{
    is_allowed_url, validate_bounds, Bounds as BrowserTargetBounds, EmbeddedViews,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Window};
#[cfg(test)]
use tauri::{PhysicalPosition, PhysicalSize};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::embedded_view::input::STALE_DOCUMENT as STALE_TARGET;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const STALE_TARGET: &str = "Browser target is stale; probe again";

#[cfg(any(test, target_os = "linux", target_os = "macos"))]
fn compare_webkit_document(response: &Value, expected: &str) -> Result<(), String> {
    if response["document"].as_str() == Some(expected) {
        Ok(())
    } else {
        Err(STALE_TARGET.into())
    }
}

#[cfg(windows)]
#[path = "browser_emulation.rs"]
mod emulation;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "browser_emulation_webkit.rs"]
mod emulation;
#[path = "browser_emulation_layout.rs"]
mod viewport;

#[path = "browser_controller_open.rs"]
mod open;
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[path = "browser_open_navigation.rs"]
mod open_navigation;
#[path = "browser_controller_page.rs"]
pub(crate) mod page;
#[path = "browser_diagnostics.rs"]
mod diagnostics;
use open::OpenClaim;
#[path = "browser_preview_owners.rs"]
mod preview_owners;
pub(crate) use open::{OpenResponse, OwnershipAction};

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[path = "browser_owner_visibility.rs"]
mod owner_visibility;

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
    open_request_id: Option<String>,
    instance_id: Option<String>,
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
    instance_id: Option<String>,
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
    instance_id: Option<String>,
    registration_id: String,
    window_label: String,
    webview_label: String,
    generation: u64,
    visibility_version: u64,
    visible: bool,
}

#[derive(Clone)]
struct PageLoadExpectation {
    sequence: u64,
    url: String,
    navigation_id: Option<u64>,
    result: Option<Result<(), String>>,
    completed_url: Option<String>,
    dispatched: bool,
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
    /// The webview whose file pickers each page operation intercepts, kept until its end even if the lease goes.
    #[cfg(any(windows, target_os = "macos"))]
    file_picker_intercepts: HashMap<String, String>,
    navigation_versions: HashMap<String, u64>,
    page_load_sequence: u64,
    page_load_expectations: HashMap<String, PageLoadExpectation>,
    /// The main-frame navigation each registration is loading, from its start to its completion.
    page_loading: HashMap<String, u64>,
    open_claims: HashMap<String, OpenClaim>,
    preview_owners: preview_owners::BrowserPreviewOwners,
}

#[derive(Clone)]
pub(crate) struct BrowserController {
    emulation_lock: Arc<Mutex<()>>,
    inner: Arc<(Mutex<Inner>, Condvar)>,
    profile: Arc<std::path::PathBuf>,
    registration_sequence: Arc<AtomicU64>,
    run_id: Arc<String>,
    pub(crate) embedded_views: EmbeddedViews,
    /// Refs of each session's snapshots (`browser-page.ts`), one operation at a time per session.
    page_refs: Arc<Mutex<page::Refs>>,
    diagnostics: Arc<diagnostics::Buffers>,
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
            page_refs: Default::default(),
            diagnostics: Arc::default(),
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
        if let Some(id) = &input.instance_id {
            validate_id(id, 256)?;
        }
        let url = allowed_url(&input.url)?;
        validate_bounds(input.bounds)?;
        let renderer_version = self
            .renderer_version(window.label())
            .map_err(|error| preview_error("read renderer generation", error))?;
        let registration_id = input.registration_id.clone();
        let generation = self.registration_sequence.fetch_add(1, Ordering::Relaxed);
        self.inner.0.lock().map_err(|error| error.to_string())?.check_preview_owner(
            &input.session_id, window.label(), input.instance_id.as_deref(),
        )?;
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
            instance_id: input.instance_id,
            session_id: input.session_id,
            registration_id: input.registration_id.clone(),
            window_label: window.label().to_string(),
            webview_label: label.clone(),
            generation,
            visibility_version: 0,
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
            self.diagnostics.remove(&input.registration_id, generation);
            let _ = self
                .embedded_views
                .close(window.app_handle(), window.label(), &label);
            return Err(error);
        }

        #[cfg(target_os = "macos")]
        let observation = registration.clone();
        let previous = match self
            .publish_registration(
                registration,
                renderer_version,
                url.as_str(),
                None,
            )
            .map_err(|error| preview_error("publish registration", error))
        {
            Ok(previous) => previous,
            Err(error) => {
                // A refused candidate drops only its own buffer: the published preview keeps its diagnostics.
                self.diagnostics.remove(&input.registration_id, generation);
                let _ = self
                    .embedded_views
                    .close(window.app_handle(), window.label(), &label);
                return Err(error);
            }
        };
        if let Some(previous) = previous {
            self.diagnostics
                .remove(&previous.registration_id, previous.generation);
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
                return Err(preview_error("configure initial viewport", error));
            }
        }
        if let Err(error) = if input.open_request_id.is_some() {
            Ok(())
        } else {
            webview.navigate(url)
        } {
            let _ = self.unregister_generation(
                window.app_handle(),
                window.label(),
                &input.registration_id,
                Some(generation),
            );
            return Err(preview_error("navigate initial document", error));
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
        _open_request_id: Option<&str>,
    ) -> Result<Option<Registration>, String> {
        let (inner, ready) = &*self.inner;
        let mut inner = inner.lock().map_err(|error| error.to_string())?;
        inner.check_preview_owner(
            &registration.session_id, &registration.window_label, registration.instance_id.as_deref(),
        )?;
        if registration.instance_id.is_some() && inner.registrations.values().any(|current|
            current.session_id == registration.session_id && current.instance_id.is_some()
                && current.registration_id != registration.registration_id
        ) {
            return Err("This session already has a native preview".into());
        }
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
        record_page_load(&mut inner, &id, url, false);
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
        if let Some(id) = &input.instance_id {
            validate_id(id, 256)?;
            self.inner.0.lock().map_err(|error| error.to_string())?.check_preview_owner(
                &registration.session_id, window_label, Some(id),
            )?;
        }
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
            current.visibility_version = current.visibility_version.wrapping_add(1);
            inner
                .page_leases
                .retain(|_, lease| lease.registration.registration_id != input.registration_id);
            drop(inner);
            return self.embedded_views.set_visible(
                app,
                window_label,
                &registration.webview_label,
                false,
            );
        }
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if let Some(current) = inner.registrations.get_mut(&input.registration_id) {
            if current.generation == registration.generation
                && current.visibility_version == registration.visibility_version
            {
                if input
                    .instance_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != current.instance_id.as_ref())
                {
                    current.visibility_version = current.visibility_version.wrapping_add(1);
                }
                current.visible = visible;
                if input.instance_id.is_some() {
                    current.instance_id = input.instance_id;
                }
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
        match input.action.as_str() {
            "emulate" => self.emulate(app, window_label, &input),
            "back" => webview
                .eval("history.back()")
                .map_err(|error| preview_error("navigate back", error)),
            "reload" => webview
                .reload()
                .map_err(|error| preview_error("reload document", error)),
            "navigate" => webview
                .navigate(self.navigation_url(&webview, &input)?)
                .map_err(|error| preview_error("navigate document", error)),
            _ => Err("Unsupported browser target action".to_string()),
        }
        .map(|()| Value::Null)
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn navigation_url(
        &self,
        webview: &tauri::Webview,
        input: &BrowserTargetAction,
    ) -> Result<tauri::Url, String> {
        let url = allowed_url(
            input
                .url
                .as_deref()
                .ok_or("Browser navigation URL is required")?,
        )?;
        self.embedded_views.configure_browser_presentation(
            webview,
            &url,
            input.logical_address.as_deref(),
        )?;
        Ok(url)
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
                .navigate(self.navigation_url(&webview, &input)?)
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
        inner.page_loading.remove(registration_id);
        drop(inner);
        self.diagnostics
            .remove(registration_id, registration.generation);
        ready.notify_all();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        webkit_history::remove(app, registration.webview_label.clone());
        self.embedded_views
            .close(app, window_label, &registration.webview_label)?;
        Ok(())
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

    pub(crate) fn revoke_window_visibility(&self, window_label: &str) {
        if let Ok(mut inner) = self.inner.0.lock() {
            for registration in inner.registrations.values_mut() {
                if registration.window_label == window_label {
                    registration.visibility_version =
                        registration.visibility_version.wrapping_add(1);
                }
            }
            inner
                .page_leases
                .retain(|_, lease| lease.registration.window_label != window_label);
            for claim in inner.open_claims.values_mut() {
                if claim.belongs_to(window_label) {
                    claim.revoke();
                }
            }
        }
        self.inner.1.notify_all();
    }

    pub(crate) fn observe_owner(&self, window: &Window) -> tauri::Result<()> {
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        return owner_visibility::observe(window, self.clone());
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = window;
            Ok(())
        }
    }

    pub(crate) fn hide_owner(&self, window: &Window) -> tauri::Result<()> {
        self.revoke_window_visibility(window.label());
        window.hide()
    }

    pub(crate) fn remove_window<R: tauri::Runtime>(&self, app: &AppHandle<R>, window_label: &str) {
        let (children, released) = if let Ok(mut inner) = self.inner.0.lock() {
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
                inner.page_loading.remove(&id);
                if let Some(registration) = inner.registrations.get(&id) {
                    self.diagnostics.remove(&id, registration.generation);
                }
                inner.registrations.remove(&id);
                inner.emulation_profiles.remove(&id);
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                inner.canvases.remove(&id);
            }
            inner
                .open_claims
                .retain(|_, claim| !claim.belongs_to(window_label));
            (children, inner.preview_owners.release(window_label, None))
        } else {
            (Vec::new(), Vec::new())
        };
        for (session, _, revision) in released {
            self.publish_preview_ownership(app, &session, revision, None);
        }
        for child in children {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            webkit_history::remove(app, child);
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            let _ = child;
        }
        self.embedded_views.remove_owner(app, window_label);
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
                "browser.probe" => self.probe(
                    app,
                    session_id,
                    workspace_filter(input.get("workspaceIDs"))?,
                    deadline,
                    &fence,
                    |registration, version| {
                        #[cfg(windows)]
                        {
                            let _ = (registration, version);
                            Ok(String::new())
                        }
                        #[cfg(any(target_os = "linux", target_os = "macos"))]
                        self.webkit_target_document(app, registration, version, deadline, &fence)
                    },
                ),
                "browser.execute" => self.execute(
                    app,
                    session_id,
                    input
                        .get("command")
                        .cloned()
                        .ok_or_else(|| "Invalid browser request".to_string())?,
                    input.get("target"),
                    &input["workspaceIDs"],
                    deadline,
                    &fence,
                ),
                _ => Err(format!("Unsupported native method: {method}")),
            }
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn probe<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        workspaces: Option<Vec<String>>,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
        read_document: impl FnOnce(&Registration, u64) -> Result<String, String>,
    ) -> Result<Value, String> {
        // Only a view in one of these project tabs serves the session to its agents.
        let registration = self.resolve_with_visibility_in(session_id, workspaces.as_deref(), |label| {
            window_visible(app, label)
        })?;
        let document = self.document_version(&registration)?;
        self.check_target(app, &registration, deadline, fence)?;
        let token = read_document(&registration, document)?;
        let mut target = self.page_generation(&registration, document);
        if !token.is_empty() {
            target.push(':');
            target.push_str(&token);
        }
        if target.len() > 128 {
            return Err("Browser target witness is too large".into());
        }
        self.check_witness_state(app, &registration, document)?;
        fence.check()?;
        let loading = self
            .inner
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .page_loading
            .contains_key(&registration.registration_id);
        Ok(json!({
            "available": true,
            "target": target,
            "loading": loading,
            "registration": registration_identity(&registration),
        }))
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn execute(
        &self,
        app: &AppHandle,
        session_id: &str,
        command: Value,
        target: Option<&Value>,
        workspace_ids: &Value,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let action = command
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "Invalid browser command".to_string())?;
        if action == "open" {
            let url = command_url(&command)?;
            return self.open(app, session_id, url, workspace_ids, deadline, fence);
        }
        let target = read_witness(target)?;
        let (registration, document, token) = self.resolve_witness(app, session_id, target)?;
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
        match action {
            "navigate" => {
                let url = allowed_url(command_url(&command)?)?;
                let url = self.navigate_and_wait(
                    &registration,
                    &webview,
                    &url,
                    deadline.min(Instant::now() + Duration::from_secs(15)),
                    fence,
                    Some((document, token)),
                    None,
                    || Ok(()),
                )?;
                Ok(json!({ "url": url, "registration": registration_identity(&registration) }))
            }
            "back" | "forward" | "reload" => {
                let nav_deadline = deadline.min(Instant::now() + Duration::from_secs(15));
                #[cfg(windows)]
                let url = if action == "reload" {
                    let current = allowed_url(
                        webview.url().map_err(|error| error.to_string())?.as_str(),
                    )?;
                    self.navigate_with_dispatch(
                        &registration,
                        &webview,
                        &current,
                        nav_deadline,
                        fence,
                        Some((document, token)),
                        None,
                        || Ok(()),
                        open_navigation::NavigationDispatch::Reload,
                    )?
                } else {
                    let controller = self.clone();
                    let expected = registration.clone();
                    let queued_app = app.clone();
                    let queued_fence = fence.clone();
                    let history = cdp_guarded(
                        &webview,
                        "Page.getNavigationHistory",
                        json!({}),
                        nav_deadline,
                        move || {
                            controller.check_capture(
                                &queued_app,
                                &expected,
                                document,
                                nav_deadline,
                                &queued_fence,
                            )
                        },
                        2 * 1024 * 1024,
                    )?;
                    let index = history["currentIndex"]
                        .as_i64()
                        .ok_or("Browser history is unavailable")?;
                    let target_index = if action == "back" { index - 1 } else { index + 1 };
                    let entry = usize::try_from(target_index)
                        .ok()
                        .and_then(|idx| history["entries"].as_array().and_then(|e| e.get(idx)))
                        .ok_or_else(|| {
                            if action == "back" {
                                "No previous page in browser history"
                            } else {
                                "No next page in browser history"
                            }
                        })?;
                    let entry_id = entry["id"]
                        .as_i64()
                        .ok_or("Invalid browser history entry")?;
                    let entry_url = allowed_url(
                        entry["url"]
                            .as_str()
                            .ok_or("Invalid browser history URL")?,
                    )?;
                    self.navigate_with_dispatch(
                        &registration,
                        &webview,
                        &entry_url,
                        nav_deadline,
                        fence,
                        Some((document, token)),
                        None,
                        || Ok(()),
                        open_navigation::NavigationDispatch::HistoryEntry(entry_id),
                    )?
                };
                #[cfg(windows)]
                return Ok(json!({ "url": url, "registration": registration_identity(&registration) }));
                // WebKit previews do not report a load receipt for history traversal or reload.
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                {
                    let _ = (nav_deadline, document, token);
                    Err("Browser history and reload are unavailable in WebKit previews; use navigate"
                        .into())
                }
            }
            "screenshot" => {
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
                            controller.check_capture(&app, &expected, document, deadline, &fence)
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
                    let queued_app = app.clone();
                    let queued_fence = fence.clone();
                    let bytes = crate::embedded_view::input::read(
                        &webview,
                        crate::embedded_view::input::Read::Guarded {
                            document: Some(token.into()),
                            dispatch: crate::embedded_view::input::DocumentDispatch::Capture,
                        },
                        deadline,
                        move || {
                            controller.check_capture(
                                &queued_app,
                                &expected,
                                document,
                                deadline,
                                &queued_fence,
                            )
                        },
                    )?;
                    if self.webkit_target_document(app, &registration, document, deadline, fence)?
                        != token
                    {
                        return Err(STALE_TARGET.into());
                    }
                    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                    if encoded.len() > 16 * 1024 * 1024 {
                        return Err("Browser screenshot is unavailable or too large".into());
                    }
                    encoded
                };
                let url = webview.url().map_err(|error| error.to_string())?;
                self.check_capture(app, &registration, document, deadline, fence)?;
                Ok(json!({ "image": { "mime": "image/png", "data": data }, "url": url }))
            }
            _ => self.page_action(app, session_id, &command, target, deadline, fence),
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn resolve<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
    ) -> Result<Registration, String> {
        self.resolve_with_visibility(session_id, |label| window_visible(app, label))
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn resolve_with_visibility(
        &self,
        session_id: &str,
        read_visibility: impl FnMut(&str) -> tauri::Result<bool>,
    ) -> Result<Registration, String> {
        self.resolve_with_visibility_in(session_id, None, read_visibility)
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn resolve_with_visibility_in(
        &self,
        session_id: &str,
        workspaces: Option<&[String]>,
        read_visibility: impl FnMut(&str) -> tauri::Result<bool>,
    ) -> Result<Registration, String> {
        validate_id(session_id, 256)?;
        let registrations = self
            .inner
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .registrations
            .values()
            .filter(|registration| {
                registration.session_id == session_id
                    && registration.visible
                    && workspaces.is_none_or(|workspaces| {
                        registration
                            .instance_id
                            .as_ref()
                            .is_some_and(|id| workspaces.contains(id))
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        resolve_visible_registration(registrations.iter(), read_visibility).cloned()
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn resolve_witness<'a, R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        target: &'a str,
    ) -> Result<(Registration, u64, &'a str), String> {
        let registration = self.resolve(app, session_id).map_err(stale_if_hidden)?;
        let document = self
            .document_version(&registration)
            .map_err(|_| STALE_TARGET)?;
        let generation = self.page_generation(&registration, document);
        let token = target.strip_prefix(&generation).ok_or(STALE_TARGET)?;
        #[cfg(windows)]
        let token = token.is_empty().then_some("").ok_or(STALE_TARGET)?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let token = token
            .strip_prefix(':')
            .filter(|token| !token.is_empty())
            .ok_or(STALE_TARGET)?;
        Ok((registration, document, token))
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn check_witness_state<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        registration: &Registration,
        document: u64,
    ) -> Result<(), String> {
        if self
            .resolve(app, &registration.session_id)
            .map_err(stale_if_hidden)?
            != *registration
        {
            return Err(STALE_TARGET.into());
        }
        self.check_dispatch_document(registration, Some(document))
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn check_capture<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        registration: &Registration,
        document: u64,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<(), String> {
        self.check_witness_state(app, registration, document)?;
        self.check_target(app, registration, deadline, fence)?;
        self.check_dispatch_document(registration, Some(document))
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
        self.check_registration(app, expected)?;
        fence.check()
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn check_registration<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        expected: &Registration,
    ) -> Result<(), String> {
        let view = app
            .get_webview(&expected.webview_label)
            .ok_or("Browser preview is no longer available")?;
        if !expected.visible
            || !window_visible(app, &expected.window_label)
                .map_err(|error| preview_error("inventory is incomplete", error))?
        {
            return Err("Browser target is no longer current".into());
        }
        if view.window().label() != expected.window_label {
            return Err("Browser target belongs to another window".into());
        }
        self.document_version(expected).map(|_| ())
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
            invalidate_page(&mut inner, registration_id);
        }
    }

    fn prepare_navigation(
        &self,
        registration: &Registration,
        url: &str,
        document: Option<u64>,
        open_request: Option<&str>,
        check_admission: impl FnOnce() -> Result<(), String>,
    ) -> Result<u64, String> {
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        let id = &registration.registration_id;
        if inner.registrations.get(id) != Some(registration)
            || document.is_some_and(|document| inner.navigation_versions.get(id) != Some(&document))
        {
            return Err(STALE_TARGET.into());
        }
        check_admission()?;
        if let Some(request_id) = open_request {
            open::check_open_target(&inner, request_id, registration)?;
        }
        invalidate_page(&mut inner, id);
        let sequence = record_page_load(&mut inner, id, url, true);
        if let Some(request_id) = open_request {
            inner.open_claims.get_mut(request_id).unwrap().load_sequence = Some(sequence);
        }
        Ok(sequence)
    }

    fn check_dispatch_document(
        &self,
        registration: &Registration,
        document: Option<u64>,
    ) -> Result<(), String> {
        if document
            .is_some_and(|document| self.document_version(registration).ok() != Some(document))
        {
            return Err(STALE_TARGET.into());
        }
        Ok(())
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
            invalidate_page(&mut inner, registration_id);
        }
        self.inner.1.notify_all();
    }

    fn retire_queued_open(&self, registration_id: &str, generation: u64, url: &str) {
        if url == "about:blank" {
            return;
        }
        if let Ok(mut inner) = self.inner.0.lock() {
            open::retire_open_for_navigation(&mut inner, registration_id, generation, None, Some(url));
        }
        self.inner.1.notify_all();
    }

    #[cfg(windows)]
    fn webview2_document_opened(
        &self,
        registration_id: &str,
        generation: u64,
        session_id: &str,
        parameters: &str,
    ) {
        if !session_id.is_empty() {
            return;
        }
        let Ok(parameters) = serde_json::from_str::<Value>(parameters) else {
            return;
        };
        let frame = &parameters["frame"];
        if frame["id"].as_str().is_some_and(|id| !id.is_empty()) && frame.get("parentId").is_none()
        {
            // document.open() replaces the document without a navigation: its diagnostics restart too.
            self.diagnostics.restart(registration_id, generation, None);
            self.invalidate_page_for_generation(registration_id, generation);
        }
    }

    fn prepare_page_load(&self, registration_id: &str, url: &str) -> Result<u64, String> {
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if !inner.registrations.contains_key(registration_id) {
            return Err("Browser preview is no longer available".to_string());
        }
        Ok(record_page_load(&mut inner, registration_id, url, false))
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
        if expectation.navigation_id.is_none() && expectation.result.is_none() {
            expectation.result = Some(Ok(()));
            expectation.completed_url = Some(current_url.to_owned());
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
                inner
                    .page_loading
                    .insert(registration_id.to_string(), navigation_id);
                if url != "about:blank" {
                    open::retire_open_for_navigation(
                        &mut inner,
                        registration_id,
                        generation,
                        None,
                        Some(&url),
                    );
                }
                if let Some(expectation) = inner.page_load_expectations.get_mut(registration_id) {
                    if expectation
                        .navigation_id
                        .is_some_and(|id| id != navigation_id)
                        || (expectation.dispatched
                            && expectation.navigation_id.is_none()
                            && expectation.url != url
                            && url != "about:blank")
                    {
                        expectation.result =
                            Some(Err("Browser preview navigation is no longer current".into()));
                        let sequence = expectation.sequence;
                        let successor = expectation.url != url
                            && expectation.completed_url.as_deref() != Some(url.as_str());
                        if allowed_url(&url).is_ok() {
                            open::retire_open_for_navigation(
                                &mut inner,
                                registration_id,
                                generation,
                                Some(sequence),
                                successor.then_some(url.as_str()),
                            );
                        }
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
            if inner.page_loading.get(registration_id) == Some(&navigation_id) {
                inner.page_loading.remove(registration_id);
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

    fn mark_page_committed(
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
                .map(|entry| entry.generation)
                != Some(generation)
            {
                return;
            }
            if let Some(load) = inner.page_load_expectations.get_mut(registration_id) {
                if load.dispatched
                    && load.navigation_id == Some(navigation_id)
                    && load.result.is_none()
                {
                    load.completed_url.get_or_insert(url);
                }
            }
        }
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

pub(crate) fn request_deadline(deadline_ms: u64) -> Result<Instant, String> {
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

/// The preview a probe or a load used: a load that ends in another registration is no receipt for the agent's tab.
fn registration_identity(registration: &Registration) -> String {
    format!("{}:{}", registration.registration_id, registration.generation)
}

/// The project tabs a probe may use, from the backend's verified owners.
fn workspace_filter(value: Option<&Value>) -> Result<Option<Vec<String>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let ids = value
        .as_array()
        .filter(|ids| ids.len() <= 1024)
        .ok_or("Invalid browser request")?
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| validate_id(id, 256).is_ok())
                .map(str::to_string)
                .ok_or("Invalid browser request")
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(ids))
}

fn resolve_visible_registration<'a>(
    registrations: impl IntoIterator<Item = &'a Registration>,
    mut read_visibility: impl FnMut(&str) -> tauri::Result<bool>,
) -> Result<&'a Registration, String> {
    let mut matches = Vec::new();
    for registration in registrations {
        if read_visibility(&registration.window_label)
            .map_err(|error| preview_error("inventory is incomplete", error))?
        {
            matches.push(registration);
        }
    }
    match matches.as_slice() {
        [] => Err(no_browser_target_error()),
        [registration] => Ok(*registration),
        _ => Err("Multiple visible browser targets exist for this session".to_string()),
    }
}

fn window_visible<R: tauri::Runtime>(app: &AppHandle<R>, owner: &str) -> tauri::Result<bool> {
    let Some(window) = app.get_window(owner) else {
        return Ok(false);
    };
    Ok(window.is_visible()? && !window.is_minimized()?)
}

fn invalidate_page(inner: &mut Inner, registration_id: &str) {
    inner.page_leases.retain(|_, lease| {
        lease.registration.registration_id != registration_id || lease.document.is_some()
    });
    if let Some(version) = inner.navigation_versions.get_mut(registration_id) {
        *version = version.wrapping_add(1);
    }
}

fn record_page_load(inner: &mut Inner, registration_id: &str, url: &str, dispatched: bool) -> u64 {
    inner.page_load_sequence = inner.page_load_sequence.wrapping_add(1);
    let sequence = inner.page_load_sequence;
    inner.page_load_expectations.insert(
        registration_id.to_string(),
        PageLoadExpectation {
            sequence,
            url: url.to_string(),
            navigation_id: None,
            result: None,
            completed_url: None,
            dispatched,
        },
    );
    sequence
}

fn read_witness(value: Option<&Value>) -> Result<&str, String> {
    value
        .and_then(Value::as_str)
        .filter(|target| !target.is_empty() && target.len() <= 128)
        .ok_or_else(|| "A current browser target is required".to_string())
}

fn no_browser_target_error() -> String {
    "No visible local browser target for this session".to_string()
}

fn stale_if_hidden(error: String) -> String {
    if error == no_browser_target_error() {
        STALE_TARGET.into()
    } else {
        error
    }
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
        CoTaskMemPWSTR, ContentLoadingEventHandler, DevToolsProtocolEventReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceivedEventArgs2,
        NavigationCompletedEventHandler, NavigationStartingEventHandler, SourceChangedEventHandler,
    };
    use windows_core::Interface;

    let app = webview.app_handle().clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    let (controller_diagnostics, diagnostics_registration_id) =
        (controller.diagnostics.clone(), registration_id.clone());
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|error| preview_error("get WebView2 for navigation handlers", error))?;
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
                    // A new document's diagnostics start with its own request, as in OpenCode's browser.
                    started_controller
                        .diagnostics
                        .restart(&started_registration_id, generation, Some(navigation_id));
                    started_controller.mark_page_started(
                        &started_registration_id,
                        generation,
                        navigation_id,
                        CoTaskMemPWSTR::from(raw).to_string(),
                    );
                    Ok(())
                }));
                let mut started_token = 0;
                unsafe { core.add_NavigationStarting(&started, &mut started_token) }
                    .map_err(|error| preview_error("install navigation starting handler", error))?;

                let committed_controller = controller.clone();
                let committed_id = registration_id.clone();
                let committed = ContentLoadingEventHandler::create(Box::new(move |core, args| {
                    if let (Some(core), Some(args)) = (core, args) {
                        let mut navigation_id = 0;
                        let mut source = Default::default();
                        unsafe {
                            args.NavigationId(&mut navigation_id)?;
                            core.Source(&mut source)?;
                        }
                        committed_controller.mark_page_committed(
                            &committed_id, generation, navigation_id, CoTaskMemPWSTR::from(source).to_string(),
                        );
                    }
                    Ok(())
                }));
                let mut committed_token = 0;
                unsafe { core.add_ContentLoading(&committed, &mut committed_token) }
                    .map_err(|error| preview_error("install navigation commit handler", error))?;

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
                        let source = if let Some(core) = core.as_ref().filter(|_| succeeded.as_bool()) {
                            let mut raw = Default::default();
                            unsafe { core.Source(&mut raw)? };
                            Some(CoTaskMemPWSTR::from(raw).to_string())
                        } else {
                            None
                        };
                        completed_controller.mark_page_finished(
                            &completed_registration_id,
                            generation,
                            navigation_id,
                            error,
                        );
                        if let Some(url) = source {
                            if let Some(webview) =
                                completed_app.get_webview(&completed_window_label)
                            {
                                let _ = webview.emit(
                                    "browser-target:navigated",
                                    json!({ "registrationId": completed_registration_id, "url": url }),
                                );
                            }
                        }
                        Ok(())
                    }));
                let mut completed_token = 0;
                unsafe { core.add_NavigationCompleted(&completed, &mut completed_token) }
                    .map_err(|error| preview_error("install navigation completed handler", error))?;

                let event_name = CoTaskMemPWSTR::from("Page.documentOpened");
                let receiver = unsafe {
                    core.GetDevToolsProtocolEventReceiver(*event_name.as_ref().as_pcwstr())
                }
                .map_err(|error| preview_error("get document-opened event receiver", error))?;
                let document_controller = controller.clone();
                let document_registration_id = registration_id.clone();
                let document_opened =
                    DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let session =
                            args.cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>()?;
                        let mut session_id = Default::default();
                        unsafe { session.SessionId(&mut session_id)? };
                        let session_id = CoTaskMemPWSTR::from(session_id);
                        let mut parameters = Default::default();
                        unsafe { args.ParameterObjectAsJson(&mut parameters)? };
                        document_controller.webview2_document_opened(
                            &document_registration_id,
                            generation,
                            &session_id.to_string(),
                            &CoTaskMemPWSTR::from(parameters).to_string(),
                        );
                        Ok(())
                    }));
                let mut document_token = 0;
                run_before_deadline(deadline, || {
                    unsafe {
                        receiver.add_DevToolsProtocolEventReceived(
                            &document_opened,
                            &mut document_token,
                        )
                    }
                    .map_err(|error| preview_error("install document-opened handler", error))
                })?;
                diagnostics::install(&core, controller.clone(), registration_id.clone(), generation)?;

                let source = SourceChangedEventHandler::create(Box::new(move |core, args| {
                    let Some(core) = core else {
                        return Ok(());
                    };
                    let mut raw = Default::default();
                    unsafe { core.Source(&mut raw)? };
                    let url = CoTaskMemPWSTR::from(raw).to_string();
                    if let Some(args) = args {
                        let mut new_document = Default::default();
                        unsafe { args.IsNewDocument(&mut new_document)? };
                        if !new_document.as_bool() {
                            controller.retire_queued_open(&registration_id, generation, &url);
                        }
                    }
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
                unsafe { core.add_SourceChanged(&source, &mut source_token) }
                    .map_err(|error| preview_error("install source changed handler", error))?;
                Ok::<(), String>(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| preview_error("dispatch WebView2 navigation handlers", error))?;
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|error| preview_error("wait for WebView2 navigation handlers", error))??;
    // Confirm Page events are enabled before this guest can publish any witness.
    cdp(webview, "Page.enable", json!({}), deadline)?;
    // Diagnostics are an extra: a preview whose domains cannot be enabled still serves the page channel.
    for (method, params) in &diagnostics::spec().enable {
        if cdp(webview, method, params.clone(), deadline).is_err() {
            controller_diagnostics.remove(&diagnostics_registration_id, generation);
            break;
        }
    }
    Ok(())
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
    cdp_guarded_in(webview, None, method, params, deadline, guard, response_limit)
}

/// `session` sends the command to an out-of-process frame's protocol session.
#[cfg(windows)]
fn cdp_guarded_in(
    webview: &tauri::Webview,
    session: Option<String>,
    method: &str,
    params: Value,
    deadline: Instant,
    guard: impl Fn() -> Result<(), String> + Send + 'static,
    response_limit: usize,
) -> Result<Value, String> {
    let step = format!("CDP {method}");
    let deadline = deadline.min(Instant::now() + Duration::from_secs(20));
    guard()
        .and_then(|()| {
            cdp_guarded_inner(webview, session, method, params, deadline, guard, response_limit)
        })
        .map_err(|error| preview_error(&step, error))
}

#[cfg(windows)]
pub(crate) fn cdp_guarded_inner(
    webview: &tauri::Webview,
    session: Option<String>,
    method: &str,
    params: Value,
    deadline: Instant,
    guard: impl Fn() -> Result<(), String> + Send + 'static,
    response_limit: usize,
) -> Result<Value, String> {
    use std::sync::mpsc;
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR,
        Microsoft::Web::WebView2::Win32::ICoreWebView2_11,
    };
    use windows_core::Interface;

    let (sender, receiver) = mpsc::sync_channel(1);
    let method = method.to_string();
    let params = params.to_string();
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
                    if let Some(session) = &session {
                        let core = core
                            .cast::<ICoreWebView2_11>()
                            .map_err(|error| error.to_string())?;
                        let session = CoTaskMemPWSTR::from(session.as_str());
                        return unsafe {
                            core.CallDevToolsProtocolMethodForSession(
                                *session.as_ref().as_pcwstr(),
                                *method.as_ref().as_pcwstr(),
                                *params.as_ref().as_pcwstr(),
                                &handler,
                            )
                            .map_err(|error| error.to_string())
                        };
                    }
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
    let timeout = deadline.saturating_duration_since(Instant::now());
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
                    completed_url: None,
                    dispatched: false,
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
            instance_id: None,
            registration_id: "registration".to_string(),
            window_label: "window".to_string(),
            webview_label: "webview".to_string(),
            generation: 1,
            visibility_version: 0,
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
            instance_id: None,
            registration_id: "registration".to_string(),
            window_label: "window".to_string(),
            webview_label: "webview".to_string(),
            generation: 1,
            visibility_version: 0,
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
