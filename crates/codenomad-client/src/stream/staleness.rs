//! Silence-based SSE staleness watchdog and wake probe registry.
use crate::{Receiver, Sender, runtime::Instant};
use std::{
    sync::{Mutex, OnceLock},
    time::Duration,
};

pub(crate) const STALE_THRESHOLD: Duration = Duration::from_secs(45);
#[cfg(any(not(target_arch = "wasm32"), test))]
pub(crate) const CHECK_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug)]
pub(crate) struct Stamp {
    pub monotonic: Instant,
    pub wall_ms: u64,
}

pub(crate) trait Clock {
    fn now(&self) -> Stamp;
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Stamp {
        Stamp {
            monotonic: Instant::now(),
            wall_ms: wall_now_ms(),
        }
    }
}

fn wall_now_ms() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64)
    }
    #[cfg(target_arch = "wasm32")]
    {
        let now = js_sys::Date::now();
        if now.is_finite() && now >= 0.0 {
            now as u64
        } else {
            0
        }
    }
}

/// Detects a silently dead SSE connection by tracking both monotonic and wall time since the last
/// observed activity, so OS sleep that pauses monotonic clocks is still caught on wake.
pub(crate) struct Watchdog<C = SystemClock> {
    clock: C,
    threshold: Duration,
    #[cfg(any(not(target_arch = "wasm32"), test))]
    check_interval: Duration,
    last: Stamp,
}

impl Watchdog<SystemClock> {
    pub(crate) fn new(threshold: Duration) -> Self {
        Self::with_clock(
            SystemClock,
            threshold,
            #[cfg(any(not(target_arch = "wasm32"), test))]
            CHECK_INTERVAL,
        )
    }
}

impl<C: Clock> Watchdog<C> {
    pub(crate) fn with_clock(
        clock: C,
        threshold: Duration,
        #[cfg(any(not(target_arch = "wasm32"), test))] check_interval: Duration,
    ) -> Self {
        let last = clock.now();
        Self {
            clock,
            threshold,
            #[cfg(any(not(target_arch = "wasm32"), test))]
            check_interval,
            last,
        }
    }

    pub(crate) fn activity(&mut self) {
        self.last = self.clock.now();
    }

    pub(crate) fn elapsed(&self) -> Duration {
        let now = self.clock.now();
        let monotonic = now.monotonic.saturating_duration_since(self.last.monotonic);
        let wall = Duration::from_millis(now.wall_ms.saturating_sub(self.last.wall_ms));
        monotonic.max(wall)
    }

    pub(crate) fn is_stale(&self) -> bool {
        self.elapsed() >= self.threshold
    }

    #[cfg(any(not(target_arch = "wasm32"), test))]
    pub(crate) fn next_check_delay(&self) -> Duration {
        self.threshold
            .saturating_sub(self.elapsed())
            .min(self.check_interval)
    }

    #[cfg(any(not(target_arch = "wasm32"), test))]
    pub(crate) async fn wait_until_stale(&self, probe: &ProbeSubscription) {
        while !self.is_stale() {
            let wait = self.next_check_delay();
            futures_lite::future::race(crate::runtime::sleep(wait), probe.wait()).await;
        }
    }
}

#[derive(Default)]
struct ProbeRegistry {
    next: u64,
    waiters: Vec<(u64, Sender<()>)>,
}

static PROBES: OnceLock<Mutex<ProbeRegistry>> = OnceLock::new();

fn probes() -> &'static Mutex<ProbeRegistry> {
    PROBES.get_or_init(|| Mutex::new(ProbeRegistry::default()))
}

pub(crate) struct ProbeSubscription {
    id: Option<u64>,
    rx: Receiver<()>,
}

impl ProbeSubscription {
    pub(crate) fn register() -> Self {
        let (tx, rx) = crate::bounded(1);
        let mut registry = probes().lock().unwrap();
        registry.next = registry.next.wrapping_add(1);
        let id = registry.next;
        registry.waiters.push((id, tx));
        Self { id: Some(id), rx }
    }

    #[cfg(test)]
    pub(crate) fn local() -> (Sender<()>, Self) {
        let (tx, rx) = crate::bounded(1);
        (tx, Self { id: None, rx })
    }

    #[cfg(test)]
    pub(crate) fn id(&self) -> Option<u64> {
        self.id
    }

    pub(crate) async fn wait(&self) {
        if self.rx.recv().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
pub(crate) fn has_probe_id(id: u64) -> bool {
    probes()
        .lock()
        .unwrap()
        .waiters
        .iter()
        .any(|(entry, _)| *entry == id)
}

impl Drop for ProbeSubscription {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            probes().lock().unwrap().waiters.retain(|(k, _)| *k != id);
        }
    }
}

/// Immediately re-evaluates silence on every open SSE connection (for foreground/network wake).
pub fn probe_stale() {
    let registry = probes().lock().unwrap();
    for (_, tx) in &registry.waiters {
        let _ = tx.try_send(());
    }
}
