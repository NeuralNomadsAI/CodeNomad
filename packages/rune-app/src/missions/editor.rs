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
        CreatedMission, CreationReceiptOutcome, EditorBodyOutcome, LifecycleTarget,
        MISSION_TEXT_MAX, MISSION_TITLE_MAX, MapHeader, RunState, StartCreatedOutcome, TaskMode,
        Template, UpdateMissionOutcome, UpdateMissionRequest, derive_mission_title, request_id,
        valid_notes_input, valid_objective_input, valid_title_input,
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
    pub(super) edit_pending: bool,
    pub(super) edit_uncertain: bool,
    pub(super) edit_conflict: bool,
    pub(super) reopening: Option<u64>,
    pub(super) starting_created: bool,
    pub(super) return_focus: Option<String>,
    pub(super) close: WindowCloseState,
}

impl Form {
    fn new_create(hold: Option<&CreationHold>, return_focus: Option<String>) -> Self {
        let mut form = Self {
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
            edit_pending: false,
            edit_uncertain: false,
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

    fn new_edit(target: EditTarget, return_focus: Option<String>) -> Self {
        let title_text = target.title.as_deref().unwrap_or("");
        Self {
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
            prefill: PrefillState::Loading,
            edit_pending: false,
            edit_uncertain: false,
            edit_conflict: false,
            reopening: None,
            starting_created: false,
            return_focus,
            close: WindowCloseState::default(),
        }
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

    pub(super) fn can_submit(&self, hold: Option<&CreationHold>) -> bool {
        if self.starting_created || self.reopening.is_some() {
            return false;
        }
        match self.mode {
            Mode::Create => {
                hold.is_none()
                    && self.objective_valid()
                    && self.title_valid()
                    && self.notes_valid()
                    && self.compare_error().is_none()
            }
            Mode::Edit => {
                self.prefill == PrefillState::Ready
                    && !self.edit_pending
                    && !self.edit_uncertain
                    && !self.edit_conflict
                    && self.objective_valid()
                    && self.notes_valid()
            }
        }
    }

    pub(super) fn fields_locked(&self, hold: Option<&CreationHold>) -> bool {
        if self.starting_created || self.reopening.is_some() {
            return true;
        }
        match self.mode {
            Mode::Create => hold.is_some(),
            Mode::Edit => {
                self.prefill != PrefillState::Ready
                    || self.edit_pending
                    || self.edit_uncertain
                    || self.edit_conflict
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
    outcome: StartCreatedOutcome,
    backend: Backend,
}

struct UpdateReply {
    serial: u64,
    outcome: UpdateMissionOutcome,
    backend: Backend,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SavedMission {
    pub(crate) mission_id: String,
    pub(crate) revision: u64,
    pub(crate) select: bool,
    pub(crate) return_focus: Option<String>,
}

#[derive(Default)]
pub(crate) struct Editor {
    pub(super) form: Option<Form>,
    pub(super) creation_hold: Option<CreationHold>,
    prefill_serial: u64,
    prefill_flight: Option<Receiver<PrefillReply>>,
    create_flight: Option<Receiver<CreateReply>>,
    receipt_flight: Option<Receiver<ReceiptReply>>,
    start_flight: Option<Receiver<StartCreatedReply>>,
    update_serial: u64,
    update_flight: Option<Receiver<UpdateReply>>,
    auth_expired: Option<Backend>,
    saved: Option<SavedMission>,
    focus_initial: Option<&'static str>,
}

impl Editor {
    pub(crate) fn is_open(&self) -> bool {
        self.form.is_some()
    }

    pub(crate) fn is_composing(&self) -> bool {
        self.form.as_ref().is_some_and(Form::is_composing)
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

    pub(crate) fn open_create(&mut self, backend: &Backend, return_focus: Option<String>) {
        self.cancel_edit_flights();
        let hold = self
            .creation_hold
            .as_ref()
            .filter(|hold| hold.same_scope(backend))
            .cloned();
        self.form = Some(Form::new_create(hold.as_ref(), return_focus));
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
        self.cancel_edit_flights();
        let target = EditTarget::from_header(header);
        self.form = Some(Form::new_edit(target.clone(), return_focus));
        self.focus_initial = Some("mission-editor-objective");
        self.start_prefill(target, backend, reads, wake);
        true
    }

    pub(crate) fn close(&mut self) -> Option<String> {
        self.cancel_edit_flights();
        self.focus_initial = None;
        self.form.take().and_then(|form| form.return_focus)
    }

    pub(crate) fn suspend(&mut self) {
        self.prefill_flight = None;
        self.prefill_serial = self.prefill_serial.saturating_add(1);
        if let Some(form) = &mut self.form
            && form.mode == Mode::Edit
            && form.prefill == PrefillState::Loading
        {
            form.prefill = PrefillState::Failed;
        }
    }

    pub(crate) fn rebind(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        self.prefill_flight = None;
        self.prefill_serial = self.prefill_serial.saturating_add(1);
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
        let retry_target = self.form.as_ref().and_then(|form| {
            (form.mode == Mode::Edit
                && matches!(form.prefill, PrefillState::Loading | PrefillState::Failed))
            .then(|| form.edit.clone())
            .flatten()
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
        else {
            return;
        };
        if let Some(form) = &mut self.form {
            form.prefill = PrefillState::Loading;
            form.error = None;
        }
        self.start_prefill(target, backend, reads, wake);
    }

    pub(super) fn begin_reopen(&mut self, map_reads: u64) -> bool {
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.mode != Mode::Edit || form.reopening.is_some() {
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
        let Some(form) = &mut self.form else {
            return false;
        };
        if form.mode != Mode::Edit {
            return false;
        }
        let Some(edit_id) = form.edit.as_ref().map(|edit| edit.mission_id.clone()) else {
            return false;
        };
        if let Some(since_reads) = form.reopening {
            if detail_failed {
                form.reopening = None;
                form.error = Some("missions.control.reader.unavailable");
                return true;
            }
            if map_reads > since_reads
                && let Some(snap) = snapshot
                && snap.header.root.id == edit_id
            {
                form.reopening = None;
                if !snap.header.root.editable() {
                    form.error = Some("missions.control.mutation.conflict");
                    form.edit_conflict = true;
                    return true;
                }
                let return_focus = form.return_focus.clone();
                let target = EditTarget::from_header(&snap.header);
                self.cancel_edit_flights();
                self.form = Some(Form::new_edit(target.clone(), return_focus));
                self.start_prefill(target, backend, reads, wake);
                return true;
            }
            return false;
        }
        if form.edit_uncertain
            && let Some(snap) = snapshot
            && snap.header.root.id == edit_id
            && let Some(edit) = &form.edit
            && (snap.header.root.revision != edit.expected_revision || !snap.header.root.editable())
        {
            form.edit_uncertain = false;
            form.edit_conflict = true;
            form.error = Some("missions.control.mutation.conflict");
            return true;
        }
        false
    }

    pub(super) fn submit(&mut self, backend: &Backend, wake: &Wake) -> bool {
        let Some(form) = &mut self.form else {
            return false;
        };
        match form.mode {
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
        if !form.can_submit(None) {
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
        let title_input = form.title.text.trim();
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
        let hold = CreationHold {
            state: HoldState::Pending,
            request: request.clone(),
            start_on_creation: form.start_on_creation,
            base: backend.base.clone(),
            workspace: backend.workspace.clone(),
            checking: false,
        };
        self.creation_hold = Some(hold);
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
        let Some(form) = &mut self.form else {
            return false;
        };
        if !form.can_submit(None) {
            return false;
        }
        let Some(target) = form.edit.clone() else {
            return false;
        };
        let payload_key = format!(
            "{}\0{}\0{}",
            target.expected_revision,
            form.objective.text.trim(),
            form.notes.text
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
        form.edit_pending = true;
        self.update_serial = self.update_serial.saturating_add(1);
        let serial = self.update_serial;
        let (out, incoming) = bounded(1);
        self.update_flight = Some(incoming);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        let lifecycle_target = target.target;
        platform::spawn(async move {
            let outcome = backend_clone
                .update_mission(&lifecycle_target, &request)
                .await;
            let _ = out
                .send(UpdateReply {
                    serial,
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

    pub(crate) fn poll(&mut self, backend: &Backend, wake: &Wake) -> bool {
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
                let auto_start = self
                    .creation_hold
                    .as_ref()
                    .is_some_and(|hold| hold.start_on_creation);
                match reply.outcome {
                    CreateMissionOutcome::Created(created) => {
                        self.creation_hold = None;
                        let same_live_connection = backend.base == reply.backend.base
                            && backend.workspace == reply.backend.workspace
                            && backend.client.same_connection(&reply.backend.client);
                        if auto_start
                            && created.can_auto_start()
                            && same_live_connection
                            && self.auth_expired.is_none()
                        {
                            self.start_created(created, backend, wake);
                        } else {
                            self.finish_created(created.id, created.revision);
                        }
                    }
                    CreateMissionOutcome::Rejected(code) => {
                        self.creation_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Create
                        {
                            if let Ok(fresh) = request_id() {
                                form.request_id = fresh;
                            }
                            form.last_payload.clear();
                            form.error = Some(code.error_key());
                        }
                    }
                    CreateMissionOutcome::AuthExpired => {
                        // HTTP 401 before route execution proves no write happened; keep the draft editable.
                        self.creation_hold = None;
                        if let Some(form) = &mut self.form
                            && form.mode == Mode::Create
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
                        // A recovered creation receipt never continues automatic Start.
                        self.creation_hold = None;
                        self.finish_created(mission_id, revision);
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
            self.finish_created(reply.mission_id, final_revision);
        }

        if let Some(rx) = &self.update_flight
            && let Ok(reply) = rx.try_recv()
        {
            self.update_flight = None;
            if reply.serial == self.update_serial
                && let Some(form) = &mut self.form
                && form.mode == Mode::Edit
            {
                changed = true;
                form.edit_pending = false;
                match reply.outcome {
                    UpdateMissionOutcome::Updated {
                        mission_id,
                        revision,
                    } => {
                        let return_focus = self.form.take().and_then(|f| f.return_focus);
                        self.saved = Some(SavedMission {
                            mission_id,
                            revision,
                            select: false,
                            return_focus,
                        });
                    }
                    UpdateMissionOutcome::RevisionConflict => {
                        form.edit_conflict = true;
                        form.error = Some("missions.control.mutation.conflict");
                    }
                    UpdateMissionOutcome::Rejected(code) => {
                        if let Ok(fresh) = request_id() {
                            form.request_id = fresh;
                        }
                        form.last_payload.clear();
                        form.error = Some(code.error_key());
                    }
                    UpdateMissionOutcome::AuthExpired => {
                        if let Ok(fresh) = request_id() {
                            form.request_id = fresh;
                        }
                        form.last_payload.clear();
                        self.auth_expired = Some(reply.backend);
                    }
                    UpdateMissionOutcome::Uncertain => {
                        form.edit_uncertain = true;
                        form.error = None;
                    }
                }
            }
        }

        changed
    }

    fn start_created(&mut self, created: CreatedMission, backend: &Backend, wake: &Wake) {
        if let Some(form) = &mut self.form
            && form.mode == Mode::Create
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
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
    }

    fn finish_created(&mut self, mission_id: String, revision: u64) {
        let return_focus = self
            .form
            .take_if(|form| form.mode == Mode::Create)
            .and_then(|form| form.return_focus);
        self.saved = Some(SavedMission {
            mission_id,
            revision,
            select: true,
            return_focus,
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
                None => EditorBodyOutcome::Ready(target.excerpt.clone()),
            };
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
                    None => EditorBodyOutcome::Ready(String::new()),
                }
            } else {
                EditorBodyOutcome::Ready(String::new())
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

    fn cancel_edit_flights(&mut self) {
        self.prefill_flight = None;
        self.prefill_serial = self.prefill_serial.saturating_add(1);
        self.update_flight = None;
        self.update_serial = self.update_serial.saturating_add(1);
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
        objective.trim(),
        title.trim(),
        notes,
        template.as_str(),
        task_mode.as_str()
    )
}

pub(super) fn title_limit_exceeded(text: &str) -> bool {
    !valid_title_input(text)
}

pub(super) fn objective_limit_exceeded(text: &str) -> bool {
    text.chars().count() > MISSION_TEXT_MAX || text.contains('\0')
}

pub(super) fn notes_limit_exceeded(text: &str) -> bool {
    !valid_notes_input(text)
}

pub(super) const TITLE_LIMIT: usize = MISSION_TITLE_MAX;
pub(super) const TEXT_LIMIT: usize = MISSION_TEXT_MAX;
