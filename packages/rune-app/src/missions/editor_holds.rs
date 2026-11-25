//! Window-scoped registry of in-flight and uncertain one-time Mission create/edit
//! operations. Creation holds survive closing the editor, switching Missions, or
//! reconnecting within the same workspace occurrence (matching the server's
//! workspace-scoped creation receipt route). Edit holds survive across Missions and
//! tab close/reopen on the same server and project.
use super::{
    editor::Mode,
    lifecycle::{Lifecycle, Source as LifecycleSource},
};
use crate::platform;
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    missions::{
        CreateMissionOutcome, CreateMissionRequest, CreationReceiptOutcome, EditReceiptOutcome,
        LifecycleTarget, MutationCode, UpdateMissionOutcome, UpdateMissionRequest,
    },
};
use std::collections::HashMap;

const CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HoldState {
    Pending,
    Uncertain,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct CreationScopeKey {
    server: String,
    workspace: String,
    scope: String,
}

impl CreationScopeKey {
    pub(crate) fn new(backend: &Backend, scope: &str) -> Self {
        Self {
            server: server_owner(backend),
            workspace: backend.workspace.clone(),
            scope: scope.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct EditHoldKey {
    server: String,
    project: String,
    mission_id: String,
}

impl EditHoldKey {
    pub(crate) fn new(backend: &Backend, project: &str, mission_id: &str) -> Self {
        Self {
            server: server_owner(backend),
            project: project.to_owned(),
            mission_id: mission_id.to_owned(),
        }
    }

    pub(crate) fn matches_panel(&self, backend: &Backend, project: Option<&str>) -> bool {
        self.server == server_owner(backend) && project.is_none_or(|p| self.project == p)
    }
}

fn server_owner(backend: &Backend) -> String {
    backend
        .client
        .server_identity()
        .map(str::to_owned)
        .unwrap_or_else(|| backend.base.clone())
}

#[derive(Clone, Debug)]
pub(crate) struct FormOrigin {
    pub occurrence: String,
    pub generation: u64,
    pub backend: Backend,
}

impl FormOrigin {
    pub(crate) fn matches(&self, other: &Self) -> bool {
        self.occurrence == other.occurrence
            && self.generation == other.generation
            && self.backend.base == other.backend.base
            && self.backend.workspace == other.backend.workspace
            && self.backend.client.same_connection(&other.backend.client)
    }

    pub(crate) fn matches_live(
        &self,
        occurrence: &str,
        generation: u64,
        backend: &Backend,
    ) -> bool {
        self.occurrence == occurrence
            && self.generation == generation
            && self.backend.base == backend.base
            && self.backend.workspace == backend.workspace
            && self.backend.client.same_connection(&backend.client)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CreationHoldView {
    pub state: HoldState,
    pub request: CreateMissionRequest,
    pub start_on_creation: bool,
    pub checking: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct EditHoldView {
    pub state: HoldState,
    pub target: LifecycleTarget,
    pub request: UpdateMissionRequest,
    pub checking: bool,
}

struct CreationEntry {
    state: HoldState,
    request: CreateMissionRequest,
    start_on_creation: bool,
    auto_start_alive: bool,
    origin: Option<FormOrigin>,
    checking: bool,
    create_flight: Option<Receiver<CreateReply>>,
    receipt_flight: Option<Receiver<ReceiptReply>>,
}

impl CreationEntry {
    fn view(&self) -> CreationHoldView {
        CreationHoldView {
            state: self.state,
            request: self.request.clone(),
            start_on_creation: self.start_on_creation,
            checking: self.checking,
        }
    }
}

struct EditEntry {
    state: HoldState,
    target: LifecycleTarget,
    request: UpdateMissionRequest,
    origin: Option<FormOrigin>,
    checking: bool,
    update_flight: Option<Receiver<UpdateReply>>,
    receipt_flight: Option<Receiver<EditReceiptReply>>,
}

impl EditEntry {
    fn view(&self) -> EditHoldView {
        EditHoldView {
            state: self.state,
            target: self.target.clone(),
            request: self.request.clone(),
            checking: self.checking,
        }
    }
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

struct UpdateReply {
    request_id: String,
    outcome: UpdateMissionOutcome,
    backend: Backend,
}

struct EditReceiptReply {
    request_id: String,
    outcome: EditReceiptOutcome,
    backend: Backend,
}

pub(crate) struct ActiveEditor<'a> {
    pub origin: FormOrigin,
    pub mode: Mode,
    pub backend: &'a Backend,
    pub wake: &'a Wake,
}

#[derive(Clone, Debug)]
pub(crate) enum EditorEvent {
    Created {
        scope: CreationScopeKey,
        mission_id: String,
        revision: u64,
        origin: Option<FormOrigin>,
    },
    CreateRejected {
        origin: Option<FormOrigin>,
        code: MutationCode,
    },
    CreateAuthExpired {
        origin: Option<FormOrigin>,
    },
    CreateReceiptRejected {
        scope: CreationScopeKey,
    },
    CreateUncertain {
        scope: CreationScopeKey,
    },
    Updated {
        key: EditHoldKey,
        mission_id: String,
        revision: u64,
        origin: Option<FormOrigin>,
    },
    EditRevisionConflict {
        key: EditHoldKey,
        origin: Option<FormOrigin>,
    },
    EditRejected {
        key: EditHoldKey,
        origin: Option<FormOrigin>,
        code: MutationCode,
    },
    EditAuthExpired {
        key: EditHoldKey,
        origin: Option<FormOrigin>,
    },
    EditUncertain {
        key: EditHoldKey,
    },
}

#[derive(Default)]
pub(crate) struct EditorHolds {
    creations: HashMap<CreationScopeKey, CreationEntry>,
    edits: HashMap<EditHoldKey, EditEntry>,
    auth_expired: Vec<Backend>,
}

impl EditorHolds {
    pub(crate) fn creation(&self, key: &CreationScopeKey) -> Option<CreationHoldView> {
        self.creations.get(key).map(CreationEntry::view)
    }

    pub(crate) fn edit(&self, key: &EditHoldKey) -> Option<EditHoldView> {
        self.edits.get(key).map(EditEntry::view)
    }

    pub(crate) fn revoke_auto_start_for_scope(&mut self, key: &CreationScopeKey) {
        if let Some(entry) = self.creations.get_mut(key) {
            entry.auto_start_alive = false;
        }
    }

    pub(crate) fn revoke_auto_start_for_occurrence(&mut self, occurrence: &str) {
        for entry in self.creations.values_mut() {
            if entry
                .origin
                .as_ref()
                .is_some_and(|origin| origin.occurrence == occurrence)
            {
                entry.auto_start_alive = false;
            }
        }
    }

    pub(crate) fn start_create(
        &mut self,
        key: CreationScopeKey,
        request: CreateMissionRequest,
        start_on_creation: bool,
        origin: FormOrigin,
        backend: &Backend,
        wake: &Wake,
    ) -> bool {
        if self.creations.contains_key(&key) || self.creations.len() >= CAPACITY {
            return false;
        }
        let (out, incoming) = bounded(1);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        let req_id = request.request_id.clone();
        let req_for_task = request.clone();
        self.creations.insert(
            key,
            CreationEntry {
                state: HoldState::Pending,
                request,
                start_on_creation,
                auto_start_alive: start_on_creation,
                origin: Some(origin),
                checking: false,
                create_flight: Some(incoming),
                receipt_flight: None,
            },
        );
        platform::spawn(async move {
            let outcome = backend_clone.create_mission(&req_for_task).await;
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

    pub(crate) fn start_edit(
        &mut self,
        key: EditHoldKey,
        target: LifecycleTarget,
        request: UpdateMissionRequest,
        origin: FormOrigin,
        backend: &Backend,
        wake: &Wake,
    ) -> bool {
        if self.edits.contains_key(&key) || self.edits.len() >= CAPACITY {
            return false;
        }
        let (out, incoming) = bounded(1);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        let req_id = request.request_id.clone();
        let target_for_task = target.clone();
        let req_for_task = request.clone();
        self.edits.insert(
            key,
            EditEntry {
                state: HoldState::Pending,
                target,
                request,
                origin: Some(origin),
                checking: false,
                update_flight: Some(incoming),
                receipt_flight: None,
            },
        );
        platform::spawn(async move {
            let outcome = backend_clone
                .update_mission(&target_for_task, &req_for_task)
                .await;
            let _ = out
                .send(UpdateReply {
                    request_id: req_id,
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
        true
    }

    pub(crate) fn reconcile_creation(
        &mut self,
        key: &CreationScopeKey,
        origin: Option<FormOrigin>,
        backend: &Backend,
        wake: &Wake,
    ) -> bool {
        let Some(entry) = self.creations.get_mut(key) else {
            return false;
        };
        if entry.state != HoldState::Uncertain || entry.checking {
            return false;
        }
        entry.checking = true;
        entry.origin = origin;
        let req_id = entry.request.request_id.clone();
        let (out, incoming) = bounded(1);
        entry.receipt_flight = Some(incoming);
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

    pub(crate) fn reconcile_edit(
        &mut self,
        key: &EditHoldKey,
        origin: Option<FormOrigin>,
        backend: &Backend,
        wake: &Wake,
    ) -> bool {
        let Some(entry) = self.edits.get_mut(key) else {
            return false;
        };
        if entry.state != HoldState::Uncertain || entry.checking {
            return false;
        }
        entry.checking = true;
        entry.origin = origin;
        let req_id = entry.request.request_id.clone();
        let target = entry.target.clone();
        let request = entry.request.clone();
        let (out, incoming) = bounded(1);
        entry.receipt_flight = Some(incoming);
        let backend_clone = backend.clone();
        let wake_clone = wake.clone();
        platform::spawn(async move {
            let outcome = backend_clone
                .reconcile_mission_edit(&target, &request)
                .await;
            let _ = out
                .send(EditReceiptReply {
                    request_id: req_id,
                    outcome,
                    backend: backend_clone,
                })
                .await;
            wake_clone();
        });
        true
    }

    pub(crate) fn drain_auth_expired(&mut self) -> Vec<Backend> {
        std::mem::take(&mut self.auth_expired)
    }

    /// Two-phase poll: drains every in-flight create/edit/receipt reply FIRST to gather
    /// every connection 401 in the current tick before authorizing any `/control` auto-start.
    pub(crate) fn poll(
        &mut self,
        active: Option<ActiveEditor<'_>>,
        external_auth_expired: &[Backend],
        lifecycle: &mut Lifecycle,
    ) -> (bool, Vec<EditorEvent>) {
        let mut create_replies = Vec::new();
        let mut receipt_replies = Vec::new();
        for (key, entry) in &mut self.creations {
            if let Some(rx) = &entry.create_flight
                && let Ok(reply) = rx.try_recv()
            {
                entry.create_flight = None;
                create_replies.push((key.clone(), reply));
            }
            if let Some(rx) = &entry.receipt_flight
                && let Ok(reply) = rx.try_recv()
            {
                entry.receipt_flight = None;
                receipt_replies.push((key.clone(), reply));
            }
        }
        let mut update_replies = Vec::new();
        let mut edit_receipt_replies = Vec::new();
        for (key, entry) in &mut self.edits {
            if let Some(rx) = &entry.update_flight
                && let Ok(reply) = rx.try_recv()
            {
                entry.update_flight = None;
                update_replies.push((key.clone(), reply));
            }
            if let Some(rx) = &entry.receipt_flight
                && let Ok(reply) = rx.try_recv()
            {
                entry.receipt_flight = None;
                edit_receipt_replies.push((key.clone(), reply));
            }
        }

        // Phase 1b: collect every expired connection across external sources and all drained replies.
        let mut expired: Vec<Backend> = external_auth_expired.to_vec();
        let mut record_expired = |backend: &Backend| {
            if !expired
                .iter()
                .any(|known| known.client.same_connection(&backend.client))
            {
                expired.push(backend.clone());
            }
            if !self
                .auth_expired
                .iter()
                .any(|known| known.client.same_connection(&backend.client))
            {
                self.auth_expired.push(backend.clone());
            }
        };
        for (key, reply) in &create_replies {
            if matches!(reply.outcome, CreateMissionOutcome::AuthExpired)
                && self
                    .creations
                    .get(key)
                    .is_some_and(|e| e.request.request_id == reply.request_id)
            {
                record_expired(&reply.backend);
            }
        }
        for (key, reply) in &receipt_replies {
            if matches!(reply.outcome, CreationReceiptOutcome::AuthExpired)
                && self
                    .creations
                    .get(key)
                    .is_some_and(|e| e.request.request_id == reply.request_id)
            {
                record_expired(&reply.backend);
            }
        }
        for (key, reply) in &update_replies {
            if matches!(reply.outcome, UpdateMissionOutcome::AuthExpired)
                && self
                    .edits
                    .get(key)
                    .is_some_and(|e| e.request.request_id == reply.request_id)
            {
                record_expired(&reply.backend);
            }
        }
        for (key, reply) in &edit_receipt_replies {
            if matches!(reply.outcome, EditReceiptOutcome::AuthExpired)
                && self
                    .edits
                    .get(key)
                    .is_some_and(|e| e.request.request_id == reply.request_id)
            {
                record_expired(&reply.backend);
            }
        }

        // Phase 2: settle every drained reply against the complete same-tick auth fence.
        let mut changed = false;
        let mut events = Vec::new();
        let connection_expired = |candidate: &Backend| {
            expired
                .iter()
                .any(|known| known.client.same_connection(&candidate.client))
        };

        for (key, reply) in create_replies {
            let matching = self
                .creations
                .get(&key)
                .is_some_and(|e| e.request.request_id == reply.request_id);
            if !matching {
                continue;
            }
            changed = true;
            match reply.outcome {
                CreateMissionOutcome::Created(created) => {
                    let entry = self.creations.remove(&key).unwrap();
                    if let Some(ctx) = &active
                        && entry.auto_start_alive
                        && ctx.mode == Mode::Create
                        && entry
                            .origin
                            .as_ref()
                            .is_some_and(|origin| origin.matches(&ctx.origin))
                        && created.can_auto_start()
                        && ctx.backend.base == reply.backend.base
                        && ctx.backend.workspace == reply.backend.workspace
                        && ctx.backend.client.same_connection(&reply.backend.client)
                        && !connection_expired(&reply.backend)
                        && let Ok(start_request) = created.start_request()
                        && let Some(source) = LifecycleSource::from_created(
                            &ctx.origin.occurrence,
                            ctx.backend,
                            &created,
                        )
                    {
                        lifecycle.start(
                            &source,
                            start_request,
                            None,
                            ctx.backend.clone(),
                            ctx.wake.clone(),
                        );
                    }
                    events.push(EditorEvent::Created {
                        scope: key,
                        mission_id: created.id,
                        revision: created.revision,
                        origin: entry.origin,
                    });
                }
                CreateMissionOutcome::Rejected(code) => {
                    let entry = self.creations.remove(&key).unwrap();
                    events.push(EditorEvent::CreateRejected {
                        origin: entry.origin,
                        code,
                    });
                }
                CreateMissionOutcome::AuthExpired => {
                    let entry = self.creations.remove(&key).unwrap();
                    events.push(EditorEvent::CreateAuthExpired {
                        origin: entry.origin,
                    });
                }
                CreateMissionOutcome::Uncertain => {
                    if let Some(entry) = self.creations.get_mut(&key) {
                        entry.state = HoldState::Uncertain;
                        entry.auto_start_alive = false;
                        entry.checking = false;
                    }
                    events.push(EditorEvent::CreateUncertain { scope: key });
                }
            }
        }

        for (key, reply) in receipt_replies {
            let matching = self
                .creations
                .get(&key)
                .is_some_and(|e| e.request.request_id == reply.request_id);
            if !matching {
                continue;
            }
            changed = true;
            match reply.outcome {
                CreationReceiptOutcome::Created {
                    mission_id,
                    revision,
                } => {
                    let entry = self.creations.remove(&key).unwrap();
                    events.push(EditorEvent::Created {
                        scope: key,
                        mission_id,
                        revision,
                        origin: entry.origin,
                    });
                }
                CreationReceiptOutcome::Rejected => {
                    self.creations.remove(&key);
                    events.push(EditorEvent::CreateReceiptRejected { scope: key });
                }
                CreationReceiptOutcome::AuthExpired | CreationReceiptOutcome::Unknown => {
                    if let Some(entry) = self.creations.get_mut(&key) {
                        entry.checking = false;
                    }
                }
            }
        }

        for (key, reply) in update_replies {
            let matching = self
                .edits
                .get(&key)
                .is_some_and(|e| e.request.request_id == reply.request_id);
            if !matching {
                continue;
            }
            changed = true;
            match reply.outcome {
                UpdateMissionOutcome::Updated {
                    mission_id,
                    revision,
                } => {
                    let entry = self.edits.remove(&key).unwrap();
                    events.push(EditorEvent::Updated {
                        key,
                        mission_id,
                        revision,
                        origin: entry.origin,
                    });
                }
                UpdateMissionOutcome::RevisionConflict => {
                    let entry = self.edits.remove(&key).unwrap();
                    events.push(EditorEvent::EditRevisionConflict {
                        key,
                        origin: entry.origin,
                    });
                }
                UpdateMissionOutcome::Rejected(code) => {
                    let entry = self.edits.remove(&key).unwrap();
                    events.push(EditorEvent::EditRejected {
                        key,
                        origin: entry.origin,
                        code,
                    });
                }
                UpdateMissionOutcome::AuthExpired => {
                    let entry = self.edits.remove(&key).unwrap();
                    events.push(EditorEvent::EditAuthExpired {
                        key,
                        origin: entry.origin,
                    });
                }
                UpdateMissionOutcome::Uncertain => {
                    if let Some(entry) = self.edits.get_mut(&key) {
                        entry.state = HoldState::Uncertain;
                        entry.checking = false;
                    }
                    events.push(EditorEvent::EditUncertain { key });
                }
            }
        }

        for (key, reply) in edit_receipt_replies {
            let matching = self
                .edits
                .get(&key)
                .is_some_and(|e| e.request.request_id == reply.request_id);
            if !matching {
                continue;
            }
            changed = true;
            match reply.outcome {
                EditReceiptOutcome::Applied {
                    mission_id,
                    revision,
                } => {
                    let entry = self.edits.remove(&key).unwrap();
                    events.push(EditorEvent::Updated {
                        key,
                        mission_id,
                        revision,
                        origin: entry.origin,
                    });
                }
                EditReceiptOutcome::AuthExpired | EditReceiptOutcome::Unconfirmed => {
                    if let Some(entry) = self.edits.get_mut(&key) {
                        entry.checking = false;
                    }
                }
            }
        }

        (changed, events)
    }

    #[cfg(test)]
    pub(crate) fn fixture_set_creation_hold(
        &mut self,
        key: CreationScopeKey,
        request: CreateMissionRequest,
        state: HoldState,
    ) {
        self.creations.insert(
            key,
            CreationEntry {
                state,
                request,
                start_on_creation: false,
                auto_start_alive: false,
                origin: None,
                checking: false,
                create_flight: None,
                receipt_flight: None,
            },
        );
    }
}
