use super::*;

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
        open(&mut rt, &http, "main.rs", "YQ0KYg==").await;
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
        assert_eq!(edit.edit().text, "a\r\nadded\r\nb");
        assert!(edit.dirty());
        rt.key(KeyEvent {
            key: Key::Command('s'),
            mods: Mods {
                ctrl: true,
                ..Mods::default()
            },
        });
        rt.frame(0.02);
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "YQ0KYg==", Some("v1"))
            .await;
        settle(&mut rt).await;
        let request = http.request("PUT", "main.rs").await;
        assert_eq!(request.body["contents"], "a\r\nadded\r\nb");
        assert_eq!(request.body["expectedVersion"], "v1");
        request.reply(204, serde_json::Value::Null).await;
        http.quiet().await;
    });
}
