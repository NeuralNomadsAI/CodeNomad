use crate::{State, files, git};
use std::borrow::Cow;

pub(super) fn open(s: &mut State, href: &str) -> bool {
    let Some((backend, directory)) = git::file_link_scope(s) else {
        return false;
    };
    let native = backend.session_directory.as_deref().unwrap_or(directory);
    let Some(path) = resolve(href, native).or_else(|| {
        (directory != native)
            .then(|| resolve(href, directory))
            .flatten()
    }) else {
        return false;
    };
    let (backend, directory) = (backend.clone(), directory.to_owned());
    files::open_session_path(s, &backend, directory, path)
}

fn resolve(href: &str, base: &str) -> Option<String> {
    let href = href.trim().split('#').next()?;
    if href.len() > 32768 || href.is_empty() {
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
