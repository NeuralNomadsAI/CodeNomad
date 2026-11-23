use super::*;

#[test]
fn right_panel_exposes_only_the_actions_for_its_host_and_row_kind() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        let project = crate::catalog::Project {
            id: http.backend.workspace.clone(),
            path: "/private".into(),
        };
        state.screen.launcher_mut().unwrap().project = Some(project.clone());
        state.workspace = Some(crate::workspace::Ui::new());
        crate::workspace::opened(&mut state, &project);
        crate::files::bind(&mut state, &http.backend);
        state.git.owner = Some(crate::git::Ui::new(
            http.backend.clone(),
            Some(project.path),
            state.reads.clone(),
            state.wake.clone(),
        ));
        let ui = state.files.as_mut().unwrap();
        ui.online(true);
        let entry = |name: &str, kind| Entry {
            path: name.into(),
            name: name.into(),
            kind,
            absolute_path: None,
            directory_identity: None,
            size: None,
            modified_at: None,
        };
        ui.tree.activate(true);
        let read = ui.tree.take_refresh().pop().unwrap();
        let long_name = format!("{}.txt", "long-name-".repeat(12));
        ui.tree.complete(
            read,
            Ok(vec![
                entry("docs", EntryKind::Directory),
                entry("test.ps1", EntryKind::File),
                entry(&long_name, EntryKind::File),
            ]),
            Ok,
        );
        let mut rt = Runtime::new(state, english, (1400.0, 900.0), Env::new(false, 1.0));
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        let settle_shell = |rt: &mut Runtime<State>| {
            for _ in 0..20 {
                rt.update(|s, tx| {
                    crate::shell::sync(s);
                    crate::files::view::poll_actions(s, tx);
                });
                rt.frame(0.025);
            }
        };
        settle_shell(&mut rt);
        click(&mut rt, "right-panel-tab-1");
        settle_shell(&mut rt);
        assert!(
            rt.elements()
                .iter()
                .any(|node| node.key.as_deref() == Some("files-panel")
                    && node.path.contains("/right-panel/"))
        );
        assert!(rt.find("files-toggle").is_none());
        assert!(rt.find("file-new").is_none());
        let shown =
            |rt: &Runtime<State>, key: &str| accessible(&rt.accessibility_json(), key).is_some();
        assert!(shown(&rt, "workspace-actions:test.ps1:pinned:preview"));
        assert!(shown(&rt, "workspace-actions:docs:inline:copy-path"));
        assert!(!shown(&rt, "workspace-actions:docs:inline:open-folder"));
        assert!(!shown(
            &rt,
            "workspace-actions:test.ps1:inline:show-in-folder"
        ));
        let button = "workspace-actions:test.ps1:inline:copy-path";
        let (x, y) = rt.find(button).unwrap();
        rt.pointer_move(x, y);
        rt.frame(0.02);
        click(&mut rt, button);
        assert_eq!(
            clipboard.text().as_deref().map(String::as_str),
            Some("test.ps1")
        );
        let long = format!("workspace-actions:{long_name}");
        assert!(shown(&rt, &format!("{long}:pinned:preview")));
        assert!(!shown(&rt, &format!("{long}:inline:copy-path")));
        let trigger = format!("{long}:trigger");
        let (x, y) = rt.find(&trigger).unwrap();
        rt.pointer_move(x, y);
        rt.frame(0.02);
        click(&mut rt, &trigger);
        settle_shell(&mut rt);
        click(&mut rt, &format!("{long}:item:copy-path"));
        settle_shell(&mut rt);
        assert_eq!(
            clipboard.text().as_deref().map(String::as_str),
            Some(long_name.as_str())
        );
        #[cfg(windows)]
        {
            rt.update(|s, _| s.files.as_mut().unwrap().local = true);
            settle_shell(&mut rt);
            for key in [
                "docs:inline:open-folder",
                "docs:inline:open-terminal",
                "test.ps1:inline:open-default",
                "test.ps1:inline:show-in-folder",
            ] {
                assert!(shown(&rt, &format!("workspace-actions:{key}")), "{key}");
            }
            assert!(
                rt.accessibility_json()
                    .to_string()
                    .contains("Edit with default application")
            );
            assert!(!shown(&rt, "workspace-actions:docs:inline:show-in-folder"));
            assert!(!shown(
                &rt,
                "workspace-actions:test.ps1:inline:open-terminal"
            ));
            for key in [
                "docs:inline:open-folder",
                "docs:inline:open-terminal",
                "test.ps1:inline:open-default",
                "test.ps1:inline:show-in-folder",
            ] {
                let key = format!("workspace-actions:{key}");
                let (x, y) = rt.find(&key).unwrap();
                rt.pointer_move(x, y);
                rt.frame(0.02);
                click(&mut rt, &key);
                let request = http.accept().await;
                assert!(
                    request
                        .header
                        .starts_with("GET /api/workspaces/owned HTTP/1.1"),
                    "{}",
                    request.header
                );
                // No external application is launched when checkout authority is absent.
                request
                    .reply(
                        404,
                        serde_json::json!({"error":"Fixture checkout unavailable"}),
                    )
                    .await;
            }
        }
        http.quiet().await;
    });
}
