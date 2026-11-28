use super::{
    editor::CriterionKind,
    summary::{
        DisplayStatus, describe_criteria, display_status, format_history_entry, status_text,
    },
    *,
};
use crate::missions::{Panel, panel as panel_view};
use codenomad_client::missions::{
    CalendarLaunchHistoryEntry, LaunchCriterion, LaunchPolicy, RepositoryEvent, RepositoryProvider,
    RunState, Status, Summary,
};
use rune::{Env, Runtime, edit::TextEdit};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn test_panel(base: &str) -> Panel {
    let mut backend = Backend::unauthenticated(base).unwrap();
    backend.workspace = "ws_1".into();
    Panel::new(
        backend,
        Some("proj_1".into()),
        Reads::default(),
        Arc::new(|| {}),
    )
}

fn summary(id: &str, status: Status, run_state: Option<RunState>) -> Summary {
    Summary {
        id: id.into(),
        title: Some("Nightly audit".into()),
        objective: "Check repository health".into(),
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

fn explicit_profiles_json() -> Value {
    let exec = json!({
        "agent": "build",
        "model": {"providerID": "anthropic", "id": "claude-sonnet"}
    });
    json!({
        "coordinator": exec,
        "roles": {"specialist": exec}
    })
}

fn calendar_json(
    id: &str,
    title: &str,
    paused: bool,
    mission_id: Option<&str>,
    launch: Option<Value>,
    last: Option<Value>,
) -> Value {
    let mut obj = json!({
        "id": id,
        "title": title,
        "paused": paused,
        "mission": {
            "title": title,
            "objective": "Review open changes",
            "template": "custom",
            "taskMode": "native",
            "profiles": explicit_profiles_json(),
            "coordinatorGoal": true
        },
        "rules": [{
            "automationID": "aut_1",
            "trigger": {"type": "cron", "cron": "0 9 * * *", "tz": "UTC"},
            "tz": "UTC",
            "nextDueAt": 1700000000000u64,
            "runCount": 0
        }]
    });
    if let Some(mid) = mission_id {
        obj["missionID"] = json!(mid);
    }
    if let Some(launch) = launch {
        obj["launch"] = launch;
    }
    if let Some(last) = last {
        obj["last"] = last;
    }
    obj
}

fn decode_calendar(value: Value) -> CalendarView {
    serde_json::from_value(value).unwrap()
}

fn find_node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| find_node(child, key))
}

#[test]
fn describe_criteria_covers_all_post_1791_variants_and_connectors() {
    let policy = LaunchPolicy {
        when: vec![
            LaunchCriterion::Cron {
                expression: "0 9 * * *".into(),
                zone: "UTC".into(),
            },
            LaunchCriterion::FilesChanged {
                paths: vec!["Cargo.toml".into(), "src/lib.rs".into()],
            },
            LaunchCriterion::BranchCommits {
                directory: "D:/repo".into(),
                git_ref: "refs/heads/main".into(),
            },
            LaunchCriterion::Now,
            LaunchCriterion::ScheduleSuccess {
                mission_id: "msn_prev".into(),
            },
            LaunchCriterion::MissionCompleted {
                mission_id: "msn_one".into(),
            },
            LaunchCriterion::ConversationMessage {
                conversation_id: "ses_chat".into(),
            },
            LaunchCriterion::GithubNotification {
                repository: Some("owner/repo".into()),
            },
            LaunchCriterion::GithubSecurityAlert {
                repository: "owner/repo".into(),
            },
            LaunchCriterion::GithubPullRequest {
                repository: "owner/repo".into(),
                author: Some("alice".into()),
            },
            LaunchCriterion::GithubIssue {
                repository: "owner/repo".into(),
                author: Some("@bob".into()),
            },
            LaunchCriterion::RepositoryActivity {
                provider: RepositoryProvider::Gitlab,
                host: "gitlab.com".into(),
                repository: "group/proj".into(),
                event: RepositoryEvent::PullRequestCreated,
                author: Some("carol".into()),
            },
            LaunchCriterion::RemoteBranchCommits {
                provider: RepositoryProvider::Gitea,
                host: "git.example.com".into(),
                repository: "org/app".into(),
                git_ref: "refs/heads/release".into(),
            },
        ],
    };
    let lines = describe_criteria(&policy, "en");
    assert_eq!(lines.len(), 13);
    assert!(lines[0].contains("0 9 * * *") && lines[0].contains("UTC"));
    assert!(lines[1].starts_with("if · ") && lines[1].contains("Cargo.toml, src/lib.rs"));
    assert!(lines[2].starts_with("or · ") && lines[2].contains("main"));
    assert!(lines[3].starts_with("or · ") && lines[3].contains("Once, now"));
    assert!(lines[4].starts_with("if · ") && lines[4].contains("msn_prev"));
    assert!(lines[11].contains("New merge request") && lines[11].contains("@carol"));
    assert!(lines[12].contains("git.example.com/org/app") && lines[12].contains("release"));
}

