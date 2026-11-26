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
        ScheduleAction as Act, ScheduleControlOutcome as CtrlOut, ScheduleControlRequest,
        ScheduleReadOutcome as ReadOut, UnifiedSchedule, classify_schedule_control_read,
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub(crate) type AuthSink = Arc<Mutex<Vec<Backend>>>;
pub(super) fn push_auth_sink(sink: &AuthSink, b: Backend) {
    if let Ok(mut list) = sink.lock() {
        push_auth_expired(&mut list, b);
    }
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
    Control(ScheduleControlRequest, bool),
    Publication(u64),
}
impl ScheduleHoldPhase {
    pub(crate) fn is_publication(&self) -> bool {
        matches!(self, Self::Publication(_))
    }
    pub(crate) fn action(&self) -> Option<Act> {
        match self {
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
    OpenConversation(String),
}

#[derive(Clone, Debug)]
pub(crate) enum ScheduleHoldEvent {
    Settled(ScheduleHoldKey, bool),
    Refused(ScheduleHoldKey, &'static str),
    NeedsRefresh(ScheduleHoldKey),
}

pub(crate) struct ActiveScheduleView<'a> {
    pub occurrence: &'a str,
    pub backend: &'a Backend,
    pub project: &'a str,
    pub scope: &'a str,
    pub selected: Option<&'a str>,
    pub wake: &'a Wake,
}

enum Reply {
    Ctrl(String, Option<String>, ScheduleControlRequest, CtrlOut),
    Read(ScheduleControlRequest, ReadOut),
}

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
        let pending = self
            .auth_sink
            .lock()
            .map(|mut list| std::mem::take(&mut *list))
            .unwrap_or_default();
        let got = !pending.is_empty();
        for b in pending {
            push_auth_expired(&mut self.auth_expired, b);
        }
        got
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
                && matches!(e.phase, ScheduleHoldPhase::Control(..))
        })
    }
    pub(crate) fn retire_workspace(&mut self, b: &Backend) {
        let srv = owner(b);
        self.entries.retain(|k, e| {
            if k.server == srv && e.workspace == b.workspace {
                if let Some((fb, rx)) = e.flight.take()
                    && let Ok(
                        Reply::Ctrl(_, _, _, CtrlOut::AuthExpired)
                        | Reply::Read(_, ReadOut::AuthExpired),
                    ) = rx.try_recv()
                {
                    push_auth_expired(&mut self.auth_expired, fb);
                }
                false
            } else {
                true
            }
        });
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

    pub(crate) fn dispatch_control(
        &mut self,
        key: ScheduleHoldKey,
        occ: String,
        req: ScheduleControlRequest,
        doc: UnifiedSchedule,
        ctx: ScheduleCtx<'_>,
    ) -> bool {
        if !self.has_capacity_for(&key) {
            return false;
        }
        let (b, id, r, dir, wake) = (
            ctx.backend.clone(),
            key.schedule_id.clone(),
            req.clone(),
            ctx.directory.map(str::to_owned),
            ctx.wake.clone(),
        );
        let (out_tx, rx) = bounded(1);
        platform::spawn(async move {
            let out = b.control_mission_schedule(&id, &r).await;
            if out_tx.send(Reply::Ctrl(occ, dir, r, out)).await.is_ok() {
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
            ScheduleHoldPhase::Control(req, _) => {
                spawn_receipt(
                    key,
                    e,
                    ctx.backend.clone(),
                    ctx.directory.map(str::to_owned),
                    req.clone(),
                    ctx.wake.clone(),
                );
                true
            }
        }
    }

    pub(crate) fn poll(
        &mut self,
        active: Option<&ActiveScheduleView<'_>>,
        exp: &[Backend],
    ) -> (bool, Vec<ScheduleHoldEvent>) {
        let (mut changed, mut evs) = (self.drain_auth_sink(), Vec::new());
        for key in self.entries.keys().cloned().collect::<Vec<_>>() {
            let Some(e) = self.entries.get_mut(&key) else {
                continue;
            };
            let Some((b, rx)) = e.flight.take() else {
                continue;
            };
            let reply = match rx.try_recv() {
                Ok(r) => r,
                Err(TryRecvError::Empty) => {
                    e.flight = Some((b, rx));
                    continue;
                }
                Err(TryRecvError::Closed) => {
                    changed = true;
                    e.checking = false;
                    continue;
                }
            };
            changed = true;
            e.checking = false;
            self.on_reply(key, b, reply, active, exp, &mut evs);
        }
        (changed, evs)
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
            Reply::Ctrl(_, _, _, CtrlOut::Settled(rev)) => self.settle(&key, rev, evs),
            Reply::Ctrl(_, _, _, CtrlOut::Refused) => {
                if let Some(m) = self.entries.get(&key).and_then(|e| e.min_rev) {
                    self.settle(&key, Some(m), evs);
                } else {
                    self.entries.remove(&key);
                }
                evs.push(Ev::Refused(key, "missions.scheduleList.conflict"));
            }
            Reply::Ctrl(occ, dir, req, CtrlOut::Pending(partial)) => {
                if let Some(e) = self.entries.get_mut(&key) {
                    set_partial(Some(e), partial);
                    if let Some(v) =
                        active.filter(|v| view_ok(v, &key, &occ, &b) && !expired(&b, exp))
                    {
                        spawn_receipt(&key, e, b, dir, req, v.wake.clone());
                    } else {
                        evs.push(Ev::NeedsRefresh(key));
                    }
                }
            }
            Reply::Ctrl(_, _, _, CtrlOut::AuthExpired) | Reply::Read(_, ReadOut::AuthExpired) => {
                push_auth_expired(&mut self.auth_expired, b);
            }
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

fn spawn_receipt(
    key: &ScheduleHoldKey,
    e: &mut Entry,
    b: Backend,
    dir: Option<String>,
    req: ScheduleControlRequest,
    wake: Wake,
) {
    let (bc, id, r) = (b.clone(), key.schedule_id.clone(), req.clone());
    let (out_tx, rx) = bounded(1);
    platform::spawn(async move {
        let (_keep, c) = bounded(1);
        let out = bc
            .mission_schedule_read(&id, dir.as_deref(), Some(&r.request_id), &c)
            .await;
        if out_tx.send(Reply::Read(r, out)).await.is_ok() {
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
fn view_ok(v: &ActiveScheduleView<'_>, k: &ScheduleHoldKey, occ: &str, b: &Backend) -> bool {
    v.occurrence == occ
        && v.selected == Some(k.schedule_id.as_str())
        && k.matches_scope(v.backend, v.project, v.scope)
        && v.backend.client.same_connection(&b.client)
}
fn expired(b: &Backend, list: &[Backend]) -> bool {
    list.iter().any(|k| k.client.same_connection(&b.client))
}
