//! Private backend-only protocol adapter. Never register these methods as Tauri commands.
use super::*;
#[path = "browser_page_operation.rs"]
mod operations;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "browser_page_webkit.rs"]
mod webkit;

#[derive(Clone)]
pub(super) struct PageLease {
    pub(super) registration: Registration,
    session_id: String,
    operation_id: String,
    pub(super) generation: String,
    pub(super) expires: Instant,
    pub(super) document: Option<String>,
    #[cfg(any(target_os="linux",target_os="macos"))]
    pub(super) held: crate::embedded_view::input::Held,
}

impl BrowserController {
    fn page_generation(&self, registration: &Registration, navigation: u64) -> String {
        format!("{}:{}:{navigation}", self.run_id, registration.generation)
    }

    pub(super) fn reserve_page(
        &self,
        registration: Registration,
        operation_id: &str,
    ) -> Result<PageLease, String> {
        if uuid::Uuid::parse_str(operation_id).is_err() || operation_id.len() != 36 {
            return Err("Invalid browser page identity".into());
        }
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        inner
            .page_leases
            .retain(|_, lease| lease.expires > Instant::now());
        if inner.page_leases.contains_key(operation_id) {
            return Err("Browser page operation already exists".into());
        }
        if inner
            .page_leases
            .values()
            .any(|lease| lease.registration.webview_label == registration.webview_label)
        {
            return Err("Browser page target is busy".into());
        }
        if inner.page_leases.len() >= 32 {
            return Err("Too many browser page operations".into());
        }
        if inner.registrations.get(&registration.registration_id) != Some(&registration)
            || !registration.visible
        {
            return Err("Browser page lease is no longer current".into());
        }
        let navigation = inner
            .navigation_versions
            .get(&registration.registration_id)
            .copied()
            .ok_or("Browser page document is unavailable")?;
        let lease = PageLease {
            session_id: registration.session_id.clone(),
            operation_id: operation_id.into(),
            generation: self.page_generation(&registration, navigation),
            registration,
            expires: Instant::now() + Duration::from_secs(30),
            document: None,
            #[cfg(any(target_os="linux",target_os="macos"))]
            held: Default::default(),
        };
        inner.page_leases.insert(operation_id.into(), lease.clone());
        Ok(lease)
    }

    pub(super) fn page_lease(&self, input: &Value) -> Result<PageLease, String> {
        let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        let lease = input["operationID"]
            .as_str()
            .and_then(|id| inner.page_leases.get(id))
            .filter(|lease| {
                Some(lease.session_id.as_str()) == input["sessionID"].as_str()
                    && Some(lease.generation.as_str()) == input["generation"].as_str()
            })
            .ok_or("Browser page lease is no longer current")?;
        Ok(lease.clone())
    }

    pub(super) fn check_page_state(
        &self,
        lease: &PageLease,
        deadline: Instant,
    ) -> Result<(), String> {
        if Instant::now() >= deadline.min(lease.expires) {
            return Err("Native request expired before execution".into());
        }
        let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if !inner
            .page_leases
            .get(&lease.operation_id)
            .is_some_and(|current| {
                current.generation == lease.generation
                    && current.expires == lease.expires
                    && current.session_id == lease.session_id
            })
            || inner.registrations.get(&lease.registration.registration_id)
                != Some(&lease.registration)
            || (lease.document.is_none()
                && !inner
                    .navigation_versions
                    .get(&lease.registration.registration_id)
                    .is_some_and(|navigation| {
                        self.page_generation(&lease.registration, *navigation) == lease.generation
                    }))
        {
            return Err("Browser page lease is no longer current".into());
        }
        Ok(())
    }

    pub(super) fn finish_page(
        &self,
        lease: &PageLease,
        deadline: Instant,
        read_url: impl FnOnce() -> Result<tauri::Url, String>,
    ) -> Result<tauri::Url, String> {
        // UI getters may process navigation callbacks that acquire inner.
        let url = read_url()?;
        self.check_page_state(lease, deadline)?;
        if !is_allowed_url(&url) {
            return Err(navigation_error());
        }
        Ok(url)
    }

    pub(super) fn end_page(&self, session_id: &str, operation_id: &str) {
        if let Ok(mut inner) = self.inner.0.lock() {
            if inner
                .page_leases
                .get(operation_id)
                .is_some_and(|lease| lease.session_id == session_id)
            {
                inner.page_leases.remove(operation_id);
            }
        }
    }

