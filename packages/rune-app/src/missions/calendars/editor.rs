//! Structured post-#1791 `launch.when` and calendar configuration editor state.
use super::summary::{local_timezone, primary_zone};
use codenomad_client::missions::{
    CalendarConfiguration, CalendarLaunch, CalendarSaveRequest, CalendarUnsupportedReason,
    CalendarView, LaunchCriterion, LaunchPolicy, MISSION_LAUNCH_CRITERIA_MAX, Profiles,
    RepositoryEvent, RepositoryProvider, TaskMode, Template,
};
use rune::edit::TextEdit;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CriterionKind {
    Cron,
    FilesChanged,
    BranchCommits,
    GithubNotification,
    GithubSecurityAlert,
    GithubPullRequest,
    GithubIssue,
    RepositoryActivity,
    RemoteBranchCommits,
}

impl CriterionKind {
    pub(crate) const ALL: [Self; 9] = [
        Self::Cron,
        Self::FilesChanged,
        Self::BranchCommits,
        Self::GithubNotification,
        Self::GithubSecurityAlert,
        Self::GithubPullRequest,
        Self::GithubIssue,
        Self::RepositoryActivity,
        Self::RemoteBranchCommits,
    ];

    pub(crate) fn next(self) -> Self {
        let index = Self::ALL.iter().position(|&item| item == self).unwrap_or(0);
        Self::ALL[(index + 1) % Self::ALL.len()]
    }

    pub(crate) fn label_key(self) -> &'static str {
        match self {
            Self::Cron => "missions.scheduling.shortcut.cron",
            Self::FilesChanged => "missions.scheduling.condition.files-changed",
            Self::BranchCommits => "missions.scheduling.condition.branch-commits",
            Self::GithubNotification => "missions.scheduling.condition.github-notification",
            Self::GithubSecurityAlert => "missions.scheduling.condition.github-security-alert",
            Self::GithubPullRequest => "missions.scheduling.condition.github-pull-request",
            Self::GithubIssue => "missions.scheduling.condition.github-issue",
            Self::RepositoryActivity => "missions.scheduling.condition.repository-activity",
            Self::RemoteBranchCommits => "missions.scheduling.condition.remote-branch-commits",
        }
    }
}

pub(crate) struct CriterionDraft {
    pub(crate) kind: CriterionKind,
    /// Primary input: cron expression, file paths (one per line), GitHub/forge repository, or local dir.
    pub(crate) primary: TextEdit,
    /// Secondary input: IANA zone, branch ref (`refs/heads/...` or branch name), or optional author.
    pub(crate) secondary: TextEdit,
    /// Forge host for `RepositoryActivity` / `RemoteBranchCommits`.
    pub(crate) host: TextEdit,
    /// Optional author for `RepositoryActivity`.
    pub(crate) author: TextEdit,
    pub(crate) provider: RepositoryProvider,
    pub(crate) event: RepositoryEvent,
}

impl CriterionDraft {
    pub(crate) fn new_cron(zone: &str) -> Self {
        Self {
            kind: CriterionKind::Cron,
            primary: TextEdit::new("0 9 * * *"),
            secondary: TextEdit::new(zone),
            host: TextEdit::new(""),
            author: TextEdit::new(""),
            provider: RepositoryProvider::Github,
            event: RepositoryEvent::PullRequestCreated,
        }
    }

