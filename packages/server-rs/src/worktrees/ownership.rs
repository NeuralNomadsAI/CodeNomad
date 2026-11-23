//! Location ownership for `subagent-depth` and `pending-requests`: `WorkspaceManager.getServiceDirectoryForPath` /
//! `ownsLocation` / `getWorktreeIdentityForPath` through `resolveOwnedWorktree` (non-strict, host
//! paths). Unlike the exact `worktrees::owns`/`placement` used by every other prototype route, a
//! subfolder of an owned checkout is admitted, including one that does not exist yet:
//! - the opened folder through any alias is the root;
//! - a physical target outside the opened folder must share its Git common directory
//!   (`sharesGitCommonDirectory`), so links and junctions to foreign folders are refused;
//! - the (virtual) target is then owned by the deepest live checkout whose project folder
//!   contains it (`resolveOwnedWorktreePath`), with one fresh inventory read on a miss.
//! Every location also stays under the authorized scope (`App::scope`). WSL is not ported.

use crate::{App, Workspace};
use std::path::{Path, PathBuf};

pub struct Owned {
    /// The service directory (`location.directory`).
    pub directory: String,
    /// The checkout the deletion fence identifies it by.
    pub checkout: PathBuf,
}

pub(crate) struct DirectoryProof {
    tree: Option<super::inventory::Tree>,
    source: Option<super::inventory::Tree>,
}

impl DirectoryProof {
    pub(crate) fn live(&self, physical: &Path) -> bool {
        self.source.as_ref().is_none_or(|source| source.contains_live(&source.path))
            && self.tree.as_ref().is_none_or(|tree| {
                tree.contains_live(physical)
                    && (self.source.is_none()
                        || physical.ancestors().take_while(|ancestor| *ancestor != tree.registered()).all(|ancestor| {
                            std::fs::symlink_metadata(ancestor.join(".git"))
                                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                        }))
            })
    }
}

/// Capture the checkout that authorizes an existing folder, for a final
/// synchronous check alongside the folder's own identity.
pub(crate) async fn capture_directory(app: &App, workspace: &Workspace, physical: &Path) -> Option<DirectoryProof> {
    if !physical.starts_with(&app.scope) {
        return None;
    }
    let external = !physical.starts_with(&workspace.path);
    if physical == workspace.path || !external && matches!(super::root_only(workspace).await, Ok(Some(true))) {
        return Some(DirectoryProof { tree: None, source: None });
    }
    if external && !shares_common_directory(&workspace.path, physical).await.ok()? {
        return None;
    }
    let catalogue = super::linked::catalogue(app, workspace, false).await.ok()?;
    let source = if external { Some(catalogue.get("root").ok()?.clone()) } else { None };
    let tree = catalogue
        .trees
        .into_iter()
        .filter(|tree| tree.contains_live(physical))
        .max_by_key(|tree| tree.path.as_os_str().len())?;
    let proof = DirectoryProof { tree: Some(tree), source };
    proof.live(physical).then_some(proof)
}

/// `resolveDirectoryPath`: the real path, or the real nearest ancestor joined with the
/// missing components; `None` when an existing entry cannot be resolved.
pub fn resolve_directory(directory: &str) -> Option<PathBuf> {
    let trimmed = crate::shared::js_trim(directory);
    if trimmed.is_empty() {
        return None;
    }
    let style = crate::files::node_path::Style::host();
    let absolute = if style.is_absolute(&trimmed) {
        style.normalize(&trimmed)
    } else {
        style.join(&std::env::current_dir().ok()?.to_string_lossy(), &trimmed)
    };
    let mut current = PathBuf::from(absolute);
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match dunce::canonicalize(&current) {
            Ok(real) => return Some(missing.iter().rev().fold(real, |p, c| p.join(c))),
            Err(_) => {
                if std::fs::symlink_metadata(&current).is_ok()
                    || std::fs::symlink_metadata(&current).err()?.kind() != std::io::ErrorKind::NotFound
                {
                    return None;
                }
                missing.push(current.file_name()?.to_owned());
                current = current.parent()?.to_path_buf();
            }
        }
    }
}
/// `isPathWithinWorktree` (host paths).
pub fn within(root: &Path, candidate: &Path) -> bool {
    let style = crate::files::node_path::Style::host();
    let relative = style.relative(&root.to_string_lossy(), &candidate.to_string_lossy());
    relative.is_empty()
        || relative != ".."
            && !relative.starts_with(&format!("..{}", std::path::MAIN_SEPARATOR))
            && !style.is_absolute(&relative)
}
/// `readGitCommonDirectory`: the canonical Git common directory, `None` when unreadable.
pub async fn common_directory(dir: &Path) -> Option<PathBuf> {
    read_common_directory(dir).await.ok().flatten()
}

