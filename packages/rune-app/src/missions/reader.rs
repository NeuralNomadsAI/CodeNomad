mod body_cache;
mod sections;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_regressions;
pub(super) mod view;

use self::body_cache::BodyCache;
pub(super) use self::body_cache::{BodyKey, BodyStatus, BodyView, MAX_WHOLE_BODY_UNITS};
use super::detail::Snapshot;
use crate::{components::window_close_button::WindowCloseState, platform::reads::Reads};
use codenomad_client::{
    Wake,
    backend::Backend,
    missions::{BodyDescriptor, ContentSelector, Report, ReportOutcome, Status, Task, TaskStatus},
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

/// Authoritative current report for a task, matching Solid's `missionTaskReport` and resolving
/// body descriptors from `Snapshot::reports` (where the compact map projection stores them).
pub(super) fn current_task_report<'a>(
    snapshot: &'a Snapshot,
    task: &'a Task,
) -> Option<&'a Report> {
    let nested = task.report()?;
    if nested.is_late() || nested.task_key != task.key || task.replaced_by_task_key().is_some() {
        return None;
    }
    let expected = match nested.outcome {
        ReportOutcome::Completed => TaskStatus::Completed,
        ReportOutcome::Blocked => TaskStatus::NeedsInput,
        ReportOutcome::Failed => TaskStatus::Failed,
    };
    if task.status != expected {
        return None;
    }
    if let Some(generation) = nested.native_call_generation()
        && Some(generation) != task.contract_generation()
    {
        return None;
    }
    snapshot
        .report(&nested.id)
        .filter(|top| top.task_key == task.key && top.same_compact_report(nested))
        .or(Some(nested))
}

/// Retained non-current reports for a task (late or superseded attempts), newest first.
pub(super) fn task_history_reports<'a>(snapshot: &'a Snapshot, task: &'a Task) -> Vec<&'a Report> {
    let current_id = current_task_report(snapshot, task).map(|report| report.id.as_str());
    let mut by_id: HashMap<&str, &'a Report> = HashMap::new();
    for report in snapshot.task_reports(&task.key) {
        if Some(report.id.as_str()) != current_id {
            by_id.insert(report.id.as_str(), report);
        }
    }
    for nested in task.report().into_iter().chain(task.late_reports()) {
        if nested.task_key == task.key && Some(nested.id.as_str()) != current_id {
            by_id.entry(nested.id.as_str()).or_insert_with(|| {
                snapshot
                    .report(&nested.id)
                    .filter(|top| top.task_key == task.key && top.same_compact_report(nested))
                    .unwrap_or(nested)
            });
        }
    }
    let mut list: Vec<&'a Report> = by_id.into_values().collect();
    list.sort_unstable_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    list
}

/// Overview fallback when a Mission has neither a final summary nor a briefing: top 3 recorded
/// completed task results and (when active) top 3 open obstacles.
pub(super) fn overview_progress<'a>(
    snapshot: &'a Snapshot,
) -> (Vec<(&'a Task, &'a Report)>, Vec<(&'a Task, &'a Report)>) {
    let mut recorded = Vec::new();
    let mut blockers = Vec::new();
    for task in snapshot.tasks.iter() {
        if task.status == TaskStatus::Withdrawn || task.replaced_by_task_key().is_some() {
            continue;
        }
        let Some(report) = current_task_report(snapshot, task) else {
            continue;
        };
        if report.outcome == ReportOutcome::Completed {
            recorded.push((task, report));
        } else if snapshot.header.root.status == Status::Active
            && matches!(task.status, TaskStatus::NeedsInput | TaskStatus::Failed)
        {
            blockers.push((task, report));
        }
    }
    recorded.sort_unstable_by(|a, b| {
        b.1.created_at
            .cmp(&a.1.created_at)
            .then_with(|| a.0.order.cmp(&b.0.order))
    });
    (
        recorded.into_iter().take(3).collect(),
        blockers.into_iter().take(3).collect(),
    )
}

