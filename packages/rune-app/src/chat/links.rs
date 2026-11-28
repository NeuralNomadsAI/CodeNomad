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

pub(super) fn on_menu(
    scope: Rc<()>,
    locale: &'static str,
) -> impl Fn(&mut State, &str, (f32, f32), &mut Tx) {
    let look = rune_theme_codenomad::layout::popup_menu_look();
    move |s, href, press, tx| {
        if s.current_scope(&scope) {
            menu(href, press, &scope, locale, look.clone(), tx);
        }
    }
}

pub(super) fn help(href: &str) -> Option<String> {
    help_for_origin(href, crate::platform::web_origin().as_deref())
}

fn help_for_origin(href: &str, origin: Option<&str>) -> Option<String> {
    (openable_http(href).is_some()
        && codenomad_client::http::is_loopback_http_url(href)
        && origin.is_some_and(|base| !codenomad_client::http::is_loopback_http_url(base)))
    .then(|| crate::strings::t("markdown.link.loopbackOnHost").into())
}

pub(crate) fn open_external(href: &str, tx: &mut Tx) {
    if let Some(url) = openable_external(href) {
        let _ = tx.open_url(&url);
    }
}

fn openable_external(href: &str) -> Option<String> {
    openable_http(href).or_else(|| openable_mailto(href))
}

fn openable_mailto(href: &str) -> Option<String> {
    let trimmed = href.trim();
    let rest = trimmed
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case("mailto:"))
        .map(|_| &trimmed[7..])?;
    if rest.is_empty()
        || rest.starts_with("//")
        || trimmed.len() > 8192
        || !valid_percent(trimmed.as_bytes())
        || has_unsafe_uri_char(trimmed)
    {
        return None;
    }
    Some(trimmed.to_owned())
}

