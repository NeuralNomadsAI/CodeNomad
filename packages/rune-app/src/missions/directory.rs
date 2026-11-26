use super::{
    detail::{Detail, read_window},
    editor::{Editor, EditorGesture},
    editor_holds::{
        ActiveEditor, CreationScopeKey, EditHoldKey, EditHoldView, EditorEvent, EditorHolds,
    },
    observation::Observation,
    reader::Reader,
};
use crate::platform::{self, reads::Reads};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{Cleanup, DirectoryChanged, DirectoryPage, DirectoryRows, Summary, Window},
};
use rune::edit::TextEdit;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Summaries,
    Cleanups,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Read {
    Refresh,
    More,
}

#[derive(Default)]
struct Lane {
    active: Option<(u64, Sender<()>)>,
    window: Option<Window>,
    failed: Option<Read>,
    owed: bool,
    seen: HashSet<(String, Option<String>)>,
}

struct Completion {
    kind: Kind,
    read: Read,
    serial: u64,
    backend: Backend,
    page: Result<DirectoryPage>,
}

pub(crate) struct Panel {
    pub(crate) backend: Backend,
    pub(super) reads: Reads,
    pub(super) wake: Wake,
    out: Sender<Completion>,
    incoming: Receiver<Completion>,
    pub(super) project: Option<String>,
    pub(super) owner_scope: String,
    pub(super) directory: Option<String>,
    serial: u64,
    visible: bool,
    refresh_due: Option<f64>,
    last_passive: Option<f64>,
    now: f64,
    pub(super) scope: std::rc::Rc<()>,
    supported: Option<bool>,
    capability: Option<Receiver<Option<bool>>>,
    probe_attempted: bool,
    lanes: [Lane; 2],
    pub(super) summaries: Vec<Summary>,
    pub(super) cleanups: Vec<Cleanup>,
    pub(super) filter: TextEdit,
    pub(crate) selected: Option<String>,
    pub(super) detail: Detail,
    pub(super) control_fields: super::control_fields::Fields,
    pub(super) observation: Observation,
    pub(super) reader: Reader,
    pub(super) editor: Editor,
    pub(crate) schedules: super::schedules::Schedules,
    editor_saved_focus: Option<String>,
    reader_suspended: bool,
    editor_suspended: bool,
    editor_auto_start_revoked: bool,
    auth_expired: Vec<Backend>,
}

const KINDS: [Kind; 2] = [Kind::Summaries, Kind::Cleanups];

impl Panel {
    pub(crate) fn is_composing(&self) -> bool {
        self.filter.is_composing() || self.editor.is_composing()
    }

    pub(crate) fn new(backend: Backend, project: Option<String>, reads: Reads, wake: Wake) -> Self {
        let (out, incoming) = bounded(4);
        let owner_scope = backend.workspace.clone();
        Self {
            backend,
            project,
            owner_scope,
            directory: None,
            reads,
            wake,
            out,
            incoming,
            serial: 0,
            visible: false,
            refresh_due: None,
            last_passive: None,
            now: 0.0,
            scope: std::rc::Rc::new(()),
            supported: None,
            capability: None,
            probe_attempted: false,
            lanes: Default::default(),
            summaries: vec![],
            cleanups: vec![],
            filter: TextEdit::new(""),
            selected: None,
            detail: Detail::default(),
            control_fields: Default::default(),
            observation: Observation::default(),
            reader: Reader::default(),
            editor: Editor::default(),
            schedules: Default::default(),
            editor_saved_focus: None,
            reader_suspended: false,
            editor_suspended: false,
            editor_auto_start_revoked: false,
            auth_expired: Vec::new(),
        }
    }

    pub(crate) fn with_owner_scope(mut self, scope: String) -> Self {
        if !scope.is_empty() {
            self.directory = Some(scope.clone());
            self.owner_scope = scope;
        }
        self
    }

    pub(crate) fn with_schedule_auth(mut self, sink: super::schedules::AuthSink) -> Self {
        self.schedules.bind_auth(sink);
        self
    }

    pub(crate) fn creation_scope_key(&self) -> CreationScopeKey {
        CreationScopeKey::new(&self.backend, &self.owner_scope)
    }

