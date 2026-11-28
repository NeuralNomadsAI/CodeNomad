//! Concise localized summaries of post-#1791 `launch.when` criteria,
//! native Automation rules, timestamps, and bounded run history (#1802 / #1803).
use codenomad_client::missions::{
    CalendarLastOutcome, CalendarLaunchHistoryEntry, CalendarTrigger, CalendarView,
    CriterionConnector, LaunchCriterion, LaunchPolicy, RepositoryEvent, RepositoryProvider,
    RunState, Status, Summary, Template,
};
use rune_theme_codenomad::catalogue;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DisplayStatus {
    Paused,
    AwaitingFirstLaunch,
    InProgress,
    Waiting,
    Running,
}

/// Derives the concise status of a programmed Mission.
/// Pre-first-launch (#1803) is determined from the prepared Mission's own
/// `Summary` (`Active` + `Prepared`), matching `CalendarView::is_awaiting_first_launch`.
pub(crate) fn display_status(calendar: &CalendarView, summaries: &[Summary]) -> DisplayStatus {
    if calendar.paused {
        return DisplayStatus::Paused;
    }
    let linked = calendar
        .current_mission_id()
        .and_then(|id| summaries.iter().find(|row| row.id == id));
    if linked.is_some_and(|summary| calendar.is_awaiting_first_launch(summary)) {
        return DisplayStatus::AwaitingFirstLaunch;
    }
    if linked.is_some_and(|summary| {
        summary.status == Status::Active
            && !matches!(
                summary.run_state,
                Some(RunState::Prepared | RunState::Paused | RunState::Stopped)
            )
    }) {
        return DisplayStatus::InProgress;
    }
    match calendar.last.as_ref().map(|last| last.outcome) {
        Some(CalendarLastOutcome::Launched) => DisplayStatus::InProgress,
        Some(CalendarLastOutcome::Waiting | CalendarLastOutcome::Idle) => DisplayStatus::Waiting,
        None if linked.is_some() => DisplayStatus::Waiting,
        None => DisplayStatus::Running,
    }
}

pub(crate) fn status_text(status: DisplayStatus, locale: &str) -> String {
    let msg = |key| catalogue::message(locale, key).expect("shared catalogue key");
    match status {
        DisplayStatus::Paused => msg("missions.scheduleList.state.paused").into(),
        DisplayStatus::AwaitingFirstLaunch => format!(
            "{} · {}",
            msg("missions.control.run.prepared"),
            msg("missionsPanel.state.waiting")
        ),
        DisplayStatus::InProgress => msg("missionsPanel.state.inProgress").into(),
        DisplayStatus::Waiting => msg("missionsPanel.state.waiting").into(),
        DisplayStatus::Running => msg("missions.scheduleList.state.running").into(),
    }
}

pub(crate) fn next_due_millis(calendar: &CalendarView) -> Option<u64> {
    if calendar.paused {
        return None;
    }
    calendar
        .rules
        .iter()
        .filter_map(|rule| rule.next_due_at)
        .min()
}

pub(crate) fn next_due_label_key(calendar: &CalendarView) -> &'static str {
    let only_checks = !calendar.rules.is_empty()
        && calendar
            .rules
            .iter()
            .all(|rule| matches!(rule.trigger, CalendarTrigger::Every { .. }));
    if only_checks {
        "missions.scheduleList.nextCheck"
    } else {
        "missions.scheduleList.nextWake"
    }
}

pub(crate) fn primary_zone(calendar: &CalendarView) -> &str {
    if let Some(policy) = calendar.launch_policy()
        && let Some(zone) = policy.when.iter().find_map(|item| match item {
            LaunchCriterion::Cron { zone, .. } => Some(zone.as_str()),
            _ => None,
        })
    {
        return zone;
    }
    calendar
        .rules
        .first()
        .map(|rule| rule.tz.as_str())
        .filter(|tz| !tz.trim().is_empty())
        .unwrap_or("UTC")
}

