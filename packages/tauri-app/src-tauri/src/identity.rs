use crate::{data_profile, profile_transition};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub(crate) const STABLE_IDENTIFIER: &str = "ai.neuralnomads.codenomad.client";
pub(crate) const LOCAL_WINDOW_PREFIX: &str = "local-";
const DEFAULT_CONFIG: &str = "~/.config/codenomad/config.json";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct IdentityScope {
    /// Profile storage key; `stable` is the default profile (see data_profile.rs).
    pub(crate) profile: String,
    pub(crate) config_identity: String,
    pub(crate) suffix: String,
    pub(crate) scoped: bool,
    pub(crate) identifier: String,
    pub(crate) client_state_directory: Option<PathBuf>,
    pub(crate) webview_data_directory: PathBuf,
}

pub(crate) fn local_window_label(window_id: &str) -> Result<String, String> {
    let uuid =
        uuid::Uuid::parse_str(window_id).map_err(|_| "Invalid local window UUID".to_string())?;
    let normalized = uuid.to_string();
    if normalized != window_id {
        return Err("Local window UUID must be lowercase".to_string());
    }
    Ok(format!("{LOCAL_WINDOW_PREFIX}{normalized}"))
}

pub(crate) fn local_window_id(label: &str) -> Result<String, String> {
    let id = label
        .strip_prefix(LOCAL_WINDOW_PREFIX)
        .ok_or_else(|| "Native operation is limited to local windows".to_string())?;
    local_window_label(id)?;
    Ok(id.to_string())
}

#[derive(Debug)]
pub(crate) enum LaunchProfile {
    Ready(String),
    Ask {
        candidates: Vec<profile_transition::Candidate>,
        lock: profile_transition::SelectionLock,
        context: profile_transition::TransitionContext,
    },
}

/// Resolves the data profile before the identifier, singleton or WebView data directory is fixed.
/// Explicit settings win; packaged launches without them use the one-time transition.
pub(crate) fn resolve_launch_profile(
    profile: Option<&str>,
    legacy_channel: Option<&str>,
    cli_config: Option<&str>,
    packaged: bool,
    cwd: &Path,
    home: &Path,
) -> Result<LaunchProfile, String> {
    if let Some(explicit) =
        data_profile::resolve_explicit_profile(profile, legacy_channel, packaged)?
    {
        return Ok(LaunchProfile::Ready(explicit.key));
    }
    let user_data_base = electron_user_data_base(home);
    let context = profile_transition::TransitionContext {
        config_identity: normalize_config_identity(cli_config, cwd, home),
        default_identity: normalize_config_identity(None, cwd, home),
        default_state_files: crate::client_state::default_state_files(&user_data_base),
        user_data_base,
    };
    Ok(
        match profile_transition::resolve_transition_profile(
            &context,
            SystemTime::now,
            std::thread::sleep,
        )
        .map_err(|error| format!("Unable to select the CodeNomad data profile: {error}"))?
        {
            profile_transition::TransitionResult::Resolved { key, reason } => {
                eprintln!(
                    "[startup] data profile {} ({reason:?})",
                    data_profile::profile_display_name(&key)
                );
                LaunchProfile::Ready(key)
            }
            profile_transition::TransitionResult::Ask { candidates, lock } => LaunchProfile::Ask {
                candidates,
                lock,
                context,
            },
        },
    )
}

fn lexical_normalize(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push("..");
                }
            }
            value => normalized.push(value.as_os_str()),
        }
    }
    normalized
}

fn resolve_config_input(value: &str, cwd: &Path, home: &Path) -> PathBuf {
    let path = if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    lexical_normalize(path)
}

/** Keep the caller's original filename for backend config/legacy migration,
 * but remove dependence on the backend process's different working directory. */
pub(crate) fn resolve_selected_config(raw: Option<&str>, cwd: &Path, home: &Path) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| resolve_config_input(value, cwd, home).to_string_lossy().into_owned())
}

pub(crate) fn normalize_config_identity(raw: Option<&str>, cwd: &Path, home: &Path) -> String {
    let value = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CONFIG);
    let mut path = resolve_config_input(value, cwd, home);
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        path.set_file_name("config.yaml");
    } else if !path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("yaml") || extension.eq_ignore_ascii_case("yml")
    }) {
        path.push("config.yaml");
    }
    let identity = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        identity.replace('/', "\\").to_ascii_lowercase()
    } else {
        identity
    }
}

pub(crate) fn electron_user_data_base(home: &Path) -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("CodeNomad")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/CodeNomad")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("CodeNomad")
    }
}

