//! The checkout inventory: `git worktree list` joined to native projects, cached for event routing.
use super::linked::{conflict, git, missing, native, native_error, physical};
use crate::{App, Error, Workspace, files};
use axum::http::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq)]
struct Physical {
    root: PathBuf,
    common: PathBuf,
    admin: PathBuf,
    root_id: String,
    common_id: String,
    admin_id: String,
    marker: Option<Vec<u8>>,
    backlink: Option<Vec<u8>>,
    stamp: [Option<(std::time::SystemTime, u64)>; 2],
}
fn config_stamp(path: &Path) -> Option<Option<(std::time::SystemTime, u64)>> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Some(Some((meta.modified().ok()?, meta.len()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
        _ => None,
    }
}
fn identity(path: &Path) -> Result<String, Error> {
    files::host_identity(path).map_err(|_| native_error())
}
fn small(path: &Path) -> Result<Vec<u8>, Error> {
    use std::io::Read;
    let meta = std::fs::symlink_metadata(path).map_err(|_| native_error())?;
    if !meta.is_file() || meta.len() > 4096 {
        return Err(native_error());
    }
    let mut value = Vec::new();
    std::fs::File::open(path).and_then(|f| f.take(4097).read_to_end(&mut value)).map_err(|_| native_error())?;
    if value.len() > 4096 { Err(native_error()) } else { Ok(value) }
}
impl Physical {
    fn live(&self) -> bool {
        let canonical = |path: &Path| dunce::canonicalize(path).ok().as_deref() == Some(path);
        canonical(&self.root)
            && canonical(&self.admin)
            && canonical(&self.common)
            && identity(&self.root).ok().as_ref() == Some(&self.root_id)
            && identity(&self.admin).ok().as_ref() == Some(&self.admin_id)
            && identity(&self.common).ok().as_ref() == Some(&self.common_id)
            && config_stamp(&self.common.join("config")) == Some(self.stamp[0])
            && config_stamp(&self.admin.join("config.worktree")) == Some(self.stamp[1])
            && self.marker.as_ref().is_none_or(|m| small(&self.root.join(".git")).ok().as_ref() == Some(m))
            && self.backlink.as_ref().is_none_or(|m| small(&self.admin.join("gitdir")).ok().as_ref() == Some(m))
    }
}
/// The checkout's `.git` is missing, or its `gitdir:` points at a missing
/// administrative directory (TS `readCheckoutIdentity` fails with ENOENT).
fn git_layout_gone(root: &Path) -> bool {
    let marker = root.join(".git");
    match std::fs::symlink_metadata(&marker) {
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        Ok(meta) if meta.is_file() => std::fs::read_to_string(&marker).is_ok_and(|text| {
            text.lines().find_map(|line| line.strip_prefix("gitdir:")).is_some_and(|dir| {
                let dir = Path::new(dir.trim());
                let dir = if dir.is_absolute() { dir.to_path_buf() } else { root.join(dir) };
                std::fs::symlink_metadata(dir).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            })
        }),
        Ok(_) => false,
    }
}
/// A readable Git checkout: the reference's strict ownership read reaches a
/// verdict there, while a non-Git or unreadable folder only fails the read.
pub async fn readable_checkout(path: &Path) -> bool {
    checkout(path).await.is_ok()
}
async fn checkout(path: &Path) -> Result<Physical, Error> {
    let text =
        git(path, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).await?;
    let mut lines = text.lines();
    let root = lines.next().and_then(physical).ok_or_else(native_error)?;
    let admin = lines.next().and_then(physical).ok_or_else(native_error)?;
    let common = lines.next().and_then(physical).ok_or_else(native_error)?;
    if lines.next().is_some() {
        return Err(native_error());
    }
    let (marker, backlink) = if admin == common {
        if common != root.join(".git") {
            return Err(conflict("External Git directory is unavailable"));
        }
        (None, None)
    } else {
        if admin.parent() != Some(common.join("worktrees").as_path()) {
            return Err(conflict("Foreign worktree administration"));
        }
        let marker = small(&root.join(".git"))?;
        let backlink = small(&admin.join("gitdir"))?;
        let text = std::str::from_utf8(&backlink).map_err(|_| native_error())?.trim_end();
        if dunce::canonicalize(text).ok().as_ref() != Some(&root.join(".git")) {
            return Err(conflict("Foreign Git backlink"));
        }
        (Some(marker), Some(backlink))
    };
    Ok(Physical {
        stamp: [
            config_stamp(&common.join("config")).ok_or_else(native_error)?,
            config_stamp(&admin.join("config.worktree")).ok_or_else(native_error)?,
        ],
        root_id: identity(&root)?,
        admin_id: identity(&admin)?,
        common_id: identity(&common)?,
        root,
        admin,
        common,
        marker,
        backlink,
    })
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tree {
    pub path: PathBuf,
    pub service: String,
    pub slug: String,
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
    pub(super) locked: bool,
    pub(super) service_root: String,
    pub nested_missing: bool,
    pub(super) removable: bool,
    layout: Physical,
    identity: Option<String>,
}
impl Tree {
    pub fn registered(&self) -> &Path {
        &self.layout.root
    }
    pub(super) fn public(&self) -> Value {
        let label = self.branch.clone().unwrap_or_else(|| {
            format!(
                "{} @ {}",
                self.layout.root.file_name().unwrap_or_default().to_string_lossy(),
                self.head.as_deref().and_then(|h| h.get(..7)).unwrap_or("HEAD")
            )
        });
        let mut row = json!({"slug":self.slug,"label":label,"kind":if self.slug=="root"{"root"}else{"worktree"},
            "directory":self.path,"registeredDirectory":self.layout.root,"serviceDirectory":self.service,
            "serviceRoot":self.service_root,"removable":self.removable});
        if let Some(v) = &self.branch {
            row["branch"] = json!(v);
        }
        if let Some(v) = &self.head {
            row["head"] = json!(v);
        }
        if self.nested_missing {
            row["nestedFolderMissing"] = json!(true);
        }
        row
    }
    fn owns_path(&self, dir: &Path) -> bool {
        self.path == dir && !self.nested_missing && self.layout.live() && identity(dir).ok() == self.identity
    }
    /// `dir` (physical, possibly not yet existing) lies in this live checkout's project folder.
    /// Only `subagent-depth` (`ownership`) admits such subfolders, as the reference does.
    pub fn contains_live(&self, dir: &Path) -> bool {
        dir.starts_with(&self.path)
            && !self.nested_missing
            && self.layout.live()
            && identity(&self.path).ok() == self.identity
    }
}
#[derive(Clone)]
pub struct Catalogue {
    pub project: String,
    pub trees: Vec<Tree>,
    pub parent: PathBuf,
    pub main: PathBuf,
}
impl Catalogue {
    pub fn get(&self, slug: &str) -> Result<&Tree, Error> {
        self.trees.iter().find(|t| t.slug == slug).ok_or_else(missing)
    }
    pub fn by_directory(&self, dir: &str) -> Option<&Tree> {
        let path = physical(dir)?;
        self.trees.iter().find(|t| t.owns_path(&path))
    }
    pub fn by_registered(&self, dir: &str) -> Option<&Tree> {
        let path = physical(dir)?;
        self.trees.iter().find(|t| t.registered() == path && t.layout.live())
    }
    pub fn response(&self) -> Value {
        json!({"isGitRepo":true,"defaultDirectory":self.parent,"worktrees":self.trees.iter().map(Tree::public).collect::<Vec<_>>()})
    }
}
pub fn scope(mut w: Workspace, tree: &Tree) -> Workspace {
    w.path = tree.path.clone();
    w.location = json!({"directory":tree.service});
    w
}

pub struct EventEntry {
    at: Instant,
    value: Option<Arc<Catalogue>>,
    refreshing: bool,
}
pub type EventCache = std::sync::Mutex<(u64, HashMap<Uuid, EventEntry>)>;
/// Event routing reuses an inventory for 4 s, then refreshes it in the
/// background while still serving it, up to the TS worktree cache TTL
/// (`WORKTREE_CACHE_TTL_MS`). A blocking refresh stalled the ordered event
/// bridge for 250–600 ms every 4 s. Invalidation always forces a fresh read,
/// and each lookup still rechecks identity and Git markers locally.
const EVENT_FRESH: Duration = Duration::from_secs(4);
const EVENT_STALE_LIMIT: Duration = Duration::from_secs(10);
const EVENT_ENTRIES: usize = 64;
fn store(cache: &mut (u64, HashMap<Uuid, EventEntry>), id: Uuid, value: Option<Arc<Catalogue>>) {
    if cache.1.len() >= EVENT_ENTRIES {
        cache.1.retain(|_, e| e.at.elapsed() < EVENT_STALE_LIMIT);
    }
    if cache.1.len() < EVENT_ENTRIES || cache.1.contains_key(&id) {
        cache.1.insert(id, EventEntry { at: Instant::now(), value, refreshing: false });
    }
}
/// Drops one workspace's inventory, or every one; a running refresh never stores after it.
fn drop_entries(app: &App, id: Option<Uuid>) {
    let mut cache = app.linked_events.lock().unwrap();
    cache.0 = cache.0.wrapping_add(1);
    match id {
        Some(id) => _ = cache.1.remove(&id),
        None => cache.1.clear(),
    }
}
pub fn invalidate(app: &App) {
    drop_entries(app, None)
}
pub fn forget(app: &App, id: Uuid) {
    drop_entries(app, Some(id))
}
pub async fn event_catalogue(app: &crate::Shared, w: &Workspace) -> Option<Arc<Catalogue>> {
    let epoch = {
        let mut cache = app.linked_events.lock().unwrap();
        let epoch = cache.0;
        if let Some(entry) = cache.1.get_mut(&w.id) {
            let age = entry.at.elapsed();
            if age < EVENT_FRESH {
                return entry.value.clone();
            }
            if age < EVENT_STALE_LIMIT && entry.value.is_some() {
                if !entry.refreshing {
                    entry.refreshing = true;
                    let (app, w) = (app.clone(), w.clone());
                    tokio::spawn(async move {
                        let started = Instant::now();
                        let result = catalogue(&app, &w, false).await.ok().map(Arc::new);
                        crate::bench::trace_elapsed("event-catalogue background", started);
                        let mut cache = app.linked_events.lock().unwrap();
                        if cache.0 != epoch {
                            return;
                        }
                        match result {
                            Some(value) => store(&mut cache, w.id, Some(value)),
                            // A failed refresh never extends the old inventory.
                            None => _ = cache.1.remove(&w.id),
                        }
                    });
                }
                return entry.value.clone();
            }
        }
        epoch
    };
    let started = Instant::now();
    let result = catalogue(app, w, false).await.ok().map(Arc::new);
    crate::bench::trace_elapsed("event-catalogue blocking", started);
    let mut cache = app.linked_events.lock().unwrap();
    if cache.0 != epoch {
        return None;
    }
    store(&mut cache, w.id, result.clone());
    result
}
pub async fn catalogue(app: &App, w: &Workspace, refresh: bool) -> Result<Catalogue, Error> {
    let native_dir = w.location["directory"].as_str().ok_or_else(native_error)?;
    let here =
        native(app, Method::GET, "/api/location", &[("location[directory]", native_dir)], None, 128 * 1024).await?;
    let project = here["project"]["id"].as_str().filter(|p| crate::opencode::valid_id(p)).ok_or_else(native_error)?;
    let local = checkout(&w.path).await?;
    let main_path = here["project"]["canonical"].as_str().and_then(physical).ok_or_else(native_error)?;
    let main = checkout(&main_path).await?;
    if here["directory"].as_str().and_then(physical).as_ref() != Some(&w.path)
        || here["project"]["directory"].as_str().and_then(physical).as_ref() != Some(&local.root)
        || main.root != main_path
        || main.admin != main.common
        || main.common != local.common
        || main.common_id != local.common_id
        || !main_path.starts_with(&app.root)
        || !local.root.starts_with(&app.root)
    {
        return Err(conflict("Workspace and native project do not share a checkout"));
    }
    let tail = w.path.strip_prefix(&local.root).map_err(|_| native_error())?;
    if refresh {
        native(app, Method::POST, "/api/worktree/refresh", &[], Some(json!({"projectID":project})), 16384).await?;
    }
    let entries = native(app, Method::GET, "/api/worktree", &[("projectID", project)], None, 256 * 1024).await?;
    let entries = entries.as_array().filter(|a| a.len() <= 64).ok_or_else(native_error)?;
    let annotations = git(&main.root, &["worktree", "list", "--porcelain", "-z"]).await?;
    let snapshot: HashMap<_, _> = annotations
        .split("\0\0")
        .filter_map(|s| Some((physical(s.split('\0').next()?.strip_prefix("worktree ")?)?, s)))
        .collect();
    let mut seen = HashSet::new();
    let mut checked = Vec::new();
    for entry in entries {
        let service_root = entry["directory"].as_str().ok_or_else(native_error)?;
        let Some(root) = physical(service_root) else { continue };
        if !root.starts_with(&app.root) || !seen.insert(root.clone()) {
            continue;
        }
        let Some(meta) = snapshot.get(&root) else { continue };
        let check = if root == local.root {
            local.clone()
        } else if root == main.root {
            main.clone()
        } else {
            match checkout(&root).await {
                Ok(check) => check,
                // Reference `listNativeWorktrees`: a registration whose Git layout
                // is gone (removal or prune in progress, interrupted removal) is no
                // longer a checkout and is omitted rather than failing the list.
                Err(_) if git_layout_gone(&root) => {
                    crate::bench::route_trace(format_args!("worktree-omitted layout-gone"));
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        if check.root != root || check.common != local.common || check.common_id != local.common_id || !check.live() {
            continue;
        }
        let opened = root == local.root;
        let projected = if tail.as_os_str().is_empty() { root.clone() } else { root.join(tail) };
        let id = if let Ok(real) = dunce::canonicalize(&projected) {
            if real != projected || !real.is_dir() {
                return Err(conflict("Projected worktree directory is not physically owned"));
            }
            Some(identity(&projected)?)
        } else {
            None
        };
        let service = if opened {
            native_dir.to_string()
        } else if tail.as_os_str().is_empty() {
            service_root.to_string()
        } else {
            Path::new(service_root).join(tail).to_str().ok_or_else(native_error)?.into()
        };
        let digest = format!("{:x}", Sha256::digest(super::linked::host(&root)?.as_bytes()));
        let slug = if opened { "root".into() } else { format!("worktree-{}", &digest[..20]) };
        let field = |prefix: &str| meta.split('\0').find_map(|s| s.strip_prefix(prefix)).map(str::to_owned);
        checked.push(Tree {
            path: projected,
            service,
            slug,
            identity: id.clone(),
            nested_missing: id.is_none(),
            service_root: service_root.into(),
            removable: !opened && check.admin != check.common,
            layout: check,
            branch: field("branch refs/heads/"),
            head: field("HEAD ").filter(|s| s.bytes().any(|b| b != b'0')),
            locked: meta.split('\0').any(|s| s == "locked" || s.starts_with("locked ")),
        });
    }
    app.workspace(&w.id.to_string())?;
    if !checked.iter().any(|t| t.slug == "root" && !t.nested_missing) {
        return Err(native_error());
    }
    checked.sort_by_key(|t| (t.slug != "root", t.branch.clone(), t.slug.clone()));
    Ok(Catalogue {
        project: project.into(),
        parent: main.root.join(".codenomad/worktrees"),
        main: main.root,
        trees: checked,
    })
}

#[cfg(test)]
mod layout_tests {
    use super::git_layout_gone;

    #[test]
    fn a_registration_without_git_layout_is_gone() {
        let base = crate::shared::test_dir("layout");
        let tree = base.join("tree");
        let admin = base.join("admin");
        std::fs::create_dir_all(&tree).unwrap();
        assert!(git_layout_gone(&tree), "no .git");
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        assert!(git_layout_gone(&tree), "administrative directory removed");
        std::fs::create_dir_all(&admin).unwrap();
        assert!(!git_layout_gone(&tree), "complete linked layout");
        std::fs::remove_file(tree.join(".git")).unwrap();
        std::fs::create_dir_all(tree.join(".git")).unwrap();
        assert!(!git_layout_gone(&tree), "main checkout directory");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