pub(crate) fn template_label_key(template: Template) -> &'static str {
    match template {
        Template::Custom => "missions.control.template.custom",
        Template::Debug => "missions.control.template.debug",
        Template::Wayfinder => "missions.control.template.wayfinder",
        Template::Delivery => "missions.control.template.delivery",
        Template::Compare => "missions.control.template.compare",
    }
}

/// One concise localized line per criterion in `policy.when`, prefixed from
/// index 1 onward with its connector (`or` / `if` / `else`), mirroring
/// `describeMissionCriteria` in `mission-scheduling-summary.ts`.
pub(crate) fn describe_criteria(policy: &LaunchPolicy, locale: &str) -> Vec<String> {
    let msg = |key: &str| catalogue::message(locale, key).expect("shared catalogue key");
    let structure = policy.structure();
    policy
        .when
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let line = describe_criterion(item, msg);
            if index == 0 {
                line
            } else {
                let connector = match structure.connectors[index - 1] {
                    CriterionConnector::Or | CriterionConnector::Else => {
                        msg("missions.scheduling.connector.or")
                    }
                    CriterionConnector::If => msg("missions.scheduling.connector.if"),
                };
                format!("{connector} · {line}")
            }
        })
        .collect()
}

fn describe_criterion(item: &LaunchCriterion, msg: impl Fn(&str) -> &'static str) -> String {
    match item {
        LaunchCriterion::Now => msg("missions.scheduling.source.now").into(),
        LaunchCriterion::Cron { expression, zone } => format!(
            "{} · {} · {}",
            msg("missions.scheduling.shortcut.cron"),
            expression.trim(),
            zone.trim()
        ),
        LaunchCriterion::ScheduleSuccess { mission_id }
        | LaunchCriterion::MissionCompleted { mission_id } => {
            format!("{} · {mission_id}", msg("missions.scheduling.group.event"))
        }
        LaunchCriterion::BranchCommits { git_ref, .. } => {
            let branch = git_ref.strip_prefix("refs/heads/").unwrap_or(git_ref);
            format!(
                "{} · {branch}",
                msg("missions.scheduling.condition.branch-commits")
            )
        }
        LaunchCriterion::ConversationMessage { conversation_id } => format!(
            "{} · {conversation_id}",
            msg("missions.scheduling.condition.conversation-message")
        ),
        LaunchCriterion::FilesChanged { paths } => format!(
            "{} · {}",
            msg("missions.scheduling.condition.files-changed"),
            paths.join(", ")
        ),
        LaunchCriterion::GithubNotification { repository } => join_parts([
            Some(msg("missions.scheduling.condition.github-notification").to_owned()),
            repository.clone(),
        ]),
        LaunchCriterion::GithubSecurityAlert { repository } => format!(
            "{} · {repository}",
            msg("missions.scheduling.condition.github-security-alert")
        ),
        LaunchCriterion::GithubPullRequest { repository, author } => join_parts([
            Some(msg("missions.scheduling.condition.github-pull-request").to_owned()),
            Some(repository.clone()),
            author.as_deref().map(format_author),
        ]),
        LaunchCriterion::GithubIssue { repository, author } => join_parts([
            Some(msg("missions.scheduling.condition.github-issue").to_owned()),
            Some(repository.clone()),
            author.as_deref().map(format_author),
        ]),
        LaunchCriterion::RepositoryActivity {
            provider,
            host,
            repository,
            event,
            author,
        } => {
            let key = match (provider, event) {
                (RepositoryProvider::Gitlab, RepositoryEvent::PullRequestCreated) => {
                    "missions.scheduling.repository.merge.pull-request-created"
                }
                (RepositoryProvider::Gitlab, RepositoryEvent::PullRequestMerged) => {
                    "missions.scheduling.repository.merge.pull-request-merged"
                }
                (RepositoryProvider::Gitlab, RepositoryEvent::IssueCreated) => {
                    "missions.scheduling.repository.merge.issue-created"
                }
                (_, RepositoryEvent::PullRequestCreated) => {
                    "missions.scheduling.repository.pull.pull-request-created"
                }
                (_, RepositoryEvent::PullRequestMerged) => {
                    "missions.scheduling.repository.pull.pull-request-merged"
                }
                (_, RepositoryEvent::IssueCreated) => {
                    "missions.scheduling.repository.pull.issue-created"
                }
            };
            join_parts([
                Some(msg(key).to_owned()),
                Some(format!("{host}/{repository}")),
                author.as_deref().map(format_author),
            ])
        }
        LaunchCriterion::RemoteBranchCommits {
            host,
            repository,
            git_ref,
            ..
        } => {
            let branch = git_ref.strip_prefix("refs/heads/").unwrap_or(git_ref);
            format!(
                "{} · {host}/{repository} · {branch}",
                msg("missions.scheduling.condition.remote-branch-commits")
            )
        }
    }
}

