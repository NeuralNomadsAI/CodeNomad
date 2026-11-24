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

fn obs_page(
    revision: u64,
    coverage: Coverage,
    requests: Coverage,
    total: u64,
    actors: Vec<(&str, ActorState, Option<ActorState>)>,
) -> Observation {
    let mut obs = Observation::default();
    let count = actors.len() as u64;
    let page = Activity {
        revision,
        observed_at: 100.0,
        window: Window {
            order: "ord".into(),
            offset: 0,
            end: count,
            total,
        },
        coverage,
        requests,
        actors: actors
            .iter()
            .map(|(id, state, request)| codenomad_client::missions::Actor {
                session_id: (*id).into(),
                title: (*id).into(),
                state: *state,
                request: *request,
            })
            .collect(),
        questions: actors
            .into_iter()
            .filter_map(|(id, _, request)| {
                request.map(|_| codenomad_client::missions::ObservedQuestion {
                    actor_session_id: id.into(),
                    session_id: id.into(),
                })
            })
            .collect(),
    };
    assert!(obs.adopt_page(0, page));
    obs.observe(revision);
    obs
}

fn obs_with(revision: u64, actors: Vec<(&str, ActorState, Option<ActorState>)>) -> Observation {
    let total = actors.len() as u64;
    obs_page(
        revision,
        Coverage::Observed,
        Coverage::Observed,
        total,
        actors,
    )
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
fn coordinator_eligibility_requires_complete_fresh_interrupted_active_or_resumable_failed() {
    let active = header_value("msn", "active", Some("running"), 7, true, None);
    let idle_coord = obs_with(7, vec![("ses_coord", ActorState::IdleWithoutReport, None)]);
    assert!(coordinator_eligible(&active, &idle_coord, None));

    // Partial coverage or unloaded actor pages must keep Pause instead of Recover.
    let partial_coverage = obs_page(
        7,
        Coverage::Partial,
        Coverage::Observed,
        1,
        vec![("ses_coord", ActorState::IdleWithoutReport, None)],
    );
    assert!(!coordinator_eligible(&active, &partial_coverage, None));

    let partial_requests = obs_page(
        7,
        Coverage::Observed,
        Coverage::Partial,
        1,
        vec![("ses_coord", ActorState::IdleWithoutReport, None)],
    );
    assert!(!coordinator_eligible(&active, &partial_requests, None));

    let unloaded_second_page = obs_page(
        7,
        Coverage::Observed,
        Coverage::Observed,
        2,
        vec![("ses_coord", ActorState::IdleWithoutReport, None)],
    );
    assert!(
        !coordinator_eligible(&active, &unloaded_second_page, None),
        "unloaded actor page may contain a working specialist"
    );

    // Same-revision invalidation must immediately revoke Recover eligibility until refreshed.
    let mut invalidated = obs_with(7, vec![("ses_coord", ActorState::IdleWithoutReport, None)]);
    invalidated.invalidate(10.0);
    assert!(!coordinator_eligible(&active, &invalidated, None));

    let unknown_coord = obs_with(7, vec![("ses_coord", ActorState::Unknown, None)]);
    assert!(!coordinator_eligible(&active, &unknown_coord, None));

    let quiet_reported_specialist = obs_with(
        7,
        vec![
            ("ses_coord", ActorState::IdleWithoutReport, None),
            ("ses_done_specialist", ActorState::Unknown, None),
        ],
    );
    assert!(
        coordinator_eligible(&active, &quiet_reported_specialist, None),
        "a quiet specialist projecting Unknown in a fully Observed window does not block Recover"
    );

    let worker_running = obs_with(
        7,
        vec![
            ("ses_coord", ActorState::IdleWithoutReport, None),
            ("ses_worker", ActorState::Running, None),
        ],
    );
    assert!(!coordinator_eligible(&active, &worker_running, None));

    let pending_control = header_value("msn", "active", Some("running"), 7, true, Some(1));
    assert!(!coordinator_eligible(&pending_control, &idle_coord, None));

    let paused = header_value("msn", "active", Some("paused"), 7, true, None);
    assert!(!coordinator_eligible(&paused, &idle_coord, None));

    let failed = header_value("msn", "failed", Some("running"), 7, true, None);
    assert!(coordinator_eligible(&failed, &unknown_coord, None));
    assert!(coordinator_eligible(&failed, &Observation::default(), None));
    let failed_running = obs_with(7, vec![("ses_coord", ActorState::Running, None)]);
    assert!(!coordinator_eligible(&failed, &failed_running, None));

    let no_actor = header_value("msn", "failed", Some("running"), 7, false, None);
    assert!(!coordinator_eligible(
        &no_actor,
        &Observation::default(),
        None
    ));
}

#[test]
fn separate_activity_windows_never_manufacture_idle_proof_and_sse_loss_persists_across_selection() {
    let active = header_value("msn", "active", Some("running"), 7, true, None);
    let page1 = Activity {
        revision: 7,
        observed_at: 100.0,
        window: Window {
            order: "ord-161".into(),
            offset: 0,
            end: 160,
            total: 161,
        },
        coverage: Coverage::Partial,
        requests: Coverage::Partial,
        actors: (0..160)
            .map(|i| codenomad_client::missions::Actor {
                session_id: if i == 0 {
                    "ses_coord".into()
                } else {
                    format!("ses_w_{i}")
                },
                title: format!("Actor {i}"),
                state: if i == 0 {
                    ActorState::IdleWithoutReport
                } else {
                    ActorState::Missing
                },
                request: None,
            })
            .collect(),
        questions: vec![],
    };
    let page2 = Activity {
        revision: 7,
        observed_at: 101.0,
        window: Window {
            order: "ord-161".into(),
            offset: 160,
            end: 161,
            total: 161,
        },
        coverage: Coverage::Partial,
        requests: Coverage::Partial,
        actors: vec![codenomad_client::missions::Actor {
            session_id: "ses_w_160".into(),
            title: "Actor 160".into(),
            state: ActorState::Missing,
            request: None,
        }],
        questions: vec![],
    };
    let mut obs = Observation::default();
    obs.observe(7);
    assert!(obs.adopt_page(0, page1));
    assert!(obs.adopt_page(160, page2));
    assert!(
        !coordinator_eligible(&active, &obs, None),
        "separately observed windows never manufacture a whole-mission idle proof"
    );

    // Losing SSE persists across switching Mission selection in the Panel.
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    backend.workspace = "ws".into();
    let (wake, _) = witness();
    let mut panel =
        super::super::Panel::new(backend, Some("project".into()), Default::default(), wake);
    let make_summary = |id: &str| codenomad_client::missions::Summary {
        id: id.into(),
        title: Some(id.into()),
        objective: id.into(),
        status: Status::Active,
        run_state: None,
        coordinator_session_id: "ses_coord".into(),
        actor_count: 1,
        updated_at: 1.0,
        revision: 7,
        finish_sequence: None,
        task_count: None,
    };
    panel.summaries = vec![make_summary("msn-a"), make_summary("msn-b")];
    panel.select("msn-a");
    panel.set_online(false);
    panel.select("msn-b");
    let single_idle = Activity {
        revision: 7,
        observed_at: 102.0,
        window: Window {
            order: "ord-1".into(),
            offset: 0,
            end: 1,
            total: 1,
        },
        coverage: Coverage::Observed,
        requests: Coverage::Observed,
        actors: vec![codenomad_client::missions::Actor {
            session_id: "ses_coord".into(),
            title: "Coord".into(),
            state: ActorState::IdleWithoutReport,
            request: None,
        }],
        questions: vec![],
    };
    panel.observation.observe(7);
    assert!(panel.observation.adopt_page(0, single_idle));
    assert!(
        !coordinator_eligible(&active, &panel.observation, None),
        "switching missions while SSE is disconnected must keep Recover unavailable"
    );
}

#[test]
fn revision_conflict_error_survives_refresh_to_next_revision() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-rev");
        let mut guard = Recovery::default();
        guard.start(
            &src,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake,
        );
        let req = http.accept().await;
        req.reply(409, json!({"code": "revision-conflict"})).await;
        wait(done.recv()).await.unwrap();
        guard.poll();
        // Even when the panel advances to revision 8, the refusal reason stays visible.
        let key_rev_8 = RecoveryKey::coordinator(&src, 8);
        assert_eq!(guard.error(&key_rev_8), Some(RecoveryError::Conflict));
        assert_eq!(
            guard.error_for(&src, RecoveryTarget::Coordinator),
            Some(RecoveryError::Conflict)
        );
        guard.clear_error_for(&src.workspace_scope(), "msn-rev");
        assert_eq!(guard.error_for(&src, RecoveryTarget::Coordinator), None);
    });
}

