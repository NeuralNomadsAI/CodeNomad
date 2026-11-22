use super::*;

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
