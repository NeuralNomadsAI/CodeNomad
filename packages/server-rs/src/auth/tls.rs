//! The HTTPS listener: supplied or locally issued certificates in the private `tls/` folder,
//! connection admission and serving.
use axum::{Router, http::Request};
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose};
use rustls::pki_types::CertificateDer;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    io::{self, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

pub type Failure = Box<dyn std::error::Error>;
/// Handshake, then request headers, must arrive within these (audit M1).
pub const HANDSHAKE: Duration = Duration::from_secs(5);
pub const IDLE: Duration = Duration::from_secs(10);
pub struct Listener {
    pub socket: TcpListener,
    pub acceptor: tokio_rustls::TlsAcceptor,
    pub origin: String,
    pub fingerprint: String,
    pub ingress: bool,
}
#[derive(Clone)]
pub struct Channel {
    pub origin: String,
    pub ingress: bool,
    pub socket: CancellationToken,
    pub principal: Arc<std::sync::Mutex<Option<uuid::Uuid>>>,
}

pub fn private_directory(path: &Path) -> io::Result<()> {
    if let Ok(meta) = fs::symlink_metadata(path)
        && (meta.file_type().is_symlink() || !meta.is_dir())
    {
        return Err(io::Error::other("Private directory must be physical"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, DACL_SECURITY_INFORMATION,
                PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
            },
        };
        fs::create_dir_all(path)?;
        if fs::symlink_metadata(path)?.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("Private directory must not be a reparse point"));
        }
        let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<_>>();
        let path = path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
        let rule = wide("D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)");
        let mut descriptor = std::ptr::null_mut();
        // The DACL is protected from inheritance; children inherit owner and
        // SYSTEM only. No process invocation or global ACL change.
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                rule.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let ok = SetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            );
            let error = io::Error::last_os_error();
            LocalFree(descriptor);
            if ok == 0 {
                return Err(error);
            }
        }
    }
    Ok(())
}

pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn leaf(pem: &str) -> Result<CertificateDer<'static>, Failure> {
    Ok(rustls_pemfile::certs(&mut pem.as_bytes()).next().transpose()?.ok_or("Certificate missing")?)
}
fn fresh(pem: &str, days: i64, names: &[String]) -> bool {
    use x509_parser::prelude::*;
    let Ok(der) = leaf(pem) else { return false };
    let Ok((_, cert)) = parse_x509_certificate(&der) else { return false };
    cert.validity().is_valid()
        && cert.validity().not_after.timestamp() > ::time::OffsetDateTime::now_utc().unix_timestamp() + days * 86400
        && cert.raw_serial().first().is_some_and(|b| b & 0x80 == 0)
        && cert.raw_serial().iter().any(|b| *b != 0)
        && (names.is_empty()
            || cert.subject_alternative_name().ok().flatten().is_some_and(|san| {
                names.iter().all(|name| {
                    san.value.general_names.iter().any(|entry| match entry {
                        GeneralName::DNSName(s) => s.eq_ignore_ascii_case(name),
                        GeneralName::IPAddress(bytes) => match name.parse::<IpAddr>() {
                            Ok(IpAddr::V4(ip)) => *bytes == ip.octets(),
                            Ok(IpAddr::V6(ip)) => *bytes == ip.octets(),
                            _ => false,
                        },
                        _ => false,
                    })
                })
            }))
}
fn params(names: Vec<String>, cn: &str, days: i64) -> Result<CertificateParams, Failure> {
    let mut params = CertificateParams::new(names)?;
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::minutes(1);
    params.not_after = now + time::Duration::days(days);
    params.distinguished_name.push(DnType::CommonName, cn);
    Ok(params)
}
/// Where and as what the HTTPS listener runs: interface, public name, `tls/` folder,
/// supplied key, certificate and CA files, extra certificate names.
pub struct Settings {
    pub bind: crate::host::Bind,
    pub name: String,
    pub dir: PathBuf,
    pub files: [Option<OsString>; 3],
    pub sans: String,
}

