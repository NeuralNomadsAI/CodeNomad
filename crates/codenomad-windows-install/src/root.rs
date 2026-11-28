//! Which folders can be an install folder. The setup replaces the folder whole and the uninstall
//! deletes it whole, so both ask here first, with the same rule.

use std::path::Path;

use crate::{EXE, Product, folders, installed_root, same_path};

/// Refuses `root` unless the setup may install `p` there: a folder that can be an install folder
/// and is absent, empty, or `p`'s registered install. Anything else stays as it is: the setup
/// replaces what it finds.
pub fn check_install_target(p: &Product, root: &Path) -> Result<(), String> {
    check_folder(root)?;
    let Ok(mut entries) = std::fs::read_dir(root) else {
        return if root.exists() {
            Err("it is not a folder that can be read".into())
        } else {
            Ok(())
        };
    };
    if entries.next().is_none() {
        return Ok(());
    }
    if installed_root(p).is_some_and(|r| same_path(&r, root)) && root.join(EXE).is_file() {
        return Ok(());
    }
    Err(format!("it holds files that are not {}", p.name))
}

/// Refuses `root` unless the uninstall may delete it: a folder that can be an install folder and
/// holds the application.
pub(crate) fn check_installed(root: &Path) -> Result<(), String> {
    check_folder(root)?;
    if !root.join(EXE).is_file() {
        return Err(format!("it has no {EXE}"));
    }
    Ok(())
}

/// Absolute and below a drive's top, not one of the user's own folders (nor holding one), and
/// not a junction or link.
fn check_folder(root: &Path) -> Result<(), String> {
    let below_top = root.parent().and_then(Path::parent).is_some();
    if !root.is_absolute() || root.file_name().is_none() || !below_top {
        return Err("it is not a folder below a drive's top".into());
    }
    // Compared as the disk names them: a short `8.3` name or a junction in a parent spells one
    // of the user's folders another way.
    let real_root = real(root);
    if folders::protected()
        .iter()
        .any(|kept| inside(&real(kept), &real_root))
    {
        return Err("it is, or holds, one of your own folders".into());
    }
    if is_link(root) {
        return Err("it is a junction or link".into());
    }
    Ok(())
}

/// `path` as the disk names it: its nearest existing ancestor resolved (long names, junctions and
/// links followed), with what does not exist yet appended.
fn real(path: &Path) -> std::path::PathBuf {
    let mut missing = Vec::new();
    let mut at = path;
    loop {
        if let Ok(resolved) = std::fs::canonicalize(at) {
            return missing.iter().rev().fold(resolved, |p, part| p.join(part));
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name);
                at = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}
/// [`real`] as other Windows calls spell paths: without the `\\?\` prefix canonicalising adds.
pub(crate) fn real_plain(path: &Path) -> String {
    let real = real(path).to_string_lossy().into_owned();
    match real.strip_prefix(r"\\?\") {
        Some(rest) => rest
            .strip_prefix(r"UNC\")
            .map_or_else(|| rest.to_owned(), |share| format!(r"\\{share}")),
        None => real,
    }
}
/// Whether `path` is `base` or lies inside it, compared without regard to case.
fn inside(path: &Path, base: &Path) -> bool {
    let lower = |p: &Path| {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect::<Vec<_>>()
    };
    lower(path).starts_with(&lower(base))
}

/// A junction, a symbolic link or another reparse point.
pub(crate) fn is_link(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(path)
        .is_ok_and(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}
