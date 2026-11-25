use super::banners::{
    anchor_offset, arm_rail_collision, has_any_rail_marker, has_rail_marker, is_row_visible,
    snapshot,
};
use super::*;

pub(super) fn check(mut rt: Runtime<State>, expected_offset: f32) -> Runtime<State> {
    let assert_rail_integrity = |rt: &Runtime<State>, label: &str| {
        let elements = rt.elements();
        let rail = rt.presented("timeline").expect("timeline presented").0;
        let t = &rt.state.transcript_display.timeline;
        let at = t.scroll.get().at;
        let mut counts = std::collections::HashMap::<String, usize>::new();
        let mut overlaps = std::collections::HashMap::<String, f32>::new();
        let mut visible_counts = std::collections::HashMap::<String, usize>::new();
        for node in elements
            .iter()
            .filter(|n| n.path.contains("/timeline/") && n.role == "button")
        {
            let key = node
                .key
                .as_deref()
                .unwrap_or_else(|| panic!("{label}: rail button missing key"));
            *counts.entry(key.to_string()).or_default() += 1;
            let overlap =
                (node.rect[1] + node.rect[3]).min(rail[1] + rail[3]) - node.rect[1].max(rail[1]);
            overlaps.insert(key.to_string(), overlap);
            if overlap > 0.5 {
                assert!(
                    node.visible[2] > 0.0
                        && node.visible[3] > 0.0
                        && (node.visible[2] - node.rect[2]).abs() <= 0.5
                        && (node.visible[3] - overlap).abs() <= 1.0,
                    "{label}: overlapping rail marker {key} unexpectedly clipped: rect={:?}, visible={:?}, rail={rail:?}, overlap={overlap}",
                    node.rect,
                    node.visible
                );
                *visible_counts.entry(key.to_string()).or_default() += 1;
            }
        }
        for (key, count) in &counts {
            assert_eq!(*count, 1, "{label}: duplicate rail marker key {key}");
        }
        let range = rune_theme_codenomad::timeline::visible_markers(at, t.markers.len());
        assert!(!range.is_empty(), "{label}: empty visible marker range");
        let mut verified = 0usize;
        for m in &t.markers[range.clone()] {
            assert_eq!(
                counts.get(&m.id).copied(),
                Some(1),
                "{label}: expected visible rail marker {} missing or duplicated",
                m.id
            );
            let overlap = overlaps.get(&m.id).copied().unwrap_or(0.0);
            if overlap > 0.5 {
                assert_eq!(
                    visible_counts.get(&m.id).copied(),
                    Some(1),
                    "{label}: overlapping visible rail marker {} was clipped",
                    m.id
                );
                verified += 1;
            }
        }
        assert!(
            verified >= range.len().saturating_sub(2) && verified > 0,
            "{label}: expected interior visible rail markers verified (verified={verified}, range={range:?})"
        );
    };
    assert_rail_integrity(&rt, "remounted at TIMELINE_MIN_WIDTH");
    rt.set_viewport((800.0, 600.0), 1.0);
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
    assert!(
        search::is_open(&rt.state) && rt.presented("history-search-body").is_some(),
        "history search must be open and mounted before showMessageTimeline toggle"
    );
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }))
    });
    settle(&mut rt);
    assert!(
        rt.presented("timeline").is_none(),
        "disabling showMessageTimeline while search is open must unmount the rail"
    );
    assert!(
        search::is_open(&rt.state) && rt.presented("history-search-body").is_some(),
        "disabling showMessageTimeline must keep history search open and mounted"
    );
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }))
    });
    settle(&mut rt);
    assert!(
        search::is_open(&rt.state) && rt.presented("history-search-body").is_some(),
        "re-enabling showMessageTimeline must keep history search open and mounted"
    );
    let reopened_snap = snapshot(&rt);
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 10.0
            && has_rail_marker(&reopened_snap, "row-26"),
        "re-enabling showMessageTimeline while search is open at identical geometry must re-reveal row-26"
    );
    assert_rail_integrity(&rt, "reopened with search open");
    rt.update(|s, _| search::close(s));
    settle(&mut rt);
    let before_up_snap = snapshot(&rt);
    assert!(
        !has_any_rail_marker(&before_up_snap, "row-8"),
        "row-8 must start completely above the visible rail before upward interior reveal"
    );
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-8", 0.0);
    });
    settle(&mut rt);
    let mid_up_at = owner(&mut rt.state).scroll.get().at;
    let mid_up_snap = snapshot(&rt);
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-8:User:0:false")
    );
    let mid_up_rail = rt.presented("timeline").expect("timeline presented").0;
    let mid_up_marker = rt
        .presented("row-8:User:0:false")
        .expect("row-8 rail marker presented")
        .0;
    assert!(
        mid_up_at.offset[1] > 0.5
            && mid_up_at.offset[1] < mid_up_at.max[1] - 0.5
            && (mid_up_marker[1] - mid_up_rail[1]).abs() <= 2.0,
        "revealing mid-rail row-8 from bottom must align it to the top edge of the rail: offset={mid_up_at:?}, rail={mid_up_rail:?}, marker={mid_up_marker:?}"
    );
    assert!(
        has_rail_marker(&mid_up_snap, "row-8"),
        "rail must reveal mid-rail marker row-8 cleanly inside the viewport"
    );
    assert_rail_integrity(&rt, "interior upward reveal");
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-25", 0.0);
    });
    settle(&mut rt);
    let mid_down_at = owner(&mut rt.state).scroll.get().at;
    let mid_down_snap = snapshot(&rt);
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-25:User:0:false")
    );
    let mid_down_rail = rt.presented("timeline").expect("timeline presented").0;
    let mid_down_marker = rt
        .presented("row-25:User:0:false")
        .expect("row-25 rail marker presented")
        .0;
    assert!(
        mid_down_at.offset[1] > mid_up_at.offset[1] + 5.0
            && mid_down_at.offset[1] < mid_down_at.max[1] - 0.5
            && ((mid_down_marker[1] + mid_down_marker[3]) - (mid_down_rail[1] + mid_down_rail[3]))
                .abs()
                <= 2.0,
        "revealing interior below-viewport row-25 must align it to the bottom edge of the rail: up={mid_up_at:?}, down={mid_down_at:?}, rail={mid_down_rail:?}, marker={mid_down_marker:?}"
    );
    assert!(
        has_rail_marker(&mid_down_snap, "row-25"),
        "rail must reveal interior marker row-25 cleanly inside the viewport"
    );
    assert_rail_integrity(&rt, "interior downward reveal");
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_bottom_instant("history");
    });
    settle(&mut rt);
    // Manually browse the rail before clicking row-26 so settle() must clear browse mode.
    let browse_rail = rt.presented("timeline").expect("timeline presented").0;
    let offset_before_browse = owner(&mut rt.state).scroll.get().at.offset[1];
    rt.wheel_xy(
        browse_rail[0] + browse_rail[2] / 2.0,
        browse_rail[1] + browse_rail[3] / 2.0,
        0.0,
        200.0,
    );
    settle(&mut rt);
    let offset_after_browse_up = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_after_browse_up < offset_before_browse - 100.0
            && owner(&mut rt.state).jump.is_browsing(),
        "wheeling the rail must actually scroll it and enter browse mode: before={offset_before_browse}, after={offset_after_browse_up}"
    );
    rt.wheel_xy(
        browse_rail[0] + browse_rail[2] / 2.0,
        browse_rail[1] + browse_rail[3] / 2.0,
        0.0,
        -200.0,
    );
    settle(&mut rt);
    assert!(
        owner(&mut rt.state).jump.is_browsing(),
        "browsing back down to row-26 must still be in browse mode before clicking"
    );
    let (lock_x, lock_y) = rt
        .find("row-26:User:0:false")
        .expect("visible row-26 rail button to click");
    rt.pointer_down(lock_x, lock_y);
    rt.pointer_up(lock_x, lock_y);
    settle(&mut rt);
    assert!(
        !owner(&mut rt.state).jump.is_browsing() && owner(&mut rt.state).jump.is_locked(),
        "clicking row-26 must lock selection and exit browse mode"
    );
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-4", -14.0);
    });
    settle(&mut rt);
    let pre_locked_snap = snapshot(&rt);
    assert!(
        is_row_visible(&rt, &pre_locked_snap, "row-4")
            && !is_row_visible(&rt, &pre_locked_snap, "row-26"),
        "transcript must be anchored at row-4 with locked row-26 off-screen before narrow round-trip"
    );
    rt.set_viewport((419.0, 600.0), 1.0);
    settle(&mut rt);
    assert!(rt.presented("timeline").is_none());
    let narrow_locked_snap = snapshot(&rt);
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(false),
        "narrowing below TIMELINE_MIN_WIDTH must not jump history to bottom"
    );
    assert!(
        (anchor_offset(&rt).1 - expected_offset).abs() < 0.5
            && is_row_visible(&rt, &narrow_locked_snap, "row-4")
            && !is_row_visible(&rt, &narrow_locked_snap, "row-26")
            && owner(&mut rt.state).jump.is_locked(),
        "transcript anchor and locked row-26 must stay preserved while narrowed at 419 px"
    );
    rt.set_viewport((800.0, 600.0), 1.0);
    settle(&mut rt);
    let after_narrow_locked_snap = snapshot(&rt);
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(false),
        "narrow/wide round-trip must not jump history to bottom"
    );
    assert!(
        (anchor_offset(&rt).1 - expected_offset).abs() < 0.5
            && is_row_visible(&rt, &after_narrow_locked_snap, "row-4")
            && !is_row_visible(&rt, &after_narrow_locked_snap, "row-26"),
        "transcript must remain anchored at row-4 with locked row-26 off-screen after narrow/wide round-trip"
    );
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-26:User:0:false"),
        "narrowing below TIMELINE_MIN_WIDTH and widening back must preserve locked row-26"
    );
    assert!(
        has_rail_marker(&after_narrow_locked_snap, "row-26"),
        "widening back after browsing + locking row-26 must re-reveal row-26 on the remounted rail"
    );
    assert_rail_integrity(&rt, "remounted with locked row-26");
    // A horizontal-only wheel event on the rail must leave positions untouched and not suppress reveal.
    let horiz_rail = rt.presented("timeline").expect("timeline presented").0;
    let rail_before_horiz = owner(&mut rt.state).scroll.get().at.offset[1];
    let anchor_before_horiz = anchor_offset(&rt).1;
    rt.wheel_xy(
        horiz_rail[0] + horiz_rail[2] / 2.0,
        horiz_rail[1] + horiz_rail[3] / 2.0,
        40.0,
        0.0,
    );
    settle(&mut rt);
    let offset_before_locked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        (offset_before_locked_banner - rail_before_horiz).abs() <= 0.5
            && (anchor_offset(&rt).1 - anchor_before_horiz).abs() <= 0.5
            && !owner(&mut rt.state).jump.is_browsing(),
        "horizontal-only wheel on rail must not move rail/transcript or set browse mode"
    );
    rt.update(|s, _| owner(s).outline_error = true);
    settle(&mut rt);
    let offset_after_locked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    let locked_snap = snapshot(&rt);
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-26:User:0:false")
    );
    assert!(
        offset_after_locked_banner > offset_before_locked_banner + 10.0,
        "banner shrinking the rail must actually scroll to re-reveal bottom-edge locked row-26: before={offset_before_locked_banner}, after={offset_after_locked_banner}"
    );
    assert!(
        has_rail_marker(&locked_snap, "row-26"),
        "shrinking the rail while row-26 is locked must automatically keep row-26 fully visible"
    );
    assert_rail_integrity(&rt, "locked banner shrink");
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    let before_race = owner(&mut rt.state).scroll.get().at;
    let offset_before_wheel = before_race.offset[1];
    let viewport_before_wheel = before_race.viewport[1];
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let after_shrink_layout = owner(&mut rt.state).scroll.get().at;
    assert!(
        after_shrink_layout.viewport[1] < viewport_before_wheel - 10.0
            && (after_shrink_layout.offset[1] - offset_before_wheel).abs() <= 0.5,
        "banner shrink must measure a shorter rail before the next poll reveals: before={before_race:?}, after={after_shrink_layout:?}"
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    assert!(
        offset_before_wheel > 130.0,
        "precondition: rail offset must stay strictly interior across all wheel deltas: {offset_before_wheel}"
    );
    arm_rail_collision(&mut rt);
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        30.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        "colliding same-frame wheel_xy must engage RailWheelOverride ownership"
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        25.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        "follow-up delta within WHEEL_IDLE must still be handled by RailWheelOverride"
    );
    settle(&mut rt);
    let offset_after_wheel = owner(&mut rt.state).scroll.get().at.offset[1];
    let expected_wheel_offset = offset_before_wheel - 95.0;
    assert!(
        offset_after_wheel > 25.0 && (offset_after_wheel - expected_wheel_offset).abs() <= 2.0,
        "same-frame multi-delta wheel_xy and follow-up delta on the shrunk rail must all accumulate interior to bounds: before={offset_before_wheel}, expected={expected_wheel_offset}, actual={offset_after_wheel}"
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        20.0,
    );
    settle(&mut rt);
    let offset_after_new_gesture = owner(&mut rt.state).scroll.get().at.offset[1];
    let expected_new_gesture = offset_after_wheel - 20.0;
    assert!(
        offset_after_new_gesture > 5.0
            && (offset_after_new_gesture - expected_new_gesture).abs() <= 2.0
            && !owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        "subsequent wheel gesture after idle timeout must scroll natively without RailWheelOverride ownership: before={offset_after_wheel}, expected={expected_new_gesture}, actual={offset_after_new_gesture}"
    );

    rt
}
