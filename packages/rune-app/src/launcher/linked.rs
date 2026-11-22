//! Publish root sessions independently; each linked location owns its native cursor.
use crate::{
    State,
    catalog::Session,
    history::Result,
    platform::{self, reads},
};
use codenomad_client::{Receiver, Sender, bounded};
use std::collections::HashSet;

#[derive(Clone, Default)]
pub(crate) struct Pages {
    pub rows: Vec<Session>,
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

pub(super) fn load(s: &mut State) {
    let reads = s.reads.clone();
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(backend), Some(project)) = (l.connection.clone(), l.project.clone()) else {
        return;
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
                let mut pages = Pages::default();
                let mut ids = HashSet::new();
                let mut budget = 1000; // Includes empty pages, across all linked locations.
                for directory in backend.linked_session_directories(&project).await? {
                    let mut cursor = None;
                    let mut seen = HashSet::new();
                    loop {
                        if budget == 0 {
                            return Err("linked session page limit reached".into());
                        }
                        budget -= 1;
                        let page = backend
                            .linked_session_page(&project, &directory, cursor.as_deref())
                            .await?;
                        pages.rows.extend(
                            page.rows
                                .into_iter()
                                .filter(|row| ids.insert(row.id.clone())),
                        );
                        if pages.rows.len() > 2000 {
                            return Err("linked session list limit reached".into());
                        }
                        let Some(next) = page.next else { break };
                        if !seen.insert(next.clone()) {
                            return Err("repeated linked session cursor".into());
                        }
                        cursor = Some(next);
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
        && !l.pending
        && !l.linked.pending()
        && !l.linked.failed
    {
        load(s);
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
