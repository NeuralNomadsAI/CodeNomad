pub(super) fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;
    use webkit2gtk::{PermissionRequestExt, WebViewExt};

    let (sender, receiver) = mpsc::sync_channel(1);
    let view = webview.clone();
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
            platform.inner().connect_enter_fullscreen(move |_| {
                if let Some(views) = enter.app_handle().try_state::<super::EmbeddedViews>() {
                    let _ = views.set_fullscreen(enter.app_handle(), enter.label(), true);
                }
                false
            });
            let leave = view.clone();
            platform.inner().connect_leave_fullscreen(move |_| {
                if let Some(views) = leave.app_handle().try_state::<super::EmbeddedViews>() {
                    let _ = views.set_fullscreen(leave.app_handle(), leave.label(), false);
                }
                false
            });
            platform
                .inner()
                .connect_permission_request(move |page, request| {
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
                        let page = page.downgrade();
                        let (reply, answer) =
                            gtk::glib::MainContext::channel::<bool>(gtk::glib::Priority::DEFAULT);
                        answer.attach(None, move |allowed| {
                            if allowed && epoch.get() == captured && page.upgrade().is_some() {
                                request.allow();
                            } else {
                                request.deny();
                            }
                            gtk::glib::ControlFlow::Break
                        });
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
