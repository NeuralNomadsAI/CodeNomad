use super::{sessions::can_rebind, *};

fn row(id: &str) -> Session {
    Session {
        id: id.into(),
        title: id.into(),
    }
}

#[test]
fn refreshing_the_opened_folder_keeps_previously_listed_linked_sessions() {
    let mut launcher = Launcher::fixture();
    launcher.sessions = vec![row("root"), row("linked")];
    launcher.creation_uncertain = true;
    launcher.apply_directory_refresh(
        Sessions {
            rows: vec![row("root")],
            next: None,
        },
        None,
    );
    assert_eq!(
        launcher
            .sessions
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["root", "linked"]
    );
    assert!(!launcher.creation_uncertain);
}

#[test]
fn an_admitted_page_is_not_truncated_at_the_browse_budget() {
    let mut launcher = Launcher::fixture();
    launcher.sessions = (0..1_999)
        .map(|index| row(&format!("old-{index}")))
        .collect();
    let rows = (0..101).map(|i| row(&format!("more-{i}"))).collect();
    launcher.apply_listing(Sessions { rows, next: None }, true, None);
    assert_eq!(launcher.sessions.len(), 2_100);
    launcher.next = Some("continue".into());
    assert!(launcher.can_page());
    launcher.consume_cursor("continue");
    assert!(!launcher.can_page());
    launcher.next = None;
    assert_eq!(launcher.sessions.last().unwrap().id, "more-100");
    assert!(launcher.next.is_none());
}

#[test]
fn partial_refresh_keeps_history_and_omission_probes_only_previously_listed_visits() {
    let mut launcher = Launcher::fixture();
    launcher.apply_listing(
        Sessions {
            rows: vec![row("a"), row("b")],
            next: None,
        },
        false,
        None,
    );
    launcher.visits.record("a", None, true);
    launcher.visits.record("b", None, true);
    launcher.apply_listing(
        Sessions {
            rows: vec![row("b")],
            next: Some("continuation".into()),
        },
        false,
        Some("b"),
    );
    assert_eq!(
        launcher
            .visits
            .steps(true, Some("b"))
            .next()
            .map(|(_, id)| id),
        Some("a")
    );
    launcher.visits.record("a", None, false);
    assert!(!launcher.listed_sessions.contains("a"));
    assert_eq!(launcher.visits.listed_ids().next(), Some("a"));
    launcher.visits.record("child", None, false);
    assert_eq!(launcher.listed_visits_not_seen(), ["a"]);
}

