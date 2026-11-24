//! Host-owned configuration and appearance, independent of any project location.
pub mod config_files;
pub mod info;
pub mod memory;
mod opencode_actions;
mod providers;
pub mod remote;
pub mod stats;
use crate::{
    Wake,
    backend::{Backend, read_json},
    history::Result,
    recovery::Input,
    runtime, stream,
};
pub use opencode_actions::{install_opencode, local_opencode_offer, opencode_local};
pub(crate) use providers::provider_change;
pub use providers::{Provider, providers};
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering::SeqCst},
    },
    time::Duration,
};

async fn session_directory(backend: &Backend, workspace: &str, session: &str) -> Result<String> {
    if !crate::history::valid_id(workspace) || !crate::history::valid_id(session) {
        return Err("Invalid session Location".into());
    }
    let url = format!(
        "{}workspaces/{workspace}/instance/api/session/{session}",
        backend.base
    );
    let value = read_json(backend.client.get(url).send().await?.error_for_status()?).await?;
    let record = &value["data"];
    let location = &record["location"];
    if record["id"] != session || location.get("workspaceID").is_some() {
        return Err("Invalid session Location".into());
    }
    location["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
        .map(str::to_owned)
        .ok_or_else(|| "Invalid session directory".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Config,
    State,
    Server,
}
impl Owner {
    fn url(self, backend: &Backend) -> String {
        let path = match self {
            Self::Config => "api/storage/config/ui",
            Self::State => "api/storage/state/ui",
            Self::Server => "api/storage/config/server",
        };
        format!("{}{path}", backend.base)
    }

    pub async fn read(self, backend: &Backend) -> Result<Value> {
        let response = backend
            .client
            .get(self.url(backend))
            .query(&[("authoritative", "1")])
            .send()
            .await?
            .error_for_status()?;
        owner(read_json(response).await?)
    }

    pub async fn patch(self, backend: &Backend, patch: &Value) -> Result<Value> {
        let response = backend
            .client
            .patch(self.url(backend))
            .json(patch)
            .send()
            .await?
            .error_for_status()?;
        owner(read_json(response).await?)
    }
}

fn owner(value: Value) -> Result<Value> {
    if value.is_object() {
        Ok(value)
    } else {
        Err("Invalid preferences owner document".into())
    }
}

pub struct OpenCodeStatus {
    pub current: Option<String>,
    pub running: Option<String>,
    pub minimum: Option<String>,
    pub recommended: Option<String>,
    pub latest: Option<String>,
    pub update_available: bool,
    pub check_failed: bool,
    pub state: &'static str,
    pub restart: Option<&'static str>,
    pub can_upgrade: bool,
    pub needs_shared_installation: bool,
    pub foreign_installation: bool,
    pub binary_path: Option<String>,
}

pub async fn opencode_status(backend: &Backend, recheck: bool) -> Result<OpenCodeStatus> {
    let mut request = backend
        .client
        .get(format!("{}api/opencode/update", backend.base));
    // The host can spend 60 s on the release lookup before probing the daemon.
    #[cfg(not(target_arch = "wasm32"))]
    {
        request = request.timeout(Duration::from_secs(120));
    }
    if recheck {
        request = request.query(&[("recheck", "1")]);
    }
    open_code_status(read_json(request.send().await?.error_for_status()?).await?)
}

fn open_code_status(data: Value) -> Result<OpenCodeStatus> {
    let text = |name: &str| {
        data[name]
            .as_str()
            .filter(|value| {
                !value.is_empty() && value.len() <= 256 && !value.contains(char::is_control)
            })
            .map(str::to_owned)
    };
    let service = data["serviceState"].as_str();
    let state = match (data["state"].as_str(), service) {
        (_, Some("ready" | "restart_available")) => "connected",
        (_, Some("error")) => "serviceError",
        (_, Some("restart_required" | "incompatible")) => "update_required",
        (Some("ready"), _) => "disconnected",
        (Some("missing"), _) => "missing",
        (Some("update_required"), _) => "update_required",
        (Some("error"), _) => "error",
        _ => return Err("Invalid OpenCode status".into()),
    };
    Ok(OpenCodeStatus {
        state,
        restart: match service {
            Some("restart_available") => Some("settings.opencode.setup.restartAvailable"),
            Some("restart_required") => Some("settings.opencode.setup.restartRequired"),
            _ => None,
        },
        current: text("currentVersion"),
        running: text("daemonVersion"),
        minimum: text("minimumVersion"),
        recommended: text("recommendedVersion"),
        latest: text("latestVersion"),
        update_available: data["updateAvailable"] == true,
        check_failed: data["checkError"] == "update_check_failed",
        can_upgrade: data["canUpgrade"] == true && data["legacyReplacement"].is_null(),
        needs_shared_installation: data["needsSharedInstallation"] == true,
        foreign_installation: data["foreignInstallation"].is_object()
            && data["installationSource"] != "managed",
        binary_path: data["binaryPath"]
            .as_str()
            .filter(|p| !p.is_empty() && p.len() <= 32768 && !p.contains(char::is_control))
            .map(str::to_owned),
    })
}

#[cfg(test)]
#[test]
fn setup_status_distinguishes_daemon_from_executable_and_redacts_invalid_fields() {
    let data = serde_json::json!({
        "state":"ready", "serviceState":"stopped", "currentVersion":"2.3.0",
        "daemonVersion":"line\nbreak", "minimumVersion":"2.2.3"
    });
    let status = open_code_status(data).unwrap();
    assert_eq!(status.state, "disconnected");
    assert_eq!(status.current.as_deref(), Some("2.3.0"));
    assert!(status.running.is_none());
    assert!(open_code_status(serde_json::json!({"state":"unrecognized"})).is_err());
}

#[cfg(test)]
#[test]
fn setup_status_keeps_restart_decisions_separate_from_update_lookup() {
    for (service, state, label) in [
        (
            "restart_available",
            "connected",
            "settings.opencode.setup.restartAvailable",
        ),
        (
            "restart_required",
            "update_required",
            "settings.opencode.setup.restartRequired",
        ),
    ] {
        let status = open_code_status(serde_json::json!({
            "state":"ready", "serviceState":service, "currentVersion":"2.3.0",
            "daemonVersion":"2.2.5", "checkError":"update_check_failed"
        }))
        .unwrap();
        assert_eq!(status.state, state);
        assert_eq!(status.restart, Some(label));
        assert_eq!(status.running.as_deref(), Some("2.2.5"));
        assert!(status.check_failed);
        assert!(!status.update_available);
    }
}

/// Host preferences subscription with an optional workspace filter for Mission events.
pub struct PreferencesWatch {
    _cancel: crate::Sender<()>,
    closed: crate::Receiver<()>,
    dirty: Arc<AtomicU8>,
    missions: Arc<Mutex<Vec<crate::transport::WorkspaceEvent>>>,
    project: Option<String>,
}
impl PreferencesWatch {
    pub fn task(
        mut backend: Backend,
        project: Option<&str>,
        wake: Wake,
    ) -> (Self, impl std::future::Future<Output = ()> + 'static) {
        let (hold, cancel) = crate::bounded(1);
        let (close, closed) = crate::bounded(1);
        let dirty = Arc::new(AtomicU8::new(0));
        let notices = dirty.clone();
        let missions = Arc::new(Mutex::new(Vec::new()));
        let mission_notices = missions.clone();
        let project = project.map(str::to_owned);
        backend.workspace = project.clone().unwrap_or_default();
        backend.session.clear();
        backend.client_id.push_str("-preferences");
        let run = async move {
            futures_lite::future::race(
                async {
                    for epoch in 1u64.. {
                        let (output, events) = crate::bounded(16);
                        let state = stream::State::default();
                        let (result, ()) = futures_lite::future::zip(
                            async {
                                let output = output;
                                stream::read(&backend, epoch, &output, &state).await
                            },
                            async {
                                while let Ok(event) = events.recv().await {
                                    let flag = match event {
                                        Input::Opened(e) => {
                                            notices.fetch_and(!64, SeqCst);
                                            if e > 1 { 11 | 16 | 32 | 128 } else { 11 | 32 | 128 }
                                        }
                                        Input::Unavailable(_) => {
                                            notices.fetch_and(!(16 | 128), SeqCst);
                                            64
                                        }
                                        Input::Available(_, _) => {
                                            notices.fetch_and(!64, SeqCst);
                                            11 | 16 | 32 | 128
                                        }
                                        Input::Preferences(Owner::Config) => 1,
                                        Input::Preferences(Owner::State) => 2,
                                        Input::Preferences(Owner::Server) => 32,
                                        Input::Workspace(
                                            _,
                                            crate::transport::WorkspaceEvent::MemoryChanged,
                                        ) => 8,
                                        Input::Workspace(_, event @ (crate::transport::WorkspaceEvent::MissionChanged { .. }
                                            | crate::transport::WorkspaceEvent::MissionsReconnected { .. }
                                            | crate::transport::WorkspaceEvent::MissionActivityChanged { .. })) => {
                                            let mut batch = mission_notices.lock().unwrap();
                                            let overflow = if batch.len() == 128 { batch.clear(); true } else { false };
                                            batch.push(event);
                                            drop(batch);
                                            wake();
                                            if overflow { 16 } else { 0 }
                                        }
                                        _ => 0,
                                    };
                                    if flag != 0 && notices.fetch_or(flag, SeqCst) & flag != flag {
                                        wake();
                                    }
                                }
                            },
                        )
                        .await;
                        notices.fetch_and(!(16 | 128), SeqCst);
                        if notices.fetch_or(64, SeqCst) & 64 == 0 {
                            wake();
                        }
                        if result
                            .as_ref()
                            .is_err_and(crate::http::authentication_expired)
                        {
                            notices.fetch_or(4, SeqCst);
                            break;
                        }
                        runtime::sleep(Duration::from_millis(250 * (1 << epoch.min(5)))).await;
                    }
                },
                async {
                    let _ = cancel.recv().await;
                },
            )
            .await;
            // The EventSource/HTTP response has been dropped before releasing the next reader.
            drop(close);
            wake();
        };
        (
            Self {
                _cancel: hold,
                closed,
                dirty,
                missions,
                project,
            },
            run,
        )
    }

    pub fn take(&self) -> (bool, bool) {
        let bits = self.dirty.fetch_and(!3, SeqCst);
        (bits & 1 != 0, bits & 2 != 0)
    }

    pub fn take_authentication_required(&self) -> bool {
        self.dirty.fetch_and(!4, SeqCst) & 4 != 0
    }

    pub fn take_memory_changed(&self) -> bool {
        self.dirty.fetch_and(!8, SeqCst) & 8 != 0
    }

    pub fn take_missions(&self) -> (bool, Vec<crate::transport::WorkspaceEvent>) {
        let reconnect = self.dirty.fetch_and(!16, SeqCst) & 16 != 0;
        (
            reconnect,
            std::mem::take(&mut *self.missions.lock().unwrap()),
        )
    }

    pub fn take_stream_state(&self) -> Option<bool> {
        let bits = self.dirty.fetch_and(!(64 | 128), SeqCst);
        if bits & 64 != 0 {
            Some(false)
        } else if bits & 128 != 0 {
            Some(true)
        } else {
            None
        }
    }

    pub fn project(&self) -> Option<&str> {
        self.project.as_deref()
    }

    pub fn take_server_changed(&self) -> bool {
        self.dirty.fetch_and(!32, SeqCst) & 32 != 0
    }

    pub fn stop(self) -> crate::Receiver<()> {
        self.closed
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod watch_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn preferences_watch_reports_upstream_instance_unavailable_and_available() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (tx_ev, mut rx_ev) = tokio::sync::mpsc::unbounded_channel::<String>();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n",
                    )
                    .await
                    .unwrap();
                stream.flush().await.unwrap();
                while let Some(chunk) = rx_ev.recv().await {
                    if stream.write_all(chunk.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stream.flush().await;
                }
            });
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let (notify, woken) = crate::bounded(16);
            let wake: Wake = Arc::new(move || {
                let _ = notify.try_send(());
            });
            let (watch, task) = PreferencesWatch::task(backend, Some("ws-1"), wake);
            let handle = tokio::spawn(task);

            // First event opens the SSE stream -> online (Some(true)).
            tx_ev
                .send(
                    "data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"ws-1\",\"status\":\"connected\"}\n\n"
                        .into(),
                )
                .unwrap();
            let mut opened = false;
            for _ in 0..40 {
                if watch.take_stream_state() == Some(true) {
                    opened = true;
                    break;
                }
                let _ = tokio::time::timeout(Duration::from_millis(25), woken.recv()).await;
            }
            assert!(opened, "watch should report online after opening");

            // Upstream disconnect without closing outer SSE -> offline (Some(false)).
            tx_ev
                .send(
                    "data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"ws-1\",\"status\":\"disconnected\"}\n\n"
                        .into(),
                )
                .unwrap();
            let mut offline = false;
            for _ in 0..40 {
                if watch.take_stream_state() == Some(false) {
                    offline = true;
                    break;
                }
                let _ = tokio::time::timeout(Duration::from_millis(25), woken.recv()).await;
            }
            assert!(
                offline,
                "owned instance.eventStatus disconnected must report offline while outer SSE stays open"
            );

            // Upstream reconnect -> online (Some(true)) + reconnect notice.
            tx_ev
                .send(
                    "data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"ws-1\",\"status\":\"connected\"}\n\n"
                        .into(),
                )
                .unwrap();
            let mut reconnected = false;
            for _ in 0..40 {
                if watch.take_stream_state() == Some(true) {
                    reconnected = true;
                    break;
                }
                let _ = tokio::time::timeout(Duration::from_millis(25), woken.recv()).await;
            }
            assert!(reconnected, "upstream connected must restore online state");

            drop(tx_ev);
            let closed = watch.stop();
            let _ = tokio::time::timeout(Duration::from_secs(2), closed.recv()).await;
            handle.abort();
            server.abort();
        });
    }
}
