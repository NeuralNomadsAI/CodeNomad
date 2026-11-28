use super::*;

#[test]
fn disabling_timeline_while_search_open_cancels_rail_jump_and_clears_retry_banner() {
    let mut s = crate::init();
    let (tx, rx) = codenomad_client::bounded(4);
    s.commands = Some(tx);
    s.messages = vec![user("row-0")];
    owner(&mut s).width = 800.0;
    owner(&mut s).online = true;
    owner(&mut s).refresh = false;
    owner(&mut s).backend = Some(codenomad_client::backend::Backend {
        client: codenomad_client::http::Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "w".into(),
        session: "s".into(),
        client_id: "c".into(),
        session_directory: None,
        fresh_mode: false,
    });
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries: ["distant", "row-0"]
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
        total: 2,
        cacheable: false,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 500.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    // Start a rail jump, open history search, then disable timeline (keeping rail width >= 420px
    // so narrowing does not already cancel the rail jump).
    rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
    let (ticket, cancelled) = match rx.try_recv().expect("rail jump dispatched") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
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
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state) && owner(&mut rt.state).jump.has_flight(),
        "precondition: search open and rail jump still in flight before disabling timeline"
    );
    // Disable showMessageTimeline WITHOUT stepping poll() first: admit_window's own origin guard
    // must reject the rail-originated response before poll() has a chance to cancel it.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    let mut accepted = false;
    navigation::admit_window(
        &mut rt.state,
        ticket,
        crate::history::Page {
            rows: vec![user("distant")],
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
    assert!(
        !accepted
            && owner(&mut rt.state).jump.has_flight()
            && rt.state.messages.iter().all(|m| m.id != "distant"),
        "admit_window must reject a rail jump after showMessageTimeline is disabled even before poll() cancels it"
    );
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state)
            && cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && owner(&mut rt.state).outline.is_none(),
        "disabling timeline while search is open must keep search open, cancel the rail jump, and drop uncacheable outline"
    );

    // Also test disabling at normal width (800 px) while search is OPEN:
    // 1a. Non-cacheable outline with folded markers + active scan + locked rail selection (NO retry)
    //     must all be cleared immediately by poll()/cancel_rail_jump() while keeping search open.
    rt.set_viewport((800.0, 500.0), 1.0);
    rt.update(|s, _| {
        s.messages.push(
            crate::history::decode_message(&json!({
                "id": "folded-msg",
                "type": "assistant",
                "content": [
                    { "type": "text", "text": "part one" },
                    { "type": "tool", "id": "t1", "name": "read", "state": { "status": "completed", "input": {} } },
                    { "type": "text", "text": "part two" },
                ],
            }))
            .unwrap()
            .into(),
        );
        crate::settings::fixture_transcript(
            s,
            json!({
                "showMessageTimeline": true,
                "toolCallExpansionDefaults": { "tools": { "read": "hidden" } },
            }),
        );
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let (scan_cancel, scan_cancelled) = codenomad_client::bounded(1);
    let (_scan_tx, scan_rx) = codenomad_client::bounded(1);
    rt.update(|s, _| {
        let t = owner(s);
        t.outline = Some(Arc::new(Outline {
            entries: vec![
                serde_json::from_value(json!({
                    "id": "distant",
                    "seq": 1,
                    "type": "user",
                    "tools": 0,
                    "reasoning": 0,
                    "text": 1,
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "id": "row-0",
                    "seq": 2,
                    "type": "user",
                    "tools": 0,
                    "reasoning": 0,
                    "text": 1,
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "id": "folded-msg",
                    "seq": 3,
                    "type": "assistant",
                    "tools": 1,
                    "reasoning": 0,
                    "text": 2,
                }))
                .unwrap(),
            ],
            total: 3,
            cacheable: false,
            saved: None,
        }));
        t.changed = true;
        t.index_changed = true;
        t.scan = Some((scan_cancel, scan_rx));
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "row-0:User:0:false", tx));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).outline.is_some()
            && !owner(&mut rt.state).folded.is_empty()
            && !scan_cancelled.is_closed()
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.retry.is_none(),
        "precondition (locked without retry) at 800 px with search open: outline, folded, scan, and locked rail selection present"
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).outline.is_none()
            && owner(&mut rt.state).markers.is_empty()
            && owner(&mut rt.state).folded.is_empty()
            && scan_cancelled.is_closed()
            && owner(&mut rt.state).scan.is_none()
            && !owner(&mut rt.state).jump.is_locked(),
        "disabling timeline at normal width while search is open must cancel scan, free uncacheable outline+folded, and clear locked rail selection without retry"
    );

    // 1b. Rail retry WITHOUT locked selection while search is OPEN must also be cleared immediately
    //     by cancel_rail_jump() and unmount timeline-jump-retry on a single poll frame.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, _| {
        owner(s).jump.retry = Some(Marker::from(timeline::Marker {
            message: "distant",
            kind: MarkerKind::User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool_name: None,
        }));
    });
    rt.frame(0.016);
    assert!(
        search::is_open(&rt.state)
            && !owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.retry.is_some()
            && rt.presented("timeline-jump-retry").is_some(),
        "precondition (retry without lock) with search open: retry banner present"
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).jump.retry.is_none()
            && rt.presented("timeline-jump-retry").is_none(),
        "disabling timeline with search open must clear rail retry without lock and unmount retry banner on one poll frame"
    );

    // 2. A search-originated jump started BEFORE disabling showMessageTimeline must survive the
    //    toggle, admit, and align cleanly to the target row.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::seek_message(s, "distant", tx));
    let search_ticket = match rx.try_recv().expect("search jump dispatched") {
        crate::transport::Command::Anchor(jump) => jump.ticket,
        other => panic!("unexpected command: {other:?}"),
    };
    assert!(navigation::pending_search(&mut rt.state));
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state) && navigation::pending_search(&mut rt.state),
        "search jump started before disabling showMessageTimeline must survive the toggle"
    );
    let mut search_accepted = false;
    rt.update(|s, _| {
        navigation::admit_window(
            s,
            search_ticket,
            crate::history::Page {
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
            },
            || {
                search_accepted = true;
                true
            },
        );
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist = rt.presented("history").expect("history presented").0;
    let distant_row = rt
        .presented("distant")
        .expect("search jump distant row presented")
        .0;
    assert!(
        search_accepted
            && !owner(&mut rt.state).jump.has_flight()
            && (distant_row[1] - hist[1]).abs() <= 2.0,
        "search-originated jump surviving showMessageTimeline=false must admit AND align to distant: hist={hist:?}, row={distant_row:?}"
    );

    // 3. Disabling showMessageTimeline with search closed cancels a rail jump.retry and unmounts
    //    timeline-jump-retry immediately on the next frame.
    rt.update(|s, _| {
        search::close(s);
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, _| {
        owner(s).jump.retry = Some(Marker::from(timeline::Marker {
            message: "distant",
            kind: MarkerKind::User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool_name: None,
        }));
    });
    rt.frame(0.016);
    assert!(rt.presented("timeline-jump-retry").is_some());
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_none() && rt.presented("timeline-jump-retry").is_none(),
        "disabling showMessageTimeline must clear jump.retry and unmount timeline-jump-retry immediately"
    );

    // 4. Opening a Files preview hides the conversation: both search and rail jumps must be
    //    rejected pre-poll by admit_window() and cancelled by poll() -> suspend().
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
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
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::seek_message(s, "distant-behind-preview", tx));
    let (preview_search_ticket, preview_search_cancelled) =
        match rx.try_recv().expect("search jump") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
    rt.update(|s, _| {
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
        s.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
            &codenomad_client::search::Hit {
                session: "s".into(),
                message: "row-0".into(),
                role: "user".into(),
                part: 0,
                kind: codenomad_client::search::Kind::Text,
                excerpt: "row-0".into(),
            },
            "row-0",
            false,
        ));
    });
    let mut behind_preview_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        preview_search_ticket,
        crate::history::Page {
            rows: vec![user("distant-behind-preview")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            behind_preview_accepted = true;
            true
        },
    );
    assert!(
        !behind_preview_accepted
            && rt
                .state
                .messages
                .iter()
                .all(|m| m.id != "distant-behind-preview"),
        "admit_window must reject a search jump once a Files preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        preview_search_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && !search::is_open(&rt.state)
            && rt.state.transcript_display.search_highlight.is_none(),
        "poll() must suspend timeline/search and cancel in-flight jump when a Files preview opens"
    );
    // Closing the Files preview must NOT resurrect the closed search window.
    rt.update(|s, _| s.files = None);
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !search::is_open(&rt.state) && rt.presented("history-search").is_none(),
        "closing Files preview must keep history search closed"
    );

    // 5. A rail-originated jump behind a Files preview must also be rejected pre-poll and cancelled on poll.
    rt.update(|s, _| {
        s.messages.retain(|m| m.id != "distant");
        s.revision += 1;
        owner(s).online = true;
        owner(s).outline = Some(Arc::new(Outline {
            entries: ["distant", "row-0"]
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
            total: 2,
            cacheable: false,
            saved: None,
        }));
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
    });
    for _ in 0..3 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
    let (preview_rail_ticket, preview_rail_cancelled) = match rx.try_recv().expect("rail jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    let (files_scan_cancel, files_scan_cancelled) = codenomad_client::bounded(1);
    let (_files_scan_out, files_scan_inbox) = codenomad_client::bounded(1);
    rt.update(|s, _| {
        owner(s).scan = Some((files_scan_cancel, files_scan_inbox));
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
    });
    let mut rail_behind_files_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        preview_rail_ticket,
        crate::history::Page {
            rows: vec![user("distant")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            rail_behind_files_accepted = true;
            true
        },
    );
    assert!(
        !rail_behind_files_accepted && rt.state.messages.iter().all(|m| m.id != "distant"),
        "admit_window must reject a rail jump once a Files preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        preview_rail_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && files_scan_cancelled.is_closed()
            && owner(&mut rt.state).scan.is_none()
            && owner(&mut rt.state).outline.is_none(),
        "poll() must cancel an in-flight rail jump and outline scan and drop uncacheable outline when a Files preview opens"
    );
    rt.update(|s, _| s.files = None);
    for _ in 0..5 {
        rt.frame(0.016);
    }

    // 6. Opening a Git preview hides the conversation identically: reject both rail and search
    //    jumps pre-poll, cancel on poll(), and keep search closed after closing the Git preview.
    rt.update(|s, tx| {
        s.messages.retain(|m| m.id != "distant");
        s.revision += 1;
        owner(s).online = true;
        owner(s).outline = Some(Arc::new(Outline {
            entries: ["distant", "row-0"]
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
            total: 2,
            cacheable: false,
            saved: None,
        }));
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
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
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
    let (git_rail_ticket, git_rail_cancelled) = match rx.try_recv().expect("git rail jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    let (git_scan_cancel, git_scan_cancelled) = codenomad_client::bounded(1);
    let (_git_scan_out, git_scan_inbox) = codenomad_client::bounded(1);
    rt.update(|s, _| {
        owner(s).scan = Some((git_scan_cancel, git_scan_inbox));
        crate::git::fixture_open_preview(s);
    });
    assert!(
        crate::git::has_preview(&rt.state),
        "precondition: Git preview must be active"
    );
    let mut git_rail_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        git_rail_ticket,
        crate::history::Page {
            rows: vec![user("distant")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            git_rail_accepted = true;
            true
        },
    );
    assert!(
        !git_rail_accepted && rt.state.messages.iter().all(|m| m.id != "distant"),
        "admit_window must reject a rail jump once a Git preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        git_rail_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && git_scan_cancelled.is_closed()
            && owner(&mut rt.state).scan.is_none()
            && owner(&mut rt.state).outline.is_none()
            && !search::is_open(&rt.state),
        "poll() must suspend timeline/search, cancel in-flight rail jump and outline scan, and drop uncacheable outline when a Git preview opens"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !crate::git::has_preview(&rt.state)
            && !search::is_open(&rt.state)
            && rt.presented("history-search").is_none(),
        "closing Git preview must keep history search closed"
    );
    // Also verify a search-originated jump behind a Git preview.
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
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::seek_message(s, "distant-behind-git", tx));
    let (git_search_ticket, git_search_cancelled) = match rx.try_recv().expect("git search jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    rt.update(|s, _| crate::git::fixture_open_preview(s));
    let mut git_search_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        git_search_ticket,
        crate::history::Page {
            rows: vec![user("distant-behind-git")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            git_search_accepted = true;
            true
        },
    );
    assert!(
        !git_search_accepted
            && rt
                .state
                .messages
                .iter()
                .all(|m| m.id != "distant-behind-git"),
        "admit_window must reject a search jump once a Git preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        git_search_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && !search::is_open(&rt.state),
        "poll() must suspend timeline/search and cancel in-flight search jump when a Git preview opens"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !search::is_open(&rt.state) && rt.presented("history-search").is_none(),
        "closing Git preview after search jump must keep history search closed"
    );

    // 7. Isolate has_pending_or_locked: with the rail already disabled (live=false, visible=false)
    //    and history search closed, opening a Files or Git preview must still call suspend() to
    //    cancel a pending jump or locked search state.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !owner(&mut rt.state).live && !owner(&mut rt.state).visible && !search::is_open(&rt.state),
        "precondition: rail already inactive and search closed before isolated Files/Git preview suspension"
    );
    // (a) Files preview suspends a pending jump when rail is already inactive.
    rt.update(|s, tx| navigation::seek_message(s, "distant-no-rail-files", tx));
    let (_no_rail_files_ticket, no_rail_files_cancelled) =
        match rx.try_recv().expect("search jump with rail disabled") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
    rt.update(|s, _| {
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
    });
    rt.frame(0.016);
    assert!(
        no_rail_files_cancelled.is_closed() && !owner(&mut rt.state).jump.has_flight(),
        "opening Files preview when rail is already inactive must suspend via has_pending_or_locked"
    );
    rt.update(|s, _| s.files = None);
    for _ in 0..3 {
        rt.frame(0.016);
    }
    // (b) Git preview suspends a locked search selection when rail is already inactive.
    rt.update(|s, tx| {
        if s.messages.iter().all(|m| m.id != "row-0") {
            s.messages.push(user("row-0"));
            s.revision += 1;
        }
        navigation::seek_message(s, "row-0", tx);
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.is_locked()
            && !owner(&mut rt.state).live
            && !owner(&mut rt.state).visible
            && !search::is_open(&rt.state),
        "precondition: locked search jump with inactive rail and closed search before Git preview"
    );
    rt.update(|s, _| crate::git::fixture_open_preview(s));
    rt.frame(0.016);
    assert!(
        !owner(&mut rt.state).jump.is_locked(),
        "opening Git preview when rail is already inactive must clear locked search jump via has_pending_or_locked"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    rt.frame(0.016);
    // (c) Isolate jump.retry alone (no flight, unlocked, inactive rail, closed search) for both
    //     Files and Git previews.
    let retry_marker = || Marker {
        id: String::new(),
        message: "retry-only".into(),
        kind: MarkerKind::User,
        ordinal: 0,
        continued: false,
        omitted_before: false,
        tool: None,
        pending: false,
    };
    rt.update(|s, _| {
        owner(s).jump.retry = Some(retry_marker());
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_some()
            && rt.presented("timeline-jump-retry").is_some()
            && !owner(&mut rt.state).jump.has_flight()
            && !owner(&mut rt.state).jump.is_locked()
            && !owner(&mut rt.state).live
            && !owner(&mut rt.state).visible
            && !search::is_open(&rt.state),
        "precondition: standalone jump.retry banner mounted with inactive rail and closed search before Files preview"
    );
    rt.update(|s, _| {
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_none() && rt.presented("timeline-jump-retry").is_none(),
        "opening Files preview when rail is already inactive must clear standalone jump.retry via suspend() changed=true"
    );
    rt.update(|s, _| {
        s.files = None;
        owner(s).jump.retry = Some(retry_marker());
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_some() && rt.presented("timeline-jump-retry").is_some()
    );
    rt.update(|s, _| crate::git::fixture_open_preview(s));
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_none() && rt.presented("timeline-jump-retry").is_none(),
        "opening Git preview when rail is already inactive must clear standalone jump.retry via suspend() changed=true"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    rt.frame(0.016);
}
