use super::{
    Target,
    write_barrier::{self, Domain},
};
use crate::{backend::Backend, platform};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::images::{self, Mutation, Snapshot},
};
use rune::Waker;

mod view;
pub(super) use view::view;

type ScopeKey = (String, String, Option<String>);

#[derive(Clone)]
struct LiveTarget {
    backend: Backend,
    workspace: String,
    wake: Waker,
}

enum ReadOutcome {
    Snapshot(Snapshot),
    Unsupported,
    Failed,
}

pub(super) struct Images {
    observer: u64,
    expanded: bool,
    scope_id: Option<ScopeKey>,
    authority: u64,
    seen: Option<u64>,
    seen_location: Option<u64>,
    live: Option<LiveTarget>,
    read_flight: Option<(Sender<()>, Receiver<ReadOutcome>)>,
    write_active: bool,
    seen_settled_id: Option<u64>,
    trailing: bool,
    keep_error: bool,
    stale_after_write: bool,
    snapshot: Option<Snapshot>,
    unsupported: bool,
    error: bool,
    generation_picker_open: bool,
    generation_info_open: bool,
    storage_info_open: bool,
}

impl Default for Images {
    fn default() -> Self {
        Self {
            observer: write_barrier::next_observer(),
            expanded: false,
            scope_id: None,
            authority: 0,
            seen: None,
            seen_location: None,
            live: None,
            read_flight: None,
            write_active: false,
            seen_settled_id: None,
            trailing: false,
            keep_error: false,
            stale_after_write: false,
            snapshot: None,
            unsupported: false,
            error: false,
            generation_picker_open: false,
            generation_info_open: false,
            storage_info_open: false,
        }
    }
}

impl Images {
    pub fn toggle(&mut self) {
        self.expanded = !self.expanded;
        self.generation_picker_open = false;
        if !self.expanded {
            self.reset_read_state();
        }
        if let Some(live) = &self.live {
            (live.wake)();
        }
    }

    pub fn suspend(&mut self) -> bool {
        let changed = self.live.is_some()
            || self.write_active
            || self.seen_settled_id.is_some()
            || self.scope_id.is_some()
            || self.read_flight.is_some()
            || self.snapshot.is_some()
            || self.unsupported
            || self.error
            || self.generation_picker_open;
        self.live = None;
        self.write_active = false;
        self.seen_settled_id = None;
        self.reset_read_state();
        changed
    }

    fn reset_read_state(&mut self) {
        self.scope_id = None;
        self.authority = 0;
        self.seen = None;
        self.seen_location = None;
        self.read_flight = None;
        self.trailing = false;
        self.keep_error = false;
        self.stale_after_write = false;
        self.snapshot = None;
        self.unsupported = false;
        self.error = false;
        self.generation_picker_open = false;
    }

    pub fn poll(&mut self, target: Option<&Target>, wake: Option<&Waker>) -> bool {
        let Some((target, wake)) = target.zip(wake).filter(|(target, _)| target.online()) else {
            let changed = self.snapshot.is_some()
                || self.unsupported
                || self.read_flight.is_some()
                || self.error
                || self.write_active;
            self.live = None;
            self.write_active = false;
            self.seen_settled_id = None;
            self.reset_read_state();
            return changed;
        };

        let next_live = LiveTarget {
            backend: target.backend.clone(),
            workspace: target.workspace.clone(),
            wake: wake.clone(),
        };
        let mut changed = false;
        let obs = write_barrier::observe(
            Domain::Images,
            &target.backend.base,
            &target.workspace,
            self.observer,
            self.expanded,
            wake,
        );

        if !self.expanded {
            let had_data = self.snapshot.is_some()
                || self.unsupported
                || self.read_flight.is_some()
                || self.error
                || self.write_active != obs.active;
            self.live = Some(next_live);
            self.write_active = obs.active;
            self.seen_settled_id = None;
            if had_data {
                self.reset_read_state();
                changed = true;
            }
            return changed;
        }

        let scope_changed = self
            .scope_id
            .as_ref()
            .is_none_or(|(client, workspace, session)| {
                client != &target.backend.client_id
                    || workspace != &target.workspace
                    || session != &target.session
            })
            || self.authority != target.provider_authority();
        if scope_changed {
            self.reset_read_state();
            self.scope_id = Some((
                target.backend.client_id.clone(),
                target.workspace.clone(),
                target.session.clone(),
            ));
            self.authority = target.provider_authority();
            self.seen_location = Some(target.location_epoch());
            self.seen_settled_id = Some(obs.settled_id);
            changed = true;
        }
        self.live = Some(next_live);

        let target_location = target.location_epoch();
        if self.seen_location != Some(target_location) {
            self.seen_location = Some(target_location);
            if self.snapshot.is_some() {
                self.stale_after_write = true;
            }
            self.read_flight = None;
            self.trailing = true;
            self.generation_picker_open = false;
            changed = true;
        }

        if obs.active {
            if !self.write_active {
                self.write_active = true;
                changed = true;
            }
            if self.read_flight.take().is_some() {
                changed = true;
            }
            self.trailing = true;
        } else {
            let was_writing = std::mem::take(&mut self.write_active);
            let newly_settled = obs.settled_id != 0
                && self
                    .seen_settled_id
                    .is_some_and(|seen| seen != obs.settled_id);
            if was_writing || newly_settled {
                self.seen_settled_id = Some(obs.settled_id);
                self.stale_after_write = true;
                self.read_flight = None;
                self.trailing = true;
                changed = true;
            }
            if obs.unseen_error {
                self.keep_error = true;
                self.error = true;
                changed = true;
            }
        }

        let target_rev = target.revision();
        if self.seen != Some(target_rev) {
            self.seen = Some(target_rev);
            self.trailing = true;
        }

        if let Some((_, rx)) = &self.read_flight {
            match rx.try_recv() {
                Ok(outcome) => {
                    self.read_flight = None;
                    if !self.trailing && !self.write_active {
                        match outcome {
                            ReadOutcome::Snapshot(snapshot) => {
                                self.snapshot = Some(snapshot);
                                self.unsupported = false;
                                self.stale_after_write = false;
                                self.error = self.keep_error;
                            }
                            ReadOutcome::Unsupported => {
                                self.snapshot = None;
                                self.unsupported = true;
                                self.stale_after_write = false;
                                self.error = self.keep_error;
                            }
                            ReadOutcome::Failed => self.error = true,
                        }
                        self.keep_error = false;
                    }
                    changed = true;
                }
                Err(_) if rx.is_closed() => {
                    self.read_flight = None;
                    if !self.trailing && !self.write_active {
                        self.error = true;
                        self.keep_error = false;
                    }
                    changed = true;
                }
                Err(_) => {}
            }
        }

        if self.trailing && self.read_flight.is_none() && !self.write_active {
            self.trailing = false;
            self.spawn_read(target, wake);
            changed = true;
        }
        changed
    }

