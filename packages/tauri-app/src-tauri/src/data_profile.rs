//! Desktop data profiles, mirrored by Electron's `data-profile.ts`. The installed version never
//! selects a profile: packaged builds use the default profile (after the one-time transition in
//! `profile_transition.rs`) and developers isolate data explicitly with `CODENOMAD_PROFILE`.
//! See dev-docs/DESKTOP_DATA_PROFILES.md.
use sha2::{Digest, Sha256};

pub(crate) const PROFILE_ENVIRONMENT: &str = "CODENOMAD_PROFILE";
pub(crate) const LEGACY_CHANNEL_ENVIRONMENT: &str = "CODENOMAD_UPDATE_CHANNEL";
/// Set by the host on the backend it launches; present only for non-default profiles.
pub(crate) const BACKEND_PROFILE_ENVIRONMENT: &str = "CODENOMAD_DESKTOP_PROFILE";

/// Storage key of the default profile; it keeps the historical unscoped locations.
pub(crate) const DEFAULT_PROFILE_KEY: &str = "stable";
pub(crate) const DEFAULT_PROFILE_NAME: &str = "default";
/// Profiles that older packaged builds selected automatically from their version label.
pub(crate) const TRANSITION_PROFILE_KEYS: [&str; 3] = [DEFAULT_PROFILE_KEY, "dev", "dev-v2"];

const MAX_PROFILE_NAME: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProfileSource {
    Profile,
    LegacyChannel,
    Unpackaged,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ExplicitProfile {
    pub(crate) key: String,
    pub(crate) source: ProfileSource,
}

pub(crate) fn invalid_profile_message(raw: &str) -> String {
    format!(
        "Invalid {PROFILE_ENVIRONMENT} value {}: use 1-64 ASCII letters, digits, '.', '_' or '-', starting with a letter or digit.",
        serde_json::to_string(raw).unwrap_or_default()
    )
}

/// ASCII-only trimming and case folding keep the grammar identical to Electron.
fn ascii_trim(value: &str) -> &str {
    value.trim_matches(|character: char| matches!(character, '\t' | '\n' | '\x0c' | '\r' | ' '))
}

/// Parses an explicit profile name into its storage key; "default" and "stable" both denote the default profile.
pub(crate) fn parse_profile_name(raw: &str) -> Result<String, String> {
    let lower = ascii_trim(raw).to_ascii_lowercase();
    let valid = !lower.is_empty()
        && lower.len() <= MAX_PROFILE_NAME
        && lower.starts_with(|character: char| character.is_ascii_alphanumeric())
        && lower.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    if !valid {
        return Err(invalid_profile_message(raw));
    }
    Ok(if lower == DEFAULT_PROFILE_NAME {
        DEFAULT_PROFILE_KEY.to_string()
    } else {
        lower
    })
}

/// Pre-profile Tauri channel normalization, kept verbatim so existing scopes stay reachable.
pub(crate) fn legacy_channel_key(value: &str) -> String {
    let mut normalized = String::new();
    for character in value.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            normalized.push(character);
        } else if !normalized.ends_with('-') {
            normalized.push('-');
        }
    }
    normalized
}

pub(crate) fn profile_display_name(key: &str) -> &str {
    if key == DEFAULT_PROFILE_KEY {
        DEFAULT_PROFILE_NAME
    } else {
        key
    }
}

/// Explicit selection wins over everything; `Ok(None)` means a packaged launch needs the transition.
pub(crate) fn resolve_explicit_profile(
    profile: Option<&str>,
    legacy_channel: Option<&str>,
    packaged: bool,
) -> Result<Option<ExplicitProfile>, String> {
    if let Some(profile) = profile.filter(|value| !ascii_trim(value).is_empty()) {
        return Ok(Some(ExplicitProfile {
            key: parse_profile_name(profile)?,
            source: ProfileSource::Profile,
        }));
    }
    if let Some(channel) = legacy_channel.filter(|value| !value.trim().is_empty()) {
        return Ok(Some(ExplicitProfile {
            key: legacy_channel_key(channel),
            source: ProfileSource::LegacyChannel,
        }));
    }
    Ok((!packaged).then(|| ExplicitProfile {
        key: "dev".to_string(),
        source: ProfileSource::Unpackaged,
    }))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProfileScope {
    pub(crate) scoped: bool,
    pub(crate) suffix: String,
    pub(crate) scope_name: String,
}

pub(crate) fn profile_scope(
    key: &str,
    config_identity: &str,
    default_identity: &str,
) -> ProfileScope {
    let digest = Sha256::digest(format!("{key}\0{config_identity}").as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    ProfileScope {
        scoped: key != DEFAULT_PROFILE_KEY || config_identity != default_identity,
        scope_name: format!("{key}-{suffix}"),
        suffix,
    }
}

#[cfg(test)]
pub(crate) fn shared_vectors() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../electron-app/electron/main/data-profile-vectors.json"
    ))
    .expect("shared data-profile vectors")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn text(value: &Value, key: &str) -> String {
        value[key].as_str().unwrap().to_string()
    }

    #[test]
    fn explicit_profile_names_follow_the_shared_grammar() {
        let vectors = shared_vectors();
        for vector in vectors["profileNames"].as_array().unwrap() {
            let key = parse_profile_name(&text(vector, "input")).unwrap();
            assert_eq!(key, text(vector, "key"));
            assert_eq!(profile_display_name(&key), text(vector, "display"));
        }
        for input in vectors["invalidProfileNames"].as_array().unwrap() {
            let input = input.as_str().unwrap();
            assert!(parse_profile_name(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn the_deprecated_channel_alias_keeps_its_historical_normalization() {
        for vector in shared_vectors()["legacyChannels"].as_array().unwrap() {
            assert_eq!(
                legacy_channel_key(&text(vector, "input")),
                text(vector, "key")
            );
        }
        // Tauri-only historical divergences remain untouched for existing folders.
        assert_eq!(legacy_channel_key("a- b"), "a-b");
        assert_eq!(legacy_channel_key("\u{212A}elvin"), "-elvin");
    }

    #[test]
    fn profile_scopes_reproduce_the_historical_scope_names() {
        for vector in shared_vectors()["scopes"].as_array().unwrap() {
            let scope = profile_scope(
                &text(vector, "key"),
                &text(vector, "configIdentity"),
                &text(vector, "defaultIdentity"),
            );
            assert_eq!(
                scope.scoped,
                vector["scoped"].as_bool().unwrap(),
                "{vector}"
            );
            assert_eq!(scope.scope_name, text(vector, "scopeName"), "{vector}");
        }
    }

    #[test]
    fn explicit_profile_precedence_matches_electron() {
        for vector in shared_vectors()["explicitProfiles"].as_array().unwrap() {
            let resolved = resolve_explicit_profile(
                vector["profile"].as_str(),
                vector["channel"].as_str(),
                vector["packaged"].as_bool().unwrap(),
            )
            .unwrap();
            let expected = vector["key"].as_str().map(|key| ExplicitProfile {
                key: key.to_string(),
                source: match vector["source"].as_str().unwrap() {
                    "profile" => ProfileSource::Profile,
                    "legacy-channel" => ProfileSource::LegacyChannel,
                    _ => ProfileSource::Unpackaged,
                },
            });
            assert_eq!(resolved, expected, "{vector}");
        }
        assert!(resolve_explicit_profile(Some("not a profile"), None, true).is_err());
    }
}
