//! Atomic HTTPS download, streaming SHA-256 + minisign verification, staging cleanup,
//! and silent Windows installer handoff (`codenomad-rune-setup.exe`).

use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write as _,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use ring::digest::{Context as DigestContext, SHA256};

use super::{
    InstallLaunchOptions, UpdateError, UpdateInfo, UpdateStageOutcome, UpdaterConfig,
    manifest::validate_update_url,
    minisign::{
        Blake2b512, MinisignAlgorithm, MinisignPublicKey, MinisignSignature, encode_lower_hex,
    },
};

/// Default upper bound for `latest.json` downloads (1 MiB).
pub const DEFAULT_MAX_MANIFEST_BYTES: usize = 1024 * 1024;
/// Default upper bound for installer downloads (512 MiB).
pub const DEFAULT_MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REDIRECTS: usize = 5;

static STAGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Returns `true` when the running executable belongs to a registered per-user installation
/// that supports silent in-place replacement (per `dev-docs/TAURI_UPDATER.md`).
/// Unpacked archives and local build outputs return `false`.
pub fn in_place_update_supported(current_version: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Ok(current_exe) = std::env::current_exe() else {
            return false;
        };
        let Some(exe_dir) = current_exe.parent() else {
            return false;
        };
        let product = codenomad_windows_install::Product::release(current_version);
        let Some(root) = codenomad_windows_install::installed_root(&product) else {
            return false;
        };
        let Ok(norm_exe_dir) = std::path::absolute(exe_dir) else {
            return false;
        };
        let Ok(norm_root) = std::path::absolute(root) else {
            return false;
        };
        let clean_exe: PathBuf = norm_exe_dir.components().collect();
        let clean_root: PathBuf = norm_root.components().collect();
        clean_exe
            .to_string_lossy()
            .eq_ignore_ascii_case(&clean_root.to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = current_version;
        false
    }
}

/// Default temporary staging root under the OS temp folder.
pub fn default_staging_root() -> PathBuf {
    std::env::temp_dir().join("codenomad-rune-updates")
}

/// Removes a staged update directory when the caller cancels or finishes installation.
pub fn cleanup_staged(staged: &UpdateStageOutcome) -> Result<(), UpdateError> {
    if staged.stage_directory.exists() {
        fs::remove_dir_all(&staged.stage_directory).map_err(|err| UpdateError::Io {
            reason: format!("failed to clean staged directory: {err}"),
        })?;
    }
    Ok(())
}

