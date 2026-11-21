use super::*;

impl BrowserController {
    /// Open supplies an occurrence guard; navigate supplies a document witness.
    /// Both own one dispatch, load receipt and deferred native stop.
    pub(super) fn navigate_and_wait(
        &self,
        registration: &Registration,
        view: &tauri::Webview,
        url: &tauri::Url,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
        witness: Option<(u64, &str)>,
        open_request_id: Option<&str>,
        check: impl Fn() -> Result<(), String> + Clone + Send + Sync + 'static,
    ) -> Result<String, String> {
        let controller = self.clone();
        let app = view.app_handle().clone();
        let expected = registration.clone();
        let fence = fence.clone();
        let document = witness.map(|(document, _)| document);
        let open_request_id = open_request_id.map(str::to_owned);
        let dispatch_request_id = open_request_id.clone();
        let check_open = move |inner: &Inner, expected: &Registration| match &open_request_id {
            Some(id) => super::open::check_open_target(inner, id, expected),
            None => Ok(()),
        };
        let dispatch_fence = fence.clone();
        let check = move || {
            fence.check()?;
            if Instant::now() >= deadline {
                return Err("Native browser command timed out".into());
            }
            check()?;
            if document.is_some() {
                controller.check_target_identity(&app, &expected, deadline, &fence)
            } else {
                controller.check_registration(&app, &expected)?;
                let inner = controller
                    .inner
                    .0
                    .lock()
                    .map_err(|error| error.to_string())?;
                check_open(&inner, &expected)
            }
        };
        check()?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let fragment_only = {
            let previous = view.url().map_err(|error| error.to_string())?;
            let mut previous_base = previous.clone();
            previous_base.set_fragment(None);
            let mut target_base = url.clone();
            target_base.set_fragment(None);
            previous != *url && previous_base == target_base
        };
        let controller = self.clone();
        let expected = registration.clone();
        let dispatch_check = check.clone();
        let target = url.to_string();
        let dispatched = Arc::new(Mutex::new(None));
        let receipt = dispatched.clone();
        let admit = move || -> Result<u64, String> {
            dispatch_check()?;
            let mut receipt = receipt.lock().map_err(|error| error.to_string())?;
            let sequence = controller.prepare_navigation(
                &expected,
                &target,
                document,
                dispatch_request_id.as_deref(),
                || {
                    dispatch_fence.check()?;
                    if Instant::now() >= deadline {
                        return Err("Native browser command timed out".into());
                    }
                    Ok(())
                },
            )?;
            *receipt = Some(sequence);
            Ok(sequence)
        };

        #[cfg(windows)]
        let dispatch = cdp_guarded_inner(
            view,
            "Page.navigate",
            json!({ "url": url.as_str() }),
            deadline,
            move || admit().map(|_| ()),
            24 * 1024 * 1024,
        )
        .and_then(|result| {
            if let Some(error) = result["errorText"]
                .as_str()
                .filter(|error| !error.is_empty())
            {
                return Err(format!("Browser navigation failed: {error}"));
            }
            Ok(result["loaderId"].as_str().is_none())
        })
        .map_err(|error| preview_error("CDP Page.navigate", error));
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let dispatch = {
            use crate::embedded_view::input::{self, DocumentDispatch, Read};
            let target = url.to_string();
            #[cfg(target_os = "macos")]
            let (controller, registration) = (self.clone(), registration.clone());
            input::read(
                view,
                Read::Guarded {
                    document: witness.map(|(_, token)| token.to_owned()),
                    dispatch: DocumentDispatch::Navigate(Box::new(move |native| {
                        let _sequence = admit()?;
                        #[cfg(target_os = "linux")]
                        {
                            use gtk::glib::translate::from_glib_borrow;
                            use webkit2gtk::WebViewExt;
                            let view: gtk::glib::translate::Borrowed<webkit2gtk::WebView> =
                                unsafe { from_glib_borrow(native.cast()) };
                            view.load_uri(&target);
                        }
                        #[cfg(target_os = "macos")]
                        {
                            let token = webkit_navigation::navigate_native(native, &target)?;
                            if !fragment_only {
                                controller.with_navigation_load(&registration, _sequence, |load| {
                                    load.navigation_id.get_or_insert(token);
                                });
                            }
                        }
                        Ok(Vec::new())
                    })),
                },
                deadline,
                check.clone(),
            )
            .map(|_| fragment_only)
        };
        let sequence = *dispatched.lock().map_err(|error| error.to_string())?;

        let result = dispatch.and_then(|same_document| {
            let sequence = sequence.ok_or("Missing native browser navigation sequence")?;
            self.wait_for_navigation_load(registration, sequence, deadline, || {
                check()?;
                if same_document {
                    let current = view.url().map_err(|error| error.to_string())?;
                    if current == *url {
                        self.complete_same_document_navigation(
                            registration,
                            sequence,
                            current.as_str(),
                        )?;
                    }
                }
                Ok(())
            })
            .and_then(|url| {
                check()?;
                Ok(url)
            })
        });
        if let (Err(_), Some(sequence)) = (&result, sequence) {
            let controller = self.clone();
            let expected = registration.clone();
            let _ = view.with_webview(move |native| {
                // Registration labels are unique; the sequence guard runs on
                // the UI thread immediately before touching that exact view.
                if !controller.take_navigation_stop(&expected, sequence) {
                    return;
                }
                #[cfg(windows)]
                if let Ok(core) = unsafe { native.controller().CoreWebView2() } {
                    let _ = unsafe { core.Stop() };
                }
                #[cfg(target_os = "linux")]
                {
                    use webkit2gtk::WebViewExt;
                    native.inner().stop_loading();
                }
                #[cfg(target_os = "macos")]
                webkit_navigation::stop_native(native.inner());
            });
        }
        result
    }

