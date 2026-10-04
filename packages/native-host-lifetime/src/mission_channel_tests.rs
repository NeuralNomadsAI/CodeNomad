//! Algorithm tests only; fake evidence is cfg(test), never native qualification.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Barrier;

pub(super) fn binding() -> Binding {
    Binding {
        registration_id: [8; 32],
        incarnation_id: [9; 32],
        signer: [1; 32],
        human_origin: [7; 32],
        invocation_id: [10; 32],
        signed_intent_digest: [11; 32],
        provisioning: [2; 32],
        profile: [3; 32],
        generation: "generation-a".into(),
        scope: "owned-profile-a".into(),
        namespace_id: [12; 16],
        namespace: "codenomad-missions/v2".into(),
        authority_namespace: "codenomad-missions/authority-v2".into(),
        project_id: "project-a".into(),
        canonical_project: "C:/fixture/project".into(),
        location: "C:/fixture/project/worktree".into(),
        daemon_storage: FileIdentity {
            volume: 1,
            file_id: [4; 16],
        },
        artifact: FileIdentity {
            volume: 2,
            file_id: [5; 16],
        },
        artifact_digest: [6; 32],
        supervisor: Identity {
            pid: 10,
            creation_filetime: 100,
        },
        manager: Identity {
            pid: 20,
            creation_filetime: 200,
        },
        backend: Identity { pid: 21, creation_filetime: 201 },
        writer: Identity {
            pid: 30,
            creation_filetime: 300,
        },
        family_epoch: 1,
    }
}
fn fixture() -> (Channel, Registration, Arc<AtomicBool>) {
    let g = Arc::new(Guardian::default());
    let live = Arc::new(AtomicBool::new(true));
    let evidence = Arc::new(Evidence {
        binding: binding(),
        retained: None,
        live: live.clone(),
        human_live: Arc::new(AtomicBool::new(true)),
    });
    let c = add_channel(&g, evidence.clone()).unwrap();
    let r = add_registration(&c, evidence).unwrap();
    (c, r, live)
}
fn add_channel(g: &Arc<Guardian>, evidence: Arc<Evidence>) -> Result<Channel> {
    evidence.revalidate()?;
    let mut s = g.lock()?;
    s.reap();
    if s.channels.len() >= CAPACITY {
        return Err(Error("native-missions-capacity"));
    }
    let id = s.next()?;
    s.channels.insert(id, ChannelEntry { evidence });
    Ok(Channel {
        guardian: g.clone(),
        id,
    })
}
fn add_registration(c: &Channel, evidence: Arc<Evidence>) -> Result<Registration> {
    evidence.revalidate()?;
    let mut s = c.guardian.lock()?;
    s.reap();
    if s.channel(c.id)?.evidence.binding != evidence.binding {
        return Err(Error("native-missions-registration-provenance-mismatch"));
    }
    if s.registrations.len() >= CAPACITY {
        return Err(Error("native-missions-capacity"));
    }
    let id = s.next()?;
    s.inventory.record_managed(&evidence.binding)?;
    s.registrations.insert(
        id,
        RegistrationEntry {
            channel: c.id,
            evidence,
        },
    );
    Ok(Registration {
        guardian: c.guardian.clone(),
        id,
    })
}
fn ready() -> (Channel, Registration, HumanLease, CommitGuard) {
    let (c, r, _) = fixture();
    let l = c.acquire(&r, MAX_LEASE_MS).unwrap();
    let g = c.begin(&r, &l).unwrap();
    (c, r, l, g)
}

