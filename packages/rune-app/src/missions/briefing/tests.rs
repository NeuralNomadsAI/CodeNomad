use super::*;
use serde_json::json;

fn header_with(briefing: serde_json::Value, responses: serde_json::Value) -> MapHeader {
    let mut root = json!({
        "id": "msn-1",
        "title": "Mission",
        "excerpt": "Objective",
        "status": "active",
        "runState": "running",
        "revision": 3,
        "projectID": "proj-1",
        "projectCanonical": "/repo",
        "coordinatorSessionId": "ses_coord",
        "version": 1,
        "template": "custom",
        "createdAt": 1.0,
        "updatedAt": 2.0,
        "historyTruncated": false,
        "bodies": {}
    });
    if !briefing.is_null() {
        root["briefing"] = briefing;
    }
    if !responses.is_null() {
        root["briefingResponses"] = responses;
    }
    serde_json::from_value(json!({
        "root": root,
        "tasks": {
            "page": {
                "order": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "offset": 0,
                "end": 0,
                "total": 0,
                "counts": {},
                "reports": 0
            },
            "pins": [],
            "reportPins": [],
            "version": "1"
        },
        "collections": {
            "actors": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true},
            "history": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true},
            "reports": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true}
        }
    }))
    .unwrap()
}

fn backend() -> Backend {
    let mut b = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    b.workspace = "ws-1".into();
    b
}

fn active<'a>(
    occurrence: &'a str,
    key: &'a BriefingKey,
    header: &'a MapHeader,
    backend: &'a Backend,
    wake: &'a Wake,
    failed: bool,
) -> ActiveBriefing<'a> {
    ActiveBriefing {
        occurrence,
        key,
        header,
        backend,
        wake,
        failed,
    }
}

fn insert_preparing(
    store: &mut BriefingRequests,
    key: &BriefingKey,
    req_id: &str,
    occ: &str,
    b: Backend,
    header: &MapHeader,
) -> (Sender<BriefingAdmissionOutcome>, Receiver<()>) {
    let (cancel, cancelled) = bounded(1);
    let (out, inbox) = bounded(1);
    store.entries.insert(
        key.clone(),
        BriefingEntry {
            request_id: req_id.into(),
            phase: BriefingPhase::Preparing,
            flight: Some(Flight::Preparing {
                occurrence: occ.into(),
                backend: b,
                target: header.briefing_target(),
                locale: "en".into(),
                cancel,
                inbox,
            }),
            touched: 1,
        },
    );
    (out, cancelled)
}

fn insert_sending(
    store: &mut BriefingRequests,
    key: &BriefingKey,
    req_id: &str,
    occ: &str,
    b: Backend,
    header: &MapHeader,
) -> Sender<BriefingSendOutcome> {
    let (out, inbox) = bounded(1);
    store.entries.insert(
        key.clone(),
        BriefingEntry {
            request_id: req_id.into(),
            phase: BriefingPhase::Sending,
            flight: Some(Flight::Sending {
                occurrence: occ.into(),
                backend: b,
                target: header.briefing_target(),
                abandoned: false,
                inbox,
            }),
            touched: 1,
        },
    );
    out
}

#[test]
fn uncertain_persists_across_auto_briefings_and_reopened_project_workspaces() {
    let b = backend();
    let wake: Wake = std::sync::Arc::new(|| {});
    let h_auto = header_with(
        json!({"id": "brf-auto", "requestID": "auto:3"}),
        json!([{"requestID": "req-other", "briefingID": "brf-other"}]),
    );
    let key = BriefingKey::fixture(&h_auto);
    let reopened_key = BriefingKey::fixture(&h_auto);
    assert_eq!(key, reopened_key);

    let mut store = BriefingRequests::default();
    store.fixture_phase(&key, "req-1", BriefingPhase::Uncertain);

    assert!(!store.reconcile(Some(active(
        "tab-0",
        &reopened_key,
        &h_auto,
        &b,
        &wake,
        false
    ))));
    assert_eq!(
        store.visible_phase(&reopened_key, &h_auto),
        Some(&BriefingPhase::Uncertain)
    );
    assert!(store.waiting(&reopened_key, &h_auto));

    let h_answered = header_with(
        json!({"id": "brf-auto-4", "requestID": "auto:4"}),
        json!([{"requestID": "req-1", "briefingID": "brf-exact"}]),
    );
    assert!(store.reconcile(Some(active(
        "tab-0",
        &reopened_key,
        &h_answered,
        &b,
        &wake,
        false
    ))));
    assert_eq!(store.visible_phase(&reopened_key, &h_answered), None);
    assert!(!store.waiting(&reopened_key, &h_answered));
    assert_eq!(
        store.entries[&reopened_key].phase,
        BriefingPhase::Answered {
            briefing_id: "brf-exact".into()
        }
    );
}

