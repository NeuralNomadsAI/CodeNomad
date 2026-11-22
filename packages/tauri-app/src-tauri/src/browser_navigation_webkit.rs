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
        let location = controller.clone();
        let location_registration = registration.clone();
        native.inner().connect_uri_notify(move |view| {
            if let Some(url) = view.uri() {
                location.retire_queued_open(
                    &location_registration.registration_id,
                    location_registration.generation,
                    &url,
                );
            }
        });
        let token = Rc::new(Cell::new(0u64));
        let started_token = token.clone();
        let started = controller.clone();
        let expected = registration.clone();
        native
            .inner()
            .connect_load_changed(move |view, event| match event {
                webkit2gtk::LoadEvent::Started => {
                    started_token.set(started_token.get().wrapping_add(1));
                    started.mark_page_started(
                        &expected.registration_id,
                        expected.generation,
                        started_token.get(),
                        view.uri()
                            .map_or_else(|| "about:blank".into(), |url| url.to_string()),
                    );
                }
                webkit2gtk::LoadEvent::Committed => {
                    if let Some(url) = view.uri() {
                        started.mark_page_committed(
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
        pub(super) fn cn_stop_navigation(view: *mut c_void);
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
        if event == 0 || event == 3 || event == 4 {
            if !url.is_null() {
                let url = unsafe { CStr::from_ptr(url) }
                    .to_string_lossy()
                    .into_owned();
                if event == 0 {
                    observer.controller.mark_page_started(
                        &registration.registration_id,
                        registration.generation,
                        token,
                        url,
                    );
                } else if event == 3 {
                    observer.controller.mark_page_committed(
                        &registration.registration_id,
                        registration.generation,
                        token,
                        url,
                    );
                } else {
                    observer.controller.retire_queued_open(
                        &registration.registration_id,
                        registration.generation,
                        &url,
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

#[cfg(target_os = "macos")]
pub(super) fn navigate_native(view: *mut std::ffi::c_void, url: &str) -> Result<u64, String> {
    let url = std::ffi::CString::new(url).map_err(|error| error.to_string())?;
    let token = unsafe { macos::cn_navigate(view, url.as_ptr()) };
    if token == 0 {
        Err("Native browser navigation was refused".into())
    } else {
        Ok(token)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn stop_native(view: *mut std::ffi::c_void) {
    unsafe { macos::cn_stop_navigation(view) }
}
