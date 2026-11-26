use crate::{
    backend::Backend,
    catalog::{InventoryScope, Member, Project, Sessions},
    history::Result,
    platform::reads::Reads,
};
use codenomad_client::{Receiver, git::Repository};
use std::{
    collections::{HashMap, HashSet},
    hash::{DefaultHasher, Hash, Hasher},
    sync::atomic::{AtomicU64, Ordering},
};

pub(super) async fn load(
    backend: &Backend,
    project: &Project,
    selected: Option<&str>,
    reads: &Reads,
    cancelled: &Receiver<()>,
    presence_epoch: &AtomicU64,
) -> Result<Option<(Sessions, Vec<(String, u64)>)>> {
    let native = {
        let _permit = reads
            .background(cancelled)
            .await
            .ok_or("catalogue closed")?;
        backend.native_project(project).await?
    };
    let Some(native) = native else {
        return Ok(None);
    };
    let trees = {
        let _permit = reads
            .background(cancelled)
            .await
            .ok_or("catalogue closed")?;
        let mut workspace = backend.clone();
        workspace.workspace.clone_from(&project.id);
        workspace.git_worktrees(false).await?
    };
    if trees.repository == Repository::Unknown {
        return Err("worktree ownership unavailable".into());
    }
    if trees.repository != Repository::Git {
        return Ok(None);
    }

    let root = trees
        .trees
        .iter()
        .find(|tree| tree.slug == "root")
        .ok_or("worktree root missing")?;
    let directory = root.service_directory.as_deref().unwrap_or(&project.path);
    let mut members = Vec::<Member>::new();
    let mut ids = HashSet::new();
    let mut id_epochs = HashMap::<String, u64>::new();
    let mut bytes = 0;
    for scope in [
        InventoryScope::NativeProject(&native),
        InventoryScope::Directory(directory),
    ] {
        let mut scope = scope;
        let mut consumed = HashSet::new();
        let mut cursor;
        loop {
            let (next, read_epoch) = {
                let _permit = reads
                    .background(cancelled)
                    .await
                    .ok_or("catalogue closed")?;
                let epoch = presence_epoch
                    .fetch_add(1, Ordering::SeqCst)
                    .wrapping_add(1);
                (backend.session_inventory(project, scope).await?, epoch)
            };
            for member in next.members {
                id_epochs
                    .entry(member.session.id.clone())
                    .and_modify(|e| *e = (*e).max(read_epoch))
                    .or_insert(read_epoch);
                if ids.insert(member.session.id.clone()) {
                    bytes += member.session.id.len()
                        + member.session.title.len()
                        + member.directory.len()
                        + member.parent.as_ref().map_or(0, String::len);
                    if bytes > 24 * 1024 * 1024 {
                        return Err("catalogue text budget reached".into());
                    }
                    members.push(member);
                }
            }
            let Some(next) = next.next else { break };
            let mut hash = DefaultHasher::new();
            next.hash(&mut hash);
            if consumed.len() >= 999 || !consumed.insert(hash.finish()) {
                return Err("session pagination exceeded its bound".into());
            }
            cursor = next;
            scope = InventoryScope::Continue(&cursor);
        }
    }
    let rows = super::families::rows(members, &project.path, &trees.trees, selected);
    let proofs: Vec<(String, u64)> = rows
        .iter()
        .filter_map(|row| Some((row.id.clone(), *id_epochs.get(&row.id)?)))
        .collect();
    Ok(Some((Sessions { rows, next: None }, proofs)))
}
