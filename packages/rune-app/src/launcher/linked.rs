//! Publish root sessions independently; each linked location owns its native cursor.
use crate::{
    State,
    catalog::Session,
    history::Result,
    platform::{self, reads},
};
use codenomad_client::{Receiver, Sender, bounded};
use std::{
    collections::{HashSet, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
};

const MAX_BROWSED_SESSIONS: usize = 2_000;
fn cursor_hash(cursor: &str) -> u64 {
    let mut hash = DefaultHasher::new();
    cursor.hash(&mut hash);
    hash.finish()
}
#[derive(Clone, Default)]
pub(crate) struct Pages {
    pub rows: Vec<Session>,
    remaining: VecDeque<Location>,
}
#[derive(Clone, Default)]
struct Location {
    directory: String,
    cursor: Option<String>,
    seen: HashSet<u64>,
    synthetic_target: bool,
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
    pub rows: Vec<Session>,
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
        self.pages = None;
        self.force_reload = true;
    }
    pub(crate) fn replace_with_authoritative(&mut self) {
        self.job = None;
        self.rows.clear();
        self.pages = Some(Pages::default());
        self.failed = false;
        self.force_reload = false;
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
    let resume = (!force && target.is_none())
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
                        if let Some(target_dir) = target.as_deref() {
                            if let Some(pos) = remaining.iter().position(|loc| {
                                codenomad_client::same_server_path(&loc.directory, target_dir)
                            }) {
                                if pos > 0
                                    && let Some(priority) = remaining.remove(pos)
                                {
                                    remaining.push_front(priority);
                                }
                            } else {
                                remaining.push_front(Location {
                                    directory: target_dir.to_owned(),
                                    synthetic_target: true,
                                    ..Default::default()
                                });
                            }
                        }
                        Pages {
                            rows: Vec::new(),
                            remaining,
                        }
                    }
                };
                let mut ids = pages.rows.iter().map(|row| row.id.clone()).collect();
                let mut target_verified = false;
                let mut deferred_target: Option<Location> = None;
                for _ in 0..1000 {
                    let Some(mut location) = pages.remaining.pop_front() else {
                        break;
                    };
                    let matches_target = target.as_deref().is_some_and(|target_dir| {
                        codenomad_client::same_server_path(&location.directory, target_dir)
                    });
                    let page = match backend
                        .linked_session_page(
                            &project,
                            &location.directory,
                            location.cursor.as_deref(),
                        )
                        .await
                    {
                        Ok(page) => page,
                        Err(err) => {
                            if location.synthetic_target {
                                if err.is::<codenomad_client::catalog::LocationUnavailable>() {
                                    let mut workspace = backend.clone();
                                    workspace.workspace.clone_from(&project.id);
                                    let target_absent = workspace
                                        .git_worktrees(true)
                                        .await
                                        .ok()
                                        .is_some_and(|trees| {
                                            matches!(
                                                trees.repository,
                                                codenomad_client::git::Repository::Git
                                                    | codenomad_client::git::Repository::Uninitialized
                                            ) && !trees.trees.iter().any(|tree| {
                                                    !tree.missing
                                                        && (codenomad_client::same_server_path(
                                                            &tree.directory,
                                                            &location.directory,
                                                        ) || tree
                                                            .service_directory
                                                            .as_deref()
                                                            .is_some_and(|service| {
                                                                codenomad_client::same_server_path(
                                                                    service,
                                                                    &location.directory,
                                                                )
                                                            }))
                                                })
                                        });
                                    if target_absent {
                                        match backend
                                            .linked_session_page(
                                                &project,
                                                &location.directory,
                                                location.cursor.as_deref(),
                                            )
                                            .await
                                        {
                                            Ok(page) => page,
                                            Err(retry_err)
                                                if retry_err.is::<codenomad_client::catalog::LocationUnavailable>() =>
                                            {
                                                target_verified = true;
                                                continue;
                                            }
                                            Err(_) => {
                                                deferred_target = Some(location);
                                                continue;
                                            }
                                        }
                                    } else {
                                        deferred_target = Some(location);
                                        continue;
                                    }
                                } else {
                                    deferred_target = Some(location);
                                    continue;
                                }
                            } else {
                                pages.remaining.push_front(location);
                                break;
                            }
                        }
                    };
                    let kept_all = pages.keep(page.rows, &mut ids);
                    if matches_target && (kept_all && page.next.is_none() || !kept_all) {
                        target_verified = true;
                    }
                    if !kept_all {
                        pages.remaining.push_front(location);
                        break;
                    }
                    if let Some(next) = page.next {
                        if location.seen.len() >= 1000 || !location.seen.insert(cursor_hash(&next))
                        {
                            pages.remaining.push_front(location);
                            break;
                        }
                        location.cursor = Some(next);
                        if matches_target {
                            pages.remaining.push_front(location);
                        } else {
                            pages.remaining.push_back(location);
                        }
                    }
                }
                if let Some(location) = deferred_target {
                    pages.remaining.push_front(location);
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
        Ok((pages, complete, target_verified)) => {
            if complete {
                l.linked.rows = pages.rows.clone();
            } else {
                let mut display = pages.rows.clone();
                let mut seen: HashSet<String> = display.iter().map(|row| row.id.clone()).collect();
                for row in &l.linked.rows {
                    if display.len() == MAX_BROWSED_SESSIONS {
                        break;
                    }
                    if seen.insert(row.id.clone()) {
                        display.push(row.clone());
                    }
                }
                l.linked.rows = display;
            }
            l.linked.pages = Some(pages);
            l.linked.failed = !complete;
            if target_verified && l.creation_uncertain_linked.is_some() {
                l.creation_uncertain = false;
                l.creation_uncertain_linked = None;
                if l.error == Some("rune.create_error") {
                    l.error = None;
                }
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
        s.screen = crate::Screen::Launcher(Box::new(crate::launcher::Launcher::fixture()));
        let deleted = Session {
            id: "existing".into(),
            title: "Existing".into(),
        };
        {
            let l = s.screen.launcher_mut().unwrap();
            l.linked.rows.push(deleted);
            let mut stale = Pages::default();
            stale.remaining.push_back(Location {
                directory: "/wt-other".into(),
                cursor: Some("stale".into()),
                ..Default::default()
            });
            l.linked.pages = Some(stale);
            l.linked.mark_reload();
            assert!(
                l.linked.rows.len() == 1 && l.linked.rows[0].id == "existing",
                "mark_reload must retain previous display snapshot"
            );
            assert!(
                l.linked.pages.is_none(),
                "mark_reload must discard stale pagination cursors"
            );
            assert!(l.linked.force_reload);
        }
        let (cancel, _cancelled) = bounded(1);
        let (out, input) = bounded(1);
        {
            let l = s.screen.launcher_mut().unwrap();
            l.creation_uncertain = true;
            l.creation_uncertain_linked = Some("/wt-target".into());
            l.error = Some("rune.create_error");
            l.linked.force_reload = false;
            l.linked.job = Some((cancel, input));
        }
        let mut pages = Pages::default();
        pages.rows.push(Session {
            id: "fresh".into(),
            title: "Fresh".into(),
        });
        pages.remaining.push_back(Location {
            directory: "/wt-target".into(),
            cursor: Some("next".into()),
            ..Default::default()
        });
        // Partial refresh before verifying the target worktree keeps creation locked, preserves
        // retained rows in the display snapshot, and keeps the pagination accumulator clean.
        assert!(out.try_send(Ok((pages.clone(), false, false))).is_ok());
        assert!(poll(&mut s));
        let l = s.screen.launcher().unwrap();
        assert!(l.creation_uncertain);
        assert!(l.creation_uncertain_linked.is_some());
        assert!(
            l.linked.rows.iter().any(|row| row.id == "existing"),
            "partial refresh must preserve previously retained display rows"
        );
        assert!(
            l.linked
                .pages
                .as_ref()
                .is_some_and(|p| p.rows.iter().all(|row| row.id != "existing")),
            "pagination accumulator must stay uncontaminated by retained display rows"
        );

        // Once the target worktree's first page is verified, creation unlocks even if capped overall.
        let (cancel, _cancelled) = bounded(1);
        let (out, input) = bounded(1);
        s.screen.launcher_mut().unwrap().linked.job = Some((cancel, input));
        assert!(out.try_send(Ok((pages.clone(), false, true))).is_ok());
        assert!(poll(&mut s));
        let l = s.screen.launcher().unwrap();
        assert!(!l.creation_uncertain);
        assert!(l.creation_uncertain_linked.is_none());
        assert_eq!(l.error, None);
        assert!(l.linked.failed);

        // Completing the resumed pagination replaces the display snapshot, purging deleted rows.
        let (cancel, _cancelled) = bounded(1);
        let (out, input) = bounded(1);
        s.screen.launcher_mut().unwrap().linked.job = Some((cancel, input));
        let mut completed = pages;
        completed.remaining.clear();
        assert!(out.try_send(Ok((completed, true, true))).is_ok());
        assert!(poll(&mut s));
        let l = s.screen.launcher().unwrap();
        assert!(!l.linked.failed);
        assert_eq!(
            l.linked
                .rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["fresh"]
        );
    }

    #[test]
    fn full_cache_does_not_verify_target_first_page() {
        let mut pages = Pages::default();
        let mut ids = HashSet::new();
        let filler: Vec<Session> = (0..MAX_BROWSED_SESSIONS)
            .map(|id| Session {
                id: format!("old-{id}"),
                title: String::new(),
            })
            .collect();
        assert!(pages.keep(filler, &mut ids));
        let target_rows = vec![Session {
            id: "target-new".into(),
            title: "New".into(),
        }];
        // Even with non-empty pages.rows, a full cache cannot admit the target page.
        assert!(!pages.keep(target_rows, &mut ids));
        assert_eq!(pages.rows.len(), MAX_BROWSED_SESSIONS);
        assert!(pages.rows.iter().all(|row| row.id != "target-new"));
    }
}
