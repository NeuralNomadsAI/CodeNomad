use super::*;

const REMOTE: &str = "https://example.invalid/never";

async fn markup(rt: &mut Runtime<State>, http: &http::Http) {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/reader-content.json"
    ))
    .unwrap();
    let case = cases["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "markup.md")
        .unwrap();
    open(rt, http, "markup.md", case["base64"].as_str().unwrap()).await;
}

#[test]
fn rendered_document_without_links_has_a_keyboard_scroll_stop() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "markdown-scroll"));
        markup(&mut rt, &http).await;
        rt.update(|state, _| {
            let ui = state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            ui.document.input(scope).text = format!(
                "# Read me\n\n{}",
                "More text in the document.\n\n".repeat(120)
            );
            ui.document.changed(scope);
        });
        rt.frame(0.02);
        let focused = |rt: &Runtime<State>| {
            rt.elements()
                .iter()
                .any(|node| node.key.as_deref() == Some("file-rendered-scroll") && node.focused)
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
                .find(|node| node.text.as_deref() == Some("Read me"))
                .unwrap()
                .rect[1]
        };
        let before = y(&rt);
        rt.key(KeyEvent {
            key: Key::Text(" ".into()),
            mods: Mods::default(),
        });
        rt.frame(0.02);
        assert!(y(&rt) < before);
        rt.key(KeyEvent {
            key: Key::Text(" ".into()),
            mods: Mods {
                shift: true,
                ..Mods::default()
            },
        });
        rt.frame(0.02);
        assert_eq!(y(&rt), before);
        http.quiet().await;
    });
}

#[test]
fn space_follows_the_reader_scroll_instead_of_activating_a_focused_link() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "markdown-space"));
        markup(&mut rt, &http).await;
        rt.update(|state, _| {
            let ui = state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            ui.document
                .input(scope)
                .text
                .push_str(&"\n\nMore text in the document.".repeat(120));
            ui.document.changed(scope);
        });
        rt.frame(0.02);
        for _ in 0..20 {
            if rt
                .elements()
                .iter()
                .any(|node| node.key.as_deref() == Some(REMOTE) && node.focused)
            {
                break;
            }
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods::default(),
            });
            rt.frame(0.02);
        }
        assert!(
            rt.elements()
                .iter()
                .any(|node| node.key.as_deref() == Some(REMOTE) && node.focused)
        );
        let paragraph_y = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|node| node.text.as_deref() == Some("safe remote"))
                .unwrap()
                .rect[1]
        };
        let before = paragraph_y(&rt);
        rt.key(KeyEvent {
            key: Key::Text(" ".into()),
            mods: Mods::default(),
        });
        rt.frame(0.02);
        assert!(paragraph_y(&rt) < before);
        assert!(rt.take_url_requests().is_empty());
        http.quiet().await;
    });
}

fn roles(node: &serde_json::Value, role: &str, name: &str) -> bool {
    (node["role"] == role && node["name"] == name)
        || node["children"]
            .as_array()
            .is_some_and(|children| children.iter().any(|child| roles(child, role, name)))
}

#[test]
fn links_expose_semantics_and_open_by_pointer_and_keyboard_while_text_stays_copyable() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "markdown-gestures"));
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        markup(&mut rt, &http).await;
        let tree = rt.accessibility_json();
        assert!(roles(&tree, "link", "remote"), "{tree:#}");
        assert!(roles(&tree, "image", "blocked"), "{tree:#}");
        assert!(rt.take_url_requests().is_empty());

        click(&mut rt, REMOTE);
        assert_eq!(rt.take_url_requests(), [REMOTE]);
        for _ in 0..20 {
            if rt
                .elements()
                .iter()
                .any(|node| node.key.as_deref() == Some(REMOTE) && node.focused)
            {
                break;
            }
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods::default(),
            });
            rt.frame(0.02);
        }
        assert!(
            rt.elements()
                .iter()
                .any(|node| { node.key.as_deref() == Some(REMOTE) && node.focused })
        );
        for (key, opened) in [(Key::Enter, true), (Key::Text(" ".into()), false)] {
            rt.key(KeyEvent {
                key,
                mods: Mods::default(),
            });
            rt.frame(0.02);
            assert_eq!(
                rt.take_url_requests(),
                if opened { vec![REMOTE] } else { vec![] }
            );
        }

        let paragraph = rt
            .elements()
            .into_iter()
            .find(|node| node.text.as_deref() == Some("safe remote"))
            .unwrap();
        let [x, y, w, h] = paragraph.rect;
        rt.pointer_down(x + 1.0, y + h / 2.0);
        rt.pointer_move(x + w - 1.0, y + h / 2.0);
        rt.pointer_up(x + w - 1.0, y + h / 2.0);
        rt.frame(0.02);
        assert_eq!(rt.selected_text().as_deref(), Some("safe remote"));
        rt.key(KeyEvent {
            key: Key::Command('c'),
            mods: Mods {
                cmd: true,
                ..Mods::default()
            },
        });
        rt.frame(0.02);
        assert_eq!(
            clipboard.text().map(|text| text.to_string()).as_deref(),
            Some("safe remote")
        );
        assert!(
            rt.take_url_requests().is_empty(),
            "selection must not activate a link"
        );
        http.quiet().await;
    });
}

