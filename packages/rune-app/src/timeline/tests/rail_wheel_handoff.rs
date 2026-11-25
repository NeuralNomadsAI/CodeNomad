use super::*;

#[test]
fn same_frame_rail_then_transcript_wheel_clears_browse() {
    let mut s = crate::init();
    s.messages = (0..30).map(|i| user(&format!("row-{i}"))).collect();
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| {
        s.paging = true;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 300.0);
        let mut sc = owner(s).scroll.get();
        sc.programmatic_rail = Some(200.0);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(200.0, tx);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let rail_before = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(rail_before > 50.0 && hist_before > 100.0);
    // In a single frame during pagination, wheel on rail first, then drift onto transcript.
    // Even though on_scroll_offset fires in DOM order (history before timeline), wheel_last_rail
    // must preserve chronological order and clear browse.
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        -40.0,
    );
    rt.frame(0.016);
    rt.frame(0.016);
    let rail_after = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (rail_before - rail_after) > 20.0
            && (hist_after - hist_before) > 20.0
            && !owner(&mut rt.state).jump.is_browsing(),
        "same-frame rail -> transcript wheel during pagination must clear browse despite DOM scroll order: rail={rail_before}->{rail_after}, hist={hist_before}->{hist_after}, browse={}",
        owner(&mut rt.state).jump.is_browsing()
    );
}

