//! Fixed-geometry timeline rail. Its caller supplies identities and active state.
pub mod icons;
pub mod preview;
pub mod search;
use crate::{catalogue, generated_layout::TIMELINE_MIN_WIDTH, layout, palettes, tokens};
use rune::{El, GrowthSpec, Icon, ScrollSpec, Tx};
use std::{borrow::Cow, rc::Rc};

pub const VIEWPORT: &str = "timeline";
pub use rune::ScrollPos as ScrollPosition;
pub use rune::{GesturePhase, WheelEvent};

pub fn navigation_status(label: &'static str) -> El {
    use crate::{Space, TextRole, layout::Layout};
    let dark = layout::dark();
    let k = crate::kit(dark);
    rune_kit::popover::raised(
        k,
        rune::col()
            .key("history-navigation-status")
            .role("status")
            .label_static(label)
            .pad(Space::Sm)
            .child(rune::text(label).text_role(TextRole::Label)),
        0.0,
    )
    .anchored(
        "oldest",
        rune::Side::Top,
        rune::Align::Start,
        tokens(dark).space(Space::Xs).px(),
    )
}

pub fn user_scrolled() -> bool {
    let (hand, instant, _) = rune::scroll_watch_state();
    hand && !instant
}

pub fn rail_scrolled() -> bool {
    rune::scroll_watch_state().0
}

pub fn fits(width: f32) -> bool {
    width >= TIMELINE_MIN_WIDTH
}

pub fn transcript_lane(history: El) -> El {
    rune::col().grow(1.0).min_w(0.0).min_h(0.0).child(history)
}

pub fn conversation(expanded: bool) -> El {
    rune::row()
        .w_full()
        .grow(1.0)
        .min_h(crate::interruption::history_minimum(expanded))
}

/// Stable wrapper keeping `conversation` mounted when status banners appear or clear above it.
pub fn panel(expanded: bool, notice: Option<El>, conversation: El) -> El {
    let panel = rune::col()
        .key("conversation-panel")
        .w_full()
        .grow(1.0)
        .children(notice)
        .child(conversation);
    if expanded { panel } else { panel.min_h(0.0) }
}

/// Fixed-width slot that isolates the timeline rail's virtualized height from flex min-content sizing.
pub fn rail_slot(rail: El) -> El {
    let width = tokens(layout::dark()).metric("timelineRail", "width").px();
    rune::col()
        .w(width)
        .min_h(0.0)
        .child(rail.pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)))
}
// Chromium's CSS layout quantum is 1/64 px. Whole bands are integral even
// though their markers are not, so Rune's f32 prefix sum accumulates no drift.
const BAND: usize = 64;

fn geometry() -> (f32, f32) {
    let t = tokens(layout::dark());
    (
        t.metric("timelineMarker", "minHeight").px(),
        t.metric("timelineGap", "height").px(),
    )
}

pub fn show_marker(index: usize, tx: &mut Tx) {
    tx.scroll_to_instant(VIEWPORT, 0.0, row_top(index));
}

pub fn scroll_rail_to(target: f32, tx: &mut Tx) {
    tx.scroll_to_instant(VIEWPORT, 0.0, target);
}

pub fn glide_rail_to(target: f32, tx: &mut Tx) {
    tx.scroll_to(VIEWPORT, 0.0, target);
}

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

pub fn reveal_target(index: usize, at: rune::ScrollPos) -> Option<f32> {
    if at.viewport[1] <= 0.0 {
        return None;
    }
    let top = row_top(index);
    let end = top + geometry().0;
    let target = if top < at.offset[1] || end - top > at.viewport[1] {
        top
    } else if end > at.offset[1] + at.viewport[1] {
        end - at.viewport[1]
    } else {
        return None;
    };
    let clamped = target.clamp(0.0, at.max[1].max(0.0));
    ((clamped - at.offset[1]).abs() > 0.5).then_some(clamped)
}

pub fn visible_markers(at: rune::ScrollPos, count: usize) -> std::ops::Range<usize> {
    if at.viewport[1] <= 0.0 {
        return 0..0;
    }
    let (height, gap) = geometry();
    let pitch = height + gap;
    let top = at.offset[1].max(0.0);
    let first = ((top + gap) / pitch).floor() as usize;
    let last = ((top + at.viewport[1]) / pitch).ceil() as usize;
    first.min(count)..last.min(count)
}

