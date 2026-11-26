//! Persistent Missions write state stored on `Preferences` and its config-bridge helpers.
use super::{defaults, depth, library};
use crate::{backend::Backend, settings::providers::Target};
use codenomad_client::settings::missions::MissionPreferenceExpectation;
use rune::Waker;
use serde_json::Value;

pub(in crate::settings) struct ConfigContext<'a> {
    pub backend: Option<&'a Backend>,
    pub config_loaded: bool,
    pub config_snapshot: Option<&'a Value>,
    pub config_guard: Option<(u64, u64)>,
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
    fn merge(&mut self, other: Self) {
        if other.applied.is_some() {
            self.applied = other.applied;
        }
        self.invalidate |= other.invalidate;
        self.revalidate_transport |= other.revalidate_transport;
        self.changed |= other.changed;
        self.settled |= other.settled;
    }
}

/// Persistent Missions write queues and depth state stored on `Preferences` so closing/reopening
/// Preferences or reattaching to the same server preserves in-flight writes and Uncertain state.
#[derive(Default)]
pub(in crate::settings) struct Shared {
    pub(super) defaults: defaults::State,
    pub(super) library: library::State,
    pub(super) depth: depth::State,
}

impl Shared {
    pub(in crate::settings) fn rebind(&mut self, same_address: bool) {
        self.defaults.rebind(same_address);
        self.library.rebind(same_address);
        self.depth.rebind(same_address);
    }

    pub(in crate::settings) fn suspend_reads(&mut self) {
        self.depth.suspend();
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn draining(&self) -> bool {
        self.defaults.draining() || self.library.pending() || self.depth.saving()
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
        transport_lost: bool,
        active: bool,
        wake: &Waker,
    ) -> bool {
        self.depth.poll(target, transport_lost, active, wake)
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
