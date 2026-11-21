use serde::Serialize;
use serde_json::{json, Value};
use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const RESTART_DELAY: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeveloperTargetState {
    Starting,
    Ready,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeveloperTargetStatus {
    state: DeveloperTargetState,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cdp_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_id: Option<String>,
}

pub(crate) struct DeveloperMode {
    run_id: String,
    native_identity: String,
    devtools_active_port: Option<PathBuf>,
    /// The Rust server: this host drives its own windows (`automation::window`), with no debugging port.
    in_process: bool,
}

pub(crate) fn append_node_option(value: Option<&str>, option: &str) -> String {
    let mut options = value
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>();
    if !options.contains(&option) {
        options.push(option);
    }
    options.join(" ")
}

pub(crate) fn webview2_arguments(value: Option<&str>, port: Option<u16>) -> String {
    let mut input = value.unwrap_or_default().split_whitespace().peekable();
    let mut arguments = Vec::new();
    while let Some(argument) = input.next() {
        if matches!(
            argument,
            "--remote-debugging-address" | "--remote-debugging-port"
        ) {
            if input.peek().is_some_and(|value| !value.starts_with("--")) {
                input.next();
            }
            continue;
        }
        if argument.starts_with("--remote-debugging-address=")
            || argument.starts_with("--remote-debugging-port=")
        {
            continue;
        }
        arguments.push(argument.to_string());
    }
    if let Some(port) = port {
        arguments.push("--remote-debugging-address=127.0.0.1".to_string());
        arguments.push(format!("--remote-debugging-port={port}"));
    }
    arguments.join(" ")
}

impl DeveloperMode {
    pub(crate) fn new(
        native_identity: String,
        devtools_active_port: Option<PathBuf>,
        in_process: bool,
    ) -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            native_identity,
            devtools_active_port,
            in_process,
        }
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    // Call only after the native singleton has been acquired, before creating
    // local WebViews. A second launch must not erase the primary's port file.
    pub(crate) fn prepare_profile(&self) -> io::Result<()> {
        let Some(path) = &self.devtools_active_port else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn discovered_port(&self) -> Option<u16> {
        let value = std::fs::read_to_string(self.devtools_active_port.as_ref()?).ok()?;
        let port = value.lines().next()?.parse::<u16>().ok()?;
        if port == 0 {
            return None;
        }
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).ok()?;
        Some(port)
    }

    fn status(&self, port: Option<u16>, window_id: Option<String>) -> DeveloperTargetStatus {
        let ready = (self.in_process || port.is_some()) && window_id.is_some();
        DeveloperTargetStatus {
            state: if ready {
                DeveloperTargetState::Ready
            } else {
                DeveloperTargetState::Starting
            },
            run_id: Some(self.run_id.clone()),
            native_identity: Some(self.native_identity.clone()),
            cdp_url: port.map(|port| format!("http://127.0.0.1:{port}")),
            window_id: if ready { window_id } else { None },
        }
    }

    pub(crate) fn native_snapshot(
        &self,
        app: &AppHandle,
        params: Option<Value>,
        inventory: bool,
    ) -> Result<Value, String> {
        if !cfg!(windows) {
            return Err("Native automation requires the Tauri Windows runtime".to_string());
        }
        let port = self.discovered_port();
        let state = app.state::<crate::AppState>();
        let mut windows: Vec<(String, String, bool)> = if self.in_process || port.is_some() {
            app.state::<crate::local_windows::LocalWindows>()
                .automation_labels()
                .into_iter()
                .filter_map(|(label, instance)| {
                    let view = app.get_webview(&label)?;
                    crate::require_local_app_webview(&view, &state).ok()?;
                    let focused = view.window().is_focused().unwrap_or(false);
                    Some((crate::identity::local_window_id(&label).ok()?, instance, focused))
                })
                .collect()
        } else {
            Vec::new()
        };
        windows.sort_by_key(|(_, _, focused)| !focused);
        let chosen = select_window(&self.run_id, &windows, params.as_ref());
        let mut result = self.snapshot(port, chosen.map(|(id, _, _)| id.clone()));
        if let Some((_, instance, _)) = chosen {
            result["status"]["windowInstance"] = json!(instance);
        }
        if inventory {
            result["windows"] = json!(windows.iter().map(|(id, instance, focused)| {
                json!({ "windowId": id, "windowInstance": instance, "focused": focused })
            }).collect::<Vec<_>>());
        }
        Ok(result)
    }

    fn snapshot(&self, port: Option<u16>, window_id: Option<String>) -> Value {
        json!({
            "status": self.status(port, window_id),
            "logs": crate::embedded_view::diagnostics::logs(),
        })
    }

    pub(crate) fn request_restart(&self, app: &AppHandle, params: Option<Value>) -> Result<Value, String> {
        if !cfg!(windows) {
            return Err("Native automation requires the Tauri Windows runtime".to_string());
        }
        if params.as_ref().is_some_and(|value| value.get("runId").is_some())
            && self.native_snapshot(app, params, false)?["status"]["state"] != "ready"
        {
            return Err("The selected window is no longer available".to_string());
        }
        let status = self.status(self.discovered_port(), None);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(RESTART_DELAY);
            crate::shutdown::request_restart(app);
        });
        Ok(json!(status))
    }
}

