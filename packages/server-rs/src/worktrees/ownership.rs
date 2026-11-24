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
            let mut opts = std::fs::OpenOptions::new();
            opts.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.custom_flags(libc::O_NONBLOCK);
            }
            let Ok(file) = opts.open(path) else { return false };
            if !file.metadata().is_ok_and(|m| m.is_file() && m.len() <= 4096) {
                return false;
            }
            let mut head = Vec::new();
            file.take(4097).read_to_end(&mut head).is_ok()
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
        return Some(DirectoryProof { tree: None, source: None, root: None, external, media: false });
    }
    if external && !shares_common_directory(&workspace.path, physical).await.ok()? {
        return None;
    }
    for &refresh in if refresh_on_miss { &[false, true][..] } else { &[false] } {
        let catalogue = super::linked::catalogue(app, workspace, refresh).await.ok()?;
        if let Some(proof) = catalogue_proof(&catalogue, physical, external, ProofMode::Live) {
            return proof.live(physical).then_some(proof);
        }
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

fn component_eq(a: std::path::Component<'_>, b: std::path::Component<'_>) -> bool {
    #[cfg(windows)]
    {
        a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

#[cfg(windows)]
fn path_starts_with_scope(scope: &Path, candidate: &Path) -> bool {
    let mut parts = candidate.components();
    scope.components().all(|s| parts.next().is_some_and(|c| component_eq(s, c)))
}

#[cfg(windows)]
fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ').to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
    };
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") || numbered("COM") || numbered("LPT")
}

/// A missing child is owned through its nearest existing directory, never
/// through a file or an unresolved link. I/O failures stay indeterminate (`Err`).
pub(crate) fn directory_anchor(path: &Path) -> Result<Option<&Path>, ()> {
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => return Ok(metadata.is_dir().then_some(ancestor)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => return Ok(None),
            Err(_) => return Err(()),
        }
    }
    Ok(None)
}

