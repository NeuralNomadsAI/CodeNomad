use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

pub(crate) const STABLE_IDENTIFIER: &str = "ai.neuralnomads.codenomad.client";
pub(crate) const LOCAL_WINDOW_PREFIX: &str = "local-";
const DEFAULT_CONFIG: &str = "~/.config/codenomad/config.json";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct IdentityScope {
    pub(crate) channel: String,
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

pub(crate) fn resolve_update_channel(
    explicit: Option<&str>,
    version: &str,
    packaged: bool,
) -> String {
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        let mut normalized = String::new();
        for character in value.to_ascii_lowercase().chars() {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                normalized.push(character);
            } else if !normalized.ends_with('-') {
                normalized.push('-');
            }
        }
        return normalized;
    }
    if !packaged {
        return "dev".to_string();
    }
    let lower = version.to_ascii_lowercase();
    if lower.contains("-dev-v2-") {
        "dev-v2".to_string()
    } else if lower.contains("-dev.") || lower.contains("-dev-") {
        "dev".to_string()
    } else {
        "stable".to_string()
    }
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

pub(crate) fn normalize_config_identity(raw: Option<&str>, cwd: &Path, home: &Path) -> String {
    let value = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CONFIG);
    let mut path = if value == "~" {
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
    path = lexical_normalize(path);
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

fn electron_user_data_base(home: &Path) -> PathBuf {
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
    explicit_channel: Option<&str>,
    cli_config: Option<&str>,
    version: &str,
    packaged: bool,
    cwd: &Path,
    home: &Path,
    local_data: &Path,
) -> IdentityScope {
    let channel = resolve_update_channel(explicit_channel, version, packaged);
    let config_identity = normalize_config_identity(cli_config, cwd, home);
    let default_identity = normalize_config_identity(None, cwd, home);
    let scoped = channel != "stable" || config_identity != default_identity;
    let digest = Sha256::digest(format!("{channel}\0{config_identity}").as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let scope_name = format!("{channel}-{suffix}");
    let identifier = if scoped {
        format!("{STABLE_IDENTIFIER}.scope.s{suffix}")
    } else {
        STABLE_IDENTIFIER.to_string()
    };
    let webview_root = local_data.join(format!("{STABLE_IDENTIFIER}-v2"));
    IdentityScope {
        channel,
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
    fn channel_and_default_compatibility_match_electron() {
        assert_eq!(
            resolve_update_channel(Some("Beta Channel"), "1.0.0", false),
            "beta-channel"
        );
        assert_eq!(resolve_update_channel(None, "1.0.0", false), "dev");
        assert_eq!(resolve_update_channel(None, "1.0.0-dev.2", true), "dev");
        assert_eq!(
            resolve_update_channel(None, "1.0.0-dev-v2-2", true),
            "dev-v2"
        );
        assert_eq!(resolve_update_channel(None, "1.0.0", true), "stable");
        let root = Path::new("/home/dev");
        let stable = resolve_scope(None, None, "1.0.0", true, root, root, Path::new("/local"));
        assert!(!stable.scoped);
        assert_eq!(stable.identifier, STABLE_IDENTIFIER);
        assert_eq!(stable.client_state_directory, None);
        let alternate = resolve_scope(
            None,
            Some("other/config.json"),
            "1.0.0",
            true,
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
    fn local_labels_are_lowercase_uuid_backed() {
        let id = "11111111-2222-4333-8444-555555555555";
        assert_eq!(local_window_label(id).unwrap(), format!("local-{id}"));
        assert_eq!(local_window_id(&format!("local-{id}")).unwrap(), id);
        assert!(local_window_id("remote-11111111-2222-4333-8444-555555555555").is_err());
        assert!(local_window_id("local-11111111-2222-4333-8444-AAAAAAAAAAAA").is_err());
    }
}
