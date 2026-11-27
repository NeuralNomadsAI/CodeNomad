//! Media-path resolution, anchor discovery, and directory ownership checks for session media/events.
use super::git_discovery::{shares_common_directory, shares_common_directory_strict};
use super::{DirectoryProof, ProofMode, catalogue_proof, reject_network_path};
use crate::{App, Workspace};
use std::path::{Path, PathBuf};

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

async fn proof_live_async(
    proof: DirectoryProof,
    path: PathBuf,
    slot: Option<std::sync::Arc<tokio::sync::OwnedSemaphorePermit>>,
) -> Option<DirectoryProof> {
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        proof.live(&path).then_some(proof)
    })
    .await
    .ok()?
}

async fn catalogue_proof_live_async(
    catalogue: std::sync::Arc<crate::worktrees::inventory::Catalogue>,
    path: PathBuf,
    external: bool,
    scope: Option<PathBuf>,
    slot: Option<std::sync::Arc<tokio::sync::OwnedSemaphorePermit>>,
) -> Option<DirectoryProof> {
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
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
    catalogue: std::sync::Arc<crate::worktrees::inventory::Catalogue>,
    path: PathBuf,
    external: bool,
) -> bool {
    catalogue_proof_live_async(catalogue, path, external, None, None).await.is_some()
}

pub(crate) async fn media_directory(
    app: &App,
    workspace: &Workspace,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    path: &Path,
    anchor: &Path,
    strict_media: bool,
) -> Result<Option<DirectoryProof>, crate::Error> {
    media_directory_with_slot(app, workspace, endpoint, path, anchor, strict_media, None).await
}

pub(crate) async fn media_directory_with_slot(
    app: &App,
    workspace: &Workspace,
    endpoint: &std::sync::Arc<crate::opencode::Endpoint>,
    path: &Path,
    anchor: &Path,
    strict_media: bool,
    slot: Option<std::sync::Arc<tokio::sync::OwnedSemaphorePermit>>,
) -> Result<Option<DirectoryProof>, crate::Error> {
    use crate::worktrees::{inventory, linked::native_error};
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
        let held = slot.clone();
        let Some(root_id) = tokio::task::spawn_blocking(move || {
            let _slot = held;
            crate::files::directory_identity(&root_path).ok()
        })
        .await
        .ok()
        .flatten() else {
            return Ok(None);
        };
        let proof = DirectoryProof {
            tree: None,
            source: None,
            root: Some((workspace.path.clone(), root_id)),
            external,
            media: true,
        };
        return Ok(proof_live_async(proof, path.to_path_buf(), slot).await);
    }
    if !external
        && let Some(subfolders) = crate::worktrees::root_only_with_slot(&app.scope, workspace, slot.clone()).await?
    {
        if !current() {
            return Err(native_error());
        }
        if !subfolders {
            return if strict_media { Err(native_error()) } else { Ok(None) };
        }
        if strict_media {
            crate::worktrees::strict_non_git_workspace(workspace).await?;
        }
        let root_path = workspace.path.clone();
        let held = slot.clone();
        let Some(root_id) = tokio::task::spawn_blocking(move || {
            let _slot = held;
            crate::files::directory_identity(&root_path).ok()
        })
        .await
        .ok()
        .flatten() else {
            return Ok(None);
        };
        let proof = DirectoryProof {
            tree: None,
            source: None,
            root: Some((workspace.path.clone(), root_id)),
            external,
            media: true,
        };
        return Ok(proof_live_async(proof, path.to_path_buf(), slot).await);
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
            let proof = catalogue_proof_live_async(
                std::sync::Arc::new(catalogue),
                path.to_path_buf(),
                external,
                None,
                slot.clone(),
            )
            .await;
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
    // Match TS `worktree-inventory.ts:30-42`, `manager.ts:467-469`, & `native-worktrees.ts:86-96`:
    // route through the shared 10-second HTTP inventory cache pinned to `endpoint` so media paths
    // share one publication order, coalescing and invalidation epoch with all other HTTP readers.
    for _ in 0..4 {
        let revision = inventory::revision(app);
        let hit = inventory::media_http_read(app, workspace, endpoint, inventory::ReadMode::Validated).await?;
        if !current() {
            return Err(native_error());
        }
        let Some(catalogue) = hit.snapshot.catalogue() else {
            return Ok(None);
        };
        let root_live = if hit.from_cache {
            let cat = std::sync::Arc::clone(&catalogue);
            let opened = workspace.path.clone();
            tokio::task::spawn_blocking(move || cat.root_live_for(&opened)).await.unwrap_or(false)
        } else {
            true
        };
        if !current() {
            return Err(native_error());
        }
        if root_live {
            let proof = catalogue_proof_live_async(
                std::sync::Arc::clone(&catalogue),
                path.to_path_buf(),
                external,
                None,
                slot.clone(),
            )
            .await;
            if !current() {
                return Err(native_error());
            }
            if inventory::revision(app) != revision {
                continue;
            }
            if proof.is_some() || !hit.from_cache || hit.refreshed_on_miss {
                return Ok(proof);
            }
        }
        let retry_mode =
            if root_live { inventory::ReadMode::RefreshOnMiss(hit.generation) } else { inventory::ReadMode::Fresh };
        let refreshed = inventory::media_http_read(app, workspace, endpoint, retry_mode).await?;
        if !current() {
            return Err(native_error());
        }
        let Some(catalogue) = refreshed.snapshot.catalogue() else {
            return Ok(None);
        };
        let proof = catalogue_proof_live_async(catalogue, path.to_path_buf(), external, None, slot.clone()).await;
        if !current() {
            return Err(native_error());
        }
        if inventory::revision(app) != revision {
            continue;
        }
        return Ok(proof);
    }
    Err(native_error())
}
