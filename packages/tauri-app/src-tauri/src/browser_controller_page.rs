//! Private backend-only protocol adapter. Never register these methods as Tauri commands.
use super::*;
#[path = "browser_page_operation.rs"]
pub(crate) mod operations;
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
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub(super) held: crate::embedded_view::input::Held,
}

impl BrowserController {
    pub(super) fn page_generation(&self, registration: &Registration, navigation: u64) -> String {
        format!(
            "{}:{}:{}:{navigation}",
            self.run_id, registration.generation, registration.visibility_version
        )
    }

    #[cfg(test)]
    pub(super) fn reserve_page(
        &self,
        registration: Registration,
        operation_id: &str,
    ) -> Result<PageLease, String> {
        self.reserve_page_for(registration, operation_id, None)
    }

    pub(super) fn reserve_page_for(
        &self,
        registration: Registration,
        operation_id: &str,
        document: Option<u64>,
    ) -> Result<PageLease, String> {
        if uuid::Uuid::parse_str(operation_id).is_err() || operation_id.len() != 36 {
            return Err("Invalid browser page identity".into());
        }
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        if inner.registrations.get(&registration.registration_id) != Some(&registration)
            || !registration.visible
        {
            return Err(if document.is_some() {
                STALE_TARGET
            } else {
                "Browser page lease is no longer current"
            }
            .into());
        }
        let navigation = inner
            .navigation_versions
            .get(&registration.registration_id)
            .copied()
            .ok_or("Browser page document is unavailable")?;
        if document.is_some_and(|document| document != navigation) {
            return Err(STALE_TARGET.into());
        }
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
        let lease = PageLease {
            session_id: registration.session_id.clone(),
            operation_id: operation_id.into(),
            generation: self.page_generation(&registration, navigation),
            registration,
            expires: Instant::now() + Duration::from_secs(30),
            document: None,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
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
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            self.webkit_cleanup(app, session_id, operation_id, deadline, fence);
            #[cfg(any(windows, target_os = "macos"))]
            let label = self
                .inner
                .0
                .lock()
                .ok()
                .and_then(|mut inner| inner.file_picker_intercepts.remove(operation_id));
            self.end_page(session_id, operation_id);
            #[cfg(target_os = "macos")]
            if let Some(label) = &label {
                refuse_file_panels(app, label, false);
            }
            #[cfg(windows)]
            if let Some(webview) = label.and_then(|label| app.get_webview(&label)) {
                let _ = cdp(
                    &webview,
                    "Page.setInterceptFileChooserDialog",
                    json!({ "enabled": false }),
                    deadline,
                );
            }
            return Ok(json!({}));
        }
        let begin = method == "browser.page.begin";
        let (lease, token) = if begin {
            let witness = read_witness(input.get("target"))?;
            let (registration, document, token) = self.resolve_witness(app, session_id, witness)?;
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            self.webkit_expire(app, deadline, fence);
            (self.reserve_page_for(registration, operation_id, Some(document))?, token)
        } else {
            (self.page_lease(input)?, "")
        };
        #[cfg(windows)]
        let _ = token;
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
                compare_webkit_document(&response, token)?;
                self.check_page_state(&lease, deadline)?;
                let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
                let current = inner.page_leases.get_mut(operation_id)
                    .filter(|current| current.generation == lease.generation && current.expires == lease.expires)
                    .ok_or(STALE_TARGET)?;
                lease.generation = format!(
                    "{}:{}:{}:{}",
                    self.run_id, lease.registration.generation, lease.registration.visibility_version, token
                );
                lease.document = Some(token.into());
                *current = lease.clone();
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
            let response = if let Some(operations::Operation::Diagnostics { after }) = &operation {
                self.diagnostics.read(
                    &lease.registration.registration_id,
                    lease.registration.generation,
                    *after,
                )?
            } else if let Some((command, mut params)) = command {
                let webview = app
                    .get_webview(&lease.registration.webview_label)
                    .ok_or("Browser preview is no longer available")?;
                let controller = self.clone();
                let guard_lease = lease.clone();
                let guard_app = app.clone();
                let guard_fence = fence.clone();
                let guard = move || {
                    controller
                        .check_page(&guard_app, &guard_lease, deadline, &guard_fence)
                        .map(|_| ())
                };
                if matches!(&operation, Some(operations::Operation::HitTest { .. })) {
                    let metrics = cdp_guarded_in(
                        &webview,
                        None,
                        "Page.getLayoutMetrics",
                        json!({}),
                        deadline.min(lease.expires),
                        guard.clone(),
                        4 * 1024 * 1024,
                    )?;
                    operations::document_point(&mut params, &metrics);
                }
                cdp_guarded_in(
                    &webview,
                    operation.as_ref().and_then(operations::Operation::session),
                    command,
                    params,
                    deadline.min(lease.expires),
                    guard,
                    4 * 1024 * 1024,
                )?
            } else {
                json!({})
            };
            // Agent page operations never open a native file picker on the person's screen.
            #[cfg(windows)]
            if begin {
                if let Some(webview) = app.get_webview(&lease.registration.webview_label) {
                    let intercept = |params| {
                        cdp(&webview, "Page.setInterceptFileChooserDialog", params, deadline.min(lease.expires))
                    };
                    if let Ok(mut inner) = self.inner.0.lock() {
                        inner.file_picker_intercepts.insert(
                            operation_id.to_string(),
                            lease.registration.webview_label.clone(),
                        );
                    }
                    if intercept(json!({ "enabled": true, "cancel": true })).is_err() {
                        intercept(json!({ "enabled": true }))?;
                    }
                }
            }
            #[cfg(target_os = "macos")]
            if begin {
                if let Ok(mut inner) = self.inner.0.lock() {
                    inner.file_picker_intercepts.insert(
                        operation_id.to_string(),
                        lease.registration.webview_label.clone(),
                    );
                }
                refuse_file_panels(app, &lease.registration.webview_label, true);
            }
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if matches!(
                &operation,
                Some(
                    operations::Operation::Diagnostics { .. }
                        | operations::Operation::ResponseBody { .. }
                )
            ) {
                return Err("Browser diagnostics are unavailable in WebKit previews".into());
            }
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
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if std::env::var_os("CN_INPUT_TRACE").is_some() {
                eprintln!(
                    "native page {method} op={} function={}: {}",
                    input["operation"]["op"],
                    input["operation"]["function"],
                    result.as_ref().unwrap_err()
                );
            }
            #[cfg(windows)]
            {
                self.release_page(&lease);
                // The person's own file pickers return now, not only at the operation's end.
                if let Ok(mut inner) = self.inner.0.lock() {
                    inner.file_picker_intercepts.remove(operation_id);
                }
                if let Some(webview) = app.get_webview(&lease.registration.webview_label) {
                    let _ = cdp(
                        &webview,
                        "Page.setInterceptFileChooserDialog",
                        json!({ "enabled": false }),
                        Instant::now() + Duration::from_secs(2),
                    );
                }
            }
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if lease.held.lock().is_ok_and(|held| held.is_empty()) {
                self.release_page(&lease);
            }
            // The person's own file panels return now, not only at the operation's end.
            #[cfg(target_os = "macos")]
            {
                if let Ok(mut inner) = self.inner.0.lock() {
                    inner.file_picker_intercepts.remove(operation_id);
                }
                refuse_file_panels(app, &lease.registration.webview_label, false);
            }
        }
        result
    }
}

