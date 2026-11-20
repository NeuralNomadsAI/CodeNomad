//! Recurrence control permits (reference `mission-recurrence-holds.ts`): one
//! per schedule, kept from admission until an exact native receipt settles it,
//! plus retained uncertain start intents an explicit control superseded.
//! In memory only, like the reference. The prototype has a single native
//! connection, so the reference's replaced-connection branches never apply.
use crate::missions::recurrence_contract::{state_matches, SAFE};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const CAPACITY: usize = 128;
const START_INTENTS: [&str; 4] = ["play", "resume", "check", "run-now"];
const SUPERSEDING: [&str; 4] = ["resume", "pause", "stop", "check"];
/// Proof lifetime plus the reference's expiry grace (`recurrenceProofExpired`).
const EXPIRED_MS: u64 = 30_000 + 5_000;

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
/// Workspace, native project storage and physical checkout of the admission.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Owner {
    pub workspace: String,
    pub project: String,
    pub canonical: String,
    pub checkout: String,
}
/// Canonical physical root and profile authority of a human admission.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Admission {
    pub root: String,
    pub profile: String,
}
/// The exact control identity (`RecurrenceControlRequest`).
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Request {
    pub schedule: String,
    pub request: String,
    pub action: String,
    pub revision: u64,
}
#[derive(Clone, Debug)]
pub(crate) struct Binding {
    pub workspace: String,
    pub directory: String,
    pub request: Request,
    pub owner: Owner,
    pub admission: Admission,
    pub issued_at: Option<u64>,
}
#[derive(Clone, Copy, PartialEq, Debug)]
enum State {
    Preparing,
    Dispatched,
    Uncertain,
    Partial,
}
#[derive(Clone, Debug)]
struct Held {
    serial: u64,
    binding: Binding,
    state: State,
    retrying: bool,
    /// Retained key and serial of the uncertain start intent this request supersedes.
    supersedes: Option<(String, u64)>,
}
#[derive(Default)]
struct Registry {
    map: HashMap<String, Held>,
    serial: u64,
}
static HELD: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);

fn main_key(workspace: &str, schedule: &str) -> String {
    json!([workspace, schedule]).to_string()
}
fn retained_key(b: &Binding) -> String {
    json!([b.workspace, b.request.schedule, b.request.request]).to_string()
}
fn locate(r: &Registry, workspace: &str, schedule: &str, request: &str) -> String {
    let id = main_key(workspace, schedule);
    if r.map.get(&id).is_some_and(|h| h.binding.request.request == request) {
        return id;
    }
    let retained = json!([workspace, schedule, request]).to_string();
    if r.map.contains_key(&retained) { retained } else { id }
}
fn same_request(a: &Binding, b: &Binding) -> bool {
    a.directory == b.directory && a.request == b.request
}
/// Releases a settled permit; a committed superseding request also retires its
/// superseded start intents, a no-effect one restores its predecessor.
fn drop_record(r: &mut Registry, id: &str, effective: bool) {
    let Some(record) = r.map.remove(id) else {
        return;
    };
    if !effective && id == retained_key(&record.binding) {
        let gone = Some((id.to_owned(), record.serial));
        for heir in r.map.values_mut() {
            if heir.supersedes == gone {
                heir.supersedes = record.supersedes.clone();
            }
        }
        return;
    }
    let mut next = record.supersedes;
    while let Some((key, serial)) = next {
        if r.map.get(&key).is_none_or(|h| h.serial != serial) {
            break;
        }
        if effective {
            next = r.map.remove(&key).and_then(|old| old.supersedes);
        } else {
            let old = r.map.remove(&key).unwrap();
            if id == main_key(&old.binding.workspace, &old.binding.request.schedule) {
                r.map.insert(id.to_owned(), old);
            }
            break;
        }
    }
}
fn hint(issued: Option<u64>) -> Option<u64> {
    issued.filter(|at| *at <= SAFE && now().saturating_sub(*at) >= EXPIRED_MS && now() >= *at)
}

