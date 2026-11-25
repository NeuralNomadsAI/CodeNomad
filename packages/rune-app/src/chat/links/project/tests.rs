use super::*;

#[test]
fn local_markdown_links_resolve_inside_the_exact_native_checkout() {
    for (href, base, want) in [
        (
            "./src/notes%20a.md#details",
            "/work/linked",
            Some("src/notes a.md"),
        ),
        ("src/%F0%9F%A6%80.md", "/work/linked", Some("src/🦀.md")),
        ("src/100%.md", "/work/linked", Some("src/100%.md")),
        (
            "d:/Work/LINKED/Notes.md",
            "D:\\work\\linked",
            Some("Notes.md"),
        ),
        ("/work/Linked/src/a", "/work/linked", None),
        ("/work/linked-other/src/a", "/work/linked", None),
        ("../root/src/a", "/work/linked", None),
        ("%2e%2e/root/src/a", "/work/linked", None),
        ("//server/share/a", "/work/linked", None),
        ("%2F%2Fserver/share/a", "/work/linked", None),
        ("https://example.org/x", "/work/linked", None),
        ("foo%00bar", "/work/linked", None),
        ("file:///work/linked/src/a", "/work/linked", None),
        ("%66ile%3A%2F%2F%2Fwork/linked/src/a", "/work/linked", None),
        ("#current", "/work/linked", None),
        ("/work/linked", "/work/linked", None),
    ] {
        assert_eq!(resolve(href, base).as_deref(), want, "{href}");
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn clicking_a_transcript_link_loads_the_conversation_checkout_not_the_browsed_tree() {
    use crate::files::test_http::{Http, wait};
    use rune::{Env, Runtime};
    use serde_json::json;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut bound = http.backend.clone();
        bound.session_directory = Some("/linked/work".into());
        let mut s = crate::init();
        s.phase = crate::Phase::Ready;
        s.files = Some(http.ui(Default::default(), "test"));
        crate::git::connected_placed(&mut s, &bound, "linked");
        let row = crate::history::decode_message(&json!({
            "id":"link", "type":"assistant", "text":"",
            "content":[{"type":"text", "text":"[Project notes](docs/notes%20a.txt#top)"}],
            "time":{"completed":1}
        }))
        .unwrap();
        s.messages.push(row.into());
        let mut rt = Runtime::new(s, crate::view, (960.0, 820.0), Env::new(false, 1.0));
        rt.frame(0.0);
        let link = rt
            .elements()
            .into_iter()
            .find(|node| {
                node.role == "link" && node.key.as_deref() == Some("docs/notes%20a.txt#top")
            })
            .unwrap();
        let [x, y, w, h] = link.rect;
        rt.pointer_down(x + w / 2.0, y + h / 2.0);
        rt.pointer_up(x + w / 2.0, y + h / 2.0);
        rt.frame(0.02);
        assert!(rt.take_url_requests().is_empty());
        let target = rt.state.files.as_ref().unwrap().reader.target().unwrap();
        assert_eq!(
            (&*target.directory, &*target.path),
            ("/linked/work", "docs/notes a.txt")
        );
        rt.update(|s, tx| {
            crate::files::poll(s, 1.0, tx);
        });
        let request = http.accept().await;
        let first = request.header.lines().next().unwrap();
        assert!(first.starts_with("GET /api/workspaces/owned/files/preview?"));
        assert!(
            first.contains("directory=%2Flinked%2Fwork")
                && first.contains("path=docs%2Fnotes+a.txt"),
            "{first}"
        );
        request
            .preview("docs/notes a.txt", "TGlua2VkIGNoZWNrb3V0Cg==", None)
            .await;
        wait(async {
            loop {
                rt.update_if(|s, tx| crate::files::poll(s, 2.0, tx));
                if rt.state.files.as_ref().unwrap().reader.preview().is_some() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert_eq!(
            rt.state.files.as_ref().unwrap().tree.directory(),
            "/private"
        );
    });
}
