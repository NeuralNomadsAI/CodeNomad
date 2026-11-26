//! Persistent Speech save state on `Preferences` with freshness, barrier and readback guards.
use crate::{backend::Backend, platform, settings::preferences::Owner};
use codenomad_client::{
    Receiver, bounded,
    settings::{PatchOutcome, speech::speech_patch_confirmed},
};
use rune::Waker;
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

/// `(invalidation_seq, publish_seq, preferences_revision)` captured when starting a Speech PATCH.
pub(in crate::settings) type ServerGuard = (u64, u64, u64);

pub(in crate::settings) struct ServerContext<'a> {
    pub backend: Option<&'a Backend>,
    pub server_ready: bool,
    pub server_guard: Option<ServerGuard>,
    pub invalidation_guard: (Arc<AtomicU64>, u64),
    pub write_authority: (Arc<AtomicU64>, u64),
    pub transport_lost: bool,
    pub can_retry: bool,
}

#[derive(Default)]
pub(in crate::settings) struct ServerEffects {
    pub applied: Option<(Value, Option<ServerGuard>)>,
    pub invalidate: bool,
    pub changed: bool,
    pub settled: bool,
}

enum Reply {
    Patch {
        outcome: PatchOutcome,
        guard: Option<ServerGuard>,
    },
}

/// Persistent in-flight speech save state stored on `Preferences` so window close/reopen,
/// same-server rebind and native shutdown preserve in-flight writes and readback reconciliation.
#[derive(Default)]
pub(in crate::settings) struct Shared {
    flight: Option<Receiver<Reply>>,
    /// Same-server in-flight PATCH demoted on rebind; blocks new saves until settled and discards
    /// its expired snapshot so an authoritative GET runs afterwards.
    barrier: Option<Receiver<Reply>>,
    in_flight_patch: Option<Value>,
    uncertain_patch: Option<Value>,
    needs_server_readback: bool,
    owner: Option<String>,
    pub(super) failed: bool,
    pub(super) uncertain: bool,
    saved_generation: u64,
}

impl Shared {
    pub(in crate::settings) fn saving(&self) -> bool {
        self.flight.is_some() || self.barrier.is_some()
    }

    pub(super) fn saved_generation(&self) -> u64 {
        self.saved_generation
    }

    pub(super) fn clear_error(&mut self) {
        self.failed = false;
        self.uncertain = false;
        self.uncertain_patch = None;
        self.needs_server_readback = false;
    }

    pub(in crate::settings) fn needs_reconciliation(&self) -> bool {
        self.flight.is_none() && self.barrier.is_none() && self.needs_server_readback
    }

    pub(in crate::settings) fn reconcile_snapshot(&mut self, snapshot: &Value) -> bool {
        if !self.needs_reconciliation() {
            return false;
        }
        self.needs_server_readback = false;
        let Some(patch) = self.uncertain_patch.take() else {
            return false;
        };
        if speech_patch_confirmed(&patch, snapshot) {
            self.failed = false;
            self.uncertain = false;
            self.saved_generation = self.saved_generation.wrapping_add(1);
            true
        } else {
            false
        }
    }

    pub(in crate::settings) fn note_readback_failed(&mut self) {
        if self.needs_reconciliation() {
            self.needs_server_readback = false;
        }
    }

