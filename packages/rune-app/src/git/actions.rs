use super::{Lane, Mode, Mutation, Ui, changes::Id};
use codenomad_client::{
    git::{Repository, Section},
    same_server_path,
};

impl Ui {
    pub(super) fn can_read_panel(&self) -> bool {
        self.active && self.online && self.shown && !self.stopped
    }

    pub(super) fn can_mutate(&self) -> bool {
        let worktrees = self.requests.slot(Lane::Worktrees);
        self.can_read_panel()
            && self.requests.mutation.is_none()
            && self.tree().is_some()
            && !worktrees.busy()
            && !worktrees.dirty
            && worktrees.error.is_none()
    }

    pub(super) fn can_change_index(&self) -> bool {
        let changes = self.requests.slot(Lane::Changes);
        let preference = self.requests.slot(Lane::Preferences);
        self.can_mutate()
            && self.mode == Mode::Changes
            && self.repository() == Repository::Git
            && self.changes.ready()
            && self.index_checked == Some(self.index_revision)
            && changes.error.is_none()
            && !preference.busy()
            && !preference.dirty
            && preference.error.is_none()
    }

    fn mutation(&mut self, action: Mutation) {
        if self.can_mutate()
            && let Some(tree) = self.tree().cloned()
        {
            for lane in [Lane::Changes, Lane::History, Lane::Preview] {
                self.requests.slot_mut(lane).cancel();
            }
            self.mutation_message = None;
            self.reconcile_revision = Some(self.preview_revision);
            self.requests.mutate(self.tree_epoch, tree, action);
        }
    }

    pub(super) fn move_paths(&mut self, id: &Id, focus: Option<&str>) {
        let paths = self.changes.paths(id);
        if self.can_change_index() && !paths.is_empty() {
            self.pending_row_focus = self.changes.focus_order(focus);
            self.mutation(Mutation::Paths(
                id.section,
                paths,
                self.changes.selection_revision,
            ));
        }
    }

    pub(super) fn can_commit(&self) -> bool {
        self.can_change_index()
            && self.changes.section(Section::Staged).next().is_some()
            && !self.changes.draft.text.trim().is_empty()
    }

    pub(super) fn commit(&mut self) {
        if self.can_commit() {
            let draft = self.changes.draft.text.clone();
            self.mutation(Mutation::Commit {
                message: draft.trim().to_owned(),
                draft,
            });
        }
    }

    pub(super) fn initialize(&mut self) {
        if self.mode != Mode::Workspace
            && self.repository() == Repository::Uninitialized
            && let Some(root) = &self.root
            && self
                .tree()
                .is_some_and(|tree| tree.slug == "root" && same_server_path(&tree.directory, root))
        {
            self.mutation(Mutation::Init(root.clone()));
        }
    }
}
