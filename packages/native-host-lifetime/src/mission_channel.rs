//! Owned Missions capabilities. No JSON, PID, HMAC receipt or JS object is a producer.
//!
//! The live runtime has no internal writer/family registration or synchronous
//! storage transaction producer. Consequently production cannot construct Evidence
//! or a Channel. The guardian algorithm is usable only once that upstream seam
//! exists; test constructors below are not compiled into the addon.
#![allow(dead_code)]
use crate::{Error, Identity, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

#[path = "mission_channel_native.rs"]
mod native;
#[path = "mission_channel_state.rs"]
mod state;
#[path = "mission_channel_inventory.rs"]
mod inventory;
#[cfg(test)]
#[path = "mission_channel_tests.rs"]
mod tests;

pub(crate) const PROTOCOL: &str = "codenomad.missions.channel.v1";
const CAPACITY: usize = 64;
const MAX_LEASE_MS: u64 = 30_000;

/// Exact immutable provenance, produced internally, never deserialized from JS.
/// Digests name identities; only retained native evidence can qualify them.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    registration_id: [u8; 32],
    incarnation_id: [u8; 32],
    signer: [u8; 32],
    human_origin: [u8; 32],
    invocation_id: [u8; 32],
    signed_intent_digest: [u8; 32],
    provisioning: [u8; 32],
    profile: [u8; 32],
    generation: String,
    scope: String,
    // Protected authority UUID is distinct from the two durable journal names.
    namespace_id: [u8; 16],
    namespace: String,
    authority_namespace: String,
    project_id: String,
    canonical_project: String,
    location: String,
    daemon_storage: FileIdentity,
    artifact: FileIdentity,
    artifact_digest: [u8; 32],
    supervisor: Identity,
    manager: Identity,
    backend: Identity,
    writer: Identity,
    family_epoch: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    file_id: [u8; 16],
}
impl Binding {
    fn validate(&self) -> Result<()> {
        if self.namespace != "codenomad-missions/v2"
            || self.authority_namespace != "codenomad-missions/authority-v2"
            || self.scope.is_empty()
            || self.generation.is_empty()
            || self.project_id.is_empty()
            || self.canonical_project.is_empty()
            || self.location.is_empty()
            || self.family_epoch == 0
            || self.namespace_id == [0; 16]
            || [
                self.registration_id,
                self.incarnation_id,
                self.signer,
                self.human_origin,
                self.invocation_id,
                self.signed_intent_digest,
                self.provisioning,
                self.profile,
                self.artifact_digest,
            ]
            .iter()
            .any(|v| *v == [0; 32])
            || self.daemon_storage.file_id == [0; 16]
            || self.daemon_storage.volume == 0
            || self.artifact.file_id == [0; 16]
            || self.artifact.volume == 0
            || [self.supervisor, self.manager, self.backend, self.writer]
                .iter()
                .any(|p| p.pid == 0 || p.creation_filetime == 0)
        {
            return Err(Error("native-missions-provenance-unqualified"));
        }
        for s in [
            &self.generation,
            &self.scope,
            &self.project_id,
            &self.canonical_project,
            &self.location,
        ] {
            if s.len() > 4096 || s.contains('\0') {
                return Err(Error("native-missions-provenance-bound"));
            }
            // Windows/WSL translation is not a native family proof.
            let lower = s.to_ascii_lowercase();
            if lower.starts_with("\\\\wsl")
                || lower.starts_with("//wsl")
                || lower.starts_with("/mnt/")
            {
                return Err(Error("native-missions-wsl-provenance-unresolved"));
            }
        }
        for s in [&self.canonical_project, &self.location] {
            let p = s.as_bytes();
            if p.len() < 3
                || !p[0].is_ascii_alphabetic()
                || p[1] != b':'
                || ![b'/', b'\\'].contains(&p[2])
            {
                return Err(Error("native-missions-project-provenance-unresolved"));
            }
        }
        Ok(())
    }
    fn same_write_domain(&self, other: &Self) -> bool {
        self.namespace == other.namespace
            && self.namespace_id == other.namespace_id
            && self.project_id == other.project_id
            && self.canonical_project == other.canonical_project
            && self.daemon_storage == other.daemon_storage
    }
}