fn resolve_media_step(
    scope: &Path,
    scope_comps: &[std::path::Component<'_>],
    cur: &mut PathBuf,
    missing: &mut bool,
    hops_left: &mut usize,
    component: std::path::Component<'_>,
) -> Result<Option<()>, ()> {
    use std::path::Component;
    match component {
        Component::Prefix(prefix) => cur.push(prefix.as_os_str()),
        Component::RootDir => cur.push(component.as_os_str()),
        Component::CurDir => {}
        Component::Normal(seg) => {
            #[cfg(windows)]
            if is_windows_device_name(&seg.to_string_lossy()) {
                return Ok(None);
            }
            cur.push(seg);
            if !*missing {
                match std::fs::symlink_metadata(&*cur) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => *missing = true,
                    Err(_) => return Err(()),
                    Ok(_) => {
                        // Follow symlinks/junctions hop-by-hop BEFORE `canonicalize` so a chain of
                        // local links ending in a UNC share or mapped drive outside `scope` never
                        // triggers SMB I/O.
                        if let Ok(target) = std::fs::read_link(&*cur) {
                            let Some(rem) = hops_left.checked_sub(1) else {
                                return Ok(None);
                            };
                            *hops_left = rem;
                            let simplified = dunce::simplified(&target);
                            let target_str = simplified.to_string_lossy();
                            if reject_network_path(&target_str, simplified).is_err() {
                                return Ok(None);
                            }
                            if simplified.is_absolute() {
                                #[cfg(windows)]
                                if !scope_comps.is_empty() && !path_starts_with_scope(scope, simplified) {
                                    return Ok(None);
                                }
                                let mut next = PathBuf::new();
                                let mut t_comps = simplified.components();
                                if !scope_comps.is_empty() {
                                    let mut matched = 0usize;
                                    while matched < scope_comps.len() {
                                        let Some(c) = t_comps.next() else {
                                            return Ok(None);
                                        };
                                        match c {
                                            Component::CurDir => continue,
                                            Component::ParentDir => return Ok(None),
                                            c if component_eq(c, scope_comps[matched]) => {
                                                next.push(c.as_os_str());
                                                matched += 1;
                                            }
                                            _ => return Ok(None),
                                        }
                                    }
                                    match std::fs::symlink_metadata(&next) {
                                        Ok(m) if !m.file_type().is_symlink() && std::fs::read_link(&next).is_err() => {}
                                        Ok(_) => return Ok(None),
                                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                                        Err(_) => return Err(()),
                                    }
                                    let real_root = match dunce::canonicalize(&next) {
                                        Ok(r) => r,
                                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                                        Err(_) => return Err(()),
                                    };
                                    if real_root != scope {
                                        return Ok(None);
                                    }
                                    next = real_root;
                                }
                                let mut next_missing = false;
                                for c in t_comps {
                                    if resolve_media_step(
                                        scope,
                                        scope_comps,
                                        &mut next,
                                        &mut next_missing,
                                        hops_left,
                                        c,
                                    )?
                                    .is_none()
                                    {
                                        return Ok(None);
                                    }
                                }
                                if next_missing {
                                    // A dangling symlink is never treated as a missing subfolder
                                    // (TS `worktree-directory.ts:166-193`).
                                    return Ok(None);
                                }
                                *cur = next;
                                *missing = false;
                                return Ok(Some(()));
                            } else {
                                if !cur.pop() {
                                    return Ok(None);
                                }
                                if !scope_comps.is_empty() && !cur.starts_with(scope) {
                                    return Ok(None);
                                }
                                for c in simplified.components() {
                                    if resolve_media_step(scope, scope_comps, cur, missing, hops_left, c)?.is_none() {
                                        return Ok(None);
                                    }
                                }
                                if *missing {
                                    return Ok(None);
                                }
                                return Ok(Some(()));
                            }
                        }
                        match dunce::canonicalize(&*cur) {
                            Ok(real) => {
                                if reject_network_path(&real.to_string_lossy(), &real).is_err() {
                                    return Ok(None);
                                }
                                if !scope_comps.is_empty() && !real.starts_with(scope) {
                                    return Ok(None);
                                }
                                *cur = real;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => *missing = true,
                            Err(_) => return Err(()),
                        }
                    }
                }
            }
        }
        Component::ParentDir => {
            if !*missing {
                // Reject `file/../dir` (`ENOTDIR`): a non-directory cannot be traversed via `..`.
                match std::fs::symlink_metadata(&*cur) {
                    Ok(m) if m.is_dir() => {}
                    Ok(_) => return Err(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => *missing = true,
                    Err(_) => return Err(()),
                }
            }
            if !scope_comps.is_empty() && *cur == scope {
                return Ok(None);
            }
            if !cur.pop() {
                return Ok(None);
            }
            if !scope_comps.is_empty() && !cur.starts_with(scope) {
                return Ok(None);
            }
            if *missing {
                match dunce::canonicalize(&*cur) {
                    Ok(real) => {
                        if !scope_comps.is_empty() && !real.starts_with(scope) {
                            return Ok(None);
                        }
                        *cur = real;
                        *missing = false;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(()),
                }
            }
        }
    }
    Ok(Some(()))
}

/// Resolves `raw` under `scope` without performing filesystem I/O outside `scope`.
/// Returns `Ok(Some((resolved, anchor)))` when admitted, `Ok(None)` when refused as outside
/// scope/invalid/non-directory, and `Err(())` when an OS I/O error (`PermissionDenied`, etc.)
/// prevents verification.
pub(crate) fn resolve_media_path_checked(scope: &Path, raw: &str) -> Result<Option<(PathBuf, PathBuf)>, ()> {
    use std::path::Component;
    if raw.is_empty() || raw.len() > 32_768 || raw.contains('\0') {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        let b = raw.as_bytes();
        if b.len() < 3
            || !b[0].is_ascii_alphabetic()
            || b[1] != b':'
            || !matches!(b[2], b'\\' | b'/')
            || raw[2..].contains(':')
        {
            return Ok(None);
        }
    }
    #[cfg(not(windows))]
    if !raw.starts_with('/') {
        return Ok(None);
    }
    // Check lexical `scope` prefix BEFORE any filesystem I/O so paths on other drives (including
    // Windows mapped SMB drives) or outside `scope` are rejected with zero filesystem calls.
    // Keep the raw components when canonicalizing the matched prefix so case-sensitive NTFS
    // siblings (`Projet` vs `projet`) are never silently rewritten onto `scope`.
    let scope_comps: Vec<Component<'_>> = scope.components().collect();
    let mut comps = Path::new(raw).components();
    let mut cur = PathBuf::new();
    let mut matched = 0usize;
    while matched < scope_comps.len() {
        let Some(comp) = comps.next() else {
            return Ok(None);
        };
        match comp {
            Component::CurDir => continue,
            Component::ParentDir => return Ok(None),
            comp if component_eq(comp, scope_comps[matched]) => {
                cur.push(comp.as_os_str());
                matched += 1;
            }
            _ => return Ok(None),
        }
    }
    if !scope_comps.is_empty() {
        // Reject a configured `scope` root replaced by a symlink/junction BEFORE `canonicalize`
        // so we never perform filesystem I/O against an external target volume.
        match std::fs::symlink_metadata(&cur) {
            Ok(m) if !m.file_type().is_symlink() && std::fs::read_link(&cur).is_err() => {}
            Ok(_) => return Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        }
        let real_root = match dunce::canonicalize(&cur) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        if real_root != scope {
            return Ok(None);
        }
        cur = real_root;
    }
    // Resolve symlinks component-by-component BEFORE applying `..` so a POSIX path like
    // `/workspace/link_to_foreign/..` resolves through `link_to_foreign` into `/foreign`
    // rather than being lexically collapsed back into `/workspace`.
    let mut missing = false;
    let mut hops_left = 40usize;
    for component in comps {
        if resolve_media_step(scope, &scope_comps, &mut cur, &mut missing, &mut hops_left, component)?.is_none() {
            return Ok(None);
        }
    }
    if !scope_comps.is_empty() && !cur.starts_with(scope) {
        return Ok(None);
    }
    let Some(anchor) = directory_anchor(&cur)?.map(Path::to_path_buf) else {
        return Ok(None);
    };
    Ok(Some((cur, anchor)))
}

pub(crate) fn resolve_media_path(scope: &Path, raw: &str) -> Option<(PathBuf, PathBuf)> {
    resolve_media_path_checked(scope, raw).ok().flatten()
}

async fn proof_live_async(proof: DirectoryProof, path: PathBuf) -> Option<DirectoryProof> {
    tokio::task::spawn_blocking(move || proof.live(&path).then_some(proof)).await.ok()?
}

async fn catalogue_proof_live_async(
    catalogue: std::sync::Arc<super::inventory::Catalogue>,
    path: PathBuf,
    external: bool,
    scope: Option<PathBuf>,
) -> Option<DirectoryProof> {
    tokio::task::spawn_blocking(move || {
        catalogue_proof(&catalogue, &path, external, ProofMode::Media).filter(|proof| {
            scope
                .as_ref()
                .is_none_or(|scope| proof.tree.as_ref().is_none_or(|tree| tree.registered().starts_with(scope)))
                && proof.live(&path)
        })
    })
    .await
    .ok()?
}

pub(crate) async fn catalogue_owns_event(
    catalogue: std::sync::Arc<super::inventory::Catalogue>,
    path: PathBuf,
    external: bool,
) -> bool {
    catalogue_proof_live_async(catalogue, path, external, None).await.is_some()
}

pub(crate) async fn media_directory(
    app: &App,
    workspace: &Workspace,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    path: &Path,
    anchor: &Path,
    strict_media: bool,
) -> Result<Option<DirectoryProof>, crate::Error> {
    use super::{inventory, linked::native_error};
    let current = || app.native.current(endpoint) && app.workspace(&workspace.id.to_string()).is_ok();
    if !current() {
        return Err(native_error());
    }
    if !path.starts_with(&app.scope) {
        return Ok(None);
    }
    let external = !path.starts_with(&workspace.path);
    if path == workspace.path {
        let root_path = workspace.path.clone();
        let Some(root_id) =
            tokio::task::spawn_blocking(move || crate::files::directory_identity(&root_path).ok()).await.ok().flatten()
        else {
            return Ok(None);
        };
        let proof = DirectoryProof {
            tree: None,
            source: None,
            root: Some((workspace.path.clone(), root_id)),
            external,
            media: true,
        };
        return Ok(proof_live_async(proof, path.to_path_buf()).await);
    }
    if !external && let Some(subfolders) = super::root_only(workspace).await? {
        if !current() {
            return Err(native_error());
        }
        if !subfolders {
            return if strict_media { Err(native_error()) } else { Ok(None) };
        }
        if strict_media {
            super::strict_non_git_workspace(workspace).await?;
        }
        let root_path = workspace.path.clone();
        let Some(root_id) =
            tokio::task::spawn_blocking(move || crate::files::directory_identity(&root_path).ok()).await.ok().flatten()
        else {
            return Ok(None);
        };
        let proof = DirectoryProof {
            tree: None,
            source: None,
            root: Some((workspace.path.clone(), root_id)),
            external,
            media: true,
        };
        return Ok(proof_live_async(proof, path.to_path_buf()).await);
    }
    if external && path == anchor {
        let shared = if strict_media {
            shares_common_directory_strict(&workspace.path, anchor).await
        } else {
            shares_common_directory(&workspace.path, anchor).await
        }
        .map_err(|_| native_error())?;
        if !shared {
            if !current() {
                return Err(native_error());
            }
            return Ok(None);
        }
    }
    if !current() {
        return Err(native_error());
    }
    if strict_media {
        // TS `session-media` forces `location -> refresh -> list` under the 30 s media budget.
        let timeout = std::time::Duration::from_secs(30);
        for _ in 0..4 {
            let revision = inventory::revision(app);
            let catalogue = inventory::catalogue_at(app, workspace, true, Some(endpoint), timeout).await?;
            if !current() {
                return Err(native_error());
            }
            let proof =
                catalogue_proof_live_async(std::sync::Arc::new(catalogue), path.to_path_buf(), external, None).await;
            if !current() {
                return Err(native_error());
            }
            if inventory::revision(app) != revision {
                continue;
            }
            return Ok(proof);
        }
        return Err(native_error());
    }
    // Match TS `worktree-inventory.ts:30-42` & `http-server.ts:1394-1408`: reuse a valid,
    // non-invalidated 10-second inventory snapshot before calling `worktree.list` so transient
    // `worktree.list` outages do not break reads while the cache is valid; on a miss, read
    // `refresh = false` first and trigger one `refresh = true` only if the path is still absent.
    let timeout = std::time::Duration::from_secs(12);
    let mut tried_cache = false;
    let mut refresh = false;
    let mut refreshed = false;
    for _ in 0..4 {
        let revision = inventory::revision(app);
        if !tried_cache && !refresh {
            tried_cache = true;
            let cached = app.linked_events.lock().unwrap().cached(workspace.id, endpoint);
            if let Some(catalogue) = cached {
                let proof = catalogue_proof_live_async(catalogue, path.to_path_buf(), external, None).await;
                if !current() {
                    return Err(native_error());
                }
                if inventory::revision(app) != revision {
                    tried_cache = false;
                    continue;
                }
                if proof.is_some() {
                    return Ok(proof);
                }
            }
        }
        let catalogue =
            std::sync::Arc::new(inventory::catalogue_at(app, workspace, refresh, Some(endpoint), timeout).await?);
        if !current() {
            return Err(native_error());
        }
        let proof =
            catalogue_proof_live_async(std::sync::Arc::clone(&catalogue), path.to_path_buf(), external, None).await;
        if !current() {
            return Err(native_error());
        }
        if inventory::revision(app) != revision {
            continue;
        }
        app.linked_events.lock().unwrap().store_if_current(workspace.id, refresh, endpoint, revision, catalogue);
        refreshed |= refresh;
        if proof.is_some() || refreshed {
            return Ok(proof);
        }
        refresh = true;
    }
    Err(native_error())
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

/// `resolveDirectoryPath`: the real path, or the real nearest ancestor joined with the
/// missing components; `None` when an existing entry cannot be resolved.
pub fn resolve_directory(directory: &str) -> Option<PathBuf> {
    let trimmed = crate::shared::js_trim(directory);
    if trimmed.is_empty() {
        return None;
    }
    let raw = trimmed;
    let style = crate::files::node_path::Style::host();
    let absolute = if style.is_absolute(raw) {
        style.normalize(raw)
    } else {
        style.join(&std::env::current_dir().ok()?.to_string_lossy(), raw)
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
    let trimmed = out.text().trim().to_owned();
    tokio::task::spawn_blocking(move || dunce::canonicalize(trimmed).ok()).await.map_err(|_| ())?.map(Some).ok_or(())
}
async fn shares_common_directory(left: &Path, right: &Path) -> Result<bool, ()> {
    let (a, b) = tokio::join!(read_common_directory(left), read_common_directory(right));
    let (a, b) = (a?, b?);
    Ok(a.is_some() && a == b)
}

/// Filesystem-only strict Git discovery mirroring TS `discoverCheckoutCommonDirectory`.
/// Returns `Ok(None)` when absence of a checkout is verified, and `Err(())` on any
/// ambiguous layout (incomplete `.git`, bare/separate markers, or Git env overrides).
fn strict_discover_common_directory(dir: &Path) -> Result<Option<PathBuf>, ()> {
    use std::io::{ErrorKind, Read};
    const DISCOVERY_ENV: &[&str] = &[
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_OBJECT_DIRECTORY",
    ];
    if DISCOVERY_ENV.iter().any(|key| std::env::var_os(key).is_some()) {
        return Err(());
    }
    let read_small = |path: &Path| -> Result<String, ()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.custom_flags(libc::O_NONBLOCK);
        }
        let file = opts.open(path).map_err(|_| ())?;
        let meta = file.metadata().map_err(|_| ())?;
        if !meta.is_file() || meta.len() > 64 * 1024 {
            return Err(());
        }
        let mut buf = Vec::new();
        file.take(64 * 1024 + 1).read_to_end(&mut buf).map_err(|_| ())?;
        if buf.len() > 64 * 1024 {
            return Err(());
        }
        String::from_utf8(buf).map_err(|_| ())
    };
    fn strip_eol(s: &str) -> &str {
        s.strip_suffix('\n').map_or(s, |r| r.strip_suffix('\r').unwrap_or(r))
    }
    let mut current = dunce::canonicalize(dir).map_err(|_| ())?;
    let info = std::fs::metadata(&current).map_err(|_| ())?;
    if !info.is_dir() {
        return Err(());
    }
    #[cfg(unix)]
    let device = {
        use std::os::unix::fs::MetadataExt;
        info.dev()
    };
    let root = loop {
        if current.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(".git")) {
            return Err(());
        }
        match std::fs::symlink_metadata(current.join(".git")) {
            Ok(_) => break current,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
        for entry in ["HEAD", "commondir"] {
            match std::fs::symlink_metadata(current.join(entry)) {
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                _ => return Err(()),
            }
        }
        let Some(parent) = current.parent() else { return Ok(None) };
        if parent == current {
            return Ok(None);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if std::fs::metadata(parent).map_err(|_| ())?.dev() != device {
                return Ok(None);
            }
        }
        current = parent.to_path_buf();
    };
    let entry = root.join(".git");
    let entry_meta = std::fs::symlink_metadata(&entry).map_err(|_| ())?;
    if entry_meta.file_type().is_symlink() {
        let link_target = std::fs::read_link(&entry).map_err(|_| ())?;
        reject_network_path(&link_target.to_string_lossy(), &link_target)?;
    }
    let git_dir = if std::fs::metadata(&entry).map_err(|_| ())?.is_dir() {
        entry
    } else {
        let text = read_small(&entry)?;
        let target = strip_eol(&text).strip_prefix("gitdir: ").ok_or(())?;
        let p = Path::new(target);
        let candidate = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
        reject_network_path(target, &candidate)?;
        candidate
    };
    let common_rel = match std::fs::symlink_metadata(git_dir.join("commondir")) {
        Err(error) if error.kind() == ErrorKind::NotFound => ".".to_owned(),
        Ok(_) => strip_eol(&read_small(&git_dir.join("commondir"))?).to_owned(),
        Err(_) => return Err(()),
    };
    let resolved_git = dunce::canonicalize(&git_dir).map_err(|_| ())?;
    let common_raw =
        if Path::new(&common_rel).is_absolute() { PathBuf::from(&common_rel) } else { git_dir.join(&common_rel) };
    reject_network_path(&common_rel, &common_raw)?;
    let resolved_common = dunce::canonicalize(&common_raw).map_err(|_| ())?;
    if resolved_git != resolved_common {
        let backlink = read_small(&resolved_git.join("gitdir"))?;
        let backlink = strip_eol(&backlink);
        let back_path =
            if Path::new(backlink).is_absolute() { PathBuf::from(backlink) } else { resolved_git.join(backlink) };
        reject_network_path(backlink, &back_path)?;
        let back_parent = back_path.parent().ok_or(())?;
        dunce::canonicalize(back_parent).map_err(|_| ())?;
    }
    std::fs::metadata(resolved_common.join("objects")).map_err(|_| ())?;
    std::fs::metadata(resolved_common.join("refs")).map_err(|_| ())?;
    let head_path = resolved_git.join("HEAD");
    let head_meta = std::fs::symlink_metadata(&head_path).map_err(|_| ())?;
    let valid_head = if head_meta.file_type().is_symlink() {
        let target = std::fs::read_link(&head_path).map_err(|_| ())?;
        target.to_str().is_some_and(|s| !s.contains('\\') && s.starts_with("refs/"))
    } else if head_meta.is_file() && head_meta.len() <= 4096 {
        let content = read_small(&head_path)?;
        let content = strip_eol(&content);
        content.strip_prefix("ref:").is_some_and(|rest| rest.trim_start().starts_with("refs/"))
            || (matches!(content.len(), 40 | 64) && content.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    } else {
        false
    };
    if !valid_head {
        return Err(());
    }
    Ok(Some(resolved_common))
}

async fn shares_common_directory_strict(left: &Path, right: &Path) -> Result<bool, ()> {
    let (left, right) = (left.to_path_buf(), right.to_path_buf());
    tokio::task::spawn_blocking(move || {
        let a = strict_discover_common_directory(&left)?;
        let b = strict_discover_common_directory(&right)?;
        Ok(a.is_some() && a == b)
    })
    .await
    .map_err(|_| ())?
}
async fn repository_root(root: &Path) -> PathBuf {
    match crate::git::run(root, &["rev-parse", "--show-toplevel"], 16 * 1024).await.ok().and_then(|o| o.ok().ok()) {
        Some(o) => {
            let trimmed = o.text().trim().to_owned();
            let fallback = root.to_path_buf();
            tokio::task::spawn_blocking(move || dunce::canonicalize(trimmed).unwrap_or(fallback))
                .await
                .unwrap_or_else(|_| root.to_path_buf())
        }
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
        && !t.starts_with(root)
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

    #[test]
    fn resolve_media_path_normalizes_parent_segments_within_scope() {
        let base = crate::shared::test_dir("media-norm");
        let scope = dunce::canonicalize(&base).unwrap();
        let sub_a = scope.join("a");
        let sub_b = scope.join("b");
        std::fs::create_dir_all(&sub_a).unwrap();
        std::fs::create_dir_all(&sub_b).unwrap();
        let with_dotdot =
            format!("{}{}..{}b", sub_a.to_string_lossy(), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
        let (resolved, anchor) = resolve_media_path(&scope, &with_dotdot).expect("normalized subfolder resolves");
        assert_eq!(resolved, sub_b);
        assert_eq!(anchor, sub_b);
        let escaping =
            format!("{}{}..{}outside", scope.to_string_lossy(), std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
        assert!(resolve_media_path(&scope, &escaping).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn strict_common_directory_rejects_incomplete_nested_git_dir() {
        let base = crate::shared::test_dir("strict-incomplete-git");
        let repo = base.join("repo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let init = crate::git::run(&repo, &["init", "--quiet"], 4096).await.unwrap();
        assert_eq!(init.code, 0);
        assert_eq!(shares_common_directory_strict(&repo, &sub).await, Ok(true));
        std::fs::create_dir_all(sub.join(".git")).unwrap();
        assert_eq!(shares_common_directory_strict(&repo, &sub).await, Err(()));
        let _ = std::fs::remove_dir_all(&base);
    }
}
