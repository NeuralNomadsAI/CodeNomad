use super::{
    cleanup::WorkspaceScope,
    lifecycle::{MissionKey, Source},
    observation::Observation,
};
use crate::platform;
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    missions::{
        ActorState, LifecycleTarget, MapHeader, RecoveryError, RecoveryOutcome, RecoveryRequest,
        RecoveryTarget, RunState, Status,
    },
};
use std::collections::HashMap;

const PENDING_CAPACITY: usize = 64;
const SETTLED_CAPACITY: usize = 128;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct RecoveryKey {
    server: String,
    workspace: String,
    mission: String,
    revision: u64,
    target: RecoveryTarget,
}

impl RecoveryKey {
    pub fn coordinator(source: &Source, revision: u64) -> Self {
        Self {
            server: source.mission.server.clone(),
            workspace: source.workspace.clone(),
            mission: source.mission.id.clone(),
            revision,
            target: RecoveryTarget::Coordinator,
        }
    }
}

enum Attempt {
    Pending {
        scope: WorkspaceScope,
        mission: MissionKey,
        target: LifecycleTarget,
        flight: Receiver<RecoveryOutcome>,
    },
    Admitted(u64),
}

#[derive(Default)]
pub(super) struct Recovery {
    attempts: HashMap<RecoveryKey, Attempt>,
    seq: u64,
    error: Option<(RecoveryKey, RecoveryError)>,
}

pub(super) fn coordinator_eligible(header: &MapHeader, observation: &Observation) -> bool {
    let resuming = header.root.status == Status::Failed;
    if header.root.status != Status::Active && !resuming {
        return false;
    }
    if header.root.run_state.unwrap_or(RunState::Running) != RunState::Running {
        return false;
    }
    if header.control.as_ref().is_some_and(|c| c.pending > 0) {
        return false;
    }
    let coordinator = &header.root.coordinator_session_id;
    if !header.has_coordinator_actor() && !observation.has_actor(coordinator) {
        return false;
    }
    if !resuming {
        observation.interrupted(header)
    } else {
        observation.actor_state(coordinator).is_none_or(|state| {
            matches!(state, ActorState::Unknown | ActorState::IdleWithoutReport)
        })
    }
}

#[derive(Default)]
pub(super) struct RecoveryPolled {
    pub admitted: Vec<(MissionKey, LifecycleTarget, u64)>,
    pub refreshed_scopes: Vec<WorkspaceScope>,
    pub changed: bool,
}

impl Recovery {
    pub fn pending(&self, key: &RecoveryKey) -> bool {
        matches!(self.attempts.get(key), Some(Attempt::Pending { .. }))
    }

    pub fn any_pending_for(&self, source: &Source) -> bool {
        self.attempts.values().any(|attempt| {
            matches!(
                attempt,
                Attempt::Pending { mission, target, .. }
                    if mission == &source.mission && target == &source.target
            )
        })
    }

    pub fn admitted(&self, key: &RecoveryKey) -> bool {
        matches!(self.attempts.get(key), Some(Attempt::Admitted(_)))
    }

    pub fn can_start(&self, key: &RecoveryKey) -> bool {
        !self.attempts.contains_key(key) && self.pending_count() < PENDING_CAPACITY
    }

    fn pending_count(&self) -> usize {
        self.attempts
            .values()
            .filter(|attempt| matches!(attempt, Attempt::Pending { .. }))
            .count()
    }

    pub fn error(&self, key: &RecoveryKey) -> Option<RecoveryError> {
        self.error
            .as_ref()
            .filter(|(owner, _)| owner == key)
            .map(|(_, error)| *error)
    }

    pub fn start(
        &mut self,
        source: &Source,
        revision: u64,
        target: RecoveryTarget,
        backend: Backend,
        wake: Wake,
    ) {
        let key = RecoveryKey {
            server: source.mission.server.clone(),
            workspace: source.workspace.clone(),
            mission: source.mission.id.clone(),
            revision,
            target: target.clone(),
        };
        if !self.can_start(&key) || self.any_pending_for(source) {
            return;
        }
        let Ok(request) = RecoveryRequest::new(revision, target) else {
            return;
        };
        if self.error.as_ref().is_some_and(|(owner, _)| owner == &key) {
            self.error = None;
        }
        let (out, inbox) = bounded(1);
        let lifecycle_target = source.target.clone();
        self.attempts.insert(
            key,
            Attempt::Pending {
                scope: source.workspace_scope(),
                mission: source.mission.clone(),
                target: lifecycle_target.clone(),
                flight: inbox,
            },
        );
        platform::spawn(async move {
            let outcome = backend
                .recover_mission(&lifecycle_target, &request)
                .await
                .unwrap_or(RecoveryOutcome::Refused(RecoveryError::Failed));
            if out.send(outcome).await.is_ok() {
                wake();
            }
        });
    }

    pub fn poll(&mut self) -> RecoveryPolled {
        let mut polled = RecoveryPolled::default();
        let mut settled = Vec::new();
        for (key, attempt) in &self.attempts {
            if let Attempt::Pending {
                scope,
                mission,
                target,
                flight,
            } = attempt
                && let Ok(outcome) = flight.try_recv()
            {
                settled.push((
                    key.clone(),
                    scope.clone(),
                    mission.clone(),
                    target.clone(),
                    outcome,
                ));
            }
        }
        polled.changed = !settled.is_empty();
        for (key, scope, mission, target, outcome) in settled {
            if !polled.refreshed_scopes.contains(&scope) {
                polled.refreshed_scopes.push(scope);
            }
            match outcome {
                RecoveryOutcome::Admitted(revision) => {
                    self.seq = self.seq.wrapping_add(1);
                    self.attempts.insert(key, Attempt::Admitted(self.seq));
                    polled.admitted.push((mission, target, revision));
                }
                RecoveryOutcome::Refused(error) => {
                    self.attempts.remove(&key);
                    self.error = Some((key, error));
                }
            }
        }
        self.prune();
        polled
    }

    fn prune(&mut self) {
        while self
            .attempts
            .values()
            .filter(|attempt| matches!(attempt, Attempt::Admitted(_)))
            .count()
            > SETTLED_CAPACITY
        {
            let Some(oldest) = self
                .attempts
                .iter()
                .filter_map(|(key, attempt)| match attempt {
                    Attempt::Admitted(seq) => Some((*seq, key)),
                    Attempt::Pending { .. } => None,
                })
                .min_by_key(|(seq, _)| *seq)
                .map(|(_, key)| key.clone())
            else {
                break;
            };
            self.attempts.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests;