fn row_top(index: usize) -> f32 {
    let (height, gap) = geometry();
    ((f64::from(height) + f64::from(gap)) * index as f64) as f32
}

pub struct Marker<'a> {
    pub label: Cow<'a, str>,
    pub current: &'static str,
    pub glyph: &'static Icon,
    pub tone: &'static str,
    pub active: bool,
}

/// Width is measured on the conversation container before reserving space for the rail.
/// `version` changes whenever the ordered row keys change.
pub fn view<S: 'static>(
    width: f32,
    locale: &str,
    count: usize,
    version: u64,
    key: impl for<'a> Fn(&'a S, usize) -> Cow<'a, str> + 'static,
    marker: impl for<'a> Fn(&'a S, usize) -> Marker<'a> + 'static,
    activate: impl Fn(&mut S, &str, &mut Tx) + 'static,
    decorate: impl Fn(&S, usize, El) -> El + 'static,
) -> Option<El> {
    if !fits(width) {
        return None;
    }
    let dark = layout::dark();
    let palette = palettes::current();
    let t = tokens(dark);
    let (height, gap) = geometry();
    let pitch = height + gap;
    let rail = rune::col()
        .key(VIEWPORT)
        .role("navigation")
        .focusable(count != 0)
        .label_static(catalogue::message(locale, "messageTimeline.ariaLabel").unwrap())
        .w(t.metric("timelineRail", "width").px())
        .h_full()
        .fill(t.color("surface-secondary"))
        .border_sides(
            [0.0, 0.0, 0.0, t.metric("timelineRail", "edgeWidth").px()],
            t.color("border-base"),
        )
        .scroll(ScrollSpec {
            stick_bottom: false,
        });
    if count == 0 {
        return Some(rail);
    }
    let activate = Rc::new(activate);
    let build = Rc::new(move |s: &S, first: usize, len: usize| {
        let last = first + len;
        let extent = len as f32 * pitch - if last == count { gap } else { 0.0 };
        rune::col()
            .w_full()
            .h(extent)
            .children((first..last).map(|i| {
                let id = key(s, i).into_owned();
                let enter = id.clone();
                let on_enter = activate.clone();
                let activate = activate.clone();
                palettes::with_palette(palette, || {
                    let button = button(dark, marker(s, i))
                        .key(id.clone())
                        .pin(Some(0.0), Some((i - first) as f32 * pitch), Some(0.0), None)
                        .on_press_tx(move |s, tx| activate(s, &id, tx))
                        // Match HTML button activation; Rune reserves Return for default actions.
                        .on_key(move |s, event, tx| {
                            if event.key != rune::Key::Enter {
                                return false;
                            }
                            on_enter(s, &enter, tx);
                            true
                        });
                    decorate(s, i, button)
                })
            }))
    });
    // Keep the last band separate so that even before it mounts its extent
    // reflects the short final band and the absence of a trailing gap.
    let last = (count - 1) / BAND * BAND;
    let full = build.clone();
    let bands = rune::col()
        .key("timeline-bands")
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            last / BAND,
            BAND as f32 * pitch,
            |_: &S, i| Cow::Owned(i.to_string()),
            move |s, i| full(s, i * BAND, BAND),
        )
        .virtual_rows_version(version);
    let tail = rune::col()
        .key("timeline-tail")
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            1,
            (count - last) as f32 * pitch - gap,
            |_: &S, _| Cow::Borrowed("tail"),
            move |s, _| build(s, last, count - last),
        );
    Some(rail.child(bands).child(tail))
}

