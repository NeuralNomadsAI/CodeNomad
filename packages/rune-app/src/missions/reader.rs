mod body_cache;
#[cfg(test)]
mod tests;
pub(super) mod view;

use self::body_cache::{BodyCache, MAX_WHOLE_BODY_UNITS};
pub(super) use self::body_cache::{BodyKey, BodyStatus, BodyView};
use super::detail::Snapshot;
use crate::{components::window_close_button::WindowCloseState, platform::reads::Reads};
use codenomad_client::{
    Wake,
    backend::Backend,
    missions::{BodyDescriptor, ContentSelector},
};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ReaderTarget {
    Overview {
        mission_id: String,
    },
    Task {
        mission_id: String,
        task_id: String,
        task_key: String,
    },
}

impl ReaderTarget {
    pub(crate) fn mission_id(&self) -> &str {
        match self {
            Self::Overview { mission_id } | Self::Task { mission_id, .. } => mission_id,
        }
    }
}

#[derive(Default)]
pub(crate) struct Reader {
    target: Option<ReaderTarget>,
    pub(super) close: WindowCloseState,
    cache: BodyCache,
    pages: HashMap<String, usize>,
    pending_copy: Option<BodyKey>,
    ready_copy: Option<String>,
}

impl Reader {
    pub(crate) fn is_open(&self) -> bool {
        self.target.is_some()
    }

    pub(crate) fn target(&self) -> Option<&ReaderTarget> {
        self.target.as_ref()
    }

    pub(crate) fn is_overview_open(&self, mission_id: &str) -> bool {
        matches!(
            &self.target,
            Some(ReaderTarget::Overview { mission_id: id }) if id == mission_id
        )
    }

    pub(crate) fn is_task_open(&self, mission_id: &str, task_id: &str) -> bool {
        matches!(
            &self.target,
            Some(ReaderTarget::Task { mission_id: mid, task_id: tid, .. })
                if mid == mission_id && tid == task_id
        )
    }

    pub(crate) fn open_overview(&mut self, mission_id: String) {
        let next = ReaderTarget::Overview { mission_id };
        if self.target.as_ref() != Some(&next) {
            self.cache.cancel_all_flights();
            self.pages.clear();
            self.pending_copy = None;
            self.ready_copy = None;
            self.target = Some(next);
        }
    }

    pub(crate) fn open_task(&mut self, mission_id: String, task_id: String, task_key: String) {
        let next = ReaderTarget::Task {
            mission_id,
            task_id,
            task_key,
        };
        if self.target.as_ref() != Some(&next) {
            self.cache.cancel_all_flights();
            self.pages.clear();
            self.pending_copy = None;
            self.ready_copy = None;
            self.target = Some(next);
        }
    }

    pub(crate) fn toggle_overview(&mut self, mission_id: String) -> bool {
        if self.is_overview_open(&mission_id) {
            self.close();
            false
        } else {
            self.open_overview(mission_id);
            true
        }
    }

    pub(crate) fn toggle_task(
        &mut self,
        mission_id: String,
        task_id: String,
        task_key: String,
    ) -> bool {
        if self.is_task_open(&mission_id, &task_id) {
            self.close();
            false
        } else {
            self.open_task(mission_id, task_id, task_key);
            true
        }
    }

    pub(crate) fn close(&mut self) {
        self.cache.cancel_all_flights();
        self.target = None;
        self.pages.clear();
        self.pending_copy = None;
        self.ready_copy = None;
        self.cache.evict_unused(&HashSet::new());
    }

    pub(crate) fn suspend(&mut self) {
        self.cache.suspend();
        self.pending_copy = None;
        self.ready_copy = None;
    }

    pub(crate) fn invalidate(&mut self) {
        self.cache.invalidate_all();
    }

    pub(crate) fn follow_selection(&mut self, selected: Option<&str>) {
        let Some(target) = &self.target else {
            return;
        };
        match selected {
            None => self.close(),
            Some(id) if id != target.mission_id() => self.open_overview(id.to_owned()),
            Some(_) => {}
        }
    }

    pub(super) fn page(&self, section: &str) -> usize {
        self.pages.get(section).copied().unwrap_or(0)
    }

    pub(super) fn set_page(&mut self, section: &str, page: usize) {
        self.pages.insert(section.to_owned(), page);
    }

    pub(super) fn retry(&mut self, key: &BodyKey) {
        self.cache.retry(key);
    }

    /// Returns text immediately when the whole digest is already loaded; otherwise queues a
    /// whole-body fetch whose completion is drained through `take_ready_copy`.
    pub(super) fn request_copy(&mut self, key: BodyKey) -> Option<String> {
        if let Some(text) = self.cache.complete_text(&key) {
            self.pending_copy = None;
            return Some(text.to_owned());
        }
        if self.cache.body_view(&key).status == BodyStatus::Error {
            self.cache.retry(&key);
        }
        self.pending_copy = Some(key);
        None
    }

    pub(crate) fn take_ready_copy(&mut self) -> Option<String> {
        self.ready_copy.take()
    }

