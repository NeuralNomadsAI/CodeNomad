use codenomad_mobile_policy::NavigationPolicy;
use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// The hosted application reads these during module initialization. Do not rely
// on UA detection: Tauri remains the container but never the hosted UI's host.
const HOSTED_CONTEXT: &str = r#"
Object.defineProperty(window, '__CODENOMAD_RUNTIME_HOST__', { value: 'web', writable: false, configurable: false });
Object.defineProperty(window, '__CODENOMAD_WINDOW_CONTEXT__', { value: 'remote', writable: false, configurable: false });
"#;

type Policy = Arc<Mutex<NavigationPolicy>>;

#[tauri::command]
async fn connect_server(
    webview: WebviewWindow,
    policy: tauri::State<'_, Policy>,
    endpoint: String,
) -> Result<(), String> {
    let current = webview.url().map_err(|_| "unavailable")?;
    let pending = policy
        .lock()
        .map_err(|_| "unavailable")?
        .prepare_connection(webview.label(), &current, &endpoint)?;
    // Runs off the UI thread: mobile readiness calls dispatch to the main thread.
    // Do not connect unless native recovery is attached and document-start
    // injection is available (Android's onPageStarted fallback is too late).
    let native_generation =
        tauri_plugin_mobile_recovery::readiness(webview.app_handle()).map_err(|_| "unsupported")?;
    let current = webview.url().map_err(|_| "unavailable")?;
    let committed = {
        let mut guard = policy.lock().map_err(|_| "unavailable")?;
        guard.commit_connection(webview.label(), &current, pending)?
    };
    // Top-level navigation preserves the hosted site's same-origin cookies,
    // SDK, SSE, and authentication. There is deliberately no iframe or proxy.
    // Selection and load are one native UI-thread transaction. Readiness never
    // selects an endpoint. Native return/document replacement invalidates the
    // snapshot even before Rust receives the corresponding navigation callback.
    if tauri_plugin_mobile_recovery::connect(
        webview.app_handle(),
        &native_generation,
        committed.endpoint().as_str(),
    )
    .is_err()
    {
        if let Ok(mut guard) = policy.lock() {
            guard.abort_connection(&committed);
        }
        return Err("unavailable".into());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launcher = if cfg!(any(target_os = "android", target_os = "windows")) {
        "https://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    let policy = Arc::new(Mutex::new(NavigationPolicy::new(launcher.parse().unwrap())));
    tauri::Builder::default()
        .manage(Arc::clone(&policy))
        .plugin(tauri_plugin_mobile_recovery::init())
        .invoke_handler(tauri::generate_handler![connect_server])
        .setup(move |app| {
            let navigation = Arc::clone(&policy);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("CodeNomad Mobile")
                .use_https_scheme(true)
                .initialization_script(HOSTED_CONTEXT)
                .on_navigation(move |url| {
                    navigation
                        .lock()
                        .map(|mut guard| guard.admit(url))
                        .unwrap_or(false)
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("mobile application startup");
}
