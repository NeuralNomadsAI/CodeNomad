//! Native family membership joined to declared actors (reference
//! `projectMissionFamily` in `missions/mission-family-projection.ts`).
use super::native::{MAX_DESCENDANTS, Tree, same};
use super::project::{Actor, Family, Member, Mission};
use std::collections::{HashMap, HashSet};

/// Reference `projectMissionFamily` (no unread actors: the route bounds them).
pub fn family(mission: &Mission, trees: &HashMap<String, Tree>, observed: bool) -> Family {
    let unknown = Family::unknown;
    if !observed || mission.actors.is_empty() {
        return unknown();
    }
    let declared: HashMap<&str, &Actor> = mission.actors.iter().map(|a| (a.session.as_str(), a)).collect();
    if declared.len() != mission.actors.len() {
        return unknown();
    }
    let mut sessions = Tree::default();
    for actor in &mission.actors {
        let Some(tree) = trees.get(&actor.session) else { return unknown() };
        let Some(root) = tree.get(&actor.session) else { return unknown() };
        if tree.len() > MAX_DESCENDANTS + 1
            || root.id != actor.session
            || root.project.as_deref() != Some(mission.project.as_str())
            || !same(root.location.as_ref(), Some(&actor.location))
        {
            return unknown();
        }
        for (id, session) in tree.iter() {
            if id.trim().is_empty()
                || *id != session.id
                || session.project != root.project
                || !same(session.location.as_ref(), root.location.as_ref())
            {
                return unknown();
            }
            let mut ancestry = HashSet::new();
            let mut current = session;
            while current.id != root.id {
                let Some(parent) = current.parent.as_ref().filter(|p| tree.has(p)) else { return unknown() };
                if !ancestry.insert(current.id.clone()) {
                    return unknown();
                }
                current = tree.get(parent).unwrap();
            }
            if let Some(existing) = sessions.get(id) {
                if existing.parent != session.parent
                    || existing.project != session.project
                    || !same(existing.location.as_ref(), session.location.as_ref())
                {
                    return unknown();
                }
            }
            sessions.insert(session.clone());
        }
    }
    for actor in &mission.actors {
        let tree = &trees[&actor.session];
        for (_, session) in sessions.iter() {
            if session.parent.as_ref().is_some_and(|p| tree.has(p)) && !tree.has(&session.id) {
                return unknown();
            }
        }
    }
    for (_, session) in sessions.iter() {
        let mut seen = HashSet::new();
        let mut current = Some(session);
        while let Some(c) = current {
            if !seen.insert(c.id.clone()) {
                return unknown();
            }
            current = c.parent.as_ref().and_then(|p| sessions.get(p));
        }
    }
    let contexts: HashMap<&str, Option<String>> = mission
        .actors
        .iter()
        .map(|a| {
            let key = mission.task_contexts.get(&a.session).and_then(|c| {
                (!c.invalid && (c.parent.is_none() || c.parent == sessions.get(&a.session).and_then(|s| s.parent.clone())))
                    .then(|| c.task_key.clone())
                    .flatten()
            });
            (a.session.as_str(), key)
        })
        .collect();
    let mut members = Vec::new();
    for (_, session) in sessions.iter() {
        let mut ancestor = Some(session);
        while let Some(a) = ancestor.filter(|a| !declared.contains_key(a.id.as_str())) {
            ancestor = a.parent.as_ref().and_then(|p| sessions.get(p));
        }
        let Some(ancestor) = ancestor else { return unknown() };
        members.push(Member {
            session: session.id.clone(),
            parent: session.parent.clone().filter(|p| !p.is_empty()),
            actor: ancestor.id.clone(),
            task_key: contexts.get(ancestor.id.as_str()).cloned().flatten().filter(|k| !k.is_empty()),
            declared: declared.contains_key(session.id.as_str()),
        });
    }
    Family { state: "observed", members }
}
