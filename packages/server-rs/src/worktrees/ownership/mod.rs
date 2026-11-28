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
mod git_discovery;
mod media_path;
#[cfg(test)]
mod tests;

pub(in crate::worktrees) use git_discovery::valid_git_admin;
pub use git_discovery::{common_directory, resolve_directory, within};
use git_discovery::{
    head_cannot_name_repository, repository_root, shares_common_directory, shares_common_directory_strict,
    strict_common_directory,
};
pub(crate) use media_path::{
    catalogue_owns_event, directory_anchor, media_directory, media_directory_with_slot, resolve_media_path,
    resolve_media_path_checked,
};

use crate::{App, Workspace};
use std::path::{Path, PathBuf};
pub struct Owned {
    /// The service directory (`location.directory`).
    pub directory: String,
    /// The checkout the deletion fence identifies it by.
    pub checkout: PathBuf,
}

#[derive(Clone)]
pub(crate) struct DirectoryProof {
    tree: Option<super::inventory::Tree>,
    source: Option<super::inventory::Tree>,
    root: Option<(PathBuf, String)>,
    external: bool,
    media: bool,
}

impl DirectoryProof {
    pub(crate) fn same_checkout(&self, other: &Self) -> bool {
        match (&self.tree, &other.tree) {
            (Some(a), Some(b)) => a.same_physical_checkout(b),
            (None, None) => self.root == other.root,
            _ => false,
        }
    }

    pub(crate) fn live(&self, physical: &Path) -> bool {
        self.live_at(physical, None, false)
    }

