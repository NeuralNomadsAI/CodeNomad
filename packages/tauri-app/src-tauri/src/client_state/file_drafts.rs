use super::{write_atomically, ClientState};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

const MAX_BYTES: usize = 256 * 1024;
const MAX_DRAFTS: usize = 32;

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
    pub(super) fn load_file_drafts(&self, window_id: &str) -> Result<Vec<Draft>, String> {
        let _write = self.write_lock.lock().map_err(|error| error.to_string())?;
        if !self.file_drafts_enabled(window_id)? {
            return Ok(Vec::new());
        }
        read(&self.file_drafts_path())
    }
    pub(super) fn save_file_draft(
        &self,
        window_id: &str,
        change: Change,
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
        if drafts
            .iter()
            .find(|draft| draft.key == change.key)
            .map(|draft| &draft.value)
            != change.expected.as_ref()
        {
            return Ok(change.draft.is_none());
        }
        drafts.retain(|draft| draft.key != change.key);
        if let Some(value) = change.draft {
            if !valid_fingerprint(&value.fingerprint)
                || value.text.len() > MAX_BYTES
                || drafts.len() >= MAX_DRAFTS
            {
                return Ok(false);
            }
            drafts.push(Draft {
                key: change.key,
                value,
            });
        }
        let bytes = serde_json::to_vec(&drafts).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Ok(false);
        }
        write_atomically(&path, &bytes, &|| self.is_primary() && current())?;
        Ok(true)
    }
}
