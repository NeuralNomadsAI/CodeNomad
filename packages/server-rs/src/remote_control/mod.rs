//! Remote Control tunnel lifecycle, launch resume, owner lease and local control routes.
pub mod ingress;
pub mod lease;
pub mod tunnel;

#[cfg(test)]
mod tests;

use std::{
    path::Path,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use axum::{
    Json,
    extract::State,
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{Shared, auth::devices::direct_origin};
use ingress::RemoteIngress;
use lease::OwnerLease;
use tunnel::{OpenRequest, TunnelOpener, TunnelSession, TunnelState};

pub const REMOTE_CONTROL_DISABLED: &str = "Remote Control is disabled by the administrator";

struct ActiveTunnel {
    id: u64,
    generation: u64,
    hostname: String,
    url: String,
    session: Arc<dyn TunnelSession>,
}

struct InFlightStart {
    generation: u64,
    cancel: CancellationToken,
    result: watch::Receiver<Option<Result<Arc<ActiveTunnel>, String>>>,
    cleanup: watch::Receiver<bool>,
}

#[derive(Default)]
struct ManagerState {
    generation: u64,
    next_tunnel_id: u64,
    next_close_id: u64,
    active_starts: usize,
    shutting_down: bool,
    enabled: bool,
    error: Option<String>,
    last_connected_at: Option<String>,
    tunnel: Option<Arc<ActiveTunnel>>,
    starting: Option<InFlightStart>,
    closing: Option<(u64, watch::Receiver<bool>)>,
}

impl ManagerState {
    fn register_closing(&mut self, rx: watch::Receiver<bool>) -> (u64, Option<watch::Receiver<bool>>) {
        self.next_close_id = self.next_close_id.wrapping_add(1);
        let id = self.next_close_id;
        let prev = self.closing.replace((id, rx)).map(|(_, prev_rx)| prev_rx);
        (id, prev)
    }

    fn finish_closing(&mut self, close_id: u64) {
        if self.closing.as_ref().is_some_and(|(id, _)| *id == close_id) {
            self.closing = None;
        }
    }
}

struct CleanupGuard(watch::Sender<bool>);
impl Drop for CleanupGuard {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

/// Ensures `state.starting`, `active_starts`, `result_tx`, lease, and ingress settle even if the
/// start task panics.
struct StartingGuard {
    app: Shared,
    generation: u64,
    result_tx: watch::Sender<Option<Result<Arc<ActiveTunnel>, String>>>,
    settled: bool,
    _cleanup: CleanupGuard,
}

impl StartingGuard {
    fn finish(mut self, outcome: Result<Arc<ActiveTunnel>, String>) {
        self.settled = true;
        {
            let mut state = self.app.remote_control.state.lock().unwrap_or_else(|e| e.into_inner());
            state.active_starts = state.active_starts.saturating_sub(1);
            if state.starting.as_ref().is_some_and(|s| s.generation == self.generation) {
                state.starting = None;
            }
            self.app.remote_control.release_lease_if_idle(&state);
        }
        let _ = self.result_tx.send(Some(outcome));
    }
}

impl Drop for StartingGuard {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let msg = "Remote Control start aborted".to_owned();
        let _ = self.result_tx.send(Some(Err(msg.clone())));
        let cleanup_info = {
            let mut state = self.app.remote_control.state.lock().unwrap_or_else(|e| e.into_inner());
            state.active_starts = state.active_starts.saturating_sub(1);
            if state.starting.as_ref().is_some_and(|s| s.generation == self.generation) {
                state.starting = None;
            }
            if state.generation == self.generation {
                if state.enabled {
                    state.enabled = false;
                    state.error = Some(msg);
                }
                let (close_tx, close_rx) = watch::channel(false);
                let (close_id, prev_closing) = state.register_closing(close_rx);
                Some((close_id, close_tx, prev_closing))
            } else {
                self.app.remote_control.release_lease_if_idle(&state);
                None
            }
        };
        if let Some((close_id, close_tx, prev_closing)) = cleanup_info {
            let app = self.app.clone();
            let generation = self.generation;
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let _done = CleanupGuard(close_tx);
                    if let Some(mut prev) = prev_closing {
                        let _ = prev.wait_for(|&done| done).await;
                    }
                    app.remote_control.ingress.stop_up_to(generation).await;
                    let mut state = app.remote_control.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.finish_closing(close_id);
                    app.remote_control.release_lease_if_idle(&state);
                });
            } else {
                let mut state = self.app.remote_control.state.lock().unwrap_or_else(|e| e.into_inner());
                state.finish_closing(close_id);
                self.app.remote_control.release_lease_if_idle(&state);
                let _ = close_tx.send(true);
            }
        }
    }
}

