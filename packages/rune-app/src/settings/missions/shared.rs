//! Persistent Missions write state stored on `Preferences` and its config-bridge helpers.
use super::{defaults, depth, library};
use crate::{backend::Backend, platform, settings::providers::Target};
use codenomad_client::{
    Receiver, Sender, absolute_server_path, bounded,
    settings::missions::{MissionPreferenceExpectation, resolve_workspace_directory},
};
use rune::Waker;
use serde_json::Value;
use std::sync::{Arc, atomic::AtomicU64};

pub(in crate::settings) struct ConfigContext<'a> {
    pub backend: Option<&'a Backend>,
    pub config_loaded: bool,
    pub config_refreshing: bool,
    pub config_snapshot: Option<&'a Value>,
    pub config_guard: Option<(u64, u64)>,
    pub write_authority: (Arc<AtomicU64>, u64),
    pub transport_lost: bool,
    pub can_retry: bool,
}

#[derive(Default)]
pub(in crate::settings) struct ConfigEffects {
    pub applied: Option<(Value, Option<(u64, u64)>)>,
    pub invalidate: bool,
    pub revalidate_transport: bool,
    pub changed: bool,
    pub settled: bool,
}

impl ConfigEffects {
    pub(super) fn record_applied(&mut self, snapshot: Value, guard: Option<(u64, u64)>) {
        // When two independent writes settle in the same poll, neither ACK order is proven;
        // invalidate Owner::Config so one authoritative GET publishes the latest server state.
        if self.applied.is_some() {
            self.applied = None;
            self.invalidate = true;
        } else {
            self.applied = Some((snapshot, guard));
        }
    }

    fn merge(&mut self, other: Self) {
        if let Some((snapshot, guard)) = other.applied {
            self.record_applied(snapshot, guard);
        }
        self.invalidate |= other.invalidate;
        self.revalidate_transport |= other.revalidate_transport;
        self.changed |= other.changed;
        self.settled |= other.settled;
    }
}

type LocationFlight = (u64, String, u64, Sender<()>, Receiver<Option<String>>);

/// Persistent Missions write queues and depth state stored on `Preferences` so closing/reopening
/// Preferences or reattaching to the same server preserves in-flight writes and Uncertain state.
#[derive(Default)]
pub(in crate::settings) struct Shared {
    pub(super) defaults: defaults::State,
    pub(super) library: library::State,
    pub(super) depth: depth::State,
    open_epoch: u64,
    pinned_directory: Option<String>,
    location_flight: Option<LocationFlight>,
    location_failed: Option<(u64, String, u64, u64)>,
    location_retry_epoch: u64,
}

impl Shared {
    pub(in crate::settings) fn capture_opener(&mut self, directory: Option<String>) {
        self.open_epoch = self.open_epoch.wrapping_add(1);
        self.pinned_directory = directory.filter(|path| absolute_server_path(path));
        self.location_flight = None;
        self.location_failed = None;
    }

    pub(super) fn open_epoch(&self) -> u64 {
        self.open_epoch
    }

    pub(in crate::settings) fn pinned_directory(&self) -> Option<&str> {
        self.pinned_directory.as_deref()
    }

    pub(super) fn retry_location(&mut self) {
        self.location_retry_epoch = self.location_retry_epoch.wrapping_add(1);
        self.location_failed = None;
    }

