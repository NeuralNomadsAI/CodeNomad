use super::State;
mod families;
mod inventory;

use crate::catalog::Sessions;
use codenomad_client::{Receiver, bounded, stream::CatalogueChanges};
use rune::Tx;
use std::{
    collections::{HashMap, HashSet},
    hash::{DefaultHasher, Hash, Hasher},
    sync::atomic::{AtomicU64, Ordering},
};

type PresenceProofs = Vec<(String, u64)>;
pub(super) type RefreshResult = (Sessions, bool, bool, PresenceProofs);

enum LinkedCheck {
    Page(Sessions, PresenceProofs),
    Removed,
    Unverified,
}

async fn load_linked_target_all(
    backend: &crate::backend::Backend,
    project: &crate::catalog::Project,
    target_dir: &str,
    reads: &crate::platform::reads::Reads,
    cancelled: &Receiver<()>,
    presence_epoch: &AtomicU64,
) -> Option<crate::history::Result<(Sessions, PresenceProofs)>> {
    let mut rows = Vec::new();
    let mut ids = HashSet::new();
    let mut id_epochs = HashMap::<String, u64>::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    let mut bytes = 0usize;
    loop {
        let (page, read_epoch) = {
            let _permit = reads.background(cancelled).await?;
            let epoch = presence_epoch
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1);
            (
                backend
                    .linked_session_page(project, target_dir, cursor.as_deref())
                    .await,
                epoch,
            )
        };
        let page = match page {
            Ok(page) => page,
            Err(err) if cursor.is_none() => return Some(Err(err)),
            Err(_) => return Some(Err("linked target pagination incomplete".into())),
        };
        for row in page.rows {
            id_epochs
                .entry(row.id.clone())
                .and_modify(|e| *e = (*e).max(read_epoch))
                .or_insert(read_epoch);
            if ids.insert(row.id.clone()) {
                bytes += row.id.len() + row.title.len();
                if bytes > 24 * 1024 * 1024 {
                    return Some(Err("linked target text budget reached".into()));
                }
                rows.push(row);
                if rows.len() >= 2_000 {
                    let proofs = rows
                        .iter()
                        .filter_map(|r| Some((r.id.clone(), *id_epochs.get(&r.id)?)))
                        .collect();
                    return Some(Ok((Sessions { rows, next: None }, proofs)));
                }
            }
        }
        let Some(next) = page.next else {
            let proofs = rows
                .iter()
                .filter_map(|r| Some((r.id.clone(), *id_epochs.get(&r.id)?)))
                .collect();
            return Some(Ok((Sessions { rows, next: None }, proofs)));
        };
        let mut hash = DefaultHasher::new();
        next.hash(&mut hash);
        if seen_cursors.len() >= 999 || !seen_cursors.insert(hash.finish()) {
            return Some(Err("linked target pagination exceeded its bound".into()));
        }
        cursor = Some(next);
    }
}

async fn verify_uncertain_linked(
    backend: &crate::backend::Backend,
    project: &crate::catalog::Project,
    target_dir: &str,
    reads: &crate::platform::reads::Reads,
    cancelled: &Receiver<()>,
    presence_epoch: &AtomicU64,
) -> Option<LinkedCheck> {
    match load_linked_target_all(
        backend,
        project,
        target_dir,
        reads,
        cancelled,
        presence_epoch,
    )
    .await?
    {
        Ok((target_page, proofs)) => return Some(LinkedCheck::Page(target_page, proofs)),
        Err(err) if !err.is::<codenomad_client::catalog::LocationUnavailable>() => {
            return Some(LinkedCheck::Unverified);
        }
        Err(_) => {}
    }
    let trees = {
        let _permit = reads.background(cancelled).await?;
        let mut workspace = backend.clone();
        workspace.workspace.clone_from(&project.id);
        workspace.git_worktrees(true).await
    };
    let target_absent = trees.ok().is_some_and(|trees| {
        matches!(
            trees.repository,
            codenomad_client::git::Repository::Git
                | codenomad_client::git::Repository::Uninitialized
        ) && !trees.trees.iter().any(|tree| {
            !tree.missing
                && (codenomad_client::same_server_path(&tree.directory, target_dir)
                    || tree.service_directory.as_deref().is_some_and(|service| {
                        codenomad_client::same_server_path(service, target_dir)
                    }))
        })
    });
    if !target_absent {
        return Some(LinkedCheck::Unverified);
    }
    Some(
        match load_linked_target_all(
            backend,
            project,
            target_dir,
            reads,
            cancelled,
            presence_epoch,
        )
        .await?
        {
            Ok((target_page, proofs)) => LinkedCheck::Page(target_page, proofs),
            Err(err) if err.is::<codenomad_client::catalog::LocationUnavailable>() => {
                LinkedCheck::Removed
            }
            Err(_) => LinkedCheck::Unverified,
        },
    )
}