pub(crate) async fn fetch_manifest(config: &UpdaterConfig) -> Result<Vec<u8>, UpdateError> {
    let url = validate_update_url(&config.manifest_url, config.allow_loopback_http())?;
    let client = build_http_client(config.allow_loopback_http(), &config.current_version)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|err| UpdateError::Http {
            reason: err.to_string(),
        })?;
    if !response.status().is_success() {
        return Err(UpdateError::Http {
            reason: format!("manifest request returned HTTP {}", response.status()),
        });
    }
    let limit = config.max_manifest_bytes as u64;
    if let Some(expected_len) = response.content_length()
        && expected_len > limit
    {
        return Err(UpdateError::PayloadTooLarge {
            limit,
            actual: expected_len,
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|err| UpdateError::Http {
        reason: err.to_string(),
    })? {
        let next_len = bytes.len().saturating_add(chunk.len());
        if next_len > config.max_manifest_bytes {
            return Err(UpdateError::PayloadTooLarge {
                limit,
                actual: next_len as u64,
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) async fn download_and_verify(
    config: &UpdaterConfig,
    info: &UpdateInfo,
    staging_root: &Path,
) -> Result<UpdateStageOutcome, UpdateError> {
    // Fail closed on key, signature header, signed version, and URL BEFORE opening the network.
    let pubkey = MinisignPublicKey::parse(&config.public_key)?;
    let sig = MinisignSignature::parse(&info.signature)?;
    sig.check_header(&pubkey, &info.version)?;
    let artifact_url = validate_update_url(&info.url, config.allow_loopback_http())?;

    let stage_guard = StageDirGuard::create_under(staging_root)?;
    let part_path = stage_guard.path().join("payload.part");

    let client = build_http_client(config.allow_loopback_http(), &config.current_version)?;
    let mut response = client
        .get(artifact_url)
        .send()
        .await
        .map_err(|err| UpdateError::Http {
            reason: err.to_string(),
        })?;
    if !response.status().is_success() {
        return Err(UpdateError::Http {
            reason: format!("artifact download returned HTTP {}", response.status()),
        });
    }
    if let Some(expected_len) = response.content_length()
        && expected_len > config.max_artifact_bytes
    {
        return Err(UpdateError::PayloadTooLarge {
            limit: config.max_artifact_bytes,
            actual: expected_len,
        });
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part_path)
        .map_err(|err| UpdateError::Io {
            reason: format!("failed to create staging file: {err}"),
        })?;

    let mut sha256_ctx = DigestContext::new(&SHA256);
    let mut blake2b = Blake2b512::new();
    let mut total_bytes: u64 = 0;

    while let Some(chunk) = response.chunk().await.map_err(|err| UpdateError::Http {
        reason: err.to_string(),
    })? {
        total_bytes = total_bytes.saturating_add(chunk.len() as u64);
        if total_bytes > config.max_artifact_bytes {
            return Err(UpdateError::PayloadTooLarge {
                limit: config.max_artifact_bytes,
                actual: total_bytes,
            });
        }
        file.write_all(&chunk).map_err(|err| UpdateError::Io {
            reason: format!("failed writing staged artifact: {err}"),
        })?;
        sha256_ctx.update(&chunk);
        if sig.algorithm == MinisignAlgorithm::PrehashedBlake2b512 {
            blake2b.update(&chunk);
        }
    }

    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|err| UpdateError::Io {
            reason: format!("failed syncing staged artifact: {err}"),
        })?;
    drop(file);

    let actual_sha256 = encode_lower_hex(sha256_ctx.finish().as_ref());
    if let Some(expected_sha256) = info.sha256.as_deref()
        && actual_sha256 != expected_sha256
    {
        return Err(UpdateError::HashMismatch {
            expected: expected_sha256.to_string(),
            actual: actual_sha256,
        });
    }

    let verified = match sig.algorithm {
        MinisignAlgorithm::PrehashedBlake2b512 => {
            let blake2b_digest = blake2b.finalize();
            sig.verify_prehashed(&pubkey, &blake2b_digest)?
        }
        MinisignAlgorithm::LegacyRawEd25519 => {
            let full_bytes = fs::read(&part_path).map_err(|err| UpdateError::Io {
                reason: format!("failed reading staged artifact for legacy verification: {err}"),
            })?;
            sig.verify_bytes(&pubkey, &full_bytes)?
        }
    };

    if verified.signed_version.as_deref() != Some(info.version.as_str()) {
        return Err(UpdateError::SignedVersionMismatch {
            expected: info.version.clone(),
            signed: verified.signed_version,
        });
    }

    let final_name = staged_filename(&info.target, &info.version);
    let final_path = stage_guard.path().join(final_name);
    fs::rename(&part_path, &final_path).map_err(|err| UpdateError::Io {
        reason: format!("failed finalizing staged artifact: {err}"),
    })?;
    let stage_directory = stage_guard.disarm();

    Ok(UpdateStageOutcome {
        info: info.clone(),
        stage_directory,
        artifact_path: final_path,
        sha256: actual_sha256,
        byte_len: total_bytes,
        trusted_comment: verified.trusted_comment,
    })
}

/// Builds the exact command-line arguments passed to `codenomad-rune-setup.exe`.
pub fn build_installer_args(options: &InstallLaunchOptions) -> Result<Vec<OsString>, UpdateError> {
    let mut args = vec![OsString::from("--silent")];
    if options.relaunch_after_install {
        args.push(OsString::from("--launch"));
    }
    if let Some(root) = options.install_root.as_deref() {
        validate_plain_absolute_path(root, "install_root")?;
        args.push(OsString::from("--dir"));
        args.push(root.as_os_str().to_os_string());
    }
    if let Some(log_path) = options.log_path.as_deref() {
        validate_plain_absolute_path(log_path, "log_path")?;
        args.push(OsString::from("--log"));
        args.push(log_path.as_os_str().to_os_string());
    }
    Ok(args)
}

/// Launches the verified staged Windows installer (`codenomad-rune-setup.exe`) detached so it
/// can replace the installation folder and optionally relaunch Rune after the caller exits.
pub fn launch_installer(
    staged: &UpdateStageOutcome,
    options: &InstallLaunchOptions,
) -> Result<(), UpdateError> {
    let meta = fs::symlink_metadata(&staged.artifact_path).map_err(|err| UpdateError::Io {
        reason: format!("staged artifact is unavailable: {err}"),
    })?;
    if !meta.file_type().is_file() {
        return Err(UpdateError::InvalidInstallOption {
            reason: "staged artifact must be a regular file".into(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        use std::process::{Command, Stdio};

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        let is_exe = staged
            .artifact_path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
        if !is_exe {
            return Err(UpdateError::InvalidInstallOption {
                reason: "Windows installer artifact must have .exe extension".into(),
            });
        }

        let mut resolved = options.clone();
        if resolved.install_root.is_none() {
            let product = codenomad_windows_install::Product::release(&resolved.current_version);
            resolved.install_root = codenomad_windows_install::installed_root(&product);
        }
        if resolved.install_root.is_none() {
            return Err(UpdateError::InvalidInstallOption {
                reason:
                    "no registered Windows installation root found; pass install_root explicitly"
                        .into(),
            });
        }
        let args = build_installer_args(&resolved)?;

        let mut command = Command::new(&staged.artifact_path);
        // Run from the staging folder so the detached installer never inherits an open
        // directory handle on `install_root`, which would block atomic folder swap on Windows.
        command
            .current_dir(&staged.stage_directory)
            .args(&args)
            .env_remove("__COMPAT_LAYER")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);

        command.spawn().map_err(|err| UpdateError::Io {
            reason: format!("failed to launch staged installer: {err}"),
        })?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = build_installer_args(options)?;
        Err(UpdateError::UnsupportedPlatform {
            detail: format!(
                "installer handoff is not yet implemented on {}",
                std::env::consts::OS
            ),
        })
    }
}

fn build_http_client(
    allow_loopback_http: bool,
    current_version: &str,
) -> Result<reqwest::Client, UpdateError> {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("too many HTTP redirects");
        }
        match validate_update_url(attempt.url().as_str(), allow_loopback_http) {
            Ok(_) => attempt.follow(),
            Err(err) => attempt.error(err.to_string()),
        }
    });
    let user_agent = format!("CodeNomad-Rune-Updater/{}", current_version.trim());
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .redirect(policy)
        .user_agent(user_agent)
        .build()
        .map_err(|err| UpdateError::Http {
            reason: format!("failed to construct HTTP client: {err}"),
        })
}

fn validate_plain_absolute_path(path: &Path, field: &str) -> Result<(), UpdateError> {
    if !path.is_absolute() {
        return Err(UpdateError::InvalidInstallOption {
            reason: format!("{field} must be an absolute path"),
        });
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(UpdateError::InvalidInstallOption {
            reason: format!("{field} must not contain '..' segments"),
        });
    }
    Ok(())
}

fn staged_filename(target: &str, version: &str) -> String {
    let safe_version: String = version
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let ext = match target {
        "windows-x86_64" => ".exe",
        "darwin-aarch64" | "darwin-x86_64" => ".app.tar.gz",
        "linux-x86_64" => ".AppImage",
        _ => ".bin",
    };
    format!("codenomad-rune-update-{safe_version}{ext}")
}

/// Owns a unique staging subdirectory and deletes it automatically on any error path.
struct StageDirGuard {
    directory: PathBuf,
    armed: bool,
}

impl StageDirGuard {
    fn create_under(staging_root: &Path) -> Result<Self, UpdateError> {
        validate_plain_absolute_path(staging_root, "staging_root")?;
        if let Ok(meta) = fs::symlink_metadata(staging_root) {
            if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
                return Err(UpdateError::Io {
                    reason: "staging root must be a real directory, not a symlink or file".into(),
                });
            }
        } else {
            fs::create_dir_all(staging_root).map_err(|err| UpdateError::Io {
                reason: format!("failed to create staging root: {err}"),
            })?;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let seq = STAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = staging_root.join(format!("stage-{}-{seq}-{nanos}", std::process::id()));
        fs::create_dir(&directory).map_err(|err| UpdateError::Io {
            reason: format!("failed to create unique staging directory: {err}"),
        })?;
        Ok(Self {
            directory,
            armed: true,
        })
    }

    fn path(&self) -> &Path {
        &self.directory
    }

    fn disarm(mut self) -> PathBuf {
        self.armed = false;
        self.directory.clone()
    }
}

impl Drop for StageDirGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}