    pub(super) fn poll_location(
        &mut self,
        target: Option<&Target>,
        active: bool,
        wake: &Waker,
    ) -> (bool, bool) {
        if self.pinned_directory.is_some() {
            let changed = self.location_flight.take().is_some();
            self.location_failed = None;
            return (changed, false);
        }
        let Some(target) = target.filter(|target| active && target.online()) else {
            let changed = self.location_flight.take().is_some();
            return (changed, false);
        };
        let (backend, workspace, authority, _) = target.stats_source();
        let (_, session) = target.location();
        let revision = target.revision().wrapping_add(self.location_retry_epoch);
        let mut changed = false;
        if self
            .location_flight
            .as_ref()
            .is_some_and(|(e, w, a, _, _)| {
                *e != self.open_epoch || w != workspace || *a != authority
            })
        {
            self.location_flight = None;
            changed = true;
        }
        if let Some(result) = self
            .location_flight
            .as_ref()
            .and_then(|(_, _, _, _, inbox)| inbox.try_recv().ok())
        {
            self.location_flight = None;
            match result.filter(|dir| absolute_server_path(dir)) {
                Some(dir) => {
                    self.pinned_directory = Some(dir);
                    self.location_failed = None;
                }
                None => {
                    self.location_failed =
                        Some((self.open_epoch, workspace.to_owned(), authority, revision));
                }
            }
            changed = true;
        }
        let failed = self.location_failed.as_ref().is_some_and(|(e, w, a, r)| {
            *e == self.open_epoch && w == workspace && *a == authority && *r == revision
        });
        if self.pinned_directory.is_none() && self.location_flight.is_none() && !failed {
            let (cancel, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            let backend = backend.clone();
            let workspace_owned = workspace.to_owned();
            let session = session.map(str::to_owned);
            let wake = wake.clone();
            self.location_flight = Some((
                self.open_epoch,
                workspace_owned.clone(),
                authority,
                cancel,
                inbox,
            ));
            platform::spawn(async move {
                let task =
                    resolve_workspace_directory(&backend, &workspace_owned, session.as_deref());
                if let Some(result) = platform::reads::cancellable(&cancelled, task).await
                    && out.send(result.ok()).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        (changed, failed)
    }

    pub(in crate::settings) fn rebind(&mut self, same_address: bool) {
        self.defaults.rebind(same_address);
        self.library.rebind(same_address);
        self.depth.rebind(same_address);
        self.location_flight = None;
        self.location_failed = None;
        if !same_address {
            self.pinned_directory = None;
        }
    }

    pub(in crate::settings) fn suspend_reads(&mut self) {
        self.location_flight = None;
        self.depth.suspend();
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn draining(&self, config_read_failed: bool) -> bool {
        self.depth.saving() || self.library.pending() || self.defaults.draining(config_read_failed)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn needs_config_revalidation(&self) -> bool {
        self.library.pending() || self.defaults.needs_config_revalidation()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn has_unconfirmed(&self) -> bool {
        self.defaults.has_unconfirmed()
            || self.library.has_unconfirmed()
            || self.depth.has_unconfirmed()
    }

    pub(in crate::settings) fn poll_writes(
        &mut self,
        ctx: &ConfigContext<'_>,
        wake: &Waker,
    ) -> ConfigEffects {
        let mut effects = self.defaults.poll(ctx, wake);
        effects.merge(self.library.poll());
        let (depth_changed, depth_settled) = self.depth.poll_save_only(ctx.transport_lost);
        effects.changed |= depth_changed;
        effects.settled |= depth_settled;
        effects
    }

    pub(super) fn poll_depth(
        &mut self,
        target: Option<&Target>,
        location_failed: bool,
        transport_lost: bool,
        active: bool,
        wake: &Waker,
    ) -> bool {
        let pinned = self.pinned_directory.as_deref();
        self.depth.poll(
            target,
            pinned,
            location_failed,
            self.open_epoch,
            transport_lost,
            active,
            wake,
        )
    }

    pub(in crate::settings) fn start_defaults_reload(
        &mut self,
        ctx: &ConfigContext<'_>,
        wake: &Waker,
    ) -> ConfigEffects {
        self.defaults.start_reload(ctx, wake)
    }

    pub(in crate::settings) fn toggle_delete_sessions(
        &mut self,
        ctx: &ConfigContext<'_>,
        next: bool,
        wake: &Waker,
    ) -> bool {
        self.defaults.toggle_delete_sessions(ctx, next, wake)
    }

    pub(in crate::settings) fn start_library_reload(
        &mut self,
        ctx: &ConfigContext<'_>,
        wake: &Waker,
    ) -> ConfigEffects {
        self.library.start_reload(ctx, wake)
    }

    pub(in crate::settings) fn start_model_remove(
        &mut self,
        ctx: &ConfigContext<'_>,
        id: &str,
        owner: &str,
        expected: MissionPreferenceExpectation,
        wake: &Waker,
    ) -> bool {
        self.library.start_remove(ctx, id, owner, expected, wake)
    }

    pub(in crate::settings) fn start_models_reset(
        &mut self,
        ctx: &ConfigContext<'_>,
        owner: &str,
        expected: MissionPreferenceExpectation,
        wake: &Waker,
    ) -> bool {
        self.library.start_reset(ctx, owner, expected, wake)
    }
}

pub(in crate::settings) fn opener_directory(s: &crate::State) -> Option<String> {
    if let Some((_, directory)) = crate::git::file_link_scope(s)
        && absolute_server_path(directory)
    {
        return Some(directory.to_owned());
    }
    if let Some(launcher) = s.screen.launcher()
        && crate::workspace::active_session(s).is_none()
        && let Some(project) = launcher.project.as_ref()
        && absolute_server_path(&project.path)
    {
        return Some(project.path.clone());
    }
    crate::settings::bound_backend(s)
        .and_then(|backend| backend.session_directory)
        .filter(|path| absolute_server_path(path))
}
