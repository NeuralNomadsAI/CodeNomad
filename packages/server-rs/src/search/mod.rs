//! `GET /api/workspaces/:id/files/search`, ported from the reference route
//! (`server/routes/workspaces.ts`), `manager.searchFiles` and
//! `filesystem/search.ts`. The root is the file browser's (`browser_root`:
//! lexical admission (M2), then a folder of an owned checkout). Links and
//! junctions are followed like `fs.stat`, outside
//! the project included; a branch never re-enters a directory it already
//! traverses (`realpath` of its ancestors). Ignored names, `.git` included,
//! are skipped as in the reference.
mod cache;
mod fuzzy;
mod query;

pub fn routes() -> axum::Router<Shared> {
    axum::Router::new().route("/api/workspaces/{id}/files/search", axum::routing::get(route))
}

use crate::{Shared, error};
use axum::{
    Json,
    extract::{Path as Route, RawQuery, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use cache::{BUSY_MESSAGE, Cache, Entry, Failure};
use chrono::{DateTime, SecondsFormat};
use std::{
    path::{Path, PathBuf},
    rc::Rc,
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 200;
const MAX_CANDIDATES: usize = 8000;
const IGNORED_DIRECTORIES: [&str; 11] =
    [".git", ".hg", ".svn", "node_modules", "dist", "build", ".next", ".nuxt", ".turbo", ".cache", "coverage"];

static CACHE: LazyLock<Cache> = LazyLock::new(Cache::default);

pub async fn route(
    State(app): State<Shared>,
    Route(id): Route<String>,
    RawQuery(raw): RawQuery,
) -> Result<Response, crate::Error> {
    let query = query::parse(raw.as_deref()).map_err(|message| error(Status::BAD_REQUEST, &message))?;
    let root = browser_root(&app, &id, query.directory.as_deref()).await?;
    let owners = owners(&app, &root);
    let kind = query.kind.unwrap_or("all");
    Ok(match search(&CACHE, root, &query.q, query.limit, kind, query.refresh == Some(true), owners).await {
        Ok(entries) => Json(entries).into_response(),
        Err(Failure::Busy) => (
            Status::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "1"), (header::CONTENT_TYPE, "text/plain")],
            BUSY_MESSAGE,
        )
            .into_response(),
        Err(Failure::Failed(message)) => error(Status::BAD_REQUEST, &message).into_response(),
    })
}

/// `fileBrowserRoot`: the workspace folder, or `resolveOwnedWorktree(directory).directory`
/// (the real or virtual requested folder inside an owned checkout, `worktrees::ownership`, which
/// admits it lexically under the server root (M2) before any disk access).
async fn browser_root(app: &crate::App, id: &str, directory: Option<&str>) -> Result<PathBuf, crate::Error> {
    let workspace = app.workspace(id)?;
    let Some(directory) = directory else { return Ok(workspace.path) };
    match crate::worktrees::ownership::resolve(app, &workspace, directory).await {
        Some(owned) => Ok(PathBuf::from(owned.directory)),
        None => Err(error(Status::BAD_REQUEST, "Directory is not owned by this workspace")),
    }
}

/// Workspaces open on `root`, whose reservation or removal clears its cache.
fn owners(app: &crate::App, root: &Path) -> Vec<Uuid> {
    let mut ids: Vec<Uuid> =
        app.inner.lock().unwrap().workspaces.iter().filter(|w| w.path == root).map(|w| w.id).collect();
    ids.sort();
    ids
}

/// `searchWorkspaceFiles` after the query's validation (`q` trimmed, non-empty).
async fn search(
    cache: &Cache,
    root: PathBuf,
    q: &str,
    limit: Option<u32>,
    kind: &'static str,
    refresh: bool,
    owners: Vec<Uuid>,
) -> Result<Vec<Entry>, Failure> {
    let limit = match limit.map(|l| l as usize) {
        None | Some(0) => DEFAULT_LIMIT,
        Some(l) => l.clamp(1, MAX_LIMIT),
    };
    let scope = format!("{kind}\0{}", q.to_lowercase());
    cache.observe(&root, &owners);
    let cached = if refresh { None } else { cache.get(&root, &scope, &owners, cache::now_ms()) };
    let entries = match cached {
        Some(entries) => entries,
        None => {
            let (scan_root, query) = (root.clone(), q.to_owned());
            let build = async move {
                tokio::task::spawn_blocking(move || collect(&scan_root, &query, kind)).await.map_err(|e| e.to_string())
            };
            match cache.refresh(&root, &scope, owners, None, build).await {
                Ok(entries) => entries,
                Err(Failure::Busy) => return Err(Failure::Busy),
                Err(failure) => {
                    cache.clear(Some(&root));
                    return Err(failure);
                }
            }
        }
    };
    let candidates: Vec<(&Entry, String)> =
        entries.iter().filter(|e| kind == "all" || e.kind == kind).map(|e| (e, e.path.to_lowercase())).collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let matches = fuzzy::go(&fuzzy::search(q), candidates.iter().map(|(_, key)| key.as_str()), limit);
    Ok(matches.into_iter().map(|(i, _)| candidates[i].0.clone()).collect())
}

struct Branch {
    identity: String,
    parent: Option<Rc<Branch>>,
}
impl Branch {
    fn contains(mut node: Option<&Rc<Branch>>, identity: &str) -> bool {
        while let Some(branch) = node {
            if branch.identity == identity {
                return true;
            }
            node = branch.parent.as_ref();
        }
        false
    }
}

/// `normalizeDirectoryIdentity(realpath(dir))`.
fn identity(dir: &Path) -> Option<String> {
    let real = dunce::canonicalize(dir).ok()?.to_string_lossy().into_owned();
    Some(if cfg!(windows) { real.to_lowercase() } else { real })
}

/// `Dirent.isDirectory()`: libuv reports every Windows reparse point as a link.
fn dirent_directory(entry: &std::fs::DirEntry) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        entry.metadata().is_ok_and(|m| m.file_attributes() & 0x10 != 0 && m.file_attributes() & 0x400 == 0)
    }
    #[cfg(not(windows))]
    entry.file_type().is_ok_and(|t| t.is_dir())
}

