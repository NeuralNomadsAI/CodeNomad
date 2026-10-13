//! Owned-window non-Windows zoom input. The generic core zoom command neither
//! updates our constraints/bookkeeping nor restricts mutation to its caller.
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, Url, Webview, WebviewWindowBuilder};

#[cfg(any(not(windows), test))]
const SCRIPT: &str = include_str!("window_zoom.js");

pub(crate) fn configure<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let builder = builder.zoom_hotkeys_enabled(cfg!(windows));
    // Disabling Tauri's hotkey flag suppresses the pinned runtime's generic
    // plugin:webview|set_webview_zoom script on macOS/Linux. Windows stays native.
    #[cfg(not(windows))]
    let builder = builder.initialization_script(render_script(std::env::consts::OS));
    builder
}

#[cfg(any(not(windows), test))]
fn render_script(platform: &str) -> String {
    SCRIPT.replace(
        "__HOST_PLATFORM__",
        &serde_json::to_string(platform).unwrap(),
    )
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ZoomAction {
    In,
    Out,
    Reset,
}

fn next_zoom(current: f64, action: ZoomAction) -> f64 {
    let current = if current.is_finite() && current > 0.0 {
        current
    } else {
        1.0
    };
    let next = match action {
        ZoomAction::In => current + 0.2,
        ZoomAction::Out => current - 0.2,
        ZoomAction::Reset => 1.0,
    };
    // Preserve the pinned hotkey's 20% step, within CodeNomad's saved zoom range,
    // without accumulating float noise at ceil-based logical minimum boundaries.
    (next.clamp(0.25, 5.0) * 1_000_000.0).round() / 1_000_000.0
}

#[derive(Debug, PartialEq)]
enum Owner {
    Local,
    Preferences,
    Remote,
}

fn owner(
    label: &str,
    window_label: &str,
    registered_local: bool,
    registered_remote: bool,
) -> Option<Owner> {
    if label != window_label {
        return None;
    }
    if label == crate::preferences_window::LABEL {
        return Some(Owner::Preferences);
    }
    if registered_local && crate::identity::local_window_id(label).is_ok() {
        return Some(Owner::Local);
    }
    if registered_remote && label.starts_with("remote-") {
        return Some(Owner::Remote);
    }
    None
}

fn remote_origin_allowed(current: &Url, registered: Option<&str>) -> bool {
    matches!(current.scheme(), "http" | "https") && crate::same_origin(current, registered)
}

fn require_owned_webview(webview: &Webview, app: &AppHandle) -> Result<Url, String> {
    let state = app.state::<crate::AppState>();
    let registered_local = app
        .state::<crate::local_windows::LocalWindows>()
        .record(webview.label())
        .is_some();
    let remote_origin = state
        .remote_navigation
        .lock()
        .map_err(|e| e.to_string())?
        .get(webview.label())
        .map(|metadata| metadata.origin.clone());
    match owner(
        webview.label(),
        webview.window().label(),
        registered_local,
        remote_origin.is_some(),
    ) {
        Some(Owner::Local | Owner::Preferences) => {
            crate::require_preferences_or_local_app_webview(webview, &state)
        }
        Some(Owner::Remote) => {
            // Do not hold any application mutex across a native URL getter.
            let current = webview.url().map_err(|e| e.to_string())?;
            if remote_origin_allowed(&current, remote_origin.as_deref()) {
                Ok(current)
            } else {
                Err("Zoom requires the registered remote renderer origin".into())
            }
        }
        None => Err("Zoom is limited to an owned primary application webview".into()),
    }
}

#[tauri::command]
pub(crate) async fn owned_webview_zoom(
    webview: Webview,
    action: ZoomAction,
) -> Result<f64, String> {
    let app = webview.app_handle().clone();
    let admitted_url = require_owned_webview(&webview, &app)?;
    let target_app = app.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            // Fence queued requests across navigation/replacement, and serialize
            // relative zoom reads/writes on the native thread without holding locks.
            if require_owned_webview(&webview, &target_app)? != admitted_url {
                return Err("Zoom renderer changed before dispatch".into());
            }
            let zoom = next_zoom(crate::target_zoom(&target_app, &webview), action);
            crate::set_target_zoom(&target_app, &webview, zoom);
            Ok(crate::target_zoom(&target_app, &webview))
        })();
        let _ = sender.send(result);
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_uses_host_zoom_and_saved_range_not_a_bootstrap_counter() {
        assert_eq!(next_zoom(1.6, ZoomAction::In), 1.8);
        assert_eq!(next_zoom(1.8, ZoomAction::Out), 1.6);
        assert_eq!(next_zoom(3.0, ZoomAction::Reset), 1.0);
        assert_eq!(next_zoom(5.0, ZoomAction::In), 5.0);
        assert_eq!(next_zoom(0.25, ZoomAction::Out), 0.25);
        assert_eq!(next_zoom(f64::NAN, ZoomAction::In), 1.2);
        assert_eq!(
            crate::window_constraints::zoomed_minimum(next_zoom(1.0, ZoomAction::In)),
            (468, 720)
        );
        for invalid in ["get", "set", "zoom", "120", "minimize"] {
            assert!(serde_json::from_value::<ZoomAction>(serde_json::json!(invalid)).is_err());
        }
    }

    #[test]
    fn only_registered_primary_webviews_have_zoom_authority() {
        let local = "local-11111111-1111-4111-8111-111111111111";
        assert_eq!(owner(local, local, true, false), Some(Owner::Local));
        assert_eq!(owner(local, local, false, false), None);
        assert_eq!(owner("local-fake", "local-fake", true, false), None);
        assert_eq!(
            owner("remote-profile", "remote-profile", false, true),
            Some(Owner::Remote)
        );
        assert_eq!(
            owner("remote-profile", "remote-profile", false, false),
            None
        );
        assert_eq!(
            owner("preferences", "preferences", false, false),
            Some(Owner::Preferences)
        );
        for label in ["browser-preview", local, "remote-profile", "preferences"] {
            assert_eq!(owner(label, "different-parent", true, true), None);
        }
        let registered = Some("https://remote.example:8443");
        assert!(remote_origin_allowed(
            &"https://remote.example:8443/app".parse().unwrap(),
            registered
        ));
        for url in [
            "about:blank",
            "tauri://localhost/loading.html",
            "https://remote.example/app",
            "https://other.example:8443/app",
        ] {
            assert!(!remote_origin_allowed(&url.parse().unwrap(), registered));
        }
        assert!(!remote_origin_allowed(
            &"https://remote.example:8443/app".parse().unwrap(),
            None
        ));
    }

    #[test]
    fn script_is_caller_scoped_and_windows_keeps_native_input_only() {
        for platform in ["macos", "linux"] {
            let script = render_script(platform);
            assert!(script.contains("'owned_webview_zoom', { action }"));
            assert!(!script.contains("plugin:webview|set_webview_zoom"));
            assert!(!script.contains("zoomLevel"));
        }
        // This script is not installed on Windows, and is inert even if supplied.
        assert!(SCRIPT.contains("platform === 'windows' || window.top !== window"));
    }

    #[test]
    fn actual_tauri_acl_keeps_zoom_narrow_and_preview_children_unprivileged() {
        use std::collections::BTreeMap;
        use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
        let manifests: BTreeMap<String, Manifest> =
            serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
        let capabilities: BTreeMap<String, Capability> =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        let source: Capability =
            serde_json::from_str(include_str!("../capabilities/owned-webview-zoom.json")).unwrap();
        assert!(source.windows.is_empty());
        assert_eq!(source.webviews, ["local-*", "remote-*", "preferences"]);
        assert_eq!(
            serde_json::to_value(&source).unwrap(),
            serde_json::to_value(&capabilities[&source.identifier]).unwrap()
        );
        let resolved = Resolved::resolve(
            &manifests,
            capabilities,
            tauri::utils::platform::Target::current(),
        )
        .unwrap();
        let commands = resolved
            .allowed_commands
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let authority = tauri::runtime_authority!(manifests, resolved);
        for (label, url) in [
            (
                "local-11111111-1111-4111-8111-111111111111",
                "http://127.0.0.1:32123/app",
            ),
            ("preferences", "http://127.0.0.1:32123/preferences"),
            ("remote-profile", "https://remote.example:8443/app"),
        ] {
            let origin = tauri::ipc::Origin::Remote {
                url: url.parse().unwrap(),
            };
            assert!(authority
                .resolve_access("owned_webview_zoom", label, label, &origin)
                .is_some());
            assert!(
                authority
                    .resolve_access("plugin:webview|set_webview_zoom", label, label, &origin)
                    .is_none(),
                "generic zoom granted to {label}"
            );
            for command in &commands {
                assert!(
                    authority
                        .resolve_access(command, label, "browser-preview", &origin)
                        .is_none(),
                    "preview under {label} inherited {command}"
                );
            }
            if label.starts_with("remote-") {
                for command in [
                    "cli_restart",
                    "client_state_load",
                    "browser_target_register",
                    "window_control",
                    "plugin:dialog|open",
                ] {
                    assert!(
                        authority
                            .resolve_access(command, label, label, &origin)
                            .is_none(),
                        "remote gained {command}"
                    );
                }
                assert!(authority
                    .resolve_access("plugin:notification|notify", label, label, &origin)
                    .is_some());
            }
        }
        let origin = tauri::ipc::Origin::Local;
        assert!(authority
            .resolve_access(
                "owned_webview_zoom",
                "local-11111111-1111-4111-8111-111111111111",
                "local-11111111-1111-4111-8111-111111111111",
                &origin
            )
            .is_some());
        assert!(authority
            .resolve_access("owned_webview_zoom", "unknown", "unknown", &origin)
            .is_none());
    }
}