async fn read_common_directory(dir: &Path) -> Result<Option<PathBuf>, ()> {
    let out = crate::git::run(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"], 16 * 1024)
        .await
        .map_err(|_| ())?;
    if out.not_a_repository() {
        return Ok(None);
    }
    let out = out.ok().map_err(|_| ())?;
    dunce::canonicalize(out.text().trim()).map(Some).map_err(|_| ())
}
async fn shares_common_directory(left: &Path, right: &Path) -> Result<bool, ()> {
    let (a, b) = tokio::join!(read_common_directory(left), read_common_directory(right));
    let (a, b) = (a?, b?);
    Ok(a.is_some() && a == b)
}
async fn repository_root(root: &Path) -> PathBuf {
    match crate::git::run(root, &["rev-parse", "--show-toplevel"], 16 * 1024).await.ok().and_then(|o| o.ok().ok()) {
        Some(o) => dunce::canonicalize(o.text().trim()).unwrap_or_else(|_| root.to_path_buf()),
        None => root.to_path_buf(),
    }
}

pub async fn resolve(app: &App, w: &Workspace, directory: &str) -> Option<Owned> {
    resolve_checked(app, w, directory, false).await.ok().flatten()
}

/// In strict discovery, distinguish a confirmed non-owner from an unreadable checkout.
pub async fn resolve_checked(app: &App, w: &Workspace, directory: &str, strict: bool) -> Result<Option<Owned>, ()> {
    let root = &w.path;
    if !crate::files::paths::under(&app.scope, Path::new(directory)) {
        return Ok(None);
    }
    let target = match dunce::canonicalize(directory) {
        Ok(path) => Some(path),
        Err(error) if strict && error.kind() != std::io::ErrorKind::NotFound => return Err(()),
        Err(_) => None,
    };
    if target.as_ref().is_some_and(|path| !path.starts_with(&app.scope)) {
        return Ok(None);
    }
    if target.as_deref() == Some(root.as_path()) {
        return Ok(Some(Owned {
            directory: root.to_string_lossy().into_owned(),
            checkout: repository_root(root).await,
        }));
    }
    if let Some(t) = &target
        && !within(root, t)
        && !shares_common_directory(root, t).await?
    {
        return Ok(None);
    }
    let resolved = resolve_directory(directory).ok_or(())?;
    if !resolved.starts_with(&app.scope) {
        return Ok(None);
    }
    for fresh in [false, true] {
        // A non-Git folder has no inventory: only the opened folder itself is owned.
        let catalogue = match crate::worktrees::linked::catalogue(app, w, fresh).await {
            Ok(catalogue) => catalogue,
            Err(_) if strict && matches!(read_common_directory(root).await, Ok(None)) => return Ok(None),
            Err(_) => return Err(()),
        };
        let owner =
            catalogue.trees.iter().filter(|t| t.contains_live(&resolved)).max_by_key(|t| t.path.as_os_str().len());
        if let Some(tree) = owner {
            return Ok(Some(Owned {
                directory: resolved.to_string_lossy().into_owned(),
                checkout: tree.registered().to_path_buf(),
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_components_resolve_under_their_real_ancestor() {
        let base = dunce::canonicalize(std::env::temp_dir()).unwrap();
        let virtual_path = base.join("depth-owner-missing").join("a").join("b");
        let _ = std::fs::remove_dir_all(base.join("depth-owner-missing"));
        assert_eq!(resolve_directory(&virtual_path.to_string_lossy()), Some(virtual_path.clone()));
        assert_eq!(resolve_directory(&format!("  {}  ", base.to_string_lossy())), Some(base.clone()));
        assert_eq!(resolve_directory("   "), None);
        assert!(within(&base, &virtual_path) && within(&base, &base) && !within(&virtual_path, &base));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_junction_to_a_foreign_folder_shares_no_common_directory() {
        let base = crate::shared::test_dir("depth-owner");
        let (repo, foreign) = (base.join("repo"), base.join("foreign"));
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&foreign).unwrap();
        let init = crate::git::run(&repo, &["init", "--quiet"], 4096).await.unwrap();
        assert_eq!(init.code, 0);
        let link = repo.join("link");
        let made =
            std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&foreign).output().unwrap();
        assert!(made.status.success());
        let real = dunce::canonicalize(&link).unwrap();
        assert_eq!(real, foreign);
        assert!(!within(&repo, &real));
        assert_eq!(shares_common_directory(&repo, &real).await, Ok(false));
        assert_eq!(shares_common_directory(&repo, &repo).await, Ok(true));
        std::fs::write(foreign.join(".git"), "gitdir: missing").unwrap();
        assert_eq!(shares_common_directory(&repo, &real).await, Err(()));
        std::fs::remove_dir(&link).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }
}
