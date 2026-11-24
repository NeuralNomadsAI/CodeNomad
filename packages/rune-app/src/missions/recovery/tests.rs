use super::*;
use crate::files::test_http::{Http, wait};
use codenomad_client::missions::{Activity, ActorState, Coverage, Window};
use serde_json::{Value, json};

fn source(mission_id: &str) -> Source {
    let header = header_value(mission_id, "active", Some("running"), 7, true, None);
    Source {
        occurrence: "occ".into(),
        workspace: "ws".into(),
        mission: MissionKey {
            server: "server".into(),
            id: mission_id.into(),
        },
        target: header.lifecycle_target(),
    }
}

fn header_value(
    id: &str,
    status: &str,
    run_state: Option<&str>,
    revision: u64,
    with_coordinator: bool,
    pending: Option<u64>,
) -> MapHeader {
    let mut root = json!({
        "version": 1, "id": id, "projectID": "project", "projectCanonical": "/fixture",
        "excerpt": "Fixture", "template": "custom", "status": status,
        "coordinatorSessionId": "ses_coord", "revision": revision,
        "createdAt": 1, "updatedAt": 1, "historyTruncated": false, "bodies": {}
    });
    if let Some(run_state) = run_state {
        root["runState"] = json!(run_state);
    }
    let coordinator = with_coordinator.then(|| {
        json!({
            "kind": "coordinator", "sessionId": "ses_coord",
            "location": {"directory": "/fixture"}
        })
    });
    let control = pending.map(|pending| {
        json!({
            "id": "ctrl-1", "requestID": "req-1", "action": "start",
            "expectedRevision": revision.saturating_sub(1).max(1),
            "pending": pending, "receipts": 0, "unconfirmedReceipts": 0, "partialDescendants": 0
        })
    });
    let value: Value = json!({
        "root": root,
        "collections": {},
        "tasks": {"page": {"order": "", "offset": 0, "end": 0, "total": 0, "counts": {}, "reports": 0},
            "pins": [], "reportPins": [], "version": ""},
        "coordinator": coordinator,
        "control": control,
    });
    serde_json::from_value(value).unwrap()
}

fn obs_with(revision: u64, actors: Vec<(&str, ActorState, Option<ActorState>)>) -> Observation {
    let mut obs = Observation::default();
    let count = actors.len() as u64;
    let page = Activity {
        revision,
        observed_at: 100.0,
        window: Window {
            order: "ord".into(),
            offset: 0,
            end: count,
            total: count,
        },
        coverage: Coverage::Observed,
        requests: Coverage::Observed,
        actors: actors
            .into_iter()
            .map(|(id, state, request)| codenomad_client::missions::Actor {
                session_id: id.into(),
                title: id.into(),
                state,
                request,
            })
            .collect(),
    };
    assert!(obs.adopt_page(0, page));
    obs.observe(revision);
    obs
}

fn witness() -> (Wake, Receiver<()>) {
    let (send, done) = bounded(4);
    (
        std::sync::Arc::new(move || {
            let _ = send.try_send(());
        }),
        done,
    )
}

#[test]
fn coordinator_eligibility_requires_interrupted_active_or_resumable_failed_without_pending_control()
{
    let active = header_value("msn", "active", Some("running"), 7, true, None);
    let idle_coord = obs_with(7, vec![("ses_coord", ActorState::IdleWithoutReport, None)]);
    assert!(coordinator_eligible(&active, &idle_coord));

    let unknown_coord = obs_with(7, vec![("ses_coord", ActorState::Unknown, None)]);
    assert!(
        !coordinator_eligible(&active, &unknown_coord),
        "unknown activity must keep Pause rather than offering coordinator recovery"
    );

    let worker_running = obs_with(
        7,
        vec![
            ("ses_coord", ActorState::IdleWithoutReport, None),
            ("ses_worker", ActorState::Running, None),
        ],
    );
    assert!(
        !coordinator_eligible(&active, &worker_running),
        "active worker prevents interrupted coordinator recovery"
    );

    let pending_control = header_value("msn", "active", Some("running"), 7, true, Some(1));
    assert!(!coordinator_eligible(&pending_control, &idle_coord));

    let paused = header_value("msn", "active", Some("paused"), 7, true, None);
    assert!(!coordinator_eligible(&paused, &idle_coord));

    let failed = header_value("msn", "failed", Some("running"), 7, true, None);
    assert!(coordinator_eligible(&failed, &unknown_coord));
    assert!(coordinator_eligible(&failed, &Observation::default()));
    let failed_running = obs_with(7, vec![("ses_coord", ActorState::Running, None)]);
    assert!(!coordinator_eligible(&failed, &failed_running));

    let no_actor = header_value("msn", "failed", Some("running"), 7, false, None);
    assert!(!coordinator_eligible(&no_actor, &Observation::default()));
}

#[test]
fn recovery_guard_prevents_duplicate_admission_and_allows_retry_after_refusal() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-1");
        let key = RecoveryKey::coordinator(&src, 7);
        let mut guard = Recovery::default();

        guard.start(
            &src,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake.clone(),
        );
        assert!(guard.pending(&key));
        // Second start at the same revision must be ignored while pending.
        guard.start(
            &src,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake.clone(),
        );
        let first = http.accept().await;
        assert!(first.header.starts_with("POST /api/workspaces/"));
        assert!(first.header.contains("/missions/msn-1/recover "));
        assert_eq!(
            first.body,
            json!({"expectedRevision": 7, "target": "coordinator"})
        );
        first.reply(409, json!({"code": "recovery-busy"})).await;
        wait(done.recv()).await.unwrap();
        let polled = guard.poll();
        assert!(polled.changed);
        assert!(polled.admitted.is_empty());
        assert!(!guard.pending(&key) && !guard.admitted(&key));
        assert_eq!(guard.error(&key), Some(RecoveryError::Busy));

        // After refusal the user may retry the same revision.
        guard.start(
            &src,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake.clone(),
        );
        assert_eq!(guard.error(&key), None);
        let second = http.accept().await;
        second
            .reply(
                200,
                json!({
                    "admitted": true,
                    "mission": {
                        "id": "msn-1", "projectID": "project", "projectCanonical": "/fixture",
                        "coordinatorSessionId": "ses_coord", "revision": 8,
                        "actors": [{"kind": "coordinator", "sessionId": "ses_coord", "location": {"directory": "/fixture"}}]
                    }
                }),
            )
            .await;
        wait(done.recv()).await.unwrap();
        let polled = guard.poll();
        assert!(polled.changed);
        assert_eq!(polled.admitted.len(), 1);
        assert_eq!(polled.admitted[0].2, Some(8));
        assert!(guard.admitted(&key));

        // Once admitted, the same revision cannot replay.
        guard.start(
            &src,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake,
        );
        http.quiet().await;
    });
}

#[test]
fn settled_guard_capacity_never_evicts_pending_attempts() {
    let mut guard = Recovery::default();
    let (_out, inbox) = bounded(1);
    let src = source("pending-mission");
    let pending_key = RecoveryKey::coordinator(&src, 1);
    guard.attempts.insert(
        pending_key.clone(),
        Attempt::Pending {
            mission: src.mission.clone(),
            target: src.target.clone(),
            flight: inbox,
        },
    );
    for i in 1..=(SETTLED_CAPACITY + 10) as u64 {
        guard.seq += 1;
        guard.attempts.insert(
            RecoveryKey::coordinator(&src, i + 10),
            Attempt::Admitted(guard.seq),
        );
    }
    guard.prune();
    assert_eq!(guard.attempts.len(), SETTLED_CAPACITY);
    assert!(guard.pending(&pending_key));
}