#[test]
fn retained_capability_kind_owner_and_disposal_fences() {
    let (c, r, l, g) = ready();
    assert_eq!(c.inventory().unwrap().len(), 1);
    g.assert().unwrap();
    let (other, foreign, _) = fixture();
    assert!(c.assert_registration(&foreign).is_err());
    assert!(other.acquire(&r, 10).is_err());
    assert!(other.begin(&foreign, &l).is_err());
    r.dispose().unwrap();
    assert!(c.assert_registration(&r).is_err());
    assert!(l.assert().is_err());
    assert!(g.assert().is_err());
    assert_eq!(c.inventory().unwrap().len(), 0);
    r.dispose().unwrap();
    l.dispose().unwrap();
    g.dispose().unwrap();
    c.dispose().unwrap();
    c.dispose().unwrap();
    assert!(c.assert().is_err());
    assert!(c.inventory().is_err());
}
#[test]
fn every_provenance_dimension_is_exact_not_a_caller_receipt() {
    let (c, _, _) = fixture();
    let base = binding();
    let mut changed = Vec::new();
    macro_rules! change {
        ($field:ident, $value:expr) => {{
            let mut b = base.clone();
            b.$field = $value;
            changed.push(b);
        }};
    }
    change!(signer, [9; 32]);
    change!(registration_id, [12; 32]);
    change!(incarnation_id, [12; 32]);
    change!(human_origin, [9; 32]);
    change!(invocation_id, [12; 32]);
    change!(signed_intent_digest, [12; 32]);
    change!(provisioning, [9; 32]);
    change!(profile, [9; 32]);
    change!(generation, "generation-b".into());
    change!(scope, "scope-b".into());
    change!(namespace_id, [13; 16]);
    change!(namespace, "codenomad-missions/v1".into());
    change!(
        authority_namespace,
        "codenomad-missions/authority-v1".into()
    );
    change!(project_id, "project-b".into());
    change!(canonical_project, "C:/other".into());
    change!(location, "C:/other/tree".into());
    change!(
        daemon_storage,
        FileIdentity {
            volume: 9,
            file_id: [4; 16]
        }
    );
    change!(
        artifact,
        FileIdentity {
            volume: 2,
            file_id: [9; 16]
        }
    );
    change!(artifact_digest, [9; 32]);
    change!(
        supervisor,
        Identity {
            pid: 10,
            creation_filetime: 101
        }
    );
    change!(
        manager,
        Identity {
            pid: 20,
            creation_filetime: 201
        }
    );
    change!(
        writer,
        Identity {
            pid: 30,
            creation_filetime: 301
        }
    );
    change!(family_epoch, 2);
    change!(backend, Identity { pid: 21, creation_filetime: 202 });
    for b in changed {
        assert!(add_registration(
            &c,
            Arc::new(Evidence {
                binding: b,
                retained: None,
                live: Arc::new(AtomicBool::new(true)),
                human_live: Arc::new(AtomicBool::new(true))
            })
        )
        .is_err());
    }
}
#[test]
fn unknown_family_wsl_paths_and_unqualified_identity_refuse() {
    for path in [
        "\\\\wsl.localhost\\Ubuntu\\home\\project",
        "\\\\WSL$\\Ubuntu\\project",
        "/mnt/c/project",
        "/home/project",
        "relative",
    ] {
        let mut b = binding();
        b.location = path.into();
        assert!(b.validate().is_err());
    }
    let mut b = binding();
    b.family_epoch = 0;
    assert!(b.validate().is_err());
    b = binding();
    b.signer = [0; 32];
    assert!(b.validate().is_err());
    b = binding();
    b.writer.creation_filetime = 0;
    assert!(b.validate().is_err());
    b = binding();
    b.daemon_storage.file_id = [0; 16];
    assert!(b.validate().is_err());
}
#[test]
fn authoritative_inventory_reaps_loss_and_dependent_guards() {
    let (c, r, live) = fixture();
    let l = c.acquire(&r, MAX_LEASE_MS).unwrap();
    let g = c.begin(&r, &l).unwrap();
    live.store(false, Ordering::Release);
    assert!(c.inventory().is_err());
    let s = c.guardian.lock().unwrap();
    assert!(
        s.channels.is_empty()
            && s.registrations.is_empty()
            && s.leases.is_empty()
            && s.guards.is_empty()
    );
    drop(s);
    assert!(g.test_native_effect(|| Ok(())).is_err());
}
#[test]
fn concurrent_acquisition_has_one_winner_and_expiry_revokes_guards() {
    let (c, r, _) = fixture();
    let gate = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let (c, r, gate) = (c.clone(), r.clone(), gate.clone());
        workers.push(std::thread::spawn(move || {
            gate.wait();
            c.acquire(&r, MAX_LEASE_MS)
        }));
    }
    gate.wait();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let l = results.into_iter().find_map(Result::ok).unwrap();
    let g = c.begin(&r, &l).unwrap();
    c.guardian
        .lock()
        .unwrap()
        .leases
        .get_mut(&l.id)
        .unwrap()
        .expires = Instant::now();
    assert!(l.assert().is_err());
    assert!(g.assert().is_err());
    let next = c.acquire(&r, MAX_LEASE_MS).unwrap();
    assert!(c.begin(&r, &next).is_ok());
}
#[test]
fn duplicate_writer_views_cannot_acquire_two_leases() {
    let (c, r, _) = fixture();
    let evidence = c.guardian.lock().unwrap().channels[&c.id].evidence.clone();
    let duplicate = add_registration(&c, evidence).unwrap();
    let l = c.acquire(&r, MAX_LEASE_MS).unwrap();
    assert!(c.acquire(&duplicate, MAX_LEASE_MS).is_err());
    l.dispose().unwrap();
    assert!(c.acquire(&duplicate, MAX_LEASE_MS).is_ok());
}
#[test]
fn revocation_during_await_preparation_prevents_irreversible_effect() {
    let (c, _, _, guard) = ready();
    let gate = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    let effects = Arc::new(AtomicUsize::new(0));
    let (g, a, b, n) = (guard.clone(), gate.clone(), resume.clone(), effects.clone());
    let worker = std::thread::spawn(move || {
        a.wait(); // Prepared guard exists, asynchronous external preparation starts.
        b.wait(); // Resume only after native revocation has returned.
        g.test_native_effect(|| {
            n.fetch_add(1, Ordering::AcqRel);
            Ok(())
        })
    });
    gate.wait();
    c.dispose().unwrap();
    resume.wait();
    assert!(worker.join().unwrap().is_err());
    assert_eq!(effects.load(Ordering::Acquire), 0);
}
#[test]
fn native_effect_and_revocation_are_linearizable_no_post_revocation_effect() {
    // Unordered race: native effect either wins the single lock and finishes
    // before revocation returns, or revocation wins and prevents it entirely.
    for _ in 0..64 {
        let (c, _, _, g) = ready();
        let gate = Arc::new(Barrier::new(3));
        let revoked = Arc::new(AtomicBool::new(false));
        let effects = Arc::new(AtomicUsize::new(0));
        let (start, done, count) = (gate.clone(), revoked.clone(), effects.clone());
        let effect = std::thread::spawn(move || {
            start.wait();
            g.test_native_effect(|| {
                assert!(!done.load(Ordering::Acquire));
                count.fetch_add(1, Ordering::AcqRel);
                Ok(())
            })
        });
        let (start, done) = (gate.clone(), revoked.clone());
        let revoke = std::thread::spawn(move || {
            start.wait();
            c.dispose().unwrap();
            done.store(true, Ordering::Release);
        });
        gate.wait();
        let result = effect.join().unwrap();
        revoke.join().unwrap();
        assert_eq!(effects.load(Ordering::Acquire), usize::from(result.is_ok()));
    }
}
#[test]
fn commit_guard_is_exclusive_one_shot_and_never_claims_async_storage_atomicity() {
    let (c, r, l, g) = ready();
    assert!(c.begin(&r, &l).is_err());
    assert_eq!(
        g.commit(),
        Err(Error(
            "native-missions-storage-transaction-producer-unavailable"
        ))
    );
    assert!(g.assert().is_err());
    assert!(g.commit().is_err());
    let next = c.begin(&r, &l).unwrap();
    assert_eq!(
        next.test_native_effect(|| Err::<(), _>(Error("test-effect-failure"))),
        Err(Error("test-effect-failure"))
    );
    assert!(next.assert().is_err());
    assert!(c.begin(&r, &l).is_ok());
}
#[test]
fn bounded_inventory_counter_overflow_and_poison_fail_closed() {
    let (c, _, _) = fixture();
    let evidence = c.guardian.lock().unwrap().channels[&c.id].evidence.clone();
    for _ in 1..CAPACITY {
        add_registration(&c, evidence.clone()).unwrap();
    }
    assert_eq!(c.inventory().unwrap().len(), CAPACITY);
    assert!(add_registration(&c, evidence).is_err());
    c.guardian.lock().unwrap().next = u64::MAX;
    let r = c.inventory().unwrap()[0].clone();
    assert!(c.acquire(&r, 10).is_err());
    let (c, _, _, g) = ready();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _lock = c.guardian.state.lock().unwrap();
        panic!("test guardian poison");
    }))
    .is_err());
    assert_eq!(g.assert(), Err(Error("native-missions-guardian-poisoned")));
    assert!(g.test_native_effect(|| Ok(())).is_err());
}

