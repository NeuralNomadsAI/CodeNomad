use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, MutexGuard},
};

use serde_json::Value;
use uuid::Uuid;

use super::Pin;

const SESSIONS: usize = 128;
const PINS: usize = 8;

#[derive(Default)]
pub struct Pins(Mutex<State>);

#[derive(Default)]
struct State {
    serial: u64,
    sessions: VecDeque<Entry>,
    runs: HashMap<String, (u64, Run)>,
}

struct Entry {
    session: String,
    ticket: u64,
    order: Option<(String, u64)>,
    issued: VecDeque<(String, Pin)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Run {
    Open,
    Restarting,
    Uncertain,
    Closed,
}

impl State {
    fn next(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }

    fn run(&self, run: &str) -> (u64, Run) {
        self.runs.get(run).copied().unwrap_or((0, Run::Open))
    }
}

fn order(raw: &str) -> Option<(String, u64)> {
    let (source, sequence) = raw.split_once('/')?;
    if source.len() != 36
        || !source.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        || !(1..=12).contains(&sequence.len())
        || !sequence.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((source.into(), sequence.parse().ok()?))
}

impl Pins {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Selection starts at arrival, before session/native reads can finish out of order.
    pub(in crate::automation) fn begin(&self, session: &str, raw_order: Option<&str>) -> Option<u64> {
        let mut state = self.lock();
        let mut next_order = raw_order.and_then(order);
        let previous = state.sessions.iter().position(|entry| entry.session == session);
        let issued = if let Some(index) = previous {
            if let (Some((source, sequence)), Some((old_source, old_sequence))) =
                (&next_order, &state.sessions[index].order)
                && source == old_source
                && sequence < old_sequence
            {
                return None;
            }
            let previous = state.sessions.remove(index).unwrap();
            next_order = next_order.or(previous.order);
            previous.issued
        } else {
            VecDeque::new()
        };
        let ticket = state.next();
        state.sessions.push_back(Entry { session: session.into(), ticket, order: next_order, issued });
        if state.sessions.len() > SESSIONS {
            state.sessions.pop_front();
        }
        Some(ticket)
    }

    pub(super) fn get(&self, session: &str, pin: &Value) -> Option<Pin> {
        let token = pin.as_str()?;
        let state = self.lock();
        let entry = state.sessions.iter().find(|entry| entry.session == session)?;
        entry.issued.iter().find(|(id, _)| id == token).map(|(_, pin)| pin.clone())
    }

    pub(super) fn access(&self, run: &str, recover: bool) -> Option<u64> {
        let (version, status) = self.lock().run(run);
        (status == Run::Open || recover && status == Run::Uncertain).then_some(version)
    }

    pub(super) fn publish(&self, session: &str, ticket: u64, version: u64, pin: Pin) -> Option<String> {
        let mut state = self.lock();
        let (observed, status) = state.run(&pin.target.run_id);
        if version != observed || !matches!(status, Run::Open | Run::Uncertain) {
            return None;
        }
        let run = (status == Run::Uncertain).then(|| pin.target.run_id.clone());
        let entry = state.sessions.iter_mut().find(|entry| entry.session == session && entry.ticket == ticket)?;
        let id = Uuid::new_v4().to_string();
        entry.issued.push_back((id.clone(), pin));
        if entry.issued.len() > PINS {
            entry.issued.pop_front();
        }
        if let Some(run) = run {
            state.runs.insert(run, (version, Run::Open));
        }
        Some(id)
    }

    pub(super) fn restart<'a>(&'a self, session: &str, run: &'a str, version: u64) -> Option<Restart<'a>> {
        let mut state = self.lock();
        if state.run(run) != (version, Run::Open) {
            return None;
        }
        let version = state.next();
        state.runs.insert(run.into(), (version, Run::Restarting));
        if let Some(entry) = state.sessions.iter_mut().find(|entry| entry.session == session) {
            entry.issued.retain(|(_, pin)| pin.target.run_id != run);
        }
        Some(Restart { pins: self, run, version })
    }
}

/// Dropping an in-flight dispatch is also an unconfirmed outcome.
pub(super) struct Restart<'a> {
    pins: &'a Pins,
    run: &'a str,
    version: u64,
}

