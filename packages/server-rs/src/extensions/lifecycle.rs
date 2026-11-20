//! Bundled plugin lifecycle, after the reference `DesktopPluginLifecycle`,
//! `prepareDesktopPluginPresence` and `provisionDesktopPlugins`.
//!
//! Every OpenCode connection provisions: at start, then each time the native
//! event stream (re)connects (`connected`, called by `events::bridge`). Its
//! discovery root is read again on that connection; an installation already
//! retained for that root is reused (one backend lease per namespace), a new
//! root gets its own installation. A failed attempt is retried by the next
//! connection only; each distinct failure is logged once until a success.
//! Leases carry this backend's requests (`lease-request.ts`): Design in
//! session-pruning leases (rewritten on each extension-store change), agent
//! memory in memory leases; rewritten only when they change and otherwise
//! renewed every two seconds.

use crate::{App, Shared, extensions::provision, extensions::readiness::Owner};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const PRESENCE_INTERVAL: Duration = Duration::from_secs(2);
const READY_WAIT: Duration = Duration::from_secs(5);

struct Installation {
    paths: provision::Paths,
    features: Vec<provision::Installed>,
    written: Vec<String>,
    readiness: Option<Arc<Owner>>,
    ready: Vec<bool>,
    since: tokio::time::Instant,
}

#[derive(Default)]
struct State {
    active: bool,
    expected: usize,
    installations: Vec<Installation>,
    /// Index of the installation of the current connection's discovery root.
    current: Option<usize>,
    connections: u64,
    reported: HashSet<String>,
    last: Option<String>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);
static CONNECTED: Notify = Notify::const_new();

/// The native event stream connected again: provision on this connection.
pub fn connected() {
    if STATE.lock().unwrap().active {
        CONNECTED.notify_one();
    }
}

/// This backend's Design request (`designRequestRefresher`): derived from the
/// extension store at start and again on every store change, never polled.
static DESIGN: Mutex<Option<bool>> = Mutex::new(None);
fn design_requested(app: &App) -> bool {
    let mut design = DESIGN.lock().unwrap();
    *design.get_or_insert_with(|| crate::extensions::requests_design(app))
}
/// The extension store changed: derive the request again and write it into every
/// retained session-pruning lease now (`setLeaseContent`). Serialized, so the
/// last change's reading wins; an unchanged request leaves the leases alone.
pub fn refresh_design(app: &App) {
    {
        let mut design = DESIGN.lock().unwrap();
        *design = Some(crate::extensions::requests_design(app));
    }
    sync(app, false);
}

/// `lease-request.ts` content per feature for this backend.
fn content(app: &App, feature: &str) -> String {
    match feature {
        // Any installed, enabled panel extension declaring `opencode.designAgent`.
        "session-pruning" => provision::lease_request("design", design_requested(app)),
        // `server.memoryEnabled` (absent means disabled), while the bridge the tool calls is published.
        "memory" => provision::lease_request("memory", crate::memory::lease_requested(app)),
        _ => String::new(),
    }
}

fn status(app: &App, state: &State) {
    let current = state.current.map(|i| &state.installations[i]);
    let features: Vec<Value> = current
        .map(|i| {
            i.features
                .iter()
                .zip(&i.ready)
                .map(|(f, r)| {
                    json!({"feature":f.feature,"sha256":f.sha256,"provider":f.provider,
                "entry":f.entry,"lease":f.lease.file_name().map(|n|n.to_string_lossy().into_owned()),"ready":r})
                })
                .collect()
        })
        .unwrap_or_default();
    let state_name = if !state.active {
        "stopped"
    } else if current.is_some() {
        "provisioned"
    } else {
        "failed"
    };
    let doc = json!({"version":1,"state":state_name,"pid":std::process::id(),"expected":state.expected,
        "connections":state.connections,"namespaces":state.installations.len(),
        "discovery":current.map(|i|&i.paths.config),"features":features,"error":state.last});
    let _ = crate::auth::tls::write_private(&app.data.join("plugin-provision.json"), doc.to_string().as_bytes());
}