/// Each session's snapshot refs (`b<n>e<k>`), at most 128 sessions; a session's operations queue
/// behind its table.
#[derive(Default)]
pub(crate) struct Refs {
    tables: Vec<(String, Arc<Mutex<crate::automation::refs::RefTable>>)>,
    sequence: u64,
}

impl Refs {
    fn table(&mut self, session: &str) -> Arc<Mutex<crate::automation::refs::RefTable>> {
        let table = match self.tables.iter().position(|(s, _)| s == session) {
            Some(index) => self.tables.remove(index).1,
            None => {
                self.sequence += 1;
                let prefix = format!("b{}e", self.sequence);
                Arc::new(Mutex::new(crate::automation::refs::RefTable::new(
                    "take a new snapshot",
                    prefix,
                )))
            }
        };
        self.tables.push((session.to_string(), table.clone()));
        if self.tables.len() > 128 {
            self.tables.remove(0);
        }
        table
    }
}

impl BrowserController {
    /// `BrowserPage`: a snapshot or page action on the session's visible preview through the in-host
    /// engine, inside one exact page lease (`browser.page.*`), ended even after a failure.
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    pub(super) fn page_action(
        &self,
        app: &AppHandle,
        session_id: &str,
        command: &Value,
        target: &str,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let deadline = deadline.min(Instant::now() + Duration::from_secs(25));
        let table = self
            .page_refs
            .lock()
            .map_err(|error| error.to_string())?
            .table(session_id);
        let mut refs = table.lock().map_err(|error| error.to_string())?;
        let base =
            json!({ "sessionID": session_id, "operationID": uuid::Uuid::new_v4().to_string() });
        let with = |extra: Value| {
            let mut input = base.clone();
            input
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().cloned().unwrap_or_default());
            input
        };
        let outcome = (|| {
            let begin = self.page_request(
                app,
                "browser.page.begin",
                &with(json!({ "target": target })),
                deadline,
                fence,
            )?;
            let generation = begin["generation"]
                .as_str()
                .filter(|g| !g.is_empty() && g.len() <= 512)
                .ok_or("Invalid native browser target")?
                .to_string();
            let url = std::cell::RefCell::new(
                begin["url"]
                    .as_str()
                    .ok_or("Invalid native browser target")?
                    .to_string(),
            );
            let checkpoint = || -> Result<(), String> {
                let checked = self.page_request(
                    app,
                    "browser.page.check",
                    &with(json!({ "generation": generation })),
                    deadline,
                    fence,
                )?;
                *url.borrow_mut() = checked["url"]
                    .as_str()
                    .ok_or("Invalid native browser target")?
                    .to_string();
                Ok(())
            };
            let send = |operation: Value| {
                self.page_request(
                    app,
                    "browser.page.send",
                    &with(json!({ "generation": generation, "operation": operation })),
                    deadline,
                    fence,
                )
            };
            let driver = if cfg!(windows) { "cdp" } else { "webkit" };
            let session = crate::automation::page::Session {
                driver,
                send: &send,
                checkpoint: &checkpoint,
                mark: false,
                guard: None,
            };
            let mut result = if command["action"] == "snapshot" {
                crate::automation::page::snapshot(&session, &mut refs, &generation, command, false)
                    .map(|(snapshot, collapsed)| json!({ "snapshot": snapshot, "collapsed": collapsed }))
            } else {
                let refs = &*refs;
                crate::automation::page::act(&session, command, &|r| refs.resolve(r, &generation))
            }
            .map_err(|fail| fail.message)?;
            result["url"] = json!(url.borrow().clone());
            Ok(result)
        })();
        // Exact and best effort, independent of the outcome; the lease also expires by itself.
        let _ = self.page_request(
            app,
            "browser.page.end",
            &base,
            Instant::now() + Duration::from_secs(5),
            fence,
        );
        outcome
    }
}

/// Agent page operations never open a native file panel on the person's screen: the vendored Wry cancels the
/// panels this preview's page opens while the operation holds its lease.
#[cfg(target_os = "macos")]
fn refuse_file_panels(app: &AppHandle, label: &str, refused: bool) {
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.with_webview(move |native| wry::set_file_panels_refused(native.inner(), refused));
    }
}
