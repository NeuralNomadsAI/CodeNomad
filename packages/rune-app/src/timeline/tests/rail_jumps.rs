use super::*;

#[test]
fn narrow_window_cancels_rail_jump_and_admits_search_jump() {
    for reduced_motion in [false, true] {
        let mut s = crate::init();
        s.messages = vec![user("row-0")];
        let (tx, rx) = codenomad_client::bounded(4);
        s.commands = Some(tx);
        owner(&mut s).width = 800.0;
        owner(&mut s).online = true;
        owner(&mut s).outline = Some(Arc::new(Outline {
            entries: ["above-0", "above-1", "distant", "below-0", "row-0"]
                .into_iter()
                .enumerate()
                .map(|(seq, id)| {
                    serde_json::from_value(json!({
                        "id": id,
                        "seq": seq + 1,
                        "type": "user",
                        "tools": 0,
                        "reasoning": 0,
                        "text": 1,
                    }))
                    .unwrap()
                })
                .collect(),
            total: 5,
            cacheable: true,
            saved: None,
        }));
        owner(&mut s).changed = true;
        owner(&mut s).index_changed = true;
        let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        rt.set_system_reduced_motion(reduced_motion);
        rt.frame(0.0);

        let page = crate::history::Page {
            rows: vec![
                user("above-0"),
                user("above-1"),
                user("distant"),
                user("below-0"),
            ],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        };

        // 1. A rail jump narrowed below 420px is rejected immediately by admit_window (!demanded)
        //    even before poll runs, and cancelled once poll sees the narrow width.
        rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
        let (rail_ticket, rail_cancelled) = match rx.try_recv().expect("rail jump dispatched") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.update(|s, _| {
            owner(s).width = 419.0;
            let mut accepted = false;
            navigation::admit_window(s, rail_ticket, page.clone(), || {
                accepted = true;
                true
            });
            assert!(
                !accepted && s.messages.iter().all(|m| m.id != "distant"),
                "rail jump must be rejected by admit_window once window is narrower than 420px"
            );
        });
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        assert!(
            rt.presented("timeline").is_none()
                && rail_cancelled.is_closed()
                && !owner(&mut rt.state).jump.has_flight(),
            "narrowing below 420px must cancel an in-flight rail jump"
        );

        // 2. A search jump narrowed below 420px remains alive, admits, aligns, and locks.
        rt.set_viewport((800.0, 600.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        rt.update(|s, tx| navigation::seek_message(s, "distant", tx));
        let ticket = match rx.try_recv().expect("distant search jump dispatched") {
            crate::transport::Command::Anchor(jump) => jump.ticket,
            other => panic!("unexpected command: {other:?}"),
        };
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.016);
        }
        assert!(rt.presented("timeline").is_none());
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.update(|s, _| {
            navigation::admit_window(s, ticket, page.clone(), || true);
        });
        for _ in 0..20 {
            rt.frame(0.016);
        }
        let hist = rt.presented("history").expect("history presented").0;
        let distant_row = rt
            .presented("distant")
            .expect("distant message presented")
            .0;
        assert!(
            !owner(&mut rt.state).jump.has_flight()
                && owner(&mut rt.state).jump.is_locked()
                && (distant_row[1] - hist[1]).abs() <= 2.0,
            "in-flight search jump must admit, align distant to top of history, and lock while narrowed: hist={hist:?}, distant={distant_row:?}"
        );
        // Move transcript away via instant jump (non-user) so reading line would select above-0 if unlocked.
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("above-0", 0.0);
        });
        for _ in 0..10 {
            rt.frame(0.016);
        }
        rt.set_viewport((800.0, 600.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.016);
        }
        assert!(
            owner(&mut rt.state).jump.is_locked() && owner(&mut rt.state).jump.active.is_none(),
            "widening back must keep search jump locked rather than drifting to above-0"
        );

        // 3. Disabling timeline while narrowed with an in-flight search jump (and search closed)
        //    must reject stale responses even when a new jump is waiting later.
        rt.update(|s, tx| navigation::seek_message(s, "row-0", tx));
        let (ticket2, cancelled2) = match rx.try_recv().expect("second distant jump dispatched") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.update(|s, _| {
            crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }));
            navigation::admit_window(
                s,
                ticket2,
                crate::history::Page {
                    rows: vec![user("row-0")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || panic!("search jump with timeline disabled and search closed must not admit"),
            );
            navigation::cancel_jump(s);
        });
        for _ in 0..10 {
            rt.frame(0.016);
        }
        assert!(
            cancelled2.is_closed()
                && !owner(&mut rt.state).jump.has_flight()
                && !owner(&mut rt.state).jump.is_locked(),
            "cancelling after disabling showMessageTimeline must close transport and clear flight"
        );
        rt.set_viewport((800.0, 600.0), 1.0);
        rt.update(|s, _| {
            crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }))
        });
        for _ in 0..15 {
            rt.frame(0.016);
        }
        assert!(
            !owner(&mut rt.state).jump.has_flight()
                && owner(&mut rt.state).jump.active.as_deref() == Some("above-0:User:0:false"),
            "re-enabling timeline must resume reading-line tracking cleanly without stranded flight"
        );
        rt.update(|s, tx| navigation::select(s, "row-0:User:0:false", tx));
        let ticket3 = match rx.try_recv().expect("third distant jump dispatched") {
            crate::transport::Command::Anchor(jump) => jump.ticket,
            other => panic!("unexpected command: {other:?}"),
        };
        assert_ne!(ticket3, ticket2);
        let mut stale_accepted = false;
        rt.update(|s, _| {
            navigation::admit_window(
                s,
                ticket2,
                crate::history::Page {
                    rows: vec![user("row-0")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || {
                    stale_accepted = true;
                    true
                },
            );
        });
        assert!(
            !stale_accepted
                && owner(&mut rt.state).jump.has_flight()
                && rt.state.messages.iter().all(|m| m.id != "row-0"),
            "stale ticket from before suspension must be rejected while a newer jump waits"
        );
        let mut fresh_accepted = false;
        rt.update(|s, _| {
            navigation::admit_window(
                s,
                ticket3,
                crate::history::Page {
                    rows: vec![user("row-0")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || {
                    fresh_accepted = true;
                    true
                },
            );
        });
        for _ in 0..15 {
            rt.frame(0.016);
        }
        assert!(
            fresh_accepted
                && !owner(&mut rt.state).jump.has_flight()
                && owner(&mut rt.state).jump.is_locked()
                && rt.presented("body-row-0").is_some(),
            "newer jump ticket must admit cleanly after stale ticket rejection"
        );

        // 4. Manual transcript touch pan (measured on_scroll_offset move) while narrowed with an
        //    in-flight distant search jump must cancel the ticket and reject a late response.
        rt.update(|s, tx| {
            s.messages = (0..10).map(|i| user(&format!("scroll-row-{i}"))).collect();
            s.revision += 1;
            tx.instant();
            tx.scroll_to_instant("history", 0.0, 200.0);
        });
        for _ in 0..10 {
            rt.frame(0.016);
        }
        rt.update(|s, tx| navigation::seek_message(s, "distant", tx));
        let (ticket_pan, cancelled_pan) = match rx.try_recv().expect("narrow pan jump dispatched") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.016);
        }
        assert!(owner(&mut rt.state).jump.has_flight());
        let hist = rt.presented("history").expect("history presented").0;
        let narrow_offset_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
        assert!(
            narrow_offset_before > 80.0,
            "precondition: transcript must have upward scroll room before narrow touch pan: {narrow_offset_before}"
        );
        let hx = hist[0] + hist[2] / 2.0;
        let hy = hist[1] + hist[3] / 2.0;
        rt.touch(9, TouchPhase::Started, hx, hy, 1.0);
        rt.touch(9, TouchPhase::Moved, hx, hy + 20.0, 1.016);
        rt.touch(9, TouchPhase::Moved, hx, hy + 80.0, 1.032);
        rt.frame(0.016);
        rt.touch(9, TouchPhase::Ended, hx, hy + 80.0, 1.25);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        let narrow_offset_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
        assert!(
            narrow_offset_after < narrow_offset_before - 30.0
                && cancelled_pan.is_closed()
                && !owner(&mut rt.state).jump.has_flight(),
            "measured touch pan while narrowed must cancel in-flight distant jump via on_scroll_offset: offset={narrow_offset_before}->{narrow_offset_after}"
        );
        let mut late_pan_accepted = false;
        rt.update(|s, _| {
            navigation::admit_window(
                s,
                ticket_pan,
                crate::history::Page {
                    rows: vec![user("distant")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || {
                    late_pan_accepted = true;
                    true
                },
            );
        });
        assert!(
            !late_pan_accepted && rt.state.messages.iter().all(|m| m.id != "distant"),
            "late response after narrow manual transcript scroll must not replace current transcript"
        );
    }
}

#[test]
fn reprojection_shifting_locked_marker_index_keeps_rail_revealed() {
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({ "showThinkingBlocks": true }));
    let mut messages = Vec::new();
    for i in 0..25 {
        let row: crate::history::Row = crate::history::decode_message(&json!({
            "id": format!("think-{i}"),
            "type": "assistant",
            "time": { "completed": 1 },
            "content": [
                { "type": "reasoning", "text": format!("Thought {i}") },
                { "type": "text", "text": format!("Answer {i}") }
            ]
        }))
        .unwrap()
        .into();
        messages.push(row);
    }
    messages.push(user("locked-target"));
    s.messages = messages;
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 420.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "locked-target:User:0:false", tx));
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let idx_before = owner(&mut rt.state)
        .markers
        .iter()
        .position(|m| m.id == "locked-target:User:0:false")
        .expect("locked-target marker before filter");
    let offset_before = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        idx_before >= 45 && owner(&mut rt.state).jump.is_locked() && offset_before > 100.0,
        "locked-target must start deep in the rail: idx={idx_before}, offset={offset_before}"
    );
    let check_revealed = |rt: &Runtime<State>, label: &str| {
        let rail = rt.presented("timeline").expect("timeline presented").0;
        let btn = rt
            .elements()
            .into_iter()
            .find(|n| n.key.as_deref() == Some("locked-target:User:0:false"))
            .unwrap_or_else(|| panic!("{label}: locked-target button missing"));
        assert!(
            btn.visible[2] > 0.0
                && btn.visible[3] > 0.0
                && btn.rect[1] >= rail[1] - 1.0
                && btn.rect[1] + btn.rect[3] <= rail[1] + rail[3] + 1.0,
            "{label}: locked-target button must remain revealed inside rail={rail:?}, rect={:?}, visible={:?}",
            btn.rect,
            btn.visible
        );
    };
    check_revealed(&rt, "before hiding reasoning");

    // Hide reasoning blocks before locked-target, shifting its marker index downward.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showThinkingBlocks": false }));
        filters_changed(s);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let idx_after_hide = owner(&mut rt.state)
        .markers
        .iter()
        .position(|m| m.id == "locked-target:User:0:false")
        .expect("locked-target marker after hiding reasoning");
    assert!(
        idx_after_hide + 20 <= idx_before
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("locked-target:User:0:false"),
        "hiding earlier reasoning markers must shift locked-target index down while keeping lock: before={idx_before}, after={idx_after_hide}"
    );
    check_revealed(&rt, "after hiding reasoning");

    // Show reasoning blocks again, shifting locked-target back down below the rail viewport.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showThinkingBlocks": true }));
        filters_changed(s);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let idx_after_show = owner(&mut rt.state)
        .markers
        .iter()
        .position(|m| m.id == "locked-target:User:0:false")
        .expect("locked-target marker after re-showing reasoning");
    assert_eq!(idx_after_show, idx_before);
    assert!(
        owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("locked-target:User:0:false"),
        "re-showing reasoning markers must keep locked-target locked and active"
    );
    check_revealed(&rt, "after re-showing reasoning");
}

