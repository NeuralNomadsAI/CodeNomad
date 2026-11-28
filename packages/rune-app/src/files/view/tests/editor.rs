use super::*;

#[test]
fn wrapped_reader_keeps_its_logical_top_line_across_resize_and_reopen() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-reflow"));
        let text = format!(
            "{}short target\n{}",
            "long prefix ".repeat(30) + "\n",
            "after\n".repeat(120)
        );
        let contents = STANDARD.encode(text);
        open(&mut rt, &http, "wrapped.txt", &contents).await;
        click(&mut rt, "file-wrap");
        let top_line = |rt: &Runtime<State>| {
            let nodes = rt.elements();
            let gutter = nodes
                .iter()
                .find(|node| node.key.as_deref() == Some("file-line-numbers"))
                .unwrap();
            let viewport = nodes
                .iter()
                .find(|node| {
                    node.key.as_deref().is_some_and(|key| {
                        key.starts_with("file-source-scroll-") && !key.contains("-anchor-")
                    })
                })
                .unwrap();
            let row = gutter
                .text
                .as_deref()
                .unwrap()
                .split('\n')
                .position(|line| line == "2")
                .unwrap();
            let metrics = rune_theme_codenomad::document_reader::editor::metrics(false);
            (
                row,
                gutter.rect[1] + metrics.style.line_px() * row as f32 - viewport.rect[1],
            )
        };
        let metrics = rune_theme_codenomad::document_reader::editor::metrics(false);
        let (wide, _) = top_line(&rt);
        assert!(wide > 1);
        rt.update(|s, tx| {
            let scope = s.files.as_ref().unwrap().document.scope();
            tx.scroll_to_instant(
                format!("file-source-scroll-{scope}"),
                0.0,
                metrics.padding + 2.0 + metrics.style.line_px() * wide as f32,
            );
        });
        rt.frame(0.02);
        let (_, y) = top_line(&rt);
        rt.set_viewport((550.0, 700.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let (narrow, new_y) = top_line(&rt);
        assert!(narrow > wide);
        assert!((new_y - y).abs() < 1.0, "{y} → {new_y} on resize");
        click(&mut rt, "file-close");
        rt.set_viewport((1000.0, 700.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        open(&mut rt, &http, "wrapped.txt", &contents).await;
        let (row, new_y) = top_line(&rt);
        assert_eq!(row, wide);
        assert!((new_y - y).abs() < 1.0, "{y} → {new_y} after reopening");

        let shortened = STANDARD.encode(format!("prefix\nshort target\n{}", "after\n".repeat(120)));
        click(&mut rt, "file-refresh");
        rt.update_if(|s, _| s.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "wrapped.txt")
            .await
            .preview("wrapped.txt", &shortened, Some("v2"))
            .await;
        settle(&mut rt).await;
        let (row, new_y) = top_line(&rt);
        assert_eq!(row, 1);
        assert!((new_y - y).abs() < 1.0, "{y} → {new_y} after refresh");

        click(&mut rt, "file-close");
        open(&mut rt, &http, "wrapped.txt", &contents).await;
        let (row, new_y) = top_line(&rt);
        assert_eq!(row, wide);
        assert!(
            (new_y - y).abs() < 1.0,
            "{y} → {new_y} with the same width but different wrapping"
        );
        http.quiet().await;
    });
}

#[test]
fn wrapped_reader_keeps_exact_segment_inside_long_line_across_resize_reopen_and_refresh() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-long-segment"));
        let long_line: String = (0..120).map(|i| format!("seg{i:03} ")).collect();
        let make = |prefix: &str| {
            STANDARD.encode(format!("{prefix}\n{long_line}\n{}", "after\n".repeat(120)))
        };
        let contents = make("header");
        open(&mut rt, &http, "long.txt", &contents).await;
        click(&mut rt, "file-wrap");
        let top_row_span = |rt: &mut Runtime<State>| {
            let viewport = rt
                .elements()
                .into_iter()
                .find(|node| {
                    node.key.as_deref().is_some_and(|key| {
                        key.starts_with("file-source-scroll-") && !key.contains("-anchor-")
                    })
                })
                .unwrap();
            let input = rt
                .elements()
                .into_iter()
                .find(|node| editable_source(&node.path, &node.role))
                .unwrap();
            let y = viewport.rect[1] + 4.0;
            let click_col = |rt: &mut Runtime<State>, x: f32| {
                rt.pointer_down(x, y);
                rt.pointer_up(x, y);
                rt.frame(0.02);
                let edit = rt.state.files.as_ref().unwrap().document.edit();
                let line2_start = edit.text.find('\n').unwrap() + 1;
                let line2_end = edit.text[line2_start..]
                    .find('\n')
                    .map(|rel| line2_start + rel)
                    .unwrap_or(edit.text.len());
                assert!(
                    edit.focus >= line2_start && edit.focus <= line2_end,
                    "focus {} outside line 2 ({line2_start}..{line2_end})",
                    edit.focus
                );
                edit.focus - line2_start
            };
            let left = click_col(rt, input.visible[0] + 10.0);
            let right = click_col(rt, input.visible[0] + input.visible[2] - 10.0);
            assert!(left < right, "top row span empty: {left}..{right}");
            (left, right)
        };
        // Scroll well inside the wrapped second line (row 5 inside line 2, plus 1 row for "header").
        let editor_metrics = rune_theme_codenomad::document_reader::editor::metrics(false);
        let line_height = editor_metrics.style.line_px();
        let inset = editor_metrics.padding;
        rt.update(|s, tx| {
            let scope = s.files.as_ref().unwrap().document.scope();
            tx.scroll_to_instant(
                format!("file-source-scroll-{scope}"),
                0.0,
                inset + line_height * 6.0 + 2.0,
            );
        });
        rt.frame(0.02);
        let (before_left, before_right) = top_row_span(&mut rt);
        assert!(
            before_left > 450,
            "expected deep inside long line, got {before_left}..{before_right}"
        );

        // Preserve a pre-existing selection across resize and wrap round-trip.
        let preserved = {
            let line2_start = rt
                .state
                .files
                .as_ref()
                .unwrap()
                .document
                .edit()
                .text
                .find('\n')
                .unwrap()
                + 1;
            let sel = [line2_start + 12, line2_start + 30];
            rt.update(|s, _| {
                let ui = s.files.as_mut().unwrap();
                let scope = ui.document.scope();
                let edit = ui.document.input(scope);
                edit.anchor = sel[0];
                edit.focus = sel[1];
            });
            rt.frame(0.02);
            sel
        };

        // Resize narrower: the anchored text segment stays on the top visible wrapped row,
        // and the pre-existing selection is untouched.
        rt.set_viewport((550.0, 700.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        let edit_sel = {
            let edit = rt.state.files.as_ref().unwrap().document.edit();
            [edit.anchor, edit.focus]
        };
        assert_eq!(edit_sel, preserved);
        let narrow_scroll = rt
            .state
            .files
            .as_ref()
            .unwrap()
            .document
            .source_viewport()
            .captured_scroll()[1];
        assert!(
            ((narrow_scroll - inset) % line_height - 2.0).abs() <= 0.6,
            "sub-line offset lost on resize: {narrow_scroll}"
        );
        let (narrow_left, narrow_right) = top_row_span(&mut rt);
        assert!(
            narrow_left <= before_left && before_left <= narrow_right,
            "narrow resize missed segment {before_left}: visible {narrow_left}..{narrow_right}"
        );

        // Close, resize to a wider viewport, reopen: the saved segment stays on the top row.
        click(&mut rt, "file-close");
        rt.set_viewport((760.0, 700.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.02);
        }
        open(&mut rt, &http, "long.txt", &contents).await;
        let (reopen_left, reopen_right) = top_row_span(&mut rt);
        assert!(
            reopen_left <= narrow_left && narrow_left <= reopen_right,
            "reopen at 760px missed segment {narrow_left}: visible {reopen_left}..{reopen_right}"
        );

        // Refresh where line 1 grows into many wrapped rows: line 2's top wrapped row stays fixed.
        let taller_prefix = make(&"longer header ".repeat(35));
        click(&mut rt, "file-refresh");
        rt.update_if(|s, _| s.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "long.txt")
            .await
            .preview("long.txt", &taller_prefix, Some("v2"))
            .await;
        settle(&mut rt).await;
        let (refresh_left, refresh_right) = top_row_span(&mut rt);
        assert_eq!(
            (refresh_left, refresh_right),
            (reopen_left, reopen_right),
            "refresh shifted top wrapped row"
        );

        // Toggle word wrap off and back on while scrolled: selection survives and top logical line stays anchored.
        let sel_before_toggle = {
            let ui = rt.state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            let line2_start = ui.document.edit().text.find('\n').unwrap() + 1;
            let sel = [line2_start + 14, line2_start + 28];
            let edit = ui.document.input(scope);
            edit.anchor = sel[0];
            edit.focus = sel[1];
            sel
        };
        rt.frame(0.02);
        click(&mut rt, "file-wrap");
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let unwrapped_y = rt
            .state
            .files
            .as_ref()
            .unwrap()
            .document
            .source_viewport()
            .captured_scroll()[1];
        assert!(
            (unwrapped_y - (inset + line_height + 2.0)).abs() <= 1.0,
            "unwrapped toggle missed line 2: {unwrapped_y}"
        );
        click(&mut rt, "file-wrap");
        for _ in 0..10 {
            rt.frame(0.02);
        }
        let edit_after_toggle = rt.state.files.as_ref().unwrap().document.edit();
        assert_eq!(
            [edit_after_toggle.anchor, edit_after_toggle.focus],
            sel_before_toggle
        );
        let (rewrapped_left, _) = top_row_span(&mut rt);
        assert!(
            rewrapped_left < 20,
            "rewrapped toggle missed start of line 2: {rewrapped_left}"
        );
        http.quiet().await;
    });
}

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
fn typing_and_primary_save_use_the_versioned_workspace_file() {
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
        let mac = cfg!(target_os = "macos");
        // Rune's native macOS End jumps to the end of the document.
        rt.key(KeyEvent {
            key: if mac { Key::Right } else { Key::End },
            mods: Mods {
                cmd: mac,
                logo: mac,
                ..Mods::default()
            },
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
                ctrl: !mac,
                logo: mac,
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
fn source_save_uses_the_live_override_and_disable_preference() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "source-save-shortcut"));
        open(&mut rt, &http, "main.rs", "YQ==").await;
        let input = rt
            .elements()
            .into_iter()
            .find(|node| editable_source(&node.path, &node.role))
            .unwrap();
        let [x, y, w, h] = input.visible;
        rt.pointer_down(x + w / 2.0, y + h / 2.0);
        rt.pointer_up(x + w / 2.0, y + h / 2.0);
        rt.frame(0.02);
        rt.key(KeyEvent {
            key: Key::Text("b".to_owned()),
            mods: Mods::default(),
        });
        rt.frame(0.02);
        let chord = |key| KeyEvent {
            key,
            mods: Mods {
                cmd: true,
                ..Mods::default()
            },
        };
        for overrides in [
            serde_json::json!({"file-save": []}),
            serde_json::json!({"file-save": [{"key": "f8", "mod": true}]}),
        ] {
            rt.update(|s, _| crate::settings::fixture_shortcuts(s, overrides));
            rt.key(chord(Key::Command('s')));
            rt.frame(0.02);
            rt.update_if(|s, _| s.files.as_mut().unwrap().poll(20.0));
            http.quiet().await;
        }
        rt.key(chord(Key::Function(8)));
        rt.frame(0.02);
        rt.update_if(|s, _| s.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "YQ==", Some("v1"))
            .await;
        settle(&mut rt).await;
        let request = http.request("PUT", "main.rs").await;
        assert!(request.body["contents"].as_str().unwrap().contains('b'));
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
            .reply(409, serde_json::json!({"error": "File changed on disk"}))
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
        let expected_conflict =
            crate::strings::with_locale("en", || crate::strings::t("filesPanel.draftConflict"));
        let a11y = rt.accessibility_json().to_string();
        assert!(a11y.contains(expected_conflict));
        assert!(!a11y.contains("File changed on disk"));
        // A disappeared file can fail both the write and the automatic reread.
        http.request("GET", "main.rs")
            .await
            .reply(404, serde_json::json!({"error": "File no longer exists"}))
            .await;
        settle(&mut rt).await;
        assert!(rt.state.files.as_ref().unwrap().reader.error().is_some());
        let a11y_after_reread = rt.accessibility_json().to_string();
        assert!(a11y_after_reread.contains(expected_conflict));
        assert!(!a11y_after_reread.contains("File changed on disk"));
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

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn isolated_editor_edit_arms_wake_and_persists_draft_while_idle() {
    crate::platform::block_on(async {
        let parent = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
        std::fs::create_dir(&parent).unwrap();
        let store = crate::platform::storage::Store::open(parent.join("rune"))
            .await
            .unwrap();
        let http = http::Http::new().await;
        let documents = Store::default();
        let mut rt = runtime(http.ui(documents.clone(), "idle-draft-wake"));
        rt.state.documents = documents;
        let mut workspace = crate::workspace::Ui::new();
        workspace.fixture_ready();
        workspace.fixture_store(store.clone());
        rt.state.workspace = Some(workspace);
        open(&mut rt, &http, "main.rs", "YQ==").await;
        rt.state
            .files
            .as_mut()
            .unwrap()
            .document
            .fixture_saved_key("installation", "/private");
        let input = rt
            .elements()
            .into_iter()
            .find(|node| node.path.contains("/file-editor/") && node.role == "textbox")
            .expect("the real reader mounts the source input");
        let [x, y, width, _] = input.visible;
        rt.pointer_down(x + width / 2.0, y + 2.0);
        rt.pointer_up(x + width / 2.0, y + 2.0);
        rt.frame(0.02);
        rt.poll = Some(crate::poll);
        rt.frame(1.0);
        // Single character edit with no further user interaction: Rune polls before input,
        // so on_change must arm an immediate wake to schedule the debounced draft checkpoint.
        rt.key(KeyEvent {
            key: Key::Text("x".into()),
            mods: Mods::default(),
        });
        rt.frame(0.02);
        let immediate = rt
            .wake_deadline()
            .expect("editor on_change must arm a wake for poll_file_drafts");
        rt.frame((immediate - rt.clock).max(0.0) + 0.01);
        let debounce = rt
            .wake_deadline()
            .expect("poll_file_drafts must arm the 250 ms debounce wake");
        assert!(debounce > rt.clock);
        rt.frame((debounce - rt.clock).max(0.0) + 0.01);
        let deadline = Instant::now() + Duration::from_secs(5);
        while store.file_draft_write_count() == 0 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(rt);
        while store.file_draft_worker_running() || store.files_refcount() > 1 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let persisted = store.load_file_drafts().await.unwrap().unwrap();
        assert!(
            String::from_utf8_lossy(&persisted).contains("x"),
            "expected persisted draft to contain edit, got: {}",
            String::from_utf8_lossy(&persisted)
        );
        drop(store);
        std::fs::remove_dir_all(parent).unwrap();
        http.quiet().await;
    });
}
