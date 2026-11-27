//! Backend-scoped write barrier shared across tabs, projects, and section lifetimes.
use codenomad_client::plugins::ActionError;
use rune::Waker;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

const MAX_RESULTS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Kind {
    McpServer(String),
    Plugins,
    PluginPackage(String),
}

struct InFlight {
    id: u64,
    waiters: HashMap<u64, Waker>,
}

#[derive(Default)]
struct Entry {
    in_flight: Option<InFlight>,
    settled_id: u64,
    results: VecDeque<(u64, Result<(), ActionError>)>,
}

pub(super) struct Observation {
    pub active: bool,
    pub settled_id: u64,
}

pub(super) struct Guard {
    kind: Kind,
    base: String,
    id: u64,
    settled: bool,
}

impl Guard {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn finish(mut self, outcome: Result<(), ActionError>) {
        self.settled = true;
        complete(&self.kind, &self.base, self.id, outcome);
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.settled {
            complete(&self.kind, &self.base, self.id, Err(ActionError::Failed));
        }
    }
}

fn registry() -> &'static Mutex<HashMap<(Kind, String), Entry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<(Kind, String), Entry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub(super) fn next_observer() -> u64 {
    next_id()
}

pub(super) fn try_begin(
    kind: Kind,
    base: &str,
    expected_settled: u64,
    observer: u64,
    wake: Waker,
) -> Option<Guard> {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.entry((kind.clone(), base.to_owned())).or_default();
    if entry.in_flight.is_some() || entry.settled_id != expected_settled {
        return None;
    }
    let id = next_id();
    let mut waiters = HashMap::new();
    waiters.insert(observer, wake);
    entry.in_flight = Some(InFlight { id, waiters });
    Some(Guard {
        kind,
        base: base.to_owned(),
        id,
        settled: false,
    })
}

pub(super) fn settled_id(kind: &Kind, base: &str) -> u64 {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.get(&(kind.clone(), base.to_owned()))
        .map_or(0, |entry| entry.settled_id)
}

pub(super) fn mcp_generations(base: &str) -> HashMap<String, u64> {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.iter()
        .filter_map(|((kind, key_base), entry)| match kind {
            Kind::McpServer(name) if key_base == base => Some((name.clone(), entry.settled_id)),
            _ => None,
        })
        .collect()
}

pub(super) fn package_generations(base: &str) -> HashMap<String, u64> {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.iter()
        .filter_map(|((kind, key_base), entry)| match kind {
            Kind::PluginPackage(target) if key_base == base => {
                Some((target.clone(), entry.settled_id))
            }
            _ => None,
        })
        .collect()
}

pub(super) fn observe(kind: &Kind, base: &str, observer: u64, wake: &Waker) -> Observation {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let Some(entry) = map.get_mut(&(kind.clone(), base.to_owned())) else {
        return Observation {
            active: false,
            settled_id: 0,
        };
    };
    if let Some(active) = &mut entry.in_flight {
        active.waiters.insert(observer, wake.clone());
    }
    Observation {
        active: entry.in_flight.is_some(),
        settled_id: entry.settled_id,
    }
}

pub(super) fn is_active(kind: &Kind, base: &str) -> bool {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.get(&(kind.clone(), base.to_owned()))
        .is_some_and(|entry| entry.in_flight.is_some())
}

pub(super) fn result(kind: &Kind, base: &str, id: u64) -> Option<Result<(), ActionError>> {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get(&(kind.clone(), base.to_owned()))?;
    if entry
        .in_flight
        .as_ref()
        .is_some_and(|active| active.id == id)
    {
        return None;
    }
    if let Some((_, outcome)) = entry.results.iter().find(|(entry_id, _)| *entry_id == id) {
        return Some(outcome.clone());
    }
    (entry.settled_id >= id).then_some(Err(ActionError::Failed))
}

fn complete(kind: &Kind, base: &str, id: u64, outcome: Result<(), ActionError>) {
    let waiters: Vec<Waker> = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get_mut(&(kind.clone(), base.to_owned())) else {
            return;
        };
        let Some(active) = entry.in_flight.as_ref() else {
            return;
        };
        if active.id != id {
            return;
        }
        let active = entry.in_flight.take().unwrap();
        entry.settled_id = id;
        if entry.results.len() >= MAX_RESULTS {
            entry.results.pop_front();
        }
        entry.results.push_back((id, outcome));
        active.waiters.into_values().collect()
    };
    for wake in waiters {
        wake();
    }
}
