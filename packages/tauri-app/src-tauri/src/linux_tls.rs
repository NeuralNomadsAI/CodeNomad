use crate::AppState;
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;
use webkit2gtk::{WebContextExt, WebView, WebViewExt};

pub fn should_bootstrap_tls_navigation(target_url: &Url, allow_tls_certificate: bool) -> bool {
    allow_tls_certificate && target_url.scheme() == "https"
}

pub fn ensure_remote_window_tls_handler(
    window: &WebviewWindow,
    app_handle: &AppHandle,
    window_label: &str,
) -> Result<(), String> {
    {
        let state = app_handle.state::<AppState>();
        let mut handlers = state
            .remote_tls_handlers
            .lock()
            .map_err(|err| err.to_string())?;
        if !handlers.insert(window_label.to_string()) {
            return Ok(());
        }
    }

    let app_handle = app_handle.clone();
    let window_label = window_label.to_string();
    window
        .with_webview(move |platform_webview| {
            let webview = platform_webview.inner();
            let app_handle = app_handle.clone();
            let window_label = window_label.clone();
            webview.connect_load_failed_with_tls_errors(move |view, failing_uri, certificate, _| {
                allow_remote_tls_certificate(
                    &app_handle,
                    &window_label,
                    view,
                    failing_uri,
                    certificate,
                )
            });
        })
        .map_err(|err| err.to_string())
}

fn allow_remote_tls_certificate(
    app_handle: &AppHandle,
    window_label: &str,
    view: &WebView,
    failing_uri: &str,
    certificate: &webkit2gtk::gio::TlsCertificate,
) -> bool {
    let Ok(parsed_uri) = Url::parse(failing_uri) else {
        return false;
    };
    let Some(host) = parsed_uri.host_str() else {
        return false;
    };

    let state = app_handle.state::<AppState>();
    let skip_tls_verify = state
        .remote_skip_tls_verify
        .lock()
        .ok()
        .and_then(|values| values.get(window_label).copied())
        .unwrap_or(false);
    if !skip_tls_verify {
        return false;
    }

    let expected_origin = state
        .remote_origins
        .lock()
        .ok()
        .and_then(|origins| origins.get(window_label).cloned());
    let parsed_origin = parsed_uri.origin().ascii_serialization();
    if expected_origin.as_deref() != Some(parsed_origin.as_str()) {
        return false;
    }

    let Some(context) = view.context() else {
        return false;
    };

    context.allow_tls_certificate_for_host(certificate, host);
    view.load_uri(failing_uri);
    true
}
