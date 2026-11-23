use super::*;

#[test]
fn hidden_drawer_returns_focused_listing_retry_to_its_toggle() {
    crate::platform::block_on(async {
        for path in [".", "nested"] {
            let http = http::Http::new().await;
            let mut ui = http.ui(Store::default(), "retry-resize");
            ui.online(false);
            ui.tree.activate(true);
            let mut read = ui.tree.take_refresh().pop().unwrap();
            if path != "." {
                ui.tree.complete(
                    read,
                    Ok(vec![Entry {
                        name: path.into(),
                        path: path.into(),
                        kind: EntryKind::Directory,
                        absolute_path: None,
                        directory_identity: None,
                        size: None,
                        modified_at: None,
                    }]),
                    Ok,
                );
                read = ui.tree.toggle(path).pop().unwrap();
            }
            ui.tree.complete(
                read,
                Err(std::io::Error::other("synthetic listing failure").into()),
                Ok,
            );
            ui.panel = true;
            let mut rt = shell_runtime(ui);
            let retry = format!("file-retry-{path}");
            rt.update(|_, tx| tx.focus(&retry, true));
            rt.frame(0.02);
            let focused = |rt: &Runtime<State>| {
                rt.elements()
                    .into_iter()
                    .find(|node| node.focused)
                    .and_then(|node| node.key)
            };
            assert_eq!(focused(&rt).as_deref(), Some(retry.as_str()));
            rt.set_viewport((589.0, 700.0), 1.0);
            for _ in 0..90 {
                rt.frame(1.0 / 60.0);
            }
            assert!(accessible(&rt.accessibility_json(), "files-panel").is_none());
            assert_eq!(focused(&rt).as_deref(), Some("right-panel-toggle"));
            http.quiet().await;
        }
    });
}

#[test]
fn drawer_compresses_redocks_and_keeps_hidden_intent_cancellable() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut ui = http.ui(Store::default(), "resize");
        ui.online(false);
        ui.tree.activate(true);
        let read = ui.tree.take_refresh().pop().unwrap();
        ui.tree.complete(
            read,
            Ok(vec![Entry {
                name: "main.rs".into(),
                path: "main.rs".into(),
                kind: EntryKind::File,
                absolute_path: None,
                directory_identity: None,
                size: None,
                modified_at: None,
            }]),
            Ok,
        );
        ui.panel = true;
        let mut rt = shell_runtime(ui);
        rt.update(|state, _| {
            state.messages = crate::transport::synthetic();
            state.revision += 1;
        });
        let frame = |rt: &mut Runtime<State>| {
            for _ in 0..90 {
                rt.update(|s, _| crate::shell::sync(s));
                rt.frame(1.0 / 60.0);
            }
        };
        frame(&mut rt);
        rt.wheel(200.0, 250.0, 1200.0);
        frame(&mut rt);
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        let anchor = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|node| {
                    node.key
                        .as_deref()
                        .is_some_and(|key| key.starts_with("body-"))
                        && node.visible[3] > 0.0
                })
                .map(|node| (node.key.unwrap(), node.rect[1]))
                .unwrap()
        };
        let before = anchor(&rt);
        for (width, expected) in [(650.0, 260.0), (620.0, 230.0), (590.0, 200.0)] {
            rt.set_viewport((width, 700.0), 1.0);
            frame(&mut rt);
            let panel = rt
                .elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some("right-panel"))
                .unwrap();
            assert_eq!(panel.rect[2], expected);
            assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        }
        rt.update(|_, tx| tx.focus("file-row-main.rs", true));
        frame(&mut rt);
        rt.set_viewport((589.0, 700.0), 1.0);
        frame(&mut rt);
        assert!(accessible(&rt.accessibility_json(), "files-panel").is_none());
        assert_eq!(
            rt.elements()
                .into_iter()
                .find(|node| node.focused)
                .and_then(|node| node.key)
                .as_deref(),
            Some("right-panel-toggle")
        );
        assert!(!rt.state.files.as_mut().unwrap().tree.busy("."));
        rt.set_viewport((1000.0, 700.0), 1.0);
        frame(&mut rt);
        assert!(rt.state.shell.visible(1));
        assert_eq!(anchor(&rt), before);
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        rt.update(|_, tx| tx.focus("composer", true));
        frame(&mut rt);
        rt.set_viewport((589.0, 700.0), 1.0);
        frame(&mut rt);
        assert_eq!(
            rt.elements()
                .into_iter()
                .find(|node| node.focused)
                .and_then(|node| node.key)
                .as_deref(),
            Some("composer")
        );
        click(&mut rt, "right-panel-toggle");
        assert!(rt.state.shell.has_floating() && rt.state.shell.visible(1));
        click(&mut rt, "right-panel-toggle");
        assert!(!rt.state.shell.visible(1));
        rt.set_viewport((1000.0, 700.0), 1.0);
        frame(&mut rt);
        assert!(rt.state.shell.visible(1));
        let (x, y) = rt.find("right-panel-toggle").unwrap();
        rt.pointer_down(x, y);
        rt.set_viewport((589.0, 700.0), 1.0);
        frame(&mut rt);
        rt.pointer_up(x, y);
        frame(&mut rt);
        assert!(rt.state.shell.has_floating() && rt.state.shell.visible(1));
        click(&mut rt, "right-panel-toggle");
        assert!(!rt.state.shell.visible(1));
        http.quiet().await;
    });
}
