use super::*;

#[test]
fn tab_selects_the_row_and_reaches_refresh_after_a_failed_listing() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut ui = http.ui(Store::default(), "files-tab");
        seed(&mut ui, 2);
        let failed = ui.tree.load(".", true).unwrap();
        ui.tree.complete(
            failed,
            Err(codenomad_client::files::ListingTooLarge.into()),
            Ok,
        );
        ui.panel = true;
        let mut rt = runtime(ui);
        rt.poll = Some(crate::files::poll);
        let focused = |rt: &Runtime<State>, key: &str| {
            rt.elements()
                .iter()
                .any(|node| node.key.as_deref() == Some(key) && node.focused)
        };
        let tab = |rt: &mut Runtime<State>, shift| {
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods {
                    shift,
                    ..Mods::default()
                },
            });
            rt.frame(0.02);
            rt.frame(0.02);
        };
        rt.update(|_, tx| tx.focus("files-toggle", true));
        rt.frame(0.02);
        assert!(rt.state.files.as_ref().unwrap().tree.selected().is_none());
        for _ in 0..16 {
            tab(&mut rt, false);
            if focused(&rt, "file-row-file00.txt") {
                break;
            }
        }
        assert!(focused(&rt, "file-row-file00.txt"));
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("file00.txt")
        );
        for next in ["file-eye-file00.txt", "file-eye-file01.txt", "file-retry-."] {
            tab(&mut rt, false);
            assert!(focused(&rt, next), "Tab should reach {next}");
        }
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("file00.txt")
        );
        tab(&mut rt, true);
        assert!(focused(&rt, "file-eye-file01.txt"));

        let a11y = rt.accessibility_json();
        assert!(
            a11y.to_string()
                .contains("private: more than 4,096 entries.")
        );
        let tree = accessible(&a11y, "workspace-tree").unwrap();
        assert_eq!(tree["role"], "tree");
        let row = accessible(tree, "file-row-file00.txt").unwrap();
        assert_eq!(row["role"], "tree-item");
        assert!(accessible(row, "file-eye-file00.txt").is_some());
        assert!(accessible(tree, "file-retry-.").is_none());

        tab(&mut rt, false);
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        rt.frame(0.02);
        assert!(rt.state.files.as_ref().unwrap().tree.busy("."));
        http.request("GET", ".")
            .await
            .reply(503, serde_json::json!({"error": "still unavailable"}))
            .await;
    });
}

#[test]
fn enter_toggles_the_files_panel_and_the_preview_eye() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut ui = http.ui(Store::default(), "files-enter");
        seed(&mut ui, 2);
        let mut rt = runtime(ui);
        let enter = |rt: &mut Runtime<State>, target: &str| {
            rt.update(|_, tx| tx.focus(target, true));
            rt.frame(0.02);
            rt.key(KeyEvent {
                key: Key::Enter,
                mods: Mods::default(),
            });
            rt.frame(0.02);
        };
        assert!(rt.find("files-panel").is_none());
        enter(&mut rt, "files-toggle");
        assert!(rt.find("files-panel").is_some());
        let pressed = |rt: &Runtime<State>| {
            rt.accessibility_tree()
                .nodes
                .into_iter()
                .find(|(_, node)| node.author_id() == Some("file-eye-file00.txt"))
                .and_then(|(_, node)| node.toggled())
        };
        let off = pressed(&rt).expect("eye exposes its toggle state");
        enter(&mut rt, "file-eye-file00.txt");
        assert_eq!(
            rt.state
                .files
                .as_ref()
                .unwrap()
                .reader
                .target()
                .unwrap()
                .path,
            "file00.txt"
        );
        assert_ne!(pressed(&rt), Some(off));
        enter(&mut rt, "file-eye-file00.txt");
        assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
        assert_eq!(pressed(&rt), Some(off));
        http.quiet().await;
    });
}

#[test]
fn end_reveals_the_selected_row_and_exposes_every_row_selection_state() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut ui = http.ui(Store::default(), "files-reveal");
        seed(&mut ui, 40);
        ui.panel = true;
        let mut rt = runtime(ui);
        rt.set_viewport((1000.0, 320.0), 1.0);
        rt.update(|_, tx| tx.focus("file-row-file00.txt", true));
        rt.frame(0.02);
        rt.key(KeyEvent {
            key: Key::End,
            mods: Mods::default(),
        });
        for _ in 0..45 {
            rt.frame(0.02);
        }
        assert!(
            rt.elements()
                .iter()
                .any(|node| node.key.as_deref() == Some("file-row-file39.txt")
                    && node.focused
                    && node.visible[3] > 0.0)
        );
        let selected = |target: &str| {
            rt.accessibility_tree()
                .nodes
                .into_iter()
                .find(|(_, node)| node.author_id() == Some(target))
                .and_then(|(_, node)| node.is_selected())
        };
        assert_eq!(selected("file-row-file39.txt"), Some(true));
        assert_eq!(selected("file-row-file00.txt"), Some(false));
        assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
        http.quiet().await;
    });
}

fn seed(ui: &mut crate::files::Ui, count: usize) {
    ui.tree.activate(true);
    let read = ui.tree.take_refresh().pop().unwrap();
    let rows = (0..count)
        .map(|i| {
            let name = format!("file{i:02}.txt");
            Entry {
                path: name.clone(),
                name,
                kind: EntryKind::File,
                absolute_path: None,
                directory_identity: None,
                size: None,
                modified_at: None,
            }
        })
        .collect();
    assert!(ui.tree.complete(read, Ok(rows), Ok));
}

#[test]
fn arrows_select_rows_and_space_on_the_separate_eye_opens_the_file() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut ui = http.ui(Store::default(), "tree-navigation");
        ui.panel = true;
        ui.tree.activate(true);
        let entries = ["notes.md", "image.png"].map(|name| Entry {
            name: name.into(),
            path: name.into(),
            kind: EntryKind::File,
            absolute_path: None,
            directory_identity: None,
            size: None,
            modified_at: None,
        });
        let read = ui.tree.take_refresh().pop().unwrap();
        assert!(ui.tree.complete(read, Ok(entries.to_vec()), Ok));
        let mut rt = runtime(ui);
        let key = |rt: &mut Runtime<State>, key| {
            rt.key(KeyEvent {
                key,
                mods: Mods::default(),
            });
            rt.frame(0.02);
        };
        rt.update(|_, tx| tx.focus("file-row-notes.md", true));
        rt.frame(0.02);
        key(&mut rt, Key::Down);
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("image.png")
        );
        key(&mut rt, Key::Enter);
        assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
        rt.update(|_, tx| tx.focus("file-eye-notes.md", true));
        rt.frame(0.02);
        key(&mut rt, Key::Text(" ".into()));
        assert_eq!(
            rt.state
                .files
                .as_ref()
                .unwrap()
                .reader
                .target()
                .unwrap()
                .path,
            "notes.md"
        );
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("image.png")
        );
        http.quiet().await;
    });
}
