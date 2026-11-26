//! Unified native Mission schedule reads, capability probes and guarded
//! control/receipt reconciliation.
use super::lifecycle::request_id;
use crate::{
    Receiver,
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const SCHEDULE_PAGE_LIMIT: u8 = 8;
const MAX_REV: u64 = (1 << 53) - 1;
const CTRL_TIMEOUT: Duration = Duration::from_secs(105);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BYTES: usize = 4 * 1024 * 1024;

pub fn valid_schedule_id(v: &str) -> bool {
    (3..=100).contains(&v.len()) && v.bytes().all(id_byte)
}
pub fn valid_schedule_request_id(v: &str) -> bool {
    (1..=128).contains(&v.len()) && v.bytes().all(id_byte)
}
fn id_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}
fn valid_dir(d: &str) -> bool {
    !d.is_empty() && d.len() <= 4096 && !d.contains('\0')
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleState {
    Paused,
    Running,
    Stopped,
    Finished,
}
impl ScheduleState {
    pub const fn i18n_key(self) -> &'static str {
        match self {
            Self::Paused => "missions.scheduleList.state.paused",
            Self::Running => "missions.scheduleList.state.running",
            Self::Stopped => "missions.scheduleList.state.stopped",
            Self::Finished => "missions.scheduleList.state.finished",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduleAction {
    Play,
    Pause,
    Resume,
    Stop,
    Check,
    RunNow,
    Configure,
    Delete,
}
impl ScheduleAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Play => "play",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Stop => "stop",
            Self::Check => "check",
            Self::RunNow => "run-now",
            Self::Configure => "configure",
            Self::Delete => "delete",
        }
    }
    pub const fn requires_calendar_check(self) -> bool {
        matches!(self, Self::Play | Self::Resume | Self::RunNow)
    }
    pub const fn requires_confirmation(self) -> bool {
        matches!(self, Self::Stop | Self::Delete | Self::RunNow)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ScheduleObservation {
    pub state: String,
    pub native_status: Option<String>,
    pub next_due_at: Option<u64>,
    pub kind: String,
}
impl ScheduleObservation {
    pub fn observed_key(&self) -> &'static str {
        match (self.state.as_str(), self.native_status.as_deref()) {
            ("known", Some("active")) => "missions.scheduleList.observed.active",
            ("known", Some("paused")) => "missions.scheduleList.observed.paused",
            ("known", Some("done")) => "missions.scheduleList.observed.done",
            ("known", Some("mixed")) => "missions.scheduleList.observed.mixed",
            ("unarmed", _) => "missions.scheduleList.observed.unarmed",
            _ => "missions.scheduleList.observed.unknown",
        }
    }
    pub fn is_check(&self) -> bool {
        self.kind == "check"
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleChecks {
    pub count: u64,
    pub since: u64,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SchedulePendingPassage {
    #[serde(rename = "coordinatorSessionID")]
    pub coordinator_session_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePassageReceipt {
    pub id: String,
    #[serde(rename = "coordinatorSessionID")]
    pub coordinator_session_id: String,
    pub due_at: u64,
    pub outcome: String,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleControlState {
    #[serde(rename = "requestID")]
    pub request_id: String,
    pub expected_revision: u64,
    pub action: String,
    pub pending: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDeletionReceipt {
    pub id: String,
    #[serde(rename = "requestID")]
    pub request_id: String,
    pub expected_revision: u64,
    pub delete_managed_sessions: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LaunchItem {
    Now,
    Cron(String, String),
    At(u64, String),
    In(u64),
    Every(u64),
    Condition(String, String, String),
}
impl LaunchItem {
    pub fn is_schedule(&self) -> bool {
        !matches!(self, Self::Condition(..))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchPolicy {
    pub items: Vec<LaunchItem>,
    pub requires_calendar: bool,
    pub launch_limit: Option<u64>,
    pub has_events: bool,
    pub until: Option<u64>,
    pub end_after_ms: Option<u64>,
}
impl LaunchPolicy {
    pub fn from_value(raw: &Value) -> std::result::Result<Self, String> {
        let (items, requires_calendar, launch_limit, until, end_after_ms) =
            if let Some(w) = raw["when"].as_array() {
                let items: Vec<_> = w
                    .iter()
                    .map(parse_crit)
                    .collect::<std::result::Result<_, _>>()?;
                let one_now = items.len() == 1 && matches!(items[0], LaunchItem::Now);
                let cal = !items.is_empty() && !one_now;
                (items, cal, (!cal).then_some(1), None, None)
            } else if let Some(k) = raw["timing"]["kind"].as_str() {
                let t = &raw["timing"];
                let mut items = match k {
                    "immediate" => Vec::new(),
                    "cron" => vec![parse_cron(t)?],
                    "at" => vec![LaunchItem::At(
                        t["at"].as_u64().ok_or("at")?,
                        t["zone"].as_str().ok_or("z")?.into(),
                    )],
                    "in" => vec![LaunchItem::In(t["delayMs"].as_u64().ok_or("delay")?)],
                    "every" => vec![LaunchItem::Every(t["intervalMs"].as_u64().ok_or("int")?)],
                    "multi" => t["calendars"]
                        .as_array()
                        .ok_or("cals")?
                        .iter()
                        .map(parse_cron)
                        .collect::<std::result::Result<Vec<_>, _>>()?,
                    _ => return Err("timing".into()),
                };
                if let Some(c) = raw.get("condition").filter(|v| !v.is_null()) {
                    items.push(parse_cond(c)?);
                }
                let cal = !items.is_empty();
                let repeats = matches!(k, "every" | "cron" | "multi");
                let lim = if !cal || !repeats {
                    Some(1)
                } else {
                    raw["ends"]["maxLaunches"].as_u64()
                };
                let until = raw["ends"]["at"].as_u64();
                let end_after_ms = raw["ends"]["afterMs"].as_u64();
                (items, cal, lim, until, end_after_ms)
            } else {
                return Err("launch".into());
            };
        let has_events = items.iter().any(|i| !i.is_schedule());
        Ok(Self {
            items,
            requires_calendar,
            launch_limit,
            has_events,
            until,
            end_after_ms,
        })
    }
    pub fn connected_items(&self) -> Vec<(Option<&'static str>, &LaunchItem)> {
        self.items
            .iter()
            .enumerate()
            .map(|(i, it)| {
                let c =
                    (i > 0).then(
                        || match (self.items[i - 1].is_schedule(), it.is_schedule()) {
                            (p, cur) if p == cur => "missions.scheduling.connector.or",
                            (_, true) => "missions.scheduling.connector.else",
                            _ => "missions.scheduling.connector.if",
                        },
                    );
                (c, it)
            })
            .collect()
    }
}
fn de_launch<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<LaunchPolicy, D::Error> {
    LaunchPolicy::from_value(&Value::deserialize(d)?).map_err(serde::de::Error::custom)
}
fn parse_cron(v: &Value) -> std::result::Result<LaunchItem, String> {
    Ok(LaunchItem::Cron(
        v["expression"].as_str().ok_or("expr")?.into(),
        v["zone"].as_str().ok_or("z")?.into(),
    ))
}
fn parse_crit(v: &Value) -> std::result::Result<LaunchItem, String> {
    match v["kind"].as_str().ok_or("kind")? {
        "now" => Ok(LaunchItem::Now),
        "cron" => parse_cron(v),
        _ => parse_cond(v),
    }
}
fn parse_cond(v: &Value) -> std::result::Result<LaunchItem, String> {
    fn strip(r: &str) -> &str {
        r.strip_prefix("refs/heads/").unwrap_or(r)
    }
    let kind = v["kind"].as_str().ok_or("kind")?.to_owned();
    let s = |k: &str| v[k].as_str().unwrap_or("");
    let mut key = format!("missions.scheduling.condition.{kind}");
    let detail = match kind.as_str() {
        "schedule-success" | "mission-completed" => s("missionID").into(),
        "branch-commits" => strip(s("ref")).into(),
        "remote-branch-commits" => {
            format!("{}/{} · {}", s("host"), s("repository"), strip(s("ref")))
        }
        "conversation-message" => s("conversationID").into(),
        "files-changed" => v["paths"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default(),
        "repository-activity" => {
            let g = if s("provider") == "gitlab" {
                "merge"
            } else {
                "pull"
            };
            key = format!("missions.scheduling.repository.{g}.{}", s("event"));
            format!("{}/{}", s("host"), s("repository"))
        }
        _ => s("repository").into(),
    };
    Ok(LaunchItem::Condition(kind, key, detail))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRoot {
    pub directory: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfiguration {
    pub title: String,
    pub objective: String,
    pub notes: Option<String>,
    #[serde(default)]
    pub roots: Vec<ScheduleRoot>,
    #[serde(deserialize_with = "de_launch")]
    pub launch: LaunchPolicy,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSchedule {
    pub id: String,
    pub kind: String,
    pub revision: u64,
    pub state: ScheduleState,
    pub first_played_at: Option<u64>,
    pub one_shot_at: Option<u64>,
    pub slot_ends_at: Option<u64>,
    #[serde(default)]
    pub launched_count: u64,
    #[serde(default)]
    pub successful_count: u64,
    pub checks: Option<ScheduleChecks>,
    pub configuration: ScheduleConfiguration,
    pub observation: ScheduleObservation,
    #[serde(default)]
    pub available_actions: Vec<ScheduleAction>,
    pub block_reason: Option<String>,
    pub pending_passage: Option<SchedulePendingPassage>,
    #[serde(default)]
    pub history: Vec<SchedulePassageReceipt>,
    pub control: Option<ScheduleControlState>,
}
impl UnifiedSchedule {
    pub fn is_schedule(&self) -> bool {
        self.kind == "schedule"
    }
    pub fn owns_directory(&self, dir: Option<&str>) -> bool {
        dir.is_some_and(|d| {
            self.configuration
                .roots
                .iter()
                .any(|r| crate::same_server_path(&r.directory, d))
        })
    }
    pub fn owns_session(&self, sid: &str) -> bool {
        self.pending_passage
            .as_ref()
            .is_some_and(|p| p.coordinator_session_id == sid)
            || self.history.iter().any(|h| h.coordinator_session_id == sid)
    }
    pub fn from_value(v: &Value) -> std::result::Result<Self, String> {
        let d: Self = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
        d.valid()
            .then_some(d)
            .ok_or_else(|| "invalid schedule".into())
    }
    fn valid(&self) -> bool {
        valid_schedule_id(&self.id)
            && self.revision <= MAX_REV
            && matches!(self.kind.as_str(), "schedule" | "one-time")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScheduleFetch<T> {
    Ready(T),
    AuthExpired,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleListPage {
    pub project_id: String,
    pub schedules: Vec<UnifiedSchedule>,
    pub next: Option<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScheduleCapability {
    pub api_available: bool,
    pub enabled: bool,
    pub activation_available: bool,
    pub activation_refused: bool,
}
impl ScheduleCapability {
    pub const fn ready(self) -> bool {
        self.api_available && self.enabled && self.activation_available && !self.activation_refused
    }
    pub const fn refused(self) -> bool {
        self.api_available && !self.activation_available && self.activation_refused
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRead {
    pub pending: bool,
    pub document: Option<UnifiedSchedule>,
    #[serde(default)]
    pub deleted: bool,
    pub deletion_receipt: Option<ScheduleDeletionReceipt>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScheduleReadOutcome {
    Ready(Box<ScheduleRead>),
    Pending(Option<(String, ScheduleControlState)>),
    AuthExpired,
    Unconfirmed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleControlRequest {
    pub action: ScheduleAction,
    #[serde(rename = "requestID")]
    pub request_id: String,
    pub expected_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_managed_sessions: Option<bool>,
}
impl ScheduleControlRequest {
    pub fn new(action: ScheduleAction, rev: u64, dir: Option<String>) -> Result<Self> {
        let req = Self {
            action,
            request_id: request_id()?,
            expected_revision: rev,
            directory: dir.filter(|d| valid_dir(d)),
            delete_managed_sessions: (action == ScheduleAction::Delete).then_some(false),
        };
        req.validate()?;
        Ok(req)
    }
    pub fn validate(&self) -> Result<()> {
        let ok = valid_schedule_request_id(&self.request_id)
            && self.expected_revision <= MAX_REV
            && !matches!(
                self.action,
                ScheduleAction::Configure | ScheduleAction::Check
            )
            && (self.action == ScheduleAction::Delete) == self.delete_managed_sessions.is_some()
            && self.delete_managed_sessions != Some(true)
            && self.directory.as_deref().is_none_or(valid_dir);
        ok.then_some(())
            .ok_or_else(|| "invalid schedule control".into())
    }
    pub fn matches_control(&self, c: &ScheduleControlState) -> bool {
        c.request_id == self.request_id
            && c.expected_revision == self.expected_revision
            && c.action == self.action.as_str()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScheduleControlOutcome {
    Settled(Option<u64>),
    Pending(bool),
    Refused,
    AuthExpired,
    Unconfirmed,
}

fn parse_partial(st: StatusCode, b: &Value) -> Option<(String, ScheduleControlState)> {
    if st != StatusCode::SERVICE_UNAVAILABLE
        || b["code"] != "schedule-pending"
        || b["pending"] != true
    {
        return None;
    }
    let id = b["document"]["id"]
        .as_str()
        .filter(|s| valid_schedule_id(s))?;
    let c: ScheduleControlState = serde_json::from_value(b["document"]["control"].clone()).ok()?;
    let known = "create configure play pause resume stop check run-now delete reconcile"
        .split(' ')
        .any(|a| a == c.action);
    (valid_schedule_request_id(&c.request_id) && c.expected_revision <= MAX_REV && known)
        .then(|| (id.into(), c))
}

pub fn classify_schedule_control_read(
    mid: &str,
    req: &ScheduleControlRequest,
    read: &ScheduleRead,
) -> ScheduleControlOutcome {
    if !read.pending {
        if req.action == ScheduleAction::Delete {
            if read.deleted
                && read.deletion_receipt.as_ref().is_some_and(|r| {
                    r.id == mid
                        && r.request_id == req.request_id
                        && r.expected_revision == req.expected_revision
                        && !r.delete_managed_sessions
                })
            {
                return ScheduleControlOutcome::Settled(None);
            }
        } else if let Some(d) = &read.document
            && d.id == mid
            && d.revision >= req.expected_revision
            && d.control
                .as_ref()
                .is_some_and(|c| req.matches_control(c) && !c.pending)
        {
            return ScheduleControlOutcome::Settled(Some(d.revision));
        }
    }
    let p = read.pending
        && read.document.as_ref().is_some_and(|d| {
            d.id == mid && d.control.as_ref().is_some_and(|c| req.matches_control(c))
        });
    ScheduleControlOutcome::Pending(p)
}

fn classify_control(
    st: StatusCode,
    b: &Value,
    mid: &str,
    req: &ScheduleControlRequest,
) -> ScheduleControlOutcome {
    use ScheduleControlOutcome as O;
    if st == StatusCode::UNAUTHORIZED {
        return O::AuthExpired;
    }
    let r = &b["refusal"];
    if st == StatusCode::CONFLICT
        && b["code"] == "schedule-refused"
        && b["pending"] == false
        && r["missionID"].as_str() == Some(mid)
        && r["requestID"].as_str() == Some(req.request_id.as_str())
        && r["expectedRevision"].as_u64() == Some(req.expected_revision)
        && r["action"].as_str() == Some(req.action.as_str())
    {
        return O::Refused;
    }
    if let Some((id, c)) = parse_partial(st, b) {
        return O::Pending(id == mid && req.matches_control(&c));
    }
    if st.is_success()
        && let Ok(read) = parse_read(b)
    {
        return classify_schedule_control_read(mid, req, &read);
    }
    O::Unconfirmed
}

fn parse_list(b: &Value) -> std::result::Result<ScheduleListPage, String> {
    if b["version"].as_u64() != Some(1) {
        return Err("version".into());
    }
    let project_id = b["projectID"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("projectID")?
        .into();
    let schedules: Vec<UnifiedSchedule> =
        serde_json::from_value(b["schedules"].clone()).map_err(|e| e.to_string())?;
    let next = match b.get("next") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_str()
                .filter(|s| valid_schedule_id(s))
                .ok_or("next")?
                .into(),
        ),
    };
    if schedules.len() > SCHEDULE_PAGE_LIMIT as usize
        || !schedules.iter().all(UnifiedSchedule::valid)
    {
        return Err("list".into());
    }
    Ok(ScheduleListPage {
        project_id,
        schedules,
        next,
    })
}
fn parse_read(b: &Value) -> std::result::Result<ScheduleRead, String> {
    if b.get("document").is_none() {
        return Err("doc".into());
    }
    let r: ScheduleRead = serde_json::from_value(b.clone()).map_err(|e| e.to_string())?;
    r.document
        .as_ref()
        .is_none_or(UnifiedSchedule::valid)
        .then_some(r)
        .ok_or_else(|| "doc".into())
}
fn parse_cap(b: &Value) -> std::result::Result<ScheduleCapability, String> {
    let act = &b["activation"];
    Ok(ScheduleCapability {
        api_available: b["api"]["available"].as_bool().ok_or("api")?,
        enabled: b["enabled"].as_bool().ok_or("enabled")?,
        activation_available: act["available"].as_bool().ok_or("activation")?,
        activation_refused: act["refusal"].is_object()
            || act["code"].as_str() == Some("schedule-activation-refused"),
    })
}

async fn race_cancel<U>(
    cancel: Option<&Receiver<()>>,
    fut: impl std::future::Future<Output = U>,
) -> Option<U> {
    match cancel {
        Some(c) => {
            futures_lite::future::race(async { Some(fut.await) }, async {
                let _ = c.recv().await;
                None
            })
            .await
        }
        None => Some(fut.await),
    }
}

impl Backend {
    async fn send_sched(
        &self,
        segs: &[&str],
        q: &[(&str, Option<&str>)],
        body: Option<&impl Serialize>,
        timeout: Duration,
        cancel: Option<&Receiver<()>>,
    ) -> Option<(StatusCode, Option<Value>)> {
        valid_id(&self.workspace).then_some(())?;
        let mut url = Url::parse(&self.base)
            .and_then(|u| u.join("api/workspaces/"))
            .ok()?;
        {
            let mut p = url.path_segments_mut().ok()?;
            p.pop_if_empty();
            p.push(&self.workspace);
            p.extend(segs.iter().copied());
        }
        {
            let mut qp = url.query_pairs_mut();
            for &(k, v) in q {
                if let Some(val) = v {
                    qp.append_pair(k, val);
                }
            }
        }
        let req = match body {
            Some(b) => self.client.post(url).timeout(timeout).json(b),
            None => self.client.get(url).timeout(timeout),
        };
        let resp = race_cancel(cancel, req.send()).await?.ok()?;
        let st = resp.status();
        if st == StatusCode::UNAUTHORIZED {
            return Some((st, None));
        }
        let json = race_cancel(cancel, read_json_limited(resp, MAX_BYTES))
            .await?
            .ok();
        Some((st, json))
    }
    async fn fetch_get<T>(
        &self,
        segs: &[&str],
        q: &[(&str, Option<&str>)],
        c: &Receiver<()>,
        parse: fn(&Value) -> std::result::Result<T, String>,
    ) -> ScheduleFetch<T> {
        match self
            .send_sched(segs, q, None::<&()>, READ_TIMEOUT, Some(c))
            .await
        {
            Some((StatusCode::UNAUTHORIZED, _)) => ScheduleFetch::AuthExpired,
            Some((s, Some(b))) if s.is_success() => {
                parse(&b).map_or(ScheduleFetch::Unavailable, ScheduleFetch::Ready)
            }
            _ => ScheduleFetch::Unavailable,
        }
    }

    pub async fn mission_schedules_page(
        &self,
        after: Option<&str>,
        limit: u8,
        dir: Option<&str>,
        c: &Receiver<()>,
    ) -> ScheduleFetch<ScheduleListPage> {
        if !(1..=SCHEDULE_PAGE_LIMIT).contains(&limit)
            || after.is_some_and(|a| !valid_schedule_id(a))
            || dir.is_some_and(|d| !valid_dir(d))
        {
            return ScheduleFetch::Unavailable;
        }
        let lim = limit.to_string();
        self.fetch_get(
            &["missions", "scheduled"],
            &[
                ("limit", Some(lim.as_str())),
                ("after", after),
                ("directory", dir),
            ],
            c,
            parse_list,
        )
        .await
    }
    pub async fn mission_schedule_capability(
        &self,
        dir: Option<&str>,
        c: &Receiver<()>,
    ) -> ScheduleFetch<ScheduleCapability> {
        if dir.is_some_and(|d| !valid_dir(d)) {
            return ScheduleFetch::Unavailable;
        }
        self.fetch_get(
            &["missions", "scheduled", "capabilities"],
            &[("directory", dir)],
            c,
            parse_cap,
        )
        .await
    }
    pub async fn mission_schedule_read(
        &self,
        mid: &str,
        dir: Option<&str>,
        req_id: Option<&str>,
        c: &Receiver<()>,
    ) -> ScheduleReadOutcome {
        use ScheduleReadOutcome as R;
        if !valid_schedule_id(mid)
            || dir.is_some_and(|d| !valid_dir(d))
            || req_id.is_some_and(|r| !valid_schedule_request_id(r))
        {
            return R::Unconfirmed;
        }
        let q = [("directory", dir), ("requestID", req_id)];
        let Some((s, b)) = self
            .send_sched(
                &["missions", mid, "schedule"],
                &q,
                None::<&()>,
                READ_TIMEOUT,
                Some(c),
            )
            .await
        else {
            return R::Unconfirmed;
        };
        if s == StatusCode::UNAUTHORIZED {
            return R::AuthExpired;
        }
        let Some(b) = b else { return R::Unconfirmed };
        if let Some(p) = parse_partial(s, &b) {
            return R::Pending(Some(p));
        }
        if s == StatusCode::SERVICE_UNAVAILABLE && b["code"] == "schedule-pending" {
            return R::Pending(None);
        }
        if s.is_success()
            && let Ok(read) = parse_read(&b)
            && read.document.as_ref().is_none_or(|d| d.id == mid)
        {
            return R::Ready(Box::new(read));
        }
        R::Unconfirmed
    }
    pub async fn control_mission_schedule(
        &self,
        mid: &str,
        req: &ScheduleControlRequest,
    ) -> ScheduleControlOutcome {
        if !valid_schedule_id(mid) || req.validate().is_err() {
            return ScheduleControlOutcome::Unconfirmed;
        }
        match self
            .send_sched(
                &["missions", mid, "schedule"],
                &[],
                Some(req),
                CTRL_TIMEOUT,
                None,
            )
            .await
        {
            Some((StatusCode::UNAUTHORIZED, _)) => ScheduleControlOutcome::AuthExpired,
            Some((s, Some(b))) => classify_control(s, &b, mid, req),
            _ => ScheduleControlOutcome::Unconfirmed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ScheduleControlOutcome as O;
    use StatusCode as S;

    fn js(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }
    fn sample(id: &str, rev: u64, control: &str) -> Value {
        js(&format!(
            r#"{{"id":"{id}","kind":"schedule","revision":{rev},"state":"paused","firstPlayedAt":1700000000000,"oneShotAt":null,"slotEndsAt":null,"launchedCount":2,"successfulCount":1,"checks":null,"configuration":{{"title":"Nightly audit","objective":"Audit changes","notes":"Server crates","roots":[{{"mode":"directory-only","directory":"/owned"}}],"launch":{{"when":[{{"kind":"cron","expression":"0 9 * * *","zone":"UTC"}},{{"kind":"files-changed","paths":["src/main.rs"]}},{{"kind":"cron","expression":"0 18 * * *","zone":"UTC"}}]}}}},"observation":{{"state":"known","nativeStatus":"paused","nextDueAt":1700003600000,"kind":"check"}},"availableActions":["resume","stop","run-now","delete","configure"],"blockReason":null,"pendingPassage":null,"history":[{{"id":"psg_1","coordinatorSessionID":"ses_c1","dueAt":1700000000000,"outcome":"completed"}}],"control":{control}}}"#
        ))
    }

    #[test]
    fn parses_list_connectors_and_receipts() {
        let mut list = js(r#"{"version":1,"projectID":"p1","schedules":[],"next":"msn_s2"}"#);
        list["schedules"] = Value::Array(vec![sample("msn_s1", 4, "null")]);
        let page = parse_list(&list).unwrap();
        let d = &page.schedules[0];
        let l = &d.configuration.launch;
        assert_eq!(
            (&*page.project_id, page.next.as_deref()),
            ("p1", Some("msn_s2"))
        );
        assert!(
            d.is_schedule()
                && l.requires_calendar
                && l.has_events
                && d.owns_directory(Some("/owned"))
                && !d.owns_directory(Some("/other"))
                && !d.owns_directory(None)
                && d.owns_session("ses_c1")
                && !d.owns_session("ses_x")
        );
        let cs: Vec<_> = l.connected_items().into_iter().map(|(c, _)| c).collect();
        assert_eq!(
            cs,
            [
                None,
                Some("missions.scheduling.connector.if"),
                Some("missions.scheduling.connector.else")
            ]
        );
        let now = LaunchPolicy::from_value(&js(r#"{"when":[{"kind":"now"}]}"#)).unwrap();
        let leg = LaunchPolicy::from_value(&js(r#"{"timing":{"kind":"every","intervalMs":3600000},"condition":{"kind":"branch-commits","directory":"/r","ref":"refs/heads/main"},"ends":{"at":1800000000000,"afterMs":600000,"maxLaunches":5}}"#)).unwrap();
        let leg_cs: Vec<_> = leg.connected_items().into_iter().map(|(c, _)| c).collect();
        let pure_ev = LaunchPolicy::from_value(&js(r#"{"timing":{"kind":"every","intervalMs":3600000},"condition":null,"ends":{"at":null,"afterMs":null,"maxLaunches":null}}"#)).unwrap();
        let multi = LaunchPolicy::from_value(&js(r#"{"timing":{"kind":"multi","calendars":[{"expression":"0 9 * * *","zone":"UTC"},{"expression":"0 18 * * *","zone":"UTC"}]},"condition":null,"ends":{"at":null,"afterMs":null,"maxLaunches":null}}"#)).unwrap();
        assert!(
            !now.requires_calendar
                && now.launch_limit == Some(1)
                && leg.requires_calendar
                && leg.has_events
                && leg_cs == [None, Some("missions.scheduling.connector.if")]
                && leg.launch_limit == Some(5)
                && leg.until == Some(1800000000000)
                && leg.end_after_ms == Some(600000)
                && !pure_ev.has_events
                && multi.items.len() == 2
                && !multi.has_events
        );
        let masked_cap = parse_cap(&js(r#"{"api":{"available":true},"enabled":true,"activation":{"available":false,"reason":"forbidden","code":"schedule-activation-refused","refusal":{"reason":"masked"}}}"#)).unwrap();
        let ready_cap = parse_cap(&js(r#"{"api":{"available":true},"enabled":true,"activation":{"available":true,"targets":[]}}"#)).unwrap();
        assert!(
            !masked_cap.ready()
                && masked_cap.refused()
                && ready_cap.ready()
                && !ready_cap.refused()
        );
        list["schedules"] = Value::Array(
            (0..9)
                .map(|i| sample(&format!("msn_s{i}"), 1, "null"))
                .collect(),
        );
        assert!(
            parse_list(&list).is_err()
                && parse_list(&js(r#"{"version":2,"projectID":"p","schedules":[]}"#)).is_err()
        );

        let mk = |action, id: &str, rev, del| ScheduleControlRequest {
            action,
            request_id: id.into(),
            expected_revision: rev,
            directory: None,
            delete_managed_sessions: del,
        };
        let req = mk(ScheduleAction::Pause, "req_1", 4, None);
        let c = |st, v: &Value, r: &ScheduleControlRequest| classify_control(st, v, "msn_s1", r);
        let ok = serde_json::json!({"pending":false,"document":sample("msn_s1",5,r#"{"requestID":"req_1","expectedRevision":4,"action":"pause","pending":false}"#)});
        let oth = serde_json::json!({"pending":false,"document":sample("msn_s1",5,r#"{"requestID":"other","expectedRevision":4,"action":"pause","pending":false}"#)});
        let part = js(
            r#"{"code":"schedule-pending","pending":true,"document":{"id":"msn_s1","control":{"requestID":"req_1","expectedRevision":4,"action":"pause","pending":true}}}"#,
        );
        let r_ok = js(
            r#"{"code":"schedule-refused","pending":false,"refusal":{"missionID":"msn_s1","requestID":"req_1","expectedRevision":4,"action":"pause"}}"#,
        );
        let r_no = js(
            r#"{"code":"schedule-refused","pending":false,"refusal":{"missionID":"msn_x","requestID":"req_1","expectedRevision":4,"action":"pause"}}"#,
        );
        assert_eq!(c(S::OK, &ok, &req), O::Settled(Some(5)));
        assert_eq!(c(S::OK, &oth, &req), O::Pending(false));
        assert_eq!(c(S::SERVICE_UNAVAILABLE, &part, &req), O::Pending(true));
        assert_eq!(c(S::CONFLICT, &r_ok, &req), O::Refused);
        assert_eq!(c(S::CONFLICT, &r_no, &req), O::Unconfirmed);
        assert_eq!(c(S::UNAUTHORIZED, &js("{}"), &req), O::AuthExpired);

        let del = mk(ScheduleAction::Delete, "req_d", 5, Some(false));
        let mut tomb = js(
            r#"{"pending":false,"document":null,"deleted":true,"deletionReceipt":{"id":"msn_s1","requestID":"req_d","expectedRevision":5,"deleteManagedSessions":false}}"#,
        );
        assert_eq!(c(S::OK, &tomb, &del), O::Settled(None));
        tomb["deletionReceipt"]["deleteManagedSessions"] = Value::Bool(true);
        assert_eq!(c(S::OK, &tomb, &del), O::Pending(false));
    }
}
