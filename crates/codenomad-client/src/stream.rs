//! SSE connection and observer lifetime.
use crate::transport::WorkspaceEvent;
use crate::{Sender, backend::Backend, history::Result, recovery::Input, runtime};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
    },
    time::Duration,
};
mod catalogue;
mod children;
#[cfg(any(not(target_arch = "wasm32"), test))]
mod frames;
pub(crate) mod hub;
mod limits;
mod mission_events;
#[cfg(not(target_arch = "wasm32"))]
mod native;
mod notifications;
mod routing;
mod sessions;
mod staleness;
pub use catalogue::{
    AttentionHint, CatalogueChanges, CatalogueWatch, ProviderMoves, SessionActivityHint,
    SessionActivityKind, SessionCatalogueChanges,
};
pub use children::ChildSettlement;
pub(crate) use children::Children;
pub(crate) use hub::Hub;
pub(crate) use notifications::session_attention;
#[cfg(test)]
use routing::dispatch;
pub use staleness::probe_stale;
#[cfg(target_arch = "wasm32")]
#[path = "stream_browser.rs"]
mod browser;

pub struct State {
    cancelled: AtomicBool,
    pub version: AtomicU64,
    pub alive: AtomicBool,
    pub running: AtomicBool,
    pub upstream: Arc<AtomicBool>,
    pub(crate) disconnect_mark: Arc<AtomicU64>,
    pub(crate) auth_expired: AtomicBool,
    pub(crate) history_revision: Arc<AtomicU64>,
    pub(crate) inbox: crate::inbox::InboxWire,
    preferences: Option<(Sender<crate::transport::Event>, crate::Wake)>,
    preferences_notices: std::sync::OnceLock<Arc<[AtomicU64; 3]>>,
    catalogue: Option<Arc<catalogue::Signals>>,
    placement: Option<(Sender<()>, crate::Receiver<()>)>,
    closed: (Sender<()>, crate::Receiver<()>),
    cancel_signal: (Sender<()>, crate::Receiver<()>),
    stopped: (Sender<()>, crate::Receiver<()>),
    provider_usage: Option<crate::provider_usage::Watch>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            version: AtomicU64::new(0),
            alive: AtomicBool::new(false),
            running: AtomicBool::new(false),
            upstream: Arc::new(AtomicBool::new(false)),
            disconnect_mark: Arc::new(AtomicU64::new(0)),
            auth_expired: AtomicBool::new(false),
            history_revision: Arc::new(AtomicU64::new(0)),
            inbox: crate::inbox::InboxWire::default(),
            preferences: None,
            preferences_notices: std::sync::OnceLock::new(),
            catalogue: None,
            placement: None,
            closed: crate::bounded(1),
            cancel_signal: crate::bounded(1),
            stopped: crate::bounded(1),
            provider_usage: None,
        }
    }
}

impl State {
    pub(crate) fn with_provider_usage(
        mut self,
        watch: Option<crate::provider_usage::Watch>,
    ) -> Self {
        self.provider_usage = watch;
        self
    }

    fn quota_ingress(&self, backend: &Backend) -> Option<crate::provider_usage::Ingress> {
        Some(crate::provider_usage::Ingress::new(
            self.provider_usage.clone()?,
            self.preferences.as_ref()?.1.clone(),
            backend.workspace.clone(),
            backend.session.clone(),
        ))
    }

    pub(crate) fn observing_preferences(
        out: Sender<crate::transport::Event>,
        wake: crate::Wake,
    ) -> Self {
        Self {
            inbox: crate::inbox::InboxWire::with_wake(wake.clone()),
            preferences: Some((out, wake)),
            placement: Some(crate::bounded(1)),
            ..Self::default()
        }
    }

    pub(crate) async fn placement_changed(&self) {
        if let Some((_, changed)) = &self.placement {
            let _ = changed.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    }

    pub(crate) fn close_placement(&self) {
        self.inbox.invalidate_closed();
        if let Some((cancel, _)) = &self.placement {
            cancel.close();
        }
    }

    pub(crate) fn placement_closed(&self) -> bool {
        self.placement
            .as_ref()
            .is_some_and(|(cancel, _)| cancel.is_closed())
    }

    pub(crate) fn is_placement_changed(&self) -> bool {
        self.placement
            .as_ref()
            .is_some_and(|(_, changed)| changed.is_closed())
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, SeqCst);
        self.inbox.invalidate_closed();
        self.cancel_signal.0.close();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(SeqCst)
    }

    pub(crate) async fn wait_cancelled(&self, out: &Sender<Input>) {
        if self.cancelled.load(SeqCst) || out.is_closed() {
            return;
        }
        futures_lite::future::or(
            async {
                let _ = self.cancel_signal.1.recv().await;
            },
            out.closed(),
        )
        .await;
    }

    pub(crate) async fn wait_stopped(&self) {
        if !self.running.load(SeqCst) {
            return;
        }
        let _ = self.stopped.1.recv().await;
    }

    pub(crate) async fn stream_closed(&self) {
        let _ = self.closed.1.recv().await;
    }

    pub(crate) fn is_stream_closed(&self) -> bool {
        self.closed.1.is_closed()
    }

    pub(super) fn closed_signal(&self) -> Sender<()> {
        self.closed.0.clone()
    }