#[derive(Default)]
pub(super) struct Refresh {
    due: Option<f64>,
    pub(super) urgent: bool,
    reset_cursor: bool,
    pub(super) request: Option<(u64, u64, Receiver<Option<RefreshResult>>)>,
}

impl Refresh {
    pub(super) fn schedule(&mut self, now: f64) {
        self.due.get_or_insert(now + 0.1);
    }

    pub(super) fn schedule_urgent(&mut self, now: f64) {
        self.urgent = true;
        self.reset_cursor = true;
        self.schedule(now);
    }

    pub(super) fn pause(&mut self, now: f64) {
        if self.request.take().is_some() {
            self.schedule(now);
        }
    }
}

pub(super) fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let visible = s.shell.visible(0)
        || s.screen
            .launcher()
            .is_some_and(|l| l.creation_uncertain_linked.is_some());
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    if let Some(watch) = &l.catalogue_watch {
        let changes = watch.take();
        for entry in ui
            .entries
            .iter_mut()
            .filter(|_| cfg!(target_os = "windows"))
        {
            let Some(project) = &entry.project else {
                continue;
            };
            if match &changes {
                CatalogueChanges::None => false,
                CatalogueChanges::All => true,
                CatalogueChanges::Workspaces(ids) => ids.contains(&project.id),
            } {
                entry.catalogue.schedule(now);
            }
        }
    }
    let entry = &mut ui.entries[ui.active];
    let refresh = &mut entry.catalogue;
    if refresh
        .request
        .as_ref()
        .is_some_and(|(generation, _, _)| *generation != l.catalogue_generation)
    {
        refresh.pause(now);
    }
    if (!visible && !refresh.urgent)
        || l.pending
        || entry.project.as_ref().map(|p| &p.id) != l.project.as_ref().map(|p| &p.id)
    {
        refresh.pause(now);
        return false;
    }
    let mut changed = false;
    let mut fresh_present: Option<(super::ProjectScope, PresenceProofs)> = None;
    if let Some((req_conn_gen, result)) = refresh
        .request
        .as_ref()
        .and_then(|(_, conn_gen, rx)| rx.try_recv().ok().map(|res| (*conn_gen, res)))
    {
        refresh.request = None;
        if refresh.due.is_none() {
            refresh.urgent = false;
            if let Some((page, authoritative, includes_linked, proofs)) = result {
                let (selected, scope) = match &entry.saved {
                    super::Tab::Workspace(w) => (
                        w.active_session_id.as_deref(),
                        Some(super::ProjectScope::from_workspace(w)),
                    ),
                    _ => (None, None),
                };
                if let Some(row) = page
                    .rows
                    .iter()
                    .find(|row| Some(row.id.as_str()) == selected)
                {
                    s.chat_title.clone_from(&row.title);
                }
                if !l.authentication_required
                    && req_conn_gen == l.connection_generation
                    && let Some(scope) = scope
                    && !proofs.is_empty()
                {
                    fresh_present = Some((scope, proofs));
                }
                let reset_cursor = refresh.reset_cursor;
                if authoritative || !includes_linked {
                    refresh.reset_cursor = false;
                }
                l.apply_passive_listing(
                    page,
                    selected,
                    authoritative,
                    includes_linked,
                    reset_cursor,
                );
                changed = true;
            }
        }
    }
    if let (None, Some(due), Some(backend), Some(project)) =
        (&refresh.request, refresh.due, &l.connection, &l.project)
    {
        if due > now {
            tx.wake_at(due);
        } else {
            let (out, input) = bounded(1);
            let (owner, cancelled) = bounded(1);
            let (backend, project, reads, wake, presence_epoch) = (
                backend.clone(),
                project.clone(),
                s.reads.clone(),
                s.wake.clone(),
                ui.restored_draft_presence_epoch.clone(),
            );
            let selected = match &entry.saved {
                super::Tab::Workspace(w) => w.active_session_id.clone(),
                _ => None,
            };
            let uncertain_linked = l.creation_uncertain_linked.clone();
            refresh.due = None;
            refresh.request = Some((l.catalogue_generation, l.connection_generation, input));
            crate::platform::spawn(async move {
                let read = async {
                    let can_replace = match inventory::load(
                        &backend,
                        &project,
                        selected.as_deref(),
                        &reads,
                        &cancelled,
                        &presence_epoch,
                    )
                    .await
                    {
                        Ok(Some((mut projected, mut proofs))) => {
                            let Some(target_dir) = uncertain_linked.as_deref() else {
                                return Some((projected, true, true, proofs));
                            };
                            let verified = match verify_uncertain_linked(
                                &backend,
                                &project,
                                target_dir,
                                &reads,
                                &cancelled,
                                &presence_epoch,
                            )
                            .await?
                            {
                                LinkedCheck::Page(target_page, linked_proofs) => {
                                    let existing: HashSet<_> =
                                        projected.rows.iter().map(|row| row.id.clone()).collect();
                                    let mut missing: Vec<_> = target_page
                                        .rows
                                        .into_iter()
                                        .filter(|row| !existing.contains(&row.id))
                                        .collect();
                                    if !missing.is_empty() {
                                        missing.extend(projected.rows);
                                        projected.rows = missing;
                                    }
                                    proofs.extend(linked_proofs);
                                    true
                                }
                                LinkedCheck::Removed => true,
                                LinkedCheck::Unverified => false,
                            };
                            return Some((projected, true, verified, proofs));
                        }
                        Ok(None) => true,
                        Err(_) => false,
                    };
                    let mut target_removed = false;
                    if let Some(target_dir) = uncertain_linked.as_deref() {
                        match verify_uncertain_linked(
                            &backend,
                            &project,
                            target_dir,
                            &reads,
                            &cancelled,
                            &presence_epoch,
                        )
                        .await?
                        {
                            LinkedCheck::Page(mut target_page, proofs) => {
                                target_page.next = None;
                                return Some((target_page, false, true, proofs));
                            }
                            LinkedCheck::Removed => target_removed = true,
                            LinkedCheck::Unverified => {}
                        }
                    }
                    let _permit = reads.background(&cancelled).await?;
                    let read_epoch = presence_epoch
                        .fetch_add(1, Ordering::SeqCst)
                        .wrapping_add(1);
                    backend.sessions(&project, None).await.ok().map(|page| {
                        let proofs = page
                            .rows
                            .iter()
                            .map(|row| (row.id.clone(), read_epoch))
                            .collect();
                        (page, can_replace, target_removed, proofs)
                    })
                };
                let result = codenomad_client::runtime::until_closed(&out, read).await;
                drop(owner);
                if let Some(result) = result {
                    let _ = out.send(result).await;
                    wake();
                }
            });
        }
    }
    if let Some((scope, proofs)) = fresh_present {
        super::drafts::note_sessions_present_in_scope_epochs(ui, &scope, proofs);
    }
    changed
}

