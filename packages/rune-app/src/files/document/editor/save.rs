use super::version as fingerprint;
use super::{Editor, Error, Intent, Pending, Reader, Snapshot, disk_text, lock, platform};
use codenomad_client::files::{FileError, MAX_FILE_BYTES, WriteResult};

impl Editor {
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
        if !matches!(draft.error, Some(Error::Conflict(_))) {
            draft.error = None;
        }
        self.intent = Intent::Checking {
            id,
            receipt: reader.reread(),
            text,
        };
        drop(draft);
        if let Some(key) = &self.key {
            self.store.sync_saved(key, self.saved_key.as_ref(), shared);
        }
    }

    pub(super) fn checked(&mut self, id: u64, text: Snapshot, reader: &mut Reader) {
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
            draft.version = fingerprint(preview.version.as_deref());
            draft.recovered = false;
            draft.uncertain = None;
            draft.error = None;
            drop(draft);
            if let Some(key) = &self.key {
                self.store.sync_saved(key, self.saved_key.as_ref(), &shared);
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
        if draft.recovered && draft.version.as_ref() != Some(version)
            || draft
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

    pub(super) fn write(&mut self, id: u64, text: Snapshot, version: String, reader: &mut Reader) {
        let (Some(key), Some(shared)) = (self.key.clone(), self.draft.clone()) else {
            return;
        };
        lock(&shared).pending = Some(Pending::Write(id));
        reader.activate(false);
        let (backend, store, wake, writes, saved_key) = (
            self.backend.clone(),
            self.store.clone(),
            self.wake.clone(),
            self.writes.clone(),
            self.saved_key.clone(),
        );
        platform::spawn(async move {
            let result = backend
                .write_file(&key.directory, &key.path, &text.wire, &version)
                .await;
            let saved = matches!(&result, Ok(WriteResult::Saved(_)));
            {
                let mut draft = lock(&shared);
                if draft.pending != Some(Pending::Write(id)) {
                    return;
                }
                draft.pending = None;
                match result {
                    Ok(WriteResult::Saved(saved_version)) => {
                        draft.original = Some(text);
                        draft.version = fingerprint(saved_version.as_deref());
                        draft.recovered = false;
                        draft.uncertain = None;
                        draft.error = None;
                    }
                    Ok(WriteResult::Conflict(conflict)) => {
                        draft.error = Some(Error::Conflict(conflict))
                    }
                    Err(error) => match error.downcast_ref::<FileError>() {
                        Some(FileError::TooLarge) => draft.error = Some(Error::TooLarge),
                        Some(FileError::AccessDenied) => draft.error = Some(Error::AccessDenied),
                        Some(FileError::Unauthorized) => draft.error = Some(Error::Unauthorized),
                        Some(FileError::NotFound) => draft.error = Some(Error::NotFound),
                        Some(FileError::WorkspaceUnavailable) => {
                            draft.error = Some(Error::WorkspaceUnavailable);
                        }
                        _ => {
                            draft.uncertain = Some(text);
                            draft.error = Some(Error::Uncertain);
                        }
                    },
                }
            }
            store.sync_saved(&key, saved_key.as_ref(), &shared);
            if saved {
                *lock(&writes) += 1;
            }
            wake();
        });
    }
}
