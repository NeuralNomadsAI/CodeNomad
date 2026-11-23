use std::borrow::Cow;

mod project;

pub(super) use project::{native_file, open_native};

pub(super) fn open(s: &mut crate::State, href: &str, tx: &mut rune::Tx) {
    if !project::open(s, href) {
        let _ = tx.open_url(&external(href));
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