#[test]
fn display_status_distinguishes_pre_first_launch_hand_played_edit_after_launch_and_paused() {
    let cal = decode_calendar(calendar_json(
        "cal_1",
        "Nightly",
        false,
        Some("msn_1"),
        Some(json!({"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]})),
        None,
    ));
    // #1803 prepared Mission awaiting first launch
    let prepared = vec![summary("msn_1", Status::Active, Some(RunState::Prepared))];
    assert_eq!(
        display_status(&cal, &prepared),
        DisplayStatus::AwaitingFirstLaunch
    );
    assert_eq!(
        status_text(DisplayStatus::AwaitingFirstLaunch, "en"),
        "Prepared · Waiting for scheduled run"
    );

    // Prepared Mission played by hand (`Running`) is in progress, not awaiting first launch.
    let hand_played = vec![summary("msn_1", Status::Active, Some(RunState::Running))];
    assert_eq!(
        display_status(&cal, &hand_played),
        DisplayStatus::InProgress
    );

    // Post-launch edit replaced Automations (`last: None`) while `missionID` points to Completed.
    let completed = vec![summary("msn_1", Status::Completed, None)];
    assert_eq!(display_status(&cal, &completed), DisplayStatus::Waiting);

    // Paused calendar reports Paused regardless of Mission run state.
    let paused = decode_calendar(calendar_json(
        "cal_1",
        "Nightly",
        true,
        Some("msn_1"),
        None,
        None,
    ));
    assert_eq!(display_status(&paused, &prepared), DisplayStatus::Paused);
}

#[test]
fn editor_validates_launch_when_opaque_replacement_and_coordinator_goal() {
    let cal = decode_calendar(calendar_json(
        "cal_edit",
        "Daily review",
        false,
        Some("msn_prep"),
        Some(json!({"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]})),
        None,
    ));
    let mut ed = CalendarEditor::from_view(&cal);
    assert!(!ed.retained_opaque);
    assert!(ed.coordinator_goal);
    assert_eq!(ed.criteria.len(), 1);

    // Duplicate cron fails closed locally.
    ed.add_criterion();
    assert_eq!(ed.criteria.len(), 2);
    assert_eq!(
        ed.build_request().unwrap_err(),
        "missions.scheduling.error.duplicate"
    );

    // Switch second criterion to FilesChanged -> becomes `if` condition, valid!
    ed.criteria[1].switch_kind(CriterionKind::FilesChanged, "UTC");
    ed.criteria[1].primary = TextEdit::new("Cargo.toml\nsrc/lib.rs");
    let req = ed.build_request().unwrap();
    assert_eq!(req.configuration.launch.when.len(), 2);
    assert_eq!(req.configuration.coordinator_goal, Some(true));

    // Reordering event before cron makes cron a fallback (`else`), which calendar rejects locally.
    ed.move_criterion(1, -1);
    assert_eq!(
        ed.build_request().unwrap_err(),
        "missions.scheduling.error.unsupported"
    );

    // Opaque stored launch stays read-only until explicitly replaced.
    let opaque_cal = decode_calendar(calendar_json(
        "cal_old",
        "Legacy stored",
        false,
        None,
        Some(json!({"timing": {"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}})),
        None,
    ));
    let mut opaque_ed = CalendarEditor::from_view(&opaque_cal);
    assert!(opaque_ed.retained_opaque);
    assert_eq!(
        opaque_ed.build_request().unwrap_err(),
        "missions.scheduling.error.retained"
    );
    opaque_ed.replace_retained();
    assert!(!opaque_ed.retained_opaque);
    assert!(opaque_ed.build_request().is_ok());

    // Missing explicit profiles fails locally with profilesRequired.
    opaque_ed.profiles = None;
    assert_eq!(
        opaque_ed.build_request().unwrap_err(),
        "missions.recurrence.profilesRequired"
    );
}

#[test]
fn ui_renders_calendars_pre_first_launch_history_and_inline_editor() {
    let mut panel = test_panel("http://127.0.0.1:1/");
    panel.summaries.push(summary(
        "msn_prep",
        Status::Active,
        Some(RunState::Prepared),
    ));
    let history: Vec<Value> = (1..=20)
        .map(|i| {
            json!({
                "at": 1700000000000u64 + i * 60_000,
                "outcome": if i % 2 == 0 { "completed" } else { "failed" }
            })
        })
        .collect();
    let cal_prep = decode_calendar(calendar_json(
        "cal_prep",
        "Morning check",
        false,
        Some("msn_prep"),
        Some(json!({"when": [{"kind": "cron", "expression": "0 8 * * *", "zone": "UTC"}]})),
        None,
    ));
    let cal_hist = decode_calendar(calendar_json(
        "cal_hist",
        "Nightly sweep",
        false,
        Some("msn_run_20"),
        Some(json!({"when": [
            {"kind": "cron", "expression": "0 2 * * *", "zone": "UTC"},
            {"kind": "files-changed", "paths": ["Cargo.toml"]}
        ]})),
        Some(json!({
            "outcome": "launched",
            "missionID": "msn_run_20",
            "status": "active",
            "coordinatorSessionID": "ses_coord_hist",
            "history": history,
            "at": 1700002000000u64
        })),
    ));
    panel
        .calendars
        .fixture_set_entries(vec![cal_prep, cal_hist]);
    assert!(panel.owns_conversation_target("ses_coord_hist"));
    assert!(!panel.owns_conversation_target("ses_unrelated"));

    let mut rt = Runtime::new(
        (panel, TextEdit::new("")),
        |s, _| {
            crate::strings::with_locale("en", || {
                panel_view(&s.0, |s: &mut (Panel, TextEdit)| (Some(&mut s.0), &mut s.1))
            })
        },
        (420.0, 900.0),
        Env::new(true, 1.0),
    );
    rt.frame(0.0);

    let tree = rt.accessibility_json();
    let prep_row = find_node(&tree, "mission-calendar-row-cal_prep").expect("prep calendar row");
    assert_eq!(prep_row["name"], "Morning check");
    assert_eq!(
        prep_row["description"],
        "Prepared · Waiting for scheduled run"
    );

    // Select the second calendar with 20 history entries and inspect its detail.
    let (x, y) = rt.find("mission-calendar-row-cal_hist").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert_eq!(rt.state.0.calendars.selected.as_deref(), Some("cal_hist"));

    let tree = rt.accessibility_json();
    let detail_json = find_node(&tree, "mission-calendar-detail")
        .expect("detail region")
        .to_string();
    assert!(detail_json.contains("Nightly sweep"));
    assert!(detail_json.contains("if · Explicit files change · Cargo.toml"));
    assert!(detail_json.contains("Keep coordinator active with /goal"));
    let first_history = find_node(&tree, "mission-calendar-history-0")
        .expect("newest history entry")
        .to_string();
    let last_history = find_node(&tree, "mission-calendar-history-19")
        .expect("oldest history entry")
        .to_string();
    assert!(find_node(&tree, "mission-calendar-history-20").is_none());

    // Newest entry (index 0 in display) is entry #20 ("completed"), oldest (#19) is entry #1 ("failed").
    let newest = format_history_entry(
        &CalendarLaunchHistoryEntry {
            at: 1700000000000u64 + 20 * 60_000,
            outcome: "completed".into(),
        },
        "en",
        "UTC",
    );
    let oldest = format_history_entry(
        &CalendarLaunchHistoryEntry {
            at: 1700000000000u64 + 60_000,
            outcome: "failed".into(),
        },
        "en",
        "UTC",
    );
    assert!(newest.ends_with("· Completed"));
    assert!(
        first_history.contains(&newest),
        "history-0 should render newest entry {newest}, got {first_history}"
    );
    assert!(
        last_history.contains(&oldest),
        "history-19 should render oldest entry {oldest}, got {last_history}"
    );

    // Open inline editor and verify controls + add criterion.
    let detail_elements = rt.elements();
    for key in ["mission-calendar-edit", "mission-calendar-delete"] {
        let btn = detail_elements
            .iter()
            .find(|el| el.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("missing {key}"));
        assert!(
            btn.rect[2] <= 36.0 && btn.rect[3] <= 36.0,
            "{key} must be a compact icon button: {:?}",
            btn.rect
        );
    }
    let (ex, ey) = rt.find("mission-calendar-edit").unwrap();
    rt.pointer_down(ex, ey);
    rt.pointer_up(ex, ey);
    rt.frame(0.02);
    assert!(rt.state.0.calendars.editor.is_some());
    assert!(rt.find("mission-calendar-editor").is_some());
    assert!(rt.find("mission-calendar-edit-title").is_some());
    assert!(rt.find("mission-calendar-edit-goal").is_some());
    assert!(rt.find("mission-calendar-save").is_some());
    let remove_btn = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("mission-calendar-criterion-remove-0"))
        .expect("criterion remove icon button");
    assert!(
        remove_btn.rect[2] <= 36.0 && remove_btn.rect[3] <= 36.0,
        "criterion remove action must be a compact icon button: {:?}",
        remove_btn.rect
    );
}

#[test]
fn hide_cancels_calendar_read_and_ignores_stale_completion() {
    let mut panel = test_panel("http://127.0.0.1:1/");
    let (cancel, cancelled) = CancelToken::new();
    panel.calendars.active_read = Some((7, cancel));
    panel.calendars.owed_refresh = true;
    panel.calendars.cancel();
    assert!(cancelled.is_cancelled());
    assert!(!panel.calendars.owed_refresh);

    // A stale completion for serial 7 is discarded.
    let (cancel2, _) = CancelToken::new();
    panel.calendars.active_read = Some((8, cancel2));
    panel
        .calendars
        .out
        .try_send(Completion {
            kind: OpKind::Read,
            serial: 7,
            outcome: Ok(CalendarOutcome::Ok(vec![decode_calendar(calendar_json(
                "cal_stale",
                "Stale",
                false,
                None,
                None,
                None,
            ))])),
        })
        .unwrap();
    let (changed, _) = panel
        .calendars
        .poll(true, &panel.backend, &panel.reads, &panel.wake);
    assert!(!changed);
    assert!(panel.calendars.entries.is_empty());
    assert!(panel.calendars.busy_read());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn http_crud_pause_resume_delete_and_auth_expired_round_trip() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    let rt = tokio::runtime::Runtime::new().unwrap();
    let _guard = rt.enter();
    rt.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}/");

        #[derive(Default)]
        struct ServerState {
            paused: bool,
            deleted: bool,
            title: String,
            auth_expired: bool,
            put_count: usize,
        }
        let shared = Arc::new(Mutex::new(ServerState {
            paused: false,
            deleted: false,
            title: "Daily audit".into(),
            auth_expired: false,
            put_count: 0,
        }));
        let server_state = shared.clone();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let state = server_state.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let header_end = loop {
                        let Ok(n) = stream.read(&mut tmp).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break pos + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                    let first = head.lines().next().unwrap_or("");
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or("").to_owned();
                    let target = parts.next().unwrap_or("").to_owned();
                    let content_len: usize = head
                        .lines()
                        .find_map(|line| {
                            let (k, v) = line.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    while buf.len() < header_end + content_len {
                        let Ok(n) = stream.read(&mut tmp).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let body = &buf[header_end..buf.len().min(header_end + content_len)];

                    let (status, payload) = {
                        let mut guard = state.lock().unwrap();
                        if guard.auth_expired {
                            (401, "unauthorized".to_owned())
                        } else if method == "GET" && target == "/api/workspaces/ws_1/missions/calendars" {
                            let list = if guard.deleted {
                                vec![]
                            } else {
                                vec![calendar_json(
                                    "cal_audit",
                                    &guard.title,
                                    guard.paused,
                                    Some("msn_prep"),
                                    Some(json!({"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]})),
                                    None,
                                )]
                            };
                            (200, json!({"calendars": list}).to_string())
                        } else if method == "POST" && target == "/api/workspaces/ws_1/missions/calendars/cal_audit/pause" {
                            guard.paused = true;
                            let list = vec![calendar_json(
                                "cal_audit",
                                &guard.title,
                                true,
                                Some("msn_prep"),
                                Some(json!({"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]})),
                                None,
                            )];
                            (200, json!({"calendars": list}).to_string())
                        } else if method == "POST" && target == "/api/workspaces/ws_1/missions/calendars/cal_audit/resume" {
                            guard.paused = false;
                            let list = vec![calendar_json(
                                "cal_audit",
                                &guard.title,
                                false,
                                Some("msn_prep"),
                                Some(json!({"when": [{"kind": "cron", "expression": "0 9 * * *", "zone": "UTC"}]})),
                                None,
                            )];
                            (200, json!({"calendars": list}).to_string())
                        } else if method == "PUT" && target == "/api/workspaces/ws_1/missions/calendars/cal_audit" {
                            let parsed: Value = serde_json::from_slice(body).unwrap();
                            guard.title = parsed["configuration"]["title"]
                                .as_str()
                                .unwrap_or("Updated")
                                .to_owned();
                            guard.put_count += 1;
                            let list = vec![calendar_json(
                                "cal_audit",
                                &guard.title,
                                guard.paused,
                                Some("msn_prep"),
                                Some(parsed["configuration"]["launch"].clone()),
                                None,
                            )];
                            (200, json!({"calendars": list}).to_string())
                        } else if method == "DELETE" && target == "/api/workspaces/ws_1/missions/calendars/cal_audit" {
                            guard.deleted = true;
                            (200, json!({"calendars": []}).to_string())
                        } else {
                            (503, json!({"code": "calendar-unavailable"}).to_string())
                        }
                    };
                    let response = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        let wakes = Arc::new(AtomicUsize::new(0));
        let wake_counter = wakes.clone();
        let mut backend = Backend::unauthenticated(&base).unwrap();
        backend.workspace = "ws_1".into();
        let mut panel = Panel::new(
            backend,
            Some("proj_1".into()),
            Reads::default(),
            Arc::new(move || {
                wake_counter.fetch_add(1, Ordering::SeqCst);
            }),
        );

        async fn wait_poll(panel: &mut Panel, done: impl Fn(&Panel) -> bool) {
            for _ in 0..200 {
                let _ = panel
                    .calendars
                    .poll(true, &panel.backend, &panel.reads, &panel.wake);
                if done(panel) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("timed out waiting for calendar operation");
        }

        // 1. Initial GET
        panel.refresh_calendars();
        wait_poll(&mut panel, |p| p.calendars.loaded && !p.calendars.busy_read()).await;
        assert_eq!(panel.calendars.entries.len(), 1);
        assert_eq!(panel.calendars.entries[0].title, "Daily audit");
        assert!(!panel.calendars.entries[0].paused);

        // 2. Pause -> Resume
        panel.toggle_calendar_pause("cal_audit");
        wait_poll(&mut panel, |p| !p.calendars.busy_mutation()).await;
        assert!(panel.calendars.entries[0].paused);

        panel.toggle_calendar_pause("cal_audit");
        wait_poll(&mut panel, |p| !p.calendars.busy_mutation()).await;
        assert!(!panel.calendars.entries[0].paused);

        // 3. Edit title & cron via inline editor -> PUT
        panel.calendars.open_editor("cal_audit");
        {
            let ed = panel.calendars.editor.as_mut().unwrap();
            ed.title = TextEdit::new("Weekly audit");
            ed.criteria[0].primary = TextEdit::new("0 10 * * 1");
        }
        panel.save_calendar_editor();
        wait_poll(&mut panel, |p| !p.calendars.busy_mutation()).await;
        assert_eq!(shared.lock().unwrap().put_count, 1);
        assert_eq!(panel.calendars.entries[0].title, "Weekly audit");
        assert!(panel.calendars.editor.is_none());

        // 4. Delete confirmation cancel keeps entry; accept removes it
        panel.calendars.request_delete("cal_audit");
        assert_eq!(
            panel.calendars.pending_delete(),
            Some(("cal_audit", "Weekly audit"))
        );
        panel.confirm_calendar_delete(false);
        assert!(panel.calendars.pending_delete().is_none());
        assert_eq!(panel.calendars.entries.len(), 1);

        panel.calendars.request_delete("cal_audit");
        panel.confirm_calendar_delete(true);
        wait_poll(&mut panel, |p| !p.calendars.busy_mutation()).await;
        assert!(panel.calendars.entries.is_empty());

        // 5. 401 surfaces auth_expired through Panel::take_reader_auth_expired()
        shared.lock().unwrap().auth_expired = true;
        panel.refresh_calendars();
        wait_poll(&mut panel, |p| !p.calendars.busy_read()).await;
        assert!(panel.take_reader_auth_expired().is_some());

        server.abort();
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn mutation_cancels_inflight_read_and_defers_passive_refresh_until_settled() {
    crate::platform::block_on(async {
        let http = crate::files::test_http::Http::new().await;
        let mut backend = http.backend.clone();
        backend.workspace = "ws_1".into();
        let (wake_tx, wake_rx) = bounded(16);
        let mut panel = Panel::new(
            backend,
            Some("proj_1".into()),
            Reads::default(),
            Arc::new(move || {
                let _ = wake_tx.try_send(());
            }),
        );
        panel
            .calendars
            .fixture_set_entries(vec![decode_calendar(calendar_json(
                "cal_a", "Original", false, None, None, None,
            ))]);

        // Simulate an in-flight GET started before a mutation.
        let (cancel_read, read_cancelled) = CancelToken::new();
        panel.calendars.active_read = Some((1, cancel_read));
        panel.calendars.owed_refresh = true;
        panel.calendars.serial = 1;

        // Starting a mutation cancels the older GET, clears pre-mutation owed_refresh, and holds
        // the real POST open on the fixture server so no transport error can race completion.
        panel.toggle_calendar_pause("cal_a");
        assert!(read_cancelled.is_cancelled());
        assert!(!panel.calendars.busy_read());
        assert!(!panel.calendars.owed_refresh);
        assert!(panel.calendars.busy_mutation());
        let pause_req = http.accept().await;
        assert!(
            pause_req
                .header
                .starts_with("POST /api/workspaces/ws_1/missions/calendars/cal_a/pause "),
            "unexpected mutation request: {}",
            pause_req.header
        );

        // A stale GET completion from serial 1 cannot overwrite anything while the mutation is active.
        panel
            .calendars
            .out
            .try_send(Completion {
                kind: OpKind::Read,
                serial: 1,
                outcome: Ok(CalendarOutcome::Ok(vec![decode_calendar(calendar_json(
                    "cal_a",
                    "Stale Before Mutation",
                    false,
                    None,
                    None,
                    None,
                ))])),
            })
            .unwrap();

        // A passive refresh arriving while the mutation is in flight does NOT start a concurrent GET.
        panel
            .calendars
            .refresh(&panel.backend, &panel.reads, &panel.wake);
        assert!(!panel.calendars.busy_read());
        assert!(panel.calendars.owed_refresh);
        let (changed, mutated) =
            panel
                .calendars
                .poll(true, &panel.backend, &panel.reads, &panel.wake);
        assert!(!changed);
        assert!(!mutated);
        assert_eq!(panel.calendars.entries[0].title, "Original");

        // Mutation settles with the authoritative paused snapshot, then dispatches the deferred GET.
        while wake_rx.try_recv().is_ok() {}
        pause_req
            .reply(
                200,
                json!({
                    "calendars": [calendar_json("cal_a", "Original", true, None, None, None)]
                }),
            )
            .await;
        crate::files::test_http::wait(wake_rx.recv()).await.unwrap();
        let (changed, mutated) =
            panel
                .calendars
                .poll(true, &panel.backend, &panel.reads, &panel.wake);
        assert!(changed);
        assert!(mutated);
        assert!(panel.calendars.entries[0].paused);
        assert!(
            panel.calendars.busy_read(),
            "deferred refresh runs after mutation settles"
        );
        let deferred = http.accept().await;
        assert!(
            deferred
                .header
                .starts_with("GET /api/workspaces/ws_1/missions/calendars "),
            "unexpected deferred refresh request: {}",
            deferred.header
        );
        panel.calendars.cancel();
        deferred.disconnected().await;

        // A 404 calendar-missing mutation while hidden does not start a background read.
        panel.calendars.active_mutation = Some(98);
        panel
            .calendars
            .out
            .try_send(Completion {
                kind: OpKind::Mutate,
                serial: 98,
                outcome: Ok(CalendarOutcome::Missing),
            })
            .unwrap();
        let (changed, mutated) =
            panel
                .calendars
                .poll(false, &panel.backend, &panel.reads, &panel.wake);
        assert!(changed);
        assert!(!mutated);
        assert!(!panel.calendars.busy_read());
        http.quiet().await;

        // A 404 calendar-missing mutation while visible schedules a follow-up resync read.
        panel.calendars.active_mutation = Some(99);
        panel
            .calendars
            .out
            .try_send(Completion {
                kind: OpKind::Mutate,
                serial: 99,
                outcome: Ok(CalendarOutcome::Missing),
            })
            .unwrap();
        let (changed, mutated) =
            panel
                .calendars
                .poll(true, &panel.backend, &panel.reads, &panel.wake);
        assert!(changed);
        assert!(!mutated);
        assert_eq!(
            panel.calendars.feedback,
            Some("missions.control.mutation.conflict")
        );
        assert!(
            panel.calendars.busy_read(),
            "Missing triggers follow-up read while visible"
        );
        let resync = http.accept().await;
        assert!(
            resync
                .header
                .starts_with("GET /api/workspaces/ws_1/missions/calendars "),
            "unexpected resync request: {}",
            resync.header
        );
        panel.calendars.cancel();
        resync.disconnected().await;
        http.quiet().await;
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn passive_refresh_does_not_flicker_loading_and_recovers_after_transient_first_error() {
    let mut panel = test_panel("http://127.0.0.1:1/");
    // While an initial/passive read is running with no entries, section does not flicker into view.
    let (cancel, _rx) = CancelToken::new();
    panel.calendars.active_read = Some((1, cancel));
    let mut rt = Runtime::new(
        (panel, TextEdit::new("")),
        |s, _| {
            crate::strings::with_locale("en", || {
                panel_view(&s.0, |s: &mut (Panel, TextEdit)| (Some(&mut s.0), &mut s.1))
            })
        },
        (460.0, 760.0),
        Env::new(true, 1.0),
    );
    rt.frame(0.02);
    assert!(
        rt.find("mission-calendars-section").is_none(),
        "empty passive read must not flicker a loading section"
    );

    // With an existing snapshot, passive refresh keeps the snapshot without injecting a loading banner.
    rt.update(|s, tx| {
        s.0.calendars
            .fixture_set_entries(vec![decode_calendar(calendar_json(
                "cal_keep",
                "Keep visible",
                false,
                None,
                None,
                None,
            ))]);
        let (cancel2, _rx2) = CancelToken::new();
        s.0.calendars.active_read = Some((2, cancel2));
        tx.instant();
    });
    rt.frame(0.02);
    let tree = rt.accessibility_json();
    let section = find_node(&tree, "mission-calendars-section")
        .expect("section stays visible")
        .to_string();
    assert!(section.contains("Keep visible"));
    assert!(
        !section.contains("Loading"),
        "passive refresh must not flicker a Loading note over the snapshot"
    );

    // Reconnect retires in-flight reads without dismissing an open delete confirmation modal;
    // hiding the panel cancels both reads and the modal.
    rt.state.0.calendars.request_delete("cal_keep");
    assert!(rt.state.0.calendars.pending_delete().is_some());
    rt.state.0.calendars.on_reconnect();
    assert!(!rt.state.0.calendars.busy_read());
    assert!(
        rt.state.0.calendars.pending_delete().is_some(),
        "reconnect must not dismiss open delete modal"
    );
    rt.state.0.calendars.cancel();
    assert!(rt.state.0.calendars.pending_delete().is_none());

    // A transient initial read error keeps the empty section hidden without permanently blocking
    // subsequent passive recovery reads.
    let mut recovering = test_panel("http://127.0.0.1:1/");
    recovering.calendars.active_read = Some((3, CancelToken::new().0));
    recovering
        .calendars
        .out
        .try_send(Completion {
            kind: OpKind::Read,
            serial: 3,
            outcome: Err("transient network timeout".into()),
        })
        .unwrap();
    let _ = recovering.calendars.poll(
        true,
        &recovering.backend,
        &recovering.reads,
        &recovering.wake,
    );
    assert!(recovering.calendars.unavailable);
    assert!(!recovering.calendars.failed);

    recovering
        .calendars
        .refresh(&recovering.backend, &recovering.reads, &recovering.wake);
    assert!(
        recovering.calendars.busy_read(),
        "passive refresh must still retry and recover after a transient first-load error"
    );
    recovering.calendars.cancel();
}
