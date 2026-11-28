use super::*;

#[test]
fn source_reader_can_scroll_with_tab_and_page_down() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-keyboard"));
        open(&mut rt, &http, "main.rs", &"bGV0IHggPSAxOwog".repeat(120)).await;
        let focused = |rt: &Runtime<State>| {
            rt.elements().iter().any(|node| {
                node.focused
                    && node
                        .key
                        .as_deref()
                        .is_some_and(|key| key.starts_with("file-source-scroll-"))
            })
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
                .find(|node| editable_source(&node.path, &node.role))
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
            let source = nodes
                .iter()
                .find(|node| editable_source(&node.path, &node.role))
                .unwrap();
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

#[test]
fn shell_workspace_tree_shares_panel_surface_exposes_path_help_and_styles_notes() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut ui = http.ui(Store::default(), "tree-visual-parity");
        let entry = |name: &str, path: &str, kind| Entry {
            name: name.into(),
            path: path.into(),
            kind,
            absolute_path: None,
            directory_identity: None,
            size: None,
            modified_at: None,
        };
        ui.tree.activate(true);
        let root = ui.tree.take_refresh().pop().unwrap();
        ui.tree.complete(
            root,
            Ok(vec![entry("src", "src", EntryKind::Directory)]),
            Ok,
        );
        let sub = ui.tree.toggle("src").pop().unwrap();
        ui.tree.complete(
            sub,
            Ok(vec![entry("lib.rs", "src/lib.rs", EntryKind::File)]),
            Ok,
        );
        let failed = ui.tree.load(".", true).unwrap();
        ui.tree.complete(
            failed,
            Err(codenomad_client::files::FileError::AccessDenied.into()),
            Ok,
        );
        ui.panel = true;
        let mut rt = shell_runtime(ui);
        // Unselect the active session while keeping the Files right-panel tab active.
        rt.update(|s, _| {
            assert!(crate::workspace::unselect_session(s, "session"));
        });
        assert!(!super::actions::has_session(&rt.state));
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let nodes = rt.elements();
        let files_panel = nodes
            .iter()
            .find(|node| node.key.as_deref() == Some("files-panel"))
            .expect("files-panel mounted");
        let git_panel = nodes
            .iter()
            .find(|node| node.key.as_deref() == Some("git-panel"))
            .expect("git-panel mounted");
        assert_eq!(
            files_panel.fill.a, 0.0,
            "shell-managed workspace tree should inherit git-panel secondary surface"
        );
        assert!(git_panel.fill.a > 0.0);

        let nested_row = nodes
            .iter()
            .find(|node| node.key.as_deref() == Some("file-row-src/lib.rs"))
            .expect("nested file row");
        assert_eq!(nested_row.help.as_deref(), Some("src/lib.rs"));

        let no_session_text =
            crate::strings::with_locale("en", || t("instanceShell.gitChanges.noSessionSelected"));
        let no_session = nodes
            .iter()
            .find(|node| node.role == "status" && node.text.as_deref() == Some(no_session_text))
            .expect("no-session status note in Workspace tab");

        let alert_text = crate::strings::with_locale("en", || t("filesPanel.error.accessDenied"));
        let alert = nodes
            .iter()
            .find(|node| node.role == "alert" && node.text.as_deref() == Some(alert_text))
            .expect("listing error alert");
        let retry = nodes
            .iter()
            .find(|node| node.key.as_deref() == Some("file-retry-."))
            .expect("listing retry button");
        assert_ne!(
            alert.text_color, no_session.text_color,
            "error alert and muted status notes must use distinct tones"
        );
        assert!(
            retry.rect[0] > files_panel.rect[0] && alert.rect[0] >= files_panel.rect[0],
            "listing alert and retry button must be inset inside the panel"
        );
        assert!(
            (retry.rect[0] - (files_panel.rect[0] + (alert.rect[0] - files_panel.rect[0]))).abs()
                < 16.0
        );
        http.quiet().await;
    });
}

#[test]
fn reader_error_banner_uses_error_tone_and_inline_refresh_retries() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-error-retry"));
        rt.update(|state, _| state.files.as_mut().unwrap().open("main.rs".into()));
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .reply(500, serde_json::json!({"error": "fixture"}))
            .await;
        settle(&mut rt).await;

        for dark in [false, true] {
            rt.set_system_dark(dark);
            for _ in 0..10 {
                rt.frame(0.02);
            }
            let nodes = rt.elements();
            let title = nodes
                .iter()
                .find(|node| node.text.as_deref() == Some("main.rs"))
                .expect("reader header title");
            let alert = nodes
                .iter()
                .find(|node| node.role == "alert")
                .expect("reader error alert");
            let inline_refresh = nodes
                .iter()
                .find(|node| node.key.as_deref() == Some("file-error-refresh"))
                .expect("inline refresh button in error banner");
            assert_ne!(
                alert.text_color, title.text_color,
                "reader alert must use error ink rather than primary text (dark={dark})"
            );
            assert!(inline_refresh.rect[1] >= alert.rect[1]);
        }

        click(&mut rt, "file-error-refresh");
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "Zm4gbWFpbigpIHt9", Some("v1"))
            .await;
        settle(&mut rt).await;
        assert!(rt.find("file-error-refresh").is_none());
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "fn main() {}"
        );
        http.quiet().await;
    });
}

#[test]
fn reader_binary_tone_dirty_readonly_header_and_markdown_width_match_solid() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-status-parity"));

        // Binary notice uses muted status tone distinct from primary header title ink.
        open(&mut rt, &http, "nul.bin", "AA==").await;
        let nodes = rt.elements();
        let title = nodes
            .iter()
            .find(|node| node.text.as_deref() == Some("nul.bin"))
            .expect("binary title");
        let binary = nodes
            .iter()
            .find(|node| {
                node.role == "status"
                    && node.text.as_deref() == Some("Preview unavailable for this binary file.")
            })
            .expect("binary status note");
        assert_ne!(
            binary.text_color, title.text_color,
            "binary notice must use muted secondary ink"
        );

        // Dirty non-editable document displays both unsaved and read-only states in the header.
        open(&mut rt, &http, "main.rs", "YQ==").await;
        rt.update(|state, _| {
            let ui = state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            ui.document.input(scope).replace_text("edited");
            ui.document.changed(scope);
            ui.document.activate(false);
        });
        rt.frame(0.02);
        let subtitle = rt.elements().into_iter().find(|node| {
            node.text
                .as_deref()
                .is_some_and(|text| text.contains("Unsaved changes") && text.contains("Read-only"))
        });
        assert!(
            subtitle.is_some(),
            "dirty non-editable header must show both Unsaved changes and Read-only"
        );

        // Rendered markdown stretches across the reader viewport width.
        open(&mut rt, &http, "readme.md", "IyBUaXRsZQo=").await;
        let nodes = rt.elements();
        let scroll = nodes
            .iter()
            .find(|node| node.key.as_deref() == Some("file-rendered-scroll"))
            .expect("markdown scroll viewport");
        let wrapper = nodes.iter().find(|node| {
            node.path.starts_with(&scroll.path)
                && node.path != scroll.path
                && (node.rect[2] - scroll.rect[2]).abs() < 2.0
        });
        assert!(
            wrapper.is_some(),
            "rendered markdown container must fill the reader viewport width"
        );
        http.quiet().await;
    });
}
