use super::*;

impl Ui {
    pub(crate) fn poll(&mut self, now: f64) -> bool {
        self.clock = now;
        if self.passive_due.is_some_and(|due| now >= due) {
            self.passive_due = None;
            self.passive_started = None;
            self.last_passive = Some(now);
            self.dirty(&[Lane::Changes, Lane::History]);
            if self
                .preview
                .as_ref()
                .is_some_and(|target| matches!(target.source, Source::Local(_)))
            {
                self.dirty(&[Lane::Preview]);
            }
        }
        let mut changed = self.reader.poll_images();
        while let Some(done) = self.requests.take() {
            changed = true;
            match done {
                Completed::Read(lane, Ok(value)) => self.accept(lane, value),
                Completed::Read(lane, Err(error)) => self.read_failed(lane, error),
                Completed::Mutation(epoch, tree, action, result) => {
                    self.settle_mutation(epoch, &tree, action, result)
                }
            }
        }
        let before = self.loading();
        self.demand();
        changed || before != self.loading()
    }

    pub(super) fn read_failed(&mut self, lane: Lane, error: Error) {
        if lane == Lane::Changes {
            self.index_checked = None;
        }
        self.requests.slot_mut(lane).error = Some(error.to_string());
    }

    pub(super) fn accept(&mut self, lane: Lane, value: Value) {
        match value {
            Value::Preferences(hide) => self.set_hide_whitespace(hide),
            Value::InitSessions(sessions) => self.init_sessions = Some(sessions),
            Value::Worktrees(inventory) => {
                let previous = self.tree().cloned();
                let repository = self.repository();
                self.inventory = Some(inventory);
                if self.session_checkout_removed() {
                    self.close_preview();
                }
                if self.tree().is_none() {
                    // The conversation's placement is not a request to browse the root.
                    self.slug.clone_from(&self.session_slug);
                }
                let replaced = previous
                    .as_ref()
                    .zip(self.tree())
                    .is_none_or(|(a, b)| !same_tree(a, b));
                if replaced || repository != self.repository() {
                    let notice = self.mutation_message.take();
                    self.reset_tree();
                    if !replaced {
                        self.mutation_message = notice;
                    }
                } else if previous
                    .as_ref()
                    .zip(self.tree())
                    .is_some_and(|(a, b)| a.branch != b.branch || a.head != b.head)
                {
                    self.invalidate_checkout_content();
                }
            }
            Value::Changes(mut statuses, revision, index_revision) => {
                // Keep Changes readable while generated files keep arriving. An
                // older display snapshot grants neither a write nor reader adoption.
                let fresh = !self.requests.slot(lane).dirty && self.passive_due.is_none();
                if let Some(collation) = &self.collation {
                    statuses.sort_by(|a, b| {
                        collation
                            .compare(&a.path, &b.path)
                            .unwrap_or_else(|_| a.path.cmp(&b.path))
                    });
                }
                self.changes.replace(statuses, self.hide_whitespace);
                if index_revision == self.index_revision {
                    self.index_checked = Some(index_revision);
                }
                if fresh && revision.is_none_or(|revision| self.preview_revision == revision) {
                    self.reconcile_preview();
                }
            }
            Value::History(mut page, more) => {
                // Continuation pages echo their pinned cursor, not the live HEAD.
                if !more && self.tree().is_some_and(|tree| page.head != tree.head) {
                    self.invalidate_index();
                    self.dirty(&[Lane::Worktrees]);
                }
                if let Some(previous) = &self.history.page {
                    if more {
                        let existing: HashSet<_> =
                            previous.commits.iter().map(|commit| &commit.id).collect();
                        if page.head != previous.head
                            || page
                                .commits
                                .iter()
                                .any(|commit| existing.contains(&commit.id))
                        {
                            self.requests.slot_mut(lane).error =
                                Some(crate::strings::t("rune.failed").into());
                            return;
                        }
                        page.commits.splice(..0, previous.commits.iter().cloned());
                    } else if page.head == previous.head
                        && page.commits.len() < previous.commits.len()
                        && page
                            .commits
                            .iter()
                            .zip(&previous.commits)
                            .all(|(a, b)| a.id == b.id)
                    {
                        page.commits
                            .extend_from_slice(&previous.commits[page.commits.len()..]);
                        page.has_more = previous.has_more;
                    }
                }
                self.history.page = Some(page);
                *self.history.dates.get_mut() = None;
            }
            Value::Details(details) => self.history.details = Some(details),
            Value::Preview(content) => {
                if let Some(target) = &self.preview
                    && self
                        .reader
                        .replace(content, &target.path, self.hide_whitespace, &self.images)
                        .is_err()
                {
                    self.requests.slot_mut(lane).error =
                        Some(crate::strings::t("toolCall.output.tooLarge").into());
                }
            }
        }
    }

