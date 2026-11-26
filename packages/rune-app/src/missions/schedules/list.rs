//! Panel-owned bounded schedule pages, off-page point reads, capability probes
//! and pre-dispatch verification.
use super::{
    ScheduleConfirmation, ScheduleGesture as G, ScheduleHoldEvent as Ev, ScheduleHoldKey as Key,
    ScheduleHoldPhase as Phase, ScheduleHolds, push_auth_expired,
};
use crate::platform::{self, reads::Reads};
use codenomad_client::{
    Receiver, Sender, TryRecvError, Wake,
    backend::Backend,
    bounded,
    missions::{
        SCHEDULE_PAGE_LIMIT, ScheduleAction as Act, ScheduleCapability, ScheduleControlRequest,
        ScheduleFetch as Fetch, ScheduleListPage, ScheduleReadOutcome as ReadOut, UnifiedSchedule,
    },
};
use std::collections::HashSet;

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

struct Flight<T, M = ()>(M, Sender<()>, Receiver<T>);
impl<T: Send + 'static, M> Flight<T, M> {
    fn spawn<Fut: PlatformFut<Option<T>>>(
        meta: M,
        wake: Wake,
        f: impl FnOnce(Receiver<()>) -> Fut,
    ) -> Self {
        let ((cancel, c), (out, rx)) = (bounded(1), bounded(1));
        let fut = f(c);
        platform::spawn(async move {
            if let Some(v) = fut.await
                && out.send(v).await.is_ok()
            {
                wake();
            }
        });
        Self(meta, cancel, rx)
    }
    fn bg<Fut: PlatformFut<T>>(
        meta: M,
        ctx: ScheduleCtx<'_>,
        f: impl FnOnce(Backend, Option<String>, Receiver<()>) -> Fut + Send + 'static,
    ) -> Self {
        let (b, d, r) = (
            ctx.backend.clone(),
            ctx.directory.map(str::to_owned),
            ctx.reads.clone(),
        );
        Self::spawn(meta, ctx.wake.clone(), move |c| async move {
            let _p = r.background(&c).await?;
            Some(f(b, d, c).await)
        })
    }
}
fn close<T, M>(s: &mut Option<Flight<T, M>>) {
    if let Some(f) = s.take() {
        f.1.close();
    }
}
fn ready<T, M>(s: &mut Option<Flight<T, M>>) -> Option<(M, Option<T>)> {
    let f = s.take()?;
    match f.2.try_recv() {
        Ok(v) => Some((f.0, Some(v))),
        Err(TryRecvError::Empty) => {
            *s = Some(f);
            None
        }
        Err(TryRecvError::Closed) => Some((f.0, None)),
    }
}

struct Pre {
    occ: String,
    key: Key,
    act: Act,
    rev: u64,
    doc: UnifiedSchedule,
}
type PreOut = (Option<ReadOut>, Option<Fetch<ScheduleCapability>>);

#[derive(Default)]
pub(crate) struct Schedules {
    visible: bool,
    pub(crate) project_id: Option<String>,
    pub(crate) rows: Vec<UnifiedSchedule>,
    pub(crate) next: Option<String>,
    fresh: HashSet<String>,
    pub(crate) error: bool,
    pub(crate) selection_error: Option<SelectionError>,
    pub(crate) selected: Option<String>,
    list_flight: Option<Flight<Fetch<ScheduleListPage>, bool>>,
    list_owed: bool,
    point_flight: Option<Flight<ReadOut, String>>,
    pub(crate) capability: Option<bool>,
    cap_flight: Option<Flight<Fetch<ScheduleCapability>>>,
    pre: Option<Flight<PreOut, Pre>>,
    pub(crate) feedback: Option<(String, &'static str)>,
    pub(crate) instructions_open: HashSet<String>,
    auth_expired: Vec<Backend>,
}

impl Schedules {
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
    pub(crate) fn capable(&self, doc: &UnifiedSchedule, act: Act, held: bool, en: bool) -> bool {
        let ok = self.visible
            && en
            && !self.error
            && self.fresh.contains(&doc.id)
            && self.pre_busy(&doc.id).is_none()
            && !held
            && doc.available_actions.contains(&act);
        ok && (!(doc.configuration.launch.requires_calendar && act.requires_calendar_check())
            || self.capability == Some(true))
    }