/// Directory entries in `readdir` order: libuv sorts them on Unix (`strcmp`).
fn read_names(dir: &Path) -> Option<Vec<(std::ffi::OsString, bool)>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        names.push((entry.file_name(), dirent_directory(&entry)));
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        names.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    }
    Some(names)
}

/// `collectCandidates`: depth-first from the end of the queue, pre-filtered by `fuzzysort.single`.
fn collect(root: &Path, query: &str, filter: &str) -> Vec<Entry> {
    let prepared = fuzzy::search(query);
    let mut queue: Vec<(String, Option<Rc<Branch>>)> = vec![(String::new(), None)];
    let mut entries = Vec::new();
    while entries.len() < MAX_CANDIDATES {
        let Some((relative_dir, ancestors)) = queue.pop() else { break };
        let absolute_dir = if relative_dir.is_empty() { root.to_path_buf() } else { root.join(&relative_dir) };
        let Some(real) = identity(&absolute_dir) else { continue };
        if Branch::contains(ancestors.as_ref(), &real) {
            continue;
        }
        let branch = Rc::new(Branch { identity: real, parent: ancestors });
        let Some(names) = read_names(&absolute_dir) else { continue };
        for (os_name, dirent_dir) in names {
            // Node decodes an unpaired surrogate to U+FFFD and its `stat` then fails.
            let Some(name) = os_name.to_str() else { continue };
            let ignored = IGNORED_DIRECTORIES.contains(&name.to_lowercase().as_str());
            let relative = if relative_dir.is_empty() { name.to_owned() } else { format!("{relative_dir}/{name}") };
            if dirent_dir && ignored {
                continue;
            }
            let Ok(meta) = std::fs::metadata(absolute_dir.join(&os_name)) else { continue };
            let is_dir = meta.is_dir();
            if is_dir && !ignored {
                queue.push((relative.clone(), Some(branch.clone())));
            }
            let kind = if is_dir { "directory" } else { "file" };
            let path = normalize_relative(&relative);
            if !(filter == "all" || kind == filter) || fuzzy::single(&prepared, &path.to_lowercase()).is_none() {
                continue;
            }
            entries.push(Entry {
                name: name.to_owned(),
                absolute_path: resolve(root, if path == "." { "" } else { &path }),
                path,
                kind,
                size: (!is_dir).then(|| meta.len()),
                modified_at: iso(meta.modified().unwrap_or(UNIX_EPOCH)),
            });
            if entries.len() >= MAX_CANDIDATES {
                break;
            }
        }
    }
    entries
}

/// `normalizeRelativeEntryPath`.
fn normalize_relative(relative: &str) -> String {
    if relative.is_empty() {
        return ".".into();
    }
    let normalized = collapse_backslash_runs(relative);
    let mut normalized = normalized.as_str();
    if normalized.starts_with("./") {
        normalized = normalized[1..].trim_start_matches('/');
    }
    let normalized = normalized.trim_start_matches('/');
    if normalized.is_empty() { ".".into() } else { normalized.to_owned() }
}