#[test]
fn recovery_guard_prevents_duplicate_admission_refreshes_on_refusal_and_allows_retry() {
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
        assert!(guard.any_pending_for(&src));
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
        assert_eq!(
            polled.refreshed_scopes,
            vec![src.workspace_scope()],
            "refusal must still refresh the workspace in case a failed Mission reopened"
        );
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
        assert_eq!(polled.admitted[0].2, 8);
        assert_eq!(polled.refreshed_scopes, vec![src.workspace_scope()]);
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
            scope: src.workspace_scope(),
            mission: src.mission.clone(),
            target: src.target.clone(),
            backend: Backend::unauthenticated("http://127.0.0.1:1/").unwrap(),
            flight: inbox,
            retired: false,
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
    assert_eq!(
        guard
            .attempts
            .values()
            .filter(|a| matches!(a, Attempt::Admitted(_)))
            .count(),
        SETTLED_CAPACITY
    );
    assert!(guard.pending(&pending_key));
}

#[test]
fn concurrent_recovery_failures_preserve_each_missions_error() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src_a = source("msn-a");
        let src_b = source("msn-b");
        let mut guard = Recovery::default();

        guard.start(
            &src_a,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake.clone(),
        );
        let req_a = http.accept().await;
        assert!(req_a.header.contains("/missions/msn-a/recover "));

        guard.start(
            &src_b,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake,
        );
        let req_b = http.accept().await;
        assert!(req_b.header.contains("/missions/msn-b/recover "));

        // B fails first with already-member.
        req_b.reply(409, json!({"code": "already-member"})).await;
        wait(done.recv()).await.unwrap();
        guard.poll();
        assert_eq!(
            guard.error_for(&src_b, RecoveryTarget::Coordinator),
            Some(RecoveryError::Member)
        );

        // Late failure from A arrives while B is still selected; B's error must survive.
        req_a.reply(409, json!({"code": "recovery-busy"})).await;
        wait(done.recv()).await.unwrap();
        guard.poll();
        assert_eq!(
            guard.error_for(&src_b, RecoveryTarget::Coordinator),
            Some(RecoveryError::Member)
        );
        assert_eq!(
            guard.error_for(&src_a, RecoveryTarget::Coordinator),
            Some(RecoveryError::Busy)
        );
    });
}

