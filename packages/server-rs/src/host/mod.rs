//! The desktop host contract (`index.ts`, `shutdown.ts`): `serve` options, listeners, the lines
//! hosts read on stdout and the commands they write on stdin.
pub mod addresses;
pub mod cli;
pub mod native_parent;
pub mod ui;

use std::{
    io::{self, BufRead, Write},
    net::IpAddr,
    path::PathBuf,
};

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

pub const SHUTDOWN_COMMAND: &str = "codenomad:shutdown";

/// One way to start: `serve` (the reference's contract) or the positional bench launch.
pub struct Launch {
    pub root: PathBuf,
    pub identity: Option<PathBuf>,
    pub data: PathBuf,
    /// `--config`: where `config.yaml` and `state.yaml` live.
    pub settings: crate::settings::document::Location,
    /// `--unrestricted-root`: any local folder may be browsed and opened.
    pub unrestricted: bool,
    /// The selected OpenCode executable; empty for the default installation.
    pub binary: PathBuf,
    pub http: Bind,
    pub https: Option<crate::auth::tls::Settings>,
    pub auth: crate::auth::Settings,
    pub ui: ui::Source,
    pub serve: bool,
}

#[cfg(test)]
pub(crate) fn ci_enabled() -> bool {
    std::env::var_os("CI").is_some_and(|v| {
        let s = v.to_string_lossy();
        let trimmed = s.trim();
        !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("false") && trimmed != "0"
    })
}

pub struct Bind {
    pub ip: IpAddr,
    pub port: u16,
    /// A default port only: any free port when taken (`shouldRetryPreferredPort`).
    pub fallback: bool,
}
impl Bind {
    pub async fn listen(&self) -> io::Result<TcpListener> {
        Ok(self.listen_with_dual_stack().await?.0)
    }

    /// Binds this address; on an IPv6 wildcard (`::`), enables dual-stack (`IPV6_V6ONLY = 0`)
    /// matching `http-server.ts` (`ipv6Only: false`) and returns whether dual-stack is active.
    pub async fn listen_with_dual_stack(&self) -> io::Result<(TcpListener, bool)> {
        #[cfg(test)]
        assert!(
            self.ip.is_loopback() || ci_enabled(),
            "local unit tests must bind loopback only (set CI for wildcard listener tests), got {}",
            self.ip
        );
        let attempt = |port: u16| async move {
            if self.ip.is_ipv6() && self.ip.is_unspecified() {
                let socket = tokio::net::TcpSocket::new_v6()?;
                let dual = disable_v6only(&socket);
                #[cfg(not(windows))]
                let _ = socket.set_reuseaddr(true);
                socket.bind((self.ip, port).into())?;
                return Ok::<_, io::Error>((socket.listen(1024)?, dual));
            }
            Ok((TcpListener::bind((self.ip, port)).await?, false))
        };
        match attempt(self.port).await {
            Err(e)
                if self.fallback
                    && (e.kind() == io::ErrorKind::AddrInUse
                        || cfg!(windows) && e.kind() == io::ErrorKind::PermissionDenied) =>
            {
                attempt(0).await
            }
            bound => bound,
        }
    }
}

fn disable_v6only(socket: &tokio::net::TcpSocket) -> bool {
    let off: i32 = 0;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Networking::WinSock::{IPPROTO_IPV6, IPV6_V6ONLY, SOCKET, setsockopt};
        // SAFETY: `socket` owns a live WinSock IPv6 socket and `off` is a valid 4-byte integer.
        unsafe {
            setsockopt(
                socket.as_raw_socket() as SOCKET,
                IPPROTO_IPV6,
                IPV6_V6ONLY,
                (&raw const off).cast(),
                size_of::<i32>() as i32,
            ) == 0
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: `socket` owns a live IPv6 file descriptor and `off` is a valid `c_int`.
        unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::IPPROTO_IPV6,
                libc::IPV6_V6ONLY,
                (&raw const off).cast(),
                size_of::<libc::c_int>() as libc::socklen_t,
            ) == 0
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (socket, off);
        false
    }
}

/// A whole stdout line, never interleaved with a native request.
pub fn line(text: &str) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{text}").and_then(|_| out.flush());
}

/// `Local Connection URL : …`, then the remote listener's URL when there is one.
pub fn announce(local: &str, remote: Option<&str>) {
    line(&format!("Local Connection URL : {local}"));
    if let Some(remote) = remote {
        line(&format!("Remote Connection URL : {remote}"));
    }
}

/// `installShutdownStdinHandler`: whole lines only; `codenomad:shutdown` stops once, other lines
/// may be native responses or managed-session renewals. Under a native desktop parent
/// (`CODENOMAD_NATIVE_PARENT=1`), EOF on stdin also cancels `stop` so an orphaned server exits
/// cleanly if the parent dies abruptly (e.g. SIGKILL on Unix); standalone/detached launches ignore
/// EOF as before.
pub fn read_stdin(stop: CancellationToken, app: crate::Shared) {
    let shutdown_on_eof = native_parent::available();
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        read_stdin_loop(&mut input, &stop, shutdown_on_eof, |text| {
            if !native_parent::handle_line(text) && !stop.is_cancelled() && native_parent::available() {
                crate::auth::managed::handle_control_if(text, &app.auth, || !stop.is_cancelled(), line);
            }
        });
    });
}

