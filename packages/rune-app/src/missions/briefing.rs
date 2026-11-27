//! Explicit "Request an update" briefing state machine.
//! Follows `packages/ui/src/components/mission-briefing.tsx` verbatim using a
//! lock-free two-step handshake on the UI thread:
//! 1. Step 1 (`Preparing`): background worker runs `GET .../admission` only.
//! 2. UI thread decides synchronously whether the view/target/connection is still
//!    current: if not, abandons as `Error` without ever posting; if yes, transitions
//!    to `Sending` and launches Step 2 (`POST .../prompt`, never auto-resent).
use super::Panel;
use crate::platform;
use codenomad_client::{
    Receiver, Sender, TryRecvError, Wake,
    backend::Backend,
    bounded,
    missions::{
        BriefingAdmissionOutcome, BriefingSendOutcome, BriefingSendState, BriefingTarget,
        MapHeader, request_id,
    },
};
use std::collections::HashMap;

const CAPACITY: usize = 64;

/// Keyed by stable Mission identity (server + project + canonical path + mission +
/// coordinator), independent of ephemeral workspace handles so reopening the same
/// folder retains any `Uncertain` or `Admitted` request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct BriefingKey {
    server: String,
    project: String,
    canonical: String,
    mission: String,
    coordinator: String,
}

impl BriefingKey {
    pub fn new(backend: &Backend, header: &MapHeader) -> Option<Self> {
        Some(Self {
            server: backend.client.server_identity()?.into(),
            project: header.root.project_id().into(),
            canonical: header.root.project_canonical().into(),
            mission: header.root.id.clone(),
            coordinator: header.root.coordinator_session_id().into(),
        })
    }

    #[cfg(test)]
    pub(super) fn fixture(header: &MapHeader) -> Self {
        Self {
            server: "server".into(),
            project: header.root.project_id().into(),
            canonical: header.root.project_canonical().into(),
            mission: header.root.id.clone(),
            coordinator: header.root.coordinator_session_id().into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BriefingPhase {
    Preparing,
    Sending,
    Admitted { message_id: String },
    Uncertain,
    Error,
    Answered { briefing_id: String },
}

impl BriefingPhase {
    pub fn is_waiting(&self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Sending | Self::Admitted { .. } | Self::Uncertain
        )
    }

    pub fn message_key(&self) -> Option<&'static str> {
        match self {
            Self::Preparing => Some("missions.briefing.request.preparing"),
            Self::Sending => Some("missions.briefing.request.sending"),
            Self::Admitted { .. } => Some("missions.briefing.request.admitted"),
            Self::Uncertain => Some("missions.briefing.request.uncertain"),
            Self::Error => Some("missions.briefing.request.error"),
            Self::Answered { .. } => None,
        }
    }

    pub fn is_alert(&self) -> bool {
        matches!(self, Self::Error | Self::Uncertain)
    }

    pub fn offers_followup(&self) -> bool {
        matches!(self, Self::Admitted { .. } | Self::Uncertain)
    }

    fn is_terminal(&self) -> bool {
        matches!(self, Self::Answered { .. } | Self::Error)
    }
}

pub(crate) enum BriefingGesture {
    Ask,
    ConfirmNewDialog,
    ConfirmNew(bool),
}

enum Flight {
    Preparing {
        occurrence: String,
        backend: Backend,
        target: BriefingTarget,
        locale: String,
        cancel: Sender<()>,
        inbox: Receiver<BriefingAdmissionOutcome>,
    },
    Sending {
        occurrence: String,
        backend: Backend,
        target: BriefingTarget,
        abandoned: bool,
        inbox: Receiver<BriefingSendOutcome>,
    },
}

struct BriefingEntry {
    request_id: String,
    phase: BriefingPhase,
    flight: Option<Flight>,
    touched: u64,
}

pub(crate) struct ActiveBriefing<'a> {
    pub occurrence: &'a str,
    pub key: &'a BriefingKey,
    pub header: &'a MapHeader,
    pub backend: &'a Backend,
    pub wake: &'a Wake,
    pub failed: bool,
}

