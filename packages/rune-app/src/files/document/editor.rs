use super::{
    Content, content,
    source_text::{Snapshot, lf},
    store::{Error, Key, Pending, SavedKey, Shared, Store, Writes, lock, version},
};
use crate::{files::reader::Reader, platform};
use codenomad_client::{Receiver, Wake, backend::Backend, bounded, catalog::Project};
use rune::TextEdit;

mod position;
mod save;
pub(super) use position::SavedPosition;
use position::{Position, Viewport};
use std::rc::Rc;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Overwrite,
    Discard,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Confirmation {
    pub id: u64,
    pub decision: Decision,
}
enum Intent {
    Idle,
    Checking {
        id: u64,
        receipt: u64,
        text: Snapshot,
    },
    Overwrite {
        id: u64,
        text: Snapshot,
        version: String,
    },
    Discard(u64),
    Refreshing(u64),
}
pub struct Editor {
    backend: Backend,
    store: Store,
    writes: Writes,
    written: u64,
    instance: String,
    project: Option<Project>,
    native_project: Option<Option<String>>,
    project_read: Option<Receiver<crate::history::Result<Option<String>>>>,
    project_error: bool,
    wake: Wake,
    key: Option<Key>,
    saved_key: Option<SavedKey>,
    draft: Option<Shared>,
    intent: Intent,
    receipt: u64,
    active: bool,
    online: bool,
    observed: Option<(bool, bool, Option<Error>)>,
    scope: u64,
    revision: u64,
    edit: TextEdit,
    position: Position,
    rejected: TextEdit,
}
impl Editor {
    pub fn new(backend: Backend, store: Store, instance: String, wake: Wake) -> Self {
        let writes = store.writes(&backend.base, &instance);
        let written = *lock(&writes);
        Self {
            backend,
            store,
            writes,
            written,
            instance,
            project: None,
            native_project: None,
            project_read: None,
            project_error: false,
            wake,
            key: None,
            saved_key: None,
            draft: None,
            intent: Intent::Idle,
            receipt: 0,
            active: true,
            online: false,
            observed: None,
            scope: 0,
            revision: 0,
            edit: TextEdit::new(""),
            position: Position::default(),
            rejected: TextEdit::new(""),
        }
    }
    pub fn rebind_session(&mut self, backend: &Backend) {
        self.backend = backend.clone();
    }
    pub fn key(&self) -> Option<&Key> {
        self.key.as_ref()
    }
    pub(crate) fn has_unsaved_edits(&self) -> bool {
        self.draft.as_ref().is_some_and(|shared| {
            let draft = lock(shared);
            draft.dirty() || draft.pending.is_some() || draft.uncertain.is_some()
        })
    }
    pub(crate) fn clean_retained_bytes(
        &self,
        seen_drafts: &mut std::collections::HashSet<usize>,
    ) -> usize {
        if self.has_unsaved_edits() {
            return 0;
        }
        let draft_bytes = self.draft.as_ref().map_or(0, |shared| {
            // Count a shared clean Draft once across all tabs that view the same file.
            if !seen_drafts.insert(std::sync::Arc::as_ptr(shared) as usize) {
                return 0;
            }
            let draft = lock(shared);
            draft.text.len().saturating_add(
                draft
                    .original
                    .as_ref()
                    .map_or(0, |snap| snap.text.len().saturating_add(snap.wire.len())),
            )
        });
        self.edit.text.len().saturating_add(draft_bytes)
    }
    pub(crate) fn clean_evictable_bytes(&self) -> usize {
        if self.has_unsaved_edits() {
            return 0;
        }
        let draft_bytes = self.draft.as_ref().map_or(0, |shared| {
            // Only count the shared Draft buffer as evictable when no other tab shares it.
            if std::sync::Arc::strong_count(shared) > 1 {
                return 0;
            }
            let draft = lock(shared);
            draft.text.len().saturating_add(
                draft
                    .original
                    .as_ref()
                    .map_or(0, |snap| snap.text.len().saturating_add(snap.wire.len())),
            )
        });
        self.edit.text.len().saturating_add(draft_bytes)
    }
    pub(crate) fn evict_clean_buffers(&mut self) -> usize {
        if self.has_unsaved_edits() {
            return 0;
        }
        let freed = self.clean_evictable_bytes();
        if freed == 0 {
            return 0;
        }
        self.edit = TextEdit::new("");
        if let Some(shared) = &self.draft {
            if std::sync::Arc::strong_count(shared) == 1 {
                let mut draft = lock(shared);
                draft.original = None;
                draft.text = String::new();
                draft.version = None;
                draft.revision += 1;
                self.revision = draft.revision;
                self.receipt = 0;
            } else {
                // Another tab shares this Draft: leave it intact and force `self.edit` to resync on return.
                let revision = lock(shared).revision;
                self.revision = revision.wrapping_sub(1);
            }
        } else {
            self.receipt = 0;
        }
        freed
    }
    #[cfg(test)]
    pub(crate) fn fixture_attach_shared(
        &mut self,
        store: Store,
        directory: &str,
        path: &str,
        text: &str,
    ) {
        self.store = store;
        let key = Key {
            server: "transport".into(),
            instance: self.instance.clone(),
            native_project: None,
            directory: directory.into(),
            path: path.into(),
        };
        let saved_key = SavedKey {
            server: "installation".into(),
            project: "/project".into(),
            native_project: None,
            directory: directory.into(),
            path: path.into(),
        };
        let shared = self.store.open_saved(&key, Some(&saved_key));
        {
            let mut draft = lock(&shared);
            if draft.original.is_none() {
                draft.original = Some(Snapshot::loaded(text));
                draft.text = text.into();
                draft.revision += 1;
            }
            self.revision = draft.revision;
        }
        self.edit = TextEdit::new(&lock(&shared).text);
        self.receipt = 1;
        self.key = Some(key);
        self.saved_key = Some(saved_key);
        self.draft = Some(shared);
    }
    #[cfg(test)]
    pub(crate) fn fixture_load_clean(&mut self, text: &str) {
        let key = Key {
            server: "transport".into(),
            instance: self.instance.clone(),
            native_project: None,
            directory: "/project".into(),
            path: "clean.rs".into(),
        };
        let shared = self.store.open(&key);
        {
            let mut draft = lock(&shared);
            draft.original = Some(Snapshot::loaded(text));
            draft.text = text.into();
            draft.revision += 1;
            self.revision = draft.revision;
        }
        self.edit = TextEdit::new(text);
        self.receipt = 1;
        self.key = Some(key);
        self.draft = Some(shared);
    }
    #[cfg(test)]
    pub(crate) fn fixture_receipt(&self) -> u64 {
        self.receipt
    }
    #[cfg(test)]
    pub(crate) fn fixture_mark_dirty(&mut self, original: &str, edited: &str) {
        let key = Key {
            server: "transport".into(),
            instance: self.instance.clone(),
            native_project: None,
            directory: "/project".into(),
            path: "dirty.rs".into(),
        };
        let shared = self.store.open(&key);
        {
            let mut draft = lock(&shared);
            draft.original = Some(Snapshot::loaded(original));
            draft.text = edited.into();
        }
        self.store.sync(&key, &shared);
        self.key = Some(key);
        self.draft = Some(shared);
    }
    #[cfg(test)]
    pub(crate) fn fixture_saved_key(&mut self, server: &str, project: &str) {
        if let Some(key) = &self.key {
            self.saved_key = Some(SavedKey {
                server: server.into(),
                project: project.into(),
                native_project: None,
                directory: key.directory.clone(),
                path: key.path.clone(),
            });
        }
    }
    pub(crate) fn set_project(&mut self, project: Project) {
        self.project = Some(project);
    }
    fn read_project(&mut self) {
        if self.native_project.is_some() || self.project_read.is_some() {
            return;
        }
        let Some(project) = self.project.clone() else {
            return;
        };
        let (out, input) = bounded(1);
        self.project_read = Some(input);
        let backend = self.backend.clone();
        let wake = self.wake.clone();
        platform::spawn(async move {
            let _ = out.send(backend.native_project(&project).await).await;
            wake();
        });
    }
    pub(crate) fn not_retained(&self) -> bool {
        self.draft
            .as_ref()
            .is_some_and(|draft| lock(draft).not_retained)
    }
    pub fn dirty(&self) -> bool {
        self.draft.as_ref().is_some_and(|draft| lock(draft).dirty())
    }
    pub(crate) fn has_edits(&self) -> bool {
        self.store.has_edits(&self.backend.base, &self.instance)
    }
    pub fn pending(&self) -> bool {
        self.draft
            .as_ref()
            .is_some_and(|draft| lock(draft).pending.is_some())
    }
    pub fn writing(&self) -> bool {
        self.draft
            .as_ref()
            .is_some_and(|draft| matches!(lock(draft).pending, Some(Pending::Write(_))))
    }
    pub fn take_write(&mut self) -> bool {
        let written = *lock(&self.writes);
        std::mem::replace(&mut self.written, written) != written
    }
    pub fn error(&self) -> Option<Error> {
        self.draft
            .as_ref()
            .and_then(|draft| lock(draft).error.clone())
    }
    pub(crate) fn project_error(&self) -> bool {
        self.project_error
    }
    pub fn confirmation(&self) -> Option<Confirmation> {
        match self.intent {
            Intent::Overwrite { id, .. } => Some(Confirmation {
                id,
                decision: Decision::Overwrite,
            }),
            Intent::Discard(id) => Some(Confirmation {
                id,
                decision: Decision::Discard,
            }),
            _ => None,
        }
    }
    pub fn scope(&self) -> u64 {
        self.scope
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn edit(&self) -> &TextEdit {
        &self.edit
    }
    pub(crate) fn source_viewport(&self) -> Rc<Viewport> {
        self.position.viewport.clone()
    }

    pub(crate) fn restore_source_scroll(&self) {
        self.position.viewport.arm();
    }
    pub fn editable(&self) -> bool {
        self.active
            && (self.project.is_none() || self.native_project.is_some())
            && self.draft.as_ref().is_some_and(|draft| {
                let draft = lock(draft);
                self.revision == draft.revision && (draft.original.is_some() || draft.recovered)
            })
    }
    pub fn writable(&self) -> bool {
        self.editable()
            && self.online
            && self.dirty()
            && !self.pending()
            && self
                .draft
                .as_ref()
                .is_some_and(|draft| lock(draft).original.is_some())
    }
    pub fn input(&mut self, scope: u64) -> &mut TextEdit {
        self.rejected = TextEdit::new("");
        if scope != self.scope
            || !self.active
            || self.project.is_some() && self.native_project.is_none()
            || self.draft.as_ref().is_none_or(|draft| {
                let draft = lock(draft);
                self.revision != draft.revision || (draft.original.is_none() && !draft.recovered)
            })
        {
            &mut self.rejected
        } else {
            &mut self.edit
        }
    }
    pub fn open(&mut self, directory: String, path: String) {
        self.close();
        self.native_project = None;
        self.project_read = None;
        self.project_error = false;
        self.read_project();
        self.attach(directory, path);
    }
    fn attach(&mut self, directory: String, path: String) {
        let key = Key {
            server: self.backend.base.clone(),
            instance: self.instance.clone(),
            native_project: self.native_project.clone().flatten(),
            directory,
            path,
        };
        let saved_key = self
            .backend
            .client
            .server_identity()
            .zip(self.project.as_ref())
            .zip(self.native_project.as_ref())
            .map(|((server, project), native_project)| SavedKey {
                server: server.into(),
                project: project.path.clone(),
                native_project: native_project.clone(),
                directory: key.directory.clone(),
                path: key.path.clone(),
            });
        let draft = if self.project.is_some() && self.native_project.is_none() {
            Shared::default()
        } else {
            self.store.open_saved(&key, saved_key.as_ref())
        };
        if saved_key.is_some() {
            self.store.sync(&key, &draft);
        }
        self.edit = TextEdit::new(&lock(&draft).text);
        self.revision = lock(&draft).revision;
        self.position = Position::new(self.store.source_position(&key));
        self.draft = Some(draft);
        self.key = Some(key);
        self.saved_key = saved_key;
    }
    pub fn close(&mut self) {
        self.cancel_check();
        if let (Some(key), Some(draft)) = (&self.key, &self.draft) {
            let has_text = {
                let draft = lock(draft);
                draft.original.is_some() || draft.recovered
            };
            if has_text
                && self.position.viewport.mounted()
                && (self.project.is_none() || self.native_project.is_some())
            {
                self.store.remember_position(
                    key.clone(),
                    SavedPosition::capture(
                        &self.edit,
                        self.position.viewport.saved_scroll(&self.edit.text),
                    ),
                );
            }
            self.store.sync_saved(key, self.saved_key.as_ref(), draft);
        }
        self.key = None;
        self.saved_key = None;
        self.draft = None;
        self.receipt = 0;
        self.observed = None;
        self.scope = self.store.next();
        self.edit = TextEdit::new("");
        self.position = Position::default();
    }
    pub fn activate(&mut self, active: bool) {
        if active {
            if !self.active {
                self.restore_source_scroll();
            }
            if let Some(shared) = self.draft.clone() {
                let draft = lock(&shared);
                self.sync_edit_from_draft(&draft);
            }
        }
        self.active = active;
        if !active {
            self.cancel_check();
        }
    }
    pub fn online(&mut self, online: bool) {
        self.online = online;
        if !online {
            self.cancel_check();
        }
    }
    pub fn changed(&mut self, scope: u64) {
        if scope != self.scope || !self.active {
            return;
        }
        if let (Some(key), Some(shared)) = (&self.key, &self.draft) {
            {
                let mut draft = lock(shared);
                if self.revision != draft.revision || (draft.original.is_none() && !draft.recovered)
                {
                    self.edit = TextEdit::new(&draft.text);
                    self.revision = draft.revision;
                    return;
                }
                draft.text = lf(&self.edit.text);
                draft.revision += 1;
                self.revision = draft.revision;
            }
            self.store.sync_saved(key, self.saved_key.as_ref(), shared);
        }
    }
    fn cancel_check(&mut self) {
        let id = match std::mem::replace(&mut self.intent, Intent::Idle) {
            Intent::Checking { id, .. } | Intent::Overwrite { id, .. } | Intent::Discard(id) => id,
            _ => return,
        };
        if let Some(shared) = &self.draft {
            let mut draft = lock(shared);
            if draft.pending == Some(Pending::Check(id)) {
                draft.pending = None;
            }
        }
    }
    fn ready(&self, reader: &Reader) -> bool {
        self.active
            && self.online
            && self.key.as_ref().is_some_and(|key| {
                reader.target().is_some_and(|target| {
                    target.directory == key.directory
                        && target.path == key.path
                        && target.session == self.backend.session
                })
            })
    }
    pub fn refresh(&mut self, scope: u64, reader: &mut Reader) {
        if scope != self.scope || !self.ready(reader) || self.pending() {
            return;
        }
        self.read_project();
        let Some(shared) = &self.draft else { return };
        let mut draft = lock(shared);
        if draft.dirty() {
            let id = self.store.next();
            draft.pending = Some(Pending::Check(id));
            self.intent = Intent::Discard(id);
        } else {
            self.intent = Intent::Refreshing(reader.reread());
        }
    }
    pub fn confirm(&mut self, id: u64, accepted: bool, reader: &mut Reader) {
        if !self.ready(reader) || self.confirmation().is_none_or(|prompt| prompt.id != id) {
            return;
        }
        let intent = std::mem::replace(&mut self.intent, Intent::Idle);
        let Some(shared) = self.draft.clone() else {
            return;
        };
        let mut draft = lock(&shared);
        if draft.pending != Some(Pending::Check(id)) {
            return;
        }
        draft.pending = None;
        if !accepted {
            return;
        }
        match intent {
            Intent::Overwrite { text, version, .. } => {
                drop(draft);
                self.write(id, text, version, reader);
            }
            Intent::Discard(_) => {
                draft.original = None;
                draft.version = None;
                draft.recovered = false;
                draft.text.clear();
                draft.revision += 1;
                draft.uncertain = None;
                draft.error = None;
                self.edit = TextEdit::new("");
                drop(draft);
                if let Some(key) = &self.key {
                    self.store.sync_saved(key, self.saved_key.as_ref(), &shared);
                }
                self.intent = Intent::Refreshing(reader.reread());
            }
            _ => {}
        }
    }
    pub fn poll(&mut self, reader: &mut Reader) -> bool {
        if let Some(Ok(result)) = self.project_read.as_ref().map(Receiver::try_recv) {
            self.project_read = None;
            self.project_error = result.is_err();
            if let Ok(project) = result {
                self.native_project = Some(project);
                if let Some(key) = self.key.clone() {
                    self.close();
                    self.attach(key.directory, key.path);
                }
            }
        }
        if !self.ready(reader) {
            if !self.active {
                return false;
            }
            let Some(shared) = self.draft.clone() else {
                return false;
            };
            let draft = lock(&shared);
            return self.sync_edit_from_draft(&draft);
        }
        let Some(shared) = self.draft.clone() else {
            return false;
        };
        let receipt = reader.receipt();
        let mut changed = false;
        if receipt.0 > self.receipt {
            self.receipt = receipt.0;
            changed = true;
            match std::mem::replace(&mut self.intent, Intent::Idle) {
                Intent::Checking {
                    id,
                    receipt: ticket,
                    text,
                } if receipt.0 >= ticket => self.checked(id, text, reader),
                Intent::Refreshing(ticket) if receipt.0 >= ticket => self.adopt(reader, true),
                intent => {
                    self.intent = intent;
                    self.adopt(reader, false);
                }
            }
        }
        let draft = lock(&shared);
        changed |= self.sync_edit_from_draft(&draft);
        if draft.original.is_some() || draft.recovered {
            changed |= self.position.restore_selection(&mut self.edit);
        }
        let observed = (draft.dirty(), draft.pending.is_some(), draft.error.clone());
        changed |= self.observed.as_ref() != Some(&observed);
        self.observed = Some(observed);
        changed
    }
    fn sync_edit_from_draft(&mut self, draft: &super::store::Draft) -> bool {
        if self.revision == draft.revision {
            return false;
        }
        self.position
            .viewport
            .before_text_replacement(&self.edit.text);
        let live_selection = self
            .position
            .viewport
            .mounted()
            .then(|| SavedPosition::capture(&self.edit, Default::default()));
        self.edit = TextEdit::new(&draft.text);
        if let Some(saved) = live_selection {
            saved.restore_selection(&mut self.edit);
        }
        self.revision = draft.revision;
        true
    }
    fn adopt(&mut self, reader: &Reader, refreshed: bool) {
        if !reader.receipt().1 {
            return;
        }
        if let (Some(preview), Some(shared)) = (reader.preview(), &self.draft) {
            let mut draft = lock(shared);
            let observed = version(preview.version.as_deref());
            if draft.recovered && draft.original.is_none() {
                let same = observed.is_some() && observed == draft.version;
                draft.original = disk_text(&preview.path, &preview.bytes);
                draft.error = (!same).then_some(Error::Conflict(None));
                if same {
                    draft.recovered = false;
                }
                return;
            }
            if draft.dirty()
                && !draft.recovered
                && observed != draft.version
                && draft
                    .original
                    .as_ref()
                    .is_some_and(|original| original.wire.as_bytes() == preview.bytes)
            {
                draft.version = observed.clone();
                drop(draft);
                if let Some(key) = &self.key {
                    self.store.sync_saved(key, self.saved_key.as_ref(), shared);
                }
                return;
            }
            if draft.dirty() || draft.pending.is_some() || draft.uncertain.is_some() && !refreshed {
                return;
            }
            if let Some(text) = disk_text(&preview.path, &preview.bytes) {
                if draft.text != text.text {
                    draft.text.clone_from(&text.text);
                    draft.revision += 1;
                }
                draft.original = Some(text);
                draft.version = observed;
                draft.error = None;
            } else {
                draft.original = None;
                if !draft.text.is_empty() {
                    draft.text.clear();
                    draft.revision += 1;
                }
            }
            draft.uncertain = None;
        }
    }
}
fn disk_text(path: &str, bytes: &[u8]) -> Option<Snapshot> {
    if !matches!(content(path, bytes), Content::Text { .. }) {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(Snapshot::loaded)
}
impl Drop for Editor {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