fn read_stdin_loop<R: BufRead, F: FnMut(&str)>(
    input: &mut R,
    stop: &CancellationToken,
    shutdown_on_eof: bool,
    mut on_other: F,
) {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match input.read_until(b'\n', &mut buffer) {
            Ok(_) if buffer.last() == Some(&b'\n') => {}
            _ => {
                if shutdown_on_eof {
                    stop.cancel();
                }
                return;
            }
        }
        let text = String::from_utf8_lossy(&buffer);
        let text = text.trim_end_matches('\n').trim_end_matches('\r');
        if text.trim() == SHUTDOWN_COMMAND {
            stop.cancel();
        } else {
            on_other(text);
        }
    }
}

/// `CODENOMAD_SHUTDOWN_STATUS:complete` and exit 0, or `:incomplete` and the process stays for the
/// host's process-tree enforcement, as the reference holds after failed cleanup.
pub fn finish(complete: bool) -> ! {
    if complete {
        line("CODENOMAD_SHUTDOWN_STATUS:complete");
        std::process::exit(0);
    }
    line("CODENOMAD_SHUTDOWN_STATUS:incomplete");
    loop {
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::{Ipv4Addr, Ipv6Addr},
        time::Duration,
    };

    #[tokio::test]
    async fn ipv6_wildcard_dual_stack_accepts_both_ipv6_and_ipv4() {
        // Binding `::` triggers the Windows Firewall prompt for each new test binary; run in CI only.
        if !ci_enabled() {
            return;
        }
        let bind = Bind { ip: IpAddr::V6(Ipv6Addr::UNSPECIFIED), port: 0, fallback: false };
        let (listener, dual_stack) = match bind.listen_with_dual_stack().await {
            Ok(bound) => bound,
            Err(err) if err.kind() == io::ErrorKind::AddrNotAvailable => return,
            Err(err) => panic!("failed to bind IPv6 wildcard listener: {err}"),
        };
        let port = listener.local_addr().unwrap().port();
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::try_join!(listener.accept(), tokio::net::TcpStream::connect((Ipv6Addr::LOCALHOST, port)))
        })
        .await
        .expect("IPv6 loopback accept timed out")
        .expect("IPv6 loopback connect/accept failed");
        assert!(dual_stack, "expected IPV6_V6ONLY=0 dual-stack to succeed on ::");
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::try_join!(listener.accept(), tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)))
        })
        .await
        .expect("IPv4-mapped loopback accept timed out")
        .expect("IPv4 loopback connect/accept failed on dual-stack ::");
    }

    #[tokio::test]
    async fn local_wildcard_bind_is_refused_without_ci() {
        if ci_enabled() {
            return;
        }
        for ip in [IpAddr::V4(Ipv4Addr::UNSPECIFIED), IpAddr::V6(Ipv6Addr::UNSPECIFIED)] {
            let panicked = tokio::spawn(async move {
                let bind = Bind { ip, port: 0, fallback: false };
                let _ = bind.listen_with_dual_stack().await;
            })
            .await
            .is_err_and(|err| err.is_panic());
            assert!(panicked, "expected non-loopback bind {ip} to be refused locally when CI is unset");
        }
    }

    #[test]
    fn stdin_eof_cancels_stop_when_native_parent_is_active() {
        let stop = CancellationToken::new();
        let mut input = io::Cursor::new(b"");
        let mut seen = Vec::new();
        read_stdin_loop(&mut input, &stop, true, |line| seen.push(line.to_string()));
        assert!(stop.is_cancelled(), "EOF under native parent must trigger graceful shutdown");
        assert!(seen.is_empty());
    }

    #[test]
    fn stdin_eof_does_not_cancel_stop_without_native_parent() {
        let stop = CancellationToken::new();
        let mut input = io::Cursor::new(b"unrelated\npartial-without-newline");
        let mut seen = Vec::new();
        read_stdin_loop(&mut input, &stop, false, |line| seen.push(line.to_string()));
        assert!(!stop.is_cancelled(), "EOF without native parent must leave detached server running");
        assert_eq!(seen, vec!["unrelated"]);
    }

    #[test]
    fn stdin_shutdown_command_cancels_stop_and_forwards_other_lines() {
        let stop = CancellationToken::new();
        let mut input = io::Cursor::new(b"hello\r\ncodenomad:shutdown\nworld\n");
        let mut seen = Vec::new();
        read_stdin_loop(&mut input, &stop, false, |line| seen.push(line.to_string()));
        assert!(stop.is_cancelled());
        assert_eq!(seen, vec!["hello", "world"]);
    }
}
