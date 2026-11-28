//! OpenCode Automations adapter and launch-criteria mapping for programmed Missions.
//! Mirrors TS `missions/calendar-automation.ts`, `missions/calendar-run.ts` (constants)
//! and `opencode/mission-calendars.ts`.
use super::{configuration, creation_admission::Scope, run};
use crate::App;
use axum::http::{Method, StatusCode as Status};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// Events have no clock of their own: their calendar polls on this interval.
pub(super) const MISSION_CALENDAR_EVENT_INTERVAL: &str = "15 minutes";
pub(super) const MISSION_CALENDAR_CODE: &str =
    "return { state: { last: await tools.codenomad.mission_calendar_run(args) } }";
pub(super) const MISSION_CALENDAR_CARRIER: &str = "codenomad.mission-calendar";
const CARRIER_TITLE: &str = "Mission calendars";
const MISSION_CALENDAR_HISTORY_MAX: usize = 20;
const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

pub(super) fn carrier_permissions() -> Value {
    json!([
        { "action": "execute", "resource": "*", "effect": "allow" },
        { "action": "codenomad_mission_calendar_run", "resource": "*", "effect": "allow" },
    ])
}

/// `missionCalendarIDSchema`: `/^[A-Za-z0-9_-]{3,100}$/`.
pub(super) fn valid_calendar_id(id: &str) -> bool {
    (3..=100).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn safe_path_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 240
        && id != "."
        && id != ".."
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// Reserved carrier session ID for a `(projectID, directory)` location.
pub(super) fn carrier_session_id(project_id: &str, directory: &str) -> String {
    format!("ses_cn_schedule_calendar_{}", run::token(&format!("{project_id}\0{directory}"), 24))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unsupported {
    OneTime,
    FallbackSchedule,
    Ending,
    Event,
    FollowedConversations,
}

impl Unsupported {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::OneTime => "one-time",
            Self::FallbackSchedule => "fallback-schedule",
            Self::Ending => "ending",
            Self::Event => "event",
            Self::FollowedConversations => "followed-conversations",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct CalendarAutomation {
    pub name: String,
    pub trigger: Value,
    pub action: Value,
}

/// Maps a normalized `MissionConfiguration` into the native OpenCode Automations
/// that carry it under one calendar identity, or names why it cannot be carried.
pub(super) fn mission_calendar_automations(
    configuration: &Value,
    calendar: &str,
    prepared: Option<&str>,
) -> Result<Vec<CalendarAutomation>, Unsupported> {
    let model = configuration::launch_model_full(&configuration["launch"]);
    if (model.schedules.is_empty() && model.events.is_empty())
        || model.schedules.iter().any(|item| !matches!(item["kind"].as_str(), Some("cron" | "every")))
    {
        return Err(Unsupported::OneTime);
    }
    if model.plans.iter().any(|plan| plan.fallback) {
        return Err(Unsupported::FallbackSchedule);
    }
    if model.until.is_some() || model.end_after_ms.is_some() || model.max_launches.is_some() {
        return Err(Unsupported::Ending);
    }
    if configuration["watchedConversationIDs"].as_array().is_some_and(|ids| !ids.is_empty()) {
        return Err(Unsupported::FollowedConversations);
    }
    if model.events.len() > 8
        || model.events.iter().any(|event| {
            matches!(
                event["kind"].as_str(),
                Some("schedule-success" | "mission-completed" | "conversation-message")
            )
        })
    {
        return Err(Unsupported::Event);
    }
    let title = configuration["title"].as_str().unwrap_or_default().to_owned();
    let build = |trigger: Value, events: &[Value]| -> CalendarAutomation {
        let mut args = Map::new();
        args.insert("calendar".into(), json!(calendar));
        for key in [
            "title",
            "objective",
            "notes",
            "template",
            "taskMode",
            "profiles",
            "coordinatorGoal",
            "coordinatorSessionID",
        ] {
            if let Some(value) = configuration.get(key).filter(|v| !v.is_null()) {
                args.insert(key.into(), value.clone());
            }
        }
        if !events.is_empty() {
            args.insert("when".into(), Value::Array(events.to_vec()));
        }
        args.insert("launch".into(), configuration["launch"].clone());
        if let Some(mid) = prepared {
            args.insert("prepared".into(), json!(mid));
        }
        CalendarAutomation {
            name: title.clone(),
            trigger,
            action: json!({
                "type": "code",
                "code": MISSION_CALENDAR_CODE,
                "args": Value::Object(args),
            }),
        }
    };
    if model.schedules.is_empty() {
        return Ok(vec![build(
            json!({ "type": "every", "every": MISSION_CALENDAR_EVENT_INTERVAL }),
            &model.triggers,
        )]);
    }
    let mut out = Vec::with_capacity(model.schedules.len());
    for (schedule, plan) in model.schedules.iter().zip(model.plans.iter()) {
        let trigger = if schedule["kind"] == "cron" {
            json!({ "type": "cron", "cron": schedule["expression"], "tz": schedule["zone"] })
        } else {
            let ms = schedule["intervalMs"].as_u64().unwrap_or(0);
            json!({ "type": "every", "every": format!("{ms} millis") })
        };
        out.push(build(trigger, &plan.conditions));
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub(super) struct CalendarLast {
    pub outcome: String,
    pub mission_id: Option<String>,
    pub status: Option<String>,
    pub coordinator_session_id: Option<String>,
    pub history: Vec<(i64, String)>,
    pub launches: u64,
    pub at: Value,
}

impl CalendarLast {
    pub(super) fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("outcome".into(), json!(self.outcome));
        if let Some(mid) = &self.mission_id {
            out.insert("missionID".into(), json!(mid));
        }
        if let Some(status) = &self.status {
            out.insert("status".into(), json!(status));
        }
        if let Some(sid) = &self.coordinator_session_id {
            out.insert("coordinatorSessionID".into(), json!(sid));
        }
        out.insert(
            "history".into(),
            Value::Array(self.history.iter().map(|(at, outcome)| json!({ "at": at, "outcome": outcome })).collect()),
        );
        out.insert("launches".into(), json!(self.launches));
        out.insert("at".into(), self.at.clone());
        Value::Object(out)
    }
}

#[derive(Debug, Clone)]
pub(super) struct CalendarView {
    pub id: String,
    pub title: String,
    pub paused: bool,
    pub mission_id: Option<String>,
    pub launch: Option<Value>,
    pub mission: Map<String, Value>,
    pub rules: Vec<Value>,
    pub last: Option<CalendarLast>,
}

impl CalendarView {
    pub(super) fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("title".into(), json!(self.title));
        out.insert("paused".into(), json!(self.paused));
        if let Some(mid) = &self.mission_id {
            out.insert("missionID".into(), json!(mid));
        }
        if let Some(launch) = &self.launch {
            out.insert("launch".into(), launch.clone());
        }
        out.insert("mission".into(), Value::Object(self.mission.clone()));
        out.insert("rules".into(), Value::Array(self.rules.clone()));
        if let Some(last) = &self.last {
            out.insert("last".into(), last.to_json());
        }
        Value::Object(out)
    }
}

#[derive(Debug)]
pub(super) enum NativeError {
    Missing,
    Unavailable,
}

fn text240(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    (!s.is_empty() && s.encode_utf16().count() <= 240).then(|| s.to_owned())
}

fn safe_i64(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    if let Some(i) = v.as_i64() {
        return (-MAX_SAFE_INT..=MAX_SAFE_INT).contains(&i).then_some(i);
    }
    if let Some(u) = v.as_u64() {
        return (u <= MAX_SAFE_INT as u64).then_some(u as i64);
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INT as f64).then_some(f as i64)
}

fn parse_last(info: &Value) -> Option<(CalendarLast, f64)> {
    let at_val = info.get("lastRunAt")?;
    let at_num = at_val.as_f64().filter(|n| n.is_finite())?;
    let text = info.get("state")?.get("last")?.as_str()?;
    let parsed: Value = serde_json::from_str(text).ok()?;
    let obj = parsed.as_object()?;
    let outcome = obj.get("outcome")?.as_str()?;
    if !matches!(outcome, "launched" | "waiting" | "idle" | "unread") {
        return None;
    }
    let mut history: Vec<(i64, String)> = obj
        .get("history")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let row = item.as_object()?;
                    let at = safe_i64(row.get("at"))?;
                    let outcome = text240(row.get("outcome"))?;
                    Some((at, outcome))
                })
                .collect()
        })
        .unwrap_or_default();
    if history.len() > MISSION_CALENDAR_HISTORY_MAX {
        history = history.split_off(history.len() - MISSION_CALENDAR_HISTORY_MAX);
    }
    let launches = safe_i64(obj.get("launches"))
        .filter(|&n| n >= 0)
        .map(|n| n as u64)
        .unwrap_or(history.len() as u64);
    Some((
        CalendarLast {
            outcome: outcome.to_owned(),
            mission_id: text240(obj.get("missionID")),
            status: text240(obj.get("status")),
            coordinator_session_id: text240(obj.get("coordinatorSessionID")),
            history,
            launches,
            at: at_val.clone(),
        },
        at_num,
    ))
}

