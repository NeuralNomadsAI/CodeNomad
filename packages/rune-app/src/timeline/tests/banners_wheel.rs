use super::*;

pub(super) fn check(
    mut rt: Runtime<State>,
) -> (
    Runtime<State>,
    codenomad_client::Receiver<crate::transport::Command>,
) {
    // Moving the pointer left into the transcript mid-owned-burst must stop scrolling the rail and
    // forward deltas to the transcript (accumulating multiple deltas within the same frame), and
    // returning to the rail in the same frame must keep accumulating onto the first rail delta.
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let rail_before_same_frame = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_before_same_frame = owner(&mut rt.state).scroll.get().viewport.offset[1];
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
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        35.0,
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        25.0,
    );
    rt.frame(0.016);
    let rail_after_same_frame = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_after_same_frame = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && ((rail_before_same_frame - rail_after_same_frame) - 65.0).abs() <= 2.0
            && ((hist_before_same_frame - hist_after_same_frame) - 80.0).abs() <= 2.0,
        "same-frame rail -> multi-delta transcript -> rail must accumulate both rail (65px) and transcript (80px) deltas: rail={rail_before_same_frame}->{rail_after_same_frame}, hist={hist_before_same_frame}->{hist_after_same_frame}"
    );

    // Drifting from an owned rail burst over an open floating search window must NOT scroll the
    // transcript behind it or run hand_scrolled(false) (which would clear browse and cancel jumps).
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let (cmd_tx, cmd_rx) = codenomad_client::bounded(8);
    rt.update(|s, _| {
        s.commands = Some(cmd_tx);
        owner(s).outline_error = false;
    });
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
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
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let search_rect = rt
        .presented("history-search")
        .expect("history-search presented")
        .0;
    let sx = search_rect[0] + search_rect[2] / 2.0;
    let sy = search_rect[1] + search_rect[3] / 2.0;
    assert!(
        sx >= hist_rect[0]
            && sx <= hist_rect[0] + hist_rect[2]
            && sy >= hist_rect[1]
            && sy <= hist_rect[1] + hist_rect[3],
        "precondition: search overlay center ({sx}, {sy}) must overlap history {hist_rect:?}"
    );
    let hist_before_overlay = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rail_hit_y = (search_rect[1] + search_rect[3] + 12.0)
        .max(rail_rect[1] + 8.0)
        .min(rail_rect[1] + rail_rect[3] - 8.0);
    rt.wheel_xy(rail_rect[0] + rail_rect[2] / 2.0, rail_hit_y, 0.0, 40.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail wheel burst must be owned by RailWheelOverride before drifting over search"
    );
    rt.wheel_xy(sx, sy, 0.0, 60.0);
    rt.frame(0.016);
    let hist_after_overlay = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (hist_after_overlay - hist_before_overlay).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing(),
        "wheel drifting over open search overlay must not scroll transcript or clear rail browse: hist={hist_before_overlay}->{hist_after_overlay}"
    );
    // Still inside the same owned burst, drifting onto an uncovered area of history MUST scroll.
    let uncovered_x = hist_rect[0] + hist_rect[2] / 2.0;
    let uncovered_y =
        (search_rect[1] + search_rect[3] + 24.0).min(hist_rect[1] + hist_rect[3] - 8.0);
    assert!(
        uncovered_y > search_rect[1] + search_rect[3] + 1.0
            && uncovered_y < hist_rect[1] + hist_rect[3],
        "precondition: uncovered history point ({uncovered_x}, {uncovered_y}) must lie below search {search_rect:?} inside history {hist_rect:?}"
    );
    rt.wheel_xy(uncovered_x, uncovered_y, 0.0, 35.0);
    rt.frame(0.016);
    let hist_after_uncovered = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((hist_before_overlay - hist_after_uncovered) - 35.0).abs() <= 2.0,
        "same owned burst moving off search onto uncovered history must scroll transcript by 35px: hist={hist_before_overlay}->{hist_after_uncovered}"
    );
    // Drag the search window right so it overlaps the rail; wheeling on the overlap (including
    // during an owned rail burst started on an uncovered portion of the rail) must NOT scroll the
    // rail behind it.
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let search_rect = rt
        .presented("history-search")
        .expect("history-search presented")
        .0;
    let drag_rect = rt
        .presented("history-search-drag")
        .expect("history-search-drag presented")
        .0;
    let drag_x = drag_rect[0] + drag_rect[2] / 2.0;
    let drag_y = drag_rect[1] + drag_rect[3] / 2.0;
    let shift_x = (rail_rect[0] + rail_rect[2] / 2.0) - (search_rect[0] + search_rect[2] - 8.0);
    let shift_y = (rail_rect[1] + 40.0 - search_rect[1]).max(0.0);
    rt.pointer_down(drag_x, drag_y);
    rt.pointer_move(drag_x + shift_x.max(20.0), drag_y + shift_y);
    rt.pointer_up(drag_x + shift_x.max(20.0), drag_y + shift_y);
    rt.frame(0.016);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let dragged_search = rt
        .presented("history-search")
        .expect("dragged history-search presented")
        .0;
    let overlap_x0 = dragged_search[0].max(rail_rect[0]);
    let overlap_x1 = (dragged_search[0] + dragged_search[2]).min(rail_rect[0] + rail_rect[2]);
    let overlap_y0 = dragged_search[1].max(rail_rect[1]);
    let overlap_y1 = (dragged_search[1] + dragged_search[3]).min(rail_rect[1] + rail_rect[3]);
    assert!(
        overlap_x1 - overlap_x0 > 2.0 && overlap_y1 - overlap_y0 > 2.0,
        "precondition: dragged search {dragged_search:?} must overlap rail {rail_rect:?}"
    );
    // Start an owned rail burst on an uncovered portion of the rail outside the dragged search window,
    // then drift directly onto the overlap with the search window.
    let uncovered_rail_y = if dragged_search[1] - rail_rect[1] >= 16.0 {
        rail_rect[1] + 8.0
    } else {
        (dragged_search[1] + dragged_search[3] + 12.0).min(rail_rect[1] + rail_rect[3] - 8.0)
    };
    assert!(
        uncovered_rail_y < dragged_search[1] - 1.0
            || uncovered_rail_y > dragged_search[1] + dragged_search[3] + 1.0,
        "precondition: uncovered_rail_y={uncovered_rail_y} must lie outside dragged_search={dragged_search:?} inside rail={rail_rect:?}"
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        uncovered_rail_y,
        0.0,
        20.0,
    );
    rt.frame(0.016);
    let rail_before_covered = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail wheel burst must be owned before drifting onto overlapping search window"
    );
    rt.wheel_xy(
        (overlap_x0 + overlap_x1) / 2.0,
        (overlap_y0 + overlap_y1) / 2.0,
        0.0,
        50.0,
    );
    rt.frame(0.016);
    let rail_after_covered = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        (rail_after_covered - rail_before_covered).abs() <= 1.0,
        "wheel over search window overlapping the rail must not scroll the rail behind it: rail={rail_before_covered}->{rail_after_covered}"
    );
    rt.update(|s, _| {
        search::close(s);
        owner(s).outline_error = false;
    });
    settle(&mut rt);

    // Drifting from an owned rail burst onto an open rail preview tooltip (`timeline-peek`) must
    // scroll `timeline-peek` itself without scrolling the transcript behind it or clearing browse.
    // Give rows overflowing multi-line content so `timeline-peek` has vertical scroll range.
    rt.update(|s, tx| {
        s.window_size = [800.0, 600.0];
        owner(s).outline_error = false;
        let long_body = (0..40)
            .map(|line| format!("Preview line {line} with enough words to overflow the tooltip"))
            .collect::<Vec<_>>()
            .join("\n");
        for row in &mut s.messages {
            let id = row.id.clone();
            *row = crate::history::decode_message(&json!({
                "id": id,
                "type": "user",
                "text": long_body,
            }))
            .unwrap()
            .into();
        }
        s.revision += 1;
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let marker_rect = rt
        .elements()
        .into_iter()
        .find(|n| {
            n.path.contains("/timeline/")
                && n.role == "button"
                && n.visible[2] > 0.0
                && n.visible[3] > 0.0
                && n.rect[1] >= rail_rect[1] + 24.0
                && n.rect[1] + n.rect[3] <= rail_rect[1] + rail_rect[3] - 24.0
        })
        .expect("visible rail marker to hover")
        .rect;
    rt.pointer_move(
        marker_rect[0] + marker_rect[2] / 2.0,
        marker_rect[1] + marker_rect[3] / 2.0,
    );
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let _peek_rect = rt
        .presented("timeline-peek")
        .expect("precondition: timeline-peek must open after hovering rail marker")
        .0;
    assert!(
        preview::is_shown(&rt.state),
        "precondition: preview::is_shown must be true"
    );
    let rail_at_max = owner(&mut rt.state).scroll.get().at;
    let at_bottom_edge = (rail_at_max.offset[1] - rail_at_max.max[1]).abs() <= 0.5;
    if !at_bottom_edge {
        rt.update(|s, tx| {
            rune_theme_codenomad::timeline::scroll_rail_to(owner(s).scroll.get().at.max[1], tx);
        });
        settle(&mut rt);
        let marker_rect = rt
            .elements()
            .into_iter()
            .find(|n| {
                n.path.contains("/timeline/")
                    && n.role == "button"
                    && n.visible[2] > 0.0
                    && n.visible[3] > 0.0
                    && n.rect[1] >= rail_rect[1] + 24.0
                    && n.rect[1] + n.rect[3] <= rail_rect[1] + rail_rect[3] - 24.0
            })
            .expect("visible rail marker at bottom")
            .rect;
        rt.pointer_move(
            marker_rect[0] + marker_rect[2] / 2.0,
            marker_rect[1] + marker_rect[3] / 2.0,
        );
        for _ in 0..30 {
            rt.frame(0.016);
        }
    }
    let peek_rect = rt
        .presented("timeline-peek")
        .expect("timeline-peek presented")
        .0;
    let px = (peek_rect[0].max(hist_rect[0])
        + (peek_rect[0] + peek_rect[2]).min(hist_rect[0] + hist_rect[2]))
        / 2.0;
    let py = (peek_rect[1].max(hist_rect[1])
        + (peek_rect[1] + peek_rect[3]).min(hist_rect[1] + hist_rect[3]))
        / 2.0;
    assert!(
        px >= peek_rect[0]
            && px <= peek_rect[0] + peek_rect[2]
            && px >= hist_rect[0]
            && px <= hist_rect[0] + hist_rect[2]
            && py >= peek_rect[1]
            && py <= peek_rect[1] + peek_rect[3]
            && py >= hist_rect[1]
            && py <= hist_rect[1] + hist_rect[3],
        "precondition: timeline-peek {peek_rect:?} must overlap history {hist_rect:?}"
    );
    let hist_before_peek = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let peek_before = preview::scroll_offset(&rt.state);
    assert!(
        hist_before_peek > 100.0 && peek_before <= 0.5,
        "precondition: history mid-transcript ({hist_before_peek}) and timeline-peek at top ({peek_before})"
    );
    rt.update(|s, _| s.paging = true);
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        -30.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing()
            && preview::is_shown(&rt.state),
        "precondition: RailWheelOverride must own the burst while timeline-peek is still open"
    );
    rt.wheel_xy(px, py, 0.0, -55.0);
    rt.frame(0.016);
    let hist_after_peek = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let peek_after = preview::scroll_offset(&rt.state);
    assert!(
        ((peek_after - peek_before) - 55.0).abs() <= 2.0
            && (hist_after_peek - hist_before_peek).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing()
            && preview::is_shown(&rt.state),
        "wheel drifting from owned rail burst over timeline-peek must scroll timeline-peek by 55px without scrolling transcript or clearing browse: peek={peek_before}->{peek_after}, hist={hist_before_peek}->{hist_after_peek}"
    );
    // In the same owned burst, moving off timeline-peek onto uncovered history MUST scroll history.
    let uncovered_hy = if peek_rect[1] - hist_rect[1] >= 24.0 {
        hist_rect[1] + 12.0
    } else {
        (peek_rect[1] + peek_rect[3] + 16.0).min(hist_rect[1] + hist_rect[3] - 8.0)
    };
    assert!(
        uncovered_hy < peek_rect[1] - 1.0 || uncovered_hy > peek_rect[1] + peek_rect[3] + 1.0,
        "precondition: uncovered history y={uncovered_hy} must lie outside timeline-peek={peek_rect:?}"
    );
    rt.wheel_xy(hist_rect[0] + hist_rect[2] / 2.0, uncovered_hy, 0.0, 35.0);
    rt.frame(0.016);
    let hist_after_off_peek = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((hist_before_peek - hist_after_off_peek) - 35.0).abs() <= 2.0,
        "same owned burst moving off timeline-peek onto uncovered history must scroll transcript by 35px: hist={hist_before_peek}->{hist_after_off_peek}"
    );

    // Z-order overlap: when timeline-peek paints above history-search-body, wheeling over their
    // intersection must scroll timeline-peek and leave history-search-body and history untouched.
    rt.update(|s, _| {
        search::fixture_hits(s, 30);
        search::set_position(s, [20.0, peek_rect[1]]);
    });
    for _ in 0..8 {
        rt.frame(0.016);
    }
    let peek_rect_z = rt
        .presented("timeline-peek")
        .expect("timeline-peek presented for z-order check")
        .0;
    let body_rect_z = rt
        .presented("history-search-body")
        .expect("history-search-body presented for z-order check")
        .0;
    let search_rect_z = rt
        .presented("history-search")
        .expect("history-search presented for z-order check")
        .0;
    let z_x0 = peek_rect_z[0].max(body_rect_z[0]);
    let z_x1 = (peek_rect_z[0] + peek_rect_z[2]).min(body_rect_z[0] + body_rect_z[2]);
    let z_y0 = peek_rect_z[1].max(body_rect_z[1]);
    let z_y1 = (peek_rect_z[1] + peek_rect_z[3]).min(body_rect_z[1] + body_rect_z[3]);
    assert!(
        z_x1 - z_x0 > 4.0 && z_y1 - z_y0 > 4.0,
        "precondition: timeline-peek {peek_rect_z:?} must overlap history-search-body {body_rect_z:?}"
    );
    let peek_z_before = preview::scroll_offset(&rt.state);
    let body_z_before = search::body_scroll_offset(&rt.state);
    let hist_z_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rail_z_x = rail_rect[0] + rail_rect[2] / 2.0;
    let rail_z_y = if rail_z_x < search_rect_z[0] || rail_z_x > search_rect_z[0] + search_rect_z[2]
    {
        rail_rect[1] + rail_rect[3] / 2.0
    } else if search_rect_z[1] - rail_rect[1] >= 16.0 {
        rail_rect[1] + 8.0
    } else {
        (search_rect_z[1] + search_rect_z[3] + 8.0).min(rail_rect[1] + rail_rect[3] - 8.0)
    };
    rt.wheel_xy(rail_z_x, rail_z_y, 0.0, -30.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken && preview::is_shown(&rt.state),
        "precondition: RailWheelOverride owns burst before z-order overlap check: taken={}, shown={}, rail_pt=({rail_z_x},{rail_z_y}), search={search_rect_z:?}, peek={peek_rect_z:?}",
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        preview::is_shown(&rt.state)
    );
    rt.wheel_xy((z_x0 + z_x1) / 2.0, (z_y0 + z_y1) / 2.0, 0.0, -45.0);
    rt.frame(0.016);
    let peek_z_after = preview::scroll_offset(&rt.state);
    let body_z_after = search::body_scroll_offset(&rt.state);
    let hist_z_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((peek_z_after - peek_z_before) - 45.0).abs() <= 2.0
            && (body_z_after - body_z_before).abs() <= 1.0
            && (hist_z_after - hist_z_before).abs() <= 1.0,
        "overlapping timeline-peek above history-search-body must receive wheel (45px) while search body and history stay still: peek={peek_z_before}->{peek_z_after}, body={body_z_before}->{body_z_after}, hist={hist_z_before}->{hist_z_after}"
    );
    rt.update(|s, _| {
        s.paging = false;
        search::close(s);
    });
    rt.pointer_move(0.0, 0.0);
    for _ in 0..15 {
        rt.frame(0.02);
    }

    // An unrendered preview target (e.g., a non-resident Reasoning marker whose overlay returns
    // None and leaves bounds empty) must NEVER swallow wheel forwarding onto history.
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(s, json!({"showThinkingBlocks": true}));
        owner(s).outline = Some(Arc::new(Outline {
            entries: vec![
                serde_json::from_value(json!({
                    "id": "cold-reason",
                    "seq": 1,
                    "type": "assistant",
                    "tools": 0,
                    "reasoning": 1,
                    "text": 0,
                }))
                .unwrap(),
            ],
            total: 1,
            cacheable: true,
            saved: None,
        }));
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
        owner(s).outline_error = true;
        rune_theme_codenomad::timeline::scroll_rail_to(0.0, tx);
    });
    settle(&mut rt);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let reason_node = rt
        .elements()
        .into_iter()
        .find(|n| n.key.as_deref() == Some("cold-reason:Reasoning:0:false"))
        .expect("non-resident Reasoning marker presented");
    assert!(
        reason_node.visible[2] > 0.0 && reason_node.visible[3] > 0.0,
        "precondition: cold-reason marker must be visible in rail: rect={:?}, visible={:?}, rail={rail_rect:?}",
        reason_node.rect,
        reason_node.visible
    );
    rt.pointer_move(
        reason_node.visible[0] + reason_node.visible[2] / 2.0,
        reason_node.visible[1] + reason_node.visible[3] / 2.0,
    );
    for _ in 0..30 {
        rt.frame(0.016);
    }
    assert!(
        preview::is_shown(&rt.state) && rt.presented("timeline-peek").is_none(),
        "precondition: hovering non-resident Reasoning sets target without rendering timeline-peek"
    );
    let hist_before_reason = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(hist_before_reason > 100.0);
    rt.update(|s, _| s.paging = true);
    // Claim against the top rail stop (+30.0 at offset 0.0) so rail placement does not change and
    // preview::poll keeps the unrendered Reasoning target active across the handoff.
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        30.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken && preview::is_shown(&rt.state),
        "precondition: RailWheelOverride must own burst while unrendered Reasoning target remains active"
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        35.0,
    );
    rt.frame(0.016);
    let hist_after_reason = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        preview::is_shown(&rt.state)
            && ((hist_before_reason - hist_after_reason) - 35.0).abs() <= 2.0,
        "unrendered Reasoning preview target must stay active without swallowing wheel forwarding onto history: shown={}, hist={hist_before_reason}->{hist_after_reason}",
        preview::is_shown(&rt.state)
    );
    rt.update(|s, _| {
        s.paging = false;
        crate::settings::fixture_transcript(s, json!({"showThinkingBlocks": false}));
        owner(s).outline = None;
        owner(s).outline_error = false;
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
    });
    rt.pointer_move(0.0, 0.0);
    for _ in 0..15 {
        rt.frame(0.02);
    }

    (rt, cmd_rx)
}
