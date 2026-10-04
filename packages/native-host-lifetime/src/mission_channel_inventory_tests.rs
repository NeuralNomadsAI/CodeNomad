//! Producer witnesses in these tests are algorithm fixtures, never native proof.
use super::*;
fn observed(revision: u64, records: Vec<Record>) -> CompleteInventoryProof {
    CompleteInventoryProof { revision, records, witness: RuntimeProducerWitness::Test }
}
#[test]
fn unknown_loss_or_missing_writer_never_certifies_disposal() {
    let b = super::super::tests::binding();
    let mut ledger = InventoryLedger::default();
    ledger.record_managed(&b).unwrap();
    assert!(ledger.assert_quiescence(&b).is_err());
    assert!(ledger.observe_complete(observed(1, vec![])).is_err());
    ledger.mark_unknown(&b);
    assert_eq!(ledger.projection()["entries"][0]["state"], "unknown");
    assert_eq!(ledger.projection()["disposals"].as_array().unwrap().len(), 0);
    assert!(ledger.assert_quiescence(&b).is_err());
}
#[test]
fn exact_explicit_disposal_and_fresh_complete_inventory_are_both_required() {
    let b = super::super::tests::binding();
    let managed = Record::managed(&b);
    let mut old_binding = b.clone();
    old_binding.registration_id = [22; 32]; old_binding.incarnation_id = [23; 32];
    let mut legacy = Record::managed(&old_binding); legacy.kind = "legacy";
    let mut ledger = InventoryLedger::default();
    ledger.observe_complete(observed(1, vec![managed.clone(), legacy.clone()])).unwrap();
    assert!(ledger.assert_quiescence(&b).is_err());
    assert!(ledger.observe_complete(observed(2, vec![managed.clone()])).is_err());
    let mut wrong = legacy.clone(); wrong.provenance.artifact_digest = [24; 32];
    assert!(ledger.apply_disposal(DisposalProof { subject: wrong, action:[25;32], receipt:[26;32], witness:RuntimeProducerWitness::Test }).is_err());
    ledger.apply_disposal(DisposalProof { subject:legacy.clone(), action:[25;32], receipt:[26;32], witness:RuntimeProducerWitness::Test }).unwrap();
    assert!(ledger.assert_quiescence(&b).is_err());
    legacy.state = "disposed";
    ledger.observe_complete(observed(2, vec![managed, legacy])).unwrap();
    ledger.assert_quiescence(&b).unwrap();
    assert_eq!(ledger.projection()["disposals"].as_array().unwrap().len(), 1);
}
#[test]
fn stale_complete_inventory_duplicate_incarnations_and_zero_receipts_refuse() {
    let b = super::super::tests::binding();
    let record = Record::managed(&b);
    let mut ledger = InventoryLedger::default();
    assert!(ledger.observe_complete(observed(1, vec![record.clone(), record.clone()])).is_err());
    ledger.observe_complete(observed(1, vec![record.clone()])).unwrap();
    assert!(ledger.observe_complete(observed(1, vec![record.clone()])).is_err());
    assert!(ledger.apply_disposal(DisposalProof { subject:record.clone(), action:[0;32], receipt:[26;32], witness:RuntimeProducerWitness::Test }).is_err());
    let mut changed = record; changed.provenance.writer.creation_filetime += 1;
    assert!(ledger.observe_complete(observed(2, vec![changed])).is_err());
    ledger.assert_quiescence(&b).unwrap();
}
#[test]
fn releasing_a_borrowed_registration_cannot_reactivate_an_unknown_writer() {
    let b = super::super::tests::binding();
    let mut ledger = InventoryLedger::default();
    ledger.record_managed(&b).unwrap(); ledger.mark_unknown(&b);
    assert!(ledger.record_managed(&b).is_err());
    assert!(ledger.assert_quiescence(&b).is_err());
}