/// Admission refused before preparation could hold the schedule.
#[derive(Debug, PartialEq)]
pub(crate) enum Refusal {
    Busy,
    /// A repeat of the held identity: it may already have been dispatched.
    Outstanding,
}
/// The exact held proof's issue time, offered once this clock considers it expired.
pub(crate) fn proof_hint(workspace: &str, q: &Request) -> Option<u64> {
    let r = HELD.lock().unwrap();
    let h = r.map.get(&locate(&r, workspace, &q.schedule, &q.request))?;
    (h.state != State::Preparing && h.binding.request == *q).then_some(())?;
    hint(h.binding.issued_at)
}
/// Whether this backend holds a dispatched permit for exactly this request.
pub(crate) fn held_read(workspace: &str, directory: &str, q: &Request) -> bool {
    let r = HELD.lock().unwrap();
    r.map
        .get(&locate(&r, workspace, &q.schedule, &q.request))
        .is_some_and(|h| h.state != State::Preparing && h.binding.directory == directory && h.binding.request == *q)
}
/// Reply code of a failure before dispatch (`recurrenceNotDispatchedReply`):
/// `None` keeps the attempt uncertain (retry, or an identity still held).
pub(crate) fn not_dispatched(refusal: Option<&Refusal>, workspace: &str, schedule: &str, request: &str, retry: bool) -> Option<u16> {
    let r = HELD.lock().unwrap();
    let original = r.map.get(&locate(&r, workspace, schedule, request));
    if refusal == Some(&Refusal::Outstanding) || retry || original.is_some_and(|h| h.binding.request.request == request) {
        return None;
    }
    Some(if refusal == Some(&Refusal::Busy) { 409 } else { 503 })
}

