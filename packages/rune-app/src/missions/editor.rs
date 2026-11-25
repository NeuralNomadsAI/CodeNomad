#[cfg(test)]
mod tests;

use super::detail::Snapshot;
use crate::{
    components::window_close_button::WindowCloseState,
    platform::{self, reads::Reads},
};
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    missions::{
        BodyDescriptor, ContentSelector, CreateMissionOutcome, CreateMissionRequest,
        CreatedMission, CreationReceiptOutcome, EditReceiptOutcome, EditorBodyOutcome,
        LifecycleTarget, MISSION_TEXT_MAX, MISSION_TITLE_MAX, MapHeader, RunState,
        StartCreatedOutcome, TaskMode, Template, UpdateMissionOutcome, UpdateMissionRequest,
        derive_mission_title, js_trim, request_id, utf16_len, valid_notes_input,
        valid_objective_input, valid_title_input,
    },
};
use rune::edit::TextEdit;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum PrefillState {
    Loading,
    Ready,
    Changed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum HoldState {
    Pending,
    Uncertain,
}

#[derive(Clone, Debug)]
pub(super) struct CreationHold {
    pub(super) state: HoldState,
    pub(super) request: CreateMissionRequest,
    pub(super) start_on_creation: bool,
    pub(super) auto_start_alive: bool,
    pub(super) origin_generation: u64,
    pub(super) base: String,
    pub(super) workspace: String,
    pub(super) checking: bool,
}

impl CreationHold {
    fn same_scope(&self, backend: &Backend) -> bool {
        self.base == backend.base && self.workspace == backend.workspace
    }
}

#[derive(Clone, Debug)]
pub(super) struct EditHold {
    pub(super) state: HoldState,
    pub(super) target: LifecycleTarget,
    pub(super) request: UpdateMissionRequest,
    pub(super) origin_generation: u64,
    pub(super) base: String,
    pub(super) workspace: String,
    pub(super) checking: bool,
}

impl EditHold {
    fn matches(&self, backend: &Backend, mission_id: &str) -> bool {
        self.base == backend.base
            && self.workspace == backend.workspace
            && self.target.mission == mission_id
    }
}

#[derive(Clone, Debug)]
pub(super) struct EditTarget {
    pub(super) mission_id: String,
    pub(super) project_id: String,
    pub(super) expected_revision: u64,
    pub(super) target: LifecycleTarget,
    pub(super) title: Option<String>,
    pub(super) excerpt: String,
    pub(super) template: Template,
    pub(super) task_mode: TaskMode,
    pub(super) run_state: Option<RunState>,
    pub(super) objective_body: Option<BodyDescriptor>,
    pub(super) notes_body: Option<BodyDescriptor>,
}

impl EditTarget {
    fn from_header(header: &MapHeader) -> Self {
        Self {
            mission_id: header.root.id.clone(),
            project_id: header.root.project_id().to_owned(),
            expected_revision: header.root.revision,
            target: header.lifecycle_target(),
            title: header.root.title.clone(),
            excerpt: header.root.excerpt.clone(),
            template: header.root.template,
            task_mode: header.root.task_mode(),
            run_state: header.root.run_state,
            objective_body: header.root.body("objective").cloned(),
            notes_body: header.root.body("notes").cloned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Mode {
    Create,
    Edit,
}

pub(super) struct Form {
    pub(super) generation: u64,
    pub(super) mode: Mode,
    pub(super) objective: TextEdit,
    pub(super) title: TextEdit,
    pub(super) notes: TextEdit,
    pub(super) template: Template,
    pub(super) task_mode: TaskMode,
    pub(super) start_on_creation: bool,
    pub(super) request_id: String,
    pub(super) last_payload: String,
    pub(super) error: Option<&'static str>,
    pub(super) edit: Option<EditTarget>,
    pub(super) prefill: PrefillState,
    pub(super) edit_conflict: bool,
    pub(super) reopening: Option<u64>,
    pub(super) starting_created: bool,
    pub(super) return_focus: Option<String>,
    pub(super) close: WindowCloseState,
}

impl Form {
    fn new_create(
        generation: u64,
        hold: Option<&CreationHold>,
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
            request_id: request_id().unwrap_or_default(),
            last_payload: String::new(),
            error: None,
            edit: None,
            prefill: PrefillState::Ready,
            edit_conflict: false,
            reopening: None,
            starting_created: false,
            return_focus,
            close: WindowCloseState::default(),
        };
        if let Some(hold) = hold {
            form.adopt_creation_hold(hold);
        }
        form
    }

    fn new_edit(
        generation: u64,
        target: EditTarget,
        hold: Option<&EditHold>,
        return_focus: Option<String>,
    ) -> Self {
        let title_text = target.title.as_deref().unwrap_or("");
        let mut form = Self {
            generation,
            mode: Mode::Edit,
            objective: TextEdit::new(""),
            title: TextEdit::new(title_text),
            notes: TextEdit::new(""),
            template: target.template,
            task_mode: target.task_mode,
            start_on_creation: false,
            request_id: request_id().unwrap_or_default(),
            last_payload: String::new(),
            error: None,
            edit: Some(target),
            prefill: if hold.is_some() {
                PrefillState::Ready
            } else {
                PrefillState::Loading
            },
            edit_conflict: false,
            reopening: None,
            starting_created: false,
            return_focus,
            close: WindowCloseState::default(),
        };
        if let Some(hold) = hold {
            form.adopt_edit_hold(hold);
        }
        form
    }

    fn adopt_creation_hold(&mut self, hold: &CreationHold) {
        self.objective = TextEdit::new(&hold.request.objective);
        self.title = TextEdit::new(hold.request.title.as_deref().unwrap_or(""));
        self.notes = TextEdit::new(hold.request.notes.as_deref().unwrap_or(""));
        self.template = hold.request.template;
        self.task_mode = hold.request.task_mode.unwrap_or_default();
        self.start_on_creation = hold.start_on_creation;
        self.request_id = hold.request.request_id.clone();
        self.last_payload = create_payload_identity(
            &self.objective.text,
            &self.title.text,
            &self.notes.text,
            self.template,
            self.task_mode,
        );
        self.error = None;
    }

    fn adopt_edit_hold(&mut self, hold: &EditHold) {
        self.objective = TextEdit::new(&hold.request.objective);
        self.notes = TextEdit::new(hold.request.notes.as_deref().unwrap_or(""));
        self.request_id = hold.request.request_id.clone();
        self.last_payload = edit_payload_identity(
            hold.request.expected_revision,
            &hold.request.objective,
            hold.request.notes.as_deref().unwrap_or(""),
        );
        self.prefill = PrefillState::Ready;
        self.edit_conflict = false;
        self.error = None;
    }

    pub(super) fn derived_title(&self) -> String {
        derive_mission_title(&self.objective.text)
    }

    pub(super) fn objective_valid(&self) -> bool {
        valid_objective_input(&self.objective.text)
    }

    pub(super) fn title_valid(&self) -> bool {
        valid_title_input(&self.title.text)
    }

    pub(super) fn notes_valid(&self) -> bool {
        valid_notes_input(&self.notes.text)
    }

    pub(super) fn compare_error(&self) -> Option<&'static str> {
        (self.mode == Mode::Create && self.template == Template::Compare)
            .then_some("missions.compare.compare-models-required")
    }

    pub(super) fn is_composing(&self) -> bool {
        self.objective.is_composing() || self.title.is_composing() || self.notes.is_composing()
    }

    pub(super) fn can_submit(
        &self,
        creation_hold: Option<&CreationHold>,
        edit_hold: Option<&EditHold>,
    ) -> bool {
        if self.starting_created || self.reopening.is_some() {
            return false;
        }
        match self.mode {
            Mode::Create => {
                creation_hold.is_none()
                    && self.objective_valid()
                    && self.title_valid()
                    && self.notes_valid()
                    && self.compare_error().is_none()
            }
            Mode::Edit => {
                edit_hold.is_none()
                    && self.prefill == PrefillState::Ready
                    && !self.edit_conflict
                    && self.objective_valid()
                    && self.notes_valid()
            }
        }
    }

    pub(super) fn fields_locked(
        &self,
        creation_hold: Option<&CreationHold>,
        edit_hold: Option<&EditHold>,
    ) -> bool {
        if self.starting_created || self.reopening.is_some() {
            return true;
        }
        match self.mode {
            Mode::Create => creation_hold.is_some(),
            Mode::Edit => {
                edit_hold.is_some() || self.prefill != PrefillState::Ready || self.edit_conflict
            }
        }
    }
}

struct PrefillReply {
    serial: u64,
    objective: EditorBodyOutcome,
    notes: EditorBodyOutcome,
    backend: Backend,
}

struct CreateReply {
    request_id: String,
    outcome: CreateMissionOutcome,
    backend: Backend,
}

struct ReceiptReply {
    request_id: String,
    outcome: CreationReceiptOutcome,
    backend: Backend,
}

struct StartCreatedReply {
    mission_id: String,
    revision: u64,
    origin_generation: u64,
    outcome: StartCreatedOutcome,
    backend: Backend,
}

struct UpdateReply {
    request_id: String,
    mission_id: String,
    outcome: UpdateMissionOutcome,
    backend: Backend,
}

struct EditReceiptReply {
    request_id: String,
    mission_id: String,
    outcome: EditReceiptOutcome,
    backend: Backend,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SavedMission {
    pub(crate) mission_id: String,
    pub(crate) revision: u64,
    pub(crate) select: bool,
    pub(crate) return_focus: Option<String>,
    pub(crate) closed_form: bool,
}

#[derive(Default)]
pub(crate) struct Editor {
    form_generation: u64,
    pub(super) form: Option<Form>,
    pub(super) creation_hold: Option<CreationHold>,
    pub(super) edit_hold: Option<EditHold>,
    prefill_serial: u64,
    prefill_flight: Option<Receiver<PrefillReply>>,
    create_flight: Option<Receiver<CreateReply>>,
    receipt_flight: Option<Receiver<ReceiptReply>>,
    start_flight: Option<Receiver<StartCreatedReply>>,
    update_flight: Option<Receiver<UpdateReply>>,
    edit_receipt_flight: Option<Receiver<EditReceiptReply>>,
    auth_expired: Option<Backend>,
    saved: Option<SavedMission>,
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
        self.form.as_ref().is_some_and(Form::is_composing)
    }

    pub(crate) fn editing_mission_id(&self) -> Option<&str> {
        self.form
            .as_ref()
            .filter(|f| f.mode == Mode::Edit)
            .and_then(|f| f.edit.as_ref())
            .map(|e| e.mission_id.as_str())
    }

    pub(crate) fn has_auth_expired(&self) -> bool {
        self.auth_expired.is_some()
    }

    pub(crate) fn take_auth_expired(&mut self) -> Option<Backend> {
        self.auth_expired.take()
    }

    pub(crate) fn take_saved(&mut self) -> Option<SavedMission> {
        self.saved.take()
    }

    pub(crate) fn take_initial_focus(&mut self) -> Option<&'static str> {
        self.focus_initial.take()
    }

    pub(super) fn active_hold(&self, backend: &Backend) -> Option<&CreationHold> {
        self.creation_hold
            .as_ref()
            .filter(|hold| hold.same_scope(backend))
    }

    pub(super) fn active_edit_hold(
        &self,
        backend: &Backend,
        mission_id: &str,
    ) -> Option<&EditHold> {
        self.edit_hold
            .as_ref()
            .filter(|hold| hold.matches(backend, mission_id))
    }

    pub(crate) fn open_create(&mut self, backend: &Backend, return_focus: Option<String>) {
        self.cancel_prefill();
        self.revoke_auto_start();
        let generation = self.next_generation();
        let hold = self
            .creation_hold
            .as_ref()
            .filter(|hold| hold.same_scope(backend))
            .cloned();
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
        backend: &Backend,
        reads: &Reads,
        wake: &Wake,
        return_focus: Option<String>,
    ) -> bool {
        if !header.root.editable() {
            return false;
        }
        self.cancel_prefill();
        self.revoke_auto_start();
        let generation = self.next_generation();
        let target = EditTarget::from_header(header);
        let hold = self
            .edit_hold
            .as_ref()
            .filter(|hold| hold.matches(backend, &target.mission_id))
            .cloned();
        self.form = Some(Form::new_edit(
            generation,
            target.clone(),
            hold.as_ref(),
            return_focus,
        ));
        self.focus_initial = Some(if hold.is_some() {
            "mission-editor-close"
        } else {
            "mission-editor-objective"
        });
        if hold.is_none() {
            self.start_prefill(target, backend, reads, wake);
        }
        true
    }

    pub(crate) fn close(&mut self) -> Option<String> {
        self.cancel_prefill();
        self.revoke_auto_start();
        self.next_generation();
        self.focus_initial = None;
        self.form.take().and_then(|form| form.return_focus)
    }

    pub(crate) fn suspend(&mut self) {
        self.cancel_prefill();
        self.revoke_auto_start();
        self.next_generation();
        if let Some(form) = &mut self.form
            && form.mode == Mode::Edit
            && form.prefill == PrefillState::Loading
        {
            form.prefill = PrefillState::Failed;
        }
    }

    pub(crate) fn rebind(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        self.cancel_prefill();
        self.revoke_auto_start();
        self.next_generation();
        if self
            .creation_hold
            .as_ref()
            .is_some_and(|hold| !hold.same_scope(backend))
        {
            self.creation_hold = None;
            self.create_flight = None;
            self.receipt_flight = None;
            self.start_flight = None;
        }
        if self
            .edit_hold
            .as_ref()
            .is_some_and(|hold| hold.base != backend.base || hold.workspace != backend.workspace)
        {
            self.edit_hold = None;
            self.update_flight = None;
            self.edit_receipt_flight = None;
        }
        let retry_target = self.form.as_ref().and_then(|form| {
            (form.mode == Mode::Edit
                && matches!(form.prefill, PrefillState::Loading | PrefillState::Failed))
            .then(|| form.edit.clone())
            .flatten()
            .filter(|t| self.active_edit_hold(backend, &t.mission_id).is_none())
        });
        if let Some(target) = retry_target {
            if let Some(form) = &mut self.form {
                form.prefill = PrefillState::Loading;
            }
            self.start_prefill(target, backend, reads, wake);
        }
    }

    pub(super) fn retry_prefill(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        let Some(target) = self
            .form
            .as_ref()
            .filter(|form| form.mode == Mode::Edit && form.prefill == PrefillState::Failed)
            .and_then(|form| form.edit.clone())
            .filter(|t| self.active_edit_hold(backend, &t.mission_id).is_none())
        else {
            return;
        };
        if let Some(form) = &mut self.form {
            form.prefill = PrefillState::Loading;
            form.error = None;
        }
        self.start_prefill(target, backend, reads, wake);
    }

    pub(super) fn begin_reopen(&mut self, backend: &Backend, map_reads: u64) -> bool {
        let Some(mission_id) = self.editing_mission_id().map(str::to_owned) else {
            return false;
        };
        if self.active_edit_hold(backend, &mission_id).is_some() {
            return false;
        }
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.reopening.is_some() {
            return false;
        }
        form.reopening = Some(map_reads);
        form.error = None;
        true
    }

    pub(super) fn observe_detail(
        &mut self,
        snapshot: Option<&Snapshot>,
        map_reads: u64,
        detail_failed: bool,
        backend: &Backend,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        let Some((since_reads, edit_id, return_focus)) = self.form.as_ref().and_then(|form| {
            (form.mode == Mode::Edit)
                .then(|| {
                    Some((
                        form.reopening?,
                        form.edit.as_ref()?.mission_id.clone(),
                        form.return_focus.clone(),
                    ))
                })
                .flatten()
        }) else {
            return false;
        };
        if self.active_edit_hold(backend, &edit_id).is_some() {
            if let Some(form) = &mut self.form {
                form.reopening = None;
            }
            return true;
        }
        if detail_failed {
            if let Some(form) = &mut self.form {
                form.reopening = None;
                form.error = Some("missions.control.reader.unavailable");
            }
            return true;
        }
        if map_reads > since_reads
            && let Some(snap) = snapshot
            && snap.header.root.id == edit_id
        {
            if !snap.header.root.editable() {
                if let Some(form) = &mut self.form {
                    form.reopening = None;
                    form.error = Some("missions.control.mutation.conflict");
                    form.edit_conflict = true;
                }
                return true;
            }
            let target = EditTarget::from_header(&snap.header);
            self.cancel_prefill();
            let generation = self.next_generation();
            self.form = Some(Form::new_edit(
                generation,
                target.clone(),
                None,
                return_focus,
            ));
            self.start_prefill(target, backend, reads, wake);
            return true;
        }
        false
    }

    pub(super) fn submit(&mut self, backend: &Backend, wake: &Wake) -> bool {
        let Some(mode) = self.form.as_ref().map(|f| f.mode.clone()) else {
            return false;
        };
        match mode {
            Mode::Create => self.submit_create(backend, wake),
            Mode::Edit => self.submit_edit(backend, wake),
        }
    }

    fn submit_create(&mut self, backend: &Backend, wake: &Wake) -> bool {
        if let Some(existing) = self.active_hold(backend).cloned() {
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
        let title_input = js_trim(&form.title.text);
        let derived = form.derived_title();
        let chosen_title = if !title_input.is_empty() {
            Some(title_input)
        } else if !derived.is_empty() {
            Some(derived.as_str())
        } else {
            None
        };
        let Ok(request) = CreateMissionRequest::with_request_id(
            form.request_id.clone(),
            &form.objective.text,
            chosen_title,
            &form.notes.text,
            form.template,
            form.task_mode,
        ) else {
            form.error = Some("missions.control.mutation.error");
            return true;
        };
        form.error = None;
        let origin_generation = form.generation;
        let start_on_creation = form.start_on_creation;
        self.creation_hold = Some(CreationHold {
            state: HoldState::Pending,
            request: request.clone(),
            start_on_creation,
            auto_start_alive: start_on_creation,
            origin_generation,
            base: backend.base.clone(),
            workspace: backend.workspace.clone(),
            checking: false,
        });
        let (out, incoming) = bounded(1);
        self.create_flight = Some(incoming);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        let req_id = request.request_id.clone();
        platform::spawn(async move {
            let outcome = backend_clone.create_mission(&request).await;
            let _ = out
                .send(CreateReply {
                    request_id: req_id,
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
        true
    }

    fn submit_edit(&mut self, backend: &Backend, wake: &Wake) -> bool {
        let Some(target) = self.form.as_ref().and_then(|f| f.edit.clone()) else {
            return false;
        };
        if let Some(existing) = self.active_edit_hold(backend, &target.mission_id).cloned() {
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
        let origin_generation = form.generation;
        self.edit_hold = Some(EditHold {
            state: HoldState::Pending,
            target: target.target.clone(),
            request: request.clone(),
            origin_generation,
            base: backend.base.clone(),
            workspace: backend.workspace.clone(),
            checking: false,
        });
        let (out, incoming) = bounded(1);
        self.update_flight = Some(incoming);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        let req_id = request.request_id.clone();
        let mission_id = target.mission_id;
        let lifecycle_target = target.target;
        platform::spawn(async move {
            let outcome = backend_clone
                .update_mission(&lifecycle_target, &request)
                .await;
            let _ = out
                .send(UpdateReply {
                    request_id: req_id,
                    mission_id,
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
        true
    }

    pub(super) fn reconcile_creation(&mut self, backend: &Backend, wake: &Wake) -> bool {
        let Some(hold) = &mut self.creation_hold else {
            return false;
        };
        if !hold.same_scope(backend) || hold.state != HoldState::Uncertain || hold.checking {
            return false;
        }
        hold.checking = true;
        let req_id = hold.request.request_id.clone();
        let (out, incoming) = bounded(1);
        self.receipt_flight = Some(incoming);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let outcome = backend_clone.creation_receipt(&req_id).await;
            let _ = out
                .send(ReceiptReply {
                    request_id: req_id,
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
        true
    }

    pub(super) fn reconcile_edit(&mut self, backend: &Backend, wake: &Wake) -> bool {
        let Some(mission_id) = self.editing_mission_id().map(str::to_owned) else {
            return false;
        };
        let Some(hold) = &mut self.edit_hold else {
            return false;
        };
        if !hold.matches(backend, &mission_id)
            || hold.state != HoldState::Uncertain
            || hold.checking
        {
            return false;
        }
        hold.checking = true;
        let req_id = hold.request.request_id.clone();
        let target = hold.target.clone();
        let request = hold.request.clone();
        let (out, incoming) = bounded(1);
        self.edit_receipt_flight = Some(incoming);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let outcome = backend_clone
                .reconcile_mission_edit(&target, &request)
                .await;
            let _ = out
                .send(EditReceiptReply {
                    request_id: req_id,
                    mission_id,
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
        true
    }

    pub(crate) fn poll(&mut self, backend: &Backend, wake: &Wake, auth_blocked: bool) -> bool {
        let mut changed = false;

        if let Some(rx) = &self.prefill_flight
            && let Ok(reply) = rx.try_recv()
        {
            self.prefill_flight = None;
            if reply.serial == self.prefill_serial
                && let Some(form) = &mut self.form
                && form.mode == Mode::Edit
            {
                changed = true;
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
            }
        }

        if let Some(rx) = &self.create_flight
            && let Ok(reply) = rx.try_recv()
        {
            self.create_flight = None;
            let matching = self.creation_hold.as_ref().is_some_and(|hold| {
                hold.request.request_id == reply.request_id && hold.same_scope(&reply.backend)
            });
            if matching {
                changed = true;
                let (origin_gen, auto_start_alive) = self
                    .creation_hold
                    .as_ref()
                    .map(|h| (h.origin_generation, h.auto_start_alive))
                    .unwrap_or((0, false));
                match reply.outcome {
                    CreateMissionOutcome::Created(created) => {
                        self.creation_hold = None;
                        let same_live_connection = backend.base == reply.backend.base
                            && backend.workspace == reply.backend.workspace
                            && backend.client.same_connection(&reply.backend.client);
                        let same_open_form = self
                            .form
                            .as_ref()
                            .is_some_and(|f| f.mode == Mode::Create && f.generation == origin_gen);
                        if auto_start_alive
                            && same_open_form
                            && created.can_auto_start()
                            && same_live_connection
                            && !auth_blocked
                            && self.auth_expired.is_none()
                        {
                            self.start_created(created, origin_gen, backend, wake);
                        } else {
                            self.finish_created(created.id, created.revision, origin_gen);
                        }
                    }
                    CreateMissionOutcome::Rejected(code) => {
                        self.creation_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Create
                            && form.generation == origin_gen
                        {
                            if let Ok(fresh) = request_id() {
                                form.request_id = fresh;
                            }
                            form.last_payload.clear();
                            form.error = Some(code.error_key());
                        }
                    }
                    CreateMissionOutcome::AuthExpired => {
                        self.creation_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Create
                            && form.generation == origin_gen
                        {
                            if let Ok(fresh) = request_id() {
                                form.request_id = fresh;
                            }
                            form.last_payload.clear();
                        }
                        self.auth_expired = Some(reply.backend);
                    }
                    CreateMissionOutcome::Uncertain => {
                        if let Some(hold) = &mut self.creation_hold {
                            hold.state = HoldState::Uncertain;
                            hold.auto_start_alive = false;
                            hold.checking = false;
                        }
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Create
                        {
                            form.error = None;
                        }
                    }
                }
            }
        }

        if let Some(rx) = &self.receipt_flight
            && let Ok(reply) = rx.try_recv()
        {
            self.receipt_flight = None;
            let matching = self.creation_hold.as_ref().is_some_and(|hold| {
                hold.request.request_id == reply.request_id && hold.same_scope(&reply.backend)
            });
            if matching {
                changed = true;
                match reply.outcome {
                    CreationReceiptOutcome::Created {
                        mission_id,
                        revision,
                    } => {
                        self.creation_hold = None;
                        let current_create_gen = self
                            .form
                            .as_ref()
                            .filter(|f| f.mode == Mode::Create)
                            .map(|f| f.generation)
                            .unwrap_or(0);
                        self.finish_created(mission_id, revision, current_create_gen);
                    }
                    CreationReceiptOutcome::Rejected => {
                        self.creation_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Create
                        {
                            if let Ok(fresh) = request_id() {
                                form.request_id = fresh;
                            }
                            form.last_payload.clear();
                            form.error = Some("missions.control.mutation.error");
                        }
                    }
                    CreationReceiptOutcome::AuthExpired => {
                        if let Some(hold) = &mut self.creation_hold {
                            hold.checking = false;
                        }
                        self.auth_expired = Some(reply.backend);
                    }
                    CreationReceiptOutcome::Unknown => {
                        if let Some(hold) = &mut self.creation_hold {
                            hold.checking = false;
                        }
                    }
                }
            }
        }

        if let Some(rx) = &self.start_flight
            && let Ok(reply) = rx.try_recv()
        {
            self.start_flight = None;
            changed = true;
            let final_revision = match reply.outcome {
                StartCreatedOutcome::Started(revision) => revision,
                StartCreatedOutcome::AuthExpired => {
                    self.auth_expired = Some(reply.backend);
                    reply.revision
                }
                StartCreatedOutcome::Unconfirmed => reply.revision,
            };
            self.finish_created(reply.mission_id, final_revision, reply.origin_generation);
        }

        if let Some(rx) = &self.update_flight
            && let Ok(reply) = rx.try_recv()
        {
            self.update_flight = None;
            let matching = self.edit_hold.as_ref().is_some_and(|hold| {
                hold.request.request_id == reply.request_id
                    && hold.matches(&reply.backend, &reply.mission_id)
            });
            if matching {
                changed = true;
                let origin_gen = self
                    .edit_hold
                    .as_ref()
                    .map(|h| h.origin_generation)
                    .unwrap_or(0);
                match reply.outcome {
                    UpdateMissionOutcome::Updated {
                        mission_id,
                        revision,
                    } => {
                        self.edit_hold = None;
                        self.finish_edited(mission_id, revision, origin_gen);
                    }
                    UpdateMissionOutcome::RevisionConflict => {
                        self.edit_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Edit
                            && form.generation == origin_gen
                        {
                            form.edit_conflict = true;
                            form.error = Some("missions.control.mutation.conflict");
                        }
                    }
                    UpdateMissionOutcome::Rejected(code) => {
                        self.edit_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Edit
                            && form.generation == origin_gen
                        {
                            if let Ok(fresh) = request_id() {
                                form.request_id = fresh;
                            }
                            form.last_payload.clear();
                            form.error = Some(code.error_key());
                        }
                    }
                    UpdateMissionOutcome::AuthExpired => {
                        self.edit_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Edit
                            && form.generation == origin_gen
                        {
                            if let Ok(fresh) = request_id() {
                                form.request_id = fresh;
                            }
                            form.last_payload.clear();
                        }
                        self.auth_expired = Some(reply.backend);
                    }
                    UpdateMissionOutcome::Uncertain => {
                        if let Some(hold) = &mut self.edit_hold {
                            hold.state = HoldState::Uncertain;
                            hold.checking = false;
                        }
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Edit
                        {
                            form.error = None;
                        }
                    }
                }
            }
        }

        if let Some(rx) = &self.edit_receipt_flight
            && let Ok(reply) = rx.try_recv()
        {
            self.edit_receipt_flight = None;
            let matching = self.edit_hold.as_ref().is_some_and(|hold| {
                hold.request.request_id == reply.request_id
                    && hold.matches(&reply.backend, &reply.mission_id)
            });
            if matching {
                changed = true;
                match reply.outcome {
                    EditReceiptOutcome::Applied {
                        mission_id,
                        revision,
                    } => {
                        self.edit_hold = None;
                        let current_edit_gen = self
                            .form
                            .as_ref()
                            .filter(|f| {
                                f.mode == Mode::Edit
                                    && f.edit.as_ref().is_some_and(|e| e.mission_id == mission_id)
                            })
                            .map(|f| f.generation)
                            .unwrap_or(0);
                        self.finish_edited(mission_id, revision, current_edit_gen);
                    }
                    EditReceiptOutcome::AuthExpired => {
                        if let Some(hold) = &mut self.edit_hold {
                            hold.checking = false;
                        }
                        self.auth_expired = Some(reply.backend);
                    }
                    EditReceiptOutcome::Unconfirmed => {
                        if let Some(hold) = &mut self.edit_hold {
                            hold.checking = false;
                        }
                    }
                }
            }
        }

        changed
    }

    fn start_created(
        &mut self,
        created: CreatedMission,
        origin_generation: u64,
        backend: &Backend,
        wake: &Wake,
    ) {
        if let Some(form) = &mut self.form
            && form.mode == Mode::Create
            && form.generation == origin_generation
        {
            form.starting_created = true;
        }
        let (out, incoming) = bounded(1);
        self.start_flight = Some(incoming);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let outcome = backend_clone.start_created_mission(&created).await;
            let _ = out
                .send(StartCreatedReply {
                    mission_id: created.id,
                    revision: created.revision,
                    origin_generation,
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
    }

    fn finish_created(&mut self, mission_id: String, revision: u64, origin_generation: u64) {
        let closed = self.form.take_if(|form| {
            form.mode == Mode::Create
                && form.generation == origin_generation
                && origin_generation > 0
        });
        self.saved = Some(SavedMission {
            mission_id,
            revision,
            select: true,
            closed_form: closed.is_some(),
            return_focus: closed.and_then(|form| form.return_focus),
        });
    }

    fn finish_edited(&mut self, mission_id: String, revision: u64, origin_generation: u64) {
        let closed = self.form.take_if(|form| {
            form.mode == Mode::Edit && form.generation == origin_generation && origin_generation > 0
        });
        self.saved = Some(SavedMission {
            mission_id,
            revision,
            select: false,
            closed_form: closed.is_some(),
            return_focus: closed.and_then(|form| form.return_focus),
        });
    }

    fn start_prefill(&mut self, target: EditTarget, backend: &Backend, reads: &Reads, wake: &Wake) {
        self.prefill_serial = self.prefill_serial.saturating_add(1);
        let serial = self.prefill_serial;
        let (out, incoming) = bounded(1);
        self.prefill_flight = Some(incoming);
        let backend_clone = backend.clone();
        let reads = reads.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let (_cancel, cancelled) = bounded(1);
            let Some(_permit) = reads.preview(&cancelled).await else {
                return;
            };
            // Never substitute the truncated excerpt for the full objective body.
            let objective = match &target.objective_body {
                Some(desc) => {
                    backend_clone
                        .read_editor_body(
                            &target.project_id,
                            &target.mission_id,
                            &ContentSelector::mission("objective"),
                            desc,
                        )
                        .await
                }
                None => EditorBodyOutcome::Unavailable,
            };
            // Confirm absent notes positively via `/content` so missing descriptors never overwrite existing notes.
            let notes = if matches!(objective, EditorBodyOutcome::Ready(_)) {
                match &target.notes_body {
                    Some(desc) => {
                        backend_clone
                            .read_editor_body(
                                &target.project_id,
                                &target.mission_id,
                                &ContentSelector::mission("notes"),
                                desc,
                            )
                            .await
                    }
                    None => {
                        backend_clone
                            .confirm_absent_editor_body(
                                &target.project_id,
                                &target.mission_id,
                                &ContentSelector::mission("notes"),
                            )
                            .await
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
        self.prefill_flight = None;
        self.prefill_serial = self.prefill_serial.saturating_add(1);
    }

    fn revoke_auto_start(&mut self) {
        if let Some(hold) = &mut self.creation_hold {
            hold.auto_start_alive = false;
        }
    }

    #[cfg(test)]
    pub(crate) fn fixture_set_creation_hold(
        &mut self,
        backend: &Backend,
        request: CreateMissionRequest,
        state: HoldState,
    ) {
        self.creation_hold = Some(CreationHold {
            state,
            request,
            start_on_creation: false,
            auto_start_alive: false,
            origin_generation: 0,
            base: backend.base.clone(),
            workspace: backend.workspace.clone(),
            checking: false,
        });
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

pub(super) const TITLE_LIMIT: usize = MISSION_TITLE_MAX;
pub(super) const TEXT_LIMIT: usize = MISSION_TEXT_MAX;
