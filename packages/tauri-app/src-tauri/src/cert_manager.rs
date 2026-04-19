use base64::Engine;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_CONFIG_PATH: &str = "~/.config/codenomad/config.json";
const TLS_DIR_NAME: &str = "tls";
const CA_CERT_FILE: &str = "ca-cert.pem";
const SERVER_CERT_FILE: &str = "server-cert.pem";
const SERVER_KEY_FILE: &str = "server-key.pem";
const TRUSTED_MARKER: &str = "server-ca.trusted";
#[cfg(windows)]
const WINDOWS_APP_USER_MODEL_ID: &str = "ai.neuralnomads.codenomad.client";

/// Holds the PEM-encoded certificate/key pair used by the local HTTPS proxy,
/// plus the CA certificate DER used for trust-store installation.
pub struct LocalCert {
    pub cert_pem: String,
    pub key_pem: String,
    pub ca_cert_der: Vec<u8>,
}

struct TlsAssetPaths {
    cert_path: PathBuf,
    key_path: PathBuf,
    trust_path: PathBuf,
    append_ca_to_cert: bool,
}

/// Loads the TLS assets already managed by `packages/server`.
pub fn ensure_local_cert() -> Result<LocalCert, String> {
    let assets = resolve_tls_asset_paths()?;
    let mut cert_pem = read_pem_file(&assets.cert_path)?;
    let key_pem = read_pem_file(&assets.key_path)?;
    let trust_pem = read_pem_file(&assets.trust_path)?;

    if assets.append_ca_to_cert {
        cert_pem = format!("{}\n{}\n", cert_pem.trim(), trust_pem.trim());
    }

    let ca_cert_der = pem_to_der(&trust_pem)?;

    Ok(LocalCert {
        cert_pem,
        key_pem,
        ca_cert_der,
    })
}

fn read_pem_file(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))
}

fn server_tls_dir() -> Result<PathBuf, String> {
    Ok(resolve_server_config_base_dir()?.join(TLS_DIR_NAME))
}

fn resolve_tls_asset_paths() -> Result<TlsAssetPaths, String> {
    let tls_key_path = env::var("CLI_TLS_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_path_like_server(&value))
        .transpose()?;
    let tls_cert_path = env::var("CLI_TLS_CERT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_path_like_server(&value))
        .transpose()?;
    let tls_ca_path = env::var("CLI_TLS_CA")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_path_like_server(&value))
        .transpose()?;

    match (tls_key_path, tls_cert_path) {
        (Some(key_path), Some(cert_path)) => {
            let append_ca_to_cert = tls_ca_path.is_some();
            let trust_path = tls_ca_path.unwrap_or_else(|| cert_path.clone());
            Ok(TlsAssetPaths {
                cert_path,
                key_path,
                trust_path,
                append_ca_to_cert,
            })
        }
        (Some(_), None) | (None, Some(_)) => Err(
            "CLI_TLS_KEY and CLI_TLS_CERT must both be set when using custom TLS files"
                .to_string(),
        ),
        (None, None) => {
            let tls_dir = server_tls_dir()?;
            Ok(TlsAssetPaths {
                cert_path: tls_dir.join(SERVER_CERT_FILE),
                key_path: tls_dir.join(SERVER_KEY_FILE),
                trust_path: tls_dir.join(CA_CERT_FILE),
                append_ca_to_cert: true,
            })
        }
    }
}

fn resolve_server_config_base_dir() -> Result<PathBuf, String> {
    let raw = env::var("CLI_CONFIG")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CONFIG_PATH.to_string());
    let expanded = resolve_path_like_server(&raw)?;
    let lower = raw.trim().to_lowercase();

    if lower.ends_with(".yaml") || lower.ends_with(".yml") || lower.ends_with(".json") {
        return expanded
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("Failed to determine config base dir from {}", expanded.display()));
    }

    Ok(expanded)
}

fn resolve_path_like_server(path: &str) -> Result<PathBuf, String> {
    if path.starts_with("~/") {
        let home = dirs::home_dir().or_else(|| env::var("HOME").ok().map(PathBuf::from));
        let home = home.ok_or_else(|| "Cannot determine home directory".to_string())?;
        return Ok(home.join(path.trim_start_matches("~/")));
    }

    let path = PathBuf::from(path);
    if path.is_absolute() {
        return Ok(path);
    }

    let cwd = env::current_dir().map_err(|e| format!("Failed to read current dir: {e}"))?;
    Ok(cwd.join(path))
}

