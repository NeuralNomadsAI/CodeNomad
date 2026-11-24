use super::{
    RunState, Status,
    codec::decode_row,
    detail::DetailRead,
    directory::{DirectoryChanged, PageRead, Source, Verified, digest_id, panel_id},
    model::Window,
};
use crate::{backend::Backend, history::Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const ACTORS: u64 = 160;
const MAX: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Coverage {
    Observed,
    Partial,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ActorState {
    Running,
    Queued,
    Background,
    Permission,
    Form,
    Missing,
    IdleWithoutReport,
    Unknown,
}

pub struct Activity {
    pub revision: u64,
    pub observed_at: f64,
    pub coordinator_session_id: String,
    pub status: Status,
    pub run_state: Option<RunState>,
    pub family_observed: bool,
    pub window: Window,
    pub coverage: Coverage,
    pub requests: Coverage,
    pub actors: Vec<Actor>,
    pub questions: Vec<ObservedQuestion>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedQuestion {
    pub actor_session_id: String,
    pub session_id: String,
}

pub struct Actor {
    pub session_id: String,
    pub title: String,
    pub state: ActorState,
    pub request: Option<ActorState>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    context: Context,
    coverage: Coverage,
    requests: Requests,
    activity: NativeActivity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    id: String,
    #[serde(rename = "projectID")]
    project_id: String,
    revision: u64,
    status: Status,
    run_state: Option<RunState>,
    coordinator_session_id: String,
    actors: Vec<ContextActor>,
    actor_page: Window,
    discarded_events: u64,
    control_unavailable: bool,
    notification_unavailable: bool,
    cleanup_unavailable: bool,
    #[serde(rename = "control")]
    _control: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextActor {
    session_id: String,
    title: String,
    location: Location,
    #[serde(rename = "reportOwed")]
    _report_owed: bool,
    #[serde(rename = "callOpen")]
    _call_open: bool,
    task_context: Option<TaskContext>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Location {
    directory: String,
    #[serde(rename = "workspaceID")]
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskContext {
    #[serde(rename = "invalid")]
    _invalid: bool,
    task_key: Option<String>,
    #[serde(rename = "parentSessionID")]
    parent_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeActivity {
    actors: Vec<NativeActor>,
    family: Family,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeActor {
    session_id: String,
    state: ActorState,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Family {
    state: Coverage,
    members: Vec<Member>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Member {
    session_id: String,
    parent_session_id: Option<String>,
    actor_session_id: String,
    kind: Option<MemberKind>,
    task_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum MemberKind {
    Declared,
    Ordinary,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Requests {
    state: Coverage,
    items: Vec<ObservedRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservedRequest {
    kind: RequestKind,
    actor_session_id: String,
    request: Request,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RequestKind {
    Form,
    Permission,
}

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(rename = "sessionID")]
    session_id: String,
    title: Option<String>,
    fields: Option<Vec<Value>>,
    #[serde(rename = "action")]
    _action: Option<String>,
    #[serde(rename = "resources")]
    _resources: Option<Vec<String>>,
}

impl Backend {
    pub fn mission_activity(
        &self,
        project: &str,
        mission: &str,
        offset: u64,
        order: Option<&str>,
    ) -> Result<DetailRead<Activity>> {
        if offset > MAX || order.is_some_and(|id| !digest_id(id)) {
            return invalid();
        }
        let mut selector = json!({"source":"activity","missionID":mission,"actorOffset":offset});
        if let Some(order) = order {
            selector["actorOrder"] = json!(order);
        }
        let read = PageRead::selected(self, project, Source::Activity, mission, selector)?;
        let mission = mission.to_owned();
        let order = order.map(str::to_owned);
        Ok(DetailRead {
            read,
            decode: Box::new(move |page| decode(page, &mission, offset, order.as_deref())),
        })
    }
}

fn decode(page: Verified, mission: &str, offset: u64, order: Option<&str>) -> Result<Activity> {
    let row: Observation = decode_row(&page)?;
    let ctx = row.context;
    let window = ctx.actor_page;
    if order.is_some_and(|order| order != window.order) {
        return Err(DirectoryChanged.into());
    }
    if ctx.id != mission
        || ctx.project_id != page.project
        || Some(ctx.revision) != page.revision
        || !panel_id(&ctx.coordinator_session_id)
        || ctx.discarded_events != 0
        || ctx.control_unavailable
        || ctx.notification_unavailable
        || ctx.cleanup_unavailable
        || !digest_id(&window.order)
        || window.total > MAX
        || window.offset != offset.min(window.total)
        || window.end != (window.offset + ACTORS).min(window.total)
        || ctx.actors.len() as u64 != window.end - window.offset
        || row.activity.actors.len() > ACTORS as usize
        || row.activity.family.members.len() > ACTORS as usize * 33
        || window.total > ctx.actors.len() as u64
            && [row.coverage, row.requests.state, row.activity.family.state]
                .contains(&Coverage::Observed)
    {
        return invalid();
    }
    let roots: HashSet<_> = ctx
        .actors
        .iter()
        .map(|actor| actor.session_id.as_str())
        .collect();
    if roots.len() != ctx.actors.len() || ctx.actors.iter().any(|actor| !actor.valid()) {
        return invalid();
    }
    let states: HashMap<_, _> = row
        .activity
        .actors
        .iter()
        .map(|actor| (actor.session_id.as_str(), actor.state))
        .collect();
    let members: HashMap<_, _> = row
        .activity
        .family
        .members
        .iter()
        .map(|member| (member.session_id.as_str(), member.actor_session_id.as_str()))
        .collect();
    if states.len() != row.activity.actors.len()
        || states.len() != roots.len()
        || states.keys().any(|id| !roots.contains(id))
        || members.len() != row.activity.family.members.len()
        || row
            .activity
            .family
            .members
            .iter()
            .any(|member| !member.valid(&roots))
    {
        return invalid();
    }
    let mut requests = HashMap::new();
    let mut questions = Vec::with_capacity(row.requests.items.len());
    for item in &row.requests.items {
        let id = item.actor_session_id.as_str();
        let session = item.request.session_id.as_str();
        if !roots.contains(id)
            || (session != id && members.get(session) != Some(&id))
            || !item.valid()
        {
            return invalid();
        }
        questions.push(ObservedQuestion {
            actor_session_id: item.actor_session_id.clone(),
            session_id: item.request.session_id.clone(),
        });
        let state = if item.kind == RequestKind::Permission {
            ActorState::Permission
        } else {
            ActorState::Form
        };
        let prior = requests.entry(id).or_insert(state);
        if state == ActorState::Permission {
            *prior = state;
        }
    }
    let actors = ctx
        .actors
        .iter()
        .map(|actor| Actor {
            session_id: actor.session_id.clone(),
            title: actor.title.clone(),
            state: states
                .get(actor.session_id.as_str())
                .copied()
                .unwrap_or(ActorState::Unknown),
            request: requests.get(actor.session_id.as_str()).copied(),
        })
        .collect();
    Ok(Activity {
        revision: ctx.revision,
        observed_at: page.observed_at.ok_or("missing Mission observation time")?,
        coordinator_session_id: ctx.coordinator_session_id,
        status: ctx.status,
        run_state: ctx.run_state,
        family_observed: row.activity.family.state == Coverage::Observed,
        window,
        coverage: row.coverage,
        requests: row.requests.state,
        actors,
        questions,
    })
}

impl ContextActor {
    fn valid(&self) -> bool {
        panel_id(&self.session_id)
            && self.title.encode_utf16().count() <= 240
            && (1..=20_000).contains(&self.location.directory.encode_utf16().count())
            && self.location.workspace_id.as_deref().is_none_or(panel_id)
            && self.task_context.as_ref().is_none_or(|task| {
                task.task_key
                    .as_ref()
                    .is_none_or(|key| key.encode_utf16().count() <= 64)
                    && task.parent_session_id.as_deref().is_none_or(panel_id)
            })
    }
}

impl Member {
    fn valid(&self, roots: &HashSet<&str>) -> bool {
        panel_id(&self.session_id)
            && roots.contains(self.actor_session_id.as_str())
            && self.parent_session_id.as_deref().is_none_or(panel_id)
            && self
                .task_key
                .as_ref()
                .is_none_or(|key| key.encode_utf16().count() <= 64)
            && (self.kind.is_some() || self.task_key.is_none())
    }
}

impl ObservedRequest {
    fn valid(&self) -> bool {
        panel_id(&self.request.id)
            && panel_id(&self.request.session_id)
            && match self.kind {
                RequestKind::Form => self.request.title.is_some() && self.request.fields.is_some(),
                RequestKind::Permission => true,
            }
    }
}

fn invalid<T>() -> Result<T> {
    Err("invalid Mission activity observation".into())
}

#[cfg(test)]
mod tests;
