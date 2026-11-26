use super::*;
use crate::{
    Screen, State,
    backend::Backend,
    catalog::{Project, Session},
    gallery::shell::fixture,
    init,
    platform::workspace_open::Editor,
    settings,
    shell::{command_palette, workspace_open},
    strings, workspace,
};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
}

fn send_key(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    let event = KeyEvent { key, mods };
    rt.key(event.clone());
    settle(rt);
    rt.key_up(event);
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

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key: {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

fn focused_key(rt: &Runtime<State>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key)
}

fn focused_path_contains(rt: &Runtime<State>, fragment: &str) -> bool {
    rt.elements()
        .into_iter()
        .any(|el| el.focused && el.path.contains(fragment))
}

fn tab_label(rt: &Runtime<State>, key: &str) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(key))
        .and_then(|el| el.label)
}

fn workspace_state(tabs: usize) -> State {
    let mut s = init();
    fixture(&mut s);
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let project = s.screen.launcher().unwrap().project.clone().unwrap();
    workspace::opened(&mut s, &project);
    let bound = Backend {
        workspace: project.id.clone(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    workspace::bound(&mut s, &bound);
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    for i in 1..tabs {
        rt.update(|s, tx| {
            workspace::new_tab(s, tx);
            let next = Project {
                id: format!("project-{i}"),
                path: format!("/repo-{i}"),
                temporary: false,
            };
            if let Some(l) = s.screen.launcher_mut() {
                l.project = Some(next.clone());
                l.sessions = vec![Session {
                    id: format!("session-{i}-a"),
                    title: format!("Session {i}A"),
                }];
            }
            workspace::opened(s, &next);
        });
    }
    rt.update(|s, tx| workspace::select(s, "tab-0", tx));
    rt.state
}

fn runtime(s: State) -> Runtime<State> {
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    settle(&mut rt);
    rt
}

#[test]
fn f2_on_focused_project_tab_commits_resets_and_propagates_to_sibling() {
    let mut rt = runtime(workspace_state(2));
    // Open a sibling tab of the same folder as tab-0.
    let same_project = rt.state.screen.launcher().unwrap().project.clone().unwrap();
    rt.update(|s, tx| {
        workspace::new_tab(s, tx);
        if let Some(l) = s.screen.launcher_mut() {
            l.project = Some(same_project.clone());
        }
        workspace::opened(s, &same_project);
        workspace::select(s, "tab-0", tx);
    });
    settle(&mut rt);

    // Focus tab-0 and press F2.
    rt.update(|_, tx| tx.focus("t-tab-0", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(is_open(&rt.state));
    assert!(rt.find(theme::DIALOG).is_some());
    assert!(focused_path_contains(&rt, INPUT_KEY));

    // Shell shortcuts are blocked while rename modal is open.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(!command_palette::is_open(&rt.state));
    assert!(is_open(&rt.state));

    // Type a custom name and commit with Enter.
    rt.update(|s, _| {
        s.tab_rename.input = TextEdit::new("  My Custom Repo  ");
    });
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(focused_key(&rt).as_deref(), Some("t-tab-0"));

    assert_eq!(
        workspace::active_project_title(&rt.state),
        Some("My Custom Repo")
    );
    assert_eq!(tab_label(&rt, "t-tab-0").as_deref(), Some("My Custom Repo"));
    // Sibling tab sharing the same folder also updates.
    assert_eq!(tab_label(&rt, "t-tab-2").as_deref(), Some("My Custom Repo"));

    // Rename non-active focused tab-1 via F2 without switching active tab.
    rt.update(|_, tx| tx.focus("t-tab-1", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(is_open(&rt.state));
    assert_eq!(rt.state.tab_rename.tab_key.as_deref(), Some("tab-1"));
    rt.update(|s, _| {
        s.tab_rename.input = TextEdit::new("Repo One");
    });
    send_key(&mut rt, Key::Enter, Mods::default());
    assert_eq!(tab_label(&rt, "t-tab-1").as_deref(), Some("Repo One"));
    assert_eq!(
        workspace::active_project_title(&rt.state),
        Some("My Custom Repo")
    );

    // Empty / whitespace input resets to default folder label.
    rt.update(|_, tx| tx.focus("t-tab-0", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Function(2), Mods::default());
    rt.update(|s, _| {
        s.tab_rename.input = TextEdit::new("   ");
    });
    send_key(&mut rt, Key::Enter, Mods::default());
    assert_eq!(
        workspace::active_project_title(&rt.state),
        Some(same_project.path.as_str())
    );
    assert_eq!(
        tab_label(&rt, "t-tab-0").as_deref(),
        Some(same_project.path.as_str())
    );
    assert_eq!(
        tab_label(&rt, "t-tab-2").as_deref(),
        Some(same_project.path.as_str())
    );
}

#[test]
fn escape_cancel_close_and_outside_click_cancel_without_mutating() {
    let mut rt = runtime(workspace_state(1));
    let original = workspace::active_project_title(&rt.state)
        .unwrap()
        .to_owned();

    // Header trigger opens modal and Escape restores focus to trigger.
    let trigger = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(theme::TRIGGER))
        .expect("header rename button");
    assert_eq!(trigger.label.as_deref(), Some("Rename…"));
    click(&mut rt, theme::TRIGGER);
    assert!(is_open(&rt.state));
    rt.update(|s, _| {
        s.tab_rename.input = TextEdit::new("Unsaved");
    });
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(
        workspace::active_project_title(&rt.state),
        Some(original.as_str())
    );
    assert_eq!(focused_key(&rt).as_deref(), Some(theme::TRIGGER));

    // Cancel button cancels without mutating.
    click(&mut rt, theme::TRIGGER);
    rt.update(|s, _| {
        s.tab_rename.input = TextEdit::new("Canceled");
    });
    click(&mut rt, CANCEL_KEY);
    assert!(!is_open(&rt.state));
    assert_eq!(
        workspace::active_project_title(&rt.state),
        Some(original.as_str())
    );

    // Top-right close button cancels without mutating.
    click(&mut rt, theme::TRIGGER);
    rt.update(|s, _| {
        s.tab_rename.input = TextEdit::new("Closed");
    });
    click(&mut rt, CLOSE_KEY);
    assert!(!is_open(&rt.state));
    assert_eq!(
        workspace::active_project_title(&rt.state),
        Some(original.as_str())
    );

    // Outside backdrop click cancels without mutating.
    click(&mut rt, theme::TRIGGER);
    rt.update(|s, _| {
        s.tab_rename.input = TextEdit::new("Outside");
    });
    rt.pointer_down(12.0, 12.0);
    rt.pointer_up(12.0, 12.0);
    settle(&mut rt);
    assert!(!is_open(&rt.state));
    assert_eq!(
        workspace::active_project_title(&rt.state),
        Some(original.as_str())
    );
}

#[test]
fn shortcut_respects_overrides_disable_blank_tab_and_command_palette_entry() {
    let mut rt = runtime(workspace_state(1));

    // Custom shortcut override works and default F2 stops triggering.
    settings::fixture_shortcuts(
        &rt.state,
        json!({ "instance-rename": [{"key": "r", "alt": true}] }),
    );
    rt.update(|_, tx| tx.focus("t-tab-0", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(!is_open(&rt.state));
    send_key(
        &mut rt,
        Key::Text("r".into()),
        Mods {
            alt: true,
            ..Mods::default()
        },
    );
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());

    // Empty override disables the shortcut.
    settings::fixture_shortcuts(&rt.state, json!({ "instance-rename": [] }));
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(!is_open(&rt.state));

    // Command palette rename-instance opened from header toggle returns focus to that toggle.
    settings::fixture_shortcuts(&rt.state, json!({}));
    click(&mut rt, "command-palette-toggle");
    assert!(command_palette::is_open(&rt.state));
    click(&mut rt, "command-palette-item-rename-instance");
    assert!(!command_palette::is_open(&rt.state));
    assert!(is_open(&rt.state));
    assert!(focused_path_contains(&rt, INPUT_KEY));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert_eq!(focused_key(&rt).as_deref(), Some("command-palette-toggle"));

    // Keyboard activation from a focused tab also returns focus to that tab on Escape.
    rt.update(|_, tx| tx.focus("t-tab-0", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(command_palette::is_open(&rt.state));
    rt.update(|s, _| {
        s.command_palette.query_for_test("rename");
    });
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!command_palette::is_open(&rt.state));
    assert!(is_open(&rt.state));
    assert!(focused_path_contains(&rt, INPUT_KEY));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert_eq!(focused_key(&rt).as_deref(), Some("t-tab-0"));

    // On a blank tab, trigger is hidden and F2 does nothing.
    rt.update(|s, tx| workspace::new_tab(s, tx));
    settle(&mut rt);
    assert!(rt.find(theme::TRIGGER).is_none());
    rt.update(|_, tx| tx.focus("t-tab-1", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(!is_open(&rt.state));
}

#[test]
fn project_name_persists_in_window_snapshot_and_validates_bounds() {
    let snapshot = workspace::Snapshot {
        revision: 1,
        saved_at: 0,
        panel_widths: [None, None],
        file_wrap: None,
        tabs: vec![workspace::Tab::Workspace(workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/repo/alpha".into(),
            project_name: Some("Alpha Custom".into()),
            temporary: false,
            occurrence: 0,
            workspace_id: Some("w-1".into()),
            active_session_id: None,
            drafts: Default::default(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        })],
        active: Some(0),
    };
    let encoded_bytes = workspace::encode(&snapshot).expect("encode snapshot");
    let encoded: serde_json::Value = serde_json::from_slice(&encoded_bytes).expect("encoded json");
    assert_eq!(
        encoded["session"]["tabs"][0]["projectName"],
        json!("Alpha Custom")
    );
    let decoded = workspace::decode(&encoded_bytes).expect("valid snapshot");
    match &decoded.tabs[0] {
        workspace::Tab::Workspace(w) => {
            assert_eq!(w.project_name.as_deref(), Some("Alpha Custom"));
        }
        other => panic!("expected workspace tab, got {other:?}"),
    }

    // Control characters, >4096 UTF-16 units, and blank names drop only projectName on decode.
    let mut bad_ctrl = encoded.clone();
    bad_ctrl["session"]["tabs"][0]["projectName"] = json!("bad\nname");
    let decoded_ctrl =
        workspace::decode(&serde_json::to_vec(&bad_ctrl).unwrap()).expect("ctrl drops only name");
    match &decoded_ctrl.tabs[0] {
        workspace::Tab::Workspace(w) => assert_eq!(w.project_name, None),
        other => panic!("expected workspace tab, got {other:?}"),
    }

    let mut bad_len = encoded.clone();
    bad_len["session"]["tabs"][0]["projectName"] = json!("a".repeat(4097));
    let decoded_len =
        workspace::decode(&serde_json::to_vec(&bad_len).unwrap()).expect("long drops only name");
    match &decoded_len.tabs[0] {
        workspace::Tab::Workspace(w) => assert_eq!(w.project_name, None),
        other => panic!("expected workspace tab, got {other:?}"),
    }

    let mut bad_empty = encoded;
    bad_empty["session"]["tabs"][0]["projectName"] = json!("   ");
    let decoded_empty =
        workspace::decode(&serde_json::to_vec(&bad_empty).unwrap()).expect("blank normalizes");
    match &decoded_empty.tabs[0] {
        workspace::Tab::Workspace(w) => assert_eq!(w.project_name, None),
        other => panic!("expected workspace tab, got {other:?}"),
    }
}

#[test]
fn open_workspace_guards_local_vs_remote_and_palette_registration() {
    let mut rt = runtime(workspace_state(1));
    // In fixture state, launcher.host is None (non-local) -> can_open must be false.
    assert!(!workspace_open::can_open(&rt.state));
    assert!(
        rt.state
            .workspace
            .as_ref()
            .and_then(|_| workspace::active_workspace(&rt.state))
            .is_some_and(|(_, saved)| saved.backend_id.is_some())
    );

    let expected_ids = [
        "open-workspace-folder",
        "open-workspace-terminal",
        Editor::VsCode.command_id(),
        Editor::Cursor.command_id(),
        Editor::Zed.command_id(),
        Editor::VsCodium.command_id(),
    ];

    // Command palette registers all 6 open-workspace commands only on Windows (disabled for remote).
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(command_palette::is_open(&rt.state));
    for id in expected_ids {
        let key = format!("command-palette-item-{id}");
        let el = rt
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some(key.as_str()));
        if workspace_open::available() {
            let _item = el.unwrap_or_else(|| panic!("missing palette item {key}"));
            assert_eq!(
                strings::with_locale("en", || command_palette::item_disabled(&rt.state, id)),
                Some(true),
                "remote workspace must disable {key} in command palette"
            );
        } else {
            assert!(el.is_none(), "non-Windows must hide {key}");
        }
    }
    // Check formatted editor label renders the editor display name (no literal {editor}).
    if workspace_open::available() {
        let vscode = rt
            .elements()
            .into_iter()
            .find(|el| {
                el.key.as_deref() == Some("command-palette-item-open-workspace-editor-vscode")
            })
            .expect("vscode item");
        let label = vscode.label.as_deref().unwrap_or_default();
        assert!(label.contains("VS Code"), "unexpected label: {label}");
        assert!(
            !label.contains("{editor}"),
            "unformatted placeholder: {label}"
        );
    }
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(rt.find("command-palette-query").is_none());

    // Local native host with an open local project enables can_open and all 6 palette items.
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut local_rt = runtime(workspace_state(1));
        let local_project = Project {
            id: "ws-local".into(),
            path: "/local-repo".into(),
            temporary: false,
        };
        local_rt.update(|s, _| {
            if let Some(l) = s.screen.launcher_mut() {
                l.connection = Some(Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
                l.set_fixture_host(crate::platform::LocalHost::fixture(|| {
                    crate::platform::ManagedRenewal::Denied
                }));
                l.project = Some(local_project.clone());
            }
            workspace::opened(s, &local_project);
        });
        settle(&mut local_rt);
        assert_eq!(
            workspace_open::can_open(&local_rt.state),
            workspace_open::available()
        );
        send_key(&mut local_rt, Key::Command('p'), primary_mods(true));
        if workspace_open::available() {
            for id in expected_ids {
                let key = format!("command-palette-item-{id}");
                let _item = local_rt
                    .elements()
                    .into_iter()
                    .find(|el| el.key.as_deref() == Some(key.as_str()))
                    .unwrap_or_else(|| panic!("missing local palette item {key}"));
                assert_eq!(
                    strings::with_locale("en", || {
                        command_palette::item_disabled(&local_rt.state, id)
                    }),
                    Some(false),
                    "local workspace must enable {key} in command palette"
                );
            }
        }
        // Blank tab disables open-workspace even on a local host.
        send_key(&mut local_rt, Key::Escape, Mods::default());
        local_rt.update(|s, tx| workspace::new_tab(s, tx));
        settle(&mut local_rt);
        assert!(!workspace_open::can_open(&local_rt.state));
    }
}

#[test]
fn palette_and_rename_dismiss_on_project_install_and_auth_renewal() {
    // 1. Project installed in empty tab dismisses an open palette.
    let mut rt = runtime(workspace_state(1));
    rt.update(|s, tx| workspace::new_tab(s, tx));
    settle(&mut rt);
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(command_palette::is_open(&rt.state));
    rt.update(|s, _| {
        let next = Project {
            id: "project-fresh".into(),
            path: "/fresh".into(),
            temporary: false,
        };
        if let Some(l) = s.screen.launcher_mut() {
            l.project = Some(next.clone());
        }
        workspace::opened(s, &next);
    });
    settle(&mut rt);
    assert!(!command_palette::is_open(&rt.state));
    assert!(!is_open(&rt.state));

    // 2. Managed auth renewal dismisses open palette and tab rename modal permanently.
    #[cfg(not(target_arch = "wasm32"))]
    {
        let expired = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let mut s = init();
        let mut l = crate::launcher::Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.set_fixture_host(crate::platform::LocalHost::fixture(|| {
            crate::platform::ManagedRenewal::Denied
        }));
        l.project = Some(Project {
            id: "ws-managed".into(),
            path: "/managed".into(),
            temporary: false,
        });
        s.screen = Screen::Chat { launcher: Some(l) };
        let mut rt = runtime(s);
        send_key(&mut rt, Key::Command('p'), primary_mods(true));
        assert!(command_palette::is_open(&rt.state));
        let before_gen = workspace_open::generation_for_test(&rt.state);
        assert!(settings::authentication_required(&mut rt.state, &expired));
        assert!(!command_palette::is_open(&rt.state));
        assert_ne!(
            workspace_open::generation_for_test(&rt.state),
            before_gen,
            "authentication_required must cancel in-flight workspace_open"
        );
        // Stale errors tagged with the cancelled generation are dropped by poll().
        workspace_open::inject_error_for_test(&rt.state, before_gen, "Old", "stale error");
        assert!(!workspace_open::poll(&mut rt.state));
        // Clearing authentication_required after renewal must not resurface the closed palette.
        rt.update(|s, _| {
            if let Some(l) = s.screen.launcher_mut() {
                l.authentication_required = false;
            }
        });
        settle(&mut rt);
        assert!(!command_palette::is_open(&rt.state));
        assert!(rt.find("command-palette-query").is_none());
    }
}
