use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(crate) const MARKER: &str = "--codenomad-automation-relaunch";
const HANDOFF: &str = "CODENOMAD_AUTOMATION_RELAUNCH";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeveloperRestart {
    pub(crate) run_id: String,
    pub(crate) native_identity: String,
    pub(crate) window_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) window_instance: Option<String>,
    pub(crate) restart_id: String,
}

impl DeveloperRestart {
    pub(crate) fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.restart_id).is_ok_and(|value| {
            value.get_version_num() == 4
                && value.get_variant() == uuid::Variant::RFC4122
                && value.to_string() == self.restart_id
        }) && crate::identity::local_window_label(&self.window_id).is_ok()
            && self
                .window_instance
                .as_ref()
                .is_none_or(|value| !value.is_empty() && value.len() <= 128)
            && !self.run_id.is_empty()
            && self.run_id.len() <= 128
            && !self.native_identity.is_empty()
            && self.native_identity.len() <= 128
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Handoff {
    pub(crate) restart: DeveloperRestart,
    pub(crate) profile: String,
    pub(crate) pinned: bool,
    pub(crate) config: Option<String>,
}

impl Handoff {
    fn parse(args: &[String], input: Option<&str>) -> Result<Option<Self>, String> {
        let Some(input) = input else { return Ok(None) };
        let launch = serde_json::from_str::<Self>(input).ok().filter(|launch| {
            args == [MARKER]
                && launch.restart.valid()
                // Keep normalized legacy keys literal, including "default".
                && (1..=255).contains(&launch.profile.len())
                && launch.profile.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
                && launch.config.as_ref().is_none_or(|path| Path::new(path).is_absolute() && !path.contains('\0'))
        });
        launch
            .map(Some)
            .ok_or_else(|| "Invalid CodeNomad automation relaunch".into())
    }

    /// Consume the private environment before any threads, plugins or child processes.
    pub(crate) fn take(args: &[String]) -> Result<Option<Self>, String> {
        let value = std::env::var_os(HANDOFF);
        std::env::remove_var(HANDOFF);
        let input = value
            .as_ref()
            .map(|value| {
                value
                    .to_str()
                    .ok_or("Invalid CodeNomad automation relaunch")
            })
            .transpose()?;
        Self::parse(args, input)
    }
}

pub(crate) struct RelaunchPlan {
    pub(crate) executable: PathBuf,
    pub(crate) handoff: Handoff,
}

impl RelaunchPlan {
    #[cfg(windows)]
    pub(crate) fn relaunch_and_exit(self, app: &tauri::AppHandle) -> ! {
        use std::process::{Command, Stdio};
        let result = serde_json::to_string(&self.handoff);
        // Clears the single-instance resource before the successor claims the same scope.
        app.cleanup_before_exit();
        match result {
            Ok(handoff) => {
                if let Err(error) = Command::new(&self.executable)
                    .arg(MARKER)
                    .env(HANDOFF, handoff)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    eprintln!("[tauri] failed to relaunch the inspected scope: {error}");
                }
            }
            Err(error) => eprintln!("[tauri] failed to prepare the scoped relaunch: {error}"),
        }
        std::process::exit(0)
    }
}

pub(crate) fn native_identity(
    profile: &str,
    config_identity: &str,
    config: Option<&str>,
    executable: &Path,
) -> String {
    let scope = format!(
        "{profile}\0{config_identity}\0{}\0{}",
        config.unwrap_or_default(),
        executable.display()
    );
    format!("tauri:{:x}", Sha256::digest(scope.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_round_trips_literal_scope_and_a_marker_alone_is_inert() {
        let args = [MARKER.into()];
        let handoff = Handoff {
            restart: DeveloperRestart {
                run_id: "old".into(),
                native_identity: "tauri:build".into(),
                window_id: "11111111-2222-4333-8444-555555555555".into(),
                window_instance: Some("incarnation".into()),
                restart_id: "7c3e5066-017d-4ce1-a371-187ac459c4b2".into(),
            },
            profile: "default".into(),
            pinned: false,
            config: None,
        };
        let encoded = serde_json::to_string(&handoff).unwrap();
        assert_eq!(
            Handoff::parse(&args, Some(&encoded)).unwrap(),
            Some(handoff)
        );
        assert_eq!(Handoff::parse(&args, None).unwrap(), None);
        assert!(Handoff::parse(&[], Some(&encoded)).is_err());
        assert!(Handoff::parse(&args, Some("{}")).is_err());
    }

    #[test]
    fn identity_binds_profile_config_source_and_executable() {
        let executable = Path::new("build-a.exe");
        let scope = native_identity("default", "config.yaml", Some("legacy.json"), executable);
        assert_ne!(
            scope,
            native_identity("stable", "config.yaml", Some("legacy.json"), executable)
        );
        assert_ne!(
            scope,
            native_identity("default", "config.yaml", Some("other.json"), executable)
        );
        assert_ne!(
            scope,
            native_identity(
                "default",
                "config.yaml",
                Some("legacy.json"),
                Path::new("build-b.exe")
            )
        );
    }
}
