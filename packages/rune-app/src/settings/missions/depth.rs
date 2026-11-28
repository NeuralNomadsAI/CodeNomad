//! Location-scoped Subagent depth state machine matching `mission-subagent-depth.tsx`.
use super::SendAuthority;
#[cfg(test)]
use super::shared::PostAttestGate;
use crate::{
    backend::Backend,
    platform,
    settings::{ServerOwner, providers::Target},
};
use codenomad_client::{
    Receiver, Sender, bounded, same_server_path,
    settings::missions::{
        SubagentDepthError, SubagentDepthSnapshot, read_subagent_depth, set_subagent_depth_checked,
    },
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

struct QueuedChoice {
    value: String,
    base: String,
    directory: String,
    authority: u64,
}

#[derive(Clone)]
struct QueuedTarget {
    backend: Backend,
    workspace: String,
    session: Option<String>,
    directory: String,
    authority: u64,
    revision: u64,
    location_revision: Option<u64>,
    expected_location_token: u64,
    expected_prefs_authority: u64,
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

fn snapshot_display_value(snapshot: Option<&SubagentDepthSnapshot>) -> String {
    let fresh = confirmed_depth_value(snapshot);
    if fresh.is_empty()
        && snapshot
            .and_then(|s| s.project.as_ref())
            .is_some_and(|p| p.empty_experimental)
    {
        "masked".to_owned()
    } else {
        fresh
    }
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

const MAX_UNCERTAIN_LOCATIONS: usize = 64;

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
    save_target: Option<QueuedTarget>,
    read_target: Option<QueuedTarget>,
    ready_target: Option<QueuedTarget>,
    background_read: bool,
    read_flight: Option<ReadFlight>,
    save_flight: Option<SaveFlight>,
    pending_save: bool,
    uncertain_locations: Vec<(String, String)>,
    recovering_uncertain: Option<(String, String)>,
}

impl State {
    fn current_location(&self) -> Option<(String, String)> {
        if let Some(target) = &self.save_target {
            return Some((target.workspace.clone(), target.directory.clone()));
        }
        let workspace = self.scope.as_ref().map(|(w, _)| w.as_str())?;
        let directory = self
            .snapshot
            .as_ref()
            .map(|s| s.directory.as_str())
            .or(self.opener_directory.as_deref())?;
        Some((workspace.to_owned(), directory.to_owned()))
    }

    fn record_uncertain_location(&mut self, workspace: &str, directory: &str) {
        if self
            .uncertain_locations
            .iter()
            .any(|(w, d)| w == workspace && same_server_path(d, directory))
        {
            return;
        }
        if self.uncertain_locations.len() >= MAX_UNCERTAIN_LOCATIONS {
            self.uncertain_locations.remove(0);
        }
        self.uncertain_locations
            .push((workspace.to_owned(), directory.to_owned()));
    }

    fn enter_uncertain(&mut self) {
        if let Some((workspace, directory)) = self.current_location() {
            self.record_uncertain_location(&workspace, &directory);
        }
        self.recovering_uncertain = None;
        self.phase = Phase::Uncertain;
    }

    fn is_uncertain_location(&self, workspace: &str, directory: &str) -> bool {
        self.uncertain_locations
            .iter()
            .any(|(w, d)| w == workspace && same_server_path(d, directory))
    }

    fn clear_uncertain_location(&mut self, workspace: &str, directory: &str) {
        self.uncertain_locations
            .retain(|(w, d)| !(w == workspace && same_server_path(d, directory)));
    }

    pub(super) fn rebind(&mut self, same_address: bool) {
        if !same_address {
            *self = Self::default();
            return;
        }
        self.invalidate_location();
    }

    pub(super) fn invalidate_location(&mut self) -> bool {
        let had_pending_choice = self.pending_save || self.queued.is_some() || self.background_read;
        let enter_uncertain =
            self.phase == Phase::Saving || self.save_flight.is_some() || had_pending_choice;
        if enter_uncertain {
            self.enter_uncertain();
        }
        let mut changed = self.resolved_authority.take().is_some()
            | self.read_location_revision.take().is_some()
            | self.read_started_location_revision.take().is_some()
            | self.queued.take().is_some()
            | self.save_target.take().is_some()
            | self.read_target.take().is_some()
            | self.ready_target.take().is_some()
            | std::mem::take(&mut self.background_read)
            | std::mem::take(&mut self.pending_save)
            | std::mem::take(&mut self.dirty)
            | self.read_flight.take().is_some()
            | self.read_started_revision.take().is_some()
            | self.seen_revision.take().is_some()
            | self.recovering_uncertain.take().is_some();
        if enter_uncertain {
            self.save_flight = None;
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
        if self.background_read {
            return;
        }
        if self.phase == Phase::Reading {
            self.phase = if self.snapshot.is_some() {
                Phase::Ready
            } else {
                Phase::Idle
            };
        }
        self.read_flight = None;
        self.read_target = None;
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

    pub(super) fn has_live_work(&self) -> bool {
        self.save_flight.is_some()
            || self.pending_save
            || self.queued.is_some()
            || self.background_read
    }

    #[cfg(test)]
    pub(super) fn save_in_flight(&self) -> bool {
        self.save_flight.is_some()
    }

    pub(super) fn adopt_reopened_authority(&mut self, authority: u64, target_revision: u64) {
        let revision = target_revision.wrapping_add(self.manual_epoch);
        self.authority = authority;
        if self.resolved_authority.is_some() {
            self.resolved_authority = Some(authority);
        }
        if let Some(queued) = &mut self.queued {
            queued.authority = authority;
        }
        if let Some(target) = &mut self.save_target {
            target.authority = authority;
            target.revision = revision;
        }
        if let Some(target) = &mut self.read_target {
            target.authority = authority;
            target.revision = revision;
        }
        if let Some(target) = &mut self.ready_target {
            target.authority = authority;
            target.revision = revision;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn saving(&self) -> bool {
        self.save_flight.is_some()
            || (self.pending_save && self.save_target.is_some())
            || (self.background_read && self.read_flight.is_some())
            || (self.queued.is_some() && self.save_target.is_some())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        self.save_flight.is_some()
            || self.pending_save
            || self.queued.is_some()
            || self.phase == Phase::Uncertain
            || !self.uncertain_locations.is_empty()
    }

    pub(super) fn request_refresh(&mut self) {
        let recovering = if self.phase == Phase::Uncertain {
            self.current_location()
        } else {
            None
        };
        self.dirty = false;
        self.error = false;
        self.saved = false;
        self.queued = None;
        self.save_target = None;
        self.read_target = None;
        self.ready_target = None;
        self.background_read = false;
        self.pending_save = false;
        self.recovering_uncertain = recovering;
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

    pub(super) fn locked(&self) -> bool {
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
                .map_or_else(|| self.saved_value().to_owned(), |q| q.base.clone());
            self.queued = Some(QueuedChoice {
                value,
                base,
                directory,
                authority: self.authority,
            });
            if self.read_flight.is_some()
                && self.save_target.is_none()
                && let Some(target) = self.read_target.clone()
            {
                self.background_read = true;
                self.save_target = Some(target);
            }
            return;
        }
        self.draft = value;
        self.queued = None;
        self.dirty = true;
        self.saved = false;
        self.save_target = self.ready_target.clone();
        self.pending_save = true;
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_save(
        &mut self,
        backend: &Backend,
        workspace: &str,
        session: Option<&str>,
        directory: &str,
        depth: Option<u64>,
        expectation: &str,
        authority: u64,
        revision: u64,
        prefs_authority: &Arc<AtomicU64>,
        location_token: &Arc<AtomicU64>,
        #[cfg(test)] pre_put_gate: &mut Option<Receiver<()>>,
        #[cfg(test)] post_attest_gate: &mut Option<PostAttestGate>,
        wake: &rune::Waker,
    ) {
        let expected_location = self
            .read_location_revision
            .map(|rev| (workspace.to_owned(), session.map(str::to_owned), rev));
        let send_authority = SendAuthority::capture(
            prefs_authority.clone(),
            None,
            Some(location_token),
            expected_location,
            backend,
            #[cfg(test)]
            pre_put_gate.take(),
            #[cfg(test)]
            post_attest_gate.take(),
        );
        self.save_target = Some(QueuedTarget {
            backend: backend.clone(),
            workspace: workspace.to_owned(),
            session: session.map(str::to_owned),
            directory: directory.to_owned(),
            authority,
            revision,
            location_revision: self.read_location_revision,
            expected_location_token: location_token.load(Ordering::SeqCst),
            expected_prefs_authority: prefs_authority.load(Ordering::SeqCst),
        });
        let (out, inbox) = bounded(1);
        let backend = backend.clone();
        let workspace = workspace.to_owned();
        let directory = directory.to_owned();
        let expectation = expectation.to_owned();
        let wake = wake.clone();
        self.phase = Phase::Saving;
        self.error = false;
        self.saved = false;
        self.save_flight = Some(inbox);
        platform::spawn(async move {
            let result = if !send_authority.authorize_send(&backend).await {
                Err(SubagentDepthError::Failed)
            } else {
                #[cfg(test)]
                send_authority.wait_post_attest().await;
                set_subagent_depth_checked(
                    &backend,
                    &workspace,
                    &directory,
                    depth,
                    &expectation,
                    || send_authority.still_ok(&backend),
                )
                .await
            };
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub(super) fn poll_save_only(&mut self, transport_lost: bool) -> (bool, bool) {
        let mut changed = false;
        let mut settled = false;
        if transport_lost && (self.phase == Phase::Saving || self.save_flight.is_some()) {
            self.enter_uncertain();
            self.save_flight = None;
            self.pending_save = false;
            self.queued = None;
            self.save_target = None;
            self.background_read = false;
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
                    if let Some(project) = self
                        .snapshot
                        .as_mut()
                        .and_then(|snapshot| snapshot.project.as_mut())
                    {
                        project.depth = self.draft.parse::<u64>().ok();
                        project.empty_experimental = false;
                    }
                    self.dirty = false;
                    self.error = false;
                    self.saved = true;
                    self.phase = Phase::Ready;
                    self.seen_revision = None;
                    if self.queued.is_none() {
                        self.save_target = None;
                    }
                }
                Err(SubagentDepthError::Unsupported) => {
                    self.draft = confirmed_depth_value(self.snapshot.as_ref());
                    self.dirty = false;
                    self.queued = None;
                    self.save_target = None;
                    self.phase = Phase::Unsupported;
                }
                Err(SubagentDepthError::Conflict | SubagentDepthError::Failed) => {
                    self.enter_uncertain();
                    self.queued = None;
                    self.save_target = None;
                }
            }
            changed = true;
            settled = true;
        }
        (changed, settled)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn poll_background_writes(
        &mut self,
        transport_lost: bool,
        launch_pending: bool,
        prefs_authority: &Arc<AtomicU64>,
        location_token: &Arc<AtomicU64>,
        #[cfg(test)] pre_put_gate: &mut Option<Receiver<()>>,
        #[cfg(test)] post_attest_gate: &mut Option<PostAttestGate>,
        wake: &rune::Waker,
    ) -> (bool, bool) {
        let (mut changed, mut settled) = self.poll_save_only(transport_lost);
        if transport_lost {
            if self.background_read || (launch_pending && self.pending_save) {
                self.enter_uncertain();
                self.background_read = false;
                self.pending_save = false;
                self.dirty = false;
                self.read_flight = None;
                self.read_started_revision = None;
                self.read_started_location_revision = None;
                self.queued = None;
                self.save_target = None;
                changed = true;
                settled = true;
            }
            return (changed, settled);
        }
        if self.background_read
            && let Some(result) = self
                .read_flight
                .as_ref()
                .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.read_flight = None;
            self.read_target = None;
            self.background_read = false;
            let started_rev = self.read_started_revision.take();
            let started_loc_rev = self.read_started_location_revision.take();
            let Some(target) = self.save_target.clone() else {
                self.enter_uncertain();
                self.queued = None;
                return (true, true);
            };
            let (current_loc_rev, upstream_healthy) = target
                .backend
                .client
                .location_state(&target.workspace, target.session.as_deref());
            match result {
                Ok(snapshot)
                    if same_server_path(&snapshot.directory, &target.directory)
                        && started_loc_rev == Some(current_loc_rev)
                        && target.location_revision == Some(current_loc_rev)
                        && upstream_healthy
                        && location_token.load(Ordering::SeqCst)
                            == target.expected_location_token
                        && prefs_authority.load(Ordering::SeqCst)
                            == target.expected_prefs_authority
                        && ServerOwner::backend_verified(&target.backend) =>
                {
                    let fresh = confirmed_depth_value(Some(&snapshot));
                    let display = snapshot_display_value(Some(&snapshot));
                    let queued = self.queued.take().filter(|queued| {
                        queued.authority == target.authority
                            && same_server_path(&queued.directory, &snapshot.directory)
                            && queued.base == display
                            && valid_depth_choice(&snapshot, &queued.value)
                    });
                    self.opener_directory = Some(target.directory.clone());
                    self.resolved_authority = Some(target.authority);
                    self.read_location_revision = Some(current_loc_rev);
                    self.ready_target = Some(target.clone());
                    let next_save = queued.and_then(|q| {
                        if q.value == display {
                            return None;
                        }
                        let (Some(capability), Some(project)) =
                            (&snapshot.capability, &snapshot.project)
                        else {
                            return None;
                        };
                        let parsed = if q.value.is_empty() {
                            Some(None)
                        } else {
                            q.value
                                .parse::<u64>()
                                .ok()
                                .filter(|&d| {
                                    d >= capability.minimum
                                        && capability.maximum.is_none_or(|max| d <= max)
                                })
                                .map(Some)
                        }?;
                        Some((
                            q.value,
                            parsed,
                            snapshot.directory.clone(),
                            project.expectation.clone(),
                        ))
                    });
                    self.snapshot = Some(snapshot);
                    self.draft = fresh;
                    self.dirty = false;
                    self.error = false;
                    if let Some((draft, parsed, directory, expectation)) = next_save {
                        self.draft = draft;
                        self.dirty = true;
                        self.saved = false;
                        self.spawn_save(
                            &target.backend,
                            &target.workspace,
                            target.session.as_deref(),
                            &directory,
                            parsed,
                            &expectation,
                            target.authority,
                            target.revision,
                            prefs_authority,
                            location_token,
                            #[cfg(test)]
                            pre_put_gate,
                            #[cfg(test)]
                            post_attest_gate,
                            wake,
                        );
                    } else {
                        self.save_target = None;
                        self.phase = Phase::Ready;
                        if let Some(rev) = started_rev {
                            self.seen_revision = Some(rev);
                        }
                    }
                }
                _ => {
                    self.enter_uncertain();
                    self.queued = None;
                    self.save_target = None;
                }
            }
            changed = true;
            settled = true;
        }
        if launch_pending
            && self.pending_save
            && self.save_flight.is_none()
            && self.read_flight.is_none()
            && let Some(target) = self.save_target.clone()
        {
            self.pending_save = false;
            let (current_loc_rev, upstream_healthy) = target
                .backend
                .client
                .location_state(&target.workspace, target.session.as_deref());
            if self.resolved_authority != Some(target.authority)
                || self.read_location_revision != Some(current_loc_rev)
                || target.location_revision != Some(current_loc_rev)
                || !upstream_healthy
                || location_token.load(Ordering::SeqCst) != target.expected_location_token
                || prefs_authority.load(Ordering::SeqCst) != target.expected_prefs_authority
                || self
                    .opener_directory
                    .as_deref()
                    .is_none_or(|od| !same_server_path(od, &target.directory))
                || !ServerOwner::backend_verified(&target.backend)
            {
                self.enter_uncertain();
                self.dirty = false;
                self.queued = None;
                self.save_target = None;
                changed = true;
                settled = true;
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
                    let snap_dir = snapshot.directory.clone();
                    let expectation = project.expectation.clone();
                    self.spawn_save(
                        &target.backend,
                        &target.workspace,
                        target.session.as_deref(),
                        &snap_dir,
                        depth,
                        &expectation,
                        target.authority,
                        target.revision,
                        prefs_authority,
                        location_token,
                        #[cfg(test)]
                        pre_put_gate,
                        #[cfg(test)]
                        post_attest_gate,
                        wake,
                    );
                    changed = true;
                } else {
                    self.enter_uncertain();
                    self.dirty = false;
                    self.queued = None;
                    self.save_target = None;
                    changed = true;
                    settled = true;
                }
            } else {
                self.enter_uncertain();
                self.dirty = false;
                self.queued = None;
                self.save_target = None;
                changed = true;
                settled = true;
            }
        }
        if self.save_flight.is_none()
            && self.read_flight.is_none()
            && self.phase == Phase::Ready
            && self.queued.is_some()
            && let Some(target) = self.save_target.clone()
        {
            let (loc_rev, upstream_healthy) = target
                .backend
                .client
                .location_state(&target.workspace, target.session.as_deref());
            if !ServerOwner::backend_verified(&target.backend)
                || target.location_revision != Some(loc_rev)
                || !upstream_healthy
                || location_token.load(Ordering::SeqCst) != target.expected_location_token
                || prefs_authority.load(Ordering::SeqCst) != target.expected_prefs_authority
            {
                self.enter_uncertain();
                self.queued = None;
                self.save_target = None;
                changed = true;
                settled = true;
            } else {
                let (cancel, cancelled) = bounded(1);
                let (out, inbox) = bounded(1);
                let backend = target.backend.clone();
                let workspace = target.workspace.clone();
                let pinned = target.directory.clone();
                let wake = wake.clone();
                self.background_read = true;
                self.read_started_revision = Some(target.revision);
                self.read_started_location_revision = Some(loc_rev);
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
        }
        if self.save_flight.is_none()
            && !self.background_read
            && self.queued.is_none()
            && !self.pending_save
        {
            self.save_target = None;
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
        #[cfg(test)] post_attest_gate: &mut Option<PostAttestGate>,
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
        let (_, session) = target.location();
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
                self.ready_target = None;
                self.suspend();
            } else {
                if self.phase == Phase::Uncertain {
                    self.enter_uncertain();
                }
                let uncertain_locations = std::mem::take(&mut self.uncertain_locations);
                *self = Self {
                    scope: Some(scope),
                    authority,
                    uncertain_locations,
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
            if self.phase == Phase::Uncertain {
                self.enter_uncertain();
            }
            self.suspend();
            self.queued = None;
            self.pending_save = false;
            self.dirty = false;
            self.saved = false;
            self.error = false;
            self.resolved_authority = None;
            self.read_location_revision = None;
            self.ready_target = None;
            self.opener_directory = None;
            self.recovering_uncertain = None;
            self.snapshot = None;
            self.draft.clear();
            self.phase = Phase::Idle;
            changed = true;
        }
        let recovering_here = self
            .recovering_uncertain
            .as_ref()
            .is_some_and(|(w, d)| w == workspace && same_server_path(d, directory));
        if !recovering_here
            && self.phase != Phase::Uncertain
            && self.save_flight.is_none()
            && self.read_flight.is_none()
            && self.is_uncertain_location(workspace, directory)
        {
            self.phase = Phase::Uncertain;
            self.opener_directory = Some(directory.to_owned());
            changed = true;
        }

        if transport_lost || !target.online() {
            if self.phase == Phase::Saving || self.save_flight.is_some() {
                self.enter_uncertain();
                self.save_flight = None;
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
        let current_location_revision = backend.client.location_revision(workspace, session);
        if !self.background_read
            && let Some(result) = self
                .read_flight
                .as_ref()
                .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.read_flight = None;
            let finished_target = self.read_target.take();
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
                    Ok(snapshot) if same_server_path(&snapshot.directory, directory) => {
                        let fresh = confirmed_depth_value(Some(&snapshot));
                        let display = snapshot_display_value(Some(&snapshot));
                        let queued = self.queued.take().filter(|queued| {
                            queued.authority == self.authority
                                && same_server_path(&queued.directory, &snapshot.directory)
                                && queued.base == display
                                && valid_depth_choice(&snapshot, &queued.value)
                        });
                        self.clear_uncertain_location(workspace, &snapshot.directory);
                        self.clear_uncertain_location(workspace, directory);
                        self.recovering_uncertain = None;
                        self.opener_directory = Some(directory.to_owned());
                        self.resolved_authority = Some(authority);
                        self.read_location_revision = Some(current_location_revision);
                        self.ready_target = finished_target;
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
                            self.save_target = self.ready_target.clone();
                            self.pending_save = true;
                        }
                    }
                    Ok(_) => {
                        self.recovering_uncertain = None;
                        self.queued = None;
                        self.error = true;
                        self.phase = if self.is_uncertain_location(workspace, directory) {
                            Phase::Uncertain
                        } else {
                            Phase::Ready
                        };
                    }
                    Err(SubagentDepthError::Unsupported) => {
                        self.clear_uncertain_location(workspace, directory);
                        self.recovering_uncertain = None;
                        self.queued = None;
                        self.error = false;
                        self.phase = Phase::Unsupported;
                    }
                    Err(SubagentDepthError::Conflict | SubagentDepthError::Failed) => {
                        self.recovering_uncertain = None;
                        self.queued = None;
                        self.error = true;
                        self.phase = if self.is_uncertain_location(workspace, directory) {
                            Phase::Uncertain
                        } else {
                            Phase::Ready
                        };
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
                let stale_location = self.read_location_revision != Some(current_location_revision);
                self.dirty = false;
                self.queued = None;
                self.draft = confirmed_depth_value(self.snapshot.as_ref());
                if stale_location {
                    let _ = self.invalidate_location();
                }
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
                    let snap_dir = snapshot.directory.clone();
                    let expectation = project.expectation.clone();
                    self.spawn_save(
                        backend,
                        workspace,
                        session,
                        &snap_dir,
                        depth,
                        &expectation,
                        authority,
                        revision,
                        prefs_authority,
                        location_token,
                        #[cfg(test)]
                        pre_put_gate,
                        #[cfg(test)]
                        post_attest_gate,
                        wake,
                    );
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
            self.read_target = Some(QueuedTarget {
                backend: backend.clone(),
                workspace: workspace.clone(),
                session: session.map(str::to_owned),
                directory: pinned.clone(),
                authority,
                revision,
                location_revision: Some(current_location_revision),
                expected_location_token: location_token.load(Ordering::SeqCst),
                expected_prefs_authority: prefs_authority.load(Ordering::SeqCst),
            });
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
