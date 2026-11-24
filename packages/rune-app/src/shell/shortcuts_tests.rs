use crate::{
    Phase, Screen, State,
    backend::Backend,
    catalog::{Project, Session},
    gallery::shell::fixture,
    init, settings, strings, workspace,
};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, edit::TextEdit};
use serde_json::json;

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..6 {
        rt.frame(1.0 / 60.0);
    }
}

fn primary_mods(shift: bool) -> Mods {
    Mods {
        ctrl: !cfg!(target_os = "macos"),
        cmd: true,
        logo: cfg!(target_os = "macos"),
        shift,
        alt: false,
    }
}

fn send_key(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    let event = KeyEvent { key, mods };
    rt.key(event.clone());
    settle(rt);
    rt.key_up(event);
}

fn workspace_state(tabs: usize) -> State {
    let mut s = init();
    fixture(&mut s);
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let project = s.screen.launcher().unwrap().project.clone().unwrap();
    workspace::opened(&mut s, &project);
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    for i in 1..tabs {
        rt.update(|s, tx| {
            workspace::new_tab(s, tx);
            let next = Project {
                id: format!("project-{i}"),
                path: format!("/repo-{i}"),
            };
            if let Some(l) = s.screen.launcher_mut() {
                l.project = Some(next.clone());
                l.sessions = vec![Session {
                    id: format!("session-{i}"),
                    title: format!("Session {i}"),
                }];
            }
            workspace::opened(s, &next);
        });
    }
    rt.update(|s, tx| workspace::select(s, "tab-0", tx));
    rt.state
}

fn project_runtime(s: State) -> Runtime<State> {
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);
    rt
}

