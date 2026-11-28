use super::*;

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn a_recorded_notification_click_returns_to_its_own_project_and_conversation_once() {
    use crate::files::test_http::{Http as Fixture, wait};
    use serde_json::json;
    crate::platform::block_on(async {
        let http = Fixture::new().await;
        let (wake, events) = bounded(1);
        let mut s = draft_state();
        s.screen.launcher_mut().unwrap().connection = Some(http.backend.clone());
        let mut first = workspace("session-first", "");
        first.workspace_id = Some("workspace-first".into());
        let mut second = workspace("session-second", "");
        second.workspace_id = Some("workspace-second".into());
        let ui = s.workspace.as_mut().unwrap();
        ui.entries[0].saved = Tab::Workspace(first);
        ui.entries[0].binding = Some(Backend {
            workspace: "workspace-first".into(),
            session: "session-first".into(),
            ..http.backend.clone()
        });
        ui.entries
            .push(entry("tab-1".into(), Tab::Workspace(second)));
        s.notifications.record();
        let mut other = init();
        other.notifications.record();
        let original = notification_target(&s).unwrap().0;
        assert_eq!(original.backend_url, http.backend.base);
        let mut rt = runtime(s);
        rt.update(|s, tx| {
            let (target, title) = notification_target(s).unwrap();
            s.notifications
                .present(&title, "Question", target.clone(), s.wake.clone());
            other.notifications.present(
                &title,
                "Another window",
                target.clone(),
                other.wake.clone(),
            );
            assert_eq!(s.notifications.recorded()[0].1, "fixture");
            assert_eq!(other.notifications.recorded()[0].2, "Another window");
            select(s, "tab-1", tx);
            assert_eq!(active_session(s), Some("session-second"));
            assert!(owns_notification(s, &target));
            s.screen.launcher_mut().unwrap().pending = true;
            s.wake = std::sync::Arc::new(move || {
                let _ = wake.try_send(());
            });
            s.notifications.simulate_click(0);
            assert!(!crate::shell::notifications::poll(&mut other, tx));
            assert!(!crate::shell::notifications::poll(s, tx));
            assert_eq!(active_session(s), Some("session-second"));
        });
        let project = http.accept().await;
        assert!(project.header.starts_with("GET /api/workspaces HTTP/"));
        project
            .reply(
                200,
                json!([{"id":"workspace-first","location":{"directory":"/fixture"}}]),
            )
            .await;
        let session = http.accept().await;
        assert!(session.header.starts_with(
            "GET /workspaces/workspace-first/instance/api/session/session-first HTTP/"
        ));
        rt.update(|s, tx| {
            assert!(!crate::shell::notifications::poll(s, tx));
            assert_eq!(active_session(s), Some("session-second"));
        });
        session
            .reply(
                200,
                json!({"data":{"id":"session-first","location":{"directory":"/fixture"}}}),
            )
            .await;
        wait(events.recv()).await.unwrap();
        rt.update(|s, tx| {
            assert!(!crate::shell::notifications::poll(s, tx));
            s.screen.launcher_mut().unwrap().pending = false;
            assert!(!crate::shell::notifications::poll(s, tx));
            assert_eq!(active_session(s), Some("session-second"));
        });
        http.accept()
            .await
            .reply(
                200,
                json!([{"id":"workspace-first","location":{"directory":"/fixture"}}]),
            )
            .await;
        http.accept()
            .await
            .reply(
                200,
                json!({"data":{"id":"session-first","location":{"directory":"/fixture"}}}),
            )
            .await;
        wait(events.recv()).await.unwrap();
        rt.update(|s, tx| {
            assert!(crate::shell::notifications::poll(s, tx));
            assert_eq!(s.workspace.as_ref().unwrap().active_key(), "tab-0");
            assert_eq!(active_session(s), Some("session-first"));
            select(s, "tab-1", tx);
            s.notifications.simulate_click(0);
            assert!(!crate::shell::notifications::poll(s, tx));
            assert_eq!(active_session(s), Some("session-second"));
            s.notifications
                .present("fixture", "Deleted", original.clone(), s.wake.clone());
            s.notifications.simulate_click(1);
            assert!(!crate::shell::notifications::poll(s, tx));
        });
        http.accept()
            .await
            .reply(
                200,
                json!([{"id":"workspace-first","location":{"directory":"/fixture"}}]),
            )
            .await;
        http.accept()
            .await
            .reply(
                404,
                json!({"_tag":"SessionNotFoundError","sessionID":"session-first"}),
            )
            .await;
        wait(events.recv()).await.unwrap();
        rt.update(|s, tx| {
            assert!(!crate::shell::notifications::poll(s, tx));
            assert_eq!(s.workspace.as_ref().unwrap().active_key(), "tab-1");
            let mut stale = original;
            stale.occurrence += 1;
            s.notifications
                .present("fixture", "Stale", stale, s.wake.clone());
            s.notifications.simulate_click(2);
            assert!(!crate::shell::notifications::poll(s, tx));
            assert_eq!(active_session(s), Some("session-second"));
        });
    });
}

