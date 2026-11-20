//! The desktop host contract (`index.ts`, `shutdown.ts`): `serve` options, listeners, the lines
//! hosts read on stdout and the commands they write on stdin.
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
    pub identity: PathBuf,
    pub data: PathBuf,
    /// `--config`: where `config.yaml` and `state.yaml` live.
    pub settings: crate::settings::document::Location,
    /// `--unrestricted-root`: any local folder may be browsed and opened.
    pub unrestricted: bool,
    /// The OpenCode executable workspaces report.
    pub binary: PathBuf,
    pub http: Bind,
    pub https: Option<crate::auth::tls::Settings>,
    pub auth: crate::auth::Settings,
    pub ui: ui::Source,
    pub serve: bool,
}

pub struct Bind {
    pub ip: IpAddr,
    pub port: u16,
    /// A default port only: any free port when taken (`shouldRetryPreferredPort`).
    pub fallback: bool,
}
impl Bind {
    pub async fn listen(&self) -> io::Result<TcpListener> {
        match TcpListener::bind((self.ip, self.port)).await {
            Err(e)
                if self.fallback
                    && (e.kind() == io::ErrorKind::AddrInUse
                        || cfg!(windows) && e.kind() == io::ErrorKind::PermissionDenied) =>
            {
                TcpListener::bind((self.ip, 0)).await
            }
            bound => bound,
        }
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
/// may be native responses. End of input changes nothing.
pub fn read_stdin(stop: CancellationToken) {
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match input.read_until(b'\n', &mut buffer) {
                Ok(_) if buffer.last() == Some(&b'\n') => {}
                _ => return,
            }
            let text = String::from_utf8_lossy(&buffer);
            let text = text.trim_end_matches('\n').trim_end_matches('\r');
            if text.trim() == SHUTDOWN_COMMAND {
                stop.cancel();
            } else {
                native_parent::handle_line(text);
            }
        }
    });
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