    fn from_criterion(item: &LaunchCriterion, default_zone: &str) -> Option<Self> {
        let mut draft = Self::new_cron(default_zone);
        match item {
            LaunchCriterion::Cron { expression, zone } => {
                draft.kind = CriterionKind::Cron;
                draft.primary = TextEdit::new(expression);
                draft.secondary = TextEdit::new(zone);
            }
            LaunchCriterion::FilesChanged { paths } => {
                draft.kind = CriterionKind::FilesChanged;
                draft.primary = TextEdit::new(&paths.join("\n"));
                draft.secondary = TextEdit::new("");
            }
            LaunchCriterion::BranchCommits { directory, git_ref } => {
                draft.kind = CriterionKind::BranchCommits;
                draft.primary = TextEdit::new(directory);
                draft.secondary = TextEdit::new(git_ref);
            }
            LaunchCriterion::GithubNotification { repository } => {
                draft.kind = CriterionKind::GithubNotification;
                draft.primary = TextEdit::new(repository.as_deref().unwrap_or(""));
                draft.secondary = TextEdit::new("");
            }
            LaunchCriterion::GithubSecurityAlert { repository } => {
                draft.kind = CriterionKind::GithubSecurityAlert;
                draft.primary = TextEdit::new(repository);
                draft.secondary = TextEdit::new("");
            }
            LaunchCriterion::GithubPullRequest { repository, author } => {
                draft.kind = CriterionKind::GithubPullRequest;
                draft.primary = TextEdit::new(repository);
                draft.secondary = TextEdit::new(author.as_deref().unwrap_or(""));
            }
            LaunchCriterion::GithubIssue { repository, author } => {
                draft.kind = CriterionKind::GithubIssue;
                draft.primary = TextEdit::new(repository);
                draft.secondary = TextEdit::new(author.as_deref().unwrap_or(""));
            }
            LaunchCriterion::RepositoryActivity {
                provider,
                host,
                repository,
                event,
                author,
            } => {
                draft.kind = CriterionKind::RepositoryActivity;
                draft.provider = *provider;
                draft.host = TextEdit::new(host);
                draft.primary = TextEdit::new(repository);
                draft.event = *event;
                draft.author = TextEdit::new(author.as_deref().unwrap_or(""));
                draft.secondary = TextEdit::new("");
            }
            LaunchCriterion::RemoteBranchCommits {
                provider,
                host,
                repository,
                git_ref,
            } => {
                draft.kind = CriterionKind::RemoteBranchCommits;
                draft.provider = *provider;
                draft.host = TextEdit::new(host);
                draft.primary = TextEdit::new(repository);
                draft.secondary = TextEdit::new(git_ref);
            }
            LaunchCriterion::Now
            | LaunchCriterion::ScheduleSuccess { .. }
            | LaunchCriterion::MissionCompleted { .. }
            | LaunchCriterion::ConversationMessage { .. } => return None,
        }
        Some(draft)
    }

    pub(crate) fn switch_kind(&mut self, next: CriterionKind, default_zone: &str) {
        if self.kind == next {
            return;
        }
        *self = match next {
            CriterionKind::Cron => Self::new_cron(default_zone),
            CriterionKind::RepositoryActivity | CriterionKind::RemoteBranchCommits => Self {
                kind: next,
                primary: TextEdit::new(""),
                secondary: TextEdit::new(if next == CriterionKind::RemoteBranchCommits {
                    "refs/heads/main"
                } else {
                    ""
                }),
                host: TextEdit::new("github.com"),
                author: TextEdit::new(""),
                provider: RepositoryProvider::Github,
                event: RepositoryEvent::PullRequestCreated,
            },
            CriterionKind::BranchCommits => Self {
                kind: next,
                primary: TextEdit::new(""),
                secondary: TextEdit::new("refs/heads/main"),
                host: TextEdit::new(""),
                author: TextEdit::new(""),
                provider: RepositoryProvider::Github,
                event: RepositoryEvent::PullRequestCreated,
            },
            _ => Self {
                kind: next,
                primary: TextEdit::new(""),
                secondary: TextEdit::new(""),
                host: TextEdit::new(""),
                author: TextEdit::new(""),
                provider: RepositoryProvider::Github,
                event: RepositoryEvent::PullRequestCreated,
            },
        };
    }

    pub(crate) fn cycle_provider(&mut self) {
        self.provider = match self.provider {
            RepositoryProvider::Github => RepositoryProvider::Gitlab,
            RepositoryProvider::Gitlab => RepositoryProvider::Gitea,
            RepositoryProvider::Gitea => RepositoryProvider::Github,
        };
    }

    pub(crate) fn cycle_event(&mut self) {
        self.event = match self.event {
            RepositoryEvent::PullRequestCreated => RepositoryEvent::PullRequestMerged,
            RepositoryEvent::PullRequestMerged => RepositoryEvent::IssueCreated,
            RepositoryEvent::IssueCreated => RepositoryEvent::PullRequestCreated,
        };
    }

    pub(crate) fn is_composing(&self) -> bool {
        self.primary.is_composing()
            || self.secondary.is_composing()
            || self.host.is_composing()
            || self.author.is_composing()
    }