#[derive(Debug)]
pub enum StartError {
    Disabled,
    Failed(String),
}

pub struct Manager {
    state: Mutex<ManagerState>,
    ingress: Arc<RemoteIngress>,
    lease: RwLock<OwnerLease>,
    opener: RwLock<TunnelOpener>,
    api: RwLock<Option<String>>,
    #[cfg(test)]
    prior_wait: RwLock<Duration>,
}

impl Manager {
    pub fn new(data: &Path) -> Self {
        Self {
            state: Mutex::new(ManagerState::default()),
            ingress: Arc::new(RemoteIngress::default()),
            lease: RwLock::new(OwnerLease::new(data)),
            opener: RwLock::new(tunnel::default_opener()),
            api: RwLock::new(crate::config::remote_control_api()),
            #[cfg(test)]
            prior_wait: RwLock::new(Duration::from_secs(15)),
        }
    }

    /// Releases the owner lease only when no tunnel is desired, live, starting, or closing.
    /// Always called while holding `self.state` so acquire/release never race.
    fn release_lease_if_idle(&self, state: &ManagerState) {
        let closing_active = state.closing.as_ref().is_some_and(|(_, rx)| !*rx.borrow());
        if !state.enabled && state.tunnel.is_none() && state.active_starts == 0 && !closing_active {
            self.lease.read().unwrap_or_else(|e| e.into_inner()).release();
        }
    }

    fn prior_wait(&self) -> Duration {
        #[cfg(test)]
        {
            *self.prior_wait.read().unwrap()
        }
        #[cfg(not(test))]
        {
            Duration::from_secs(15)
        }
    }

    pub fn attach_router(&self, router: axum::Router) {
        self.ingress.attach_router(router);
    }

    pub fn ingress_port(&self) -> Option<u16> {
        self.ingress.port()
    }

    #[cfg(test)]
    pub(crate) fn set_opener(&self, opener: TunnelOpener) {
        *self.opener.write().unwrap() = opener;
    }

    #[cfg(test)]
    pub(crate) fn set_lease(&self, lease: OwnerLease) {
        *self.lease.write().unwrap() = lease;
    }

    #[cfg(test)]
    pub(crate) fn set_prior_wait(&self, timeout: Duration) {
        *self.prior_wait.write().unwrap() = timeout;
    }

    pub fn is_tunnel_active(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.enabled && state.tunnel.is_some()
    }

    pub fn tunnel_url(&self) -> Option<String> {
        let state = self.state.lock().unwrap();
        (state.enabled).then(|| state.tunnel.as_ref().map(|t| t.url.clone())).flatten()
    }

    pub fn tunnel_hostname(&self) -> Option<String> {
        let state = self.state.lock().unwrap();
        (state.enabled).then(|| state.tunnel.as_ref().map(|t| t.hostname.clone())).flatten()
    }

    pub fn is_preview_device_authorized(&self, app: &crate::App, id: Uuid, host: &str, ingress: bool) -> bool {
        let Some(devices) = &app.devices else {
            return false;
        };
        // Read `state` before locking `devices` to preserve the global `state -> devices` lock order.
        let tunnel_host = ingress.then(|| self.tunnel_hostname()).flatten();
        let d = devices.lock().unwrap();
        if !d.previews_allowed_for_remote() {
            return false;
        }
        if ingress {
            if let Some(tunnel_host) = tunnel_host {
                return tunnel_host == host && d.is_paired(id, None);
            }
            // Preserves bench fixture ingress mode (`CNRS_FIXTURE_INGRESS=1`).
            return d.ingress && d.is_paired(id, None);
        }
        let origin = format!("https://{host}");
        d.origins.iter().any(|o| o == &origin) && direct_origin(&origin) && d.is_paired(id, Some(&origin))
    }

