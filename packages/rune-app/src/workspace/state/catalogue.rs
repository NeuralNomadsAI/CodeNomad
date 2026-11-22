use super::State;
mod families;
mod inventory;

use crate::catalog::Sessions;
use codenomad_client::{Receiver, bounded, stream::CatalogueChanges};
use rune::Tx;

#[derive(Default)]
pub(super) struct Refresh {
    due: Option<f64>,
    request: Option<(u64, Receiver<Option<(Sessions, bool)>>)>,
}

impl Refresh {
    pub(super) fn schedule(&mut self, now: f64) {
        self.due.get_or_insert(now + 0.1);
    }

    pub(super) fn pause(&mut self, now: f64) {
        if self.request.take().is_some() {
            self.schedule(now);
        }
    }
}

pub(super) fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let visible = s.screen.is_launcher() || s.shell.visible(0);
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    let Some(ui) = &mut s.workspace else {
        return false;
    };
    if let Some(watch) = &l.catalogue_watch {
        let changes = watch.take();
        for entry in &mut ui.entries {
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
        .is_some_and(|(generation, _)| *generation != l.catalogue_generation)
    {
        refresh.pause(now);
    }
    if !visible
        || l.pending
        || entry.project.as_ref().map(|p| &p.id) != l.project.as_ref().map(|p| &p.id)
    {
        refresh.pause(now);
        return false;
    }
    let mut changed = false;
    if let Some(result) = refresh
        .request
        .as_ref()
        .and_then(|(_, rx)| rx.try_recv().ok())
    {
        refresh.request = None;
        if refresh.due.is_none()
            && let Some((page, authoritative)) = result
        {
            let selected = match &entry.saved {
                super::Tab::Workspace(w) => w.active_session_id.as_deref(),
                _ => None,
            };
            if let Some(row) = page
                .rows
                .iter()
                .find(|row| Some(row.id.as_str()) == selected)
            {
                s.chat_title.clone_from(&row.title);
            }
            l.apply_passive_listing(page, selected, authoritative);
            changed = true;
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
            let (backend, project, reads, wake) = (
                backend.clone(),
                project.clone(),
                s.reads.clone(),
                s.wake.clone(),
            );
            let selected = match &entry.saved {
                super::Tab::Workspace(w) => w.active_session_id.clone(),
                _ => None,
            };
            refresh.due = None;
            refresh.request = Some((l.catalogue_generation, input));
            crate::platform::spawn(async move {
                let read = async {
                    let can_replace = match inventory::load(
                        &backend,
                        &project,
                        selected.as_deref(),
                        &reads,
                        &cancelled,
                    )
                    .await
                    {
                        Ok(Some(projected)) => return Some((projected, true)),
                        Ok(None) => true,
                        Err(_) => false,
                    };
                    let _permit = reads.background(&cancelled).await?;
                    backend
                        .sessions(&project, None)
                        .await
                        .ok()
                        .map(|page| (page, can_replace))
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
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{catalog::Project, workspace};

    #[test]
    fn opening_a_second_project_schedules_a_read_without_an_sse_hint() {
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
                },
            );
            workspace::new_tab(s, tx);
            workspace::opened(
                s,
                &Project {
                    id: "second".into(),
                    path: "/second".into(),
                },
            );
            let ui = s.workspace.as_ref().unwrap();
            assert!(ui.entries[ui.active].catalogue.due.is_some());
            assert!(s.screen.launcher().unwrap().catalogue_watch.is_none());
        });
    }
}
