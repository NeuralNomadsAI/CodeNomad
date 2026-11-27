use crate::platform::{
    self,
    reads::{Reads, cancellable},
};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    files::Preview,
    history::{Error, Result},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub session: String,
    pub directory: String,
    pub path: String,
}
struct Pending {
    id: u64,
    cancel: Sender<()>,
}
pub struct Reader {
    backend: Backend,
    reads: Reads,
    wake: Wake,
    incoming: Receiver<(u64, Target, Result<Preview>)>,
    out: Sender<(u64, Target, Result<Preview>)>,
    target: Option<Target>,
    preview: Option<Preview>,
    error: Option<Error>,
    pending: Option<Pending>,
    sequence: u64,
    settled: (u64, bool),
    active: bool,
    online: bool,
    dirty: bool,
    clock: f64,
    due: f64,
}
impl Reader {
    pub fn new(backend: Backend, reads: Reads, wake: Wake) -> Self {
        let (out, incoming) = bounded(8);
        Self {
            backend,
            reads,
            wake,
            incoming,
            out,
            target: None,
            preview: None,
            error: None,
            pending: None,
            sequence: 0,
            settled: (0, false),
            active: true,
            online: false,
            dirty: false,
            clock: 0.0,
            due: 0.0,
        }
    }
    pub fn rebind_session(&mut self, backend: &Backend) {
        self.backend = backend.clone();
    }
    pub fn target(&self) -> Option<&Target> {
        self.target.as_ref()
    }
    pub fn preview(&self) -> Option<&Preview> {
        self.preview.as_ref()
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        self.preview.as_ref().map_or(0, |preview| {
            preview
                .bytes
                .len()
                .saturating_add(preview.path.len())
                .saturating_add(preview.workspace_id.len())
                .saturating_add(preview.version.as_deref().map_or(0, str::len))
        })
    }
    pub(crate) fn evict_preview(&mut self) -> usize {
        let freed = self.retained_bytes();
        if freed == 0 {
            return 0;
        }
        self.cancel();
        self.preview = None;
        self.error = None;
        self.dirty = self.target.is_some();
        self.due = 0.0;
        freed
    }
    #[cfg(test)]
    pub(crate) fn fixture_set_preview(&mut self, directory: &str, path: &str, bytes: Vec<u8>) {
        self.target = Some(Target {
            session: self.backend.session.clone(),
            directory: directory.into(),
            path: path.into(),
        });
        self.preview = Some(Preview {
            workspace_id: self.backend.workspace.clone(),
            path: path.into(),
            bytes,
            version: None,
        });
        self.dirty = false;
    }
    pub fn error(&self) -> Option<&Error> {
        self.error.as_ref()
    }
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    pub fn receipt(&self) -> (u64, bool) {
        self.settled
    }
    pub fn reread(&mut self) -> u64 {
        self.cancel();
        self.refresh();
        self.sequence + 1
    }
    pub fn open(&mut self, directory: String, path: String) {
        self.close();
        self.target = Some(Target {
            session: self.backend.session.clone(),
            directory,
            path,
        });
        self.refresh();
    }
    pub fn close(&mut self) {
        self.cancel();
        self.target = None;
        self.preview = None;
        self.error = None;
        self.dirty = false;
        self.settled = (0, false);
    }
    fn cancel(&mut self) {
        if let Some(pending) = self.pending.take() {
            pending.cancel.close();
        }
    }
    pub fn activate(&mut self, active: bool) {
        if self.active == active {
            return;
        }
        self.active = active;
        if !active {
            self.cancel();
        }
        self.refresh();
    }
    pub fn online(&mut self, online: bool) {
        if self.online == online {
            return;
        }
        self.online = online;
        if !online {
            self.cancel();
        }
        self.refresh();
    }
    pub fn refresh(&mut self) {
        self.dirty = self.target.is_some();
        self.due = 0.0;
    }
    pub fn invalidate(&mut self) {
        self.dirty = self.target.is_some();
        self.due = self.clock + 0.1;
    }
    pub fn poll(&mut self, now: f64) -> bool {
        self.clock = now;
        let mut changed = false;
        for _ in 0..8 {
            let Ok((id, target, result)) = self.incoming.try_recv() else {
                break;
            };
            if self.pending.as_ref().map(|p| p.id) != Some(id) {
                continue;
            }
            self.pending = None;
            if self.target.as_ref() != Some(&target) {
                continue;
            }
            self.settled = (id, result.is_ok());
            match result {
                Ok(preview) => {
                    self.preview = Some(preview);
                    self.error = None;
                }
                Err(error) => self.error = Some(error),
            }
            changed = true;
        }
        if !self.incoming.is_empty() {
            (self.wake)();
        }
        if self.active && self.online && self.dirty && !self.busy() && now >= self.due {
            if let Some(target) = self.target.clone() {
                self.dirty = false;
                self.error = None;
                self.sequence += 1;
                let id = self.sequence;
                let (cancel, cancelled) = bounded(1);
                self.pending = Some(Pending { id, cancel });
                let (backend, reads, out, wake) = (
                    self.backend.clone(),
                    self.reads.clone(),
                    self.out.clone(),
                    self.wake.clone(),
                );
                platform::spawn(async move {
                    let result = cancellable(&cancelled, async {
                        let _slot = reads.preview(&cancelled).await?;
                        Some(backend.preview_file(&target.directory, &target.path).await)
                    })
                    .await
                    .flatten();
                    if let Some(result) = result {
                        if out.send((id, target, result)).await.is_ok() {
                            wake();
                        }
                    }
                });
                changed = true;
            }
        }
        changed
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Reader {
    pub fn scene(&mut self, preview: Result<Preview>) {
        self.cancel();
        self.dirty = false;
        self.sequence += 1;
        self.settled = (self.sequence, preview.is_ok());
        match preview {
            Ok(preview) => {
                self.preview = Some(preview);
                self.error = None;
            }
            Err(error) => {
                self.preview = None;
                self.error = Some(error);
            }
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
