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
    force_reload: bool,
}
impl Linked {
    pub fn pending(&self) -> bool {
        self.job.is_some()
    }
    pub(crate) fn mark_reload(&mut self) {
        self.job = None;
        self.force_reload = true;
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
    let force = std::mem::take(&mut l.linked.force_reload);
    let target = l.creation_uncertain_linked.clone();
    let resume = (!force)
        .then(|| {
            l.linked
                .pages
                .as_ref()
                .filter(|pages| l.linked.failed && !pages.remaining.is_empty())
                .cloned()
        })
        .flatten();
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
                let fresh = resume.is_none();
                let mut pages = match resume {
                    Some(pages) => pages,
                    None => {
                        let mut remaining: VecDeque<Location> = backend
                            .linked_session_directories(&project)
                            .await?
                            .into_iter()
                            .map(|directory| Location {
                                directory,
                                ..Default::default()
                            })
                            .collect();
                        if let Some(target_dir) = target.as_deref()
                            && let Some(pos) = remaining.iter().position(|loc| {
                                codenomad_client::same_server_path(&loc.directory, target_dir)
                            })
                            && pos > 0
                        {
                            if let Some(priority) = remaining.remove(pos) {
                                remaining.push_front(priority);
                            }
                        }
                        Pages {
                            rows: Vec::new(),
                            remaining,
                        }
                    }
                };
                let mut ids = pages.rows.iter().map(|row| row.id.clone()).collect();
                let target_matched = target.as_deref().is_some_and(|target_dir| {
                    pages
                        .remaining
                        .iter()
                        .any(|loc| codenomad_client::same_server_path(&loc.directory, target_dir))
                });
                let mut unverified_first_pages = if fresh && target.is_some() && !target_matched {
                    pages.remaining.len()
                } else {
                    0
                };
                let mut target_verified =
                    fresh && target.is_some() && !target_matched && unverified_first_pages == 0;
                for _ in 0..1000 {
                    let Some(mut location) = pages.remaining.pop_front() else {
                        return Ok((pages, true, true));
                    };
                    let first_page = location.cursor.is_none();
                    let matches_target = target.as_deref().is_some_and(|target_dir| {
                        codenomad_client::same_server_path(&location.directory, target_dir)
                    });
                    let Ok(page) = backend
                        .linked_session_page(
                            &project,
                            &location.directory,
                            location.cursor.as_deref(),
                        )
                        .await
                    else {
                        pages.remaining.push_front(location);
                        break;
                    };
                    let kept_all = pages.keep(page.rows, &mut ids);
                    if first_page {
                        if matches_target && (kept_all || !pages.rows.is_empty()) {
                            target_verified = true;
                        } else if !target_matched && unverified_first_pages > 0 {
                            unverified_first_pages -= 1;
                            if unverified_first_pages == 0 && (kept_all || !pages.rows.is_empty()) {
                                target_verified = true;
                            }
                        }
                    }
                    if !kept_all {
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
                if target.is_none() {
                    target_verified = complete;
                }
                Ok((pages, complete, target_verified))
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
        && !l.pending
        && !l.linked.pending()
        && (l.linked.force_reload || (l.linked.pages.is_none() && !l.linked.failed))
    {
        load(s);
        return true;
    }
    let Some(result) = l.linked.job.as_ref().and_then(|(_, r)| r.try_recv().ok()) else {
        return false;
    };
    l.linked.job = None;
    match result {
        Ok((mut pages, complete, target_verified)) => {
            if !complete && let Some(previous) = l.linked.pages.as_ref() {
                let mut seen: HashSet<String> =
                    pages.rows.iter().map(|row| row.id.clone()).collect();
                for row in &previous.rows {
                    if pages.rows.len() == MAX_BROWSED_SESSIONS {
                        break;
                    }
                    if seen.insert(row.id.clone()) {
                        pages.rows.push(row.clone());
                    }
                }
            }
            l.linked.pages = Some(pages);
            l.linked.failed = !complete;
            if target_verified && l.creation_uncertain_linked.is_some() {
                l.creation_uncertain = false;
                l.creation_uncertain_linked = None;
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
        let mut retained = Pages::default();
        retained.rows.push(Session {
            id: "existing".into(),
            title: "Existing".into(),
        });
        {
            let l = s.screen.launcher_mut().unwrap();
            l.linked.pages = Some(retained);
            l.linked.mark_reload();
            assert!(
                l.linked
                    .pages
                    .as_ref()
                    .is_some_and(|p| p.rows.len() == 1 && p.rows[0].id == "existing")
            );
            assert!(l.linked.force_reload);
        }
        let (cancel, _cancelled) = bounded(1);
        let (out, input) = bounded(1);
        {
            let l = s.screen.launcher_mut().unwrap();
            l.creation_uncertain = true;
            l.creation_uncertain_linked = Some("/wt-target".into());
            l.linked.force_reload = false;
            l.linked.job = Some((cancel, input));
        }
        let mut pages = Pages::default();
        pages.remaining.push_back(Location {
            directory: "/wt-target".into(),
            cursor: Some("next".into()),
            ..Default::default()
        });
        // Cap/error before verifying the target worktree keeps creation locked and preserves retained rows.
        assert!(out.try_send(Ok((pages.clone(), false, false))).is_ok());
        assert!(poll(&mut s));
        let l = s.screen.launcher().unwrap();
        assert!(l.creation_uncertain);
        assert!(l.creation_uncertain_linked.is_some());
        assert!(
            l.linked
                .pages
                .as_ref()
                .is_some_and(|p| p.rows.iter().any(|row| row.id == "existing")),
            "partial refresh must preserve previously retained linked rows"
        );

        // Once the target worktree's first page is verified, creation unlocks even if capped overall.
        let (cancel, _cancelled) = bounded(1);
        let (out, input) = bounded(1);
        s.screen.launcher_mut().unwrap().linked.job = Some((cancel, input));
        assert!(out.try_send(Ok((pages, false, true))).is_ok());
        assert!(poll(&mut s));
        let l = s.screen.launcher().unwrap();
        assert!(!l.creation_uncertain);
        assert!(l.creation_uncertain_linked.is_none());
        assert!(l.linked.failed);
    }
}
