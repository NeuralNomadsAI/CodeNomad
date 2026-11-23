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

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct Source {
    occurrence: String,
    workspace: String,
    server: String,
    target: LifecycleTarget,
}

impl Source {
    fn same_mission(&self, other: &Self) -> bool {
        self.server == other.server && self.target.mission == other.target.mission
    }
    pub fn new(occurrence: &str, backend: &Backend, header: &MapHeader) -> Option<Self> {
        Some(Self {
            occurrence: occurrence.into(),
            workspace: backend.workspace.clone(),
            server: backend.client.server_identity()?.to_owned(),
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
                        owner.release_durable_intent(source, header);
                    }
                    request
                } else {
                    owner.feedback = Some((target, "missions.control.run.notSent.stop"));
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
            owner.start(source, request, self.backend.clone(), self.wake.clone());
        }
    }

    pub(crate) fn settle_controls(
        &mut self,
        occurrence: &str,
        owner: &mut Lifecycle,
        finished: &[(Source, LifecycleOutcome)],
    ) {
        let Some((source, _)) = self.control_source(occurrence) else {
            return;
        };
        if let Some((_, outcome)) = finished.iter().find(|(finished, _)| *finished == source) {
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
            owner.start(&source, request, self.backend.clone(), self.wake.clone());
        }
    }
}

#[derive(Default)]
pub(crate) struct Lifecycle {
    intents: HashMap<Source, Intent>,
    pub confirmation: Option<(Source, u64)>,
    pub feedback: Option<(Source, &'static str)>,
}

struct Intent {
    request: LifecycleRequest,
    flight: Option<Receiver<LifecycleOutcome>>,
    checking: Option<(bool, u64)>,
    checked: Option<u64>,
    acknowledged: Option<u64>,
}

impl Lifecycle {
    pub fn idle(&self, source: &Source, header: &MapHeader) -> bool {
        !self.unresolved(source, header) && !self.busy(source) && self.intents.len() < CAPACITY
    }

    pub fn can_stop(&self, source: &Source, header: &MapHeader) -> bool {
        !self.busy(source)
            && (self.intents.len() < CAPACITY || self.intents.contains_key(source))
            && self.intents.get(source).is_none_or(|intent| {
                durable(header).as_ref() == Some(&intent.request) && intent.acknowledged.is_none()
            })
    }

    fn release_durable_intent(&mut self, source: &Source, header: &MapHeader) {
        if self
            .intents
            .get(source)
            .is_some_and(|intent| durable(header).as_ref() == Some(&intent.request))
        {
            self.intents.remove(source);
        }
    }

    pub fn unresolved(&self, source: &Source, header: &MapHeader) -> bool {
        self.intents.contains_key(source) || durable(header).is_some()
    }

    pub fn busy(&self, source: &Source) -> bool {
        self.intents.iter().any(|(key, intent)| {
            key.same_mission(source) && (intent.flight.is_some() || intent.checking.is_some())
        })
    }

