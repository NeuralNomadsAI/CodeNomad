use super::scroll_rail_to;
use rune::Tx;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy)]
struct WheelStamp {
    clock: f64,
    input: Option<rune::time::Instant>,
}

impl WheelStamp {
    fn from_tx(tx: &Tx) -> Self {
        Self {
            clock: tx.clock(),
            input: tx.input_time(),
        }
    }

    fn elapsed_since(self, earlier: Self) -> f64 {
        if let (Some(now), Some(then)) = (self.input, earlier.input) {
            now.saturating_duration_since(then).as_secs_f64()
        } else {
            (self.clock - earlier.clock).max(0.0)
        }
    }
}

#[derive(Default, Clone, Copy)]
pub struct RailWheelOverride {
    target: Option<f32>,
    owned: Option<OwnedWheel>,
    phased: Option<WheelStamp>,
}

#[derive(Clone, Copy)]
enum OwnedWheel {
    Unphased(WheelStamp),
    Phased(WheelStamp),
    Ended(WheelStamp),
    Momentum(WheelStamp),
}

impl RailWheelOverride {
    pub fn clear_frame(&mut self) {
        self.target = None;
    }

    /// Whether local wheel coordinates `(x, y)` lie inside the rail's presented bounds
    /// (`at.drawn`, falling back to `at.viewport` before first draw).
    pub fn contains_point(at: rune::ScrollPos, x: f32, y: f32) -> bool {
        let w = if at.drawn[0] > 0.0 {
            at.drawn[0]
        } else {
            at.viewport[0]
        };
        let h = if at.drawn[1] > 0.0 {
            at.drawn[1]
        } else {
            at.viewport[1]
        };
        w <= 0.0 || h <= 0.0 || (x >= 0.0 && y >= 0.0 && x <= w && y <= h)
    }

    /// Track gesture phase transitions observed on peer viewports (such as the transcript)
    /// so a trackpad gesture that began outside the rail still uses `PHASED_IDLE` if it moves
    /// onto the rail.
    pub fn note_phase(&mut self, phase: rune::GesturePhase, tx: &Tx) {
        self.note_phase_at(phase, WheelStamp::from_tx(tx));
    }

    fn note_phase_at(&mut self, phase: rune::GesturePhase, now: WheelStamp) {
        match phase {
            rune::GesturePhase::Began => self.phased = Some(now),
            rune::GesturePhase::Ended => self.phased = None,
            rune::GesturePhase::Moved => {}
        }
    }

    #[cfg(test)]
    fn is_owned(&self) -> bool {
        self.owned.is_some()
    }

    /// Advance an already-owned gesture when the pointer has drifted outside the rail.
    /// Returns `true` while Rune's `WheelOwner::Handler` still belongs to the rail so the caller
    /// can forward deltas to a peer viewport without losing ownership if the pointer returns.
    pub fn forward_outside(&mut self, event: rune::WheelEvent, tx: &Tx) -> bool {
        self.forward_outside_at(event, WheelStamp::from_tx(tx))
    }

    const WHEEL_IDLE: f64 = 0.1;
    const PHASED_IDLE: f64 = 1.0;
    const MOMENTUM_GAP: f64 = 0.05;

    fn forward_outside_at(&mut self, event: rune::WheelEvent, now: WheelStamp) -> bool {
        // Rune only routes an outside-rail event to `on_wheel` while `WheelOwner::Handler` still
        // owns the gesture. If `Began` happened on an unobserved element before `Moved` claimed
        // the rail, receiving an outside `Moved`/`Ended` past `WHEEL_IDLE` proves the gesture is
        // phased in Rune (`PHASED_IDLE`).
        if let Some(OwnedWheel::Unphased(last)) = self.owned
            && event.phase != rune::GesturePhase::Began
        {
            let elapsed = now.elapsed_since(last);
            if elapsed > Self::WHEEL_IDLE && elapsed <= Self::PHASED_IDLE {
                self.owned = Some(OwnedWheel::Phased(last));
                self.phased = Some(last);
            }
        }
        self.expire_for_event(event, now);
        if self.owned.is_none() {
            self.target = None;
            if event.phase == rune::GesturePhase::Ended {
                self.phased = None;
            }
            return false;
        }
        self.record_owned(event, now);
        true
    }