    pub fn status(&self, app: &crate::App, local: bool) -> Value {
        let (disabled_by_admin, starts_on_launch, previews, paired, origins) = match &app.devices {
            Some(devices) => {
                let d = devices.lock().unwrap();
                let origins: Vec<String> = if d.ingress {
                    Vec::new()
                } else {
                    d.origins.iter().filter(|o| direct_origin(o)).cloned().collect()
                };
                (d.disabled_by_admin, d.starts_on_launch(), d.previews_allowed(), d.paired_count(), origins)
            }
            None => {
                (crate::config::remote_control().trim().eq_ignore_ascii_case("disabled"), false, false, 0, Vec::new())
            }
        };
        let (enabled, remote_url, last_connected_at, error, state_str) = {
            let state = self.state.lock().unwrap();
            let tunnel_state = state.tunnel.as_ref().map(|t| t.session.state());
            let state_str = if !state.enabled {
                if state.error.is_some() { "error" } else { "stopped" }
            } else if let Some(ts) = tunnel_state {
                match ts {
                    TunnelState::Connecting => "connecting",
                    TunnelState::Connected => "connected",
                    TunnelState::Reconnecting => "reconnecting",
                    TunnelState::Stopped => "error",
                }
            } else {
                "connecting"
            };
            (
                state.enabled,
                state.tunnel.as_ref().map(|t| t.url.clone()),
                state.last_connected_at.clone(),
                state.error.clone(),
                state_str,
            )
        };
        let mut out = json!({
            "manageable": local,
            "enabled": enabled,
            "startsOnLaunch": !disabled_by_admin && starts_on_launch,
            "previews": previews,
            "state": state_str,
            "pairedDevices": paired,
        });
        if disabled_by_admin {
            out["disabledByAdministrator"] = json!(true);
        }
        if let Some(url) = remote_url {
            out["remoteUrl"] = json!(url);
        }
        if let Some(ts) = last_connected_at {
            out["lastConnectedAt"] = json!(ts);
        }
        if let Some(err) = error {
            out["error"] = json!(err);
        }
        if local && !origins.is_empty() {
            out["directOrigins"] = json!(origins);
        }
        out
    }

    pub async fn start(&self, app: &Shared) -> Result<Value, StartError> {
        let Some(devices) = &app.devices else {
            return Err(StartError::Failed("Remote Control registry unavailable".into()));
        };
        // Serialize `startsOnLaunch` persistence with `state` transitions (`state -> devices` order)
        // so concurrent `start`, `stop`, and `shutdown` can never invert persisted vs live state.
        {
            let mut state = self.state.lock().unwrap();
            if state.shutting_down {
                return Err(StartError::Failed("Remote Control is shutting down".into()));
            }
            let mut d = devices.lock().unwrap();
            if d.disabled_by_admin {
                return Err(StartError::Disabled);
            }
            d.set_starts_on_launch(true).map_err(|e| StartError::Failed(e.to_string()))?;
            drop(d);
            if !state.enabled {
                state.generation = state.generation.wrapping_add(1);
                state.enabled = true;
            }
            state.error = None;
            // Explicit Start proceeds even if another backend holds the launch lease; acquire
            // under `state` lock so it is serialized with `release_lease_if_idle`.
            let _ = self.lease.read().unwrap().try_acquire();
        }
        let tunnel = self.ensure_tunnel(app).await.map_err(StartError::Failed)?;
        let pairing = {
            let state = self.state.lock().unwrap();
            if state.shutting_down || !state.enabled || state.tunnel.as_ref().is_none_or(|t| t.id != tunnel.id) {
                return Err(StartError::Failed("Remote Control was stopped".into()));
            }
            let mut d = devices.lock().unwrap();
            d.issue_tunnel(&tunnel.url).map_err(|e| StartError::Failed(e.to_string()))?
        };
        Ok(json!({ "status": self.status(app, true), "pairing": pairing }))
    }