pub(crate) fn resolve_scope(
    profile: &str,
    cli_config: Option<&str>,
    cwd: &Path,
    home: &Path,
    local_data: &Path,
) -> IdentityScope {
    let config_identity = normalize_config_identity(cli_config, cwd, home);
    let default_identity = normalize_config_identity(None, cwd, home);
    let data_profile::ProfileScope {
        scoped,
        suffix,
        scope_name,
    } = data_profile::profile_scope(profile, &config_identity, &default_identity);
    let identifier = if scoped {
        format!("{STABLE_IDENTIFIER}.scope.s{suffix}")
    } else {
        STABLE_IDENTIFIER.to_string()
    };
    let webview_root = local_data.join(format!("{STABLE_IDENTIFIER}-v2"));
    IdentityScope {
        profile: profile.to_string(),
        config_identity,
        suffix,
        scoped,
        identifier,
        client_state_directory: scoped.then(|| {
            electron_user_data_base(home)
                .join("scopes")
                .join(&scope_name)
                .join("client-state")
        }),
        webview_data_directory: if scoped {
            webview_root.join("scopes").join(scope_name)
        } else {
            webview_root
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_profile_keeps_unscoped_paths_and_named_profiles_are_scoped() {
        let root = Path::new("/home/dev");
        let stable = resolve_scope("stable", None, root, root, Path::new("/local"));
        assert!(!stable.scoped);
        assert_eq!(stable.identifier, STABLE_IDENTIFIER);
        assert_eq!(stable.client_state_directory, None);
        assert_eq!(
            stable.webview_data_directory,
            Path::new("/local").join(format!("{STABLE_IDENTIFIER}-v2"))
        );
        let dev = resolve_scope("dev", None, root, root, Path::new("/local"));
        assert!(dev.scoped);
        assert_eq!(
            dev.identifier,
            format!("{STABLE_IDENTIFIER}.scope.s{}", dev.suffix)
        );
        assert!(dev
            .webview_data_directory
            .ends_with(Path::new("scopes").join(format!("dev-{}", dev.suffix))));
        let alternate = resolve_scope(
            "stable",
            Some("other/config.json"),
            root,
            root,
            Path::new("/local"),
        );
        assert!(alternate.scoped);
        assert!(alternate
            .identifier
            .starts_with(&format!("{STABLE_IDENTIFIER}.scope.s")));
        assert!(alternate
            .client_state_directory
            .unwrap()
            .ends_with(Path::new("client-state")));
    }

    #[test]
    fn explicit_launch_profiles_never_consult_the_transition() {
        let root = Path::new("/nonexistent-codenomad-home");
        let ready = |profile, channel, packaged| match resolve_launch_profile(
            profile, channel, None, packaged, root, root,
        )
        .unwrap()
        {
            LaunchProfile::Ready(key) => key,
            LaunchProfile::Ask { .. } => panic!("unexpected question"),
        };
        assert_eq!(ready(Some("Team"), Some("dev"), true), "team");
        assert_eq!(ready(None, Some("dev-v2"), true), "dev-v2");
        assert_eq!(ready(None, None, false), "dev");
        assert!(
            resolve_launch_profile(Some("not a profile"), None, None, true, root, root).is_err()
        );
    }

    #[test]
    fn config_json_and_yaml_have_one_semantic_identity() {
        let cwd = Path::new("/work");
        let home = Path::new("/home/dev");
        assert_eq!(
            normalize_config_identity(Some("config.json"), cwd, home),
            normalize_config_identity(Some("config.yaml"), cwd, home)
        );
        assert_eq!(
            normalize_config_identity(Some("../work/./config.json"), cwd, home),
            normalize_config_identity(Some("config.yaml"), cwd, home)
        );
    }

    #[test]
    fn selected_relative_config_keeps_legacy_filename_with_startup_cwd_and_home() {
        let cwd = std::env::current_dir().unwrap();
        let home = cwd.join("profile-home");
        for extension in ["json", "yaml"] {
            let raw = format!("alternate/../selected/custom.{extension}");
            let selected = resolve_selected_config(Some(&raw), &cwd, &home).unwrap();
            assert_eq!(PathBuf::from(&selected), cwd.join("selected").join(format!("custom.{extension}")));
            if extension == "json" {
                assert_ne!(selected, normalize_config_identity(Some(&raw), &cwd, &home));
            }
            assert_eq!(
                resolve_selected_config(Some(&format!("~/selected/custom.{extension}")), &cwd, &home),
                Some(home.join("selected").join(format!("custom.{extension}")).to_string_lossy().into_owned())
            );
        }
        assert_eq!(resolve_selected_config(None, &cwd, &home), None);
    }

    #[test]
    fn local_labels_are_lowercase_uuid_backed() {
        let id = "11111111-2222-4333-8444-555555555555";
        assert_eq!(local_window_label(id).unwrap(), format!("local-{id}"));
        assert_eq!(local_window_id(&format!("local-{id}")).unwrap(), id);
        assert!(local_window_id("remote-11111111-2222-4333-8444-555555555555").is_err());
        assert!(local_window_id("local-11111111-2222-4333-8444-AAAAAAAAAAAA").is_err());
    }
}
