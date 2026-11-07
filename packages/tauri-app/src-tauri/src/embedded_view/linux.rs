pub(super) fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;
    use webkit2gtk::{PermissionRequestExt, WebViewExt};

    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            platform.inner().connect_permission_request(|_, request| {
                request.deny();
                true
            });
            let _ = sender.send(());
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out configuring WebKitGTK browser security".to_string())
}