#[test]
fn closing_the_active_tab_supersedes_a_pending_notification_click() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries.push(entry("tab-1".into(), Tab::Blank));
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.update(|s, tx| {
        let pending = s.notifications.navigation_ticket();
        close(s, "tab-0", tx);
        assert_ne!(s.notifications.navigation_ticket(), pending);
        assert_eq!(s.workspace.as_ref().unwrap().active_key(), "tab-1");
    });
}

#[test]
fn panel_visibility_returns_only_with_its_own_project_tab() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries.push(entry("tab-1".into(), Tab::Blank));
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.update(|s, tx| {
        s.shell.wanted = [Some([false, true]), None];
        select(s, "tab-1", tx);
        assert_eq!(s.shell.wanted, [None; 2]);
        s.shell.wanted = [Some([true, false]), None];
        select(s, "tab-0", tx);
        assert_eq!(s.shell.wanted, [Some([false, true]), None]);
        select(s, "tab-1", tx);
        assert_eq!(s.shell.wanted, [Some([true, false]), None]);
    });
}

#[test]
fn right_panel_selection_is_specific_to_each_project_occurrence() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("first", ""));
    ui.entries.push(entry(
        "tab-1".into(),
        Tab::Workspace(workspace("second", "")),
    ));
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.update(|s, tx| {
        assert!(files_tab(s));
        set_files_tab(s, false);
        assert!(!files_tab(s));
        select(s, "tab-1", tx);
        assert!(files_tab(s));
        select(s, "tab-0", tx);
        assert!(!files_tab(s));
        let saved = s.workspace.as_ref().unwrap().snapshot();
        assert!(
            matches!(&saved.tabs[0], Tab::Workspace(w) if w.view.files_mode == Some("workspace"))
        );
        assert!(
            matches!(&saved.tabs[1], Tab::Workspace(w) if w.view.files_mode == Some("workspace"))
        );
    });
}

#[test]
fn opened_project_defaults_to_files_and_unsupported_missions_falls_back_to_files() {
    let mut s = init();
    crate::gallery::shell::fixture(&mut s);
    let project = s.screen.launcher().unwrap().project.clone().unwrap();
    let mut ui = Ui::new();
    ui.ready = true;
    s.workspace = Some(ui);
    opened(&mut s, &project);

    assert_eq!(right_panel_tab(&s), crate::workspace::RightPanelTab::Files);
    assert!(files_tab(&s));
    let saved = s.workspace.as_ref().unwrap().snapshot();
    assert!(matches!(
        &saved.tabs[0],
        Tab::Workspace(w) if w.view.files_mode == Some("workspace")
    ));

    set_right_panel_tab(&mut s, crate::workspace::RightPanelTab::Missions);
    assert!(!mission_supported(&s));
    assert_eq!(right_panel_tab(&s), crate::workspace::RightPanelTab::Files);

    set_right_panel_tab(&mut s, crate::workspace::RightPanelTab::Status);
    assert_eq!(right_panel_tab(&s), crate::workspace::RightPanelTab::Status);
    assert!(!files_tab(&s));
}

#[test]
fn sidebar_search_and_title_edits_are_kept_only_by_their_origin_tab() {
    let mut s = init();
    crate::gallery::shell::fixture(&mut s);
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].project = s.screen.launcher().unwrap().project.clone();
    ui.entries.push(entry("tab-1".into(), Tab::Blank));
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.update(|s, tx| {
        let launcher = s.screen.launcher_mut().unwrap();
        launcher.search = TextEdit::new("alpha");
        launcher.title = TextEdit::new("unsent title");
        launcher.show_title = true;
        launcher.show_search = true;
        launcher.creation_uncertain = true;
        select(s, "tab-1", tx);
        assert!(s.screen.launcher().unwrap().search.text.is_empty());
        assert!(!s.screen.launcher().unwrap().creation_uncertain);
        select(s, "tab-0", tx);
        let launcher = s.screen.launcher_mut().unwrap();
        assert_eq!(launcher.search.text, "alpha");
        assert_eq!(launcher.title.text, "unsent title");
        assert!(launcher.show_title && launcher.show_search);
        assert!(launcher.creation_uncertain);
        assert_eq!(launcher.error, Some("rune.create_error"));
        launcher.creation_uncertain = false;
        launcher.error = None;
        assert!(!s.workspace.as_ref().unwrap().entries[0].creation_uncertain);
        resume(s, tx);
        let launcher = s.screen.launcher().unwrap();
        assert!(!launcher.creation_uncertain);
        assert_eq!(launcher.error, None);
        assert_eq!(launcher.title.text, "unsent title");
    });
}