#[test]
fn browsing_rail_during_distant_jump_keeps_manual_rail_position() {
    let mut s = crate::init();
    let (tx, rx) = codenomad_client::bounded(4);
    s.commands = Some(tx);
    s.messages = (0..40).map(|i| user(&format!("row-{i}"))).collect();
    owner(&mut s).width = 800.0;
    owner(&mut s).online = true;
    let mut entries: Vec<_> = (0..40)
        .map(|i| {
            serde_json::from_value(json!({
                "id": format!("row-{i}"),
                "seq": i + 1,
                "type": "user",
                "tools": 0,
                "reasoning": 0,
                "text": 1,
            }))
            .unwrap()
        })
        .collect();
    entries.push(
        serde_json::from_value(json!({
            "id": "distant-end",
            "seq": 41,
            "type": "user",
            "tools": 0,
            "reasoning": 0,
            "text": 1,
        }))
        .unwrap(),
    );
    entries.push(
        serde_json::from_value(json!({
            "id": "distant-tail",
            "seq": 42,
            "type": "user",
            "tools": 0,
            "reasoning": 0,
            "text": 1,
        }))
        .unwrap(),
    );
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries,
        total: 42,
        cacheable: true,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 400.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    // Start at the top of the transcript so the rail begins at offset 0 and distant-end is off-screen.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-0", 0.0);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail_visible_key = |rt: &Runtime<State>, key: &str| {
        let rail = rt.presented("timeline").expect("timeline presented").0;
        rt.elements().into_iter().any(|n| {
            n.key.as_deref() == Some(key)
                && n.visible[2] > 0.0
                && n.visible[3] > 0.0
                && n.rect[1] >= rail[1] - 1.0
                && n.rect[1] + n.rect[3] <= rail[1] + rail[3] + 1.0
        })
    };
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] <= 1.0
            && !rail_visible_key(&rt, "distant-end:User:0:false"),
        "precondition: rail must start at top with distant-end off-screen"
    );
    // Start a distant jump to the end of the rail.
    rt.update(|s, tx| navigation::select(s, "distant-end:User:0:false", tx));
    let ticket = match rx.try_recv().expect("distant jump dispatched") {
        crate::transport::Command::Anchor(jump) => jump.ticket,
        other => panic!("unexpected command: {other:?}"),
    };
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let offset_at_end = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_at_end > 200.0 && rail_visible_key(&rt, "distant-end:User:0:false"),
        "rail must reveal distant-end before admission: offset={offset_at_end}"
    );
    // Manually wheel the rail upward while the distant jump is still in flight.
    let rail = rt.presented("timeline").expect("timeline presented").0;
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, 260.0);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let browsed_offset = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        browsed_offset < offset_at_end - 150.0
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).jump.has_flight(),
        "wheeling the rail during flight must scroll, enter browse mode, and keep jump in flight: before={offset_at_end}, after={browsed_offset}"
    );
    // Admit the distant jump response; distant-end must align and lock while keeping manual rail browse.
    let mut accepted = false;
    rt.update(|s, _| {
        navigation::admit_window(
            s,
            ticket,
            crate::history::Page {
                rows: vec![user("distant-end")],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            || {
                accepted = true;
                true
            },
        );
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist = rt.presented("history").expect("history presented").0;
    let distant_body = rt
        .presented("body-distant-end")
        .expect("distant-end body presented")
        .0;
    let offset_after_settle = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        accepted
            && !owner(&mut rt.state).jump.has_flight()
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("distant-end:User:0:false")
            && (distant_body[1] - hist[1]).abs() <= 2.0
            && owner(&mut rt.state).jump.is_browsing()
            && (offset_after_settle - browsed_offset).abs() <= 1.0,
        "settling a distant jump must admit, align, and lock distant-end while preserving manual rail browse: browsed={browsed_offset}, after={offset_after_settle}, hist={hist:?}, body={distant_body:?}"
    );
    // Clicking an unavailable (offline) marker while browsing must keep browse mode and rail position.
    rt.update(|s, tx| {
        owner(s).online = false;
        navigation::select(s, "row-0:User:0:false", tx);
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let offset_after_offline = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).jump.retry.is_some()
            && owner(&mut rt.state).jump.is_browsing()
            && (offset_after_offline - browsed_offset).abs() <= 1.0,
        "failed/offline click during rail browse must not snap the rail away: browsed={browsed_offset}, after={offset_after_offline}"
    );
    // A valid online distant jump from browse mode to an off-screen target must exit browse mode
    // and reveal the target in the rail even before the page is admitted.
    assert!(
        !rail_visible_key(&rt, "distant-tail:User:0:false"),
        "precondition: distant-tail must be off-screen before selecting"
    );
    rt.update(|s, tx| {
        owner(s).online = true;
        navigation::select(s, "distant-tail:User:0:false", tx);
    });
    match rx.try_recv().expect("online distant-tail jump dispatched") {
        crate::transport::Command::Anchor(jump) => assert_eq!(jump.message, "distant-tail"),
        other => panic!("unexpected command: {other:?}"),
    }
    for _ in 0..45 {
        rt.frame(0.016);
    }
    assert!(
        !owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).jump.has_flight()
            && rail_visible_key(&rt, "distant-tail:User:0:false"),
        "valid distant jump from browse mode must clear browse and reveal off-screen target before admission"
    );
}
