use super::{
    Lane, Mode, Ui,
    changes::{self, Id},
};
use codenomad_client::git::Section;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Source {
    Local(Section),
    Commit { id: String, subject: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Preview {
    pub source: Source,
    pub path: String,
    pub original_path: Option<String>,
}

impl Preview {
    pub(super) fn local(row: &changes::Row) -> Self {
        Self {
            source: Source::Local(row.id.section),
            path: row.id.path.clone(),
            original_path: row.original_path.clone(),
        }
    }
}

impl Ui {
    pub(super) fn toggle_preview(&mut self, preview: Preview) -> bool {
        if !self.can_read_panel() || self.backend.session.is_empty() {
            return false;
        }
        if self.preview.as_ref() == Some(&preview) {
            self.close_preview();
            return false;
        }
        let admitted = match &preview.source {
            Source::Local(section) => {
                self.mode == Mode::Changes
                    && self
                        .changes
                        .find(&Id {
                            section: *section,
                            path: preview.path.clone(),
                        })
                        .is_some_and(|row| row.original_path == preview.original_path)
            }
            Source::Commit { id, .. } => {
                self.mode == Mode::History
                    && self.history.details.as_ref().is_some_and(|details| {
                        details.id == *id
                            && details.files.iter().any(|row| row.path == preview.path)
                    })
            }
        };
        if !admitted {
            return false;
        }
        self.replace_preview(preview);
        self.demand();
        true
    }

    pub(super) fn replace_preview(&mut self, preview: Preview) {
        self.close_preview();
        self.preview_revision = self.preview_revision.wrapping_add(1);
        if let Source::Local(section) = preview.source {
            self.changes.keep_visible(Id {
                section,
                path: preview.path.clone(),
            });
        }
        self.preview = Some(preview);
    }

    pub(crate) fn has_preview(&self) -> bool {
        self.preview.is_some()
    }

    pub(crate) fn close_preview(&mut self) {
        if self.preview.take().is_some() {
            self.preview_revision = self.preview_revision.wrapping_add(1);
            self.reader.clear();
            *self.requests.slot_mut(Lane::Preview) = Default::default();
        }
    }

    pub(super) fn reconcile_preview(&mut self) {
        let Some(target) = &self.preview else {
            return;
        };
        let Source::Local(section) = target.source else {
            return;
        };
        let id = Id {
            section,
            path: target.path.clone(),
        };
        match self.changes.equivalent(&id).map(Preview::local) {
            Some(next) if &next == target => self.changes.keep_visible(id),
            Some(next) => self.replace_preview(next),
            None => self.close_preview(),
        }
    }
}
