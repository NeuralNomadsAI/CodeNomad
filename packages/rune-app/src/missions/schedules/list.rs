//! Panel-owned bounded schedule pages, off-page point reads, capability probes
//! and pre-dispatch verification.
use super::{
    AuthSink, ScheduleConfirmation, ScheduleGesture as G, ScheduleHoldEvent as Ev,
    ScheduleHoldKey as Key, ScheduleHoldPhase as Phase, ScheduleHolds, push_auth_expired,
    push_auth_sink, take_auth_sink,
};
use crate::platform::{self, reads::Reads};
use codenomad_client::{
    Receiver, Sender, TryRecvError, Wake,
    backend::Backend,
    bounded,
    missions::{
        ActivationRefusal, SCHEDULE_PAGE_LIMIT, ScheduleAction as Act, ScheduleCapability,
        ScheduleControlRequest, ScheduleFetch as Fetch, ScheduleListPage,
        ScheduleReadOutcome as ReadOut, UnifiedSchedule, request_id,
    },
};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Cap {
    Available,
    Activatable,
    Refused,
    Missing,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SelectionError {
    Pending,
    Failed,
}
#[derive(Clone, Copy)]
pub(crate) struct ScheduleCtx<'a> {
    pub backend: &'a Backend,
    pub project: Option<&'a str>,
    pub scope: &'a str,
    pub directory: Option<&'a str>,
    pub reads: &'a Reads,
    pub wake: &'a Wake,
}

#[cfg(not(target_arch = "wasm32"))]
trait PlatformFut<O>: std::future::Future<Output = O> + Send + 'static {}
#[cfg(not(target_arch = "wasm32"))]
impl<O, F: std::future::Future<Output = O> + Send + 'static> PlatformFut<O> for F {}
#[cfg(target_arch = "wasm32")]
trait PlatformFut<O>: std::future::Future<Output = O> + 'static {}
#[cfg(target_arch = "wasm32")]
impl<O, F: std::future::Future<Output = O> + 'static> PlatformFut<O> for F {}

struct Flight<T, M = ()>(M, Backend, Sender<()>, Receiver<T>);
impl<T: Send + 'static, M> Flight<T, M> {
    fn spawn<Fut: PlatformFut<Option<T>>>(
        meta: M,
        backend: Backend,
        wake: Wake,
        auth_sink: AuthSink,
        is_auth: fn(&T) -> bool,
        f: impl FnOnce(Receiver<()>) -> Fut,
    ) -> Self {
        let ((cancel, c), (out, rx)) = (bounded(1), bounded(1));
        let auth_backend = backend.clone();
        let fut = f(c);
        platform::spawn(async move {
            if let Some(v) = fut.await {
                if is_auth(&v) {
                    push_auth_sink(&auth_sink, auth_backend);
                    wake();
                }
                if out.send(v).await.is_ok() {
                    wake();
                }
            }
        });
        Self(meta, backend, cancel, rx)
    }
    fn bg<Fut: PlatformFut<T>>(
        meta: M,
        ctx: ScheduleCtx<'_>,
        auth_sink: AuthSink,
        is_auth: fn(&T) -> bool,
        f: impl FnOnce(Backend, Option<String>, Receiver<()>) -> Fut + Send + 'static,
    ) -> Self {
        let (b, d, r) = (
            ctx.backend.clone(),
            ctx.directory.map(str::to_owned),
            ctx.reads.clone(),
        );
        Self::spawn(
            meta,
            ctx.backend.clone(),
            ctx.wake.clone(),
            auth_sink,
            is_auth,
            move |c| async move {
                let _p = r.background(&c).await?;
                Some(f(b, d, c).await)
            },
        )
    }
}
fn is_fetch_auth<T>(v: &Fetch<T>) -> bool {
    matches!(v, Fetch::AuthExpired)
}
fn is_read_auth(v: &ReadOut) -> bool {
    matches!(v, ReadOut::AuthExpired)
}
fn is_pre_auth(v: &PreOut) -> bool {
    matches!(v.0, Some(ReadOut::AuthExpired)) || matches!(v.1, Some(Fetch::AuthExpired))
}
fn cancel<T, M>(
    s: &mut Option<Flight<T, M>>,
    auth: &mut Vec<Backend>,
    is_auth: impl FnOnce(&T) -> bool,
) {
    if let Some(f) = s.take() {
        f.2.close();
        if let Ok(v) = f.3.try_recv()
            && is_auth(&v)
        {
            push_auth_expired(auth, f.1);
        }
    }
}
fn ready<T, M>(s: &mut Option<Flight<T, M>>) -> Option<(M, Backend, Option<T>)> {
    let f = s.take()?;
    match f.3.try_recv() {
        Ok(v) => Some((f.0, f.1, Some(v))),
        Err(TryRecvError::Empty) => {
            *s = Some(f);
            None
        }
        Err(TryRecvError::Closed) => Some((f.0, f.1, None)),
    }
}