#[test]
fn two_step_handshake_abandons_admitted_get_if_view_left_before_ui_commits_sending() {
    let b = backend();
    let header = header_with(json!(null), json!(null));
    let key = BriefingKey::fixture(&header);
    let mut store = BriefingRequests::default();

    // Worker finishes GET .../admission with Admitted, but the user closed the panel
    // or switched tabs before the UI thread polled -> UI abandons as Error, zero POST spawned!
    let (out, cancelled) =
        insert_preparing(&mut store, &key, "req-stale", "tab-0", b.clone(), &header);
    out.try_send(BriefingAdmissionOutcome::Admitted).unwrap();
    assert!(store.reconcile(None));
    assert!(cancelled.is_closed());
    assert!(store.entries[&key].flight.is_none());
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Error)
    );

    // Same if the user switched to another tab ("tab-1") with the same Mission!
    let wake: Wake = std::sync::Arc::new(|| {});
    let (out2, cancelled2) =
        insert_preparing(&mut store, &key, "req-tab", "tab-0", b.clone(), &header);
    out2.try_send(BriefingAdmissionOutcome::Admitted).unwrap();
    assert!(store.reconcile(Some(active("tab-1", &key, &header, &b, &wake, false))));
    assert!(cancelled2.is_closed());
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Error)
    );

    // Once Sending is committed on UI thread and the view stays current, an ACK
    // promotes to Admitted (context loss is covered in the dedicated test below).
    let send_out = insert_sending(&mut store, &key, "req-send", "tab-0", b.clone(), &header);
    assert!(!store.reconcile(Some(active("tab-0", &key, &header, &b, &wake, false))));
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Sending)
    );
    send_out
        .try_send(BriefingSendOutcome {
            state: BriefingSendState::Admitted {
                message_id: "msg-ok".into(),
            },
            auth_expired: false,
        })
        .unwrap();
    drop(send_out);
    assert!(store.poll());
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Admitted {
            message_id: "msg-ok".into(),
        })
    );
}

#[test]
fn context_loss_after_sending_turns_uncertain_and_rejects_late_ack() {
    let b = backend();
    let header = header_with(json!(null), json!(null));
    let key = BriefingKey::fixture(&header);
    let wake: Wake = std::sync::Arc::new(|| {});
    let mut store = BriefingRequests::default();

    // Case 1: panel hidden while POST is in flight -> immediately Uncertain,
    // flight kept until drain, and late Admitted ACK must NOT overwrite Uncertain.
    let send_out = insert_sending(
        &mut store,
        &key,
        "req-lost-hide",
        "tab-0",
        b.clone(),
        &header,
    );
    assert!(store.reconcile(None));
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Uncertain)
    );
    assert!(store.entries[&key].flight.is_some());
    assert!(store.waiting(&key, &header));

    send_out
        .try_send(BriefingSendOutcome {
            state: BriefingSendState::Admitted {
                message_id: "msg-late".into(),
            },
            auth_expired: false,
        })
        .unwrap();
    drop(send_out);
    assert!(store.poll());
    assert!(store.entries[&key].flight.is_none());
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Uncertain)
    );

    // Case 2: tab switched while POST is in flight -> Uncertain, late 401 still captured.
    let send_out2 = insert_sending(
        &mut store,
        &key,
        "req-lost-tab",
        "tab-0",
        b.clone(),
        &header,
    );
    assert!(store.reconcile(Some(active("tab-1", &key, &header, &b, &wake, false))));
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Uncertain)
    );
    send_out2
        .try_send(BriefingSendOutcome {
            state: BriefingSendState::Uncertain,
            auth_expired: true,
        })
        .unwrap();
    drop(send_out2);
    assert!(store.poll());
    assert!(store.entries[&key].flight.is_none());
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Uncertain)
    );
    assert_eq!(store.take_auth_expired().len(), 1);
}

