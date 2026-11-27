use super::*;
use crate::files::test_http as http;
use crate::files::{document::store::Store, ui::Row};
use codenomad_client::files::{Entry, EntryKind};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use std::time::{Duration, Instant};

mod editor;
mod markdown;
mod reading;
mod resize;
mod server;
mod tree;
mod visual;
mod workspace_actions;

fn english(s: &State, cx: &mut rune::Cx<State>) -> El {
    crate::strings::with_locale("en", || crate::view(s, cx))
}

fn runtime(ui: crate::files::Ui) -> Runtime<State> {
    let mut state = crate::init();
    state.phase = crate::Phase::Ready;
    state.files = Some(ui);
    let mut rt = Runtime::new(state, english, (1000.0, 700.0), Env::new(false, 1.0));
    rt.frame(0.0);
    for _ in 0..30 {
        rt.frame(0.02);
    }
    rt
}

fn shell_runtime(mut ui: crate::files::Ui) -> Runtime<State> {
    let mut s = crate::init();
    crate::gallery::shell::fixture(&mut s);
    let backend = ui.backend.clone();
    let project = crate::catalog::Project {
        id: backend.workspace.clone(),
        path: ui.tree.directory().into(),
        temporary: false,
    };
    s.screen.launcher_mut().unwrap().project = Some(project.clone());
    s.workspace = Some(crate::workspace::Ui::new());
    crate::workspace::opened(&mut s, &project);
    crate::workspace::bound(&mut s, &backend);
    crate::workspace::set_files_tab(&mut s, true);
    s.shell.wanted = [Some([false, ui.panel]); 2];
    ui.shell_managed = true;
    s.files = Some(ui);
    crate::git::connected(&mut s, &backend);
    let mut rt = Runtime::new(s, english, (1000.0, 700.0), Env::new(false, 1.0));
    for _ in 0..30 {
        rt.frame(0.02);
        rt.update(|s, _| crate::shell::sync(s));
    }
    rt
}
fn accessible<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    if node["key"] == key {
        return Some(node);
    }
    node["children"]
        .as_array()?
        .iter()
        .find_map(|node| accessible(node, key))
}
fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    rt.update(|s, _| crate::shell::sync(s));
    rt.frame(0.02);
}
fn editable_source(path: &str, role: &str) -> bool {
    path.contains("/file-editor/") && role == "textbox"
}
async fn settle(rt: &mut Runtime<State>) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        if !rt.state.files.as_ref().unwrap().reader.busy() {
            break;
        }
        assert!(Instant::now() < deadline, "preview deadline");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    rt.frame(0.02);
    for _ in 0..30 {
        rt.frame(0.02);
    }
}
async fn open(rt: &mut Runtime<State>, http: &http::Http, path: &str, contents: &str) {
    rt.update(|state, _| state.files.as_mut().unwrap().open(path.into()));
    rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
    http.request("GET", path)
        .await
        .preview(path, contents, Some("v1"))
        .await;
    settle(rt).await;
}

#[test]
fn eye_opens_real_reader_and_return_preserves_chat_draft_without_prompt() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut ui = http.ui(Store::default(), "occurrence");
        ui.tree.activate(true);
        let entry = Entry {
            name: "main.rs".into(),
            path: "main.rs".into(),
            kind: EntryKind::File,
            absolute_path: None,
            directory_identity: None,
            size: None,
            modified_at: None,
        };
        let read = ui.tree.take_refresh().pop().unwrap();
        let other = Entry {
            name: "other.rs".into(),
            path: "other.rs".into(),
            ..entry.clone()
        };
        ui.tree
            .complete(read, Ok(vec![entry.clone(), other.clone()]), Ok);
        ui.rows = vec![entry, other]
            .into_iter()
            .map(|entry| Row {
                entry,
                parent: ".".into(),
                depth: 1,
                expanded: None,
                busy: false,
            })
            .collect();
        ui.panel = true;
        let mut rt = shell_runtime(ui);
        let (commands, incoming) = codenomad_client::bounded(4);
        rt.state.draft = rune::TextEdit::new("unfinished prompt");
        rt.state.commands = Some(commands);
        click(&mut rt, "file-row-main.rs");
        assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
        click(&mut rt, "file-row-other.rs");
        click(&mut rt, "workspace-actions:main.rs:pinned:preview");
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.selected(),
            Some("other.rs")
        );
        rt.state.files.as_mut().unwrap().poll(20.0);
        let request = http.request("GET", "main.rs").await;
        request
            .preview("main.rs", &"bGV0IHggPSAxOwog".repeat(400), Some("v1"))
            .await;
        settle(&mut rt).await;
        assert!(
            rt.elements()
                .iter()
                .any(|node| editable_source(&node.path, &node.role) && node.visible[3] > 0.0)
        );
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "let x = 1;\n ".repeat(400)
        );
        assert_eq!(rt.state.draft.text, "unfinished prompt");
        assert!(incoming.try_recv().is_err());
        click(&mut rt, "file-wrap");
        assert!(
            crate::workspace::file_wrap(&rt.state),
            "target={:?}, wrapnode={:?}, close={:?}",
            rt.state.files.as_ref().unwrap().reader.target(),
            rt.presented("file-wrap"),
            rt.presented("file-close")
        );
        assert!(rt.find("composer").is_some());
        click(&mut rt, "file-close");
        assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
        let saved = rt.state.workspace.as_ref().unwrap().snapshot();
        assert_eq!(saved.file_wrap, Some(true));
        click(&mut rt, "workspace-actions:other.rs:pinned:preview");
        rt.state.files.as_mut().unwrap().poll(20.0);
        http.request("GET", "other.rs")
            .await
            .preview("other.rs", "YQ==", Some("v1"))
            .await;
        settle(&mut rt).await;
        assert!(crate::workspace::file_wrap(&rt.state));
        click(&mut rt, "file-wrap");
        assert_eq!(
            rt.state.workspace.as_ref().unwrap().snapshot().file_wrap,
            Some(false)
        );
        click(&mut rt, "file-close");
        assert_eq!(rt.state.draft.text, "unfinished prompt");
        assert!(rt.find("rows").is_some());
        assert!(incoming.try_recv().is_err());
        http.quiet().await;
    });
}