#[test]
fn app_tab_navigation_shortcuts_follow_defaults_overrides_and_disable() {
    let mut rt = project_runtime(workspace_state(3));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

    // Default instance-next / instance-prev wrap around.
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 2);
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    send_key(&mut rt, Key::Command('['), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 2);

    // Direct app-tab-2 selects index 1; out-of-range app-tab-9 is a safe no-op.
    send_key(&mut rt, Key::Command('2'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
    send_key(&mut rt, Key::Command('9'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);

    // Overrides and explicit empty disable.
    settings::fixture_shortcuts(
        &rt.state,
        json!({
            "instance-next": [{"key": "f8"}],
            "instance-prev": [],
            "app-tab-1": [{"key": "f9"}]
        }),
    );
    send_key(&mut rt, Key::Command('['), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 2);
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
}

#[test]
fn close_instance_respects_file_edit_and_pending_form_guards() {
    let mut rt = project_runtime(workspace_state(2));
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);

    // Unsaved file edit in the active tab blocks close-instance.
    let backend = Backend {
        workspace: "header-windows".into(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    let mut files = crate::files::Ui::new(
        backend.clone(),
        "/repo".into(),
        rt.state.reads.clone(),
        rt.state.wake.clone(),
    )
    .with_documents(rt.state.documents.clone(), "tab-0".into());
    files.online(true);
    files.open("draft.txt".into());
    files.reader.scene(Ok(codenomad_client::files::Preview {
        workspace_id: backend.workspace.clone(),
        path: "draft.txt".into(),
        bytes: b"original".to_vec(),
        version: Some("v1".into()),
    }));
    files.document.poll(&mut files.reader);
    let scope = files.document.scope();
    files.document.input(scope).replace_text("unsaved edit");
    files.document.changed(scope);
    assert!(rt.state.documents.has_tab_edits("tab-0"));
    rt.state.files = Some(files);
    send_key(&mut rt, Key::Command('w'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);

    // Clearing the dirty edit unblocks the document guard.
    if let Some(files) = &mut rt.state.files {
        let scope = files.document.scope();
        files.document.input(scope).replace_text("original");
        files.document.changed(scope);
    }
    assert!(!rt.state.documents.has_tab_edits("tab-0"));

    // Pending agent form edit also blocks close-instance.
    let handle = crate::agent::start(backend, rt.state.wake.clone());
    let mut agent = crate::agent::Ui::new(handle);
    agent.forms.push(crate::agent_api::Form {
        id: "form-1".into(),
        title: "Confirm".into(),
        fields: vec![json!({"key":"name","type":"string"})],
    });
    agent.drafts.insert(
        ("form-1".into(), "name".into()),
        crate::agent::forms::Draft {
            dirty: true,
            ..Default::default()
        },
    );
    rt.state.agent = Some(agent);
    send_key(&mut rt, Key::Command('w'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);

    // Clearing the blocking state lets close-instance close the tab.
    rt.state.agent = None;
    send_key(&mut rt, Key::Command('w'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 1);
}

#[test]
fn session_new_opens_sidebar_and_title_and_honors_guards_and_overrides() {
    let mut rt = project_runtime(workspace_state(1));
    // Collapse the sessions panel first.
    let (x, y) = rt.find("sessions-panel-toggle").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(!rt.state.shell.visible(0));

    // Streaming blocks session-new.
    rt.state.phase = Phase::Streaming;
    send_key(&mut rt, Key::Command('n'), primary_mods(true));
    assert!(!rt.state.shell.visible(0));
    assert!(!rt.state.screen.launcher().unwrap().show_title);

    // Ready allows session-new: reveals the sidebar, opens and focuses session-title.
    rt.state.phase = Phase::Ready;
    send_key(&mut rt, Key::Command('n'), primary_mods(true));
    assert!(rt.state.shell.visible(0));
    assert!(rt.state.screen.launcher().unwrap().show_title);
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.focused && el.path.contains("/session-title/"))
    );

    // Custom override works and disabled [] suppresses it.
    rt.state.screen.launcher_mut().unwrap().show_title = false;
    settings::fixture_shortcuts(&rt.state, json!({"session-new": [{"key": "f7"}]}));
    send_key(&mut rt, Key::Command('n'), primary_mods(true));
    assert!(!rt.state.screen.launcher().unwrap().show_title);
    send_key(&mut rt, Key::Function(7), Mods::default());
    assert!(rt.state.screen.launcher().unwrap().show_title);
}

#[test]
fn close_session_clears_active_session_preserves_draft_and_honors_guards() {
    let mut s = workspace_state(1);
    let backend = Backend {
        workspace: "header-windows".into(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    if let Some(l) = s.screen.launcher_mut() {
        l.connection = Some(Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    workspace::bound(&mut s, &backend);
    let mut files = crate::files::Ui::new(
        backend.clone(),
        "/repo".into(),
        s.reads.clone(),
        s.wake.clone(),
    )
    .with_documents(s.documents.clone(), "tab-0".into());
    files.online(true);
    files.open("draft.txt".into());
    files.reader.scene(Ok(codenomad_client::files::Preview {
        workspace_id: backend.workspace.clone(),
        path: "draft.txt".into(),
        bytes: b"original".to_vec(),
        version: Some("v1".into()),
    }));
    files.document.poll(&mut files.reader);
    let scope = files.document.scope();
    files.document.input(scope).replace_text("unsaved edit");
    files.document.changed(scope);
    s.files = Some(files);
    s.draft = TextEdit::new("unsent draft");
    let mut rt = project_runtime(s);
    assert!(!rt.state.screen.is_launcher());
    assert_eq!(workspace::active_session(&rt.state), Some("session"));

    // Dirty file editor blocks close-session.
    send_key(&mut rt, Key::Command('w'), primary_mods(true));
    assert!(!rt.state.screen.is_launcher());
    assert_eq!(workspace::active_session(&rt.state), Some("session"));

    if let Some(files) = &mut rt.state.files {
        let scope = files.document.scope();
        files.document.input(scope).replace_text("original");
        files.document.changed(scope);
    }

    // Streaming blocks close-session.
    rt.state.phase = Phase::Streaming;
    send_key(&mut rt, Key::Command('w'), primary_mods(true));
    assert!(!rt.state.screen.is_launcher());
    assert_eq!(workspace::active_session(&rt.state), Some("session"));

    // Ready closes the active session, keeps the project + Files/Git attached, and saves the draft.
    rt.state.phase = Phase::Ready;
    send_key(&mut rt, Key::Command('w'), primary_mods(true));
    assert!(rt.state.screen.is_launcher());
    assert!(rt.state.screen.launcher().unwrap().project.is_some());
    assert_eq!(workspace::active_session(&rt.state), None);
    assert!(rt.state.files.is_some());
    assert!(rt.state.git.owner.is_some());
    let snap = rt.state.workspace.as_ref().unwrap().snapshot();
    let workspace::Tab::Workspace(saved) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        saved.drafts.get("session").map(String::as_str),
        Some("unsent draft")
    );
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn session_prev_next_and_session_tabs_select_visible_sessions_and_respect_overrides() {
    use crate::files::test_http::Http as Fixture;
    crate::platform::block_on(async {
        let http = Fixture::new().await;
        let mut s = workspace_state(1);
        let project = Project {
            id: "proj-1".into(),
            path: "/repo".into(),
        };
        let l = s.screen.launcher_mut().unwrap();
        l.connection = Some(http.backend.clone());
        l.project = Some(project.clone());
        l.sessions = vec![
            Session {
                id: "s-1".into(),
                title: "Alpha".into(),
            },
            Session {
                id: "s-2".into(),
                title: "Beta".into(),
            },
            Session {
                id: "s-3".into(),
                title: "Gamma".into(),
            },
        ];
        workspace::opened(&mut s, &project);
        let bound = Backend {
            workspace: "proj-1".into(),
            session: "s-1".into(),
            ..http.backend.clone()
        };
        workspace::bound(&mut s, &bound);
        let mut rt = project_runtime(s);

        async fn expect_bind(rt: &mut Runtime<State>, http: &Fixture, expected: &str) {
            assert!(
                rt.state.screen.launcher().unwrap().pending,
                "expected pending session bind for {expected}"
            );
            let title = match expected {
                "s-1" => "Alpha",
                "s-2" => "Beta",
                _ => "Gamma",
            };
            let want = format!("GET /workspaces/proj-1/instance/api/session/{expected}");
            loop {
                let req = http.accept().await;
                if req.header.starts_with(&want) {
                    req.reply(
                        200,
                        json!({"data":{"id":expected,"title":title,"location":{"directory":"/repo"}}}),
                    )
                    .await;
                    break;
                }
                assert!(
                    !req.header
                        .starts_with("GET /workspaces/proj-1/instance/api/session/"),
                    "unexpected session request: {}",
                    req.header
                );
                req.reply(404, json!({})).await;
            }
            for _ in 0..40 {
                let mut done = false;
                rt.update(|s, tx| done = crate::launcher::poll(s, tx));
                if done {
                    break;
                }
                crate::platform::sleep(std::time::Duration::from_millis(5)).await;
            }
            settle(rt);
            assert_eq!(workspace::active_session(&rt.state), Some(expected));
        }

        // session-next (Ctrl+Shift+] via logical '}') moves s-1 -> s-2.
        send_key(&mut rt, Key::Command('}'), primary_mods(true));
        expect_bind(&mut rt, &http, "s-2").await;

        // session-prev (Ctrl+Shift+[ via logical '{') moves s-2 -> s-1.
        send_key(&mut rt, Key::Command('{'), primary_mods(true));
        expect_bind(&mut rt, &http, "s-1").await;

        // session-prev wraps s-1 -> s-3.
        send_key(&mut rt, Key::Command('{'), primary_mods(true));
        expect_bind(&mut rt, &http, "s-3").await;

        // session-tab-2 (Ctrl+Shift+2) jumps directly to s-2.
        send_key(&mut rt, Key::Command('2'), primary_mods(true));
        expect_bind(&mut rt, &http, "s-2").await;

        // Filtered search restricts session-next to matching visible sessions only.
        {
            let l = rt.state.screen.launcher_mut().unwrap();
            l.show_search = true;
            l.search = TextEdit::new("Gamma");
        }
        send_key(&mut rt, Key::Command('}'), primary_mods(true));
        expect_bind(&mut rt, &http, "s-3").await;

        // Override on session-tab-1 selects the first visible session.
        {
            let l = rt.state.screen.launcher_mut().unwrap();
            l.show_search = false;
            l.search = TextEdit::new("");
        }
        settings::fixture_shortcuts(&rt.state, json!({"session-tab-1": [{"key": "f8"}]}));
        send_key(&mut rt, Key::Function(8), Mods::default());
        expect_bind(&mut rt, &http, "s-1").await;
    });
}

#[test]
#[cfg(not(target_arch = "wasm32"))]
fn browse_folder_wins_on_home_outside_inputs_and_defers_to_new_instance_otherwise() {
    let mut s = init();
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let mut l = crate::launcher::Launcher::fixture();
    l.connection = Some(Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    s.screen = Screen::Launcher(l);
    let mut rt = project_runtime(s);

    // Home view without focused input: Ctrl+N triggers browse-folder, not new-instance.
    send_key(&mut rt, Key::Command('n'), primary_mods(false));
    assert!(matches!(
        rt.file_dialog(),
        Some((rune::file_dialog::FileDialogKind::Folder, _))
    ));
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 1);
    rt.resolve_file_dialog(None).unwrap();
    settle(&mut rt);

    // While pending, Ctrl+N is consumed without opening a dialog or a new tab.
    rt.state.screen.launcher_mut().unwrap().pending = true;
    send_key(&mut rt, Key::Command('n'), primary_mods(false));
    assert!(rt.file_dialog().is_none());
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 1);
    rt.state.screen.launcher_mut().unwrap().pending = false;

    // Focused folder-path field: browse-folder does not fire; new-instance opens a tab.
    let (x, y) = rt.find("folder-path").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    send_key(&mut rt, Key::Command('n'), primary_mods(false));
    assert!(rt.file_dialog().is_none());
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);

    // Custom override separates browse-folder from new-instance.
    rt.update(|_, tx| tx.focus("browse", true));
    settle(&mut rt);
    settings::fixture_shortcuts(
        &rt.state,
        json!({"browse-folder": [{"key": "o", "mod": true}]}),
    );
    send_key(&mut rt, Key::Command('o'), primary_mods(false));
    assert!(rt.file_dialog().is_some());
    rt.resolve_file_dialog(None).unwrap();
    settle(&mut rt);

    // Project view: Ctrl+N opens a new tab instead of browsing for a folder.
    let mut project_rt = project_runtime(workspace_state(1));
    send_key(&mut project_rt, Key::Command('n'), primary_mods(false));
    assert!(project_rt.file_dialog().is_none());
    assert_eq!(project_rt.state.workspace.as_ref().unwrap().tab_count(), 2);
}

#[test]
fn modals_pickers_composing_inputs_and_repeat_block_global_shortcuts() {
    let mut rt = project_runtime(workspace_state(2));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

    // Notification history modal blocks global shortcuts.
    let (x, y) = rt.find("notification-history-toggle").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(crate::shell::notifications::history_open(&rt.state));
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    let (x, y) = rt.find("notification-history-close").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);

    // Agent model picker blocks global shortcuts.
    let handle = crate::agent::start(
        Backend::unauthenticated("http://127.0.0.1:9/").unwrap(),
        rt.state.wake.clone(),
    );
    let mut agent = crate::agent::Ui::new(handle);
    agent.picker = true;
    rt.state.agent = Some(agent);
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    rt.state.agent = None;

    // IME preedit blocks global shortcuts.
    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    rt.ime(rune::edit::Ime::Preedit("ni".into(), None, Vec::new()));
    settle(&mut rt);
    assert!(rt.state.draft.is_composing());
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    rt.ime(rune::edit::Ime::Preedit(String::new(), None, Vec::new()));
    settle(&mut rt);
    assert!(!rt.state.draft.is_composing());

    // Key repeat never triggers global shortcuts.
    rt.repeat_key(KeyEvent {
        key: Key::Command(']'),
        mods: primary_mods(false),
    });
    settle(&mut rt);
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

    // Plain character remapped to a global shortcut must not steal typing in the composer.
    settings::fixture_shortcuts(&rt.state, json!({"instance-next": [{"key": "a"}]}));
    send_key(&mut rt, Key::Text("a".into()), Mods::default());
    assert_eq!(rt.state.draft.text, "a");
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

    // Unmodified PageUp remapped to a global shortcut does not fire while a text input has focus.
    settings::fixture_shortcuts(&rt.state, json!({"instance-next": [{"key": "pageup"}]}));
    send_key(&mut rt, Key::PageUp, Mods::default());
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    rt.update(|_, tx| tx.focus("sessions-panel-toggle", true));
    settle(&mut rt);
    send_key(&mut rt, Key::PageUp, Mods::default());
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
}

#[test]
fn authentication_required_git_ime_f11_override_and_repeat_consumption() {
    use std::sync::atomic::{AtomicBool, Ordering};

    static LAST_HANDLED: AtomicBool = AtomicBool::new(false);
    fn tracked_keys(s: &mut State, event: &KeyEvent, tx: &mut rune::Tx) -> bool {
        let handled = crate::shell::keys(s, event, tx);
        LAST_HANDLED.store(handled, Ordering::SeqCst);
        handled
    }

    let mut rt = project_runtime(workspace_state(2));
    rt.on_key = Some(tracked_keys);
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

    // Authentication gate blocks all tab navigation and lifecycle shortcuts.
    rt.state
        .screen
        .launcher_mut()
        .unwrap()
        .authentication_required = true;
    for (key, mods) in [
        (Key::Command(']'), primary_mods(false)),
        (Key::Command('['), primary_mods(false)),
        (Key::Command('2'), primary_mods(false)),
        (Key::Command('w'), primary_mods(false)),
        (Key::Command('n'), primary_mods(false)),
    ] {
        send_key(&mut rt, key, mods);
    }
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);
    rt.state
        .screen
        .launcher_mut()
        .unwrap()
        .authentication_required = false;

    // Git commit draft IME composition blocks global shortcuts.
    let backend = Backend {
        workspace: "header-windows".into(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    crate::git::connected(&mut rt.state, &backend);
    crate::git::fixture_commit_preedit(&mut rt.state, "ka");
    assert!(crate::git::is_composing(&rt.state));
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    crate::git::fixture_commit_preedit(&mut rt.state, "");
    assert!(!crate::git::is_composing(&rt.state));

    // Repeat consumes matching global shortcuts without executing, and leaves unmatched keys alone.
    LAST_HANDLED.store(false, Ordering::SeqCst);
    rt.repeat_key(KeyEvent {
        key: Key::Command(']'),
        mods: primary_mods(false),
    });
    settle(&mut rt);
    assert!(LAST_HANDLED.load(Ordering::SeqCst));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

    LAST_HANDLED.store(true, Ordering::SeqCst);
    rt.repeat_key(KeyEvent {
        key: Key::Function(12),
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(!LAST_HANDLED.load(Ordering::SeqCst));

    // Remapping a shortcut to F11 runs the shortcut instead of the default fullscreen fallback.
    settings::fixture_shortcuts(&rt.state, json!({"instance-next": [{"key": "f11"}]}));
    send_key(&mut rt, Key::Function(11), Mods::default());
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
}
