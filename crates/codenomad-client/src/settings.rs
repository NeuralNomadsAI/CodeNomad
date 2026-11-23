//! Host-owned configuration and appearance, independent of any project location.
mod providers;
use crate::{
    Wake,
    backend::{Backend, read_json},
    history::Result,
    recovery::Input,
    runtime, stream,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Config,
    State,
}
impl Owner {
    fn url(self, backend: &Backend) -> String {
        let path = match self {
            Self::Config => "api/storage/config/ui",
            Self::State => "api/storage/state/ui",
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

/// One scope-less subscription per connected host, independent of conversation lifetimes.
pub struct PreferencesWatch {
    _cancel: crate::Sender<()>,
    closed: crate::Receiver<()>,
    dirty: Arc<AtomicU8>,
    missions: Arc<Mutex<Vec<crate::transport::WorkspaceEvent>>>,
}
impl PreferencesWatch {
    pub fn task(mut backend: Backend, wake: Wake) -> (Self, impl std::future::Future<Output = ()>) {
        let (hold, cancel) = crate::bounded(1);
        let (close, closed) = crate::bounded(1);
        let dirty = Arc::new(AtomicU8::new(0));
        let notices = dirty.clone();
        let missions = Arc::new(Mutex::new(Vec::new()));
        let mission_notices = missions.clone();
        backend.workspace.clear();
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
                                        Input::Opened(e) => if e > 1 { 3 | 8 } else { 3 },
                                        Input::Preferences(Owner::Config) => 1,
                                        Input::Preferences(Owner::State) => 2,
                                        Input::Workspace(_, event @ (crate::transport::WorkspaceEvent::MissionChanged { .. }
                                            | crate::transport::WorkspaceEvent::MissionsReconnected { .. }
                                            | crate::transport::WorkspaceEvent::MissionActivityChanged { .. })) => {
                                            let mut batch = mission_notices.lock().unwrap();
                                            let overflow = if batch.len() == 128 { batch.clear(); true } else { false };
                                            batch.push(event);
                                            drop(batch);
                                            wake();
                                            if overflow { 8 } else { 0 }
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

    pub fn take_missions(&self) -> (bool, Vec<crate::transport::WorkspaceEvent>) {
        let reconnect = self.dirty.fetch_and(!8, SeqCst) & 8 != 0;
        (
            reconnect,
            std::mem::take(&mut *self.missions.lock().unwrap()),
        )
    }

    pub fn stop(self) -> crate::Receiver<()> {
        self.closed
    }
}