    pub(crate) fn take_auth_expired(&mut self) -> Option<Backend> {
        self.cache.take_auth_expired()
    }

    pub(super) fn body_view(
        &self,
        project_id: &str,
        mission_id: &str,
        selector: &ContentSelector,
    ) -> BodyView<'_> {
        let key = (
            project_id.to_owned(),
            mission_id.to_owned(),
            selector.clone(),
        );
        self.cache.body_view(&key)
    }

    pub(super) fn poll(
        &mut self,
        backend: &Backend,
        project_id: Option<&str>,
        snapshot: Option<&Snapshot>,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        let mut changed = self.cache.poll_flights(backend);

        let Some(target) = self.target.clone() else {
            return changed;
        };
        let Some(project_id) = project_id else {
            return changed;
        };
        let Some(snapshot) = snapshot.filter(|s| s.header.root.id == target.mission_id()) else {
            return changed;
        };

        let revision = snapshot.header.root.revision;
        let demands = self.collect_demands(&target, project_id, snapshot);
        changed |= self.cache.drive(backend, revision, demands, reads, wake);

        if let Some(copy_key) = self.pending_copy.clone() {
            if let Some(text) = self.cache.complete_text(&copy_key) {
                self.ready_copy = Some(text.to_owned());
                self.pending_copy = None;
                changed = true;
            } else if matches!(
                self.cache.body_view(&copy_key).status,
                BodyStatus::Error | BodyStatus::Missing
            ) {
                self.pending_copy = None;
            }
        }
        changed
    }

    fn collect_demands(
        &self,
        target: &ReaderTarget,
        project_id: &str,
        snapshot: &Snapshot,
    ) -> Vec<(BodyKey, BodyDescriptor, u64)> {
        let mut out = Vec::new();
        let copy_key = self.pending_copy.as_ref();
        let push_paged = |out: &mut Vec<(BodyKey, BodyDescriptor, u64)>,
                          section: &str,
                          selector: ContentSelector,
                          desc: Option<&BodyDescriptor>| {
            let Some(desc) = desc else {
                return;
            };
            let key = (
                project_id.to_owned(),
                target.mission_id().to_owned(),
                selector,
            );
            let need = if copy_key == Some(&key) {
                desc.characters.min(MAX_WHOLE_BODY_UNITS)
            } else {
                let page = self.page(section);
                self.cache.need_for_paged(&key, desc, page)
            };
            out.push((key, desc.clone(), need));
        };
        let push_whole = |out: &mut Vec<(BodyKey, BodyDescriptor, u64)>,
                          selector: ContentSelector,
                          desc: Option<&BodyDescriptor>| {
            let Some(desc) = desc else {
                return;
            };
            let key = (
                project_id.to_owned(),
                target.mission_id().to_owned(),
                selector,
            );
            out.push((key, desc.clone(), desc.characters.min(MAX_WHOLE_BODY_UNITS)));
        };

        match target {
            ReaderTarget::Overview { .. } => {
                let root = &snapshot.header.root;
                let has_summary = root.body("summary").is_some_and(|b| b.characters > 0);
                if has_summary {
                    push_paged(
                        &mut out,
                        "summary",
                        ContentSelector::mission("summary"),
                        root.body("summary"),
                    );
                } else if root.body("briefing").is_some_and(|b| b.characters > 0) {
                    push_whole(
                        &mut out,
                        ContentSelector::mission("briefing"),
                        root.body("briefing"),
                    );
                }
                push_paged(
                    &mut out,
                    "objective",
                    ContentSelector::mission("objective"),
                    root.body("objective"),
                );
                push_paged(
                    &mut out,
                    "notes",
                    ContentSelector::mission("notes"),
                    root.body("notes"),
                );
            }
            ReaderTarget::Task {
                task_id, task_key, ..
            } => {
                if let Some(task) = snapshot.tasks.find_by_id_or_key(task_id, task_key) {
                    push_paged(
                        &mut out,
                        "brief",
                        ContentSelector::task(task.key.clone(), "brief"),
                        task.body("brief"),
                    );
                    if let Some(report) = task.report() {
                        if let Some(desc) = report.body("summary") {
                            push_paged(
                                &mut out,
                                "report-summary",
                                ContentSelector::report(report.id.clone(), "summary"),
                                Some(&desc),
                            );
                        }
                        if let Some(desc) = report.body("evidence") {
                            push_whole(
                                &mut out,
                                ContentSelector::report(report.id.clone(), "evidence"),
                                Some(&desc),
                            );
                        }
                        if let Some(desc) = report.body("next") {
                            push_whole(
                                &mut out,
                                ContentSelector::report(report.id.clone(), "next"),
                                Some(&desc),
                            );
                        }
                        if let Some(desc) = report.body("artifact") {
                            push_paged(
                                &mut out,
                                "report-artifact",
                                ContentSelector::report(report.id.clone(), "artifact"),
                                Some(&desc),
                            );
                        }
                    }
                }
            }
        }
        out
    }
}
