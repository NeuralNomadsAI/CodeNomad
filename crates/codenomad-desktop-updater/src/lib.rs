#![forbid(unsafe_code)]
//! Signed desktop auto-updater engine aligned with `dev-docs/TAURI_UPDATER.md`.
//!
//! Decoupled from UI state so settings/info or startup hooks can check, stage, verify,
//! and launch updates without coupling renderer state to network or cryptographic code.

mod manifest;
mod minisign;
mod stage;
#[cfg(test)]
mod tests;

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub use manifest::{
    GithubRelease, PreviewOrdering, ReleaseCandidate, UpdateFeed, compare_versions, parse_manifest,
    select_release_candidate, validate_update_url,
};
pub use minisign::{
    MinisignAlgorithm, MinisignPublicKey, MinisignSignature, VerifiedMinisign, parse_public_key,
    sha256_hex_lowercase, trusted_comment_version, verify_minisign,
};
pub use stage::{
    DEFAULT_MAX_ARTIFACT_BYTES, DEFAULT_MAX_MANIFEST_BYTES, build_installer_args, cleanup_staged,
    default_staging_root, in_place_update_supported, launch_installer,
};

static UPDATE_BUSY: AtomicBool = AtomicBool::new(false);

/// Process-wide guard ensuring only one update check/install sequence runs at a time.
#[derive(Debug)]
pub struct UpdateLease {
    _private: (),
}

impl UpdateLease {
    pub fn acquire() -> Result<Self, UpdateError> {
        UPDATE_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self { _private: () })
            .map_err(|_| UpdateError::OperationInProgress)
    }
}

impl Drop for UpdateLease {
    fn drop(&mut self) {
        UPDATE_BUSY.store(false, Ordering::Release);
    }
}

/// Acquires the process-wide update operation lease.
pub fn acquire_update_lease() -> Result<UpdateLease, UpdateError> {
    UpdateLease::acquire()
}

/// Configuration for checking and verifying desktop updates.
#[derive(Clone, Debug)]
pub struct UpdaterConfig {
    /// Current installed application SemVer string (e.g. `1.2.0` or `1.2.0-dev.1`).
    pub current_version: String,
    /// HTTPS URL pointing to the signed release `latest.json` manifest.
    pub manifest_url: String,
    /// Pinned base64-encoded minisign public key (2-line minisign pubkey format).
    pub public_key: String,
    /// Target identifier inside `latest.json` `platforms` (e.g. `windows-x86_64`).
    pub target: String,
    /// Optional publication timestamps when evaluating a preview feed by publication order.
    pub preview_ordering: Option<PreviewOrdering>,
    /// Maximum accepted manifest byte count.
    pub max_manifest_bytes: usize,
    /// Maximum accepted installer artifact byte count.
    pub max_artifact_bytes: u64,
    /// Test-only loopback HTTP opt-in; production constructors always keep this `false`.
    allow_loopback_http: bool,
}

impl UpdaterConfig {
    /// Creates a fail-closed production updater configuration (HTTPS only).
    pub fn new(
        current_version: impl Into<String>,
        manifest_url: impl Into<String>,
        public_key: impl Into<String>,
    ) -> Result<Self, UpdateError> {
        let target = current_target().ok_or_else(|| UpdateError::UnsupportedPlatform {
            detail: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        })?;
        Ok(Self::for_target(
            current_version,
            manifest_url,
            public_key,
            target,
        ))
    }

    /// Creates a fail-closed updater configuration for an explicit platform target key.
    pub fn for_target(
        current_version: impl Into<String>,
        manifest_url: impl Into<String>,
        public_key: impl Into<String>,
        target: impl Into<String>,
    ) -> Self {
        Self {
            current_version: current_version.into(),
            manifest_url: manifest_url.into(),
            public_key: public_key.into(),
            target: target.into(),
            preview_ordering: None,
            max_manifest_bytes: DEFAULT_MAX_MANIFEST_BYTES,
            max_artifact_bytes: DEFAULT_MAX_ARTIFACT_BYTES,
            allow_loopback_http: false,
        }
    }

    /// Enables HTTP strictly for loopback hosts inside unit/integration tests.
    #[cfg(test)]
    pub(crate) fn with_loopback_http_for_tests(mut self) -> Self {
        self.allow_loopback_http = true;
        self
    }

    pub(crate) fn allow_loopback_http(&self) -> bool {
        self.allow_loopback_http
    }
}

/// Verified metadata for a candidate release parsed from `latest.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub target: String,
    pub url: String,
    pub signature: String,
    pub sha256: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

/// Outcome of checking `latest.json` against the installed version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateCheckOutcome {
    UpToDate { current_version: String },
    Available(UpdateInfo),
}

/// Outcome of downloading and cryptographically verifying a staged update artifact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateStageOutcome {
    pub info: UpdateInfo,
    pub stage_directory: PathBuf,
    pub artifact_path: PathBuf,
    pub sha256: String,
    pub byte_len: u64,
    pub trusted_comment: String,
}