fn calendar_of(info: &Value) -> String {
    info.get("action")
        .and_then(|a| a.get("args"))
        .and_then(|a| a.get("calendar"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| info["id"].as_str().unwrap_or_default().to_owned())
}

pub(super) struct NativeCalendars<'a> {
    app: &'a App,
    scope: &'a Scope,
    pub carrier: String,
}

impl<'a> NativeCalendars<'a> {
    pub(super) fn new(app: &'a App, scope: &'a Scope) -> Self {
        let carrier = carrier_session_id(&scope.project, &scope.dir);
        Self { app, scope, carrier }
    }

    async fn own(&self) -> Result<Vec<Value>, NativeError> {
        let (status, body) = self
            .scope
            .request(
                self.app,
                Method::GET,
                "/api/experimental/automation",
                &[("location[directory]", self.scope.dir.as_str()), ("sessionID", self.carrier.as_str())],
                None,
                15,
                2 * 1024 * 1024,
            )
            .await
            .map_err(|_| NativeError::Unavailable)?;
        if status == Status::NOT_FOUND && body["_tag"] == "SessionNotFoundError" {
            return Ok(Vec::new());
        }
        if !status.is_success() {
            return Err(NativeError::Unavailable);
        }
        let rows = body.get("data").and_then(Value::as_array).ok_or(NativeError::Unavailable)?;
        Ok(rows
            .iter()
            .filter(|info| {
                info["sessionID"].as_str() == Some(self.carrier.as_str())
                    && info["action"]["type"] == "code"
                    && info["action"]["code"] == MISSION_CALENDAR_CODE
            })
            .cloned()
            .collect())
    }

