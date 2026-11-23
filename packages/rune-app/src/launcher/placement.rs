use super::{Backend, Project, Reply, State};
use crate::{
    catalog::{InventoryScope, Member},
    git,
    history::Result,
    workspace,
};
use std::collections::{HashMap, HashSet};

const ERROR: &str = "sessionList.worktreeMove.error";

pub(crate) fn place(s: &mut State, target: String) {
    if !git::can_place(s) || !git::placeable(s, &target) {
        return;
    }
    let Some(id) = workspace::active_session(s).map(str::to_owned) else {
        return;
    };
    let Some(current) = git::placement(s).map(str::to_owned) else {
        return;
    };
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(backend), Some(project)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    l.job(ERROR, async move {
        let (bound, info, actual) = backend.bind_session_placed(&project, &id, false).await?;
        let native = backend
            .native_project(&project)
            .await?
            .ok_or("missing project inventory")?;
        let before = inventory(&backend, &project, &native).await?;
        let family = family(&before, &id)?;
        let trees = bound.git_worktrees(false).await?;
        let tree = trees
            .trees
            .iter()
            .find(|tree| tree.slug == target && !tree.missing)
            .ok_or("checkout is no longer available")?;
        let all_there = |rows: &[&Member]| {
            rows.iter().all(|m| {
                codenomad_client::same_server_path(&m.directory, &tree.directory)
                    || tree
                        .service_directory
                        .as_ref()
                        .is_some_and(|d| codenomad_client::same_server_path(&m.directory, d))
            })
        };
        let already_placed = actual == target && all_there(&family);
        if already_placed || actual != current && actual != target {
            return Ok(Reply::Placed(
                bound,
                info.title,
                actual,
                already_placed,
                false,
            ));
        }

        let moved = bound.place_session(&target).await;
        let mut affected: HashSet<_> = family
            .iter()
            .map(|member| member.session.id.clone())
            .collect();
        if let Ok(members) = &moved {
            affected.extend(members.iter().cloned());
        }
        // A transport failure cannot establish when the server finished the POST.
        // Defer its separate reconciliation to an explicit read gesture.
        let answered = match &moved {
            Ok(_) => true,
            Err(error) => error
                .downcast_ref::<codenomad_client::git::Refusal>()
                .is_some_and(codenomad_client::git::Refusal::placement_answered),
        };
        let hold = || {
            Reply::PlacementUnconfirmed(git::PlacementHold {
                members: affected.clone(),
                answered,
            })
        };
        if !answered {
            return Ok(hold());
        }
        match reconcile(&backend, &project, &id, &native, &affected).await {
            Ok((bound, title, actual)) => {
                let confirmed = moved.is_ok() && actual == target;
                Ok(Reply::Placed(bound, title, actual, confirmed, true))
            }
            Err(_) => Ok(hold()),
        }
    });
}

async fn inventory(backend: &Backend, project: &Project, native: &str) -> Result<Vec<Member>> {
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    let mut cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    let mut bytes = 0;
    loop {
        let scope = cursor.as_deref().map_or(
            InventoryScope::NativeProject(native),
            InventoryScope::Continue,
        );
        let page = backend.session_inventory(project, scope).await?;
        for row in page.members {
            bytes += row.session.title.len()
                + row.session.id.len()
                + row.directory.len()
                + row.parent.as_ref().map_or(0, String::len);
            if bytes > 24 * 1024 * 1024 || !seen.insert(row.session.id.clone()) {
                return Err("incomplete project inventory".into());
            }
            rows.push(row);
        }
        let Some(next) = page.next else {
            return Ok(rows);
        };
        if cursors.len() >= 999 || !cursors.insert(next.clone()) {
            return Err("project inventory did not complete".into());
        }
        cursor = Some(next);
    }
}

fn family<'a>(rows: &'a [Member], session: &str) -> Result<Vec<&'a Member>> {
    let by_id: HashMap<_, _> = rows.iter().map(|m| (m.session.id.as_str(), m)).collect();
    let root = |id: &str| {
        let mut id = *by_id.get_key_value(id)?.0;
        for _ in 0..64 {
            match by_id.get(id)?.parent.as_deref() {
                Some(parent) => id = parent,
                None => return Some(id),
            }
        }
        None
    };
    let owner = root(session).ok_or("missing conversation family")?;
    Ok(rows
        .iter()
        .filter(|m| root(&m.session.id) == Some(owner))
        .collect())
}

async fn reconcile(
    backend: &Backend,
    project: &Project,
    selected: &str,
    native: &str,
    affected: &HashSet<String>,
) -> Result<(Backend, String, String)> {
    let rows = inventory(backend, project, native).await?;
    let current_family = family(&rows, selected)?;
    let (bound, info, actual) = backend
        .bind_session_placed(project, selected, false)
        .await?;
    let directories: HashSet<_> = rows
        .iter()
        .filter(|m| affected.contains(&m.session.id))
        .map(|m| m.directory.as_str())
        .chain(current_family.into_iter().map(|m| m.directory.as_str()))
        .collect();
    for directory in directories {
        if !bound.placement_activity(directory).await?["data"].is_object() {
            return Err("activity unavailable".into());
        }
    }
    Ok((bound, info.title, actual))
}

pub(crate) fn retry(s: &mut State) {
    let Some(id) = workspace::active_session(s).map(str::to_owned) else {
        return;
    };
    let Some(hold) = git::placement_hold(s).filter(|hold| hold.answered) else {
        return;
    };
    let Some(l) = s.screen.launcher_mut().filter(|l| !l.pending) else {
        return;
    };
    let (Some(backend), Some(project)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    l.job(ERROR, async move {
        let native = backend
            .native_project(&project)
            .await?
            .ok_or("missing project inventory")?;
        let (bound, title, actual) =
            reconcile(&backend, &project, &id, &native, &hold.members).await?;
        Ok(Reply::PlacementReconciled(bound, title, actual, hold))
    });
}
