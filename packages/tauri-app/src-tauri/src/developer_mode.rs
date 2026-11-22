use crate::developer_relaunch::{DeveloperRestart, Handoff, RelaunchPlan};
use crate::native_request::RequestFence;
use serde::Serialize;
use serde_json::{json, Value};
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const RESTART_DELAY: Duration = Duration::from_millis(100);
// The client may wait 95 s for a lost ACK before spending 95 s reconnecting.
const RECONNECT_RECEIPT_TTL: Duration = Duration::from_secs(2 * 95);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeveloperTargetState {
    Starting,
    Ready,
    Missing,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    restart_id: Option<String>,
}

pub(crate) struct DeveloperMode {
    run_id: String,
    native_identity: String,
    devtools_active_port: Option<PathBuf>,
    previous_restart: Option<(DeveloperRestart, Instant)>,
    launch_scope: Option<(PathBuf, crate::identity::LaunchProfile, Option<String>)>,
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
    pub(crate) fn new(native_identity: String, devtools_active_port: Option<PathBuf>) -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            native_identity,
            devtools_active_port,
            previous_restart: None,
            launch_scope: None,
        }
    }

    pub(crate) fn with_launch_scope(
        mut self,
        executable: Option<PathBuf>,
        profile: crate::identity::LaunchProfile,
        config: Option<String>,
        previous_restart: Option<(DeveloperRestart, Instant)>,
    ) -> Self {
        self.launch_scope = executable.map(|path| (path, profile, config));
        self.previous_restart = previous_restart;
        self
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
        let ready = port.is_some() && window_id.is_some();
        DeveloperTargetStatus {
            state: if ready {
                DeveloperTargetState::Ready
            } else {
                DeveloperTargetState::Starting
            },
            run_id: Some(self.run_id.clone()),
            native_identity: Some(self.native_identity.clone()),
            cdp_url: port.map(|port| format!("http://127.0.0.1:{port}")),
            window_id,
            restart_id: None,
        }
    }

    fn local_window(app: &AppHandle, id: &str) -> Option<String> {
        let Ok(label) = crate::identity::local_window_label(id) else {
            return None;
        };
        let windows = app.state::<crate::local_windows::LocalWindows>();
        (windows.record(&label).is_some()
            && !windows.is_connect_only(&label)
            && !crate::shutdown::local_window_close_in_flight(app, &label)
            && app
                .get_webview(&label)
                .is_some_and(|window| window.window().label() == label))
        .then_some(label)
    }

    fn automation_windows(app: &AppHandle) -> Vec<(String, String, bool)> {
        let state = app.state::<crate::AppState>();
        let mut windows: Vec<_> = app
            .state::<crate::local_windows::LocalWindows>()
            .automation_labels()
            .into_iter()
            .filter_map(|(label, instance)| {
                let view = app.get_webview(&label)?;
                crate::require_local_app_webview(&view, &state).ok()?;
                if crate::shutdown::local_window_close_in_flight(app, &label) {
                    return None;
                }
                let focused = view.window().is_focused().unwrap_or(false);
                Some((
                    crate::identity::local_window_id(&label).ok()?,
                    instance,
                    focused,
                ))
            })
            .collect();
        windows.sort_by_key(|(_, _, focused)| !focused);
        windows
    }

    fn exact_window(app: &AppHandle, expected: &DeveloperRestart) -> bool {
        Self::automation_windows(app)
            .iter()
            .any(|(id, instance, _)| {
                id == &expected.window_id && Some(instance) == expected.window_instance.as_ref()
            })
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
        let windows = if port.is_some() {
            Self::automation_windows(app)
        } else {
            Vec::new()
        };
        let chosen = select_window(&self.run_id, &windows, params.as_ref());
        let mut result = self.snapshot(port, chosen.map(|(id, _, _)| id.clone()));
        if let Some((_, instance, _)) = chosen {
            result["status"]["windowInstance"] = json!(instance);
        }
        if inventory {
            result["windows"] = json!(windows
                .iter()
                .map(|(id, instance, focused)| {
                    json!({ "windowId": id, "windowInstance": instance, "focused": focused })
                })
                .collect::<Vec<_>>());
        }
        Ok(result)
    }

    fn snapshot(&self, port: Option<u16>, window_id: Option<String>) -> Value {
        json!({
            "status": self.status(port, window_id),
            "logs": crate::embedded_view::diagnostics::logs(),
        })
    }

    fn reconnect_snapshot(&self, app: &AppHandle, expected: &DeveloperRestart) -> Value {
        let port = self.discovered_port();
        let id = &expected.window_id;
        let window = Self::automation_windows(app)
            .into_iter()
            .find(|(window, _, _)| window == id);
        let mut status = self.status(port, window.as_ref().map(|(id, _, _)| id.clone()));
        if window.is_none() && Self::local_window(app, id).is_none() {
            status.state = DeveloperTargetState::Missing;
        }
        status.window_id = Some(id.clone());
        status.restart_id = Some(expected.restart_id.clone());
        let mut result =
            json!({ "status": status, "logs": crate::embedded_view::diagnostics::logs() });
        if let Some((_, instance, _)) = window {
            result["status"]["windowInstance"] = json!(instance);
        }
        result
    }

    fn restart_request(params: Option<Value>) -> Result<DeveloperRestart, String> {
        let expected: DeveloperRestart = serde_json::from_value(params.unwrap_or_default())
            .map_err(|_| "Invalid developer restart target")?;
        if !expected.valid() {
            return Err("Invalid developer restart target".into());
        }
        Ok(expected)
    }

    pub(crate) fn reconnect(
        &self,
        app: &AppHandle,
        params: Option<Value>,
    ) -> Result<Value, String> {
        let expected = Self::restart_request(params)?;
        if !cfg!(windows) {
            return Err("No matching CodeNomad relaunch".into());
        }
        self.read_reconnect(&expected, Instant::now, || {
            self.reconnect_snapshot(app, &expected)
        })
    }

    fn read_reconnect(
        &self,
        expected: &DeveloperRestart,
        now: impl Fn() -> Instant,
        snapshot: impl FnOnce() -> Value,
    ) -> Result<Value, String> {
        let no_match = "No matching CodeNomad relaunch";
        let (_, started_at) = self
            .previous_restart
            .as_ref()
            .filter(|(restart, _)| restart == expected)
            .ok_or(no_match)?;
        let expired = || now().duration_since(*started_at) >= RECONNECT_RECEIPT_TTL;
        if expired() {
            return Err(no_match.into());
        }
        let result = snapshot();
        if expired() {
            return Err(no_match.into());
        }
        Ok(result)
    }

    fn prove_restart(
        &self,
        expected: &DeveloperRestart,
        window_exists: impl FnOnce(&DeveloperRestart) -> bool,
    ) -> Result<(), String> {
        if expected.run_id != self.run_id
            || expected.native_identity != self.native_identity
            || !window_exists(expected)
        {
            return Err("The inspected CodeNomad window or run changed".into());
        }
        Ok(())
    }

    pub(crate) fn request_restart(
        &self,
        app: &AppHandle,
        params: Option<Value>,
        fence: RequestFence,
    ) -> Result<Value, String> {
        if !cfg!(windows) {
            return Err("Native automation requires the Tauri Windows runtime".to_string());
        }
        let expected = Self::restart_request(params)?;
        let (executable, profile, config) = self
            .launch_scope
            .as_ref()
            .ok_or("The inspected CodeNomad executable is unavailable")?;
        self.prove_restart(&expected, |window| Self::exact_window(app, window))?;
        let label = crate::identity::local_window_label(&expected.window_id)?;
        fence.check()?;
        let generation = crate::shutdown::reserve_automation_restart(app, &label, &fence)?;
        let app = app.clone();
        let plan = RelaunchPlan {
            executable: executable.clone(),
            handoff: Handoff {
                restart: expected.clone(),
                profile: profile.key.clone(),
                pinned: profile.pinned,
                config: config.clone(),
            },
        };
        std::thread::spawn(move || {
            std::thread::sleep(RESTART_DELAY);
            let current = fence.check().is_ok()
                && Self::exact_window(&app, &plan.handoff.restart)
                && fence.check().is_ok();
            crate::shutdown::finish_automation_restart(
                app,
                &label,
                generation,
                current.then_some(plan),
                &fence,
            );
        });
        Ok(json!(expected))
    }
}

