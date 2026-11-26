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
        BodyDescriptor, ContentSelector, CreateMissionRequest, DocumentEditCheck,
        EditorBodyOutcome, LifecycleTarget, MISSION_TEXT_MAX, MISSION_TITLE_MAX, MapHeader,
        MissionCatalog, MissionCatalogOutcome, MissionDefaultsOutcome, MissionProfileDefault,
        MissionProfiles, RunState, TaskMode, Template, UpdateMissionRequest,
        catalog_profiles_valid, compare_model_error, defaults_have_profiles, derive_mission_title,
        freeze_compare_profiles, js_trim, mission_defaults_for, mission_task_mode_for, request_id,
        utf16_len, valid_notes_input, valid_objective_input, valid_title_input,
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
    DocumentLocked(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DefaultsState {
    Loading,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum EditorGesture {
    OpenCreate { return_focus: Option<String> },
    OpenEdit { return_focus: Option<String> },
    Submit,
    ReconcileCreation,
    ReconcileEdit,
    RetryDefaults,
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
    pub has_document: bool,
    pub document_lock_help: Option<&'static str>,
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
            has_document: header.root.has_document(),
            document_lock_help: None,
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
            has_document: false,
            document_lock_help: None,
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
    pub(super) custom_task_mode: bool,
    pub(super) defaults_state: DefaultsState,
    pub(super) defaults_loaded: bool,
    pub(super) defaults: Vec<MissionProfileDefault>,
    pub(super) profiles: Option<MissionProfiles>,
    pub(super) catalog: Option<MissionCatalog>,
    pub(super) start_on_creation: bool,
    pub(super) prefill: PrefillState,
    pub(super) has_loaded_draft: bool,
    pub(super) doc_rechecking: bool,
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
            custom_task_mode: hold.is_some(),
            defaults_state: if hold.is_some() {
                DefaultsState::Ready
            } else {
                DefaultsState::Loading
            },
            defaults_loaded: false,
            defaults: Vec::new(),
            profiles: None,
            catalog: None,
            start_on_creation: false,
            prefill: PrefillState::Ready,
            has_loaded_draft: false,
            doc_rechecking: false,
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
            custom_task_mode: true,
            defaults_state: DefaultsState::Ready,
            defaults_loaded: true,
            defaults: Vec::new(),
            profiles: None,
            catalog: None,
            start_on_creation: false,
            prefill: if hold.is_some() {
                PrefillState::Ready
            } else {
                PrefillState::Loading
            },
            has_loaded_draft: hold.is_some(),
            doc_rechecking: false,
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
        self.custom_task_mode = true;
        self.profiles = hold.request.profiles.clone();
        self.defaults_state = DefaultsState::Ready;
        self.start_on_creation = hold.start_on_creation;
        self.request_id = hold.request.request_id.clone();
        self.last_payload = create_payload_identity(
            &hold.request.objective,
            hold.request.title.as_deref().unwrap_or(""),
            hold.request.notes.as_deref().unwrap_or(""),
            hold.request.template,
            hold.request.profiles.as_ref(),
            hold.request.task_mode.unwrap_or_default(),
        );
        self.error = None;
    }

    fn adopt_edit_hold(&mut self, hold: &EditHoldView) {
        self.objective = TextEdit::new(&hold.request.objective);
        self.notes = TextEdit::new(hold.request.notes.as_deref().unwrap_or(""));
        self.prefill = PrefillState::Ready;
        self.has_loaded_draft = true;
        self.doc_rechecking = false;
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

    pub(super) fn select_template(&mut self, chosen: Template) {
        self.template = chosen;
        if self.mode == Mode::Create {
            self.profiles = mission_defaults_for(&self.defaults, chosen);
            if !self.custom_task_mode {
                self.task_mode = mission_task_mode_for(&self.defaults, chosen);
            }
        }
    }

    pub(super) fn select_task_mode(&mut self, chosen: TaskMode) {
        self.task_mode = chosen;
        self.custom_task_mode = true;
    }

    pub(super) fn derived_title(&self) -> String {
        derive_mission_title(&self.objective.text)
    }

    pub(super) fn is_locked(
        &self,
        creation_hold: Option<&CreationHoldView>,
        edit_hold: Option<&EditHoldView>,
    ) -> bool {
        if self.reopening.is_some() || self.doc_rechecking {
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
            Mode::Edit => {
                self.doc_rechecking || edit_hold.is_some_and(|h| h.state == HoldState::Pending)
            }
        }
    }

    pub(super) fn compare_error(&self) -> Option<&'static str> {
        if self.mode == Mode::Create
            && self.template == Template::Compare
            && self.defaults_state == DefaultsState::Ready
        {
            compare_model_error(self.profiles.as_ref())
        } else {
            None
        }
    }

    pub(super) fn profile_catalog_error(&self) -> Option<&'static str> {
        if self.mode != Mode::Create || self.defaults_state != DefaultsState::Ready {
            return None;
        }
        let frozen = freeze_compare_profiles(self.template, self.profiles.as_ref());
        let has_profiles = frozen.as_ref().is_some_and(|profiles| {
            profiles.coordinator.is_some() || profiles.roles.as_ref().is_some_and(|r| !r.is_empty())
        });
        if !has_profiles {
            return None;
        }
        let valid = self.catalog.as_ref().is_some_and(|catalog| {
            catalog_profiles_valid(frozen.as_ref(), catalog, self.task_mode)
        });
        (!valid).then_some("missions.control.profiles.error")
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
            Mode::Create => {
                self.defaults_state == DefaultsState::Ready
                    && valid_title_input(&self.title.text)
                    && self.compare_error().is_none()
                    && self.profile_catalog_error().is_none()
            }
            Mode::Edit => self.edit.is_some() && !self.edit_conflict,
        }
    }
}

