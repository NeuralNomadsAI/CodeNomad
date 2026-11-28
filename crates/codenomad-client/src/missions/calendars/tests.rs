use super::*;
use crate::missions::{
    CriterionConnector, CriterionRole, ExecutionProfile, ModelRef, RepositoryEvent,
    RepositoryProvider,
};
use serde_json::json;

fn explicit_profile(agent: &str, provider: &str, model: &str) -> ExecutionProfile {
    ExecutionProfile {
        agent: Some(agent.into()),
        model: Some(ModelRef {
            provider_id: provider.into(),
            id: model.into(),
            variant: None,
        }),
    }
}

fn custom_profiles() -> Profiles {
    let profile = explicit_profile("build", "anthropic", "claude-sonnet");
    Profiles {
        coordinator: Some(profile.clone()),
        roles: Some(BTreeMap::from([("specialist".into(), profile)])),
    }
}

fn sample_summary(id: &str, status: Status, run_state: Option<RunState>) -> Summary {
    Summary {
        id: id.into(),
        title: Some("Daily review".into()),
        objective: "Review open changes".into(),
        status,
        run_state,
        coordinator_session_id: "ses_coord_1".into(),
        actor_count: 1,
        updated_at: 1000.0,
        revision: 1,
        finish_sequence: None,
        task_count: Some(0),
    }
}

fn sample_configuration(when: Vec<LaunchCriterion>) -> CalendarConfiguration {
    CalendarConfiguration {
        title: "Daily review".into(),
        objective: "Review open changes".into(),
        notes: None,
        template: Template::Custom,
        profiles: Some(custom_profiles()),
        task_mode: TaskMode::Native,
        watched_conversation_ids: Vec::new(),
        coordinator_session_id: None,
        coordinator_goal: Some(true),
        launch: LaunchPolicy { when },
    }
}

fn cron(expr: &str, zone: &str) -> LaunchCriterion {
    LaunchCriterion::Cron {
        expression: expr.into(),
        zone: zone.into(),
    }
}

fn remote_commits() -> LaunchCriterion {
    LaunchCriterion::RemoteBranchCommits {
        provider: RepositoryProvider::Github,
        host: "github.com".into(),
        repository: "owner/repo".into(),
        git_ref: "refs/heads/dev".into(),
    }
}

#[test]
fn launch_policy_round_trips_all_post_1791_criteria_and_rejects_daily_legacy() {
    let criteria = vec![
        LaunchCriterion::Now,
        cron("0 9 * * 1-5", "Europe/Paris"),
        LaunchCriterion::ScheduleSuccess {
            mission_id: "msn_prev".into(),
        },
        LaunchCriterion::MissionCompleted {
            mission_id: "msn_done".into(),
        },
        LaunchCriterion::BranchCommits {
            directory: "D:/CodeNomad".into(),
            git_ref: "refs/heads/dev".into(),
        },
        LaunchCriterion::ConversationMessage {
            conversation_id: "ses_watch".into(),
        },
        LaunchCriterion::FilesChanged {
            paths: vec![
                "Cargo.toml".into(),
                "crates/codenomad-client/src/lib.rs".into(),
            ],
        },
        LaunchCriterion::GithubNotification { repository: None },
        LaunchCriterion::GithubSecurityAlert {
            repository: "owner/repo".into(),
        },
        LaunchCriterion::GithubPullRequest {
            repository: "owner/repo".into(),
            author: Some("@dependabot[bot]".into()),
        },
        LaunchCriterion::GithubIssue {
            repository: "owner/repo".into(),
            author: None,
        },
        LaunchCriterion::RepositoryActivity {
            provider: RepositoryProvider::Gitlab,
            host: "gitlab.example.com:8443".into(),
            repository: "group/sub/repo".into(),
            event: RepositoryEvent::PullRequestMerged,
            author: Some("alice".into()),
        },
        remote_commits(),
    ];
    for item in &criteria {
        item.validate()
            .unwrap_or_else(|e| panic!("expected valid {item:?}: {e}"));
        let value = serde_json::to_value(item).unwrap();
        let back: LaunchCriterion = serde_json::from_value(value).unwrap();
        assert_eq!(&back, item);
    }

    // Legacy daily / pre-#1791 shapes are strictly rejected.
    for rejected in [
        json!({"timing": {"kind": "daily", "time": "09:00", "zone": "UTC"}, "condition": null, "ends": {"maxLaunches": null, "afterMs": null, "at": null}}),
        json!({"when": [{"kind": "daily", "time": "09:00", "zone": "UTC"}]}),
        json!({"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC", "extra": true}]}),
        json!({"when": [], "extra": 1}),
    ] {
        assert!(
            serde_json::from_value::<LaunchPolicy>(rejected.clone()).is_err(),
            "should reject {rejected}"
        );
    }
}