    pub(crate) fn show(&mut self, show: bool) {
        if self.visible == show {
            return;
        }
        self.visible = show;
        if !show {
            self.cancel_flights();
        }
    }
    pub(crate) fn suspend(&mut self) {
        self.visible = false;
        self.cancel_flights();
    }
    pub(crate) fn rebind(&mut self) {
        self.cancel_flights();
        self.fresh.clear();
        self.capability = None;
    }
    pub(crate) fn invalidate(&mut self) {
        close(&mut self.pre);
        self.fresh.clear();
    }
    pub(crate) fn refresh(&mut self, ctx: ScheduleCtx<'_>) {
        if !self.visible {
            return;
        }
        if self.list_flight.is_some() {
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
        self.selected = None;
        self.selection_error = None;
        self.feedback = None;
        close(&mut self.pre);
        close(&mut self.point_flight);
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
                self.refresh(ctx);
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
            G::Action(act) => {
                let (Some(doc), Some(p)) = (
                    self.selected_document(holds, ctx).cloned(),
                    self.project(ctx).map(str::to_owned),
                ) else {
                    return false;
                };
                if !self.capable(&doc, act, self.hold_for(holds, ctx, &doc.id).is_some(), en) {
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
                if !ok || c.occurrence != occ || !en || !self.visible {
                    return true;
                }
                if let Some(doc) = self.selected_document(holds, ctx).cloned()
                    && doc.id == c.key.schedule_id
                    && doc.revision == c.expected_revision
                    && self.hold_for(holds, ctx, &doc.id).is_none()
                {
                    let m = Pre {
                        occ: c.occurrence,
                        key: c.key,
                        act: c.action,
                        rev: c.expected_revision,
                        doc,
                    };
                    if m.act.requires_calendar_check()
                        && m.doc.configuration.launch.requires_calendar
                    {
                        self.start_pre(m, false, true, ctx);
                    } else {
                        self.dispatch_control(m, holds, ctx);
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

    pub(crate) fn poll(&mut self, holds: &mut ScheduleHolds, ctx: ScheduleCtx<'_>) -> bool {
        let mut changed = false;
        if let Some((append, res)) = ready(&mut self.list_flight) {
            changed = true;
            let owed = std::mem::take(&mut self.list_owed);
            match res {
                Some(Fetch::Ready(page)) => self.accept_page(append, page, holds, ctx),
                Some(Fetch::AuthExpired) => {
                    push_auth_expired(&mut self.auth_expired, ctx.backend.clone())
                }
                _ => self.error = true,
            }
            if owed && self.visible {
                self.start_list(false, ctx);
            }
        }
        if let Some((sid, res)) = ready(&mut self.point_flight) {
            changed = true;
            if self.selected.as_deref() == Some(sid.as_str()) {
                self.finish_point_read(sid, res, holds, ctx);
            }
        }
        if let Some(((), res)) = ready(&mut self.cap_flight) {
            changed = true;
            match res {
                Some(Fetch::Ready(cap)) => self.capability = Some(cap.ready()),
                Some(Fetch::AuthExpired) => {
                    push_auth_expired(&mut self.auth_expired, ctx.backend.clone())
                }
                _ => self.capability = Some(false),
            }
        }
        if let Some((m, res)) = ready(&mut self.pre) {
            changed = true;
            match res {
                Some(r) => self.finish_pre(m, r, holds, ctx),
                None => {
                    self.feedback = Some((m.key.schedule_id, "missions.scheduleList.readFailed"))
                }
            }
        }
        changed
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
                    if m.act.requires_confirmation() {
                        holds.confirmation = Some(ScheduleConfirmation {
                            occurrence: m.occ,
                            key: m.key,
                            action: m.act,
                            expected_revision: m.rev,
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
                    self.capability = Some(c.ready());
                    if !self.visible || self.selected.as_deref() != Some(m.key.schedule_id.as_str())
                    {
                        return;
                    }
                    if !c.ready() {
                        self.feedback =
                            Some((m.key.schedule_id, "missions.scheduling.capability.missing"));
                        return;
                    }
                }
            }
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
                Ev::Settled(k, _) | Ev::Refused(k, _) | Ev::NeedsRefresh(k) => k,
            };
            if !key.matches_scope(ctx.backend, &p, ctx.scope) {
                continue;
            }
            let sel = self.selected.as_deref() == Some(key.schedule_id.as_str());
            match ev {
                Ev::Settled(_, true) if sel => self.clear_selection(),
                Ev::Refused(_, fb) if sel => self.feedback = Some((key.schedule_id.clone(), *fb)),
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
                close(&mut self.point_flight);
                let mid = id.clone();
                self.point_flight = Some(Flight::bg(id, ctx, move |b, d, c| async move {
                    b.mission_schedule_read(&mid, d.as_deref(), None, &c).await
                }));
            } else {
                self.selection_error = None;
            }
        }
        holds.mark_published(ctx.backend, &page.project_id, ctx.scope, &published);
    }

    fn start_list(&mut self, append: bool, ctx: ScheduleCtx<'_>) {
        let after = append.then(|| self.next.clone()).flatten();
        if append && after.is_none() {
            return;
        }
        self.list_flight = Some(Flight::bg(append, ctx, move |b, d, c| async move {
            b.mission_schedules_page(after.as_deref(), SCHEDULE_PAGE_LIMIT, d.as_deref(), &c)
                .await
        }));
    }
    fn start_cap(&mut self, ctx: ScheduleCtx<'_>) {
        close(&mut self.cap_flight);
        self.cap_flight = Some(Flight::bg((), ctx, move |b, d, c| async move {
            b.mission_schedule_capability(d.as_deref(), &c).await
        }));
    }
    fn start_pre(&mut self, m: Pre, do_read: bool, do_cap: bool, ctx: ScheduleCtx<'_>) {
        close(&mut self.pre);
        let (b, mid, d, rev) = (
            ctx.backend.clone(),
            m.key.schedule_id.clone(),
            ctx.directory.map(str::to_owned),
            m.rev,
        );
        self.pre = Some(Flight::spawn(m, ctx.wake.clone(), move |c| async move {
            let read = if do_read {
                Some(b.mission_schedule_read(&mid, d.as_deref(), None, &c).await)
            } else {
                None
            };
            let ok = read.as_ref().is_none_or(|r| matches!(r, ReadOut::Ready(rd) if rd.document.as_ref().is_some_and(|x| x.id == mid && x.revision == rev)));
            let cap = if do_cap && ok {
                Some(b.mission_schedule_capability(d.as_deref(), &c).await)
            } else {
                None
            };
            Some((read, cap))
        }));
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
        holds.dispatch_control(m.key, m.occ, req, m.doc, ctx);
    }
    fn cancel_flights(&mut self) {
        close(&mut self.list_flight);
        self.list_owed = false;
        close(&mut self.point_flight);
        close(&mut self.cap_flight);
        close(&mut self.pre);
    }
}
impl Drop for Schedules {
    fn drop(&mut self) {
        self.cancel_flights();
    }
}