struct PrefillReply {
    serial: u64,
    document: Option<DocumentEditCheck>,
    objective: EditorBodyOutcome,
    notes: EditorBodyOutcome,
    backend: Backend,
}

struct DefaultsReply {
    serial: u64,
    outcome: MissionDefaultsOutcome,
    catalog: Option<MissionCatalogOutcome>,
    backend: Backend,
}

struct DocRecheckReply {
    serial: u64,
    check: DocumentEditCheck,
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
    defaults_flight: Option<Receiver<DefaultsReply>>,
    defaults_cancel: Option<Sender<()>>,
    defaults_serial: u64,
    doc_recheck_flight: Option<Receiver<DocRecheckReply>>,
    doc_recheck_cancel: Option<Sender<()>>,
    doc_recheck_serial: u64,
    doc_recheck_submit: Option<(String, u64)>,
    ready_edit_submit: Option<(String, u64, Backend)>,
    auth_expired: Vec<Backend>,
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
        self.cancel_async();
        holds.revoke_auto_start_for_scope(scope);
        let next = self.next_generation();
        if let Some(form) = &mut self.form {
            form.generation = next;
            form.doc_rechecking = false;
        }
        let create_needs_defaults = self.form.as_ref().is_some_and(|form| {
            form.mode == Mode::Create && form.defaults_state != DefaultsState::Ready
        }) && holds.creation(scope).is_none();
        if create_needs_defaults {
            if let Some(form) = &mut self.form {
                form.defaults_state = DefaultsState::Loading;
            }
            self.start_defaults_load(backend, reads, wake);
            return;
        }
        let restart_prefill = self.form.as_ref().and_then(|form| {
            if form.mode == Mode::Edit
                && (form.reopen_target.is_some()
                    || (!form.has_loaded_draft && form.prefill != PrefillState::Ready))
            {
                form.reopen_target.clone().or_else(|| form.edit.clone())
            } else {
                None
            }
        });
        if let Some(target) = restart_prefill
            && holds.edit(&target.hold_key(backend)).is_none()
        {
            if let Some(form) = &mut self.form
                && form.reopen_target.is_none()
            {
                form.prefill = PrefillState::Loading;
            }
            self.start_prefill(target, backend, reads, wake);
            return;
        }
        let recheck_doc = self.form.as_ref().and_then(|form| {
            (form.mode == Mode::Edit
                && form.has_loaded_draft
                && form.reopen_target.is_none()
                && form.reopening.is_none())
            .then(|| form.edit.clone())
            .flatten()
            .filter(|e| e.has_document)
        });
        if let Some(target) = recheck_doc
            && holds.edit(&target.hold_key(backend)).is_none()
        {
            self.start_doc_recheck(target, None, backend, reads, wake);
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
                backend: backend.clone(),
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
        backend: &Backend,
        holds: &mut EditorHolds,
        reads: &Reads,
        wake: &Wake,
        return_focus: Option<String>,
    ) {
        if self
            .form
            .as_ref()
            .is_some_and(|form| form.mode == Mode::Create)
        {
            return;
        }
        self.cancel_async();
        holds.revoke_auto_start_for_scope(scope);
        let generation = self.next_generation();
        let hold = holds.creation(scope);
        self.form = Some(Form::new_create(generation, hold.as_ref(), return_focus));
        self.focus_initial = Some(if hold.is_some() {
            "mission-editor-close"
        } else {
            "mission-editor-objective"
        });
        if hold.is_none() {
            self.start_defaults_load(backend, reads, wake);
        }
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
        if self.editing_mission_id() == Some(header.root.id.as_str()) {
            return false;
        }
        let target = EditTarget::from_header(header);
        let hold = holds.edit(&target.hold_key(backend));
        if target.read_only && hold.is_none() {
            return false;
        }
        self.cancel_async();
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
        if self.editing_mission_id() == Some(hold.target.mission.as_str()) {
            return;
        }
        self.cancel_async();
        holds.revoke_auto_start_for_scope(scope);
        let generation = self.next_generation();
        let target = EditTarget::from_hold(hold, title, template, run_state);
        self.form = Some(Form::new_edit(generation, target, Some(hold), return_focus));
        self.focus_initial = Some("mission-editor-close");
    }

