use super::request::Read;
use codenomad_client::{
    Sender, bounded,
    files::{Entry, EntryKind},
    history::Result,
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
};

const MAX_TRACKED_PATHS: usize = 1024;

#[derive(Default)]
struct Snapshot {
    directories: BTreeMap<String, Vec<Entry>>,
    expanded: BTreeSet<String>,
    selected: Option<String>,
    loaded: BTreeMap<String, u64>,
    versions: BTreeMap<String, u64>,
    version: u64,
    latest_version: u64,
}
impl Snapshot {
    fn retained_bytes(&self) -> usize {
        self.directories
            .iter()
            .fold(0usize, |total, (dir, entries)| {
                let entries_bytes = entries.iter().fold(0usize, |acc, entry| {
                    acc.saturating_add(entry.name.len())
                        .saturating_add(entry.path.len())
                        .saturating_add(entry.absolute_path.as_deref().map_or(0, str::len))
                        .saturating_add(entry.directory_identity.as_deref().map_or(0, str::len))
                        .saturating_add(entry.modified_at.as_deref().map_or(0, str::len))
                        .saturating_add(size_of::<Entry>())
                });
                total
                    .saturating_add(dir.len())
                    .saturating_add(entries_bytes)
            })
    }

    fn empty() -> Self {
        Self {
            expanded: BTreeSet::from([".".into()]),
            ..Self::default()
        }
    }
    fn version(&self, path: &str) -> u64 {
        self.version.max(*self.versions.get(path).unwrap_or(&0))
    }
}
struct Pending {
    id: u64,
    cancel: Sender<()>,
}
pub struct Row<'a> {
    pub entry: &'a Entry,
    pub parent: &'a str,
    pub depth: usize,
    pub expanded: Option<bool>,
}
pub struct Tree {
    owner: Arc<()>,
    directory: String,
    state: Snapshot,
    cache: VecDeque<(String, Snapshot)>,
    requests: BTreeMap<String, Pending>,
    errors: BTreeMap<String, codenomad_client::history::Error>,
    active: bool,
    closed: bool,
    dirty: bool,
    force: bool,
    sequence: u64,
}
impl Tree {
    pub fn new(directory: String) -> Self {
        Self {
            owner: Arc::new(()),
            directory,
            state: Snapshot::empty(),
            cache: VecDeque::new(),
            requests: BTreeMap::new(),
            errors: BTreeMap::new(),
            active: false,
            closed: false,
            dirty: true,
            force: false,
            sequence: 0,
        }
    }
    pub fn directory(&self) -> &str {
        &self.directory
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        let cached: usize = self
            .cache
            .iter()
            .map(|(dir, snap)| dir.len().saturating_add(snap.retained_bytes()))
            .sum();
        self.state.retained_bytes().saturating_add(cached)
    }
    pub(crate) fn evict_cached_worktrees(&mut self) -> usize {
        let freed: usize = self
            .cache
            .iter()
            .map(|(dir, snap)| dir.len().saturating_add(snap.retained_bytes()))
            .sum();
        self.cache.clear();
        freed
    }
    pub(crate) fn evict_listings(&mut self) -> usize {
        let before = self.retained_bytes();
        if before == 0 {
            return 0;
        }
        self.cancel();
        self.cache.clear();
        self.state.directories.clear();
        self.state.loaded.clear();
        self.dirty = true;
        before
    }
    pub fn selected(&self) -> Option<&str> {
        self.state.selected.as_deref()
    }
    pub fn select(&mut self, path: String) {
        self.state.selected = Some(path);
    }
    pub fn errors(&self) -> &BTreeMap<String, codenomad_client::history::Error> {
        &self.errors
    }
    pub fn busy(&self, path: &str) -> bool {
        self.requests.contains_key(path)
    }
    pub fn expanded(&self, path: &str) -> bool {
        self.state.expanded.contains(path)
    }
    pub fn rows(&self) -> Vec<Row<'_>> {
        fn visit<'a>(state: &'a Snapshot, path: &'a str, depth: usize, rows: &mut Vec<Row<'a>>) {
            for entry in state.directories.get(path).into_iter().flatten() {
                let expanded = (entry.kind == EntryKind::Directory)
                    .then(|| state.expanded.contains(&entry.path));
                rows.push(Row {
                    entry,
                    parent: path,
                    depth,
                    expanded,
                });
                if expanded == Some(true) {
                    visit(state, &entry.path, depth + 1, rows);
                }
            }
        }
        let mut rows = Vec::new();
        visit(&self.state, ".", 1, &mut rows);
        rows
    }
    fn visible(&self) -> Vec<String> {
        std::iter::once(".".to_owned())
            .chain(
                self.rows()
                    .into_iter()
                    .filter(|row| row.expanded == Some(true))
                    .map(|row| row.entry.path.clone()),
            )
            .collect()
    }
    fn stale(&self, path: &str) -> bool {
        self.state.loaded.get(path).copied() != Some(self.state.version(path))
    }
    pub fn activate(&mut self, active: bool) {
        if self.closed {
            return;
        }
        self.active = active;
        if !active {
            self.cancel();
        } else {
            self.dirty |= self.visible().iter().any(|path| self.stale(path));
        }
    }
    pub fn switch(&mut self, directory: String) {
        if self.closed || directory == self.directory {
            return;
        }
        self.cancel();
        let next = self
            .cache
            .iter()
            .position(|(key, _)| key == &directory)
            .and_then(|index| self.cache.remove(index))
            .map(|(_, state)| state)
            .unwrap_or_else(Snapshot::empty);
        let previous = std::mem::replace(&mut self.state, next);
        self.cache
            .push_back((std::mem::replace(&mut self.directory, directory), previous));
        if self.cache.len() > 8 {
            self.cache.pop_front();
        }
        self.errors.clear();
        self.force = false;
        self.dirty = self.visible().iter().any(|path| self.stale(path));
    }
    /// None invalidates every listing; a path invalidates only that listing.
    pub fn invalidate(&mut self, directory: &str, path: Option<&str>) {
        let current = codenomad_client::same_server_path(directory, &self.directory);
        let state = if current {
            Some(&mut self.state)
        } else {
            self.cache
                .iter_mut()
                .find(|(key, _)| codenomad_client::same_server_path(key, directory))
                .map(|(_, state)| state)
        };
        if let Some(state) = state {
            state.latest_version += 1;
            let version = state.latest_version;
            if let Some(path) = path
                && (state.versions.len() < MAX_TRACKED_PATHS || state.versions.contains_key(path))
            {
                state.versions.insert(path.into(), version);
            } else {
                state.version = version;
                state.versions.clear();
            }
            if current {
                self.dirty = true;
            }
        }
    }
    pub fn refresh(&mut self, force: bool) {
        self.dirty = true;
        self.force |= force;
    }
    pub fn invalidate_all(&mut self) {
        let directories = std::iter::once(self.directory.clone())
            .chain(self.cache.iter().map(|(directory, _)| directory.clone()))
            .collect::<Vec<_>>();
        for directory in directories {
            self.invalidate(&directory, None);
        }
    }
    /// The owner calls after its shared debounce, and again after the last completion.
    pub fn take_refresh(&mut self) -> Vec<Read> {
        if !self.active || self.closed || !self.dirty || !self.requests.is_empty() {
            return vec![];
        }
        self.dirty = false;
        let force = std::mem::take(&mut self.force);
        let paths = self.visible();
        paths
            .into_iter()
            .filter_map(|path| {
                if force || self.stale(&path) {
                    self.load(&path, true)
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn toggle(&mut self, path: &str) -> Vec<Read> {
        if self.closed {
            return vec![];
        }
        if !self.state.expanded.insert(path.into()) {
            self.state.expanded.remove(path);
            return vec![];
        }
        let paths = self.visible();
        paths
            .into_iter()
            .filter(|key| key == path || descendant(key, path))
            .filter_map(|key| {
                if self.stale(&key) {
                    self.load(&key, true)
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn load(&mut self, path: &str, force: bool) -> Option<Read> {
        if !self.active
            || self.closed
            || self.requests.contains_key(path)
            || !force && self.state.directories.contains_key(path)
        {
            return None;
        }
        self.sequence += 1;
        let (cancel, cancelled) = bounded(1);
        self.requests.insert(
            path.into(),
            Pending {
                id: self.sequence,
                cancel,
            },
        );
        self.errors.remove(path);
        Some(Read {
            owner: self.owner.clone(),
            directory: self.directory.clone(),
            path: path.into(),
            id: self.sequence,
            version: self.state.version(path),
            cancelled,
        })
    }
    pub fn complete(
        &mut self,
        read: Read,
        result: Result<Vec<Entry>>,
        order: impl FnOnce(Vec<Entry>) -> std::result::Result<Vec<Entry>, String>,
    ) -> bool {
        if !Arc::ptr_eq(&read.owner, &self.owner)
            || read.cancelled()
            || read.directory != self.directory
            || self.requests.get(&read.path).map(|pending| pending.id) != Some(read.id)
        {
            return false;
        }
        self.requests.remove(&read.path);
        let result = result.and_then(|entries| order(entries).map_err(Into::into));
        match result {
            Ok(entries) => {
                let replaced: Vec<_> = self
                    .state
                    .directories
                    .get(&read.path)
                    .into_iter()
                    .flatten()
                    .filter(|old| {
                        old.kind == EntryKind::Directory
                            && entries
                                .iter()
                                .find(|entry| entry.path == old.path)
                                .is_none_or(|new| {
                                    new.kind != EntryKind::Directory
                                        || old
                                            .directory_identity
                                            .as_ref()
                                            .zip(new.directory_identity.as_ref())
                                            .is_some_and(|(a, b)| a != b)
                                })
                    })
                    .map(|entry| entry.path.clone())
                    .collect();
                let invalid = |key: &str| {
                    replaced
                        .iter()
                        .any(|path| key == path || descendant(key, path))
                };
                self.state.directories.retain(|key, _| !invalid(key));
                self.state.loaded.retain(|key, _| !invalid(key));
                self.errors.retain(|key, _| !invalid(key));
                self.requests.retain(|key, pending| {
                    if invalid(key) {
                        pending.cancel.close();
                        false
                    } else {
                        true
                    }
                });
                self.state.directories.insert(read.path.clone(), entries);
                self.state.loaded.insert(read.path, read.version);
                self.dirty |= self.visible().iter().any(|path| self.stale(path));
            }
            Err(error) => {
                self.errors.insert(read.path, error);
            }
        }
        true
    }
    fn cancel(&mut self) {
        for (_, pending) in std::mem::take(&mut self.requests) {
            pending.cancel.close();
        }
    }
    pub fn close(&mut self) {
        self.cancel();
        self.closed = true;
        self.dirty = false;
        self.force = false;
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        self.cancel();
    }
}
fn descendant(candidate: &str, path: &str) -> bool {
    candidate
        .strip_prefix(path)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_invalidations_collapse_to_directory_version_at_bound() {
        let mut tree = Tree::new("/repo".into());
        for index in 0..MAX_TRACKED_PATHS {
            tree.invalidate("/repo", Some(&format!("dir-{index}")));
        }
        assert_eq!(tree.state.versions.len(), MAX_TRACKED_PATHS);
        assert_eq!(tree.state.version, 0);
        // Updating an already-tracked path keeps per-path tracking within bound.
        tree.invalidate("/repo", Some("dir-0"));
        assert_eq!(tree.state.versions.len(), MAX_TRACKED_PATHS);
        assert_eq!(tree.state.version, 0);
        // Exceeding MAX_TRACKED_PATHS collapses to a directory-wide invalidation.
        tree.invalidate("/repo", Some("dir-overflow"));
        assert!(tree.state.versions.is_empty());
        assert_eq!(tree.state.version, (MAX_TRACKED_PATHS + 2) as u64);
        assert_eq!(tree.state.version("."), (MAX_TRACKED_PATHS + 2) as u64);
    }
}