#[test]
fn source_selection_copies_through_memory_clipboard() {
    struct Scene;
    fn view(_: &Scene, cx: &mut rune::Cx<Scene>) -> El {
        layout::render(cx, |_| {
            theme::surface(layout::dark()).child(theme::source(
                layout::dark(),
                "main.rs",
                "fn main() {}",
                false,
                None,
            ))
        })
    }
    let mut rt = Runtime::new(Scene, view, (600.0, 320.0), Env::new(false, 1.0));
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    let node = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("file-source-text"))
        .unwrap();
    let [x, y, w, h] = node.rect;
    rt.pointer_down(x + 1.0, y + 1.0);
    rt.pointer_move(x + w - 1.0, y + h - 1.0);
    rt.pointer_up(x + w - 1.0, y + h - 1.0);
    rt.frame(0.02);
    assert_eq!(rt.selected_text().as_deref(), Some("fn main() {}"));
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
        Some("fn main() {}")
    );
}

#[test]
fn source_beyond_the_highlight_limit_remains_visible_selectable_and_copyable() {
    struct Scene {
        text: String,
    }
    fn view(state: &Scene, cx: &mut rune::Cx<Scene>) -> El {
        layout::render(cx, |_| {
            theme::surface(layout::dark()).child(
                theme::viewport(
                    theme::source(layout::dark(), "long.rs", &state.text, false, None),
                    false,
                )
                .key("long-source-scroll"),
            )
        })
    }
    let prefix = "// synthetic source line for selection\n".repeat(4000);
    assert!(prefix.len() > 128 * 1024);
    let tail = "TAIL_MARKER_AFTER_HIGHLIGHT // été 🦀";
    let start = prefix.len();
    let mut rt = Runtime::new(
        Scene {
            text: prefix + tail,
        },
        view,
        (600.0, 320.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    rt.update(|_, tx| tx.scroll_to_bottom_instant("long-source-scroll"));
    for _ in 0..10 {
        rt.frame(0.02);
    }
    assert_eq!(rt.scroll_at_bottom("long-source-scroll"), Some(true));
    let source = rt
        .elements()
        .into_iter()
        .find(|node| node.key.as_deref() == Some("file-source-text"))
        .unwrap();
    assert!(source.text.as_ref().unwrap().ends_with(tail));
    let line = theme::source_font(false).line_px();
    let y = source.rect[1] + source.rect[3] - line / 2.0;
    for _ in 0..2 {
        rt.pointer_down(source.rect[0] + 6.0, y);
        rt.pointer_up(source.rect[0] + 6.0, y);
        rt.frame(0.02);
    }
    assert_eq!(
        rt.selected_text().as_deref(),
        Some(if cfg!(target_os = "windows") {
            "TAIL_MARKER_AFTER_HIGHLIGHT "
        } else {
            "TAIL_MARKER_AFTER_HIGHLIGHT"
        })
    );
    rt.update(|_, tx| tx.select_text("file-source-text", start..start + tail.len()));
    rt.frame(0.02);
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
        Some(tail)
    );
}

#[test]
fn private_image_bytes_decode_and_fit_the_public_pixel_size() {
    crate::platform::block_on(async {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/reader-content.json"))
                .unwrap();
        for case in cases["images"].as_array().unwrap() {
            let http = http::Http::new().await;
            let name = case["name"].as_str().unwrap();
            let mut rt = runtime(http.ui(Store::default(), "images"));
            open(&mut rt, &http, name, case["base64"].as_str().unwrap()).await;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
                let image = rt
                    .state
                    .files
                    .as_ref()
                    .unwrap()
                    .presentation
                    .image
                    .as_ref()
                    .unwrap();
                if image.is_ready() {
                    assert!(image.error().is_none(), "{name}: {:?}", image.error());
                    break;
                }
                assert!(Instant::now() < deadline, "{name}: decode deadline");
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            for _ in 0..30 {
                rt.frame(0.02);
            }
            let image = rt
                .elements()
                .into_iter()
                .find(|node| node.role == "img" && node.label.as_deref() == Some(name))
                .unwrap();
            let width = case["width"].as_f64().unwrap() as f32;
            let height = case["height"].as_f64().unwrap() as f32;
            assert!(image.rect[2] > 0.0 && image.rect[3] > 0.0, "{name}");
            if name != "sample.svg" {
                assert!(
                    image.rect[2] <= width && image.rect[3] <= height,
                    "{name}: {:?}",
                    image.rect
                );
            }
            assert!(
                (image.rect[2] / image.rect[3] - width / height).abs() < 0.001,
                "{name}: {:?}",
                image.rect
            );
            if width < 100.0 && name != "sample.svg" {
                assert_eq!([image.rect[2], image.rect[3]], [width, height], "{name}");
            }
            assert!(rt.take_url_requests().is_empty());
            http.quiet().await;
        }
    });
}

#[test]
fn failed_read_retries_and_passive_revalidation_preserves_source_selection() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "retry"));
        rt.update(|state, _| state.files.as_mut().unwrap().open("main.rs".into()));
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .reply(500, serde_json::json!({"error":"fixture"}))
            .await;
        settle(&mut rt).await;
        assert!(rt.state.files.as_ref().unwrap().reader.error().is_some());
        assert!(rt.elements().iter().any(|node| node.role == "alert"));
        click(&mut rt, "file-refresh");
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "Zm4gbWFpbigpIHt9", Some("v1"))
            .await;
        settle(&mut rt).await;
        rt.update(|state, _| {
            let ui = state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            ui.document.input(scope).set_selection(0, 12);
        });
        rt.frame(0.02);
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().selected(),
            "fn main() {}"
        );
        rt.update(|state, _| state.files.as_mut().unwrap().reader.refresh());
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "main.rs")
            .await
            .preview("main.rs", "Zm4gbWFpbigpIHt9", Some("v2"))
            .await;
        settle(&mut rt).await;
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().selected(),
            "fn main() {}"
        );
        assert!(rt.state.files.as_ref().unwrap().reader.error().is_none());
        http.quiet().await;
    });
}