#[test]
fn launch_policy_structure_duplicates_limits_and_calendar_support_match_server() {
    // Schedule group -> if -> event group -> else -> fallback schedule group.
    let policy = LaunchPolicy {
        when: vec![
            cron("0 9 * * *", "UTC"),
            cron("0 18 * * *", "UTC"),
            remote_commits(),
            LaunchCriterion::FilesChanged {
                paths: vec!["src/main.rs".into()],
            },
            cron("0 20 * * *", "UTC"),
        ],
    };
    policy.validate().unwrap();
    assert!(policy.requires_calendar());
    let structure = policy.structure();
    assert_eq!(
        structure.connectors,
        vec![
            CriterionConnector::Or,
            CriterionConnector::If,
            CriterionConnector::Or,
            CriterionConnector::Else,
        ]
    );
    assert_eq!(
        structure.roles,
        vec![
            CriterionRole::Trigger,
            CriterionRole::Trigger,
            CriterionRole::Condition,
            CriterionRole::Condition,
            CriterionRole::Trigger,
        ]
    );
    assert!(structure.has_fallback);
    assert_eq!(
        policy.calendar_unsupported_reason(&[]),
        Some(CalendarUnsupportedReason::FallbackSchedule)
    );

    // Leading events trigger (OR); supported by native Automations.
    let event_only = LaunchPolicy {
        when: vec![
            remote_commits(),
            LaunchCriterion::RepositoryActivity {
                provider: RepositoryProvider::Github,
                host: "github.com".into(),
                repository: "owner/repo".into(),
                event: RepositoryEvent::PullRequestCreated,
                author: None,
            },
        ],
    };
    event_only.validate().unwrap();
    assert_eq!(
        event_only.structure().roles,
        vec![CriterionRole::Trigger, CriterionRole::Trigger]
    );
    assert_eq!(event_only.calendar_unsupported_reason(&[]), None);
    assert_eq!(
        event_only.calendar_unsupported_reason(&["ses_watched".into()]),
        Some(CalendarUnsupportedReason::FollowedConversations)
    );

    // One-time policies (empty or sole `now`).
    for one_time in [
        LaunchPolicy { when: vec![] },
        LaunchPolicy {
            when: vec![LaunchCriterion::Now],
        },
    ] {
        one_time.validate().unwrap();
        assert!(!one_time.requires_calendar());
        assert_eq!(
            one_time.calendar_unsupported_reason(&[]),
            Some(CalendarUnsupportedReason::OneTime)
        );
    }

    // Internal-only events fail calendar support check with `Event`.
    let internal_event = LaunchPolicy {
        when: vec![LaunchCriterion::MissionCompleted {
            mission_id: "msn_other".into(),
        }],
    };
    internal_event.validate().unwrap();
    assert_eq!(
        internal_event.calendar_unsupported_reason(&[]),
        Some(CalendarUnsupportedReason::Event)
    );

    // Duplicates are rejected (including normalized cron spacing & unsorted paths).
    let dup_cron = LaunchPolicy {
        when: vec![cron("0  9 * * *", "UTC"), cron("0 9 * * *", "UTC")],
    };
    assert!(dup_cron.validate().is_err());

    let dup_files = LaunchPolicy {
        when: vec![
            LaunchCriterion::FilesChanged {
                paths: vec!["a.rs".into(), "b.rs".into()],
            },
            LaunchCriterion::FilesChanged {
                paths: vec!["b.rs".into(), "a.rs".into()],
            },
        ],
    };
    assert!(dup_files.validate().is_err());

    // Invalid paths, refs, and hosts are rejected.
    for bad in [
        LaunchCriterion::FilesChanged {
            paths: vec!["../secret".into()],
        },
        LaunchCriterion::FilesChanged {
            paths: vec!["C:/abs".into()],
        },
        LaunchCriterion::BranchCommits {
            directory: "D:/repo".into(),
            git_ref: "refs/tags/v1".into(),
        },
        LaunchCriterion::BranchCommits {
            directory: "D:/repo".into(),
            git_ref: "refs/heads/main\u{00A0}branch".into(),
        },
        LaunchCriterion::RemoteBranchCommits {
            provider: RepositoryProvider::Github,
            host: "github.com/evil".into(),
            repository: "owner/repo".into(),
            git_ref: "refs/heads/main".into(),
        },
    ] {
        assert!(bad.validate().is_err(), "expected invalid {bad:?}");
    }

    // Principal limit (>8 schedules) is rejected.
    let too_many = LaunchPolicy {
        when: (0..9)
            .map(|m| cron(&format!("{m} 9 * * *"), "UTC"))
            .collect(),
    };
    assert!(too_many.validate().is_err());
}

