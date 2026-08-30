use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(not(windows))]
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

pub(super) const PROTOCOL_VERSION: u64 = 1;
pub(super) const MAX_ROOT_BYTES: usize = 1024 * 1024;
const MAX_PARTITION_BYTES: usize = 1024 * 1024;
pub(super) const MAX_COMMIT_BYTES: usize = 256 * 1024 * 1024;
const MAX_PARTITION_KEYS: usize = 4096;
const PARTITION_DIRECTORY: &str = "partitions";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PartitionCommit {
    protocol_version: Value,
    pub(super) snapshot: Value,
    partitions: HashMap<String, String>,
    partition_keys: Vec<String>,
}

pub(super) struct ValidatedCommit {
    pub(super) snapshot: Value,
    partitions: HashMap<String, String>,
    pub(super) partition_keys: Vec<String>,
}

pub(super) fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn validate_keys(value: &Value) -> Option<Vec<String>> {
    let values = value.as_array()?;
    if values.len() > MAX_PARTITION_KEYS {
        return None;
    }
    let mut keys: Vec<String> = Vec::with_capacity(values.len());
    for value in values {
        let key = value.as_str()?;
        if !valid_key(key) || keys.last().is_some_and(|previous| previous.as_str() >= key) {
            return None;
        }
        keys.push(key.to_string());
    }
    Some(keys)
}

pub(super) fn validate_root(value: &Value) -> Option<Vec<String>> {
    let root = value.as_object()?;
    if super::envelope::exact_nonnegative_safe_integer(root.get("version")?) != Some(2) {
        return None;
    }
    let session_partition = root.get("sessionPartition")?.as_str()?;
    if !valid_key(session_partition) {
        return None;
    }
    let partition_keys = validate_keys(root.get("partitionKeys")?)?;
    partition_keys
        .iter()
        .any(|key| key == session_partition)
        .then_some(partition_keys)
}

impl PartitionCommit {
    pub(super) fn validate(self) -> Result<ValidatedCommit, String> {
        if super::envelope::exact_nonnegative_safe_integer(&self.protocol_version)
            != Some(PROTOCOL_VERSION)
        {
            return Err("Unsupported client state partition protocol".to_string());
        }
        if self.partition_keys.len() > MAX_PARTITION_KEYS
            || self.partitions.len() > MAX_PARTITION_KEYS
        {
            return Err("Too many client state partitions".to_string());
        }
        let partition_keys_value = Value::Array(
            self.partition_keys
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        );
        let Some(payload_keys) = validate_keys(&partition_keys_value) else {
            return Err("Invalid client state partition keys".to_string());
        };
        let Some(root_keys) = validate_root(&self.snapshot) else {
            return Err("Invalid client state partition root".to_string());
        };
        if root_keys != payload_keys {
            return Err("Client state root partition keys do not match the commit".to_string());
        }
        let mut supplied_keys = self.partitions.keys().collect::<Vec<_>>();
        supplied_keys.sort();
        if supplied_keys.len() != root_keys.len()
            || supplied_keys
                .iter()
                .zip(&root_keys)
                .any(|(supplied, expected)| supplied.as_str() != expected)
        {
            return Err("Client state partitions do not match the root".to_string());
        }
        let root_size = serde_json::to_vec(&self.snapshot)
            .map_err(|err| err.to_string())?
            .len();
        if root_size > MAX_ROOT_BYTES {
            return Err("Client state root exceeds the 1 MiB limit".to_string());
        }
        let mut commit_size = root_size;
        for (key, content) in &self.partitions {
            if !valid_key(key) {
                return Err("Invalid client state partition reference".to_string());
            }
            if content.len() > MAX_PARTITION_BYTES {
                return Err("Client state partition exceeds the 1 MiB limit".to_string());
            }
            commit_size = commit_size.checked_add(content.len()).ok_or_else(|| {
                "Client state partition commit exceeds the 256 MiB limit".to_string()
            })?;
            if commit_size > MAX_COMMIT_BYTES {
                return Err("Client state partition commit exceeds the 256 MiB limit".to_string());
            }
            if hex_digest(content.as_bytes()) != *key {
                return Err("Client state partition digest mismatch".to_string());
            }
        }
        Ok(ValidatedCommit {
            snapshot: self.snapshot,
            partitions: self.partitions,
            partition_keys: root_keys,
        })
    }
}