#[test]
fn terminal_omission_is_not_enough_to_retire_a_visit() {
    let mut state = crate::init();
    crate::gallery::shell::fixture(&mut state);
    let mut rt = rune::Runtime::new(
        state,
        crate::view,
        (1000.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    rt.update(|s, tx| {
        let l = s.screen.launcher_mut().unwrap();
        l.visits.record("a", None, true);
        l.apply_listing(
            Sessions {
                rows: vec![row("b")],
                next: None,
            },
            true,
            None,
        );
        assert!(can_visit(s, true));
        let (out, input) = bounded(1);
        s.screen
            .launcher_mut()
            .unwrap()
            .visits
            .start_checks(&["a".into()], input);
        assert!(
            out.try_send(("a".into(), codenomad_client::runtime::Instant::now()))
                .is_ok()
        );
        assert!(poll(s, tx));
        assert!(!can_visit(s, true));
    });
}

#[test]
fn pending_selection_cannot_consume_the_departing_draft() {
    let mut state = crate::init();
    crate::gallery::shell::fixture(&mut state);
    let (out, commands) = bounded(1);
    state.commands = Some(out);
    state.draft = TextEdit::new("keep this draft");
    state.screen.launcher_mut().unwrap().pending = true;
    let mut rt = rune::Runtime::new(
        state,
        crate::view,
        (1000.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    rt.update(crate::send);
    assert!(commands.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "keep this draft");
    rt.update(|s, tx| {
        s.screen.launcher_mut().unwrap().listing = true;
        crate::send(s, tx);
    });
    assert!(
        matches!(commands.try_recv(), Ok(crate::transport::Command::Prompt(prompt)) if prompt.text == "keep this draft")
    );
    rt.update(|s, _| s.phase = Phase::Streaming);
    assert!(!can_change_session(&rt.state));
}

#[test]
fn a_new_navigation_intent_invalidates_an_admitted_notification_selection() {
    let mut s = crate::init();
    crate::gallery::shell::fixture(&mut s);
    s.phase = Phase::Ready;
    let (out, input) = bounded(1);
    let ticket = s.notifications.navigation_ticket();
    let launcher = s.screen.launcher_mut().unwrap();
    launcher.result = Some(input);
    launcher.selection_ticket = Some(ticket);
    launcher.pending = true;
    let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    assert!(
        out.try_send(Ok(Reply::Selected(
            vec![],
            Some((backend, "Stale".into(), None, Instant::now(), "root".into())),
            None,
        )))
        .is_ok()
    );
    s.notifications.supersede_navigation();
    let mut runtime =
        rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
    runtime.update(|s, tx| {
        assert!(poll(s, tx));
        assert_eq!(s.chat_title, "Fixture conversation");
        assert!(!s.screen.launcher().unwrap().pending);
    });
}

#[test]
fn a_selection_reply_cannot_replace_a_session_that_resumed_streaming() {
    let mut state = crate::init();
    crate::gallery::shell::fixture(&mut state);
    let (out, input) = bounded(1);
    let launcher = state.screen.launcher_mut().unwrap();
    launcher.result = Some(input);
    launcher.pending = true;
    let (events, incoming) = bounded(1);
    state.incoming = Some(incoming);
    assert!(
        events
            .try_send(crate::transport::Event::Sync(crate::history::Page {
                rows: vec![],
                older: None,
                newer: None,
                running: true,
                user_file_references: false,
            }))
            .is_ok()
    );
    let backend = Backend {
        client: codenomad_client::http::Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "header-windows".into(),
        session: "another".into(),
        client_id: "fixture".into(),
        session_directory: None,
        fresh_mode: false,
    };
    assert!(
        out.try_send(Ok(Reply::Selected(
            vec![],
            Some((
                backend,
                "Another".into(),
                None,
                Instant::now(),
                "root".into()
            )),
            None
        )))
        .is_ok()
    );
    let mut rt = rune::Runtime::new(
        state,
        crate::view,
        (1000.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    rt.update(|s, tx| {
        crate::poll(s, 0.0, tx);
    });
    assert!(rt.state.phase == Phase::Streaming);
    assert_eq!(rt.state.chat_title, "Fixture conversation");
    assert!(!rt.state.screen.launcher().unwrap().pending);
}

#[test]
fn a_rebind_of_the_current_session_keeps_the_last_history_until_sync() {
    let mut state = crate::init();
    crate::gallery::shell::fixture(&mut state);
    let backend = Backend {
        client: codenomad_client::http::Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "header-windows".into(),
        session: "session".into(),
        client_id: "fixture".into(),
        session_directory: None,
        fresh_mode: false,
    };
    let launcher = state.screen.launcher_mut().unwrap();
    let project = launcher.project.clone().unwrap();
    launcher.connection = Some(backend.clone());
    state.workspace = Some(crate::workspace::Ui::new());
    crate::workspace::opened(&mut state, &project);
    crate::workspace::bound(&mut state, &backend);
    state.draft = TextEdit::new("held draft");
    let mut agent = crate::agent::Ui::new(crate::agent::start(backend.clone(), state.wake.clone()));
    agent
        .reasons
        .insert("pending".into(), TextEdit::new("unsent answer"));
    agent.busy = true;
    state.agent = Some(agent);
    state.phase = Phase::Failed;
    assert!(can_rebind(&state, "session") && crate::agent::navigation_blocked(&state));
    let mut rt = rune::Runtime::new(
        state,
        crate::view,
        (1100.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    rt.update(move |s, tx| bind(s, backend, "Fixture conversation".into(), None, "root", tx));
    assert_eq!(rt.state.draft.text, "held draft");
    assert_eq!(rt.state.messages.len(), 1);
    assert_eq!(rt.state.messages[0].body, "Fixture message");
    assert!(rt.state.phase == Phase::Loading);
    assert_eq!(
        rt.state.agent.as_ref().unwrap().reasons["pending"].text,
        "unsent answer"
    );
    assert!(rt.state.agent.as_ref().unwrap().busy);
}
#[test]
fn session_choices_remain_visible_in_the_scrolling_launcher() {
    for viewport in [(320.0, 640.0), (1400.0, 1600.0)] {
        let mut state = crate::init();
        let mut launcher = Launcher::with_boot(std::sync::Arc::new(|| {}), None);
        launcher.connection = Some(Backend {
            client: codenomad_client::http::Http::new().unwrap(),
            base: "http://127.0.0.1:9/".into(),
            workspace: String::new(),
            session: String::new(),
            client_id: "fixture".into(),
            session_directory: None,
            fresh_mode: false,
        });
        launcher.project = Some(Project {
            id: "project".into(),
            path: "/fixture".into(),
        });
        launcher.sessions = vec![Session {
            id: "existing".into(),
            title: "Existing history".into(),
        }];
        state.screen = crate::Screen::Launcher(launcher);
        let mut runtime =
            rune::Runtime::new(state, crate::view, viewport, rune::Env::new(false, 1.0));
        for _ in 0..8 {
            runtime.frame(1.0 / 60.0);
        }
        if viewport.0 < 610.0 {
            let (x, y) = runtime.find("sessions-panel-toggle").unwrap();
            runtime.pointer_down(x, y);
            runtime.pointer_up(x, y);
        }
        runtime.update(|_, tx| {
            tx.scroll_into_view("session-existing");
            tx.instant();
        });
        for _ in 0..12 {
            runtime.frame(1.0 / 60.0);
        }
        let choice = runtime
            .elements()
            .into_iter()
            .find(|e| e.path.ends_with("/session-existing"))
            .unwrap();
        let [_, y, _, height] = choice.rect;
        assert!(
            height > 0.0 && y < viewport.1 && y + height > 0.0,
            "session choice must have visible geometry: {:?}",
            choice.rect
        );
        let (x, y) = runtime.find("session-existing").unwrap();
        assert!(x >= 0.0 && x < viewport.0 && y >= 0.0 && y < viewport.1);
    }
}
#[test]
fn bootstrap_failure_reaches_the_rendered_launcher() {
    let (out, input) = bounded(1);
    let mut state = crate::init();
    state.screen =
        crate::Screen::Launcher(Launcher::with_boot(std::sync::Arc::new(|| {}), Some(input)));
    out.try_send(Err("private backend startup detail".into()))
        .unwrap();
    let mut runtime = rune::Runtime::new(
        state,
        crate::view,
        (640.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    runtime.poll = Some(crate::poll);
    runtime.frame(0.0);
    assert_eq!(
        runtime.state.screen.launcher().unwrap().error,
        Some("rune.connect_error")
    );
    let tree = runtime.accessibility_json().to_string();
    assert!(tree.contains(crate::strings::t("rune.connect_error")));
    assert!(!tree.contains("private backend startup detail"));
}
#[test]
fn shared_fields_edit_their_inner_models_and_stale_launcher_input_is_discarded() {
    let mut state = crate::init();
    let mut launcher = Launcher::fixture();
    launcher.address = TextEdit::new("");
    launcher.password = TextEdit::new("");
    state.screen = crate::Screen::Launcher(launcher);
    let mut rt = rune::Runtime::new(
        state,
        crate::view,
        (640.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    rt.frame(0.0);
    for (key, value) in [
        ("server-address", "synthetic-server"),
        ("server-password", "synthetic-password"),
    ] {
        let node = rt
            .elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some(key))
            .unwrap();
        assert_eq!(node.fill, rune_theme_codenomad::field_kit(false).c.bg_base);
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.paste(value);
        rt.frame(0.02);
    }
    assert_eq!(
        rt.state.screen.launcher().unwrap().address.text,
        "synthetic-server"
    );
    assert_eq!(
        rt.state.screen.launcher().unwrap().password.text,
        "synthetic-password"
    );
    rt.state.show_chat();
    rt.state.draft = TextEdit::new("current composer");
    rt.paste("late password edit");
    rt.frame(0.02);
    assert_eq!(
        rt.state.screen.launcher().unwrap().password.text,
        "synthetic-password"
    );
    assert_eq!(rt.state.draft.text, "current composer");
}

#[test]
fn reauthentication_settles_pending_prompt_and_rebinds_active_session() {
    crate::platform::block_on(async {
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = crate::workspace::Ui::new();
        ui.fixture_ready();
        s.workspace = Some(ui);
        let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let project = Project {
            id: "proj-1".into(),
            path: "/repo".into(),
        };
        if let Some(l) = s.screen.launcher_mut() {
            l.connection = Some(backend.clone());
            l.project = Some(project.clone());
        }
        crate::workspace::opened(&mut s, &project);
        let bound = Backend {
            workspace: project.id.clone(),
            session: "ses-1".into(),
            ..backend.clone()
        };
        crate::workspace::bound(&mut s, &bound);
        let (_cmd_tx, _cmd_rx) = bounded::<crate::transport::Command>(1);
        s.commands = Some(_cmd_tx);
        let (_ev_tx, ev_rx) = bounded::<crate::transport::Event>(1);
        s.incoming = Some(ev_rx);
        s.draft = TextEdit::new("unsent prompt");
        let (send_tx, _send_rx) = bounded(1);
        s.commands = Some(send_tx);
        s.phase = Phase::Ready;
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
        rt.update(|s, tx| {
            crate::composer::send(s, tx, false);
        });
        assert!(rt.state.composer.pending());
        assert!(rt.state.draft.text.is_empty());

        rt.state.phase = Phase::Reconnecting;
        let (out, input) = bounded(1);
        {
            let l = rt.state.screen.launcher_mut().unwrap();
            l.authentication_required = true;
            l.result = Some(input);
            l.pending = true;
        }
        rt.state.show_launcher();
        let renewed = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        assert!(
            out.try_send(Ok(Reply::Connected(renewed, vec![project], "srv-1".into())))
                .is_ok()
        );
        rt.update(|s, tx| {
            assert!(poll(s, tx));
        });
        assert!(!rt.state.composer.pending());
        assert_eq!(rt.state.draft.text, "unsent prompt");
        assert!(!rt.state.screen.is_launcher());
        assert!(rt.state.screen.launcher().unwrap().pending);
    });
}
