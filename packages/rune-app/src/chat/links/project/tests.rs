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
            "docs/2026-11-26-算法工作台MVP-design.md#L10-L20",
            "/work/linked",
            Some("docs/2026-11-26-算法工作台MVP-design.md"),
        ),
        (
            "docs/résumé-été.md#L1-L5",
            "/work/linked",
            Some("docs/résumé-été.md"),
        ),
        (
            "docs/caf%C3%A9%20%E7%AE%97%E6%B3%95.md#L10-L20",
            "/work/linked",
            Some("docs/café 算法.md"),
        ),
        (
            "d:/Work/LINKED/Notes.md",
            "D:\\work\\linked",
            Some("Notes.md"),
        ),
        (
            "d:/Projets/été/工作/docs/café.md#L10-L20",
            "D:\\Projets\\Été\\工作",
            Some("docs/café.md"),
        ),
        (
            "C%3A/work/linked/docs/r%C3%A9sum%C3%A9.md#L4",
            "C:\\work\\linked",
            Some("docs/résumé.md"),
        ),
        ("file:///work/linked/src/a", "/work/linked", Some("src/a")),
        (
            "file:///work/linked/docs/caf%C3%A9%20%E7%AE%97%E6%B3%95.md#L10-L20",
            "/work/linked",
            Some("docs/café 算法.md"),
        ),
        (
            "file://localhost/work/linked/docs/%E7%AE%97%E6%B3%95.md?view=%2F#L10-L20",
            "/work/linked",
            Some("docs/算法.md"),
        ),
        (
            "file:/work/linked/docs/résumé.md#L2",
            "/work/linked",
            Some("docs/résumé.md"),
        ),
        (
            "file:///D:/work/linked/docs/r%C3%A9sum%C3%A9.md#L10-L20",
            "D:\\work\\linked",
            Some("docs/résumé.md"),
        ),
        (
            "file:D:\\work\\linked\\docs\\notes.md#L1",
            "D:\\work\\linked",
            Some("docs/notes.md"),
        ),
        (
            "file://D:/work/linked/docs/notes.md",
            "D:\\work\\linked",
            Some("docs/notes.md"),
        ),
        ("/work/Linked/src/a", "/work/linked", None),
        ("/work/linked-other/src/a", "/work/linked", None),
        ("../root/src/a", "/work/linked", None),
        ("%2e%2e/root/src/a", "/work/linked", None),
        ("//server/share/a", "/work/linked", None),
        ("%2F%2Fserver/share/a", "/work/linked", None),
        (
            "/%5Cfixture.invalid%5Cshare%5Cnotes.txt",
            "/work/linked",
            None,
        ),
        ("https://example.org/x", "/work/linked", None),
        ("javascript:alert(1)", "/work/linked", None),
        ("javascript%3Aalert(1)", "/work/linked", None),
        ("data:text/plain,x", "/work/linked", None),
        ("data%3Atext/plain,x", "/work/linked", None),
        ("foo%00bar", "/work/linked", None),
        ("file:///etc/passwd", "/work/linked", None),
        ("file:///work/linked-other/src/a", "/work/linked", None),
        ("file:///work/linked/../outside.md", "/work/linked", None),
        (
            "file:///work/linked/%2e%2e/outside.md",
            "/work/linked",
            None,
        ),
        (
            "file://server/share/work/linked/src/a",
            "/work/linked",
            None,
        ),
        ("file:////server/share/a", "/work/linked", None),
        ("file:///\\\\server\\share\\a", "/work/linked", None),
        ("file:///%5C%5Cserver%5Cshare", "/work/linked", None),
        ("file:///work/linked/src%2Fa", "/work/linked", None),
        ("file:///work/linked/src%5Ca", "/work/linked", None),
        ("file:///work/linked/foo%00bar", "/work/linked", None),
        ("file:///work/linked/100%.md", "/work/linked", None),
        ("file:///work/linked", "/work/linked", None),
        ("%66ile%3A%2F%2F%2Fwork/linked/src/a", "/work/linked", None),
        ("#current", "/work/linked", None),
        ("/work/linked", "/work/linked", None),
    ] {
        assert_eq!(resolve(href, base).as_deref(), want, "{href}");
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn clicking_non_ascii_and_confined_file_links_opens_only_checkout_files() {
    use crate::files::test_http::Http;
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
            "id":"links-nonascii", "type":"assistant", "text":"",
            "content":[{"type":"text", "text":"[Spec](docs/2026-11-26-算法工作台-café.md#L10-L20) · [FileUrl](file:///linked/work/docs/r%C3%A9sum%C3%A9%20%E7%AE%97%E6%B3%95.md#L1-L5) · [Outside](file:///etc/passwd) · [Js](javascript:alert(1)) · [Data](data:text/html,hi)"}],
            "time":{"completed":1}
        }))
        .unwrap();
        s.messages.push(row.into());
        let mut rt = Runtime::new(s, crate::view, (960.0, 820.0), Env::new(false, 1.0));
        rt.frame(0.0);

        let click_link = |rt: &mut Runtime<crate::State>, href: &str| {
            let [x, y, w, h] = rt
                .elements()
                .into_iter()
                .find(|node| node.role == "link" && node.key.as_deref() == Some(href))
                .unwrap_or_else(|| panic!("missing link {href:?}"))
                .rect;
            rt.pointer_down(x + w / 2.0, y + h / 2.0);
            rt.pointer_up(x + w / 2.0, y + h / 2.0);
            rt.frame(0.02);
        };

        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
        ] {
            click_link(&mut rt, refused);
            assert!(rt.take_url_requests().is_empty(), "{refused}");
            assert!(
                rt.state.files.as_ref().unwrap().reader.target().is_none(),
                "{refused}"
            );
        }

        click_link(&mut rt, "docs/2026-11-26-算法工作台-café.md#L10-L20");
        assert!(rt.take_url_requests().is_empty());
        let target = rt.state.files.as_ref().unwrap().reader.target().unwrap();
        assert_eq!(
            (&*target.directory, &*target.path),
            ("/linked/work", "docs/2026-11-26-算法工作台-café.md")
        );

        rt.state.files.as_mut().unwrap().reader.close();
        rt.frame(0.04);

        click_link(
            &mut rt,
            "file:///linked/work/docs/r%C3%A9sum%C3%A9%20%E7%AE%97%E6%B3%95.md#L1-L5",
        );
        assert!(rt.take_url_requests().is_empty());
        let target = rt.state.files.as_ref().unwrap().reader.target().unwrap();
        assert_eq!(
            (&*target.directory, &*target.path),
            ("/linked/work", "docs/résumé 算法.md")
        );
    });
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