#[test]
fn retire_scope_drops_late_recovery_refusal_error() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake, done) = witness();
        let src = source("msn-retire");
        let mut guard = Recovery::default();

        guard.start(
            &src,
            7,
            RecoveryTarget::Coordinator,
            http.backend.clone(),
            wake,
        );
        let req = http.accept().await;
        guard.retire_scope(&src.workspace_scope());
        req.reply(409, json!({"code": "recovery-busy"})).await;
        wait(done.recv()).await.unwrap();
        let polled = guard.poll();
        assert!(polled.admitted.is_empty());
        assert!(polled.refreshed_scopes.is_empty());
        assert_eq!(guard.error_for(&src, RecoveryTarget::Coordinator), None);
    });
}

#[test]
fn offline_failed_mission_disables_recovery_and_refuses_dispatch() {
    use super::super::{Gesture, Lifecycle, Panel, detail, task_rows::TaskRows};
    use rune::{Env, Runtime};

    crate::platform::block_on(async {
        let http = Http::new().await;
        let backend = http.backend.clone();
        let attest = std::thread::spawn(move || {
            crate::platform::block_on(async {
                let meta = http.accept().await;
                meta.reply(200, json!({"apiContract": 1, "serverId": "server"}))
                    .await;
                http
            })
        });
        backend.attest_server().await.unwrap();
        let http = attest.join().unwrap();
        let (wake, _done) = witness();
        let mut panel = Panel::new(
            http.backend.clone(),
            Some("project".into()),
            Default::default(),
            wake,
        );
        let header = header_value("msn-1", "failed", None, 7, true, None);
        let src = Source::new("occ", &http.backend, &header).unwrap();
        panel.detail.snapshot = Some(detail::Snapshot {
            header,
            tasks: std::rc::Rc::new(TaskRows::new(vec![])),
            end: 0,
            attention_end: 0,
        });
        panel.set_online(false);

        let mut owner = Lifecycle::default();
        panel.control("occ", &mut owner, &src, Gesture::RecoverCoordinator(7));
        http.quiet().await;
        assert!(!owner.recovery.any_pending_for(&src));

        let mut rt = Runtime::new(
            (panel, owner),
            |(panel, owner), _| {
                crate::strings::with_locale("en", || {
                    super::super::lifecycle_view::controls(
                        panel,
                        owner,
                        "occ",
                        Some(false),
                        |_: &mut (Panel, Lifecycle), _, _| {},
                    )
                })
            },
            (420.0, 240.0),
            Env::new(false, 1.0),
        );
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json();
        fn has_disabled(node: &Value, key: &str) -> bool {
            if node["key"].as_str() == Some(key) {
                return node["states"]
                    .as_array()
                    .is_some_and(|s| s.contains(&Value::from("disabled")));
            }
            node["children"]
                .as_array()
                .is_some_and(|c| c.iter().any(|child| has_disabled(child, key)))
        }
        assert!(has_disabled(&tree, "mission-control-primary"));
    });
}

