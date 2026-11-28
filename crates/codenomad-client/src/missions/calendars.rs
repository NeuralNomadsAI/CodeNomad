//! Unified programmed Missions ("calendars") HTTP contract matching
//! `packages/server/src/server/routes/mission-calendars.ts`,
//! `packages/server/src/opencode/mission-calendars.ts`, and
//! `packages/server/src/missions/calendar-run.ts` (#1788, #1799, #1802, #1803).
use super::{
    CalendarUnsupportedReason, LaunchCriterion, LaunchPolicy, Profiles, RunState, Status, Summary,
    TaskMode, Template,
    directory::panel_id,
    launch::{document_id_valid, native_document_id_valid},
};
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    time::Duration,
};

const JS_MAX: u64 = (1 << 53) - 1;
const CALENDAR_HISTORY_MAX: usize = 20;
const CALENDAR_READ_TIMEOUT: Duration = Duration::from_secs(30);
const CALENDAR_MUTATION_TIMEOUT: Duration = Duration::from_secs(90);
const CALENDAR_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const SCHEDULE_CARRIER_PREFIX: &str = "ses_cn_schedule_";
const GOAL_CARRIER_PREFIX: &str = "ses_cn_goal_";

pub fn calendar_id_valid(id: &str) -> bool {
    document_id_valid(id)
}

fn reserved_carrier_session(id: &str) -> bool {
    id.starts_with(SCHEDULE_CARRIER_PREFIX) || id.starts_with(GOAL_CARRIER_PREFIX)
}