    pub fn replayable(&self, source: &Source, revision: u64) -> bool {
        self.intents.get(source).is_some_and(|intent| {
            intent.checked == Some(revision)
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
        if self.busy(source) {
            return false;
        }
        if !self.intents.contains_key(source)
            && self.intents.len() < CAPACITY
            && let Some(request) = durable(header)
        {
            self.intents.insert(
                source.clone(),
                Intent {
                    request,
                    flight: None,
                    checking: None,
                    checked: None,
                    acknowledged: None,
                },
            );
        }
        if let Some(intent) = self.intents.get_mut(source)
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
        let intent = self.intents.get_mut(source)?;
        if intent.flight.is_some() {
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
            self.intents.remove(source);
        } else if header.control.as_ref().is_some_and(|receipt| {
            !receipt.matches(&intent.request)
                && receipt.expected_revision > intent.request.expected_revision
        }) {
            self.intents.remove(source);
            self.feedback = Some((source.clone(), "missions.control.run.superseded"));
        } else if let Some((resend, _)) = checking {
            intent.checked = header
                .control
                .as_ref()
                .is_none_or(|receipt| {
                    if receipt.matches(&intent.request) {
                        receipt.pending > 0
                    } else {
                        receipt.pending == 0
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
        for (key, intent) in &mut self.intents {
            if Some(key) != source {
                intent.checking = None;
                intent.checked = None;
            }
        }
    }

    pub fn start(
        &mut self,
        source: &Source,
        request: LifecycleRequest,
        backend: Backend,
        wake: Wake,
    ) {
        if self.busy(source) || !self.intents.contains_key(source) && self.intents.len() >= CAPACITY
        {
            return;
        }
        let intent = self
            .intents
            .entry(source.clone())
            .or_insert_with(|| Intent {
                request: request.clone(),
                flight: None,
                checking: None,
                checked: None,
                acknowledged: None,
            });
        if intent.request != request
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

    #[cfg(test)]
    fn original(&self, source: &Source, revision: u64) -> Option<LifecycleRequest> {
        self.replayable(source, revision)
            .then(|| self.intents[source].request.clone())
    }

    pub fn poll(&mut self) -> Vec<(Source, LifecycleOutcome)> {
        let mut finished = Vec::new();
        self.intents.retain(|source, intent| {
            let Some(outcome) = intent
                .flight
                .as_ref()
                .and_then(|inbox| inbox.try_recv().ok())
            else {
                return true;
            };
            finished.push((source.clone(), outcome));
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
                self.feedback = Some((source.clone(), key));
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
mod tests {
    use super::*;
    use serde_json::json;

    fn source(occurrence: &str) -> Source {
        Source {
            occurrence: occurrence.into(),
            workspace: occurrence.into(),
            server: "server".into(),
            target: header(7, None).lifecycle_target(),
        }
    }

    fn receipt(request: &LifecycleRequest, pending: u64, unconfirmed: u64) -> serde_json::Value {
        json!({"id":"operation","requestID":request.request_id,"action":request.action,
            "expectedRevision":request.expected_revision,"graceful":request.graceful,
            "pending":pending,"receipts":unconfirmed,"unconfirmedReceipts":unconfirmed,
            "partialDescendants":0,"completedRevision":(pending == 0).then_some(request.expected_revision + 1)})
    }

    #[test]
    fn durable_partial_allows_stop_but_unknown_ack_and_supersession_stay_distinct() {
        let mut owner = Lifecycle::default();
        let source = source("a");
        let start = LifecycleRequest::new(LifecycleAction::Start, 7, false).unwrap();
        let partial = header(8, Some(receipt(&start, 1, 0)));
        assert!(owner.unresolved(&source, &partial));
        assert!(owner.can_stop(&source, &partial));
        assert!(owner.check(&source, &partial, false, 0));
        owner.readback(&source, Some(&partial), 1);
        assert!(owner.can_stop(&source, &partial));
        owner.readback(&source, Some(&header(8, Some(receipt(&start, 0, 1)))), 2);
        assert!(owner.unresolved(&source, &header(8, None)));
        assert!(!owner.can_stop(&source, &header(8, None)));
        let later = LifecycleRequest::new(LifecycleAction::Pause, 8, true).unwrap();
        owner.readback(&source, Some(&header(9, Some(receipt(&later, 0, 0)))), 3);
        assert!(!owner.unresolved(&source, &header(9, None)));
        assert_eq!(owner.feedback.unwrap().1, "missions.control.run.superseded");
    }

    #[test]
    fn a_delayed_post_excludes_double_click_duplicate_tab_and_reconnected_source() {
        use crate::files::test_http::{Http, wait};
        crate::platform::block_on(async {
            let http = Http::new().await;
            let a = source("tab-a");
            let b = source("tab-b");
            let replacement = Backend::unauthenticated(&http.backend.base).unwrap();
            let (send, done) = bounded(1);
            let wake: Wake = std::sync::Arc::new(move || {
                let _ = send.try_send(());
            });
            let request = LifecycleRequest::new(LifecycleAction::Pause, 7, true).unwrap();
            let mut owner = Lifecycle::default();
            owner.start(&a, request.clone(), http.backend.clone(), wake.clone());
            let held = http.accept().await;
            assert_eq!(held.body["requestId"], request.request_id);
            owner.start(&a, request.clone(), http.backend.clone(), wake.clone());
            owner.retain_checks_for(Some(&b));
            assert!(owner.busy(&b));
            owner.start(&b, request.clone(), http.backend.clone(), wake.clone());
            owner.start(&b, request.clone(), replacement, wake.clone());
            http.quiet().await;
            held.reply(503, json!({})).await;
            wait(done.recv()).await.unwrap();
            assert_eq!(owner.poll(), vec![(a, LifecycleOutcome::Unconfirmed)]);
            assert!(!owner.busy(&b));
            assert!(!owner.intents.contains_key(&b));
        });
    }

    fn header(revision: u64, control: Option<serde_json::Value>) -> MapHeader {
        serde_json::from_value(json!({
            "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
                "excerpt":"Fixture","template":"custom","status":"active","coordinatorSessionId":"session",
                "revision":revision,"createdAt":1,"updatedAt":1,"historyTruncated":false,"bodies":{}},
            "collections":{},"tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
                "pins":[],"reportPins":[],"version":""},
            "control":control,
        })).unwrap()
    }

    #[test]
    fn absent_or_foreign_receipts_leave_exact_intent_held_and_require_a_fresh_check() {
        let source = Source {
            occurrence: "occurrence".into(),
            workspace: "workspace".into(),
            server: "server".into(),
            target: header(7, None).lifecycle_target(),
        };
        let intent = LifecycleRequest::new(LifecycleAction::Pause, 7, true).unwrap();
        let mut store = Lifecycle::default();
        store.intents.insert(
            source.clone(),
            Intent {
                request: intent.clone(),
                flight: None,
                checking: None,
                checked: None,
                acknowledged: None,
            },
        );
        assert!(store.original(&source, 7).is_none());
        assert!(store.check(&source, &header(7, None), false, 0));
        store.readback(&source, None, 0);
        assert!(store.original(&source, 7).is_none());
        assert!(store.check(&source, &header(7, None), false, 0));
        store.readback(&source, Some(&header(7, None)), 1);
        assert_eq!(store.original(&source, 7), Some(intent.clone()));
        assert!(store.original(&source, 8).is_none());
        assert!(store.check(&source, &header(7, None), true, 1));
        assert!(store.readback(&source, Some(&header(7, None)), 1).is_none());
        assert_eq!(
            store.readback(&source, Some(&header(7, None)), 2),
            Some(intent.clone())
        );
        assert!(store.check(&source, &header(7, None), true, 2));
        store.retain_checks_for(None);
        assert!(store.readback(&source, Some(&header(7, None)), 3).is_none());
        let receipt = |id: &str, pending: u64| {
            json!({
                "id":"control","requestID":id,"action":"pause","expectedRevision":7,"completedRevision":(pending==0).then_some(8),
                "pending":pending,"receipts":0,"unconfirmedReceipts":0,"partialDescendants":0,"graceful":true,
            })
        };
        store.readback(&source, Some(&header(8, Some(receipt("foreign", 0)))), 3);
        assert!(store.intents.contains_key(&source));
        store.readback(
            &source,
            Some(&header(8, Some(receipt(&intent.request_id, 1)))),
            4,
        );
        assert!(store.intents.contains_key(&source));
        store.readback(
            &source,
            Some(&header(8, Some(receipt(&intent.request_id, 0)))),
            5,
        );
        assert!(!store.intents.contains_key(&source));
    }
}