fn select_window<'a>(
    run: &str,
    windows: &'a [(String, String, bool)],
    params: Option<&Value>,
) -> Option<&'a (String, String, bool)> {
    let exact = params.filter(|value| value.get("runId").is_some() || value.get("windowId").is_some());
    match exact {
        None => windows.first(),
        Some(input) if input["runId"].as_str() == Some(run) => windows
            .iter()
            .find(|(id, instance, _)| Some(id.as_str()) == input["windowId"].as_str()
                && Some(instance.as_str()) == input["windowInstance"].as_str()),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_exact_window_without_using_focus_or_substituting() {
        let mut windows = vec![("B".into(), "b".into(), true), ("A".into(), "a".into(), false)];
        let target = json!({ "runId": "current", "windowId": "A", "windowInstance": "a" });
        assert_eq!(select_window("current", &windows, None).map(|w| w.0.as_str()), Some("B"));
        assert_eq!(select_window("current", &windows, Some(&target)).map(|w| w.0.as_str()), Some("A"));
        assert_eq!(select_window("old", &windows, Some(&target)), None);
        windows.pop();
        assert_eq!(select_window("current", &windows, Some(&target)), None);
        windows.push(("A".into(), "new".into(), false));
        assert_eq!(select_window("current", &windows, Some(&target)), None);
    }

    #[test]
    fn native_snapshot_includes_recorded_preview_failure() {
        let error = crate::embedded_view::diagnostics::preview_error(
            "snapshot regression",
            "Paramètre incorrect. (0x80070057)",
        );
        let mode = DeveloperMode::new("tauri:test".into(), None, false);
        let snapshot = mode.snapshot(None, None);
        assert!(snapshot["logs"].as_array().unwrap().iter().any(|log| {
            log["level"] == "error" && log["text"] == error
        }));
    }

    #[test]
    fn normal_startup_prepares_stable_profile_and_clears_only_stale_endpoint() {
        let root = tempfile::tempdir().unwrap();
        let port_file = root.path().join("local/EBWebView/DevToolsActivePort");
        let mode = DeveloperMode::new("tauri:test".to_string(), Some(port_file.clone()), false);
        mode.prepare_profile().unwrap();
        let cookie_file = port_file.with_file_name("Cookies");
        std::fs::write(&cookie_file, b"persisted").unwrap();
        std::fs::write(&port_file, b"12345\n").unwrap();
        mode.prepare_profile().unwrap();
        assert!(!port_file.exists());
        assert_eq!(std::fs::read(cookie_file).unwrap(), b"persisted");
        assert_eq!(
            mode.status(None, None).state,
            DeveloperTargetState::Starting
        );
    }

    #[test]
    fn sanitizes_webview2_debugging_arguments_and_preserves_other_flags() {
        let inherited = "--trace-startup --remote-debugging-address 0.0.0.0 --remote-debugging-port=9222 --disable-features=msSmartScreenProtection";
        assert_eq!(
            webview2_arguments(Some(inherited), None),
            "--trace-startup --disable-features=msSmartScreenProtection"
        );
        assert_eq!(
            webview2_arguments(Some(inherited), Some(0)),
            "--trace-startup --disable-features=msSmartScreenProtection --remote-debugging-address=127.0.0.1 --remote-debugging-port=0"
        );
        assert_eq!(
            append_node_option(
                Some("--trace-warnings --enable-source-maps"),
                "--enable-source-maps"
            ),
            "--trace-warnings --enable-source-maps"
        );
    }

    #[test]
    fn native_status_has_only_current_process_fields() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let root = tempfile::tempdir().unwrap();
        let devtools_active_port = root.path().join("DevToolsActivePort");
        std::fs::write(
            &devtools_active_port,
            format!("{port}\n/devtools/browser/test\n"),
        )
        .unwrap();
        let mode = DeveloperMode {
            run_id: "run-1".to_string(),
            native_identity: "tauri:test".to_string(),
            devtools_active_port: Some(devtools_active_port),
            in_process: false,
        };
        assert_eq!(
            json!(mode.status(mode.discovered_port(), Some("window-1".to_string()))),
            json!({
                "state": "ready",
                "runId": "run-1",
                "nativeIdentity": "tauri:test",
                "cdpUrl": format!("http://127.0.0.1:{port}"),
                "windowId": "window-1"
            })
        );
        assert_eq!(
            json!(mode.status(mode.discovered_port(), None)),
            json!({
                "state": "starting",
                "runId": "run-1",
                "nativeIdentity": "tauri:test",
                "cdpUrl": format!("http://127.0.0.1:{port}")
            })
        );
    }

    #[test]
    fn in_process_automation_is_ready_without_a_debugging_port() {
        let mode = DeveloperMode::new("tauri:test".into(), None, true);
        assert_eq!(
            json!(mode.status(None, Some("window-1".into()))),
            json!({ "state": "ready", "runId": mode.run_id(), "nativeIdentity": "tauri:test", "windowId": "window-1" })
        );
        assert_eq!(mode.status(None, None).state, DeveloperTargetState::Starting);
    }

    #[test]
    fn startup_enables_local_instrumentation_without_a_marker_or_global_remote_flags() {
        let source = include_str!("main.rs");
        assert!(source.contains("configure_developer_environment();"));
        assert!(source.contains("configure_developer_webview(&scope, in_process_automation)"));
        assert!(source.contains("Some(developer_mode::webview2_arguments(None, Some(0)))"));
        assert!(source.contains("scope.webview_data_directory.join(\"developer-mode\")"));
        assert!(!source.contains("developer_mode_active"));
        assert!(!source.contains("developer_mode_get"));
        assert!(!source.contains("developer_mode_set"));
        // Only the singleton primary's setup removes a stale endpoint. Remote
        // windows use a distinct profile without additional debugging arguments.
        let setup = source.split(".setup(move |app| {").nth(1).unwrap();
        assert!(setup.contains("developer_mode.prepare_profile()?"));
        let remote = source
            .split("let data_directory = app")
            .nth(1)
            .unwrap()
            .split("let window = match builder.build()")
            .next()
            .unwrap();
        assert!(remote.contains(".join(\"remote\")"));
        assert!(!remote.contains("additional_browser_args"));
    }
}