#[test]
fn early_exact_answer_blocks_replacement_until_sending_drains_and_preserves_late_401() {
    let b = backend();
    let header = header_with(json!(null), json!(null));
    let key = BriefingKey::fixture(&header);
    let wake: Wake = std::sync::Arc::new(|| {});
    let mut store = BriefingRequests::default();

    let send_out = insert_sending(&mut store, &key, "req-early", "tab-0", b.clone(), &header);
    let h_answered = header_with(
        json!({"id": "brf-early", "requestID": "req-early"}),
        json!(null),
    );
    assert!(store.reconcile(Some(active("tab-0", &key, &h_answered, &b, &wake, false))));
    assert!(store.entries[&key].flight.is_some());
    assert!(store.waiting(&key, &h_answered));
    assert!(store.evictable_victim().is_none());

    // A genuine user Ask gesture MUST be refused while Sending is still in flight,
    // so the late 401 is never lost.
    assert!(!store.act(
        "tab-0",
        &key,
        &h_answered,
        &b,
        &wake,
        "en",
        BriefingGesture::Ask
    ));

    send_out
        .try_send(BriefingSendOutcome {
            state: BriefingSendState::Uncertain,
            auth_expired: true,
        })
        .unwrap();
    assert!(store.poll());
    assert!(store.entries[&key].flight.is_none());
    assert!(!store.waiting(&key, &h_answered));
    assert_eq!(
        store.entries[&key].phase,
        BriefingPhase::Answered {
            briefing_id: "brf-early".into()
        }
    );
    assert_eq!(store.take_auth_expired().len(), 1);
}

#[test]
fn capacity_never_evicts_uncertain_and_multi_401_keeps_every_connection() {
    let b1 = backend();
    let b2 = backend();
    let header = header_with(json!(null), json!(null));
    let key = BriefingKey::fixture(&header);
    let wake: Wake = std::sync::Arc::new(|| {});
    let mut store = BriefingRequests::default();

    for i in 0..CAPACITY {
        let mut k = key.clone();
        k.mission = format!("msn-{i}");
        store.fixture_phase(&k, &format!("req-{i}"), BriefingPhase::Uncertain);
    }
    let mut extra = key.clone();
    extra.mission = "msn-overflow".into();
    assert!(store.at_capacity(&extra));
    assert!(!store.act(
        "tab-0",
        &extra,
        &header,
        &b1,
        &wake,
        "en",
        BriefingGesture::Ask
    ));
    assert_eq!(store.entries.len(), CAPACITY);
    assert!(!store.entries.contains_key(&extra));

    // Two distinct connections returning 401 in the same poll are both preserved.
    store.entries.clear();
    let mut key2 = key.clone();
    key2.mission = "msn-2".into();
    let out_a = insert_sending(&mut store, &key, "req-a", "tab-0", b1, &header);
    let out_b = insert_sending(&mut store, &key2, "req-b", "tab-0", b2, &header);
    out_a
        .try_send(BriefingSendOutcome {
            state: BriefingSendState::Uncertain,
            auth_expired: true,
        })
        .unwrap();
    out_b
        .try_send(BriefingSendOutcome {
            state: BriefingSendState::Uncertain,
            auth_expired: true,
        })
        .unwrap();
    assert!(store.poll());
    assert_eq!(store.take_auth_expired().len(), 2);
}

#[test]
fn cancelling_new_request_confirmation_preserves_uncertain_state_and_accepting_issues_fresh_uuid() {
    let b = backend();
    let header = header_with(json!(null), json!(null));
    let key = BriefingKey::fixture(&header);
    let wake: Wake = std::sync::Arc::new(|| {});
    let mut store = BriefingRequests::default();
    store.fixture_phase(&key, "req-1", BriefingPhase::Uncertain);

    assert!(store.act(
        "tab-0",
        &key,
        &header,
        &b,
        &wake,
        "en",
        BriefingGesture::ConfirmNewDialog
    ));
    assert_eq!(store.confirmation, Some(("tab-0".into(), key.clone())));

    assert!(store.act(
        "tab-0",
        &key,
        &header,
        &b,
        &wake,
        "en",
        BriefingGesture::ConfirmNew(false)
    ));
    assert!(store.confirmation.is_none());
    assert_eq!(
        store.visible_phase(&key, &header),
        Some(&BriefingPhase::Uncertain)
    );
    assert_eq!(store.entries[&key].request_id, "req-1");

    crate::platform::block_on(async {
        let http = crate::files::test_http::Http::new().await;
        assert!(store.act(
            "tab-0",
            &key,
            &header,
            &http.backend,
            &wake,
            "en",
            BriefingGesture::ConfirmNewDialog
        ));
        assert!(store.act(
            "tab-0",
            &key,
            &header,
            &http.backend,
            &wake,
            "en",
            BriefingGesture::ConfirmNew(true)
        ));
        assert!(store.confirmation.is_none());
        assert_eq!(
            store.visible_phase(&key, &header),
            Some(&BriefingPhase::Preparing)
        );
        assert_ne!(store.entries[&key].request_id, "req-1");
        assert_eq!(store.entries[&key].request_id.len(), 36);
        store.suspend();
    });
}
