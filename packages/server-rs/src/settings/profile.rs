//! Lexical desktop profile identity shared with the TypeScript host and native Mission proofs.
use std::{env, path::Path};

use sha2::{Digest, Sha256};

use crate::files::node_path::Style;

pub struct Scope {
    pub channel: String,
    pub identity: String,
    pub key: String,
}

pub fn scope(config: &Path) -> Option<Scope> {
    let channel = env::var("CODENOMAD_UPDATE_CHANNEL").unwrap_or_default();
    let default = if env::var("CODENOMAD_DEV").as_deref() == Ok("1") { "dev" } else { "stable" };
    let expected = env::var("CODENOMAD_PROFILE_CONFIG_IDENTITY");
    if matches!(expected, Err(env::VarError::NotUnicode(_))) {
        return None;
    }
    profile_scope(Style::host(), config.to_str()?, &channel, default, expected.ok().as_deref())
}

#[cfg(test)]
pub fn scope_for_test(config: &Path, channel: &str, expected: Option<&str>) -> Option<Scope> {
    profile_scope(Style::host(), config.to_str()?, channel, "stable", expected)
}

fn profile_scope(style: Style, config: &str, channel: &str, default: &str, expected: Option<&str>) -> Option<Scope> {
    let channel = channel.trim().to_lowercase();
    let channel = if channel.is_empty() { default } else { channel.as_str() };
    if !channel.as_bytes().first().is_some_and(|b| b.is_ascii_alphanumeric())
        || !channel.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        || !style.is_absolute(config)
        || config.contains('\0')
    {
        return None;
    }
    let path = style.normalize(config);
    let folded = style.fold(&path);
    let identity = match expected {
        None => &folded,
        Some(provided) if provided == folded || (style == Style::Win32 && provided == path.to_ascii_lowercase()) => {
            provided
        }
        Some(_) => return None,
    };
    let key = format!("{:x}", Sha256::digest(format!("{channel}\0{identity}")));
    Some(Scope { channel: channel.into(), identity: identity.into(), key })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(channel: &str, path: &str) -> String {
        format!("{:x}", Sha256::digest(format!("{channel}\0{path}")))
    }

    fn scope_key(style: Style, config: &str, channel: &str, default: &str, expected: Option<&str>) -> Option<String> {
        profile_scope(style, config, channel, default, expected).map(|scope| scope.key)
    }
    #[test]
    fn matches_desktop_profile_without_resolving_links() {
        let path = "/fixture/link/relative/../config.yaml";
        assert_eq!(
            scope_key(Style::Posix, path, " Trial ", "stable", None),
            Some(digest("trial", "/fixture/link/config.yaml"))
        );
        assert_eq!(scope_key(Style::Posix, path, " ", "dev", None), Some(digest("dev", "/fixture/link/config.yaml")));
        assert_eq!(scope_key(Style::Posix, path, "trial", "stable", Some("/fixture/other/config.yaml")), None);
        assert_eq!(scope_key(Style::Posix, path, "../wrong", "stable", None), None);
    }

    #[test]
    fn windows_keeps_the_identity_issued_by_tauri() {
        let path = "C:/Fixture/Émilie/config.yaml";
        let tauri = r"c:\fixture\Émilie\config.yaml";
        let node = r"c:\fixture\émilie\config.yaml";
        assert_eq!(scope_key(Style::Win32, path, "stable", "stable", Some(tauri)), Some(digest("stable", tauri)));
        assert_eq!(scope_key(Style::Win32, path, "stable", "stable", None), Some(digest("stable", node)));
        assert_eq!(scope_key(Style::Win32, path, "stable", "stable", Some(r"c:\fixture\other\config.yaml")), None);
    }
}