fn material(s: &Settings) -> Result<(String, String), Failure> {
    let (dir, host) = (s.dir.as_path(), s.name.as_str());
    let [key, cert, ca] = s.files.clone();
    if key.is_some() || cert.is_some() || ca.is_some() {
        let cert = fs::read_to_string(cert.ok_or("TLS certificate missing")?)?;
        let chain = ca.map(fs::read_to_string).transpose()?.unwrap_or_default();
        return Ok((fs::read_to_string(key.ok_or("TLS key missing")?)?, format!("{}\n{}", cert.trim_end(), chain)));
    }
    private_directory(dir)?;
    let mut names = vec!["localhost".into(), "127.0.0.1".into(), host.trim_matches(['[', ']']).into()];
    names.extend(
        s.sans
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_matches(['[', ']']).split('%').next().unwrap_or(s).to_ascii_lowercase()),
    );
    names.sort();
    names.dedup();
    // The folder is shared with the reference (`server/tls.ts`), whose `node-forge` reads RSA keys only:
    // its authority is reused as is, and what this server issues is what the reference issues.
    let (ca_path, ca_key_path) = (dir.join("ca-cert.pem"), dir.join("ca-key.pem"));
    let (leaf_path, key_path) = (dir.join("server-cert.pem"), dir.join("server-key.pem"));
    let mut ca = fs::read_to_string(&ca_path).unwrap_or_default();
    let mut ca_key = fs::read_to_string(&ca_key_path).ok().and_then(|pem| KeyPair::from_pem(&pem).ok());
    let rotate = !fresh(&ca, 0, &[]) || ca_key.is_none();
    if rotate {
        let key = rsa()?;
        let mut p = params(vec![], "CodeNomad Local CA", 365)?;
        p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
        ca = p.self_signed(&key)?.pem();
        write_private(&ca_key_path, pkcs1_pem(&key)?.as_bytes())?;
        write_private(&ca_path, ca.as_bytes())?;
        ca_key = Some(key);
    }
    let ca_key = ca_key.ok_or("TLS authority key missing")?;
    let mut certificate = fs::read_to_string(&leaf_path).unwrap_or_default();
    if rotate || !fresh(&certificate, 3, &names) || !key_path.is_file() {
        let key = rsa()?;
        let issuer = CertificateParams::from_ca_cert_pem(&ca)?.self_signed(&ca_key)?;
        let mut p = params(names, if host == "127.0.0.1" { "localhost" } else { host }, 30)?;
        p.is_ca = IsCa::ExplicitNoCa;
        p.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        certificate = p.signed_by(&key, &issuer, &ca_key)?.pem();
        write_private(&key_path, pkcs1_pem(&key)?.as_bytes())?;
        write_private(&leaf_path, certificate.as_bytes())?;
    }
    Ok((fs::read_to_string(key_path)?, format!("{certificate}{ca}")))
}

/// RSA-2048 signing with SHA-256, as `forge.pki.rsa.generateKeyPair(2048)` and `md.sha256`.
fn rsa() -> Result<KeyPair, Failure> {
    Ok(KeyPair::generate_rsa_for(&rcgen::PKCS_RSA_SHA256, rcgen::RsaKeySize::_2048)?)
}

/// `RSA PRIVATE KEY` (PKCS#1), as `forge.pki.privateKeyToPem` writes: the key inside the PKCS#8 wrapper.
fn pkcs1_pem(key: &KeyPair) -> Result<String, Failure> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (_, pkcs8) = x509_parser::der_parser::parse_der(key.serialized_der()).map_err(|_| "Invalid PKCS#8 key")?;
    let inner = pkcs8.as_sequence()?.get(2).ok_or("Invalid PKCS#8 key")?.as_slice()?;
    let body = STANDARD.encode(inner);
    let lines: Vec<_> = body.as_bytes().chunks(64).map(|l| std::str::from_utf8(l).unwrap_or_default()).collect();
    Ok(format!("-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----\n", lines.join("\n")))
}