fn select_window<'a>(
    run: &str,
    windows: &'a [(String, String, bool)],
    params: Option<&Value>,
) -> Option<&'a (String, String, bool)> {
    let exact =
        params.filter(|value| value.get("runId").is_some() || value.get("windowId").is_some());
    match exact {
        None => windows.first(),
        Some(input) if input["runId"].as_str() == Some(run) => {
            windows.iter().find(|(id, instance, _)| {
                Some(id.as_str()) == input["windowId"].as_str()
                    && Some(instance.as_str()) == input["windowInstance"].as_str()
            })
        }
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_exact_window_without_using_focus_or_substituting() {
        let mut windows = vec![
            ("B".into(), "b".into(), true),
            ("A".into(), "a".into(), false),
        ];
        let target = json!({ "runId": "current", "windowId": "A", "windowInstance": "a" });
        assert_eq!(
            select_window("current", &windows, None).map(|w| w.0.as_str()),
            Some("B")
        );
        assert_eq!(
            select_window("current", &windows, Some(&target)).map(|w| w.0.as_str()),
            Some("A")
        );
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
        let mode = DeveloperMode::new("tauri:test".into(), None);
        let snapshot = mode.snapshot(None, None);
        assert!(snapshot["logs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|log| { log["level"] == "error" && log["text"] == error }));
    }

    #[test]
    fn normal_startup_prepares_stable_profile_and_clears_only_stale_endpoint() {
        let root = tempfile::tempdir().unwrap();
        let port_file = root.path().join("local/EBWebView/DevToolsActivePort");
        let mode = DeveloperMode::new("tauri:test".to_string(), Some(port_file.clone()));
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
        let mut mode = DeveloperMode::new("tauri:test".into(), Some(devtools_active_port));
        mode.run_id = "run-1".into();
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
    fn native_restart_requires_the_inspected_run_scope_and_window() {
        let mode = DeveloperMode::new("tauri:test".into(), None);
        let mut expected = DeveloperRestart {
            run_id: mode.run_id.clone(),
            native_identity: "tauri:test".into(),
            window_id: "11111111-2222-4333-8444-555555555555".into(),
            window_instance: Some("incarnation".into()),
            restart_id: "7c3e5066-017d-4ce1-a371-187ac459c4b2".into(),
        };
        assert!(DeveloperMode::restart_request(None).is_err());
        assert!(mode.prove_restart(&expected, |_| false).is_err());
        assert!(mode
            .prove_restart(&expected, |window| window.window_id == expected.window_id
                && window.window_instance.as_deref() == Some("incarnation"))
            .is_ok());
        expected.native_identity = "tauri:other".into();
        assert!(mode.prove_restart(&expected, |_| true).is_err());
        expected.native_identity = "tauri:test".into();
        expected.run_id = "another run".into();
        assert!(mode.prove_restart(&expected, |_| true).is_err());
    }

    #[test]
    fn reconnect_receipt_survives_lost_ack_but_expires_even_during_a_snapshot() {
        use std::cell::Cell;

        let mut mode = DeveloperMode::new("tauri:test".into(), None);
        let restart = DeveloperRestart {
            run_id: "old".into(),
            native_identity: "tauri:test".into(),
            window_id: "11111111-2222-4333-8444-555555555555".into(),
            window_instance: Some("old-incarnation".into()),
            restart_id: "7c3e5066-017d-4ce1-a371-187ac459c4b2".into(),
        };
        let started = Instant::now();
        mode.previous_restart = Some((restart.clone(), started));
        let clock = Cell::new(started + Duration::from_secs(95));
        let now = || clock.get();
        assert_eq!(
            mode.read_reconnect(&restart, now, || json!("starting")),
            Ok(json!("starting"))
        );
        clock.set(started + Duration::from_millis(189_999));
        assert_eq!(
            mode.read_reconnect(&restart, now, || json!("ready")),
            Ok(json!("ready"))
        );
        assert!(mode
            .read_reconnect(&restart, now, || {
                clock.set(started + Duration::from_secs(190));
                json!("late")
            })
            .is_err());
        assert!(mode
            .read_reconnect(&restart, now, || panic!("expired receipt reached snapshot"))
            .is_err());
    }

    #[test]
    fn startup_enables_local_instrumentation_without_a_marker_or_global_remote_flags() {
        let source = include_str!("main.rs");
        assert!(source.contains("configure_developer_environment();"));
        assert!(source.contains("configure_developer_webview(&scope)"));
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
