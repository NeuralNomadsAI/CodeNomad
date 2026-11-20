//! The HTTPS listener: supplied or locally issued certificates in the private `tls/` folder,
//! connection admission and serving.
use axum::{Router, http::Request};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose};
use rustls::pki_types::CertificateDer;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    path::Path,
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
fn material(dir: &Path, host: &str) -> Result<(String, String), Failure> {
    let [key, cert, ca] = crate::config::tls_files();
    if key.is_some() || cert.is_some() || ca.is_some() {
        let cert = fs::read_to_string(cert.ok_or("TLS certificate missing")?)?;
        let chain = ca.map(fs::read_to_string).transpose()?.unwrap_or_default();
        return Ok((fs::read_to_string(key.ok_or("TLS key missing")?)?, format!("{}\n{}", cert.trim_end(), chain)));
    }
    private_directory(dir)?;
    let mut names = vec!["localhost".into(), "127.0.0.1".into(), host.trim_matches(['[', ']']).into()];
    names.extend(
        crate::config::tls_sans()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_matches(['[', ']']).split('%').next().unwrap_or(s).to_ascii_lowercase()),
    );
    names.sort();
    names.dedup();
    let (ca_path, ca_key_path) = (dir.join("ca-cert.pem"), dir.join("ca-key.pem"));
    let (leaf_path, key_path) = (dir.join("server-cert.pem"), dir.join("server-key.pem"));
    let mut ca = fs::read_to_string(&ca_path).unwrap_or_default();
    let rotate = !fresh(&ca, 0, &[]) || !ca_key_path.is_file();
    if rotate {
        let key = KeyPair::generate()?;
        let mut p = params(vec![], "CodeNomad Local CA", 365)?;
        p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
        ca = p.self_signed(&key)?.pem();
        write_private(&ca_key_path, key.serialize_pem().as_bytes())?;
        write_private(&ca_path, ca.as_bytes())?;
    }
    let mut certificate = fs::read_to_string(&leaf_path).unwrap_or_default();
    if rotate || !fresh(&certificate, 3, &names) || !key_path.is_file() {
        let key = KeyPair::generate()?;
        let ca_key = KeyPair::from_pem(&fs::read_to_string(ca_key_path)?)?;
        let issuer = CertificateParams::from_ca_cert_pem(&ca)?.self_signed(&ca_key)?;
        let mut p = params(names, if host == "127.0.0.1" { "localhost" } else { host }, 30)?;
        p.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        certificate = p.signed_by(&key, &issuer, &ca_key)?.pem();
        write_private(&key_path, key.serialize_pem().as_bytes())?;
        write_private(&leaf_path, certificate.as_bytes())?;
    }
    Ok((fs::read_to_string(key_path)?, format!("{certificate}{ca}")))
}

impl Listener {
    pub async fn open(root: &Path) -> Result<Option<Self>, Failure> {
        let Some(bind) = crate::config::https_bind() else { return Ok(None) };
        let ip: SocketAddr = bind.parse()?;
        if !match ip.ip() {
            IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
            IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
        } {
            return Err("An explicit loopback or private TLS interface is required".into());
        }
        let host = crate::config::https_name()?;
        let ingress = crate::bench::ingress();
        if ingress && !ip.ip().is_loopback() {
            return Err("Fixture ingress is loopback-only".into());
        }
        let listener = TcpListener::bind(ip).await?;
        let port = listener.local_addr()?.port();
        let base = format!("https://{host}");
        let url = reqwest::Url::parse(&base)?;
        if url.origin().ascii_serialization() != base || url.host_str() != Some(&host) {
            return Err("Invalid HTTPS listener name".into());
        }
        let origin = if port == 443 { base } else { format!("{base}:{port}") };
        let (key, cert) = material(&root.join("tls"), &host)?;
        let certs = rustls_pemfile::certs(&mut cert.as_bytes()).collect::<Result<Vec<_>, _>>()?;
        let fingerprint = format!("{:x}", Sha256::digest(certs.first().ok_or("TLS chain empty")?.as_ref()));
        let private = rustls_pemfile::private_key(&mut key.as_bytes())?.ok_or("TLS private key missing")?;
        let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, private)?;
        Ok(Some(Self {
            socket: listener,
            acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(config)),
            origin,
            fingerprint,
            ingress,
        }))
    }
    pub async fn serve(self, router: Router, shutdown: CancellationToken) -> io::Result<()> {
        let gate = Arc::new(crate::auth::tls_admission::Gate::default());
        loop {
            let (socket, peer) = tokio::select! {
                _=shutdown.cancelled()=>return Ok(()),
                result=self.socket.accept()=>match result {
                    Ok(accepted) => accepted,
                    // A per-connection failure (reset before accept, descriptor
                    // pressure) never stops the listener.
                    Err(_) => { tokio::time::sleep(Duration::from_millis(50)).await; continue }
                },
            };
            let (acceptor, router) = (self.acceptor.clone(), router.clone());
            let channel = Channel {
                origin: self.origin.clone(),
                ingress: self.ingress,
                socket: shutdown.child_token(),
                principal: Arc::new(std::sync::Mutex::new(None)),
            };
            let Some(ticket) = gate.admit(peer.ip(), channel.principal.clone(), channel.socket.clone()) else {
                continue;
            };
            tokio::spawn(async move {
                let _ticket = ticket;
                let lifetime = channel.socket.clone();
                let io = tokio::select! {
                    _ = lifetime.cancelled() => return,
                    result = tokio::time::timeout(HANDSHAKE, acceptor.accept(socket)) => {
                        let Ok(Ok(io)) = result else { return; };
                        io
                    }
                };
                let service = router.layer(axum::Extension(channel));
                let connection = http1::Builder::new()
                    .timer(TokioTimer::new())
                    // Also bounds the wait for a request's first byte, after the
                    // handshake and between keep-alive requests (hyper 1.x).
                    .header_read_timeout(IDLE)
                    .serve_connection(TokioIo::new(io), TowerToHyperService::new(service));
                tokio::select! { _=lifetime.cancelled()=>{}, _=connection=>{} }
                lifetime.cancel();
            });
        }
    }
}

pub fn https_only<B>(req: &Request<B>) -> Option<&Channel> {
    req.extensions().get::<Channel>()
}