#[test]
fn calendar_configuration_validates_profiles_coordinator_and_goal_serialization() {
    let mut cfg = sample_configuration(vec![cron("0 9 * * *", "UTC")]);
    cfg.validate().unwrap();
    let encoded = serde_json::to_value(&cfg).unwrap();
    assert_eq!(encoded["coordinatorGoal"], json!(true));
    assert!(encoded.get("notes").is_none());
    assert!(encoded.get("coordinatorSessionID").is_none());
    assert_eq!(encoded["watchedConversationIDs"], json!([]));

    // Reserved carrier session IDs are rejected.
    for reserved in ["ses_cn_schedule_calendar_abc", "ses_cn_goal_proj"] {
        cfg.coordinator_session_id = Some(reserved.into());
        assert!(cfg.validate().is_err(), "{reserved}");
    }

    // Coordinator cannot also be a watched conversation.
    cfg.coordinator_session_id = Some("ses_coord".into());
    cfg.watched_conversation_ids = vec!["ses_coord".into()];
    assert!(cfg.validate().is_err());
    cfg.watched_conversation_ids.clear();
    cfg.validate().unwrap();

    // Missing explicit role profile for calendar criteria fails closed.
    cfg.profiles
        .as_mut()
        .unwrap()
        .roles
        .as_mut()
        .unwrap()
        .clear();
    assert!(cfg.validate().is_err());

    // Compare template requires distinct models for model-a and model-b.
    let mut compare = sample_configuration(vec![cron("0 9 * * *", "UTC")]);
    compare.template = Template::Compare;
    let same = explicit_profile("build", "openai", "gpt-5");
    compare.profiles = Some(Profiles {
        coordinator: Some(same.clone()),
        roles: Some(BTreeMap::from([
            ("model-a".into(), same.clone()),
            ("model-b".into(), same.clone()),
            ("comparator".into(), same),
        ])),
    });
    assert!(compare.validate().is_err());
    compare
        .profiles
        .as_mut()
        .unwrap()
        .roles
        .as_mut()
        .unwrap()
        .insert(
            "model-b".into(),
            explicit_profile("build", "anthropic", "claude-opus"),
        );
    compare.validate().unwrap();

    // One-time Compare configuration without profiles also fails closed.
    let mut one_time_compare = sample_configuration(vec![LaunchCriterion::Now]);
    one_time_compare.template = Template::Compare;
    one_time_compare.profiles = None;
    assert!(one_time_compare.validate().is_err());
}

