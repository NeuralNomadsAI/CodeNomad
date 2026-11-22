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

pub(crate) fn absolute(path: &str) -> bool {
    style(path).is_some()
}

pub(crate) fn same(left: &str, right: &str) -> bool {
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
}