impl Restart<'_> {
    pub(super) fn finish(&self, acknowledged: bool) {
        self.resolve(if acknowledged { Run::Closed } else { Run::Open });
    }

    fn resolve(&self, outcome: Run) {
        let mut state = self.pins.lock();
        if state.run(self.run) != (self.version, Run::Restarting) {
            return;
        }
        if outcome != Run::Open {
            for entry in &mut state.sessions {
                entry.issued.retain(|(_, pin)| pin.target.run_id != self.run);
            }
        }
        state.runs.insert(self.run.into(), (self.version, outcome));
    }
}

impl Drop for Restart<'_> {
    fn drop(&mut self) {
        self.resolve(Run::Uncertain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::developer::Target;
    use serde_json::json;

    const RUN: &str = "run";
    const SOURCE: &str = "11111111-1111-1111-1111-111111111111";

    fn pin(run: &str) -> Pin {
        Pin {
            target: Target::parse(&json!(format!("tauri:test/{run}/window/instance"))).unwrap(),
            document: Some("epoch".into()),
        }
    }

    fn publish(pins: &Pins, session: &str, run: &str) -> Value {
        let ticket = pins.begin(session, None).unwrap();
        let access = pins.access(run, false).unwrap();
        json!(pins.publish(session, ticket, access, pin(run)).unwrap())
    }

    #[test]
    fn order_fences_late_publication_and_receipts_remain_scoped_and_bounded() {
        let pins = Pins::default();
        let old = publish(&pins, "mine", RUN);
        assert!(pins.get("other", &old).is_none());
        let first = pins.begin("mine", Some(&format!("{SOURCE}/000000000010"))).unwrap();
        let second = pins.begin("mine", Some(&format!("{SOURCE}/11"))).unwrap();
        assert!(pins.begin("mine", Some(&format!("{SOURCE}/10"))).is_none());
        assert!(pins.publish("mine", first, 0, pin(RUN)).is_none());
        assert!(pins.publish("mine", second, 0, pin(RUN)).is_some());
        assert_eq!(pins.get("mine", &old).unwrap().document.as_deref(), Some("epoch"));
        let missing_order = pins.begin("mine", Some("malformed")).unwrap();
        assert!(pins.begin("mine", Some(&format!("{SOURCE}/10"))).is_none());
        assert!(pins.publish("mine", missing_order, 0, pin(RUN)).is_some());
        for _ in 0..PINS {
            publish(&pins, "mine", RUN);
        }
        assert!(pins.get("mine", &old).is_none());
        let ticket = pins.begin("mine", None).unwrap();
        for i in 0..SESSIONS {
            pins.begin(&format!("other-{i}"), None).unwrap();
        }
        assert!(pins.publish("mine", ticket, 0, pin(RUN)).is_none());
    }

    #[test]
    fn restart_forgets_issuing_session_pins_on_refusal_and_retires_run_when_unconfirmed() {
        let pins = Pins::default();
        let mine = publish(&pins, "mine", RUN);
        let other = publish(&pins, "other", RUN);
        let other_run = publish(&pins, "mine", "different-run");
        let old_ticket = pins.begin("mine", None).unwrap();

        let restart = pins.restart("mine", RUN, 0).unwrap();
        assert!(pins.access(RUN, true).is_none(), "an in-flight restart cannot be recovered or replayed");
        assert!(pins.restart("other", RUN, 0).is_none());
        restart.finish(false);
        assert!(pins.get("mine", &mine).is_none());
        assert!(pins.get("other", &other).is_some());
        assert!(pins.publish("mine", old_ticket, 0, pin(RUN)).is_none());

        drop(pins.restart("other", RUN, pins.access(RUN, false).unwrap()).unwrap());
        assert!(pins.get("other", &other).is_none());
        assert!(pins.get("mine", &other_run).is_some());
        assert!(pins.access(RUN, false).is_none());
        let ticket = pins.begin("mine", None).unwrap();
        let access = pins.access(RUN, true).unwrap();
        assert!(pins.publish("mine", ticket, access, pin(RUN)).is_some());
        assert!(pins.access(RUN, false).is_some());

        pins.restart("mine", RUN, access).unwrap().finish(true);
        assert!(pins.access(RUN, true).is_none(), "a confirmed restart cannot recover the old run");
    }
}
