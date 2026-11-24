use super::{
    Attention, ControlReceipt, RunState, Status,
    codec::{RevisionChanged, decode_row},
    directory::{DirectoryChanged, PageRead, Source, Verified, digest_id, panel_id},
};
use crate::{backend::Backend, history::Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const SAFE: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Blocked,
    Ready,
    Dispatching,
    Queued,
    Completed,
    NeedsInput,
    Failed,
    Withdrawn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub key: String,
    pub title: String,
    pub status: TaskStatus,
    pub blocked_by: Vec<String>,
    pub order: u64,
    pub report_count: u64,
    role: String,
    created_at: u64,
    updated_at: u64,
    dependents: u64,
    outstanding_execution: bool,
    #[serde(default)]
    late_reports: Vec<Report>,
    late_report_count: Option<u64>,
    report: Option<Report>,
    #[serde(default)]
    bodies: HashMap<String, Body>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Report {
    id: String,
    task_key: String,
    session_id: String,
    outcome: Outcome,
    created_at: u64,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Completed,
    Blocked,
    Failed,
}

impl Report {
    fn valid(&self) -> bool {
        panel_id(&self.id)
            && panel_id(&self.session_id)
            && units(&self.task_key) <= 240
            && self.created_at <= SAFE
            && self
                .extra
                .get("excerpt")
                .is_none_or(|value| value.as_str().is_some_and(|text| units(text) <= 482))
            && self.extra.get("bodies").is_none_or(|value| {
                serde_json::from_value::<HashMap<String, Body>>(value.clone())
                    .is_ok_and(|bodies| valid_bodies(&bodies))
            })
            && !["summary", "evidence", "next", "artifact"]
                .iter()
                .any(|key| self.extra.contains_key(*key))
    }

    fn same_compact_report(&self, other: &Self) -> bool {
        self.task_key == other.task_key
            && self.session_id == other.session_id
            && self.outcome == other.outcome
            && self.created_at == other.created_at
            && [
                "delivery",
                "notificationStatus",
                "late",
                "decidedBy",
                "excerpt",
                "nativeCall",
            ]
            .iter()
            .all(|key| self.extra.get(*key) == other.extra.get(*key))
    }
}

#[derive(Debug, Deserialize)]
pub struct TaskPage {
    pub order: String,
    pub offset: u64,
    pub end: u64,
    pub total: u64,
    counts: HashMap<TaskStatus, u64>,
    reports: u64,
    pub attention: Option<Attention>,
}

impl TaskPage {
    fn valid(&self, offset: u64, named: bool) -> bool {
        let start = offset.min(self.total);
        digest_id(&self.order)
            && self.total <= SAFE
            && self.reports <= SAFE
            && self
                .counts
                .values()
                .try_fold(0u64, |sum, &value| sum.checked_add(value))
                == Some(self.total)
            && self.offset == start
            && self.end
                == if named {
                    0
                } else {
                    (start + 50).min(self.total)
                }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWindow {
    pub task_page: TaskPage,
    pub tasks: Vec<Task>,
    reports: Vec<Report>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub id: String,
    pub title: Option<String>,
    pub excerpt: String,
    pub status: Status,
    pub run_state: Option<RunState>,
    pub revision: u64,
    #[serde(rename = "projectID")]
    pub(super) project: String,
    pub(super) project_canonical: String,
    pub(super) coordinator_session_id: String,
    version: u8,
    #[serde(rename = "template")]
    _template: Template,
    created_at: f64,
    updated_at: f64,
    #[serde(rename = "historyTruncated")]
    _history_truncated: bool,
    bodies: HashMap<String, Body>,
    #[serde(flatten)]
    extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Template {
    Custom,
    Debug,
    Wayfinder,
    Delivery,
    Compare,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    characters: u64,
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Collection {
    characters: u64,
    digest: String,
    total: u64,
    array: bool,
    order: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSource {
    pub page: TaskPage,
    pub pins: Vec<String>,
    pub report_pins: Vec<String>,
    pub version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapHeader {
    pub root: Header,
    pub tasks: TaskSource,
    collections: HashMap<String, Collection>,
    pub(super) coordinator: Option<Value>,
    pub control: Option<ControlReceipt>,
}

pub struct DetailRead<T> {
    pub(super) read: PageRead,
    pub(super) decode: Box<dyn Fn(Verified) -> Result<T> + Send>,
}

impl<T> DetailRead<T> {
    pub async fn read_next(&mut self) -> Result<Option<T>> {
        let page = self.read.read_next().await?.map(&self.decode).transpose()?;
        self.read.live(page)
    }

    #[cfg(test)]
    pub(super) fn accept(&mut self, value: Value) -> Result<Option<T>> {
        self.read.accept(value)?.map(&self.decode).transpose()
    }
}

impl Backend {
    pub fn mission_header(&self, project: &str, mission: &str) -> Result<DetailRead<MapHeader>> {
        let read = PageRead::selected(
            self,
            project,
            Source::Mission,
            mission,
            json!({"source":"mission","missionID":mission,"header":true}),
        )?;
        let id = mission.to_owned();
        Ok(DetailRead {
            read,
            decode: Box::new(move |page| header(page, &id)),
        })
    }

    pub fn mission_task_window(
        &self,
        project: &str,
        header: &MapHeader,
        offset: u64,
    ) -> Result<DetailRead<TaskWindow>> {
        if offset > SAFE {
            return invalid();
        }
        task_read(self, project, header, offset, None, false)
    }

    pub fn mission_task_pins(
        &self,
        project: &str,
        header: &MapHeader,
    ) -> Result<DetailRead<TaskWindow>> {
        task_read(
            self,
            project,
            header,
            0,
            Some((&header.tasks.pins, &header.tasks.report_pins)),
            false,
        )
    }

    pub fn mission_task_attention(
        &self,
        project: &str,
        header: &MapHeader,
        offset: u64,
    ) -> Result<DetailRead<TaskWindow>> {
        if offset > SAFE
            || header
                .tasks
                .page
                .attention
                .as_ref()
                .is_none_or(|a| offset >= a.omitted)
        {
            return invalid();
        }
        task_read(self, project, header, offset, None, true)
    }
}

fn task_read(
    backend: &Backend,
    project: &str,
    header: &MapHeader,
    offset: u64,
    pins: Option<(&[String], &[String])>,
    attention: bool,
) -> Result<DetailRead<TaskWindow>> {
    let mission = &header.root.id;
    let order = header.tasks.page.order.clone();
    let revision = header.root.revision;
    let total = header.tasks.page.total;
    let reports = header.tasks.page.reports;
    let counts = header.tasks.page.counts.clone();
    let task = match pins {
        Some((ids, reports)) => {
            json!({"missionID":mission,"order":order,"ids":ids,"reportIds":reports})
        }
        None if attention => json!({"missionID":mission,"order":order,"attention":offset}),
        None => json!({"missionID":mission,"order":order,"offset":offset}),
    };
    let read = PageRead::selected(
        backend,
        project,
        Source::Tasks,
        mission,
        json!({"source":"tasks","task":task}),
    )?;
    let pins = pins.map(|(ids, reports)| (ids.to_vec(), reports.to_vec()));
    let base = header.tasks.page.attention.clone();
    let excluded = header.tasks.pins.clone();
    Ok(DetailRead {
        read,
        decode: Box::new(move |page| {
            if page.revision != Some(revision) {
                return Err(RevisionChanged(page.revision.ok_or("missing task revision")?).into());
            }
            let row: TaskWindow = decode_row(&page)?;
            if row.task_page.order != order {
                return Err(DirectoryChanged.into());
            }
            if row.task_page.total != total
                || row.task_page.reports != reports
                || row.task_page.counts != counts
                || !valid_tasks(&row, offset, pins.as_ref(), attention.then_some(offset))
                || attention && !super::attention::matches_page(base.as_ref(), &row, &excluded)
            {
                return invalid();
            }
            Ok(row)
        }),
    })
}

fn header(page: Verified, mission: &str) -> Result<MapHeader> {
    let map: MapHeader = decode_row(&page)?;
    let root = &map.root;
    let tasks = &map.tasks;
    if root.version != 1
        || root.id != mission
        || root.project != page.project
        || Some(root.revision) != page.revision
        || !panel_id(&root.coordinator_session_id)
        || !(1..=20_000).contains(&units(&root.project_canonical))
        || units(&root.excerpt) > 1004
        || root.title.as_ref().is_some_and(|title| units(title) > 60)
        || !root.created_at.is_finite()
        || !root.updated_at.is_finite()
        || !valid_bodies(&root.bodies)
        || map
            .control
            .as_ref()
            .is_some_and(|control| !control.valid(root.revision))
        || [
            "objective",
            "notes",
            "summary",
            "actors",
            "tasks",
            "reports",
            "history",
            "frontier",
            "claims",
            "control",
            "actorEvidence",
            "taskPage",
        ]
        .iter()
        .any(|key| root.extra.contains_key(*key))
        || map.coordinator.as_ref().is_some_and(|actor| {
            actor["sessionId"] != root.coordinator_session_id || actor["kind"] != "coordinator"
        })
        || !["actors", "history", "reports"]
            .iter()
            .all(|key| map.collections.get(*key).is_some_and(|d| d.array))
        || map.collections.values().any(|d| {
            d.characters > SAFE
                || d.total > SAFE
                || !digest_id(&d.digest)
                || d.order.as_ref().is_some_and(|order| !digest_id(order))
        })
        || map
            .collections
            .get("reports")
            .is_none_or(|d| d.total != tasks.page.reports)
        || !tasks.page.valid(0, false)
        || !valid_attention(&tasks.page, None)
        || !digest_id(&tasks.version)
        || !pins_valid(&tasks.pins, 20)
        || !pins_valid(&tasks.report_pins, 8)
        || tasks.page.end + tasks.pins.len() as u64 > tasks.page.total
    {
        return invalid();
    }
    Ok(map)
}

fn pins_valid(pins: &[String], maximum: usize) -> bool {
    pins.len() <= maximum
        && pins.iter().all(|id| panel_id(id))
        && pins.iter().collect::<HashSet<_>>().len() == pins.len()
}

fn valid_attention(page: &TaskPage, offset: Option<u64>) -> bool {
    page.attention.as_ref().map_or(offset.is_none(), |a| {
        a.valid(
            page.total,
            page.counts
                .get(&TaskStatus::NeedsInput)
                .copied()
                .unwrap_or(0),
            page.counts.get(&TaskStatus::Failed).copied().unwrap_or(0),
            offset,
        )
    })
}

fn valid_tasks(
    row: &TaskWindow,
    offset: u64,
    pins: Option<&(Vec<String>, Vec<String>)>,
    attention: Option<u64>,
) -> bool {
    let page = &row.task_page;
    if !page.valid(
        if attention.is_some() { 0 } else { offset },
        pins.is_some() || attention.is_some(),
    ) || !valid_attention(page, attention)
        || row.tasks.len() > 50
        || row.reports.len() > 200
        || row.reports.len() as u64 > page.reports
    {
        return false;
    }
    if pins.is_none() && attention.is_none() && row.tasks.len() as u64 != page.end - page.offset {
        return false;
    }
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    let mut positions = HashSet::new();
    let mut statuses = HashMap::new();
    let reports: HashMap<_, _> = row
        .reports
        .iter()
        .map(|report| (&report.id, report))
        .collect();
    let named_reports = |id: &String| pins.is_some_and(|(_, reports)| reports.contains(id));
    if reports.len() != row.reports.len() || row.reports.iter().any(|report| !report.valid()) {
        return false;
    }
    for task in &row.tasks {
        let count = statuses.entry(task.status).or_insert(0u64);
        *count += 1;
        let own = row
            .reports
            .iter()
            .filter(|report| report.task_key == task.key);
        let late = task.late_report_count.unwrap_or(0);
        if ![&task.id, &task.key, &task.role]
            .into_iter()
            .all(|id| panel_id(id))
            || units(&task.title) > 240
            || task.created_at > SAFE
            || task.updated_at > SAFE
            || task.dependents > page.total
            || !valid_bodies(&task.bodies)
            || task.extra.contains_key("brief")
            || !ids.insert(&task.id)
            || !keys.insert(&task.key)
            || !positions.insert(task.order)
            || task.order >= page.total
            || task.blocked_by.len() > 24
            || task.blocked_by.iter().any(|id| !panel_id(id))
            || task.report_count > page.reports
            || late > task.report_count
            || late < task.late_reports.len() as u64
            || task.late_reports.len() > 1
            || own.clone().count() as u64 > task.report_count
            || own
                .clone()
                .filter(|report| !named_reports(&report.id))
                .count()
                > 3
            || task.report.iter().chain(&task.late_reports).any(|nested| {
                nested.task_key != task.key
                    || !nested.valid()
                    || reports
                        .get(&nested.id)
                        .is_none_or(|top| !top.same_compact_report(nested))
            })
            || *count > page.counts.get(&task.status).copied().unwrap_or(0)
            || match pins {
                Some((ids, _)) => {
                    !ids.contains(&task.id) && !own.clone().any(|report| named_reports(&report.id))
                }
                None if attention.is_some() => {
                    task.order < 50
                        || !(matches!(task.status, TaskStatus::NeedsInput | TaskStatus::Failed)
                            || own.clone().any(|report| {
                                report
                                    .extra
                                    .get("notificationStatus")
                                    .is_some_and(|value| value == "pending")
                            })
                            || task.missing_report())
                }
                None => !(page.offset..page.end).contains(&task.order),
            }
        {
            return false;
        }
    }
    row.reports
        .iter()
        .all(|report| keys.contains(&report.task_key) || named_reports(&report.id))
}

impl Task {
    fn missing_report(&self) -> bool {
        let identity = |value: Option<&Value>| {
            value
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
        };
        let binding = self.extra.get("nativeBinding").is_some_and(|value| {
            value["generation"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= SAFE)
                && ["parentSessionID", "parentMessageID", "toolCallID"]
                    .iter()
                    .all(|key| identity(value.get(*key)))
        });
        identity(self.extra.get("actorSessionId"))
            && (self.outstanding_execution || identity(self.extra.get("admissionId")) || binding)
            && self.report.is_none()
            && self.late_reports.is_empty()
            && (self.outstanding_execution
                || matches!(self.status, TaskStatus::Queued | TaskStatus::Dispatching))
    }
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn valid_bodies(bodies: &HashMap<String, Body>) -> bool {
    bodies.len() <= 64
        && bodies.iter().all(|(key, body)| {
            (1..=64).contains(&units(key)) && body.characters <= SAFE && digest_id(&body.digest)
        })
}

fn invalid<T>() -> Result<T> {
    Err("invalid Mission detail".into())
}

#[cfg(test)]
mod tests;
