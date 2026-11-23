use super::Ui;
use codenomad_client::{
    Receiver, Sender, bounded,
    files::{CreateEntry, EntryKind},
};
use rune::{TextEdit, Tx};

#[derive(Clone)]
struct Target {
    directory: String,
    parent: String,
    kind: EntryKind,
}

pub(in crate::files) struct Form {
    pub id: u64,
    pub edit: TextEdit,
    pub error: Option<&'static str>,
    target: Target,
}
impl Form {
    pub fn parent(&self) -> &str {
        &self.target.parent
    }
    pub fn kind(&self) -> EntryKind {
        self.target.kind
    }
    pub fn valid(&self) -> bool {
        let name = &self.edit.text;
        !name.trim().is_empty()
            && name.len() <= 4096
            && !name.contains(['/', '\\', '\0', '\n', '\r'])
            && !matches!(name.as_str(), "." | "..")
            && !name.eq_ignore_ascii_case(".git")
    }
}

pub(in crate::files) struct Create {
    pub local: bool,
    pub form: Option<Form>,
    pub pending: bool,
    sequence: u64,
    unclear: Option<Target>,
    incoming: Receiver<Option<CreateEntry>>,
    out: Sender<Option<CreateEntry>>,
}
impl Default for Create {
    fn default() -> Self {
        let (out, incoming) = bounded(1);
        Self {
            local: false,
            form: None,
            pending: false,
            sequence: 0,
            unclear: None,
            incoming,
            out,
        }
    }
}

impl Ui {
    pub(in crate::files) fn with_local_entries(mut self, local: bool) -> Self {
        self.create.local = local;
        self
    }
    pub(in crate::files) fn can_create(&self) -> bool {
        self.create.local
            && self.active
            && self.online
            && !self.stopped
            && self.drawer().pinned
            && !self.create.pending
            && !self.creation_unclear()
    }
    pub(in crate::files) fn creation_unclear(&self) -> bool {
        self.create
            .unclear
            .as_ref()
            .is_some_and(|entry| entry.directory == self.tree.directory())
    }
    pub(in crate::files) fn start_create(&mut self, kind: EntryKind, tx: &mut Tx) {
        if !self.can_create() {
            return;
        }
        let parent = self
            .rows
            .iter()
            .find(|row| Some(row.entry.path.as_str()) == self.tree.selected())
            .map_or(".", |row| {
                if row.expanded.is_some() {
                    &row.entry.path
                } else {
                    &row.parent
                }
            });
        self.create.sequence += 1;
        self.create.form = Some(Form {
            id: self.create.sequence,
            edit: TextEdit::new(""),
            error: None,
            target: Target {
                directory: self.tree.directory().into(),
                parent: parent.into(),
                kind,
            },
        });
        tx.focus_when_shown("file-create-name", true);
    }
    pub(in crate::files) fn cancel_create(&mut self, id: u64) {
        if !self.create.pending && self.create.form.as_ref().is_some_and(|form| form.id == id) {
            self.create.form = None;
        }
    }
    pub(in crate::files) fn create_entry(&mut self, id: u64) {
        if !self.can_create() {
            return;
        }
        let Some(form) = &mut self.create.form else {
            return;
        };
        if form.id != id || form.target.directory != self.tree.directory() {
            return;
        }
        if !form.valid() {
            form.error = Some("filesPanel.entryNameInvalid");
            return;
        }
        let entry = form.target.clone();
        if entry.parent != "."
            && !self
                .rows
                .iter()
                .any(|row| row.expanded.is_some() && row.entry.path == entry.parent)
        {
            form.error = Some("filesPanel.entryCreateFailed");
            return;
        }
        self.create.pending = true;
        form.error = None;
        let (backend, out, wake, name) = (
            self.backend.clone(),
            self.create.out.clone(),
            self.wake.clone(),
            form.edit.text.clone(),
        );
        crate::platform::spawn(async move {
            let result = backend
                .create_entry(&entry.directory, &entry.parent, &name, entry.kind)
                .await
                .ok();
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }
    pub(super) fn poll_create(&mut self) -> bool {
        if let Ok(outcome) = self.create.incoming.try_recv() {
            self.create.pending = false;
            let Some(mut form) = self.create.form.take() else {
                return false;
            };
            let entry = form.target.clone();
            if matches!(
                outcome,
                None | Some(CreateEntry::Created | CreateEntry::NameTaken)
            ) {
                self.tree.invalidate(&entry.directory, Some(&entry.parent));
                self.due = Some(0.0);
                if entry.directory == self.tree.directory()
                    && self.listing_visible(&entry.parent)
                    && !self.tree.expanded(&entry.parent)
                    && entry.parent != "."
                {
                    let reads = self.tree.toggle(&entry.parent);
                    self.launch(reads);
                }
            }
            match outcome {
                Some(CreateEntry::Created) => {}
                None => self.create.unclear = Some(entry),
                Some(result) => {
                    form.error = Some(if result == CreateEntry::NameTaken {
                        "filesPanel.entryNameTaken"
                    } else {
                        "filesPanel.entryCreateFailed"
                    });
                    if self.active
                        && self.drawer().pinned
                        && entry.directory == self.tree.directory()
                    {
                        self.create.form = Some(form);
                    }
                }
            }
            return true;
        }
        if self.create.unclear.as_ref().is_some_and(|entry| {
            entry.directory == self.tree.directory() && !self.tree.stale(&entry.parent)
        }) {
            self.create.unclear = None;
            return true;
        }
        false
    }
}

pub(in crate::files) fn create_key(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::File => "file-new",
        EntryKind::Directory => "file-new-directory",
    }
}