impl Panel {
    pub(crate) fn briefing_source(&self) -> Option<(BriefingKey, &MapHeader)> {
        let header = &self.detail.snapshot.as_ref()?.header;
        let key = BriefingKey::new(&self.backend, header)?;
        Some((key, header))
    }

    pub(crate) fn briefing_backend(&self) -> &Backend {
        &self.backend
    }

    pub(crate) fn briefing_wake(&self) -> &Wake {
        &self.wake
    }

    pub(crate) fn detail_failed(&self) -> bool {
        self.detail.failed
    }

    pub(crate) fn owns_conversation_target(&self, session_id: &str) -> bool {
        if self.calendars.owns_conversation(session_id) {
            return true;
        }
        let Some(snapshot) = &self.detail.snapshot else {
            return false;
        };
        if snapshot.header.root.coordinator_session_id() == session_id {
            return true;
        }
        session_id != "global" && self.observation.includes_actor(session_id)
    }

    pub(crate) fn briefing_act(
        &self,
        occurrence: &str,
        owner: &mut BriefingRequests,
        key: &BriefingKey,
        locale: &str,
        gesture: BriefingGesture,
    ) -> bool {
        let Some((current_key, header)) = self.briefing_source() else {
            return false;
        };
        if &current_key != key {
            return false;
        }
        if self.detail.failed && !matches!(gesture, BriefingGesture::ConfirmNew(false)) {
            return false;
        }
        owner.act(
            occurrence,
            key,
            header,
            &self.backend,
            &self.wake,
            locale,
            gesture,
        )
    }
}

#[derive(Default)]
pub(crate) struct BriefingRequests {
    entries: HashMap<BriefingKey, BriefingEntry>,
    pub confirmation: Option<(String, BriefingKey)>,
    clock: u64,
    auth_expired: Vec<Backend>,
}

impl BriefingRequests {
    pub fn visible_phase(&self, key: &BriefingKey, header: &MapHeader) -> Option<&BriefingPhase> {
        let entry = self.entries.get(key)?;
        if matches!(entry.phase, BriefingPhase::Answered { .. })
            || header
                .root
                .briefing_response_id(&entry.request_id)
                .is_some()
        {
            return None;
        }
        Some(&entry.phase)
    }

    pub fn waiting(&self, key: &BriefingKey, header: &MapHeader) -> bool {
        self.entries
            .get(key)
            .is_some_and(|entry| entry.flight.is_some())
            || self
                .visible_phase(key, header)
                .is_some_and(BriefingPhase::is_waiting)
    }

    /// True when all 64 slots hold active flights or unresolved (`Admitted`/`Uncertain`)
    /// requests so a brand new Mission key cannot be inserted without forgetting one.
    pub fn at_capacity(&self, key: &BriefingKey) -> bool {
        !self.entries.contains_key(key)
            && self.entries.len() >= CAPACITY
            && self.evictable_victim().is_none()
    }

    pub fn take_auth_expired(&mut self) -> Vec<Backend> {
        std::mem::take(&mut self.auth_expired)
    }

    fn record_auth_expired(&mut self, backend: Backend) {
        if self.auth_expired.len() < CAPACITY
            && !self
                .auth_expired
                .iter()
                .any(|existing| existing.client.same_connection(&backend.client))
        {
            self.auth_expired.push(backend);
        }
    }

