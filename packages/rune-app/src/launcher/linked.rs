//! Publish root sessions independently; each linked location owns its native cursor.
use crate::{
    State,
    catalog::Session,
    history::Result,
    platform::{self, reads},
};
use codenomad_client::{Receiver, Sender, bounded};
use std::collections::{HashSet, VecDeque};

const MAX_BROWSED_SESSIONS: usize = 2_000;
#[derive(Clone, Default)]
pub(crate) struct Pages {
    pub rows: Vec<Session>,
    remaining: VecDeque<Location>,
}
#[derive(Clone, Default)]
struct Location {
    directory: String,
    cursor: Option<String>,
    seen: HashSet<String>,
}
impl Pages {
    fn keep(&mut self, rows: Vec<Session>, ids: &mut HashSet<String>) -> bool {
        for row in rows {
            if ids.insert(row.id.clone()) {
                if self.rows.len() == MAX_BROWSED_SESSIONS {
                    return false;
                }
                self.rows.push(row);
            }
        }
        true
    }
}
#[derive(Default)]
pub(crate) struct Linked {
    pub pages: Option<Pages>,
    job: Option<(Sender<()>, Receiver<Result<(Pages, bool, bool)>>)>,
    pub failed: bool,
}
impl Linked {
    pub fn pending(&self) -> bool {
        self.job.is_some()
    }
    pub(super) fn reset(&mut self) {
        self.job = None;
        self.pages = None;
        self.failed = false;
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
    let resume = l
        .linked
        .pages
        .as_ref()
        .filter(|pages| l.linked.failed && !pages.remaining.is_empty())
        .cloned();
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
                let mut pages = match resume {
                    Some(pages) => pages,
                    None => Pages {
                        rows: Vec::new(),
                        remaining: backend
                            .linked_session_directories(&project)
                            .await?
                            .into_iter()
                            .map(|directory| Location {
                                directory,
                                ..Default::default()
                            })
                            .collect(),
                    },
                };
                let mut ids = pages.rows.iter().map(|row| row.id.clone()).collect();
                let mut io_failed = false;
                for _ in 0..1000 {
                    let Some(mut location) = pages.remaining.pop_front() else {
                        return Ok((pages, true, false));
                    };
                    let Ok(page) = backend
                        .linked_session_page(
                            &project,
                            &location.directory,
                            location.cursor.as_deref(),
                        )
                        .await
                    else {
                        pages.remaining.push_front(location);
                        io_failed = true;
                        break;
                    };
                    if !pages.keep(page.rows, &mut ids) {
                        pages.remaining.push_front(location);
                        break;
                    }
                    if let Some(next) = page.next {
                        if location.seen.len() >= 1000 || !location.seen.insert(next.clone()) {
                            pages.remaining.push_front(location);
                            break;
                        }
                        location.cursor = Some(next);
                        pages.remaining.push_back(location);
                    }
                }
                let complete = pages.remaining.is_empty();
                Ok((pages, complete, io_failed))
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
        Ok((pages, complete, io_failed)) => {
            l.linked.pages = Some(pages);
            l.linked.failed = !complete;
            if !io_failed && l.creation_uncertain_linked {
                l.creation_uncertain = false;
                l.creation_uncertain_linked = false;
            }
        }
        Err(_) => l.linked.failed = true,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_overflowing_page_preserves_the_retained_rows_and_its_cursor() {
        let mut pages = Pages::default();
        pages.remaining.push_back(Location {
            cursor: Some("opaque".into()),
            ..Default::default()
        });
        let rows = (0..=MAX_BROWSED_SESSIONS)
            .map(|id| Session {
                id: id.to_string(),
                title: String::new(),
            })
            .collect();
        assert!(!pages.keep(rows, &mut HashSet::new()));
        assert_eq!(pages.rows.len(), MAX_BROWSED_SESSIONS);
        assert_eq!(pages.remaining[0].cursor.as_deref(), Some("opaque"));
    }

    #[test]
    fn capped_error_free_refresh_clears_linked_creation_uncertain() {
        let mut s = crate::init();
        s.screen = crate::Screen::Launcher(crate::launcher::Launcher::fixture());
        let (cancel, _cancelled) = bounded(1);
        let (out, input) = bounded(1);
        {
            let l = s.screen.launcher_mut().unwrap();
            l.creation_uncertain = true;
            l.creation_uncertain_linked = true;
            l.linked.job = Some((cancel, input));
        }
        let mut pages = Pages::default();
        pages.remaining.push_back(Location {
            directory: "/wt".into(),
            cursor: Some("next".into()),
            ..Default::default()
        });
        assert!(out.try_send(Ok((pages.clone(), false, true))).is_ok());
        assert!(poll(&mut s));
        let l = s.screen.launcher().unwrap();
        assert!(l.creation_uncertain);
        assert!(l.creation_uncertain_linked);

        let (cancel, _cancelled) = bounded(1);
        let (out, input) = bounded(1);
        s.screen.launcher_mut().unwrap().linked.job = Some((cancel, input));
        assert!(out.try_send(Ok((pages, false, false))).is_ok());
        assert!(poll(&mut s));
        let l = s.screen.launcher().unwrap();
        assert!(!l.creation_uncertain);
        assert!(!l.creation_uncertain_linked);
        assert!(l.linked.failed);
    }
}