#[test]
fn independent_task_form_does_not_suppress_coordinator_recovery() {
    let header = header_value("msn-indep", "active", Some("running"), 7, true, None);
    let obs = obs_page(
        7,
        Coverage::Observed,
        Coverage::Observed,
        2,
        vec![
            ("ses_coord", ActorState::IdleWithoutReport, None),
            (
                "ses_independent_task",
                ActorState::Form,
                Some(ActorState::Form),
            ),
        ],
    );
    let make_tasks = |status: &str| {
        let task: codenomad_client::missions::Task = serde_json::from_value(json!({
            "id": "tsk-1", "key": "task-1", "title": "Specialist task", "status": status,
            "blockedBy": [], "role": "specialist", "order": 0, "createdAt": 1, "updatedAt": 1,
            "dependents": 0, "reportCount": 0, "outstandingExecution": false,
            "actorSessionId": "ses_independent_task"
        }))
        .unwrap();
        super::super::task_rows::TaskRows::new(vec![task])
    };
    // A live task carries its own Form on its chevron, so coordinator recovery stays eligible.
    let live_tasks = make_tasks("needs-input");
    assert!(
        obs.interrupted(&header, Some(&live_tasks)),
        "Form owned by a live independent task must not suppress interrupted coordinator detection"
    );
    assert!(
        coordinator_eligible(&header, &obs, Some(&live_tasks)),
        "coordinator recovery must remain eligible when a live independent task owns the Form"
    );

    // A finished specialist task cannot carry a question, so the Form moves to the Mission flag
    // and suppresses Recover (keeping Pause).
    let finished_tasks = make_tasks("completed");
    assert!(
        !obs.interrupted(&header, Some(&finished_tasks)),
        "Form on a completed specialist moves to the Mission flag and takes precedence over interrupted"
    );
    assert!(
        !coordinator_eligible(&header, &obs, Some(&finished_tasks)),
        "Mission-level question from a finished specialist must keep Pause and suppress Recover"
    );

    // By contrast, a Form on the coordinator itself MUST still suppress recovery.
    let coord_form_obs = obs_page(
        7,
        Coverage::Observed,
        Coverage::Observed,
        1,
        vec![(
            "ses_coord",
            ActorState::IdleWithoutReport,
            Some(ActorState::Form),
        )],
    );
    assert!(!coord_form_obs.interrupted(&header, Some(&live_tasks)));
    assert!(!coordinator_eligible(
        &header,
        &coord_form_obs,
        Some(&live_tasks)
    ));
}