fn trusted_marker_path() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| "Cannot determine local app data directory".to_string())?;

    #[cfg(windows)]
    {
        return Ok(base.join(WINDOWS_APP_USER_MODEL_ID).join(TRUSTED_MARKER));
    }

    #[cfg(not(windows))]
    {
        Ok(base.join("codenomad").join(TRUSTED_MARKER))
    }
}

fn trusted_marker_value(cert_der: &[u8]) -> String {
    cert_der.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn trusted_marker_file_suffix(cert_der: &[u8]) -> String {
    trusted_marker_value(cert_der).chars().take(16).collect()
}

fn has_matching_trusted_marker(cert_der: &[u8]) -> bool {
    trusted_marker_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|value| value.trim() == trusted_marker_value(cert_der))
        .unwrap_or(false)
}

fn write_trusted_marker(cert_der: &[u8]) -> Result<(), String> {
    let path = trusted_marker_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create trust state dir {}: {e}", parent.display()))?;
    }
    fs::write(path, trusted_marker_value(cert_der))
        .map_err(|e| format!("Failed to write trust marker: {e}"))
}

#[cfg(windows)]
pub fn needs_trust_in_store(cert_der: &[u8]) -> Result<bool, String> {
    Ok(!windows_cert_is_trusted(cert_der)?)
}

#[cfg(windows)]
pub fn trust_cert_in_store(cert_der: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::{
        CertAddEncodedCertificateToStore, CertCloseStore, CertOpenSystemStoreW,
        CERT_STORE_ADD_REPLACE_EXISTING, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
    };

    if !needs_trust_in_store(cert_der)? {
        return Ok(());
    }

    let store_name: Vec<u16> = "Root\0".encode_utf16().collect();

    unsafe {
        let store = CertOpenSystemStoreW(0, store_name.as_ptr());
        if store.is_null() {
            return Err("Failed to open CurrentUser\\Root certificate store".into());
        }

        let encoding = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;
        let result = CertAddEncodedCertificateToStore(
            store,
            encoding,
            cert_der.as_ptr(),
            cert_der.len() as u32,
            CERT_STORE_ADD_REPLACE_EXISTING,
            std::ptr::null_mut(),
        );

        CertCloseStore(store, 0);

        if result == 0 {
            return Err(
                "Failed to add certificate to trust store. The user may have declined the security dialog."
                    .into(),
            );
        }
    }

    write_trusted_marker(cert_der)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn needs_trust_in_store(cert_der: &[u8]) -> Result<bool, String> {
    Ok(!(has_matching_trusted_marker(cert_der) && macos_cert_is_trusted(cert_der)?))
}

#[cfg(target_os = "macos")]
pub fn trust_cert_in_store(cert_der: &[u8]) -> Result<(), String> {
    use std::process::Command;

    if !needs_trust_in_store(cert_der)? {
        return Ok(());
    }

    let temp_path = env::temp_dir().join(format!(
        "codenomad-server-ca-{}.cer",
        trusted_marker_file_suffix(cert_der)
    ));
    fs::write(&temp_path, cert_der)
        .map_err(|e| format!("Failed to write temporary certificate {}: {e}", temp_path.display()))?;

    let keychain_path = resolve_macos_user_keychain()?;

    let mut command = Command::new("/usr/bin/security");
    command.args(["add-trusted-cert", "-r", "trustRoot", "-k"]);
    command.arg(&keychain_path);

    let output = command.arg(&temp_path).output().map_err(|e| {
        format!(
            "Failed to launch macOS security tool to trust the local CA certificate: {e}"
        )
    })?;

    let _ = fs::remove_file(&temp_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("security exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(format!(
            "Failed to add the local CodeNomad CA certificate to the macOS trust settings: {detail}"
        ));
    }

    if !macos_cert_is_trusted(cert_der)? {
        return Err(format!(
            "Added the local CodeNomad CA certificate to {} but could not verify that macOS trusts it",
            keychain_path.display()
        ));
    }

    write_trusted_marker(cert_der)?;
    Ok(())
}

