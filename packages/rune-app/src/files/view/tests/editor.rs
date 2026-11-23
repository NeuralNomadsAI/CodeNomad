use super::*;

#[test]
fn reopening_source_restores_selection_and_both_scroll_axes() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-position"));
        let contents = STANDARD.encode(format!("{}\n", "un mot été 🦀 ".repeat(20)).repeat(80));
        let source_rect = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|node| editable_source(&node.path, &node.role))
                .unwrap()
                .rect
        };
        let selection = |rt: &Runtime<State>| {
            let edit = rt.state.files.as_ref().unwrap().document.edit();
            [edit.anchor, edit.focus]
        };
        open(&mut rt, &http, "main.rs", &contents).await;
        let input = rt
            .elements()
            .into_iter()
            .find(|node| editable_source(&node.path, &node.role))
            .unwrap();
        let [x, y, _, _] = input.visible;
        rt.pointer_down(x + 30.0, y + 10.0);
        rt.pointer_move(x + 105.0, y + 10.0);
        rt.pointer_up(x + 105.0, y + 10.0);
        rt.frame(0.02);
        let selected = selection(&rt);
        assert_ne!(selected[0], selected[1]);
        let initial = source_rect(&rt);
        rt.update(|s, tx| {
            let scope = s.files.as_ref().unwrap().document.scope();
            tx.scroll_to_instant(format!("file-source-scroll-{scope}"), 200.0, 500.0);
        });
        rt.frame(0.02);
        let scrolled = source_rect(&rt);
        assert!(scrolled[0] < initial[0] && scrolled[1] < initial[1]);

        click(&mut rt, "file-close");
        open(&mut rt, &http, "other.rs", &contents).await;
        let other = source_rect(&rt);
        assert_eq!(other[..2], initial[..2]);
        assert_ne!(selection(&rt), selected);
        click(&mut rt, "file-close");
        rt.update(|state, _| state.files.as_mut().unwrap().open("main.rs".into()));
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .reply(500, serde_json::json!({"error":"temporary"}))
            .await;
        settle(&mut rt).await;
        click(&mut rt, "file-close");
        open(&mut rt, &http, "main.rs", &contents).await;
        for _ in 0..10 {
            rt.frame(0.02);
        }
        assert_eq!(selection(&rt), selected);
        let restored = source_rect(&rt);
        assert_eq!(restored[..2], scrolled[..2]);

        click(&mut rt, "file-close");
        open(&mut rt, &http, "main.rs", "YQ==").await;
        assert_eq!(selection(&rt), [1, 1], "shorter source clamps both ends");
        assert_eq!(
            source_rect(&rt)[..2],
            initial[..2],
            "shorter source clamps scroll"
        );
        http.quiet().await;
    });
}

#[test]
fn overwrite_dialog_defaults_to_cancel_and_keeps_the_draft() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-conflict"));
        open(&mut rt, &http, "main.rs", "YQ==").await;
        rt.update(|state, _| {
            let ui = state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            ui.document.input(scope).replace_text("local");
            ui.document.changed(scope);
        });
        rt.frame(0.02);
        click(&mut rt, "file-save");
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "ZXh0ZXJuYWw=", Some("v2"))
            .await;
        settle(&mut rt).await;
        assert!(
            rt.elements()
                .iter()
                .any(|node| node.key.as_deref() == Some("file-decision-cancel") && node.focused)
        );
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        rt.frame(0.02);
        let document = &rt.state.files.as_ref().unwrap().document;
        assert!(document.confirmation().is_none());
        assert_eq!(document.edit().text, "local");
        http.quiet().await;
    });
}

#[test]
fn typing_and_control_save_use_the_versioned_workspace_file() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-editor"));
        open(&mut rt, &http, "main.rs", "77u/YQ0KYg==").await;
        let input = rt
            .elements()
            .into_iter()
            .find(|node| node.path.contains("/file-editor/") && node.role == "textbox")
            .expect("the real reader mounts the source input");
        let [x, y, width, height] = input.visible;
        assert!(width > 0.0 && height > 0.0, "{input:?}");
        rt.pointer_down(x + width / 2.0, y + 2.0);
        rt.pointer_up(x + width / 2.0, y + 2.0);
        rt.frame(0.02);
        assert!(
            rt.elements()
                .iter()
                .any(|node| node.path == input.path && node.focused)
        );
        rt.key(KeyEvent {
            key: Key::End,
            mods: Mods::default(),
        });
        rt.key(KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        });
        rt.key(KeyEvent {
            key: Key::Text("added".into()),
            mods: Mods::default(),
        });
        rt.frame(0.02);
        let edit = &rt.state.files.as_ref().unwrap().document;
        assert_eq!(edit.edit().text, "a\nadded\nb");
        assert!(edit.dirty());
        assert!(rt.elements().iter().any(|node| {
            node.text
                .as_deref()
                .is_some_and(|text| text.contains("Unsaved changes"))
        }));
        rt.key(KeyEvent {
            key: Key::Command('s'),
            mods: Mods {
                cmd: true,
                ctrl: true,
                ..Mods::default()
            },
        });
        rt.frame(0.02);
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "77u/YQ0KYg==", Some("v1"))
            .await;
        settle(&mut rt).await;
        let request = http.request("PUT", "main.rs").await;
        assert_eq!(request.body["contents"], "\u{feff}a\r\nadded\r\nb");
        assert_eq!(request.body["expectedVersion"], "v1");
        request.reply(204, serde_json::Value::Null).await;
        http.quiet().await;
    });
}

#[test]
fn binary_replacement_keeps_the_draft_visible_and_version_refusal_shows_the_reason() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-replaced"));
        open(&mut rt, &http, "main.rs", "YQ==").await;
        rt.update(|state, _| {
            let document = &mut state.files.as_mut().unwrap().document;
            let scope = document.scope();
            document.input(scope).replace_text("my draft");
            document.changed(scope);
        });
        rt.frame(0.02);
        click(&mut rt, "file-save");
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "YQ==", Some("v1"))
            .await;
        settle(&mut rt).await;
        http.request("PUT", "main.rs")
            .await
            .reply(
                409,
                serde_json::json!({"error": "File changed while saving"}),
            )
            .await;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
            if rt.state.files.as_ref().unwrap().document.error().is_some() {
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        rt.frame(0.02);
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("File changed while saving")
        );
        // A disappeared file can fail both the write and the automatic reread.
        http.request("GET", "main.rs")
            .await
            .reply(404, serde_json::json!({"error": "File no longer exists"}))
            .await;
        settle(&mut rt).await;
        assert!(rt.state.files.as_ref().unwrap().reader.error().is_some());
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("File changed while saving")
        );
        rt.update(|state, _| state.files.as_mut().unwrap().reader.refresh());
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "AA==", Some("v2"))
            .await;
        settle(&mut rt).await;
        assert!(
            rt.elements()
                .iter()
                .any(|node| editable_source(&node.path, &node.role)
                    && node.text.as_deref() == Some("my draft"))
        );
        assert!(rt.state.files.as_ref().unwrap().document.dirty());
        http.quiet().await;
    });
}
