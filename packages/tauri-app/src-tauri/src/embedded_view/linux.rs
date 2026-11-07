pub(super) fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;
    use webkit2gtk::{PermissionRequestExt, WebViewExt};

    let (sender, receiver) = mpsc::sync_channel(1);
    let view = webview.clone();
    webview
        .with_webview(move |platform| {
            use tauri::Manager;
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
                .connect_permission_request(move |_, request| {
                    use gtk::glib::{Cast, ObjectExt};
                    use webkit2gtk::{
                        DeviceInfoPermissionRequest, GeolocationPermissionRequest,
                        NotificationPermissionRequest, UserMediaPermissionRequest,
                        UserMediaPermissionRequestExt, WebsiteDataAccessPermissionRequest,
                        WebsiteDataAccessPermissionRequestExt,
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
                    if let Some(storage) =
                        request.downcast_ref::<WebsiteDataAccessPermissionRequest>()
                    {
                        if let (Some(requester), Some(current)) =
                            (storage.requesting_domain(), storage.current_domain())
                        {
                            use tauri::Manager;
                            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                            let label = |key| {
                                view.app_handle()
                                    .try_state::<crate::AppState>()
                                    .map(|state| state.menu_labels.text(key))
                                    .unwrap_or_else(|| crate::menu_labels::label(key).to_string())
                            };
                            let message = label("browserPermission")
                                .replace("{permission}", "storage-access")
                                .replace("{origin}", &format!("{requester} → {current}"));
                            let request = request.clone();
                            let (reply, answer) = gtk::glib::MainContext::channel::<bool>(
                                gtk::glib::Priority::DEFAULT,
                            );
                            answer.attach(None, move |allowed| {
                                if allowed {
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
