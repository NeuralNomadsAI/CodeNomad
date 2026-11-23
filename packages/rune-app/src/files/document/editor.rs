use super::{
    Content, content,
    source_text::{Snapshot, lf},
    store::{Error, Key, Pending, Shared, Store, Writes, lock},
};
use crate::{files::reader::Reader, platform};
use codenomad_client::{
    Wake,
    backend::Backend,
    files::{MAX_FILE_BYTES, WriteResult},
};
use rune::TextEdit;

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
    wake: Wake,
    key: Option<Key>,
    draft: Option<Shared>,
    intent: Intent,
    receipt: u64,
    active: bool,
    online: bool,
    observed: Option<(bool, bool, Option<Error>)>,
    scope: u64,
    revision: u64,
    edit: TextEdit,
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
            wake,
            key: None,
            draft: None,
            intent: Intent::Idle,
            receipt: 0,
            active: true,
            online: false,
            observed: None,
            scope: 0,
            revision: 0,
            edit: TextEdit::new(""),
            rejected: TextEdit::new(""),
        }
    }
    pub fn key(&self) -> Option<&Key> {
        self.key.as_ref()
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
    pub fn editable(&self) -> bool {
        self.active
            && self
                .draft
                .as_ref()
                .is_some_and(|draft| lock(draft).original.is_some())
    }
    pub fn writable(&self) -> bool {
        self.editable() && self.online && self.dirty() && !self.pending()
    }
    pub fn input(&mut self, scope: u64) -> &mut TextEdit {
        self.rejected = TextEdit::new("");
        if scope != self.scope
            || !self.active
            || self
                .draft
                .as_ref()
                .is_none_or(|draft| lock(draft).original.is_none())
        {
            &mut self.rejected
        } else {
            &mut self.edit
        }
    }
    pub fn open(&mut self, directory: String, path: String) {
        self.close();
        let key = Key {
            server: self.backend.base.clone(),
            instance: self.instance.clone(),
            directory,
            path,
        };
        let draft = self.store.open(&key);
        self.edit = TextEdit::new(&lock(&draft).text);
        self.revision = lock(&draft).revision;
        self.draft = Some(draft);
        self.key = Some(key);
    }
    pub fn close(&mut self) {
        self.cancel_check();
        if let (Some(key), Some(draft)) = (&self.key, &self.draft) {
            self.store.sync(key, draft);
        }
        self.key = None;
        self.draft = None;
        self.receipt = 0;
        self.observed = None;
        self.scope = self.store.next();
        self.edit = TextEdit::new("");
    }
    pub fn activate(&mut self, active: bool) {
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
                if draft.original.is_none() {
                    self.edit = TextEdit::new(&draft.text);
                    return;
                }
                draft.text = lf(&self.edit.text);
                draft.revision += 1;
                self.revision = draft.revision;
            }
            self.store.sync(key, shared);
        }
    }
    fn cancel_check(&mut self) {
        self.intent = Intent::Idle;
        if let Some(shared) = &self.draft {
            let mut draft = lock(shared);
            if matches!(draft.pending, Some(Pending::Check(_))) {
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
    pub fn save(&mut self, scope: u64, reader: &mut Reader) {
        if scope != self.scope || !self.ready(reader) {
            return;
        }
        let Some(shared) = &self.draft else { return };
        let mut draft = lock(shared);
        if draft.pending.is_some() || !draft.dirty() {
            return;
        }
        let Some(original) = &draft.original else {
            return;
        };
        if draft.text.len() > MAX_FILE_BYTES {
            draft.error = Some(Error::TooLarge);
            return;
        }
        let text = original.edited(&draft.text);
        if text.wire.len() > MAX_FILE_BYTES {
            draft.error = Some(Error::TooLarge);
            return;
        }
        let id = self.store.next();
        draft.pending = Some(Pending::Check(id));
        draft.error = None;
        self.intent = Intent::Checking {
            id,
            receipt: reader.reread(),
            text,
        };
        drop(draft);
        if let Some(key) = &self.key {
            self.store.sync(key, shared);
        }
    }
    pub fn refresh(&mut self, scope: u64, reader: &mut Reader) {
        if scope != self.scope || !self.ready(reader) || self.pending() {
            return;
        }
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
                draft.text.clear();
                draft.revision += 1;
                draft.uncertain = None;
                draft.error = None;
                self.edit = TextEdit::new("");
                drop(draft);
                if let Some(key) = &self.key {
                    self.store.sync(key, &shared);
                }
                self.intent = Intent::Refreshing(reader.reread());
            }
            _ => {}
        }
    }
    pub fn poll(&mut self, reader: &mut Reader) -> bool {
        if !self.ready(reader) {
            return false;
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
        if self.revision != draft.revision {
            self.edit = TextEdit::new(&draft.text);
            self.revision = draft.revision;
            changed = true;
        }
        let observed = (draft.dirty(), draft.pending.is_some(), draft.error.clone());
        changed |= self.observed.as_ref() != Some(&observed);
        self.observed = Some(observed);
        changed
    }
    fn adopt(&mut self, reader: &Reader, refreshed: bool) {
        if !reader.receipt().1 {
            return;
        }
        if let (Some(preview), Some(shared)) = (reader.preview(), &self.draft) {
            let mut draft = lock(shared);
            if draft.dirty() || draft.pending.is_some() || draft.uncertain.is_some() && !refreshed {
                return;
            }
            if let Some(text) = disk_text(&preview.path, &preview.bytes) {
                if draft.text != text.text {
                    draft.text.clone_from(&text.text);
                    draft.revision += 1;
                }
                draft.original = Some(text);
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
    fn checked(&mut self, id: u64, text: Snapshot, reader: &mut Reader) {
        let Some(shared) = self.draft.clone() else {
            return;
        };
        let mut draft = lock(&shared);
        if draft.pending != Some(Pending::Check(id)) {
            return;
        }
        draft.pending = None;
        if !reader.receipt().1 {
            draft.error = Some(Error::Read);
            return;
        }
        let Some(preview) = reader.preview() else {
            draft.error = Some(Error::Read);
            return;
        };
        let Some(disk) = disk_text(&preview.path, &preview.bytes) else {
            draft.error = Some(Error::ReadOnly);
            return;
        };
        if draft
            .uncertain
            .as_ref()
            .is_some_and(|saved| saved.wire == disk.wire)
        {
            draft.original = draft.uncertain.take();
        }
        if disk.wire == text.wire {
            draft.original = Some(text);
            draft.uncertain = None;
            draft.error = None;
            drop(draft);
            if let Some(key) = &self.key {
                self.store.sync(key, &shared);
            }
            *lock(&self.writes) += 1;
            return;
        }
        let Some(version) = preview
            .version
            .as_ref()
            .filter(|version| !version.is_empty())
        else {
            draft.error = Some(Error::MissingVersion);
            return;
        };
        if draft
            .original
            .as_ref()
            .is_none_or(|original| original.wire != disk.wire)
        {
            draft.pending = Some(Pending::Check(id));
            self.intent = Intent::Overwrite {
                id,
                text,
                version: version.clone(),
            };
        } else {
            drop(draft);
            self.write(id, text, version.clone(), reader);
        }
    }
    fn write(&mut self, id: u64, text: Snapshot, version: String, reader: &mut Reader) {
        let (Some(key), Some(shared)) = (self.key.clone(), self.draft.clone()) else {
            return;
        };
        lock(&shared).pending = Some(Pending::Write(id));
        reader.activate(false);
        let (backend, store, wake, writes) = (
            self.backend.clone(),
            self.store.clone(),
            self.wake.clone(),
            self.writes.clone(),
        );
        platform::spawn(async move {
            let result = backend
                .write_file(&key.directory, &key.path, &text.wire, &version)
                .await;
            let saved = matches!(&result, Ok(WriteResult::Saved));
            {
                let mut draft = lock(&shared);
                if draft.pending != Some(Pending::Write(id)) {
                    return;
                }
                draft.pending = None;
                match result {
                    Ok(WriteResult::Saved) => {
                        draft.original = Some(text);
                        draft.uncertain = None;
                        draft.error = None;
                    }
                    Ok(WriteResult::Conflict(reason)) => {
                        draft.error = Some(Error::Conflict(reason))
                    }
                    Err(_) => {
                        draft.uncertain = Some(text);
                        draft.error = Some(Error::Uncertain);
                    }
                }
            }
            store.sync(&key, &shared);
            if saved {
                *lock(&writes) += 1;
            }
            wake();
        });
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
