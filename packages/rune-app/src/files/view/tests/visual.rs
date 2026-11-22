use super::*;

#[test]
fn source_reader_can_scroll_with_tab_and_page_down() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-keyboard"));
        open(&mut rt, &http, "main.rs", &"bGV0IHggPSAxOwog".repeat(120)).await;
        let focused = |rt: &Runtime<State>| {
            rt.elements()
                .iter()
                .any(|node| node.key.as_deref() == Some("file-source-scroll") && node.focused)
        };
        for _ in 0..20 {
            if focused(&rt) {
                break;
            }
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods::default(),
            });
            rt.frame(0.02);
        }
        assert!(focused(&rt));
        let y = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some("file-source-text"))
                .unwrap()
                .rect[1]
        };
        let before = y(&rt);
        rt.key(KeyEvent {
            key: Key::PageDown,
            mods: Mods::default(),
        });
        rt.frame(0.02);
        assert!(y(&rt) < before);
        http.quiet().await;
    });
}

#[test]
fn reader_uses_product_palette_and_compact_named_actions() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-visual"));
        open(&mut rt, &http, "main.rs", "Zm4gbWFpbigpIHt9Cg==").await;
        let mut fills = Vec::new();
        for dark in [false, true] {
            rt.set_system_dark(dark);
            for _ in 0..30 {
                rt.frame(0.02);
            }
            let nodes = rt.elements();
            let find = |key| {
                nodes
                    .iter()
                    .find(|node| node.key.as_deref() == Some(key))
                    .unwrap()
            };
            let reader = nodes
                .iter()
                .find(|node| {
                    node.key
                        .as_ref()
                        .is_some_and(|key| key.starts_with("file-reader-"))
                })
                .unwrap();
            fills.push(reader.fill);
            let close = find("file-close");
            let wrap = find("file-wrap");
            assert!(close.rect[0] > wrap.rect[0]);
            assert_eq!(close.label.as_deref(), Some("Back to conversation"));
            assert!(wrap.text.as_ref().is_none_or(String::is_empty));
            let gutter = find("file-line-numbers");
            let source = find("file-source-text");
            assert_eq!(gutter.text.as_deref(), Some("1\n2"));
            assert!(source.rect[0] > gutter.rect[0] && gutter.rect[0] > reader.rect[0]);
            assert!(accessible(&rt.accessibility_json(), "file-line-numbers").is_none());
        }
        assert_ne!(fills[0], fills[1]);
        http.quiet().await;
    });
}

#[test]
fn source_gutter_leaves_continuation_lines_blank_when_wrapped() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-gutter"));
        open(
            &mut rt,
            &http,
            "wide.txt",
            &format!("{}CmI=", "YWFh".repeat(700)),
        )
        .await;
        click(&mut rt, "file-wrap");
        for _ in 0..30 {
            rt.frame(0.02);
        }
        let nodes = rt.elements();
        let gutter = nodes
            .iter()
            .find(|node| node.key.as_deref() == Some("file-line-numbers"))
            .unwrap();
        let text = gutter.text.as_deref().unwrap();
        assert!(text.starts_with("1\n\n") && text.ends_with("\n2"), "{text}");
        http.quiet().await;
    });
}