impl Listener {
    pub async fn open(settings: Settings) -> Result<Self, Failure> {
        let ip = settings.bind.ip;
        if !match ip {
            IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
            IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
        } {
            return Err("An explicit loopback or private TLS interface is required".into());
        }
        let host = settings.name.clone();
        let ingress = crate::bench::ingress();
        if ingress && !ip.is_loopback() {
            return Err("Fixture ingress is loopback-only".into());
        }
        let listener = settings.bind.listen().await?;
        let port = listener.local_addr()?.port();
        let base = format!("https://{host}");
        let url = reqwest::Url::parse(&base)?;
        if url.origin().ascii_serialization() != base || url.host_str() != Some(&host) {
            return Err("Invalid HTTPS listener name".into());
        }
        let origin = if port == 443 { base } else { format!("{base}:{port}") };
        let (key, cert) = material(&settings)?;
        let certs = rustls_pemfile::certs(&mut cert.as_bytes()).collect::<Result<Vec<_>, _>>()?;
        let fingerprint = format!("{:x}", Sha256::digest(certs.first().ok_or("TLS chain empty")?.as_ref()));
        let private = rustls_pemfile::private_key(&mut key.as_bytes())?.ok_or("TLS private key missing")?;
        let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, private)?;
        Ok(Self {
            socket: listener,
            acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(config)),
            origin,
            fingerprint,
            ingress,
        })
    }
    pub async fn serve(self, router: Router, shutdown: CancellationToken) -> io::Result<()> {
        const DRAIN: Duration = Duration::from_secs(25);
        let gate = Arc::new(crate::auth::tls_admission::Gate::default());
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            while tasks.try_join_next().is_some() {}
            let (socket, peer) = tokio::select! {
                _ = shutdown.cancelled() => break,
                Some(_) = tasks.join_next(), if !tasks.is_empty() => continue,
                result = self.socket.accept() => match result {
                    Ok(accepted) => accepted,
                    // A per-connection failure (reset before accept, descriptor
                    // pressure) never stops the listener.
                    Err(_) => { tokio::time::sleep(Duration::from_millis(50)).await; continue }
                },
            };
            let (acceptor, router, stop) = (self.acceptor.clone(), router.clone(), shutdown.clone());
            // Keep per-connection eviction (`gate`) separate from server `shutdown` so active
            // HTTPS requests drain gracefully before `main` tears down plugin leases.
            let channel = Channel {
                origin: self.origin.clone(),
                ingress: self.ingress,
                socket: CancellationToken::new(),
                principal: Arc::new(std::sync::Mutex::new(None)),
            };
            let Some(ticket) = gate.admit(peer.ip(), channel.principal.clone(), channel.socket.clone()) else {
                continue;
            };
            tasks.spawn(async move {
                let _ticket = ticket;
                let lifetime = channel.socket.clone();
                let io = tokio::select! {
                    _ = lifetime.cancelled() => return,
                    _ = stop.cancelled() => return,
                    result = tokio::time::timeout(HANDSHAKE, acceptor.accept(socket)) => {
                        let Ok(Ok(io)) = result else { return; };
                        io
                    }
                };
                let cancel = crate::shared::WriteCancel::new();
                let io = crate::shared::WriteStallIo::new(io, Duration::from_secs(30), cancel.clone());
                let service = router.layer(axum::Extension(channel));
                let connection = http1::Builder::new()
                    .timer(TokioTimer::new())
                    // Also bounds the wait for a request's first byte, after the
                    // handshake and between keep-alive requests (hyper 1.x).
                    .header_read_timeout(IDLE)
                    .serve_connection(TokioIo::new(io), crate::shared::abortable_service(service, cancel))
                    .with_upgrades();
                tokio::pin!(connection);
                tokio::select! {
                    _ = lifetime.cancelled() => {}
                    _ = &mut connection => {}
                    _ = stop.cancelled() => {
                        connection.as_mut().graceful_shutdown();
                        tokio::select! {
                            _ = lifetime.cancelled() => {}
                            _ = connection => {}
                        }
                    }
                }
                lifetime.cancel();
            });
        }
        let drained = tokio::time::timeout(DRAIN, async { while tasks.join_next().await.is_some() {} }).await;
        tasks.abort_all();
        match drained {
            Ok(()) => Ok(()),
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "remote server shutdown drain timed out")),
        }
    }
}

pub fn https_only<B>(req: &Request<B>) -> Option<&Channel> {
    req.extensions().get::<Channel>()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference's layout: RSA PKCS#1 keys, an authority reused as is, the leaf alone renewed.
    #[test]
    fn issues_and_keeps_the_reference_authority() {
        let dir = std::env::temp_dir().join(format!("cnrs-tls-{}", uuid::Uuid::new_v4()));
        let settings = |sans: &str| Settings {
            bind: crate::host::Bind { ip: [127, 0, 0, 1].into(), port: 0, fallback: false },
            name: "localhost".into(),
            dir: dir.clone(),
            files: Default::default(),
            sans: sans.into(),
        };
        material(&settings("")).unwrap();
        let read = |name: &str| fs::read_to_string(dir.join(name)).unwrap();
        let (ca, ca_key, leaf) = (read("ca-cert.pem"), read("ca-key.pem"), read("server-cert.pem"));
        for key in [&ca_key, &read("server-key.pem")] {
            assert!(key.starts_with("-----BEGIN RSA PRIVATE KEY-----\n") && KeyPair::from_pem(key).is_ok());
        }
        let names = ["localhost".to_owned(), "127.0.0.1".to_owned()];
        assert!(fresh(&ca, 300, &[]) && fresh(&leaf, 20, &names));
        material(&settings("")).unwrap();
        assert_eq!(
            (read("ca-cert.pem"), read("ca-key.pem"), read("server-cert.pem")),
            (ca.clone(), ca_key.clone(), leaf.clone())
        );
        material(&settings("extra.example")).unwrap();
        assert_eq!((read("ca-cert.pem"), read("ca-key.pem")), (ca.clone(), ca_key));
        let renewed = read("server-cert.pem");
        assert!(renewed != leaf && fresh(&renewed, 20, &["extra.example".to_owned()]));
        let (issued, authority) = (super::leaf(&renewed).unwrap(), super::leaf(&ca).unwrap());
        let parse = |der: &CertificateDer| x509_parser::parse_x509_certificate(der).unwrap().1.issuer().to_string();
        let subject = x509_parser::parse_x509_certificate(&authority).unwrap().1.subject().to_string();
        assert_eq!(parse(&issued), subject);
        let _ = fs::remove_dir_all(&dir);
    }
}