#[test]
fn a_press_held_on_send_is_cancelled_when_the_pending_selection_binds() {
    let mut s = init();
    crate::gallery::shell::fixture(&mut s);
    let mut ui = Ui::new();
    ui.ready = true;
    let mut saved = workspace("old-session", "Old draft");
    saved
        .drafts
        .insert("new-session".into(), "New draft".into());
    ui.entries[0].saved = Tab::Workspace(saved);
    ui.entries[0].binding = Some(backend("old-session"));
    let (old_commands, old) = bounded(1);
    s.commands = Some(old_commands);
    s.draft = TextEdit::new("Old draft");
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    for _ in 0..8 {
        rt.frame(0.02);
    }
    let (x, y) = rt.find("send").unwrap();
    rt.pointer_down(x, y);
    rt.frame(0.02);
    let (new_commands, new) = bounded(1);
    rt.update(move |s, tx| {
        s.draft = TextEdit::new(bound(s, &backend("new-session")));
        s.commands = Some(new_commands);
        s.renew_scope();
        tx.instant();
    });
    rt.frame(0.02);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(old.try_recv().is_err() && new.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "New draft");
}

#[test]
fn retry_rebinds_when_the_event_lane_is_gone_even_if_the_command_relay_is_open() {
    let mut s = init();
    crate::gallery::shell::fixture(&mut s);
    let backend = backend("session");
    let launcher = s.screen.launcher_mut().unwrap();
    launcher.connection = Some(backend.clone());
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("session", "keep this draft"));
    ui.entries[0].binding = Some(backend);
    s.workspace = Some(ui);
    s.draft = TextEdit::new("keep this draft");
    s.phase = Phase::Failed;
    let (events, incoming) = bounded(1);
    drop(events);
    s.incoming = Some(incoming);
    let (out, relay) = bounded(1);
    s.commands = Some(out);
    let mut rt = runtime(s);
    rt.update(crate::retry_connection);
    assert!(
        rt.state.screen.launcher().unwrap().pending,
        "retry starts a targeted read"
    );
    assert!(relay.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "keep this draft");
}

#[test]
fn confirmed_missing_selection_does_not_block_future_project_restoration() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("missing", "saved draft"));
    ui.entries[0].binding = Some(backend("missing"));
    s.workspace = Some(ui);
    s.draft = TextEdit::new("unsent latest");
    assert!(!unselect_missing(&mut s, "another"));
    assert!(unselect_missing(&mut s, "missing"));
    let snapshot = s.workspace.as_ref().unwrap().snapshot();
    let saved = crate::workspace::decode(&crate::workspace::encode(&snapshot).unwrap()).unwrap();
    let Tab::Workspace(project) = &saved.tabs[0] else {
        panic!("workspace must remain")
    };
    assert_eq!(project.active_session_id, None);
    assert!(!project.drafts.contains_key("missing"));
    assert_eq!(
        project.drafts[crate::workspace::NO_SESSION_DRAFT_ID],
        "unsent latest"
    );
}

#[test]
fn waiting_saved_session_keeps_its_draft_until_native_binding() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("native-session", "été\n日本語🦀"));
    s.workspace = Some(ui);
    capture(&mut s);
    let Tab::Workspace(saved) = &s.workspace.as_ref().unwrap().snapshot().tabs[0] else {
        panic!()
    };
    assert_eq!(saved.drafts["native-session"], "été\n日本語🦀");
    assert!(s.commands.is_none());
}

