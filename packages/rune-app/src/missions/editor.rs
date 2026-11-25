//! One-time Mission create and edit editor form state.
//! In-flight/uncertain mutations live in window-scoped `editor_holds::EditorHolds`
//! so holds survive closing the form, switching Missions, or closing and reopening tabs.
#[cfg(test)]
mod tests;

use super::{
    detail::Snapshot,
    editor_holds::{
        ActiveEditor, CreationHoldView, CreationScopeKey, EditHoldKey, EditHoldView, EditorEvent,
        EditorHolds, FormOrigin, HoldState,
    },
};
use crate::platform::{self, reads::Reads};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    missions::{
        BodyDescriptor, ContentSelector, CreateMissionRequest, EditorBodyOutcome, LifecycleTarget,
        MISSION_TEXT_MAX, MISSION_TITLE_MAX, MapHeader, RunState, TaskMode, Template,
        UpdateMissionRequest, derive_mission_title, js_trim, request_id, utf16_len,
        valid_notes_input, valid_objective_input, valid_title_input,
    },
};
use rune::edit::TextEdit;

pub(super) const TITLE_LIMIT: usize = MISSION_TITLE_MAX;
pub(super) const TEXT_LIMIT: usize = MISSION_TEXT_MAX;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Mode {
    Create,
    Edit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PrefillState {
    Loading,
    Ready,
    Changed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum EditorGesture {
    OpenCreate { return_focus: Option<String> },
    OpenEdit { return_focus: Option<String> },
    Submit,
    ReconcileCreation,
    ReconcileEdit,
    RetryPrefill,
    Reopen,
}

#[derive(Clone, Debug)]
pub(super) struct EditTarget {
    pub mission_id: String,
    pub project_id: String,
    pub expected_revision: u64,
    pub title: String,
    pub excerpt: String,
    pub template: Template,
    pub task_mode: TaskMode,
    pub run_state: Option<RunState>,
    pub objective_body: Option<BodyDescriptor>,
    pub notes_body: Option<BodyDescriptor>,
    pub target: LifecycleTarget,
    pub read_only: bool,
}

impl EditTarget {
    pub(super) fn from_header(header: &MapHeader) -> Self {
        Self {
            mission_id: header.root.id.clone(),
            project_id: header.root.project_id().to_owned(),
            expected_revision: header.root.revision,
            title: header.root.title.clone().unwrap_or_default(),
            excerpt: header.root.excerpt.clone(),
            template: header.root.template,
            task_mode: header.root.task_mode(),
            run_state: header.root.run_state,
            objective_body: header.root.body("objective").cloned(),
            notes_body: header.root.body("notes").cloned(),
            target: header.lifecycle_target(),
            read_only: !header.root.editable(),
        }
    }

    pub(super) fn from_hold(
        hold: &EditHoldView,
        title: String,
        template: Template,
        run_state: Option<RunState>,
    ) -> Self {
        Self {
            mission_id: hold.target.mission.clone(),
            project_id: hold.target.project.clone(),
            expected_revision: hold.request.expected_revision,
            title,
            excerpt: String::new(),
            template,
            task_mode: TaskMode::Native,
            run_state,
            objective_body: None,
            notes_body: None,
            target: hold.target.clone(),
            read_only: true,
        }
    }

    pub(super) fn hold_key(&self, backend: &Backend) -> EditHoldKey {
        EditHoldKey::new(backend, &self.project_id, &self.mission_id)
    }
}

pub(crate) struct Form {
    pub(super) generation: u64,
    pub(super) mode: Mode,
    pub(super) objective: TextEdit,
    pub(super) title: TextEdit,
    pub(super) notes: TextEdit,
    pub(super) template: Template,
    pub(super) task_mode: TaskMode,
    pub(super) start_on_creation: bool,
    pub(super) prefill: PrefillState,
    pub(super) edit: Option<EditTarget>,
    pub(super) reopening: Option<u64>,
    pub(super) reopen_target: Option<EditTarget>,
    pub(super) previous_draft: Option<String>,
    pub(super) previous_draft_open: bool,
    pub(super) lock_help_open: bool,
    pub(super) request_id: String,
    pub(super) last_payload: String,
    pub(super) error: Option<&'static str>,
    pub(super) edit_conflict: bool,
    pub(super) return_focus: Option<String>,
    pub(super) close: crate::components::window_close_button::WindowCloseState,
}

impl Form {
    fn new_create(
        generation: u64,
        hold: Option<&CreationHoldView>,
        return_focus: Option<String>,
    ) -> Self {
        let mut form = Self {
            generation,
            mode: Mode::Create,
            objective: TextEdit::new(""),
            title: TextEdit::new(""),
            notes: TextEdit::new(""),
            template: Template::Custom,
            task_mode: TaskMode::Native,
            start_on_creation: false,
            prefill: PrefillState::Ready,
            edit: None,
            reopening: None,
            reopen_target: None,
            previous_draft: None,
            previous_draft_open: false,
            lock_help_open: false,
            request_id: request_id().unwrap_or_default(),
            last_payload: String::new(),
            error: None,
            edit_conflict: false,
            return_focus,
            close: Default::default(),
        };
        if let Some(hold) = hold {
            form.adopt_creation_hold(hold);
        }
        form
    }

    fn new_edit(
        generation: u64,
        target: EditTarget,
        hold: Option<&EditHoldView>,
        return_focus: Option<String>,
    ) -> Self {
        let mut form = Self {
            generation,
            mode: Mode::Edit,
            objective: TextEdit::new(""),
            title: TextEdit::new(&target.title),
            notes: TextEdit::new(""),
            template: target.template,
            task_mode: target.task_mode,
            start_on_creation: false,
            prefill: if hold.is_some() {
                PrefillState::Ready
            } else {
                PrefillState::Loading
            },
            edit: Some(target),
            reopening: None,
            reopen_target: None,
            previous_draft: None,
            previous_draft_open: false,
            lock_help_open: false,
            request_id: request_id().unwrap_or_default(),
            last_payload: String::new(),
            error: None,
            edit_conflict: false,
            return_focus,
            close: Default::default(),
        };
        if let Some(hold) = hold {
            form.adopt_edit_hold(hold);
        }
        form
    }

    fn adopt_creation_hold(&mut self, hold: &CreationHoldView) {
        self.objective = TextEdit::new(&hold.request.objective);
        self.title = TextEdit::new(hold.request.title.as_deref().unwrap_or(""));
        self.notes = TextEdit::new(hold.request.notes.as_deref().unwrap_or(""));
        self.template = hold.request.template;
        self.task_mode = hold.request.task_mode.unwrap_or_default();
        self.start_on_creation = hold.start_on_creation;
        self.request_id = hold.request.request_id.clone();
        self.last_payload = create_payload_identity(
            &hold.request.objective,
            hold.request.title.as_deref().unwrap_or(""),
            hold.request.notes.as_deref().unwrap_or(""),
            hold.request.template,
            hold.request.task_mode.unwrap_or_default(),
        );
        self.error = None;
    }

    fn adopt_edit_hold(&mut self, hold: &EditHoldView) {
        self.objective = TextEdit::new(&hold.request.objective);
        self.notes = TextEdit::new(hold.request.notes.as_deref().unwrap_or(""));
        self.prefill = PrefillState::Ready;
        self.request_id = hold.request.request_id.clone();
        self.last_payload = edit_payload_identity(
            hold.request.expected_revision,
            &hold.request.objective,
            hold.request.notes.as_deref().unwrap_or(""),
        );
        self.reopening = None;
        self.reopen_target = None;
        self.edit_conflict = false;
        self.error = None;
    }

    pub(super) fn derived_title(&self) -> String {
        derive_mission_title(&self.objective.text)
    }

    pub(super) fn is_locked(
        &self,
        creation_hold: Option<&CreationHoldView>,
        edit_hold: Option<&EditHoldView>,
    ) -> bool {
        if self.reopening.is_some() {
            return true;
        }
        match self.mode {
            Mode::Create => creation_hold.is_some(),
            Mode::Edit => {
                edit_hold.is_some()
                    || self.prefill != PrefillState::Ready
                    || self.edit.as_ref().is_some_and(|e| e.read_only)
            }
        }
    }

    pub(super) fn is_structural_locked(
        &self,
        creation_hold: Option<&CreationHoldView>,
        edit_hold: Option<&EditHoldView>,
    ) -> bool {
        self.mode == Mode::Edit || self.is_locked(creation_hold, edit_hold)
    }

    pub(super) fn is_pending(
        &self,
        creation_hold: Option<&CreationHoldView>,
        edit_hold: Option<&EditHoldView>,
    ) -> bool {
        match self.mode {
            Mode::Create => creation_hold.is_some_and(|h| h.state == HoldState::Pending),
            Mode::Edit => edit_hold.is_some_and(|h| h.state == HoldState::Pending),
        }
    }

    pub(super) fn compare_error(&self) -> Option<&'static str> {
        (self.mode == Mode::Create && self.template == Template::Compare)
            .then_some("missions.compare.compare-models-required")
    }

    pub(super) fn can_submit(
        &self,
        creation_hold: Option<&CreationHoldView>,
        edit_hold: Option<&EditHoldView>,
    ) -> bool {
        if self.is_locked(creation_hold, edit_hold) {
            return false;
        }
        if !valid_objective_input(&self.objective.text) || !valid_notes_input(&self.notes.text) {
            return false;
        }
        match self.mode {
            Mode::Create => valid_title_input(&self.title.text) && self.compare_error().is_none(),
            Mode::Edit => self.edit.is_some() && !self.edit_conflict,
        }
    }
}

struct PrefillReply {
    serial: u64,
    objective: EditorBodyOutcome,
    notes: EditorBodyOutcome,
    backend: Backend,
}

#[derive(Clone, Debug)]
pub(crate) struct AppliedSave {
    pub mission_id: String,
    pub revision: u64,
    pub select: bool,
    pub closed_form: bool,
    pub return_focus: Option<String>,
}

#[derive(Default)]
pub(crate) struct Editor {
    pub(super) form: Option<Form>,
    form_generation: u64,
    prefill_flight: Option<Receiver<PrefillReply>>,
    prefill_cancel: Option<Sender<()>>,
    prefill_serial: u64,
    auth_expired: Option<Backend>,
    focus_initial: Option<&'static str>,
}

impl Editor {
    fn next_generation(&mut self) -> u64 {
        self.form_generation = self.form_generation.saturating_add(1);
        self.form_generation
    }

    pub(crate) fn is_open(&self) -> bool {
        self.form.is_some()
    }

    pub(crate) fn is_composing(&self) -> bool {
        self.form.as_ref().is_some_and(|form| {
            form.objective.is_composing() || form.title.is_composing() || form.notes.is_composing()
        })
    }

    pub(crate) fn rebind(
        &mut self,
        scope: &CreationScopeKey,
        backend: &Backend,
        holds: &mut EditorHolds,
        reads: &Reads,
        wake: &Wake,
    ) {
        self.cancel_prefill();
        holds.revoke_auto_start_for_scope(scope);
        let restart = self.form.as_ref().and_then(|form| {
            if form.mode == Mode::Edit
                && (form.prefill != PrefillState::Ready || form.reopen_target.is_some())
            {
                form.reopen_target.clone().or_else(|| form.edit.clone())
            } else {
                None
            }
        });
        if let Some(target) = restart
            && holds.edit(&target.hold_key(backend)).is_none()
        {
            if let Some(form) = &mut self.form
                && form.reopen_target.is_none()
            {
                form.prefill = PrefillState::Loading;
            }
            self.start_prefill(target, backend, reads, wake);
        }
    }

    pub(crate) fn editing_mission_id(&self) -> Option<&str> {
        self.form
            .as_ref()
            .filter(|form| form.mode == Mode::Edit)
            .and_then(|form| form.edit.as_ref())
            .map(|edit| edit.mission_id.as_str())
    }

    pub(crate) fn active_edit_key(&self, backend: &Backend) -> Option<EditHoldKey> {
        self.form
            .as_ref()
            .filter(|form| form.mode == Mode::Edit)
            .and_then(|form| form.edit.as_ref())
            .map(|edit| edit.hold_key(backend))
    }

    pub(crate) fn active_context<'a>(
        &self,
        occurrence: &str,
        backend: &'a Backend,
        wake: &'a Wake,
    ) -> Option<ActiveEditor<'a>> {
        let form = self.form.as_ref()?;
        Some(ActiveEditor {
            origin: FormOrigin {
                occurrence: occurrence.to_owned(),
                generation: form.generation,
            },
            mode: form.mode,
            backend,
            wake,
        })
    }

    pub(crate) fn active_hold(
        &self,
        scope: &CreationScopeKey,
        holds: &EditorHolds,
    ) -> Option<CreationHoldView> {
        holds.creation(scope)
    }

    pub(crate) fn active_edit_hold(
        &self,
        backend: &Backend,
        holds: &EditorHolds,
    ) -> Option<EditHoldView> {
        let key = self.active_edit_key(backend)?;
        holds.edit(&key)
    }

    pub(crate) fn open_create(
        &mut self,
        scope: &CreationScopeKey,
        holds: &mut EditorHolds,
        return_focus: Option<String>,
    ) {
        self.cancel_prefill();
        holds.revoke_auto_start_for_scope(scope);
        let generation = self.next_generation();
        let hold = holds.creation(scope);
        self.form = Some(Form::new_create(generation, hold.as_ref(), return_focus));
        self.focus_initial = Some(if hold.is_some() {
            "mission-editor-close"
        } else {
            "mission-editor-objective"
        });
    }

    pub(crate) fn open_edit(
        &mut self,
        header: &MapHeader,
        scope: &CreationScopeKey,
        backend: &Backend,
        holds: &mut EditorHolds,
        reads: &Reads,
        wake: &Wake,
        return_focus: Option<String>,
    ) -> bool {
        let target = EditTarget::from_header(header);
        let hold = holds.edit(&target.hold_key(backend));
        if target.read_only && hold.is_none() {
            return false;
        }
        self.cancel_prefill();
        holds.revoke_auto_start_for_scope(scope);
        let generation = self.next_generation();
        self.form = Some(Form::new_edit(
            generation,
            target.clone(),
            hold.as_ref(),
            return_focus,
        ));
        // Fields are disabled while prefilling or under an uncertain edit hold; focus Close.
        self.focus_initial = Some("mission-editor-close");
        if hold.is_none() {
            self.start_prefill(target, backend, reads, wake);
        }
        true
    }

    pub(crate) fn open_edit_hold_only(
        &mut self,
        hold: &EditHoldView,
        title: String,
        template: Template,
        run_state: Option<RunState>,
        scope: &CreationScopeKey,
        holds: &mut EditorHolds,
        return_focus: Option<String>,
    ) {
        self.cancel_prefill();
        holds.revoke_auto_start_for_scope(scope);
        let generation = self.next_generation();
        let target = EditTarget::from_hold(hold, title, template, run_state);
        self.form = Some(Form::new_edit(generation, target, Some(hold), return_focus));
        self.focus_initial = Some("mission-editor-close");
    }

    pub(crate) fn close(&mut self) -> Option<String> {
        self.cancel_prefill();
        let _ = self.next_generation();
        self.focus_initial = None;
        self.form.take().and_then(|form| form.return_focus)
    }

    pub(crate) fn suspend(&mut self) {
        self.cancel_prefill();
    }

    /// Resumes any prefill or conflict-reopen interrupted by `suspend()` on the same connection.
    /// Returns `true` when the caller must request a fresh detail refresh and pass its serial to `set_reopen_since`.
    pub(crate) fn resume(
        &mut self,
        backend: &Backend,
        holds: &EditorHolds,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        if self.active_edit_hold(backend, holds).is_some() {
            return false;
        }
        let Some(form) = self.form.as_ref() else {
            return false;
        };
        if form.mode != Mode::Edit {
            return false;
        }
        if form.reopening.is_some() && form.reopen_target.is_none() {
            return true;
        }
        if self.prefill_flight.is_none() {
            let restart = if let Some(target) = form.reopen_target.clone() {
                Some(target)
            } else if form.prefill == PrefillState::Loading {
                form.edit.clone()
            } else {
                None
            };
            if let Some(target) = restart {
                self.start_prefill(target, backend, reads, wake);
            }
        }
        false
    }

    pub(super) fn set_reopen_since(&mut self, since_started: u64) {
        if let Some(form) = &mut self.form
            && form.reopening.is_some()
        {
            form.reopening = Some(since_started);
        }
    }

    pub(crate) fn take_initial_focus(&mut self) -> Option<&'static str> {
        self.focus_initial.take()
    }

    pub(crate) fn take_auth_expired(&mut self) -> Option<Backend> {
        self.auth_expired.take()
    }

    pub(super) fn retry_prefill(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        let Some(target) = self
            .form
            .as_ref()
            .filter(|f| f.mode == Mode::Edit)
            .and_then(|f| f.reopen_target.as_ref().or(f.edit.as_ref()))
            .cloned()
        else {
            return;
        };
        if let Some(form) = &mut self.form {
            if form.reopen_target.is_none() {
                form.prefill = PrefillState::Loading;
            }
            form.error = None;
        }
        self.start_prefill(target, backend, reads, wake);
    }

    pub(super) fn begin_reopen(
        &mut self,
        backend: &Backend,
        holds: &EditorHolds,
        map_reads: u64,
    ) -> bool {
        if self.active_edit_hold(backend, holds).is_some() {
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.mode != Mode::Edit || form.edit.is_none() || form.reopening.is_some() {
            return false;
        }
        form.reopening = Some(map_reads);
        form.reopen_target = None;
        form.error = None;
        true
    }

    pub(super) fn observe_detail(
        &mut self,
        snapshot: Option<&Snapshot>,
        refresh_completed: u64,
        refresh_failed: u64,
        backend: &Backend,
        holds: &EditorHolds,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        let Some((since_started, edit_id)) = self.form.as_ref().and_then(|form| {
            (form.mode == Mode::Edit && form.reopen_target.is_none())
                .then(|| Some((form.reopening?, form.edit.as_ref()?.mission_id.clone())))
                .flatten()
        }) else {
            return false;
        };
        if self.active_edit_hold(backend, holds).is_some() {
            if let Some(form) = &mut self.form {
                form.reopening = None;
            }
            return true;
        }
        if refresh_failed > since_started {
            if let Some(form) = &mut self.form {
                form.reopening = None;
                form.error = Some("missions.control.reader.unavailable");
            }
            return true;
        }
        if refresh_completed > since_started
            && let Some(snap) = snapshot
            && snap.header.root.id == edit_id
        {
            if !snap.header.root.editable() {
                if let Some(form) = &mut self.form {
                    form.reopening = None;
                    form.error = Some("missions.scheduling.lock.terminal");
                    form.edit_conflict = true;
                }
                return true;
            }
            let target = EditTarget::from_header(&snap.header);
            // Keep the current draft untouched until the new target's prefill succeeds.
            if let Some(form) = &mut self.form {
                form.reopen_target = Some(target.clone());
            }
            self.start_prefill(target, backend, reads, wake);
            return true;
        }
        false
    }

    pub(super) fn submit(
        &mut self,
        occurrence: &str,
        scope: &CreationScopeKey,
        backend: &Backend,
        holds: &mut EditorHolds,
        wake: &Wake,
    ) -> bool {
        let Some(mode) = self.form.as_ref().map(|f| f.mode) else {
            return false;
        };
        match mode {
            Mode::Create => self.submit_create(occurrence, scope, backend, holds, wake),
            Mode::Edit => self.submit_edit(occurrence, backend, holds, wake),
        }
    }

    fn submit_create(
        &mut self,
        occurrence: &str,
        scope: &CreationScopeKey,
        backend: &Backend,
        holds: &mut EditorHolds,
        wake: &Wake,
    ) -> bool {
        if let Some(existing) = holds.creation(scope) {
            if let Some(form) = &mut self.form {
                form.adopt_creation_hold(&existing);
            }
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if !form.can_submit(None, None) {
            return false;
        }
        let payload_key = create_payload_identity(
            &form.objective.text,
            &form.title.text,
            &form.notes.text,
            form.template,
            form.task_mode,
        );
        if (!form.last_payload.is_empty() && form.last_payload != payload_key)
            || form.request_id.is_empty()
        {
            let Ok(fresh_id) = request_id() else {
                form.error = Some("missions.control.mutation.error");
                return true;
            };
            form.request_id = fresh_id;
        }
        form.last_payload = payload_key;
        let title = (!js_trim(&form.title.text).is_empty()).then_some(form.title.text.as_str());
        let Ok(request) = CreateMissionRequest::with_request_id(
            form.request_id.clone(),
            &form.objective.text,
            title,
            &form.notes.text,
            form.template,
            form.task_mode,
        ) else {
            form.error = Some("missions.control.mutation.error");
            return true;
        };
        form.error = None;
        let start_on_creation = form.start_on_creation;
        let origin = FormOrigin {
            occurrence: occurrence.to_owned(),
            generation: form.generation,
        };
        if !holds.start_create(
            scope.clone(),
            request,
            start_on_creation,
            origin,
            backend,
            wake,
        ) {
            form.error = Some("missions.control.mutation.error");
        }
        true
    }

    fn submit_edit(
        &mut self,
        occurrence: &str,
        backend: &Backend,
        holds: &mut EditorHolds,
        wake: &Wake,
    ) -> bool {
        let Some(target) = self.form.as_ref().and_then(|f| f.edit.clone()) else {
            return false;
        };
        let key = target.hold_key(backend);
        if let Some(existing) = holds.edit(&key) {
            if let Some(form) = &mut self.form {
                form.adopt_edit_hold(&existing);
            }
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if !form.can_submit(None, None) {
            return false;
        }
        let payload_key = edit_payload_identity(
            target.expected_revision,
            &form.objective.text,
            &form.notes.text,
        );
        if (!form.last_payload.is_empty() && form.last_payload != payload_key)
            || form.request_id.is_empty()
        {
            let Ok(fresh_id) = request_id() else {
                form.error = Some("missions.control.mutation.error");
                return true;
            };
            form.request_id = fresh_id;
        }
        form.last_payload = payload_key;
        let Ok(request) = UpdateMissionRequest::with_request_id(
            form.request_id.clone(),
            target.expected_revision,
            &form.objective.text,
            &form.notes.text,
        ) else {
            form.error = Some("missions.control.mutation.error");
            return true;
        };
        form.error = None;
        let origin = FormOrigin {
            occurrence: occurrence.to_owned(),
            generation: form.generation,
        };
        if !holds.start_edit(key, target.target, request, origin, backend, wake) {
            form.error = Some("missions.control.mutation.error");
        }
        true
    }

    pub(super) fn reconcile_creation(
        &mut self,
        occurrence: &str,
        scope: &CreationScopeKey,
        backend: &Backend,
        holds: &mut EditorHolds,
        wake: &Wake,
    ) -> bool {
        let origin = self
            .form
            .as_ref()
            .filter(|f| f.mode == Mode::Create)
            .map(|f| FormOrigin {
                occurrence: occurrence.to_owned(),
                generation: f.generation,
            });
        holds.reconcile_creation(scope, origin, backend, wake)
    }

    pub(super) fn reconcile_edit(
        &mut self,
        occurrence: &str,
        backend: &Backend,
        holds: &mut EditorHolds,
        wake: &Wake,
    ) -> bool {
        let Some(key) = self.active_edit_key(backend) else {
            return false;
        };
        let origin = self
            .form
            .as_ref()
            .filter(|f| f.mode == Mode::Edit)
            .map(|f| FormOrigin {
                occurrence: occurrence.to_owned(),
                generation: f.generation,
            });
        holds.reconcile_edit(&key, origin, backend, wake)
    }

    pub(crate) fn poll_prefill(&mut self) -> bool {
        let Some(reply) = self
            .prefill_flight
            .as_ref()
            .and_then(|rx| rx.try_recv().ok())
        else {
            return false;
        };
        self.prefill_flight = None;
        self.prefill_cancel = None;
        if reply.serial != self.prefill_serial {
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.mode != Mode::Edit {
            return false;
        }
        if let Some(new_target) = form.reopen_target.take() {
            match (reply.objective, reply.notes) {
                (EditorBodyOutcome::Ready(obj), EditorBodyOutcome::Ready(notes)) => {
                    if form.prefill == PrefillState::Ready {
                        form.previous_draft = Some(format_previous_draft(
                            &form.objective.text,
                            &form.notes.text,
                        ));
                        form.previous_draft_open = true;
                    }
                    form.title = TextEdit::new(&new_target.title);
                    form.template = new_target.template;
                    form.task_mode = new_target.task_mode;
                    form.edit = Some(new_target);
                    form.objective = TextEdit::new(&obj);
                    form.notes = TextEdit::new(&notes);
                    form.prefill = PrefillState::Ready;
                    form.reopening = None;
                    form.edit_conflict = false;
                    form.error = None;
                    if let Ok(fresh) = request_id() {
                        form.request_id = fresh;
                    }
                    form.last_payload.clear();
                }
                (EditorBodyOutcome::AuthExpired, _) | (_, EditorBodyOutcome::AuthExpired) => {
                    form.reopening = None;
                    form.error = Some("missions.control.reader.unavailable");
                    self.auth_expired = Some(reply.backend);
                }
                (EditorBodyOutcome::Changed, _) | (_, EditorBodyOutcome::Changed) => {
                    form.reopening = None;
                    form.error = Some("missions.control.reader.changed");
                }
                (EditorBodyOutcome::Unavailable, _) | (_, EditorBodyOutcome::Unavailable) => {
                    form.reopening = None;
                    form.error = Some("missions.control.reader.unavailable");
                }
            }
            return true;
        }

        match (reply.objective, reply.notes) {
            (EditorBodyOutcome::AuthExpired, _) | (_, EditorBodyOutcome::AuthExpired) => {
                form.prefill = PrefillState::Failed;
                self.auth_expired = Some(reply.backend);
            }
            (EditorBodyOutcome::Changed, _) | (_, EditorBodyOutcome::Changed) => {
                form.prefill = PrefillState::Changed;
            }
            (EditorBodyOutcome::Unavailable, _) | (_, EditorBodyOutcome::Unavailable) => {
                form.prefill = PrefillState::Failed;
            }
            (EditorBodyOutcome::Ready(obj), EditorBodyOutcome::Ready(notes)) => {
                form.objective = TextEdit::new(&obj);
                form.notes = TextEdit::new(&notes);
                form.prefill = PrefillState::Ready;
            }
        }
        true
    }

    pub(crate) fn apply_event(
        &mut self,
        occurrence: &str,
        scope_key: &CreationScopeKey,
        backend: &Backend,
        project: Option<&str>,
        event: &EditorEvent,
    ) -> (bool, Option<AppliedSave>) {
        let matches_origin = |form: &Form, mode: Mode, origin: &Option<FormOrigin>| {
            form.mode == mode
                && origin
                    .as_ref()
                    .is_some_and(|o| o.occurrence == occurrence && o.generation == form.generation)
        };
        match event {
            EditorEvent::Created {
                scope,
                mission_id,
                revision,
                origin,
            } => {
                if scope != scope_key {
                    return (false, None);
                }
                let closed = self
                    .form
                    .take_if(|form| matches_origin(form, Mode::Create, origin));
                let closed_form = closed.is_some();
                (
                    true,
                    Some(AppliedSave {
                        mission_id: mission_id.clone(),
                        revision: *revision,
                        select: closed_form,
                        closed_form,
                        return_focus: closed.and_then(|form| form.return_focus),
                    }),
                )
            }
            EditorEvent::CreateRejected { origin, code } => {
                if let Some(form) = &mut self.form
                    && matches_origin(form, Mode::Create, origin)
                {
                    if let Ok(fresh) = request_id() {
                        form.request_id = fresh;
                    }
                    form.last_payload.clear();
                    form.error = Some(code.error_key());
                    return (true, None);
                }
                (false, None)
            }
            EditorEvent::CreateAuthExpired { origin } => {
                if let Some(form) = &mut self.form
                    && matches_origin(form, Mode::Create, origin)
                {
                    if let Ok(fresh) = request_id() {
                        form.request_id = fresh;
                    }
                    form.last_payload.clear();
                    return (true, None);
                }
                (false, None)
            }
            EditorEvent::CreateReceiptRejected { scope } => {
                if scope == scope_key
                    && let Some(form) = &mut self.form
                    && form.mode == Mode::Create
                {
                    if let Ok(fresh) = request_id() {
                        form.request_id = fresh;
                    }
                    form.last_payload.clear();
                    form.error = Some("missions.control.mutation.error");
                    return (true, None);
                }
                (false, None)
            }
            EditorEvent::CreateUncertain { scope } => {
                if scope == scope_key
                    && let Some(form) = &mut self.form
                    && form.mode == Mode::Create
                {
                    form.error = None;
                    return (true, None);
                }
                (false, None)
            }
            EditorEvent::Updated {
                key,
                mission_id,
                revision,
                origin,
            } => {
                if !key.matches_panel(backend, project) {
                    return (false, None);
                }
                let closed = self.form.take_if(|form| {
                    matches_origin(form, Mode::Edit, origin)
                        && form
                            .edit
                            .as_ref()
                            .is_some_and(|e| e.hold_key(backend) == *key)
                });
                let closed_form = closed.is_some();
                (
                    true,
                    Some(AppliedSave {
                        mission_id: mission_id.clone(),
                        revision: *revision,
                        select: false,
                        closed_form,
                        return_focus: closed.and_then(|form| form.return_focus),
                    }),
                )
            }
            EditorEvent::EditRevisionConflict { key, origin } => {
                if let Some(form) = &mut self.form
                    && matches_origin(form, Mode::Edit, origin)
                    && form
                        .edit
                        .as_ref()
                        .is_some_and(|e| e.hold_key(backend) == *key)
                {
                    form.edit_conflict = true;
                    form.error = Some("missions.control.mutation.conflict");
                    return (true, None);
                }
                (false, None)
            }
            EditorEvent::EditRejected { key, origin, code } => {
                if let Some(form) = &mut self.form
                    && matches_origin(form, Mode::Edit, origin)
                    && form
                        .edit
                        .as_ref()
                        .is_some_and(|e| e.hold_key(backend) == *key)
                {
                    if let Ok(fresh) = request_id() {
                        form.request_id = fresh;
                    }
                    form.last_payload.clear();
                    form.error = Some(code.error_key());
                    return (true, None);
                }
                (false, None)
            }
            EditorEvent::EditAuthExpired { key, origin } => {
                if let Some(form) = &mut self.form
                    && matches_origin(form, Mode::Edit, origin)
                    && form
                        .edit
                        .as_ref()
                        .is_some_and(|e| e.hold_key(backend) == *key)
                {
                    if let Ok(fresh) = request_id() {
                        form.request_id = fresh;
                    }
                    form.last_payload.clear();
                    return (true, None);
                }
                (false, None)
            }
            EditorEvent::EditUncertain { key } => {
                if let Some(form) = &mut self.form
                    && form.mode == Mode::Edit
                    && form
                        .edit
                        .as_ref()
                        .is_some_and(|e| e.hold_key(backend) == *key)
                {
                    form.error = None;
                    return (true, None);
                }
                (false, None)
            }
        }
    }

    fn start_prefill(&mut self, target: EditTarget, backend: &Backend, reads: &Reads, wake: &Wake) {
        self.cancel_prefill();
        let serial = self.prefill_serial;
        let (out, incoming) = bounded(1);
        let (cancel_tx, cancelled) = bounded(1);
        self.prefill_flight = Some(incoming);
        self.prefill_cancel = Some(cancel_tx);
        let backend_clone = backend.clone();
        let reads = reads.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let Some(_permit) = reads.preview(&cancelled).await else {
                return;
            };
            // Never substitute the truncated excerpt for the full objective body.
            let objective = match &target.objective_body {
                Some(desc) => {
                    let Some(outcome) = crate::platform::reads::cancellable(
                        &cancelled,
                        backend_clone.read_editor_body(
                            &target.project_id,
                            &target.mission_id,
                            &ContentSelector::mission("objective"),
                            desc,
                        ),
                    )
                    .await
                    else {
                        return;
                    };
                    outcome
                }
                None => EditorBodyOutcome::Unavailable,
            };
            // Confirm absent notes positively via `/content` so missing descriptors never overwrite existing notes.
            let notes = if matches!(objective, EditorBodyOutcome::Ready(_)) {
                match &target.notes_body {
                    Some(desc) => {
                        let Some(outcome) = crate::platform::reads::cancellable(
                            &cancelled,
                            backend_clone.read_editor_body(
                                &target.project_id,
                                &target.mission_id,
                                &ContentSelector::mission("notes"),
                                desc,
                            ),
                        )
                        .await
                        else {
                            return;
                        };
                        outcome
                    }
                    None => {
                        let Some(outcome) = crate::platform::reads::cancellable(
                            &cancelled,
                            backend_clone.confirm_absent_editor_body(
                                &target.project_id,
                                &target.mission_id,
                                &ContentSelector::mission("notes"),
                            ),
                        )
                        .await
                        else {
                            return;
                        };
                        outcome
                    }
                }
            } else {
                EditorBodyOutcome::Unavailable
            };
            let _ = out
                .send(PrefillReply {
                    serial,
                    objective,
                    notes,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
    }

    fn cancel_prefill(&mut self) {
        self.prefill_cancel = None;
        self.prefill_flight = None;
        self.prefill_serial = self.prefill_serial.saturating_add(1);
    }
}

fn format_previous_draft(objective: &str, notes: &str) -> String {
    if notes.is_empty() {
        objective.to_owned()
    } else {
        format!("{objective}\n\n{notes}")
    }
}

fn create_payload_identity(
    objective: &str,
    title: &str,
    notes: &str,
    template: Template,
    task_mode: TaskMode,
) -> String {
    format!(
        "{}\0{}\0{}\0{}\0{}",
        js_trim(objective),
        js_trim(title),
        notes,
        template.as_str(),
        task_mode.as_str()
    )
}

fn edit_payload_identity(expected_revision: u64, objective: &str, notes: &str) -> String {
    format!("{expected_revision}\0{}\0{notes}", js_trim(objective))
}

pub(super) fn title_limit_exceeded(text: &str) -> bool {
    !valid_title_input(text)
}

pub(super) fn objective_limit_exceeded(text: &str) -> bool {
    utf16_len(js_trim(text)) > MISSION_TEXT_MAX || text.contains('\0')
}

pub(super) fn notes_limit_exceeded(text: &str) -> bool {
    !valid_notes_input(text)
}
