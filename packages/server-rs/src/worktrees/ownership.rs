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
    external: bool,
}

impl DirectoryProof {
    pub(crate) fn same_checkout(&self, other: &Self) -> bool {
        self.tree.as_ref().map(super::inventory::Tree::registered)
            == other.tree.as_ref().map(super::inventory::Tree::registered)
    }

    pub(crate) fn live(&self, physical: &Path) -> bool {
        self.live_at(physical, None, false)
    }

    pub(crate) fn history_live(&self, workspace: &Path, physical: &Path) -> bool {
        self.live_at(physical, Some(workspace), false)
    }

    fn live_at(&self, physical: &Path, history_root: Option<&Path>, receipt: bool) -> bool {
        let no_nested_git = |path: &Path, root: &Path| {
            let absent = |path: &Path| {
                std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            };
            let no_repository = |path: &Path| {
                (absent(&path.join("commondir")) && (absent(&path.join("objects")) || absent(&path.join("refs"))))
                    || head_cannot_name_repository(&path.join("HEAD"))
            };
            within(root, path)
                && path.ancestors().take_while(|ancestor| !within(ancestor, root)).all(|ancestor| {
                    let marker = ancestor.join(".git");
                    let marker_clear = match std::fs::symlink_metadata(&marker) {
                        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
                        // Git skips incomplete layouts. The external target's
                        // Git common directory is also checked at admission.
                        Ok(meta) if meta.is_dir() => no_repository(&marker),
                        _ => false,
                    };
                    marker_clear && no_repository(ancestor)
                })
        };
        self.source
            .as_ref()
            .is_none_or(|source| source.contains_live(&source.path) && no_nested_git(&source.path, source.registered()))
            && match &self.tree {
                Some(tree) => {
                    (if receipt { tree.contains_receipt_location(physical) } else { tree.contains_live(physical) })
                        && (!(self.external || history_root.is_some()) || no_nested_git(physical, tree.registered()))
                }
                None => history_root.is_none_or(|root| no_nested_git(physical, root)),
            }
    }
}

pub(crate) struct ReceiptLocation {
    proof: DirectoryProof,
    directory: String,
    path: PathBuf,
    anchor: PathBuf,
    identity: same_file::Handle,
    inventory: Option<(u64, String)>,
}

impl ReceiptLocation {
    pub(crate) fn live(&self, app: &App, workspace: &Workspace) -> bool {
        resolve_directory(&self.directory).as_ref() == Some(&self.path)
            && existing_directory(&self.path) == Some(self.anchor.as_path())
            && same_file::Handle::from_path(&self.anchor).is_ok_and(|handle| handle == self.identity)
            && self.proof.live_at(&self.path, self.proof.external.then_some(workspace.path.as_path()), true)
            && self
                .inventory
                .as_ref()
                .is_none_or(|(at, project)| app.linked_events.lock().unwrap().valid(*at, Some(project)))
    }
}

pub(crate) async fn receipt_location(
    app: &crate::Shared,
    w: &Workspace,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    directory: &str,
) -> Option<ReceiptLocation> {
    if !crate::files::paths::local_absolute(directory) {
        return None;
    }
    let path = resolve_directory(directory)?;
    let anchor = existing_directory(&path)?.to_owned();
    let identity = same_file::Handle::from_path(&anchor).ok()?;
    let external = !within(&w.path, &path);
    let mut revision = None;
    let proof = if path == w.path {
        DirectoryProof { tree: None, source: None, external }
    } else {
        let stamp = app.linked_events.lock().unwrap().stamp();
        match super::inventory::receipt_catalogue(app, w, endpoint).await {
            Some(inventory) => {
                revision = Some((stamp, inventory.project.clone()));
                registered_proof(&inventory, &path, external)?
            }
            None if !external && matches!(super::root_only(w).await, Ok(Some(true))) => {
                DirectoryProof { tree: None, source: None, external }
            }
            None => return None,
        }
    };
    let result = ReceiptLocation { proof, directory: directory.into(), path, anchor, identity, inventory: revision };
    result.live(app, w).then_some(result)
}

pub(super) fn registered_proof(
    inventory: &super::inventory::Catalogue,
    path: &Path,
    external: bool,
) -> Option<DirectoryProof> {
    let root = inventory.get("root").ok()?;
    let tree = inventory
        .trees
        .iter()
        .filter(|tree| tree.contains_receipt_location(path))
        .max_by_key(|tree| tree.path.as_os_str().len())?;
    let source = (tree.registered() != root.registered()).then(|| root.clone());
    Some(DirectoryProof { tree: Some(tree.clone()), source, external })
}

pub(super) fn existing_directory(path: &Path) -> Option<&Path> {
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => return metadata.is_dir().then_some(ancestor),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return None,
        }
    }
    None
}

fn head_cannot_name_repository(path: &Path) -> bool {
    use std::io::{ErrorKind, Read};
    match std::fs::symlink_metadata(path) {
        Err(error) => error.kind() == ErrorKind::NotFound,
        Ok(meta) if meta.is_dir() => true,
        // Keep links and ambiguous reads closed; Git resolves the external
        // target's actual common directory during the asynchronous admission.
        Ok(meta) if meta.is_file() && meta.len() <= 4096 => {
            let mut head = Vec::new();
            std::fs::File::open(path).and_then(|file| file.take(4097).read_to_end(&mut head)).is_ok()
                && head.len() <= 4096
                && !head.strip_prefix(b"ref:").is_some_and(|target| target.trim_ascii_start().starts_with(b"refs/"))
                && !head.get(..40).is_some_and(|oid| oid.iter().all(u8::is_ascii_hexdigit))
        }
        _ => false,
    }
}

