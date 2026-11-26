//! Location-scoped Subagent depth state machine matching `mission-subagent-depth.tsx`.
use crate::{platform, settings::providers::Target};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::missions::{
        SubagentDepthError, SubagentDepthSnapshot, read_subagent_depth,
        resolve_workspace_directory, set_subagent_depth,
    },
};

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

#[derive(Default)]
pub(super) struct State {
    scope: Option<(String, Option<String>)>,
    authority: u64,
    seen_revision: Option<u64>,
    read_started_revision: Option<u64>,
    manual_epoch: u64,
    pub(super) phase: Phase,
    pub(super) snapshot: Option<SubagentDepthSnapshot>,
    pub(super) draft: String,
    dirty: bool,
    pub(super) error: bool,
    pub(super) saved: bool,
    queued: Option<(String, String)>,
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
        self.suspend();
        if self.phase == Phase::Saving || self.save_flight.is_some() {
            self.save_flight = None;
            self.pending_save = false;
            self.queued = None;
            self.phase = Phase::Uncertain;
        } else if self.phase == Phase::Unsupported {
            self.phase = Phase::Idle;
        }
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
        self.save_flight.is_some() || self.pending_save
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        self.save_flight.is_some() || self.pending_save || self.phase == Phase::Uncertain
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
            .map_or_else(|| self.saved_value(), |(value, _)| value.as_str())
    }

    fn locked(&self) -> bool {
        self.busy() || self.pending_save
    }

    pub(super) fn disabled(&self, active: bool, has_target: bool) -> bool {
        !active
            || !has_target
            || matches!(self.phase, Phase::Uncertain | Phase::Unsupported)
            || self.error
            || self
                .snapshot
                .as_ref()
                .is_none_or(|s| s.capability.is_none() || s.project.is_none())
    }

    pub(super) fn choose(&mut self, value: String, active: bool, has_target: bool) {
        if self.disabled(active, has_target) || value == "masked" {
            return;
        }
        if !self.locked() && value == self.saved_value() {
            self.queued = None;
            return;
        }
        if self.locked() {
            let base = self
                .queued
                .as_ref()
                .map_or_else(|| self.draft.clone(), |(_, base)| base.clone());
            self.queued = Some((value, base));
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

    pub(super) fn poll(
        &mut self,
        target: Option<&Target>,
        transport_lost: bool,
        active: bool,
        wake: &rune::Waker,
    ) -> bool {
        let (mut changed, _) = self.poll_save_only(transport_lost);
        let Some(target) = target else {
            // Preserve scope, snapshot, and Uncertain state when the panel closes with no target.
            if self.read_flight.is_some() || self.seen_revision.is_some() {
                self.suspend();
                changed = true;
            }
            return changed;
        };

        let (backend, workspace, authority, _) = target.stats_source();
        let (_, session) = target.location();
        let scope = (workspace.to_owned(), session.map(str::to_owned));
        if self.scope.as_ref() != Some(&scope) {
            *self = Self {
                scope: Some(scope),
                authority,
                ..Self::default()
            };
            changed = true;
        } else if self.authority != authority {
            self.authority = authority;
            self.seen_revision = None;
            if self.phase == Phase::Saving {
                self.save_flight = None;
                self.pending_save = false;
                self.queued = None;
                self.phase = Phase::Uncertain;
            } else if self.phase == Phase::Reading {
                self.suspend();
            } else if self.phase == Phase::Unsupported {
                self.phase = Phase::Idle;
            }
            changed = true;
        }

        if transport_lost || !target.online() {
            if self.phase == Phase::Saving {
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

        let revision = target.revision().wrapping_add(self.manual_epoch);
        if let Some(result) = self
            .read_flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.read_flight = None;
            let started = self.read_started_revision.take();
            if started != Some(revision) {
                self.phase = if self.snapshot.is_some() {
                    Phase::Ready
                } else {
                    Phase::Idle
                };
                self.seen_revision = None;
            } else {
                match result {
                    Ok(snapshot) => {
                        let fresh = snapshot
                            .project
                            .as_ref()
                            .and_then(|p| p.depth)
                            .map_or_else(String::new, |d| d.to_string());
                        let queued = self.queued.take().filter(|(_, base)| *base == fresh);
                        self.snapshot = Some(snapshot);
                        self.draft = fresh;
                        self.dirty = false;
                        self.error = false;
                        self.phase = Phase::Ready;
                        if let Some((next_value, _)) = queued
                            && next_value != self.saved_value()
                        {
                            self.draft = next_value;
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
            if let Some(snapshot) = &self.snapshot
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
                        let result = set_subagent_depth(
                            &backend,
                            &workspace,
                            &directory,
                            depth,
                            &expectation,
                        )
                        .await;
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
            let session = session.map(str::to_owned);
            let wake = wake.clone();
            self.seen_revision = Some(revision);
            self.read_started_revision = Some(revision);
            self.phase = Phase::Reading;
            self.error = false;
            self.read_flight = Some((cancel, inbox));
            platform::spawn(async move {
                let task = async {
                    let directory =
                        resolve_workspace_directory(&backend, &workspace, session.as_deref())
                            .await?;
                    read_subagent_depth(&backend, &workspace, &directory).await
                };
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