    fn to_criterion(&self) -> Result<LaunchCriterion, &'static str> {
        let primary = self.primary.text.trim();
        let secondary = self.secondary.text.trim();
        let criterion = match self.kind {
            CriterionKind::Cron => {
                if primary.is_empty() {
                    return Err("missions.scheduling.error.cron");
                }
                if secondary.is_empty() {
                    return Err("missions.scheduling.error.zone");
                }
                LaunchCriterion::Cron {
                    expression: primary.to_owned(),
                    zone: secondary.to_owned(),
                }
            }
            CriterionKind::FilesChanged => {
                let paths: Vec<String> = self
                    .primary
                    .text
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(ToOwned::to_owned)
                    .collect();
                if paths.is_empty() {
                    return Err("missions.scheduling.error.files");
                }
                LaunchCriterion::FilesChanged { paths }
            }
            CriterionKind::BranchCommits => LaunchCriterion::BranchCommits {
                directory: primary.to_owned(),
                git_ref: normalize_branch_ref(secondary),
            },
            CriterionKind::GithubNotification => LaunchCriterion::GithubNotification {
                repository: (!primary.is_empty()).then(|| primary.to_owned()),
            },
            CriterionKind::GithubSecurityAlert => LaunchCriterion::GithubSecurityAlert {
                repository: primary.to_owned(),
            },
            CriterionKind::GithubPullRequest => LaunchCriterion::GithubPullRequest {
                repository: primary.to_owned(),
                author: (!secondary.is_empty()).then(|| secondary.to_owned()),
            },
            CriterionKind::GithubIssue => LaunchCriterion::GithubIssue {
                repository: primary.to_owned(),
                author: (!secondary.is_empty()).then(|| secondary.to_owned()),
            },
            CriterionKind::RepositoryActivity => {
                let author = self.author.text.trim();
                LaunchCriterion::RepositoryActivity {
                    provider: self.provider,
                    host: self.host.text.trim().to_owned(),
                    repository: primary.to_owned(),
                    event: self.event,
                    author: (!author.is_empty()).then(|| author.to_owned()),
                }
            }
            CriterionKind::RemoteBranchCommits => LaunchCriterion::RemoteBranchCommits {
                provider: self.provider,
                host: self.host.text.trim().to_owned(),
                repository: primary.to_owned(),
                git_ref: normalize_branch_ref(secondary),
            },
        };
        if criterion.validate().is_err() {
            return Err(match self.kind {
                CriterionKind::Cron => "missions.scheduling.error.cron",
                CriterionKind::FilesChanged => "missions.scheduling.error.files",
                CriterionKind::GithubPullRequest | CriterionKind::GithubIssue
                    if !secondary.is_empty() =>
                {
                    "missions.scheduling.error.author"
                }
                CriterionKind::RepositoryActivity if !self.author.text.trim().is_empty() => {
                    "missions.scheduling.error.author"
                }
                _ => "missions.scheduling.error.source",
            });
        }
        Ok(criterion)
    }
}

fn normalize_branch_ref(value: &str) -> String {
    if value.is_empty() || value.starts_with("refs/") {
        value.to_owned()
    } else {
        format!("refs/heads/{value}")
    }
}

pub(crate) struct CalendarEditor {
    pub(crate) calendar_id: String,
    pub(crate) title: TextEdit,
    pub(crate) objective: TextEdit,
    pub(crate) notes: TextEdit,
    pub(crate) template: Template,
    pub(crate) profiles: Option<Profiles>,
    pub(crate) task_mode: TaskMode,
    pub(crate) coordinator_session_id: Option<String>,
    pub(crate) coordinator_goal: bool,
    pub(crate) default_zone: String,
    pub(crate) retained_opaque: bool,
    pub(crate) criteria: Vec<CriterionDraft>,
    pub(crate) validation_error: Option<&'static str>,
}

impl CalendarEditor {
    pub(crate) fn from_view(view: &CalendarView) -> Self {
        let default_zone = {
            let zone = primary_zone(view);
            if zone.is_empty() {
                local_timezone()
            } else {
                zone.to_owned()
            }
        };
        let (retained_opaque, criteria) = match &view.launch {
            Some(CalendarLaunch::Criteria(policy)) => {
                let mut rows = Vec::with_capacity(policy.when.len());
                let mut opaque = false;
                for item in &policy.when {
                    if let Some(row) = CriterionDraft::from_criterion(item, &default_zone) {
                        rows.push(row);
                    } else {
                        opaque = true;
                        break;
                    }
                }
                if opaque {
                    (true, Vec::new())
                } else {
                    (false, rows)
                }
            }
            Some(CalendarLaunch::Opaque(_)) => (true, Vec::new()),
            None => {
                let mut rows = Vec::new();
                if let Some(when) = &view.mission.when {
                    for item in when {
                        if let Some(row) = CriterionDraft::from_criterion(item, &default_zone) {
                            rows.push(row);
                        }
                    }
                }
                if rows.is_empty() {
                    rows.push(CriterionDraft::new_cron(&default_zone));
                }
                (false, rows)
            }
        };
        Self {
            calendar_id: view.id.clone(),
            title: TextEdit::new(view.mission.title.as_deref().unwrap_or(&view.title)),
            objective: TextEdit::new(view.mission.objective.as_deref().unwrap_or("")),
            notes: TextEdit::new(view.mission.notes.as_deref().unwrap_or("")),
            template: view.mission.template.unwrap_or(Template::Custom),
            profiles: view.mission.profiles.clone(),
            task_mode: view.mission.task_mode.unwrap_or(TaskMode::Native),
            coordinator_session_id: view.mission.coordinator_session_id.clone(),
            coordinator_goal: view.coordinator_goal(),
            default_zone,
            retained_opaque,
            criteria,
            validation_error: None,
        }
    }

