use super::*;
use crate::files::test_http::{Http, wait};
use serde_json::{Value, json};

fn source(occurrence: &str) -> Source {
    Source {
        occurrence: occurrence.into(),
        workspace: occurrence.into(),
        mission: MissionKey {
            server: "server".into(),
            id: "mission".into(),
        },
        target: header(7, None).lifecycle_target(),
    }
}

fn header(revision: u64, control: Option<Value>) -> MapHeader {
    serde_json::from_value(json!({
        "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
            "excerpt":"Fixture","template":"custom","status":"active","coordinatorSessionId":"session",
            "revision":revision,"createdAt":1,"updatedAt":1,"historyTruncated":false,"bodies":{}},
        "collections":{},"tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
            "pins":[],"reportPins":[],"version":""},
        "control":control,
    })).unwrap()
}

fn receipt(request: &LifecycleRequest, pending: u64, unconfirmed: u64) -> Value {
    json!({"id":request.request_id,"requestID":request.request_id,"action":request.action,
        "expectedRevision":request.expected_revision,"graceful":request.graceful,
        "pending":pending,"receipts":unconfirmed,"unconfirmedReceipts":unconfirmed,
        "partialDescendants":0,"completedRevision":(pending == 0).then_some(request.expected_revision + 1)})
}

fn action(action: LifecycleAction, revision: u64) -> LifecycleRequest {
    LifecycleRequest::new(action, revision, action == LifecycleAction::Pause).unwrap()
}

fn witness() -> (Wake, Receiver<()>) {
    let (send, done) = bounded(1);
    (
        std::sync::Arc::new(move || {
            let _ = send.try_send(());
        }),
        done,
    )
}

#[test]
fn durable_partial_allows_stop_but_unknown_ack_and_supersession_stay_distinct() {
    let mut owner = Lifecycle::default();
    let source = source("a");
    owner.retain_checks_for(Some(&source));
    let start = action(LifecycleAction::Start, 7);
    let partial = header(8, Some(receipt(&start, 1, 0)));
    assert!(owner.unresolved(&source, &partial));
    assert!(owner.can_stop(&source, &partial));
    assert!(owner.check(&source, &partial, false, 0));
    owner.readback(&source, Some(&partial), 1);
    assert!(owner.can_stop(&source, &partial));
    owner.readback(&source, Some(&header(8, Some(receipt(&start, 0, 1)))), 2);
    assert!(owner.unresolved(&source, &header(8, None)));
    assert!(!owner.can_stop(&source, &header(8, None)));
    let later = action(LifecycleAction::Pause, 8);
    owner.readback(&source, Some(&header(9, Some(receipt(&later, 0, 0)))), 3);
    assert!(!owner.unresolved(&source, &header(9, None)));
    assert_eq!(
        owner.feedback(&source),
        Some("missions.control.run.superseded")
    );
}

#[test]
fn stop_lost_before_admission_replays_over_the_same_partial_play() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let source = source("a");
        let start = action(LifecycleAction::Start, 7);
        let partial = header(8, Some(receipt(&start, 1, 0)));
        let stop = action(LifecycleAction::Stop, 8);
        let mut owner = Lifecycle::default();
        owner.retain_checks_for(Some(&source));
        assert!(owner.can_stop(&source, &partial));
        owner.start(
            &source,
            stop.clone(),
            durable(&partial),
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        assert_eq!(first.body["action"], "stop");
        let first_body = first.body.clone();
        assert_eq!(first_body["requestId"], stop.request_id);
        first.reply(503, json!({})).await;
        wait(done.recv()).await.unwrap();
        assert_eq!(owner.poll()[0].2, LifecycleOutcome::Unconfirmed);
        assert!(
            !owner.can_stop(&source, &partial),
            "a new request would lose Stop's identity"
        );
        assert!(owner.check(&source, &partial, false, 0));
        assert_eq!(owner.readback(&source, Some(&partial), 1), None);
        assert!(owner.replayable(&source, 8));
        assert!(owner.check(&source, &partial, true, 1));
        let replay = owner.readback(&source, Some(&partial), 2).unwrap();
        assert_eq!(replay, stop);
        owner.start(&source, replay, None, http.backend.clone(), wake);
        let again = http.accept().await;
        assert_eq!(again.body, first_body);
        again.reply(503, json!({})).await;
        wait(done.recv()).await.unwrap();
        assert_eq!(owner.poll()[0].2, LifecycleOutcome::Unconfirmed);
    });
}

