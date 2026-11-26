//! OpenTunnel `v0.7.0` adapter for Remote Control: blind TLS tunnel with `Tunnel::ready()`.
//!
//! Uses the shared `"default"` OpenTunnel profile (same identity as OpenCode and the
//! OpenTunnel CLI), never calls `Client::remove`, and keeps PROXY protocol disabled so
//! the loopback ingress receives plain HTTP.
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use opentunnel::{Client, ClientOptions, Route, Routes, State, Status};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

/// Remote Control waits up to five minutes for initial certificate provisioning and
/// first bridge attachment; `stop()` cancels any in-flight start immediately.
pub const START_TIMEOUT: Duration = Duration::from_secs(300);

const PROFILE: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelState {
    Connecting,
    Connected,
    Reconnecting,
    Stopped,
}

impl From<State> for TunnelState {
    fn from(state: State) -> Self {
        match state {
            State::WaitingRoutes | State::Connecting => Self::Connecting,
            State::Connected => Self::Connected,
            State::Reconnecting => Self::Reconnecting,
            State::Stopped => Self::Stopped,
        }
    }
}

pub trait TunnelSession: Send + Sync {
    fn hostname(&self) -> &str;
    fn url(&self) -> &str;
    fn state(&self) -> TunnelState;
    /// Resolves once when the tunnel stops on its own (fatal error or relay drop).
    fn take_closed(&self) -> Option<oneshot::Receiver<Option<String>>>;
    fn close(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

pub struct OpenRequest {
    pub route: String,
    pub target: String,
    pub api: Option<String>,
    /// Invoked once the public `https://<host>` origin is known, before bridge attach completes.
    pub on_origin: Arc<dyn Fn(String) + Send + Sync>,
    pub cancel: CancellationToken,
}

pub type OpenFuture = Pin<Box<dyn Future<Output = Result<Arc<dyn TunnelSession>, String>> + Send>>;
pub type TunnelOpener = Arc<dyn Fn(OpenRequest) -> OpenFuture + Send + Sync>;

pub fn default_opener() -> TunnelOpener {
    Arc::new(|req| Box::pin(open_opentunnel(req, None)))
}

/// Matches `@opentunnel/client`'s XDG storage location on all platforms, including Windows
/// (`os.homedir()` prefers `USERPROFILE` over `HOME`), so Rust and TypeScript backends share
/// the `default` profile.
pub(crate) fn shared_storage() -> opentunnel::Storage {
    shared_storage_from(
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        std::env::var_os("USERPROFILE").map(PathBuf::from),
    )
}

pub(crate) fn shared_storage_from(
    xdg_data_home: Option<PathBuf>,
    home: Option<PathBuf>,
    userprofile: Option<PathBuf>,
) -> opentunnel::Storage {
    if let Some(xdg) = xdg_data_home.filter(|v| !v.as_os_str().is_empty()) {
        return opentunnel::Storage::at(xdg.join("opentunnel"));
    }
    let home = if cfg!(windows) {
        userprofile.filter(|v| !v.as_os_str().is_empty()).or_else(|| home.filter(|v| !v.as_os_str().is_empty()))
    } else {
        home.filter(|v| !v.as_os_str().is_empty())
    }
    .unwrap_or_else(std::env::temp_dir);
    opentunnel::Storage::at(home.join(".local").join("share").join("opentunnel"))
}

pub(crate) async fn open_opentunnel(
    req: OpenRequest,
    storage: Option<opentunnel::Storage>,
) -> Result<Arc<dyn TunnelSession>, String> {
    let api = match req.api.as_deref() {
        Some(raw) => {
            let parsed = reqwest::Url::parse(raw)
                .map_err(|_| "Invalid CODENOMAD_REMOTE_CONTROL_API URL: expected an http or https origin".to_owned())?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || parsed.cannot_be_a_base()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || !matches!(parsed.path(), "" | "/")
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err("Invalid CODENOMAD_REMOTE_CONTROL_API URL: expected an http or https origin".to_owned());
            }
            Some(parsed)
        }
        None => None,
    };
    let storage = Some(storage.unwrap_or_else(shared_storage));
    let client = Client::new(ClientOptions { api, storage, ca_cert: None });
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    let identity = tokio::select! {
        biased;
        _ = req.cancel.cancelled() => return Err("Remote Control was stopped".to_owned()),
        _ = tokio::time::sleep_until(deadline) => return Err("Remote Control timed out while connecting".to_owned()),
        result = client.ensure(PROFILE) => result.map_err(|err| err.to_string())?,
    };
    let hostname = format!("{}.{}", req.route, identity.hostname);
    let url = format!("https://{hostname}");
    (req.on_origin)(url.clone());

    // Plain TCP target, PROXY protocol explicitly disabled (None).
    let route = Route::from(req.target.as_str());
    debug_assert!(route.proxy_protocol.is_none());
    let mut routes = Routes::new();
    routes.insert(req.route, route);

    let tunnel = client.connect(PROFILE, routes).map_err(|err| err.to_string())?;
    let ready = tunnel.ready();
    let ready_outcome = tokio::select! {
        biased;
        _ = req.cancel.cancelled() => Err("Remote Control was stopped".to_owned()),
        _ = tokio::time::sleep_until(deadline) => Err("Remote Control timed out while connecting".to_owned()),
        result = ready => result.map_err(|err| err.to_string()),
    };
    if let Err(err) = ready_outcome {
        let _ = tunnel.close().await;
        return Err(err);
    }
    Ok(Arc::new(OpentunnelSession::spawn(hostname, url, tunnel)) as Arc<dyn TunnelSession>)
}

struct OpentunnelSession {
    hostname: String,
    url: String,
    status: watch::Receiver<Status>,
    closed_rx: Mutex<Option<oneshot::Receiver<Option<String>>>>,
    close_tx: Mutex<Option<oneshot::Sender<()>>>,
    done_rx: watch::Receiver<bool>,
}

impl OpentunnelSession {
    fn spawn(hostname: String, url: String, mut tunnel: opentunnel::Tunnel) -> Self {
        let status = tunnel.status_watch();
        let mut events = tunnel.subscribe();
        let (closed_tx, closed_rx) = oneshot::channel();
        let (close_tx, mut close_rx) = oneshot::channel();
        let (done_tx, done_rx) = watch::channel(false);
        tokio::spawn(async move {
            // Observe autonomous stop via events without polling `tunnel.wait()` inside
            // `select!`: `wait()` takes the supervisor JoinHandle on first poll, which
            // would leave `tunnel.close()` unable to await bridge teardown.
            let autonomous = tokio::select! {
                reason = async {
                    loop {
                        match events.recv().await {
                            Ok(opentunnel::Event::Stopped { error }) => break Some(error),
                            Ok(_) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                let snap = tunnel.status();
                                if snap.state == State::Stopped {
                                    break Some(snap.last_error);
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                break Some(tunnel.status().last_error);
                            }
                        }
                    }
                } => reason,
                _ = &mut close_rx => None,
            };
            if let Some(event_err) = autonomous {
                let wait_err = tunnel.wait().await.err().map(|e| e.to_string());
                let _ = closed_tx.send(wait_err.or(event_err));
            } else {
                let _ = tunnel.close().await;
            }
            let _ = done_tx.send(true);
        });
        Self {
            hostname,
            url,
            status,
            closed_rx: Mutex::new(Some(closed_rx)),
            close_tx: Mutex::new(Some(close_tx)),
            done_rx,
        }
    }
}

impl TunnelSession for OpentunnelSession {
    fn hostname(&self) -> &str {
        &self.hostname
    }

    fn url(&self) -> &str {
        &self.url
    }

    fn state(&self) -> TunnelState {
        self.status.borrow().state.clone().into()
    }

    fn take_closed(&self) -> Option<oneshot::Receiver<Option<String>>> {
        self.closed_rx.lock().unwrap().take()
    }

    fn close(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        if let Some(tx) = self.close_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        let mut done = self.done_rx.clone();
        Box::pin(async move {
            let _ = done.wait_for(|&finished| finished).await;
        })
    }
}
