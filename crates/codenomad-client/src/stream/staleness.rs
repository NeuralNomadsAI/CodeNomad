//! Silence-based SSE staleness watchdog and wake probe registry.
use crate::{Receiver, Sender, runtime::Instant};
#[cfg(test)]
use std::sync::Arc;
use std::{
    sync::{Mutex, OnceLock},
    time::Duration,
};

pub(crate) const STALE_THRESHOLD: Duration = Duration::from_secs(45);
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

struct WatchState {
    last: Stamp,
    paused: usize,
}

/// Detects a silently dead SSE connection by tracking both monotonic and wall time since the last
/// observed network activity. Waiting on local downstream queues pauses the deadline so UI
/// backpressure never tears down a healthy connection.
pub(crate) struct Watchdog<C = SystemClock> {
    clock: C,
    threshold: Duration,
    check_interval: Duration,
    state: Mutex<WatchState>,
}

#[cfg(test)]
pub(crate) struct PauseGuard<'a, C: Clock> {
    watchdog: &'a Watchdog<C>,
}

#[cfg(test)]
impl<C: Clock> Drop for PauseGuard<'_, C> {
    fn drop(&mut self) {
        let mut state = self.watchdog.state.lock().unwrap();
        state.paused = state.paused.saturating_sub(1);
        if state.paused == 0 {
            state.last = self.watchdog.clock.now();
        }
    }
}

impl Watchdog<SystemClock> {
    pub(crate) fn new(threshold: Duration) -> Self {
        Self::with_clock(SystemClock, threshold, CHECK_INTERVAL)
    }
}

impl<C: Clock + Clone> Watchdog<C> {
    /// Creates an independent silence timer sharing the same clock and thresholds, unaffected
    /// by local queue backpressure pauses on the parent stream reader.
    pub(crate) fn fork(&self) -> Self {
        Self::with_clock(self.clock.clone(), self.threshold, self.check_interval)
    }
}

impl<C: Clock> Watchdog<C> {
    pub(crate) fn with_clock(clock: C, threshold: Duration, check_interval: Duration) -> Self {
        let last = clock.now();
        Self {
            clock,
            threshold,
            check_interval,
            state: Mutex::new(WatchState { last, paused: 0 }),
        }
    }

    pub(crate) fn activity(&self) {
        self.state.lock().unwrap().last = self.clock.now();
    }

    #[cfg(test)]
    pub(crate) fn pause(&self) -> PauseGuard<'_, C> {
        self.state.lock().unwrap().paused += 1;
        PauseGuard { watchdog: self }
    }

    fn elapsed_locked(&self, state: &WatchState) -> Duration {
        let now = self.clock.now();
        let monotonic = now
            .monotonic
            .saturating_duration_since(state.last.monotonic);
        let wall = Duration::from_millis(now.wall_ms.saturating_sub(state.last.wall_ms));
        monotonic.max(wall)
    }

    #[cfg(test)]
    pub(crate) fn elapsed(&self) -> Duration {
        let state = self.state.lock().unwrap();
        if state.paused > 0 {
            return Duration::ZERO;
        }
        self.elapsed_locked(&state)
    }

    pub(crate) fn is_stale(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.paused == 0 && self.elapsed_locked(&state) >= self.threshold
    }

    pub(crate) fn next_check_delay(&self) -> Duration {
        let state = self.state.lock().unwrap();
        if state.paused > 0 {
            return self.threshold.min(self.check_interval);
        }
        self.threshold
            .saturating_sub(self.elapsed_locked(&state))
            .min(self.check_interval)
    }

    pub(crate) async fn wait_until_stale(
        &self,
        probe: &ProbeSubscription,
        extra_probe: Option<&Receiver<()>>,
    ) {
        while !self.is_stale() {
            let wait = self.next_check_delay();
            let wake = async {
                if let Some(extra) = extra_probe {
                    futures_lite::future::or(probe.wait(), async {
                        if extra.recv().await.is_err() {
                            std::future::pending::<()>().await;
                        }
                    })
                    .await;
                } else {
                    probe.wait().await;
                }
            };
            futures_lite::future::or(wake, crate::runtime::sleep(wait)).await;
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

#[derive(Clone)]
pub(crate) struct ProbeSource {
    #[cfg(test)]
    local: Option<Arc<Mutex<ProbeRegistry>>>,
    #[cfg(test)]
    captured: Option<Arc<Mutex<Vec<u64>>>>,
}

impl ProbeSource {
    pub(crate) fn global() -> Self {
        Self {
            #[cfg(test)]
            local: None,
            #[cfg(test)]
            captured: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn global_capturing() -> (Arc<Mutex<Vec<u64>>>, Self) {
        let captured = Arc::new(Mutex::new(Vec::new()));
        (
            captured.clone(),
            Self {
                local: None,
                captured: Some(captured),
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn local() -> (LocalProbe, Self) {
        let registry = Arc::new(Mutex::new(ProbeRegistry::default()));
        (
            LocalProbe(registry.clone()),
            Self {
                local: Some(registry),
                captured: None,
            },
        )
    }

    pub(crate) fn subscribe(&self) -> ProbeSubscription {
        let (tx, rx) = crate::bounded(1);
        #[cfg(test)]
        if let Some(local) = &self.local {
            let mut registry = local.lock().unwrap();
            registry.next = registry.next.wrapping_add(1);
            let id = registry.next;
            registry.waiters.push((id, tx));
            return ProbeSubscription {
                id,
                rx,
                local: Some(local.clone()),
            };
        }
        let mut registry = probes().lock().unwrap();
        registry.next = registry.next.wrapping_add(1);
        let id = registry.next;
        registry.waiters.push((id, tx));
        #[cfg(test)]
        if let Some(captured) = &self.captured {
            captured.lock().unwrap().push(id);
        }
        ProbeSubscription {
            id,
            rx,
            #[cfg(test)]
            local: None,
        }
    }
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct LocalProbe(Arc<Mutex<ProbeRegistry>>);

#[cfg(test)]
impl LocalProbe {
    pub(crate) fn trigger(&self) {
        let registry = self.0.lock().unwrap();
        for (_, tx) in &registry.waiters {
            let _ = tx.try_send(());
        }
    }
}

pub(crate) struct ProbeSubscription {
    id: u64,
    rx: Receiver<()>,
    #[cfg(test)]
    local: Option<Arc<Mutex<ProbeRegistry>>>,
}

impl ProbeSubscription {
    pub(crate) async fn wait(&self) {
        if self.rx.recv().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

impl Drop for ProbeSubscription {
    fn drop(&mut self) {
        #[cfg(test)]
        if let Some(local) = &self.local {
            local.lock().unwrap().waiters.retain(|(k, _)| *k != self.id);
            return;
        }
        probes()
            .lock()
            .unwrap()
            .waiters
            .retain(|(k, _)| *k != self.id);
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

/// Immediately re-evaluates silence on every open SSE connection in this process.
pub fn probe_stale() {
    let registry = probes().lock().unwrap();
    for (_, tx) in &registry.waiters {
        let _ = tx.try_send(());
    }
}
