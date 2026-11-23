use super::{
    envelope, parse_client_state, partitions, write_atomically, PersistedClientState,
    CLIENT_STATE_FILENAME,
};
use serde::Serialize;
use serde_json::Value;
use std::{fs, io::Write, path::Path};

fn legacy_candidate(
    path: &Path,
    host: &'static str,
) -> Option<(PersistedClientState, bool, i64, &'static str)> {
    let bytes = fs::read(path).ok()?;
    let Value::Object(value) = serde_json::from_slice::<Value>(&bytes).ok()? else {
        return None;
    };
    if value
        .get("version")
        .and_then(envelope::exact_nonnegative_safe_integer)
        != Some(envelope::LEGACY_MONOLITHIC_VERSION)
    {
        return None;
    }
    let saved_at = value
        .get("snapshot")
        .and_then(Value::as_object)
        .and_then(|snapshot| snapshot.get("savedAt"))
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    let mut parsed = parse_client_state(&bytes);
    if parsed.unsupported_future_envelope {
        return None;
    }
    parsed.active_mut().window = None;
    Some((parsed, value.contains_key("snapshot"), saved_at, host))
}

pub(super) fn has_future_legacy_state(
    tauri_data_dir: &Path,
    electron_data_dir: Option<&Path>,
) -> bool {
    [
        electron_data_dir.map(|path| path.join(CLIENT_STATE_FILENAME)),
        Some(tauri_data_dir.join(CLIENT_STATE_FILENAME)),
    ]
    .into_iter()
    .flatten()
    .any(|path| {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("version")
                    .and_then(envelope::exact_nonnegative_safe_integer)
            })
            .is_some_and(|version| version > envelope::LEGACY_MONOLITHIC_VERSION)
    })
}

pub(super) fn migrate_legacy_state(
    state_path: &Path,
    tauri_data_dir: &Path,
    electron_data_dir: Option<&Path>,
    ownership_valid: &dyn Fn() -> bool,
) -> Result<(), String> {
    let mut candidates = [
        electron_data_dir
            .and_then(|path| legacy_candidate(&path.join(CLIENT_STATE_FILENAME), "electron")),
        legacy_candidate(&tauri_data_dir.join(CLIENT_STATE_FILENAME), "tauri"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.0
            .active()
            .restore_enabled
            .cmp(&right.0.active().restore_enabled)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| right.3.cmp(left.3))
    });
    let Some((state, _, _, _)) = candidates.first() else {
        return Ok(());
    };
    let record = state.active();
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyState<'a> {
        version: u64,
        restore_enabled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<&'a Value>,
    }
    let bytes = serde_json::to_vec(&LegacyState {
        version: envelope::LEGACY_MONOLITHIC_VERSION,
        restore_enabled: record.restore_enabled,
        snapshot: record.snapshot.as_ref(),
    })
    .map_err(|err| err.to_string())?;
    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create shared client-state directory: {err}"))?;
    }
    write_atomically(state_path, &bytes, ownership_valid)?;
    Ok(())
}

pub(super) fn copy_legacy_shared_state(
    legacy_path: &Path,
    state_path: &Path,
    ownership_valid: &dyn Fn() -> bool,
) -> Result<(), String> {
    if state_path.exists() {
        return Ok(());
    }
    let bytes = match fs::read(legacy_path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("failed to read legacy shared client state: {err}")),
    };
    let version = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("version")
                .and_then(envelope::exact_nonnegative_safe_integer)
        });
    if version != Some(envelope::LEGACY_MONOLITHIC_VERSION)
        || parse_client_state(&bytes).unsupported_future_envelope
    {
        return Ok(());
    }
    let parent = state_path
        .parent()
        .ok_or_else(|| format!("state path has no parent: {}", state_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create shared client-state directory: {err}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|err| format!("failed to create temporary state file: {err}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|err| format!("failed to copy legacy shared client state: {err}"))?;
    if !ownership_valid() {
        return Err("Client state ownership changed before atomic replacement".to_string());
    }
    match temporary.persist_noclobber(state_path) {
        Ok(_) => partitions::sync_directory(parent),
        Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(format!(
            "failed to publish copied legacy shared client state: {}",
            err.error
        )),
    }
}
