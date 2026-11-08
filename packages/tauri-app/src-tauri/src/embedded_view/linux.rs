pub(super) fn request_close<R: tauri::Runtime>(view: &tauri::Webview<R>) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    view.with_webview(|native| native.inner().try_close())
        .map_err(|error| error.to_string())
}

pub(super) fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Manager;
    use webkit2gtk::{PermissionRequestExt, WebViewExt};

    let (sender, receiver) = mpsc::sync_channel(1);
    let view = webview.clone();
    let policy = webview
        .app_handle()
        .try_state::<super::EmbeddedViews>()
        .ok_or("Missing browser registry")?
        .inner()
        .clone();
    let token = policy
        .token(webview.label())
        .ok_or("Expired browser view")?;
    webview
        .with_webview(move |platform| {
            use std::{cell::Cell, rc::Rc};
            use tauri::Manager;
            let generation = Rc::new(Cell::new(0u64));
            let loading = generation.clone();
            platform.inner().connect_load_changed(move |_, event| {
                if event == webkit2gtk::LoadEvent::Started {
                    loading.set(loading.get().wrapping_add(1));
                }
            });
            let enter = view.clone();
            let enter_policy = policy.clone();
            platform.inner().connect_enter_fullscreen(move |_| {
                if !enter_policy.current(enter.label(), token) {
                    return true;
                }
                if let Some(views) = enter.app_handle().try_state::<super::EmbeddedViews>() {
                    let _ = views.set_fullscreen(enter.app_handle(), enter.label(), true);
                }
                false
            });
            let leave = view.clone();
            let leave_policy = policy.clone();
            platform.inner().connect_leave_fullscreen(move |_| {
                if !leave_policy.current(leave.label(), token) {
                    return false;
                }
                if let Some(views) = leave.app_handle().try_state::<super::EmbeddedViews>() {
                    let _ = views.set_fullscreen(leave.app_handle(), leave.label(), false);
                }
                false
            });
            platform
                .inner()
                .connect_permission_request(move |page, request| {
                    if !policy.current(view.label(), token) {
                        request.deny();
                        return true;
                    }
                    use gtk::glib::{Cast, ObjectExt};
                    use webkit2gtk::{
                        DeviceInfoPermissionRequest, GeolocationPermissionRequest,
                        NotificationPermissionRequest, PointerLockPermissionRequest,
                        UserMediaPermissionRequest, UserMediaPermissionRequestExt,
                        WebsiteDataAccessPermissionRequest, WebsiteDataAccessPermissionRequestExt,
                    };
                    if request.is::<GeolocationPermissionRequest>()
                        || request.is::<NotificationPermissionRequest>()
                        || request
                            .downcast_ref::<UserMediaPermissionRequest>()
                            .is_some_and(|media| {
                                media.is_for_audio_device() || media.is_for_video_device()
                            })
                        || request.is::<DeviceInfoPermissionRequest>()
                    {
                        request.deny();
                        return true;
                    }
                    // WebKit's pointer-lock API grants the WebView's pointer,
                    // not a frame resource. Its own MiniBrowser attributes this
                    // page-scoped request to the displayed WebView origin.
                    // https://github.com/WebKit/WebKit/blob/main/Tools/MiniBrowser/gtk/BrowserTab.c
                    let consent = if request.is::<PointerLockPermissionRequest>() {
                        page.uri()
                            .and_then(|uri| super::browser::page_permission_subject(&uri))
                            .map(|subject| ("pointer-lock", subject))
                    } else if let Some(storage) =
                        request.downcast_ref::<WebsiteDataAccessPermissionRequest>()
                    {
                        storage
                            .requesting_domain()
                            .zip(storage.current_domain())
                            .map(|(requester, current)| {
                                ("storage-access", format!("{requester} → {current}"))
                            })
                    } else {
                        None
                    };
                    if let Some((kind, subject)) = consent {
                        use tauri::Manager;
                        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                        let label = |key| {
                            view.app_handle()
                                .try_state::<crate::AppState>()
                                .map(|state| state.menu_labels.text(key))
                                .unwrap_or_else(|| crate::menu_labels::label(key).to_string())
                        };
                        let message = label("browserPermission")
                            .replace("{permission}", kind)
                            .replace("{origin}", &subject);
                        let request = request.clone();
                        let epoch = generation.clone();
                        let captured = epoch.get();
                        let weak_page = page.downgrade();
                        let answer_policy = policy.clone();
                        let answer_label = view.label().to_string();
                        let (reply, answer) =
                            gtk::glib::MainContext::channel::<bool>(gtk::glib::Priority::DEFAULT);
                        answer.attach(None, move |allowed| {
                            if allowed
                                && epoch.get() == captured
                                && weak_page.upgrade().is_some()
                                && answer_policy.current(&answer_label, token)
                            {
                                request.allow();
                            } else {
                                request.deny();
                            }
                            gtk::glib::ControlFlow::Break
                        });
                        if kind == "pointer-lock" {
                            let denied = reply.clone();
                            if pointer_lock_consent(
                                page,
                                &message,
                                &label("browserAllow"),
                                &label("browserDeny"),
                                move |allowed| {
                                    let _ = reply.send(allowed);
                                },
                            )
                            .is_err()
                            {
                                let _ = denied.send(false);
                                super::browser::unknown_permission(
                                    &view,
                                    "pointer-lock: consent unavailable",
                                );
                            }
                            return true;
                        }
                        view.app_handle()
                            .dialog()
                            .message(message)
                            .parent(&view.window())
                            .buttons(MessageDialogButtons::OkCancelCustom(
                                label("browserAllow"),
                                label("browserDeny"),
                            ))
                            .show(move |allowed| {
                                let _ = reply.send(allowed);
                            });
                        return true;
                    }
                    // This API exposes no requesting-frame origin for these request
                    // classes. Never substitute the top-level page's origin.
                    request.deny();
                    super::browser::unknown_permission(&view, request.type_().name());
                    true
                });
            let _ = sender.send(());
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out configuring WebKitGTK browser security".to_string())
}

// Keep the requesting Wayland surface focused: a separate modal window causes
// WebKit to cancel pointer lock before its permission response arrives.
fn pointer_lock_consent(
    page: &webkit2gtk::WebView,
    message: &str,
    allow: &str,
    deny: &str,
    answer: impl FnOnce(bool) + 'static,
) -> Result<(), ()> {
    use gtk::{
        glib::{Cast, ObjectExt},
        prelude::*,
    };
    use std::{cell::RefCell, rc::Rc};
    use webkit2gtk::WebViewExt;

    let mut ancestor = page.parent();
    let mut overlay = None;
    while let Some(widget) = ancestor {
        overlay = widget.clone().downcast::<gtk::Overlay>().ok();
        if overlay.is_some() {
            break;
        }
        ancestor = widget.parent();
    }
    let overlay = match overlay {
        Some(overlay) => overlay,
        None => {
            let window = page
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok())
                .ok_or(())?;
            let child = window.child().ok_or(())?;
            let overlay = gtk::Overlay::new();
            window.remove(&child);
            overlay.add(&child);
            window.add(&overlay);
            overlay.show();
            overlay
        }
    };
    let bar = gtk::InfoBar::new();
    bar.set_halign(gtk::Align::Fill);
    bar.set_valign(gtk::Align::Start);
    bar.set_message_type(gtk::MessageType::Question);
    let text = gtk::Label::new(Some(message));
    text.set_line_wrap(true);
    bar.content_area().add(&text);
    for (label, response) in [
        (deny, gtk::ResponseType::Cancel),
        (allow, gtk::ResponseType::Accept),
    ] {
        let button = bar.add_button(&format!("_{label}"), response).ok_or(())?;
        button.set_use_underline(true);
        button.set_focus_on_click(false);
    }
    let answer = Rc::new(RefCell::new(Some(answer)));
    let response = answer.clone();
    bar.connect_response(move |bar, value| {
        if let Some(answer) = response.borrow_mut().take() {
            answer(value == gtk::ResponseType::Accept);
        }
        unsafe {
            bar.destroy();
        }
    });
    bar.connect_close(|bar| bar.response(gtk::ResponseType::Cancel));
    let weak_bar = bar.downgrade();
    let loading = page.connect_load_changed(move |_, event| {
        if event == webkit2gtk::LoadEvent::Started {
            if let Some(bar) = weak_bar.upgrade() {
                bar.response(gtk::ResponseType::Cancel);
            }
        }
    });
    let weak_page = page.downgrade();
    let loading = RefCell::new(Some(loading));
    bar.connect_destroy(move |_| {
        if let (Some(page), Some(loading)) = (weak_page.upgrade(), loading.borrow_mut().take()) {
            page.disconnect(loading);
        }
        if let Some(answer) = answer.borrow_mut().take() {
            answer(false);
        }
    });
    overlay.add_overlay(&bar);
    bar.show_all();
    Ok(())
}
