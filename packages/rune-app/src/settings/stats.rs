pub(super) mod dates;
#[cfg(test)]
mod tests;
mod view;
use super::Preferences;
use super::providers::Target;
use crate::platform;
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::stats::{self, Cached, Proof, Snapshot},
};
use std::time::Duration;
pub(super) use view::view;

const EVENT_DEBOUNCE: f64 = 0.05;
const ACTIVITY_COOLDOWN: f64 = 5.0;

pub(super) fn supported(prefs: &Preferences) -> bool {
    prefs
        .provider_target
        .as_ref()
        .map(|target| target.stats_source().0)
        .or(prefs.backend.as_ref())
        .is_none_or(|backend| backend.client.supports_service_usage())
}

enum Reply {
    Owner(Option<Proof>),
    Cache(Option<Cached>),
    Fresh(Option<Snapshot>),
}

struct Flight {
    cancel: Sender<()>,
    replies: Receiver<Reply>,
    observed: u64,
    fresh: bool,
    rejected: bool,
    proof: Proof,
}

#[derive(Default)]
pub(super) struct Dashboard {
    scope: Option<(String, String)>,
    transport: Option<(String, u64, bool, Option<(bool, Option<u64>)>)>,
    hints: [u64; 2],
    days: Option<u32>,
    explicit: Option<u32>,
    snapshot: Option<Snapshot>,
    flight: Option<Flight>,
    invalidation: u64,
    due: Option<f64>,
    activity_after: f64,
    visible: bool,
    busy: bool,
    failed: bool,
    stale: bool,
    picker: bool,
    help: bool,
    restore: bool,
    zone: Option<String>,
    visibility: dates::Visibility,
}

impl Dashboard {
    fn stop(&mut self) {
        if let Some(request) = self.flight.take() {
            request.cancel.close();
        }
        self.busy = false;
    }

    pub fn suspend(&mut self) {
        self.stop();
        *self = Self::default();
    }

    fn invalidate(&mut self, due: f64) {
        self.invalidation = self.invalidation.wrapping_add(1);
        self.stale = true;
        self.due = Some(self.due.map_or(due, |old| old.min(due)));
    }

    fn select(&mut self, days: u32) {
        if self.days != Some(days) {
            self.stop();
            self.snapshot = None;
            self.explicit = Some(days);
            self.days = Some(days);
            self.restore = true;
            self.invalidate(0.0);
        }
        self.picker = false;
    }

    pub fn poll(
        &mut self,
        target: Option<&Target>,
        active: bool,
        wake: &rune::Waker,
        now: f64,
        tx: &mut rune::Tx,
    ) -> bool {
        let before = self.status();
        let changed = self.update(target, active, wake, now, tx);
        if self.status() != before
            && let Some(key) = self.status()
        {
            rune_theme_codenomad::layout::announce_polite(tx, crate::strings::t(key));
        }
        changed
    }

