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

/// Adds the DER-encoded CA certificate to the Windows `CurrentUser\Root` store.
/// This will show a one-time Windows security confirmation dialog when needed.
#[cfg(windows)]
pub fn trust_cert_in_store(cert_der: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::{
        CertAddEncodedCertificateToStore, CertCloseStore, CertOpenSystemStoreW,
        CERT_STORE_ADD_REPLACE_EXISTING, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
    };

    if has_matching_trusted_marker(cert_der) {
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

#[cfg(not(windows))]
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
