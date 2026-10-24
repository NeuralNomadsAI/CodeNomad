//! Private backend-only protocol adapter. Never register these methods as Tauri commands.
use super::*;

#[derive(Clone)]
pub(super) struct PageLease {
    pub(super) registration: Registration,
    session_id: String,
    operation_id: String,
    pub(super) generation: String,
    pub(super) expires: Instant,
}

fn page_method_allowed(method: &str) -> bool {
    matches!(
        method,
        "Accessibility.getFullAXTree"
            | "DOM.resolveNode"
            | "DOM.scrollIntoViewIfNeeded"
            | "DOM.getContentQuads"
            | "DOM.getNodeForLocation"
            | "Page.getLayoutMetrics"
            | "Runtime.callFunctionOn"
            | "Runtime.evaluate"
            | "Runtime.releaseObjectGroup"
            | "Input.insertText"
            | "Input.dispatchMouseEvent"
            | "Input.dispatchKeyEvent"
    )
}

fn page_params(method: &str, params: Value) -> Result<Value, String> {
    if !page_method_allowed(method) {
        return Err("Unsupported browser page command".into());
    }
    if !params.is_object() || params.to_string().len() > 256 * 1024 {
        return Err("Invalid or oversized browser page parameters".into());
    }
    Ok(params)
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
            || !inner
                .navigation_versions
                .get(&lease.registration.registration_id)
                .is_some_and(|navigation| {
                    self.page_generation(&lease.registration, *navigation) == lease.generation
                })
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

    #[cfg(windows)]
    fn check_page(
        &self,
        app: &AppHandle,
        lease: &PageLease,
        deadline: Instant,
    ) -> Result<tauri::Url, String> {
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
        Ok(url)
    }

    #[cfg(windows)]
    pub(super) fn page_request(
        &self,
        app: &AppHandle,
        method: &str,
        input: &Value,
        deadline: Instant,
    ) -> Result<Value, String> {
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
            self.end_page(session_id, operation_id);
            return Ok(json!({}));
        }
        let begin = method == "browser.page.begin";
        let lease = if begin {
            self.reserve_page(self.resolve(app, session_id)?, operation_id)?
        } else {
            self.page_lease(input)?
        };
        let result = (|| {
            let url = self.check_page(app, &lease, deadline)?;
            if method == "browser.page.check" {
                return Ok(json!({ "url": url }));
            }
            let command = if begin {
                "Accessibility.enable"
            } else {
                input["method"]
                    .as_str()
                    .ok_or("Invalid browser page command")?
            };
            let params = if begin {
                json!({})
            } else {
                page_params(command, input.get("params").cloned().unwrap_or(json!({})))?
            };
            let webview = app
                .get_webview(&lease.registration.webview_label)
                .ok_or("Browser preview is no longer available")?;
            let controller = self.clone();
            let guard_lease = lease.clone();
            let guard_app = app.clone();
            let response = cdp_guarded(
                &webview,
                command,
                params,
                deadline.min(lease.expires),
                move || {
                    controller
                        .check_page(&guard_app, &guard_lease, deadline)
                        .map(|_| ())
                },
                4 * 1024 * 1024,
            )?;
            let url = self.check_page(app, &lease, deadline)?;
            if begin {
                Ok(json!({ "generation": lease.generation, "url": url }))
            } else {
                Ok(response)
            }
        })();
        if result.is_err() {
            self.release_page(&lease);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_allowlist_and_parameter_budget_are_fixed() {
        for method in [
            "Page.navigate",
            "Network.enable",
            "Browser.close",
            "DOM.getBoxModel",
            "Accessibility.enable",
        ] {
            assert!(page_params(method, json!({})).is_err());
        }
        assert!(page_params("Input.insertText", json!({ "text": "x" })).is_ok());
        assert!(page_params(
            "Runtime.evaluate",
            json!({ "expression": "x".repeat(256 * 1024) })
        )
        .is_err());
        assert!(page_params("Runtime.evaluate", Value::Null).is_err());
    }
}
