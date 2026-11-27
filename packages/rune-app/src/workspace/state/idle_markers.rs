//! Unseen session and subagent idle markers (`keepUnseenSubagentIdleStatus`), matching Solid
//! `types/session.ts:getIdleSinceForStatusTransition`, `stores/session-status.ts`, and
//! `stores/session-state.ts:markViewedSessionIdleSeen`.
use super::{Entry, State, Tab, Tx, Ui};
use crate::{Phase, backend::Backend, catalog::Project, settings};
use codenomad_client::{
    Receiver, Sender, TryRecvError, bounded,
    stream::{SessionActivityHint, SessionActivityKind},
};
use std::collections::{HashMap, HashSet, VecDeque};

/// Matches Solid `IDLE_STATUS_VISIBILITY_MS = 5000`.
pub(crate) const IDLE_STATUS_VISIBILITY_SECS: f64 = 5.0;
const MAX_TRACKED_SESSIONS: usize = 256;
const MAX_PENDING_PARENTS: usize = 64;

#[derive(Clone, Debug, Default)]
struct SessionMarker {
    parent_id: Option<String>,
    parent_known: bool,
    working: bool,
    idle_since: Option<f64>,
}

struct ParentLookup {
    session_id: String,
    reply: Receiver<Option<Option<String>>>,
    _cancel: Sender<()>,
}

#[derive(Default)]
pub(super) struct Tracker {
    sessions: HashMap<String, SessionMarker>,
    pending_parents: VecDeque<String>,
    parent_lookup: Option<ParentLookup>,
    bound_working: Option<(String, bool)>,
    last_visible: bool,
    watch_generation: u64,
}

impl Tracker {
    pub(super) fn clear(&mut self) {
        self.sessions.clear();
        self.pending_parents.clear();
        self.parent_lookup = None;
        self.bound_working = None;
        self.last_visible = false;
    }

    pub(super) fn remove(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
        self.pending_parents.retain(|id| id != session_id);
        if self
            .parent_lookup
            .as_ref()
            .is_some_and(|lookup| lookup.session_id == session_id)
        {
            self.parent_lookup = None;
        }
        if self
            .bound_working
            .as_ref()
            .is_some_and(|(id, _)| id == session_id)
        {
            self.bound_working = None;
        }
    }

    pub(super) fn is_working(&self, session_id: &str) -> bool {
        self.sessions
            .get(session_id)
            .is_some_and(|marker| marker.working)
    }

    pub(super) fn any_working(&self) -> bool {
        self.sessions.values().any(|marker| marker.working)
    }

    pub(super) fn observe_working(
        &mut self,
        session_id: &str,
        known_parent: Option<Option<&str>>,
        now: f64,
        keep_unseen_subagent_idle_status: bool,
    ) {
        if !self.ensure_capacity(session_id, now, keep_unseen_subagent_idle_status) {
            return;
        }
        let entry = self.sessions.entry(session_id.to_owned()).or_default();
        if let Some(parent) = known_parent {
            entry.parent_id = parent.map(str::to_owned);
            entry.parent_known = true;
        }
        entry.working = true;
        entry.idle_since = None;
        if !entry.parent_known {
            self.queue_parent_lookup(session_id);
        }
    }

    pub(super) fn observe_idle(
        &mut self,
        session_id: &str,
        known_parent: Option<Option<&str>>,
        now: f64,
    ) {
        let Some(entry) = self.sessions.get_mut(session_id) else {
            // Sessions that start idle never receive an unseen idle marker.
            return;
        };
        if let Some(parent) = known_parent {
            entry.parent_id = parent.map(str::to_owned);
            entry.parent_known = true;
        }
        if entry.working {
            entry.working = false;
            entry.idle_since = Some(now);
            if !entry.parent_known {
                self.queue_parent_lookup(session_id);
            }
        }
    }