#[cfg(windows)]
fn windows_cert_is_trusted(cert_der: &[u8]) -> Result<bool, String> {
    use windows_sys::Win32::Security::Cryptography::{
        CertCloseStore, CertEnumCertificatesInStore, CertOpenSystemStoreW,
    };

    let store_name: Vec<u16> = "Root\0".encode_utf16().collect();

    unsafe {
        let store = CertOpenSystemStoreW(0, store_name.as_ptr());
        if store.is_null() {
            return Err("Failed to open CurrentUser\\Root certificate store".into());
        }

        let mut context = CertEnumCertificatesInStore(store, std::ptr::null());
        while !context.is_null() {
            let encoded = std::slice::from_raw_parts(
                (*context).pbCertEncoded,
                (*context).cbCertEncoded as usize,
            );
            if encoded == cert_der {
                CertCloseStore(store, 0);
                return Ok(true);
            }

            context = CertEnumCertificatesInStore(store, context);
        }

        CertCloseStore(store, 0);
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
fn resolve_macos_user_keychain() -> Result<PathBuf, String> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["default-keychain", "-d", "user"])
        .output()
        .map_err(|e| format!("Failed to resolve macOS default user keychain: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.trim().trim_matches('"');
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home = dirs::home_dir().or_else(|| env::var("HOME").ok().map(PathBuf::from));
    let home = home.ok_or_else(|| "Cannot determine home directory for macOS keychain lookup".to_string())?;
    Ok(home.join("Library/Keychains/login.keychain-db"))
}

#[cfg(target_os = "macos")]
fn macos_cert_is_trusted(cert_der: &[u8]) -> Result<bool, String> {
    use std::process::Command;

    let temp_path = env::temp_dir().join(format!(
        "codenomad-server-ca-verify-{}.cer",
        trusted_marker_file_suffix(cert_der)
    ));
    fs::write(&temp_path, cert_der)
        .map_err(|e| format!("Failed to write temporary certificate {}: {e}", temp_path.display()))?;

    let keychain_path = resolve_macos_user_keychain()?;
    let fingerprint = macos_cert_sha256(&temp_path)?;
    let find_output = Command::new("/usr/bin/security")
        .args(["find-certificate", "-a", "-Z", "-c", "CodeNomad Local CA"])
        .arg(&keychain_path)
        .output()
        .map_err(|e| format!("Failed to query macOS keychain certificates: {e}"))?;

    if !find_output.status.success() {
        let _ = fs::remove_file(&temp_path);
        let stderr = String::from_utf8_lossy(&find_output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("security exited with status {}", find_output.status)
        } else {
            stderr
        };
        return Err(format!(
            "Failed to inspect the macOS keychain for the local CodeNomad CA certificate: {detail}"
        ));
    }

    let stdout = String::from_utf8_lossy(&find_output.stdout);
    if !stdout.to_ascii_uppercase().contains(&fingerprint) {
        let _ = fs::remove_file(&temp_path);
        return Ok(false);
    }

    let verify_output = Command::new("/usr/bin/security")
        .args(["verify-cert", "-q", "-L", "-l", "-p", "basic", "-c"])
        .arg(&temp_path)
        .args(["-k"])
        .arg(&keychain_path)
        .output()
        .map_err(|e| format!("Failed to verify macOS trust for the local CodeNomad CA certificate: {e}"))?;

    let _ = fs::remove_file(&temp_path);
    Ok(verify_output.status.success())
}

#[cfg(target_os = "macos")]
fn macos_cert_sha256(cert_path: &Path) -> Result<String, String> {
    let output = std::process::Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(cert_path)
        .output()
        .map_err(|e| format!("Failed to compute SHA-256 for {}: {e}", cert_path.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("shasum exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(format!(
            "Failed to compute SHA-256 for {}: {detail}",
            cert_path.display()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let hash = stdout
        .split_whitespace()
        .next()
        .ok_or_else(|| format!("Failed to parse SHA-256 output for {}", cert_path.display()))?;
    Ok(hash.to_ascii_uppercase())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn needs_trust_in_store(_cert_der: &[u8]) -> Result<bool, String> {
    Ok(false)
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn trust_cert_in_store(_cert_der: &[u8]) -> Result<(), String> {
    // Non-Windows platforms use native webview-specific handling instead of OS trust-store writes.
    Ok(())
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    let mut body = String::new();
    let mut in_block = false;

    for line in pem.lines() {
        if line.starts_with("-----BEGIN CERTIFICATE-----") {
            in_block = true;
            continue;
        }
        if line.starts_with("-----END CERTIFICATE-----") {
            break;
        }
        if in_block {
            body.push_str(line.trim());
        }
    }

    if body.is_empty() {
        return Err("No certificate found in PEM file".to_string());
    }

    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|e| format!("Failed to decode certificate PEM: {e}"))
}