#[test]
fn files_follow_their_occurrence_through_tab_switches_and_hidden_stream_events() {
    use codenomad_client::{
        files::{Entry as File, EntryKind},
        transport::WorkspaceEvent,
    };
    fn files(s: &State, name: &str) -> crate::files::Ui {
        let mut b = backend("same-session");
        b.workspace = name.into();
        let mut ui = crate::files::Ui::new(b, "/fixture".into(), s.reads.clone(), s.wake.clone());
        ui.tree.activate(true);
        let read = ui.tree.take_refresh().pop().unwrap();
        assert!(ui.tree.complete(
            read,
            Ok(vec![File {
                path: name.into(),
                name: name.into(),
                kind: EntryKind::File,
                absolute_path: None,
                directory_identity: None,
                size: None,
                modified_at: None,
            }]),
            Ok
        ));
        ui.tree.select(name.into());
        ui.activate(false);
        ui
    }
    let mut s = init();
    s.phase = Phase::Ready;
    s.files = Some(files(&s, "alpha"));
    let (out, incoming) = bounded(64);
    s.incoming = Some(incoming);
    let mut ui = Ui::new();
    ui.ready = true;
    let mut other = init();
    other.phase = Phase::Ready;
    other.files = Some(files(&other, "beta"));
    let mut second = entry("tab-1".into(), Tab::Blank);
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    rt.update(|s, tx| select(s, "tab-1", tx));
    assert_eq!(
        rt.state.files.as_ref().unwrap().tree.selected(),
        Some("beta")
    );
    out.try_send(crate::transport::Event::Workspace(
        WorkspaceEvent::Stopped {
            workspace_id: "alpha".into(),
            deleted: false,
            temporary_retained: false,
        },
    ))
    .unwrap();
    rt.frame(0.1);
    let active = rt.state.files.as_ref().unwrap();
    assert!(!active.stopped);
    assert_eq!(active.tree.selected(), Some("beta"));
    rt.update(|s, tx| select(s, "tab-0", tx));
    let restored = rt.state.files.as_ref().unwrap();
    assert!(restored.stopped);
    assert_eq!(restored.tree.selected(), Some("alpha"));
    assert_eq!(restored.tree.rows()[0].entry.name, "alpha");
    rt.update(|s, tx| select(s, "tab-1", tx));
    rt.update(|s, tx| close(s, "tab-0", tx));
    assert_eq!(
        rt.state.files.as_ref().unwrap().tree.selected(),
        Some("beta")
    );
}

#[test]
fn two_occurrences_keep_their_drafts_when_the_user_selects_another_tab() {
    let mut s = init();
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("Alpha local");
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("alpha", "Alpha saved"));
    ui.entries[0].binding = Some(backend("alpha"));
    let mut other = init();
    other.phase = Phase::Ready;
    other.draft = TextEdit::new("Beta\n🦀");
    let mut second = entry(
        "tab-1".into(),
        Tab::Workspace(workspace("beta", "Beta\n🦀")),
    );
    second.binding = Some(backend("beta"));
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.frame(0.0);
    rt.update(|s, tx| select(s, "tab-1", tx));
    assert_eq!(rt.state.draft.text, "Beta\n🦀");
    rt.update(|s, tx| select(s, "tab-0", tx));
    assert_eq!(rt.state.draft.text, "Alpha local");
    let snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(alpha) = &snapshot.tabs[0] else {
        panic!()
    };
    let Tab::Workspace(beta) = &snapshot.tabs[1] else {
        panic!()
    };
    assert_eq!(alpha.drafts["alpha"], "Alpha local");
    assert_eq!(beta.drafts["beta"], "Beta\n🦀");
}

#[test]
fn six_tabs_leave_only_the_fresh_draft_when_a_large_recall_is_suspended() {
    use crate::composer::draft::{Attachment, MAX_FILE};
    use crate::transport::{Command, PromptOutcome};
    use std::sync::{Arc, Weak};

    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries.clear();
    let (send, requests) = bounded(1);
    for i in 0..6 {
        let session = format!("session-{i}");
        let fresh = format!("fresh-{i}");
        let mut item = entry(
            format!("tab-{i}"),
            Tab::Workspace(workspace(&session, &fresh)),
        );
        item.binding = Some(backend(&session));
        let mut state = init();
        state.phase = Phase::Ready;
        state.commands = Some(send.clone());
        state.draft = TextEdit::new(&fresh);
        state.composer.picker.set_attachments_supported(true);
        item.cache = Some(Cache::take(&mut state));
        ui.entries.push(item);
    }
    ui.entries[0].cache.take().unwrap().apply(&mut s);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    let mut first: Option<Weak<[u8]>> = None;
    for i in 0..6 {
        rt.update(|s, tx| select(s, &format!("tab-{i}"), tx));
        rt.update(|s, tx| {
            s.draft.replace_text(format!("attempt-{i}"));
            for file in 0..3 {
                let bytes: Arc<[u8]> = Arc::from(vec![i as u8; MAX_FILE]);
                if i == 0 && file == 0 {
                    first = Some(Arc::downgrade(&bytes));
                }
                assert!(s.composer.draft.attach(Attachment::Device {
                    name: format!("file-{file}"),
                    mime: "application/octet-stream".into(),
                    bytes,
                    token: None,
                }));
            }
            crate::composer::send(s, tx, false);
        });
        let Command::Prompt(prompt) = requests.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        let id = prompt.id.unwrap();
        rt.update(|s, tx| {
            crate::composer::acknowledge(s, &id, PromptOutcome::Confirmed(id.clone()));
            s.draft.replace_text(format!("fresh-{i}"));
            draft_changed(s, tx);
            assert!(crate::composer::recall::step(s, true, true, tx));
            assert_eq!(s.draft.text, format!("attempt-{i}"));
            assert_eq!(s.composer.draft.inline_usage().1, 3 * MAX_FILE);
        });
    }
    assert!(
        first.unwrap().upgrade().is_none(),
        "inactive recall pinned an evicted payload"
    );
    for i in 0..6 {
        rt.update(|s, tx| select(s, &format!("tab-{i}"), tx));
        assert!(rt.state.composer.recall.is_none());
        assert_eq!(rt.state.draft.text, format!("fresh-{i}"));
        assert!(rt.state.composer.draft.attachments.is_empty());
    }
}