pub(crate) fn describe_rule_trigger(trigger: &CalendarTrigger, locale: &str) -> String {
    let msg = |key| catalogue::message(locale, key).expect("shared catalogue key");
    match trigger {
        CalendarTrigger::Cron { cron, tz } => join_parts([
            Some(msg("missions.scheduling.shortcut.cron").to_owned()),
            Some(cron.clone()),
            tz.clone(),
        ]),
        CalendarTrigger::Every { every, .. } => {
            format!("{} · {every}", msg("missions.scheduling.frequency.every"))
        }
        CalendarTrigger::At { at, tz } => join_parts([
            Some(msg("missions.scheduling.frequency.at").to_owned()),
            Some(at.clone()),
            tz.clone(),
        ]),
        CalendarTrigger::Event { server, event, .. } => format!("{server}/{event}"),
    }
}

pub(crate) fn format_history_entry(
    entry: &CalendarLaunchHistoryEntry,
    locale: &str,
    zone: &str,
) -> String {
    let outcome = history_outcome_label(&entry.outcome, locale);
    let stamp = format_epoch_ms(entry.at, locale, zone);
    if stamp.is_empty() {
        outcome.to_owned()
    } else {
        format!("{stamp} · {outcome}")
    }
}

fn history_outcome_label<'a>(outcome: &'a str, locale: &str) -> &'a str {
    let key = match outcome {
        "completed" => Some("missionsPanel.run.completed"),
        "failed" => Some("missionsPanel.run.failed"),
        "stopped" => Some("missionsPanel.run.stopped"),
        "ended-without-report" => Some("missionsPanel.run.ended-without-report"),
        "interrupted" => Some("missionsPanel.run.interrupted"),
        "not-started" => Some("missionsPanel.run.not-started"),
        _ => None,
    };
    key.and_then(|key| catalogue::message(locale, key))
        .unwrap_or(outcome)
}

pub(crate) fn format_epoch_ms(millis: u64, locale: &str, zone: &str) -> String {
    #[cfg(target_arch = "wasm32")]
    let localized = {
        let _ = zone;
        let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(millis as f64));
        date.to_locale_string(locale, &wasm_bindgen::JsValue::UNDEFINED)
            .as_string()
    };
    #[cfg(not(target_arch = "wasm32"))]
    let localized = codenomad_host_process::local_date_time(millis, locale, zone);
    localized
        .unwrap_or_else(|| codenomad_client::settings::stats::utc_stamp(millis).unwrap_or_default())
}

pub(crate) fn local_timezone() -> String {
    #[cfg(target_arch = "wasm32")]
    let zone = {
        let format =
            js_sys::Intl::DateTimeFormat::new(&js_sys::Array::new(), &js_sys::Object::new());
        js_sys::Reflect::get(
            &format.resolved_options(),
            &wasm_bindgen::JsValue::from_str("timeZone"),
        )
        .ok()
        .and_then(|value| value.as_string())
    };
    #[cfg(not(target_arch = "wasm32"))]
    let zone = codenomad_host_process::local_time_zone();
    zone.unwrap_or_else(|| "UTC".to_owned())
}

fn format_author(author: &str) -> String {
    let trimmed = author.trim();
    if trimmed.starts_with('@') {
        trimmed.to_owned()
    } else {
        format!("@{trimmed}")
    }
}

fn join_parts<const N: usize>(parts: [Option<String>; N]) -> String {
    parts
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}
