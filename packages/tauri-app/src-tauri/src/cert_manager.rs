use rcgen::{CertificateParams, DnType, KeyPair, SanType};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

const CERT_DIR_NAME: &str = "proxy-certs";
const CERT_PEM_FILE: &str = "proxy.crt";
const KEY_PEM_FILE: &str = "proxy.key";
const CERT_DER_FILE: &str = "proxy.der";
const TRUSTED_MARKER: &str = ".trusted";

/// Holds PEM-encoded certificate and private key for the local HTTPS proxy.
pub struct LocalCert {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_der: Vec<u8>,
}

/// Returns the directory where proxy certificates are stored.
fn cert_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| "Cannot determine local app data directory".to_string())?;
    Ok(base
        .join(crate::WINDOWS_APP_USER_MODEL_ID)
        .join(CERT_DIR_NAME))
}

/// Ensures a self-signed certificate exists on disk, generating one if needed.
/// Returns the PEM cert, PEM key, and DER cert bytes.
pub fn ensure_local_cert() -> Result<LocalCert, String> {
    let dir = cert_dir()?;
    let cert_pem_path = dir.join(CERT_PEM_FILE);
    let key_pem_path = dir.join(KEY_PEM_FILE);
    let cert_der_path = dir.join(CERT_DER_FILE);

    // If all files exist, load from disk
    if cert_pem_path.exists() && key_pem_path.exists() && cert_der_path.exists() {
        let cert_pem = fs::read_to_string(&cert_pem_path)
            .map_err(|e| format!("Failed to read {}: {e}", cert_pem_path.display()))?;
        let key_pem = fs::read_to_string(&key_pem_path)
            .map_err(|e| format!("Failed to read {}: {e}", key_pem_path.display()))?;
        let cert_der = fs::read(&cert_der_path)
            .map_err(|e| format!("Failed to read {}: {e}", cert_der_path.display()))?;
        return Ok(LocalCert {
            cert_pem,
            key_pem,
            cert_der,
        });
    }

    // Generate a new self-signed certificate
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create cert dir {}: {e}", dir.display()))?;

    let mut params = CertificateParams::default();
    params
        .distinguished_name
        .push(DnType::CommonName, "CodeNomad Local Proxy");
    params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into().map_err(|e| format!("{e}"))?),
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
    ];

    // Valid for 10 years
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    let ten_years = Duration::from_secs(10 * 365 * 24 * 3600);
    params.not_after = params.not_before + ten_years;

    let key_pair = KeyPair::generate().map_err(|e| format!("Key generation failed: {e}"))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("Certificate generation failed: {e}"))?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    let cert_der = cert.der().to_vec();

    fs::write(&cert_pem_path, &cert_pem)
        .map_err(|e| format!("Failed to write {}: {e}", cert_pem_path.display()))?;
    fs::write(&key_pem_path, &key_pem)
        .map_err(|e| format!("Failed to write {}: {e}", key_pem_path.display()))?;
    fs::write(&cert_der_path, &cert_der)
        .map_err(|e| format!("Failed to write {}: {e}", cert_der_path.display()))?;

    // Remove the trusted marker since this is a new cert
    let marker = dir.join(TRUSTED_MARKER);
    let _ = fs::remove_file(&marker);

    Ok(LocalCert {
        cert_pem,
        key_pem,
        cert_der,
    })
}

/// Returns true if the certificate has already been added to the Windows trust
/// store (indicated by the `.trusted` marker file).
pub fn is_cert_trusted() -> bool {
    cert_dir()
        .map(|dir| dir.join(TRUSTED_MARKER).exists())
        .unwrap_or(false)
}

/// Adds the DER-encoded certificate to the Windows `CurrentUser\Root` store.
/// This will show a one-time Windows security confirmation dialog.
/// After success, writes a `.trusted` marker file to avoid re-prompting.
#[cfg(windows)]
pub fn trust_cert_in_store(cert_der: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::{
        CertAddEncodedCertificateToStore, CertCloseStore, CertOpenSystemStoreW,
        CERT_STORE_ADD_REPLACE_EXISTING, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
    };

    if is_cert_trusted() {
        return Ok(());
    }

    // "Root" in UTF-16
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
            return Err("Failed to add certificate to trust store. \
                 The user may have declined the security dialog."
                .into());
        }
    }

    // Write marker file
    let dir = cert_dir()?;
    fs::write(dir.join(TRUSTED_MARKER), "trusted")
        .map_err(|e| format!("Failed to write trust marker: {e}"))?;

    Ok(())
}

#[cfg(not(windows))]
pub fn trust_cert_in_store(_cert_der: &[u8]) -> Result<(), String> {
    // On non-Windows platforms, certificate trust is not yet implemented.
    // The proxy will still work but the browser may show a warning.
    Ok(())
}