    pub(super) fn mark_viewed(
        &mut self,
        session_id: &str,
        keep_unseen_subagent_idle_status: bool,
        known_root: bool,
    ) {
        let viewed_is_root = self
            .sessions
            .get(session_id)
            .map(|marker| marker.parent_known && marker.parent_id.is_none())
            .unwrap_or(known_root);
        if let Some(marker) = self.sessions.get_mut(session_id)
            && !marker.working
        {
            marker.idle_since = None;
        }
        if viewed_is_root && !keep_unseen_subagent_idle_status {
            let descendants = self.descendant_ids(session_id);
            for child_id in descendants {
                if let Some(marker) = self.sessions.get_mut(&child_id)
                    && !marker.working
                {
                    marker.idle_since = None;
                }
            }
        }
    }

    /// Evaluates Solid `getInstanceStatusPresentation` idle eligibility and wake deadline.
    pub(super) fn idle_presentation(
        &self,
        now: f64,
        keep_unseen_subagent_idle_status: bool,
    ) -> (bool, Option<f64>) {
        let mut last_deadline: Option<f64> = None;
        for marker in self.sessions.values() {
            if !marker.parent_known || marker.working {
                continue;
            }
            let Some(idle_since) = marker.idle_since else {
                continue;
            };
            if marker.parent_id.is_some() && !keep_unseen_subagent_idle_status {
                let deadline = idle_since + IDLE_STATUS_VISIBILITY_SECS;
                if deadline > now {
                    last_deadline = Some(last_deadline.map_or(deadline, |prev| prev.max(deadline)));
                }
            } else {
                // Indefinite idle marker (root session or kept subagent): no expiry wake needed.
                return (true, None);
            }
        }
        (last_deadline.is_some(), last_deadline)
    }

    pub(super) fn tab_idle_visible(
        &self,
        now: f64,
        keep_unseen_subagent_idle_status: bool,
    ) -> bool {
        self.idle_presentation(now, keep_unseen_subagent_idle_status)
            .0
    }

    fn descendant_ids(&self, root_id: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (id, marker) in &self.sessions {
            if id == root_id || !marker.parent_known || marker.parent_id.is_none() {
                continue;
            }
            let mut cursor = marker.parent_id.as_deref();
            let mut visited = HashSet::new();
            visited.insert(id.as_str());
            while let Some(parent) = cursor {
                if parent == root_id {
                    out.push(id.clone());
                    break;
                }
                if !visited.insert(parent) {
                    break;
                }
                cursor = self
                    .sessions
                    .get(parent)
                    .and_then(|next| next.parent_id.as_deref());
            }
        }
        out
    }

    fn queue_parent_lookup(&mut self, session_id: &str) {
        if self
            .parent_lookup
            .as_ref()
            .is_some_and(|lookup| lookup.session_id == session_id)
            || self.pending_parents.iter().any(|id| id == session_id)
        {
            return;
        }
        if self.pending_parents.len() >= MAX_PENDING_PARENTS {
            self.pending_parents.pop_front();
        }
        self.pending_parents.push_back(session_id.to_owned());
    }

    fn ensure_capacity(
        &mut self,
        incoming: &str,
        now: f64,
        keep_unseen_subagent_idle_status: bool,
    ) -> bool {
        if self.sessions.contains_key(incoming) || self.sessions.len() < MAX_TRACKED_SESSIONS {
            return true;
        }
        let victim = self
            .sessions
            .iter()
            .find(|(_, m)| !m.working && m.idle_since.is_none())
            .map(|(id, _)| id.clone())
            .or_else(|| {
                self.sessions
                    .iter()
                    .find(|(_, m)| {
                        !m.working
                            && m.parent_known
                            && m.parent_id.is_some()
                            && !keep_unseen_subagent_idle_status
                            && m.idle_since
                                .is_some_and(|t| t + IDLE_STATUS_VISIBILITY_SECS <= now)
                    })
                    .map(|(id, _)| id.clone())
            })
            .or_else(|| {
                self.sessions
                    .iter()
                    .filter(|(_, m)| !m.working)
                    .min_by(|(_, a), (_, b)| {
                        a.idle_since
                            .unwrap_or(f64::INFINITY)
                            .total_cmp(&b.idle_since.unwrap_or(f64::INFINITY))
                    })
                    .map(|(id, _)| id.clone())
            });
        if let Some(id) = victim {
            self.sessions.remove(&id);
            true
        } else {
            false
        }
    }