/// Options controlling silent handoff to the verified platform installer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallLaunchOptions {
    /// Current installed version (used on Windows to query the registered install root when
    /// `install_root` is omitted).
    pub current_version: String,
    /// Explicit absolute installation folder passed to `--dir`.
    pub install_root: Option<PathBuf>,
    /// Whether the installer should relaunch CodeNomad Rune after replacing files (`--launch`).
    pub relaunch_after_install: bool,
    /// Optional installer log file path (`--log`).
    pub log_path: Option<PathBuf>,
}

impl InstallLaunchOptions {
    pub fn silent_update(current_version: impl Into<String>) -> Self {
        Self {
            current_version: current_version.into(),
            install_root: None,
            relaunch_after_install: true,
            log_path: None,
        }
    }
}

/// Fail-closed updater error taxonomy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateError {
    OperationInProgress,
    UnsupportedPlatform {
        detail: String,
    },
    InvalidUrl {
        url: String,
        reason: String,
    },
    InvalidVersion {
        version: String,
    },
    InvalidManifest {
        reason: String,
    },
    TargetUnavailable {
        target: String,
    },
    DowngradeRefused {
        current: String,
        candidate: String,
    },
    InvalidPublicKey {
        reason: String,
    },
    InvalidSignature {
        reason: String,
    },
    SignatureVerificationFailed {
        reason: String,
    },
    SignedVersionMismatch {
        expected: String,
        signed: Option<String>,
    },
    HashMismatch {
        expected: String,
        actual: String,
    },
    PayloadTooLarge {
        limit: u64,
        actual: u64,
    },
    Http {
        reason: String,
    },
    Io {
        reason: String,
    },
    InvalidInstallOption {
        reason: String,
    },
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OperationInProgress => f.write_str("An update operation is already running"),
            Self::UnsupportedPlatform { detail } => {
                write!(
                    f,
                    "Desktop auto-updater is unsupported on platform: {detail}"
                )
            }
            Self::InvalidUrl { url, reason } => write!(f, "Rejected update URL ({url}): {reason}"),
            Self::InvalidVersion { version } => write!(f, "Invalid SemVer version: {version}"),
            Self::InvalidManifest { reason } => write!(f, "Invalid update manifest: {reason}"),
            Self::TargetUnavailable { target } => {
                write!(f, "Update manifest does not contain target: {target}")
            }
            Self::DowngradeRefused { current, candidate } => {
                write!(f, "Refused downgrade from {current} to {candidate}")
            }
            Self::InvalidPublicKey { reason } => {
                write!(f, "Invalid updater public key: {reason}")
            }
            Self::InvalidSignature { reason } => write!(f, "Invalid updater signature: {reason}"),
            Self::SignatureVerificationFailed { reason } => {
                write!(f, "Updater signature verification failed: {reason}")
            }
            Self::SignedVersionMismatch { expected, signed } => match signed {
                Some(signed) => write!(
                    f,
                    "Signed update version ({signed}) does not match manifest version ({expected})"
                ),
                None => write!(
                    f,
                    "Updater signature trusted comment does not record version:{expected}"
                ),
            },
            Self::HashMismatch { expected, actual } => {
                write!(
                    f,
                    "Artifact SHA-256 mismatch: expected {expected}, got {actual}"
                )
            }
            Self::PayloadTooLarge { limit, actual } => {
                write!(
                    f,
                    "Update payload exceeded size limit ({actual} > {limit} bytes)"
                )
            }
            Self::Http { reason } => write!(f, "Update HTTP request failed: {reason}"),
            Self::Io { reason } => write!(f, "Update filesystem/process error: {reason}"),
            Self::InvalidInstallOption { reason } => {
                write!(f, "Invalid installer launch option: {reason}")
            }
        }
    }
}

impl std::error::Error for UpdateError {}

/// Maps the current compilation target to the Tauri/CodeNomad `latest.json` platform key.
pub fn current_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        _ => None,
    }
}

/// Fetches `latest.json`, validates its structure, target entry, URL policy, public key,
/// signature header, and version monotonicity (refusing downgrades).
pub async fn check_for_update(config: &UpdaterConfig) -> Result<UpdateCheckOutcome, UpdateError> {
    let pubkey = parse_public_key(&config.public_key)?;
    let body = stage::fetch_manifest(config).await?;
    let info = parse_manifest(&body, &config.target, config.allow_loopback_http())?;
    let sig = MinisignSignature::parse(&info.signature)?;
    sig.check_header(&pubkey, &info.version)?;
    compare_versions(
        &config.current_version,
        &info,
        config.preview_ordering.as_ref(),
    )
}

/// Downloads the release artifact atomically into a private staging directory under
/// `staging_root`, verifies SHA-256 (when listed) and the full minisign Ed25519 signature
/// (both artifact signature and trusted-comment global signature + signed version) before
/// returning the staged path. Removes all staged files on any failure.
pub async fn download_and_verify(
    config: &UpdaterConfig,
    info: &UpdateInfo,
    staging_root: &Path,
) -> Result<UpdateStageOutcome, UpdateError> {
    stage::download_and_verify(config, info, staging_root).await
}