    pub(crate) fn root_direct() -> Self {
        Self { tree: None, source: None, root: None, external: false, media: false }
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
            path.starts_with(root)
                && path.ancestors().take_while(|ancestor| *ancestor != root && ancestor.starts_with(root)).all(
                    |ancestor| {
                        let marker = ancestor.join(".git");
                        let marker_clear = match std::fs::symlink_metadata(&marker) {
                            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
                            // Git skips incomplete layouts. The external target's
                            // Git common directory is also checked at admission.
                            Ok(meta) if meta.is_dir() => no_repository(&marker),
                            _ => false,
                        };
                        marker_clear && no_repository(ancestor)
                    },
                )
        };
        self.source
            .as_ref()
            .is_none_or(|source| source.contains_live(&source.path) && no_nested_git(&source.path, source.registered()))
            && match &self.tree {
                Some(tree) => {
                    // A checkout of another repository nested inside the opened folder (`!external`)
                    // is intentionally owned under the root's identity per TS `manager.test.ts:225`.
                    // `no_nested_git` applies to external targets and history provenance.
                    (if receipt {
                        tree.contains_receipt_location(physical)
                    } else if self.media {
                        tree.contains_media(physical)
                    } else if history_root.is_some() {
                        tree.contains_history(physical)
                    } else {
                        tree.contains_live(physical)
                    }) && (!(self.external || history_root.is_some()) || no_nested_git(physical, tree.target_root()))
                }
                None => {
                    self.root.as_ref().is_none_or(|(root, id)| {
                        dunce::canonicalize(root).ok().as_deref() == Some(root.as_path())
                            && crate::files::directory_identity(root).ok().as_deref() == Some(id.as_str())
                            && physical.starts_with(root)
                    }) && (self.media || history_root.is_none_or(|root| no_nested_git(physical, root)))
                }
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
        DirectoryProof { tree: None, source: None, root: None, external, media: false }
    } else {
        let stamp = app.linked_events.lock().unwrap().stamp();
        match super::inventory::receipt_catalogue(app, w, endpoint).await {
            Some(inventory) => {
                revision = Some((stamp, inventory.project.clone()));
                registered_proof(&inventory, &path, external)?
            }
            None if !external && matches!(super::root_only(w).await, Ok(Some(true))) => {
                DirectoryProof { tree: None, source: None, root: None, external, media: false }
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
    Some(DirectoryProof { tree: Some(tree.clone()), source, root: None, external, media: false })
}

pub(crate) fn existing_directory(path: &Path) -> Option<&Path> {
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => return metadata.is_dir().then_some(ancestor),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return None,
        }
    }
    None
}

/// Capture the checkout that authorizes an existing folder on the SSE event path using only the
/// isolated registered-only SSE inventory cache (never triggering HTTP `worktree.refresh` or
/// acquiring a new daemon connection, matching TS `manager.ts:485-503`).
pub(crate) async fn capture_event_directory(
    app: &crate::Shared,
    workspace: &Workspace,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    physical: &Path,
) -> Option<DirectoryProof> {
    if !physical.starts_with(&app.scope) || !physical.is_dir() {
        return None;
    }
    let external = !physical.starts_with(&workspace.path);
    if physical == workspace.path || !external && matches!(super::root_only(workspace).await, Ok(Some(true))) {
        return Some(DirectoryProof { tree: None, source: None, root: None, external, media: false });
    }
    if external && !shares_common_directory(&workspace.path, physical).await.ok()? {
        return None;
    }
    let catalogue = super::inventory::receipt_catalogue(app, workspace, endpoint).await?;
    let opened = workspace.path.clone();
    let physical_owned = physical.to_path_buf();
    tokio::task::spawn_blocking(move || {
        if !catalogue.root_live_for(&opened) {
            return None;
        }
        let proof = catalogue_proof(&catalogue, &physical_owned, external, ProofMode::Live)?;
        proof.live(&physical_owned).then_some(proof)
    })
    .await
    .ok()
    .flatten()
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
        return Some(DirectoryProof { tree: None, source: None, root: None, external, media: false });
    }
    if external && !shares_common_directory(&workspace.path, physical).await.ok()? {
        return None;
    }
    let Ok(hit) = super::linked::http_read(app, workspace, super::linked::ReadMode::Validated).await else {
        return None;
    };
    let catalogue = hit.snapshot.catalogue()?;
    let (proof, root_live) = {
        let cat = std::sync::Arc::clone(&catalogue);
        let opened = workspace.path.clone();
        let phys = physical.to_path_buf();
        let check_root = hit.from_cache;
        tokio::task::spawn_blocking(move || {
            let root_live = !check_root || cat.root_live_for(&opened);
            let proof = if root_live {
                catalogue_proof(&cat, &phys, external, ProofMode::Live).filter(|p| p.live(&phys))
            } else {
                None
            };
            (proof, root_live)
        })
        .await
        .unwrap_or((None, false))
    };
    if proof.is_some() {
        return proof;
    }
    if hit.from_cache && (!root_live || (refresh_on_miss && !hit.refreshed_on_miss)) {
        let mode = if root_live {
            super::linked::ReadMode::RefreshOnMiss(hit.generation)
        } else {
            super::linked::ReadMode::Fresh
        };
        let Ok(refreshed) = super::linked::http_read(app, workspace, mode).await else { return None };
        let catalogue = refreshed.snapshot.catalogue()?;
        let phys = physical.to_path_buf();
        return tokio::task::spawn_blocking(move || {
            catalogue_proof(&catalogue, &phys, external, ProofMode::Live).filter(|p| p.live(&phys))
        })
        .await
        .ok()
        .flatten();
    }
    None
}

#[derive(Clone, Copy)]
enum ProofMode {
    Live,
    Media,
    History,
}

fn catalogue_proof(
    catalogue: &super::inventory::Catalogue,
    path: &Path,
    external: bool,
    mode: ProofMode,
) -> Option<DirectoryProof> {
    let root = catalogue.get("root").ok()?;
    let tree = catalogue
        .trees
        .iter()
        .filter(|tree| match mode {
            ProofMode::Live => tree.contains_live(path),
            ProofMode::Media => tree.contains_media(path),
            ProofMode::History => tree.contains_history(path),
        })
        .max_by_key(|tree| match mode {
            ProofMode::Live => tree.path.as_os_str().len(),
            ProofMode::Media | ProofMode::History => tree.media_path_len(),
        })?;
    let source = (external || tree.registered() != root.registered()).then(|| root.clone());
    Some(DirectoryProof {
        tree: Some(tree.clone()),
        source,
        root: None,
        external,
        media: matches!(mode, ProofMode::Media),
    })
}