struct Pre {
    occ: String,
    key: Key,
    act: Act,
    rev: u64,
    epoch: u64,
    doc: UnifiedSchedule,
}
type PreOut = (Option<ReadOut>, Option<Fetch<ScheduleCapability>>);

pub(crate) struct Schedules {
    visible: bool,
    pub(crate) generation: u64,
    view_epoch: u64,
    page_limit: u8,
    pub(crate) project_id: Option<String>,
    pub(crate) rows: Vec<UnifiedSchedule>,
    pub(crate) next: Option<String>,
    pub(super) fresh: HashSet<String>,
    pub(crate) error: bool,
    failed_append: bool,
    pub(crate) selection_error: Option<SelectionError>,
    pub(crate) selected: Option<String>,
    list_flight: Option<Flight<Fetch<ScheduleListPage>, (bool, u8, u64)>>,
    list_owed: bool,
    point_flight: Option<Flight<ReadOut, (String, u64)>>,
    pub(crate) capability: Option<Cap>,
    pub(crate) refusal: Option<ActivationRefusal>,
    cap_flight: Option<Flight<Fetch<ScheduleCapability>, u64>>,
    pre: Option<Flight<PreOut, Pre>>,
    pending_pre: Option<(Pre, Backend, PreOut)>,
    pub(crate) feedback: Option<(String, &'static str)>,
    pub(crate) instructions_open: HashSet<String>,
    pub(crate) diagnostics_open: HashSet<String>,
    pub(crate) diagnostics_info_open: HashSet<String>,
    pub(crate) refusal_info_open: bool,
    pub(crate) activatable_info_open: bool,
    auth_sink: AuthSink,
    auth_expired: Vec<Backend>,
}
impl Default for Schedules {
    fn default() -> Self {
        Self {
            visible: false,
            generation: 0,
            view_epoch: 0,
            page_limit: SCHEDULE_PAGE_LIMIT,
            project_id: None,
            rows: Vec::new(),
            next: None,
            fresh: HashSet::new(),
            error: false,
            failed_append: false,
            selection_error: None,
            selected: None,
            list_flight: None,
            list_owed: false,
            point_flight: None,
            capability: None,
            refusal: None,
            cap_flight: None,
            pre: None,
            pending_pre: None,
            feedback: None,
            instructions_open: HashSet::new(),
            diagnostics_open: HashSet::new(),
            diagnostics_info_open: HashSet::new(),
            refusal_info_open: false,
            activatable_info_open: false,
            auth_sink: AuthSink::default(),
            auth_expired: Vec::new(),
        }
    }
}

impl Schedules {
    pub(crate) fn bind_auth(&mut self, sink: AuthSink) {
        self.auth_sink = sink;
    }
    pub(crate) fn visible(&self) -> bool {
        self.visible
    }
    pub(crate) fn view_epoch(&self) -> u64 {
        self.view_epoch
    }
    pub(crate) fn loading(&self) -> bool {
        self.list_flight.is_some()
    }
    pub(crate) fn is_fresh(&self, id: &str) -> bool {
        self.fresh.contains(id)
    }
    pub(crate) fn feedback_for(&self, id: &str) -> Option<&'static str> {
        self.feedback
            .as_ref()
            .filter(|(t, _)| t == id)
            .map(|(_, k)| *k)
    }
    pub(crate) fn pre_busy(&self, id: &str) -> Option<Act> {
        self.pre
            .as_ref()
            .filter(|f| f.0.key.schedule_id == id)
            .map(|f| f.0.act)
            .or_else(|| {
                self.pending_pre
                    .as_ref()
                    .filter(|(m, _, _)| m.key.schedule_id == id)
                    .map(|(m, _, _)| m.act)
            })
    }
    fn project<'a>(&'a self, ctx: ScheduleCtx<'a>) -> Option<&'a str> {
        ctx.project.or(self.project_id.as_deref())
    }