    pub(super) fn wait_for_navigation_load(
        &self,
        registration: &Registration,
        sequence: u64,
        deadline: Instant,
        check: impl Fn() -> Result<(), String>,
    ) -> Result<String, String> {
        let (inner, ready) = &*self.inner;
        loop {
            check()?;
            let guard = inner.lock().map_err(|error| error.to_string())?;
            let load = guard
                .page_load_expectations
                .get(&registration.registration_id)
                .filter(|load| load.sequence == sequence)
                .ok_or("Browser navigation changed")?;
            if let Some(result) = &load.result {
                result.clone()?;
                let url = load
                    .completed_url
                    .as_deref()
                    .ok_or("Browser document is unavailable")?;
                allowed_url(url)?;
                return Ok(url.to_owned());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out waiting for the browser page to load".into());
            }
            drop(
                ready
                    .wait_timeout(guard, remaining.min(Duration::from_millis(100)))
                    .map_err(|error| error.to_string())?,
            );
        }
    }

    fn with_navigation_load(
        &self,
        registration: &Registration,
        sequence: u64,
        update: impl FnOnce(&mut PageLoadExpectation),
    ) -> bool {
        let Ok(mut inner) = self.inner.0.lock() else {
            return false;
        };
        let id = &registration.registration_id;
        if !inner
            .registrations
            .get(id)
            .is_some_and(|current| current.generation == registration.generation)
        {
            return false;
        }
        let Some(load) = inner
            .page_load_expectations
            .get_mut(id)
            .filter(|load| load.sequence == sequence && load.result.is_none())
        else {
            return false;
        };
        update(load);
        true
    }

    pub(super) fn take_navigation_stop(&self, registration: &Registration, sequence: u64) -> bool {
        let mut stop = false;
        self.with_navigation_load(registration, sequence, |load| {
            stop = load.dispatched;
            load.result = Some(Err("Browser navigation cancelled".into()));
        });
        stop
    }
}