    /// Reconnects at launch when the user left Remote Control on. Issues no pairing code.
    pub async fn resume(&self, app: &Shared) {
        let Some(devices) = &app.devices else {
            return;
        };
        {
            let mut state = self.state.lock().unwrap();
            if state.shutting_down || state.enabled {
                return;
            }
            let d = devices.lock().unwrap();
            if d.disabled_by_admin || !d.starts_on_launch() {
                return;
            }
            drop(d);
            if !self.lease.read().unwrap().try_acquire() {
                return;
            }
            state.generation = state.generation.wrapping_add(1);
            state.enabled = true;
            state.error = None;
        }
        // Failure is surfaced through `status()`; `startsOnLaunch` stays true until explicit Stop.
        let _ = self.ensure_tunnel(app).await;
    }

    pub async fn stop(&self, app: &Shared) -> Result<Value, String> {
        let (close_tx, mut close_rx) = watch::channel(false);
        let (stop_gen, close_id, tunnel, prev_cleanup, prev_closing, persist_err) = {
            let mut state = self.state.lock().unwrap();
            let persist_err = app
                .devices
                .as_ref()
                .and_then(|devices| devices.lock().unwrap().set_starts_on_launch(false).err().map(|e| e.to_string()));
            state.enabled = false;
            state.error = None;
            state.generation = state.generation.wrapping_add(1);
            let prev_cleanup = state.starting.as_ref().map(|s| {
                s.cancel.cancel();
                s.cleanup.clone()
            });
            let (close_id, prev_closing) = state.register_closing(close_rx.clone());
            (state.generation, close_id, state.tunnel.take(), prev_cleanup, prev_closing, persist_err)
        };
        self.spawn_release(app, stop_gen, close_id, tunnel, prev_cleanup, prev_closing, close_tx);
        let closed = tokio::time::timeout(Duration::from_secs(15), close_rx.wait_for(|&done| done)).await.is_ok();
        if let Some(err) = persist_err {
            return Err(err);
        }
        if !closed {
            return Err("Remote Control tunnel is still closing".into());
        }
        Ok(self.status(app, true))
    }

    /// Stops the tunnel and ingress on server exit without clearing `startsOnLaunch`.
    pub async fn shutdown(&self, app: &Shared) {
        let (close_tx, mut close_rx) = watch::channel(false);
        let (stop_gen, close_id, tunnel, prev_cleanup, prev_closing) = {
            let mut state = self.state.lock().unwrap();
            state.shutting_down = true;
            state.enabled = false;
            state.generation = state.generation.wrapping_add(1);
            let prev_cleanup = state.starting.as_ref().map(|s| {
                s.cancel.cancel();
                s.cleanup.clone()
            });
            let (close_id, prev_closing) = state.register_closing(close_rx.clone());
            (state.generation, close_id, state.tunnel.take(), prev_cleanup, prev_closing)
        };
        app.previews.revoke_devices();
        if let Some(devices) = &app.devices {
            devices.lock().unwrap().drop_all_principals();
        }
        self.spawn_release(app, stop_gen, close_id, tunnel, prev_cleanup, prev_closing, close_tx);
        // Bound server exit wait while leaving `close_rx` false (and the lease unreleased) if
        // teardown has not actually completed yet.
        let _ = tokio::time::timeout(Duration::from_secs(15), close_rx.wait_for(|&done| done)).await;
    }

    /// Runs teardown to true completion in a dedicated task: `close_tx` becomes `true` and the
    /// launch lease is released ONLY after prior cleanup, prior closing, bridge close, and ingress
    /// shutdown have all actually finished (never on a caller timeout).
    #[allow(clippy::too_many_arguments)]
    fn spawn_release(
        &self,
        app: &Shared,
        stop_gen: u64,
        close_id: u64,
        tunnel: Option<Arc<ActiveTunnel>>,
        prev_cleanup: Option<watch::Receiver<bool>>,
        prev_closing: Option<watch::Receiver<bool>>,
        close_tx: watch::Sender<bool>,
    ) {
        if let Some(devices) = &app.devices {
            let mut d = devices.lock().unwrap();
            d.cancel_tunnel_pairing();
            d.drop_tunnel_principals();
        }
        app.previews.revoke_tunnel_devices();
        let app = app.clone();
        tokio::spawn(async move {
            let _done = CleanupGuard(close_tx);
            if let Some(mut cleanup) = prev_cleanup {
                let _ = cleanup.wait_for(|&done| done).await;
            }
            if let Some(mut closing) = prev_closing {
                let _ = closing.wait_for(|&done| done).await;
            }
            let close_tunnel = async {
                if let Some(tunnel) = tunnel {
                    tunnel.session.close().await;
                }
            };
            tokio::join!(close_tunnel, app.remote_control.ingress.stop_up_to(stop_gen));
            let mut state = app.remote_control.state.lock().unwrap_or_else(|e| e.into_inner());
            state.finish_closing(close_id);
            app.remote_control.release_lease_if_idle(&state);
        });
    }