    async fn members(&self, calendar: &str) -> Result<Vec<Value>, NativeError> {
        let found: Vec<Value> = self.own().await?.into_iter().filter(|info| calendar_of(info) == calendar).collect();
        if found.is_empty() {
            return Err(NativeError::Missing);
        }
        Ok(found)
    }

    async fn ensure_carrier(&self) -> Result<(), NativeError> {
        let existing = self
            .scope
            .request(
                self.app,
                Method::GET,
                &format!("/api/session/{}", self.carrier),
                &[("location[directory]", self.scope.dir.as_str())],
                None,
                10,
                1024 * 1024,
            )
            .await;
        if let Ok((status, body)) = existing
            && status.is_success()
        {
            let row = body.get("data").unwrap_or(&body);
            let marked = row["metadata"]
                .get(MISSION_CALENDAR_CARRIER)
                .is_some_and(|v| !v.is_null() && *v != Value::Bool(false));
            let same_dir = row["location"]["directory"].as_str() == Some(self.scope.dir.as_str());
            if !marked || !same_dir {
                return Err(NativeError::Unavailable);
            }
            return Ok(());
        }
        let body = json!({
            "id": self.carrier,
            "title": CARRIER_TITLE,
            "location": { "directory": self.scope.dir },
            "metadata": { MISSION_CALENDAR_CARRIER: { "version": 1 } },
            "permissions": carrier_permissions(),
        });
        let (status, _) = self
            .scope
            .request(
                self.app,
                Method::POST,
                "/api/session",
                &[("location[directory]", self.scope.dir.as_str())],
                Some(&body),
                15,
                256 * 1024,
            )
            .await
            .map_err(|_| NativeError::Unavailable)?;
        if !status.is_success() {
            return Err(NativeError::Unavailable);
        }
        Ok(())
    }

    async fn create_automation(&self, automation: &CalendarAutomation) -> Result<String, NativeError> {
        let payload = json!({
            "sessionID": self.carrier,
            "directory": self.scope.dir,
            "name": automation.name,
            "trigger": automation.trigger,
            "action": automation.action,
        });
        let (status, body) = self
            .scope
            .request(
                self.app,
                Method::POST,
                "/api/experimental/automation",
                &[("location[directory]", self.scope.dir.as_str())],
                Some(&payload),
                15,
                512 * 1024,
            )
            .await
            .map_err(|_| NativeError::Unavailable)?;
        if !status.is_success() {
            return Err(NativeError::Unavailable);
        }
        let row = body.get("data").unwrap_or(&body);
        row["id"].as_str().filter(|id| safe_path_id(id)).map(str::to_owned).ok_or(NativeError::Unavailable)
    }

    async fn mutate_automation(&self, id: &str, action: Option<&str>) -> Result<(), NativeError> {
        if !safe_path_id(id) {
            return Err(NativeError::Unavailable);
        }
        let (method, path) = match action {
            Some(act) => (Method::POST, format!("/api/experimental/automation/{id}/{act}")),
            None => (Method::DELETE, format!("/api/experimental/automation/{id}")),
        };
        let (status, _) = self
            .scope
            .request(
                self.app,
                method,
                &path,
                &[("location[directory]", self.scope.dir.as_str())],
                None,
                15,
                256 * 1024,
            )
            .await
            .map_err(|_| NativeError::Unavailable)?;
        if !status.is_success() {
            return Err(NativeError::Unavailable);
        }
        Ok(())
    }