fn reject_network_path(raw: &str, path: &Path) -> Result<(), ()> {
    if raw.starts_with("\\\\") || raw.starts_with("//") || raw.starts_with(r"\??\") {
        return Err(());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if let Some(Component::Prefix(prefix)) = path.components().next()
            && matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(..))
        {
            return Err(());
        }
    }
    let _ = path;
    Ok(())
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
pub(crate) struct HistoryInventory {
    catalogue: Option<std::sync::Arc<super::inventory::Catalogue>>,
    allow_subfolders: bool,
}

impl HistoryInventory {
    pub(crate) async fn load(
        app: &crate::Shared,
        workspace: &Workspace,
        endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    ) -> Option<Self> {
        if let Some(allow_subfolders) = super::root_only(workspace).await.ok()? {
            return Some(Self { catalogue: None, allow_subfolders });
        }
        Some(Self {
            // Reuse the shared 10-second validated inventory cache (TS `worktree-inventory.ts:13-93`)
            // which refreshes native worktree registrations on cold/invalidated loads.
            catalogue: Some(super::inventory::history_catalogue(app, workspace, endpoint).await?),
            allow_subfolders: true,
        })
    }

    pub(crate) fn directories(&self) -> impl Iterator<Item = &str> {
        self.catalogue.iter().flat_map(|inventory| &inventory.trees).map(|tree| tree.service.as_str())
    }

    pub(crate) fn prove(&self, workspace: &Path, path: &Path) -> Option<DirectoryProof> {
        let external = !path.starts_with(workspace);
        let proof = match &self.catalogue {
            Some(inventory) => catalogue_proof(inventory, path, external, ProofMode::History)?,
            None if !external && (path == workspace || self.allow_subfolders) => {
                DirectoryProof { tree: None, source: None, root: None, external, media: false }
            }
            None => return None,
        };
        proof.history_live(workspace, path).then_some(proof)
    }
}

pub async fn resolve(app: &App, w: &Workspace, directory: &str) -> Option<Owned> {
    resolve_checked(app, w, directory, false).await.ok().flatten()
}

/// Admits a subfolder under a non-Git workspace root only while the opened root's physical path
/// is unchanged (`inventory::probe_root_checkout`), never following a redirected root symlink.
async fn admit_non_git(root: &Path, resolved: &Path, target_exists: bool, strict: bool) -> Result<Option<Owned>, ()> {
    let root_owned = root.to_path_buf();
    let live = tokio::task::spawn_blocking(move || dunce::canonicalize(&root_owned).ok().as_ref() == Some(&root_owned))
        .await
        .unwrap_or(false);
    if !live {
        return Err(());
    }
    if strict && !matches!(strict_common_directory(root).await, Ok(None)) {
        return Err(());
    }
    if (!strict || target_exists) && within(root, resolved) {
        return Ok(Some(Owned { directory: resolved.to_string_lossy().into_owned(), checkout: root.to_path_buf() }));
    }
    Ok(None)
}