fn directory_valid(directory: &str) -> bool {
    !directory.is_empty() && directory.encode_utf16().count() <= 4096 && !directory.contains('\0')
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CalendarAction {
    Pause,
    Resume,
}

impl CalendarAction {
    fn segment(self) -> &'static str {
        match self {
            Self::Pause => "pause",
            Self::Resume => "resume",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CalendarTrigger {
    Cron {
        cron: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
    },
    Every {
        every: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
    },
    At {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
    },
    Event {
        server: String,
        event: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Value>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRule {
    #[serde(rename = "automationID")]
    pub automation_id: String,
    pub trigger: CalendarTrigger,
    pub tz: String,
    #[serde(default)]
    pub next_due_at: Option<u64>,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    #[serde(default)]
    pub last_outcome: Option<String>,
    #[serde(default)]
    pub last_output: Option<String>,
    pub run_count: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CalendarLastOutcome {
    Launched,
    Waiting,
    Idle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CalendarLaunchHistoryEntry {
    pub at: u64,
    pub outcome: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarLast {
    pub outcome: CalendarLastOutcome,
    #[serde(rename = "missionID", default)]
    pub mission_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(rename = "coordinatorSessionID", default)]
    pub coordinator_session_id: Option<String>,
    #[serde(default)]
    pub history: Vec<CalendarLaunchHistoryEntry>,
    pub at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMission {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub template: Option<Template>,
    #[serde(default)]
    pub task_mode: Option<TaskMode>,
    #[serde(default)]
    pub profiles: Option<Profiles>,
    #[serde(default)]
    pub coordinator_goal: Option<bool>,
    #[serde(rename = "coordinatorSessionID", default)]
    pub coordinator_session_id: Option<String>,
    #[serde(default)]
    pub when: Option<Vec<LaunchCriterion>>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl CalendarMission {
    pub fn coordinator_goal(&self) -> bool {
        self.coordinator_goal.unwrap_or(false)
    }

    fn validate(&self) -> Result<()> {
        if let Some(when) = &self.when {
            for item in when {
                item.validate()?;
            }
        }
        if let Some(session_id) = &self.coordinator_session_id
            && !panel_id(session_id)
        {
            return Err("invalid calendar mission coordinatorSessionID".into());
        }
        if let Some(profiles) = &self.profiles {
            if let Some(template) = self.template {
                profiles.validate_for_template(template)?;
            } else {
                if let Some(coordinator) = &profiles.coordinator {
                    coordinator.validate()?;
                }
                if let Some(roles) = &profiles.roles {
                    for execution in roles.values() {
                        execution.validate()?;
                    }
                }
            }
        }
        Ok(())
    }
}

/// Read-only representation of `calendar.launch` on listed views.
/// Valid `{ when }` policies decode strictly into `Criteria`; any non-criteria
/// stored shape stays `Opaque` so one atypical Automation never breaks the list.
#[derive(Clone, Debug, PartialEq)]
pub enum CalendarLaunch {
    Criteria(LaunchPolicy),
    Opaque(Value),
}

impl<'de> Deserialize<'de> for CalendarLaunch {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if value
            .as_object()
            .is_some_and(|obj| obj.contains_key("when"))
            && let Ok(policy) = serde_json::from_value::<LaunchPolicy>(value.clone())
            && policy.validate().is_ok()
        {
            return Ok(Self::Criteria(policy));
        }
        Ok(Self::Opaque(value))
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarView {
    pub id: String,
    pub title: String,
    pub paused: bool,
    /// The Mission that is the programmed one right now: its current launch,
    /// or the prepared Mission standing for it before the first launch (#1803).
    #[serde(rename = "missionID", default)]
    pub mission_id: Option<String>,
    /// The launch criteria as entered, kept for editing (opaque if non-criteria).
    #[serde(default)]
    pub launch: Option<CalendarLaunch>,
    /// The Mission each launch creates and any event conditions it waits for.
    pub mission: CalendarMission,
    pub rules: Vec<CalendarRule>,
    /// Latest Automation run state (#1802): absent before any rule has run,
    /// and reset when editing a calendar replaces its Automation rows.
    #[serde(default)]
    pub last: Option<CalendarLast>,
}

impl CalendarView {
    pub fn launch_policy(&self) -> Option<&LaunchPolicy> {
        match &self.launch {
            Some(CalendarLaunch::Criteria(policy)) => Some(policy),
            _ => None,
        }
    }

    /// True when `mission` is the prepared Mission standing for this calendar
    /// before its first launch (#1803). Determined from the Mission's own
    /// `status` and `runState` rather than `last`, because editing after the
    /// first launch replaces Automation rows (clearing `last`) and a prepared
    /// Mission can also be played by hand.
    pub fn is_awaiting_first_launch(&self, mission: &Summary) -> bool {
        self.mission_id.as_deref() == Some(mission.id.as_str())
            && mission.status == Status::Active
            && mission.run_state == Some(RunState::Prepared)
    }

    pub fn current_mission_id(&self) -> Option<&str> {
        self.mission_id.as_deref()
    }

    pub fn coordinator_session_id(&self) -> Option<&str> {
        self.last
            .as_ref()
            .and_then(|last| last.coordinator_session_id.as_deref())
            .or(self.mission.coordinator_session_id.as_deref())
    }

    pub fn coordinator_goal(&self) -> bool {
        self.mission.coordinator_goal()
    }

    pub fn history(&self) -> &[CalendarLaunchHistoryEntry] {
        self.last
            .as_ref()
            .map_or(&[], |last| last.history.as_slice())
    }

    fn validate(&self) -> Result<()> {
        if !calendar_id_valid(&self.id)
            || self.title.trim().is_empty()
            || self.title.encode_utf16().count() > 240
            || self.mission_id.as_deref().is_some_and(|id| !panel_id(id))
            || self.rules.is_empty()
        {
            return Err("invalid Mission calendar view".into());
        }
        if let Some(CalendarLaunch::Criteria(launch)) = &self.launch {
            launch.validate()?;
        }
        self.mission.validate()?;
        let mut rule_ids = HashSet::with_capacity(self.rules.len());
        for rule in &self.rules {
            if !panel_id(&rule.automation_id)
                || !rule_ids.insert(rule.automation_id.as_str())
                || rule.tz.trim().is_empty()
                || rule.run_count > JS_MAX
                || rule.next_due_at.is_some_and(|t| t > JS_MAX)
                || rule.last_run_at.is_some_and(|t| t > JS_MAX)
            {
                return Err("invalid Mission calendar rule".into());
            }
            match &rule.trigger {
                CalendarTrigger::Cron { cron, .. } if cron.trim().is_empty() => {
                    return Err("invalid cron calendar trigger".into());
                }
                CalendarTrigger::Every { every, .. } if every.trim().is_empty() => {
                    return Err("invalid interval calendar trigger".into());
                }
                CalendarTrigger::At { at, .. } if at.trim().is_empty() => {
                    return Err("invalid timestamp calendar trigger".into());
                }
                CalendarTrigger::Event { server, event, .. }
                    if server.trim().is_empty() || event.trim().is_empty() =>
                {
                    return Err("invalid event calendar trigger".into());
                }
                _ => {}
            }
        }
        if let Some(last) = &self.last
            && (last.at > JS_MAX
                || last.history.len() > CALENDAR_HISTORY_MAX
                || last.mission_id.as_deref().is_some_and(|id| !panel_id(id))
                || last
                    .mission_id
                    .as_deref()
                    .is_some_and(|id| self.mission_id.as_deref() != Some(id))
                || last.status.as_deref().is_some_and(|s| !panel_id(s))
                || last
                    .coordinator_session_id
                    .as_deref()
                    .is_some_and(|id| !panel_id(id))
                || last
                    .history
                    .iter()
                    .any(|entry| entry.at > JS_MAX || !panel_id(&entry.outcome)))
        {
            return Err("invalid Mission calendar run state".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarConfiguration {
    pub title: String,
    pub objective: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub template: Template,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Profiles>,
    pub task_mode: TaskMode,
    #[serde(rename = "watchedConversationIDs")]
    pub watched_conversation_ids: Vec<String>,
    #[serde(
        rename = "coordinatorSessionID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub coordinator_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_goal: Option<bool>,
    pub launch: LaunchPolicy,
}

impl CalendarConfiguration {
    /// Client-side validation mirroring `missionConfigurationSchema` in `launch-policy.ts`.
    /// IANA zone membership, cron minute syntax, and the 64 KiB canonical JSON cap remain
    /// server-authoritative (`400 calendar-input-invalid` -> `CalendarOutcome::InvalidInput`).
    pub fn validate(&self) -> Result<()> {
        let title = self.title.trim();
        if title.is_empty()
            || title.encode_utf16().count() > 60
            || title.contains(['\r', '\n'])
            || self.objective.is_empty()
            || self.objective.encode_utf16().count() > 20_000
            || self
                .notes
                .as_deref()
                .is_some_and(|notes| notes.encode_utf16().count() > 20_000)
        {
            return Err("invalid Mission calendar text fields".into());
        }
        if self.watched_conversation_ids.len() > 64 {
            return Err("too many watched conversations".into());
        }
        let mut watched = HashSet::with_capacity(self.watched_conversation_ids.len());
        for id in &self.watched_conversation_ids {
            if !native_document_id_valid(id) || !watched.insert(id.as_str()) {
                return Err("invalid watchedConversationIDs".into());
            }
        }
        self.launch.validate()?;
        if let Some(session_id) = &self.coordinator_session_id {
            if !native_document_id_valid(session_id) || reserved_carrier_session(session_id) {
                return Err("invalid coordinatorSessionID".into());
            }
            if !self.launch.requires_calendar() {
                return Err("coordinatorSessionID requires calendar launch criteria".into());
            }
            if watched.contains(session_id.as_str())
                || self.launch.when.iter().any(|item| {
                    matches!(item, LaunchCriterion::ConversationMessage { conversation_id } if conversation_id == session_id)
                })
            {
                return Err("coordinatorSessionID cannot be a watched source".into());
            }
        }
        if self.launch.requires_calendar() {
            let profiles = self
                .profiles
                .as_ref()
                .ok_or("calendar Mission requires explicit profiles")?;
            profiles.validate_explicit_for_template(self.template)?;
        } else if let Some(profiles) = &self.profiles {
            profiles.validate_for_template(self.template)?;
        } else if self.template == Template::Compare {
            return Err("compare playbook requires two distinct models".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarSaveRequest {
    pub configuration: CalendarConfiguration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
}

impl CalendarSaveRequest {
    pub fn validate(&self) -> Result<()> {
        self.configuration.validate()?;
        if self
            .directory
            .as_deref()
            .is_some_and(|dir| !directory_valid(dir))
        {
            return Err("invalid Mission calendar directory".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CalendarOutcome {
    Ok(Vec<CalendarView>),
    Unsupported(CalendarUnsupportedReason),
    Missing,
    InvalidInput,
    Unavailable,
    AuthExpired,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CalendarListResponse {
    calendars: Vec<CalendarView>,
}

#[derive(Deserialize)]
struct CalendarErrorBody {
    code: Option<String>,
    reason: Option<CalendarUnsupportedReason>,
}

impl Backend {
    pub async fn mission_calendars(&self, directory: Option<&str>) -> Result<CalendarOutcome> {
        let url = calendar_url(self, None, None, directory)?;
        let request = self.client.get(url).timeout(CALENDAR_READ_TIMEOUT);
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_cache_no_store();
        decode_calendar_response(request.send().await?).await
    }

    pub async fn save_mission_calendar(
        &self,
        calendar_id: &str,
        request: &CalendarSaveRequest,
    ) -> Result<CalendarOutcome> {
        if !calendar_id_valid(calendar_id) {
            return Err("invalid Mission calendar ID".into());
        }
        request.validate()?;
        let url = calendar_url(self, Some(calendar_id), None, None)?;
        let response = self
            .client
            .put(url)
            .timeout(CALENDAR_MUTATION_TIMEOUT)
            .json(request)
            .send()
            .await?;
        decode_calendar_response(response).await
    }

    pub async fn control_mission_calendar(
        &self,
        calendar_id: &str,
        action: CalendarAction,
        directory: Option<&str>,
    ) -> Result<CalendarOutcome> {
        if !calendar_id_valid(calendar_id) {
            return Err("invalid Mission calendar ID".into());
        }
        let url = calendar_url(self, Some(calendar_id), Some(action), directory)?;
        let response = self
            .client
            .post(url)
            .timeout(CALENDAR_MUTATION_TIMEOUT)
            .send()
            .await?;
        decode_calendar_response(response).await
    }

    pub async fn delete_mission_calendar(
        &self,
        calendar_id: &str,
        directory: Option<&str>,
    ) -> Result<CalendarOutcome> {
        if !calendar_id_valid(calendar_id) {
            return Err("invalid Mission calendar ID".into());
        }
        let url = calendar_url(self, Some(calendar_id), None, directory)?;
        let response = self
            .client
            .delete(url)
            .timeout(CALENDAR_MUTATION_TIMEOUT)
            .send()
            .await?;
        decode_calendar_response(response).await
    }
}

fn calendar_url(
    backend: &Backend,
    calendar_id: Option<&str>,
    action: Option<CalendarAction>,
    directory: Option<&str>,
) -> Result<Url> {
    if !valid_id(&backend.workspace) {
        return Err("invalid Mission calendar workspace".into());
    }
    if directory.is_some_and(|dir| !directory_valid(dir)) {
        return Err("invalid Mission calendar directory".into());
    }
    let mut url = Url::parse(&backend.base)?.join("api/workspaces/")?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "invalid Mission backend URL")?;
        segments.pop_if_empty();
        segments.extend([backend.workspace.as_str(), "missions", "calendars"]);
        if let Some(id) = calendar_id {
            segments.push(id);
        }
        if let Some(action) = action {
            segments.push(action.segment());
        }
    }
    if let Some(dir) = directory {
        url.query_pairs_mut().append_pair("directory", dir);
    }
    Ok(url)
}

async fn decode_calendar_response(response: reqwest::Response) -> Result<CalendarOutcome> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Ok(CalendarOutcome::AuthExpired);
    }
    let body = read_json_limited(response, CALENDAR_RESPONSE_BYTES).await?;
    settle_calendar(status, body)
}

pub(crate) fn settle_calendar(status: StatusCode, body: Value) -> Result<CalendarOutcome> {
    if status == StatusCode::OK {
        let list: CalendarListResponse = serde_json::from_value(body)?;
        validate_calendar_list(&list.calendars)?;
        return Ok(CalendarOutcome::Ok(list.calendars));
    }
    let err: CalendarErrorBody = serde_json::from_value(body)?;
    match (status.as_u16(), err.code.as_deref()) {
        (422, Some("calendar-unsupported")) => err
            .reason
            .map(CalendarOutcome::Unsupported)
            .ok_or_else(|| "missing calendar-unsupported reason".into()),
        (404, Some("calendar-missing")) => Ok(CalendarOutcome::Missing),
        (400, Some("calendar-input-invalid")) => Ok(CalendarOutcome::InvalidInput),
        (403 | 404 | 409 | 503, Some("calendar-unavailable")) | (503, None) => {
            Ok(CalendarOutcome::Unavailable)
        }
        _ => Err(format!("unexpected Mission calendar response ({status})").into()),
    }
}

fn validate_calendar_list(views: &[CalendarView]) -> Result<()> {
    let mut ids = HashSet::with_capacity(views.len());
    for view in views {
        view.validate()?;
        if !ids.insert(view.id.as_str()) {
            return Err("duplicate Mission calendar ID".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
