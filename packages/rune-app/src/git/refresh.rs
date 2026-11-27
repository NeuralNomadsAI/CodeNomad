use super::{Lane, Mode, Read, Source, Ui};
use codenomad_client::{git::Repository, same_server_path, transport::WorkspaceEvent};

impl Ui {
    pub(crate) fn event(&mut self, event: &WorkspaceEvent) {
        if self.stopped {
            return;
        }
        match event {
            WorkspaceEvent::UiPreferencesChanged => {
                self.requests.slot_mut(Lane::Preferences).cancel();
                self.dirty(&[Lane::Preferences]);
            }
            WorkspaceEvent::FilesChanged {
                workspace_id,
                changes,
            } if workspace_id == &self.backend.workspace
                && self.tree().is_some_and(|tree| {
                    changes
                        .iter()
                        .any(|change| same_server_path(&change.directory, &tree.directory))
                }) =>
            {
                self.filesystem_hint();
            }
            WorkspaceEvent::NativeFilesystemChanged { workspace_id }
                if workspace_id == &self.backend.workspace =>
            {
                self.filesystem_hint();
            }
            WorkspaceEvent::WorktreesChanged { workspace_id }
                if workspace_id == &self.backend.workspace =>
            {
                self.dirty(&[Lane::Worktrees]);
                self.invalidate_checkout_content();
            }
            WorkspaceEvent::SessionMoved {
                workspace_id,
                session_id,
            } if workspace_id == &self.backend.workspace && session_id == &self.backend.session => {
                self.close_preview();
            }
            WorkspaceEvent::Stopped { workspace_id, .. }
                if workspace_id == &self.backend.workspace =>
            {
                self.stopped = true;
                self.reset_tree();
                self.inventory = None;
                self.demand();
            }
            _ => {}
        }
    }

    pub(super) fn filesystem_hint(&mut self) {
        let start = *self.passive_started.get_or_insert(self.clock);
        let soon = self.clock + 0.1;
        self.passive_due = Some(
            self.last_passive
                .map_or(soon, |last| (last + 5.0).max(soon))
                .min(start + 5.0),
        );
    }

    pub(super) fn dirty(&mut self, lanes: &[Lane]) {
        for &lane in lanes {
            self.requests.slot_mut(lane).dirty = true;
        }
    }

    pub(super) fn invalidate_index(&mut self) {
        self.index_revision = self.index_revision.wrapping_add(1);
        self.dirty(&[Lane::Changes]);
    }

    pub(super) fn invalidate_checkout_content(&mut self) {
        self.invalidate_index();
        self.dirty(&[Lane::History]);
        if self.has_local_preview() {
            self.requests.slot_mut(Lane::Preview).cancel();
            self.dirty(&[Lane::Preview]);
        }
    }

    pub(super) fn has_local_preview(&self) -> bool {
        self.preview
            .as_ref()
            .is_some_and(|target| matches!(target.source, Source::Local(_)))
    }

    pub(super) fn demand(&mut self) {
        let available = self.active && self.online && !self.stopped;
        let shown = available && self.shown;
        let preview = available && self.preview.is_some();
        let tree_wanted = shown
            || preview
            || available
                && (self.workspace_preview
                    || !self.backend.session.is_empty()
                    || self.requests.slot(Lane::InitSessions).dirty);
        let git = self.repository() != Repository::Uninitialized && self.tree().is_some();
        let changes = shown && git && self.mode == Mode::Changes;
        let history = shown && git && self.mode == Mode::History;
        for (lane, wanted) in [
            (Lane::Worktrees, tree_wanted),
            (Lane::InitSessions, available),
            (Lane::Changes, changes),
            (Lane::History, history),
            (Lane::Details, history && self.history.selected.is_some()),
            (Lane::Preview, preview),
            (Lane::Preferences, shown || preview),
        ] {
            if !wanted {
                self.requests.slot_mut(lane).cancel();
            }
        }
        if tree_wanted && self.requests.mutation.is_none() {
            self.ensure(
                Read::Worktrees(self.inventory.is_some()),
                self.inventory.is_none(),
            );
        }
        if shown || preview {
            self.ensure(Read::Preferences, false);
        }
        if self.requests.mutation.is_some() {
            return;
        }
        if available
            && !self.requests.slot(Lane::Worktrees).busy()
            && let Some(root) = self
                .inventory
                .as_ref()
                .and_then(|list| list.trees.iter().find(|tree| tree.slug == "root"))
        {
            self.ensure(Read::InitSessions(root.clone()), false);
        }
        if let Some(tree) = self.tree().cloned() {
            if changes
                && self.ensure(
                    Read::Changes(
                        tree.clone(),
                        self.hide_whitespace,
                        self.reconcile_revision,
                        self.index_revision,
                    ),
                    !self.changes.ready(),
                )
            {
                self.reconcile_revision = None;
            }
            if history {
                self.ensure(
                    Read::History(tree.slug.clone(), None),
                    self.history.page.is_none(),
                );
                if let Some(id) = self.history.selected.clone() {
                    self.ensure(
                        Read::Details(tree.clone(), id),
                        self.history.details.is_none(),
                    );
                }
            }
            if available && let Some(target) = self.preview.clone() {
                self.ensure(Read::Preview(tree, target), self.reader.content.is_none());
            }
        }
    }

    fn ensure(&mut self, read: Read, missing: bool) -> bool {
        let slot = self.requests.slot(read.lane());
        if !slot.busy() && (slot.dirty || missing && slot.error.is_none()) {
            self.requests.start(read);
            return true;
        }
        false
    }

    pub(super) fn refresh(&mut self) {
        self.retry_panel_reads();
        self.dirty(&[Lane::Worktrees]);
        self.invalidate_index();
        if self.repository() == Repository::Git {
            match self.mode {
                Mode::Workspace => {}
                Mode::Changes => {
                    self.reconcile_revision = Some(self.preview_revision);
                    if self.has_local_preview() {
                        self.dirty(&[Lane::Preview]);
                    }
                }
                Mode::History => {
                    self.dirty(&[Lane::History]);
                    if self.history.selected.is_some() && self.history.details.is_none() {
                        self.dirty(&[Lane::Details]);
                    }
                }
            }
        }
        self.demand();
    }
}
