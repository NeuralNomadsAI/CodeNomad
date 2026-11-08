pub(super) fn request_close<R: tauri::Runtime>(view: &tauri::Webview<R>) -> Result<(), String> {
    let window = view.window();
    view.with_webview(move |native| unsafe {
        let Some(view) = native.inner().cast::<objc2::runtime::AnyObject>().as_ref() else {
            return;
        };
        // WebKit's native tryClose runs beforeunload, then webViewDidClose.
        // An immediate YES means no asynchronous confirmation was needed.
        let available: objc2::runtime::Bool =
            objc2::msg_send![view, respondsToSelector: objc2::sel!(_tryClose)];
        if !available.as_bool() {
            eprintln!("[browser-close] WKWebView tryClose unavailable");
            return;
        }
        let close: objc2::runtime::Bool = objc2::msg_send![view, _tryClose];
        if close.as_bool() {
            let _ = window.destroy();
        }
    })
    .map_err(|error| error.to_string())
}

pub(super) fn install<R: tauri::Runtime>(view: &tauri::Webview<R>) -> Result<(), String> {
    super::zoom::install(view)
}
