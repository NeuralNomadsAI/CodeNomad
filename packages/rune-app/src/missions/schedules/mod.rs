//! Window-scoped recurring Mission schedule controls, holds and receipts,
//! paired with panel-owned list/detail state and pure view assembly.
mod list;
mod view;

#[cfg(test)]
mod tests;

pub(crate) use list::{Cap, ScheduleCtx, Schedules};
pub(crate) use view::{confirmation, detail_section, list_section};

use crate::platform;
use codenomad_client::{
    Receiver, TryRecvError, Wake,
    backend::Backend,
    bounded,
    missions::{
        ActivationRefusal, ScheduleAction as Act, ScheduleActivationOutcome as ActOut,
        ScheduleActivationRequest, ScheduleControlOutcome as CtrlOut, ScheduleControlRequest,
        ScheduleReadOutcome as ReadOut, UnifiedSchedule, classify_schedule_control_read,
    },
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(crate) struct AuthSinkState {
    pub(super) pending: Vec<Backend>,
    log: VecDeque<(u64, Backend)>,
    epoch: u64,
}
pub(crate) type AuthSink = Arc<Mutex<AuthSinkState>>;
pub(super) fn push_auth_sink(sink: &AuthSink, b: Backend) {
    if let Ok(mut state) = sink.lock() {
        state.epoch = state.epoch.wrapping_add(1);
        let ep = state.epoch;
        if state.log.len() >= 64 {
            state.log.pop_front();
        }
        state.log.push_back((ep, b.clone()));
        push_auth_expired(&mut state.pending, b);
    }
}
pub(super) fn take_auth_sink(sink: &AuthSink) -> (Vec<Backend>, u64) {
    sink.lock()
        .map(|mut state| (std::mem::take(&mut state.pending), state.epoch))
        .unwrap_or_default()
}
pub(super) fn has_auth_since(sink: &AuthSink, since_epoch: u64, b: &Backend) -> bool {
    let Ok(state) = sink.lock() else {
        return true;
    };
    if state.epoch == since_epoch {
        return false;
    }
    let delta = state.epoch.wrapping_sub(since_epoch);
    if delta > state.log.len() as u64 {
        return true;
    }
    state.log.iter().any(|(ep, bk)| {
        let diff = ep.wrapping_sub(since_epoch);
        diff != 0 && diff <= delta && bk.client.same_connection(&b.client)
    })
}

pub(crate) const HOLD_CAPACITY: usize = 128;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ScheduleHoldKey {
    server: String,
    project: String,
    scope: String,
    pub schedule_id: String,
}
impl ScheduleHoldKey {
    pub(crate) fn new(b: &Backend, p: &str, scope: &str, id: &str) -> Self {
        Self {
            server: owner(b),
            project: p.into(),
            scope: scope.into(),
            schedule_id: id.into(),
        }
    }
    pub(crate) fn matches_scope(&self, b: &Backend, p: &str, scope: &str) -> bool {
        self.server == owner(b) && self.project == p && self.scope == scope
    }
}
fn owner(b: &Backend) -> String {
    b.client
        .server_identity()
        .map(str::to_owned)
        .unwrap_or_else(|| b.base.clone())
}
pub(super) fn push_auth_expired(dst: &mut Vec<Backend>, b: Backend) {
    if !dst.iter().any(|k| k.client.same_connection(&b.client)) {
        dst.push(b);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ScheduleHoldPhase {
    Activation {
        action: Act,
        request_id: String,
        proof_expected_revision: u64,
    },
    Control(ScheduleControlRequest, bool),
    Publication(u64),
}
impl ScheduleHoldPhase {
    pub(crate) fn is_publication(&self) -> bool {
        matches!(self, Self::Publication(_))
    }
    pub(crate) fn action(&self) -> Option<Act> {
        match self {
            Self::Activation { action, .. } => Some(*action),
            Self::Control(r, _) => Some(r.action),
            Self::Publication(_) => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ScheduleConfirmation {
    pub occurrence: String,
    pub key: ScheduleHoldKey,
    pub action: Act,
    pub expected_revision: u64,
    pub generation: u64,
    pub title: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ScheduleGesture {
    Select(String),
    More,
    RetryList,
    Action(Act),
    Confirm(bool),
    Reconcile,
    ToggleInstructions,
    ToggleDiagnostics,
    ToggleDiagnosticsInfo,
    ToggleRefusalInfo,
    ToggleActivatableInfo,
    OpenConfigFile(String),
    OpenConversation(String),
}

#[derive(Clone, Debug)]
pub(crate) enum ScheduleHoldEvent {
    Settled(ScheduleHoldKey, bool),
    Refused(ScheduleHoldKey, &'static str),
    ActivationRefused(ScheduleHoldKey, Option<ActivationRefusal>),
    NeedsRefresh(ScheduleHoldKey),
}

pub(crate) struct ActiveScheduleView<'a> {
    pub occurrence: &'a str,
    pub backend: &'a Backend,
    pub project: &'a str,
    pub scope: &'a str,
    pub selected: Option<&'a str>,
    pub view_epoch: u64,
    pub wake: &'a Wake,
}

enum Reply {
    ActApply(String, Option<String>, Act, u64, ActOut),
    ActAborted(u64),
    ActRead(ActOut),
    Ctrl(String, Option<String>, ScheduleControlRequest, u64, CtrlOut),
    Read(ScheduleControlRequest, ReadOut),
    ReadAborted,
}

pub(crate) struct ReadyScheduleReplies(Vec<(ScheduleHoldKey, Backend, Reply)>);

struct Entry {
    phase: ScheduleHoldPhase,
    workspace: String,
    doc: UnifiedSchedule,
    min_rev: Option<u64>,
    checking: bool,
    flight: Option<(Backend, Receiver<Reply>)>,
}

#[derive(Default)]
pub(crate) struct ScheduleHolds {
    entries: HashMap<ScheduleHoldKey, Entry>,
    pub confirmation: Option<ScheduleConfirmation>,
    auth_sink: AuthSink,
    auth_expired: Vec<Backend>,
}

impl ScheduleHolds {
    pub(crate) fn auth_sink(&self) -> AuthSink {
        Arc::clone(&self.auth_sink)
    }
    fn drain_auth_sink(&mut self) -> bool {
        let (pending, _) = take_auth_sink(&self.auth_sink);
        let got = !pending.is_empty();
        for b in pending {
            push_auth_expired(&mut self.auth_expired, b);
        }
        got
    }
    fn drain_auth_sink_epoch(&mut self) -> u64 {
        let (pending, epoch) = take_auth_sink(&self.auth_sink);
        for b in pending {
            push_auth_expired(&mut self.auth_expired, b);
        }
        epoch
    }
    pub(crate) fn get(&self, key: &ScheduleHoldKey) -> Option<(&ScheduleHoldPhase, bool)> {
        self.entries.get(key).map(|e| (&e.phase, e.checking))
    }
    pub(crate) fn has_capacity_for(&self, key: &ScheduleHoldKey) -> bool {
        self.entries.len() < HOLD_CAPACITY || self.entries.contains_key(key)
    }
    pub(crate) fn has_unresolved_control_for_workspace(&self, b: &Backend) -> bool {
        let srv = owner(b);
        self.entries.iter().any(|(k, e)| {
            k.server == srv
                && e.workspace == b.workspace
                && matches!(
                    e.phase,
                    ScheduleHoldPhase::Control(..) | ScheduleHoldPhase::Activation { .. }
                )
        })
    }
    pub(crate) fn retire_workspace(&mut self, b: &Backend) {
        self.drain_auth_sink();
        let srv = owner(b);
        self.entries
            .retain(|k, e| !(k.server == srv && e.workspace == b.workspace));
    }
    pub(crate) fn held_documents<'a>(
        &'a self,
        b: &Backend,
        p: &str,
        scope: &str,
    ) -> impl Iterator<Item = &'a UnifiedSchedule> {
        let srv = owner(b);
        self.entries.iter().filter_map(move |(k, e)| {
            (k.server == srv && k.project == p && k.scope == scope).then_some(&e.doc)
        })
    }
    pub(crate) fn mark_published(
        &mut self,
        b: &Backend,
        p: &str,
        scope: &str,
        docs: &[UnifiedSchedule],
    ) -> bool {
        let mut changed = false;
        for d in docs {
            let k = ScheduleHoldKey::new(b, p, scope, &d.id);
            if self.entries.get(&k).is_some_and(
                |e| matches!(e.phase, ScheduleHoldPhase::Publication(m) if d.revision >= m),
            ) {
                self.entries.remove(&k);
                changed = true;
            }
        }
        changed
    }
    pub(crate) fn drain_auth_expired(&mut self) -> Vec<Backend> {
        self.drain_auth_sink();
        std::mem::take(&mut self.auth_expired)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn dispatch_activation(
        &mut self,
        key: ScheduleHoldKey,
        occ: String,
        action: Act,
        view_epoch: u64,
        request_id: String,
        proof_expected_revision: u64,
        expected_document_revision: u64,
        doc: UnifiedSchedule,
        ctx: ScheduleCtx<'_>,
    ) -> bool {
        if !self.has_capacity_for(&key) {
            return false;
        }
        let req = ScheduleActivationRequest {
            request_id: request_id.clone(),
            expected_document_revision,
        };
        if req.validate().is_err() {
            return false;
        }
        let (b, id, dir, wake, sink) = (
            ctx.backend.clone(),
            key.schedule_id.clone(),
            ctx.directory.map(str::to_owned),
            ctx.wake.clone(),
            self.auth_sink.clone(),
        );
        let (out_tx, rx) = bounded(1);
        platform::spawn(async move {
            let out = b
                .mission_schedule_settings_apply(&id, &req, proof_expected_revision)
                .await;
            let auth = matches!(out, ActOut::AuthExpired);
            if auth {
                push_auth_sink(&sink, b.clone());
            }
            if out_tx
                .send(Reply::ActApply(occ, dir, action, view_epoch, out))
                .await
                .is_ok()
                || auth
            {
                wake();
            }
        });
        let min_rev = self.entries.get(&key).and_then(|e| e.min_rev);
        let entry = Entry {
            phase: ScheduleHoldPhase::Activation {
                action,
                request_id,
                proof_expected_revision,
            },
            workspace: ctx.backend.workspace.clone(),
            doc,
            min_rev,
            checking: true,
            flight: Some((ctx.backend.clone(), rx)),
        };
        self.entries.insert(key, entry);
        true
    }

    pub(crate) fn dispatch_control(
        &mut self,
        key: ScheduleHoldKey,
        occ: String,
        view_epoch: u64,
        req: ScheduleControlRequest,
        doc: UnifiedSchedule,
        ctx: ScheduleCtx<'_>,
    ) -> bool {
        if !self.has_capacity_for(&key) {
            return false;
        }
        let (b, id, r, dir, wake, sink) = (
            ctx.backend.clone(),
            key.schedule_id.clone(),
            req.clone(),
            ctx.directory.map(str::to_owned),
            ctx.wake.clone(),
            self.auth_sink.clone(),
        );
        let (out_tx, rx) = bounded(1);
        platform::spawn(async move {
            let out = b.control_mission_schedule(&id, &r).await;
            let auth = matches!(out, CtrlOut::AuthExpired);
            if auth {
                push_auth_sink(&sink, b.clone());
            }
            if out_tx
                .send(Reply::Ctrl(occ, dir, r, view_epoch, out))
                .await
                .is_ok()
                || auth
            {
                wake();
            }
        });
        let min_rev = self.entries.get(&key).and_then(|e| e.min_rev);
        let entry = Entry {
            phase: ScheduleHoldPhase::Control(req, false),
            workspace: ctx.backend.workspace.clone(),
            doc,
            min_rev,
            checking: true,
            flight: Some((ctx.backend.clone(), rx)),
        };
        self.entries.insert(key, entry);
        true
    }

    /// Explicit user-triggered receipt read ("Refresh saved request"). Never resends a mutation.
    pub(crate) fn reconcile(&mut self, key: &ScheduleHoldKey, ctx: ScheduleCtx<'_>) -> bool {
        let Some(e) = self.entries.get_mut(key) else {
            return false;
        };
        if e.checking || e.workspace != ctx.backend.workspace {
            return false;
        }
        match &e.phase {
            ScheduleHoldPhase::Publication(_) => true,
            ScheduleHoldPhase::Activation {
                request_id,
                proof_expected_revision,
                ..
            } => {
                let req_id = request_id.clone();
                let proof_rev = *proof_expected_revision;
                let (b, id, wake, sink) = (
                    ctx.backend.clone(),
                    key.schedule_id.clone(),
                    ctx.wake.clone(),
                    self.auth_sink.clone(),
                );
                let (out_tx, rx) = bounded(1);
                platform::spawn(async move {
                    let (_keep, c) = bounded(1);
                    let out = b
                        .mission_schedule_settings_read(&id, &req_id, proof_rev, &c)
                        .await;
                    let auth = matches!(out, ActOut::AuthExpired);
                    if auth {
                        push_auth_sink(&sink, b.clone());
                    }
                    if out_tx.send(Reply::ActRead(out)).await.is_ok() || auth {
                        wake();
                    }
                });
                e.checking = true;
                e.flight = Some((ctx.backend.clone(), rx));
                true
            }
            ScheduleHoldPhase::Control(req, _) => {
                let sink = self.auth_sink.clone();
                spawn_receipt(
                    key,
                    e,
                    ctx.backend.clone(),
                    ctx.directory.map(str::to_owned),
                    req.clone(),
                    ctx.wake.clone(),
                    sink,
                    None,
                );
                true
            }
        }
    }

    pub(crate) fn collect_ready(&mut self, exp: &mut Vec<Backend>) -> (bool, ReadyScheduleReplies) {
        let mut changed = self.drain_auth_sink();
        let mut ready = Vec::new();
        for key in self.entries.keys().cloned().collect::<Vec<_>>() {
            let Some(e) = self.entries.get_mut(&key) else {
                continue;
            };
            let Some((b, rx)) = e.flight.take() else {
                continue;
            };
            match rx.try_recv() {
                Ok(reply) => {
                    changed = true;
                    e.checking = false;
                    ready.push((key, b, reply));
                }
                Err(TryRecvError::Empty) => {
                    e.flight = Some((b, rx));
                }
                Err(TryRecvError::Closed) => {
                    changed = true;
                    e.checking = false;
                }
            }
        }
        changed |= self.drain_auth_sink();
        for b in &self.auth_expired {
            push_auth_expired(exp, b.clone());
        }
        (changed, ReadyScheduleReplies(ready))
    }

    pub(crate) fn apply_ready(
        &mut self,
        mut ready: ReadyScheduleReplies,
        active: Option<&ActiveScheduleView<'_>>,
        exp: &[Backend],
    ) -> (bool, Vec<ScheduleHoldEvent>) {
        let mut all_expired: Vec<Backend> = exp.to_vec();
        let (mut changed, extra) = self.collect_ready(&mut all_expired);
        ready.0.extend(extra.0);
        let mut evs = Vec::new();
        for (key, b, reply) in ready.0 {
            changed = true;
            self.on_reply(key, b, reply, active, &all_expired, &mut evs);
        }
        (changed, evs)
    }

    #[cfg(test)]
    pub(crate) fn poll(
        &mut self,
        active: Option<&ActiveScheduleView<'_>>,
        exp: &[Backend],
    ) -> (bool, Vec<ScheduleHoldEvent>) {
        let mut all = exp.to_vec();
        let (c1, ready) = self.collect_ready(&mut all);
        let (c2, evs) = self.apply_ready(ready, active, &all);
        (c1 || c2, evs)
    }

    fn on_reply(
        &mut self,
        key: ScheduleHoldKey,
        b: Backend,
        reply: Reply,
        active: Option<&ActiveScheduleView<'_>>,
        exp: &[Backend],
        evs: &mut Vec<ScheduleHoldEvent>,
    ) {
        use ScheduleHoldEvent as Ev;
        match reply {
            Reply::ActApply(occ, dir, action, view_epoch, out) => match out {
                ActOut::Ready { revision } => {
                    if let Some(e) = self.entries.get_mut(&key) {
                        e.min_rev = Some(e.min_rev.unwrap_or(0).max(revision));
                    }
                    let sink_epoch = self.drain_auth_sink_epoch();
                    let sink = self.auth_sink.clone();
                    if let Some(v) = active.filter(|v| {
                        view_ok(v, &key, &occ, view_epoch, &b)
                            && !expired(&b, exp)
                            && !expired(&b, &self.auth_expired)
                    }) && let Ok(ctrl_req) =
                        ScheduleControlRequest::new(action, revision, dir.clone())
                        && let Some(e) = self.entries.get_mut(&key)
                    {
                        let (bc, id, r, wake) = (
                            b.clone(),
                            key.schedule_id.clone(),
                            ctrl_req.clone(),
                            v.wake.clone(),
                        );
                        let (out_tx, rx) = bounded(1);
                        platform::spawn(async move {
                            if has_auth_since(&sink, sink_epoch, &bc) {
                                if out_tx.send(Reply::ActAborted(revision)).await.is_ok() {
                                    wake();
                                }
                                return;
                            }
                            let out = bc.control_mission_schedule(&id, &r).await;
                            let auth = matches!(out, CtrlOut::AuthExpired);
                            if auth {
                                push_auth_sink(&sink, bc.clone());
                            }
                            if out_tx
                                .send(Reply::Ctrl(occ, dir, r, view_epoch, out))
                                .await
                                .is_ok()
                                || auth
                            {
                                wake();
                            }
                        });
                        e.phase = ScheduleHoldPhase::Control(ctrl_req, false);
                        e.checking = true;
                        e.flight = Some((b, rx));
                    } else {
                        self.settle(&key, Some(revision), evs);
                    }
                }
                ActOut::Refused {
                    refusal,
                    not_applied,
                } => {
                    if not_applied {
                        self.entries.remove(&key);
                    }
                    evs.push(Ev::ActivationRefused(key, refusal));
                }
                ActOut::Conflict => {
                    self.entries.remove(&key);
                    evs.push(Ev::Refused(key, "missions.scheduleList.conflict"));
                }
                ActOut::AuthExpired => {}
                ActOut::Unconfirmed => evs.push(Ev::NeedsRefresh(key)),
            },
            Reply::ActAborted(revision) => self.settle(&key, Some(revision), evs),
            Reply::ActRead(out) => match out {
                ActOut::Ready { revision } => self.settle(&key, Some(revision), evs),
                ActOut::AuthExpired => {}
                ActOut::Refused { .. } | ActOut::Conflict | ActOut::Unconfirmed => {
                    evs.push(Ev::NeedsRefresh(key));
                }
            },
            Reply::Ctrl(_, _, _, _, CtrlOut::Settled(rev)) => self.settle(&key, rev, evs),
            Reply::Ctrl(_, _, _, _, CtrlOut::Refused) => {
                if let Some(m) = self.entries.get(&key).and_then(|e| e.min_rev) {
                    self.settle(&key, Some(m), evs);
                } else {
                    self.entries.remove(&key);
                }
                evs.push(Ev::Refused(key, "missions.scheduleList.conflict"));
            }
            Reply::Ctrl(occ, dir, req, view_epoch, CtrlOut::Pending(partial)) => {
                let sink_epoch = self.drain_auth_sink_epoch();
                let sink = self.auth_sink.clone();
                let auth_blocked = expired(&b, exp) || expired(&b, &self.auth_expired);
                if let Some(e) = self.entries.get_mut(&key) {
                    set_partial(Some(e), partial);
                    if let Some(v) =
                        active.filter(|v| view_ok(v, &key, &occ, view_epoch, &b) && !auth_blocked)
                    {
                        spawn_receipt(&key, e, b, dir, req, v.wake.clone(), sink, Some(sink_epoch));
                    } else {
                        evs.push(Ev::NeedsRefresh(key));
                    }
                }
            }
            Reply::Ctrl(_, _, _, _, CtrlOut::AuthExpired)
            | Reply::Read(_, ReadOut::AuthExpired) => {}
            Reply::Read(req, ReadOut::Ready(read)) => {
                match classify_schedule_control_read(&key.schedule_id, &req, &read) {
                    CtrlOut::Settled(rev) => self.settle(&key, rev, evs),
                    CtrlOut::Pending(p) => {
                        set_partial(self.entries.get_mut(&key), p);
                        evs.push(Ev::NeedsRefresh(key));
                    }
                    _ => evs.push(Ev::NeedsRefresh(key)),
                }
            }
            Reply::Read(req, ReadOut::Pending(rec)) => {
                let ok =
                    rec.is_some_and(|(id, c)| id == key.schedule_id && req.matches_control(&c));
                set_partial(self.entries.get_mut(&key), ok);
                evs.push(Ev::NeedsRefresh(key));
            }
            Reply::ReadAborted => evs.push(Ev::NeedsRefresh(key)),
            _ => evs.push(Ev::NeedsRefresh(key)),
        }
    }

    fn settle(
        &mut self,
        key: &ScheduleHoldKey,
        rev: Option<u64>,
        evs: &mut Vec<ScheduleHoldEvent>,
    ) {
        let Some(e) = self.entries.get_mut(key) else {
            return;
        };
        let del = rev.is_none() && e.phase.action() == Some(Act::Delete);
        if let Some(r) = rev {
            let min = e.min_rev.unwrap_or(0).max(r);
            e.phase = ScheduleHoldPhase::Publication(min);
            e.min_rev = Some(min);
            e.checking = false;
            e.flight = None;
        } else {
            self.entries.remove(key);
        }
        evs.push(ScheduleHoldEvent::Settled(key.clone(), del));
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_receipt(
    key: &ScheduleHoldKey,
    e: &mut Entry,
    b: Backend,
    dir: Option<String>,
    req: ScheduleControlRequest,
    wake: Wake,
    sink: AuthSink,
    abort_after_epoch: Option<u64>,
) {
    let (bc, id, r) = (b.clone(), key.schedule_id.clone(), req.clone());
    let (out_tx, rx) = bounded(1);
    platform::spawn(async move {
        if let Some(ep) = abort_after_epoch
            && has_auth_since(&sink, ep, &bc)
        {
            if out_tx.send(Reply::ReadAborted).await.is_ok() {
                wake();
            }
            return;
        }
        let (_keep, c) = bounded(1);
        let out = bc
            .mission_schedule_read(&id, dir.as_deref(), Some(&r.request_id), &c)
            .await;
        let auth = matches!(out, ReadOut::AuthExpired);
        if auth {
            push_auth_sink(&sink, bc.clone());
        }
        if out_tx.send(Reply::Read(r, out)).await.is_ok() || auth {
            wake();
        }
    });
    e.checking = true;
    e.flight = Some((b, rx));
}
fn set_partial(e: Option<&mut Entry>, val: bool) {
    if let Some(Entry {
        phase: ScheduleHoldPhase::Control(_, p),
        ..
    }) = e
    {
        *p = val;
    }
}
fn view_ok(
    v: &ActiveScheduleView<'_>,
    k: &ScheduleHoldKey,
    occ: &str,
    view_epoch: u64,
    b: &Backend,
) -> bool {
    v.occurrence == occ
        && v.selected == Some(k.schedule_id.as_str())
        && v.view_epoch == view_epoch
        && k.matches_scope(v.backend, v.project, v.scope)
        && v.backend.client.same_connection(&b.client)
}
fn expired(b: &Backend, list: &[Backend]) -> bool {
    list.iter().any(|k| k.client.same_connection(&b.client))
}