#[test]
fn rail_arrival_does_not_overwrite_queued_transcript_wheel() {
    let mut s = crate::init();
    let long_intro = "Reflowing opening paragraph with plenty of words so toggling the rail wraps onto extra lines. ".repeat(18);
    let second_block = "Second paragraph below the opening text. ".repeat(10);
    let tail_block = "Trailing text below the second block. ".repeat(16);
    let long_msg: crate::history::Row = crate::history::decode_message(&json!({
        "id": "long-msg",
        "type": "assistant",
        "time": { "completed": 1 },
        "content": [
            { "type": "text", "text": long_intro },
            { "type": "text", "text": second_block },
            { "type": "text", "text": tail_block }
        ]
    }))
    .unwrap()
    .into();
    s.messages = vec![user("head"), long_msg, user("tail")];
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    // Simulate the rail being absent before an outline/marker update arrives (settings::poll settled).
    rt.update(|s, _| {
        let t = owner(s);
        t.markers.clear();
        t.has_raw_markers = false;
        t.changed = false;
        t.refresh = false;
    });
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_none());
    let hist_rect = rt.presented("history").expect("history presented").0;
    let frag1_before = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented")
        .0;
    let offset_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        offset_before > 100.0 && (frag1_before[1] - hist_rect[1]).abs() <= 2.0,
        "precondition: fragment-long-msg:1 aligned at top before rail arrival: offset={offset_before}, rel={}",
        frag1_before[1] - hist_rect[1]
    );
    // First verify the control case (input_waiting=false): rail arrival calls keep_passage and
    // snaps fragment-long-msg:1 back to rel=0 even if a wheel notch arrives on the same frame.
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, false));
    rt.update(|s, _| {
        owner(s).changed = true;
        owner(s).index_changed = true;
    });
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        60.0,
    );
    rt.frame(0.016);
    let hist_ctrl = rt.presented("history").expect("history presented").0;
    let frag1_ctrl = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented after control arrival")
        .0;
    assert!(
        rt.presented("timeline").is_some() && (frag1_ctrl[1] - hist_ctrl[1]).abs() <= 2.0,
        "control: without input_waiting, rail arrival snaps fragment-long-msg:1 back to rel=0: rel={}",
        frag1_ctrl[1] - hist_ctrl[1]
    );
    // Expire Rune's 100 ms unphased wheel burst window, reset to rail-absent state, re-verify
    // fragment-long-msg:1 alignment at top, then repeat with input_waiting=true (as Rune's
    // native/web hosts set when wheel input is queued): timeline::poll must skip keep_passage so
    // the user's upward wheel moves history (~60px).
    rt.poll = Some(crate::poll);
    for _ in 0..8 {
        rt.frame(0.02);
    }
    rt.update(|s, tx| {
        let t = owner(s);
        t.markers.clear();
        t.has_raw_markers = false;
        t.changed = false;
        t.refresh = false;
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..3 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_none());
    let hist_rect = rt.presented("history").expect("history presented").0;
    let frag1_before_2 = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented before guarded arrival")
        .0;
    let offset_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        offset_before > 100.0 && (frag1_before_2[1] - hist_rect[1]).abs() <= 2.0,
        "precondition: fragment-long-msg:1 re-aligned at top after 160ms wheel gap: offset={offset_before}, rel={}",
        frag1_before_2[1] - hist_rect[1]
    );
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, true));
    rt.update(|s, _| {
        owner(s).changed = true;
        owner(s).index_changed = true;
    });
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        60.0,
    );
    rt.frame(0.016);
    let hist_after = rt.presented("history").expect("history presented").0;
    let frag1_after = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented after arrival")
        .0;
    let offset_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rel_after = frag1_after[1] - hist_after[1];
    assert!(
        rt.presented("timeline").is_some()
            && (offset_before - offset_after) >= 30.0
            && rel_after >= 40.0,
        "rail arrival with queued transcript wheel (input_waiting=true) must not overwrite user scroll with keep_passage: shown={}, offset={offset_before}->{offset_after}, rel_after={rel_after}",
        rt.presented("timeline").is_some()
    );

    // Also verify on_layout_tx threshold crossing honors poll_input_waiting: narrowing 500 -> 419px
    // on the same frame a wheel notch is queued must skip keep_passage so the user's wheel moves
    // history upward instead of snapping fragment-long-msg:1 back to rel=0.
    rt.poll = Some(crate::poll);
    for _ in 0..8 {
        rt.frame(0.02);
    }
    rt.set_viewport((500.0, 320.0), 1.0);
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_some());
    let hist_500 = rt.presented("history").expect("history presented").0;
    let frag1_500 = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented at 500px")
        .0;
    assert!(
        (frag1_500[1] - hist_500[1]).abs() <= 2.0,
        "precondition: fragment-long-msg:1 aligned at top at 500px before narrowing: rel={}",
        frag1_500[1] - hist_500[1]
    );
    // Frame 1 measures 419px and enqueues Action::Layout(419).
    rt.set_viewport((419.0, 320.0), 1.0);
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_some());
    let hist_pre_narrow = rt.presented("history").expect("history presented").0;
    let offset_pre_narrow = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(offset_pre_narrow > 100.0);
    // Frame 2 drains poll (setting poll_input_waiting=true), then Action::Layout(419) and wheel.
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, true));
    rt.wheel_xy(
        hist_pre_narrow[0] + hist_pre_narrow[2] / 2.0,
        hist_pre_narrow[1] + hist_pre_narrow[3] / 2.0,
        0.0,
        60.0,
    );
    rt.frame(0.016);
    let hist_post_narrow = rt.presented("history").expect("history presented").0;
    let frag1_post_narrow = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented after narrow with wheel")
        .0;
    let offset_post_narrow = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rel_post_narrow = frag1_post_narrow[1] - hist_post_narrow[1];
    assert!(
        !super::demanded(&rt.state)
            && !owner(&mut rt.state).rail_shown
            && (offset_pre_narrow - offset_post_narrow) >= 40.0
            && rel_post_narrow >= 40.0,
        "on_layout_tx rail removal with queued transcript wheel must apply the upward wheel delta: demanded={}, rail_shown={}, offset={offset_pre_narrow}->{offset_post_narrow}, rel_post_narrow={rel_post_narrow}",
        super::demanded(&rt.state),
        owner(&mut rt.state).rail_shown
    );
    // Once the exit transition and subsequent poll settle, timeline must be unmounted and
    // flush_deferred_keep_passage must discard the deferred re-anchor because the transcript scrolled.
    rt.poll = Some(crate::poll);
    for _ in 0..20 {
        rt.frame(0.016);
    }
    let hist_settled = rt.presented("history").expect("history presented").0;
    let frag1_settled = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented after settle")
        .0;
    let offset_settled = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rel_settled = frag1_settled[1] - hist_settled[1];
    assert!(
        rt.presented("timeline").is_none()
            && owner(&mut rt.state).keep_passage_deferred.is_none()
            && (offset_pre_narrow - offset_settled) >= 40.0
            && rel_settled >= 40.0,
        "subsequent poll after guarded on_layout_tx rail removal with wheel must keep timeline unmounted and preserve wheel offset: shown={}, deferred={:?}, offset={offset_pre_narrow}->{offset_settled}, rel_settled={rel_settled}",
        rt.presented("timeline").is_some(),
        owner(&mut rt.state).keep_passage_deferred
    );

    // Conversely, if input_waiting=true came from non-scroll input (no wheel/transcript scroll),
    // the deferred keep_passage MUST replay on the next idle poll and re-anchor fragment-long-msg:1.
    rt.set_viewport((500.0, 320.0), 1.0);
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_some());
    rt.set_viewport((419.0, 320.0), 1.0);
    rt.frame(0.016);
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, true));
    rt.frame(0.016);
    assert!(owner(&mut rt.state).keep_passage_deferred.is_some());
    // Must replay on the VERY FIRST idle poll (not 20 frames later).
    rt.poll = Some(crate::poll);
    rt.frame(0.016);
    let hist_idle = rt.presented("history").expect("history presented").0;
    let frag1_idle = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented on first idle poll")
        .0;
    let rel_idle = frag1_idle[1] - hist_idle[1];
    assert!(
        owner(&mut rt.state).keep_passage_deferred.is_none() && rel_idle.abs() <= 2.0,
        "deferred keep_passage must replay on the very first idle poll: deferred={:?}, rel_idle={rel_idle}",
        owner(&mut rt.state).keep_passage_deferred
    );
    for _ in 0..20 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_none());

    // 1. A rail-only wheel (wheel_last_rail == Some(true)) during a deferred transition must NOT
    //    cancel the deferred transcript re-anchor.
    // 2. A second rail toggle before the first idle poll must preserve the original pre-reflow
    //    (key, offset) target instead of overwriting it with post-reflow layout.
    // 3. A resident jump (apply_alignment) while keep_passage_deferred is armed must clear it so
    //    the next idle poll does not snap the transcript back to the departed passage.
    rt.set_viewport((500.0, 320.0), 1.0);
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.set_viewport((419.0, 320.0), 1.0);
    rt.frame(0.016);
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, true));
    rt.frame(0.016);
    let original_deferred = owner(&mut rt.state)
        .keep_passage_deferred
        .clone()
        .expect("deferred target captured on narrow");
    // Simulate a rail-only wheel and a second toggle before any idle poll runs.
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        sc.wheel_last_rail = Some(true);
        owner(s).scroll.set(sc);
        super::defer_keep_passage(s, tx);
    });
    assert_eq!(
        owner(&mut rt.state).keep_passage_deferred,
        Some(original_deferred),
        "second toggle before idle poll must preserve the original pre-reflow target"
    );
    rt.poll = Some(crate::poll);
    rt.frame(0.016);
    let hist_rail_wheel = rt.presented("history").expect("history presented").0;
    let frag1_rail_wheel = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented after rail-only wheel")
        .0;
    assert!(
        owner(&mut rt.state).keep_passage_deferred.is_none()
            && (frag1_rail_wheel[1] - hist_rail_wheel[1]).abs() <= 2.0,
        "rail-only wheel must not cancel deferred transcript re-anchor: rel={}",
        frag1_rail_wheel[1] - hist_rail_wheel[1]
    );
    // Resident jump while keep_passage_deferred is armed clears the deferred target immediately.
    rt.set_viewport((500.0, 320.0), 1.0);
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.set_viewport((419.0, 320.0), 1.0);
    rt.frame(0.016);
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, true));
    rt.frame(0.016);
    assert!(owner(&mut rt.state).keep_passage_deferred.is_some());
    rt.update(|s, tx| navigation::select(s, "head:User:0:false", tx));
    assert!(
        owner(&mut rt.state).keep_passage_deferred.is_none(),
        "resident jump must clear keep_passage_deferred immediately"
    );
    rt.poll = Some(crate::poll);
    for _ in 0..5 {
        rt.frame(0.016);
    }
    let hist_jump = rt.presented("history").expect("history presented").0;
    let head_body = rt
        .presented("body-head")
        .expect("head message presented after resident jump")
        .0;
    assert!(
        (head_body[1] - hist_jump[1]).abs() <= 2.0,
        "idle poll after resident jump must stay at head rather than snapping back to fragment 1: rel={}",
        head_body[1] - hist_jump[1]
    );
}
