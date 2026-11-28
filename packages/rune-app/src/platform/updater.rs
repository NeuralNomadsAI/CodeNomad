//! Thin desktop auto-updater adapter for CodeNomad Rune.
//!
//! All manifest parsing, SemVer downgrade checks, minisign Ed25519 verification,
//! atomic staging, and silent installer handoff live in the shared
//! `codenomad-desktop-updater` crate (zero server routes).

pub use codenomad_desktop_updater::{
    DEFAULT_MAX_ARTIFACT_BYTES, DEFAULT_MAX_MANIFEST_BYTES, GithubRelease, InstallLaunchOptions,
    MinisignAlgorithm, MinisignPublicKey, MinisignSignature, PreviewOrdering, ReleaseCandidate,
    UpdateCheckOutcome, UpdateError, UpdateFeed, UpdateInfo, UpdateLease, UpdateStageOutcome,
    UpdaterConfig, VerifiedMinisign, acquire_update_lease, build_installer_args, check_for_update,
    cleanup_staged, compare_versions, current_target, default_staging_root, download_and_verify,
    in_place_update_supported, launch_installer, parse_manifest, parse_public_key,
    select_release_candidate, sha256_hex_lowercase, trusted_comment_version, validate_update_url,
    verify_minisign,
};

/// Returns the application's release version label used for update checks.
pub fn current_app_version() -> &'static str {
    option_env!("CODENOMAD_RUNE_VERSION")
        .filter(|value| !value.is_empty())
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// Builds a fail-closed production `UpdaterConfig` targeting this Rune build.
pub fn default_config(
    manifest_url: impl Into<String>,
    public_key: impl Into<String>,
) -> Result<UpdaterConfig, UpdateError> {
    UpdaterConfig::new(current_app_version(), manifest_url, public_key)
}

/// Reports whether the running executable is a registered install eligible for
/// silent in-place update replacement.
pub fn supported_for_current_install() -> bool {
    in_place_update_supported(current_app_version())
}

#[cfg(test)]
mod tests {
    use super::{current_app_version, current_target, default_config};

    #[test]
    fn adapter_builds_fail_closed_config_for_current_desktop_target() {
        let cfg = default_config(
            "https://github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.2.1/latest.json",
            "placeholder-pubkey",
        )
        .expect("desktop target supported");
        assert_eq!(cfg.current_version, current_app_version());
        assert_eq!(Some(cfg.target.as_str()), current_target());
    }
}
