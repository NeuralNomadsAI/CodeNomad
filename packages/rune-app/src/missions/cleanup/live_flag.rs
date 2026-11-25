use codenomad_client::Receiver;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU8, Ordering},
};

pub(super) const PHASE_PREFLIGHT: u8 = 0;
pub(super) const PHASE_CANCELLED: u8 = 1;
pub(super) const PHASE_DISPATCHED: u8 = 2;

#[derive(Clone)]
pub(crate) struct LiveFlag(Arc<Mutex<LiveFlagInner>>);

struct LiveFlagInner {
    live: bool,
    waiters: Vec<(Arc<AtomicU8>, Receiver<()>)>,
}

impl LiveFlag {
    pub(crate) fn new(live: bool) -> Self {
        Self(Arc::new(Mutex::new(LiveFlagInner {
            live,
            waiters: Vec::new(),
        })))
    }

    pub(crate) fn is_live(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).live
    }

    pub(crate) fn revoke(&self) {
        let waiters = {
            let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
            inner.live = false;
            let waiters = std::mem::take(&mut inner.waiters);
            for (phase, _) in &waiters {
                let _ = phase.compare_exchange(
                    PHASE_PREFLIGHT,
                    PHASE_CANCELLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
            }
            waiters
        };
        for (_, cancel) in waiters {
            cancel.close();
        }
    }

    pub(crate) fn register(&self, phase: Arc<AtomicU8>, cancel: Receiver<()>) -> bool {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.live {
            let _ = phase.compare_exchange(
                PHASE_PREFLIGHT,
                PHASE_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            drop(inner);
            cancel.close();
            return false;
        }
        inner.waiters.retain(|(_, c)| !c.is_closed());
        inner.waiters.push((phase, cancel));
        true
    }

    pub(crate) fn commit_dispatch(flags: &[&Self], phase: &AtomicU8) -> bool {
        let mut ordered: Vec<&Self> = flags.to_vec();
        ordered.sort_by_key(|flag| Arc::as_ptr(&flag.0) as usize);
        ordered.dedup_by_key(|flag| Arc::as_ptr(&flag.0) as usize);
        let guards: Vec<_> = ordered
            .iter()
            .map(|flag| flag.0.lock().unwrap_or_else(|e| e.into_inner()))
            .collect();
        if !guards.iter().all(|g| g.live) {
            let _ = phase.compare_exchange(
                PHASE_PREFLIGHT,
                PHASE_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            return false;
        }
        phase
            .compare_exchange(
                PHASE_PREFLIGHT,
                PHASE_DISPATCHED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
}