    pub(crate) fn close(&mut self) -> Option<String> {
        self.cancel_async();
        let _ = self.next_generation();
        self.focus_initial = None;
        self.form.take().and_then(|form| form.return_focus)
    }

    pub(crate) fn suspend(&mut self) {
        self.cancel_async();
        let next = self.next_generation();
        if let Some(form) = &mut self.form {
            form.generation = next;
            form.doc_rechecking = false;
        }
    }

    pub(crate) fn invalidate_generation(&mut self) {
        let next = self.next_generation();
        self.ready_edit_submit = None;
        let dropped_submit = self.doc_recheck_submit.take().is_some();
        if let Some(form) = &mut self.form {
            form.generation = next;
            if dropped_submit {
                form.doc_rechecking = false;
            }
        }
    }

    /// Resumes any prefill, document-lock check, defaults load or conflict-reopen interrupted by
    /// `suspend()` on the same connection.
    /// Returns `true` when the caller must request a fresh detail refresh and pass its serial to `set_reopen_since`.
    pub(crate) fn resume(
        &mut self,
        scope: &CreationScopeKey,
        backend: &Backend,
        holds: &EditorHolds,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        let Some(form) = self.form.as_ref() else {
            return false;
        };
        if form.mode == Mode::Create {
            if holds.creation(scope).is_none()
                && form.defaults_state == DefaultsState::Loading
                && self.defaults_flight.is_none()
            {
                self.start_defaults_load(backend, reads, wake);
            }
            return false;
        }
        if self.active_edit_hold(backend, holds).is_some() {
            return false;
        }
        if form.reopening.is_some() && form.reopen_target.is_none() {
            return true;
        }
        if self.prefill_flight.is_none() {
            let restart = if let Some(target) = form.reopen_target.clone() {
                Some(target)
            } else if !form.has_loaded_draft && form.prefill == PrefillState::Loading {
                form.edit.clone()
            } else {
                None
            };
            if let Some(target) = restart {
                self.start_prefill(target, backend, reads, wake);
                return false;
            }
        }
        if self.doc_recheck_flight.is_none()
            && form.has_loaded_draft
            && form.reopening.is_none()
            && form.reopen_target.is_none()
            && form.prefill == PrefillState::Ready
            && let Some(target) = form.edit.clone().filter(|e| e.has_document)
        {
            self.start_doc_recheck(target, None, backend, reads, wake);
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

    fn record_auth_expired(&mut self, backend: Backend) {
        if !self
            .auth_expired
            .iter()
            .any(|known| known.client.same_connection(&backend.client))
        {
            self.auth_expired.push(backend);
        }
    }

    pub(crate) fn drain_auth_expired(&mut self) -> Vec<Backend> {
        std::mem::take(&mut self.auth_expired)
    }

    pub(super) fn retry_defaults(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        let Some(form) = &mut self.form else {
            return;
        };
        if form.mode != Mode::Create {
            return;
        }
        form.defaults_state = DefaultsState::Loading;
        form.error = None;
        self.start_defaults_load(backend, reads, wake);
    }

    pub(super) fn retry_prefill(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        let Some(form) = self.form.as_ref().filter(|f| f.mode == Mode::Edit) else {
            return;
        };
        if let Some(target) = form.reopen_target.clone() {
            if let Some(form) = &mut self.form {
                form.reopening = Some(0);
                form.error = None;
            }
            self.start_prefill(target, backend, reads, wake);
            return;
        }
        let Some(target) = form.edit.clone() else {
            return;
        };
        if form.has_loaded_draft && matches!(form.prefill, PrefillState::DocumentLocked(_)) {
            if let Some(form) = &mut self.form {
                form.error = None;
            }
            self.start_doc_recheck(target, None, backend, reads, wake);
            return;
        }
        if let Some(form) = &mut self.form {
            form.prefill = PrefillState::Loading;
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
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        let Some(mode) = self.form.as_ref().map(|f| f.mode) else {
            return false;
        };
        match mode {
            Mode::Create => self.submit_create(occurrence, scope, backend, holds, wake),
            Mode::Edit => self.submit_edit(occurrence, backend, holds, reads, wake),
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
        let frozen_profiles = freeze_compare_profiles(form.template, form.profiles.as_ref());
        let payload_key = create_payload_identity(
            &form.objective.text,
            &form.title.text,
            &form.notes.text,
            form.template,
            frozen_profiles.as_ref(),
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
        let derived_title = form.derived_title();
        let title = if !js_trim(&form.title.text).is_empty() {
            Some(form.title.text.as_str())
        } else if !derived_title.is_empty() {
            Some(derived_title.as_str())
        } else {
            None
        };
        let Ok(request) = CreateMissionRequest::with_request_id_and_profiles(
            form.request_id.clone(),
            &form.objective.text,
            title,
            &form.notes.text,
            form.template,
            frozen_profiles,
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
            backend: backend.clone(),
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
        reads: &Reads,
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
        let Some(form) = self.form.as_ref() else {
            return false;
        };
        if !form.can_submit(None, None) {
            return false;
        }
        if target.has_document {
            let generation = form.generation;
            self.start_doc_recheck(
                target,
                Some((occurrence.to_owned(), generation)),
                backend,
                reads,
                wake,
            );
            return true;
        }
        self.dispatch_edit_patch(occurrence, backend, holds, wake)
    }

    fn dispatch_edit_patch(
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
            backend: backend.clone(),
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
                backend: backend.clone(),
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
                backend: backend.clone(),
            });
        holds.reconcile_edit(&key, origin, backend, wake)
    }

    pub(crate) fn poll_async(&mut self, backend: &Backend) -> bool {
        let mut changed = self.poll_defaults();
        changed |= self.poll_prefill();
        changed |= self.poll_doc_recheck(backend);
        changed
    }

    fn poll_defaults(&mut self) -> bool {
        let Some(reply) = self
            .defaults_flight
            .as_ref()
            .and_then(|rx| rx.try_recv().ok())
        else {
            return false;
        };
        self.defaults_flight = None;
        self.defaults_cancel = None;
        if matches!(reply.outcome, MissionDefaultsOutcome::AuthExpired)
            || matches!(reply.catalog, Some(MissionCatalogOutcome::AuthExpired))
        {
            self.record_auth_expired(reply.backend.clone());
        }
        if reply.serial != self.defaults_serial {
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.mode != Mode::Create {
            return false;
        }
        match (reply.outcome, reply.catalog) {
            (MissionDefaultsOutcome::Ready(defaults), None) => {
                form.defaults = defaults;
                form.profiles = mission_defaults_for(&form.defaults, form.template);
                form.catalog = None;
                if !form.custom_task_mode {
                    form.task_mode = mission_task_mode_for(&form.defaults, form.template);
                }
                form.defaults_loaded = true;
                form.defaults_state = DefaultsState::Ready;
            }
            (
                MissionDefaultsOutcome::Ready(defaults),
                Some(MissionCatalogOutcome::Ready(catalog)),
            ) => {
                form.defaults = defaults;
                form.profiles = mission_defaults_for(&form.defaults, form.template);
                form.catalog = Some(catalog);
                if !form.custom_task_mode {
                    form.task_mode = mission_task_mode_for(&form.defaults, form.template);
                }
                form.defaults_loaded = true;
                form.defaults_state = DefaultsState::Ready;
            }
            _ => {
                form.defaults_state = DefaultsState::Failed;
            }
        }
        true
    }

    pub(crate) fn ensure_defaults_if_loading(
        &mut self,
        backend: &Backend,
        reads: &Reads,
        wake: &Wake,
    ) {
        if self.form.as_ref().is_some_and(|form| {
            form.mode == Mode::Create && form.defaults_state == DefaultsState::Loading
        }) && self.defaults_flight.is_none()
        {
            self.start_defaults_load(backend, reads, wake);
        }
    }

    fn poll_doc_recheck(&mut self, backend: &Backend) -> bool {
        let Some(reply) = self
            .doc_recheck_flight
            .as_ref()
            .and_then(|rx| rx.try_recv().ok())
        else {
            return false;
        };
        self.doc_recheck_flight = None;
        self.doc_recheck_cancel = None;
        let pending_submit = self.doc_recheck_submit.take();
        if matches!(reply.check, DocumentEditCheck::AuthExpired) {
            self.record_auth_expired(reply.backend.clone());
        }
        if reply.serial != self.doc_recheck_serial {
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.mode != Mode::Edit {
            return false;
        }
        match reply.check {
            DocumentEditCheck::Editable { lock_help } => {
                if let Some(edit) = &mut form.edit {
                    edit.document_lock_help = lock_help;
                }
                form.prefill = PrefillState::Ready;
                form.error = None;
                let form_gen = form.generation;
                if let Some((occurrence, submit_gen)) = pending_submit
                    && submit_gen == form_gen
                    && reply.backend.client.same_connection(&backend.client)
                {
                    self.ready_edit_submit = Some((occurrence, submit_gen, reply.backend));
                } else {
                    form.doc_rechecking = false;
                }
            }
            DocumentEditCheck::Locked(reason) => {
                form.doc_rechecking = false;
                form.prefill = PrefillState::DocumentLocked(reason);
                form.error = None;
            }
            DocumentEditCheck::AuthExpired | DocumentEditCheck::Unavailable => {
                form.doc_rechecking = false;
                form.error = Some("missions.control.reader.unavailable");
            }
        }
        true
    }

    pub(crate) fn commit_ready_edit_submit(
        &mut self,
        holds: &mut EditorHolds,
        backend: &Backend,
        wake: &Wake,
        auth_expired: &[Backend],
    ) -> bool {
        let Some((occurrence, submit_gen, reply_backend)) = self.ready_edit_submit.take() else {
            return false;
        };
        let Some(form) = &mut self.form else {
            return false;
        };
        form.doc_rechecking = false;
        if form.mode != Mode::Edit
            || form.generation != submit_gen
            || !reply_backend.client.same_connection(&backend.client)
        {
            return true;
        }
        if auth_expired
            .iter()
            .any(|expired| expired.client.same_connection(&backend.client))
        {
            form.error = Some("missions.control.reader.unavailable");
            return true;
        }
        self.dispatch_edit_patch(&occurrence, backend, holds, wake);
        true
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
        let reply_is_auth_expired = matches!(reply.document, Some(DocumentEditCheck::AuthExpired))
            || matches!(reply.objective, EditorBodyOutcome::AuthExpired)
            || matches!(reply.notes, EditorBodyOutcome::AuthExpired);
        if reply_is_auth_expired {
            self.record_auth_expired(reply.backend.clone());
        }
        if reply.serial != self.prefill_serial {
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.mode != Mode::Edit {
            return false;
        }
        if form.reopen_target.is_some() {
            match reply.document {
                Some(DocumentEditCheck::AuthExpired) => {
                    form.reopening = None;
                    form.error = Some("missions.control.reader.unavailable");
                    return true;
                }
                Some(DocumentEditCheck::Locked(reason)) => {
                    // Retain reopen_target and user draft untouched until the lock clears.
                    form.reopening = None;
                    form.prefill = PrefillState::DocumentLocked(reason);
                    form.error = None;
                    return true;
                }
                Some(DocumentEditCheck::Unavailable) => {
                    form.reopening = None;
                    form.error = Some("missions.control.reader.unavailable");
                    return true;
                }
                Some(DocumentEditCheck::Editable { lock_help }) => {
                    if let Some(target) = &mut form.reopen_target {
                        target.document_lock_help = lock_help;
                    }
                }
                None => {}
            }
            match (reply.objective, reply.notes) {
                (EditorBodyOutcome::Ready(obj), EditorBodyOutcome::Ready(notes)) => {
                    let new_target = form.reopen_target.take().unwrap();
                    if form.has_loaded_draft {
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
                    form.has_loaded_draft = true;
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

        match reply.document {
            Some(DocumentEditCheck::AuthExpired) | Some(DocumentEditCheck::Unavailable) => {
                form.prefill = PrefillState::Failed;
                return true;
            }
            Some(DocumentEditCheck::Locked(reason)) => {
                form.prefill = PrefillState::DocumentLocked(reason);
                return true;
            }
            Some(DocumentEditCheck::Editable { lock_help }) => {
                if let Some(edit) = &mut form.edit {
                    edit.document_lock_help = lock_help;
                }
            }
            None => {}
        }

        match (reply.objective, reply.notes) {
            (EditorBodyOutcome::AuthExpired, _) | (_, EditorBodyOutcome::AuthExpired) => {
                form.prefill = PrefillState::Failed;
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
                form.has_loaded_draft = true;
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
                    .is_some_and(|o| o.matches_live(occurrence, form.generation, backend))
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
            EditorEvent::CreateReceiptRejected { scope } => {
                if scope == scope_key
                    && let Some(form) = &mut self.form
                    && form.mode == Mode::Create
                {
                    if let Ok(fresh) = request_id() {
                        form.request_id = fresh;
                    }
                    form.last_payload.clear();
                    if !form.defaults_loaded {
                        form.defaults_state = DefaultsState::Loading;
                    }
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
            let document = if target.has_document {
                let Some(check) = crate::platform::reads::cancellable(
                    &cancelled,
                    backend_clone.read_mission_edit_document(&target.mission_id),
                )
                .await
                else {
                    return;
                };
                Some(check)
            } else {
                None
            };
            let doc_editable = matches!(document, None | Some(DocumentEditCheck::Editable { .. }));
            // Never substitute the truncated excerpt for the full objective body.
            let objective = if doc_editable {
                match &target.objective_body {
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
                }
            } else {
                EditorBodyOutcome::Unavailable
            };
            // Confirm absent notes positively via `/content` so missing descriptors never overwrite existing notes.
            let notes = if doc_editable && matches!(objective, EditorBodyOutcome::Ready(_)) {
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
                    document,
                    objective,
                    notes,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
    }

    fn start_defaults_load(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        self.cancel_defaults();
        let serial = self.defaults_serial;
        let (out, incoming) = bounded(1);
        let (cancel_tx, cancelled) = bounded(1);
        self.defaults_flight = Some(incoming);
        self.defaults_cancel = Some(cancel_tx);
        let backend_clone = backend.clone();
        let reads = reads.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let Some(_permit) = reads.preview(&cancelled).await else {
                return;
            };
            let Some(outcome) = crate::platform::reads::cancellable(
                &cancelled,
                backend_clone.read_mission_defaults(),
            )
            .await
            else {
                return;
            };
            let catalog = match &outcome {
                MissionDefaultsOutcome::Ready(defaults) if defaults_have_profiles(defaults) => {
                    let Some(cat) = crate::platform::reads::cancellable(
                        &cancelled,
                        backend_clone.read_mission_catalog(),
                    )
                    .await
                    else {
                        return;
                    };
                    Some(cat)
                }
                _ => None,
            };
            let _ = out
                .send(DefaultsReply {
                    serial,
                    outcome,
                    catalog,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
    }

    fn start_doc_recheck(
        &mut self,
        target: EditTarget,
        pending_submit: Option<(String, u64)>,
        backend: &Backend,
        reads: &Reads,
        wake: &Wake,
    ) {
        self.cancel_doc_recheck();
        let serial = self.doc_recheck_serial;
        let (out, incoming) = bounded(1);
        let (cancel_tx, cancelled) = bounded(1);
        self.doc_recheck_flight = Some(incoming);
        self.doc_recheck_cancel = Some(cancel_tx);
        self.doc_recheck_submit = pending_submit;
        if let Some(form) = &mut self.form {
            form.doc_rechecking = true;
            form.error = None;
        }
        let backend_clone = backend.clone();
        let reads = reads.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let Some(_permit) = reads.preview(&cancelled).await else {
                return;
            };
            let Some(check) = crate::platform::reads::cancellable(
                &cancelled,
                backend_clone.read_mission_edit_document(&target.mission_id),
            )
            .await
            else {
                return;
            };
            let _ = out
                .send(DocRecheckReply {
                    serial,
                    check,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
    }

    fn cancel_async(&mut self) {
        self.cancel_prefill();
        self.cancel_defaults();
        self.cancel_doc_recheck();
    }

    fn cancel_defaults(&mut self) {
        self.defaults_cancel = None;
        if let Some(rx) = self.defaults_flight.take()
            && let Ok(reply) = rx.try_recv()
            && (matches!(reply.outcome, MissionDefaultsOutcome::AuthExpired)
                || matches!(reply.catalog, Some(MissionCatalogOutcome::AuthExpired)))
        {
            self.record_auth_expired(reply.backend);
        }
        self.defaults_serial = self.defaults_serial.saturating_add(1);
    }

    fn cancel_doc_recheck(&mut self) {
        self.doc_recheck_cancel = None;
        self.doc_recheck_submit = None;
        self.ready_edit_submit = None;
        if let Some(rx) = self.doc_recheck_flight.take()
            && let Ok(reply) = rx.try_recv()
            && matches!(reply.check, DocumentEditCheck::AuthExpired)
        {
            self.record_auth_expired(reply.backend);
        }
        self.doc_recheck_serial = self.doc_recheck_serial.saturating_add(1);
    }

    fn cancel_prefill(&mut self) {
        self.prefill_cancel = None;
        if let Some(rx) = self.prefill_flight.take()
            && let Ok(reply) = rx.try_recv()
            && (matches!(reply.document, Some(DocumentEditCheck::AuthExpired))
                || matches!(reply.objective, EditorBodyOutcome::AuthExpired)
                || matches!(reply.notes, EditorBodyOutcome::AuthExpired))
        {
            self.record_auth_expired(reply.backend);
        }
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
    profiles: Option<&MissionProfiles>,
    task_mode: TaskMode,
) -> String {
    let profiles_json = profiles
        .and_then(|p| serde_json::to_string(p).ok())
        .unwrap_or_default();
    format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        js_trim(objective),
        js_trim(title),
        notes,
        template.as_str(),
        profiles_json,
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
