//! Publish root sessions independently; each linked location owns its native cursor.
use crate::{
    State,
    catalog::Session,
    history::Result,
    platform::{self, reads},
};
use codenomad_client::{Receiver, Sender, bounded};
use std::collections::VecDeque;

#[derive(Clone, Default)]
pub(crate) struct Pages {
    pub rows: Vec<Session>,
    next: VecDeque<(String, String)>,
}
impl Pages {
    pub fn more(&self) -> bool {
        !self.next.is_empty()
    }
}
#[derive(Default)]
pub(crate) struct Linked {
    pub pages: Option<Pages>,
    job: Option<(Sender<()>, Receiver<Result<Pages>>)>,
    pub failed: bool,
}
impl Linked {
    pub fn pending(&self) -> bool {
        self.job.is_some()
    }
}

pub(super) fn load(s: &mut State, more: bool) {
    let reads = s.reads.clone();
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(backend), Some(project)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    let old = if more {
        if l.linked.pending() {
            return;
        }
        let Some(pages) = l.linked.pages.clone().filter(Pages::more) else {
            return;
        };
        Some(pages)
    } else {
        None
    };
    let wake = l.wake.clone();
    let (cancel, cancelled) = bounded(1);
    let (out, input) = bounded(1);
    l.linked.job = Some((cancel, input));
    l.linked.failed = false;
    platform::spawn(async move {
        let read = async {
            let Some(_slot) = reads.background(&cancelled).await else {
                return;
            };
            let result = async {
                let (mut pages, targets) = match old {
                    Some(mut pages) => {
                        let (directory, cursor) =
                            pages.next.pop_front().ok_or("missing linked cursor")?;
                        (pages, vec![(directory, Some(cursor))])
                    }
                    None => (
                        Pages::default(),
                        backend
                            .linked_session_directories(&project)
                            .await?
                            .into_iter()
                            .map(|directory| (directory, None))
                            .collect(),
                    ),
                };
                let mut ids: std::collections::HashSet<_> =
                    pages.rows.iter().map(|row| row.id.clone()).collect();
                for (directory, cursor) in targets {
                    let page = backend
                        .linked_session_page(&project, &directory, cursor.as_deref())
                        .await?;
                    if page.next.is_some() && page.next == cursor {
                        return Err("linked session cursor did not advance".into());
                    }
                    if let Some(next) = page.next {
                        pages.next.push_back((directory, next));
                    }
                    pages.rows.extend(
                        page.rows
                            .into_iter()
                            .filter(|row| ids.insert(row.id.clone())),
                    );
                    if pages.rows.len() > 2000 {
                        return Err("linked session list limit reached".into());
                    }
                }
                Ok(pages)
            }
            .await;
            let _ = out.send(result).await;
            wake();
        };
        reads::cancellable(&cancelled, read).await;
    });
}

pub(super) fn poll(s: &mut State) -> bool {
    let visible = s.screen.is_launcher();
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    if visible
        && l.connection.is_some()
        && l.project.is_some()
        && l.linked.pages.is_none()
        && !l.linked.pending()
        && !l.linked.failed
    {
        load(s, false);
        return true;
    }
    let Some(result) = l.linked.job.as_ref().and_then(|(_, r)| r.try_recv().ok()) else {
        return false;
    };
    l.linked.job = None;
    match result {
        Ok(pages) => l.linked.pages = Some(pages),
        Err(_) => l.linked.failed = true,
    }
    true
}