#[test]
fn calendar_view_models_pre_first_launch_and_repeated_passages_and_optional_fields() {
    // #1803: Before first launch, prepared Mission stands in missionID while `last` is absent.
    let prepared_body = json!({
        "calendars": [{
            "id": "cal_review",
            "title": "Daily review",
            "paused": false,
            "missionID": "msn_prepared_1",
            "launch": {"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]},
            "mission": {
                "title": "Daily review",
                "objective": "Review open changes",
                "template": "custom",
                "taskMode": "native",
                "coordinatorGoal": true
            },
            "rules": [{
                "automationID": "aut_1",
                "trigger": {"type": "cron", "cron": "0 9 * * *", "tz": "UTC", "upstreamExtra": true},
                "tz": "UTC",
                "nextDueAt": 1700000000000u64,
                "runCount": 0,
                "upstreamRuleField": "ignored"
            }]
        }]
    });
    let CalendarOutcome::Ok(views) = settle_calendar(StatusCode::OK, prepared_body).unwrap() else {
        panic!("expected ok");
    };
    let view = &views[0];
    let prepared_summary =
        sample_summary("msn_prepared_1", Status::Active, Some(RunState::Prepared));
    let hand_played_summary =
        sample_summary("msn_prepared_1", Status::Active, Some(RunState::Running));
    let other_summary = sample_summary("msn_other", Status::Active, Some(RunState::Prepared));
    assert!(view.is_awaiting_first_launch(&prepared_summary));
    assert!(!view.is_awaiting_first_launch(&hand_played_summary));
    assert!(!view.is_awaiting_first_launch(&other_summary));
    assert_eq!(view.current_mission_id(), Some("msn_prepared_1"));
    assert!(view.launch_policy().is_some());
    assert!(view.coordinator_goal());
    assert!(view.history().is_empty());

    // Editing a calendar after its first launch replaces the Automation rows (clearing `last`)
    // while keeping `missionID` pointing at the launched Mission (#1802 / #1803).
    let edited_after_launch = json!({
        "calendars": [{
            "id": "cal_review",
            "title": "Daily review",
            "paused": false,
            "missionID": "msn_launched_1",
            "mission": {"objective": "Review open changes", "template": "custom"},
            "rules": [{
                "automationID": "aut_new",
                "trigger": {"type": "cron", "cron": "0 10 * * *", "tz": "UTC"},
                "tz": "UTC",
                "runCount": 0
            }]
        }]
    });
    let CalendarOutcome::Ok(views) = settle_calendar(StatusCode::OK, edited_after_launch).unwrap()
    else {
        panic!("expected ok");
    };
    assert!(views[0].last.is_none());
    assert_eq!(views[0].current_mission_id(), Some("msn_launched_1"));
    assert!(!views[0].is_awaiting_first_launch(&sample_summary(
        "msn_launched_1",
        Status::Active,
        Some(RunState::Running),
    )));
    assert!(!views[0].is_awaiting_first_launch(&sample_summary(
        "msn_launched_1",
        Status::Completed,
        None,
    )));

    // Event-gated calendar that checked once with no news (`idle` without status/coordinator/history)
    // still matches its prepared Mission when the Mission itself is Active + Prepared (#1803).
    let idle_before_first = json!({
        "calendars": [{
            "id": "cal_commits",
            "title": "On commit",
            "paused": false,
            "missionID": "msn_prepared_2",
            "mission": {"objective": "Check diff", "template": "custom"},
            "rules": [{
                "automationID": "aut_2",
                "trigger": {"type": "every", "every": "15 minutes"},
                "tz": "UTC",
                "lastRunAt": 1700000900000u64,
                "runCount": 1
            }],
            "last": {
                "outcome": "idle",
                "missionID": "msn_prepared_2",
                "history": [],
                "at": 1700000900000u64
            }
        }]
    });
    let CalendarOutcome::Ok(views) = settle_calendar(StatusCode::OK, idle_before_first).unwrap()
    else {
        panic!("expected ok");
    };
    assert!(views[0].is_awaiting_first_launch(&sample_summary(
        "msn_prepared_2",
        Status::Active,
        Some(RunState::Prepared),
    )));
    assert!(!views[0].coordinator_goal());
    assert!(views[0].launch.is_none());
    assert!(views[0].launch_policy().is_none());

    // Opaque non-criteria `launch` on one stored calendar stays read-only and never breaks the list.
    let mixed_list = json!({
        "calendars": [
            {
                "id": "cal_opaque",
                "title": "Stored non-criteria",
                "paused": false,
                "launch": {"timing": {"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}},
                "mission": {"objective": "Stored", "template": "custom"},
                "rules": [{"automationID": "aut_old", "trigger": {"type": "cron", "cron": "0 9 * * *"}, "tz": "UTC", "runCount": 2}]
            },
            {
                "id": "cal_current",
                "title": "Current criteria",
                "paused": false,
                "launch": {"when": [{"kind": "cron", "expression": "0 8 * * *", "zone": "UTC"}]},
                "mission": {"objective": "Current", "template": "custom"},
                "rules": [{"automationID": "aut_cur", "trigger": {"type": "cron", "cron": "0 8 * * *"}, "tz": "UTC", "runCount": 0}]
            }
        ]
    });
    let CalendarOutcome::Ok(views) = settle_calendar(StatusCode::OK, mixed_list).unwrap() else {
        panic!("expected ok");
    };
    assert_eq!(views.len(), 2);
    assert!(matches!(views[0].launch, Some(CalendarLaunch::Opaque(_))));
    assert!(views[0].launch_policy().is_none());
    assert!(views[1].launch_policy().is_some());

    // #1802: Second launch replaces the first in the same coordinator conversation with history.
    let repeated = json!({
        "calendars": [{
            "id": "cal_review",
            "title": "Daily review",
            "paused": false,
            "missionID": "msn_launch_3",
            "launch": {"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]},
            "mission": {
                "objective": "Review open changes",
                "template": "custom",
                "coordinatorGoal": true
            },
            "rules": [{
                "automationID": "aut_1",
                "trigger": {"type": "cron", "cron": "0 9 * * *", "tz": "UTC"},
                "tz": "UTC",
                "lastRunAt": 3000,
                "lastOutcome": "fired",
                "runCount": 3
            }],
            "last": {
                "outcome": "launched",
                "missionID": "msn_launch_3",
                "status": "active",
                "coordinatorSessionID": "ses_coord_1",
                "history": [
                    {"at": 1000, "outcome": "completed"},
                    {"at": 2000, "outcome": "failed"}
                ],
                "at": 3000
            }
        }]
    });
    let CalendarOutcome::Ok(views) = settle_calendar(StatusCode::OK, repeated).unwrap() else {
        panic!("expected ok");
    };
    let active = &views[0];
    assert!(!active.is_awaiting_first_launch(&sample_summary(
        "msn_launch_3",
        Status::Active,
        Some(RunState::Running),
    )));
    assert_eq!(active.current_mission_id(), Some("msn_launch_3"));
    assert_eq!(active.coordinator_session_id(), Some("ses_coord_1"));
    assert_eq!(active.history().len(), 2);
    assert_eq!(active.history()[0].outcome, "completed");
    assert_eq!(active.history()[1].outcome, "failed");

    // Validation fails closed on mismatched last.missionID, >20 history entries, or duplicate IDs.
    let mismatch = json!({
        "calendars": [{
            "id": "cal_review",
            "title": "Daily review",
            "paused": false,
            "missionID": "msn_a",
            "mission": {},
            "rules": [{"automationID": "aut_1", "trigger": {"type": "every", "every": "15 minutes"}, "tz": "UTC", "runCount": 1}],
            "last": {"outcome": "waiting", "missionID": "msn_b", "history": [], "at": 10}
        }]
    });
    assert!(settle_calendar(StatusCode::OK, mismatch).is_err());

    let overflow_history: Vec<Value> = (1..=21)
        .map(|i| json!({"at": i, "outcome": "completed"}))
        .collect();
    let too_much_history = json!({
        "calendars": [{
            "id": "cal_review",
            "title": "Daily review",
            "paused": false,
            "missionID": "msn_a",
            "mission": {},
            "rules": [{"automationID": "aut_1", "trigger": {"type": "every", "every": "15 minutes"}, "tz": "UTC", "runCount": 21}],
            "last": {"outcome": "launched", "missionID": "msn_a", "history": overflow_history, "at": 22}
        }]
    });
    assert!(settle_calendar(StatusCode::OK, too_much_history).is_err());

    let non_bool_goal = json!({
        "calendars": [{
            "id": "cal_review",
            "title": "Daily review",
            "paused": false,
            "mission": {"coordinatorGoal": "true"},
            "rules": [{"automationID": "aut_1", "trigger": {"type": "every", "every": "15 minutes"}, "tz": "UTC", "runCount": 0}]
        }]
    });
    assert!(settle_calendar(StatusCode::OK, non_bool_goal).is_err());
}

#[test]
fn settle_calendar_maps_all_error_codes_and_rejects_malformed_errors() {
    assert_eq!(
        settle_calendar(
            StatusCode::BAD_REQUEST,
            json!({"error": "Invalid Mission calendar request", "code": "calendar-input-invalid"}),
        )
        .unwrap(),
        CalendarOutcome::InvalidInput
    );
    for status in [
        StatusCode::FORBIDDEN,
        StatusCode::NOT_FOUND,
        StatusCode::CONFLICT,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        assert_eq!(
            settle_calendar(
                status,
                json!({"error": "Mission calendars unavailable", "code": "calendar-unavailable"}),
            )
            .unwrap(),
            CalendarOutcome::Unavailable,
            "status {status}"
        );
    }
    assert_eq!(
        settle_calendar(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "temporarily unavailable"}),
        )
        .unwrap(),
        CalendarOutcome::Unavailable
    );
    assert_eq!(
        settle_calendar(
            StatusCode::NOT_FOUND,
            json!({"error": "Mission calendar not found", "code": "calendar-missing"}),
        )
        .unwrap(),
        CalendarOutcome::Missing
    );
    // 422 without a typed `reason` and generic 404 without `code` fail closed.
    assert!(
        settle_calendar(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error": "unsupported", "code": "calendar-unsupported"}),
        )
        .is_err()
    );
    assert!(settle_calendar(StatusCode::NOT_FOUND, json!({"error": "Not Found"})).is_err());
}

#[cfg(not(target_arch = "wasm32"))]
mod http_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Clone, Debug)]
    struct RecordedRequest {
        method: String,
        target: String,
        body: String,
    }

    async fn spawn_calendar_server(
        handler: impl Fn(RecordedRequest) -> (u16, String) + Send + Sync + 'static,
    ) -> (
        String,
        Arc<Mutex<Vec<RecordedRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let log = recorded.clone();
        let handler = Arc::new(handler);
        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let log = log.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let header_end = loop {
                        let Ok(n) = stream.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break pos + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                    let content_length = head
                        .lines()
                        .find_map(|line| {
                            let (k, v) = line.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    while buf.len() < header_end + content_length {
                        let Ok(n) = stream.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
                    let method = parts.next().unwrap_or_default().to_owned();
                    let target = parts.next().unwrap_or_default().to_owned();
                    let body = String::from_utf8_lossy(
                        &buf[header_end..(header_end + content_length).min(buf.len())],
                    )
                    .into_owned();
                    let req = RecordedRequest {
                        method,
                        target,
                        body,
                    };
                    log.lock().unwrap().push(req.clone());
                    let (status, payload) = handler(req);
                    let response = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (base, recorded, handle)
    }

    fn run<F: std::future::Future<Output = ()>>(future: F) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future);
    }

    #[test]
    fn calendar_http_crud_pause_resume_and_error_codes_match_server_routes() {
        run(async {
            let state = Arc::new(Mutex::new((false, false, false)));
            let st = state.clone();
            let (base, recorded, server) = spawn_calendar_server(move |req| {
                let mut guard = st.lock().unwrap();
                match (req.method.as_str(), req.target.as_str()) {
                    ("GET", t) if t.starts_with("/api/workspaces/ws_1/missions/calendars") => {
                        if guard.2 {
                            return (401, "Unauthorized".into());
                        }
                        if !guard.0 {
                            return (200, json!({"calendars": []}).to_string());
                        }
                        (
                            200,
                            json!({"calendars": [{
                                "id": "cal_review",
                                "title": "Daily review",
                                "paused": guard.1,
                                "missionID": "msn_prepared",
                                "launch": {"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]},
                                "mission": {"title": "Daily review", "objective": "Review open changes", "template": "custom", "taskMode": "native", "coordinatorGoal": true},
                                "rules": [{"automationID": "aut_1", "trigger": {"type": "cron", "cron": "0 9 * * *", "tz": "UTC"}, "tz": "UTC", "runCount": 0}]
                            }]})
                            .to_string(),
                        )
                    }
                    ("PUT", "/api/workspaces/ws_1/missions/calendars/cal_review") => {
                        let parsed: Value = serde_json::from_str(&req.body).unwrap();
                        assert_eq!(parsed["configuration"]["coordinatorGoal"], json!(true));
                        assert_eq!(parsed["directory"], json!("D:/repo with space"));
                        guard.0 = true;
                        (
                            200,
                            json!({"calendars": [{
                                "id": "cal_review",
                                "title": "Daily review",
                                "paused": guard.1,
                                "missionID": "msn_prepared",
                                "launch": parsed["configuration"]["launch"],
                                "mission": {"title": "Daily review", "objective": "Review open changes", "template": "custom", "taskMode": "native", "coordinatorGoal": true},
                                "rules": [{"automationID": "aut_1", "trigger": {"type": "cron", "cron": "0 9 * * *", "tz": "UTC"}, "tz": "UTC", "runCount": 0}]
                            }]})
                            .to_string(),
                        )
                    }
                    ("PUT", "/api/workspaces/ws_1/missions/calendars/cal_bad") => (
                        422,
                        json!({"error": "Launch criteria a calendar cannot carry", "code": "calendar-unsupported", "reason": "event"}).to_string(),
                    ),
                    ("POST", t)
                        if t.starts_with(
                            "/api/workspaces/ws_1/missions/calendars/cal_review/pause",
                        ) =>
                    {
                        guard.1 = true;
                        (
                            200,
                            json!({"calendars": [{
                                "id": "cal_review",
                                "title": "Daily review",
                                "paused": true,
                                "missionID": "msn_prepared",
                                "mission": {"objective": "Review open changes", "template": "custom"},
                                "rules": [{"automationID": "aut_1", "trigger": {"type": "cron", "cron": "0 9 * * *", "tz": "UTC"}, "tz": "UTC", "runCount": 0}]
                            }]})
                            .to_string(),
                        )
                    }
                    ("POST", t)
                        if t.starts_with(
                            "/api/workspaces/ws_1/missions/calendars/cal_review/resume",
                        ) =>
                    {
                        guard.1 = false;
                        (
                            200,
                            json!({"calendars": [{
                                "id": "cal_review",
                                "title": "Daily review",
                                "paused": false,
                                "missionID": "msn_prepared",
                                "mission": {"objective": "Review open changes", "template": "custom"},
                                "rules": [{"automationID": "aut_1", "trigger": {"type": "cron", "cron": "0 9 * * *", "tz": "UTC"}, "tz": "UTC", "runCount": 0}]
                            }]})
                            .to_string(),
                        )
                    }
                    ("DELETE", t)
                        if t.starts_with("/api/workspaces/ws_1/missions/calendars/cal_review") =>
                    {
                        if !guard.0 {
                            return (
                                404,
                                json!({"error": "Mission calendar not found", "code": "calendar-missing"}).to_string(),
                            );
                        }
                        guard.0 = false;
                        (200, json!({"calendars": []}).to_string())
                    }
                    _ => (
                        503,
                        json!({"error": "Mission calendars unavailable", "code": "calendar-unavailable"}).to_string(),
                    ),
                }
            })
            .await;

            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws_1".into();

            // Empty list initially.
            assert_eq!(
                backend
                    .mission_calendars(Some("D:/repo with space"))
                    .await
                    .unwrap(),
                CalendarOutcome::Ok(vec![])
            );

            // Save prepares the Mission before first launch (#1803).
            let save_req = CalendarSaveRequest {
                configuration: sample_configuration(vec![cron("0 9 * * *", "UTC")]),
                directory: Some("D:/repo with space".into()),
            };
            let CalendarOutcome::Ok(saved) = backend
                .save_mission_calendar("cal_review", &save_req)
                .await
                .unwrap()
            else {
                panic!("expected saved calendar");
            };
            assert_eq!(saved.len(), 1);
            assert!(saved[0].is_awaiting_first_launch(&sample_summary(
                "msn_prepared",
                Status::Active,
                Some(RunState::Prepared),
            )));
            assert_eq!(saved[0].current_mission_id(), Some("msn_prepared"));
            assert!(saved[0].coordinator_goal());

            // Pause & resume with directory query parameter.
            let CalendarOutcome::Ok(paused) = backend
                .control_mission_calendar(
                    "cal_review",
                    CalendarAction::Pause,
                    Some("D:/repo with space"),
                )
                .await
                .unwrap()
            else {
                panic!("expected paused");
            };
            assert!(paused[0].paused);

            let CalendarOutcome::Ok(resumed) = backend
                .control_mission_calendar(
                    "cal_review",
                    CalendarAction::Resume,
                    Some("D:/repo with space"),
                )
                .await
                .unwrap()
            else {
                panic!("expected resumed");
            };
            assert!(!resumed[0].paused);

            // Unsupported criteria returns typed 422 reason.
            let unsupported_req = CalendarSaveRequest {
                configuration: sample_configuration(vec![LaunchCriterion::MissionCompleted {
                    mission_id: "msn_other".into(),
                }]),
                directory: None,
            };
            assert_eq!(
                backend
                    .save_mission_calendar("cal_bad", &unsupported_req)
                    .await
                    .unwrap(),
                CalendarOutcome::Unsupported(CalendarUnsupportedReason::Event)
            );

            // Delete with directory query parameter succeeds, then second delete reports Missing.
            assert_eq!(
                backend
                    .delete_mission_calendar("cal_review", Some("D:/repo with space"))
                    .await
                    .unwrap(),
                CalendarOutcome::Ok(vec![])
            );
            assert_eq!(
                backend
                    .delete_mission_calendar("cal_review", Some("D:/repo with space"))
                    .await
                    .unwrap(),
                CalendarOutcome::Missing
            );

            // 401 returns AuthExpired even with plain-text body.
            state.lock().unwrap().2 = true;
            assert_eq!(
                backend.mission_calendars(None).await.unwrap(),
                CalendarOutcome::AuthExpired
            );

            // Verify URL query encoding for directory on GET, POST (pause/resume), and DELETE.
            let log = recorded.lock().unwrap();
            assert_eq!(
                log[0].target,
                "/api/workspaces/ws_1/missions/calendars?directory=D%3A%2Frepo+with+space"
            );
            assert_eq!(
                log[2].target,
                "/api/workspaces/ws_1/missions/calendars/cal_review/pause?directory=D%3A%2Frepo+with+space"
            );
            assert_eq!(
                log[3].target,
                "/api/workspaces/ws_1/missions/calendars/cal_review/resume?directory=D%3A%2Frepo+with+space"
            );
            assert_eq!(
                log[5].target,
                "/api/workspaces/ws_1/missions/calendars/cal_review?directory=D%3A%2Frepo+with+space"
            );

            server.abort();
        });
    }
}