/// In strict discovery, distinguish a confirmed non-owner from an unreadable checkout.
pub async fn resolve_checked(app: &App, w: &Workspace, directory: &str, strict: bool) -> Result<Option<Owned>, ()> {
    let root = &w.path;
    if !crate::files::paths::local_absolute(directory) {
        return Ok(None);
    }
    let target = match dunce::canonicalize(directory) {
        Ok(path) => Some(path),
        Err(error) if strict && error.kind() != std::io::ErrorKind::NotFound => {
            return if crate::files::paths::under(&app.scope, Path::new(directory)) { Err(()) } else { Ok(None) };
        }
        Err(_) => None,
    };
    if target.as_ref().is_some_and(|path| !crate::files::paths::under(&app.scope, path)) {
        return Ok(None);
    }
    if target.as_deref() == Some(root.as_path()) {
        return Ok(Some(Owned {
            directory: root.to_string_lossy().into_owned(),
            checkout: repository_root(root).await,
        }));
    }
    if let Some(t) = &target
        && !t.starts_with(root)
    {
        let shared = if strict {
            shares_common_directory_strict(root, t).await?
        } else {
            shares_common_directory(root, t).await?
        };
        if !shared {
            return Ok(None);
        }
    }
    let resolved = resolve_directory(directory).ok_or(())?;
    if !crate::files::paths::under(&app.scope, &resolved) {
        return Ok(None);
    }
    let hit = match crate::worktrees::linked::http_read(app, w, crate::worktrees::linked::ReadMode::Validated).await {
        Ok(hit) => hit,
        Err(_) if strict && matches!(strict_common_directory(root).await, Ok(None)) => return Ok(None),
        Err(_) => return Err(()),
    };
    let catalogue = match hit.snapshot {
        crate::worktrees::linked::HttpSnapshot::Git(catalogue) => catalogue,
        // `MissingGit` (`directoryOnly`) is never a strict absence verdict (TS `worktree-directory.ts:233`).
        crate::worktrees::linked::HttpSnapshot::MissingGit => return Err(()),
        // `NonGit`: Git is installed and the workspace root is not a repository, so subfolders
        // inside the workspace root are owned (`native-worktrees.ts:66`, `worktree-directory.ts:230`).
        // Verify the opened root's physical path is unchanged before admitting `resolved`.
        crate::worktrees::linked::HttpSnapshot::NonGit => {
            return admit_non_git(root, &resolved, target.is_some(), strict).await;
        }
    };
    let (owner, root_live) = {
        let cat = std::sync::Arc::clone(&catalogue);
        let opened = root.clone();
        let res_owned = resolved.clone();
        let check_root = hit.from_cache;
        tokio::task::spawn_blocking(move || {
            let live = !check_root || cat.root_live_for(&opened);
            let owner = if live {
                cat.trees
                    .iter()
                    .filter(|t| t.contains_live(&res_owned))
                    .max_by_key(|t| t.path.as_os_str().len())
                    .map(|t| t.registered().to_path_buf())
            } else {
                None
            };
            (owner, live)
        })
        .await
        .unwrap_or((None, false))
    };
    if let Some(checkout) = owner {
        return Ok(Some(Owned { directory: resolved.to_string_lossy().into_owned(), checkout }));
    }
    if hit.from_cache && (!root_live || !hit.refreshed_on_miss) {
        let retry_mode = if root_live {
            crate::worktrees::linked::ReadMode::RefreshOnMiss(hit.generation)
        } else {
            crate::worktrees::linked::ReadMode::Fresh
        };
        let refreshed = match crate::worktrees::linked::http_read(app, w, retry_mode).await {
            Ok(hit) => hit,
            Err(_) if strict && matches!(strict_common_directory(root).await, Ok(None)) => return Ok(None),
            Err(_) => return Err(()),
        };
        let catalogue = match refreshed.snapshot {
            crate::worktrees::linked::HttpSnapshot::Git(catalogue) => catalogue,
            crate::worktrees::linked::HttpSnapshot::MissingGit => return Err(()),
            crate::worktrees::linked::HttpSnapshot::NonGit => {
                return admit_non_git(root, &resolved, target.is_some(), strict).await;
            }
        };
        let res_owned = resolved.clone();
        let owner = tokio::task::spawn_blocking(move || {
            catalogue
                .trees
                .iter()
                .filter(|t| t.contains_live(&res_owned))
                .max_by_key(|t| t.path.as_os_str().len())
                .map(|t| t.registered().to_path_buf())
        })
        .await
        .unwrap_or(None);
        if let Some(checkout) = owner {
            return Ok(Some(Owned { directory: resolved.to_string_lossy().into_owned(), checkout }));
        }
    }
    Ok(None)
}