fn button(dark: bool, marker: Marker<'_>) -> El {
    let t = tokens(dark);
    let metric = |name| t.metric("timelineMarker", name).px();
    let color = t.color(marker.tone);
    let highlight = t.color("selection-neutral-strong-bg");
    let border = metric("borderTopWidth");
    let mut button = rune::row()
        .role("button")
        .focusable(true)
        .label(marker.label.into_owned())
        .w_full()
        .h(metric("minHeight"))
        .center()
        .hover(highlight)
        .hover_group()
        .focus_ring(
            t.metric("timelineFocus", "ringWidth").px(),
            -t.metric("timelineFocus", "extent").px(),
            t.color("accent-primary"),
        )
        .child(
            rune::icon(marker.glyph, t.metric("timelineGlyph", "width").px())
                .color(color)
                .group_opacity(
                    if marker.active {
                        1.0
                    } else {
                        metric("opacity")
                    },
                    1.0,
                )
                .a11y_hidden(),
        );
    if marker.active {
        // Rune's native tree and DOM bridge expose descriptions for buttons.
        button = button
            .description_static(marker.current)
            .fill(highlight)
            .border(border, color);
    } else {
        button = button
            .child(
                rune::el()
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .border(border, color)
                    .group_opacity(0.0, 1.0)
                    .a11y_hidden(),
            )
            .child(
                rune::row()
                    .pin(Some(border), None, Some(border), Some(border))
                    .justify_center()
                    .group_opacity(metric("opacity"), 0.0)
                    .a11y_hidden()
                    .child(
                        rune::el()
                            .w_frac(metric("separatorFraction"))
                            .h(metric("separatorHeight"))
                            .fill(t.color("border-divider")),
                    ),
            );
    }
    button
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, GesturePhase, Runtime, WheelEvent};
    use std::cell::Cell;

    #[test]
    fn rail_wheel_override_preserves_same_frame_gestures_and_releases_next_gesture() {
        struct State {
            scroll: Rc<Cell<(Option<f32>, RailWheelOverride, rune::ScrollPos, bool)>>,
        }
        let scroll = Rc::new(Cell::new((
            None,
            RailWheelOverride::default(),
            rune::ScrollPos::default(),
            false,
        )));
        let view_fn = |s: &State, _cx: &mut rune::Cx<State>| {
            let wheel_scroll = s.scroll.clone();
            let offset_scroll = s.scroll.clone();
            let rail = rune::col()
                .key(VIEWPORT)
                .w(40.0)
                .h(120.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(rune::el().w(40.0).h(800.0))
                .on_wheel(move |_s: &mut State, event, tx| {
                    let (mut prog, mut wheel, at, _) = wheel_scroll.get();
                    let taken = wheel.apply(&mut prog, at, event, tx);
                    wheel_scroll.set((prog, wheel, at, taken));
                    taken
                })
                .on_scroll_offset(move |at| {
                    let (prog, mut wheel, _, taken) = offset_scroll.get();
                    wheel.clear_frame();
                    offset_scroll.set((prog, wheel, at, taken));
                });
            rune::col().w(40.0).h(120.0).child(rail)
        };
        let mut rt = Runtime::new(
            State {
                scroll: scroll.clone(),
            },
            view_fn,
            (40.0, 120.0),
            Env::new(false, 1.0),
        );
        rt.set_system_reduced_motion(true);
        rt.frame(0.0);
        rt.update(|_, tx| scroll_rail_to(300.0, tx));
        rt.frame(0.016);
        assert!((scroll.get().2.offset[1] - 300.0).abs() <= 0.5);

        // Colliding phased gesture: verify ownership & taken=true BEFORE Ended arrives.
        rt.update(|s, tx| {
            let (_, wheel, at, _) = s.scroll.get();
            scroll_rail_to(500.0, tx);
            s.scroll.set((Some(500.0), wheel, at, false));
        });
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Began),
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 80.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Moved),
        );
        rt.frame(0.016);
        assert!(
            (scroll.get().2.offset[1] - 220.0).abs() <= 1.0
                && scroll.get().1.is_owned()
                && scroll.get().3,
            "phased delta must override reveal and take ownership before Ended: {:?}",
            scroll.get().2
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Ended),
        );
        rt.frame(0.016);
        assert!(
            scroll.get().1.is_owned() && scroll.get().3,
            "phased Ended must transition to Ended state awaiting momentum"
        );

        // Wait past MOMENTUM_GAP (0.05 s) while still in Ended state, then send a fresh Began +
        // Moved (WITHOUT Ended) to prove RailWheelOverride returns false and Rune scrolls natively.
        rt.frame(0.06);
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Began),
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 30.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Moved),
        );
        rt.frame(0.016);
        assert!(
            (scroll.get().2.offset[1] - 190.0).abs() <= 1.0
                && !scroll.get().1.is_owned()
                && !scroll.get().3,
            "fresh gesture after MOMENTUM_GAP must pass through natively without ownership: {:?}",
            scroll.get().2
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Ended),
        );
        rt.frame(0.016);
        // Let the previous native gesture's 50 ms momentum window expire before starting a new one.
        rt.frame(0.06);

        // Same-frame momentum-chained follow-up: an intercepted gesture ends and a chained
        // gesture begins + moves in the SAME frame (within Rune's 50 ms momentum window) while
        // the first jump is still pending; both deltas must combine on the pending jump.
        rt.update(|s, tx| {
            let (_, wheel, at, _) = s.scroll.get();
            scroll_rail_to(500.0, tx);
            s.scroll.set((Some(500.0), wheel, at, false));
        });
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Began),
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 40.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Moved),
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Ended),
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Began),
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 25.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Moved),
        );
        rt.frame(0.016);
        assert!(
            (scroll.get().2.offset[1] - 125.0).abs() <= 1.0
                && scroll.get().1.is_owned()
                && scroll.get().3,
            "same-frame momentum-chained follow-up must accumulate on pending jump instead of being overwritten: {:?}",
            scroll.get().2
        );
        // Once the chained gesture ends and the 50 ms momentum window expires, a distinct new
        // gesture must release ownership and scroll natively.
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Ended),
        );
        rt.frame(0.016);
        rt.frame(0.06);
        rt.wheel_event(
            WheelEvent::new(0.0, 0.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Began),
        );
        rt.wheel_event(
            WheelEvent::new(0.0, 20.0)
                .at(20.0, 60.0)
                .phase(GesturePhase::Moved),
        );
        rt.frame(0.016);
        assert!(
            (scroll.get().2.offset[1] - 105.0).abs() <= 1.0
                && !scroll.get().1.is_owned()
                && !scroll.get().3,
            "distinct gesture after MOMENTUM_GAP must release ownership and scroll natively: {:?}",
            scroll.get().2
        );
    }

    #[test]
    fn rail_wheel_override_thresholds_and_momentum_handoff() {
        let mut at = rune::ScrollPos::default();
        at.offset = [0.0, 300.0];
        at.max = [0.0, 680.0];
        at.viewport = [40.0, 120.0];
        at.drawn = [40.0, 120.0];
        let t0 = rune::time::Instant::now();
        let stamp = |ms: u64| WheelStamp {
            clock: 10.0,
            input: Some(t0 + std::time::Duration::from_millis(ms)),
        };
        let mut tx = rune::Tx::default();

        // 1. Instant elapsed_since (forward, reversed saturating, and clock fallback).
        assert!((stamp(75).elapsed_since(stamp(0)) - 0.075).abs() < 1e-6);
        assert_eq!(stamp(0).elapsed_since(stamp(75)), 0.0);
        let clock_a = WheelStamp {
            clock: 1.0,
            input: None,
        };
        let clock_b = WheelStamp {
            clock: 3.5,
            input: None,
        };
        assert!((clock_b.elapsed_since(clock_a) - 2.5).abs() < 1e-6);

        // 2. Phased Ended -> momentum Began within 50 ms (49 ms) stays owned; momentum Ended releases.
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        assert!(!wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            stamp(0),
            &mut tx,
        ));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 40.0).phase(GesturePhase::Moved),
            stamp(10),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(260.0));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Ended),
            stamp(20),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(260.0));
        assert!(wheel.is_owned());
        wheel.clear_frame();
        let mut at_after_first = at;
        at_after_first.offset = [0.0, 260.0];
        let mut mom_began = WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began);
        mom_began.momentum = true;
        assert!(wheel.apply_at(&mut prog, at_after_first, mom_began, stamp(69), &mut tx));
        assert_eq!(wheel.target, Some(260.0));
        assert!(wheel.is_owned());
        let mut mom_moved = WheelEvent::new(0.0, 15.0).phase(GesturePhase::Moved);
        mom_moved.momentum = true;
        assert!(wheel.apply_at(&mut prog, at_after_first, mom_moved, stamp(80), &mut tx));
        assert_eq!(wheel.target, Some(245.0));
        let mut mom_moved2 = WheelEvent::new(0.0, 10.0).phase(GesturePhase::Moved);
        mom_moved2.momentum = true;
        assert!(wheel.apply_at(&mut prog, at_after_first, mom_moved2, stamp(85), &mut tx));
        assert_eq!(wheel.target, Some(235.0));
        assert!(wheel.is_owned());
        let mut mom_ended = WheelEvent::new(0.0, 0.0).phase(GesturePhase::Ended);
        mom_ended.momentum = true;
        assert!(wheel.apply_at(&mut prog, at_after_first, mom_ended, stamp(90), &mut tx));
        assert!(!wheel.is_owned());

        // 3. Phased Ended -> momentum Began AFTER 50 ms (51 ms) does NOT capture.
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            stamp(0),
            &mut tx,
        );
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            stamp(10),
            &mut tx,
        ));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Ended),
            stamp(20),
            &mut tx,
        ));
        wheel.clear_frame();
        let mut late_mom_began = WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began);
        late_mom_began.momentum = true;
        assert!(!wheel.apply_at(&mut prog, at, late_mom_began, stamp(71), &mut tx));
        assert!(!wheel.is_owned());

        // 4. Phased Ended -> non-momentum Began even at 10 ms releases immediately (next frame).
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            stamp(0),
            &mut tx,
        );
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            stamp(10),
            &mut tx,
        ));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Ended),
            stamp(20),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(!wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            stamp(30),
            &mut tx,
        ));
        assert!(!wheel.is_owned());

        // 5. Unphased WHEEL_IDLE (99 ms owned vs 101 ms released) and phased PHASED_IDLE (999 vs 1001 ms).
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        assert!(wheel.apply_at(&mut prog, at, WheelEvent::new(0.0, 20.0), stamp(0), &mut tx,));
        wheel.clear_frame();
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0),
            stamp(99),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(!wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0),
            stamp(200),
            &mut tx,
        ));
        assert!(!wheel.is_owned());

        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            stamp(0),
            &mut tx,
        );
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            stamp(10),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 10.0).phase(GesturePhase::Moved),
            stamp(1009),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(!wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 10.0).phase(GesturePhase::Moved),
            stamp(2010),
            &mut tx,
        ));
        assert!(!wheel.is_owned());

        // 6. Same-frame non-momentum Began + Moved after Ended (without clear_frame) must still
        // accumulate on self.target so the pending scroll_rail_to jump does not overwrite it.
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 40.0).phase(GesturePhase::Moved),
            stamp(0),
            &mut tx,
        ));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Ended),
            stamp(10),
            &mut tx,
        ));
        assert!(!wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            stamp(15),
            &mut tx,
        ));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 25.0).phase(GesturePhase::Moved),
            stamp(16),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(235.0));
        assert!(wheel.is_owned());

        // 7. Clamp-then-reverse in the same frame: clamping each delta (20 - 50 -> 0, then 0 - (-15) -> 15)
        // produces 15.0 rather than 0.0 (which clamping only the final sum would produce).
        let mut at_near_top = at;
        at_near_top.offset = [0.0, 20.0];
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        assert!(wheel.apply_at(
            &mut prog,
            at_near_top,
            WheelEvent::new(0.0, 50.0).phase(GesturePhase::Moved),
            stamp(0),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(0.0));
        assert!(wheel.apply_at(
            &mut prog,
            at_near_top,
            WheelEvent::new(0.0, -15.0).phase(GesturePhase::Moved),
            stamp(5),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(15.0));

        // 8a. Unphased precise wheel without Began uses WHEEL_IDLE (0.1 s), not PHASED_IDLE (1.0 s).
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        assert!(
            wheel.apply_at(
                &mut prog,
                at,
                WheelEvent::new(0.0, 20.0)
                    .phase(GesturePhase::Moved)
                    .precise(true),
                stamp(0),
                &mut tx,
            )
        );
        wheel.clear_frame();
        assert!(
            !wheel.apply_at(
                &mut prog,
                at,
                WheelEvent::new(0.0, 10.0)
                    .phase(GesturePhase::Moved)
                    .precise(true),
                stamp(101),
                &mut tx,
            )
        );
        assert!(!wheel.is_owned());

        // 8b. Peer-viewport Began observed via note_phase_at keeps rail Moved in PHASED_IDLE (1.0 s),
        // and peer Ended resets phased so a later unphased burst expires at WHEEL_IDLE (0.1 s).
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        wheel.note_phase_at(GesturePhase::Began, stamp(0));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            stamp(10),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 10.0).phase(GesturePhase::Moved),
            stamp(510),
            &mut tx,
        ));
        assert!(wheel.is_owned());
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        wheel.note_phase_at(GesturePhase::Began, stamp(0));
        wheel.note_phase_at(GesturePhase::Ended, stamp(10));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            stamp(20),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(!wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 10.0).phase(GesturePhase::Moved),
            stamp(125),
            &mut tx,
        ));
        assert!(!wheel.is_owned());

        // 9. contains_point uses presented drawn geometry (during animated shrink), and moving
        // outside presented bounds releases ownership immediately.
        let mut at_shrinking = at;
        at_shrinking.viewport = [40.0, 80.0];
        at_shrinking.drawn = [40.0, 120.0];
        assert!(RailWheelOverride::contains_point(at_shrinking, 20.0, 100.0));
        assert!(!RailWheelOverride::contains_point(
            at_shrinking,
            -10.0,
            60.0
        ));
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        assert!(
            wheel.apply_at(
                &mut prog,
                at_shrinking,
                WheelEvent::new(0.0, 20.0)
                    .at(20.0, 100.0)
                    .phase(GesturePhase::Moved),
                stamp(0),
                &mut tx,
            )
        );
        assert!(wheel.is_owned());
        assert!(
            !wheel.apply_at(
                &mut prog,
                at_shrinking,
                WheelEvent::new(0.0, 10.0)
                    .at(-10.0, 60.0)
                    .phase(GesturePhase::Moved),
                stamp(10),
                &mut tx,
            )
        );
        assert!(!wheel.is_owned());

        // 10. Clock-only fallback (headless Runtime, input: None) enforces exact 50 ms MOMENTUM_GAP.
        let cstamp = |secs: f64| WheelStamp {
            clock: secs,
            input: None,
        };
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            cstamp(1.0),
            &mut tx,
        );
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            cstamp(1.01),
            &mut tx,
        ));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Ended),
            cstamp(1.02),
            &mut tx,
        ));
        wheel.clear_frame();
        let mut mom_began = WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began);
        mom_began.momentum = true;
        assert!(wheel.apply_at(&mut prog, at, mom_began, cstamp(1.069), &mut tx));
        assert!(wheel.is_owned());
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Began),
            cstamp(1.0),
            &mut tx,
        );
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            cstamp(1.01),
            &mut tx,
        ));
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 0.0).phase(GesturePhase::Ended),
            cstamp(1.02),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(!wheel.apply_at(&mut prog, at, mom_began, cstamp(1.071), &mut tx));
        assert!(!wheel.is_owned());

        // 11. Same-frame rail -> outside (forward_outside_at) -> rail preserves accumulated target;
        // clear_frame() on a later frame resets target to start from the updated offset.
        let mut wheel = RailWheelOverride::default();
        let mut prog = Some(500.0);
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 40.0).phase(GesturePhase::Moved),
            stamp(0),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(260.0));
        assert!(
            wheel.forward_outside_at(
                WheelEvent::new(0.0, 30.0)
                    .at(-20.0, 50.0)
                    .phase(GesturePhase::Moved),
                stamp(2),
            )
        );
        assert!(wheel.apply_at(
            &mut prog,
            at,
            WheelEvent::new(0.0, 25.0).phase(GesturePhase::Moved),
            stamp(4),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(235.0));
        wheel.clear_frame();
        let mut at_next = at;
        at_next.offset = [0.0, 235.0];
        assert!(
            wheel.forward_outside_at(
                WheelEvent::new(0.0, 15.0)
                    .at(-20.0, 50.0)
                    .phase(GesturePhase::Moved),
                stamp(20),
            )
        );
        assert!(wheel.apply_at(
            &mut prog,
            at_next,
            WheelEvent::new(0.0, 10.0).phase(GesturePhase::Moved),
            stamp(22),
            &mut tx,
        ));
        assert_eq!(wheel.target, Some(225.0));

        // 12. Unobserved Began on another element before Moved claims the rail: an outside Moved
        // arriving after WHEEL_IDLE (0.1 s) but within PHASED_IDLE (1.0 s) is promoted to Phased
        // because Rune's WheelOwner::Handler only routes outside events while the gesture lives;
        // past PHASED_IDLE it expires.
        let mut wheel = RailWheelOverride::default();
        let mut prog = None;
        assert!(wheel.apply_at_inner(
            &mut prog,
            at,
            WheelEvent::new(0.0, 20.0).phase(GesturePhase::Moved),
            true,
            stamp(0),
            &mut tx,
        ));
        wheel.clear_frame();
        assert!(
            wheel.forward_outside_at(
                WheelEvent::new(0.0, 15.0)
                    .at(-20.0, 50.0)
                    .phase(GesturePhase::Moved),
                stamp(200),
            )
        );
        assert!(wheel.is_owned());
        assert!(
            !wheel.forward_outside_at(
                WheelEvent::new(0.0, 10.0)
                    .at(-20.0, 50.0)
                    .phase(GesturePhase::Moved),
                stamp(1250),
            )
        );
        assert!(!wheel.is_owned());
    }
}
