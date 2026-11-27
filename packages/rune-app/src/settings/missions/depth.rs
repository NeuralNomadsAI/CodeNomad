//! Location-scoped Subagent depth state machine matching `mission-subagent-depth.tsx`.
use super::SendAuthority;
use crate::{
    platform,
    settings::{ServerOwner, providers::Target},
};
use codenomad_client::{
    Receiver, Sender, bounded, same_server_path,
    settings::missions::{
        SubagentDepthError, SubagentDepthSnapshot, read_subagent_depth, set_subagent_depth,
    },
};
use std::sync::{Arc, atomic::AtomicU64};

struct QueuedChoice {
    value: String,
    base: String,
    directory: String,
    authority: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    Idle,
    Reading,
    Ready,
    Saving,
    Uncertain,
    Unsupported,
}

impl Default for Phase {
    fn default() -> Self {
        Self::Idle
    }
}

type ReadFlight = (
    Sender<()>,
    Receiver<Result<SubagentDepthSnapshot, SubagentDepthError>>,
);
type SaveFlight = Receiver<Result<(), SubagentDepthError>>;

fn confirmed_depth_value(snapshot: Option<&SubagentDepthSnapshot>) -> String {
    snapshot
        .and_then(|s| s.project.as_ref())
        .and_then(|p| p.depth)
        .map_or_else(String::new, |d| d.to_string())
}

fn valid_depth_choice(snapshot: &SubagentDepthSnapshot, value: &str) -> bool {
    let (Some(capability), Some(_)) = (&snapshot.capability, &snapshot.project) else {
        return false;
    };
    if value.is_empty() {
        return true;
    }
    value
        .parse::<u64>()
        .ok()
        .is_some_and(|d| d >= capability.minimum && capability.maximum.is_none_or(|max| d <= max))
}

#[derive(Default)]
pub(super) struct State {
    scope: Option<(String, u64)>,
    opener_directory: Option<String>,
    authority: u64,
    resolved_authority: Option<u64>,
    read_location_revision: Option<u64>,
    read_started_location_revision: Option<u64>,
    seen_revision: Option<u64>,
    read_started_revision: Option<u64>,
    manual_epoch: u64,
    pub(super) phase: Phase,
    pub(super) snapshot: Option<SubagentDepthSnapshot>,
    pub(super) draft: String,
    dirty: bool,
    pub(super) error: bool,
    pub(super) saved: bool,
    queued: Option<QueuedChoice>,
    read_flight: Option<ReadFlight>,
    save_flight: Option<SaveFlight>,
    pending_save: bool,
}

impl State {
    pub(super) fn rebind(&mut self, same_address: bool) {
        if !same_address {
            *self = Self::default();
            return;
        }
        self.invalidate_location();
    }

    pub(super) fn invalidate_location(&mut self) -> bool {
        let mut changed = self.resolved_authority.take().is_some()
            | self.read_location_revision.take().is_some()
            | self.read_started_location_revision.take().is_some()
            | self.queued.take().is_some()
            | std::mem::take(&mut self.pending_save)
            | std::mem::take(&mut self.dirty)
            | self.read_flight.take().is_some()
            | self.read_started_revision.take().is_some()
            | self.seen_revision.take().is_some();
        if self.phase == Phase::Saving || self.save_flight.is_some() {
            self.save_flight = None;
            self.phase = Phase::Uncertain;
            changed = true;
        } else if self.phase == Phase::Reading {
            self.phase = if self.snapshot.is_some() {
                Phase::Ready
            } else {
                Phase::Idle
            };
            changed = true;
        } else if self.phase == Phase::Unsupported {
            self.phase = Phase::Idle;
            changed = true;
        }
        changed
    }

    pub(super) fn suspend(&mut self) {
        if self.phase == Phase::Reading {
            self.phase = if self.snapshot.is_some() {
                Phase::Ready
            } else {
                Phase::Idle
            };
        }
        self.read_flight = None;
        self.read_started_revision = None;
        self.read_started_location_revision = None;
        self.seen_revision = None;
    }

