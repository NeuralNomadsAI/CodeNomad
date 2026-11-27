use super::*;

#[test]
fn touch_pan_on_rail_enters_browse_mode_without_snapping_back() {
    let mut s = crate::init();
    s.messages = (0..40).map(|i| user(&format!("tp-{i}"))).collect();
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 360.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let offset_before = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_before > 200.0 && !owner(&mut rt.state).jump.is_browsing(),
        "rail must start scrolled toward bottom and not browsing: {offset_before}"
    );
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let x = rail[0] + rail[2] / 2.0;
    let y0 = rail[1] + 40.0;
    rt.touch(1, TouchPhase::Started, x, y0, 1.0);
    for step in 1..=10 {
        rt.touch(
            1,
            TouchPhase::Moved,
            x,
            y0 + step as f32 * 18.0,
            1.0 + step as f64 * 0.016,
        );
        // Force an instant commit on the same frame to distinguish rail_scrolled() from user_scrolled().
        rt.update(|_, tx| tx.instant());
        rt.frame(0.016);
    }
    rt.touch(1, TouchPhase::Ended, x, y0 + 180.0, 1.35);
    for _ in 0..20 {
        rt.frame(0.016);
    }
    let offset_after_pan = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_after_pan < offset_before - 80.0 && owner(&mut rt.state).jump.is_browsing(),
        "touch pan on the rail must scroll upward and enter browse mode via on_scroll_offset: before={offset_before}, after={offset_after_pan}"
    );
    // Showing a banner shrinks the rail; browse mode must keep the manually panned position.
    rt.update(|s, _| owner(s).outline_error = true);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let offset_after_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).jump.is_browsing()
            && (offset_after_banner - offset_after_pan).abs() <= 1.0,
        "banner resize must not snap a touch-browsed rail back to the active marker: panned={offset_after_pan}, after={offset_after_banner}"
    );
    // Unmounting the rail (narrowing below TIMELINE_MIN_WIDTH) discards Rune's scroll state, so
    // browse mode must clear and widening back must re-reveal the active marker instead of 0.0.
    rt.set_viewport((419.0, 360.0), 1.0);
    for _ in 0..20 {
        rt.frame(0.016);
    }
    assert!(
        rt.presented("timeline").is_none() && !owner(&mut rt.state).jump.is_browsing(),
        "unmounting the rail must clear browse mode: presented={:?}, browsing={}",
        rt.presented("timeline"),
        owner(&mut rt.state).jump.is_browsing()
    );
    rt.set_viewport((800.0, 360.0), 1.0);
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail_after_remount = rt.presented("timeline").expect("timeline remounted").0;
    let active_key = owner(&mut rt.state)
        .jump
        .active
        .clone()
        .expect("active marker after remount");
    let active_visible = rt.elements().into_iter().any(|n| {
        n.key.as_deref() == Some(active_key.as_str())
            && n.visible[2] > 0.0
            && n.visible[3] > 0.0
            && n.rect[1] >= rail_after_remount[1] - 1.0
            && n.rect[1] + n.rect[3] <= rail_after_remount[1] + rail_after_remount[3] + 1.0
    });
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 100.0 && active_visible,
        "remounting a previously browsed rail must re-reveal active marker {active_key}"
    );

    // Concurrent touch pan arriving right before a pending reveal_active must NOT be overwritten
    // and must transition into browse mode.
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let x = rail[0] + rail[2] / 2.0;
    let y0 = rail[1] + 40.0;
    let offset_before_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_before_race > 200.0 && !owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail near bottom and not browsing before touch/reveal race"
    );
    // Arm an off-screen active target (tp-0 at top, offset 0) without polling yet so the next
    // poll() frame calls reveal_active() -> glide_rail_to() on the exact frame the touch pan arrives.
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    assert_eq!(
        rune_theme_codenomad::timeline::reveal_target(0, owner(&mut rt.state).scroll.get().at),
        Some(0.0),
        "precondition: tp-0 reveal target must be 0.0 before touch/reveal race"
    );
    rt.poll = Some(crate::poll);
    rt.touch(2, TouchPhase::Started, x, y0, 3.0);
    rt.touch(2, TouchPhase::Moved, x, y0 + 20.0, 3.016);
    rt.touch(2, TouchPhase::Moved, x, y0 + 90.0, 3.032);
    rt.frame(0.016);
    let during_race = owner(&mut rt.state).scroll.get().at.offset[1];
    let touch_glide_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    rt.touch(2, TouchPhase::Ended, x, y0 + 90.0, 3.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        !touch_glide_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && during_race >= 200.0
            && (after_race - during_race).abs() <= 5.0,
        "same-frame headless touch/reveal race must defer reveal without snapping to 0.0 and enter browse mode: interrupted={touch_glide_interrupted}, before={offset_before_race}, during={during_race}, after={after_race}"
    );
    // Mid-glide touch pan: once a reveal glide is already in-flight, a touch pan must interrupt
    // the glide, enter browse mode, and preserve its ~82px pan displacement with no snap/clamp.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_glide_before_touch = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0) && mid_glide_before_touch > 120.0,
        "precondition: reveal glide must be mid-flight before mid-glide touch pan: offset={mid_glide_before_touch}"
    );
    rt.touch(4, TouchPhase::Started, x, y0, 4.0);
    rt.touch(4, TouchPhase::Moved, x, y0 + 20.0, 4.016);
    rt.touch(4, TouchPhase::Moved, x, y0 + 90.0, 4.032);
    rt.frame(0.016);
    let during_mid_touch = owner(&mut rt.state).scroll.get().at.offset[1];
    let mid_touch_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    rt.touch(4, TouchPhase::Ended, x, y0 + 90.0, 4.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_mid_touch = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        mid_touch_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && ((mid_glide_before_touch - during_mid_touch) - 82.0).abs() <= 12.0
            && (after_mid_touch - during_mid_touch).abs() <= 5.0,
        "mid-glide touch pan must interrupt the glide and preserve its ~82px displacement: interrupted={mid_touch_interrupted}, before={mid_glide_before_touch}, during={during_mid_touch}, after={after_mid_touch}"
    );

    // Concurrent WheelOwner::Vertical burst crossing from transcript onto the rail right before a
    // reveal must also enter browse mode and halt the interrupted reveal glide cleanly.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let hist = rt.presented("history").expect("history presented").0;
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 200.0
            && !owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail at bottom before WheelOwner::Vertical race"
    );
    // Latch WheelOwner::Vertical on history first.
    rt.wheel_xy(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 0.0, 20.0);
    rt.frame(0.016);
    // Arm an off-screen active marker (tp-0) without polling yet, then send a continuing vertical
    // wheel tick directly on the rail (within WHEEL_IDLE) so Rune moves the rail pre-poll right
    // before reveal_active fires.
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    assert_eq!(
        rune_theme_codenomad::timeline::reveal_target(0, owner(&mut rt.state).scroll.get().at),
        Some(0.0),
        "precondition: tp-0 reveal target must be 0.0 before WheelOwner::Vertical race"
    );
    let before_wheel_race = owner(&mut rt.state).scroll.get().at.offset[1];
    rt.poll = Some(crate::poll);
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, 50.0);
    rt.frame(0.016);
    let wheel_glide_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let after_wheel_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        wheel_glide_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && after_wheel_race >= 200.0
            && after_wheel_race < rail[3] * 2.0,
        "same-frame headless WheelOwner::Vertical race must interrupt the glide without snapping to 0.0 and enter browse mode: interrupted={wheel_glide_interrupted}, before={before_wheel_race}, after={after_wheel_race}"
    );
    // Mid-glide WheelOwner::Vertical burst: once a reveal glide is already in-flight, a continuing
    // vertical wheel tick crossing from history onto the rail must interrupt the glide and preserve
    // its ~50px wheel delta with no snap/clamp.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    rt.wheel_xy(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 0.0, 20.0);
    rt.frame(0.016);
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_before_wheel = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0) && mid_before_wheel > 100.0,
        "precondition: reveal glide must be mid-flight before mid-glide WheelOwner::Vertical tick: offset={mid_before_wheel}"
    );
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, 50.0);
    rt.frame(0.016);
    let mid_wheel_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let after_mid_wheel = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        mid_wheel_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && (after_mid_wheel - (mid_before_wheel - 50.0)).abs() <= 15.0,
        "mid-glide WheelOwner::Vertical tick must interrupt the glide and preserve its ~50px wheel delta: interrupted={mid_wheel_interrupted}, before={mid_before_wheel}, after={after_mid_wheel}"
    );

    // A non-timeline subsystem (search::poll) returning changed=true on the same crate::poll frame
    // causes main.rs to call tx.instant(); poll_reveal must defer on that frame so a concurrent
    // touch pan is never overwritten by a snapped glide.
    static TRACKED_POLL_CHANGED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static TRACKED_POLL_CALLS: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);
    fn tracked_poll(s: &mut State, now: f64, tx: &mut rune::Tx) -> bool {
        let changed = crate::poll(s, now, tx);
        TRACKED_POLL_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        TRACKED_POLL_CHANGED.fetch_or(changed, std::sync::atomic::Ordering::SeqCst);
        changed
    }
    rt.update(|s, tx| {
        owner(s).backend = Some(codenomad_client::backend::Backend {
            client: codenomad_client::http::Http::new().unwrap(),
            base: "http://127.0.0.1:9/".into(),
            workspace: "w".into(),
            session: "s".into(),
            client_id: "c".into(),
            session_directory: None,
            fresh_mode: false,
        });
        navigation::select(s, "tp-39:User:0:false", tx);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let before_instant_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        before_instant_race > 200.0 && !owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail near bottom before search::poll changed=true deferral check"
    );
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.update(|s, _| search::deliver_result(s));
    TRACKED_POLL_CHANGED.store(false, std::sync::atomic::Ordering::SeqCst);
    rt.poll = Some(tracked_poll);
    rt.touch(3, TouchPhase::Started, x, y0, 5.0);
    rt.touch(3, TouchPhase::Moved, x, y0 + 20.0, 5.016);
    rt.touch(3, TouchPhase::Moved, x, y0 + 90.0, 5.032);
    rt.frame(0.016);
    let early_poll_changed = TRACKED_POLL_CHANGED.load(std::sync::atomic::Ordering::SeqCst);
    let early_scroll = owner(&mut rt.state).scroll.get();
    let during_instant_race = early_scroll.at.offset[1];
    let deferred_on_instant = early_scroll.programmatic_rail.is_none()
        && early_scroll.rail_glide.is_none()
        && !early_scroll.rail_glide_interrupted;
    rt.poll = Some(crate::poll);
    rt.touch(3, TouchPhase::Ended, x, y0 + 90.0, 5.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_instant_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        early_poll_changed
            && deferred_on_instant
            && owner(&mut rt.state).jump.is_browsing()
            && during_instant_race < before_instant_race - 50.0
            && (after_instant_race - during_instant_race).abs() <= 5.0,
        "poll_reveal must defer when search::poll causes crate::poll to call tx.instant(): changed={early_poll_changed}, deferred={deferred_on_instant}, interrupted={}, before={before_instant_race}, during={during_instant_race}, after={after_instant_race}",
        early_scroll.rail_glide_interrupted
    );
    rt.update(|s, _| search::close(s));
    rt.frame(0.016);

    // Changing target mid-glide must halt Rune's in-flight glide instead of letting it run to the
    // obsolete aim: (a) clearing active via seek_message to a distant hit, and (b) switching active
    // to a marker already visible in the current rail viewport.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let start_halt_a = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(start_halt_a > 200.0 && !owner(&mut rt.state).jump.is_browsing());
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_halt_a = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0)
            && mid_halt_a > 60.0
            && mid_halt_a < start_halt_a - 1.0,
        "precondition: glide toward tp-0 must be mid-flight before seek_message: start={start_halt_a}, mid={mid_halt_a}, glide={:?}",
        owner(&mut rt.state).scroll.get().rail_glide
    );
    let (halt_cmd_tx, _halt_cmd_rx) = codenomad_client::bounded(4);
    rt.update(|s, tx| {
        s.commands = Some(halt_cmd_tx);
        owner(s).online = true;
        navigation::seek_message(s, "distant-search-hit", tx);
    });
    assert!(
        owner(&mut rt.state).jump.active.is_none(),
        "precondition: seek_message to distant hit must clear active"
    );
    for _ in 0..40 {
        rt.frame(0.016);
    }
    let end_halt_a = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && end_halt_a > 50.0
            && (end_halt_a - mid_halt_a).abs() <= 25.0,
        "clearing active mid-glide via seek_message must halt the obsolete Rune glide instead of reaching 0.0: mid={mid_halt_a}, end={end_halt_a}"
    );

    // (b) Switching active to a marker already visible at the current mid-glide position must also
    // halt the obsolete glide.
    rt.update(|s, tx| {
        navigation::cancel_search(s);
        navigation::select(s, "tp-39:User:0:false", tx);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let start_halt_b = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(start_halt_b > 200.0 && !owner(&mut rt.state).jump.is_browsing());
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_at_b = owner(&mut rt.state).scroll.get().at;
    let mid_halt_b = mid_at_b.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0)
            && mid_halt_b > 60.0
            && mid_halt_b < start_halt_b - 1.0,
        "precondition: glide toward tp-0 must be mid-flight before switching to visible marker: start={start_halt_b}, mid={mid_halt_b}"
    );
    let visible_idx = (0..40)
        .find(|&idx| rune_theme_codenomad::timeline::reveal_target(idx, mid_at_b).is_none())
        .expect("a marker already visible at mid-glide offset");
    rt.update(|s, tx| {
        navigation::select(s, &format!("tp-{visible_idx}:User:0:false"), tx);
    });
    for _ in 0..40 {
        rt.frame(0.016);
    }
    let end_halt_b = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && end_halt_b > 50.0
            && (end_halt_b - mid_halt_b).abs() <= 25.0,
        "switching active mid-glide to an already-visible marker must halt the obsolete glide: mid={mid_halt_b}, end={end_halt_b}"
    );

    // Late-subsystem changed=true (shell::notifications::poll at the tail of crate::poll, after
    // Display::poll / files::poll / git::poll) must STILL defer poll_reveal on that tx.instant() frame.
    // Settle the notification settings fixture first and verify a quiet frame reports changed=false
    // so only shell::notifications::poll produces changed=true on the tested frame.
    rt.update(|s, tx| {
        crate::settings::notification_fixture(s);
        crate::settings::notification_test_config(s, None);
        navigation::select(s, "tp-39:User:0:false", tx);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    TRACKED_POLL_CALLS.store(0, std::sync::atomic::Ordering::SeqCst);
    TRACKED_POLL_CHANGED.store(false, std::sync::atomic::Ordering::SeqCst);
    rt.poll = Some(tracked_poll);
    rt.frame(0.016);
    assert!(
        TRACKED_POLL_CALLS.load(std::sync::atomic::Ordering::SeqCst) > 0
            && !TRACKED_POLL_CHANGED.load(std::sync::atomic::Ordering::SeqCst),
        "precondition: settings::poll and all earlier subsystems must be quiet (changed=false) before emitting notification"
    );
    rt.poll = Some(crate::poll);
    let before_late_instant = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(before_late_instant > 200.0 && !owner(&mut rt.state).jump.is_browsing());
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.update(|s, _| {
        crate::shell::notifications::emit_outcome(
            s,
            crate::shell::notifications::Category::Settings,
            None,
            "late-poll-change",
            true,
        );
    });
    TRACKED_POLL_CHANGED.store(false, std::sync::atomic::Ordering::SeqCst);
    rt.poll = Some(tracked_poll);
    rt.touch(5, TouchPhase::Started, x, y0, 6.0);
    rt.touch(5, TouchPhase::Moved, x, y0 + 20.0, 6.016);
    rt.touch(5, TouchPhase::Moved, x, y0 + 90.0, 6.032);
    rt.frame(0.016);
    let late_poll_changed = TRACKED_POLL_CHANGED.load(std::sync::atomic::Ordering::SeqCst);
    let late_scroll = owner(&mut rt.state).scroll.get();
    let during_late_instant = late_scroll.at.offset[1];
    let deferred_on_late_instant = late_scroll.programmatic_rail.is_none()
        && late_scroll.rail_glide.is_none()
        && !late_scroll.rail_glide_interrupted;
    rt.poll = Some(crate::poll);
    rt.touch(5, TouchPhase::Ended, x, y0 + 90.0, 6.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_late_instant = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        late_poll_changed
            && deferred_on_late_instant
            && owner(&mut rt.state).jump.is_browsing()
            && during_late_instant < before_late_instant - 50.0
            && (after_late_instant - during_late_instant).abs() <= 5.0,
        "poll_reveal must defer when a late subsystem (shell::notifications::poll) causes crate::poll to call tx.instant(): changed={late_poll_changed}, deferred={deferred_on_late_instant}, interrupted={}, before={before_late_instant}, during={during_late_instant}, after={after_late_instant}",
        late_scroll.rail_glide_interrupted
    );

    // Zero-drag touch tap on the rail mid-glide halts Rune's glide without changing offset; the
    // stall watchdog must detect the halted glide and resume revealing the active marker.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    rt.frame(0.016);
    let glide_wake_origin = rt.clock;
    rt.frame(0.016);
    let mid_tap = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0) && mid_tap > 80.0,
        "precondition: reveal glide toward tp-0 must be mid-flight before zero-drag tap: offset={mid_tap}"
    );
    // Tap strictly in a gap between rail markers (outside every marker button rect) without dragging.
    let mut rail_buttons: Vec<[f32; 4]> = rt
        .elements()
        .into_iter()
        .filter(|n| {
            n.path.contains("/timeline/")
                && n.role == "button"
                && n.visible[2] > 0.0
                && n.visible[3] > 0.0
        })
        .map(|n| n.rect)
        .collect();
    rail_buttons.sort_by(|a, b| a[1].total_cmp(&b[1]));
    let tap_y = rail_buttons
        .windows(2)
        .find_map(|pair| {
            let gap = pair[1][1] - (pair[0][1] + pair[0][3]);
            let mid = pair[0][1] + pair[0][3] + gap / 2.0;
            (gap >= 1.0 && mid >= rail[1] + 1.0 && mid <= rail[1] + rail[3] - 1.0).then_some(mid)
        })
        .expect("visible gap between two adjacent rail marker buttons");
    assert!(
        rail_buttons
            .iter()
            .all(|b| { !(x >= b[0] && x <= b[0] + b[2] && tap_y >= b[1] && tap_y <= b[1] + b[3]) }),
        "precondition: tap point ({x}, {tap_y}) must lie in the gap between rail markers"
    );
    rt.touch(6, TouchPhase::Started, x, tap_y, 7.0);
    rt.touch(6, TouchPhase::Ended, x, tap_y, 7.032);
    rt.frame(0.016);
    let stalled_after_tap = owner(&mut rt.state).scroll.get().at.offset[1];
    let stall_wake = rt.wake_deadline().expect("50ms watchdog wake scheduled");
    let stall_dt = stall_wake - rt.clock;
    let watchdog_cadence = stall_wake - glide_wake_origin;
    assert!(
        !rt.animating
            && stalled_after_tap > 80.0
            && stall_dt > 0.0
            && stall_dt <= 0.055
            && (watchdog_cadence - 0.050).abs() <= 0.001,
        "zero-drag tap must stall mid-flight (!animating) on the exact 50ms watchdog schedule (not 1ms, 30ms, or 500ms long-press): animating={}, offset={stalled_after_tap}, dt={stall_dt}, cadence={watchdog_cadence}",
        rt.animating
    );
    // Advance strictly via the 50ms watchdog wakes until the watchdog itself restarts the glide.
    let mut watchdog_wakes = 0usize;
    let mut restarted = false;
    for _ in 0..80 {
        let off = owner(&mut rt.state).scroll.get().at.offset[1];
        if off <= 1.0 {
            break;
        }
        if rt.animating {
            if watchdog_wakes > 0 && !restarted {
                restarted = true;
            }
            rt.frame(0.016);
        } else if let Some(deadline) = rt.wake_deadline() {
            let dt = deadline - rt.clock;
            if watchdog_wakes == 0 {
                assert!(
                    (deadline - glide_wake_origin - 0.050).abs() <= 0.001,
                    "first stall watchdog wake must land at exact +50ms from glide_wake_origin: cadence={}",
                    deadline - glide_wake_origin
                );
            } else {
                assert!(
                    (dt - 0.050).abs() <= 0.001,
                    "follow-up stall watchdog wake must keep an exact 50ms cadence: dt={dt}"
                );
            }
            watchdog_wakes += 1;
            rt.frame(dt.max(0.016));
        } else {
            panic!(
                "stall watchdog stopped scheduling wakes before rail reached tp-0: offset={off}"
            );
        }
    }
    let after_tap_recovery = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        watchdog_wakes >= 1
            && restarted
            && !owner(&mut rt.state).jump.is_browsing()
            && after_tap_recovery <= 1.0,
        "zero-drag touch tap mid-glide must recover via 50ms watchdog wakes and finish revealing tp-0: wakes={watchdog_wakes}, cadence={watchdog_cadence}, restarted={restarted}, mid={mid_tap}, stalled={stalled_after_tap}, after={after_tap_recovery}"
    );

    // Distant jump in flight: a vertical wheel burst starting on the rail must be claimed by
    // RailWheelOverride (WheelOwner::Handler, never WheelOwner::Vertical), so crossing onto the
    // transcript immediately cancels the distant jump and rejects its late admit_window.
    let (claim_tx, claim_rx) = codenomad_client::bounded(4);
    rt.update(|s, tx| {
        s.commands = Some(claim_tx);
        owner(s).online = true;
        navigation::seek_message(s, "distant-claimed", tx);
    });
    let (claim_ticket, claim_cancelled) = match claim_rx.try_recv().expect("distant jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let hist = rt.presented("history").expect("history presented").0;
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, -30.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.has_flight(),
        "wheel starting on rail during an in-flight distant jump must be claimed by RailWheelOverride while keeping flight alive"
    );
    rt.wheel_xy(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 0.0, 40.0);
    rt.frame(0.016);
    let mut claim_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        claim_ticket,
        crate::history::Page {
            rows: vec![user("distant-claimed")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            claim_accepted = true;
            true
        },
    );
    assert!(
        claim_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && !claim_accepted
            && rt.state.messages.iter().all(|m| m.id != "distant-claimed"),
        "drifting a rail wheel burst onto the transcript during a distant jump must cancel the jump and reject late admission"
    );

    // Successful resident search jump while history-search is open locks with no rail marker;
    // closing search via Escape without scrolling must unlock the rail and immediately highlight
    // the reading line's active marker again.
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: !cfg!(target_os = "macos"),
                    cmd: true,
                    logo: cfg!(target_os = "macos"),
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    for _ in 0..3 {
        rt.frame(0.016);
    }
    assert!(search::is_open(&rt.state));
    rt.update(|s, tx| navigation::seek_message(s, "tp-10", tx));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.is_none(),
        "precondition: successful search jump while search is open locks without a rail marker"
    );
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Escape,
                mods: rune::Mods::default(),
            },
            tx,
        ));
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !search::is_open(&rt.state)
            && !owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("tp-10:User:0:false"),
        "closing open search via Escape after a successful jump must unlock the rail and restore active marker tp-10: open={}, locked={}, active={:?}",
        search::is_open(&rt.state),
        owner(&mut rt.state).jump.is_locked(),
        owner(&mut rt.state).jump.active
    );
}