    fn reset_working_on_reconnect(&mut self) {
        self.parent_lookup = None;
        self.pending_parents.clear();
        self.bound_working = None;
        let mut requeue = Vec::new();
        for (id, marker) in &mut self.sessions {
            marker.working = false;
            if marker.idle_since.is_some() && !marker.parent_known {
                requeue.push(id.clone());
            }
        }
        for id in requeue {
            self.queue_parent_lookup(&id);
        }
    }

    fn apply_parent(&mut self, session_id: &str, parent: Option<Option<String>>) {
        let Some(marker) = self.sessions.get_mut(session_id) else {
            return;
        };
        if let Some(parent_id) = parent {
            marker.parent_id = parent_id;
            marker.parent_known = true;
        } else {
            // Foreign, deleted or unreadable session must not display a stale marker.
            self.sessions.remove(session_id);
        }
    }
}

fn entry_knows_root(entry: &Entry, active: bool, s: &State, session_id: &str) -> bool {
    if active {
        s.screen.launcher().is_some_and(|l| {
            l.listed_sessions.contains(session_id)
                || l.linked.rows.iter().any(|row| row.id == session_id)
        })
    } else {
        entry.listed_sessions.contains(session_id)
            || entry.linked.rows.iter().any(|row| row.id == session_id)
    }
}

fn spawn_parent_lookup(
    s: &State,
    backend: Backend,
    project: Project,
    session_id: String,
) -> ParentLookup {
    let (out, reply) = bounded(1);
    let (cancel, cancelled) = bounded(1);
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let sid = session_id.clone();
    crate::platform::spawn(async move {
        let work = async {
            let _permit = reads.background(&cancelled).await?;
            backend.session_parent(&project, &sid).await.ok()
        };
        let result = codenomad_client::runtime::until_closed(&out, work)
            .await
            .flatten();
        if let Some(parent) = result {
            let _ = out.try_send(parent);
            wake();
        }
    });
    ParentLookup {
        session_id,
        reply,
        _cancel: cancel,
    }
}

fn observe_bound_tab(entry: &mut Entry, active: bool, s: &State, now: f64, keep_unseen: bool) {
    let Tab::Workspace(saved) = &entry.saved else {
        return;
    };
    let Some(session_id) = saved.active_session_id.as_deref() else {
        entry.idle_markers.bound_working = None;
        return;
    };
    let working = if active {
        !s.screen.is_launcher()
            && (s.phase == Phase::Streaming
                || s.agent.as_ref().is_some_and(|a| a.online && a.running))
    } else {
        entry.cache.as_ref().is_some_and(|cache| {
            matches!(
                cache.status(),
                Some(rune_theme_codenomad::tabs::Status::Working)
            )
        })
    };
    let previous = entry
        .idle_markers
        .bound_working
        .as_ref()
        .filter(|(id, _)| id == session_id)
        .map(|(_, prev)| *prev);
    entry.idle_markers.bound_working = Some((session_id.to_owned(), working));
    let known_parent = entry_knows_root(entry, active, s, session_id).then_some(None);
    if working {
        entry
            .idle_markers
            .observe_working(session_id, known_parent, now, keep_unseen);
    } else if previous == Some(true) {
        entry
            .idle_markers
            .observe_idle(session_id, known_parent, now);
    }
}

fn apply_hints(
    ui: &mut Ui,
    s: &State,
    generation: u64,
    hints: VecDeque<SessionActivityHint>,
    now: f64,
    keep_unseen: bool,
) {
    let active = ui.active;
    for (index, entry) in ui.entries.iter_mut().enumerate() {
        if entry.idle_markers.watch_generation != generation {
            entry.idle_markers.watch_generation = generation;
            entry.idle_markers.reset_working_on_reconnect();
        }
        let Some(ws_id) = entry
            .project
            .as_ref()
            .map(|p| p.id.as_str())
            .or(match &entry.saved {
                Tab::Workspace(w) => w.workspace_id.as_deref(),
                Tab::Blank => None,
            })
        else {
            continue;
        };
        let ws_id = ws_id.to_owned();
        for hint in hints.iter().filter(|h| h.workspace == ws_id) {
            let known_parent =
                entry_knows_root(entry, index == active, s, &hint.session).then_some(None);
            match hint.kind {
                SessionActivityKind::Working => {
                    entry.idle_markers.observe_working(
                        &hint.session,
                        known_parent,
                        now,
                        keep_unseen,
                    );
                }
                SessionActivityKind::Idle => {
                    entry
                        .idle_markers
                        .observe_idle(&hint.session, known_parent, now);
                }
                SessionActivityKind::Deleted => {
                    entry.idle_markers.remove(&hint.session);
                }
                SessionActivityKind::ResetWorkspace => {
                    entry.idle_markers.reset_working_on_reconnect();
                }
            }
        }
    }
}

