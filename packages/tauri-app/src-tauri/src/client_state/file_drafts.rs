use super::{write_atomically, ClientState};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_BYTES: usize = 256 * 1024;
const MAX_DRAFTS: usize = 32;
pub(super) type Readers = Mutex<HashMap<String, (Option<u64>, HashSet<String>)>>;

#[derive(Deserialize, Serialize)]
pub struct Draft {
    key: String,
    #[serde(flatten)]
    value: Text,
}

#[derive(Deserialize, Serialize, PartialEq)]
struct Text {
    fingerprint: String,
    text: String,
}

#[derive(Deserialize)]
pub struct Change {
    key: String,
    draft: Option<Text>,
    expected: Option<Text>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.encode_utf16().count() <= 16 * 1024
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn read(path: &Path) -> Result<Vec<Draft>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Ok(Vec::new());
    }
    let drafts: Vec<Draft> = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(drafts
        .into_iter()
        .take(MAX_DRAFTS)
        .filter(|row| valid_key(&row.key) && valid_fingerprint(&row.value.fingerprint))
        .collect())
}

impl ClientState {
    fn file_drafts_path(&self) -> PathBuf {
        self.state_path.with_file_name("workspace-file-drafts.json")
    }
    fn file_drafts_enabled(&self, window_id: &str) -> Result<bool, String> {
        if !self.is_primary() {
            return Ok(false);
        }
        Ok(self
            .state
            .lock()
            .map_err(|error| error.to_string())?
            .record(window_id)?
            .restore_enabled)
    }
    #[cfg(test)]
    pub(super) fn load_file_drafts(&self, window_id: &str) -> Result<Vec<Draft>, String> {
        self.load_file_drafts_for(window_id, None, 0)
    }

    pub(super) fn load_file_drafts_for(
        &self,
        window_id: &str,
        key: Option<&str>,
        generation: u64,
    ) -> Result<Vec<Draft>, String> {
        let _write = self.write_lock.lock().map_err(|error| error.to_string())?;
        if !self.file_drafts_enabled(window_id)? {
            return Ok(Vec::new());
        }
        let mut drafts = read(&self.file_drafts_path())?;
        if let Some(key) = key {
            drafts.retain(|draft| draft.key == key);
            if !self
                .renderer_access
                .is_generation_current_for(window_id, generation)
            {
                return Err("File draft renderer changed".into());
            }
            if !drafts.is_empty() {
                self.retain_file_draft(window_id, generation, key)?;
            }
        }
        Ok(drafts)
    }

    fn retain_file_draft(&self, window_id: &str, generation: u64, key: &str) -> Result<(), String> {
        let mut readers = self
            .file_draft_readers
            .lock()
            .map_err(|error| error.to_string())?;
        readers.retain(|id, (generation, _)| {
            generation.is_none_or(|generation| {
                self.renderer_access
                    .is_generation_current_for(id, generation)
            })
        });
        let (_, keys) = readers
            .entry(window_id.into())
            .or_insert_with(|| (Some(generation), HashSet::new()));
        keys.insert(key.into());
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn save_file_draft(
        &self,
        window_id: &str,
        change: Change,
        current: impl Fn() -> bool,
    ) -> Result<bool, String> {
        self.save_file_draft_for(window_id, change, None, current)
    }

    pub(super) fn save_file_draft_for(
        &self,
        window_id: &str,
        change: Change,
        generation: Option<u64>,
        current: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let _write = self.write_lock.lock().map_err(|error| error.to_string())?;
        let enabled = self.file_drafts_enabled(window_id)?;
        if !current()
            || !self.is_primary()
            || (!enabled && change.draft.is_some())
            || !valid_key(&change.key)
        {
            return Ok(false);
        }
        let path = self.file_drafts_path();
        let mut drafts = read(&path)?;
        if !current() {
            return Ok(false);
        }
        if change.draft.is_none() {
            let mut readers = self
                .file_draft_readers
                .lock()
                .map_err(|error| error.to_string())?;
            readers.retain(|id, (generation, _)| {
                generation.is_none_or(|generation| {
                    self.renderer_access
                        .is_generation_current_for(id, generation)
                })
            });
            if let Some((_, keys)) = readers.get_mut(window_id) {
                keys.remove(&change.key);
            }
            if readers.values().any(|(_, keys)| keys.contains(&change.key)) {
                return Ok(true);
            }
        }
        if drafts
            .iter()
            .find(|draft| draft.key == change.key)
            .map(|draft| &draft.value)
            != change.expected.as_ref()
        {
            return Ok(change.draft.is_none());
        }
        drafts.retain(|draft| draft.key != change.key);
        let retain = change.draft.is_some();
        if let Some(value) = change.draft {
            if !valid_fingerprint(&value.fingerprint)
                || value.text.len() > MAX_BYTES
                || drafts.len() >= MAX_DRAFTS
            {
                return Ok(false);
            }
            drafts.push(Draft {
                key: change.key.clone(),
                value,
            });
        }
        let bytes = serde_json::to_vec(&drafts).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Ok(false);
        }
        write_atomically(&path, &bytes, &|| self.is_primary() && current())?;
        if let Some(generation) = generation.filter(|_| retain && current()) {
            self.retain_file_draft(window_id, generation, &change.key)?;
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use url::Url;

    #[test]
    fn other_renderer_cannot_discard_a_draft_held_by_a_live_reader() {
        let directory = tempfile::tempdir().unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        state.set_restore_enabled(true).unwrap();
        let a = state.active_window_id().unwrap();
        let b = "11111111-1111-4111-8111-111111111111";
        assert!(state.add_window(b.into()).unwrap());
        let url = Url::parse("http://127.0.0.1:43123/workspace").unwrap();
        state.renderer_access.claim_for(&a, "a", &url).unwrap();
        let generation = state.renderer_access.validate_for(&a, "a", &url).unwrap();
        let draft = json!({"fingerprint": "0".repeat(64), "text": "draft"});
        let save = serde_json::from_value(json!({"key": "file", "expected": null, "draft": draft}))
            .unwrap();
        assert!(state.save_file_draft(b, save, || true).unwrap());
        assert_eq!(
            state
                .load_file_drafts_for(&a, Some("file"), generation)
                .unwrap()
                .len(),
            1
        );
        let discard = || {
            serde_json::from_value(json!({"key": "file", "expected": draft, "draft": null}))
                .unwrap()
        };
        assert!(state.remove_window(&a).unwrap());
        assert!(state.save_file_draft(b, discard(), || true).unwrap());
        assert_eq!(state.load_file_drafts(b).unwrap().len(), 1);
        state.unregister_window(&a);
        assert!(state.save_file_draft(b, discard(), || true).unwrap());
        assert!(state.load_file_drafts(b).unwrap().is_empty());
    }
}
