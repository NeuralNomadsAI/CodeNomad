use crate::{State, files, git};
use std::borrow::Cow;

pub(super) fn open(s: &mut State, href: &str) -> bool {
    open_resolved(s, href)
}

pub(in crate::chat) fn open_native(s: &mut State, path: &str) -> bool {
    open_resolved(s, &literal(path))
}

pub(in crate::chat) fn native_file(s: &State, path: &str) -> Option<String> {
    let (backend, directory) = git::file_link_scope(s)?;
    path_in_scope(
        backend.session_directory.as_deref().unwrap_or(directory),
        directory,
        &literal(path),
    )
}

fn literal(path: &str) -> String {
    path.replace('%', "%25").replace('#', "%23")
}

fn open_resolved(s: &mut State, href: &str) -> bool {
    let Some((backend, directory)) = git::file_link_scope(s) else {
        return false;
    };
    let native = backend.session_directory.as_deref().unwrap_or(directory);
    let Some(path) = path_in_scope(native, directory, href) else {
        return false;
    };
    let (backend, directory) = (backend.clone(), directory.to_owned());
    files::open_session_path(s, &backend, directory, path)
}

fn path_in_scope(native: &str, directory: &str, href: &str) -> Option<String> {
    resolve(href, native).or_else(|| {
        (directory != native)
            .then(|| resolve(href, directory))
            .flatten()
    })
}

fn resolve(href: &str, base: &str) -> Option<String> {
    let trimmed = href.trim();
    if trimmed.len() > 32768 || trimmed.is_empty() {
        return None;
    }
    let path = if trimmed
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
    {
        local_file_url_path(trimmed)?
    } else {
        let href = trimmed.split('#').next()?;
        if href.is_empty() {
            return None;
        }
        let raw = href.replace('\\', "/");
        if non_file(&raw) {
            return None;
        }
        let decoded = decode(&raw);
        let path = decoded.replace('\\', "/");
        if path.is_empty() || non_file(&path) {
            return None;
        }
        path
    };

    let base = base.replace('\\', "/");
    let (root, base) = prefix(&base);
    if root.is_empty() || base.starts_with('/') {
        return None;
    }
    let (other_root, path) = prefix(&path);
    let (base, resolved) = if other_root.is_empty() {
        (
            normalize(base.split('/')),
            normalize(base.split('/').chain(path.split('/'))),
        )
    } else if root.eq_ignore_ascii_case(other_root) {
        (normalize(base.split('/')), normalize(path.split('/')))
    } else {
        return None;
    };
    let inside = resolved.len() > base.len()
        && base.iter().zip(&resolved).all(|(a, b)| {
            if root == "/" {
                a == b
            } else {
                a.to_lowercase() == b.to_lowercase()
            }
        });
    inside.then(|| resolved[base.len()..].join("/"))
}

fn is_windows_drive(path: &str) -> bool {
    matches!(
        path.as_bytes(),
        [letter, b':', b'/' | b'\\', ..] if letter.is_ascii_alphabetic()
    )
}

fn local_file_url_path(href: &str) -> Option<String> {
    let rest = href
        .get(..5)
        .filter(|prefix| prefix.eq_ignore_ascii_case("file:"))
        .map(|_| &href[5..])?;
    let after_authority = if let Some(after_slashes) = rest.strip_prefix("//") {
        if let Some(after_localhost) = after_slashes
            .get(..9)
            .filter(|host| host.eq_ignore_ascii_case("localhost"))
            .map(|_| &after_slashes[9..])
            .filter(|tail| tail.starts_with('/') || is_windows_drive(tail))
        {
            after_localhost
        } else if after_slashes.starts_with('/') || is_windows_drive(after_slashes) {
            after_slashes
        } else {
            return None;
        }
    } else if rest.starts_with('/') || is_windows_drive(rest) {
        rest
    } else {
        return None;
    };
    let head = after_authority.split(['?', '#']).next()?;
    let encoded = head.replace('\\', "/");
    if encoded.chars().any(char::is_control) {
        return None;
    }
    let bytes = encoded.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let (Some(&a), Some(&b)) = (bytes.get(i + 1), bytes.get(i + 2)) else {
                return None;
            };
            if !a.is_ascii_hexdigit() || !b.is_ascii_hexdigit() {
                return None;
            }
            let pair = [a.to_ascii_lowercase(), b.to_ascii_lowercase()];
            if matches!(pair, [b'0', b'0'] | [b'2', b'f'] | [b'5', b'c']) {
                return None;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    let decoded = percent_encoding::percent_decode_str(&encoded)
        .decode_utf8()
        .ok()?;
    if decoded.chars().any(char::is_control) {
        return None;
    }
    let path = decoded
        .strip_prefix('/')
        .filter(|tail| is_windows_drive(tail))
        .unwrap_or(&decoded);
    let valid_root = (path.starts_with('/') && !path.starts_with("//")) || is_windows_drive(path);
    valid_root.then(|| path.to_owned())
}

fn prefix(path: &str) -> (&str, &str) {
    if let Some(tail) = path.strip_prefix('/') {
        ("/", tail)
    } else if let [letter, b':', b'/', ..] = path.as_bytes()
        && letter.is_ascii_alphabetic()
    {
        (&path[..2], &path[3..])
    } else {
        ("", path)
    }
}

fn non_file(path: &str) -> bool {
    path.starts_with("//")
        || path.chars().any(char::is_control)
        || prefix(path).0.is_empty()
            && path.split_once(':').is_some_and(|(scheme, _)| {
                scheme
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic)
                    && scheme
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.'))
            })
}

fn decode(path: &str) -> Cow<'_, str> {
    let mut bytes = path.as_bytes();
    while let Some(i) = bytes.iter().position(|c| *c == b'%') {
        if !bytes
            .get(i + 1..i + 3)
            .is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit))
        {
            return Cow::Borrowed(path);
        }
        bytes = &bytes[i + 3..];
    }
    percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .unwrap_or(Cow::Borrowed(path))
}

fn normalize<'a>(parts: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut normalized = Vec::new();
    for part in parts {
        match part {
            "." | "" => (),
            ".." => {
                normalized.pop();
            }
            _ => normalized.push(part),
        }
    }
    normalized
}

#[cfg(test)]
mod tests;