    fn status(&self) -> Option<&'static str> {
        if self.failed {
            Some("settings.usage.error")
        } else if self.stale && self.snapshot.is_some() {
            Some("settings.usage.cached")
        } else if self.busy && self.snapshot.is_none() {
            Some("settings.usage.loading")
        } else {
            None
        }
    }

    fn update(
        &mut self,
        target: Option<&Target>,
        active: bool,
        wake: &rune::Waker,
        now: f64,
        tx: &mut rune::Tx,
    ) -> bool {
        let Some(target) = target.filter(|_| active) else {
            let changed = self.scope.is_some();
            if changed {
                self.suspend();
            }
            return changed;
        };
        let (backend, workspace, authority, hints) = target.stats_source();
        let scope = (backend.base.clone(), workspace.to_owned());
        let new_scope = self.scope.as_ref() != Some(&scope);
        if new_scope {
            self.suspend();
            self.scope = Some(scope);
            self.restore = true;
        }
        let native = target.stats_status();
        let online = target.online() && native.is_none_or(|(online, _)| online);
        let transport = (backend.client_id.clone(), authority, online, native);
        let changed = self.transport.as_ref() != Some(&transport);
        if changed {
            self.stop();
            self.transport = Some(transport);
            self.restore = true;
            self.invalidate(now + EVENT_DEBOUNCE);
        }
        let visible = self.visibility.visible(wake);
        if !visible || !online {
            let lost = self.visible || self.busy;
            self.visible = false;
            self.stop();
            self.due = None;
            self.stale = true;
            return new_scope || changed || lost;
        }
        if !self.visible {
            self.visible = true;
            self.invalidate(now + EVENT_DEBOUNCE);
        }
        let previous = std::mem::replace(&mut self.hints, hints);
        if previous[0] != hints[0] {
            self.invalidate(if self.busy { 0.0 } else { now + EVENT_DEBOUNCE });
        } else if previous[1] != hints[1] {
            self.invalidate((now + EVENT_DEBOUNCE).max(self.activity_after));
        }
        let mut paint = new_scope || changed || previous != hints;
        while let Some(reply) = self
            .flight
            .as_ref()
            .and_then(|flight| flight.replies.try_recv().ok())
        {
            self.receive(reply, now);
            paint = true;
        }
        if let Some(due) = self.due.filter(|_| !self.busy) {
            if due <= now {
                self.stop();
                self.due = None;
                self.start(backend, workspace, wake);
                paint = true;
            } else {
                tx.wake_after(Duration::from_secs_f64(due - now));
            }
        }
        paint
    }

    fn start(&mut self, backend: &crate::backend::Backend, workspace: &str, wake: &rune::Waker) {
        let (cancel, cancelled) = bounded(1);
        let (out, replies) = bounded(3);
        self.flight = Some(Flight {
            cancel,
            replies,
            observed: self.invalidation,
            fresh: false,
            rejected: false,
            proof: Proof::default(),
        });
        self.busy = true;
        self.failed = false;
        let zone = self.zone.get_or_insert_with(dates::timezone).clone();
        let (days, explicit, to) = (self.days, self.explicit.take(), dates::now());
        let restore = self.restore;
        let restore_period = restore && explicit.is_none();
        for lane in 0..3 {
            if lane == 1 && !restore {
                continue;
            }
            let (out, cancelled, wake) = (out.clone(), cancelled.clone(), wake.clone());
            let (backend, workspace, zone) = (backend.clone(), workspace.to_owned(), zone.clone());
            platform::spawn(async move {
                let reply = platform::reads::cancellable(&cancelled, async {
                    match lane {
                        0 => Reply::Owner(stats::owner(&backend, &workspace).await.ok()),
                        1 => Reply::Cache(
                            stats::cached(&backend, &workspace, &zone, explicit)
                                .await
                                .ok(),
                        ),
                        _ => Reply::Fresh(
                            stats::fresh(
                                &backend,
                                &workspace,
                                &zone,
                                days.unwrap_or(30),
                                to,
                                restore_period || days.is_none(),
                            )
                            .await
                            .ok(),
                        ),
                    }
                })
                .await;
                if let Some(reply) = reply
                    && out.send(reply).await.is_ok()
                {
                    wake();
                }
            });
        }
    }

    fn receive(&mut self, reply: Reply, now: f64) {
        let Some(flight) = self.flight.as_mut() else {
            return;
        };
        let (proof, cache) = match reply {
            Reply::Owner(Some(proof)) => (proof, None),
            Reply::Cache(cache) => {
                self.restore = false;
                let Some(cache) = cache else { return };
                (cache.proof.clone(), Some(cache))
            }
            Reply::Fresh(fresh) => {
                flight.fresh = true;
                self.busy = false;
                self.activity_after = now + ACTIVITY_COOLDOWN;
                if self.due.is_some_and(|due| due > 0.0) {
                    self.due = Some(self.activity_after);
                }
                if let Some(mut fresh) = fresh {
                    if flight.proof.different_owner(&fresh.proof) {
                        self.snapshot = None;
                        flight.rejected = true;
                        self.failed = true;
                        self.stale = true;
                        return;
                    }
                    fresh.proof.adopt_identity(&flight.proof);
                    self.days = Some(fresh.days());
                    self.snapshot = Some(fresh);
                    self.stale = flight.observed != self.invalidation;
                } else {
                    self.failed = true;
                    self.stale = true;
                }
                return;
            }
            _ => return,
        };
        if flight.rejected || flight.fresh && !self.failed {
            if !flight.rejected
                && let Some(snapshot) = self.snapshot.as_mut()
            {
                snapshot.proof.adopt_identity(&proof);
            }
            return;
        }
        if cache.is_some() && flight.proof.different_owner(&proof) {
            return;
        }
        if self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.proof.conflicts(&proof))
        {
            self.snapshot = None;
        }
        if let Some(cache) = cache {
            self.days = Some(cache.days);
            self.snapshot = cache
                .snapshot
                .or_else(|| self.snapshot.take().filter(|s| s.days() == cache.days));
        }
        if flight.proof.conflicts(&proof)
            || flight.proof.identity.is_none()
            || proof.identity.is_some()
        {
            flight.proof = proof;
        }
    }
}