    pub(super) fn needs_confirm_refresh(&self) -> bool {
        self.dirty || self.phase == Phase::Uncertain
    }

    pub(super) fn busy(&self) -> bool {
        matches!(self.phase, Phase::Reading | Phase::Saving)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn saving(&self) -> bool {
        self.save_flight.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        self.save_flight.is_some()
            || self.pending_save
            || self.queued.is_some()
            || self.phase == Phase::Uncertain
    }

    pub(super) fn request_refresh(&mut self) {
        self.dirty = false;
        self.error = false;
        self.saved = false;
        self.queued = None;
        self.pending_save = false;
        if self.phase == Phase::Uncertain || self.phase == Phase::Unsupported {
            self.phase = Phase::Idle;
        }
        self.manual_epoch = self.manual_epoch.wrapping_add(1);
        self.seen_revision = None;
    }

    pub(super) fn masked(&self) -> bool {
        self.draft.is_empty()
            && !self.dirty
            && self
                .snapshot
                .as_ref()
                .and_then(|s| s.project.as_ref())
                .is_some_and(|p| p.empty_experimental)
    }

    fn saved_value(&self) -> &str {
        if self.masked() { "masked" } else { &self.draft }
    }

    pub(super) fn selected_value(&self) -> &str {
        self.queued
            .as_ref()
            .map_or_else(|| self.saved_value(), |queued| queued.value.as_str())
    }

    fn locked(&self) -> bool {
        self.busy() || self.pending_save
    }

    pub(super) fn disabled(
        &self,
        active: bool,
        has_target: bool,
        pinned_directory: Option<&str>,
    ) -> bool {
        let Some(directory) = pinned_directory else {
            return true;
        };
        !active
            || !has_target
            || matches!(self.phase, Phase::Uncertain | Phase::Unsupported)
            || self.error
            || self.resolved_authority != Some(self.authority)
            || self
                .opener_directory
                .as_deref()
                .is_none_or(|od| !same_server_path(od, directory))
            || self
                .snapshot
                .as_ref()
                .is_none_or(|s| s.capability.is_none() || s.project.is_none())
    }

    pub(super) fn choose(
        &mut self,
        value: String,
        active: bool,
        has_target: bool,
        pinned_directory: Option<&str>,
    ) {
        if self.disabled(active, has_target, pinned_directory) || value == "masked" {
            return;
        }
        if !self.locked() && value == self.saved_value() {
            self.queued = None;
            return;
        }
        if self.locked() {
            let Some(directory) = self.snapshot.as_ref().map(|s| s.directory.clone()) else {
                return;
            };
            let base = self
                .queued
                .as_ref()
                .filter(|q| {
                    q.authority == self.authority && same_server_path(&q.directory, &directory)
                })
                .map_or_else(|| self.draft.clone(), |q| q.base.clone());
            self.queued = Some(QueuedChoice {
                value,
                base,
                directory,
                authority: self.authority,
            });
            return;
        }
        self.draft = value;
        self.queued = None;
        self.dirty = true;
        self.saved = false;
        self.pending_save = true;
    }

    pub(super) fn poll_save_only(&mut self, transport_lost: bool) -> (bool, bool) {
        let mut changed = false;
        let mut settled = false;
        if transport_lost && (self.phase == Phase::Saving || self.save_flight.is_some()) {
            self.save_flight = None;
            self.pending_save = false;
            self.queued = None;
            self.phase = Phase::Uncertain;
            return (true, true);
        }
        if let Some(result) = self
            .save_flight
            .as_ref()
            .and_then(|inbox| inbox.try_recv().ok())
        {
            self.save_flight = None;
            self.pending_save = false;
            match result {
                Ok(()) => {
                    self.dirty = false;
                    self.error = false;
                    self.saved = true;
                    self.phase = Phase::Ready;
                    self.seen_revision = None;
                }
                Err(SubagentDepthError::Unsupported) => {
                    self.draft = confirmed_depth_value(self.snapshot.as_ref());
                    self.dirty = false;
                    self.queued = None;
                    self.phase = Phase::Unsupported;
                }
                Err(SubagentDepthError::Conflict | SubagentDepthError::Failed) => {
                    self.queued = None;
                    self.phase = Phase::Uncertain;
                }
            }
            changed = true;
            settled = true;
        }
        (changed, settled)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn poll(
        &mut self,
        target: Option<&Target>,
        pinned_directory: Option<&str>,
        location_failed: bool,
        open_epoch: u64,
        transport_lost: bool,
        active: bool,
        prefs_authority: &Arc<AtomicU64>,
        location_token: &Arc<AtomicU64>,
        #[cfg(test)] pre_put_gate: &mut Option<Receiver<()>>,
        wake: &rune::Waker,
    ) -> bool {
        let mut changed = false;
        let Some(target) = target else {
            let (save_changed, _) = self.poll_save_only(transport_lost);
            changed |= save_changed;
            // Preserve scope, snapshot, and Uncertain state when the panel closes with no target.
            if self.read_flight.is_some() || self.seen_revision.is_some() {
                self.suspend();
                changed = true;
            }
            return changed;
        };

        let (backend, workspace, authority, _) = target.stats_source();
        let scope = (workspace.to_owned(), open_epoch);
        let Some(directory) = pinned_directory else {
            if self.scope.as_ref().is_some_and(|(w, _)| w == workspace)
                && self.authority != authority
            {
                self.authority = authority;
                changed |= self.invalidate_location();
            }
            let (save_changed, _) = self.poll_save_only(transport_lost || !target.online());
            changed |= save_changed;
            if location_failed && self.phase != Phase::Uncertain {
                if self.snapshot.take().is_some() {
                    self.opener_directory = None;
                    self.resolved_authority = None;
                    self.draft.clear();
                    changed = true;
                }
                if !self.error {
                    self.error = true;
                    changed = true;
                }
            }
            return changed;
        };

        // Check scope and authority BEFORE consuming any in-flight PUT receipt.
        if self.scope.as_ref() != Some(&scope) {
            let same_checkout = self.scope.as_ref().is_some_and(|(w, _)| w == workspace)
                && self.snapshot.as_ref().is_some_and(|s| {
                    same_server_path(directory, &s.directory)
                        || self
                            .opener_directory
                            .as_deref()
                            .is_some_and(|od| same_server_path(directory, od))
                });
            let keep_same_checkout = same_checkout
                && (self.phase == Phase::Uncertain
                    || self.save_flight.is_some()
                    || self.queued.is_some());
            if keep_same_checkout {
                self.scope = Some(scope);
                self.authority = authority;
                self.resolved_authority = None;
                self.read_location_revision = None;
                self.suspend();
            } else {
                *self = Self {
                    scope: Some(scope),
                    authority,
                    ..Self::default()
                };
            }
            changed = true;
        } else if self.authority != authority {
            self.authority = authority;
            changed |= self.invalidate_location();
        }
        if self
            .opener_directory
            .as_deref()
            .is_some_and(|od| !same_server_path(od, directory))
        {
            self.suspend();
            self.queued = None;
            self.pending_save = false;
            self.dirty = false;
            self.saved = false;
            self.error = false;
            self.resolved_authority = None;
            self.read_location_revision = None;
            self.opener_directory = None;
            if self.phase != Phase::Uncertain {
                self.snapshot = None;
                self.draft.clear();
                self.phase = Phase::Idle;
            }
            changed = true;
        }

        if transport_lost || !target.online() {
            if self.phase == Phase::Saving || self.save_flight.is_some() {
                self.save_flight = None;
                self.phase = Phase::Uncertain;
                self.pending_save = false;
                self.queued = None;
                changed = true;
            }
            if self.read_flight.is_some() || self.seen_revision.is_some() {
                self.suspend();
                changed = true;
            }
            return changed;
        }

        let (save_changed, _) = self.poll_save_only(false);
        changed |= save_changed;

        let revision = target.revision().wrapping_add(self.manual_epoch);
        let current_location_revision = backend.client.location_revision();
        if let Some(result) = self
            .read_flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.read_flight = None;
            let started = self.read_started_revision.take();
            let started_loc_rev = self.read_started_location_revision.take();
            if started != Some(revision) || started_loc_rev != Some(current_location_revision) {
                self.phase = if self.snapshot.is_some() {
                    Phase::Ready
                } else {
                    Phase::Idle
                };
                self.seen_revision = None;
            } else {
                match result {
                    Ok(snapshot) => {
                        let fresh = confirmed_depth_value(Some(&snapshot));
                        let queued = self.queued.take().filter(|queued| {
                            queued.authority == self.authority
                                && same_server_path(&queued.directory, &snapshot.directory)
                                && queued.base == fresh
                                && valid_depth_choice(&snapshot, &queued.value)
                        });
                        self.opener_directory = Some(directory.to_owned());
                        self.resolved_authority = Some(authority);
                        self.read_location_revision = Some(current_location_revision);
                        self.snapshot = Some(snapshot);
                        self.draft = fresh;
                        self.dirty = false;
                        self.error = false;
                        self.phase = Phase::Ready;
                        if let Some(queued) = queued
                            && queued.value != self.saved_value()
                        {
                            self.draft = queued.value;
                            self.dirty = true;
                            self.saved = false;
                            self.pending_save = true;
                        }
                    }
                    Err(SubagentDepthError::Unsupported) => {
                        self.queued = None;
                        self.error = false;
                        self.phase = Phase::Unsupported;
                    }
                    Err(SubagentDepthError::Conflict | SubagentDepthError::Failed) => {
                        self.queued = None;
                        self.error = true;
                        self.phase = Phase::Ready;
                    }
                }
            }
            changed = true;
        }

        if self.pending_save && self.save_flight.is_none() && self.read_flight.is_none() {
            self.pending_save = false;
            if self.resolved_authority != Some(authority)
                || self.read_location_revision != Some(current_location_revision)
                || self
                    .opener_directory
                    .as_deref()
                    .is_none_or(|od| !same_server_path(od, directory))
                || !ServerOwner::backend_verified(backend)
            {
                self.dirty = false;
                self.queued = None;
                self.draft = confirmed_depth_value(self.snapshot.as_ref());
                changed = true;
            } else if let Some(snapshot) = &self.snapshot
                && let (Some(capability), Some(project)) = (&snapshot.capability, &snapshot.project)
            {
                let parsed = if self.draft.is_empty() {
                    Some(None)
                } else {
                    self.draft
                        .parse::<u64>()
                        .ok()
                        .filter(|&d| {
                            d >= capability.minimum && capability.maximum.is_none_or(|max| d <= max)
                        })
                        .map(Some)
                };
                if let Some(depth) = parsed {
                    let send_authority = SendAuthority::capture(
                        prefs_authority.clone(),
                        None,
                        Some(location_token),
                        self.read_location_revision,
                        backend,
                        #[cfg(test)]
                        pre_put_gate.take(),
                    );
                    let (out, inbox) = bounded(1);
                    let backend = backend.clone();
                    let workspace = workspace.to_owned();
                    let directory = snapshot.directory.clone();
                    let expectation = project.expectation.clone();
                    let wake = wake.clone();
                    self.phase = Phase::Saving;
                    self.error = false;
                    self.saved = false;
                    self.save_flight = Some(inbox);
                    platform::spawn(async move {
                        let result = if !send_authority.authorize_send(&backend).await {
                            Err(SubagentDepthError::Failed)
                        } else {
                            set_subagent_depth(
                                &backend,
                                &workspace,
                                &directory,
                                depth,
                                &expectation,
                            )
                            .await
                        };
                        if out.send(result).await.is_ok() {
                            wake();
                        }
                    });
                    changed = true;
                }
            }
        }

        if !active {
            if self.read_flight.is_some() {
                self.suspend();
                changed = true;
            }
            return changed;
        }

        if self.read_flight.is_none()
            && self.save_flight.is_none()
            && self.seen_revision != Some(revision)
            && !self.dirty
            && !matches!(self.phase, Phase::Uncertain | Phase::Unsupported)
        {
            let (cancel, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            let backend = backend.clone();
            let workspace = workspace.to_owned();
            let pinned = directory.to_owned();
            let wake = wake.clone();
            self.seen_revision = Some(revision);
            self.read_started_revision = Some(revision);
            self.read_started_location_revision = Some(current_location_revision);
            self.phase = Phase::Reading;
            self.error = false;
            self.read_flight = Some((cancel, inbox));
            platform::spawn(async move {
                let task = read_subagent_depth(&backend, &workspace, &pinned);
                if let Some(result) = platform::reads::cancellable(&cancelled, task).await
                    && out.send(result).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        changed
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use codenomad_client::settings::missions::{SubagentDepthCapability, SubagentDepthProject};

    fn snap(directory: &str, depth: Option<u64>) -> SubagentDepthSnapshot {
        SubagentDepthSnapshot {
            directory: directory.to_owned(),
            capability: Some(SubagentDepthCapability {
                minimum: 1,
                maximum: Some(10),
                default: Some(2),
            }),
            effective_depth: depth.or(Some(2)),
            nesting: None,
            origin: None,
            project: Some(SubagentDepthProject {
                path: format!("{directory}/opencode.json"),
                depth,
                expectation: "a".repeat(64),
                nesting_skipped: false,
                empty_experimental: false,
            }),
        }
    }

    #[test]
    fn queued_choice_is_dropped_when_directory_changes_and_flush_never_spins_on_pending_save() {
        let mut state = State {
            authority: 7,
            resolved_authority: Some(7),
            opener_directory: Some("/checkout-a".into()),
            phase: Phase::Saving,
            snapshot: Some(snap("/checkout-a", Some(2))),
            draft: "2".into(),
            ..State::default()
        };
        state.choose("4".into(), true, true, Some("/checkout-a"));
        assert!(state.queued.is_some());
        assert!(!state.saving());
        assert!(state.has_unconfirmed());

        // A fresh snapshot for a different checkout directory with the same base depth must drop the queued choice.
        let fresh_b = snap("/checkout-b", Some(2));
        let fresh = fresh_b
            .project
            .as_ref()
            .and_then(|p| p.depth)
            .map_or_else(String::new, |d| d.to_string());
        let accepted = state.queued.take().filter(|queued| {
            queued.authority == state.authority
                && same_server_path(&queued.directory, &fresh_b.directory)
                && queued.base == fresh
        });
        assert!(accepted.is_none());

        // An unsubmitted pending_save reports unconfirmed without blocking flush draining.
        state.phase = Phase::Ready;
        state.choose("3".into(), true, true, Some("/checkout-a"));
        assert!(state.pending_save);
        assert!(!state.saving());
        assert!(state.has_unconfirmed());

        // Invalidating location drops pending writes and blocks new choices until re-resolved.
        assert!(state.invalidate_location());
        assert!(!state.pending_save);
        assert!(state.queued.is_none());
        assert!(state.disabled(true, true, None));
        assert!(state.disabled(true, true, Some("/checkout-a")));
        state.choose("5".into(), true, true, Some("/checkout-a"));
        assert!(!state.pending_save);
    }
}