    pub(super) fn placement_signal(&self) -> Option<Sender<()>> {
        self.placement.as_ref().map(|(cancel, _)| cancel.clone())
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(crate) fn close_stream(&self) {
        self.inbox.invalidate_closed();
        self.closed.0.close();
    }

    async fn notify_preferences(
        &self,
        owner: crate::settings::Owner,
        out: &Sender<Input>,
    ) -> Result<()> {
        if let Some(notices) = self.preferences_notices.get() {
            notices[owner.index()].fetch_add(1, SeqCst);
            if owner == crate::settings::Owner::Config {
                notices[crate::settings::Owner::Server.index()].fetch_add(1, SeqCst);
            }
        }
        if let Some((events, wake)) = &self.preferences {
            crate::transport::publish(events, wake, crate::transport::Event::Preferences(owner))
                .await;
        } else {
            out.send(Input::Preferences(owner)).await?;
        }
        Ok(())
    }

    async fn storage_changed(
        &self,
        epoch: u64,
        owner: crate::settings::Owner,
        out: &Sender<Input>,
    ) -> Result<()> {
        self.notify_preferences(owner, out).await?;
        if owner == crate::settings::Owner::Config {
            let event = WorkspaceEvent::UiPreferencesChanged;
            if let Some((events, wake)) = &self.preferences {
                crate::transport::publish(events, wake, crate::transport::Event::Workspace(event))
                    .await;
            } else {
                out.send(Input::Workspace(epoch, event)).await?;
            }
        }
        Ok(())
    }
    pub fn valid(&self, version: u64) -> bool {
        self.version.load(SeqCst) == version
            && self.alive.load(SeqCst)
            && !self.is_stream_closed()
            && !self.is_placement_changed()
            && self.upstream.load(SeqCst)
            && !self.cancelled.load(SeqCst)
            && !self.placement_closed()
    }
    pub(crate) fn history_current(&self, revision: u64) -> bool {
        self.history_revision.load(SeqCst) == revision
            && self.alive.load(SeqCst)
            && !self.is_stream_closed()
            && !self.is_placement_changed()
            && self.upstream.load(SeqCst)
            && !self.cancelled.load(SeqCst)
            && !self.placement_closed()
    }
}

struct RunGuard(Arc<State>);

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.alive.store(false, SeqCst);
        self.0.closed.0.close();
        self.0.version.fetch_add(1, SeqCst);
        self.0.inbox.invalidate_closed();
        self.0.running.store(false, SeqCst);
        self.0.stopped.0.close();
    }
}

pub fn start(backend: Backend, epoch: u64, out: Sender<Input>, state: Arc<State>) {
    state.running.store(true, SeqCst);
    let guard = RunGuard(state.clone());
    runtime::spawn(async move {
        let result = {
            let _guard = guard;
            if backend.client.tracks_server_attestation() {
                if epoch > 1 {
                    backend.client.note_reconnect_attempt(&backend.client_id);
                }
                match futures_lite::future::or(
                    async {
                        state.wait_cancelled(&out).await;
                        Ok(())
                    },
                    async {
                        backend.attest_server().await?;
                        Ok(())
                    },
                )
                .await
                {
                    Ok(()) if !state.cancelled.load(SeqCst) && !out.is_closed() => {
                        read(&backend, epoch, &out, &state).await
                    }
                    Err(err) => {
                        if !state.cancelled.load(SeqCst) && !out.is_closed() {
                            backend
                                .client
                                .record_transport_drop(&backend.client_id, false);
                        }
                        Err(err)
                    }
                    other => other,
                }
            } else {
                read(&backend, epoch, &out, &state).await
            }
        };
        if let Some(quota) = state.quota_ingress(&backend) {
            quota.transport(false);
        }
        let expired = result
            .as_ref()
            .is_err_and(crate::http::authentication_expired);
        if expired {
            state.auth_expired.store(true, SeqCst);
        }
        if result.is_err() {
            eprintln!("Rune event stream unavailable");
        }
        let _ = out
            .send(if expired {
                Input::AuthenticationRequired(epoch)
            } else {
                Input::Closed(epoch)
            })
            .await;
        if let Some(wake) = state.preferences.as_ref().map(|(_, wake)| wake.clone()) {
            drop(state);
            wake();
        }
    });
}

pub(crate) async fn read(
    backend: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
) -> Result<()> {
    let stream_guard = Arc::new(backend.client.track_stream(&backend.client_id));
    let count_open_stream = state.catalogue.is_none();
    let notices = backend.client.preferences_notices();
    let _ = state.preferences_notices.set(notices.clone());
    let result = hub::read_shared(
        backend,
        epoch,
        out,
        state,
        stream_guard.clone(),
        count_open_stream,
    )
    .await;
    let record_drop = !state.cancelled.load(SeqCst) && !out.is_closed();
    stream_guard.close_and_revoke(&backend.client, count_open_stream, record_drop);
    result
}

pub(super) async fn opened(epoch: u64, out: &Sender<Input>, state: &State) -> Result<()> {
    opened_at(epoch, out, state, state.inbox.current_ingress()).await
}

pub(super) async fn opened_at(
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    mark: u64,
) -> Result<()> {
    if let Some(signals) = &state.catalogue {
        signals.reconnected();
    }
    state.alive.store(true, SeqCst);
    if mark >= state.disconnect_mark.load(SeqCst) {
        state.upstream.store(true, SeqCst);
    }
    out.send(Input::Opened(epoch)).await?;
    if state.preferences.is_some() {
        state
            .notify_preferences(crate::settings::Owner::Config, out)
            .await?;
        state
            .notify_preferences(crate::settings::Owner::State, out)
            .await?;
    } else if state.catalogue.is_none()
        && let Some(notices) = state.preferences_notices.get()
    {
        for owner in [
            crate::settings::Owner::Config,
            crate::settings::Owner::State,
            crate::settings::Owner::Server,
        ] {
            notices[owner.index()].fetch_add(1, SeqCst);
        }
    }
    Ok(())
}
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "stream_workspace_tests.rs"]
mod workspace_tests;
