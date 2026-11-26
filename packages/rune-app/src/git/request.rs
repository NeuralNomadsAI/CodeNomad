use super::{Preview, Source};
use crate::platform::{
    self,
    reads::{self, Reads},
};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    catalog::Sessions,
    git::{Details, Diff, Page, Section, Status, Worktree, Worktrees},
    history::Result,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Lane {
    Worktrees,
    Changes,
    History,
    Details,
    Preview,
    Preferences,
    InitSessions,
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(super) const LANES: [(&str, Lane); 7] = [
    ("Worktrees", Lane::Worktrees),
    ("Changes", Lane::Changes),
    ("History", Lane::History),
    ("Details", Lane::Details),
    ("Preview", Lane::Preview),
    ("Preferences", Lane::Preferences),
    ("InitSessions", Lane::InitSessions),
];

pub(super) enum Read {
    Preferences,
    InitSessions(Worktree),
    Worktrees(bool),
    Changes(Worktree, bool, Option<u64>, u64),
    History(String, Option<(String, usize)>),
    Details(Worktree, String),
    Preview(Worktree, Preview),
}

pub(super) enum Value {
    Preferences(bool),
    InitSessions(Sessions),
    Worktrees(Worktrees),
    Changes(Vec<Status>, Option<u64>, u64),
    History(Page, bool),
    Details(Details),
    Preview(Diff),
}

impl Read {
    pub(super) fn lane(&self) -> Lane {
        match self {
            Self::Preferences => Lane::Preferences,
            Self::InitSessions(_) => Lane::InitSessions,
            Self::Worktrees(_) => Lane::Worktrees,
            Self::Changes(..) => Lane::Changes,
            Self::History(..) => Lane::History,
            Self::Details(..) => Lane::Details,
            Self::Preview(..) => Lane::Preview,
        }
    }

    async fn fetch(self, backend: &Backend) -> Result<Value> {
        Ok(match self {
            Self::Preferences => Value::Preferences(backend.git_hide_whitespace().await?),
            Self::InitSessions(root) => {
                Value::InitSessions(backend.git_init_sessions(&root).await?)
            }
            Self::Worktrees(fresh) => Value::Worktrees(backend.git_worktrees(fresh).await?),
            Self::Changes(tree, hide, preview_revision, index_revision) => Value::Changes(
                backend.git_status(&tree, hide).await?,
                preview_revision,
                index_revision,
            ),
            Self::History(slug, cursor) => Value::History(
                backend
                    .git_history(
                        &slug,
                        cursor
                            .as_ref()
                            .map(|(head, offset)| (head.as_str(), *offset)),
                    )
                    .await?,
                cursor.is_some(),
            ),
            Self::Details(tree, id) => {
                Value::Details(backend.git_commit_details(&tree, &id).await?)
            }
            Self::Preview(tree, target) => Value::Preview(match target.source {
                Source::Local(section) => {
                    backend
                        .git_local_diff(
                            &tree,
                            section,
                            &target.path,
                            target.original_path.as_deref(),
                        )
                        .await?
                }
                Source::Commit { id, .. } => {
                    backend.git_commit_diff(&tree, &id, &target.path).await?
                }
            }),
        })
    }
}

pub(super) enum Mutation {
    Paths(Section, Vec<String>, u64),
    Commit { message: String, draft: String },
    Init(String),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum MutationKind {
    Paths,
    Commit,
    Init,
}

impl Mutation {
    fn kind(&self) -> MutationKind {
        match self {
            Self::Paths(..) => MutationKind::Paths,
            Self::Commit { .. } => MutationKind::Commit,
            Self::Init(_) => MutationKind::Init,
        }
    }
    async fn send(&self, tree: &Worktree, backend: &Backend) -> Result<()> {
        match self {
            Self::Paths(from, paths, _) => backend.git_move_paths(tree, *from, paths).await,
            Self::Commit { message, .. } => backend.git_commit(&tree.slug, message).await,
            Self::Init(directory) => backend.git_init(directory).await,
        }
    }
}

enum Event {
    Read {
        lane: Lane,
        token: Sender<()>,
        outcome: Result<Value>,
    },
    Mutation {
        epoch: u64,
        tree: Worktree,
        source: Backend,
        action: Mutation,
        outcome: Result<()>,
    },
}

pub(super) enum Completed {
    Read(Lane, Result<Value>),
    Mutation(u64, Worktree, Backend, Mutation, Result<()>),
}

#[derive(Default)]
pub(super) struct Slot {
    token: Option<Sender<()>>,
    pub dirty: bool,
    pub error: Option<String>,
}

impl Slot {
    pub fn busy(&self) -> bool {
        self.token.is_some()
    }
    pub fn cancel(&mut self) {
        if let Some(token) = self.token.take() {
            token.close();
            self.dirty = true;
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub(super) struct Requests {
    backend: Backend,
    reads: Reads,
    wake: Wake,
    out: Sender<Event>,
    incoming: Receiver<Event>,
    slots: [Slot; 7],
    pub mutation: Option<MutationKind>,
}

impl Requests {
    pub fn new(backend: Backend, reads: Reads, wake: Wake) -> Self {
        let (out, incoming) = bounded(16);
        Self {
            backend,
            reads,
            wake,
            out,
            incoming,
            slots: Default::default(),
            mutation: None,
        }
    }

    pub fn renew(&mut self, backend: Backend) {
        self.backend = backend;
        for (index, slot) in self.slots.iter_mut().enumerate() {
            slot.cancel();
            slot.dirty |= index != Lane::InitSessions as usize;
        }
    }

    #[cfg(test)]
    pub(super) fn deliver_read(&mut self, lane: Lane, outcome: Result<Value>) {
        let (token, _rx) = bounded(1);
        self.slots[lane as usize].token = Some(token.clone());
        self.slots[lane as usize].dirty = false;
        let _ = self.out.try_send(Event::Read {
            lane,
            token,
            outcome,
        });
    }

    pub fn slot(&self, lane: Lane) -> &Slot {
        &self.slots[lane as usize]
    }
    pub fn slot_mut(&mut self, lane: Lane) -> &mut Slot {
        &mut self.slots[lane as usize]
    }

    pub fn has_completion(&self) -> bool {
        !self.incoming.is_empty()
    }

    pub fn start(&mut self, read: Read) {
        let lane = read.lane();
        let slot = self.slot_mut(lane);
        if slot.busy() {
            return;
        }
        slot.dirty = false;
        slot.error = None;
        let (token, cancel) = bounded(1);
        slot.token = Some(token.clone());
        let (backend, reads, out, wake) = (
            self.backend.clone(),
            self.reads.clone(),
            self.out.clone(),
            self.wake.clone(),
        );
        platform::spawn(async move {
            let Some(permit) = (if lane == Lane::Preview {
                reads.preview(&cancel).await
            } else {
                reads.background(&cancel).await
            }) else {
                return;
            };
            let outcome = reads::cancellable(&cancel, read.fetch(&backend)).await;
            drop(permit);
            if let Some(outcome) = outcome
                && out
                    .send(Event::Read {
                        lane,
                        token,
                        outcome,
                    })
                    .await
                    .is_ok()
            {
                wake();
            }
        });
    }

    pub fn mutate(&mut self, epoch: u64, tree: Worktree, action: Mutation) {
        if self.mutation.is_some() {
            return;
        }
        self.mutation = Some(action.kind());
        let (backend, out, wake) = (self.backend.clone(), self.out.clone(), self.wake.clone());
        platform::spawn(async move {
            let outcome = action.send(&tree, &backend).await;
            if out
                .send(Event::Mutation {
                    epoch,
                    tree,
                    source: backend,
                    action,
                    outcome,
                })
                .await
                .is_ok()
            {
                wake();
            }
        });
    }

    pub fn take(&mut self) -> Option<Completed> {
        while let Ok(event) = self.incoming.try_recv() {
            match event {
                Event::Read {
                    lane,
                    token,
                    outcome,
                } => {
                    let slot = self.slot_mut(lane);
                    if slot
                        .token
                        .as_ref()
                        .is_some_and(|current| current.same_channel(&token))
                    {
                        slot.token = None;
                        return Some(Completed::Read(lane, outcome));
                    }
                }
                Event::Mutation {
                    epoch,
                    tree,
                    source,
                    action,
                    outcome,
                } => {
                    self.mutation = None;
                    return Some(Completed::Mutation(epoch, tree, source, action, outcome));
                }
            }
        }
        None
    }
}