/// This attempt's permit. Dropping it disposes it like the reference `dispose`.
pub(crate) struct Hold {
    id: String,
    serial: u64,
    pub requires_partial_proof: bool,
    /// The superseded start intent and its proof hint, to prove before dispatch.
    pub superseded: Option<(Request, Option<u64>)>,
    partial_proven: bool,
    supersede_proven: bool,
    proven: bool,
    effective: bool,
}
pub(crate) fn hold(binding: Binding, retry: bool) -> Result<Hold, Refusal> {
    let mut r = HELD.lock().unwrap();
    let id = main_key(&binding.workspace, &binding.request.schedule);
    let previous = r.map.get(&id).cloned();
    let reuses = previous
        .as_ref()
        .is_some_and(|p| retry && p.state == State::Partial && !p.retrying && same_request(&p.binding, &binding));
    let superseding = previous.as_ref().filter(|p| {
        !retry
            && matches!(p.state, State::Uncertain | State::Partial)
            && !p.retrying
            && p.binding.request.request != binding.request.request
            && START_INTENTS.contains(&p.binding.request.action.as_str())
            && SUPERSEDING.contains(&binding.request.action.as_str())
            && p.binding.directory == binding.directory
            && p.binding.owner == binding.owner
            && p.binding.admission == binding.admission
            && !r.map.contains_key(&retained_key(&p.binding))
    });
    if let Some(p) = &previous {
        if !reuses && superseding.is_none() {
            return Err(if p.binding.request.request == binding.request.request { Refusal::Outstanding } else { Refusal::Busy });
        }
    }
    if (previous.is_none() || superseding.is_some()) && r.map.len() >= CAPACITY {
        return Err(Refusal::Busy);
    }
    let superseded = superseding.map(|p| (p.binding.request.clone(), hint(p.binding.issued_at)));
    let serial = if reuses {
        let held = r.map.get_mut(&id).unwrap();
        held.retrying = true;
        held.serial
    } else {
        r.serial += 1;
        let serial = r.serial;
        let mut supersedes = None;
        if let Some(p) = superseding.cloned() {
            supersedes = Some((retained_key(&p.binding), p.serial));
            r.map.insert(retained_key(&p.binding), p);
        }
        r.map.insert(id.clone(), Held { serial, binding, state: State::Preparing, retrying: false, supersedes });
        serial
    };
    Ok(Hold {
        id,
        serial,
        requires_partial_proof: retry && !reuses,
        superseded,
        partial_proven: false,
        supersede_proven: false,
        proven: false,
        effective: true,
    })
}
impl Hold {
    fn with<T>(&self, f: impl FnOnce(&mut Registry, Option<&mut Held>) -> T) -> T {
        let mut r = HELD.lock().unwrap();
        let held = r.map.get(&self.id).filter(|h| h.serial == self.serial).cloned();
        match held {
            Some(mut h) => {
                let out = f(&mut r, Some(&mut h));
                if r.map.get(&self.id).is_some_and(|x| x.serial == self.serial) {
                    r.map.insert(self.id.clone(), h);
                }
                out
            }
            None => f(&mut r, None),
        }
    }
    /// Binds the exact signed issue time of the proof this attempt dispatches.
    pub fn issued(&self, at: u64) {
        self.with(|_, h| {
            if let Some(h) = h {
                h.binding.issued_at = Some(at);
            }
        })
    }
    /// A fresh exact native read must show the superseded intent recorded and incomplete.
    pub fn confirm_superseded(&mut self, receipt: &Value, owner: &Owner) -> bool {
        let ok = self.with(|r, h| {
            let Some(h) = h else { return false };
            let Some((key, serial)) = h.supersedes.clone() else { return false };
            let Some(old) = r.map.get(&key).filter(|o| o.serial == serial) else { return false };
            let o = &old.binding;
            h.state == State::Preparing
                && matches!(old.state, State::Uncertain | State::Partial)
                && o.owner == *owner
                && h.binding.owner == *owner
                && exact_record(o, receipt)
                && receipt["outcome"] == "unknown"
                && receipt["controlsComplete"] == false
                && (o.request.action == "run-now" || state_matches(&o.request.action, &receipt["state"]))
        });
        self.supersede_proven |= ok;
        ok
    }
    /// Only an exact native partial record authorizes a fresh retry's first dispatch.
    pub fn confirm_partial(&mut self, receipt: &Value) -> bool {
        let required = self.requires_partial_proof;
        let ok = self.with(|_, h| {
            let Some(h) = h else { return false };
            let b = &h.binding;
            required
                && h.state == State::Preparing
                && matches!(b.request.action.as_str(), "pause" | "stop")
                && exact_record(b, receipt)
                && receipt["outcome"] == "unknown"
                && receipt["controlsComplete"] == false
                && state_matches(&b.request.action, &receipt["state"])
        });
        self.partial_proven |= ok;
        ok
    }
    pub fn dispatched(&self) -> bool {
        let (partial, supersede, superseding) = (self.partial_proven, self.supersede_proven, self.superseded.is_some());
        let required = self.requires_partial_proof;
        self.with(|_, h| {
            let Some(h) = h else { return false };
            if required && !partial
                || superseding && !supersede
                || !(h.state == State::Preparing || h.state == State::Partial && h.retrying)
            {
                return false;
            }
            h.state = State::Dispatched;
            true
        })
    }
    /// Proven outcome: a committed receipt, or (`applied` false) proof nothing applied.
    pub fn settled(&mut self, applied: bool) {
        if self.with(|_, h| h.is_some_and(|h| h.state == State::Dispatched)) {
            self.proven = true;
            self.effective = applied;
        }
    }
    pub fn partial(&self) {
        self.with(|_, h| {
            if let Some(h) = h.filter(|h| h.state == State::Dispatched) {
                h.state = State::Partial;
            }
        })
    }
    pub fn dispose(&mut self) {
        let (proven, effective) = (self.proven, self.effective);
        let id = self.id.clone();
        self.with(|r, h| {
            let Some(h) = h else { return };
            h.retrying = false;
            if h.state != State::Preparing && !proven {
                if h.state != State::Partial {
                    h.state = State::Uncertain;
                }
                return;
            }
            let effective = h.state != State::Preparing && effective;
            r.map.insert(id.clone(), h.clone());
            drop_record(r, &id, effective);
        })
    }
}
impl Drop for Hold {
    fn drop(&mut self) {
        self.dispose();
    }
}
fn exact_record(b: &Binding, receipt: &Value) -> bool {
    let q = &b.request;
    receipt["version"] == 1
        && receipt["scheduleID"] == q.schedule.as_str()
        && receipt["requestID"] == q.request.as_str()
        && receipt["action"] == q.action.as_str()
        && receipt["expectedRevision"] == q.revision
        && receipt["revision"] == q.revision + 1
}
/// Exact receipt settlement (`reconcileRecurrenceControlHold`): a completed
/// committed receipt or an exact native rejection releases the permit; an
/// incomplete one marks it partial. Unknown or foreign reads change nothing.
pub(crate) fn reconcile(workspace: &str, directory: &str, q: &Request, issued: Option<u64>, receipt: &Value) {
    let mut r = HELD.lock().unwrap();
    let id = locate(&r, workspace, &q.schedule, &q.request);
    let Some(h) = r.map.get(&id).cloned() else { return };
    if h.state == State::Preparing {
        return;
    }
    let o = &h.binding;
    let identity = directory == o.directory
        && *q == o.request
        && receipt["scheduleID"] == o.request.schedule.as_str()
        && receipt["requestID"] == o.request.request.as_str()
        && receipt["expectedRevision"] == o.request.revision;
    if receipt["outcome"] == "rejected" {
        if issued.is_some_and(|at| Some(at) != o.issued_at) || !identity || h.state == State::Partial {
            return;
        }
        drop_record(&mut r, &id, false);
        return;
    }
    if !identity
        || receipt["revision"] != o.request.revision + 1
        || o.request.action != "run-now" && !state_matches(&o.request.action, &receipt["state"])
    {
        return;
    }
    if receipt["outcome"] == "committed" && receipt["controlsComplete"] == true {
        drop_record(&mut r, &id, true);
    } else if receipt["controlsComplete"] == false {
        r.map.get_mut(&id).unwrap().state = State::Partial;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(ws: &str, request: &str, action: &str, revision: u64) -> Binding {
        Binding {
            workspace: ws.into(),
            directory: "D:\\p".into(),
            request: Request { schedule: "rcs_a".into(), request: request.into(), action: action.into(), revision },
            owner: Owner { workspace: ws.into(), project: "p".into(), canonical: "c".into(), checkout: "h".into() },
            admission: Admission { root: "r".into(), profile: "k".into() },
            issued_at: None,
        }
    }
    fn receipt(request: &str, action: &str, revision: u64, outcome: &str, complete: Option<bool>, state: &str) -> Value {
        let mut v = json!({"version":1,"scheduleID":"rcs_a","requestID":request,"action":action,
            "expectedRevision":revision,"revision":revision + 1,"state":state,"outcome":outcome});
        if let Some(c) = complete {
            v["controlsComplete"] = json!(c);
        }
        v
    }
    fn count(ws: &str) -> usize {
        HELD.lock().unwrap().map.keys().filter(|k| k.contains(ws)).count()
    }

    #[test]
    fn an_undispatched_permit_is_released_and_a_dispatched_one_stays_uncertain() {
        let ws = "w-release";
        drop(hold(binding(ws, "req_1", "play", 1), false).unwrap());
        assert_eq!(count(ws), 0);
        let h = hold(binding(ws, "req_1", "play", 1), false).unwrap();
        assert!(h.dispatched());
        drop(h);
        assert_eq!(count(ws), 1, "dispatched without proof");
        assert_eq!(hold(binding(ws, "req_1", "play", 1), false).err(), Some(Refusal::Outstanding));
        assert_eq!(hold(binding(ws, "req_2", "play", 2), false).err(), Some(Refusal::Busy), "play cannot supersede");
        assert_eq!(not_dispatched(None, ws, "rcs_a", "req_1", false), None, "held identity stays uncoded");
        assert_eq!(not_dispatched(Some(&Refusal::Busy), ws, "rcs_a", "req_9", false), Some(409));
        assert_eq!(not_dispatched(None, ws, "rcs_a", "req_9", true), None, "retries stay uncoded");
        let q = binding(ws, "req_1", "play", 1).request;
        reconcile(ws, "D:\\p", &q, None, &receipt("req_1", "play", 1, "committed", Some(true), "running"));
        assert_eq!(count(ws), 0, "exact completed receipt settles");
    }

    #[test]
    fn foreign_or_mismatched_receipts_never_release() {
        let ws = "w-foreign";
        let h = hold(binding(ws, "req_1", "pause", 4), false).unwrap();
        assert!(h.dispatched());
        drop(h);
        let q = binding(ws, "req_1", "pause", 4).request;
        reconcile(ws, "D:\\other", &q, None, &receipt("req_1", "pause", 4, "committed", Some(true), "paused"));
        reconcile(ws, "D:\\p", &q, None, &receipt("req_1", "pause", 4, "committed", Some(true), "running"));
        assert_eq!(count(ws), 1);
        reconcile(ws, "D:\\p", &q, None, &receipt("req_1", "pause", 4, "unknown", Some(false), "paused"));
        // Partial: only an exact retry reuses it, and a rejection cannot release it.
        let mut rejected = receipt("req_1", "pause", 4, "rejected", None, "paused");
        rejected["reason"] = json!("revision-conflict");
        reconcile(ws, "D:\\p", &q, None, &rejected);
        assert_eq!(count(ws), 1);
        assert_eq!(hold(binding(ws, "req_1", "pause", 4), false).err(), Some(Refusal::Outstanding));
        let mut retry = hold(binding(ws, "req_1", "pause", 4), true).unwrap();
        assert!(!retry.requires_partial_proof, "reuses the original partial permit");
        assert!(retry.dispatched());
        retry.settled(true);
        drop(retry);
        assert_eq!(count(ws), 0);
    }

    #[test]
    fn a_fresh_retry_needs_the_exact_native_partial_record() {
        let ws = "w-partial";
        let mut h = hold(binding(ws, "req_1", "stop", 2), true).unwrap();
        assert!(h.requires_partial_proof);
        assert!(!h.dispatched());
        assert!(!h.confirm_partial(&receipt("req_1", "stop", 2, "unknown", Some(false), "paused")));
        assert!(h.confirm_partial(&receipt("req_1", "stop", 2, "unknown", Some(false), "stopped")));
        assert!(h.dispatched());
    }

    #[test]
    fn a_superseding_control_retires_or_restores_its_start_intent() {
        let ws = "w-supersede";
        let h = hold(binding(ws, "req_play", "play", 1), false).unwrap();
        assert!(h.dispatched());
        drop(h);
        // Superseding needs the exact native unknown record first.
        let mut pause = hold(binding(ws, "req_pause", "pause", 2), false).unwrap();
        let (old, _) = pause.superseded.clone().unwrap();
        assert_eq!(old.request, "req_play");
        assert!(!pause.dispatched());
        let owner = binding(ws, "x", "pause", 0).owner;
        assert!(pause.confirm_superseded(&receipt("req_play", "play", 1, "unknown", Some(false), "running"), &owner));
        assert!(pause.dispatched());
        pause.settled(false);
        drop(pause);
        assert_eq!(count(ws), 1, "no effect restores the start intent");
        let mut stop = hold(binding(ws, "req_stop", "stop", 2), false).unwrap();
        assert!(stop.confirm_superseded(&receipt("req_play", "play", 1, "unknown", Some(false), "running"), &owner));
        assert!(stop.dispatched());
        stop.settled(true);
        drop(stop);
        assert_eq!(count(ws), 0, "a committed control retires the superseded intent");
    }

    #[test]
    fn proof_hints_are_only_for_expired_held_proofs() {
        let ws = "w-hint";
        let h = hold(binding(ws, "req_1", "play", 1), false).unwrap();
        h.issued(now() - 40_000);
        let q = binding(ws, "req_1", "play", 1).request;
        assert_eq!(proof_hint(ws, &q), None, "preparing permits carry no hint");
        assert!(h.dispatched());
        assert!(proof_hint(ws, &q).is_some());
        h.issued(now());
        assert_eq!(proof_hint(ws, &q), None, "fresh proofs are not sent");
        let other = Request { request: "req_2".into(), ..q.clone() };
        assert_eq!(proof_hint(ws, &other), None);
    }
}