#[derive(Default)]
pub(crate) struct Reader {
    target: Option<ReaderTarget>,
    pub(super) close: WindowCloseState,
    cache: BodyCache,
    pages: HashMap<String, usize>,
    disclosures: HashSet<String>,
    pending_copy: Option<(BodyKey, Option<String>)>,
    ready_copy: Option<String>,
    return_focus: Option<String>,
    pending_lookup: Option<(String, String)>,
    lookup_missing: Option<String>,
    lookup_failed: Option<String>,
    focus_close_pending: bool,
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
                if mid == mission_id && !tid.is_empty() && tid == task_id
        )
    }

    pub(crate) fn set_return_focus(&mut self, key: String) {
        if !key.is_empty() {
            self.return_focus = Some(key);
        }
    }

    pub(crate) fn take_return_focus(&mut self) -> Option<String> {
        self.return_focus.take()
    }

    pub(crate) fn take_focus_close(&mut self) -> bool {
        std::mem::take(&mut self.focus_close_pending)
    }

    pub(super) fn request_task_lookup(&mut self, mission_id: String, task_key: String) {
        self.lookup_missing = None;
        self.lookup_failed = None;
        self.pending_lookup = Some((mission_id, task_key));
    }

    pub(super) fn pending_lookup(&self) -> Option<(&str, &str)> {
        self.pending_lookup
            .as_ref()
            .map(|(mid, key)| (mid.as_str(), key.as_str()))
    }

    pub(super) fn lookup_missing(&self) -> Option<&str> {
        self.lookup_missing.as_deref()
    }

    pub(super) fn lookup_failed(&self) -> Option<&str> {
        self.lookup_failed.as_deref()
    }

    pub(super) fn resolve_lookup(&mut self, mission_id: String, task_id: String, task_key: String) {
        self.pending_lookup = None;
        self.lookup_missing = None;
        self.lookup_failed = None;
        self.open_task(mission_id, task_id, task_key);
        self.focus_close_pending = true;
    }

    pub(super) fn fail_lookup(&mut self, task_key: String) {
        self.pending_lookup = None;
        self.lookup_failed = None;
        self.lookup_missing = Some(task_key);
    }

    pub(super) fn fail_lookup_error(&mut self, task_key: String) {
        self.pending_lookup = None;
        self.lookup_missing = None;
        self.lookup_failed = Some(task_key);
    }

    pub(super) fn clear_lookup_error(&mut self) {
        self.lookup_failed = None;
    }

    pub(crate) fn open_overview(&mut self, mission_id: String) {
        let next = ReaderTarget::Overview { mission_id };
        if self.target.as_ref() != Some(&next) {
            self.cache.cancel_all_flights();
            self.pages.clear();
            self.disclosures.clear();
            self.pending_copy = None;
            self.ready_copy = None;
            self.pending_lookup = None;
            self.lookup_missing = None;
            self.lookup_failed = None;
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
            self.disclosures.clear();
            self.pending_copy = None;
            self.ready_copy = None;
            self.pending_lookup = None;
            self.lookup_missing = None;
            self.lookup_failed = None;
            self.target = Some(next);
        }
    }

    pub(super) fn bind_task_identity(&mut self, mission_id: &str, id: &str, key: &str) {
        if let Some(ReaderTarget::Task {
            mission_id: mid,
            task_id,
            task_key,
        }) = &mut self.target
            && mid == mission_id
            && (task_id == id || task_key == key)
        {
            if task_id != id {
                *task_id = id.to_owned();
            }
            if task_key != key {
                *task_key = key.to_owned();
            }
        }
    }

    pub(crate) fn close(&mut self) {
        self.cache.cancel_all_flights();
        self.target = None;
        self.pages.clear();
        self.disclosures.clear();
        self.pending_copy = None;
        self.ready_copy = None;
        self.pending_lookup = None;
        self.lookup_missing = None;
        self.lookup_failed = None;
        self.focus_close_pending = false;
        self.cache.evict_unused(&HashSet::new());
    }

    pub(crate) fn suspend(&mut self) {
        self.cache.suspend();
        self.pending_copy = None;
        self.ready_copy = None;
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        self.cache
            .retained_bytes()
            .saturating_add(self.ready_copy.as_ref().map_or(0, String::len))
    }

    pub(crate) fn evict_cache(&mut self) -> usize {
        let mut freed = self.cache.evict_all();
        if let Some(copy) = self.ready_copy.take() {
            freed = freed.saturating_add(copy.len());
        }
        self.pending_copy = None;
        freed
    }

    #[cfg(test)]
    pub(crate) fn fixture_cache_body(&mut self, mission_id: &str, text: String) {
        self.cache.fixture_insert_body(
            (
                mission_id.into(),
                "fixture".into(),
                ContentSelector::mission("summary"),
            ),
            text,
        );
    }

    pub(crate) fn invalidate(&mut self) {
        self.cache.invalidate_all();
        self.lookup_missing = None;
        self.lookup_failed = None;
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

    pub(super) fn is_disclosure_open(&self, id: &str) -> bool {
        self.disclosures.contains(id)
    }

    pub(super) fn toggle_disclosure(&mut self, id: &str) {
        if !self.disclosures.remove(id) {
            self.disclosures.insert(id.to_owned());
        }
    }

    pub(super) fn retry(&mut self, key: &BodyKey) {
        self.cache.retry(key);
    }

    /// Returns text immediately when the whole clicked digest is already loaded; otherwise queues
    /// a whole-body fetch bound to that digest. Bodies beyond `MAX_WHOLE_BODY_UNITS` are never
    /// silently truncated into the clipboard.
    pub(super) fn request_copy(
        &mut self,
        key: BodyKey,
        expected_digest: Option<String>,
        characters: u64,
    ) -> Option<String> {
        if self
            .target
            .as_ref()
            .is_none_or(|target| target.mission_id() != key.1)
        {
            self.pending_copy = None;
            return None;
        }
        if characters > MAX_WHOLE_BODY_UNITS {
            self.pending_copy = None;
            return None;
        }
        if let Some(text) = self.cache.complete_text(&key, expected_digest.as_deref()) {
            self.pending_copy = None;
            return Some(text.to_owned());
        }
        if self.cache.body_view(&key).status == BodyStatus::Error {
            self.cache.retry(&key);
        }
        self.pending_copy = Some((key, expected_digest));
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
        let active_snap = self.target.as_ref().and_then(|target| {
            let project_id = project_id?;
            let snapshot = snapshot.filter(|s| s.header.root.id == target.mission_id())?;
            Some((target.clone(), project_id, snapshot))
        });

        // Synchronize expected `(revision, digest)` BEFORE draining in-flight completions so a
        // body from an older revision completing in the same poll cannot publish over a newer header.
        if let Some((ref target, project_id, snapshot)) = active_snap {
            let pre_demands = self.collect_demands(target, project_id, snapshot);
            self.cache
                .sync_expectations(snapshot.header.root.revision, &pre_demands);
        }

        let mut changed = self.cache.poll_flights(backend);

        let Some((target, project_id, snapshot)) = active_snap else {
            self.pending_copy = None;
            return changed;
        };

        let revision = snapshot.header.root.revision;
        let demands = self.collect_demands(&target, project_id, snapshot);
        let active_digests: HashMap<BodyKey, (String, u64)> = demands
            .iter()
            .map(|(k, d, _)| (k.clone(), (d.digest.clone(), d.characters)))
            .collect();
        changed |= self.cache.drive(backend, revision, demands, reads, wake);

        if let Some((copy_key, exp_digest)) = self.pending_copy.clone() {
            let body_view = self.cache.body_view(&copy_key);
            let superseded_by_body = exp_digest
                .as_deref()
                .is_some_and(|exp| body_view.body.is_some_and(|b| b.digest != exp));
            let still_valid = !superseded_by_body
                && active_digests
                    .get(&copy_key)
                    .is_some_and(|(digest, chars)| {
                        *chars <= MAX_WHOLE_BODY_UNITS
                            && exp_digest.as_deref().is_none_or(|exp| exp == digest)
                    });
            if !still_valid {
                self.pending_copy = None;
                changed = true;
            } else if let Some(text) = self.cache.complete_text(&copy_key, exp_digest.as_deref()) {
                // On wasm32, calling navigator.clipboard outside a live user gesture can be
                // rejected without feedback; keep the verified body cached so the user's Copy
                // click succeeds synchronously in the gesture.
                #[cfg(not(target_arch = "wasm32"))]
                {
                    self.ready_copy = Some(text.to_owned());
                }
                let _ = text;
                self.pending_copy = None;
                changed = true;
            } else if matches!(body_view.status, BodyStatus::Error | BodyStatus::Missing) {
                self.pending_copy = None;
                changed = true;
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
        let pending_copy = self.pending_copy.as_ref();
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
            let wants_copy = pending_copy.is_some_and(|(copy_key, exp_digest)| {
                copy_key == &key
                    && desc.characters <= MAX_WHOLE_BODY_UNITS
                    && exp_digest.as_deref().is_none_or(|exp| exp == desc.digest)
            });
            let need = if wants_copy {
                desc.characters
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
                let has_briefing =
                    !has_summary && root.body("briefing").is_some_and(|b| b.characters > 0);
                if has_summary {
                    push_paged(
                        &mut out,
                        "summary",
                        ContentSelector::mission("summary"),
                        root.body("summary"),
                    );
                } else if has_briefing {
                    push_whole(
                        &mut out,
                        ContentSelector::mission("briefing"),
                        root.body("briefing"),
                    );
                } else {
                    let (recorded, blockers) = overview_progress(snapshot);
                    for (_, report) in recorded.into_iter().chain(blockers) {
                        if let Some(desc) = report.body("summary") {
                            push_whole(
                                &mut out,
                                ContentSelector::report(report.id.clone(), "summary"),
                                Some(&desc),
                            );
                        }
                    }
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
                    if self.is_disclosure_open("task-brief") {
                        push_paged(
                            &mut out,
                            "brief",
                            ContentSelector::task(task.key.clone(), "brief"),
                            task.body("brief"),
                        );
                    }
                    if let Some(report) = current_task_report(snapshot, task) {
                        if let Some(desc) = report.body("summary") {
                            push_paged(
                                &mut out,
                                "report-summary",
                                ContentSelector::report(report.id.clone(), "summary"),
                                Some(&desc),
                            );
                        }
                        if let Some(desc) = report.body("evidence").filter(|b| b.characters > 2) {
                            push_whole(
                                &mut out,
                                ContentSelector::report(report.id.clone(), "evidence"),
                                Some(&desc),
                            );
                        }
                        if let Some(desc) = report.body("next").filter(|b| b.characters > 2) {
                            push_whole(
                                &mut out,
                                ContentSelector::report(report.id.clone(), "next"),
                                Some(&desc),
                            );
                        }
                        if self.is_disclosure_open("report-artifact")
                            && let Some(desc) = report.body("artifact")
                        {
                            push_paged(
                                &mut out,
                                "report-artifact",
                                ContentSelector::report(report.id.clone(), "artifact"),
                                Some(&desc),
                            );
                        }
                    }
                    if self.is_disclosure_open("task-all-history") {
                        let oversized = task
                            .body("reports")
                            .is_some_and(|b| b.characters > MAX_WHOLE_BODY_UNITS);
                        if !oversized {
                            let desc = task.body("reports").cloned().unwrap_or(BodyDescriptor {
                                characters: MAX_WHOLE_BODY_UNITS,
                                digest: String::new(),
                            });
                            push_whole(
                                &mut out,
                                ContentSelector::task(task.key.clone(), "reports"),
                                Some(&desc),
                            );
                        }
                    }
                    for report in task_history_reports(snapshot, task) {
                        let disc = format!("history-report-{}", report.id);
                        if !self.is_disclosure_open(&disc) {
                            continue;
                        }
                        if let Some(desc) = report.body("summary") {
                            push_paged(
                                &mut out,
                                &format!("history-{}-summary", report.id),
                                ContentSelector::report(report.id.clone(), "summary"),
                                Some(&desc),
                            );
                        }
                        if let Some(desc) = report.body("evidence").filter(|b| b.characters > 2) {
                            push_whole(
                                &mut out,
                                ContentSelector::report(report.id.clone(), "evidence"),
                                Some(&desc),
                            );
                        }
                        if let Some(desc) = report.body("next").filter(|b| b.characters > 2) {
                            push_whole(
                                &mut out,
                                ContentSelector::report(report.id.clone(), "next"),
                                Some(&desc),
                            );
                        }
                        let art_disc = format!("report-artifact-{}", report.id);
                        if self.is_disclosure_open(&art_disc)
                            && let Some(desc) = report.body("artifact")
                        {
                            push_paged(
                                &mut out,
                                &art_disc,
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