    /// Drains already-committed `Sending` flights on every poll regardless of
    /// which tab or Mission is currently visible.
    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        let mut expired = Vec::new();
        for entry in self.entries.values_mut() {
            let (entry_changed, auth) = drain_sending(entry);
            changed |= entry_changed;
            if let Some(conn) = auth {
                expired.push(conn);
            }
        }
        for conn in expired {
            self.record_auth_expired(conn);
        }
        changed
    }

    /// Runs synchronously on the UI thread:
    /// - Reconciles exact briefing readback (`briefing` or `briefingResponses`).
    /// - For every `Preparing` flight, either abandons as `Error` if the active
    ///   view/tab/Mission/connection changed, or promotes an admitted GET directly
    ///   into `Sending` and launches Step 2 (`POST .../prompt`).
    /// - Marks any in-flight `Sending` whose view/tab/Mission/connection is lost as
    ///   abandoned (`Uncertain`), while keeping the flight until drain so late `401`
    ///   responses are never dropped and replacement stays blocked.
    pub fn reconcile(&mut self, active: Option<ActiveBriefing<'_>>) -> bool {
        let mut changed = false;
        if let Some(view) = &active
            && let Some(entry) = self.entries.get_mut(view.key)
            && !matches!(entry.phase, BriefingPhase::Answered { .. })
            && let Some(briefing_id) = view.header.root.briefing_response_id(&entry.request_id)
        {
            if let Some(Flight::Preparing { cancel, .. }) = entry.flight.as_ref() {
                cancel.close();
                entry.flight = None;
            }
            entry.phase = BriefingPhase::Answered {
                briefing_id: briefing_id.to_owned(),
            };
            changed = true;
        }

        let mut expired = Vec::new();
        for (key, entry) in &mut self.entries {
            match entry.flight.as_mut() {
                Some(Flight::Preparing {
                    occurrence,
                    backend,
                    target,
                    ..
                }) => {
                    if !flight_still_valid(active.as_ref(), key, occurrence, backend, target) {
                        if let Some(Flight::Preparing {
                            backend,
                            cancel,
                            inbox,
                            ..
                        }) = entry.flight.take()
                        {
                            if let Ok(BriefingAdmissionOutcome::Error { auth_expired: true }) =
                                inbox.try_recv()
                            {
                                expired.push(backend);
                            }
                            cancel.close();
                        }
                        if !matches!(entry.phase, BriefingPhase::Answered { .. }) {
                            entry.phase = BriefingPhase::Error;
                        }
                        changed = true;
                        continue;
                    }
                    let Some(Flight::Preparing { inbox, .. }) = entry.flight.as_ref() else {
                        continue;
                    };
                    match inbox.try_recv() {
                        Ok(BriefingAdmissionOutcome::Admitted) => {
                            // UI thread synchronously commits Step 2 (POST .../prompt).
                            if let Some(Flight::Preparing {
                                occurrence,
                                backend,
                                target,
                                locale,
                                ..
                            }) = entry.flight.take()
                            {
                                let wake = active.as_ref().unwrap().wake.clone();
                                entry.phase = BriefingPhase::Sending;
                                entry.flight = Some(spawn_send(
                                    occurrence,
                                    backend,
                                    target,
                                    entry.request_id.clone(),
                                    locale,
                                    wake,
                                ));
                                changed = true;
                            }
                        }
                        Ok(BriefingAdmissionOutcome::Error { auth_expired }) => {
                            if let Some(Flight::Preparing { backend, .. }) = entry.flight.take()
                                && auth_expired
                            {
                                expired.push(backend);
                            }
                            if !matches!(entry.phase, BriefingPhase::Answered { .. }) {
                                entry.phase = BriefingPhase::Error;
                            }
                            changed = true;
                        }
                        Err(TryRecvError::Closed) => {
                            entry.flight = None;
                            if !matches!(entry.phase, BriefingPhase::Answered { .. }) {
                                entry.phase = BriefingPhase::Error;
                            }
                            changed = true;
                        }
                        Err(TryRecvError::Empty) => {}
                    }
                }
                Some(Flight::Sending {
                    occurrence,
                    backend,
                    target,
                    abandoned,
                    ..
                }) => {
                    if !*abandoned
                        && !flight_still_valid(active.as_ref(), key, occurrence, backend, target)
                    {
                        *abandoned = true;
                        if !matches!(
                            entry.phase,
                            BriefingPhase::Answered { .. } | BriefingPhase::Uncertain
                        ) {
                            entry.phase = BriefingPhase::Uncertain;
                            changed = true;
                        }
                    }
                }
                None => {}
            }
        }
        for conn in expired {
            self.record_auth_expired(conn);
        }

        if let Some((occ, key)) = &self.confirmation {
            let keep = active.as_ref().is_some_and(|view| {
                view.occurrence == occ
                    && view.key == key
                    && !view.failed
                    && view.header.accepts_coordinator_message()
                    && !self
                        .entries
                        .get(key)
                        .is_some_and(|entry| entry.flight.is_some())
                    && self
                        .visible_phase(key, view.header)
                        .is_some_and(BriefingPhase::offers_followup)
            });
            if !keep {
                self.confirmation = None;
                changed = true;
            }
        }
        changed
    }

    pub fn suspend(&mut self) {
        self.confirmation = None;
        self.reconcile(None);
    }

    #[cfg(test)]
    pub(super) fn fixture_phase(
        &mut self,
        key: &BriefingKey,
        request_id: &str,
        phase: BriefingPhase,
    ) {
        self.entries.insert(
            key.clone(),
            BriefingEntry {
                request_id: request_id.into(),
                phase,
                flight: None,
                touched: 1,
            },
        );
    }

    #[cfg(test)]
    pub(crate) fn fixture_preparing(
        &mut self,
        key: &BriefingKey,
        request_id: &str,
        occurrence: &str,
        backend: Backend,
        header: &MapHeader,
    ) -> (Sender<BriefingAdmissionOutcome>, Receiver<()>) {
        let (cancel, cancelled) = bounded(1);
        let (out, inbox) = bounded(1);
        self.entries.insert(
            key.clone(),
            BriefingEntry {
                request_id: request_id.into(),
                phase: BriefingPhase::Preparing,
                flight: Some(Flight::Preparing {
                    occurrence: occurrence.into(),
                    backend,
                    target: header.briefing_target(),
                    locale: "en".into(),
                    cancel,
                    inbox,
                }),
                touched: 1,
            },
        );
        (out, cancelled)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn act(
        &mut self,
        occurrence: &str,
        key: &BriefingKey,
        header: &MapHeader,
        backend: &Backend,
        wake: &Wake,
        locale: &str,
        gesture: BriefingGesture,
    ) -> bool {
        match gesture {
            BriefingGesture::Ask => self.ask(occurrence, key, header, backend, wake, locale, None),
            BriefingGesture::ConfirmNewDialog => {
                if header.accepts_coordinator_message()
                    && !self
                        .entries
                        .get(key)
                        .is_some_and(|entry| entry.flight.is_some())
                    && self
                        .visible_phase(key, header)
                        .is_some_and(BriefingPhase::offers_followup)
                {
                    self.confirmation = Some((occurrence.to_owned(), key.clone()));
                    true
                } else {
                    false
                }
            }
            BriefingGesture::ConfirmNew(accepted) => {
                let confirmed = self.confirmation.take();
                if !accepted
                    || confirmed
                        .as_ref()
                        .is_none_or(|(occ, expected)| occ != occurrence || expected != key)
                {
                    return confirmed.is_some();
                }
                if !header.accepts_coordinator_message()
                    || self
                        .entries
                        .get(key)
                        .is_some_and(|entry| entry.flight.is_some())
                    || !self
                        .visible_phase(key, header)
                        .is_some_and(BriefingPhase::offers_followup)
                {
                    return true;
                }
                // Reserve the fresh UUID BEFORE mutating the prior Uncertain/Admitted state.
                let Ok(fresh_id) = request_id() else {
                    return true;
                };
                self.ask(
                    occurrence,
                    key,
                    header,
                    backend,
                    wake,
                    locale,
                    Some(fresh_id),
                );
                true
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn ask(
        &mut self,
        occurrence: &str,
        key: &BriefingKey,
        header: &MapHeader,
        backend: &Backend,
        wake: &Wake,
        locale: &str,
        preallocated_id: Option<String>,
    ) -> bool {
        if !header.accepts_coordinator_message()
            || self
                .entries
                .get(key)
                .is_some_and(|entry| entry.flight.is_some())
            || (preallocated_id.is_none() && self.waiting(key, header))
        {
            return false;
        }
        if !self.entries.contains_key(key) && self.entries.len() >= CAPACITY && !self.evict_one() {
            return false;
        }
        let id = match preallocated_id {
            Some(id) => id,
            None => match request_id() {
                Ok(id) => id,
                Err(_) => return false,
            },
        };
        let (cancel, cancelled) = bounded(1);
        let (out, inbox) = bounded(1);
        let target = header.briefing_target();
        self.clock = self.clock.wrapping_add(1);
        let touched = self.clock;
        self.entries.insert(
            key.clone(),
            BriefingEntry {
                request_id: id,
                phase: BriefingPhase::Preparing,
                flight: Some(Flight::Preparing {
                    occurrence: occurrence.to_owned(),
                    backend: backend.clone(),
                    target: target.clone(),
                    locale: locale.to_owned(),
                    cancel,
                    inbox,
                }),
                touched,
            },
        );
        let worker_backend = backend.clone();
        let worker_wake = wake.clone();
        platform::spawn(async move {
            let outcome = worker_backend
                .mission_briefing_admission(&target, &cancelled)
                .await;
            if out.send(outcome).await.is_ok() {
                worker_wake();
            }
        });
        true
    }

    fn evictable_victim(&self) -> Option<BriefingKey> {
        // Never evict an active flight or an unresolved Admitted/Uncertain request.
        self.entries
            .iter()
            .filter(|(_, entry)| entry.flight.is_none() && entry.phase.is_terminal())
            .min_by_key(|(_, entry)| entry.touched)
            .map(|(key, _)| key.clone())
    }

    fn evict_one(&mut self) -> bool {
        let Some(victim) = self.evictable_victim() else {
            return false;
        };
        self.entries.remove(&victim);
        true
    }
}

fn flight_still_valid(
    active: Option<&ActiveBriefing<'_>>,
    key: &BriefingKey,
    occurrence: &str,
    backend: &Backend,
    target: &BriefingTarget,
) -> bool {
    active.is_some_and(|view| {
        view.key == key
            && !view.failed
            && view.header.accepts_coordinator_message()
            && view.occurrence == occurrence
            && view.backend.client.same_connection(&backend.client)
            && view.header.briefing_target() == *target
    })
}

fn spawn_send(
    occurrence: String,
    backend: Backend,
    target: BriefingTarget,
    request_id: String,
    locale: String,
    wake: Wake,
) -> Flight {
    let (out, inbox) = bounded(1);
    let task_backend = backend.clone();
    let task_target = target.clone();
    platform::spawn(async move {
        let outcome = task_backend
            .send_mission_briefing_prompt(&task_target, &request_id, &locale)
            .await;
        if out.send(outcome).await.is_ok() {
            wake();
        }
    });
    Flight::Sending {
        occurrence,
        backend,
        target,
        abandoned: false,
        inbox,
    }
}

fn drain_sending(entry: &mut BriefingEntry) -> (bool, Option<Backend>) {
    let Some(Flight::Sending {
        backend,
        abandoned,
        inbox,
        ..
    }) = entry.flight.as_ref()
    else {
        return (false, None);
    };
    let abandoned = *abandoned;
    match inbox.try_recv() {
        Ok(outcome) => {
            let auth = outcome.auth_expired.then(|| backend.clone());
            if !matches!(entry.phase, BriefingPhase::Answered { .. }) {
                entry.phase = if abandoned {
                    BriefingPhase::Uncertain
                } else {
                    match outcome.state {
                        BriefingSendState::Admitted { message_id } => {
                            BriefingPhase::Admitted { message_id }
                        }
                        BriefingSendState::Uncertain => BriefingPhase::Uncertain,
                    }
                };
            }
            entry.flight = None;
            (true, auth)
        }
        Err(TryRecvError::Empty) => (false, None),
        Err(TryRecvError::Closed) => {
            if !matches!(entry.phase, BriefingPhase::Answered { .. }) {
                entry.phase = BriefingPhase::Uncertain;
            }
            entry.flight = None;
            (true, None)
        }
    }
}

#[cfg(test)]
mod tests;