pub(super) struct PartitionStore {
    directory: PathBuf,
}

impl PartitionStore {
    pub(super) fn new(root: &Path) -> Self {
        Self {
            directory: root.join(PARTITION_DIRECTORY),
        }
    }

    pub(super) fn prepare(
        &self,
        commit: &ValidatedCommit,
        authority_valid: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|err| err.to_string())?;
        self.validate_directory(false)?;
        let mut published = false;
        for (key, content) in &commit.partitions {
            published |= self.write_immutable(key, content.as_bytes(), authority_valid)?;
        }
        if published {
            self.validate_directory(false)?;
            sync_directory(&self.directory)?;
            authority(authority_valid)?;
        }
        for key in &commit.partition_keys {
            let content = self.read_verified(key)?;
            authority(authority_valid)?;
            if content.is_none() {
                return Err(format!("Missing client state partition {key}"));
            }
        }
        Ok(())
    }

    pub(super) fn load(
        &self,
        key: &str,
        authority_valid: &dyn Fn() -> bool,
    ) -> Result<Option<String>, String> {
        if !self.validate_directory(true)? {
            return Ok(None);
        }
        let result = self.read_verified(key)?;
        authority(authority_valid)?;
        Ok(result)
    }

    pub(super) fn sweep(
        &self,
        partition_keys: &[String],
        authority_valid: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        if !self.validate_directory(true)? {
            return Ok(());
        }
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.to_string()),
        };
        authority(authority_valid)?;
        let retained = partition_keys
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        for entry in entries {
            let entry = entry.map_err(|err| err.to_string())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !valid_key(name) || retained.contains(name) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|err| err.to_string())?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            fs::remove_file(entry.path()).map_err(|err| err.to_string())?;
            authority(authority_valid)?;
        }
        Ok(())
    }

    fn validate_directory(&self, allow_missing: bool) -> Result<bool, String> {
        match fs::symlink_metadata(&self.directory) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
                Ok(true)
            }
            Ok(_) => Err("Invalid client state partition directory".to_string()),
            Err(err) if allow_missing && err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(err.to_string()),
        }
    }

    fn read_verified(&self, key: &str) -> Result<Option<String>, String> {
        let path = self.directory.join(key);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_file() => return Ok(None),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.to_string()),
        }
        match fs::read(path) {
            Ok(bytes) if bytes.len() <= MAX_PARTITION_BYTES && hex_digest(&bytes) == key => {
                String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|err| err.to_string())
            }
            Ok(_) => Ok(None),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn write_immutable(
        &self,
        key: &str,
        bytes: &[u8],
        authority_valid: &dyn Fn() -> bool,
    ) -> Result<bool, String> {
        if self.read_verified(key)?.is_some() {
            authority(authority_valid)?;
            return Ok(false);
        }
        let path = self.directory.join(key);
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err(format!("Invalid existing client state partition {key}")),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.to_string()),
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|err| err.to_string())?;
        temporary
            .write_all(bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|err| err.to_string())?;
        authority(authority_valid)?;
        let published = match temporary.persist_noclobber(&path) {
            Ok(_) => true,
            Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if self.read_verified(key)?.is_none() {
                    return Err(format!("Invalid existing client state partition {key}"));
                }
                false
            }
            Err(err) => return Err(err.error.to_string()),
        };
        authority(authority_valid)?;
        Ok(published)
    }
}

fn authority(authority_valid: &dyn Fn() -> bool) -> Result<(), String> {
    if authority_valid() {
        Ok(())
    } else {
        Err("Client state authority changed during partition I/O".to_string())
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(not(windows))]
pub(super) fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|err| err.to_string())
}

#[cfg(windows)]
pub(super) fn sync_directory(_path: &Path) -> Result<(), String> {
    // Windows std::fs cannot open directories; synced files plus atomic publication are the stdlib limit.
    Ok(())
}