    pub(in crate::settings) fn rebind(&mut self, same_address: bool) {
        if !same_address {
            *self = Self::default();
            return;
        }
        // Clear owner so the new client_id on the same server adopts barrier/uncertain state.
        self.owner = None;
        if let Some(flight) = self.flight.take() {
            self.barrier = Some(flight);
            if let Some(patch) = self.in_flight_patch.take() {
                self.uncertain_patch = Some(patch);
            }
            self.failed = true;
            self.uncertain = true;
            self.needs_server_readback = true;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn draining(&self) -> bool {
        self.flight.is_some() || self.barrier.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn has_unconfirmed(&self) -> bool {
        self.flight.is_some() || self.barrier.is_some() || self.failed || self.uncertain
    }

    pub(in crate::settings) fn start_save(
        &mut self,
        ctx: &ServerContext<'_>,
        patch: Value,
        wake: &Waker,
    ) -> bool {
        if self.saving() || !ctx.server_ready || ctx.transport_lost || !ctx.can_retry {
            return false;
        }
        let Some(backend) = ctx.backend.cloned() else {
            return false;
        };
        if backend.client.attestation_revoked()
            || backend.client.has_unattested_stream_drop()
            || backend.client.is_in_outage(&backend.client_id)
        {
            return false;
        }
        let guard = ctx.server_guard;
        let expected_server_rev = guard.map(|(_, _, rev)| rev);
        let (inv_guard, expected_inv) = ctx.invalidation_guard.clone();
        let (epoch_guard, expected_epoch) = ctx.write_authority.clone();
        let expected_drop_gen = backend.client.drop_generation();
        let expected_client_id = backend.client_id.clone();
        self.owner = Some(expected_client_id.clone());
        self.in_flight_patch = Some(patch.clone());
        self.uncertain_patch = None;
        self.needs_server_readback = false;
        self.failed = false;
        self.uncertain = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.flight = Some(inbox);
        platform::spawn(async move {
            let stale_doc = inv_guard.load(Ordering::Acquire) != expected_inv
                || expected_server_rev
                    .is_some_and(|rev| backend.client.preferences_revision(Owner::Server) != rev);
            let revoked = stale_doc
                || epoch_guard.load(Ordering::Acquire) != expected_epoch
                || backend.client.drop_generation() != expected_drop_gen
                || backend.client.attestation_revoked()
                || backend.client.has_unattested_stream_drop()
                || backend.client.is_in_outage(&expected_client_id);
            let outcome = if revoked {
                PatchOutcome::Rejected
            } else {
                Owner::Server.patch(&backend, &patch, false).await
            };
            if out.send(Reply::Patch { outcome, guard }).await.is_ok() {
                wake();
            }
        });
        true
    }

    pub(in crate::settings) fn poll(&mut self, ctx: &ServerContext<'_>) -> ServerEffects {
        let mut effects = ServerEffects::default();
        if let Some(owner) = self.owner.as_deref()
            && ctx.backend.is_some_and(|b| b.client_id != owner)
        {
            *self = Self::default();
            effects.changed = true;
            return effects;
        }
        if self.owner.is_none()
            && let Some(backend) = ctx.backend
        {
            self.owner = Some(backend.client_id.clone());
        }
        if let Some(barrier) = self.barrier.as_ref()
            && barrier.try_recv().is_ok()
        {
            // Barrier expired before settlement: discard its snapshot and force an authoritative GET.
            self.barrier = None;
            self.needs_server_readback = true;
            effects.invalidate = true;
            effects.changed = true;
            effects.settled = true;
            return effects;
        }
        if ctx.transport_lost
            && let Some(flight) = self.flight.take()
        {
            self.barrier = Some(flight);
            if let Some(patch) = self.in_flight_patch.take() {
                self.uncertain_patch = Some(patch);
            }
            self.failed = true;
            self.uncertain = true;
            self.needs_server_readback = true;
            effects.invalidate = true;
            effects.changed = true;
            effects.settled = true;
            return effects;
        }
        let Some(reply) = self.flight.as_ref().and_then(|inbox| inbox.try_recv().ok()) else {
            return effects;
        };
        self.flight = None;
        let sent_patch = self.in_flight_patch.take();
        let Reply::Patch { outcome, guard } = reply;
        match outcome {
            PatchOutcome::Applied(snapshot) => {
                self.failed = false;
                self.uncertain = false;
                self.uncertain_patch = None;
                self.needs_server_readback = false;
                self.saved_generation = self.saved_generation.wrapping_add(1);
                effects.applied = Some((snapshot, guard));
            }
            PatchOutcome::Rejected => {
                self.failed = true;
                self.uncertain = false;
                self.uncertain_patch = None;
                self.needs_server_readback = false;
                effects.invalidate = true;
            }
            PatchOutcome::Uncertain => {
                self.failed = true;
                self.uncertain = true;
                self.uncertain_patch = sent_patch;
                self.needs_server_readback = true;
                effects.invalidate = true;
            }
        }
        effects.changed = true;
        effects.settled = true;
        effects
    }
}