async fn connection(app: &Shared, features: &[&'static str]) {
    STATE.lock().unwrap().connections += 1;
    let outcome = match provision::discovery(app).await {
        Err(e) => Err(e),
        Ok(paths) => {
            let known = STATE.lock().unwrap().installations.iter().position(|i| i.paths.config == paths.config);
            match known {
                Some(index) => Ok((index, false)),
                None => {
                    let contents: Vec<String> = features.iter().map(|f| content(app, f)).collect();
                    let (target, chosen, written) = (paths.clone(), features.to_vec(), contents.clone());
                    let installed = tokio::task::spawn_blocking(move || {
                        let mut done = Vec::new();
                        for (feature, lease) in chosen.into_iter().zip(&written) {
                            let result = provision::payloads(feature)
                                .and_then(|(b, p)| provision::install(feature, &b, p.as_deref(), &target, lease));
                            match result {
                                Ok(i) => done.push(i),
                                // A failed attempt relinquishes only its own new leases.
                                Err(e) => {
                                    provision::dispose(&done);
                                    return Err(format!(
                                        "Failed to provision bundled desktop plugins for the current connection: {e}"
                                    ));
                                }
                            }
                        }
                        Ok(done)
                    })
                    .await
                    .unwrap_or_else(|_| Err("Provisioning task failed".into()));
                    installed.map(|done| {
                        let readiness = done
                            .iter()
                            .find(|i| i.feature == "session-pruning")
                            .map(|i| Arc::new(Owner::new(i.lease.clone())));
                        for i in &done {
                            println!("plugin-provision {} {}", i.feature, i.sha256);
                        }
                        let mut state = STATE.lock().unwrap();
                        let ready = vec![false; done.len()];
                        state.installations.push(Installation {
                            paths,
                            features: done,
                            written: contents,
                            readiness,
                            ready,
                            since: tokio::time::Instant::now(),
                        });
                        (state.installations.len() - 1, true)
                    })
                }
            }
        }
    };
    let mut state = STATE.lock().unwrap();
    match outcome {
        Ok((index, fresh)) => {
            state.current = Some(index);
            state.reported.clear();
            state.last = None;
            if !fresh {
                println!("plugin-provision connection {} reused", state.connections);
            }
        }
        Err(message) => {
            // `provisionDesktopPlugins`: once per distinct failure until a success.
            if state.reported.insert(message.clone()) {
                eprintln!("plugin-provision error: {message}");
            }
            state.current = None;
            state.last = Some(message);
        }
    }
    status(app, &state);
}

/// `DesktopPluginLifecycle.sync`: rewrite a lease whose request changed, else renew it.
fn sync(app: &App, renew: bool) {
    let mut state = STATE.lock().unwrap();
    let mut changed = false;
    for installation in &mut state.installations {
        for (index, feature) in installation.features.iter().enumerate() {
            let wanted = content(app, feature.feature);
            if wanted != installation.written[index] {
                if crate::extensions::artifact::write_replacing(&feature.lease, wanted.as_bytes()).is_ok() {
                    installation.written[index] = wanted;
                }
            } else if renew {
                let now = std::time::SystemTime::now();
                // The reference ignores a failed renewal; the lease simply expires.
                let _ = fs::OpenOptions::new().write(true).open(&feature.lease).and_then(|f| f.set_modified(now));
            }
        }
        // Bounded startup marker wait: no marker comes before a Location loads.
        if installation.since.elapsed() <= READY_WAIT {
            for (ready, feature) in installation.ready.iter_mut().zip(&installation.features) {
                if !*ready && provision::ready_marker(&feature.lease).exists() {
                    *ready = true;
                    changed = true;
                }
            }
        }
    }
    if changed {
        status(app, &state);
    }
}

pub fn start(app: &Shared, stop: CancellationToken) -> Result<Option<tokio::task::JoinHandle<()>>, String> {
    let features = provision::selected()?;
    if features.is_empty() {
        return Ok(None);
    }
    {
        let mut state = STATE.lock().unwrap();
        state.active = true;
        state.expected = features.len();
    }
    let app = app.clone();
    Ok(Some(tokio::spawn(async move {
        let attempt = connection(&app, &features);
        tokio::select! { _ = stop.cancelled() => {}, _ = attempt => {} }
        let mut renewed = tokio::time::Instant::now();
        while !stop.is_cancelled() {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = CONNECTED.notified() => connection(&app, &features).await,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
            let renew = renewed.elapsed() >= PRESENCE_INTERVAL;
            if renew {
                renewed = tokio::time::Instant::now();
            }
            sync(&app, renew);
        }
        let (owners, leases): (Vec<_>, Vec<_>) = {
            let mut state = STATE.lock().unwrap();
            state.active = false;
            let installations = std::mem::take(&mut state.installations);
            state.current = None;
            status(&app, &state);
            installations.into_iter().map(|i| (i.readiness, i.features)).unzip()
        };
        for owner in owners.into_iter().flatten() {
            owner.close().await;
        }
        for features in leases {
            provision::dispose(&features);
        }
    })))
}

/// `DesktopPluginLifecycle.ready(target)` after the native catalogue wait: a fresh
/// presence challenge for this exact Location through the current connection's
/// pruning lease. When this backend does not provision, the presence (and its
/// proof) belongs to whoever installed the plugin, and the catalogue wait stands.
pub async fn ready(directory: &str, deadline: tokio::time::Instant) -> Result<(), String> {
    let owner = {
        let state = STATE.lock().unwrap();
        if !state.active {
            return Ok(());
        }
        state.current.and_then(|i| state.installations[i].readiness.clone())
    };
    let owner = owner.ok_or("Pruning presence unavailable for captured connection")?;
    owner.prepare(directory, deadline).await.map(|_| ())
}
