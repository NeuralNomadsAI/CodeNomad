//! Display-only activity of declared actors (reference `projectMissionActivity`
//! in `missions/activity.ts` and `projectMissionFamily` in
//! `missions/mission-family-projection.ts`). Never authority.
use super::family::family;
use super::native::{Fail, Loc, Observer, Session, Tree, same, truthy};
use super::ojson::J;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tokio::time::Instant;

const READ_CONCURRENCY: usize = 4;
const ACTIVE_DESCENDANT_PROBE: Duration = Duration::from_secs(5);
const ANCESTRY_READS: i64 = 128;

#[derive(Clone, Debug)]
pub struct TaskCtx {
    pub invalid: bool,
    pub task_key: Option<String>,
    pub parent: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Actor {
    pub session: String,
    pub location: Loc,
}
/// One persisted context as the observation reads it (tasks absent: actor evidence decides).
#[derive(Clone, Debug)]
pub struct Mission {
    pub id: String,
    pub project: String,
    pub status: String,
    pub run_state: Option<String>,
    pub control_unavailable: bool,
    pub pausing_control: bool,
    pub actors: Vec<Actor>,
    pub report_owed: HashSet<String>,
    pub call_open: HashSet<String>,
    pub task_contexts: HashMap<String, TaskCtx>,
}
impl Mission {
    /// From a context already validated by `context::context`.
    pub fn read(c: &J) -> Option<Mission> {
        let text = |v: &J, k: &str| v.get(k).and_then(J::str).map(str::to_owned);
        let mut m = Mission {
            id: text(c, "id")?,
            project: text(c, "projectID")?,
            status: text(c, "status")?,
            run_state: text(c, "runState"),
            control_unavailable: c.get("controlUnavailable")?.bool()?,
            pausing_control: c.get("control").is_some_and(|k| {
                k.get("action").and_then(J::str) == Some("pause") && k.get("graceful") == Some(&J::Bool(true))
            }),
            actors: Vec::new(),
            report_owed: HashSet::new(),
            call_open: HashSet::new(),
            task_contexts: HashMap::new(),
        };
        for a in c.get("actors")?.arr()? {
            let session = text(a, "sessionId")?;
            if a.get("reportOwed")?.bool()? {
                m.report_owed.insert(session.clone());
            }
            if a.get("callOpen")?.bool()? {
                m.call_open.insert(session.clone());
            }
            if let Some(t) = a.get("taskContext") {
                m.task_contexts.insert(
                    session.clone(),
                    TaskCtx { invalid: t.get("invalid")?.bool()?, task_key: text(t, "taskKey"), parent: text(t, "parentSessionID") },
                );
            }
            m.actors.push(Actor { session, location: Loc::read(a.get("location"))? });
        }
        Some(m)
    }
    /// Reference `missionIsRunning` (contexts carry no document).
    fn running(&self) -> bool {
        !self.control_unavailable && self.status == "active" && matches!(self.run_state.as_deref(), None | Some("running"))
    }
    fn rank(&self) -> u8 {
        let pausing = self.status == "active"
            && !self.control_unavailable
            && self.run_state.as_deref() == Some("paused")
            && self.pausing_control;
        if self.running() || pausing {
            2
        } else if self.status == "active" {
            1
        } else {
            0
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub session: String,
    pub parent: Option<String>,
    pub actor: String,
    pub task_key: Option<String>,
    pub declared: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Family {
    pub state: &'static str,
    pub members: Vec<Member>,
}
impl Family {
    pub(super) fn unknown() -> Family {
        Family { state: "unknown", members: Vec::new() }
    }
}
#[derive(Debug)]
pub struct Observed {
    pub mission: String,
    pub actors: Vec<(String, &'static str)>,
    pub family: Family,
}
/// Reference `MissionObservedRequests`, emitted only after the final fence.
#[derive(Debug)]
pub struct Requests {
    pub location: Loc,
    pub owned: Vec<String>,
    pub forms: Vec<J>,
    pub permissions: Vec<J>,
    pub forms_observed: bool,
    pub permissions_observed: bool,
}
#[derive(Debug)]
pub struct Projection {
    pub generated_at: u64,
    pub missions: Vec<Observed>,
    pub requests: Vec<Requests>,
}

#[derive(Default, Debug)]
struct ActorRead {
    owned: bool,
    session: Option<Session>,
    inbox: Option<usize>,
    tree: Option<Tree>,
    missing: bool,
    failed: bool,
    family_failed: bool,
    active_descendant: bool,
}
#[derive(Debug)]
struct LocationRead {
    shells: Vec<J>,
    forms: Vec<J>,
    permissions: Vec<J>,
    forms_observed: bool,
    permissions_observed: bool,
    failed: bool,
}

/// A read actor root: same project, identity and Location as a declared actor.
fn admitted<'a>(session: &Session, id: &str, project: &str, mut declared: impl Iterator<Item = &'a Actor>) -> bool {
    session.project.as_deref() == Some(project)
        && session.id == id
        && declared.any(|a| a.session == session.id && same(Some(&a.location), session.location.as_ref()))
}

/// Reference `readBounded`: four workers take the next index; results keep item order.
async fn bounded<R, F, Fut>(count: usize, read: F) -> Vec<R>
where
    F: Fn(usize) -> Fut,
    Fut: Future<Output = R>,
{
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results = std::sync::Mutex::new((0..count).map(|_| None).collect::<Vec<Option<R>>>());
    let worker = || async {
        loop {
            let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if i >= count {
                break;
            }
            let value = read(i).await;
            results.lock().unwrap()[i] = Some(value);
        }
    };
    futures_util::future::join_all((0..READ_CONCURRENCY.min(count)).map(|_| worker())).await;
    results.into_inner().unwrap().into_iter().map(|r| r.expect("read")).collect()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn unknown(missions: &[Mission]) -> Projection {
    Projection {
        generated_at: now_ms(),
        missions: missions
            .iter()
            .map(|m| Observed {
                mission: m.id.clone(),
                actors: m.actors.iter().map(|a| (a.session.clone(), "unknown")).collect(),
                family: Family::unknown(),
            })
            .collect(),
        requests: Vec::new(),
    }
}

fn session_of(item: &J) -> &str {
    item.get("sessionID").and_then(J::str).unwrap_or_default()
}
/// Reference `runningMissionShellRelation`.
fn shell_relation(shell: &J, family: &Tree) -> &'static str {
    if shell.get("status").and_then(J::str) != Some("running") {
        return "unrelated";
    }
    match shell.get("metadata").and_then(|m| m.get("sessionID")).and_then(J::str) {
        Some(id) if !id.trim().is_empty() => {
            if family.has(id) {
                "related"
            } else {
                "unrelated"
            }
        }
        _ => "unknown",
    }
}

async fn read_location(obs: &Observer<'_>, location: &Loc) -> LocationRead {
    let mut query = vec![("location[directory]", location.directory.as_str())];
    if let Some(w) = location.workspace.as_deref() {
        query.push(("location[workspaceID]", w));
    }
    let list = |path: &'static str| {
        let query = query.clone();
        async move {
            obs.observe(async {
                let v = obs.get(path, &query, 8 * 1024 * 1024, obs.deadline).await?;
                let data = v.get("data").and_then(J::arr).ok_or(Fail::Other)?.to_vec();
                let directory = v.get("location").and_then(|l| l.get("directory")).and_then(J::str).map(str::to_owned);
                Ok((data, directory))
            })
            .await
        }
    };
    let shells = list("/api/shell").await;
    let forms = list("/api/form").await;
    let permissions = list("/api/permission/request").await;
    let here = |r: &Result<(Vec<J>, Option<String>), Fail>| {
        r.as_ref().is_ok_and(|(_, d)| d.as_deref() == Some(location.directory.as_str()))
    };
    let failed = [&shells, &forms, &permissions].iter().any(|r| !here(r));
    let (forms_observed, permissions_observed) = (here(&forms), here(&permissions));
    let data = |r: Result<(Vec<J>, Option<String>), Fail>| r.map(|(d, _)| d).unwrap_or_default();
    LocationRead {
        shells: data(shells),
        forms: data(forms),
        permissions: data(permissions),
        forms_observed,
        permissions_observed,
        failed,
    }
}

pub async fn project(obs: &Observer<'_>, project_id: &str, missions: &[Mission]) -> Projection {
    if !obs.assert() {
        return unknown(missions);
    }
    // Running (and gracefully pausing), then other active missions, stable.
    let mut sorted: Vec<&Mission> = missions.iter().collect();
    sorted.sort_by_key(|m| std::cmp::Reverse(m.rank()));
    let occurrences: Vec<(&Mission, &Actor)> = sorted.iter().flat_map(|m| m.actors.iter().map(move |a| (*m, a))).collect();
    let mut seen = HashSet::new();
    let actor_ids: Vec<String> =
        occurrences.iter().filter(|(_, a)| seen.insert(a.session.clone())).map(|(_, a)| a.session.clone()).collect();
    let mut missing_reports = HashSet::new();
    let mut unsettled = HashSet::new();
    for (m, a) in &occurrences {
        if m.report_owed.contains(&a.session) {
            missing_reports.insert((m.id.clone(), a.session.clone()));
        }
        if m.call_open.contains(&a.session) {
            unsettled.insert((m.id.clone(), a.session.clone()));
        }
    }
    let working: HashSet<String> = missing_reports.iter().chain(unsettled.iter()).map(|(_, s)| s.clone()).collect();
    // The route admits at most MISSION_ACTIVITY_ACTORS declared actors, so the
    // reference's actor prioritisation and family-size budgets never apply here.

    let mut reads: Vec<(String, ActorRead)> = bounded(actor_ids.len(), |i| {
        let id = &actor_ids[i];
        async move {
            let read = match obs.observe(obs.session(id, obs.deadline)).await {
                Ok(s) => ActorRead { session: Some(Session::read(&s)), ..Default::default() },
                Err(Fail::Missing) => ActorRead { missing: true, ..Default::default() },
                Err(Fail::Other) => ActorRead { failed: true, ..Default::default() },
            };
            (id.clone(), read)
        }
    })
    .await;

    // Owned location, same project/identity/location as a declared actor, then its family.
    let occurrences = &occurrences;
    let rows = &reads;
    let families: Vec<Option<(bool, Option<Result<Tree, Fail>>)>> = bounded(rows.len(), |i| {
        let (id, read) = &rows[i];
        async move {
            let session = read.session.as_ref().filter(|_| !read.failed)?;
            let owned = match session.location.as_ref() {
                Some(l) => obs.observe(async { Ok(obs.owns(l).await) }).await.unwrap_or(false),
                None => false,
            };
            if !owned || !admitted(session, id, project_id, occurrences.iter().map(|(_, a)| *a)) {
                return Some((false, None));
            }
            Some((true, Some(obs.family(session).await)))
        }
    })
    .await;
    let mut authorized: Vec<Loc> = Vec::new();
    for ((_, read), outcome) in reads.iter_mut().zip(families) {
        match outcome {
            None => {}
            Some((false, _)) => read.failed = true,
            Some((true, family)) => {
                let location = read.session.as_ref().and_then(|s| s.location.clone()).expect("owned location");
                if !authorized.iter().any(|l| l.key() == location.key()) {
                    authorized.push(location);
                }
                read.owned = true;
                match family {
                    Some(Ok(tree)) => read.tree = Some(tree),
                    _ => {
                        read.failed = true;
                        read.family_failed = true;
                    }
                }
            }
        }
    }

    let active: Option<Vec<(String, J)>> = obs
        .observe(async {
            let v = obs.get("/api/session/active", &[], 1024 * 1024, obs.deadline).await?;
            v.get("data").and_then(J::obj).map(<[_]>::to_vec).ok_or(Fail::Other)
        })
        .await
        .ok();
    let is_active = |id: &str| active.as_ref().is_some_and(|a| a.iter().any(|(k, v)| k == id && truthy(v)));

    let locations: HashMap<String, LocationRead> = bounded(authorized.len(), |i| {
        let l = &authorized[i];
        async move { (l.key(), read_location(obs, l).await) }
    })
    .await
    .into_iter()
    .collect();

    // Queued input decides only for an actor owing a report or with an open call
    // that no request, run or background work already describes.
    let needs_inbox = |id: &str, read: &ActorRead| -> bool {
        let (Some(tree), Some(session)) = (read.tree.as_ref(), read.session.as_ref()) else {
            return false;
        };
        if !working.contains(id) || active.is_none() {
            return false;
        }
        let Some(resources) = session.location.as_ref().and_then(|l| locations.get(&l.key())).filter(|r| !r.failed) else {
            return false;
        };
        let related = |s: &str| s == "global" || tree.has(s);
        if resources.permissions.iter().chain(&resources.forms).any(|i| related(session_of(i))) {
            return false;
        }
        if tree.order.iter().any(|m| is_active(m)) {
            return false;
        }
        !resources.shells.iter().any(|s| shell_relation(s, tree) == "related")
    };
    let mut inbox_ids: Vec<String> = Vec::new();
    for (id, read) in &reads {
        if needs_inbox(id, read) {
            for member in &read.tree.as_ref().unwrap().order {
                if !inbox_ids.contains(member) {
                    inbox_ids.push(member.clone());
                }
            }
        }
    }
    let inboxes: HashMap<String, usize> = bounded(inbox_ids.len(), |i| {
        let id = &inbox_ids[i];
        async move {
            let result = obs
                .observe(async {
                    let path = format!("/api/session/{}/inbox", super::native::component(id).ok_or(Fail::Other)?);
                    let v = obs.get(&path, &[], 2 * 1024 * 1024, obs.deadline).await?;
                    v.get("data").and_then(J::arr).map(<[_]>::len).ok_or(Fail::Other)
                })
                .await;
            (id.clone(), result)
        }
    })
    .await
    .into_iter()
    .filter_map(|(id, r)| r.ok().map(|n| (id, n)))
    .collect();
    let needs: Vec<bool> = reads.iter().map(|(id, read)| needs_inbox(id, read)).collect();
    for ((_, read), needed) in reads.iter_mut().zip(needs) {
        let Some(tree) = read.tree.as_ref() else { continue };
        if !needed {
            read.inbox = Some(0);
        } else if tree.order.iter().any(|m| !inboxes.contains_key(m)) {
            read.failed = true;
        } else {
            read.inbox = Some(tree.order.iter().map(|m| inboxes[m]).sum());
        }
    }

    // Oversized families: probe ancestry for an active descendant, one shared budget.
    if let Some(active) = active.as_ref() {
        let probe = obs.deadline.min(Instant::now() + ACTIVE_DESCENDANT_PROBE);
        let mut parents = HashMap::new();
        let mut budget = ANCESTRY_READS;
        for (id, read) in reads.iter_mut() {
            if !read.family_failed || is_active(id) {
                continue;
            }
            let found = obs.observe(obs.active_descendant(id, active, &mut parents, &mut budget, probe)).await;
            read.active_descendant = found == Ok(true);
        }
    }

    // Overlapping families must agree on every native identity.
    let mut conflicts = HashSet::new();
    let mut identities: Vec<(String, Session, Vec<String>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (root, read) in &reads {
        if read.failed || read.tree.is_none() {
            continue;
        }
        for (id, session) in read.tree.as_ref().unwrap().iter() {
            match index.get(id) {
                Some(&i) => {
                    let prior = &mut identities[i];
                    if !prior.2.contains(root) {
                        prior.2.push(root.clone());
                    }
                    if prior.1.parent != session.parent
                        || prior.1.project != session.project
                        || !same(prior.1.location.as_ref(), session.location.as_ref())
                    {
                        conflicts.insert(id.clone());
                    }
                }
                None => {
                    index.insert(id.clone(), identities.len());
                    identities.push((id.clone(), session.clone(), vec![root.clone()]));
                }
            }
        }
    }
    let position: HashMap<String, usize> = reads.iter().enumerate().map(|(i, (id, _))| (id.clone(), i)).collect();
    for id in &conflicts {
        for root in identities[index[id]].2.clone() {
            reads[position[&root]].1.failed = true;
        }
    }
    for i in 0..reads.len() {
        if reads[i].1.failed || reads[i].1.tree.is_none() {
            continue;
        }
        let tree = reads[i].1.tree.clone().unwrap();
        for (id, session) in tree.iter() {
            if let Some(&j) = position.get(id) {
                let direct = &reads[j].1;
                if !direct.session.as_ref().is_some_and(|d| {
                    d.id == *id
                        && d.parent == session.parent
                        && d.project == session.project
                        && same(d.location.as_ref(), session.location.as_ref())
                }) {
                    reads[i].1.failed = true;
                }
            }
        }
        for (_, session, _) in &identities {
            if session.parent.as_ref().is_some_and(|p| tree.has(p)) && !tree.has(&session.id) {
                reads[i].1.failed = true;
                for root in identities[index[&session.id]].2.clone() {
                    reads[position[&root]].1.failed = true;
                }
            }
        }
    }
    let mut trees: HashMap<String, Tree> = HashMap::new();
    for (id, read) in &reads {
        let location_ok = read
            .session
            .as_ref()
            .and_then(|s| s.location.as_ref())
            .and_then(|l| locations.get(&l.key()))
            .is_some_and(|r| !r.failed);
        if !read.failed && read.session.is_some() && location_ok {
            if let Some(tree) = &read.tree {
                trees.insert(id.clone(), tree.clone());
            }
        }
    }
    if !obs.assert() {
        return unknown(missions);
    }
    let reads: HashMap<String, ActorRead> = reads.into_iter().collect();
    let projection = Projection {
        generated_at: now_ms(),
        missions: missions
            .iter()
            .map(|m| Observed {
                mission: m.id.clone(),
                family: family(m, &trees, active.is_some()),
                actors: m
                    .actors
                    .iter()
                    .map(|a| (a.session.clone(), state(m, a, reads.get(&a.session), &locations, active.is_some(), &is_active, &missing_reports, &unsettled)))
                    .collect(),
            })
            .collect(),
        requests: authorized
            .iter()
            .filter_map(|l| {
                let r = locations.get(&l.key())?;
                Some(Requests {
                    location: l.clone(),
                    owned: actor_ids
                        .iter()
                        .filter(|id| {
                            reads[*id].owned
                                && reads[*id].session.as_ref().and_then(|s| s.location.as_ref()).map(Loc::key) == Some(l.key())
                        })
                        .cloned()
                        .collect(),
                    forms: r.forms.clone(),
                    permissions: r.permissions.clone(),
                    forms_observed: r.forms_observed,
                    permissions_observed: r.permissions_observed,
                })
            })
            .collect(),
    };
    if !obs.assert() {
        return unknown(missions);
    }
    projection
}

#[allow(clippy::too_many_arguments)]
fn state(
    m: &Mission,
    actor: &Actor,
    read: Option<&ActorRead>,
    locations: &HashMap<String, LocationRead>,
    active_ok: bool,
    is_active: &dyn Fn(&str) -> bool,
    missing_reports: &HashSet<(String, String)>,
    unsettled: &HashSet<(String, String)>,
) -> &'static str {
    let Some(read) = read else { return "unknown" };
    if read.missing {
        return "missing";
    }
    let resources = |s: &Session| s.location.as_ref().and_then(|l| locations.get(&l.key())).filter(|r| !r.failed);
    let here = |s: &Session| same(s.location.as_ref(), Some(&actor.location));
    // An oversized family is still positive evidence of ongoing work.
    if let Some(session) = read.session.as_ref().filter(|s| read.family_failed && active_ok && here(s)) {
        let own = |i: &J| session_of(i) == actor.session || session_of(i) == "global";
        if let Some(r) = resources(session) {
            if r.permissions.iter().any(own) {
                return "permission";
            }
            if r.forms.iter().any(own) {
                return "form";
            }
        }
        if is_active(&actor.session) {
            return "running";
        }
        if read.active_descendant {
            return "background";
        }
    }
    let (Some(session), Some(inbox), Some(tree)) = (read.session.as_ref(), read.inbox, read.tree.as_ref()) else {
        return "unknown";
    };
    if read.failed || !active_ok || !here(session) {
        return "unknown";
    }
    let Some(r) = resources(session) else { return "unknown" };
    let key = (m.id.clone(), actor.session.clone());
    let relations: Vec<&str> = r.shells.iter().map(|s| shell_relation(s, tree)).collect();
    let related = |i: &J| session_of(i) == "global" || tree.has(session_of(i));
    if r.permissions.iter().any(related) {
        "permission"
    } else if r.forms.iter().any(related) {
        "form"
    } else if is_active(&actor.session) {
        "running"
    } else if tree.order.iter().any(|id| *id != actor.session && is_active(id)) || relations.contains(&"related") {
        "background"
    } else if (missing_reports.contains(&key) || unsettled.contains(&key)) && inbox > 0 {
        "queued"
    } else if relations.contains(&"unknown") || unsettled.contains(&key) {
        "unknown"
    } else if missing_reports.contains(&key) {
        "idle-without-report"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc() -> Loc {
        Loc { directory: "D:\\p".into(), workspace: None }
    }
    fn session(id: &str, parent: Option<&str>) -> Session {
        Session { id: id.into(), parent: parent.map(Into::into), project: Some("p".into()), location: Some(loc()) }
    }
    fn mission(actors: &[&str]) -> Mission {
        Mission {
            id: "m".into(),
            project: "p".into(),
            status: "active".into(),
            run_state: None,
            control_unavailable: false,
            pausing_control: false,
            actors: actors.iter().map(|a| Actor { session: (*a).into(), location: loc() }).collect(),
            report_owed: HashSet::from(["root".to_owned()]),
            call_open: HashSet::new(),
            task_contexts: HashMap::from([("child".to_owned(), TaskCtx { invalid: false, task_key: Some("t1".into()), parent: Some("root".into()) })]),
        }
    }
    fn tree(rows: &[Session]) -> Tree {
        let mut t = Tree::default();
        for r in rows {
            t.insert(r.clone());
        }
        t
    }

    #[test]
    fn family_joins_declared_and_ordinary_members() {
        let root = tree(&[session("root", None), session("child", Some("root")), session("helper", Some("child"))]);
        let child = tree(&[session("child", Some("root")), session("helper", Some("child"))]);
        let trees = HashMap::from([("root".to_owned(), root), ("child".to_owned(), child)]);
        let f = family(&mission(&["root", "child"]), &trees, true);
        assert_eq!(f.state, "observed");
        let rows: Vec<_> = f.members.iter().map(|m| (m.session.as_str(), m.actor.as_str(), m.task_key.as_deref(), m.declared)).collect();
        assert_eq!(rows, [("root", "root", None, true), ("child", "child", Some("t1"), true), ("helper", "child", Some("t1"), false)]);
        // A declared child absent from its parent's complete catalogue clears the membership.
        let lone = HashMap::from([("root".to_owned(), tree(&[session("root", None)])), ("child".to_owned(), tree(&[session("child", Some("root"))]))]);
        assert_eq!(family(&mission(&["root", "child"]), &lone, true), Family::unknown());
        assert_eq!(family(&mission(&["root"]), &HashMap::new(), true), Family::unknown());
    }

    #[test]
    fn foreign_actor_locations_are_refused() {
        let m = mission(&["root"]);
        let ok = session("root", None);
        assert!(admitted(&ok, "root", "p", m.actors.iter()));
        let moved = Session { location: Some(Loc { directory: "D:\\other".into(), workspace: None }), ..ok.clone() };
        assert!(!admitted(&moved, "root", "p", m.actors.iter()));
        let selector = Session { location: Some(Loc { directory: "D:\\p".into(), workspace: Some("w".into()) }), ..ok.clone() };
        assert!(!admitted(&selector, "root", "p", m.actors.iter()));
        assert!(!super::super::native::ownable(selector.location.as_ref().unwrap()));
        assert!(!admitted(&Session { project: Some("q".into()), ..ok.clone() }, "root", "p", m.actors.iter()));
        assert!(!admitted(&Session { id: "other".into(), ..ok.clone() }, "root", "p", m.actors.iter()));
        assert!(!admitted(&Session { location: None, ..ok }, "root", "p", m.actors.iter()));
    }

    fn resources(permissions: Vec<J>, forms: Vec<J>, shells: Vec<J>) -> HashMap<String, LocationRead> {
        HashMap::from([(loc().key(), LocationRead { shells, forms, permissions, forms_observed: true, permissions_observed: true, failed: false })])
    }
    fn item(session: &str) -> J {
        super::super::ojson::obj(vec![("id", J::s("x")), ("sessionID", J::s(session))])
    }

    #[test]
    fn state_priority_follows_the_reference() {
        let m = mission(&["root"]);
        let actor = &m.actors[0];
        let read = ActorRead {
            owned: true,
            session: Some(session("root", None)),
            inbox: Some(1),
            tree: Some(tree(&[session("root", None), session("kid", Some("root"))])),
            ..Default::default()
        };
        let none = HashSet::new();
        let reports = HashSet::from([("m".to_owned(), "root".to_owned())]);
        let idle = |_: &str| false;
        let kid = |id: &str| id == "kid";
        let me = |id: &str| id == "root";
        let all = resources(vec![item("kid")], vec![item("root")], vec![]);
        assert_eq!(state(&m, actor, Some(&read), &all, true, &me, &reports, &none), "permission");
        let forms = resources(vec![item("other")], vec![item("global")], vec![]);
        assert_eq!(state(&m, actor, Some(&read), &forms, true, &me, &reports, &none), "form");
        let empty = resources(vec![], vec![], vec![]);
        assert_eq!(state(&m, actor, Some(&read), &empty, true, &me, &reports, &none), "running");
        assert_eq!(state(&m, actor, Some(&read), &empty, true, &kid, &reports, &none), "background");
        assert_eq!(state(&m, actor, Some(&read), &empty, true, &idle, &reports, &none), "queued");
        let quiet = ActorRead { inbox: Some(0), ..read };
        assert_eq!(state(&m, actor, Some(&quiet), &empty, true, &idle, &reports, &none), "idle-without-report");
        assert_eq!(state(&m, actor, Some(&quiet), &empty, true, &idle, &none, &none), "unknown");
        assert_eq!(state(&m, actor, Some(&quiet), &empty, false, &idle, &reports, &none), "unknown");
        let shell = resources(vec![], vec![], vec![super::super::ojson::obj(vec![("status", J::s("running"))])]);
        assert_eq!(state(&m, actor, Some(&quiet), &shell, true, &idle, &reports, &none), "unknown");
        let gone = ActorRead { missing: true, ..Default::default() };
        assert_eq!(state(&m, actor, Some(&gone), &empty, true, &idle, &reports, &none), "missing");
        // An oversized family still shows its own request or run.
        let big = ActorRead { session: Some(session("root", None)), failed: true, family_failed: true, ..Default::default() };
        assert_eq!(state(&m, actor, Some(&big), &forms, true, &me, &reports, &none), "form");
        assert_eq!(state(&m, actor, Some(&big), &empty, true, &me, &reports, &none), "running");
        assert_eq!(state(&m, actor, Some(&big), &empty, true, &idle, &reports, &none), "unknown");
    }
}
