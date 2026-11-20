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

/// The lexical location of an admitted relative path.
pub fn target(base: &Path, relative: &str) -> PathBuf {
    if relative == "." { base.to_path_buf() } else { base.join(relative) }
}

/// Refuses a link whose target lies in this project's protected names
/// (`.git`, reserved device names). A missing, dangling or unresolvable
/// target (loop) passes: the access itself then fails as in the reference.
pub fn guard(base: &Path, relative: &str) -> Result<(), Error> {
    let Ok(real) = dunce::canonicalize(target(base, relative)) else { return Ok(()) };
    match real.strip_prefix(base) {
        Ok(inside) => {
            let inside = inside.to_str().ok_or_else(unavailable)?.replace('\\', "/");
            files::relative(if inside.is_empty() { "." } else { &inside }, true).map(|_| ())
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
pub fn read(base: &Path, relative: &str, max: usize) -> Result<Option<Vec<u8>>, Error> {
    guard(base, relative)?;
    let Ok(file) = std::fs::File::open(target(base, relative)) else { return Ok(None) };
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err(not_file());
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
        std::fs::create_dir_all(base.join(".git")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("note.txt"), "outside\n").unwrap();
        std::fs::write(base.join(".git").join("config"), "[core]\n").unwrap();
        link_dir(&outside, &base.join("out")).unwrap();
        link_dir(&base.join(".git"), &base.join("gitalias")).unwrap();
        assert_eq!(read(&base, "out/note.txt", 64).unwrap().unwrap(), b"outside\n");
        assert!(guard(&base, "gitalias/config").is_err(), "a link into .git stays refused");
        assert!(read(&base, "missing.txt", 64).unwrap().is_none());
        assert!(!matches!(read(&base, "out", 64), Ok(Some(_))), "a directory yields no bytes");
        assert!(read_lenient(&base, "out", 64).unwrap().is_none());
        std::fs::write(outside.join("big.txt"), "x".repeat(65)).unwrap();
        assert!(read_lenient(&base, "out/big.txt", 64).is_err());
        let _ = std::fs::remove_dir_all(top);
    }
}
