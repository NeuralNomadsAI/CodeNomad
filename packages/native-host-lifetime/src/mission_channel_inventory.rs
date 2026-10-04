//! Complete runtime inventory and explicit disposal protocol. Capability GC,
//! deadline expiry and process loss only mark unknown; none produces a receipt.
//! There is deliberately no production constructor for either producer witness:
//! the public OpenCode plugin ABI has no internal inventory/disposal producer.
use super::{Binding, Error, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

const LIMIT: usize = 64;
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct Key { registration: [u8; 32], incarnation: [u8; 32] }
#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    key: Key,
    provenance: Binding,
    kind: &'static str,
    state: &'static str,
}
impl Record {
    fn managed(binding: &Binding) -> Self {
        Self { key: Key { registration: binding.registration_id, incarnation: binding.incarnation_id },
            provenance: binding.clone(), kind: "managed", state: "active" }
    }
}
// Empty outside cfg(test). A native process handle or authenticated echo cannot
// create this witness; an upstream trusted runtime producer is mandatory.
enum RuntimeProducerWitness { #[cfg(test)] Test }
struct CompleteInventoryProof {
    revision: u64,
    records: Vec<Record>,
    witness: RuntimeProducerWitness,
}
struct DisposalProof {
    subject: Record,
    action: [u8; 32],
    receipt: [u8; 32],
    witness: RuntimeProducerWitness,
}
struct Receipt { subject: Record, action: [u8; 32], receipt: [u8; 32] }
#[derive(Default)]
pub(super) struct InventoryLedger {
    revision: u64,
    complete: bool,
    entries: HashMap<Key, Record>,
    disposals: HashMap<Key, Receipt>,
}
impl InventoryLedger {
    pub(super) fn record_managed(&mut self, binding: &Binding) -> Result<()> {
        binding.validate()?;
        let record = Record::managed(binding);
        if let Some(existing) = self.entries.get(&record.key) {
            if existing == &record { return Ok(()); }
            return Err(Error("native-missions-writer-inventory-conflict"));
        }
        if self.entries.len() >= LIMIT { return Err(Error("native-missions-inventory-capacity")); }
        self.complete = false;
        self.entries.insert(record.key, record);
        Ok(())
    }
    pub(super) fn mark_unknown(&mut self, binding: &Binding) {
        let key = Key { registration: binding.registration_id, incarnation: binding.incarnation_id };
        if let Some(record) = self.entries.get_mut(&key) {
            if record.state != "disposed" { record.state = "unknown"; self.complete = false; }
        }
    }
    fn observe_complete(&mut self, proof: CompleteInventoryProof) -> Result<()> {
        let _witness = proof.witness;
        if proof.revision <= self.revision || proof.records.len() > LIMIT {
            return Err(Error("native-missions-inventory-revision-or-bound"));
        }
        let mut next = HashMap::new();
        for record in proof.records {
            record.provenance.validate()?;
            if !["managed", "legacy", "unknown"].contains(&record.kind)
                || !["active", "disposed", "unknown"].contains(&record.state)
                || record.key.registration != record.provenance.registration_id
                || record.key.incarnation != record.provenance.incarnation_id
                || next.insert(record.key, record.clone()).is_some() {
                return Err(Error("native-missions-inventory-invalid"));
            }
            if record.state == "disposed" && !self.disposals.contains_key(&record.key) {
                return Err(Error("native-missions-explicit-disposal-required"));
            }
        }
        // Missing prior entries require actual disposal, never presence expiry.
        for (key, old) in &self.entries {
            if !next.contains_key(key) && !self.disposals.contains_key(key) {
                return Err(Error("native-missions-explicit-disposal-required"));
            }
            if let Some(current) = next.get(key) {
                if current.provenance != old.provenance || current.kind != old.kind {
                    return Err(Error("native-missions-writer-incarnation-reused"));
                }
                if old.state == "disposed" && current.state != "disposed" {
                    return Err(Error("native-missions-writer-incarnation-reused"));
                }
            }
        }
        self.entries = next; self.revision = proof.revision; self.complete = true;
        Ok(())
    }
    fn apply_disposal(&mut self, proof: DisposalProof) -> Result<()> {
        let _witness = proof.witness;
        let key = proof.subject.key;
        let current = self.entries.get(&key).ok_or(Error("native-missions-disposal-subject-unknown"))?;
        if current.provenance != proof.subject.provenance || current.kind != proof.subject.kind
            || current.state == "disposed" || proof.action == [0; 32] || proof.receipt == [0; 32]
            || self.disposals.len() >= LIMIT
            || self.disposals.values().any(|r| r.receipt == proof.receipt) {
            return Err(Error("native-missions-disposal-proof-mismatch"));
        }
        self.entries.get_mut(&key).unwrap().state = "disposed";
        self.disposals.insert(key, Receipt { subject: proof.subject, action: proof.action, receipt: proof.receipt });
        // Receipt admission does not imply a subsequent complete inventory.
        self.complete = false;
        Ok(())
    }
    pub(super) fn assert_quiescence(&self, binding: &Binding) -> Result<()> {
        if !self.complete { return Err(Error("native-missions-complete-inventory-producer-unavailable")); }
        let active: Vec<_> = self.entries.values().filter(|e| e.state == "active").collect();
        if active.len() != 1 || active[0].kind != "managed" || active[0].provenance != *binding
            || self.entries.values().any(|e| e.kind == "unknown" || e.state == "unknown"
                || e.state == "disposed" && !self.disposals.contains_key(&e.key)) {
            return Err(Error("native-missions-explicit-quiescence-unproven"));
        }
        Ok(())
    }
    pub(super) fn projection(&self) -> Value {
        let mut entries: Vec<_> = self.entries.values().collect();
        entries.sort_by_key(|e| (e.key.registration, e.key.incarnation));
        let mut disposals: Vec<_> = self.disposals.values().collect();
        disposals.sort_by_key(|r| (r.subject.key.registration, r.subject.key.incarnation));
        json!({"revision":self.revision,"complete":self.complete,
            "entries":entries.iter().map(|e| json!({"registrationID":crate::service_permit::hex(&e.key.registration),
                "incarnationID":crate::service_permit::hex(&e.key.incarnation),"kind":e.kind,"state":e.state,
                "artifactDigest":crate::service_permit::hex(&e.provenance.artifact_digest)})).collect::<Vec<_>>(),
            "disposals":disposals.iter().map(|r| json!({"registrationID":crate::service_permit::hex(&r.subject.key.registration),
                "incarnationID":crate::service_permit::hex(&r.subject.key.incarnation),
                "actionID":crate::service_permit::hex(&r.action),"receiptID":crate::service_permit::hex(&r.receipt)})).collect::<Vec<_>>()})
    }
}

#[cfg(test)]
#[path = "mission_channel_inventory_tests.rs"]
mod tests;
