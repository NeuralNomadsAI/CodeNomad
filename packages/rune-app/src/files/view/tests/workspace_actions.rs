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
            temporary: false,
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
        let mut rows = vec![
            entry("docs", EntryKind::Directory),
            entry("manual.txt", EntryKind::File),
            entry("test.ps1", EntryKind::File),
            entry("unknown.fixture", EntryKind::File),
        ];
        rows.extend((0..32).map(|i| entry(&format!("before{i:02}.txt"), EntryKind::File)));
        rows.push(entry(&long_name, EntryKind::File));
        rows.extend((0..24).map(|i| entry(&format!("after{i:02}.txt"), EntryKind::File)));
        ui.tree.complete(read, Ok(rows), Ok);
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
        let eye = "workspace-actions:test.ps1:pinned:preview";
        let disabled = |rt: &Runtime<State>| {
            rt.accessibility_tree()
                .nodes
                .into_iter()
                .find(|(_, node)| node.author_id() == Some(eye))
                .expect("preview eye")
                .1
                .is_disabled()
        };
        assert!(disabled(&rt), "no active conversation");
        click(&mut rt, eye);
        assert!(!crate::files::has_preview(&rt.state));
        rt.update(|s, _| {
            crate::workspace::bound(s, &http.backend);
        });
        settle_shell(&mut rt);
        assert!(!disabled(&rt), "an active conversation enables the eye");
        rt.update(|s, _| s.files.as_mut().unwrap().online(false));
        settle_shell(&mut rt);
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
        http.quiet().await;
        let long = format!("workspace-actions:{long_name}");
        let long_row = format!("file-row-{long_name}");
        let before_scroll = rt.find(&long_row).unwrap().1;
        rt.update(|_, tx| tx.scroll_to_instant("workspace-tree-scroll", 0.0, 680.0));
        settle_shell(&mut rt);
        let scrolled = rt.find(&long_row).unwrap().1;
        assert!(before_scroll - scrolled > 500.0);
        let viewport = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some("workspace-tree-scroll"))
                .unwrap()
                .path
        };
        let viewport_path = viewport(&rt);
        assert!(shown(&rt, &format!("{long}:pinned:preview")));
        assert!(!shown(&rt, &format!("{long}:inline:copy-path")));
        let trigger = format!("{long}:trigger");
        let (x, y) = rt.find(&trigger).unwrap();
        rt.pointer_move(x, y);
        rt.frame(0.02);
        click(&mut rt, &trigger);
        settle_shell(&mut rt);
        assert_eq!(viewport(&rt), viewport_path);
        assert!((rt.find(&long_row).unwrap().1 - scrolled).abs() < 1.0);
        click(&mut rt, &format!("{long}:item:copy-path"));
        settle_shell(&mut rt);
        assert_eq!(viewport(&rt), viewport_path);
        assert!((rt.find(&long_row).unwrap().1 - scrolled).abs() < 1.0);
        assert_eq!(
            clipboard.text().as_deref().map(String::as_str),
            Some(long_name.as_str())
        );
        click(&mut rt, "git-mode/segment1");
        settle_shell(&mut rt);
        assert!(rt.find("workspace-tree-scroll").is_none());
        click(&mut rt, "git-mode/segment0");
        settle_shell(&mut rt);
        assert!(
            (rt.find(&long_row).unwrap().1 - scrolled).abs() < 1.0,
            "returning to Workspace restores the scroll offset"
        );
        #[cfg(windows)]
        {
            rt.update(|s, tx| {
                let ui = s.files.as_mut().unwrap();
                ui.local = true;
                ui.online(true);
                tx.scroll_to_instant("workspace-tree-scroll", 0.0, 0.0);
            });
            settle_shell(&mut rt);
            let native_actions = [
                "docs:inline:open-folder",
                "docs:inline:open-terminal",
                "manual.txt:inline:open-default",
                "test.ps1:inline:open-default",
                "unknown.fixture:inline:open-default",
                "test.ps1:inline:show-in-folder",
            ];
            for key in native_actions {
                assert!(shown(&rt, &format!("workspace-actions:{key}")), "{key}");
            }
            let tree = rt.accessibility_json();
            for (name, label) in [
                ("manual.txt", "openDefault"),
                ("test.ps1", "editDefault"),
                ("unknown.fixture", "chooseApplication"),
            ] {
                let node = accessible(
                    &tree,
                    &format!("workspace-actions:{name}:inline:open-default"),
                )
                .unwrap();
                let label = crate::strings::with_locale("en", || {
                    crate::strings::t(&format!("instanceShell.filesShell.actions.{label}"))
                });
                assert!(node.to_string().contains(label), "{node}");
            }
            assert!(!shown(&rt, "workspace-actions:docs:inline:show-in-folder"));
            assert!(!shown(
                &rt,
                "workspace-actions:test.ps1:inline:open-terminal"
            ));
            for key in native_actions {
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