#[test]
fn markdown_links_html_and_mermaid_fallback_use_only_the_loaded_document() {
    crate::platform::block_on(async {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/reader-content.json"))
                .unwrap();
        for case in cases["documents"].as_array().unwrap() {
            let http = http::Http::new().await;
            let name = case["name"].as_str().unwrap();
            let mut rt = runtime(http.ui(Store::default(), "renderers"));
            open(&mut rt, &http, name, case["base64"].as_str().unwrap()).await;
            if name == "broken.png" {
                let deadline = Instant::now() + Duration::from_secs(3);
                while !rt
                    .state
                    .files
                    .as_ref()
                    .unwrap()
                    .presentation
                    .image
                    .as_ref()
                    .is_some_and(rune::Image::is_ready)
                {
                    assert!(Instant::now() < deadline);
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
                rt.frame(0.02);
            }
            let nodes = rt.elements();
            let shown = nodes
                .iter()
                .filter_map(|node| node.text.as_deref())
                .collect::<Vec<_>>()
                .join("\n");
            match name {
                "markup.md" => {
                    assert!(shown.contains("Reader") && shown.contains("safe"));
                    assert!(!shown.contains("never_execute"));
                    click(&mut rt, "file-source-toggle");
                    assert!(rt.state.files.as_ref().unwrap().presentation.source);
                    assert!(
                        rt.elements()
                            .iter()
                            .any(|node| editable_source(&node.path, &node.role))
                    );
                }
                "valid.mmd" => assert!(nodes.iter().any(|node| node.role == "figure"
                    && node.label.as_deref() == Some("Mermaid diagram"))),
                "unsupported.mmd" | "unreadable.mmd" => {
                    assert!(nodes.iter().any(|node| node.role == "alert"));
                    assert!(shown.contains(if name == "unsupported.mmd" {
                        "unknownDiagram"
                    } else {
                        "flowchart LR"
                    }));
                }
                "nul.bin" | "broken.png" => {
                    assert!(shown.contains("Preview unavailable for this binary file."))
                }
                "reader.rs" => assert!(shown.contains("été 日本語 🦀")),
                _ => panic!("unknown fixture"),
            }
            assert!(rt.take_url_requests().is_empty());
            http.quiet().await;
        }
    });
}

#[test]
fn compressed_workspace_svg_is_rejected_before_the_decoder() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "compressed-svg"));
        open(&mut rt, &http, "drawing.svg", "H4s=").await;
        assert!(
            rt.state
                .files
                .as_ref()
                .unwrap()
                .presentation
                .image
                .is_none()
        );
        assert!(
            rt.elements()
                .iter()
                .any(|node| node.text.as_deref()
                    == Some("Preview unavailable for this binary file."))
        );
        http.quiet().await;
    });
}