#[test]
fn markdown_url_gestures_keep_the_platform_scheme_gate() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "markdown-schemes"));
        markup(&mut rt, &http).await;
        let urls = [
            ("https://example.invalid/one", true),
            ("mailto:test@example.invalid", true),
            ("javascript:alert%281%29", false),
            ("file:///C:/private.txt", false),
            ("myapp://exec", false),
            ("data:text/html,payload", false),
            ("./notes.md", true),
            ("#reader", true),
        ];
        let markdown = urls
            .iter()
            .enumerate()
            .map(|(i, (url, _))| format!("[destination{i}]({url})"))
            .collect::<Vec<_>>()
            .join("\n\n");
        rt.update(|state, _| {
            let ui = state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            ui.document.input(scope).text = markdown;
            ui.document.changed(scope);
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        for (url, allowed) in urls {
            click(&mut rt, url);
            let requests = rt.take_url_requests();
            let expected = if url.starts_with("./") || url.starts_with('#') {
                format!("{}{}", http.backend.base, url.trim_start_matches("./"))
            } else {
                url.into()
            };
            assert_eq!(
                requests,
                if allowed { vec![expected] } else { vec![] },
                "{url}"
            );
        }
        assert_eq!(
            rt.state
                .files
                .as_ref()
                .unwrap()
                .reader
                .target()
                .unwrap()
                .path,
            "markup.md"
        );
        http.quiet().await;
    });
}

#[test]
fn departed_markdown_callbacks_cannot_open_urls_for_a_new_document_or_screen() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "markdown-ownership"));
        markup(&mut rt, &http).await;
        let departed = document_link(&rt.state);
        rt.update(|state, _| state.files.as_mut().unwrap().open("second.md".into()));
        rt.update(|state, tx| departed(state, REMOTE, tx));
        assert!(rt.take_url_requests().is_empty());
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "second.md")
            .await
            .preview("second.md", "c2Vjb25k", Some("v1"))
            .await;
        settle(&mut rt).await;
        let departed = document_link(&rt.state);
        rt.update(|state, _| state.renew_scope());
        rt.update(|state, tx| departed(state, REMOTE, tx));
        assert!(rt.take_url_requests().is_empty());
        let hidden = document_link(&rt.state);
        rt.update(|state, _| state.files.as_mut().unwrap().presentation.source = true);
        rt.update(|state, tx| hidden(state, REMOTE, tx));
        assert!(rt.take_url_requests().is_empty());
        rt.update(|state, _| state.files.as_mut().unwrap().presentation.source = false);
        let departed = document_link(&rt.state);
        rt.update(|state, _| state.files.as_mut().unwrap().close_reader());
        rt.update(|state, tx| departed(state, REMOTE, tx));
        assert!(rt.take_url_requests().is_empty());
        http.quiet().await;
    });
}

#[test]
fn refresh_keeps_shown_links_until_different_text_is_published() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "markdown-refresh"));
        markup(&mut rt, &http).await;
        let shown = document_link(&rt.state);
        for changed in [false, true] {
            rt.update(|state, _| state.files.as_mut().unwrap().reader.refresh());
            rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
            let request = http.request("GET", "markup.md").await;
            rt.update(|state, tx| shown(state, REMOTE, tx));
            assert_eq!(
                rt.take_url_requests(),
                [REMOTE],
                "retained display during read"
            );
            if changed {
                // [later](https://example.invalid/later)
                request
                    .preview(
                        "markup.md",
                        "W2xhdGVyXShodHRwczovL2V4YW1wbGUuaW52YWxpZC9sYXRlcik=",
                        Some("v2"),
                    )
                    .await;
            } else {
                request
                    .reply(500, serde_json::json!({"error":"fixture"}))
                    .await;
            }
            settle(&mut rt).await;
            rt.update(|state, tx| shown(state, REMOTE, tx));
            assert_eq!(
                rt.take_url_requests(),
                if changed { vec![] } else { vec![REMOTE] }
            );
        }
        click(&mut rt, "https://example.invalid/later");
        assert_eq!(rt.take_url_requests(), ["https://example.invalid/later"]);
        http.quiet().await;
    });
}
