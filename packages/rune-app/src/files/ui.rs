use super::{reader::Reader, request::Read, state::Tree};
use crate::platform::{self, collation::Collation, reads::Reads};
use codenomad_client::{
    Receiver, Sender, Wake, backend::Backend, bounded, files::Entry, history::Result,
    transport::WorkspaceEvent,
};
use std::collections::BTreeSet;

type Changes = Option<BTreeSet<(String, String)>>;

pub struct Row {
    pub entry: Entry,
    pub parent: String,
    pub depth: usize,
    pub expanded: Option<bool>,
    pub busy: bool,
}
pub struct Ui {
    pub reader: Reader,
    pub tree: Tree,
    pub rows: Vec<Row>,
    pub panel: bool,
    backend: Backend,
    reads: Reads,
    collation: std::result::Result<Collation, String>,
    incoming: Receiver<(Read, Result<Vec<Entry>>)>,
    out: Sender<(Read, Result<Vec<Entry>>)>,
    wake: Wake,
    active: bool,
    online: bool,
    due: Option<f64>,
    clock: f64,
    last_passive: Option<f64>,
    pending: Option<(f64, Changes)>,
    pub stopped: bool,
}
impl Ui {
    pub fn new(backend: Backend, directory: String, reads: Reads, wake: Wake) -> Self {
        let (out, incoming) = bounded(16);
        Self {
            reader: Reader::new(backend.clone(), reads.clone(), wake.clone()),
            tree: Tree::new(directory),
            rows: vec![],
            panel: false,
            backend,
            reads,
            collation: Collation::try_default(),
            incoming,
            out,
            wake,
            active: true,
            online: false,
            due: None,
            clock: 0.0,
            last_passive: None,
            pending: None,
            stopped: false,
        }
    }
    pub fn activate(&mut self, active: bool) {
        self.active = active;
        self.reader.activate(active);
        self.demand();
    }
    pub fn show(&mut self, show: bool) {
        self.panel = show;
        self.demand();
    }
    pub fn online(&mut self, online: bool) {
        self.reader.online(online && !self.stopped);
        if online && !self.online {
            self.tree.invalidate_all();
            self.pending = None;
        }
        self.online = online;
        self.demand();
    }
    fn demand(&mut self) {
        self.tree.activate(self.active && self.panel && self.online);
        self.due = Some(0.0);
        self.snapshot();
    }
    pub fn event(&mut self, event: WorkspaceEvent) {
        match event {
            WorkspaceEvent::FilesChanged {
                workspace_id,
                changes,
            } if workspace_id == self.backend.workspace && !self.stopped && !changes.is_empty() => {
                let due = self
                    .last_passive
                    .map_or(self.clock + 0.1, |last| (last + 5.0).max(self.clock + 0.1));
                let (_, pending) = self
                    .pending
                    .get_or_insert_with(|| (due, Some(BTreeSet::new())));
                if let Some(paths) = pending {
                    paths.extend(
                        changes
                            .into_iter()
                            .map(|change| (change.directory, change.path)),
                    );
                    if paths.len() > 1024 {
                        *pending = None;
                    }
                }
            }
            WorkspaceEvent::Stopped { workspace_id } if workspace_id == self.backend.workspace => {
                self.tree.close();
                self.reader.close();
                self.pending = None;
                self.stopped = true;
                self.snapshot();
            }
            _ => {}
        }
    }
    pub fn refresh(&mut self, path: Option<&str>) {
        if let Some(path) = path {
            if let Some(read) = self.tree.load(path, true) {
                self.launch(vec![read]);
            }
        } else {
            self.tree.refresh(true);
            self.reader.refresh();
            self.due = Some(0.0);
        }
    }
    pub fn select(&mut self, path: String, toggle: bool) {
        self.tree.select(path.clone());
        if toggle {
            let requests = self.tree.toggle(&path);
            self.launch(requests);
        }
    }
    pub fn open(&mut self, path: String) {
        if !self.stopped {
            self.reader.open(self.tree.directory().into(), path);
        }
    }
    pub fn close_reader(&mut self) {
        self.reader.close();
    }
    pub fn poll(&mut self, now: f64) -> bool {
        self.clock = now;
        let mut changed = false;
        if self.pending.as_ref().is_some_and(|(due, _)| now >= *due) {
            if let Some((_, changes)) = self.pending.take() {
                if let Some(changes) = changes {
                    for (directory, path) in changes {
                        self.tree.invalidate(&directory, Some(&path));
                    }
                } else {
                    self.tree.invalidate_all();
                }
                self.last_passive = Some(now);
                self.due = Some(now + 0.1);
                self.reader.invalidate();
            }
        }
        for _ in 0..8 {
            let Ok((read, result)) = self.incoming.try_recv() else {
                break;
            };
            let collation = &self.collation;
            changed |= self.tree.complete(read, result, |entries| match collation {
                Ok(collation) => collation.sort_files(entries),
                Err(error) => Err(error.clone()),
            });
        }
        if !self.incoming.is_empty() {
            (self.wake)();
        }
        if self.active && self.panel && self.online && self.due.is_some_and(|due| now >= due) {
            self.due = None;
            let requests = self.tree.take_refresh();
            changed |= !requests.is_empty();
            self.launch(requests);
        }
        if changed {
            self.snapshot();
            self.due.get_or_insert(now + 0.1);
        }
        if self
            .reader
            .target()
            .is_some_and(|target| target.directory != self.tree.directory())
        {
            self.reader.close();
            changed = true;
        }
        changed | self.reader.poll(now)
    }
    fn launch(&mut self, requests: Vec<Read>) {
        for read in requests {
            let (backend, reads, out, wake) = (
                self.backend.clone(),
                self.reads.clone(),
                self.out.clone(),
                self.wake.clone(),
            );
            platform::spawn(async move {
                if let Some(result) = read.fetch(&backend, &reads).await {
                    if out.send((read, result)).await.is_ok() {
                        wake();
                    }
                }
            });
        }
        self.snapshot();
    }
    fn snapshot(&mut self) {
        self.rows = self
            .tree
            .rows()
            .into_iter()
            .map(|row| Row {
                entry: row.entry.clone(),
                parent: row.parent.into(),
                depth: row.depth,
                expanded: row.expanded,
                busy: self.tree.busy(&row.entry.path),
            })
            .collect();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