    fn busy(&self) -> bool {
        self.read_flight.is_some() || self.write_active
    }

    fn mutations_disabled(&self) -> bool {
        self.write_active || self.stale_after_write
    }

    fn request_refresh(&mut self) {
        let Some(live) = &self.live else {
            return;
        };
        if self.busy() {
            return;
        }
        write_barrier::clear_unseen_error(Domain::Images, &live.backend.base, &live.workspace);
        self.keep_error = false;
        self.error = false;
        self.trailing = true;
        (live.wake)();
    }

    fn spawn_read(&mut self, target: &Target, wake: &Waker) {
        let (cancel, cancelled) = bounded(1);
        let (out, rx) = bounded(1);
        self.read_flight = Some((cancel, rx));
        let (backend, workspace, session, wake) = (
            target.backend.clone(),
            target.workspace.clone(),
            target.session.clone(),
            wake.clone(),
        );
        platform::spawn(async move {
            let Some(result) = platform::reads::cancellable(
                &cancelled,
                images::load(&backend, &workspace, session.as_deref()),
            )
            .await
            else {
                return;
            };
            let outcome = match result {
                Ok(Some(snapshot)) => ReadOutcome::Snapshot(snapshot),
                Ok(None) => ReadOutcome::Unsupported,
                Err(_) => ReadOutcome::Failed,
            };
            if out.send(outcome).await.is_ok() {
                wake();
            }
        });
    }

    fn save(&mut self, mutation: Mutation) {
        if self.mutations_disabled() {
            return;
        }
        let Some(live) = self.live.clone() else {
            return;
        };
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        if snapshot.blocked_by.is_some() {
            return;
        }
        let directory = snapshot.directory.clone();
        let Some(guard) = write_barrier::try_begin(
            Domain::Images,
            &live.backend.base,
            &live.workspace,
            self.observer,
            live.wake.clone(),
        ) else {
            self.write_active = true;
            return;
        };
        self.read_flight = None;
        self.trailing = false;
        self.keep_error = false;
        self.error = false;
        self.generation_picker_open = false;
        self.write_active = true;
        platform::spawn(async move {
            let ok = images::save(&live.backend, &live.workspace, &directory, &mutation)
                .await
                .is_ok();
            guard.finish(ok);
        });
    }

    #[cfg(test)]
    pub(super) fn is_expanded(&self) -> bool {
        self.expanded
    }

    #[cfg(test)]
    pub(super) fn has_snapshot(&self) -> bool {
        self.snapshot.is_some()
    }

    #[cfg(test)]
    pub(super) fn is_unsupported(&self) -> bool {
        self.unsupported
    }

    #[cfg(test)]
    pub(super) fn is_idle(&self) -> bool {
        !self.busy() && !self.trailing
    }

    #[cfg(test)]
    pub(super) fn is_blocked(&self) -> bool {
        self.snapshot
            .as_ref()
            .is_some_and(|snap| snap.blocked_by.is_some())
    }
}
