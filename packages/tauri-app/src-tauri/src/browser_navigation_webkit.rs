//! Native load completion/failure for the private backend browser channel.
use super::*;
use std::sync::mpsc;

#[cfg(target_os = "linux")]
pub(super) fn install(
    view: &tauri::Webview,
    controller: BrowserController,
    registration: Registration,
) -> Result<(), String> {
    use std::cell::Cell;
    use std::rc::Rc;
    use webkit2gtk::WebViewExt;
    let (sender, receiver) = mpsc::sync_channel(1);
    view.with_webview(move |native| {
        let token = Rc::new(Cell::new(0u64));
        let started_token = token.clone();
        let started = controller.clone();
        let expected = registration.clone();
        native
            .inner()
            .connect_load_changed(move |view, event| match event {
                webkit2gtk::LoadEvent::Started => {
                    started_token.set(started_token.get().wrapping_add(1));
                    if let Some(url) = view.uri().filter(|url| url.as_str() != "about:blank") {
                        started.mark_page_started(
                            &expected.registration_id,
                            expected.generation,
                            started_token.get(),
                            url.to_string(),
                        );
                    }
                }
                webkit2gtk::LoadEvent::Finished => started.mark_page_finished(
                    &expected.registration_id,
                    expected.generation,
                    started_token.get(),
                    None,
                ),
                _ => {}
            });
        native.inner().connect_load_failed(move |_, _, _, error| {
            controller.mark_page_finished(
                &registration.registration_id,
                registration.generation,
                token.get(),
                Some(format!("Browser navigation failed: {error}")),
            );
            false
        });
        let _ = sender.send(());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out configuring native navigation".to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_char, c_void, CStr};
    struct Observer {
        controller: BrowserController,
        registration: Registration,
    }
    extern "C" {
        fn cn_observe_load(
            view: *mut c_void,
            callback: unsafe extern "C" fn(*mut c_void, u64, i32, *const c_char, *const c_char),
            release: unsafe extern "C" fn(*mut c_void),
            context: *mut c_void,
        ) -> i32;
        pub(super) fn cn_navigate(view: *mut c_void, url: *const c_char) -> u64;
    }
    unsafe extern "C" fn released(context: *mut c_void) {
        drop(unsafe { Box::from_raw(context.cast::<Observer>()) });
    }
    unsafe extern "C" fn changed(
        context: *mut c_void,
        token: u64,
        event: i32,
        url: *const c_char,
        error: *const c_char,
    ) {
        let observer = unsafe { &*context.cast::<Observer>() };
        let registration = &observer.registration;
        if event == 0 {
            if !url.is_null() {
                let url = unsafe { CStr::from_ptr(url) }
                    .to_string_lossy()
                    .into_owned();
                if url != "about:blank" {
                    observer.controller.mark_page_started(
                        &registration.registration_id,
                        registration.generation,
                        token,
                        url,
                    );
                }
            }
        } else {
            let failure = (event == 2).then(|| {
                if error.is_null() {
                    "Browser navigation failed".into()
                } else {
                    format!(
                        "Browser navigation failed: {}",
                        unsafe { CStr::from_ptr(error) }.to_string_lossy()
                    )
                }
            });
            observer.controller.mark_page_finished(
                &registration.registration_id,
                registration.generation,
                token,
                failure,
            );
        }
    }
    pub(crate) fn install(
        view: &tauri::Webview,
        controller: BrowserController,
        registration: Registration,
    ) -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        view.with_webview(move |native| {
            let context = Box::into_raw(Box::new(Observer {
                controller,
                registration,
            }))
            .cast::<c_void>();
            let ok = unsafe { cn_observe_load(native.inner(), changed, released, context) };
            if ok == 0 {
                unsafe { released(context) };
            }
            let _ = sender.send(if ok == 0 {
                Err("Native navigation delegate is unavailable".to_string())
            } else {
                Ok(())
            });
        })
        .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Timed out configuring native navigation".to_string())?
    }
}
#[cfg(target_os = "macos")]
pub(super) use macos::install;

impl BrowserController {
    pub(super) fn navigate_and_wait(
        &self,
        app: &AppHandle,
        registration: &Registration,
        view: &tauri::Webview,
        url: &tauri::Url,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<(), String> {
        self.check_target_identity(app, registration, deadline, fence)?;
        let previous = view.url().map_err(|error| error.to_string())?;
        let mut previous_base = previous.clone();
        previous_base.set_fragment(None);
        let mut target_base = url.clone();
        target_base.set_fragment(None);
        let fragment_only = previous != *url && previous_base == target_base;
        self.invalidate_page(&registration.registration_id);
        let sequence = self.prepare_page_load(&registration.registration_id, url.as_str())?;
        let expected = registration.clone();
        let controller = self.clone();
        let app = app.clone();
        let queued_fence = fence.clone();
        let target = url.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        view.with_webview(move |native| {
            let result: Result<(), String> = (|| {
                controller.check_target_identity(&app, &expected, deadline, &queued_fence)?;
                if controller.page_load_expectation(&expected.registration_id, target.as_str())?
                    != Some(sequence)
                {
                    return Err("Browser preview navigation is no longer current".into());
                }
                #[cfg(target_os = "linux")]
                {
                    use webkit2gtk::WebViewExt;
                    native.inner().load_uri(target.as_str());
                }
                #[cfg(target_os = "macos")]
                {
                    let target = std::ffi::CString::new(target.as_str())
                        .map_err(|error| error.to_string())?;
                    let token = unsafe { macos::cn_navigate(native.inner(), target.as_ptr()) };
                    if token == 0 {
                        return Err("Native browser navigation was refused".into());
                    }
                    let mut inner = controller
                        .inner
                        .0
                        .lock()
                        .map_err(|error| error.to_string())?;
                    let expectation = inner
                        .page_load_expectations
                        .get_mut(&expected.registration_id)
                        .filter(|entry| entry.sequence == sequence)
                        .ok_or("Browser preview navigation is no longer current")?;
                    // WKWebView can return a navigation object for a fragment
                    // change without issuing document completion callbacks.
                    if !fragment_only {
                        expectation.navigation_id = Some(token);
                    }
                }
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "Timed out dispatching native navigation".to_string())??;
        if fragment_only {
            loop {
                self.check_target(view.app_handle(), registration, deadline, fence)?;
                let current = view.url().map_err(|error| error.to_string())?;
                if current == *url {
                    self.complete_same_document_navigation(
                        registration,
                        sequence,
                        current.as_str(),
                    )?;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        self.wait_for_page_load(&registration.registration_id, sequence, deadline)?;
        self.check_target(view.app_handle(), registration, deadline, fence)
    }
}