    pub(crate) fn active_editor(&self, occurrence: &str) -> Option<ActiveEditor<'_>> {
        self.editor
            .active_context(occurrence, &self.backend, &self.wake)
    }

    pub(super) fn wake(&self) {
        (self.wake)();
    }

    pub(crate) fn same_workspace(&self, backend: &Backend) -> bool {
        self.backend.base == backend.base && self.backend.workspace == backend.workspace
    }

    /// Rebinds the authenticated HTTP client after sign-in while preserving the selected Mission
    /// and any open Mission reader so the user returns to their reading state and revalidates it.
    pub(crate) fn rebind(&mut self, backend: Backend) {
        self.backend = backend;
        self.cancel_probe();
        for lane in &mut self.lanes {
            if let Some((_, cancel)) = lane.active.take() {
                cancel.close();
            }
            lane.owed = false;
        }
        self.control_fields.cancel();
        self.observation.cancel();
        self.detail.cancel();
        self.detail.clear_lookup_cache();
        self.reader.invalidate();
        self.editor.suspend();
        self.schedules.rebind();
        if self.visible || self.reader.is_open() || self.editor.is_open() {
            self.refresh();
        }
        (self.wake)();
    }

    pub(crate) fn rebind_editor(&mut self, holds: &mut EditorHolds) {
        self.editor_suspended = false;
        let scope = self.creation_scope_key();
        self.editor
            .rebind(&scope, &self.backend, holds, &self.reads, &self.wake);
        if self
            .editor
            .resume(&scope, &self.backend, holds, &self.reads, &self.wake)
        {
            let since = self.detail.request_fresh_refresh();
            self.editor.set_reopen_since(since);
        }
    }

    pub(crate) fn has_reader(&self) -> bool {
        self.reader.is_open()
    }

    pub(crate) fn has_editor(&self) -> bool {
        self.editor.is_open()
    }

    pub(crate) fn has_surface(&self) -> bool {
        self.reader.is_open() || self.editor.is_open()
    }

    pub(crate) fn invalidate_editor_generation(&mut self) {
        self.editor.invalidate_generation();
    }

    pub(crate) fn open_create_editor(
        &mut self,
        holds: &mut EditorHolds,
        return_focus: Option<String>,
    ) {
        self.reader.close();
        self.detail.cancel_lookup();
        self.schedules.cancel_pre();
        self.editor_suspended = false;
        let scope = self.creation_scope_key();
        self.editor.open_create(
            &scope,
            &self.backend,
            holds,
            &self.reads,
            &self.wake,
            return_focus,
        );
        (self.wake)();
    }

    pub(crate) fn selected_edit_hold(&self, holds: &EditorHolds) -> Option<EditHoldView> {
        let mission_id = self.selected.as_deref()?;
        let project = self.project.as_deref().or_else(|| {
            self.detail
                .snapshot
                .as_ref()
                .map(|s| s.header.root.project_id())
        })?;
        let key = EditHoldKey::new(&self.backend, project, mission_id);
        holds.edit(&key)
    }

    pub(crate) fn open_edit_editor(
        &mut self,
        holds: &mut EditorHolds,
        return_focus: Option<String>,
    ) -> bool {
        let hold = self.selected_edit_hold(holds);
        let editable = self.detail.authoritative()
            && self
                .detail
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.header.root.editable());
        if !editable && hold.is_none() {
            return false;
        }
        self.reader.close();
        self.detail.cancel_lookup();
        self.schedules.cancel_pre();
        self.editor_suspended = false;
        let scope = self.creation_scope_key();
        if let Some(snapshot) = self.detail.snapshot.as_ref()
            && self.selected.as_deref() == Some(snapshot.header.root.id.as_str())
        {
            let opened = self.editor.open_edit(
                &snapshot.header,
                &scope,
                &self.backend,
                holds,
                &self.reads,
                &self.wake,
                return_focus,
            );
            if opened {
                (self.wake)();
            }
            return opened;
        }
        let Some(hold) = hold else {
            return false;
        };
        let summary = self
            .summaries
            .iter()
            .find(|row| row.id == hold.target.mission);
        let title = summary
            .and_then(|row| row.title.clone())
            .unwrap_or_default();
        let template = codenomad_client::missions::Template::Custom;
        let run_state = summary.and_then(|row| row.run_state);
        self.editor.open_edit_hold_only(
            &hold,
            title,
            template,
            run_state,
            &scope,
            holds,
            return_focus,
        );
        (self.wake)();
        true
    }

    pub(crate) fn can_edit_selected(&self) -> bool {
        self.detail.authoritative()
            && self
                .detail
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.header.root.editable())
    }

    pub(crate) fn has_unsaved_editor_draft(&self, holds: &EditorHolds) -> bool {
        let scope = self.creation_scope_key();
        self.editor.has_unsaved_draft(&scope, &self.backend, holds)
    }

    pub(crate) fn discard_unsaved_editor_draft(&mut self, holds: &mut EditorHolds) -> bool {
        if !self.has_unsaved_editor_draft(holds) {
            return false;
        }
        self.editor_suspended = false;
        self.editor_auto_start_revoked = true;
        let scope = self.creation_scope_key();
        holds.revoke_auto_start_for_scope(&scope);
        let _ = self.editor.close();
        true
    }

    pub(crate) fn close_reader_preserving_dirty_editor(
        &mut self,
        holds: &EditorHolds,
    ) -> Option<String> {
        self.reader_suspended = false;
        self.detail.cancel_lookup();
        let reader_back = self.reader.take_return_focus();
        self.reader.close();
        if self.editor.is_open() {
            self.editor_auto_start_revoked = true;
            if self.has_unsaved_editor_draft(holds) {
                self.editor.invalidate_generation();
            } else {
                self.editor_suspended = false;
                return self.editor.close().or(reader_back);
            }
        }
        reader_back
    }

    pub(crate) fn request_close_surface(
        &mut self,
        holds: &EditorHolds,
        from_escape: bool,
    ) -> super::editor::CloseSurface {
        if self.editor.is_open() {
            if from_escape && self.editor.cancel_pending_leave() {
                return super::editor::CloseSurface::CancelledPrompt;
            }
            if self.has_unsaved_editor_draft(holds) {
                self.editor_auto_start_revoked = true;
                self.editor.arm_leave(super::editor::LeaveIntent::Close);
                return super::editor::CloseSurface::PromptedDiscard;
            }
            self.editor_suspended = false;
            self.editor_auto_start_revoked = true;
            return super::editor::CloseSurface::Closed(self.editor.close());
        }
        super::editor::CloseSurface::Closed(self.close_reader())
    }

    pub(crate) fn confirm_discard_editor(
        &mut self,
        holds: &mut EditorHolds,
    ) -> Option<(super::editor::LeaveIntent, Option<String>)> {
        let intent = self.editor.take_pending_leave()?;
        if intent == super::editor::LeaveIntent::CloseTab {
            return Some((intent, None));
        }
        self.editor_suspended = false;
        self.editor_auto_start_revoked = true;
        let scope = self.creation_scope_key();
        holds.revoke_auto_start_for_scope(&scope);
        let back = self.editor.close();
        match &intent {
            super::editor::LeaveIntent::Close | super::editor::LeaveIntent::CloseTab => {}
            super::editor::LeaveIntent::SelectMission(id) => {
                self.select_unchecked(id);
            }
            super::editor::LeaveIntent::SelectSchedule(id) => {
                self.select_schedule_unchecked(id.clone());
            }
            super::editor::LeaveIntent::OpenOverview(id) => {
                if self.selected.as_deref() != Some(id.as_str()) {
                    self.select_unchecked(id);
                }
                self.reader.open_overview(id.clone());
                (self.wake)();
            }
            super::editor::LeaveIntent::OpenTask(mission_id, task_id, task_key) => {
                if self.selected.as_deref() != Some(mission_id.as_str()) {
                    self.select_unchecked(mission_id);
                }
                self.reader
                    .open_task(mission_id.clone(), task_id.clone(), task_key.clone());
                (self.wake)();
            }
        }
        Some((intent, back))
    }

    pub(crate) fn editor_gesture(
        &mut self,
        occurrence: &str,
        holds: &mut EditorHolds,
        gesture: EditorGesture,
    ) -> bool {
        match gesture {
            EditorGesture::OpenCreate { return_focus } => {
                self.open_create_editor(holds, return_focus);
                true
            }
            EditorGesture::OpenEdit { return_focus } => self.open_edit_editor(holds, return_focus),
            EditorGesture::Submit => {
                self.submit_editor(occurrence, holds);
                false
            }
            EditorGesture::ReconcileCreation => {
                self.reconcile_editor_creation(occurrence, holds);
                false
            }
            EditorGesture::ReconcileEdit => {
                self.reconcile_editor_edit(occurrence, holds);
                false
            }
            EditorGesture::RetryDefaults => {
                self.retry_editor_defaults();
                false
            }
            EditorGesture::RetryPrefill => {
                self.retry_editor_prefill();
                false
            }
            EditorGesture::Reopen => {
                self.reopen_editor(holds);
                false
            }
            EditorGesture::RequestCloseTab => {
                let scope = self.creation_scope_key();
                if holds.creation(&scope).is_some_and(|h| {
                    h.state == super::editor_holds::HoldState::Uncertain && !h.checking
                }) {
                    self.editor.arm_leave(super::editor::LeaveIntent::CloseTab);
                    return true;
                }
                false
            }
            EditorGesture::CancelDiscard => {
                self.editor.cancel_pending_leave();
                false
            }
            EditorGesture::ConfirmDiscard => {
                let _ = self.confirm_discard_editor(holds);
                false
            }
        }
    }

    pub(crate) fn submit_editor(&mut self, occurrence: &str, holds: &mut EditorHolds) {
        let scope = self.creation_scope_key();
        if self.editor.submit(
            occurrence,
            &scope,
            &self.backend,
            holds,
            &self.reads,
            &self.wake,
        ) {
            (self.wake)();
        }
    }

    pub(crate) fn reconcile_editor_creation(&mut self, occurrence: &str, holds: &mut EditorHolds) {
        let scope = self.creation_scope_key();
        if self
            .editor
            .reconcile_creation(occurrence, &scope, &self.backend, holds, &self.wake)
        {
            (self.wake)();
        }
    }

    pub(crate) fn reconcile_editor_edit(&mut self, occurrence: &str, holds: &mut EditorHolds) {
        if self
            .editor
            .reconcile_edit(occurrence, &self.backend, holds, &self.wake)
        {
            (self.wake)();
        }
    }

    pub(super) fn retry_editor_defaults(&mut self) {
        self.editor
            .retry_defaults(&self.backend, &self.reads, &self.wake);
        (self.wake)();
    }

    pub(super) fn retry_editor_prefill(&mut self) {
        self.editor
            .retry_prefill(&self.backend, &self.reads, &self.wake);
        (self.wake)();
    }

    pub(crate) fn reopen_editor(&mut self, holds: &EditorHolds) {
        if self.editor.begin_reopen(&self.backend, holds, 0) {
            self.schedules.cancel_pre();
            if let Some(mid) = self.editor.editing_mission_id().map(str::to_owned)
                && self.selected.as_deref() != Some(mid.as_str())
            {
                self.selected = Some(mid);
                self.detail.clear();
            }
            let since = self.detail.request_fresh_refresh();
            self.editor.set_reopen_since(since);
            self.refresh();
            (self.wake)();
        }
    }

    pub(crate) fn observe_editor_detail(&mut self, holds: &EditorHolds) -> bool {
        let mut changed = false;
        let scope = self.creation_scope_key();
        self.editor.sync_hold_flags(&scope, &self.backend, holds);
        if self.editor_suspended && self.editor.is_open() {
            self.editor_suspended = false;
            if self
                .editor
                .resume(&scope, &self.backend, holds, &self.reads, &self.wake)
            {
                let since = self.detail.request_fresh_refresh();
                self.editor.set_reopen_since(since);
            }
            changed = true;
        }
        changed |= self.editor.poll_async(&self.backend);
        changed
            | self.editor.observe_detail(
                self.detail.snapshot.as_ref(),
                self.detail.refresh_completed,
                self.detail.refresh_failed,
                &self.backend,
                holds,
                &self.reads,
                &self.wake,
            )
    }

    pub(crate) fn commit_editor_submit(
        &mut self,
        holds: &mut EditorHolds,
        auth_expired: &[Backend],
    ) -> bool {
        let scope = self.creation_scope_key();
        let changed = self.editor.commit_ready_submits(
            &scope,
            holds,
            &self.backend,
            &self.wake,
            auth_expired,
        );
        if changed {
            (self.wake)();
        }
        changed
    }

    pub(crate) fn take_editor_auto_start_revoked(&mut self) -> bool {
        std::mem::take(&mut self.editor_auto_start_revoked)
    }

    pub(crate) fn apply_editor_events(&mut self, occurrence: &str, events: &[EditorEvent]) -> bool {
        let scope_key = self.creation_scope_key();
        let mut changed = false;
        for event in events {
            let (ev_changed, saved) = self.editor.apply_event(
                occurrence,
                &scope_key,
                &self.backend,
                self.project.as_deref(),
                event,
            );
            changed |= ev_changed;
            if let Some(saved) = saved {
                if saved.select {
                    self.schedules.clear_selection();
                    self.selected = Some(saved.mission_id.clone());
                    self.detail.clear();
                    self.observation.reset();
                    // Cancel any pre-creation Summaries read so a stale page cannot clear the new selection.
                    if let Some((_, cancel)) = self.lanes[Kind::Summaries as usize].active.take() {
                        cancel.close();
                    }
                }
                if self.selected.as_deref() == Some(saved.mission_id.as_str()) {
                    self.detail.observe(&saved.mission_id, saved.revision);
                }
                self.refresh();
                if saved.closed_form {
                    self.editor_saved_focus = saved
                        .return_focus
                        .or_else(|| Some("missions-create".into()));
                }
                changed = true;
            }
        }
        self.editor
            .ensure_defaults_if_loading(&self.backend, &self.reads, &self.wake);
        changed
    }

    pub(crate) fn close_reader(&mut self) -> Option<String> {
        let back = if self.editor.is_open() {
            self.editor_suspended = false;
            self.editor.close()
        } else {
            let back = self.reader.take_return_focus();
            self.reader.close();
            self.detail.cancel_lookup();
            self.reader_suspended = false;
            back
        };
        if !self.visible && !self.has_surface() {
            self.refresh_due = None;
            self.detail.cancel();
        }
        back
    }

    fn record_auth_expired(&mut self, backend: Backend) {
        if !self
            .auth_expired
            .iter()
            .any(|known| known.client.same_connection(&backend.client))
        {
            self.auth_expired.push(backend);
        }
    }

    pub(crate) fn suspend(&mut self) {
        self.reader_suspended = self.reader.is_open();
        self.editor_suspended = self.editor.is_open();
        self.show(false);
        self.refresh_due = None;
        self.detail.cancel();
        self.observation.cancel();
        self.control_fields.cancel();
        self.reader.suspend();
        self.editor.suspend();
        self.schedules.suspend();
        self.cancel_probe();
        while let Ok(done) = self.incoming.try_recv() {
            if let Err(error) = &done.page
                && codenomad_client::missions::is_auth_expired(error)
            {
                self.record_auth_expired(done.backend);
            }
        }
    }

    pub(crate) fn drain_auth_expired(&mut self) -> Vec<Backend> {
        let mut expired = Vec::new();
        for candidate in std::mem::take(&mut self.auth_expired)
            .into_iter()
            .chain(self.observation.drain_auth_expired())
            .chain(self.detail.drain_auth_expired())
            .chain(self.reader.take_auth_expired())
            .chain(self.control_fields.drain_auth_expired())
            .chain(self.editor.drain_auth_expired())
            .chain(self.schedules.drain_auth_expired())
        {
            if !expired
                .iter()
                .any(|known: &Backend| known.client.same_connection(&candidate.client))
            {
                expired.push(candidate);
            }
        }
        expired
    }

    pub(crate) fn take_editor_initial_focus(&mut self) -> Option<&'static str> {
        self.editor.take_initial_focus()
    }

    pub(crate) fn take_editor_saved_focus(&mut self) -> Option<String> {
        self.editor_saved_focus.take()
    }

    #[cfg(test)]
    pub(crate) fn fixture_ready_with_lookup(
        &mut self,
        header: codenomad_client::missions::MapHeader,
        task_id: &str,
        task_key: &str,
    ) {
        self.supported = Some(true);
        self.probe_attempted = true;
        self.visible = true;
        self.project = Some(header.root.project_id().to_owned());
        self.selected = Some(header.root.id.clone());
        self.detail
            .fixture_snapshot_and_lookup(header, task_id.to_owned(), task_key.to_owned());
    }

    pub(crate) fn take_reader_copy(&mut self) -> Option<String> {
        self.reader.take_ready_copy()
    }

    pub(crate) fn take_reader_focus_close(&mut self) -> bool {
        self.reader.take_focus_close()
    }

    pub(super) fn toggle_overview(&mut self, id: &str) -> bool {
        if self.reader.is_overview_open(id) {
            self.reader.close();
            self.detail.cancel_lookup();
            false
        } else {
            if self.editor.is_open() {
                if !self
                    .editor
                    .request_leave_from_form(super::editor::LeaveIntent::OpenOverview(
                        id.to_owned(),
                    ))
                {
                    self.editor_auto_start_revoked = true;
                    (self.wake)();
                    return false;
                }
                self.editor_suspended = false;
                self.editor_auto_start_revoked = true;
                self.editor.close();
            }
            if self.selected.as_deref() != Some(id) {
                self.select_unchecked(id);
            }
            self.reader.open_overview(id.to_owned());
            (self.wake)();
            true
        }
    }

    pub(super) fn toggle_task(&mut self, mission_id: &str, task_id: &str, task_key: &str) -> bool {
        if self.reader.is_task_open(mission_id, task_id) {
            self.reader.close();
            self.detail.cancel_lookup();
            false
        } else {
            if self.editor.is_open() {
                if !self
                    .editor
                    .request_leave_from_form(super::editor::LeaveIntent::OpenTask(
                        mission_id.to_owned(),
                        task_id.to_owned(),
                        task_key.to_owned(),
                    ))
                {
                    self.editor_auto_start_revoked = true;
                    (self.wake)();
                    return false;
                }
                self.editor_suspended = false;
                self.editor_auto_start_revoked = true;
                self.editor.close();
            }
            if self.selected.as_deref() != Some(mission_id) {
                self.select_unchecked(mission_id);
            }
            self.reader.open_task(
                mission_id.to_owned(),
                task_id.to_owned(),
                task_key.to_owned(),
            );
            (self.wake)();
            true
        }
    }

    pub(crate) fn show(&mut self, show: bool) {
        if self.visible == show {
            return;
        }
        self.visible = show;
        self.schedules.show(show);
        if show {
            self.refresh();
        } else {
            if !self.has_surface() {
                self.refresh_due = None;
                self.detail.cancel();
            }
            self.control_fields.cancel();
            self.observation.cancel();
            for lane in &mut self.lanes {
                if let Some((_, cancel)) = lane.active.take() {
                    cancel.close();
                }
                lane.owed = false;
            }
        }
    }

    pub(super) fn refresh(&mut self) {
        if self.visible {
            self.detail.refresh();
            self.observation.refresh();
            let (s, c) = self.schedule_parts();
            s.refresh(c);
            for kind in KINDS {
                if self.busy(kind) {
                    self.lanes[kind as usize].owed = true;
                } else {
                    self.start(kind, Read::Refresh);
                }
            }
        } else if self.has_surface() {
            self.detail.refresh();
        }
    }

    pub(crate) fn invalidate(&mut self, change: Option<(&str, u64)>, now: f64) {
        if let Some((id, revision)) = change {
            if self.selected.as_deref() == Some(id)
                || self.reader.target().is_some_and(|t| t.mission_id() == id)
                || self
                    .editor
                    .form
                    .as_ref()
                    .and_then(|f| f.edit.as_ref())
                    .is_some_and(|e| e.mission_id == id)
            {
                self.detail.observe(id, revision);
            }
            if self.selected.as_deref() == Some(id) {
                self.observation.observe(revision);
            }
        } else {
            // A reconnect retires publication authority while keeping the display.
            self.detail.cancel();
            self.observation.cancel();
            self.reader.invalidate();
            self.editor.invalidate_generation();
            self.editor_auto_start_revoked = true;
            self.schedules.invalidate();
            for lane in &mut self.lanes {
                if let Some((_, cancel)) = lane.active.take() {
                    cancel.close();
                }
            }
        }
        if (self.visible || self.has_surface()) && self.refresh_due.is_none() {
            self.refresh_due = Some(self.last_passive.map_or(now, |last| now.max(last + 1.5)));
            (self.wake)();
        }
    }

    pub(crate) fn invalidate_schedules(&mut self, now: f64) {
        self.schedules.invalidate();
        if self.visible && self.refresh_due.is_none() {
            self.refresh_due = Some(self.last_passive.map_or(now, |last| now.max(last + 1.5)));
            (self.wake)();
        }
    }

    pub(crate) fn refresh_when_due(&mut self, now: f64, tx: &mut rune::Tx) {
        self.now = now;
        self.observation.schedule(now, tx);
        if let Some(due) = self.refresh_due {
            if due > now {
                tx.wake_at(due);
            } else {
                self.refresh_due = None;
                self.last_passive = Some(now);
                self.refresh();
            }
        }
    }

    pub(crate) fn activity_changed(&mut self, now: f64) {
        if self.visible && self.selected.is_some() {
            self.observation.invalidate(now);
            (self.wake)();
        }
    }

    pub(super) fn more(&mut self, kind: Kind) {
        let lane = &self.lanes[kind as usize];
        if let Some(read) = lane.failed {
            self.start(kind, read);
        } else if self.has_more(kind) {
            self.start(kind, Read::More);
        }
    }

    pub(super) fn busy(&self, kind: Kind) -> bool {
        self.lanes[kind as usize].active.is_some()
    }

    pub(crate) fn matches(&self, backend: &Backend) -> bool {
        self.backend.workspace == backend.workspace
            && self.backend.base == backend.base
            && self.backend.client.same_connection(&backend.client)
    }

    pub(crate) fn supported(&self) -> bool {
        self.supported == Some(true)
    }

    pub(crate) fn probe(&mut self) {
        if self.supported.is_some() || self.probe_attempted {
            return;
        }
        self.probe_attempted = true;
        let backend = self.backend.clone();
        let (out, incoming) = bounded(1);
        self.capability = Some(incoming);
        let wake = self.wake.clone();
        let reads = self.reads.clone();
        platform::spawn(async move {
            let query = async || {
                let (_cancel, cancelled) = bounded(1);
                let _permit = reads.background(&cancelled).await?;
                let response = backend
                    .client
                    .get(format!("{}api/meta", backend.base))
                    .send()
                    .await
                    .ok()?
                    .error_for_status()
                    .ok()?;
                let value = codenomad_client::backend::read_json(response).await.ok()?;
                Some(
                    value["capabilities"]
                        .as_array()?
                        .iter()
                        .any(|value| value == "missions"),
                )
            };
            let check = async {
                // Like Solid, give the failed initial metadata flight one recovery read.
                match query().await {
                    None => query().await,
                    result => result,
                }
            };
            if let Some(supported) = codenomad_client::runtime::until_closed(&out, check).await
                && out.send(supported).await.is_ok()
            {
                wake();
            }
        });
    }

    pub(crate) fn cancel_probe(&mut self) {
        self.capability = None;
        self.probe_attempted = false;
    }

    pub(super) fn failed(&self, kind: Kind) -> bool {
        self.lanes[kind as usize].failed.is_some()
    }

    pub(super) fn loaded(&self, kind: Kind) -> bool {
        self.lanes[kind as usize].window.is_some()
    }

    pub(super) fn has_more(&self, kind: Kind) -> bool {
        self.lanes[kind as usize]
            .window
            .as_ref()
            .is_some_and(|w| w.end < w.total)
    }

    pub(super) fn covered(&self, kind: Kind) -> bool {
        self.loaded(kind) && !self.has_more(kind) && !self.failed(kind) && !self.busy(kind)
    }

    fn start(&mut self, kind: Kind, read: Read) {
        if !self.visible || self.busy(kind) {
            return;
        }
        let lane = &mut self.lanes[kind as usize];
        let (offset, order) = match (read, &lane.window) {
            (Read::Refresh, _) => (0, None),
            (Read::More, Some(window)) if window.end < window.total => {
                (window.end, Some(window.order.as_str()))
            }
            _ => return,
        };
        let project = self.project.as_deref();
        let opened = match kind {
            Kind::Summaries => {
                self.backend
                    .mission_summaries(project, offset, order, lane.window.is_none())
            }
            Kind::Cleanups => self.backend.mission_cleanups(project, offset, order),
        };
        let Ok(opened) = opened else {
            lane.failed = Some(read);
            return;
        };
        self.serial = self.serial.wrapping_add(1);
        let serial = self.serial;
        let (cancel, cancelled) = bounded(1);
        lane.active = Some((serial, cancel));
        let reads = self.reads.clone();
        let backend = self.backend.clone();
        let out = self.out.clone();
        let wake = self.wake.clone();
        platform::spawn(async move {
            if let Some(page) = read_window(opened, &reads, &cancelled).await
                && out
                    .send(Completion {
                        kind,
                        read,
                        serial,
                        backend,
                        page,
                    })
                    .await
                    .is_ok()
            {
                wake();
            }
        });
    }

    pub(crate) fn poll(&mut self) -> bool {
        let mut changed = false;
        if let Some(supported) = self.capability.as_ref().and_then(|r| r.try_recv().ok()) {
            self.capability = None;
            self.supported = supported;
            changed = self.supported();
        }
        while let Ok(done) = self.incoming.try_recv() {
            if let Err(error) = &done.page
                && codenomad_client::missions::is_auth_expired(error)
            {
                self.record_auth_expired(done.backend.clone());
            }
            let lane = &mut self.lanes[done.kind as usize];
            if lane
                .active
                .as_ref()
                .is_none_or(|(serial, _)| *serial != done.serial)
            {
                continue;
            }
            lane.active = None;
            changed = true;
            let owed = std::mem::take(&mut lane.owed);
            let keep_failed_more = done.read == Read::Refresh && lane.failed == Some(Read::More);
            let order = keep_failed_more
                .then(|| lane.window.as_ref().map(|w| w.order.clone()))
                .flatten();
            let outcome = done
                .page
                .map(|page| self.accept(done.kind, done.read, page));
            match outcome {
                Ok(true) => {
                    let lane = &mut self.lanes[done.kind as usize];
                    lane.failed = order.map(|order| {
                        if lane
                            .window
                            .as_ref()
                            .is_some_and(|window| window.order == order)
                        {
                            Read::More
                        } else {
                            Read::Refresh
                        }
                    });
                    if owed {
                        self.start(done.kind, Read::Refresh);
                    }
                }
                Err(error) => {
                    self.lanes[done.kind as usize].failed =
                        Some(if error.is::<DirectoryChanged>() {
                            Read::Refresh
                        } else {
                            done.read
                        });
                }
                Ok(false) => self.lanes[done.kind as usize].failed = Some(done.read),
            }
        }
        if self.reader_suspended && self.reader.is_open() {
            self.reader_suspended = false;
            self.detail.refresh();
        }
        if self.visible
            && let (Some(project), Some(id)) = (&self.project, &self.selected)
        {
            let revision = self
                .summaries
                .iter()
                .find(|row| row.id == *id)
                .map(|row| row.revision);
            let floor = self.detail.revision_floor(id, revision);
            changed |= self.observation.settle(floor, self.now, &self.wake);
            changed |= self.detail.poll(
                &self.backend,
                project,
                id,
                revision.max(self.observation.revision()),
                &self.reads,
                &self.wake,
            );
            if let Some(snapshot) = &self.detail.snapshot {
                changed |= self.observation.poll(
                    &self.backend,
                    project,
                    id,
                    snapshot.header.root.revision,
                    &self.reads,
                    &self.wake,
                );
            }
        } else if let Some(target_id) = self
            .reader
            .target()
            .map(|t| t.mission_id().to_owned())
            .or_else(|| self.editor.editing_mission_id().map(str::to_owned))
            && let Some(project) = self
                .project
                .as_deref()
                .or_else(|| {
                    self.detail
                        .snapshot
                        .as_ref()
                        .map(|s| s.header.root.project_id())
                })
                .map(str::to_owned)
        {
            let revision = self
                .summaries
                .iter()
                .find(|row| row.id == target_id)
                .map(|row| row.revision);
            let floor = self.detail.revision_floor(&target_id, revision);
            changed |= self.detail.poll(
                &self.backend,
                &project,
                &target_id,
                floor,
                &self.reads,
                &self.wake,
            );
        } else if let Some(edit_id) = self
            .editor
            .form
            .as_ref()
            .and_then(|f| f.edit.as_ref())
            .map(|e| e.mission_id.clone())
            && let Some(project) = self
                .project
                .as_deref()
                .or_else(|| {
                    self.detail
                        .snapshot
                        .as_ref()
                        .map(|s| s.header.root.project_id())
                })
                .or_else(|| {
                    self.editor
                        .form
                        .as_ref()
                        .and_then(|f| f.edit.as_ref())
                        .map(|e| e.project_id.as_str())
                })
                .map(str::to_owned)
        {
            let revision = self
                .summaries
                .iter()
                .find(|row| row.id == edit_id)
                .map(|row| row.revision);
            let floor = self.detail.revision_floor(&edit_id, revision);
            changed |= self.detail.poll(
                &self.backend,
                &project,
                &edit_id,
                floor,
                &self.reads,
                &self.wake,
            );
        } else if self.selected.is_none() {
            self.detail.clear();
            self.observation.reset();
            self.reader.follow_selection(None);
        }
        // Resolve or dispatch pending off-page task lookups AFTER detail.poll() so a lookup queued
        // behind Refresh/More/Attention starts in the same cycle once detail settles.
        let mut started_lookup = false;
        if let Some((mid, tkey)) = self
            .reader
            .pending_lookup()
            .map(|(m, k)| (m.to_owned(), k.to_owned()))
            && let Some((found, exhausted)) = self
                .detail
                .snapshot
                .as_ref()
                .filter(|s| s.header.root.id == mid)
                .map(|s| {
                    (
                        s.tasks
                            .find_by_key(&tkey)
                            .map(|t| (t.id.clone(), t.key.clone())),
                        s.tasks.len() >= s.header.tasks.page.total,
                    )
                })
        {
            if let Some((tid, key)) = found {
                self.reader.resolve_lookup(mid, tid, key);
                changed = true;
            } else if self.detail.take_lookup_failed("", &tkey) {
                self.reader.fail_lookup_error(tkey);
                changed = true;
            } else if exhausted || self.detail.lookup_settled("", &tkey) {
                self.reader.fail_lookup(tkey);
                changed = true;
            } else if !self.detail.busy() {
                self.detail.lookup_task(None, Some(&tkey));
                started_lookup = true;
            }
        }
        if let Some(super::reader::ReaderTarget::Task {
            mission_id,
            task_id,
            task_key,
        }) = self.reader.target().cloned()
            && let Some((found, has_more)) = self
                .detail
                .snapshot
                .as_ref()
                .filter(|s| s.header.root.id == mission_id)
                .map(|s| {
                    (
                        s.tasks
                            .find_by_id_or_key(&task_id, &task_key)
                            .map(|t| (t.id.clone(), t.key.clone())),
                        s.tasks.len() < s.header.tasks.page.total,
                    )
                })
        {
            if let Some((id, key)) = found {
                self.reader.bind_task_identity(&mission_id, &id, &key);
                self.reader.clear_lookup_error();
            } else if self.detail.take_lookup_failed(&task_id, &task_key) {
                self.reader.fail_lookup_error(task_key);
                changed = true;
            } else if !self.detail.busy()
                && self.reader.lookup_failed().is_none()
                && !self.detail.lookup_settled(&task_id, &task_key)
                && has_more
            {
                self.detail.lookup_task(
                    (!task_id.is_empty()).then_some(task_id.as_str()),
                    (!task_key.is_empty()).then_some(task_key.as_str()),
                );
                started_lookup = true;
            }
        }
        if started_lookup
            && let Some(snapshot) = &self.detail.snapshot
            && let Some(project) = self
                .project
                .as_deref()
                .or(Some(snapshot.header.root.project_id()))
                .map(str::to_owned)
        {
            let target_id = snapshot.header.root.id.clone();
            changed |= self.detail.poll(
                &self.backend,
                &project,
                &target_id,
                None,
                &self.reads,
                &self.wake,
            );
        }
        let reader_project = self.project.as_deref().or_else(|| {
            self.detail
                .snapshot
                .as_ref()
                .map(|s| s.header.root.project_id())
        });
        changed |= self.reader.poll(
            &self.backend,
            reader_project,
            self.detail.snapshot.as_ref(),
            &self.reads,
            &self.wake,
        );
        changed |= self.editor.poll_async(&self.backend);
        changed | self.poll_control_fields()
    }

    fn accept(&mut self, kind: Kind, read: Read, page: DirectoryPage) -> bool {
        if self
            .project
            .as_ref()
            .is_some_and(|project| project != &page.project_id)
        {
            return false;
        }
        let lane = &mut self.lanes[kind as usize];
        if read == Read::More
            && lane.window.as_ref().is_none_or(|w| {
                page.window.order != w.order
                    || page.window.offset != w.end
                    || page.window.total != w.total
            })
        {
            return false;
        }
        if read == Read::Refresh
            && lane.window.as_ref().is_some_and(|w| {
                w.order == page.window.order
                    && w.total == page.window.total
                    && w.end > page.window.end
            })
        {
            return true;
        }
        match (kind, page.rows) {
            (Kind::Summaries, DirectoryRows::Summaries(rows)) => {
                if !merge(&mut self.summaries, lane, read, &page.window, rows, |row| {
                    (row.id.clone(), None)
                }) {
                    return false;
                }
                // A page that does not cover the directory cannot prove a selection is gone.
                if page.window.end == page.window.total
                    && self
                        .selected
                        .as_ref()
                        .is_some_and(|id| !self.summaries.iter().any(|row| &row.id == id))
                {
                    self.selected = None;
                    self.reader.follow_selection(None);
                }
            }
            (Kind::Cleanups, DirectoryRows::Cleanups(rows)) => {
                if rows.iter().any(|row| {
                    self.cleanups.iter().any(|old| {
                        old.mission_id == row.mission_id
                            && old.deletion_id == row.deletion_id
                            && (old.request_id != row.request_id
                                || old.expected_revision != row.expected_revision
                                || old.delete_managed_sessions != row.delete_managed_sessions)
                    })
                }) || !merge(&mut self.cleanups, lane, read, &page.window, rows, |row| {
                    (row.mission_id.clone(), Some(row.deletion_id.clone()))
                }) {
                    return false;
                }
            }
            _ => return false,
        }
        self.project = Some(page.project_id);
        lane.window = Some(page.window);
        true
    }

    pub(super) fn select(&mut self, id: &str) {
        if self.selected.as_deref() != Some(id) && self.summaries.iter().any(|row| row.id == id) {
            if self.editor.is_open() && self.editor.editing_mission_id() != Some(id) {
                if !self
                    .editor
                    .request_leave_from_form(super::editor::LeaveIntent::SelectMission(
                        id.to_owned(),
                    ))
                {
                    self.editor_auto_start_revoked = true;
                    (self.wake)();
                    return;
                }
                self.editor_suspended = false;
                self.editor_auto_start_revoked = true;
                self.editor.close();
            }
            self.select_unchecked(id);
        }
    }

    fn select_unchecked(&mut self, id: &str) {
        if self.selected.as_deref() != Some(id) && self.summaries.iter().any(|row| row.id == id) {
            self.schedules.clear_selection();
            self.control_fields.cancel();
            self.detail.clear();
            self.observation.reset();
            self.selected = Some(id.into());
            self.reader.follow_selection(Some(id));
        }
    }

    fn schedule_project(&self) -> Option<&str> {
        self.project
            .as_deref()
            .or(self.schedules.project_id.as_deref())
    }

    pub(super) fn schedule_ctx(&self) -> super::schedules::ScheduleCtx<'_> {
        super::schedules::ScheduleCtx {
            backend: &self.backend,
            project: self.project.as_deref(),
            scope: &self.owner_scope,
            directory: self.directory.as_deref(),
            reads: &self.reads,
            wake: &self.wake,
        }
    }

    pub(super) fn schedule_parts(
        &mut self,
    ) -> (
        &mut super::schedules::Schedules,
        super::schedules::ScheduleCtx<'_>,
    ) {
        let ctx = super::schedules::ScheduleCtx {
            backend: &self.backend,
            project: self.project.as_deref(),
            scope: &self.owner_scope,
            directory: self.directory.as_deref(),
            reads: &self.reads,
            wake: &self.wake,
        };
        (&mut self.schedules, ctx)
    }

    fn select_schedule_unchecked(&mut self, id: String) {
        self.control_fields.cancel();
        self.detail.clear();
        self.observation.reset();
        self.selected = None;
        self.reader.follow_selection(None);
        let (s, c) = self.schedule_parts();
        s.select(id, c);
        (self.wake)();
    }

    pub(crate) fn active_schedule_view<'a>(
        &'a self,
        occurrence: &'a str,
    ) -> Option<super::schedules::ActiveScheduleView<'a>> {
        Some(super::schedules::ActiveScheduleView {
            occurrence,
            backend: &self.backend,
            project: self.schedule_project()?,
            scope: &self.owner_scope,
            selected: self.schedules.selected.as_deref(),
            view_epoch: self.schedules.view_epoch(),
            wake: &self.wake,
        })
    }

    pub(crate) fn selected_schedule_hold_key(&self) -> Option<super::schedules::ScheduleHoldKey> {
        Some(super::schedules::ScheduleHoldKey::new(
            &self.backend,
            self.schedule_project()?,
            &self.owner_scope,
            self.schedules.selected.as_deref()?,
        ))
    }

    pub(crate) fn poll_schedules(&mut self, holds: &mut super::schedules::ScheduleHolds) -> bool {
        let (s, c) = self.schedule_parts();
        let changed = s.poll(holds, c);
        if self.project.is_none() {
            self.project = self.schedules.project_id.clone();
        }
        changed
    }

    pub(crate) fn commit_schedule_pre(
        &mut self,
        holds: &mut super::schedules::ScheduleHolds,
        en: bool,
        auth_expired: &[Backend],
    ) -> bool {
        let allow = en && !self.editor.is_open();
        let (s, c) = self.schedule_parts();
        s.commit_pre(holds, c, allow, auth_expired)
    }

    pub(crate) fn schedule_confirmation_valid(
        &self,
        holds: &super::schedules::ScheduleHolds,
        c: &super::schedules::ScheduleConfirmation,
    ) -> bool {
        !self.editor.is_open()
            && self.schedules.visible()
            && self.schedules.generation == c.generation
            && self.selected_schedule_hold_key().as_ref() == Some(&c.key)
            && self.schedules.is_fresh(&c.key.schedule_id)
            && self
                .schedules
                .selected_document(holds, self.schedule_ctx())
                .is_some_and(|d| {
                    d.revision == c.expected_revision && d.owns_directory(self.directory.as_deref())
                })
            && self
                .schedules
                .hold_for(holds, self.schedule_ctx(), &c.key.schedule_id)
                .is_none()
    }

    pub(crate) fn apply_schedule_hold_events(
        &mut self,
        events: &[super::schedules::ScheduleHoldEvent],
    ) -> bool {
        let (s, c) = self.schedule_parts();
        s.apply_hold_events(events, c)
    }

    pub(crate) fn schedule_gesture(
        &mut self,
        occurrence: &str,
        holds: &mut super::schedules::ScheduleHolds,
        gesture: super::schedules::ScheduleGesture,
    ) -> bool {
        if let super::schedules::ScheduleGesture::Select(id) = gesture {
            if self.schedules.selected.as_deref() == Some(id.as_str()) {
                return false;
            }
            if self.editor.is_open() {
                if !self
                    .editor
                    .request_leave_from_form(super::editor::LeaveIntent::SelectSchedule(id.clone()))
                {
                    self.editor_auto_start_revoked = true;
                    (self.wake)();
                    return false;
                }
                self.editor_suspended = false;
                self.editor_auto_start_revoked = true;
                self.editor.close();
            }
            holds.confirmation = None;
            self.select_schedule_unchecked(id);
            return true;
        }
        let allow = !self.editor.is_open();
        let (s, c) = self.schedule_parts();
        let changed = s.handle_gesture(occurrence, gesture, holds, c, allow);
        if changed {
            (self.wake)();
        }
        changed
    }

    pub(crate) fn owns_schedule_conversation_target(
        &self,
        holds: &super::schedules::ScheduleHolds,
        sid: &str,
    ) -> bool {
        self.schedules
            .selected_document(holds, self.schedule_ctx())
            .is_some_and(|d| d.owns_session(sid))
    }

    pub(crate) fn has_eye_trigger(&self, key: &str) -> bool {
        if let Some(mission_id) = key.strip_prefix("mission-row-eye-") {
            self.shown_rows().any(|row| row.id == mission_id)
        } else if let Some(task_id) = key.strip_prefix("mission-task-eye-") {
            self.detail
                .snapshot
                .as_ref()
                .is_some_and(|snap| snap.tasks.find_by_id_or_key(task_id, "").is_some())
        } else {
            false
        }
    }

    pub(super) fn shown_rows(&self) -> impl Iterator<Item = &Summary> {
        let filter = self.filter.text.trim().to_lowercase();
        self.summaries.iter().filter(move |row| {
            self.selected.as_deref() == Some(&row.id)
                || filter.is_empty()
                || title(row).to_lowercase().contains(&filter)
        })
    }
}

pub(super) fn title(row: &Summary) -> &str {
    row.title
        .as_deref()
        .filter(|text| !text.is_empty())
        .unwrap_or(&row.objective)
}

impl Drop for Panel {
    fn drop(&mut self) {
        self.suspend();
    }
}

fn merge<T>(
    display: &mut Vec<T>,
    lane: &mut Lane,
    read: Read,
    window: &Window,
    rows: Vec<T>,
    key: impl Fn(&T) -> (String, Option<String>),
) -> bool {
    if read == Read::Refresh {
        lane.seen.clear();
    } else if rows.iter().any(|row| lane.seen.contains(&key(row))) {
        return false;
    }
    // Current-order rows are a prefix; keep the previous snapshot's unvisited rows after it.
    let previous = std::mem::take(display);
    let prefix = lane.seen.len();
    lane.seen.extend(rows.iter().map(&key));
    let mut previous = previous.into_iter();
    display.extend(previous.by_ref().take(prefix));
    display.extend(rows);
    if window.end != window.total {
        display.extend(previous.filter(|row| !lane.seen.contains(&key(row))));
    }
    true
}

#[cfg(test)]
mod tests;