#[test]
fn revision_conflict_at_the_same_expected_revision_releases_to_the_durable_winner() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let source = source("a");
        let winner = action(LifecycleAction::Start, 7);
        let loser = action(LifecycleAction::Pause, 7);
        let current = header(8, Some(receipt(&winner, 2, 0)));
        let mut owner = Lifecycle::default();
        owner.retain_checks_for(Some(&source));
        owner.start(&source, loser, None, http.backend.clone(), wake);
        let held = http.accept().await;
        // The winner may be observed before the losing POST's response arrives.
        assert_eq!(owner.readback(&source, Some(&current), 1), None);
        assert!(owner.busy(&source));
        held.reply(409, json!({"code":"revision-conflict"})).await;
        wait(done.recv()).await.unwrap();
        assert_eq!(owner.poll()[0].2, LifecycleOutcome::Rejected);
        assert!(owner.check(&source, &current, false, 1));
        assert_eq!(owner.readback(&source, Some(&current), 2), None);
        assert!(owner.replayable(&source, 8));
        assert!(owner.check(&source, &current, true, 2));
        assert_eq!(owner.readback(&source, Some(&current), 3), Some(winner));
    });
}

#[test]
fn a_delayed_post_excludes_duplicates_and_can_settle_in_another_tab() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let a = source("tab-a");
        let b = source("tab-b");
        let replacement = Backend::unauthenticated(&http.backend.base).unwrap();
        let (wake, done) = witness();
        let request = action(LifecycleAction::Pause, 7);
        let mut owner = Lifecycle::default();
        owner.retain_checks_for(Some(&a));
        owner.start(
            &a,
            request.clone(),
            None,
            http.backend.clone(),
            wake.clone(),
        );
        let held = http.accept().await;
        assert_eq!(held.body["requestId"], request.request_id);
        owner.start(
            &a,
            request.clone(),
            None,
            http.backend.clone(),
            wake.clone(),
        );
        owner.retain_checks_for(None); // The sending occurrence closed.
        owner.retain_checks_for(Some(&b));
        assert!(owner.busy(&b));
        owner.start(
            &b,
            request.clone(),
            None,
            http.backend.clone(),
            wake.clone(),
        );
        owner.start(&b, request.clone(), None, replacement, wake);
        http.quiet().await;
        held.reply(503, json!({})).await;
        wait(done.recv()).await.unwrap();
        assert_eq!(
            owner.poll(),
            vec![(
                b.mission.clone(),
                b.target.clone(),
                LifecycleOutcome::Unconfirmed
            )]
        );
        assert!(owner.unresolved(&b, &header(7, None)));
        let mut wrong = b.clone();
        wrong.target.project = "another-project".into();
        let saved = header(8, Some(receipt(&request, 0, 0)));
        owner.readback(&wrong, Some(&saved), 1);
        assert!(owner.unresolved(&b, &header(7, None)));
        owner.readback(&b, Some(&saved), 1);
        assert!(!owner.unresolved(&b, &header(7, None)));
    });
}

#[test]
fn unchanged_header_does_not_clear_intent_and_departure_cancels_only_the_check() {
    let source = source("a");
    let request = action(LifecycleAction::Pause, 7);
    let mut owner = Lifecycle::default();
    owner.retain_checks_for(Some(&source));
    owner.intents.insert(
        source.mission.clone(),
        Intent::new(&source, request.clone(), None),
    );
    let empty = header(7, None);
    assert!(owner.check(&source, &empty, false, 0));
    owner.readback(&source, None, 0);
    assert!(!owner.replayable(&source, 7));
    assert!(owner.check(&source, &empty, false, 0));
    owner.readback(&source, Some(&empty), 1);
    assert!(owner.replayable(&source, 7));
    assert!(!owner.replayable(&source, 8));
    assert!(owner.check(&source, &empty, true, 1));
    assert_eq!(owner.readback(&source, Some(&empty), 1), None);
    assert_eq!(owner.readback(&source, Some(&empty), 2), Some(request));
    assert!(owner.check(&source, &empty, true, 2));
    owner.retain_checks_for(None);
    assert_eq!(owner.readback(&source, Some(&empty), 3), None);
    assert!(owner.unresolved(&source, &empty));
}

