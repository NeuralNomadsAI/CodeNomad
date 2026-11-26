//! Persistent Speech save state on `Preferences` with authority and pre-send transport guards.
use crate::{backend::Backend, platform, settings::preferences::Owner};
use codenomad_client::{Receiver, bounded, settings::PatchOutcome};
use rune::Waker;
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

pub(in crate::settings) struct ServerContext<'a> {
    pub backend: Option<&'a Backend>,
    pub server_ready: bool,
    pub server_guard: Option<(u64, u64)>,
    pub write_authority: (Arc<AtomicU64>, u64),
    pub transport_lost: bool,
    pub can_retry: bool,
}

#[derive(Default)]
pub(in crate::settings) struct ServerEffects {
    pub applied: Option<(Value, Option<(u64, u64)>)>,
    pub invalidate: bool,
    pub changed: bool,
    pub settled: bool,
}

enum Reply {
    Patch {
        outcome: PatchOutcome,
        guard: Option<(u64, u64)>,
    },
}

/// Persistent in-flight speech save state stored on `Preferences` so window close/reopen and
/// same-server rebind preserve in-flight writes and unconfirmed status.
#[derive(Default)]
pub(in crate::settings) struct Shared {
    flight: Option<Receiver<Reply>>,
    owner: Option<String>,
    pub(super) failed: bool,
    pub(super) uncertain: bool,
    saved_generation: u64,
}

impl Shared {
    pub(in crate::settings) fn saving(&self) -> bool {
        self.flight.is_some()
    }

    pub(super) fn saved_generation(&self) -> u64 {
        self.saved_generation
    }

    pub(super) fn clear_error(&mut self) {
        self.failed = false;
        self.uncertain = false;
    }

    pub(in crate::settings) fn rebind(&mut self, same_address: bool) {
        if !same_address {
            *self = Self::default();
            return;
        }
        if self.flight.is_some() {
            self.flight = None;
            self.failed = true;
            self.uncertain = true;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn draining(&self) -> bool {
        self.flight.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn has_unconfirmed(&self) -> bool {
        self.flight.is_some() || self.failed || self.uncertain
    }

    pub(in crate::settings) fn start_save(
        &mut self,
        ctx: &ServerContext<'_>,
        patch: Value,
        wake: &Waker,
    ) -> bool {
        if self.flight.is_some() || !ctx.server_ready || ctx.transport_lost || !ctx.can_retry {
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
        let (epoch_guard, expected_epoch) = ctx.write_authority.clone();
        let expected_drop_gen = backend.client.drop_generation();
        let expected_client_id = backend.client_id.clone();
        self.owner = Some(expected_client_id.clone());
        self.failed = false;
        self.uncertain = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.flight = Some(inbox);
        platform::spawn(async move {
            let revoked = epoch_guard.load(Ordering::Acquire) != expected_epoch
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
        if ctx.transport_lost && self.flight.is_some() {
            self.flight = None;
            self.failed = true;
            self.uncertain = true;
            effects.invalidate = true;
            effects.changed = true;
            effects.settled = true;
            return effects;
        }
        let Some(reply) = self.flight.as_ref().and_then(|inbox| inbox.try_recv().ok()) else {
            return effects;
        };
        self.flight = None;
        let Reply::Patch { outcome, guard } = reply;
        match outcome {
            PatchOutcome::Applied(snapshot) => {
                self.failed = false;
                self.uncertain = false;
                self.saved_generation = self.saved_generation.wrapping_add(1);
                effects.applied = Some((snapshot, guard));
            }
            PatchOutcome::Rejected => {
                self.failed = true;
                self.uncertain = false;
                effects.invalidate = true;
            }
            PatchOutcome::Uncertain => {
                self.failed = true;
                self.uncertain = true;
                effects.invalidate = true;
            }
        }
        effects.changed = true;
        effects.settled = true;
        effects
    }
}
