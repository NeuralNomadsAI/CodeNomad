use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Window};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTargetRegistration {
    session_id: String,
    registration_id: String,
    url: String,
    bounds: BrowserTargetBounds,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub(crate) struct BrowserTargetBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTargetUpdate {
    registration_id: String,
    bounds: Option<BrowserTargetBounds>,
    visible: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTargetAction {
    registration_id: String,
    action: String,
    url: Option<String>,
}

#[derive(Clone)]
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
}

#[derive(Default)]
struct Inner {
    registrations: HashMap<String, Registration>,
    refs: HashMap<String, HashMap<String, i64>>,
    navigation_versions: HashMap<String, u64>,
    page_load_sequence: u64,
    page_load_expectations: HashMap<String, PageLoadExpectation>,
    open_claims: HashMap<String, OpenClaim>,
}

#[derive(Clone)]
pub(crate) struct BrowserController {
    inner: Arc<(Mutex<Inner>, Condvar)>,
    profile: Arc<std::path::PathBuf>,
    registration_sequence: Arc<AtomicU64>,
}

impl BrowserController {
    pub(crate) fn new(profile: std::path::PathBuf) -> Self {
        Self {
            inner: Arc::new((Mutex::new(Inner::default()), Condvar::new())),
            profile: Arc::new(profile),
            registration_sequence: Arc::new(AtomicU64::new(1)),
        }
    }

    #[cfg(windows)]
    pub(crate) fn register(
        &self,
        window: &Window,
        input: BrowserTargetRegistration,
    ) -> Result<(), String> {
        use tauri::webview::{NewWindowResponse, WebviewBuilder};
        use tauri::WebviewUrl;

        validate_id(&input.session_id, 256)?;
        validate_id(&input.registration_id, 128)?;
        let url = allowed_url(&input.url)?;
        let blank = "about:blank"
            .parse()
            .map_err(|error| format!("failed to prepare browser preview: {error}"))?;
        validate_bounds(input.bounds)?;
        let label = format!("browser-{}", input.registration_id);
        let registration_id = input.registration_id.clone();
        let generation = self.registration_sequence.fetch_add(1, Ordering::Relaxed);
        let navigation_controller = self.clone();
        let navigation_registration_id = registration_id.clone();
        let policy_controller = self.clone();
        let policy_registration_id = registration_id.clone();
        let profile = self
            .profile
            .join(format!("{:x}", Sha256::digest(input.session_id.as_bytes())));
        let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(blank))
            .data_directory(profile)
            .on_navigation(move |url| {
                let allowed = url.as_str() == "about:blank" || is_allowed_url(url);
                if allowed {
                    policy_controller
                        .clear_refs_for_generation(&policy_registration_id, generation);
                }
                allowed
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(move |webview, payload| {
                if payload.event() == PageLoadEvent::Started
                    && payload.url().as_str() != "about:blank"
                {
                    navigation_controller
                        .clear_refs_for_generation(&navigation_registration_id, generation);
                    let _ = webview.window().emit(
                        "browser-target:navigated",
                        json!({ "registrationId": registration_id, "url": payload.url().as_str() }),
                    );
                }
            });
        let webview = window
            .add_child(
                builder,
                PhysicalPosition::new(input.bounds.x, input.bounds.y),
                PhysicalSize::new(input.bounds.width, input.bounds.height),
            )
            .map_err(|error| format!("failed to create browser preview: {error}"))?;
        if let Err(error) = install_webview2_handlers(
            &webview,
            self.clone(),
            input.registration_id.clone(),
            window.label().to_string(),
            generation,
        ) {
            let _ = webview.close();
            return Err(error);
        }
        if let Err(error) = webview.show() {
            let _ = webview.close();
            return Err(error.to_string());
        }

        let registration = Registration {
            session_id: input.session_id,
            registration_id: input.registration_id.clone(),
            window_label: window.label().to_string(),
            webview_label: label,
            generation,
            visible: true,
        };
        let (inner, ready) = &*self.inner;
        let mut inner = inner.lock().map_err(|error| error.to_string())?;
        let previous = inner
            .registrations
            .insert(input.registration_id.clone(), registration);
        inner.refs.remove(&input.registration_id);
        inner
            .navigation_versions
            .insert(input.registration_id.clone(), 0);
        inner.page_load_sequence = inner.page_load_sequence.wrapping_add(1);
        let load_sequence = inner.page_load_sequence;
        inner.page_load_expectations.insert(
            input.registration_id.clone(),
            PageLoadExpectation {
                sequence: load_sequence,
                url: url.to_string(),
                navigation_id: None,
                result: None,
            },
        );
        drop(inner);
        if let Some(previous) = previous {
            if let Some(previous_webview) = window.app_handle().get_webview(&previous.webview_label)
            {
                let _ = previous_webview.close();
            }
        }
        ready.notify_all();
        if let Err(error) = webview.navigate(url) {
            let _ = self.unregister(window.app_handle(), window.label(), &input.registration_id);
            return Err(error.to_string());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub(crate) fn register(
        &self,
        _window: &Window,
        _input: BrowserTargetRegistration,
    ) -> Result<(), String> {
        Err(unsupported())
    }

    pub(crate) fn update(
        &self,
        app: &AppHandle,
        window_label: &str,
        input: BrowserTargetUpdate,
    ) -> Result<(), String> {
        let registration = self.owned_registration(window_label, &input.registration_id)?;
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
        let visible = input.visible.unwrap_or(true);
        if visible {
            let bounds = input
                .bounds
                .ok_or_else(|| "Visible browser target bounds are required".to_string())?;
            validate_bounds(bounds)?;
            webview
                .set_position(PhysicalPosition::new(bounds.x, bounds.y))
                .and_then(|()| webview.set_size(PhysicalSize::new(bounds.width, bounds.height)))
                .and_then(|()| webview.show())
                .map_err(|error| error.to_string())?;
        } else {
            webview.hide().map_err(|error| error.to_string())?;
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
    ) -> Result<(), String> {
        let registration = self.owned_registration(window_label, &input.registration_id)?;
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
        match input.action.as_str() {
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
    }

    #[cfg(not(windows))]
    pub(crate) fn action(
        &self,
        _app: &AppHandle,
        _window_label: &str,
        _input: BrowserTargetAction,
    ) -> Result<(), String> {
        Err(unsupported())
    }

    pub(crate) fn unregister(
        &self,
        app: &AppHandle,
        window_label: &str,
        registration_id: &str,
    ) -> Result<(), String> {
        let (inner, ready) = &*self.inner;
        let mut inner = inner.lock().map_err(|error| error.to_string())?;
        let Some(registration) = inner.registrations.get(registration_id) else {
            return Ok(());
        };
        if registration.window_label != window_label {
            return Err("Browser target belongs to another window".to_string());
        }
        let registration = inner.registrations.remove(registration_id).unwrap();
        inner.refs.remove(registration_id);
        inner.navigation_versions.remove(registration_id);
        inner.page_load_expectations.remove(registration_id);
        drop(inner);
        ready.notify_all();
        if let Some(webview) = app.get_webview(&registration.webview_label) {
            webview.close().map_err(|error| error.to_string())?;
        }
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
        if claim.owner.as_deref() != Some(window_label) {
            return None;
        }
        claim.owner = None;
        claim.failed_owners.insert(window_label.to_string());
        Some(claim.clone())
    }

    pub(crate) fn remove_window(&self, app: &AppHandle, window_label: &str) {
        let (labels, retries) = if let Ok(mut inner) = self.inner.0.lock() {
            let ids = inner
                .registrations
                .values()
                .filter(|registration| registration.window_label == window_label)
                .map(|registration| registration.registration_id.clone())
                .collect::<Vec<_>>();
            let labels = ids
                .into_iter()
                .filter_map(|id| {
                    inner.refs.remove(&id);
                    inner.navigation_versions.remove(&id);
                    inner.page_load_expectations.remove(&id);
                    inner
                        .registrations
                        .remove(&id)
                        .map(|item| item.webview_label)
                })
                .collect::<Vec<_>>();
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
            (labels, retries)
        } else {
            (Vec::new(), Vec::new())
        };
        for label in labels {
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.close();
            }
        }
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
    ) -> Result<Value, String> {
        #[cfg(not(windows))]
        {
            let _ = (app, method, params, deadline_ms);
            return Err(unsupported());
        }
        #[cfg(windows)]
        {
            let input = params.ok_or_else(|| "Invalid browser request".to_string())?;
            let deadline = request_deadline(deadline_ms)?;
            let session_id = input
                .get("sessionID")
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid browser request".to_string())?;
            match method {
                "browser.probe" => {
                    self.resolve(app, session_id)?;
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
                ),
                _ => Err(format!("Unsupported native method: {method}")),
            }
        }
    }

    #[cfg(windows)]
    fn execute(
        &self,
        app: &AppHandle,
        session_id: &str,
        command: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        let action = command
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "Invalid browser command".to_string())?;
        if action == "open" {
            let url = command_url(&command)?;
            return self.open(app, session_id, url, deadline);
        }
        let registration = self.resolve(app, session_id)?;
        let webview = app
            .get_webview(&registration.webview_label)
            .ok_or_else(|| "Browser preview is no longer available".to_string())?;
        match action {
            "navigate" => {
                let url = allowed_url(command_url(&command)?)?;
                self.navigate_and_wait(&registration, &webview, &url, deadline)?;
                Ok(json!({ "url": webview.url().map_err(|error| error.to_string())? }))
            }
            "snapshot" => self.snapshot(&registration, &webview, deadline),
            "click" => {
                let target = command_ref(&command)?;
                self.click(&registration, &webview, target, deadline)?;
                Ok(
                    json!({ "clicked": target, "url": webview.url().map_err(|error| error.to_string())? }),
                )
            }
            "type" => {
                let target = command_ref(&command)?;
                self.click(&registration, &webview, target, deadline)?;
                if command.get("clear").and_then(Value::as_bool) != Some(false) {
                    clear_focused_field(&webview, deadline)?;
                }
                let text = command
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Browser text is required".to_string())?;
                cdp(
                    &webview,
                    "Input.insertText",
                    json!({ "text": text }),
                    deadline,
                )?;
                Ok(
                    json!({ "typed": target, "url": webview.url().map_err(|error| error.to_string())? }),
                )
            }
            "screenshot" => {
                let result = cdp(
                    &webview,
                    "Page.captureScreenshot",
                    json!({ "format": "png", "fromSurface": true }),
                    deadline,
                )?;
                let data = result
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|data| data.len() <= 16 * 1024 * 1024)
                    .ok_or_else(|| "Browser screenshot is unavailable or too large".to_string())?;
                Ok(
                    json!({ "image": { "mime": "image/png", "data": data }, "url": webview.url().map_err(|error| error.to_string())? }),
                )
            }
            _ => Err("Invalid browser command".to_string()),
        }
    }

    #[cfg(windows)]
    fn open(
        &self,
        app: &AppHandle,
        session_id: &str,
        raw_url: &str,
        deadline: Instant,
    ) -> Result<Value, String> {
        let url = allowed_url(raw_url)?;
        match self.resolve(app, session_id) {
            Ok(registration) => {
                let webview = app
                    .get_webview(&registration.webview_label)
                    .ok_or_else(|| "Browser preview is no longer available".to_string())?;
                self.navigate_and_wait(&registration, &webview, &url, deadline)?;
                return Ok(json!({ "url": webview.url().map_err(|error| error.to_string())? }));
            }
            Err(error) if error == no_browser_target_error() => {}
            Err(error) => return Err(error),
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        {
            let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
            inner.open_claims.insert(
                request_id.clone(),
                OpenClaim {
                    session_id: session_id.to_string(),
                    url: raw_url.to_string(),
                    owner: None,
                    failed_owners: HashSet::new(),
                },
            );
        }
        let claim = OpenClaim {
            session_id: session_id.to_string(),
            url: raw_url.to_string(),
            owner: None,
            failed_owners: HashSet::new(),
        };
        Self::emit_open_request(app, &request_id, &claim);
        let result = (|| -> Result<Value, String> {
            let registration_deadline = deadline.min(Instant::now() + Duration::from_secs(10));
            let (inner, ready) = &*self.inner;
            let mut guard = inner.lock().map_err(|error| error.to_string())?;
            loop {
                drop(guard);
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

    fn emit_open_request(app: &AppHandle, request_id: &str, claim: &OpenClaim) {
        for record in app.state::<crate::local_windows::LocalWindows>().records() {
            if let Some(webview) = app.get_webview(&record.label) {
                let _ = webview.emit(
                    "browser-target:open",
                    json!({ "sessionID": claim.session_id, "url": claim.url, "requestID": request_id }),
                );
            }
        }
    }

    #[cfg(windows)]
    fn resolve(&self, app: &AppHandle, session_id: &str) -> Result<Registration, String> {
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

    pub(crate) fn navigation_allowed(&self, webview_label: &str, url: &tauri::Url) -> Option<bool> {
        if webview_label
            .strip_prefix("browser-")
            .is_some_and(|id| validate_id(id, 128).is_ok())
        {
            return Some(is_allowed_url(url));
        }
        self.inner.0.lock().ok().and_then(|inner| {
            inner
                .registrations
                .values()
                .any(|registration| registration.webview_label == webview_label)
                .then(|| is_allowed_url(url))
        })
    }

    #[cfg(windows)]
    fn snapshot(
        &self,
        registration: &Registration,
        webview: &tauri::Webview,
        deadline: Instant,
    ) -> Result<Value, String> {
        let navigation_version = self
            .inner
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .navigation_versions
            .get(&registration.registration_id)
            .copied();
        cdp(webview, "Accessibility.enable", json!({}), deadline)?;
        let result = cdp(webview, "Accessibility.getFullAXTree", json!({}), deadline)?;
        let mut refs = HashMap::new();
        let mut lines = Vec::new();
        let mut length = 0;
        for node in result
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if node.get("ignored").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(backend_id) = node.get("backendDOMNodeId").and_then(Value::as_i64) else {
                continue;
            };
            let role = ax_string(node.get("role"));
            let name = ax_string(node.get("name"));
            if role.is_empty()
                || (name.is_empty()
                    && ["generic", "none", "StaticText", "InlineTextBox"].contains(&role.as_str()))
            {
                continue;
            }
            let reference = format!("e{}", refs.len() + 1);
            refs.insert(reference.clone(), backend_id);
            let value = ax_string(node.get("value"));
            let states = node
                .get("properties")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|property| {
                    let key = property.get("name")?.as_str()?;
                    if !["checked", "disabled", "expanded", "focused", "selected"].contains(&key) {
                        return None;
                    }
                    Some(format!("{key}={}", property.pointer("/value/value")?))
                })
                .collect::<Vec<_>>();
            let line = format!(
                "[{reference}] {role}{}{}{}",
                (!name.is_empty())
                    .then(|| format!(" {name:?}"))
                    .unwrap_or_default(),
                (!value.is_empty())
                    .then(|| format!(" value={value:?}"))
                    .unwrap_or_default(),
                (!states.is_empty())
                    .then(|| format!(" {}", states.join(" ")))
                    .unwrap_or_default(),
            );
            if lines.len() >= 750 || length + line.len() > 64 * 1024 {
                break;
            }
            length += line.len() + 1;
            lines.push(line);
        }
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if inner
            .navigation_versions
            .get(&registration.registration_id)
            .copied()
            == navigation_version
        {
            inner
                .refs
                .insert(registration.registration_id.clone(), refs);
        }
        Ok(json!({
            "url": webview.url().map_err(|error| error.to_string())?,
            "snapshot": if lines.is_empty() { "No accessible elements found".to_string() } else { lines.join("\n") },
        }))
    }

    #[cfg(windows)]
    fn navigate_and_wait(
        &self,
        registration: &Registration,
        webview: &tauri::Webview,
        url: &tauri::Url,
        deadline: Instant,
    ) -> Result<(), String> {
        self.clear_refs(&registration.registration_id);
        let sequence = self.prepare_page_load(&registration.registration_id, url.as_str())?;
        let result = cdp(
            webview,
            "Page.navigate",
            json!({ "url": url.as_str() }),
            deadline,
        )?;
        if let Some(error) = result
            .get("errorText")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Err(format!("Browser navigation failed: {error}"));
        }
        self.wait_for_page_load(&registration.registration_id, sequence, deadline)
    }

    #[cfg(windows)]
    fn click(
        &self,
        registration: &Registration,
        webview: &tauri::Webview,
        target: &str,
        deadline: Instant,
    ) -> Result<(), String> {
        let (backend_node_id, navigation_version) = {
            let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
            let backend_node_id = inner
                .refs
                .get(&registration.registration_id)
                .and_then(|refs| refs.get(target))
                .copied()
                .ok_or_else(|| format!("Unknown browser ref {target}; take a new snapshot"))?;
            (
                backend_node_id,
                inner
                    .navigation_versions
                    .get(&registration.registration_id)
                    .copied(),
            )
        };
        cdp(
            webview,
            "DOM.scrollIntoViewIfNeeded",
            json!({ "backendNodeId": backend_node_id }),
            deadline,
        )?;
        let result = cdp(
            webview,
            "DOM.getBoxModel",
            json!({ "backendNodeId": backend_node_id }),
            deadline,
        )?;
        let box_model = result
            .pointer("/model/content")
            .and_then(Value::as_array)
            .filter(|values| values.len() == 8)
            .ok_or_else(|| format!("Browser ref {target} is not visible"))?;
        let x = [0, 2, 4, 6]
            .into_iter()
            .filter_map(|index| box_model[index].as_f64())
            .sum::<f64>()
            / 4.0;
        let y = [1, 3, 5, 7]
            .into_iter()
            .filter_map(|index| box_model[index].as_f64())
            .sum::<f64>()
            / 4.0;
        for (kind, extra) in [
            ("mouseMoved", json!({})),
            ("mousePressed", json!({ "button": "left", "clickCount": 1 })),
            (
                "mouseReleased",
                json!({ "button": "left", "clickCount": 1 }),
            ),
        ] {
            if self.page_navigation_version(&registration.registration_id) != navigation_version {
                return Err(format!("Unknown browser ref {target}; take a new snapshot"));
            }
            let mut params = json!({ "type": kind, "x": x, "y": y });
            params
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            cdp(webview, "Input.dispatchMouseEvent", params, deadline)?;
        }
        Ok(())
    }

    fn page_navigation_version(&self, registration_id: &str) -> Option<u64> {
        self.inner
            .0
            .lock()
            .ok()?
            .navigation_versions
            .get(registration_id)
            .copied()
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

    fn clear_refs(&self, registration_id: &str) {
        if let Ok(mut inner) = self.inner.0.lock() {
            inner.refs.remove(registration_id);
            if let Some(version) = inner.navigation_versions.get_mut(registration_id) {
                *version = version.wrapping_add(1);
            }
        }
    }

    fn clear_refs_for_generation(&self, registration_id: &str, generation: u64) {
        if let Ok(mut inner) = self.inner.0.lock() {
            if inner
                .registrations
                .get(registration_id)
                .map(|item| item.generation)
                != Some(generation)
            {
                return;
            }
            inner.refs.remove(registration_id);
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
                    if expectation.url == url && expectation.navigation_id.is_none() {
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
                if expectation.navigation_id == Some(navigation_id) {
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

fn validate_bounds(bounds: BrowserTargetBounds) -> Result<(), String> {
    if bounds.width == 0 || bounds.height == 0 || bounds.width > 16_384 || bounds.height > 16_384 {
        return Err("Invalid browser target bounds".to_string());
    }
    Ok(())
}

fn allowed_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw).map_err(|_| navigation_error())?;
    is_allowed_url(&url)
        .then_some(url)
        .ok_or_else(navigation_error)
}

fn is_allowed_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn navigation_error() -> String {
    "Browser navigation requires a credential-free HTTP(S) URL".to_string()
}

fn no_browser_target_error() -> String {
    "No visible local browser target for this session".to_string()
}

#[cfg(not(windows))]
fn unsupported() -> String {
    "Native browser control is only supported by the Tauri Windows runtime".to_string()
}

#[cfg(windows)]
fn command_url(command: &Value) -> Result<&str, String> {
    command
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Browser navigation URL is required".to_string())
}

#[cfg(windows)]
fn command_ref(command: &Value) -> Result<&str, String> {
    command
        .get("ref")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 32)
        .ok_or_else(|| "Browser ref is required".to_string())
}

#[cfg(windows)]
fn ax_string(value: Option<&Value>) -> String {
    value
        .and_then(|value| value.get("value"))
        .and_then(Value::as_str)
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
        .chars()
        .take(500)
        .collect()
}

#[cfg(windows)]
fn select_all_key_events() -> [Value; 4] {
    [
        json!({ "type": "rawKeyDown", "key": "Control", "code": "ControlLeft", "modifiers": 2, "windowsVirtualKeyCode": 17 }),
        json!({ "type": "rawKeyDown", "key": "a", "code": "KeyA", "modifiers": 2, "windowsVirtualKeyCode": 65, "commands": ["selectAll"] }),
        json!({ "type": "keyUp", "key": "a", "code": "KeyA", "modifiers": 2, "windowsVirtualKeyCode": 65 }),
        json!({ "type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17 }),
    ]
}

#[cfg(windows)]
fn clear_focused_field(webview: &tauri::Webview, deadline: Instant) -> Result<(), String> {
    for params in select_all_key_events() {
        cdp(webview, "Input.dispatchKeyEvent", params, deadline)?;
    }
    Ok(())
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
        CoTaskMemPWSTR, Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY,
        NavigationCompletedEventHandler, NavigationStartingEventHandler,
        PermissionRequestedEventHandler, SourceChangedEventHandler,
    };

    let app = webview.app_handle().clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let core = unsafe { platform.controller().CoreWebView2() }?;
                let permission = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)? };
                    }
                    Ok(())
                }));
                let mut permission_token = 0;
                unsafe { core.add_PermissionRequested(&permission, &mut permission_token)? };

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
                let completed =
                    NavigationCompletedEventHandler::create(Box::new(move |_, args| {
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
                    controller.clear_refs_for_generation(&registration_id, generation);
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
fn cdp(
    webview: &tauri::Webview,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, String> {
    use std::sync::mpsc;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

    let (sender, receiver) = mpsc::sync_channel(1);
    let method = method.to_string();
    let params = params.to_string();
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
            if let Err(error) = unsafe {
                core.CallDevToolsProtocolMethod(
                    *method.as_ref().as_pcwstr(),
                    *params.as_ref().as_pcwstr(),
                    &handler,
                )
            } {
                let _ = sender.send(Err(error.to_string()));
            }
        })
        .map_err(|error| error.to_string())?;
    let timeout = deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_secs(20));
    if timeout.is_zero() {
        return Err("Native request expired before execution".to_string());
    }
    let result = receiver
        .recv_timeout(timeout)
        .map_err(|_| "WebView2 browser command timed out".to_string())??;
    serde_json::from_str(&result).map_err(|error| format!("Invalid WebView2 response: {error}"))
}

#[cfg(test)]
mod tests {
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

    #[cfg(windows)]
    #[test]
    fn clear_shortcut_uses_chromium_editing_command_and_virtual_keys() {
        let events = select_all_key_events();
        assert_eq!(events[0]["type"], "rawKeyDown");
        assert_eq!(events[0]["windowsVirtualKeyCode"], 17);
        assert_eq!(events[1]["type"], "rawKeyDown");
        assert_eq!(events[1]["windowsVirtualKeyCode"], 65);
        assert_eq!(events[1]["commands"], json!(["selectAll"]));
    }
}