#[test]
fn a_revision_advance_retires_an_unrecorded_stop_but_not_a_recorded_partial_stop() {
    let source = source("a");
    let play = action(LifecycleAction::Start, 7);
    let stop = action(LifecycleAction::Stop, 8);
    let partial = header(8, Some(receipt(&play, 1, 0)));
    for saved in [false, true] {
        let mut owner = Lifecycle::default();
        owner.retain_checks_for(Some(&source));
        owner.intents.insert(
            source.mission.clone(),
            Intent::new(&source, stop.clone(), durable(&partial)),
        );
        assert!(owner.check(&source, &partial, false, 0));
        owner.readback(&source, Some(&partial), 1);
        assert!(owner.replayable(&source, 8));
        assert!(owner.check(&source, &partial, true, 1));
        let updated = header(9, Some(receipt(if saved { &stop } else { &play }, 1, 0)));
        let replay = owner.readback(&source, Some(&updated), 2);
        if saved {
            assert_eq!(replay, Some(stop.clone()));
        } else {
            assert_eq!(replay, None);
            assert!(!owner.replayable(&source, 9));
            assert!(owner.can_stop(&source, &updated));
            assert_eq!(
                owner.feedback(&source),
                Some("missions.control.run.rejected.stop")
            );
            assert_eq!(updated.root.revision, 9);
        }
    }
}

#[test]
fn capacity_keeps_uncertain_intents_and_reopens_after_an_exact_late_ack() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let a = source("tab-a");
        let b = source("tab-b");
        let request = action(LifecycleAction::Stop, 7);
        let mut owner = Lifecycle::default();
        owner.retain_checks_for(Some(&a));
        owner.start(
            &a,
            request.clone(),
            None,
            http.backend.clone(),
            wake.clone(),
        );
        let post = http.accept().await;
        for n in 1..CAPACITY {
            let mut other = source("retained");
            other.mission.id = format!("mission-{n}");
            other.target.mission.clone_from(&other.mission.id);
            owner.intents.insert(
                other.mission.clone(),
                Intent::new(&other, request.clone(), None),
            );
        }
        let mut extra = source("extra");
        extra.mission.id = "mission-extra".into();
        extra.target.mission.clone_from(&extra.mission.id);
        let partial = header(8, Some(receipt(&action(LifecycleAction::Start, 7), 1, 0)));
        owner.retain_checks_for(Some(&extra));
        assert!(!owner.idle(&extra, &header(7, None)));
        assert!(!owner.can_stop(&extra, &partial));
        assert!(!owner.check(&extra, &partial, false, 0));
        owner.start(&extra, request.clone(), None, http.backend.clone(), wake);
        http.quiet().await;
        assert_eq!(owner.intents.len(), CAPACITY);

        owner.retain_checks_for(Some(&b));
        post.reply(200, json!({"mission":{
            "id":"mission","projectID":"project","projectCanonical":"/fixture","coordinatorSessionId":"session",
            "revision":8,"control":{"missionID":"mission","requestID":request.request_id,"action":"stop",
            "expectedRevision":7,"pending":[],"completedRevision":8,"receipts":[]}
        }})).await;
        wait(done.recv()).await.unwrap();
        assert_eq!(
            owner.poll(),
            vec![(
                b.mission.clone(),
                b.target.clone(),
                LifecycleOutcome::Acknowledged(8)
            )]
        );
        assert_eq!(owner.readback(&b, Some(&header(7, None)), 1), None);
        assert_eq!(
            owner.intents.len(),
            CAPACITY,
            "the old header cannot settle the late acknowledgement"
        );
        assert_eq!(
            owner.readback(&b, Some(&header(8, Some(receipt(&request, 0, 0)))), 2),
            None
        );
        assert_eq!(owner.intents.len(), CAPACITY - 1);
        assert!(owner.idle(&extra, &header(8, None)));
        http.quiet().await;
    });
}