    async fn ensure_tunnel(&self, app: &Shared) -> Result<Arc<ActiveTunnel>, String> {
        let mut result_rx = {
            let mut state = self.state.lock().unwrap();
            if state.shutting_down {
                return Err("Remote Control is shutting down".to_owned());
            }
            if let Some(tunnel) = state.tunnel.clone() {
                return Ok(tunnel);
            }
            if let Some(starting) = &state.starting
                && starting.generation == state.generation
            {
                starting.result.clone()
            } else {
                let prev_cleanup = state.starting.as_ref().map(|s| s.cleanup.clone());
                let prev_closing = state.closing.as_ref().map(|(_, rx)| rx.clone());
                let generation = state.generation;
                let cancel = CancellationToken::new();
                let (result_tx, result_rx) = watch::channel(None);
                let (cleanup_tx, cleanup_rx) = watch::channel(false);
                state.active_starts += 1;
                state.starting = Some(InFlightStart {
                    generation,
                    cancel: cancel.clone(),
                    result: result_rx.clone(),
                    cleanup: cleanup_rx,
                });
                let app = app.clone();
                let wait_prior = self.prior_wait();
                tokio::spawn(async move {
                    let guard = StartingGuard {
                        app: app.clone(),
                        generation,
                        result_tx,
                        settled: false,
                        _cleanup: CleanupGuard(cleanup_tx),
                    };
                    if let Some(mut prev) = prev_cleanup
                        && tokio::time::timeout(wait_prior, prev.wait_for(|&done| done)).await.is_err()
                    {
                        let msg = "Previous Remote Control start is still stopping".to_owned();
                        app.remote_control.record_start_failure(generation, &msg).await;
                        guard.finish(Err(msg));
                        return;
                    }
                    if let Some(mut closing) = prev_closing
                        && tokio::time::timeout(wait_prior, closing.wait_for(|&done| done)).await.is_err()
                    {
                        let msg = "Previous Remote Control tunnel is still closing".to_owned();
                        app.remote_control.record_start_failure(generation, &msg).await;
                        guard.finish(Err(msg));
                        return;
                    }
                    let outcome = app.remote_control.open_for_generation(&app, generation, cancel).await;
                    guard.finish(outcome);
                });
                result_rx
            }
        };
        let outcome =
            result_rx.wait_for(|val| val.is_some()).await.map_err(|_| "Remote Control start cancelled".to_owned())?;
        outcome.as_ref().cloned().unwrap_or_else(|| Err("Remote Control start cancelled".to_owned()))
    }

