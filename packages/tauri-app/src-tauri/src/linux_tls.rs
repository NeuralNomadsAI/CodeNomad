use crate::{clear_remote_tls_handler, AppState};
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
    window_generation: u64,
) -> Result<(), String> {
    {
        let state = app_handle.state::<AppState>();
        let mut handlers = state
            .remote_tls_handlers
            .lock()
            .map_err(|err| err.to_string())?;
        if handlers.get(window_label).copied() == Some(window_generation) {
            return Ok(());
        }
        handlers.insert(window_label.to_string(), window_generation);
    }

    let handler_app = app_handle.clone();
    let handler_label = window_label.to_string();
    window
        .with_webview(move |platform_webview| {
            let webview = platform_webview.inner();
            let app_handle = handler_app.clone();
            let window_label = handler_label.clone();
            webview.connect_load_failed_with_tls_errors(
                move |view, failing_uri, certificate, _| {
                    allow_remote_tls_certificate(
                        &app_handle,
                        &window_label,
                        window_generation,
                        view,
                        failing_uri,
                        certificate,
                    )
                },
            );
        })
        .map_err(|err| {
            if let Ok(mut handlers) = app_handle.state::<AppState>().remote_tls_handlers.lock() {
                clear_remote_tls_handler(&mut handlers, &window_label, window_generation);
            }
            err.to_string()
        })
}

fn allow_remote_tls_certificate(
    app_handle: &AppHandle,
    window_label: &str,
    window_generation: u64,
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
    if state.remote_tls_handlers.lock().map_or(true, |handlers| {
        handlers.get(window_label).copied() != Some(window_generation)
    }) {
        return false;
    }
    let metadata = state
        .remote_navigation
        .lock()
        .ok()
        .and_then(|values| values.get(window_label).cloned());
    let Some(metadata) = metadata else {
        return false;
    };
    if !metadata.allow_linux_tls_certificate {
        return false;
    }
    if metadata.window_generation != window_generation {
        return false;
    }

    let parsed_origin = parsed_uri.origin().ascii_serialization();
    if metadata.origin != parsed_origin {
        return false;
    }

    let Some(context) = view.context() else {
        return false;
    };

    context.allow_tls_certificate_for_host(certificate, host);
    view.load_uri(failing_uri);
    true
}
