//! Lexical server path spelling, independent of the client's operating system.
//! Mirrors server `files/node_path.rs::Style::of`: a drive or backslash UNC is
//! explicit Win32 syntax; slash-rooted paths retain POSIX case and backslashes.
//! Physical identity, aliases and authorization are resolved by the server.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    Windows,
    Posix,
}

fn style(path: &str) -> Option<Style> {
    if path.is_empty() || path.len() > 32768 || path.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return None;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return Some(Style::Windows);
    }
    if let Some(rest) = path.strip_prefix("\\\\") {
        let mut parts = rest.split(['\\', '/']).filter(|part| !part.is_empty());
        let server = parts.next()?;
        let share = parts.next()?;
        if [server, share]
            .iter()
            .any(|part| matches!(*part, "." | ".." | "?") || part.contains(':'))
        {
            return None;
        }
        return Some(Style::Windows);
    }
    path.starts_with('/').then_some(Style::Posix)
}

pub fn absolute(path: &str) -> bool {
    style(path).is_some()
}

pub fn file_uri(path: &str) -> crate::history::Result<String> {
    let style = style(path).ok_or("absolute server path required")?;
    if path.starts_with("\\\\") {
        return Err("local file URI authority required".into());
    }
    let path = if style == Style::Windows {
        path.replace('\\', "/")
    } else {
        path.into()
    };
    let relative = path.trim_start_matches('/');
    let segments = relative.split('/');
    if segments.clone().any(|part| part == "..") {
        return Err("normalized server path required".into());
    }
    let mut uri = reqwest::Url::parse("file:///")?;
    uri.path_segments_mut()
        .map_err(|_| "file URI path unavailable")?
        .clear()
        .extend(segments);
    let additional_slashes = (path.len() - relative.len()).saturating_sub(1);
    Ok(format!(
        "file://{}{}",
        "/".repeat(additional_slashes),
        uri.path()
    ))
}

pub fn same(left: &str, right: &str) -> bool {
    match (style(left), style(right)) {
        (Some(Style::Windows), Some(Style::Windows)) => {
            let normalize =
                |path: &str| path.replace('\\', "/").trim_end_matches('/').to_lowercase();
            normalize(left) == normalize(right)
        }
        (Some(Style::Posix), Some(Style::Posix)) => {
            left.trim_end_matches('/') == right.trim_end_matches('/')
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_drive_and_unc_match_on_every_client_target() {
        assert!(absolute(r"D:\CodeNomad"));
        assert!(absolute("d:/CodeNomad"));
        assert!(same(r"D:\CodeNomad\", "d:/codenomad"));
        assert!(same(r"\\Server\Share\Project\", r"\\server/SHARE/project"));
        assert!(!same(r"D:\Project", r"E:\Project"));
        assert!(!same(r"\\server\share\project", r"\\other\share\project"));
        assert!(!same(r"\\server\share\project", r"\\server\other\project"));
    }
    #[test]
    fn posix_spelling_preserves_case_literal_backslashes_and_double_slash_roots() {
        assert!(absolute("/project"));
        assert!(same("/project/", "/project"));
        assert!(!same("/Project", "/project"));
        assert!(!same(r"/project\child", "/project/child"));
        assert!(!same("//Server/Share", "//server/share"));
        assert!(!same("//server/share", r"\\server\share"));
        assert!(!same("/project/nested", "/project"));
        assert!(!same("/project/../other", "/other"));
    }
    #[test]
    fn relative_incomplete_unc_device_paths_and_control_characters_are_rejected() {
        for path in [
            "",
            "relative",
            "C:relative",
            r"\rooted",
            r"\\server",
            r"\\server\",
            r"\\.\device",
            r"\\?\C:\project",
            "/project\0other",
            "/project\nother",
            "/project\u{7f}",
        ] {
            assert!(!absolute(path), "accepted {path:?}");
            assert!(
                !same(path, path),
                "compared an invalid server path {path:?}"
            );
        }
        assert!(!absolute(&format!("/{}", "a".repeat(32768))));
    }

    #[test]
    fn files_escape_literal_segments_on_the_server_os() {
        for (path, expected) in [
            (
                r"/project/a b#%🦀\file",
                "file:///project/a%20b%23%25%F0%9F%A6%80%5Cfile",
            ),
            (
                r"D:\Projet\é #%.txt",
                "file:///D:/Projet/%C3%A9%20%23%25.txt",
            ),
            ("/project/%2e%2e", "file:///project/%252e%252e"),
            ("//Server/Share", "file:////Server/Share"),
            ("/", "file:///"),
        ] {
            let actual = file_uri(path).unwrap();
            assert_eq!(actual, expected);
            let parsed = reqwest::Url::parse(&actual).unwrap();
            assert_eq!(parsed.host_str(), None);
            assert_eq!(parsed.fragment(), None);
            assert_eq!(parsed.query(), None);
        }
        assert!(file_uri(r"\\Server\Share").is_err());
        assert!(file_uri("relative").is_err());
        assert!(file_uri("/project/a/../b").is_err());
    }
}