    async fn open_for_generation(
        &self,
        app: &Shared,
        generation: u64,
        cancel: CancellationToken,
    ) -> Result<Arc<ActiveTunnel>, String> {
        {
            let state = self.state.lock().unwrap();
            if state.shutting_down || state.generation != generation || cancel.is_cancelled() {
                return Err("Remote Control was stopped".to_owned());
            }
        }
        let route = {
            let Some(devices) = &app.devices else {
                return Err("Remote Control registry unavailable".to_owned());
            };
            let mut d = devices.lock().unwrap();
            d.route().map_err(|e| e.to_string())
        };
        let route = match route {
            Ok(route) => route,
            Err(err) => {
                self.record_start_failure(generation, &err).await;
                return Err(err);
            }
        };
        let target = match self.ingress.start(generation).await {
            Ok(target) => target,
            Err(err) => {
                let msg = err.to_string();
                self.record_start_failure(generation, &msg).await;
                return Err(msg);
            }
        };
        let opener = self.opener.read().unwrap().clone();
        let api = self.api.read().unwrap().clone();
        let ingress_for_origin = self.ingress.clone();
        let cancel_for_origin = cancel.clone();
        let on_origin: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |url: String| {
            if !cancel_for_origin.is_cancelled() {
                ingress_for_origin.set_origin(generation, Some(url));
            }
        });
        let session = match opener(OpenRequest { route, target, api, on_origin, cancel }).await {
            Ok(session) => session,
            Err(err) => {
                self.record_start_failure(generation, &err).await;
                return Err(err);
            }
        };
        let hostname = session.hostname().to_owned();
        let url = session.url().to_owned();
        let installed = {
            let mut state = self.state.lock().unwrap();
            if state.shutting_down || state.generation != generation {
                None
            } else {
                state.next_tunnel_id = state.next_tunnel_id.wrapping_add(1);
                let active = Arc::new(ActiveTunnel {
                    id: state.next_tunnel_id,
                    generation,
                    hostname,
                    url: url.clone(),
                    session: session.clone(),
                });
                self.ingress.set_origin(generation, Some(url));
                state.tunnel = Some(active.clone());
                state.last_connected_at = Some(crate::now());
                Some(active)
            }
        };
        let Some(active) = installed else {
            session.close().await;
            return Err("Remote Control was stopped".to_owned());
        };
        if let Some(closed_rx) = active.session.take_closed() {
            let app = app.clone();
            let active_id = active.id;
            tokio::spawn(async move {
                let err = closed_rx.await.ok().flatten();
                app.remote_control.handle_tunnel_stopped(&app, active_id, err).await;
            });
        }
        Ok(active)
    }

    async fn record_start_failure(&self, generation: u64, err: &str) {
        let still_current = {
            let mut state = self.state.lock().unwrap();
            if state.generation != generation {
                false
            } else {
                if state.enabled {
                    state.enabled = false;
                    state.error = Some(err.to_owned());
                }
                true
            }
        };
        if still_current {
            self.ingress.stop_up_to(generation).await;
        }
    }

    async fn handle_tunnel_stopped(&self, app: &Shared, active_id: u64, err: Option<String>) {
        let (close_tx, close_rx) = watch::channel(false);
        let _close_guard = CleanupGuard(close_tx);
        let stopped = {
            let mut state = self.state.lock().unwrap();
            if let Some(active) = state.tunnel.as_ref().filter(|t| t.id == active_id) {
                let gen_id = active.generation;
                state.tunnel = None;
                state.enabled = false;
                state.error = Some(err.unwrap_or_else(|| "Remote Control tunnel stopped".to_owned()));
                let (close_id, prev_closing) = state.register_closing(close_rx);
                Some((gen_id, close_id, prev_closing))
            } else {
                None
            }
        };
        let Some((stopped_gen, close_id, prev_closing)) = stopped else {
            return;
        };
        if let Some(devices) = &app.devices {
            let mut d = devices.lock().unwrap();
            d.cancel_tunnel_pairing();
            d.drop_tunnel_principals();
        }
        app.previews.revoke_tunnel_devices();
        if let Some(mut prev) = prev_closing {
            let _ = prev.wait_for(|&done| done).await;
        }
        self.ingress.stop_up_to(stopped_gen).await;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.finish_closing(close_id);
        self.release_lease_if_idle(&state);
    }
}

pub async fn start_route(State(app): State<Shared>) -> Response {
    match app.remote_control.start(&app).await {
        Ok(payload) => Json(payload).into_response(),
        Err(StartError::Disabled) => {
            (Status::FORBIDDEN, Json(json!({ "error": REMOTE_CONTROL_DISABLED, "code": "remote_control_disabled" })))
                .into_response()
        }
        Err(StartError::Failed(message)) => (Status::BAD_GATEWAY, Json(json!({ "error": message }))).into_response(),
    }
}

pub async fn stop_route(State(app): State<Shared>) -> Response {
    match app.remote_control.stop(&app).await {
        Ok(status) => Json(status).into_response(),
        Err(message) => (Status::SERVICE_UNAVAILABLE, Json(json!({ "error": message }))).into_response(),
    }
}
