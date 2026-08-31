use serde::Serialize;
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const RESTART_DELAY: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeveloperModeState {
    pub(crate) enabled: bool,
    pub(crate) active: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum DeveloperTargetState {
    Stopped,
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
    active: bool,
    run_id: String,
    native_identity: String,
    devtools_active_port: Option<PathBuf>,
    marker_path: PathBuf,
}

pub(crate) fn marker_path(home: &Path) -> PathBuf {
    home.join(".config")
        .join("codenomad")
        .join("developer-mode")
}

pub(crate) fn read_enabled(marker_path: &Path) -> bool {
    marker_path.exists()
}

fn write_enabled(enabled: bool, marker_path: &Path) -> io::Result<()> {
    if !enabled {
        return match std::fs::remove_file(marker_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
    }

    let parent = marker_path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "marker path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut marker = options.open(marker_path)?;
    marker.write_all(b"enabled\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        marker.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
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
        active: bool,
        native_identity: String,
        devtools_active_port: Option<PathBuf>,
        marker_path: PathBuf,
    ) -> Self {
        Self {
            active,
            run_id: uuid::Uuid::new_v4().to_string(),
            native_identity,
            devtools_active_port,
            marker_path,
        }
    }

    pub(crate) fn state(&self) -> DeveloperModeState {
        DeveloperModeState {
            enabled: read_enabled(&self.marker_path),
            active: self.active,
        }
    }

    pub(crate) fn set_enabled(&self, enabled: bool) -> io::Result<DeveloperModeState> {
        write_enabled(enabled, &self.marker_path)?;
        Ok(self.state())
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
        if !self.active {
            return DeveloperTargetStatus {
                state: DeveloperTargetState::Stopped,
                run_id: None,
                native_identity: None,
                cdp_url: None,
                window_id: None,
            };
        }
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
            window_id: if ready { window_id } else { None },
        }
    }

    fn focused_window_id(app: &AppHandle) -> Option<String> {
        crate::local_windows::focused_local_window(app)
            .and_then(|window| crate::identity::local_window_id(window.label()).ok())
    }

    pub(crate) fn native_snapshot(&self, app: &AppHandle) -> Value {
        let port = self.discovered_port();
        let window_id = (self.active && port.is_some())
            .then(|| Self::focused_window_id(app))
            .flatten();
        json!({ "status": self.status(port, window_id), "logs": [] })
    }

    pub(crate) fn request_restart(&self, app: &AppHandle) -> Result<Value, String> {
        if !self.active {
            return Err("Developer Mode is not active".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_defaults_disabled_and_persists_transitions() {
        let home = tempfile::tempdir().unwrap();
        let marker = marker_path(home.path());
        let mode = DeveloperMode::new(false, "tauri:test".to_string(), None, marker.clone());

        assert_eq!(marker, home.path().join(".config/codenomad/developer-mode"));
        assert_eq!(
            mode.state(),
            DeveloperModeState {
                enabled: false,
                active: false
            }
        );
        assert_eq!(mode.set_enabled(true).unwrap().enabled, true);
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "enabled\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(mode.set_enabled(false).unwrap().enabled, false);
        assert!(!marker.exists());
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
        let mut mode = DeveloperMode {
            active: true,
            run_id: "run-1".to_string(),
            native_identity: "tauri:test".to_string(),
            devtools_active_port: Some(devtools_active_port),
            marker_path: PathBuf::new(),
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
        mode.active = false;
        assert_eq!(
            json!(mode.status(mode.discovered_port(), None)),
            json!({ "state": "stopped" })
        );
    }
}
