use super::*;

#[test]
fn restore_search_filtered_notice_survives_disabled_timeline_and_reveal_defers_for_input() {
    use codenomad_client::search::{Hit, Kind};

    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({ "showMessageTimeline": false, "showThinkingBlocks": false }),
    );
    let row: crate::history::Row = crate::history::decode_message(&json!({
        "id": "hidden-thought",
        "type": "assistant",
        "time": { "completed": 1 },
        "content": [
            { "type": "reasoning", "text": "Hidden needle" },
            { "type": "text", "text": "Visible answer" }
        ]
    }))
    .unwrap()
    .into();
    s.messages = vec![row];
    let mut hit = crate::chat::search_hit::SearchHit::new(
        &Hit {
            session: "s".into(),
            message: "hidden-thought".into(),
            role: "assistant".into(),
            part: 0,
            kind: Kind::Reasoning,
            excerpt: "Hidden needle".into(),
        },
        "Hidden needle",
        false,
    );
    hit.restore_pending = true;
    s.transcript_display.search_highlight = Some(hit);
    let mut rt = Runtime::new(s, view, (800.0, 420.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.update(|s, _| navigation::restore_search(s));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_some(),
        "disabled timeline without search must not erase restore_search filtered banner"
    );

    // Disabling showMessageTimeline after narrowing (live=true, search CLOSED) must NOT erase a
    // restored search highlight or its pending alignment while the transcript stays shown;
    // rail-originated filtered notices still clear cleanly when disabling showMessageTimeline.
    let mut s = crate::init();
    s.messages = (0..30)
        .map(|i| {
            if i == 1 {
                crate::history::decode_message(&json!({
                    "id": "m-1",
                    "type": "user",
                    "text": format!("{}m-1 match line\n\n{}", "Preface line.\n\n".repeat(4), "Tail line.\n\n".repeat(6))
                }))
                .unwrap()
                .into()
            } else {
                user(&format!("m-{i}"))
            }
        })
        .collect();
    owner(&mut s).width = 800.0;
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries: vec![
            serde_json::from_value(json!({
                "id": "m-0",
                "seq": 1,
                "type": "user",
                "tools": 0,
                "reasoning": 0,
                "text": 1,
            }))
            .unwrap(),
        ],
        total: 1,
        cacheable: false,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 420.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, _| {
        let mut restored = crate::chat::search_hit::SearchHit::new(
            &Hit {
                session: "s".into(),
                message: "m-1".into(),
                role: "user".into(),
                part: 0,
                kind: Kind::Text,
                excerpt: "m-1".into(),
            },
            "m-1",
            false,
        );
        restored.restore_pending = true;
        s.transcript_display.search_highlight = Some(restored);
        navigation::restore_search(s);
    });
    rt.set_viewport((419.0, 420.0), 1.0);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    assert!(
        rt.presented("timeline").is_none()
            && owner(&mut rt.state).outline.is_none()
            && rt.state.transcript_display.search_highlight.is_some(),
        "narrowing must drop non-cacheable outline immediately while keeping restored search highlight"
    );
    // Move the transcript away from m-1 first so the second restore_search must actually re-align.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("m-29", 0.0);
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist_away = rt.presented("history").expect("history presented").0;
    assert!(
        rt.presented("m-1")
            .is_none_or(|(r, _)| (r[1] - hist_away[1]).abs() > 20.0),
        "precondition: m-1 must be scrolled away before second restore_search"
    );
    rt.update(|s, _| {
        if let Some(hit) = s.transcript_display.search_highlight.as_mut() {
            hit.restore_pending = true;
        }
        navigation::restore_search(s);
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }));
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist_restored = rt.presented("history").expect("history presented").0;
    let m1_row = rt.presented("m-1").expect("restored m-1 row presented").0;
    assert!(
        rt.state.transcript_display.search_highlight.is_some()
            && (m1_row[1] - hist_restored[1]).abs() <= 2.0,
        "disabling showMessageTimeline while on the conversation must preserve restored search highlight and apply its alignment: hist={hist_restored:?}, m1={m1_row:?}"
    );

    // Real rail-originated destinationFiltered refusal must be cleared when showMessageTimeline is disabled.
    let mut s = crate::init();
    s.messages = vec![
        user("m-keep"),
        crate::history::decode_message(&json!({
            "id": "tool-msg",
            "type": "assistant",
            "content": [
                { "type": "tool", "id": "t-read", "name": "read", "state": { "status": "completed", "input": {} } }
            ],
        }))
        .unwrap()
        .into(),
    ];
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 360.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    rt.frame(0.016);
    // Hide the read tool without reprojecting yet, then click the still-present rail marker so
    // navigation::select() triggers a genuine rail-originated filtered refusal without moving history.
    let local_hist_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(
            s,
            json!({ "showMessageTimeline": true, "toolCallExpansionDefaults": { "tools": { "read": "hidden" } } }),
        );
        navigation::select(s, "tool-msg:Tool:0:false", tx);
    });
    rt.frame(0.016);
    let local_hist_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_some()
            && (local_hist_after - local_hist_before).abs() <= 0.5,
        "rail click on a now-hidden destination must show timeline-destination-filtered without scrolling history: hist={local_hist_before}->{local_hist_after}"
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        !owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_none(),
        "disabling showMessageTimeline must clear a rail-originated destinationFiltered alert"
    );

    // Distant rail-originated destinationFiltered refusal (landing from an outline click via
    // admit_window) must reject the page without installing it, keep messages intact, and clear
    // when showMessageTimeline is disabled.
    let mut s = crate::init();
    let (distant_tx, distant_rx) = codenomad_client::bounded(4);
    s.commands = Some(distant_tx);
    s.messages = vec![user("m-keep")];
    crate::settings::fixture_transcript(
        &mut s,
        json!({ "showMessageTimeline": true, "toolCallExpansionDefaults": { "tools": { "read": "hidden" } } }),
    );
    owner(&mut s).width = 800.0;
    owner(&mut s).online = true;
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries: [
            json!({ "id": "distant-tool", "seq": 1, "type": "assistant", "tools": 1, "reasoning": 0, "text": 0 }),
            json!({ "id": "m-keep", "seq": 2, "type": "user", "tools": 0, "reasoning": 0, "text": 1 }),
        ]
        .into_iter()
        .map(|v| serde_json::from_value(v).unwrap())
        .collect(),
        total: 2,
        cacheable: true,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 360.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "distant-tool:Tool:0:false", tx));
    let distant_ticket = match distant_rx.try_recv().expect("distant rail jump dispatched") {
        crate::transport::Command::Anchor(jump) => jump.ticket,
        other => panic!("unexpected command: {other:?}"),
    };
    let distant_page = crate::history::Page {
        rows: vec![
            crate::history::decode_message(&json!({
                "id": "distant-tool",
                "type": "assistant",
                "content": [
                    { "type": "tool", "id": "t-distant", "name": "read", "state": { "status": "completed", "input": {} } }
                ],
            }))
            .unwrap()
            .into(),
            user("m-keep"),
        ],
        older: None,
        newer: None,
        running: false,
        user_file_references: false,
    };
    let mut distant_accepted = false;
    rt.update(|s, _| {
        navigation::admit_window(s, distant_ticket, distant_page.clone(), || {
            distant_accepted = true;
            true
        });
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !distant_accepted
            && rt.state.messages.len() == 1
            && rt.state.messages[0].id == "m-keep"
            && owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_some(),
        "distant rail landing on a filtered destination must reject the page without installing it and show timeline-destination-filtered: accepted={distant_accepted}, messages={}",
        rt.state.messages.len()
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        !owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_none(),
        "disabling showMessageTimeline must clear a distant rail-originated destinationFiltered alert"
    );

    // Directly exercise reveal_active deferral with an isolated deferred frame and immediate wake check.
    let mut s = crate::init();
    s.messages = (0..40).map(|i| user(&format!("m-{i}"))).collect();
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let offset_before = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_before > 100.0,
        "rail must start scrolled toward bottom before selecting m-0: {offset_before}"
    );
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "m-0:User:0:false", tx));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        rt.wake_deadline().is_none()
            && (owner(&mut rt.state).scroll.get().at.offset[1] - offset_before).abs() <= 0.5,
        "precondition: no pending wake and rail still at bottom before reveal_active"
    );
    let mut deferred = true;
    let mut clock_at_defer = 0.0;
    rt.update(|s, tx| {
        clock_at_defer = tx.clock();
        deferred = !navigation::reveal_active(s, tx, true);
    });
    rt.frame(0.016);
    let wake = rt
        .wake_deadline()
        .expect("reveal_active(input_waiting=true) must schedule an immediate wake");
    assert!(
        deferred
            && wake <= clock_at_defer + 0.02
            && owner(&mut rt.state)
                .scroll
                .get()
                .programmatic_rail
                .is_none()
            && (owner(&mut rt.state).scroll.get().at.offset[1] - offset_before).abs() <= 0.5,
        "isolated frame after reveal_active(input_waiting=true) must schedule an immediate wake without scrolling: clock={clock_at_defer}, wake={wake}"
    );
    let mut revealed = false;
    rt.update(|s, tx| {
        revealed = navigation::reveal_active(s, tx, false);
    });
    assert!(
        revealed
            && owner(&mut rt.state)
                .scroll
                .get()
                .programmatic_rail
                .is_some(),
        "reveal_active(input_waiting=false) must schedule the reveal glide"
    );
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let m0_visible = rt.elements().into_iter().any(|n| {
        n.key.as_deref() == Some("m-0:User:0:false")
            && n.visible[2] > 0.0
            && n.visible[3] > 0.0
            && n.rect[1] >= rail[1] - 1.0
            && n.rect[1] + n.rect[3] <= rail[1] + rail[3] + 1.0
    });
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] < offset_before - 100.0 && m0_visible,
        "reveal_active(input_waiting=false) must move the rail upward and make m-0 visible"
    );
}

