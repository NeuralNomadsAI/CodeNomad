use super::*;

#[test]
fn typing_and_control_save_use_the_versioned_workspace_file() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-editor"));
        open(&mut rt, &http, "main.rs", "YQ==").await;
        let input = rt
            .elements()
            .into_iter()
            .find(|node| node.path.contains("/file-editor/") && node.role == "textbox")
            .expect("the real reader mounts the source input");
        let [x, y, width, height] = input.visible;
        assert!(width > 0.0 && height > 0.0, "{input:?}");
        rt.pointer_down(x + width / 2.0, y + height / 2.0);
        rt.pointer_up(x + width / 2.0, y + height / 2.0);
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
            key: Key::Text("b".into()),
            mods: Mods::default(),
        });
        rt.frame(0.02);
        let edit = &rt.state.files.as_ref().unwrap().document;
        assert_eq!(edit.edit().text, "ab");
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
            .preview("main.rs", "YQ==", Some("v1"))
            .await;
        settle(&mut rt).await;
        let request = http.request("PUT", "main.rs").await;
        assert_eq!(request.body["contents"], "ab");
        assert_eq!(request.body["expectedVersion"], "v1");
        request.reply(204, serde_json::Value::Null).await;
        http.quiet().await;
    });
}