pub(super) fn poll(s: &mut State, ui: &mut Ui, now: f64, tx: &mut Tx) -> bool {
    let keep_unseen = settings::keep_unseen_subagent_idle_status(s);
    if let Some((generation, hints)) = s
        .screen
        .launcher()
        .and_then(|l| l.catalogue_watch.as_ref())
        .map(|watch| watch.take_session_activity())
    {
        apply_hints(ui, s, generation, hints, now, keep_unseen);
    }

    let mut changed = false;
    let active_index = ui.active;
    let window_focused = s.notifications.main_window_focused();
    let has_pending_interruption = s.agent.as_ref().is_some_and(|a| !a.ids().is_empty());
    let viewing_chat = window_focused && !s.screen.is_launcher() && !has_pending_interruption;
    let shared_conn = s.screen.launcher().and_then(|l| l.connection.clone());

    for index in 0..ui.entries.len() {
        let is_active = index == active_index;
        observe_bound_tab(&mut ui.entries[index], is_active, s, now, keep_unseen);

        // Drain parent lookup completion and launch next queued lookup if needed.
        if let Some(lookup) = ui.entries[index].idle_markers.parent_lookup.take() {
            match lookup.reply.try_recv() {
                Ok(parent) => {
                    ui.entries[index]
                        .idle_markers
                        .apply_parent(&lookup.session_id, parent);
                    changed = true;
                }
                Err(TryRecvError::Closed) => {
                    ui.entries[index]
                        .idle_markers
                        .apply_parent(&lookup.session_id, None);
                }
                Err(TryRecvError::Empty) => {
                    ui.entries[index].idle_markers.parent_lookup = Some(lookup);
                }
            }
        }
        if ui.entries[index].idle_markers.parent_lookup.is_none() {
            let backend = ui.entries[index]
                .binding
                .clone()
                .or_else(|| shared_conn.clone());
            let project = ui.entries[index].project.clone();
            if let (Some(backend), Some(project)) = (backend, project) {
                while let Some(next_id) = ui.entries[index].idle_markers.pending_parents.pop_front()
                {
                    if ui.entries[index]
                        .idle_markers
                        .sessions
                        .get(&next_id)
                        .is_none_or(|m| m.parent_known)
                    {
                        continue;
                    }
                    ui.entries[index].idle_markers.parent_lookup =
                        Some(spawn_parent_lookup(s, backend, project, next_id));
                    break;
                }
            }
        }

        if is_active && viewing_chat {
            let active_session = match &ui.entries[index].saved {
                Tab::Workspace(saved) => saved.active_session_id.clone(),
                Tab::Blank => None,
            };
            if let Some(viewed_id) = active_session {
                let known_root = entry_knows_root(&ui.entries[index], true, s, &viewed_id);
                ui.entries[index]
                    .idle_markers
                    .mark_viewed(&viewed_id, keep_unseen, known_root);
            }
        }

        let (visible, wake_deadline) = ui.entries[index]
            .idle_markers
            .idle_presentation(now, keep_unseen);
        if let Some(deadline) = wake_deadline {
            tx.wake_at(deadline);
        }
        if ui.entries[index].idle_markers.last_visible != visible {
            ui.entries[index].idle_markers.last_visible = visible;
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{self, Snapshot, Workspace};
    use serde_json::json;

    #[test]
    fn subagent_idle_marker_respects_keep_unseen_preference_and_timeout() {
        let mut tracker = Tracker::default();
        // Starting idle never shows an indicator.
        tracker.observe_idle("ses_root", Some(None), 1.0);
        assert!(!tracker.tab_idle_visible(1.0, true));

        // Subagent finishes work at t = 10.0s.
        tracker.observe_working("ses_child", Some(Some("ses_root")), 9.0, true);
        tracker.observe_idle("ses_child", Some(Some("ses_root")), 10.0);

        // With keepUnseenSubagentIdleStatus = true, marker persists past 5s without wake timer.
        assert_eq!(tracker.idle_presentation(12.0, true), (true, None));
        assert_eq!(tracker.idle_presentation(30.0, true), (true, None));

        // Viewing the parent keeps the unseen subagent marker when keep = true.
        tracker.mark_viewed("ses_root", true, true);
        assert_eq!(tracker.idle_presentation(30.0, true), (true, None));

        // With keepUnseenSubagentIdleStatus = false, marker ages out at t + 5.0s and arms wake_at.
        assert_eq!(tracker.idle_presentation(12.0, false), (true, Some(15.0)));
        assert_eq!(tracker.idle_presentation(15.0, false), (false, None));

        // Viewing the parent clears descendant subagents when keep = false.
        tracker.observe_working("ses_child", Some(Some("ses_root")), 19.0, false);
        tracker.observe_idle("ses_child", Some(Some("ses_root")), 20.0);
        tracker.observe_working("ses_grand", Some(Some("ses_child")), 19.0, false);
        tracker.observe_idle("ses_grand", Some(Some("ses_child")), 20.0);
        tracker.mark_viewed("ses_root", false, true);
        assert_eq!(tracker.idle_presentation(21.0, false), (false, None));

        // Viewing the subagent itself clears its marker even when keep = true.
        tracker.observe_working("ses_child", Some(Some("ses_root")), 24.0, true);
        tracker.observe_idle("ses_child", Some(Some("ses_root")), 25.0);
        tracker.mark_viewed("ses_child", true, false);
        assert_eq!(tracker.idle_presentation(26.0, true), (false, None));
    }

    #[test]
    fn resuming_work_clears_idle_marker_until_next_completion() {
        let mut tracker = Tracker::default();
        tracker.observe_working("ses_child", Some(Some("ses_root")), 0.5, true);
        tracker.observe_idle("ses_child", Some(Some("ses_root")), 1.0);
        assert!(tracker.tab_idle_visible(2.0, true));

        tracker.observe_working("ses_child", Some(Some("ses_root")), 2.5, true);
        assert!(!tracker.tab_idle_visible(3.0, true));
    }

    #[test]
    fn subagent_in_sessions_list_only_is_not_misclassified_as_root() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        let ui = workspace::Ui::new();
        if let Some(l) = state.screen.launcher_mut() {
            l.sessions.push(crate::catalog::Session {
                id: "ses_child_opened".into(),
                title: "Child".into(),
            });
            l.listed_sessions.insert("ses_listed_root".into());
        }
        assert!(!entry_knows_root(
            &ui.entries[0],
            true,
            &state,
            "ses_child_opened"
        ));
        assert!(entry_knows_root(
            &ui.entries[0],
            true,
            &state,
            "ses_listed_root"
        ));
    }

    #[test]
    fn tracker_enforces_max_tracked_sessions_cap() {
        let mut tracker = Tracker::default();
        for i in 0..(MAX_TRACKED_SESSIONS + 20) {
            let id = format!("ses_idle_{i}");
            tracker.observe_working(&id, Some(Some("ses_root")), i as f64, false);
            tracker.observe_idle(&id, Some(Some("ses_root")), i as f64 + 1.0);
        }
        assert!(tracker.sessions.len() <= MAX_TRACKED_SESSIONS);

        let mut busy_tracker = Tracker::default();
        for i in 0..(MAX_TRACKED_SESSIONS + 10) {
            busy_tracker.observe_working(&format!("ses_busy_{i}"), Some(None), 1.0, true);
        }
        assert_eq!(busy_tracker.sessions.len(), MAX_TRACKED_SESSIONS);
    }

    #[test]
    fn project_tab_displays_idle_status_for_subagent_and_expires_after_five_seconds_when_disabled()
    {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        let mut ui = workspace::Ui::new();
        ui.fixture_hydrate(Snapshot {
            revision: 1,
            saved_at: 1,
            panel_widths: [None; 2],
            file_wrap: None,
            tabs: vec![Tab::Workspace(Workspace {
                backend_id: None,
                server_id: None,
                folder: "/repo".into(),
                project_name: None,
                temporary: false,
                occurrence: 0,
                workspace_id: Some("ws1".into()),
                active_session_id: Some("ses_root".into()),
                drafts: Default::default(),
                attachment_drafts: Default::default(),
                attachment_parts: Default::default(),
                view: Default::default(),
            })],
            active: Some(0),
        });
        ui.fixture_ready();
        ui.entries[0]
            .idle_markers
            .observe_working("ses_child", Some(Some("ses_root")), 9.0, true);
        ui.entries[0]
            .idle_markers
            .observe_idle("ses_child", Some(Some("ses_root")), 10.0);
        state.workspace = Some(ui);
        state.show_chat();
        crate::settings::fixture_config_doc(
            &mut state,
            json!({"settings": {"keepUnseenSubagentIdleStatus": true}}),
        );

        let mut rt = rune::Runtime::new(
            state,
            |s, cx| crate::workspace::strip(s, cx.touch_controls(), false),
            (800.0, 80.0),
            rune::Env::new(false, 1.0),
        );
        rt.poll = Some(workspace::poll);
        crate::strings::with_locale("en", || {
            rt.frame(12.0);
            let idle_label = crate::strings::t("instanceTab.status.idle");
            let working_label = crate::strings::t("instanceTab.status.working");
            let has_label = |rt: &rune::Runtime<State>, label: &str| {
                rt.elements()
                    .iter()
                    .any(|el| el.description.as_deref().is_some_and(|d| d.contains(label)))
            };
            assert!(
                has_label(&rt, idle_label),
                "kept subagent idle marker must remain visible on the project tab while viewing parent"
            );

            // While another subagent in the same tab is actively working, Working takes priority over Idle.
            rt.update(|s, _tx| {
                s.workspace.as_mut().unwrap().entries[0]
                    .idle_markers
                    .observe_working("ses_child_2", Some(Some("ses_root")), 12.1, true);
            });
            rt.frame(0.1);
            assert!(has_label(&rt, working_label));
            assert!(!has_label(&rt, idle_label));
            rt.update(|s, _tx| {
                s.workspace.as_mut().unwrap().entries[0]
                    .idle_markers
                    .remove("ses_child_2");
            });

            // Toggle off keepUnseenSubagentIdleStatus while unfocused: tab keeps Idle until 15.0s, arms wake_at(15.0).
            rt.update(|s, _tx| {
                crate::shell::notifications::set_focus_for_test(s, false);
                crate::settings::fixture_config_doc(
                    s,
                    json!({"settings": {"keepUnseenSubagentIdleStatus": false}}),
                );
            });
            rt.frame(0.4); // clock = 12.5
            assert!(has_label(&rt, idle_label));
            let due = rt
                .wake_deadline()
                .expect("expiring subagent idle marker must arm tx.wake_at");
            assert!(
                (due - 15.0).abs() < 1e-6,
                "expected wake at 15.0, got {due}"
            );

            rt.frame(2.6); // clock = 15.1 > 15.0
            assert!(
                !has_label(&rt, idle_label),
                "subagent idle marker must expire after 5 seconds when keepUnseenSubagentIdleStatus is false"
            );
        });
    }

    #[test]
    fn reset_workspace_clears_working_markers_and_moved_removes_stale_marker() {
        let mut tracker = Tracker::default();
        tracker.observe_working("ses_busy", None, 1.0, true);
        assert!(tracker.any_working());
        assert!(!tracker.pending_parents.is_empty());

        tracker.reset_working_on_reconnect();
        assert!(!tracker.any_working());
        assert!(tracker.pending_parents.is_empty());

        tracker.observe_working("ses_moved", Some(Some("ses_root")), 2.0, true);
        tracker.observe_idle("ses_moved", Some(Some("ses_root")), 3.0);
        assert!(tracker.tab_idle_visible(4.0, true));
        tracker.remove("ses_moved");
        assert!(!tracker.tab_idle_visible(4.0, true));
    }
}
