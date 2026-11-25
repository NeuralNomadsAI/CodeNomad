use super::Preferences;
use crate::{platform, strings};
use codenomad_client::{Sender, bounded};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::settings) enum CloseOutcome {
    Confirmed,
    Failed(&'static str),
    Draining,
}

pub(super) struct CloseDrain {
    started: Instant,
    last_progress: Instant,
    pub(super) last_revs: Option<(u64, u64, u64)>,
    pub(super) shutdown: bool,
    settled_ops: u32,
    deadline_cancel: Option<Sender<()>>,
}

impl CloseDrain {
    fn new(last_revs: Option<(u64, u64, u64)>, shutdown: bool, settled_ops: u32) -> Self {
        let now = Instant::now();
        Self {
            started: now,
            last_progress: now,
            last_revs,
            shutdown,
            settled_ops,
            deadline_cancel: None,
        }
    }

    pub(super) fn is_expired(&self, stall_budget: Duration, total_budget: Duration) -> bool {
        self.started.elapsed() >= total_budget
            || self.last_progress.elapsed() >= stall_budget
            || self.settled_ops >= 16
    }

    fn arm_deadline(
        &mut self,
        wake: Option<rune::Waker>,
        stall_budget: Duration,
        total_budget: Duration,
    ) {
        self.deadline_cancel = None;
        let Some(wake) = wake else {
            return;
        };
        let remaining = stall_budget
            .saturating_sub(self.last_progress.elapsed())
            .min(total_budget.saturating_sub(self.started.elapsed()));
        let (cancel_tx, cancel_rx) = bounded(1);
        self.deadline_cancel = Some(cancel_tx);
        platform::spawn(async move {
            if tokio::time::timeout(remaining, cancel_rx.recv())
                .await
                .is_err()
            {
                wake();
            }
        });
    }
}

impl Preferences {
    pub(super) fn drain_budgets(&self) -> (Duration, Duration) {
        #[cfg(test)]
        if let Some(budgets) = self.drain_budgets {
            return budgets;
        }
        (
            codenomad_client::http::REQUEST_TIMEOUT * 3 + Duration::from_millis(100),
            codenomad_client::http::REQUEST_TIMEOUT * 6 + Duration::from_millis(100),
        )
    }

    #[cfg(test)]
    pub(super) fn set_drain_budgets(&mut self, stall: Duration, total: Duration) {
        self.drain_budgets = Some((stall, total));
    }

    #[cfg(test)]
    pub(super) fn set_close_drain_settled_ops(&mut self, settled_ops: u32) {
        if let Some(drain) = &mut self.close_drain {
            drain.settled_ops = settled_ops;
        }
    }

    pub(in crate::settings) fn has_unconfirmed(&self) -> bool {
        self.config.has_unconfirmed()
            || self.state.has_unconfirmed()
            || self.server.has_unconfirmed()
    }

    pub(in crate::settings) fn has_close_drain(&self) -> bool {
        self.close_drain.is_some()
    }

    pub(super) fn clear_drain_wake(&self) {
        *self.drain_wake.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub(in crate::settings) fn cancel_close_drain(&mut self) {
        self.close_drain = None;
        self.pending_save_warning = None;
        self.clear_drain_wake();
    }

    pub(in crate::settings) fn abort_close_drain(&mut self) {
        self.close_drain = None;
        self.pending_save_warning = None;
        self.clear_drain_wake();
        self.abandon_unconfirmed();
    }

    fn abandon_unconfirmed(&mut self) {
        self.config.fail_unconfirmed();
        self.state.fail_unconfirmed();
        self.server.fail_unconfirmed();
    }

    pub(in crate::settings) fn take_save_warning(&mut self) -> Option<&'static str> {
        self.pending_save_warning.take()
    }

    #[cfg(test)]
    pub(in crate::settings) fn fixture_save_warning(&mut self, locale: &'static str) {
        self.pending_save_warning = Some(locale);
    }

    pub(in crate::settings) fn attach_close_drain_wake(&mut self, wake: rune::Waker) {
        self.main_wake = Some(wake.clone());
        let (stall_budget, total_budget) = self.drain_budgets();
        if let Some(drain) = &mut self.close_drain {
            *self.drain_wake.lock().unwrap_or_else(|e| e.into_inner()) = Some(wake.clone());
            drain.arm_deadline(Some(wake.clone()), stall_budget, total_budget);
        } else {
            self.clear_drain_wake();
        }
        wake();
    }

    pub(in crate::settings) fn begin_close_drain(&mut self, shutdown: bool) -> CloseOutcome {
        let (stall_budget, total_budget) = self.drain_budgets();
        let already_expired = self
            .close_drain
            .as_ref()
            .is_some_and(|drain| drain.is_expired(stall_budget, total_budget));
        let mut initial_settled = 0u32;
        if self.backend.is_some() && !self.authentication_required {
            self.observe_transport_drops();
            self.take_invalidations();
            // Settle arrived replies first without dispatching new unconfirmed work.
            let (_, _, settled) = self.poll_documents_inner(!shutdown, 0);
            initial_settled = initial_settled.saturating_add(settled);
        }
        if !self.has_unconfirmed() {
            self.close_drain = None;
            self.pending_save_warning = None;
            self.clear_drain_wake();
            return CloseOutcome::Confirmed;
        }
        let used_ops = self
            .close_drain
            .as_ref()
            .map_or(0, |drain| drain.settled_ops)
            .saturating_add(initial_settled);
        let pre_dispatch_expired = already_expired
            || self
                .close_drain
                .as_ref()
                .is_some_and(|drain| drain.is_expired(stall_budget, total_budget))
            || used_ops >= 16;
        if !pre_dispatch_expired && self.backend.is_some() && !self.authentication_required {
            self.prepare_all_drains(true, true);
            if self.documents_draining() {
                let budget =
                    16u32.saturating_sub(used_ops.saturating_add(self.unconfirmed_in_flight()));
                let (_, _, settled_next) = self.poll_documents_inner(!shutdown, budget);
                initial_settled = initial_settled.saturating_add(settled_next);
            }
        }
        if !self.has_unconfirmed() {
            self.close_drain = None;
            self.pending_save_warning = None;
            self.clear_drain_wake();
            return CloseOutcome::Confirmed;
        }
        let expired = pre_dispatch_expired
            || self.close_drain.as_ref().is_some_and(|drain| {
                drain.is_expired(stall_budget, total_budget)
                    || drain.settled_ops.saturating_add(initial_settled) >= 16
            });
        if self.backend.is_none()
            || self.authentication_required
            || !self.documents_draining()
            || expired
        {
            let locale = self.locale().unwrap_or_else(strings::locale);
            self.close_drain = None;
            self.pending_save_warning = None;
            self.clear_drain_wake();
            self.abandon_unconfirmed();
            return CloseOutcome::Failed(locale);
        }
        let revs = self.preferences_revisions();
        let wake = self.main_wake.clone();
        if let Some(drain) = &mut self.close_drain {
            drain.shutdown |= shutdown;
            drain.last_revs = revs;
            drain.settled_ops = drain.settled_ops.saturating_add(initial_settled);
            if initial_settled > 0 {
                drain.last_progress = Instant::now();
            }
            drain.arm_deadline(wake.clone(), stall_budget, total_budget);
        } else {
            let mut drain = CloseDrain::new(revs, shutdown, initial_settled);
            drain.arm_deadline(wake.clone(), stall_budget, total_budget);
            self.close_drain = Some(drain);
        }
        if let Some(wake) = wake {
            wake();
        }
        CloseOutcome::Draining
    }

    pub(super) fn step_close_drain(
        &mut self,
        transport_or_watch: bool,
        rev_changed: bool,
        dropped_mid_poll: bool,
        settled_count: u32,
        was_expired: bool,
    ) -> bool {
        if self.close_drain.is_none() {
            return false;
        }
        if !self.has_unconfirmed() {
            self.close_drain = None;
            self.clear_drain_wake();
            return true;
        }
        let (stall_budget, total_budget) = self.drain_budgets();
        if was_expired {
            let locale = self.locale().unwrap_or_else(strings::locale);
            self.close_drain = None;
            self.clear_drain_wake();
            self.abandon_unconfirmed();
            self.pending_save_warning = Some(locale);
            return true;
        }
        let revs = self.preferences_revisions();
        let mut rearm = false;
        let mut shutdown = false;
        if let Some(drain) = &mut self.close_drain {
            shutdown = drain.shutdown;
            if settled_count > 0 {
                drain.settled_ops = drain.settled_ops.saturating_add(settled_count);
                if !rev_changed && !dropped_mid_poll {
                    drain.last_progress = Instant::now();
                    rearm = true;
                }
            }
            drain.last_revs = revs;
        }
        let expired = self
            .close_drain
            .as_ref()
            .is_some_and(|drain| drain.is_expired(stall_budget, total_budget));
        if !expired {
            if transport_or_watch || rev_changed || dropped_mid_poll || settled_count > 0 {
                self.prepare_all_drains(rev_changed, false);
            }
            if self.documents_draining() {
                let settled_ops = self
                    .close_drain
                    .as_ref()
                    .map_or(0, |drain| drain.settled_ops);
                let budget =
                    16u32.saturating_sub(settled_ops.saturating_add(self.unconfirmed_in_flight()));
                let (_, _, settled_next) = self.poll_documents_inner(!shutdown, budget);
                if settled_next > 0
                    && let Some(drain) = &mut self.close_drain
                {
                    drain.settled_ops = drain.settled_ops.saturating_add(settled_next);
                    if !rev_changed && !dropped_mid_poll {
                        drain.last_progress = Instant::now();
                        rearm = true;
                    }
                }
            }
        }
        if !self.has_unconfirmed() {
            self.close_drain = None;
            self.clear_drain_wake();
            return true;
        }
        let finished_failed = self.backend.is_none()
            || self.authentication_required
            || !self.documents_draining()
            || self
                .close_drain
                .as_ref()
                .is_some_and(|drain| drain.is_expired(stall_budget, total_budget));
        if finished_failed {
            let locale = self.locale().unwrap_or_else(strings::locale);
            self.close_drain = None;
            self.clear_drain_wake();
            self.abandon_unconfirmed();
            self.pending_save_warning = Some(locale);
            return true;
        }
        let wake = self.main_wake.clone();
        if rearm && let Some(drain) = &mut self.close_drain {
            drain.arm_deadline(wake.clone(), stall_budget, total_budget);
        }
        if (transport_or_watch || rev_changed || dropped_mid_poll || settled_count > 0)
            && let Some(wake) = wake
        {
            wake();
        }
        false
    }

    pub(in crate::settings) fn flush_on_quit_warning(&mut self) -> Option<&'static str> {
        match self.begin_close_drain(true) {
            CloseOutcome::Confirmed => return None,
            CloseOutcome::Failed(locale) => return Some(locale),
            CloseOutcome::Draining => {}
        }
        platform::block_on(async {
            while self.has_close_drain() {
                self.poll();
                if self.has_close_drain() {
                    platform::sleep(Duration::from_millis(10)).await;
                }
            }
        });
        if let Some(locale) = self.take_save_warning() {
            return Some(locale);
        }
        if self.has_unconfirmed() {
            let locale = self.locale().unwrap_or_else(strings::locale);
            self.abandon_unconfirmed();
            return Some(locale);
        }
        None
    }

    #[cfg(test)]
    pub(in crate::settings) fn flush_on_quit(&mut self) -> bool {
        self.flush_on_quit_warning().is_none()
    }

    #[cfg(test)]
    pub(super) fn flush(&mut self) -> bool {
        self.flush_on_quit()
    }
}