#[cfg(test)]
mod tests {
    use crate::{catalog::Project, workspace};

    #[test]
    fn opening_a_second_project_adopts_it_without_an_sse_hint() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        state.workspace = Some(workspace::Ui::new());
        workspace::connected(&mut state);
        let mut rt = rune::Runtime::new(
            state,
            crate::view,
            (1000.0, 800.0),
            rune::Env::new(false, 1.0),
        );
        rt.update(|s, tx| {
            workspace::opened(
                s,
                &Project {
                    id: "first".into(),
                    path: "/first".into(),
                    temporary: false,
                },
            );
            workspace::new_tab(s, tx);
            workspace::opened(
                s,
                &Project {
                    id: "second".into(),
                    path: "/second".into(),
                    temporary: false,
                },
            );
            let ui = s.workspace.as_ref().unwrap();
            let entry = &ui.entries[ui.active];
            assert_eq!(
                entry.project.as_ref().map(|project| project.id.as_str()),
                Some("second")
            );
            // Opening already loads the directory page. Only Windows follows it with full inventory.
            assert_eq!(entry.catalogue.due.is_some(), cfg!(target_os = "windows"));
            assert!(s.screen.launcher().unwrap().catalogue_watch.is_none());
        });
    }

    #[test]
    fn urgent_refresh_stays_armed_when_trailing_due_coalesces() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        state.workspace = Some(workspace::Ui::new());
        workspace::connected(&mut state);
        let mut rt = rune::Runtime::new(
            state,
            crate::view,
            (1000.0, 800.0),
            rune::Env::new(false, 1.0),
        );
        rt.update(|s, tx| {
            let project = Project {
                id: "p1".into(),
                path: "/repo".into(),
                temporary: false,
            };
            s.screen.launcher_mut().unwrap().project = Some(project.clone());
            workspace::opened(s, &project);
            s.shell.wanted = [Some([false, false]); 2];
            assert!(!s.shell.visible(0));
            let (out, rx) = codenomad_client::bounded(1);
            let generation = s.screen.launcher().unwrap().catalogue_generation;
            let conn_gen = s.screen.launcher().unwrap().connection_generation;
            let ui = s.workspace.as_mut().unwrap();
            let entry = &mut ui.entries[ui.active];
            entry.catalogue.urgent = true;
            entry.catalogue.request = Some((generation, conn_gen, rx));
            entry.catalogue.due = Some(2.0);
            assert!(out.try_send(None).is_ok());
            let _ = super::poll(s, 1.0, tx);
            let entry = &s.workspace.as_ref().unwrap().entries[0];
            assert!(
                entry.catalogue.urgent,
                "urgent must remain set while a coalesced trailing read is queued"
            );
            assert!(entry.catalogue.due.is_some());
        });
    }
}
