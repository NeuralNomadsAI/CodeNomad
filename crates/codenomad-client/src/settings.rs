//! Host-owned configuration and appearance, independent of any project location.
pub mod config_files;
pub mod images;
pub mod info;
pub mod integrations;
pub mod memory;
pub mod missions;
mod opencode_actions;
pub mod provider_auth;
mod providers;
pub mod remote;
pub mod speech;
pub mod stats;
pub mod websearch;
use crate::{
    Wake,
    backend::{Backend, read_json},
    history::Result,
    recovery::Input,
    runtime, stream,
};
pub use opencode_actions::{
    BinaryValidation, LoginStartError, LoginStartState, OpenCodeLogs, install_opencode,
    local_opencode_offer, opencode_local, opencode_login_start, opencode_logs,
    set_opencode_login_start, validate_opencode_binary,
};
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
#[derive(Debug)]
pub enum PatchOutcome {
    Applied(Value),
    Rejected,
    Uncertain,
}

impl Owner {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::Config => 0,
            Self::State => 1,
            Self::Server => 2,
        }
    }

    fn url(self, backend: &Backend) -> String {
        let path = match self {
            Self::Config => "api/storage/config/ui",
            Self::State => "api/storage/state/ui",
            Self::Server => "api/storage/config/server",
        };
        format!("{}{path}", backend.base)
    }

    pub async fn read(self, backend: &Backend) -> Result<Value> {
        let request = backend
            .client
            .get(self.url(backend))
            .query(&[("authoritative", "1")])
            .header(reqwest::header::CACHE_CONTROL, "no-store");
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_cache_no_store();
        let response = request.send().await?.error_for_status()?;
        self.validate(read_json(response).await?)
    }

    pub async fn patch(self, backend: &Backend, patch: &Value, atomic: bool) -> PatchOutcome {
        let mut request = backend.client.patch(self.url(backend)).json(patch);
        let atomic_query =
            atomic || (self == Self::Server && patch.get("secureEnvVarsMask").is_some());
        let stamp = atomic_query.then(|| backend.client.observed_capability_stamp());
        if atomic_query {
            request = request.query(&[("conditional", "atomic-v1")]);
        }
        let Ok(response) = request.send().await else {
            return PatchOutcome::Uncertain;
        };
        if let Some((generation, seq)) = stamp
            && response.status() == reqwest::StatusCode::BAD_REQUEST
        {
            backend.client.revoke_server_attestation_at(generation, seq);
            return PatchOutcome::Rejected;
        }
        let Ok(response) = response.error_for_status() else {
            return PatchOutcome::Uncertain;
        };
        match read_json(response).await.and_then(|v| self.validate(v)) {
            Ok(value) => PatchOutcome::Applied(value),
            Err(_) => PatchOutcome::Uncertain,
        }
    }

    fn validate(self, value: Value) -> Result<Value> {
        let valid = value.as_object().is_some_and(|map| match self {
            Self::Config => map.get("settings").is_none_or(Value::is_object),
            Self::State | Self::Server => true,
        });
        if valid {
            Ok(value)
        } else {
            Err("Invalid preferences owner document".into())
        }
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
    pub has_installation_source: bool,
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
        has_installation_source: data["installationSource"]
            .as_str()
            .is_some_and(|source| !source.is_empty()),
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
    connected: Arc<std::sync::atomic::AtomicBool>,
    missions: Arc<Mutex<Vec<crate::transport::WorkspaceEvent>>>,
    client_id: String,
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
        let connected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let connected_state = connected.clone();
        let missions = Arc::new(Mutex::new(Vec::new()));
        let mission_notices = missions.clone();
        let project = project.map(str::to_owned);
        backend.workspace = project.clone().unwrap_or_default();
        backend.session.clear();
        backend.client_id.push_str("-preferences");
        let client_id = backend.client_id.clone();
        let run = async move {
            let mut disconnected = false;
            for epoch in 1u64.. {
                if cancel.is_closed() {
                    break;
                }
                if backend.client.tracks_server_attestation()
                    || (epoch > 1 && backend.client.needs_capability_recheck())
                {
                    enum Attest {
                        Done(crate::history::Result<()>),
                        Cancelled,
                    }
                    let outcome = futures_lite::future::or(
                        async {
                            let _ = cancel.recv().await;
                            Attest::Cancelled
                        },
                        async { Attest::Done(backend.attest_server().await.map(|_| ())) },
                    )
                    .await;
                    match outcome {
                        Attest::Cancelled => break,
                        Attest::Done(Ok(())) => {}
                        Attest::Done(Err(err)) => {
                            if crate::http::authentication_expired(&err) {
                                notices.fetch_or(4, SeqCst);
                                break;
                            }
                            if !disconnected {
                                disconnected = true;
                                if notices.fetch_or(64, SeqCst) & 64 == 0 {
                                    wake();
                                }
                            }
                            futures_lite::future::or(
                                async {
                                    let _ = cancel.recv().await;
                                },
                                runtime::sleep(Duration::from_millis(250 * (1 << epoch.min(5)))),
                            )
                            .await;
                            continue;
                        }
                    }
                }
                let (output, events) = crate::bounded(16);
                let state = Arc::new(stream::State::default());
                let cancel_state = state.clone();
                let cancel_watch = cancel.clone();
                let (done_watch_tx, done_watch_rx) = crate::bounded::<()>(1);
                let mut opened = false;
                let (result, ((), ())) = futures_lite::future::zip(
                    async {
                        let output = output;
                        let res = stream::read(&backend, epoch, &output, &state).await;
                        drop(done_watch_tx);
                        res
                    },
                    futures_lite::future::zip(
                        async {
                            while let Ok(event) = events.recv().await {
                                let flag = match event {
                                    Input::Opened(e) => {
                                        opened = true;
                                        connected_state.store(true, SeqCst);
                                        if e > 1 { 11 | 16 | 32 } else { 11 | 32 }
                                    }
                                    Input::Hint(_, _, _) => 11 | 16 | 32,
                                    Input::Preferences(Owner::Config) => 1,
                                    Input::Preferences(Owner::State) => 2,
                                    Input::Preferences(Owner::Server) => 32,
                                    Input::Workspace(
                                        _,
                                        crate::transport::WorkspaceEvent::MemoryChanged,
                                    ) => 8,
                                    Input::Workspace(
                                        _,
                                        event @ (crate::transport::WorkspaceEvent::MissionChanged { .. }
                                        | crate::transport::WorkspaceEvent::MissionsReconnected { .. }
                                        | crate::transport::WorkspaceEvent::MissionActivityChanged {
                                            ..
                                        }),
                                    ) => {
                                        let mut batch = mission_notices.lock().unwrap();
                                        let overflow = if batch.len() == 128 {
                                            batch.clear();
                                            true
                                        } else {
                                            false
                                        };
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
                        async {
                            futures_lite::future::or(
                                async {
                                    let _ = cancel_watch.recv().await;
                                    cancel_state.cancel();
                                },
                                async {
                                    let _ = done_watch_rx.recv().await;
                                },
                            )
                            .await;
                        },
                    ),
                )
                .await;
                connected_state.store(false, SeqCst);
                if cancel.is_closed() || state.is_cancelled() {
                    break;
                }
                if opened {
                    disconnected = false;
                }
                if result
                    .as_ref()
                    .is_err_and(crate::http::authentication_expired)
                {
                    notices.fetch_or(4, SeqCst);
                    break;
                }
                if !disconnected {
                    disconnected = true;
                    if notices.fetch_or(64, SeqCst) & 64 == 0 {
                        wake();
                    }
                }
                futures_lite::future::or(
                    async {
                        let _ = cancel.recv().await;
                    },
                    runtime::sleep(Duration::from_millis(250 * (1 << epoch.min(5)))),
                )
                .await;
            }
            // The EventSource/HTTP response has been dropped before releasing the next reader.
            connected_state.store(false, SeqCst);
            drop(close);
            wake();
        };
        (
            Self {
                _cancel: hold,
                closed,
                dirty,
                connected,
                missions,
                client_id,
                project,
            },
            run,
        )
    }

    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(SeqCst)
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

    pub fn project(&self) -> Option<&str> {
        self.project.as_deref()
    }

    pub fn take_server_changed(&self) -> bool {
        self.dirty.fetch_and(!32, SeqCst) & 32 != 0
    }

    pub fn take_disconnected(&self) -> bool {
        self.dirty.fetch_and(!64, SeqCst) & 64 != 0
    }

    pub fn stop(self) -> crate::Receiver<()> {
        self.closed
    }
}