    pub fn apply(
        &mut self,
        programmatic: &mut Option<f32>,
        at: rune::ScrollPos,
        event: rune::WheelEvent,
        tx: &mut Tx,
    ) -> bool {
        self.apply_at(programmatic, at, event, WheelStamp::from_tx(tx), tx)
    }

    pub fn apply_claiming(
        &mut self,
        programmatic: &mut Option<f32>,
        at: rune::ScrollPos,
        event: rune::WheelEvent,
        tx: &mut Tx,
    ) -> bool {
        self.apply_at_inner(programmatic, at, event, true, WheelStamp::from_tx(tx), tx)
    }

    fn expire_for_event(&mut self, event: rune::WheelEvent, now: WheelStamp) {
        if self
            .phased
            .is_some_and(|last| now.elapsed_since(last) > Self::PHASED_IDLE)
        {
            self.phased = None;
        }
        match event.phase {
            rune::GesturePhase::Began => {
                let momentum = event.momentum
                    && matches!(self.owned, Some(OwnedWheel::Ended(ended)) if now.elapsed_since(ended) <= Self::MOMENTUM_GAP);
                self.phased = Some(now);
                self.owned = momentum.then_some(OwnedWheel::Momentum(now));
            }
            rune::GesturePhase::Moved | rune::GesturePhase::Ended => {
                let expired = match self.owned {
                    Some(OwnedWheel::Unphased(last)) => now.elapsed_since(last) > Self::WHEEL_IDLE,
                    Some(OwnedWheel::Phased(last) | OwnedWheel::Momentum(last)) => {
                        now.elapsed_since(last) > Self::PHASED_IDLE
                    }
                    Some(OwnedWheel::Ended(_)) => true,
                    None => false,
                };
                if expired {
                    self.owned = None;
                }
            }
        }
    }

    fn record_owned(&mut self, event: rune::WheelEvent, now: WheelStamp) {
        let in_phased = self.phased.is_some()
            || matches!(
                self.owned,
                Some(OwnedWheel::Phased(_) | OwnedWheel::Momentum(_))
            )
            || event.phase != rune::GesturePhase::Moved;
        self.owned = match event.phase {
            rune::GesturePhase::Ended => {
                self.phased = None;
                (!event.momentum).then_some(OwnedWheel::Ended(now))
            }
            _ if event.momentum || matches!(self.owned, Some(OwnedWheel::Momentum(_))) => {
                self.phased = Some(now);
                Some(OwnedWheel::Momentum(now))
            }
            _ if in_phased => {
                self.phased = Some(now);
                Some(OwnedWheel::Phased(now))
            }
            _ => Some(OwnedWheel::Unphased(now)),
        };
    }

    fn apply_at(
        &mut self,
        programmatic: &mut Option<f32>,
        at: rune::ScrollPos,
        event: rune::WheelEvent,
        now: WheelStamp,
        tx: &mut Tx,
    ) -> bool {
        self.apply_at_inner(programmatic, at, event, false, now, tx)
    }

    fn apply_at_inner(
        &mut self,
        programmatic: &mut Option<f32>,
        at: rune::ScrollPos,
        event: rune::WheelEvent,
        claim: bool,
        now: WheelStamp,
        tx: &mut Tx,
    ) -> bool {
        if !Self::contains_point(at, event.x, event.y) {
            self.owned = None;
            self.phased = None;
            self.target = None;
            return false;
        }
        self.expire_for_event(event, now);
        let base = if event.dy != 0.0 && programmatic.take().is_some() {
            at.offset[1]
        } else if let Some(target) = self.target.filter(|_| event.dy != 0.0) {
            target
        } else if self.owned.is_some() || (claim && event.dy != 0.0) {
            self.target.unwrap_or(at.offset[1])
        } else {
            if event.phase == rune::GesturePhase::Ended {
                self.phased = None;
            }
            return false;
        };
        let target = (base - event.dy).clamp(0.0, at.max[1].max(0.0));
        self.target = Some(target);
        self.record_owned(event, now);
        scroll_rail_to(target, tx);
        true
    }
}