    pub(super) async fn delete_automation_best_effort(&self, id: &str) {
        let _ = self.mutate_automation(id, None).await;
    }

    pub(super) async fn list(&self) -> Result<Vec<CalendarView>, NativeError> {
        let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for info in self.own().await? {
            groups.entry(calendar_of(&info)).or_default().push(info);
        }
        let mut views = Vec::with_capacity(groups.len());
        for (id, infos) in groups {
            let first = &infos[0];
            let mut mission = first
                .get("action")
                .and_then(|a| a.get("args"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            mission.remove("calendar");
            let entered = mission.remove("launch");
            let prepared = mission.remove("prepared").and_then(|v| v.as_str().map(str::to_owned));
            let launch = entered.and_then(|v| configuration::launch(&v).ok());
            let mut latest: Option<(CalendarLast, f64)> = None;
            for info in &infos {
                if let Some((parsed, at)) = parse_last(info)
                    && latest.as_ref().is_none_or(|(_, best)| at > *best)
                {
                    latest = Some((parsed, at));
                }
            }
            let last = latest.map(|(l, _)| l);
            let mission_id = last
                .as_ref()
                .and_then(|l| l.mission_id.clone())
                .or(prepared)
                .filter(|s| !s.is_empty());
            let paused = infos.iter().all(|info| info["status"] != "active");
            let title = first["name"].as_str().unwrap_or_default().to_owned();
            let rules = infos
                .iter()
                .map(|info| {
                    let mut rule = Map::new();
                    rule.insert("automationID".into(), info["id"].clone());
                    rule.insert("trigger".into(), info["trigger"].clone());
                    rule.insert("tz".into(), info["tz"].clone());
                    rule.insert("runCount".into(), info["runCount"].clone());
                    if let Some(v) = info.get("nextDueAt").filter(|v| v.is_number()) {
                        rule.insert("nextDueAt".into(), v.clone());
                    }
                    if let Some(v) = info.get("lastRunAt").filter(|v| v.is_number()) {
                        rule.insert("lastRunAt".into(), v.clone());
                    }
                    if let Some(v) = info.get("lastOutcome").filter(|v| v.is_string()) {
                        rule.insert("lastOutcome".into(), v.clone());
                    }
                    if let Some(v) = info.get("lastOutput").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
                        rule.insert("lastOutput".into(), v.clone());
                    }
                    Value::Object(rule)
                })
                .collect();
            views.push(CalendarView { id, title, paused, mission_id, launch, mission, rules, last });
        }
        views.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then_with(|| a.title.cmp(&b.title))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(views)
    }

    pub(super) async fn save(
        &self,
        calendar: &str,
        automations: &[CalendarAutomation],
        paused: bool,
    ) -> Result<(), NativeError> {
        if !valid_calendar_id(calendar) || automations.is_empty() {
            return Err(NativeError::Unavailable);
        }
        self.ensure_carrier().await?;
        let previous: Vec<Value> = self.own().await?.into_iter().filter(|info| calendar_of(info) == calendar).collect();
        let mut created: Vec<String> = Vec::with_capacity(automations.len());
        for automation in automations {
            match self.create_automation(automation).await {
                Ok(id) => created.push(id),
                Err(err) => {
                    for id in &created {
                        self.delete_automation_best_effort(id).await;
                    }
                    return Err(err);
                }
            }
        }
        let should_pause =
            if !previous.is_empty() { previous.iter().all(|info| info["status"] != "active") } else { paused };
        if should_pause {
            for id in &created {
                if let Err(err) = self.mutate_automation(id, Some("pause")).await {
                    for rollback in &created {
                        self.delete_automation_best_effort(rollback).await;
                    }
                    return Err(err);
                }
            }
        }
        for info in &previous {
            let id = info["id"].as_str().ok_or(NativeError::Unavailable)?;
            self.mutate_automation(id, None).await?;
        }
        Ok(())
    }

    pub(super) async fn pause(&self, calendar: &str) -> Result<(), NativeError> {
        for info in self.members(calendar).await? {
            if info["status"] == "active" {
                let id = info["id"].as_str().ok_or(NativeError::Unavailable)?;
                self.mutate_automation(id, Some("pause")).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn resume(&self, calendar: &str) -> Result<(), NativeError> {
        for info in self.members(calendar).await? {
            if info["status"] == "paused" {
                let id = info["id"].as_str().ok_or(NativeError::Unavailable)?;
                self.mutate_automation(id, Some("resume")).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn delete(&self, calendar: &str) -> Result<(), NativeError> {
        for info in self.members(calendar).await? {
            let id = info["id"].as_str().ok_or(NativeError::Unavailable)?;
            self.mutate_automation(id, None).await?;
        }
        Ok(())
    }
}