    pub(super) fn settle_mutation(
        &mut self,
        epoch: u64,
        origin: &Worktree,
        action: Mutation,
        outcome: codenomad_client::history::Result<()>,
    ) {
        if self.stopped {
            return;
        }
        let init = matches!(&action, Mutation::Init(_));
        if init {
            self.dirty(&[Lane::Worktrees, Lane::InitSessions]);
        }
        self.invalidate_index();
        self.dirty(&[Lane::History]);
        self.invalidated_files = true;
        if epoch != self.tree_epoch || !self.tree().is_some_and(|tree| same_tree(origin, tree)) {
            return;
        }
        if self
            .preview
            .as_ref()
            .is_some_and(|target| matches!(target.source, Source::Local(_)))
        {
            self.dirty(&[Lane::Preview]);
        }
        self.mutation_message = match (action, outcome) {
            (Mutation::Init(_), Ok(())) => {
                Some((true, crate::strings::t("filesPanel.gitInit.success").into()))
            }
            (Mutation::Commit { draft, .. }, Ok(())) => {
                if self.changes.draft.text == draft {
                    self.changes.draft = TextEdit::new("");
                }
                Some((
                    true,
                    crate::strings::t("instanceShell.gitChanges.commit.success").into(),
                ))
            }
            (Mutation::Paths(_, _, revision), Ok(())) => {
                self.changes.finish_bulk(revision);
                None
            }
            (Mutation::Init(_), Err(error)) => Some((false, init_error(error))),
            (_, Err(error)) => Some((false, error.to_string())),
        };
    }

    pub(crate) fn take_files_invalidation(&mut self) -> bool {
        std::mem::take(&mut self.invalidated_files)
    }

    pub(super) fn loading(&self) -> bool {
        self.requests.slot(Lane::Worktrees).busy()
            || match self.mode {
                Mode::Workspace => false,
                Mode::Changes => self.requests.slot(Lane::Changes).busy(),
                Mode::History => {
                    self.requests.slot(Lane::History).busy()
                        || self.requests.slot(Lane::Details).busy()
                }
            }
    }
}

fn same_tree(a: &Worktree, b: &Worktree) -> bool {
    a.slug == b.slug
        && same_server_path(&a.directory, &b.directory)
        && match (&a.service_directory, &b.service_directory) {
            (None, None) => true,
            (Some(a), Some(b)) => same_server_path(a, b),
            _ => false,
        }
}

fn init_error(error: Error) -> String {
    if error
        .downcast_ref::<Refusal>()
        .is_some_and(|err| err.code.as_deref() == Some("git_required"))
    {
        return error.to_string();
    }
    let key = error.downcast_ref::<Refusal>().and_then(|err| {
        Some(match err.code.as_deref() {
            Some("git_init_unsupported") => "filesPanel.gitInit.unsupported",
            Some("git_init_repository_exists") => "filesPanel.gitInit.exists",
            Some("git_init_directory_mismatch") => "filesPanel.gitInit.mismatch",
            _ if matches!(err.status, 403 | 404) => "filesPanel.gitInit.notOwned",
            _ if err.status == 409 => "filesPanel.gitInit.deleting",
            _ => return None,
        })
    });
    key.map_or_else(
        || crate::strings::t("filesPanel.gitInit.error").replace("{message}", &error.to_string()),
        |key| crate::strings::t(key).into(),
    )
}
