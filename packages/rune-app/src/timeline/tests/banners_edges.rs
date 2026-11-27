use super::banners::arm_rail_collision;
use super::*;

pub(super) fn check(
    mut rt: Runtime<State>,
    cmd_rx: codenomad_client::Receiver<crate::transport::Command>,
) -> Runtime<State> {
    // Captured rail burst drifting onto a scrollable history-search results list MUST accumulate
    // multiple same-frame wheel deltas onto history-search-body without scrolling history behind it
    // or clearing browse.
    rt.update(|s, _| {
        owner(s).outline_error = false;
        search::fixture_hits(s, 30);
    });
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let body_rect = rt
        .presented("history-search-body")
        .expect("history-search-body presented")
        .0;
    let search_rect = rt
        .presented("history-search")
        .expect("history-search presented")
        .0;
    let body_before = search::body_scroll_offset(&rt.state);
    let hist_before_body = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rail_hit_y = (search_rect[1] + search_rect[3] + 12.0)
        .max(rail_rect[1] + 8.0)
        .min(rail_rect[1] + rail_rect[3] - 8.0);
    arm_rail_collision(&mut rt);
    rt.wheel_xy(rail_rect[0] + rail_rect[2] / 2.0, rail_hit_y, 0.0, 30.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own burst before drifting onto scrollable search body"
    );
    rt.wheel_xy(
        body_rect[0] + body_rect[2] / 2.0,
        body_rect[1] + body_rect[3] / 2.0,
        0.0,
        -30.0,
    );
    rt.wheel_xy(
        body_rect[0] + body_rect[2] / 2.0,
        body_rect[1] + body_rect[3] / 2.0,
        0.0,
        -50.0,
    );
    rt.frame(0.016);
    let body_after = search::body_scroll_offset(&rt.state);
    let hist_after_body = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((body_after - body_before) - 80.0).abs() <= 2.0
            && (hist_after_body - hist_before_body).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing(),
        "owned rail burst drifting onto scrollable history-search-body must accumulate two same-frame deltas (+80px) without scrolling transcript: body={body_before}->{body_after}, hist={hist_before_body}->{hist_after_body}"
    );
    // Drifting onto the history-search toolbar (inside search_rect but strictly above body_rect)
    // must NOT scroll the results list OR history behind it, while keeping browse active.
    let toolbar_y = search_rect[1] + (body_rect[1] - search_rect[1]) / 2.0;
    assert!(
        toolbar_y > search_rect[1] && toolbar_y < body_rect[1] - 2.0,
        "precondition: history-search toolbar band must sit strictly above body_rect: search={search_rect:?}, body={body_rect:?}"
    );
    rt.wheel_xy(search_rect[0] + search_rect[2] / 2.0, toolbar_y, 0.0, -60.0);
    rt.frame(0.016);
    let body_after_toolbar = search::body_scroll_offset(&rt.state);
    let hist_after_toolbar = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (body_after_toolbar - body_after).abs() <= 1.0
            && (hist_after_toolbar - hist_after_body).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing(),
        "owned rail burst drifting onto history-search toolbar must not scroll results body or history: body={body_after}->{body_after_toolbar}, hist={hist_after_body}->{hist_after_toolbar}"
    );
    rt.update(|s, _| {
        search::close(s);
        owner(s).outline_error = false;
    });
    settle(&mut rt);

    // Mid-transcript: forwarded momentum deltas MUST still scroll history normally (momentum only
    // suppresses edge paging, not scrolling itself). Arm programmatic_rail first and assert
    // RailWheelOverride owns the burst before forwarding momentum.
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let hist_before_mom_mid = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        hist_before_mom_mid > 100.0,
        "precondition: history must be mid-transcript before momentum scroll check: {hist_before_mom_mid}"
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    arm_rail_collision(&mut rt);
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 30.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own the phased burst before mid-transcript momentum handoff"
    );
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut mid_mom_ev = rune_theme_codenomad::timeline::WheelEvent::new(0.0, 45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    mid_mom_ev.momentum = true;
    rt.wheel_event(mid_mom_ev);
    rt.frame(0.016);
    let hist_after_mom_mid = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((hist_before_mom_mid - hist_after_mom_mid) - 45.0).abs() <= 2.0,
        "forwarded momentum wheel mid-transcript must still scroll history by 45px: hist={hist_before_mom_mid}->{hist_after_mom_mid}"
    );
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);

    // At the top edge of history, forwarded momentum deltas must NOT trigger a Before page request,
    // while non-momentum deltas MUST dispatch Page(Before).
    rt.update(|s, tx| {
        s.can_older = true;
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    assert!(
        owner(&mut rt.state).scroll.get().viewport.offset[1] <= 0.5,
        "precondition: history must be at top edge before edge-forwarding check"
    );
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    arm_rail_collision(&mut rt);
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 40.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own the phased burst before top-edge momentum check"
    );
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut mom_ev = rune_theme_codenomad::timeline::WheelEvent::new(0.0, 45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    mom_ev.momentum = true;
    rt.wheel_event(mom_ev);
    rt.frame(0.016);
    assert!(
        !rt.state.paging && cmd_rx.try_recv().is_err(),
        "forwarded momentum wheel at top edge must not dispatch a page request"
    );
    // Starting near (not yet at) the top edge of history: a forwarded momentum wheel that crosses
    // onto 0.0 must scroll to 0.0 without triggering poll_edge -> Page(Before) via on_scroll_offset.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 20.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 20.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    let near_top_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (near_top_before - 20.0).abs() <= 1.0,
        "precondition: history near top edge (20px) before momentum arrival check: {near_top_before}"
    );
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    arm_rail_collision(&mut rt);
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 40.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own phased burst before near-top momentum arrival"
    );
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut near_mom = rune_theme_codenomad::timeline::WheelEvent::new(0.0, 45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    near_mom.momentum = true;
    rt.wheel_event(near_mom);
    for _ in 0..3 {
        rt.frame(0.016);
    }
    let near_top_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        near_top_after <= 0.5 && !rt.state.paging && cmd_rx.try_recv().is_err(),
        "forwarded momentum wheel arriving at top edge from 20px must land at 0.0 without triggering poll_edge Page(Before): offset={near_top_after}, paging={}",
        rt.state.paging
    );
    // Start a fresh non-momentum owned rail burst and drift to top edge of history.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    arm_rail_collision(&mut rt);
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
        45.0,
    );
    rt.frame(0.016);
    assert!(
        rt.state.paging
            && matches!(
                cmd_rx.try_recv(),
                Ok(crate::transport::Command::Page(
                    crate::transport::HistoryEdge::Before,
                    _,
                ))
            ),
        "forwarded non-momentum wheel at top edge must dispatch Page(Before)"
    );

    // Same-frame down (+100px) then up (-10px) from top edge (0.0) lands at 90px and must NOT
    // dispatch Page(Before) by reading the stale pre-frame 0.0 offset.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, tx| {
        s.paging = false;
        s.can_older = true;
        owner(s).outline_error = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    arm_rail_collision(&mut rt);
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
        -100.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        10.0,
    );
    rt.frame(0.016);
    let bounce_offset = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (bounce_offset - 90.0).abs() <= 2.0 && !rt.state.paging && cmd_rx.try_recv().is_err(),
        "same-frame forwarded down 100px then up 10px from top edge must land at 90px without paging: offset={bounce_offset}, paging={}",
        rt.state.paging
    );

    // Detached history bottom edge: forwarded momentum arriving at max must NOT dispatch Page(After),
    // non-momentum at max MUST dispatch Page(After), and reversing upward MUST revoke it.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    let (detached_reader, _detached_lane) = crate::chat::reader::Reader::fixture_open();
    rt.update(|s, tx| {
        s.paging = false;
        s.can_older = false;
        s.phase = crate::Phase::Ready;
        s.reader = Some(detached_reader);
        s.history_detached = true;
        owner(s).outline_error = false;
        tx.instant();
        tx.scroll_to_bottom_instant("history");
    });
    settle(&mut rt);
    let max_bottom = owner(&mut rt.state).scroll.get().viewport.max[1];
    assert!(max_bottom > 200.0);
    // Select row-26 (bottom of rail), then position history at max_bottom - 20.0 at stable height
    // (no banner resize) and scroll the rail programmatically to 0.0 so reveal_active arms
    // programmatic_rail without shifting history's max[1].
    rt.update(|s, tx| {
        s.paging = false;
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, max_bottom - 20.0);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        sc.programmatic_rail = Some(0.0);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(0.0, tx);
    });
    rt.frame(0.016);
    while cmd_rx.try_recv().is_ok() {}
    let pre_mom_vp = owner(&mut rt.state).scroll.get().viewport;
    assert!(
        (pre_mom_vp.max[1] - pre_mom_vp.offset[1] - 20.0).abs() <= 1.0,
        "precondition: history must sit 20px above max before momentum arrival: offset={}/{}",
        pre_mom_vp.offset[1],
        pre_mom_vp.max[1]
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    // Arm a programmatic rail scroll on the exact frame the wheel arrives (without resizing history).
    arm_rail_collision(&mut rt);
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 40.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(owner(&mut rt.state).scroll.get().last_rail_wheel_taken);
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut bottom_mom = rune_theme_codenomad::timeline::WheelEvent::new(0.0, -45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    bottom_mom.momentum = true;
    rt.wheel_event(bottom_mom);
    // An inert key queued in the same frame triggers Rune's intermediate commit_for before
    // scroll offsets run; wheel_pending_commit must survive until observe_history_scroll.
    rt.key(rune::KeyEvent {
        key: rune::Key::Function(12),
        mods: rune::Mods::default(),
    });
    for _ in 0..3 {
        rt.frame(0.016);
    }
    let bottom_vp = owner(&mut rt.state).scroll.get().viewport;
    assert!(
        (bottom_vp.offset[1] - bottom_vp.max[1]).abs() <= 0.5
            && !rt.state.paging
            && cmd_rx.try_recv().is_err(),
        "forwarded momentum wheel arriving at bottom edge must land at max without dispatching Page(After): offset={}/{}, paging={}",
        bottom_vp.offset[1],
        bottom_vp.max[1],
        rt.state.paging
    );
    // Fresh non-momentum burst at bottom edge dispatches Page(After), then upward reversal revokes it.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, tx| {
        s.paging = false;
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, max_bottom);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        sc.programmatic_rail = Some(0.0);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(0.0, tx);
    });
    rt.frame(0.016);
    while cmd_rx.try_recv().is_ok() {}
    let pre_edge_vp = owner(&mut rt.state).scroll.get().viewport;
    assert!(
        (pre_edge_vp.max[1] - pre_edge_vp.offset[1]).abs() <= 0.5,
        "precondition: history must sit right at max before non-momentum edge paging: offset={}/{}",
        pre_edge_vp.offset[1],
        pre_edge_vp.max[1]
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    arm_rail_collision(&mut rt);
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
        -45.0,
    );
    rt.frame(0.016);
    let after_cancelled = match cmd_rx.try_recv() {
        Ok(crate::transport::Command::Page(crate::transport::HistoryEdge::After, cancelled)) => {
            cancelled
        }
        other => panic!(
            "forwarded non-momentum wheel at bottom edge must dispatch Page(After): {other:?}"
        ),
    };
    assert!(rt.state.paging && !after_cancelled.is_closed());
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        45.0,
    );
    rt.frame(0.016);
    assert!(
        after_cancelled.is_closed() && !rt.state.paging,
        "reversing forwarded wheel upward while Page(After) is in flight must revoke it"
    );
    rt
}