fn menu(
    href: &str,
    point: (f32, f32),
    scope: &Rc<()>,
    locale: &'static str,
    look: rune_theme_codenomad::layout::PopupMenuLook,
    tx: &mut Tx,
) {
    use crate::strings::{t, with_locale};
    let Some(url) = openable_http(href) else {
        return;
    };
    let (open, copy, help) = with_locale(locale, || {
        (
            t("remoteAccess.address.open"),
            t("remoteControl.pairing.copy"),
            help(href),
        )
    });
    let scope = scope.clone();
    rune_theme_codenomad::markdown::link_menu(
        tx,
        point,
        open,
        copy,
        help,
        look,
        move |s: &mut State, picked, tx| {
            if s.current_scope(&scope) {
                match picked {
                    Some("open") => {
                        let _ = tx.open_url(&url);
                    }
                    Some("copy-link") => {
                        s.transcript_display.children.cancel_copy();
                        tx.copy(url.as_str());
                    }
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

fn openable_http(href: &str) -> Option<String> {
    let (url, host) = codenomad_client::http::external_http_url(href)?;
    let hostname = host
        .strip_prefix('[')
        .and_then(|rest| rest.split(']').next())
        .unwrap_or_else(|| host.split(':').next().unwrap_or(&host));
    if hostname.starts_with('.') || hostname.contains("..") {
        return None;
    }
    let url = external(&url).into_owned();
    (url.len() <= 8192 && valid_percent(url.as_bytes()) && !has_unsafe_uri_char(&url))
        .then_some(url)
}

fn has_unsafe_uri_char(url: &str) -> bool {
    url.chars().any(|c| {
        c.is_whitespace()
            || c.is_control()
            || matches!(c, '\\' | '"' | '<' | '>' | '`' | '^' | '{' | '|' | '}')
    })
}

fn valid_percent(bytes: &[u8]) -> bool {
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let (Some(&a), Some(&b)) = (bytes.get(i + 1), bytes.get(i + 2)) else {
                return false;
            };
            if !a.is_ascii_hexdigit() || !b.is_ascii_hexdigit() || (a == b'0' && b == b'0') {
                return false;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    true
}

fn external(url: &str) -> Cow<'_, str> {
    let trimmed = url.trim();
    let Some((scheme, rest)) = trimmed.split_once("://").filter(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    }) else {
        return Cow::Borrowed(trimmed);
    };
    let Some(tail) = rest.find(['/', '?', '#']) else {
        return Cow::Borrowed(trimmed);
    };
    let (host, path) = rest.split_at(tail);
    if !path.contains(['[', ']', '{', '}', '|', '^', '\\']) {
        return Cow::Borrowed(trimmed);
    }
    let mut encoded = String::with_capacity(trimmed.len() + 8);
    encoded.push_str(scheme);
    encoded.push_str("://");
    encoded.push_str(host);
    for ch in path.chars() {
        match ch {
            '[' => encoded.push_str("%5B"),
            ']' => encoded.push_str("%5D"),
            '{' => encoded.push_str("%7B"),
            '}' => encoded.push_str("%7D"),
            '|' => encoded.push_str("%7C"),
            '^' => encoded.push_str("%5E"),
            '\\' => encoded.push_str("%5C"),
            _ => encoded.push(ch),
        }
    }
    Cow::Owned(encoded)
}

#[cfg(test)]
#[test]
fn only_encode_brackets_after_authority() {
    assert_eq!(
        external("https://[::1]:8080/?filter[]=open"),
        "https://[::1]:8080/?filter%5B%5D=open"
    );
    assert_eq!(
        external(" https://[::1]:8080/?filter[]=open&q={id} "),
        "https://[::1]:8080/?filter%5B%5D=open&q=%7Bid%7D"
    );
    assert_eq!(
        external("https://example.org/?filter%5B%5D=open"),
        "https://example.org/?filter%5B%5D=open"
    );
    assert_eq!(
        openable_http(" http://127.0.0.1:8123/a b?q={id} ").as_deref(),
        Some("http://127.0.0.1:8123/a%20b?q=%7Bid%7D")
    );
    for rejected in [
        "http://alice:demo@localhost:8123/",
        "http://@localhost:8123/",
        "http:localhost:8123/",
        "http://127.0.0.1:8123/%ZZ",
        "http://127.0.0.1:8123/%00",
        "http://127.0.0.1:8123/ok\ncmd",
        "http://127.0.0.1:8123\\@evil.example/",
        "https://.example.com/",
        "https://a..b.com/",
    ] {
        assert!(openable_http(rejected).is_none(), "{rejected:?}");
    }
    assert_eq!(
        openable_external(" mailto:local@example.org ").as_deref(),
        Some("mailto:local@example.org")
    );
    assert_eq!(
        openable_external("MAILTO:team@example.org?subject=Hello%20World").as_deref(),
        Some("MAILTO:team@example.org?subject=Hello%20World")
    );
    for rejected in [
        "mailto:",
        "mailto:   ",
        "mailto://evil.example/a@b",
        "mailto:local@example.org%00",
        "mailto:local@example.org%ZZ",
        "mailto:local@example.org\nBcc:evil@example.org",
        "mailto:local@example.org \"arg\"",
        "mailto:<local@example.org>",
        "javascript:alert(1)",
        "data:text/html,hi",
        "file:///etc/passwd",
        "file:///C:/Windows/win.ini",
    ] {
        assert!(openable_external(rejected).is_none(), "{rejected:?}");
    }
}

#[cfg(test)]
#[test]
fn loopback_help_applies_only_to_loopback_links_on_remote_origins() {
    let expected =
        crate::strings::with_locale("en", || crate::strings::t("markdown.link.loopbackOnHost"));
    crate::strings::with_locale("en", || {
        assert_eq!(
            help_for_origin(
                " http://127.0.0.1:8123/view ",
                Some("https://code.example.test")
            )
            .as_deref(),
            Some(expected)
        );
        assert_eq!(
            help_for_origin("https://[::1]:8123/view", Some("https://code.example.test"))
                .as_deref(),
            Some(expected)
        );
        for omitted in [
            "https://127.0.0.1.example.org/",
            "http://alice:demo@localhost:8123/",
            "http://127.0.0.1:8123/%ZZ",
            "http://127.0.0.1:8123/%00",
        ] {
            assert!(
                help_for_origin(omitted, Some("https://code.example.test")).is_none(),
                "{omitted:?}"
            );
        }
        assert!(
            help_for_origin("http://127.0.0.1:8123/view", Some("http://127.0.0.1:4173")).is_none()
        );
        assert!(help_for_origin("http://127.0.0.1:8123/view", None).is_none());
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn native_transcript_dispatches_link_and_context_actions_without_a_window() {
    use rune::{Env, Runtime};
    const SOURCE: &str = "[IPv4](http://127.0.0.1:8123/view?a=1#top) · \
        [IPv6](https://[::1]:8123/view?a=1#top) · [Name](http://localhost:8123/view?a=1#top)\n\n\
        Bare http://localhost:8123/bare · [Ordinary](https://127.0.0.1.example.org/)\n\n\
        [Creds](http://alice:demo@localhost:8123/) · [Mail](mailto:local@example.org)";
    assert!(SOURCE.starts_with(SAMPLE));
    let mut rt = Runtime::new(
        crate::init(),
        |s, _| {
            crate::strings::with_locale("fr", || {
                super::document::prose(s, "", "links".into(), SOURCE, false)
            })
        },
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
        "http://localhost:8123/bare",
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
            let menu = rt.popup_menu().expect("missing link context menu");
            assert!(menu.find("link-help").is_none());
            assert_eq!(menu.find("open").map(|item| item.title()), Some("Ouvrir"));
            assert_eq!(
                menu.find("copy-link").map(|item| item.title()),
                Some("Copier le lien")
            );
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
    let creds = "http://alice:demo@localhost:8123/";
    let [x, y, w, h] = rt
        .elements()
        .into_iter()
        .find(|node| node.role == "link" && node.key.as_deref() == Some(creds))
        .expect("missing credential link")
        .rect;
    let (x, y) = ((x + w / 2.0) as f32, (y + h / 2.0) as f32);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(rt.take_url_requests().is_empty());
    rt.secondary_down(x, y);
    rt.secondary_up(x, y);
    rt.frame(0.02);
    assert!(rt.popup_menu().is_none());

    let mail = "mailto:local@example.org";
    let [x, y, w, h] = rt
        .elements()
        .into_iter()
        .find(|node| node.role == "link" && node.key.as_deref() == Some(mail))
        .expect("missing mailto link")
        .rect;
    let (x, y) = ((x + w / 2.0) as f32, (y + h / 2.0) as f32);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert_eq!(rt.take_url_requests(), [mail]);
    rt.secondary_down(x, y);
    rt.secondary_up(x, y);
    rt.frame(0.02);
    assert!(rt.popup_menu().is_none());
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn link_context_menu_carries_active_theme_popup_menu_style() {
    use rune::{Env, Runtime};
    use rune_theme_codenomad::{layout, palettes};

    let expected_look = |dark: bool, palette: Option<&'static palettes::Palette>| {
        palettes::with_palette(palette, || {
            layout::with_appearance(dark, layout::popup_menu_look)
        })
    };

    fn view(s: &State, cx: &mut rune::Cx<State>) -> rune::El {
        crate::settings::render(s, cx, |_| {
            // Exceed document.rs's 10,000 UTF-16 memo threshold so palette/contrast
            // switches also prove memoized Markdown callbacks refresh their menu look.
            let body = format!(
                "[Local](http://127.0.0.1:8123/view)\n\n{}",
                "memo ".repeat(2200)
            );
            super::document::prose(s, "m1", "links".into(), &body, false)
        })
    }

    let light_palette = palettes::built_in()
        .iter()
        .find(|p| !p.dark)
        .expect("built-in light palette");
    let mut dark_palettes = palettes::built_in().iter().filter(|p| p.dark);
    let dark_a = dark_palettes.next().expect("first built-in dark palette");
    let dark_b = dark_palettes.next().expect("second built-in dark palette");

    let mut state = crate::init();
    crate::settings::fixture_appearance(&mut state, light_palette.id, dark_a.id, "off");
    let mut rt = Runtime::new(state, view, (600.0, 240.0), Env::new(false, 1.0));
    rt.frame(0.0);

    let open_and_check = |rt: &mut Runtime<State>, expected: &layout::PopupMenuLook| {
        let [x, y, w, h] = rt
            .elements()
            .into_iter()
            .find(|node| node.role == "link")
            .expect("missing accessible link")
            .rect;
        let (x, y) = ((x + w / 2.0) as f32, (y + h / 2.0) as f32);
        rt.secondary_down(x, y);
        rt.secondary_up(x, y);
        rt.frame(0.02);
        let menu = rt.popup_menu().expect("missing link context menu");
        assert!(expected.matches(menu));
        rt.resolve_popup(None).unwrap();
        rt.frame(0.02);
    };

    let light = expected_look(false, Some(light_palette));
    let dark = expected_look(true, Some(dark_a));
    let themed = expected_look(true, Some(dark_b));
    let high_contrast = palettes::increased_contrast(Some(dark_b), true).unwrap();
    let contrasted = expected_look(true, Some(high_contrast));
    assert_ne!(light, dark);
    assert_ne!(dark, themed);
    assert_ne!(themed, contrasted);

    open_and_check(&mut rt, &light);

    rt.set_system_dark(true);
    rt.frame(0.02);
    open_and_check(&mut rt, &dark);

    rt.update(|s, _| {
        crate::settings::fixture_appearance(s, light_palette.id, dark_b.id, "off");
    });
    rt.frame(0.02);
    open_and_check(&mut rt, &themed);

    rt.update(|s, _| {
        crate::settings::fixture_appearance(s, light_palette.id, dark_b.id, "on");
    });
    rt.frame(0.02);
    open_and_check(&mut rt, &contrasted);
}
