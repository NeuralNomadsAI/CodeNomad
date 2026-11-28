//! Post-#1791 launch criteria contract (`launch.when`) matching
//! `packages/server/src/missions/launch-policy.ts`, `mission-launch-kind.ts`,
//! `mission-github-condition.ts`, and `mission-repository-condition.ts`.
use crate::history::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MISSION_CALENDAR_LIMIT: usize = 8;
pub const MISSION_LAUNCH_CRITERIA_MAX: usize = MISSION_CALENDAR_LIMIT * 2;
pub const MISSION_FILES_CHANGED_MAX: usize = 128;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RepositoryProvider {
    Github,
    Gitlab,
    Gitea,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryEvent {
    PullRequestCreated,
    PullRequestMerged,
    IssueCreated,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CriterionConnector {
    Or,
    If,
    Else,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CriterionRole {
    Trigger,
    Condition,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CriteriaStructure {
    pub connectors: Vec<CriterionConnector>,
    pub roles: Vec<CriterionRole>,
    pub has_fallback: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CalendarUnsupportedReason {
    OneTime,
    FallbackSchedule,
    Ending,
    Event,
    FollowedConversations,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum LaunchCriterion {
    Now,
    Cron {
        expression: String,
        zone: String,
    },
    ScheduleSuccess {
        #[serde(rename = "missionID")]
        mission_id: String,
    },
    MissionCompleted {
        #[serde(rename = "missionID")]
        mission_id: String,
    },
    BranchCommits {
        directory: String,
        #[serde(rename = "ref")]
        git_ref: String,
    },
    ConversationMessage {
        #[serde(rename = "conversationID")]
        conversation_id: String,
    },
    FilesChanged {
        paths: Vec<String>,
    },
    GithubNotification {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repository: Option<String>,
    },
    GithubSecurityAlert {
        repository: String,
    },
    GithubPullRequest {
        repository: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        author: Option<String>,
    },
    GithubIssue {
        repository: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        author: Option<String>,
    },
    RepositoryActivity {
        provider: RepositoryProvider,
        host: String,
        repository: String,
        event: RepositoryEvent,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        author: Option<String>,
    },
    RemoteBranchCommits {
        provider: RepositoryProvider,
        host: String,
        repository: String,
        #[serde(rename = "ref")]
        git_ref: String,
    },
}

impl LaunchCriterion {
    pub fn is_schedule(&self) -> bool {
        matches!(self, Self::Now | Self::Cron { .. })
    }

    /// Events a native Automation calendar can observe with this machine's own
    /// access (matching `missionCalendarEventsSchema` in `calendar-run.ts`).
    pub fn is_calendar_event(&self) -> bool {
        !self.is_schedule()
            && !matches!(
                self,
                Self::ScheduleSuccess { .. }
                    | Self::MissionCompleted { .. }
                    | Self::ConversationMessage { .. }
            )
    }

    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Now => Ok(()),
            Self::Cron { expression, zone } => {
                let expr = expression.trim();
                if expr.is_empty()
                    || expr.encode_utf16().count() > 512
                    || zone.is_empty()
                    || zone.encode_utf16().count() > 100
                    || zone
                        .bytes()
                        .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
                {
                    return Err("invalid cron launch criterion".into());
                }
                Ok(())
            }
            Self::ScheduleSuccess { mission_id } | Self::MissionCompleted { mission_id } => {
                if !document_id_valid(mission_id) {
                    return Err("invalid Mission reference in launch criterion".into());
                }
                Ok(())
            }
            Self::BranchCommits { directory, git_ref } => {
                if directory.is_empty()
                    || directory.encode_utf16().count() > 4096
                    || directory.contains('\0')
                    || !branch_head_ref_valid(git_ref)
                {
                    return Err("invalid branch-commits launch criterion".into());
                }
                Ok(())
            }
            Self::ConversationMessage { conversation_id } => {
                if !native_document_id_valid(conversation_id) {
                    return Err("invalid conversationID in launch criterion".into());
                }
                Ok(())
            }
            Self::FilesChanged { paths } => {
                if paths.is_empty() || paths.len() > MISSION_FILES_CHANGED_MAX {
                    return Err("invalid files-changed path count".into());
                }
                let mut seen = HashSet::with_capacity(paths.len());
                for path in paths {
                    if !relative_path_valid(path) || !seen.insert(path.as_str()) {
                        return Err("invalid files-changed path".into());
                    }
                }
                Ok(())
            }
            Self::GithubNotification { repository } => {
                if repository
                    .as_deref()
                    .is_some_and(|repo| !github_repo_valid(repo))
                {
                    return Err("invalid GitHub repository in launch criterion".into());
                }
                Ok(())
            }
            Self::GithubSecurityAlert { repository } => {
                if !github_repo_valid(repository) {
                    return Err("invalid GitHub repository in launch criterion".into());
                }
                Ok(())
            }
            Self::GithubPullRequest { repository, author }
            | Self::GithubIssue { repository, author } => {
                if !github_repo_valid(repository)
                    || author.as_deref().is_some_and(|a| !github_author_valid(a))
                {
                    return Err("invalid GitHub criterion".into());
                }
                Ok(())
            }
            Self::RepositoryActivity {
                host,
                repository,
                author,
                ..
            } => {
                if !repo_host_valid(host)
                    || !forge_repo_valid(repository)
                    || author.as_deref().is_some_and(|a| !repo_author_valid(a))
                {
                    return Err("invalid repository-activity criterion".into());
                }
                Ok(())
            }
            Self::RemoteBranchCommits {
                host,
                repository,
                git_ref,
                ..
            } => {
                if !repo_host_valid(host)
                    || !forge_repo_valid(repository)
                    || !branch_head_ref_valid(git_ref)
                {
                    return Err("invalid remote-branch-commits criterion".into());
                }
                Ok(())
            }
        }
    }

    fn canonical_key(&self) -> String {
        match self {
            Self::Cron { expression, zone } => {
                let collapsed = expression.split_whitespace().collect::<Vec<_>>().join(" ");
                format!("cron:{collapsed}\0{zone}")
            }
            Self::FilesChanged { paths } => {
                let mut sorted: Vec<&str> = paths.iter().map(String::as_str).collect();
                sorted.sort_unstable();
                format!("files-changed:{}", sorted.join("\0"))
            }
            Self::GithubNotification { repository } => format!(
                "github-notification:{}",
                repository
                    .as_deref()
                    .map(|r| r.trim().to_ascii_lowercase())
                    .unwrap_or_default()
            ),
            Self::GithubSecurityAlert { repository } => {
                format!(
                    "github-security-alert:{}",
                    repository.trim().to_ascii_lowercase()
                )
            }
            Self::GithubPullRequest { repository, author } => format!(
                "github-pull-request:{}\0{}",
                repository.trim().to_ascii_lowercase(),
                author
                    .as_deref()
                    .map(|a| a.trim().trim_start_matches('@').to_ascii_lowercase())
                    .unwrap_or_default()
            ),
            Self::GithubIssue { repository, author } => format!(
                "github-issue:{}\0{}",
                repository.trim().to_ascii_lowercase(),
                author
                    .as_deref()
                    .map(|a| a.trim().trim_start_matches('@').to_ascii_lowercase())
                    .unwrap_or_default()
            ),
            Self::RepositoryActivity {
                provider,
                host,
                repository,
                event,
                author,
            } => format!(
                "repository-activity:{provider:?}\0{host}\0{repository}\0{event:?}\0{}",
                author
                    .as_deref()
                    .map(|a| a.trim().trim_start_matches('@').to_ascii_lowercase())
                    .unwrap_or_default()
            ),
            _ => serde_json::to_string(self).unwrap_or_default(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchPolicy {
    pub when: Vec<LaunchCriterion>,
}

impl LaunchPolicy {
    /// Mirrors `missionCriteriaStructure` in `mission-launch-kind.ts`.
    pub fn structure(&self) -> CriteriaStructure {
        let scheduled: Vec<bool> = self.when.iter().map(LaunchCriterion::is_schedule).collect();
        let connectors = scheduled
            .windows(2)
            .map(|pair| match (pair[0], pair[1]) {
                (a, b) if a == b => CriterionConnector::Or,
                (false, true) => CriterionConnector::Else,
                (true, false) => CriterionConnector::If,
                _ => unreachable!(),
            })
            .collect();
        let mut roles = vec![CriterionRole::Trigger; scheduled.len()];
        let mut has_fallback = false;
        let mut saw_schedule = false;
        let mut saw_event = false;
        for (index, &is_schedule) in scheduled.iter().enumerate() {
            if is_schedule {
                if saw_event {
                    has_fallback = true;
                }
                saw_schedule = true;
            } else {
                if saw_schedule {
                    roles[index] = CriterionRole::Condition;
                }
                saw_event = true;
            }
        }
        CriteriaStructure {
            connectors,
            roles,
            has_fallback,
        }
    }

    /// Matches `requiresMissionCalendar` in `mission-launch-kind.ts`:
    /// an empty list or sole `now` uses one-time journal admission at Play.
    pub fn requires_calendar(&self) -> bool {
        !(self.when.is_empty() || matches!(self.when.as_slice(), [LaunchCriterion::Now]))
    }

    /// Client-side structural validation of `launch.when` criteria.
    /// IANA zone membership, cron minute-resolution syntax, and the 64 KiB
    /// canonical configuration cap remain server-authoritative (`400 calendar-input-invalid`).
    pub fn validate(&self) -> Result<()> {
        if self.when.len() > MISSION_LAUNCH_CRITERIA_MAX {
            return Err("Mission launch criteria exceed maximum length".into());
        }
        for item in &self.when {
            item.validate()?;
        }
        let structure = self.structure();
        let mut schedule_keys = HashSet::new();
        let mut event_keys = HashSet::new();
        let mut schedule_count = 0usize;
        let mut event_count = 0usize;
        let mut has_trigger_event = false;
        for (index, item) in self.when.iter().enumerate() {
            let key = item.canonical_key();
            if item.is_schedule() {
                schedule_count += 1;
                if !schedule_keys.insert(key) {
                    return Err("duplicate schedule in Mission launch criteria".into());
                }
            } else {
                event_count += 1;
                if !event_keys.insert(key) {
                    return Err("duplicate event in Mission launch criteria".into());
                }
                if structure.roles[index] == CriterionRole::Trigger {
                    has_trigger_event = true;
                }
            }
        }
        let principals = schedule_count + usize::from(has_trigger_event);
        if event_count > MISSION_CALENDAR_LIMIT || principals > MISSION_CALENDAR_LIMIT {
            return Err("Mission launch criteria exceed calendar limit".into());
        }
        Ok(())
    }

    /// Mirrors `missionCalendarAutomations` support checks in `calendar-automation.ts`.
    pub fn calendar_unsupported_reason(
        &self,
        watched_conversations: &[String],
    ) -> Option<CalendarUnsupportedReason> {
        if !self.requires_calendar()
            || self
                .when
                .iter()
                .any(|item| matches!(item, LaunchCriterion::Now))
        {
            return Some(CalendarUnsupportedReason::OneTime);
        }
        if self.structure().has_fallback {
            return Some(CalendarUnsupportedReason::FallbackSchedule);
        }
        if !watched_conversations.is_empty() {
            return Some(CalendarUnsupportedReason::FollowedConversations);
        }
        if self
            .when
            .iter()
            .filter(|item| !item.is_schedule())
            .any(|item| !item.is_calendar_event())
        {
            return Some(CalendarUnsupportedReason::Event);
        }
        None
    }
}

pub(super) fn document_id_valid(value: &str) -> bool {
    (3..=100).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub(super) fn native_document_id_valid(value: &str) -> bool {
    (1..=240).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn relative_path_valid(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 4096
        && !value.contains('\\')
        && !value.contains(':')
        && !value.bytes().any(|b| b < 0x20 || b == 0x7f)
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn branch_head_ref_valid(value: &str) -> bool {
    (12..=1024).contains(&value.encode_utf16().count())
        && value.starts_with("refs/heads/")
        && !value.contains("..")
        && !value.contains("@{")
        && !value.chars().any(char::is_whitespace)
        && !value.bytes().any(|b| {
            b <= 0x20 || b == 0x7f || matches!(b, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
        && value.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with('.')
                && !part.ends_with(".lock")
        })
}

fn github_repo_valid(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() > 140 {
        return false;
    }
    let Some((owner, name)) = trimmed.split_once('/') else {
        return false;
    };
    if name.contains('/') || matches!(name, "." | "..") {
        return false;
    }
    let owner_ok = (1..=39).contains(&owner.len())
        && owner.as_bytes()[0].is_ascii_alphanumeric()
        && owner
            .bytes()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let name_ok = (1..=100).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    owner_ok && name_ok
}

fn github_author_valid(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() > 100 {
        return false;
    }
    let body = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let base = body.strip_suffix("[bot]").unwrap_or(body);
    (1..=39).contains(&base.len())
        && base.as_bytes()[0].is_ascii_alphanumeric()
        && base
            .bytes()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn repo_host_valid(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&format!("https://{value}")) else {
        return false;
    };
    let rendered_host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    };
    rendered_host == value
        && url.path() == "/"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn forge_repo_valid(value: &str) -> bool {
    if !(3..=1024).contains(&value.len()) {
        return false;
    }
    let parts: Vec<&str> = value.split('/').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && !part.bytes().all(|b| b == b'.')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        })
}

fn repo_author_valid(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() > 100 {
        return false;
    }
    let body = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let base = body.strip_suffix("[bot]").unwrap_or(body);
    !base.is_empty()
        && (base.as_bytes()[0].is_ascii_alphanumeric() || base.as_bytes()[0] == b'_')
        && base
            .bytes()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}
