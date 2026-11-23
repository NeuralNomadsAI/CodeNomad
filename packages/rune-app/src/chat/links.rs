use crate::State;
use rune::Tx;
use std::{borrow::Cow, rc::Rc};

mod project;
pub(super) use project::{native_file, open_native};

#[cfg(any(test, feature = "test-support"))]
pub(crate) const SAMPLE: &str = "[IPv4](http://127.0.0.1:8123/view?a=1#top) · \
    [IPv6](https://[::1]:8123/view?a=1#top) · [Name](http://localhost:8123/view?a=1#top)\n\n\
    Bare http://localhost:8123/bare · [Ordinary](https://127.0.0.1.example.org/)";

pub(super) fn on_open(scope: Rc<()>) -> impl Fn(&mut State, &str, &mut Tx) {
    move |s, href, tx| {
        if s.current_scope(&scope) {
            open(s, href, tx);
        }
    }
}

pub(super) fn on_menu(scope: Rc<()>) -> impl Fn(&mut State, &str, (f32, f32), &mut Tx) {
    move |s, href, press, tx| {
        if s.current_scope(&scope) {
            menu(href, press, &scope, tx);
        }
    }
}

pub(super) fn help(href: &str) -> Option<String> {
    #[cfg(target_arch = "wasm32")]
    if codenomad_client::http::is_loopback_http_url(href)
        && web_sys::window()
            .and_then(|window| web_sys::Location::origin(&window.location()).ok())
            .is_some_and(|base| !codenomad_client::http::is_loopback_http_url(&base))
    {
        return Some(crate::strings::t("markdown.link.loopbackOnHost").into());
    }
    let _ = href;
    None
}

pub(super) fn open_external(href: &str, tx: &mut Tx) {
    let _ = tx.open_url(&external(href));
}

fn menu(href: &str, point: (f32, f32), scope: &Rc<()>, tx: &mut Tx) {
    use crate::strings::t;
    if codenomad_client::http::external_http_url(href).is_none() {
        return;
    }
    let help = help(href);
    let href = href.to_owned();
    let scope = scope.clone();
    rune_theme_codenomad::markdown::link_menu(
        tx,
        point,
        t("remoteAccess.address.open"),
        t("remoteControl.pairing.copy"),
        help,
        move |s: &mut State, picked, tx| {
            if s.current_scope(&scope) {
                match picked {
                    Some("open") => open_external(&href, tx),
                    Some("copy-link") => tx.copy(href.as_str()),
                    _ => {}
                }
            }
        },
    );
}

pub(super) fn open(s: &mut State, href: &str, tx: &mut Tx) {
    if !project::open(s, href) {
        open_external(href, tx);
    }
}

pub(super) fn external(url: &str) -> Cow<'_, str> {
    let Some((scheme, rest)) = url.split_once("://").filter(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    }) else {
        return Cow::Borrowed(url);
    };
    let Some(tail) = rest.find(['/', '?', '#']) else {
        return Cow::Borrowed(url);
    };
    let (host, path) = rest.split_at(tail);
    if !path.contains(['[', ']']) {
        return Cow::Borrowed(url);
    }
    Cow::Owned(format!(
        "{scheme}://{host}{}",
        path.replace('[', "%5B").replace(']', "%5D")
    ))
}

#[cfg(test)]
#[test]
fn only_encode_brackets_after_authority() {
    assert_eq!(
        external("https://[::1]:8080/?filter[]=open"),
        "https://[::1]:8080/?filter%5B%5D=open"
    );
    assert_eq!(
        external("https://example.org/?filter%5B%5D=open"),
        "https://example.org/?filter%5B%5D=open"
    );
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn native_transcript_dispatches_link_and_context_actions_without_a_window() {
    use rune::{Env, Runtime};
    let mut rt = Runtime::new(
        crate::init(),
        |s, _| super::document::prose(s, "links".into(), SAMPLE, false),
        (800.0, 360.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    assert!(rt.take_url_requests().is_empty());
    for url in [
        "http://127.0.0.1:8123/view?a=1#top",
        "https://[::1]:8123/view?a=1#top",
        "http://localhost:8123/view?a=1#top",
    ] {
        let [x, y, w, h] = rt
            .elements()
            .into_iter()
            .find(|node| node.role == "link" && node.key.as_deref() == Some(url))
            .unwrap_or_else(|| panic!("missing accessible link {url}"))
            .rect;
        let (x, y) = ((x + w / 2.0) as f32, (y + h / 2.0) as f32);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert_eq!(rt.take_url_requests(), [url]);
        for choice in [None, Some("copy-link"), Some("open")] {
            rt.secondary_down(x, y);
            rt.secondary_up(x, y);
            rt.frame(0.02);
            assert!(rt.popup_menu().is_some());
            rt.resolve_popup(choice).unwrap();
            if choice == Some("copy-link") {
                assert_eq!(
                    clipboard.text().as_ref().map(|value| value.as_str()),
                    Some(url)
                );
            }
            assert_eq!(
                rt.take_url_requests(),
                if choice == Some("open") {
                    vec![url]
                } else {
                    vec![]
                }
            );
        }
    }
}