#[test]
fn capability_release_and_process_loss_are_never_explicit_disposal_receipts() {
    let (c, r, _) = fixture();
    assert!(c.assert_quiescence().is_err());
    let before = c.writer_inventory().unwrap();
    assert_eq!(before["complete"], false);
    r.dispose().unwrap();
    let after = c.writer_inventory().unwrap();
    assert_eq!(after["entries"][0]["state"], "unknown");
    assert_eq!(after["disposals"].as_array().unwrap().len(), 0);
    assert!(c.assert_quiescence().is_err());
}

#[test]
fn originating_human_revocation_fences_commit_without_unregistering_writer() {
    let (c, r, l, g) = ready();
    let human = c.guardian.lock().unwrap().registrations[&r.id]
        .evidence
        .human_live
        .clone();
    human.store(false, Ordering::Release);
    c.assert_registration(&r).unwrap(); // writer remains live, human authority does not
    assert!(l.assert().is_err());
    assert!(g.test_native_effect(|| Ok(())).is_err());
    assert!(c.acquire(&r, 100).is_err());
    assert_eq!(c.inventory().unwrap().len(), 1);
}

#[test]
fn protocol_availability_flags_never_mint_native_writer_authority() {
    let challenge = [7; 32];
    let reply = serde_json::json!({"protocol":PROTOCOL,"challenge":crate::service_permit::hex(&challenge),
        "writerProducer":true,"familyProducer":true,"transactionProducer":true});
    assert!(matches!(
        admit_producer(&reply, &challenge),
        Err(Error("native-missions-writer-producer-unavailable"))
    ));
}

#[test]
fn guardian_shutdown_revokes_all_owned_capabilities_before_returning() {
    let (c, r, l, g) = ready();
    c.guardian.fence().unwrap();
    c.guardian.fence().unwrap();
    assert!(c.assert().is_err());
    assert!(c.assert_registration(&r).is_err());
    assert!(l.assert().is_err());
    assert!(g.test_native_effect(|| Ok(())).is_err());
    let s = c.guardian.state.lock().unwrap();
    assert!(
        s.closed
            && s.channels.is_empty()
            && s.registrations.is_empty()
            && s.leases.is_empty()
            && s.guards.is_empty()
    );
}