    pub(crate) fn visible_rows<'a>(
        &'a self,
        holds: &'a ScheduleHolds,
        ctx: ScheduleCtx<'_>,
    ) -> Vec<&'a UnifiedSchedule> {
        let mut out: Vec<_> = self.rows.iter().filter(|d| d.is_schedule()).collect();
        if let Some(p) = self.project(ctx) {
            for h in holds.held_documents(ctx.backend, p, ctx.scope) {
                if h.is_schedule() && !out.iter().any(|d| d.id == h.id) {
                    out.push(h);
                }
            }
        }
        out
    }
    pub(crate) fn selected_document<'a>(
        &'a self,
        holds: &'a ScheduleHolds,
        ctx: ScheduleCtx<'_>,
    ) -> Option<&'a UnifiedSchedule> {
        let id = self.selected.as_deref()?;
        self.visible_rows(holds, ctx)
            .into_iter()
            .find(|d| d.id == id)
    }
    pub(crate) fn hold_for<'a>(
        &self,
        holds: &'a ScheduleHolds,
        ctx: ScheduleCtx<'_>,
        id: &str,
    ) -> Option<(&'a Phase, bool)> {
        holds.get(&Key::new(ctx.backend, self.project(ctx)?, ctx.scope, id))
    }
    pub(crate) fn capable(
        &self,
        doc: &UnifiedSchedule,
        act: Act,
        held: bool,
        en: bool,
        dir: Option<&str>,
    ) -> bool {
        let ok = self.visible
            && en
            && !self.error
            && self.fresh.contains(&doc.id)
            && self.pre_busy(&doc.id).is_none()
            && !held
            && doc.owns_directory(dir)
            && doc.available_actions.contains(&act);
        let cal = doc.configuration.launch.requires_calendar;
        let cap_ok = if cal && act.requires_calendar_check() {
            self.capability == Some(Cap::Available)
                || (act.requires_activation_proof() && self.capability == Some(Cap::Activatable))
        } else {
            true
        };
        ok && cap_ok
    }

    pub(crate) fn show(&mut self, show: bool) {
        if self.visible == show {
            return;
        }
        self.visible = show;
        if !show {
            self.generation = self.generation.wrapping_add(1);
            self.view_epoch = self.view_epoch.wrapping_add(1);
            self.cancel_flights();
        }
    }
    pub(crate) fn suspend(&mut self) {
        self.visible = false;
        self.generation = self.generation.wrapping_add(1);
        self.view_epoch = self.view_epoch.wrapping_add(1);
        self.cancel_flights();
    }
    pub(crate) fn rebind(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.view_epoch = self.view_epoch.wrapping_add(1);
        self.page_limit = SCHEDULE_PAGE_LIMIT;
        self.failed_append = false;
        self.cancel_flights();
        self.fresh.clear();
        self.capability = None;
        self.refusal = None;
        self.instructions_open.clear();
        self.diagnostics_open.clear();
        self.diagnostics_info_open.clear();
        self.refusal_info_open = false;
        self.activatable_info_open = false;
    }
    pub(crate) fn revoke_continuation(&mut self) {
        self.view_epoch = self.view_epoch.wrapping_add(1);
    }
    pub(crate) fn on_transport_lost(&mut self) {
        self.view_epoch = self.view_epoch.wrapping_add(1);
        self.invalidate();
    }
    pub(crate) fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.failed_append = false;
        self.cancel_pre();
        cancel(&mut self.point_flight, &mut self.auth_expired, is_read_auth);
        if self.list_flight.is_some() {
            self.list_owed = true;
        }
        self.fresh.clear();
    }
    pub(crate) fn cancel_pre(&mut self) {
        self.pending_pre = None;
        cancel(&mut self.pre, &mut self.auth_expired, is_pre_auth);
    }
    pub(crate) fn refresh(&mut self, ctx: ScheduleCtx<'_>) {
        if !self.visible {
            return;
        }
        if self
            .list_flight
            .as_ref()
            .is_some_and(|f| f.0.2 == self.generation)
        {
            self.list_owed = true;
        } else {
            self.start_list(false, ctx);
        }
        if self.selected.is_some() {
            self.start_cap(ctx);
        }
    }
    pub(crate) fn select(&mut self, id: String, ctx: ScheduleCtx<'_>) {
        if self.selected.as_deref() == Some(id.as_str()) {
            return;
        }
        self.clear_selection();
        self.selected = Some(id);
        if self.visible {
            self.refresh(ctx);
        }
    }
    pub(crate) fn clear_selection(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.view_epoch = self.view_epoch.wrapping_add(1);
        self.selected = None;
        self.selection_error = None;
        self.feedback = None;
        self.refusal = None;
        self.refusal_info_open = false;
        self.activatable_info_open = false;
        self.cancel_pre();
        cancel(&mut self.point_flight, &mut self.auth_expired, is_read_auth);
    }

    pub(crate) fn handle_gesture(
        &mut self,
        occ: &str,
        g: G,
        holds: &mut ScheduleHolds,
        ctx: ScheduleCtx<'_>,
        en: bool,
    ) -> bool {
        match g {
            G::Select(id) => {
                holds.confirmation = None;
                self.select(id, ctx);
                true
            }
            G::More if self.next.is_some() && !self.loading() && self.visible => {
                self.start_list(true, ctx);
                true
            }
            G::RetryList => {
                if self.loading() || !self.visible {
                    return false;
                }
                if self.error && self.page_limit > 1 {
                    self.page_limit = (self.page_limit / 2).max(1);
                }
                self.error = false;
                if self.failed_append && self.next.is_some() {
                    self.start_list(true, ctx);
                } else {
                    self.failed_append = false;
                    self.refresh(ctx);
                }
                true
            }
            G::ToggleInstructions => {
                let Some(id) = self.selected.as_deref() else {
                    return false;
                };
                if !self.instructions_open.remove(id) {
                    self.instructions_open.insert(id.to_owned());
                }
                true
            }
            G::ToggleDiagnostics => {
                let Some(id) = self.selected.as_deref() else {
                    return false;
                };
                if !self.diagnostics_open.remove(id) {
                    self.diagnostics_open.insert(id.to_owned());
                }
                true
            }
            G::ToggleDiagnosticsInfo => {
                let Some(id) = self.selected.as_deref() else {
                    return false;
                };
                if !self.diagnostics_info_open.remove(id) {
                    self.diagnostics_info_open.insert(id.to_owned());
                }
                true
            }
            G::ToggleRefusalInfo => {
                self.refusal_info_open = !self.refusal_info_open;
                true
            }
            G::ToggleActivatableInfo => {
                self.activatable_info_open = !self.activatable_info_open;
                true
            }
            G::Action(act) => {
                let (Some(doc), Some(p)) = (
                    self.selected_document(holds, ctx).cloned(),
                    self.project(ctx).map(str::to_owned),
                ) else {
                    return false;
                };
                if !self.capable(
                    &doc,
                    act,
                    self.hold_for(holds, ctx, &doc.id).is_some(),
                    en,
                    ctx.directory,
                ) {
                    return false;
                }
                self.feedback = None;
                let key = Key::new(ctx.backend, &p, ctx.scope, &doc.id);
                let cal = !act.requires_confirmation()
                    && act.requires_calendar_check()
                    && doc.configuration.launch.requires_calendar;
                self.start_pre(
                    Pre {
                        occ: occ.into(),
                        key,
                        act,
                        rev: doc.revision,
                        epoch: self.generation,
                        doc,
                    },
                    true,
                    cal,
                    ctx,
                );
                true
            }
            G::Confirm(ok) => {
                let Some(c) = holds.confirmation.take() else {
                    return false;
                };
                if !ok
                    || c.occurrence != occ
                    || !en
                    || !self.visible
                    || c.generation != self.generation
                {
                    return true;
                }
                if let Some(doc) = self.selected_document(holds, ctx).cloned()
                    && doc.id == c.key.schedule_id
                    && self.is_fresh(&doc.id)
                    && doc.revision == c.expected_revision
                    && doc.owns_directory(ctx.directory)
                    && self.hold_for(holds, ctx, &doc.id).is_none()
                {
                    let m = Pre {
                        occ: c.occurrence,
                        key: c.key,
                        act: c.action,
                        rev: c.expected_revision,
                        epoch: self.generation,
                        doc,
                    };
                    if m.act.requires_calendar_check()
                        && m.doc.configuration.launch.requires_calendar
                    {
                        self.start_pre(m, false, true, ctx);
                    } else {
                        self.cancel_pre();
                        self.pending_pre = Some((m, ctx.backend.clone(), (None, None)));
                    }
                }
                true
            }
            G::Reconcile => {
                let (Some(id), Some(p)) = (self.selected.clone(), self.project(ctx)) else {
                    return false;
                };
                if !self.visible {
                    return false;
                }
                let key = Key::new(ctx.backend, p, ctx.scope, &id);
                if holds.get(&key).is_some_and(|(ph, _)| ph.is_publication()) {
                    self.refresh(ctx);
                    return true;
                }
                holds.reconcile(&key, ctx)
            }
            _ => false,
        }
    }

    fn drain_auth_sink(&mut self) -> bool {
        let (pending, _) = take_auth_sink(&self.auth_sink);
        let got = !pending.is_empty();
        for b in pending {
            push_auth_expired(&mut self.auth_expired, b);
        }
        got
    }

    pub(crate) fn poll(&mut self, holds: &mut ScheduleHolds, ctx: ScheduleCtx<'_>) -> bool {
        let mut changed = self.drain_auth_sink();
        if let Some(((append, _limit, epoch), b, res)) = ready(&mut self.list_flight) {
            changed = true;
            let owed = std::mem::take(&mut self.list_owed);
            if matches!(res, Some(Fetch::AuthExpired)) {
                push_auth_expired(&mut self.auth_expired, b);
            } else if epoch == self.generation {
                match res {
                    Some(Fetch::Ready(page)) => {
                        self.failed_append = false;
                        self.accept_page(append, page, holds, ctx);
                    }
                    _ => {
                        self.error = true;
                        self.failed_append = append;
                    }
                }
                if owed && self.visible {
                    self.failed_append = false;
                    self.start_list(false, ctx);
                }
            } else if owed && self.visible {
                self.failed_append = false;
                self.start_list(false, ctx);
            }
        }
        if let Some(((sid, epoch), b, res)) = ready(&mut self.point_flight) {
            changed = true;
            if matches!(res, Some(ReadOut::AuthExpired)) {
                push_auth_expired(&mut self.auth_expired, b);
            } else if epoch == self.generation && self.selected.as_deref() == Some(sid.as_str()) {
                self.finish_point_read(sid, res, holds, ctx);
            }
        }
        if let Some((epoch, b, res)) = ready(&mut self.cap_flight) {
            changed = true;
            if matches!(res, Some(Fetch::AuthExpired)) {
                push_auth_expired(&mut self.auth_expired, b);
            } else if epoch == self.generation {
                match res {
                    Some(Fetch::Ready(cap)) => {
                        self.capability = Some(cap_state(&cap));
                        self.refusal = cap.refusal.clone();
                        if cap.activation_available
                            && self.feedback.as_ref().is_some_and(|(_, k)| {
                                *k == "missions.scheduleList.activationRefused"
                            })
                        {
                            self.feedback = None;
                        }
                    }
                    _ => {
                        self.capability = Some(Cap::Missing);
                        self.refusal = None;
                    }
                }
            }
        }
        if let Some((m, b, res)) = ready(&mut self.pre) {
            changed = true;
            match res {
                Some((Some(ReadOut::AuthExpired), _)) | Some((_, Some(Fetch::AuthExpired))) => {
                    push_auth_expired(&mut self.auth_expired, b);
                }
                Some(r) => self.pending_pre = Some((m, b, r)),
                None => {
                    self.feedback = Some((m.key.schedule_id, "missions.scheduleList.readFailed"))
                }
            }
        }
        changed
    }

    pub(crate) fn commit_pre(
        &mut self,
        holds: &mut ScheduleHolds,
        ctx: ScheduleCtx<'_>,
        en: bool,
        auth_expired: &[Backend],
    ) -> bool {
        let Some((m, b, out)) = self.pending_pre.take() else {
            return false;
        };
        let auth_hit = auth_expired.iter().any(|x| {
            x.client.same_connection(&b.client) || x.client.same_connection(&ctx.backend.client)
        });
        let confirmed_fresh = out.0.is_some()
            || (self.is_fresh(&m.key.schedule_id)
                && self
                    .selected_document(holds, ctx)
                    .is_some_and(|d| d.revision == m.rev && d.owns_directory(ctx.directory)));
        if auth_hit
            || !en
            || !self.visible
            || m.epoch != self.generation
            || self.selected.as_deref() != Some(m.key.schedule_id.as_str())
            || self.hold_for(holds, ctx, &m.key.schedule_id).is_some()
            || !confirmed_fresh
        {
            return true;
        }
        self.finish_pre(m, out, holds, ctx);
        true
    }

    fn finish_point_read(
        &mut self,
        sid: String,
        res: Option<ReadOut>,
        holds: &mut ScheduleHolds,
        ctx: ScheduleCtx<'_>,
    ) {
        match res {
            Some(ReadOut::Ready(r)) => match r.document {
                Some(doc) => {
                    let id = doc.id.clone();
                    if let Some(s) = self.rows.iter_mut().find(|x| x.id == id) {
                        *s = doc.clone();
                    } else {
                        self.rows.push(doc.clone());
                    }
                    if r.pending {
                        self.fresh.remove(&id);
                        self.selection_error = Some(SelectionError::Pending);
                    } else {
                        self.fresh.insert(id);
                        if let Some(p) = self.project(ctx) {
                            holds.mark_published(ctx.backend, p, ctx.scope, &[doc]);
                        }
                        self.selection_error = None;
                    }
                }
                None => {
                    self.rows.retain(|x| x.id != sid);
                    self.fresh.remove(&sid);
                    self.selection_error = None;
                }
            },
            Some(ReadOut::Pending(r)) => {
                self.fresh.remove(&sid);
                self.selection_error = Some(if r.is_some_and(|(id, _)| id == sid) {
                    SelectionError::Pending
                } else {
                    SelectionError::Failed
                });
            }
            Some(ReadOut::AuthExpired) => {
                push_auth_expired(&mut self.auth_expired, ctx.backend.clone())
            }
            _ => {
                self.fresh.remove(&sid);
                self.selection_error = Some(SelectionError::Failed);
            }
        }
    }

    fn finish_pre(
        &mut self,
        mut m: Pre,
        (read, cap): PreOut,
        holds: &mut ScheduleHolds,
        ctx: ScheduleCtx<'_>,
    ) {
        if let Some(out) = read {
            match out {
                ReadOut::AuthExpired => {
                    push_auth_expired(&mut self.auth_expired, ctx.backend.clone());
                    return;
                }
                ReadOut::Ready(r) => {
                    if !self.visible || self.selected.as_deref() != Some(m.key.schedule_id.as_str())
                    {
                        return;
                    }
                    let Some(doc) = r
                        .document
                        .filter(|d| d.id == m.doc.id && d.revision == m.rev)
                    else {
                        self.feedback = Some((m.key.schedule_id, "missions.scheduleList.conflict"));
                        self.refresh(ctx);
                        return;
                    };
                    if let Some(slot) = self.rows.iter_mut().find(|x| x.id == doc.id) {
                        if slot.revision > doc.revision {
                            self.feedback =
                                Some((m.key.schedule_id, "missions.scheduleList.conflict"));
                            return;
                        }
                        *slot = doc.clone();
                    }
                    if !doc.owns_directory(ctx.directory) {
                        self.feedback = Some((m.key.schedule_id, "missions.scheduleList.conflict"));
                        return;
                    }
                    if m.act.requires_confirmation() {
                        holds.confirmation = Some(ScheduleConfirmation {
                            occurrence: m.occ,
                            key: m.key,
                            action: m.act,
                            expected_revision: m.rev,
                            generation: m.epoch,
                            title: doc.configuration.title,
                        });
                        return;
                    }
                    m.doc = doc;
                }
                _ => {
                    self.feedback = Some((m.key.schedule_id, "missions.scheduleList.readFailed"));
                    return;
                }
            }
        }
        if let Some(out) = cap {
            match out {
                Fetch::AuthExpired => {
                    push_auth_expired(&mut self.auth_expired, ctx.backend.clone());
                    return;
                }
                Fetch::Unavailable => {
                    self.feedback = Some((m.key.schedule_id, "missions.scheduleList.readFailed"));
                    return;
                }
                Fetch::Ready(c) => {
                    self.capability = Some(cap_state(&c));
                    self.refusal = c.refusal.clone();
                    if !self.visible || self.selected.as_deref() != Some(m.key.schedule_id.as_str())
                    {
                        return;
                    }
                    if c.refused() {
                        self.feedback =
                            Some((m.key.schedule_id, "missions.scheduleList.activationRefused"));
                        return;
                    }
                    if !c.api_available || (!c.enabled && !c.activation_available) {
                        self.feedback =
                            Some((m.key.schedule_id, "missions.scheduling.capability.missing"));
                        return;
                    }
                    if m.act == Act::RunNow && !c.enabled {
                        self.feedback = Some((
                            m.key.schedule_id,
                            "missions.scheduleList.runNowRequiresEnabled",
                        ));
                        return;
                    }
                    if m.act != Act::RunNow && (!c.enabled || !m.doc.activation_ready()) {
                        if !m.doc.owns_directory(ctx.directory) {
                            return;
                        }
                        if !holds.has_capacity_for(&m.key) {
                            self.feedback =
                                Some((m.key.schedule_id, "missions.scheduleList.capacity"));
                            return;
                        }
                        let (req_id, proof_rev) = match m
                            .doc
                            .schedule_activation
                            .as_ref()
                            .filter(|a| a.state == "ready" && !a.request_id.is_empty())
                        {
                            Some(prev) => (prev.request_id.clone(), prev.expected_revision),
                            None => {
                                let Ok(id) = request_id() else {
                                    self.feedback = Some((
                                        m.key.schedule_id,
                                        "missions.scheduleList.readFailed",
                                    ));
                                    return;
                                };
                                (id, m.rev)
                            }
                        };
                        if !holds.dispatch_activation(
                            m.key.clone(),
                            m.occ,
                            m.act,
                            self.view_epoch,
                            req_id,
                            proof_rev,
                            m.rev,
                            m.doc,
                            ctx,
                        ) {
                            self.feedback =
                                Some((m.key.schedule_id, "missions.scheduleList.readFailed"));
                        }
                        return;
                    }
                }
            }
        }
        if !m.doc.owns_directory(ctx.directory) {
            return;
        }
        self.dispatch_control(m, holds, ctx);
    }

    pub(crate) fn apply_hold_events(&mut self, evs: &[Ev], ctx: ScheduleCtx<'_>) -> bool {
        let Some(p) = self.project(ctx).map(str::to_owned) else {
            return false;
        };
        let (mut changed, mut refresh) = (false, false);
        for ev in evs {
            let key = match ev {
                Ev::Settled(k, _)
                | Ev::Refused(k, _)
                | Ev::ActivationRefused(k, _)
                | Ev::NeedsRefresh(k) => k,
            };
            if !key.matches_scope(ctx.backend, &p, ctx.scope) {
                continue;
            }
            let sel = self.selected.as_deref() == Some(key.schedule_id.as_str());
            match ev {
                Ev::Settled(_, true) if sel => self.clear_selection(),
                Ev::Refused(_, fb) if sel => self.feedback = Some((key.schedule_id.clone(), *fb)),
                Ev::ActivationRefused(_, refusal) if sel => {
                    self.refusal = refusal.clone();
                    self.feedback = Some((
                        key.schedule_id.clone(),
                        "missions.scheduleList.activationRefused",
                    ));
                }
                _ => {}
            }
            refresh = true;
            changed = true;
        }
        if refresh && self.visible {
            self.refresh(ctx);
        }
        changed
    }

    pub(crate) fn drain_auth_expired(&mut self) -> Vec<Backend> {
        self.drain_auth_sink();
        std::mem::take(&mut self.auth_expired)
    }

    fn accept_page(
        &mut self,
        append: bool,
        page: ScheduleListPage,
        holds: &mut ScheduleHolds,
        ctx: ScheduleCtx<'_>,
    ) {
        if self.project(ctx).is_some_and(|e| e != page.project_id) {
            self.error = true;
            return;
        }
        self.project_id = Some(page.project_id.clone());
        self.error = false;
        let published = page.schedules.clone();
        if append {
            for doc in page.schedules {
                self.fresh.insert(doc.id.clone());
                if let Some(slot) = self.rows.iter_mut().find(|r| r.id == doc.id) {
                    *slot = doc;
                } else {
                    self.rows.push(doc);
                }
            }
            self.next = page.next;
        } else {
            let sel = self.selected.clone();
            let prev = sel
                .as_deref()
                .and_then(|id| self.rows.iter().find(|r| r.id == id).cloned());
            let prev_fresh = sel.as_deref().is_some_and(|id| self.fresh.contains(id));
            let in_page = sel
                .as_deref()
                .is_some_and(|id| page.schedules.iter().any(|d| d.id == id));
            self.rows = page.schedules;
            self.fresh = self.rows.iter().map(|d| d.id.clone()).collect();
            self.next = page.next;
            if let Some(id) = sel
                && !in_page
            {
                if let Some(p) = prev {
                    self.rows.push(p);
                    if prev_fresh {
                        self.fresh.insert(id.clone());
                    }
                }
                cancel(&mut self.point_flight, &mut self.auth_expired, is_read_auth);
                let mid = id.clone();
                self.point_flight = Some(Flight::bg(
                    (id, self.generation),
                    ctx,
                    self.auth_sink.clone(),
                    is_read_auth,
                    move |b, d, c| async move {
                        b.mission_schedule_read(&mid, d.as_deref(), None, &c).await
                    },
                ));
            } else {
                self.selection_error = None;
            }
        }
        holds.mark_published(ctx.backend, &page.project_id, ctx.scope, &published);
    }

    fn start_list(&mut self, append: bool, ctx: ScheduleCtx<'_>) {
        self.start_list_limit(append, self.page_limit, ctx);
    }
    fn start_list_limit(&mut self, append: bool, limit: u8, ctx: ScheduleCtx<'_>) {
        let after = append.then(|| self.next.clone()).flatten();
        if append && after.is_none() {
            return;
        }
        let lim = limit.clamp(1, SCHEDULE_PAGE_LIMIT);
        cancel(&mut self.list_flight, &mut self.auth_expired, is_fetch_auth);
        self.list_flight = Some(Flight::bg(
            (append, lim, self.generation),
            ctx,
            self.auth_sink.clone(),
            is_fetch_auth,
            move |b, d, c| async move {
                b.mission_schedules_page(after.as_deref(), lim, d.as_deref(), &c)
                    .await
            },
        ));
    }
    fn start_cap(&mut self, ctx: ScheduleCtx<'_>) {
        cancel(&mut self.cap_flight, &mut self.auth_expired, is_fetch_auth);
        self.cap_flight = Some(Flight::bg(
            self.generation,
            ctx,
            self.auth_sink.clone(),
            is_fetch_auth,
            move |b, d, c| async move { b.mission_schedule_capability(d.as_deref(), &c).await },
        ));
    }
    fn start_pre(&mut self, m: Pre, do_read: bool, do_cap: bool, ctx: ScheduleCtx<'_>) {
        self.cancel_pre();
        let (b, mid, d, rev) = (
            ctx.backend.clone(),
            m.key.schedule_id.clone(),
            ctx.directory.map(str::to_owned),
            m.rev,
        );
        self.pre = Some(Flight::spawn(
            m,
            ctx.backend.clone(),
            ctx.wake.clone(),
            self.auth_sink.clone(),
            is_pre_auth,
            move |c| async move {
                let read = if do_read {
                    Some(b.mission_schedule_read(&mid, d.as_deref(), None, &c).await)
                } else {
                    None
                };
                let ok = read.as_ref().is_none_or(|r| {
                    matches!(r, ReadOut::Ready(rd) if rd.document.as_ref().is_some_and(|x| x.id == mid && x.revision == rev))
                });
                let cap = if do_cap && ok {
                    Some(b.mission_schedule_capability(d.as_deref(), &c).await)
                } else {
                    None
                };
                Some((read, cap))
            },
        ));
    }
    fn dispatch_control(&mut self, m: Pre, holds: &mut ScheduleHolds, ctx: ScheduleCtx<'_>) {
        if !holds.has_capacity_for(&m.key) {
            self.feedback = Some((m.key.schedule_id, "missions.scheduleList.capacity"));
            return;
        }
        let Ok(req) = ScheduleControlRequest::new(m.act, m.rev, ctx.directory.map(str::to_owned))
        else {
            self.feedback = Some((m.key.schedule_id, "missions.scheduleList.readFailed"));
            return;
        };
        holds.dispatch_control(m.key, m.occ, self.view_epoch, req, m.doc, ctx);
    }
    fn cancel_flights(&mut self) {
        cancel(&mut self.list_flight, &mut self.auth_expired, is_fetch_auth);
        self.list_owed = false;
        cancel(&mut self.point_flight, &mut self.auth_expired, is_read_auth);
        cancel(&mut self.cap_flight, &mut self.auth_expired, is_fetch_auth);
        self.cancel_pre();
    }
}
fn cap_state(c: &ScheduleCapability) -> Cap {
    if c.ready() {
        Cap::Available
    } else if c.activatable() {
        Cap::Activatable
    } else if c.refused() {
        Cap::Refused
    } else {
        Cap::Missing
    }
}
impl Drop for Schedules {
    fn drop(&mut self) {
        self.cancel_flights();
    }
}
