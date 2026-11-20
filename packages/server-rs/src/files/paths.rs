//! Lexical admission of client- and native-supplied paths, applied before any
//! filesystem call (audit M2). Canonicalisation, which opens the target, only
//! follows a path this module admitted: a UNC share, a device namespace
//! (`\\.\pipe\…`), a verbatim prefix or a path outside the authorized root is
//! never opened, so it cannot trigger an SMB/WebDAV connection or reach a pipe.
use std::path::{Component, Path, PathBuf};

/// An absolute path on a local drive (Windows `X:\…`) or under `/` (POSIX),
/// without `..`, NUL, alternate data streams or Windows device names.
pub fn local_absolute(text: &str) -> bool {
    if text.is_empty() || text.len() > 32_768 || text.contains('\0') {
        return false;
    }
    #[cfg(windows)]
    {
        let b = text.as_bytes();
        let separator = |c: u8| c == b'\\' || c == b'/';
        // Only `X:\` or `X:/`: refuses `\\host\share`, `//host`, `\\?\`, `\\.\`,
        // `\??\`, `UNC\…`, root-relative `\x` and drive-relative `X:x`.
        if (b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || !separator(b[2])) || text[2..].contains(':') {
            return false;
        }
    }
    #[cfg(not(windows))]
    if !text.starts_with('/') {
        return false;
    }
    Path::new(text).components().all(|c| match c {
        Component::ParentDir => false,
        #[cfg(windows)]
        Component::Normal(name) => !device(&name.to_string_lossy()),
        _ => true,
    })
}

/// `CON`, `NUL`, `COM1`… open a device whatever their directory or extension.
#[cfg(windows)]
fn device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
    };
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") || numbered("COM") || numbered("LPT")
}

fn same(a: Component, b: Component) -> bool {
    #[cfg(windows)]
    {
        a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// `path` is [`local_absolute`] and lexically equal to or below `root`
/// (case-insensitive on Windows; separators and repeated separators ignored).
pub fn under(root: &Path, path: &Path) -> bool {
    let Some(text) = path.to_str() else { return false };
    if !local_absolute(text) {
        return false;
    }
    let mut parts = path.components();
    root.components().all(|r| parts.next().is_some_and(|p| same(r, p)))
}

/// The physical path of a lexically admitted `path`; `None` without any
/// filesystem access when `path` is not admitted under `root`.
pub fn canonical(root: &Path, path: impl AsRef<Path>) -> Option<PathBuf> {
    let path = path.as_ref();
    if !under(root, path) { None } else { dunce::canonicalize(path).ok() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn windows_refuses_network_device_and_relative_forms() {
        let root = Path::new(r"C:\Work\root");
        for p in [
            r"\\host\share\x",
            r"//host/share/x",
            r"\/host\share",
            r"/\host\share",
            r"\\?\C:\Work\root",
            r"\\?\UNC\host\share",
            r"\\.\pipe\probe",
            r"\??\C:\Work\root",
            r"UNC\host\share",
            r"\Work\root",
            r"C:Work\root",
            r"C:\Work\root\..\other",
            r"C:\Work\root\x:stream",
            r"C:\Work\root\NUL",
            r"C:\Work\root\com1.txt",
            r"C:\Work\rootx",
            r"C:\Work",
            r"D:\Work\root",
            "C:\\Work\\root\0",
            "",
        ] {
            assert!(!under(root, Path::new(p)), "{p}");
            assert!(canonical(root, p).is_none(), "{p}");
        }
        for p in [r"C:\Work\root", r"c:/work/ROOT/sub", r"C:\Work\root\\a\.\b\"] {
            assert!(under(root, Path::new(p)), "{p}");
        }
    }

    #[test]
    #[cfg(not(windows))]
    fn posix_requires_the_lexical_prefix() {
        let root = Path::new("/work/root");
        for p in ["work/root", "/work/root/../x", "/work/rootx", "/work", "//work/root/../a"] {
            assert!(!under(root, Path::new(p)), "{p}");
        }
        assert!(under(root, Path::new("/work//root/a")));
    }

    #[test]
    fn admitted_paths_still_resolve() {
        let dir = dunce::canonicalize(std::env::temp_dir()).unwrap();
        assert_eq!(canonical(&dir, &dir).as_deref(), Some(dir.as_path()));
    }
}
