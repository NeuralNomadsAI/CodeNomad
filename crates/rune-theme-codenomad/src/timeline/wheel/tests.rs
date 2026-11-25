use super::*;
use crate::timeline::{VIEWPORT, scroll_rail_to};
use rune::{Env, GesturePhase, Runtime, ScrollSpec, WheelEvent};
use std::{cell::Cell, rc::Rc};

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
    // Ending the chained momentum gesture immediately releases ownership before any next gesture.
    rt.wheel_event(
        WheelEvent::new(0.0, 0.0)
            .at(20.0, 60.0)
            .phase(GesturePhase::Ended),
    );
    rt.frame(0.016);
    assert!(
        !scroll.get().1.is_owned(),
        "momentum Ended must immediately release ownership before any subsequent Began"
    );
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
        "subsequent gesture after momentum Ended must release ownership and scroll natively: {:?}",
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