    pub(crate) fn is_composing(&self) -> bool {
        self.title.is_composing()
            || self.objective.is_composing()
            || self.notes.is_composing()
            || self.criteria.iter().any(CriterionDraft::is_composing)
    }

    pub(crate) fn replace_retained(&mut self) {
        self.retained_opaque = false;
        self.criteria = vec![CriterionDraft::new_cron(&self.default_zone)];
        self.validation_error = None;
    }

    pub(crate) fn add_criterion(&mut self) {
        if self.criteria.len() < MISSION_LAUNCH_CRITERIA_MAX {
            self.criteria
                .push(CriterionDraft::new_cron(&self.default_zone));
            self.validation_error = None;
        }
    }

    pub(crate) fn remove_criterion(&mut self, index: usize) {
        if index < self.criteria.len() {
            self.criteria.remove(index);
            self.validation_error = None;
        }
    }

    pub(crate) fn move_criterion(&mut self, index: usize, delta: isize) {
        let Some(target) = index.checked_add_signed(delta) else {
            return;
        };
        if index < self.criteria.len() && target < self.criteria.len() {
            self.criteria.swap(index, target);
            self.validation_error = None;
        }
    }

    pub(crate) fn build_request(&mut self) -> Result<CalendarSaveRequest, &'static str> {
        let result = self.build_request_inner();
        self.validation_error = result.as_ref().err().copied();
        result
    }

    fn build_request_inner(&self) -> Result<CalendarSaveRequest, &'static str> {
        if self.retained_opaque {
            return Err("missions.scheduling.error.retained");
        }
        if self.criteria.is_empty() {
            return Err("missions.scheduling.error.empty");
        }
        let mut when = Vec::with_capacity(self.criteria.len());
        for draft in &self.criteria {
            when.push(draft.to_criterion()?);
        }
        let launch = LaunchPolicy { when };
        if let Err(err) = launch.validate() {
            let text = err.to_string();
            return Err(if text.contains("duplicate") {
                "missions.scheduling.error.duplicate"
            } else if text.contains("maximum") || text.contains("limit") {
                "missions.scheduling.error.count"
            } else {
                "missions.scheduling.error.source"
            });
        }
        if let Some(reason) = launch.calendar_unsupported_reason(&[]) {
            return Err(unsupported_error_key(reason));
        }
        let notes = self.notes.text.trim();
        let configuration = CalendarConfiguration {
            title: self.title.text.trim().to_owned(),
            objective: self.objective.text.trim().to_owned(),
            notes: (!notes.is_empty()).then(|| notes.to_owned()),
            template: self.template,
            profiles: self.profiles.clone(),
            task_mode: self.task_mode,
            watched_conversation_ids: Vec::new(),
            coordinator_session_id: self.coordinator_session_id.clone(),
            coordinator_goal: self.coordinator_goal.then_some(true),
            launch,
        };
        if let Err(err) = configuration.validate() {
            let text = err.to_string();
            return Err(if text.contains("profile") || text.contains("model") {
                "missions.recurrence.profilesRequired"
            } else {
                "missions.control.mutation.error"
            });
        }
        let request = CalendarSaveRequest {
            configuration,
            directory: None,
        };
        request
            .validate()
            .map_err(|_| "missions.control.mutation.error")?;
        Ok(request)
    }
}

pub(crate) fn unsupported_error_key(reason: CalendarUnsupportedReason) -> &'static str {
    match reason {
        CalendarUnsupportedReason::OneTime => "missions.scheduling.error.empty",
        CalendarUnsupportedReason::FallbackSchedule => "missions.scheduling.error.capability",
        CalendarUnsupportedReason::Ending => "missions.scheduling.error.capability",
        CalendarUnsupportedReason::Event => "missions.scheduling.error.source",
        CalendarUnsupportedReason::FollowedConversations => "missions.scheduling.error.capability",
    }
}
