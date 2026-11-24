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

#[cfg(not(target_arch = "wasm32"))]
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
        let (ev_tx, ev_rx) = bounded::<crate::transport::Event>(4);
        s.incoming = Some(ev_rx);
        s.draft = TextEdit::new("unsent prompt");
        let (send_tx, send_rx) = bounded(1);
        s.commands = Some(send_tx);
        s.phase = Phase::Ready;
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
        rt.update(|s, tx| {
            crate::composer::send(s, tx, false);
        });
        assert!(rt.state.composer.pending());
        assert!(rt.state.draft.text.is_empty());
        let attempted = match send_rx.try_recv().expect("sent prompt command") {
            crate::transport::Command::Prompt(prompt) => prompt.id.expect("prompt id"),
            other => panic!("unexpected command: {other:?}"),
        };

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
            out.try_send(Ok(Reply::Connected(
                renewed.clone(),
                vec![project.clone()],
                "srv-1".into(),
            )))
            .is_ok()
        );
        rt.update(|s, tx| {
            assert!(poll(s, tx));
        });
        // Re-authentication keeps the old receiver alive until the in-flight prompt settles,
        // and preserves rebind_after_send across a tab switch round-trip.
        assert!(rt.state.composer.pending());
        assert!(!rt.state.screen.is_launcher());
        assert!(!rt.state.screen.launcher().unwrap().pending);
        rt.update(|s, tx| {
            crate::workspace::new_tab(s, tx);
            let _ = poll(s, tx);
            crate::workspace::select_index(s, 0, tx);
        });
        assert!(rt.state.composer.pending());
        assert!(!rt.state.screen.is_launcher());

        // When the old transport reports an explicit 401 rejection, the draft restores without locking sends
        // and the launcher automatically rebinds the session on the renewed connection.
        assert!(
            ev_tx
                .try_send(crate::transport::Event::PromptAcknowledged {
                    attempted,
                    outcome: crate::transport::PromptOutcome::Rejected,
                })
                .is_ok()
        );
        assert!(
            ev_tx
                .try_send(crate::transport::Event::AuthenticationRequired(
                    codenomad_client::transport::Authentication {
                        backend: bound,
                        confirmed: true,
                    },
                ))
                .is_ok()
        );
        rt.update(|s, tx| {
            assert!(crate::chat::events::poll_chat(s, 32));
            assert!(poll(s, tx));
        });
        assert!(!rt.state.composer.pending());
        assert_eq!(rt.state.draft.text, "unsent prompt");
        assert!(!rt.state.screen.is_launcher());
        assert!(!rt.state.screen.launcher().unwrap().authentication_required);
        assert!(rt.state.screen.launcher().unwrap().pending);
        // Settle the rebind reply on the renewed connection and verify the new commands channel allows sending.
        let (rebind_out, rebind_in) = bounded(1);
        rt.state.screen.launcher_mut().unwrap().result = Some(rebind_in);
        let rebound = Backend {
            workspace: project.id.clone(),
            session: "ses-1".into(),
            ..renewed
        };
        assert!(
            rebind_out
                .try_send(Ok(Reply::Selected(
                    vec![],
                    Some((rebound, "Chat".into(), None, Instant::now(), "root".into())),
                    None,
                )))
                .is_ok()
        );
        rt.update(|s, tx| {
            assert!(poll(s, tx));
        });
        assert!(!rt.state.screen.launcher().unwrap().pending);
        assert!(rt.state.commands.is_some());
        rt.state.phase = Phase::Ready;
        assert!(crate::composer::can_send(&rt.state));
        assert_eq!(rt.state.draft.text, "unsent prompt");
    });
}

