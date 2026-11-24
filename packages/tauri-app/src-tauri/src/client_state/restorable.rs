//! Bounded, read-only restorable-state check used by the profile transition before any profile is
//! opened. Mirrors `hasRestorableState` in Electron's `profile-transition.ts`.
use super::{cross_host, envelope};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const MAX_STATE_BYTES: u64 = 32 * 1024 * 1024;

fn restorable_record(record: &envelope::WindowRecord) -> bool {
    if !record.restore_enabled {
        return false;
    }
    // A partitioned root always references its session partition; any further key is a workspace tab.
    if let Some(keys) = &record.partition_keys {
        return keys.len() > 1;
    }
    // Legacy monolithic snapshots: sidecar-only tabs are not restorable work, as in the partitioned branch.
    record
        .snapshot
        .as_ref()
        .and_then(|snapshot| {
            snapshot
                .get("session")?
                .get("tabs")?
                .as_array()
                .map(|tabs| tabs.iter().any(|tab| tab["kind"] == "workspace"))
        })
        .unwrap_or(false)
}

/// Returns the file's modification time when it holds restorable state; unsupported files never count.
pub(crate) fn restorable_state_modified(path: &Path) -> Option<SystemTime> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_STATE_BYTES {
        return None;
    }
    let state = envelope::parse(&std::fs::read(path).ok()?);
    let restorable = !state.unsupported_future_envelope
        && state
            .window_order
            .iter()
            .any(|id| state.windows.get(id).is_some_and(restorable_record));
    restorable.then(|| metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH))
}

fn legacy_tauri_data_directory(
    platform: &str,
    environment: &impl Fn(&str) -> Option<OsString>,
    home: &str,
) -> PathBuf {
    let configured = |name: &str| {
        environment(name)
            .and_then(|value| value.into_string().ok())
            .filter(|value| !value.is_empty())
    };
    let root = match platform {
        "windows" => configured("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(home).join("AppData").join("Roaming")),
        "macos" => Path::new(home).join("Library").join("Application Support"),
        _ => configured("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(home).join(".local").join("share")),
    };
    root.join(crate::identity::STABLE_IDENTIFIER)
}

/// Default-profile client-state files in migration order: the shared current file first, then
/// the legacy files that are migrated only while it does not exist.
pub(crate) fn default_state_files_for(
    platform: &str,
    environment: impl Fn(&str) -> Option<OsString>,
    fallback_home: Option<&Path>,
    electron_user_data_base: &Path,
) -> Vec<PathBuf> {
    let Some(home) = cross_host::configured_home(platform, &environment, fallback_home) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    files.extend(
        cross_host::resolve_state_path_for(platform, &environment, fallback_home)
            .map(PathBuf::from),
    );
    files.extend(
        cross_host::resolve_legacy_state_path_for(platform, &environment, fallback_home)
            .map(PathBuf::from),
    );
    files.push(electron_user_data_base.join("client-state.json"));
    files
        .push(legacy_tauri_data_directory(platform, &environment, &home).join("client-state.json"));
    files
}

pub(crate) fn default_state_files(electron_user_data_base: &Path) -> Vec<PathBuf> {
    default_state_files_for(
        std::env::consts::OS,
        |name| std::env::var_os(name),
        dirs::home_dir().as_deref(),
        electron_user_data_base,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restorable_state_fixtures_shared_with_electron() {
        let directory = tempfile::tempdir().unwrap();
        for (index, fixture) in crate::data_profile::shared_vectors()["stateFixtures"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let path = directory.path().join(format!("{index}.json"));
            let content = fixture["raw"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| fixture["content"].to_string());
            std::fs::write(&path, content).unwrap();
            assert_eq!(
                restorable_state_modified(&path).is_some(),
                fixture["restorable"].as_bool().unwrap(),
                "{}",
                fixture["name"]
            );
        }
        assert!(restorable_state_modified(&directory.path().join("missing.json")).is_none());
    }

    #[test]
    fn default_state_files_list_current_then_legacy_locations() {
        let files = default_state_files_for(
            "linux",
            |name| (name == "HOME").then(|| OsString::from("/home/dev")),
            None,
            Path::new("/home/dev/.config/CodeNomad"),
        );
        assert_eq!(
            files,
            vec![
                PathBuf::from("/home/dev/.codenomad/client-state/v2/client-state.json"),
                PathBuf::from("/home/dev/.codenomad/client-state/client-state.json"),
                PathBuf::from("/home/dev/.config/CodeNomad/client-state.json"),
                PathBuf::from(
                    "/home/dev/.local/share/ai.neuralnomads.codenomad.client/client-state.json"
                ),
            ]
        );
    }
}