#[test]
fn toggling_rail_at_fixed_width_keeps_inner_passage_anchored() {
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({ "showMessageTimeline": true }));
    let long_intro = "Reflowing opening paragraph with plenty of words so narrowing by forty pixels wraps onto extra lines. ".repeat(18);
    let second_block = "Anchored second paragraph inside the same long message. ".repeat(8);
    let tail_block = "Trailing text below the anchored passage. ".repeat(14);
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
    owner(&mut s).width = 500.0;
    let mut rt = Runtime::new(s, view, (500.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_some());
    // Scroll to the second text block inside `long-msg` so `reading.passage` tracks fragment 1, not the message top.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let hist_before = rt.presented("history").expect("history presented").0;
    let frag0_before = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented before rail hide")
        .0;
    let before = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented before rail hide")
        .0;
    let before_rel = before[1] - hist_before[1];
    assert!(
        before_rel.abs() <= 4.0,
        "precondition: fragment-long-msg:1 aligned near top of history before toggling rail: before={before:?}, hist={hist_before:?}"
    );
    // Hide the rail at fixed window width (500px): history widens by 40px and fragment 0 reflows shorter,
    // yet keep_passage must hold fragment 1 at its reading offset.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_none());
    let hist_after_hide = rt.presented("history").expect("history presented").0;
    let frag0_after_hide = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented after rail hide")
        .0;
    let after_hide = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented after rail hide")
        .0;
    let after_hide_rel = after_hide[1] - hist_after_hide[1];
    assert!(
        hist_after_hide[2] > hist_before[2] + 30.0
            && frag0_after_hide[3] < frag0_before[3] - 10.0
            && (after_hide_rel - before_rel).abs() <= 2.0,
        "hiding rail at fixed width must widen history, reflow fragment 0 shorter, and keep fragment 1 anchored: hist_w={}->{}, frag0_h={}->{}, rel={before_rel}->{after_hide_rel}",
        hist_before[2],
        hist_after_hide[2],
        frag0_before[3],
        frag0_after_hide[3]
    );
    // Show the rail again at fixed window width (500px): history narrows by 40px and fragment 0 reflows taller,
    // yet keep_passage must keep fragment 1 anchored.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": true }));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_some());
    let hist_after_show = rt.presented("history").expect("history presented").0;
    let frag0_after_show = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented after rail show")
        .0;
    let after_show = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented after rail show")
        .0;
    let after_show_rel = after_show[1] - hist_after_show[1];
    assert!(
        hist_after_show[2] < hist_after_hide[2] - 30.0
            && frag0_after_show[3] > frag0_after_hide[3] + 10.0
            && (after_show_rel - before_rel).abs() <= 2.0,
        "showing rail at fixed width must narrow history, reflow fragment 0 taller, and keep fragment 1 anchored: hist_w={}->{}, frag0_h={}->{}, rel={before_rel}->{after_show_rel}",
        hist_after_hide[2],
        hist_after_show[2],
        frag0_after_hide[3],
        frag0_after_show[3]
    );

    // Lock a landed rail marker and keep fragment 1 at the top before narrowing across 420px:
    // on_layout_tx must re-anchor with tx.instant() so fragment 1 stays anchored on the very first
    // unmounted frame AND the locked marker is NOT mistakenly unlocked by gesture().
    rt.update(|s, tx| navigation::select(s, "head:User:0:false", tx));
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
    assert!(
        owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("head:User:0:false"),
        "precondition: landed rail marker must be locked before narrowing across 420px"
    );
    // Narrowing across the 420px threshold hides the rail inside on_layout_tx: Frame 1 measures
    // 419px and enqueues Action::Layout; Frame 2 executes on_layout_tx (unmounting the rail BEFORE
    // timeline::poll sees 419px) and must keep fragment 1 anchored on that very first unmounted frame.
    rt.set_viewport((419.0, 320.0), 1.0);
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_some());
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_none());
    let hist_narrow = rt.presented("history").expect("history presented").0;
    let frag0_narrow = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented after narrowing")
        .0;
    let after_narrow = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented after narrowing")
        .0;
    let after_narrow_rel = after_narrow[1] - hist_narrow[1];
    // Step one more frame so navigation::poll -> gesture() observes the on_layout_tx scroll_key_to.
    rt.frame(0.016);
    assert!(
        frag0_narrow[3] > frag0_after_show[3] + 10.0
            && (after_narrow_rel - before_rel).abs() <= 2.0
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("head:User:0:false"),
        "narrowing across 420px must keep inner passage anchored on the very first unmounted frame without unlocking or clearing a landed marker: frag0_h={}->{}, rel={before_rel}->{after_narrow_rel}, locked={}, active={:?}",
        frag0_after_show[3],
        frag0_narrow[3],
        owner(&mut rt.state).jump.is_locked(),
        owner(&mut rt.state).jump.active
    );
}