/// No production constructor: qualifying retained internal writer/storage/family
/// handles is an upstream prerequisite, not satisfied by the process owner alone.
struct Evidence {
    binding: Binding,
    retained: Option<native::Retained>,
    #[cfg(test)]
    live: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(test)]
    human_live: Arc<std::sync::atomic::AtomicBool>,
}
impl Evidence {
    fn revalidate(&self) -> Result<()> {
        self.binding.validate()?;
        if let Some(retained) = &self.retained {
            return retained.revalidate(&self.binding);
        }
        #[cfg(test)]
        if self.live.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        Err(Error("native-missions-writer-producer-unavailable"))
    }
    fn revalidate_human(&self) -> Result<()> {
        self.revalidate()?;
        #[cfg(test)]
        if self.human_live.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        Err(Error("native-missions-human-origin-producer-unavailable"))
    }
}
struct ChannelEntry {
    evidence: Arc<Evidence>,
}
struct RegistrationEntry {
    channel: u64,
    evidence: Arc<Evidence>,
}
struct LeaseEntry {
    registration: u64,
    human_origin: [u8; 32],
    expires: Instant,
}
struct GuardEntry {
    registration: u64,
    lease: u64,
}
#[derive(Default)]
struct State {
    next: u64,
    closed: bool,
    channels: HashMap<u64, ChannelEntry>,
    registrations: HashMap<u64, RegistrationEntry>,
    leases: HashMap<u64, LeaseEntry>,
    guards: HashMap<u64, GuardEntry>,
    inventory: inventory::InventoryLedger,
}
#[derive(Default)]
struct Guardian {
    state: Mutex<State>,
}
#[derive(Clone)]
pub(crate) struct Channel {
    guardian: Arc<Guardian>,
    id: u64,
}
#[derive(Clone)]
pub(crate) struct Registration {
    guardian: Arc<Guardian>,
    id: u64,
}
#[derive(Clone)]
pub(crate) struct HumanLease {
    guardian: Arc<Guardian>,
    id: u64,
}
#[derive(Clone)]
pub(crate) struct CommitGuard {
    guardian: Arc<Guardian>,
    id: u64,
}

impl Guardian {
    fn fence(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error("native-missions-guardian-poisoned"))?;
        state.closed = true;
        let bindings: Vec<_> = state.registrations.values().map(|r| r.evidence.binding.clone()).collect();
        for binding in bindings { state.inventory.mark_unknown(&binding); }
        state.guards.clear();
        state.leases.clear();
        state.registrations.clear();
        state.channels.clear();
        Ok(())
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error("native-missions-guardian-poisoned"))?;
        if state.closed {
            return Err(Error("native-missions-channel-closed"));
        }
        Ok(state)
    }
}
fn same(a: &Arc<Guardian>, b: &Arc<Guardian>) -> Result<()> {
    if Arc::ptr_eq(a, b) {
        Ok(())
    } else {
        Err(Error("native-missions-capability-owner-mismatch"))
    }
}

pub(crate) fn open(client: &crate::native_client::Client, challenge: &[u8]) -> Result<Channel> {
    client.revalidate()?;
    if client.boot.role != "manager" || challenge.len() != 32 {
        return Err(Error("native-missions-channel-admission-refused"));
    }
    // An explicit version exchange through the retained authenticated native pipe;
    // old supervisors refuse the new method rather than silently using runtime.v1.
    let reply = client
        .rpc(
            serde_json::json!({"method":"missionsHello", "protocol":PROTOCOL,
        "challenge":crate::service_permit::hex(challenge)}),
        )
        .map_err(|_| Error("native-missions-protocol-unavailable"))?;
    client.revalidate()?;
    admit_producer(&reply, challenge)
}
fn admit_producer(reply: &serde_json::Value, challenge: &[u8]) -> Result<Channel> {
    crate::mission_channel_wire::validate_hello(reply, challenge)?;
    // Even a forged/misconfigured peer saying `available:true` cannot mint local
    // authority. Only an internal retained producer can create the owned evidence.
    Err(Error("native-missions-writer-producer-unavailable"))
}
