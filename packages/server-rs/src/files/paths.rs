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
/// (case-insensitive on Windows; separators and repeated separators ignored);
/// an empty `root` (`--unrestricted-root`) admits every local absolute path.
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

/// Resolves a [`local_absolute`] `path` to its canonical physical location, or to the
/// canonical nearest existing directory ancestor joined with its remaining missing normal
/// components, then verifies confinement under `root`.
///
/// Refuses non-local/UNC/device/`..`/NUL/ADS paths without any filesystem call (audit M2),
/// dangling symlinks, non-directory ancestors, and any target that resolves outside `root`.
pub fn resolve_under(root: &Path, path: impl AsRef<Path>) -> Option<PathBuf> {
    let path = path.as_ref();
    let text = path.to_str()?;
    if !local_absolute(text) {
        return None;
    }
    let resolved = canonical_or_ancestor(path)?;
    under(root, &resolved).then_some(resolved)
}

fn canonical_or_ancestor(path: &Path) -> Option<PathBuf> {
    if let Ok(real) = dunce::canonicalize(path) {
        return Some(real);
    }
    let mut current = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(&current) {
            // An existing entry (e.g. a dangling symlink, symlink loop, or unreadable node)
            // failed `canonicalize`: never treat it as a missing suffix.
            Ok(_) => return None,
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => return None,
            Err(_) => {}
        }
        missing.push(current.file_name()?.to_owned());
        current = current.parent()?.to_path_buf();
        if let Ok(real) = dunce::canonicalize(&current) {
            if !real.is_dir() {
                return None;
            }
            let mut resolved = real;
            for part in missing.into_iter().rev() {
                resolved.push(part);
            }
            return Some(resolved);
        }
    }
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
        // Unrestricted: any local absolute path, never a network or relative one.
        let anywhere = Path::new("");
        assert!(under(anywhere, &dir) && !under(anywhere, Path::new("relative")));
        #[cfg(windows)]
        assert!(!under(anywhere, Path::new(r"\\host\share\x")) && !under(anywhere, Path::new(r"C:\a\..\b")));
    }

    fn make_dir_link(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let out = std::process::Command::new("cmd")
                .creation_flags(0x0800_0000)
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));
        }
    }

    #[test]
    fn resolve_under_admits_alias_into_scope_and_rejects_escapes() {
        let base = dunce::canonicalize(crate::shared::test_dir("paths-resolve-under")).unwrap();
        let scope = base.join("private").join("root");
        let inside = scope.join("project");
        let outside = base.join("outside");
        let alias = base.join("var-alias");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        make_dir_link(&alias, &scope);

        // Alias outside scope pointing to canonical scope (like macOS /var -> /private/var) is admitted.
        assert_eq!(resolve_under(&scope, alias.join("project")).as_deref(), Some(inside.as_path()));
        // Missing child under an aliased existing directory resolves under canonical scope.
        assert_eq!(
            resolve_under(&scope, alias.join("project").join("future").join("nested")),
            Some(inside.join("future").join("nested"))
        );

        // Symlink/junction inside scope pointing outside scope is refused, direct and with missing suffix.
        let escape = scope.join("escape-link");
        make_dir_link(&escape, &outside);
        assert_eq!(resolve_under(&scope, &escape), None);
        assert_eq!(resolve_under(&scope, escape.join("child")), None);

        // Regular file ancestor cannot host a missing child path.
        let file = inside.join("plain.txt");
        std::fs::write(&file, "data").unwrap();
        assert_eq!(resolve_under(&scope, file.join("child")), None);

        // Direct outside path and lexical parent traversal are refused.
        assert_eq!(resolve_under(&scope, &outside), None);
        assert_eq!(resolve_under(&scope, inside.join("..").join("..").join("outside")), None);

        // Dangling link inside scope is refused rather than treated as missing.
        #[cfg(unix)]
        {
            let dangling = scope.join("dangling");
            std::os::unix::fs::symlink(outside.join("absent"), &dangling).unwrap();
            assert_eq!(resolve_under(&scope, &dangling), None);
            assert_eq!(resolve_under(&scope, dangling.join("child")), None);
        }

        #[cfg(windows)]
        {
            let _ = std::fs::remove_dir(&escape);
            let _ = std::fs::remove_dir(&alias);
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