#[test]
fn symmetric_mutation_guards_block_competing_lifecycle_recovery_and_delete_gestures() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let attest = tokio::spawn({
            let backend = backend.clone();
            async move { backend.attest_server().await }
        });
        let meta = http.accept().await;
        meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
            .await;
        wait(attest).await.unwrap().unwrap();

        let (wake, done) = witness();
        let mut panel = Panel::new(backend, Some("project".into()), Default::default(), wake);
        panel.selection_live = super::super::cleanup::LiveFlag::new(true);
        let hdr = serde_json::from_value::<MapHeader>(json!({
            "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
                "excerpt":"Fixture","template":"custom","status":"failed","runState":"running",
                "coordinatorSessionId":"session","revision":7,"createdAt":1,"updatedAt":1,
                "historyTruncated":false,"bodies":{}},
            "collections":{},
            "coordinator":{"kind":"coordinator","sessionId":"session","location":{"directory":"/fixture"}},
            "tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
                "pins":[],"reportPins":[],"version":""},
        }))
        .unwrap();
        panel.detail.snapshot = Some(crate::missions::detail::Snapshot {
            header: hdr,
            tasks: std::rc::Rc::new(crate::missions::task_rows::TaskRows::new(vec![])),
            end: 0,
            attention_end: 0,
        });
        let src = panel.control_source("occ").unwrap().0;
        let mut owner = Lifecycle::default();

        // 1. Hold recovery pending -> DeleteMission and StopDialog must not send anything.
        panel.control("occ", &mut owner, &src, Gesture::RecoverCoordinator(7));
        let rec_req = http.accept().await;
        assert!(rec_req.header.contains("/missions/mission/recover "));
        panel.control("occ", &mut owner, &src, Gesture::DeleteMission(7, false));
        panel.control("occ", &mut owner, &src, Gesture::StopDialog(7));
        assert!(owner.confirmation.is_none());
        http.quiet().await;
        rec_req.reply(409, json!({"code": "recovery-busy"})).await;
        wait(done.recv()).await.unwrap();
        let _ = owner.poll_all();

        // 2. Start delete and let it fail -> competing RecoverCoordinator/Check/Replay/ConfirmStop must not dispatch.
        panel.control("occ", &mut owner, &src, Gesture::DeleteMission(7, false));
        let del_req = http.accept().await;
        assert!(del_req.header.starts_with("DELETE /api/workspaces/"));
        del_req.reply(503, json!({})).await;
        let reconcile = http.accept().await;
        reconcile
            .reply(
                200,
                json!({"available": true, "version": 1, "projectID": "project", "generatedAt": 1, "cleanups": []}),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let _ = owner.poll_all();
        assert!(owner.cleanup.delete_active(&src));

        panel.control("occ", &mut owner, &src, Gesture::RecoverCoordinator(7));
        owner.confirmation = Some(super::StopConfirmation {
            id: 1,
            source: src.clone(),
            revision: 7,
            live: super::super::cleanup::LiveFlag::new(true),
        });
        panel.control("occ", &mut owner, &src, Gesture::ConfirmStop(1, true));
        panel.control("occ", &mut owner, &src, Gesture::Check);
        panel.control("occ", &mut owner, &src, Gesture::Replay);
        http.quiet().await;

        // 3. While lifecycle is in flight, RetryDelete must not dispatch.
        let stop_req = action(LifecycleAction::Stop, 7);
        owner.start(
            &src,
            stop_req,
            None,
            http.backend.clone(),
            panel.wake.clone(),
        );
        let stop_post = http.accept().await;
        assert!(stop_post.header.contains("/missions/mission/control "));
        let req_id = owner.cleanup.delete_request_id(&src).unwrap();
        panel.control("occ", &mut owner, &src, Gesture::RetryDelete(req_id));
        http.quiet().await;
        stop_post.reply(503, json!({})).await;
    });
}