#[test]
fn departed_reader_press_and_reopening_keep_the_current_target_and_owned_draft() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "reader-draft"));
        open(&mut rt, &http, "first.rs", "Zm4gbWFpbigpIHt9").await;
        rt.update(|state, _| {
            let ui = state.files.as_mut().unwrap();
            let scope = ui.document.scope();
            ui.document.input(scope).text = "owned unfinished edit".into();
            ui.document.changed(scope);
        });
        rt.frame(0.02);
        let (x, y) = rt.find("file-close").unwrap();
        rt.pointer_down(x, y);
        rt.update(|state, _| state.files.as_mut().unwrap().open("second.rs".into()));
        rt.frame(0.02);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert_eq!(
            rt.state
                .files
                .as_ref()
                .unwrap()
                .reader
                .target()
                .unwrap()
                .path,
            "second.rs"
        );
        rt.update_if(|state, _| state.files.as_mut().unwrap().poll(20.0));
        http.request("GET", "second.rs")
            .await
            .preview("second.rs", "c2Vjb25k", Some("v1"))
            .await;
        settle(&mut rt).await;
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "second"
        );
        open(&mut rt, &http, "first.rs", "Zm4gbWFpbigpIHt9").await;
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "owned unfinished edit"
        );
        assert!(
            rt.elements()
                .iter()
                .any(|node| editable_source(&node.path, &node.role)
                    && node.text.as_deref() == Some("owned unfinished edit"))
        );
        click(&mut rt, "file-refresh");
        assert!(
            rt.state
                .files
                .as_ref()
                .unwrap()
                .document
                .confirmation()
                .is_some()
        );
        click(&mut rt, "file-decision-cancel");
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "owned unfinished edit"
        );
        http.quiet().await;
    });
}

#[test]
fn closing_reader_restores_the_transcript_reading_position() {
    crate::platform::block_on(async {
        let http = http::Http::new().await;
        let mut rt = runtime(http.ui(Store::default(), "history"));
        rt.update(|state, _| {
            state.messages = crate::transport::synthetic();
            state.draft = rune::TextEdit::new("unfinished reader return · été 🦀");
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
        let first_visible = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|node| {
                    node.key
                        .as_deref()
                        .is_some_and(|key| key.starts_with("body-"))
                        && node.visible[3] > 0.0
                })
                .map(|node| (node.key.unwrap(), node.rect[1]))
        };
        let before = first_visible(&rt).unwrap();
        open(&mut rt, &http, "main.rs", &"bGV0IHggPSAxOwog".repeat(400)).await;
        assert!(accessible(&rt.accessibility_json(), "history").is_none());
        assert!(!rt.elements().iter().any(|node| {
            node.key.as_deref() == Some("history")
                || node
                    .key
                    .as_deref()
                    .is_some_and(|key| key.starts_with("body-"))
        }));
        let source_rect = |rt: &Runtime<State>| {
            rt.elements()
                .into_iter()
                .find(|node| editable_source(&node.path, &node.role))
                .unwrap()
        };
        let source = source_rect(&rt);
        rt.wheel(source.visible[0] + 10.0, source.visible[1] + 10.0, -600.0);
        for _ in 0..30 {
            rt.frame(0.02);
        }
        assert!(source_rect(&rt).rect[1] < source.rect[1]);
        rt.update(|state, _| {
            state.messages.push(
                crate::Message {
                    usage: None,
                    id: "while-reading-file".into(),
                    role: "assistant".into(),
                    body: "Arriving message".into(),
                    parts: vec![],
                    completed: true,
                }
                .into(),
            );
            state.revision += 1;
        });
        for _ in 0..30 {
            rt.frame(0.02);
        }
        click(&mut rt, "file-close");
        assert_eq!(first_visible(&rt).unwrap(), before, "first return frame");
        for _ in 0..30 {
            rt.frame(0.02);
            assert_eq!(first_visible(&rt).unwrap(), before, "settling return frame");
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        assert_eq!(first_visible(&rt).unwrap(), before);
        assert_eq!(rt.state.messages.len(), 10001);
        assert_eq!(rt.state.draft.text, "unfinished reader return · été 🦀");
        http.quiet().await;
    });
}