/// Capture the checkout that authorizes an existing folder, for a final
/// synchronous check alongside the folder's own identity.
pub(crate) async fn capture_directory(app: &App, workspace: &Workspace, physical: &Path) -> Option<DirectoryProof> {
    capture_directory_with_refresh(app, workspace, physical, false).await
}

pub(crate) async fn capture_directory_with_refresh(
    app: &App,
    workspace: &Workspace,
    physical: &Path,
    refresh_on_miss: bool,
) -> Option<DirectoryProof> {
    if !physical.starts_with(&app.scope) || !physical.is_dir() {
        return None;
    }
    let external = !physical.starts_with(&workspace.path);
    if physical == workspace.path || !external && matches!(super::root_only(workspace).await, Ok(Some(true))) {
        return Some(DirectoryProof { tree: None, source: None, external });
    }
    if external && !shares_common_directory(&workspace.path, physical).await.ok()? {
        return None;
    }
    for &refresh in if refresh_on_miss { &[false, true][..] } else { &[false] } {
        let catalogue = super::linked::catalogue(app, workspace, refresh).await.ok()?;
        if let Some(proof) = catalogue_proof(&catalogue, physical, external) {
            return proof.live(physical).then_some(proof);
        }
    }
    None
}

fn catalogue_proof(catalogue: &super::inventory::Catalogue, path: &Path, external: bool) -> Option<DirectoryProof> {
    let root = catalogue.get("root").ok()?;
    let tree = catalogue
        .trees
        .iter()
        .filter(|tree| tree.contains_live(path))
        .max_by_key(|tree| tree.path.as_os_str().len())?;
    let source = (external || tree.registered() != root.registered()).then(|| root.clone());
    Some(DirectoryProof { tree: Some(tree.clone()), source, external })
}

pub(crate) struct LoadedOwnership {
    inventory: Option<std::sync::Arc<super::inventory::Catalogue>>,
    directory_only: bool,
    revision: u64,
}

impl LoadedOwnership {
    pub(crate) async fn load(
        app: &crate::Shared,
        w: &Workspace,
        endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    ) -> Self {
        let revision = app.linked_events.lock().unwrap().stamp();
        let inventory = super::inventory::receipt_catalogue(app, w, endpoint).await;
        let directory_only = inventory.is_none() && matches!(super::root_only(w).await, Ok(Some(true)));
        Self { inventory, directory_only, revision }
    }

    pub(crate) fn opened_only(app: &App) -> Self {
        Self { inventory: None, directory_only: false, revision: app.linked_events.lock().unwrap().stamp() }
    }

    pub(crate) fn cached(
        app: &App,
        workspace: &Workspace,
        endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    ) -> Self {
        let cache = app.linked_events.lock().unwrap();
        Self { inventory: cache.cached(workspace.id, endpoint), directory_only: false, revision: cache.stamp() }
    }

    pub(crate) fn complete(&self) -> bool {
        self.inventory.is_some() || self.directory_only
    }

    pub(crate) fn valid(&self, app: &App) -> bool {
        app.linked_events.lock().unwrap().valid(self.revision, self.inventory.as_ref().map(|c| c.project.as_str()))
    }

    pub(crate) fn owns(&self, app: &App, w: &Workspace, directory: &str) -> bool {
        if !crate::files::paths::local_absolute(directory) {
            return false;
        }
        let Some(path) = resolve_directory(directory) else { return false };
        if existing_directory(&path).is_none() {
            return false;
        }
        let external = !within(&w.path, &path);
        if path == w.path || !external && self.directory_only {
            return true;
        }
        self.inventory
            .as_ref()
            .and_then(|inventory| registered_proof(inventory, &path, external))
            .is_some_and(|proof| proof.live_at(&path, None, true))
            && self.valid(app)
    }
}

pub(crate) async fn owns_loaded(
    app: &crate::Shared,
    w: &Workspace,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    directory: &str,
) -> bool {
    LoadedOwnership::load(app, w, endpoint).await.owns(app, w, directory) && app.native.current(endpoint)
}

/// Request-local validated checkout inventory for history fan-out and provenance.
pub(crate) struct HistoryInventory(Option<super::inventory::Catalogue>);

impl HistoryInventory {
    pub(crate) async fn load(app: &App, workspace: &Workspace) -> Option<Self> {
        if super::root_only(workspace).await.ok()?.is_some() {
            return Some(Self(None));
        }
        Some(Self(Some(super::linked::catalogue(app, workspace, false).await.ok()?)))
    }

    pub(crate) fn directories(&self) -> impl Iterator<Item = &str> {
        self.0
            .iter()
            .flat_map(|inventory| &inventory.trees)
            .filter(|tree| !tree.nested_missing)
            .map(|tree| tree.service.as_str())
    }

    pub(crate) fn prove(&self, workspace: &Path, path: &Path) -> Option<DirectoryProof> {
        let external = !path.starts_with(workspace);
        let proof = match &self.0 {
            Some(inventory) => catalogue_proof(inventory, path, external)?,
            None if !external => DirectoryProof { tree: None, source: None, external },
            None => return None,
        };
        proof.history_live(workspace, path).then_some(proof)
    }
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