#[test]
fn stale_stop_confirmation_callback_cannot_confirm_replacement_dialog() {
    platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();

        let (wake, _) = witness();
        let mut panel = Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        panel.selection_live = super::super::cleanup::LiveFlag::new(true);
        let mut owner = Lifecycle::default();
        let h7 = header(7, None);
        panel.detail.snapshot = Some(super::super::detail::Snapshot {
            header: h7,
            tasks: std::rc::Rc::new(super::super::task_rows::TaskRows::new(vec![])),
            end: 0,
            attention_end: 0,
        });
        let (src7, _) = panel.control_source("occ").unwrap();

        // Open Stop dialog at revision 7, capture its id, dismiss it.
        panel.control("occ", &mut owner, &src7, Gesture::StopDialog(7));
        let old_id = owner.confirmation.as_ref().expect("dialog 1").id;
        panel.control(
            "occ",
            &mut owner,
            &src7,
            Gesture::ConfirmStop(old_id, false),
        );
        assert!(owner.confirmation.is_none());

        // Advance to revision 8 and open a replacement Stop dialog.
        let h8 = header(8, None);
        panel.detail.snapshot = Some(super::super::detail::Snapshot {
            header: h8,
            tasks: std::rc::Rc::new(super::super::task_rows::TaskRows::new(vec![])),
            end: 0,
            attention_end: 0,
        });
        let (src8, _) = panel.control_source("occ").unwrap();
        panel.control("occ", &mut owner, &src8, Gesture::StopDialog(8));
        let new_id = owner.confirmation.as_ref().expect("dialog 2").id;
        assert_ne!(old_id, new_id);

        // Delivering the stale callback from dialog 1 must neither send Stop nor consume dialog 2.
        panel.control("occ", &mut owner, &src8, Gesture::ConfirmStop(old_id, true));
        http.quiet().await;
        assert_eq!(
            owner.confirmation.as_ref().map(|c| c.id),
            Some(new_id),
            "stale Stop callback must not consume the replacement dialog"
        );
    });
}

#[test]
fn unresolved_pause_on_finished_mission_does_not_block_delete_and_lifecycle_401_surfaces_auth() {
    platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();

        let (wake, done) = witness();
        let mut panel = Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        panel.selection_live = super::super::cleanup::LiveFlag::new(true);
        let mut owner = Lifecycle::default();
        let h7 = header(7, None);
        panel.detail.snapshot = Some(super::super::detail::Snapshot {
            header: h7,
            tasks: std::rc::Rc::new(super::super::task_rows::TaskRows::new(vec![])),
            end: 0,
            attention_end: 0,
        });
        let (src, _) = panel.control_source("occ").unwrap();

        // 1. Pause POST hits confirmed 401 -> surfaces auth_expired and keeps original intent without auto-replay.
        let pause_req = action(LifecycleAction::Pause, 7);
        owner.start(
            &src,
            pause_req,
            None,
            http.backend.clone(),
            panel.wake.clone(),
        );
        let post = http.accept().await;
        assert!(post.header.contains("/missions/mission/control "));
        post.reply(401, json!({"error": "unauthorized"})).await;
        let probe = http.accept().await;
        assert!(probe.header.starts_with("GET /api/auth/status"));
        probe.reply(200, json!({"authenticated": false})).await;
        wait(done.recv()).await.unwrap();
        let settled = owner.poll_all();
        assert_eq!(settled.auth_expired().len(), 1);
        assert!(owner.unresolved(&src, &panel.detail.snapshot.as_ref().unwrap().header));
        http.quiet().await;

        // 2. Mission finishes without recording that Pause: Delete is no longer blocked, and readback retires intent.
        let mut finished_header = header(8, None);
        finished_header.root.status = Status::Completed;
        assert!(
            !owner.blocks_delete(&src, &finished_header),
            "unrecorded local Pause intent on a finished mission must not disable Delete"
        );
        assert!(owner.readback(&src, Some(&finished_header), 1).is_none());
        assert!(!owner.unresolved(&src, &finished_header));
    });
}