#[test]
fn failed_session_selection_reply_cannot_hide_authentication_required() {
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
    crate::workspace::opened(&mut s, &project);
    let bound = Backend {
        workspace: project.id.clone(),
        session: "ses-1".into(),
        ..backend.clone()
    };
    crate::workspace::bound(&mut s, &bound);
    s.phase = Phase::Failed;
    s.show_launcher();
    let (out, input) = bounded(1);
    {
        let l = s.screen.launcher_mut().unwrap();
        l.authentication_required = true;
        l.result = Some(input);
        l.pending = true;
    }
    assert!(
        out.try_send(Ok(Reply::Selected(
            vec![],
            Some((
                bound.clone(),
                "Retry".into(),
                None,
                Instant::now(),
                "root".into()
            )),
            None,
        )))
        .is_ok()
    );
    let mut rt = rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(rt.state.screen.is_launcher());
    assert!(rt.state.screen.launcher().unwrap().authentication_required);

    // Late Reply::Placed while authentication_required must also stay on the login screen.
    let (placed_out, placed_in) = bounded(1);
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.result = Some(placed_in);
        l.pending = true;
    }
    assert!(
        placed_out
            .try_send(Ok(Reply::Placed(
                bound,
                "Moved".into(),
                "wt-1".into(),
                true,
                true,
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(rt.state.screen.is_launcher());
    assert!(rt.state.screen.launcher().unwrap().authentication_required);

    // Reply::Created whose navigation ticket was superseded (e.g. a newer Files preview opened)
    // inserts the created session into the list without stealing focus from the current screen.
    let old_ticket = rt.state.notifications.navigation_ticket();
    rt.state.notifications.supersede_navigation();
    let (created_out, created_in) = bounded(1);
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.authentication_required = false;
        l.result = Some(created_in);
        l.pending = true;
    }
    let created_backend = Backend {
        workspace: "proj-1".into(),
        session: "ses-new".into(),
        ..backend
    };
    assert!(
        created_out
            .try_send(Ok(Reply::Created(
                created_backend,
                "New".into(),
                "root".into(),
                String::new(),
                None,
                Some(old_ticket),
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(rt.state.screen.is_launcher());
    assert!(
        rt.state
            .screen
            .launcher()
            .unwrap()
            .sessions
            .iter()
            .any(|row| row.id == "ses-new")
    );
}

#[test]
fn linked_creation_uncertain_survives_root_refresh_until_authoritative_inventory() {
    let mut launcher = Launcher::fixture();
    launcher.creation_uncertain = true;
    launcher.creation_uncertain_linked = Some("/wt-a".into());
    launcher.apply_directory_refresh(
        Sessions {
            rows: vec![row("root")],
            next: None,
        },
        None,
    );
    assert!(launcher.creation_uncertain);
    assert!(launcher.creation_uncertain_linked.is_some());
    launcher.apply_listing(
        Sessions {
            rows: vec![row("root")],
            next: None,
        },
        false,
        None,
    );
    assert!(launcher.creation_uncertain);
    assert!(launcher.creation_uncertain_linked.is_some());
    // An authoritative root-only fallback (includes_linked = false) must not unlock a linked creation.
    launcher.error = Some("rune.create_error");
    launcher.apply_passive_listing(
        Sessions {
            rows: vec![row("root")],
            next: None,
        },
        None,
        true,
        false,
    );
    assert!(launcher.creation_uncertain);
    assert!(launcher.creation_uncertain_linked.is_some());
    assert_eq!(launcher.error, Some("rune.create_error"));
    // A direct linked target page (authoritative = false, includes_linked = true) merges
    // additively (retaining existing root sessions) and unlocks creation_uncertain_linked.
    launcher.apply_passive_listing(
        Sessions {
            rows: vec![row("linked-new")],
            next: None,
        },
        None,
        false,
        true,
    );
    assert!(!launcher.creation_uncertain);
    assert!(launcher.creation_uncertain_linked.is_none());
    assert_eq!(launcher.error, None);
    assert!(launcher.sessions.iter().any(|r| r.id == "root"));
    assert!(launcher.sessions.iter().any(|r| r.id == "linked-new"));
}

#[test]
fn reauthentication_stops_unlisted_detached_projects_and_defers_permission_write_rebind() {
    let mut s = crate::init();
    crate::gallery::shell::fixture(&mut s);
    let mut ui = crate::workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    let project_a = Project {
        id: "proj-a".into(),
        path: "/repo-a".into(),
    };
    let project_b = Project {
        id: "proj-b".into(),
        path: "/repo-b".into(),
    };
    let bound_a = Backend {
        workspace: project_a.id.clone(),
        session: String::new(),
        ..backend.clone()
    };
    let bound_b = Backend {
        workspace: project_b.id.clone(),
        session: "ses-b".into(),
        ..backend.clone()
    };
    {
        let l = s.screen.launcher_mut().unwrap();
        l.connection = Some(backend.clone());
        l.project = Some(project_a.clone());
    }
    crate::workspace::opened(&mut s, &project_a);
    s.show_launcher();
    s.files = Some(crate::files::Ui::new(
        bound_a.clone(),
        project_a.path.clone(),
        s.reads.clone(),
        s.wake.clone(),
    ));
    crate::git::connected(&mut s, &bound_a);

    let mut rt = rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
    rt.update(|s, tx| {
        crate::workspace::new_tab(s, tx);
        let l = s.screen.launcher_mut().unwrap();
        l.connection = Some(backend.clone());
        l.project = Some(project_b.clone());
        crate::workspace::opened(s, &project_b);
        crate::workspace::bound(s, &bound_b);
        s.show_chat();
    });

    // While tab B has an in-flight permission write and auth expired, reauthentication
    // stops detached tab A (not in fresh projects list) and defers tab B's rebind.
    rt.state.status_permissions.fixture_writing(true);
    let (out, input) = bounded(1);
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.authentication_required = true;
        l.result = Some(input);
        l.pending = true;
    }
    assert!(
        out.try_send(Ok(Reply::Connected(
            backend.clone(),
            vec![project_b.clone()],
            "srv-1".into(),
        )))
        .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(!rt.state.screen.is_launcher());
    assert_eq!(
        rt.state
            .screen
            .launcher()
            .unwrap()
            .rebind_after_send
            .as_deref(),
        Some("ses-b")
    );
    // Settling the permission write triggers the deferred rebind automatically.
    rt.state.status_permissions.fixture_writing(false);
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(
        rt.state
            .screen
            .launcher()
            .unwrap()
            .rebind_after_send
            .is_none()
    );
    assert!(rt.state.screen.launcher().unwrap().pending);

    // Refused tab switch and refused named create while pending do not invalidate navigation tickets.
    let ticket = rt.state.notifications.navigation_ticket();
    let (created_out, created_in) = bounded(1);
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.title = TextEdit::new("Blocked title");
        l.result = Some(created_in);
        l.pending = true;
    }
    rt.update(|s, tx| {
        crate::workspace::select_index(s, 0, tx);
        create(s, tx);
    });
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
    assert_eq!(rt.state.notifications.navigation_ticket(), ticket);
    let created_backend = Backend {
        workspace: project_b.id.clone(),
        session: "ses-created".into(),
        ..backend
    };
    assert!(
        created_out
            .try_send(Ok(Reply::Created(
                created_backend,
                "Created".into(),
                "root".into(),
                String::new(),
                None,
                Some(ticket),
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert_eq!(
        crate::workspace::active_session(&rt.state),
        Some("ses-created")
    );

    // Switching back to cached tab A shows its detached Files panel stayed stopped after reauth.
    rt.update(|s, tx| {
        crate::workspace::select_index(s, 0, tx);
    });
    assert!(rt.state.files.as_ref().unwrap().stopped);

    // Clicking cached tab B while authentication_required stays on Screen::Launcher (never empty view).
    rt.state
        .screen
        .launcher_mut()
        .unwrap()
        .authentication_required = true;
    rt.update(|s, tx| {
        crate::workspace::select_index(s, 1, tx);
    });
    assert!(rt.state.screen.is_launcher());
    assert!(rt.state.screen.launcher().unwrap().authentication_required);

    // A workspace.stopped observed while Reply::Opened is in flight stops the opened project
    // instead of inserting it into opened_after.
    let (opened_out, opened_in) = bounded(1);
    let (_reconcile_tx, reconcile_rx) = bounded(1);
    let project_c = Project {
        id: "proj-c".into(),
        path: "/repo-c".into(),
    };
    let opening_c = rt
        .state
        .screen
        .launcher()
        .unwrap()
        .openings
        .begin(
            rt.state
                .screen
                .launcher()
                .unwrap()
                .connection
                .clone()
                .unwrap(),
            "tab-c",
        )
        .unwrap()
        .fixture_opening(project_c.clone());
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.authentication_required = false;
        l.detached_reconcile = Some((1, HashSet::new(), reconcile_rx));
        l.pending_stream_generation = 1;
        l.stopped_during_pending.insert(project_c.id.clone());
        l.result = Some(opened_in);
        l.pending = true;
    }
    assert!(
        opened_out
            .try_send(Ok(Reply::Opened(
                opening_c,
                Sessions {
                    rows: vec![],
                    next: None
                },
                Restored::Empty,
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(
        !rt.state
            .screen
            .launcher()
            .unwrap()
            .detached_reconcile
            .as_ref()
            .unwrap()
            .1
            .contains("proj-c")
    );
    assert!(rt.state.files.as_ref().unwrap().stopped);

    // Reply::Opened started before an SSE disconnect/reconnect (generation 1 vs reconcile 3)
    // is not inserted into opened_after and replaces the stale pre-open reconcile read so a
    // stale GET /api/workspaces snapshot cannot stop the freshly opened project.
    let (opened_out_d, opened_in_d) = bounded(1);
    let (reconcile_tx_d, reconcile_rx_d) = bounded(1);
    let project_d = Project {
        id: "proj-d".into(),
        path: "/repo-d".into(),
    };
    let opening_d = rt
        .state
        .screen
        .launcher()
        .unwrap()
        .openings
        .begin(
            rt.state
                .screen
                .launcher()
                .unwrap()
                .connection
                .clone()
                .unwrap(),
            "tab-d",
        )
        .unwrap()
        .fixture_opening(project_d.clone());
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.detached_reconcile = Some((3, HashSet::new(), reconcile_rx_d));
        l.pending_stream_generation = 1;
        l.result = Some(opened_in_d);
        l.pending = true;
    }
    assert!(
        opened_out_d
            .try_send(Ok(Reply::Opened(
                opening_d,
                Sessions {
                    rows: vec![],
                    next: None
                },
                Restored::Empty,
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(
        reconcile_tx_d.try_send(Some(vec![])).is_err(),
        "stale pre-open reconcile channel must be dropped so it cannot stop proj-d"
    );
    assert!(
        !rt.state
            .screen
            .launcher()
            .unwrap()
            .detached_reconcile
            .as_ref()
            .unwrap()
            .1
            .contains("proj-d")
    );

    // Reply::Created whose workspace stopped while creation was in flight must not bind or list it.
    let (created_out, created_in) = bounded(1);
    let mut created_backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    created_backend.workspace = "proj-stopped".into();
    created_backend.session = "ses-stopped".into();
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.sessions.clear();
        l.stopped_during_pending.insert("proj-stopped".into());
        l.result = Some(created_in);
        l.pending = true;
    }
    assert!(
        created_out
            .try_send(Ok(Reply::Created(
                created_backend,
                "New".into(),
                "root".into(),
                String::new(),
                None,
                None,
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(rt.state.screen.is_launcher());
    assert!(
        rt.state
            .screen
            .launcher()
            .unwrap()
            .sessions
            .iter()
            .all(|row| row.id != "ses-stopped"),
        "Reply::Created for a project stopped in flight must not list or bind the session"
    );
}

#[test]
fn reauthentication_hydrates_unbound_restored_attachment_draft() {
    let mut s = crate::init();
    crate::gallery::shell::fixture(&mut s);
    let mut ui = crate::workspace::Ui::new();
    ui.fixture_ready();
    let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    let project = Project {
        id: "proj-att".into(),
        path: "/repo-att".into(),
    };
    let mut draft = crate::composer::draft::Draft::default();
    draft
        .attachments
        .push(crate::composer::draft::Attachment::Path(
            "src/main.rs".into(),
        ));
    let saved_parts =
        crate::composer::draft_storage::SavedParts::capture(&draft, false, &TextEdit::new("fix"))
            .unwrap();
    let snapshot = crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![crate::workspace::Tab::Workspace(
            crate::workspace::Workspace {
                backend_id: Some("external".into()),
                server_id: Some("srv-att".into()),
                folder: project.path.clone(),
                occurrence: 0,
                workspace_id: Some(project.id.clone()),
                active_session_id: Some("ses-att".into()),
                drafts: [("ses-att".into(), "fix".into())].into_iter().collect(),
                attachment_drafts: ["ses-att".into()].into_iter().collect(),
                attachment_parts: [("ses-att".into(), saved_parts)].into_iter().collect(),
                view: Default::default(),
            },
        )],
        active: Some(0),
    };
    ui.fixture_hydrate(snapshot);
    s.workspace = Some(ui);
    let opening = s
        .screen
        .launcher()
        .unwrap()
        .openings
        .begin(backend.clone(), "tab-0")
        .unwrap()
        .fixture_opening(project.clone());
    let bound_backend = Backend {
        workspace: project.id.clone(),
        session: "ses-att".into(),
        ..backend.clone()
    };

    // Auth expires before Reply::Opened is processed: Restored::Bound is skipped, leaving
    // Screen::Launcher active with s.files == None and saved attachment parts unhydrated.
    s.show_launcher();
    let (open_out, open_in) = bounded(1);
    {
        let l = s.screen.launcher_mut().unwrap();
        l.connection = Some(backend.clone());
        l.server_id = Some("srv-att".into());
        l.authentication_required = true;
        l.result = Some(open_in);
        l.pending = true;
    }
    assert!(
        open_out
            .try_send(Ok(Reply::Opened(
                opening,
                Sessions {
                    rows: vec![],
                    next: None
                },
                Restored::Bound(bound_backend.clone(), "Title".into(), "root".into()),
            )))
            .is_ok()
    );
    let mut rt = rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(rt.state.screen.is_launcher());
    assert!(rt.state.files.is_none());

    // Reauthentication keeps Screen::Launcher until Reply::Selected binds the session so
    // workspace::bound hydrates the recoverable attachment parts and initializes Files.
    let (conn_out, conn_in) = bounded(1);
    {
        let l = rt.state.screen.launcher_mut().unwrap();
        l.result = Some(conn_in);
        l.pending = true;
    }
    assert!(
        conn_out
            .try_send(Ok(Reply::Connected(
                backend,
                vec![project],
                "srv-att".into(),
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(rt.state.screen.is_launcher());
    assert!(rt.state.screen.launcher().unwrap().pending);

    let (sel_out, sel_in) = bounded(1);
    rt.state.screen.launcher_mut().unwrap().result = Some(sel_in);
    assert!(
        sel_out
            .try_send(Ok(Reply::Selected(
                vec![],
                Some((
                    bound_backend,
                    "Title".into(),
                    None,
                    Instant::now(),
                    "root".into()
                )),
                None,
            )))
            .is_ok()
    );
    rt.update(|s, tx| {
        assert!(poll(s, tx));
    });
    assert!(!rt.state.screen.is_launcher());
    assert_eq!(rt.state.draft.text, "fix");
    assert!(!rt.state.composer.attachments_missing);
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    assert!(rt.state.files.is_some());
}
