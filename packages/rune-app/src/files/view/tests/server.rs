use super::*;
use std::{fs, path::PathBuf, sync::Arc};

#[test]
#[ignore = "requires the private files-fixture --reader or --editor manifest and real Rust server"]
fn real_rust_reader_ui_contract() {
    let manifest = PathBuf::from(std::env::var_os("RUNE_FILES_TEST_MANIFEST").unwrap());
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/rune-files-tests")
        .canonicalize()
        .unwrap();
    let root = manifest.parent().unwrap().canonicalize().unwrap();
    assert!(manifest.is_absolute() && root.starts_with(&base));
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("trial-")
    );
    assert_eq!(manifest.canonicalize().unwrap(), root.join("manifest.json"));
    let data: serde_json::Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
    assert_eq!(data["reader"], true);
    let directory = data["directory"].as_str().unwrap();
    assert_eq!(
        PathBuf::from(directory).canonicalize().unwrap(),
        root.join("project")
    );
    let origin = data["origin"].as_str().unwrap();
    let url = reqwest::Url::parse(origin).unwrap();
    assert_eq!(url.scheme(), "http");
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert!(url.port().is_some() && url.username().is_empty() && url.password().is_none());
    let password = std::env::var("RUNE_FILES_TEST_PASSWORD").unwrap();
    crate::platform::block_on(async {
        let mut backend = crate::backend::Backend::connect(origin, &password)
            .await
            .unwrap();
        backend.workspace = data["workspaceId"].as_str().unwrap().into();
        let mut ui = crate::files::Ui::new(
            backend,
            directory.into(),
            crate::platform::reads::Reads::default(),
            Arc::new(|| {}),
        );
        ui.online(true);
        let mut rt = runtime(ui);
        let (commands, incoming) = codenomad_client::bounded(4);
        rt.update(|state, _| {
            state.draft = rune::TextEdit::new("reader fixture draft");
            state.messages = crate::transport::synthetic();
            state.commands = Some(commands);
            state.revision += 1;
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        rt.wheel(300.0, 300.0, 1200.0);
        for _ in 0..90 {
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        click(&mut rt, "files-toggle");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
            if rt
                .state
                .files
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .any(|row| row.entry.path == "été 日本語.txt")
            {
                break;
            }
            assert!(Instant::now() < deadline, "real tree deadline");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        for _ in 0..30 {
            rt.frame(0.02);
        }
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
        click(&mut rt, "file-eye-été 日本語.txt");
        settle(&mut rt).await;
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "été\n日本語🦀\n"
        );
        assert!(
            rt.elements()
                .iter()
                .any(|node| editable_source(&node.path, &node.role) && node.visible[3] > 0.0)
        );
        rt.set_viewport((589.0, 700.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(accessible(&rt.accessibility_json(), "files-panel").is_none());
        click(&mut rt, "file-refresh");
        settle(&mut rt).await;
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "été\n日本語🦀\n"
        );
        assert!(rt.state.files.as_ref().unwrap().reader.error().is_none());
        if data["editor"] == true {
            let input = rt
                .elements()
                .into_iter()
                .find(|node| editable_source(&node.path, &node.role))
                .unwrap();
            let [x, y, width, height] = input.visible;
            rt.pointer_down(x + width / 2.0, y + height / 2.0);
            rt.pointer_up(x + width / 2.0, y + height / 2.0);
            rt.frame(0.02);
            let ctrl = Mods {
                ctrl: true,
                ..Mods::default()
            };
            for (key, mods) in [
                (Key::End, ctrl),
                (Key::Text("saved".into()), Mods::default()),
                (Key::Command('s'), ctrl),
            ] {
                rt.key(KeyEvent { key, mods });
                rt.frame(0.02);
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
                let document = &rt.state.files.as_ref().unwrap().document;
                assert!(document.error().is_none() && document.confirmation().is_none());
                assert_eq!(document.edit().text, "été\n日本語🦀\nsaved");
                if !document.dirty() && !document.pending() {
                    break;
                }
                assert!(Instant::now() < deadline, "real save deadline");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        rt.set_viewport((1000.0, 700.0), 1.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        click(&mut rt, "file-close");
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert_eq!(anchor(&rt), before);
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        assert_eq!(rt.state.draft.text, "reader fixture draft");
        assert!(incoming.try_recv().is_err());
        println!(
            "{}",
            serde_json::json!({"type":"files-native-proof","result":"ok","reader":true,
            "messages":rt.state.messages.len(),"edited":data["editor"],"anchor":before})
        );
    });
}
