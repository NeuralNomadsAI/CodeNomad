//! Project files follow symbolic links and junctions like the reference
//! (`filesystem/browser.ts`, `workspaces/git-status.ts`): a request path is
//! confined lexically under the project folder, then the filesystem resolves
//! links wherever they point, outside the project included. Kept: the lexical
//! refusals of `files::workspace_path`/`relative` (`..` past the root,
//! absolute paths outside it, network and device spellings, reserved names,
//! `.git` components) and a resolved target inside the project's own `.git`.
use crate::{Error, error, files};
use axum::http::StatusCode as Status;
use std::{
    io::Read,
    path::{Path, PathBuf},
};

fn unavailable() -> Error {
    error(Status::BAD_REQUEST, "Selected path is unavailable")
}

fn changed() -> Error {
    error(Status::CONFLICT, "File changed on disk")
}

fn resolve_parent(parent: &Path, conditional: bool) -> Result<PathBuf, Error> {
    let real = dunce::canonicalize(parent)
        .map_err(|err| if conditional && files::is_missing_or_not_dir(&err) { changed() } else { unavailable() })?;
    if !std::fs::metadata(&real).is_ok_and(|m| m.is_dir()) {
        return Err(if conditional { changed() } else { unavailable() });
    }
    Ok(real)
}

/// The lexical location of an admitted relative path.
pub fn target(base: &Path, relative: &str) -> PathBuf {
    if relative == "." { base.to_path_buf() } else { base.join(relative) }
}

fn is_dir_link(path: &Path, link: &Path) -> bool {
    let raw = link.to_string_lossy();
    if raw.ends_with('/') || cfg!(windows) && raw.ends_with('\\') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0) {
            return true;
        }
    }
    let _ = path;
    false
}

/// Resolve the file or its parent before admitting a write, including a
/// not-yet-created file behind a directory link.
pub(super) fn write_target(mut path: PathBuf, reject_dir_link: bool, conditional: bool) -> Result<PathBuf, Error> {
    for _ in 0..40 {
        if let Ok(real) = dunce::canonicalize(&path) {
            return Ok(real);
        }
        if let Ok(link) = std::fs::read_link(&path) {
            if reject_dir_link && is_dir_link(&path, &link) {
                return Err(if conditional { changed() } else { not_file() });
            }
            let parent = resolve_parent(path.parent().ok_or_else(unavailable)?, conditional)?;
            path = parent.join(link);
        } else {
            let parent = resolve_parent(path.parent().ok_or_else(unavailable)?, conditional)?;
            let leaf = path.file_name().ok_or_else(|| if conditional { changed() } else { unavailable() })?;
            return Ok(parent.join(leaf));
        }
    }
    Err(unavailable())
}

/// Refuses a link whose target lies in this project's protected names
/// (`.git`, reserved device names). A missing, dangling or unresolvable
/// target (loop) passes: the access itself then fails as in the reference.
pub fn guard(base: &Path, relative: &str) -> Result<(), Error> {
    let candidate = target(base, relative);
    let resolved = dunce::canonicalize(&candidate).or_else(|_| write_target(candidate, false, false).map_err(|_| ()));
    let Ok(real) = resolved else { return Ok(()) };
    match real.strip_prefix(base) {
        Ok(inside) => {
            if inside.as_os_str().is_empty() {
                return Ok(());
            }
            if cfg!(windows) {
                let inside = inside.to_str().ok_or_else(unavailable)?.replace('\\', "/");
                return files::relative(&inside, true).map(|_| ());
            }
            for component in inside.components() {
                match component {
                    std::path::Component::Normal(part) => {
                        let name = part.to_str().ok_or_else(unavailable)?;
                        files::check_component(name)?;
                    }
                    _ => return Err(files::invalid()),
                }
            }
            Ok(())
        }
        Err(_) => Ok(()),
    }
}

fn large() -> Error {
    error(Status::BAD_REQUEST, "Selected file is too large to attach")
}
fn not_file() -> Error {
    error(Status::BAD_REQUEST, "Selected path is not a file")
}

/// File bytes through links; `None` when the path is missing or unreadable.
/// Stats first so directories, special files, and oversized files are rejected
/// before opening or allocating the bounded buffer.
pub fn read(base: &Path, relative: &str, max: usize) -> Result<Option<Vec<u8>>, Error> {
    guard(base, relative)?;
    let path = target(base, relative);
    let Ok(meta) = std::fs::metadata(&path) else { return Ok(None) };
    if !meta.is_file() {
        return Err(not_file());
    }
    if meta.len() > max as u64 {
        return Err(large());
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let Ok(file) = opts.open(&path) else { return Ok(None) };
    let Ok(file_meta) = file.metadata() else { return Ok(None) };
    if !file_meta.is_file() {
        return Err(not_file());
    }
    if file_meta.len() > max as u64 {
        return Err(large());
    }
    let mut bytes = Vec::new();
    if file.take(max as u64 + 1).read_to_end(&mut bytes).is_err() {
        return Ok(None);
    }
    if bytes.len() > max { Err(large()) } else { Ok(Some(bytes)) }
}

/// A diff's working-tree side: anything unreadable (missing, directory,
/// loop) is empty text, as in the reference; only the size bound refuses.
pub fn read_lenient(base: &Path, relative: &str, max: usize) -> Result<Option<Vec<u8>>, Error> {
    match read(base, relative, max) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.1.0["error"] == large().1.0["error"] => Err(e),
        Err(_) => Ok(None),
    }
}