#[test]
fn hidden_tab_drains_events_without_changing_active_conversation() {
    let mut s = init();
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("Active draft");
    let mut ui = Ui::new();
    ui.ready = true;
    let mut other = init();
    other.phase = Phase::Streaming;
    let (out, incoming) = bounded(64);
    other.incoming = Some(incoming);
    out.try_send(crate::transport::Event::Done).unwrap();
    let mut second = entry("tab-1".into(), Tab::Blank);
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    assert!(rt.state.phase == Phase::Ready);
    assert_eq!(rt.state.draft.text, "Active draft");
    let hidden = rt.state.workspace.as_mut().unwrap().entries[1]
        .cache
        .take()
        .unwrap();
    let mut scratch = init();
    hidden.apply(&mut scratch);
    assert!(scratch.phase == Phase::Ready);
    assert!(scratch.incoming.as_ref().unwrap().try_recv().is_err());
}
#[test]
fn polling_preserves_the_active_editor_scope_and_tab_switch_expires_it() {
    let mut s = init();
    s.phase = Phase::Ready;
    let mut ui = Ui::new();
    ui.ready = true;
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.poll = Some(crate::poll);
    let scope = rt.state.input_scope.clone();
    for _ in 0..8 {
        rt.frame(0.02);
    }
    assert!(rt.state.current_scope(&scope));
    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.paste("active input");
    rt.frame(0.02);
    assert_eq!(rt.state.draft.text, "active input");
    rt.update(|s, tx| new_tab(s, tx));
    assert!(!rt.state.current_scope(&scope));
    let active = rt.state.draft.text.clone();
    rt.state
        .editor(&scope, crate::screen::Editor::Composer)
        .text
        .push_str("late");
    assert_eq!(rt.state.draft.text, active);
}

#[test]
#[cfg(feature = "test-support")]
fn closing_active_or_cached_tab_keeps_a_draft_after_its_reader_closed() {
    let mut s = init();
    s.phase = Phase::Ready;
    let mut workspace = Ui::new();
    workspace.ready = true;
    let mut other = init();
    other.phase = Phase::Ready;
    let mut second = entry("tab-1".into(), Tab::Blank);
    second.cache = Some(Cache::take(&mut other));
    workspace.entries.push(second);
    s.workspace = Some(workspace);
    let mut files = crate::files::Ui::new(
        backend("draft-session"),
        "/fixture".into(),
        s.reads.clone(),
        s.wake.clone(),
    )
    .with_documents(s.documents.clone(), "tab-0".into());
    files.open("draft.txt".into());
    files.reader.scene(Ok(codenomad_client::files::Preview {
        workspace_id: "fixture".into(),
        path: "draft.txt".into(),
        bytes: b"original".to_vec(),
        version: Some("v1".into()),
    }));
    files.document.online(true);
    files.document.poll(&mut files.reader);
    let scope = files.document.scope();
    files.document.input(scope).replace_text("unsaved");
    files.document.changed(scope);
    files.close_reader();
    s.files = Some(files);
    let mut rt = runtime(s);
    rt.frame(0.0);
    rt.update(|s, tx| close(s, "tab-0", tx));
    assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
    rt.update(|s, tx| select(s, "tab-1", tx));
    rt.update(|s, tx| close(s, "tab-0", tx));
    assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
    rt.update(|s, tx| select(s, "tab-0", tx));
    rt.update(|s, _| s.files.as_mut().unwrap().open("draft.txt".into()));
    assert_eq!(
        rt.state.files.as_ref().unwrap().document.edit().text,
        "unsaved"
    );
}
