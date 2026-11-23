use super::Panel;
use crate::platform;
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    missions::{
        ControlReceipt, LifecycleAction, LifecycleOutcome, LifecycleRequest, LifecycleTarget,
        MapHeader, RunState, Status,
    },
};
use std::collections::HashMap;

const CAPACITY: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Source {
    occurrence: String,
    workspace: String,
    mission: MissionKey,
    target: LifecycleTarget,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct MissionKey {
    server: String,
    id: String,
}

impl Source {
    pub fn new(occurrence: &str, backend: &Backend, header: &MapHeader) -> Option<Self> {
        Some(Self {
            occurrence: occurrence.into(),
            workspace: backend.workspace.clone(),
            mission: MissionKey {
                server: backend.client.server_identity()?.into(),
                id: header.root.id.clone(),
            },
            target: header.lifecycle_target(),
        })
    }
}

pub(crate) enum Gesture {
    New(LifecycleAction, bool, u64),
    Check,
    Replay,
    StopDialog(u64),
    ConfirmStop(bool),
    ReadField(codenomad_client::missions::ControlPart, u64),
}

impl Panel {
    pub(crate) fn control_source(&self, occurrence: &str) -> Option<(Source, &MapHeader)> {
        let header = &self.detail.snapshot.as_ref()?.header;
        let source = Source::new(occurrence, &self.backend, header)?;
        Some((source, header))
    }

    pub(crate) fn control(
        &mut self,
        occurrence: &str,
        owner: &mut Lifecycle,
        source: &Source,
        gesture: Gesture,
    ) {
        let Some((target, header)) = self.control_source(occurrence) else {
            return;
        };
        if &target != source {
            return;
        }
        owner.retain_checks_for(Some(source));
        let revision = header.root.revision;
        let ready = self.detail.authoritative();
        let working = self.observation.working();
        let allowed = |action, graceful| {
            ready
                && (if action == LifecycleAction::Stop {
                    owner.can_stop(source, header)
                } else {
                    owner.idle(source, header)
                })
                && Lifecycle::allow(header, action, graceful, working)
        };
        let mut predecessor = None;
        let request = match gesture {
            Gesture::ReadField(part, offset) => {
                self.read_control_field(part, offset);
                return;
            }
            Gesture::New(action, graceful, witnessed)
                if witnessed == revision
                    && action != LifecycleAction::Stop
                    && allowed(action, graceful) =>
            {
                LifecycleRequest::new(action, revision, graceful).ok()
            }
            Gesture::StopDialog(witnessed)
                if witnessed == revision && allowed(LifecycleAction::Stop, false) =>
            {
                owner.confirmation = Some((target, revision));
                None
            }
            Gesture::ConfirmStop(accepted) => {
                let confirmation = owner.confirmation.take();
                if !accepted || confirmation.as_ref().is_none_or(|(key, _)| key != source) {
                    return;
                }
                if confirmation
                    .as_ref()
                    .is_some_and(|(_, expected)| *expected == revision)
                    && ready
                    && owner.can_stop(source, header)
                    && Lifecycle::allow(header, LifecycleAction::Stop, false, working)
                {
                    let request =
                        LifecycleRequest::new(LifecycleAction::Stop, revision, false).ok();
                    if request.is_some() {
                        predecessor = durable(header);
                        owner.release_durable_intent(source, header);
                    }
                    request
                } else {
                    owner.set_feedback(&target, "missions.control.run.notSent.stop");
                    None
                }
            }
            Gesture::Check if owner.unresolved(source, header) && !owner.busy(source) => {
                if owner.check(source, header, false, self.detail.map_reads) {
                    self.refresh();
                }
                None
            }
            Gesture::Replay if ready && owner.replayable(source, revision) => {
                if owner.check(source, header, true, self.detail.map_reads) {
                    self.refresh();
                }
                None
            }
            _ => None,
        };
        if let Some(request) = request {
            owner.start(
                source,
                request,
                predecessor,
                self.backend.clone(),
                self.wake.clone(),
            );
        }
    }

    pub(crate) fn settle_controls(
        &mut self,
        occurrence: &str,
        owner: &mut Lifecycle,
        finished: &[(MissionKey, LifecycleTarget, LifecycleOutcome)],
    ) {
        let Some((source, _)) = self.control_source(occurrence) else {
            return;
        };
        if let Some((_, _, outcome)) = finished
            .iter()
            .find(|(key, target, _)| *key == source.mission && *target == source.target)
        {
            if let LifecycleOutcome::Acknowledged(revision) = outcome {
                self.detail.observe(&source.target.mission, *revision);
            }
            self.refresh();
            (self.wake)();
        } else if !self.detail.busy()
            && let Some(request) = owner.readback(
                &source,
                self.detail
                    .authoritative()
                    .then(|| &self.detail.snapshot.as_ref().unwrap().header),
                self.detail.map_reads,
            )
        {
            owner.start(
                &source,
                request,
                None,
                self.backend.clone(),
                self.wake.clone(),
            );
        }
    }
}

#[derive(Default)]
pub(crate) struct Lifecycle {
    intents: HashMap<MissionKey, Intent>,
    current: Option<Source>,
    pub confirmation: Option<(Source, u64)>,
    feedback: Option<(MissionKey, LifecycleTarget, &'static str)>,
}

struct Intent {
    target: LifecycleTarget,
    request: LifecycleRequest,
    predecessor: Option<LifecycleRequest>,
    flight: Option<Receiver<LifecycleOutcome>>,
    checking: Option<(bool, u64)>,
    checked: Option<u64>,
    acknowledged: Option<u64>,
}

impl Intent {
    fn new(
        source: &Source,
        request: LifecycleRequest,
        predecessor: Option<LifecycleRequest>,
    ) -> Self {
        Self {
            target: source.target.clone(),
            request,
            predecessor,
            flight: None,
            checking: None,
            checked: None,
            acknowledged: None,
        }
    }
}

impl Lifecycle {
    pub fn idle(&self, source: &Source, header: &MapHeader) -> bool {
        !self.unresolved(source, header) && !self.busy(source) && self.intents.len() < CAPACITY
    }

    pub fn can_stop(&self, source: &Source, header: &MapHeader) -> bool {
        !self.busy(source)
            && (self.intents.len() < CAPACITY || self.intents.contains_key(&source.mission))
            && self.intents.get(&source.mission).is_none_or(|intent| {
                intent.target == source.target
                    && durable(header).as_ref() == Some(&intent.request)
                    && intent.acknowledged.is_none()
            })
    }

    fn release_durable_intent(&mut self, source: &Source, header: &MapHeader) {
        if self.intents.get(&source.mission).is_some_and(|intent| {
            intent.target == source.target && durable(header).as_ref() == Some(&intent.request)
        }) {
            self.intents.remove(&source.mission);
        }
    }

    pub fn unresolved(&self, source: &Source, header: &MapHeader) -> bool {
        self.intents.contains_key(&source.mission) || durable(header).is_some()
    }

    pub fn busy(&self, source: &Source) -> bool {
        self.intents
            .get(&source.mission)
            .is_some_and(|intent| intent.flight.is_some() || intent.checking.is_some())
    }

    pub fn replayable(&self, source: &Source, revision: u64) -> bool {
        self.current.as_ref() == Some(source)
            && self.intents.get(&source.mission).is_some_and(|intent| {
                intent.target == source.target
                    && intent.checked == Some(revision)
                    && intent.flight.is_none()
                    && intent.acknowledged.is_none()
            })
    }

    pub fn allow(
        header: &MapHeader,
        action: LifecycleAction,
        graceful: bool,
        working: bool,
    ) -> bool {
        if header.root.status != Status::Active || header.root.run_state == Some(RunState::Stopped)
        {
            return false;
        }
        match action {
            LifecycleAction::Start => matches!(
                header.root.run_state,
                Some(RunState::Prepared | RunState::Paused)
            ),
            LifecycleAction::Pause if graceful => {
                matches!(header.root.run_state, None | Some(RunState::Running))
            }
            LifecycleAction::Pause => {
                header.root.run_state == Some(RunState::Paused)
                    && header.control.as_ref().is_some_and(|control| {
                        control.action == LifecycleAction::Pause && control.graceful == Some(true)
                    })
                    && working
            }
            LifecycleAction::Stop => true,
        }
    }

    pub fn check(&mut self, source: &Source, header: &MapHeader, resend: bool, since: u64) -> bool {
        if self.current.as_ref() != Some(source) || self.busy(source) {
            return false;
        }
        if !self.intents.contains_key(&source.mission)
            && self.intents.len() < CAPACITY
            && let Some(request) = durable(header)
        {
            self.intents
                .insert(source.mission.clone(), Intent::new(source, request, None));
        }
        if let Some(intent) = self.intents.get_mut(&source.mission)
            && intent.target == source.target
            && intent.flight.is_none()
        {
            intent.checked = None;
            intent.checking = Some((resend, since));
            return true;
        }
        false
    }

    pub fn readback(
        &mut self,
        source: &Source,
        header: Option<&MapHeader>,
        observed: u64,
    ) -> Option<LifecycleRequest> {
        let intent = self.intents.get_mut(&source.mission)?;
        if intent.flight.is_some() || intent.target != source.target {
            return None;
        }
        if header.is_some() && intent.checking.is_some_and(|(_, since)| observed <= since) {
            return None;
        }
        let checking = intent.checking.take();
        let header = header?;
        if intent
            .acknowledged
            .is_some_and(|revision| header.root.revision >= revision)
            || header
                .control
                .as_ref()
                .is_some_and(|receipt| completed(receipt, &intent.request))
        {
            self.intents.remove(&source.mission);
        } else if header.control.as_ref().is_some_and(|receipt| {
            !receipt.matches(&intent.request)
                && receipt.expected_revision >= intent.request.expected_revision
                && header.root.revision > intent.request.expected_revision
        }) {
            self.intents.remove(&source.mission);
            self.set_feedback(source, "missions.control.run.superseded");
        } else if intent.request.action == LifecycleAction::Stop
            && header.root.revision > intent.request.expected_revision
            && header
                .control
                .as_ref()
                .is_none_or(|receipt| !receipt.matches(&intent.request))
        {
            self.intents.remove(&source.mission);
            self.set_feedback(source, "missions.control.run.rejected.stop");
        } else if let Some((resend, _)) = checking
            && self.current.as_ref() == Some(source)
        {
            intent.checked = header
                .control
                .as_ref()
                .is_none_or(|receipt| {
                    if receipt.matches(&intent.request) {
                        receipt.pending > 0
                    } else {
                        receipt.pending == 0
                            || intent
                                .predecessor
                                .as_ref()
                                .is_some_and(|older| receipt.matches(older))
                    }
                })
                .then_some(header.root.revision);
            if resend && intent.checked.is_some() && intent.acknowledged.is_none() {
                return Some(intent.request.clone());
            }
        }
        None
    }

    pub fn retain_checks_for(&mut self, source: Option<&Source>) {
        if self.current.as_ref() != source {
            if let Some(intent) = self
                .current
                .as_ref()
                .and_then(|old| self.intents.get_mut(&old.mission))
            {
                intent.checking = None;
                intent.checked = None;
            }
            self.current = source.cloned();
        }
    }

    pub fn feedback(&self, source: &Source) -> Option<&'static str> {
        let (key, target, label) = self.feedback.as_ref()?;
        (key == &source.mission && target == &source.target).then_some(*label)
    }

    fn set_feedback(&mut self, source: &Source, label: &'static str) {
        self.feedback = Some((source.mission.clone(), source.target.clone(), label));
    }

    pub fn start(
        &mut self,
        source: &Source,
        request: LifecycleRequest,
        predecessor: Option<LifecycleRequest>,
        backend: Backend,
        wake: Wake,
    ) {
        if self.busy(source)
            || !self.intents.contains_key(&source.mission) && self.intents.len() >= CAPACITY
        {
            return;
        }
        let intent = self
            .intents
            .entry(source.mission.clone())
            .or_insert_with(|| Intent::new(source, request.clone(), predecessor));
        if intent.target != source.target
            || intent.request != request
            || intent.flight.is_some()
            || intent.checking.is_some()
            || intent.acknowledged.is_some()
        {
            return;
        }
        let target = source.target.clone();
        let (out, inbox) = bounded(1);
        intent.flight = Some(inbox);
        intent.checked = None;
        self.feedback = None;
        platform::spawn(async move {
            let result = backend
                .control_mission(&target, &request)
                .await
                .unwrap_or(LifecycleOutcome::Unconfirmed);
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn poll(&mut self) -> Vec<(MissionKey, LifecycleTarget, LifecycleOutcome)> {
        let mut finished = Vec::new();
        self.intents.retain(|source, intent| {
            let Some(outcome) = intent
                .flight
                .as_ref()
                .and_then(|inbox| inbox.try_recv().ok())
            else {
                return true;
            };
            finished.push((source.clone(), intent.target.clone(), outcome));
            intent.flight = None;
            if let LifecycleOutcome::Acknowledged(revision) = outcome {
                intent.acknowledged = Some(revision);
            }
            if outcome == LifecycleOutcome::Rejected {
                let key = match intent.request.action {
                    LifecycleAction::Start => "missions.control.run.rejected.start",
                    LifecycleAction::Pause => "missions.control.run.rejected.pause",
                    LifecycleAction::Stop => "missions.control.run.rejected.stop",
                };
                self.feedback = Some((source.clone(), intent.target.clone(), key));
            }
            outcome != LifecycleOutcome::Rejected
        });
        finished
    }
}

fn durable(header: &MapHeader) -> Option<LifecycleRequest> {
    let receipt = header
        .control
        .as_ref()
        .filter(|receipt| receipt.pending > 0)?;
    Some(LifecycleRequest {
        action: receipt.action,
        request_id: receipt.request_id.clone(),
        expected_revision: receipt.expected_revision,
        graceful: receipt.graceful,
    })
}

fn completed(receipt: &ControlReceipt, request: &LifecycleRequest) -> bool {
    receipt.matches(request)
        && receipt.pending == 0
        && receipt.unconfirmed_receipts == 0
        && receipt.completed_revision.is_some()
}

#[cfg(test)]
mod tests;