/// `relativePath.replace(/\\+/g, "/")`.
fn collapse_backslash_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if c == '\\' {
            if !in_run {
                out.push('/');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `path.resolve(root, relative)` for an absolute local root.
fn resolve(root: &Path, relative: &str) -> String {
    let root = root.to_string_lossy();
    #[cfg(windows)]
    let (prefix, rest, sep, seps): (&str, &str, &str, &[char]) = {
        let at = if root.as_bytes().get(1) == Some(&b':') { 2 } else { 0 };
        (&root[..at], &root[at..], "\\", &['\\', '/'])
    };
    #[cfg(not(windows))]
    let (prefix, rest, sep, seps): (&str, &str, &str, &[char]) = ("", &root[..], "/", &['/']);
    let mut parts: Vec<&str> = Vec::new();
    for segment in rest.split(seps).chain(relative.split(seps)) {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("{prefix}{sep}{}", parts.join(sep))
}

/// `stats.mtime.toISOString()`: Node rounds `mtimeMs` to the millisecond.
fn iso(time: SystemTime) -> String {
    let ms = match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6,
        Err(e) => -(e.duration().as_secs() as f64 * 1e3 + e.duration().subsec_nanos() as f64 / 1e6),
    };
    let up = ms.ceil();
    let rounded = if up - 0.5 > ms { up - 1.0 } else { up };
    DateTime::from_timestamp_millis(rounded as i64).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        crate::shared::test_dir(&format!("search-{name}"))
    }
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap()
                .status
                .success()
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[tokio::test]
    async fn finds_a_matching_file_after_more_than_8000_non_matching_entries() {
        let workspace = temp("many");
        std::fs::create_dir(workspace.join("a")).unwrap();
        std::fs::create_dir(workspace.join("b")).unwrap();
        let names = read_names(&workspace).unwrap();
        let (target_dir, filler_dir) = (workspace.join(&names[0].0), workspace.join(&names[1].0));
        for index in 0..8_001 {
            std::fs::write(filler_dir.join(format!("filler-{index}.txt")), "").unwrap();
        }
        std::fs::write(target_dir.join("unique-search-target.txt"), "").unwrap();
        let cache = Cache::default();
        let found =
            search(&cache, workspace.clone(), "unique-search-target", None, "file", true, vec![]).await.unwrap();
        assert!(found.iter().any(|e| e.name == "unique-search-target.txt"));
        search(&cache, workspace.clone(), "filler", None, "file", true, vec![]).await.unwrap();
        assert_eq!(cache.get(&workspace, "file\0filler", &[], cache::now_ms()).unwrap().len(), 8_000);
        let _ = std::fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn does_not_revisit_directory_links_and_indexes_real_and_linked_paths() {
        let cyclic = temp("cycle");
        link_dir(&cyclic, &cyclic.join("cycle"));
        let cache = Cache::default();
        assert!(search(&cache, cyclic.clone(), "not-present", None, "all", true, vec![]).await.unwrap().is_empty());
        let cycles = collect(&cyclic, "cycle", "all");
        assert_eq!(
            cycles.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            ["cycle"],
            "the link is listed once, not entered"
        );
        let linked = temp("link");
        std::fs::create_dir(linked.join("b")).unwrap();
        std::fs::write(linked.join("b").join("needle.txt"), "").unwrap();
        link_dir(&linked.join("b"), &linked.join("a"));
        let via_link = search(&cache, linked.clone(), "a/needle", None, "file", true, vec![]).await.unwrap();
        let via_real = search(&cache, linked.clone(), "b/needle", None, "file", true, vec![]).await.unwrap();
        assert!(via_link.iter().any(|e| e.path == "a/needle.txt"));
        assert!(via_real.iter().any(|e| e.path == "b/needle.txt"));
        let _ = (std::fs::remove_dir_all(cyclic), std::fs::remove_dir_all(linked));
    }

    #[tokio::test]
    async fn ignores_tooling_directories_and_shapes_entries_like_the_reference() {
        let root = temp("shape");
        for dir in [".git", "Node_Modules", "src"] {
            std::fs::create_dir(root.join(dir)).unwrap();
        }
        std::fs::write(root.join(".git").join("needle"), "").unwrap();
        std::fs::write(root.join("Node_Modules").join("needle"), "").unwrap();
        std::fs::write(root.join("src").join("Needle.TS"), "12345").unwrap();
        let found = search(&Cache::default(), root.clone(), "needle", None, "all", false, vec![]).await.unwrap();
        assert_eq!(found.len(), 1);
        let entry = &found[0];
        assert_eq!(
            (entry.name.as_str(), entry.path.as_str(), entry.kind, entry.size),
            ("Needle.TS", "src/Needle.TS", "file", Some(5))
        );
        assert_eq!(entry.absolute_path, root.join("src").join("Needle.TS").to_string_lossy());
        assert!(entry.modified_at.ends_with('Z') && entry.modified_at.len() == 24);
        let dirs = search(&Cache::default(), root.clone(), "src", None, "directory", false, vec![]).await.unwrap();
        assert_eq!(serde_json::to_value(&dirs[0]).unwrap().get("size"), None, "directories carry no size");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rounds_modification_times_like_node() {
        let at = |ms: u64, ns: u32| {
            UNIX_EPOCH + std::time::Duration::from_millis(ms) + std::time::Duration::from_nanos(ns as u64)
        };
        assert_eq!(iso(at(1_700_000_000_000, 499_200)), "2023-11-14T22:13:20.000Z");
        assert_eq!(iso(at(1_700_000_000_000, 600_000)), "2023-11-14T22:13:20.001Z");
        assert_eq!(iso(at(1_700_000_000_999, 600_000)), "2023-11-14T22:13:21.000Z");
        assert_eq!(normalize_relative("\\\\a\\\\b\\c"), "a/b/c");
        assert_eq!(normalize_relative("./x"), "x");
    }
}