/// Non-blocking wrapper around `read_lenient` for the single-threaded Tokio runtime.
pub async fn read_lenient_async(base: PathBuf, relative: String, max: usize) -> Result<Option<Vec<u8>>, Error> {
    tokio::task::spawn_blocking(move || read_lenient(&base, &relative, max)).await.map_err(|_| unavailable())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    fn link_dir(target: &Path, link: &Path) -> io::Result<()> {
        #[cfg(windows)]
        {
            // A junction needs no privilege.
            let status =
                std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output()?;
            if !status.status.success() { Err(io::Error::other("mklink /J failed")) } else { Ok(()) }
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link)
    }

    #[test]
    fn links_are_followed_outside_but_not_into_git() {
        let top = crate::shared::test_dir("links");
        let (base, outside) = (top.join("project"), top.join("outside"));
        std::fs::create_dir_all(base.join(".git").join("hooks")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("note.txt"), "outside\n").unwrap();
        std::fs::write(base.join(".git").join("config"), "[core]\n").unwrap();
        link_dir(&outside, &base.join("out")).unwrap();
        link_dir(&base.join(".git"), &base.join("gitalias")).unwrap();
        link_dir(&base.join(".git").join("hooks"), &base.join("hooksalias")).unwrap();
        assert_eq!(read(&base, "out/note.txt", 64).unwrap().unwrap(), b"outside\n");
        assert!(guard(&base, "gitalias/config").is_err(), "a link into .git stays refused");
        assert!(guard(&base, "gitalias/new-hook").is_err(), "a missing file behind a link into .git stays refused");
        let symlink_result = {
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_file("..\\new-hook", base.join(".git").join("hooks").join("rel"))
            }
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink("../new-hook", base.join(".git").join("hooks").join("rel"))
            }
        };
        if symlink_result.is_ok() {
            assert!(
                guard(&base, "hooksalias/rel").is_err(),
                "a dangling relative symlink behind a directory link into .git stays refused"
            );
        }
        assert!(read(&base, "missing.txt", 64).unwrap().is_none());
        assert!(!matches!(read(&base, "out", 64), Ok(Some(_))), "a directory yields no bytes");
        assert!(read_lenient(&base, "out", 64).unwrap().is_none());
        std::fs::write(outside.join("big.txt"), "x".repeat(65)).unwrap();
        assert!(read_lenient(&base, "out/big.txt", 64).is_err());
        let deleted = top.join("deleted-dir");
        std::fs::create_dir_all(&deleted).unwrap();
        #[cfg(windows)]
        link_dir(&deleted, &base.join("broken-dir-link")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(format!("{}/", deleted.display()), base.join("broken-dir-link")).unwrap();
        std::fs::remove_dir(&deleted).unwrap();
        assert!(
            write_target(base.join("broken-dir-link"), true, false).is_err(),
            "a broken directory link or junction is not a writable file target"
        );
        assert_eq!(
            write_target(base.join("broken-dir-link"), true, true).unwrap_err().0,
            Status::CONFLICT,
            "conditional write behind a broken directory link returns 409"
        );
        assert!(!deleted.exists());
        let missing_parent = base.join("absent-dir").join("note.txt");
        assert_eq!(write_target(missing_parent.clone(), true, false).unwrap_err().0, Status::BAD_REQUEST);
        assert_eq!(write_target(missing_parent, true, true).unwrap_err().0, Status::CONFLICT);
        let file_parent = base.join("regular-file");
        std::fs::write(&file_parent, "not-a-dir").unwrap();
        assert_eq!(write_target(file_parent.join("note.txt"), true, false).unwrap_err().0, Status::BAD_REQUEST);
        assert_eq!(write_target(file_parent.join("note.txt"), true, true).unwrap_err().0, Status::CONFLICT);
        let _ = std::fs::remove_dir_all(top);
    }

    #[cfg(unix)]
    #[test]
    fn posix_trailing_backslash_in_symlink_target_and_parent_is_preserved() {
        use std::os::unix::fs::symlink;
        let top = crate::shared::test_dir("links-posix-backslash");
        let base = dunce::canonicalize(&top).unwrap();
        let dir = base.join(r"dir\");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("note.txt");
        std::fs::write(&file, "ok").unwrap();
        let leaf = base.join(r"leaf\");
        std::fs::write(&leaf, "leaf").unwrap();
        symlink(r"dir\/note.txt", base.join("via-dir")).unwrap();
        symlink(r"leaf\", base.join("via-leaf")).unwrap();
        symlink(r"dangling\", base.join("via-dangling")).unwrap();
        symlink(r"dir\/.git/config", base.join("via-git")).unwrap();
        assert_eq!(write_target(base.join("via-dir"), true, false).unwrap(), file);
        assert_eq!(write_target(base.join("via-leaf"), true, false).unwrap(), leaf);
        assert_eq!(write_target(base.join("via-dangling"), true, false).unwrap(), base.join(r"dangling\"));
        guard(&base, "via-dir").unwrap();
        guard(&base, "via-leaf").unwrap();
        guard(&base, "via-dangling").unwrap();
        assert!(guard(&base, "via-git").is_err(), ".git under a backslash-named dir stays refused");
        let _ = std::fs::remove_dir_all(top);
    }
}