    fn release_page(&self, lease: &PageLease) {
        if let Ok(mut inner) = self.inner.0.lock() {
            if inner
                .page_leases
                .get(&lease.operation_id)
                .is_some_and(|current| {
                    current.session_id == lease.session_id
                        && current.expires == lease.expires
                        && current.generation == lease.generation
                })
            {
                inner.page_leases.remove(&lease.operation_id);
            }
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn check_page(
        &self,
        app: &AppHandle,
        lease: &PageLease,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<tauri::Url, String> {
        fence.check()?;
        self.check_page_state(lease, deadline)?;
        if self.resolve(app, &lease.session_id)? != lease.registration {
            return Err("Browser page lease is no longer current".into());
        }
        let webview = app
            .get_webview(&lease.registration.webview_label)
            .ok_or("Browser preview is no longer available")?;
        let url = self.finish_page(lease, deadline, || {
            webview.url().map_err(|error| error.to_string())
        })?;
        if self.resolve(app, &lease.session_id)? != lease.registration {
            return Err("Browser page lease is no longer current".into());
        }
        self.check_page_state(lease, deadline)?;
        fence.check()?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(document) = &lease.document {
            let response =
                self.webkit_read(app, lease, &json!({"op":"checkpoint"}), deadline, fence)?;
            if response["document"].as_str() != Some(document.as_str()) {
                return Err("Browser page document changed; inspect again".into());
            }
        }
        Ok(url)
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    pub(super) fn page_request(
        &self,
        app: &AppHandle,
        method: &str,
        input: &Value,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        operations::envelope(method, input)?;
        let session_id = input["sessionID"]
            .as_str()
            .ok_or("Invalid browser page identity")?;
        let operation_id = input["operationID"]
            .as_str()
            .ok_or("Invalid browser page identity")?;
        validate_id(session_id, 256)?;
        if operation_id.len() != 36 || uuid::Uuid::parse_str(operation_id).is_err() {
            return Err("Invalid browser page identity".into());
        }
        if method == "browser.page.end" {
            #[cfg(any(target_os="linux",target_os="macos"))]
            self.webkit_cleanup(app, session_id, operation_id, deadline, fence);
            self.end_page(session_id, operation_id);
            return Ok(json!({}));
        }
        let begin = method == "browser.page.begin";
        #[cfg(any(target_os="linux",target_os="macos"))]
        if begin { self.webkit_expire(app, deadline, fence); }
        let lease = if begin {
            self.reserve_page(self.resolve(app, session_id)?, operation_id)?
        } else {
            self.page_lease(input)?
        };
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let mut lease = lease;
        let operation = if method == "browser.page.send" {
            Some(operations::parse(
                input
                    .get("operation")
                    .cloned()
                    .ok_or("Invalid browser page operation")?,
            )?)
        } else {
            None
        };
        let result = (|| {
            let url = self.check_page(app, &lease, deadline, fence)?;
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if begin {
                let response =
                    self.webkit_read(app, &lease, &json!({"op":"checkpoint"}), deadline, fence)?;
                let document = response["document"]
                    .as_str()
                    .ok_or("Missing WebKit document identity")?
                    .to_string();
                self.check_page_state(&lease, deadline)?;
                lease.generation = format!(
                    "{}:{}:{}",
                    self.run_id, lease.registration.generation, document
                );
                lease.document = Some(document);
                self.inner
                    .0
                    .lock()
                    .map_err(|error| error.to_string())?
                    .page_leases
                    .insert(operation_id.into(), lease.clone());
            }
            if method == "browser.page.check" {
                return Ok(json!({ "url": url }));
            }
            if !begin && method != "browser.page.send" {
                return Err("Invalid browser page method".into());
            }
            #[cfg(windows)]
            let command = if begin {
                Some(("Accessibility.enable", json!({})))
            } else {
                operation.as_ref().and_then(operations::Operation::cdp)
            };
            #[cfg(windows)]
            let response = if let Some((command, params)) = command {
                let webview = app
                    .get_webview(&lease.registration.webview_label)
                    .ok_or("Browser preview is no longer available")?;
                let controller = self.clone();
                let guard_lease = lease.clone();
                let guard_app = app.clone();
                let guard_fence = fence.clone();
                cdp_guarded(
                    &webview,
                    command,
                    params,
                    deadline.min(lease.expires),
                    move || {
                        controller
                            .check_page(&guard_app, &guard_lease, deadline, &guard_fence)
                            .map(|_| ())
                    },
                    4 * 1024 * 1024,
                )?
            } else {
                json!({})
            };
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            let response = if let Some(_) = &operation {
                let response =
                    self.webkit_read(app, &lease, &input["operation"], deadline, fence)?;
                if response["document"].as_str() != lease.document.as_deref() {
                    return Err("Browser page document changed; inspect again".into());
                }
                response["result"].clone()
            } else {
                json!({})
            };
            let url = self.check_page(app, &lease, deadline, fence)?;
            if begin {
                Ok(
                    json!({ "generation": lease.generation, "url": url, "driver": if cfg!(windows) {"cdp"} else {"webkit"}, "contractVersion":1 }),
                )
            } else {
                #[cfg(windows)]
                {
                    let operation = operation.as_ref().ok_or("Invalid browser page operation")?;
                    Ok(operation.result(response))
                }
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                {
                    Ok(response)
                }
            }
        })();
        if result.is_err() {
            #[cfg(windows)]
            self.release_page(&lease);
            #[cfg(any(target_os="linux",target_os="macos"))]
            if lease.held.lock().is_ok_and(|held|held.is_empty()) { self.release_page(&lease); }
        }
        result
    }
}
