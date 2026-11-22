use super::*;
use crate::files::test_http as http;
use crate::files::{document::store::Store, ui::Row};
use codenomad_client::files::{Entry, EntryKind};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use std::time::{Duration, Instant};

fn english(s: &State, cx: &mut rune::Cx<State>) -> El {
    crate::strings::with_locale("en", || crate::view(s, cx))
}
fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
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
        let mut state = crate::init();
        state.phase = crate::Phase::Ready;
        state.draft = rune::TextEdit::new("unfinished prompt");
        state.files = Some(ui);
        let (commands, incoming) = codenomad_client::bounded(4);
        state.commands = Some(commands);
        let mut rt = Runtime::new(state, english, (1000.0, 700.0), Env::new(false, 1.0));
        rt.frame(0.0);
        click(&mut rt, "file-row-main.rs");
        assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
        click(&mut rt, "file-row-other.rs");
        click(&mut rt, "file-eye-main.rs");
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
        assert!(rt.elements().iter().any(|node| node.key.as_deref() == Some("file-source-text") && node.visible[3] > 0.0), "{:?}", rt.elements().into_iter().filter(|node|node.path.contains("file-") || node.key.as_deref() == Some("history")).map(|node|(node.key,node.rect,node.visible,node.text)).collect::<Vec<_>>());
        assert_eq!(
            rt.state.files.as_ref().unwrap().document.edit().text,
            "let x = 1;\n ".repeat(400)
        );
        assert_eq!(rt.state.draft.text, "unfinished prompt");
        assert!(incoming.try_recv().is_err());
        click(&mut rt, "file-wrap");
        assert!(
            rt.state.files.as_ref().unwrap().presentation.wrap,
            "target={:?}, wrapnode={:?}, close={:?}",
            rt.state.files.as_ref().unwrap().reader.target(),
            rt.presented("file-wrap"),
            rt.presented("file-close")
        );
        assert!(rt.find("composer").is_some());
        click(&mut rt, "file-close");
        assert!(rt.state.files.as_ref().unwrap().reader.target().is_none());
        assert_eq!(rt.state.draft.text, "unfinished prompt");
        assert!(rt.find("rows").is_some());
        assert!(incoming.try_recv().is_err());
        http.quiet().await;
    });
}

#[test]
fn source_selection_uses_memory_clipboard_and_renderers_make_no_url_request() {
    struct Scene;
    fn view(_: &Scene, cx: &mut rune::Cx<Scene>) -> El {
        layout::render(cx, |_| {
            theme::surface(layout::dark()).child(theme::source(
                layout::dark(),
                "main.rs",
                "fn main() {}",
                false,
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
    assert!(rt.take_url_requests().is_empty());
}
