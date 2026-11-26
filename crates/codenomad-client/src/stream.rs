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
mod limits;
mod mission_events;
#[cfg(not(target_arch = "wasm32"))]
mod native;
mod notifications;
mod routing;
mod sessions;
mod staleness;
pub use catalogue::{AttentionHint, CatalogueChanges, CatalogueWatch, SessionCatalogueChanges};
pub use children::ChildSettlement;
pub(crate) use children::Children;
pub(crate) use notifications::session_attention;
use routing::dispatch;
pub use staleness::probe_stale;
#[cfg(target_arch = "wasm32")]
#[path = "stream_browser.rs"]
mod browser;

pub struct State {
    pub cancelled: AtomicBool,
    pub version: AtomicU64,
    pub alive: AtomicBool,
    pub running: AtomicBool,
    pub upstream: AtomicBool,
    pub(crate) history_revision: AtomicU64,
    preferences: Option<(Sender<crate::transport::Event>, crate::Wake)>,
    preferences_notices: std::sync::OnceLock<Arc<[AtomicU64; 3]>>,
    open_stream: std::sync::OnceLock<(Arc<std::sync::atomic::AtomicUsize>, Arc<AtomicBool>)>,
    stream_owner: std::sync::OnceLock<(crate::http::Http, String)>,
    catalogue: Option<Arc<catalogue::Signals>>,
    placement: Option<(Sender<()>, crate::Receiver<()>)>,
    closed: (Sender<()>, crate::Receiver<()>),
    provider_usage: Option<crate::provider_usage::Watch>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            version: AtomicU64::new(0),
            alive: AtomicBool::new(false),
            running: AtomicBool::new(false),
            upstream: AtomicBool::new(false),
            history_revision: AtomicU64::new(0),
            preferences: None,
            preferences_notices: std::sync::OnceLock::new(),
            open_stream: std::sync::OnceLock::new(),
            stream_owner: std::sync::OnceLock::new(),
            catalogue: None,
            placement: None,
            closed: crate::bounded(1),
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

    pub(crate) fn is_placement_changed(&self) -> bool {
        self.placement
            .as_ref()
            .is_some_and(|(_, changed)| changed.is_closed())
    }

    pub(crate) async fn stream_closed(&self) {
        let _ = self.closed.1.recv().await;
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(crate) fn close_stream(&self) {
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
            && self.upstream.load(SeqCst)
            && !self.cancelled.load(SeqCst)
    }
    pub(crate) fn history_current(&self, revision: u64) -> bool {
        self.history_revision.load(SeqCst) == revision
            && self.alive.load(SeqCst)
            && self.upstream.load(SeqCst)
            && !self.cancelled.load(SeqCst)
    }
}

pub fn start(backend: Backend, epoch: u64, out: Sender<Input>, state: Arc<State>) {
    state.running.store(true, SeqCst);
    runtime::spawn(async move {
        let result = if backend.client.tracks_server_attestation() {
            if epoch > 1 {
                backend.client.note_reconnect_attempt(&backend.client_id);
            }
            match futures_lite::future::race(
                async {
                    backend.attest_server().await?;
                    Ok(())
                },
                async {
                    while !state.cancelled.load(SeqCst) && !out.is_closed() {
                        runtime::sleep(Duration::from_millis(25)).await;
                    }
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
        };
        state.alive.store(false, SeqCst);
        state.closed.0.close();
        state.running.store(false, SeqCst);
        state.version.fetch_add(1, SeqCst);
        if let Some(quota) = state.quota_ingress(&backend) {
            quota.transport(false);
        }
        let expired = result
            .as_ref()
            .is_err_and(crate::http::authentication_expired);
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
    let (stream_guard, open_flag) = backend.client.track_stream(&backend.client_id);
    let _ = state
        .stream_owner
        .set((backend.client.clone(), backend.client_id.clone()));
    if state.catalogue.is_none() {
        let _ = state
            .open_stream
            .set((backend.client.open_streams_counter(), open_flag));
    }
    let notices = backend.client.preferences_notices();
    let _ = state.preferences_notices.set(notices.clone());
    let result = {
        #[cfg(not(target_arch = "wasm32"))]
        {
            futures_lite::future::race(native::read_native(backend, epoch, out, state), async {
                while !state.cancelled.load(SeqCst) && !out.is_closed() {
                    runtime::sleep(Duration::from_millis(25)).await;
                }
                Ok(())
            })
            .await
        }
        #[cfg(target_arch = "wasm32")]
        {
            browser::read(backend, epoch, out, state).await
        }
    };
    let was_open = stream_guard.release_open();
    if !state.cancelled.load(SeqCst) && !out.is_closed() {
        backend
            .client
            .record_transport_drop(&backend.client_id, was_open);
    }
    result
}

pub(super) async fn opened(epoch: u64, out: &Sender<Input>, state: &State) -> Result<()> {
    if let Some((client, client_id)) = state.stream_owner.get() {
        client.mark_stream_opened(client_id);
    }
    if let Some((counter, flag)) = state.open_stream.get()
        && !flag.swap(true, SeqCst)
    {
        counter.fetch_add(1, SeqCst);
    }
    if let Some(signals) = &state.catalogue {
        signals.reconnected();
    }
    state.alive.store(true, SeqCst);
    state.upstream.store(true, SeqCst);
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
