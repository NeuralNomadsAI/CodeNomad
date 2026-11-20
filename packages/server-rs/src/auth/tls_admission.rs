//! Connection admission for the HTTPS listener (audit M1). A connection is
//! anonymous until a paired device is bound to its socket. Idle anonymous
//! connections can never exhaust the listener: past the per-address or global
//! anonymous budget, the oldest anonymous connection is closed so the newest
//! one is served. Device-bound connections (requests, event streams) are
//! outside the anonymous budget and are never evicted for an anonymous one.
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub const PER_ADDRESS_ANONYMOUS: usize = 16;
pub const ANONYMOUS: usize = 128;
pub const TOTAL: usize = 1024;

type Bound = Arc<Mutex<Option<uuid::Uuid>>>;
struct Entry {
    id: u64,
    address: IpAddr,
    born: Instant,
    principal: Bound,
    socket: CancellationToken,
}
impl Entry {
    fn anonymous(&self) -> bool {
        self.principal.lock().unwrap_or_else(|e| e.into_inner()).is_none()
    }
}

#[derive(Default)]
pub struct Gate {
    entries: Mutex<(u64, Vec<Entry>)>,
}

/// Removes its connection from the gate when the connection ends.
pub struct Ticket {
    gate: Arc<Gate>,
    id: u64,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        let mut state = self.gate.entries.lock().unwrap_or_else(|e| e.into_inner());
        state.1.retain(|e| e.id != self.id);
    }
}

fn evict_oldest(entries: &mut Vec<Entry>, matches: impl Fn(&Entry) -> bool) -> bool {
    let oldest = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.anonymous() && matches(e))
        .min_by_key(|(_, e)| e.born)
        .map(|(i, _)| i);
    match oldest {
        Some(i) => {
            entries.swap_remove(i).socket.cancel();
            true
        }
        None => false,
    }
}

impl Gate {
    /// Admits a new connection, closing older anonymous ones when a budget is
    /// full; `None` only when every slot belongs to a device-bound connection.
    pub fn admit(self: &Arc<Self>, address: IpAddr, principal: Bound, socket: CancellationToken) -> Option<Ticket> {
        let mut state = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let entries = &mut state.1;
        let same = entries.iter().filter(|e| e.address == address && e.anonymous()).count();
        if same >= PER_ADDRESS_ANONYMOUS {
            evict_oldest(entries, |e| e.address == address);
        }
        if entries.iter().filter(|e| e.anonymous()).count() >= ANONYMOUS {
            evict_oldest(entries, |_| true);
        }
        if entries.len() >= TOTAL && !evict_oldest(entries, |_| true) {
            return None;
        }
        state.0 += 1;
        let id = state.0;
        state.1.push(Entry { id, address, born: Instant::now(), principal, socket });
        Some(Ticket { gate: self.clone(), id })
    }
    #[cfg(test)]
    fn open(&self) -> usize {
        self.entries.lock().unwrap().1.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connect(gate: &Arc<Gate>, address: &str) -> (Option<Ticket>, Bound, CancellationToken) {
        let principal = Bound::default();
        let socket = CancellationToken::new();
        let ticket = gate.admit(address.parse().unwrap(), principal.clone(), socket.clone());
        (ticket, principal, socket)
    }

    #[test]
    fn idle_anonymous_connections_never_lock_out_a_new_one() {
        let gate = Arc::new(Gate::default());
        let idle: Vec<_> = (0..32).map(|_| connect(&gate, "10.0.0.5")).collect();
        assert_eq!(gate.open(), PER_ADDRESS_ANONYMOUS);
        assert_eq!(idle.iter().filter(|c| c.2.is_cancelled()).count(), 32 - PER_ADDRESS_ANONYMOUS);
        assert!(idle[..16].iter().all(|c| c.2.is_cancelled()), "oldest closed first");
        // A paired device from the same address is admitted and, once bound,
        // is outside the anonymous budget.
        let device = connect(&gate, "10.0.0.5");
        assert!(device.0.is_some() && !device.2.is_cancelled());
        *device.1.lock().unwrap() = Some(uuid::Uuid::new_v4());
        let more: Vec<_> = (0..40).map(|_| connect(&gate, "10.0.0.5")).collect();
        assert!(!device.2.is_cancelled(), "a bound connection is never evicted");
        assert!(more.last().unwrap().0.is_some());
        drop(more);
        drop(idle);
        drop(device.0);
        assert_eq!(gate.open(), 0);
    }

    #[test]
    fn global_budgets() {
        let gate = Arc::new(Gate::default());
        let spread: Vec<_> = (0..200).map(|i| connect(&gate, &format!("10.0.{}.{}", i / 250, i % 250 + 1))).collect();
        assert_eq!(gate.open(), ANONYMOUS);
        assert!(spread[0].2.is_cancelled() && !spread[199].2.is_cancelled());
        drop(spread);
        let bound: Vec<_> = (0..TOTAL)
            .map(|i| {
                let c = connect(&gate, &format!("10.1.{}.{}", i / 250, i % 250 + 1));
                *c.1.lock().unwrap() = Some(uuid::Uuid::nil());
                c
            })
            .collect();
        assert!(connect(&gate, "10.2.0.1").0.is_none(), "only bound slots: refuse");
        assert!(bound.iter().all(|c| !c.2.is_cancelled()));
    }
}
