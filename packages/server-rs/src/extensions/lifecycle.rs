//! Bundled plugin lifecycle, after the reference `DesktopPluginLifecycle`,
//! `prepareDesktopPluginPresence` and `provisionDesktopPlugins`.
//!
//! Every OpenCode connection provisions: at start when the endpoint is already
//! known, before a discovered connection's first use (`prepare`), then each time
//! the native event stream (re)connects (`connected`, called by `events::bridge`). Its
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
    features: Vec<&'static str>,
    /// The connection already prepared (`pluginPreparations`): one attempt each, again after a failure.
    prepared: Option<Arc<crate::opencode::Endpoint>>,
    /// Deduplicated in-flight `prepare()` task for a given endpoint so concurrent or timed-out
    /// callers share one flight instead of piling tasks behind `SERIAL`.
    preparing: Option<(Arc<crate::opencode::Endpoint>, Arc<Notify>)>,
    /// Lifecycle shutdown token so detached `prepare()` flights cancel discovery immediately on stop.
    stop: Option<CancellationToken>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);
static CONNECTED: Notify = Notify::const_new();
static SYNC_NOW: Notify = Notify::const_new();
/// One provisioning attempt at a time, from a connection's acquirer or from the stream.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The native event stream connected again: provision on this connection.
pub fn connected() {
    if STATE.lock().unwrap().active {
        CONNECTED.notify_one();
    }
}

/// `OpenCodeSharedService.connect`: a new connection is provisioned before its first use (a
/// workspace opening, the event stream) returns; a failed attempt leaves it usable and the next
/// acquisition tries again. Shares one detached flight per endpoint so concurrent or timed-out
/// callers never pile tasks behind `SERIAL` or orphan in-flight leases.
pub async fn prepare(app: &Shared, endpoint: &Arc<crate::opencode::Endpoint>) {
    if !app.native.current(endpoint) {
        return;
    }
    let (notify, owner) = {
        let mut state = STATE.lock().unwrap();
        if !state.active
            || (state.current.is_some() && state.prepared.as_ref().is_some_and(|p| Arc::ptr_eq(p, endpoint)))
        {
            return;
        }
        if let Some((current, notify)) = &state.preparing
            && Arc::ptr_eq(current, endpoint)
        {
            (notify.clone(), false)
        } else {
            let notify = Arc::new(Notify::new());
            state.preparing = Some((endpoint.clone(), notify.clone()));
            (notify, true)
        }
    };
    if owner {
        let app = app.clone();
        let endpoint = endpoint.clone();
        let done = notify.clone();
        tokio::spawn(async move {
            prepare_inner(&app, &endpoint).await;
            let mut state = STATE.lock().unwrap();
            if state.preparing.as_ref().is_some_and(|(ep, _)| Arc::ptr_eq(ep, &endpoint)) {
                state.preparing = None;
            }
            done.notify_waiters();
        });
    }
    loop {
        let notified = notify.notified();
        {
            let state = STATE.lock().unwrap();
            if !state.active || !state.preparing.as_ref().is_some_and(|(ep, _)| Arc::ptr_eq(ep, endpoint)) {
                return;
            }
        }
        notified.await;
    }
}

async fn prepare_inner(app: &Shared, endpoint: &Arc<crate::opencode::Endpoint>) {
    let _serial = SERIAL.lock().await;
    if !app.native.current(endpoint) {
        return;
    }
    let (features, stop) = {
        let state = STATE.lock().unwrap();
        if !state.active
            || (state.current.is_some() && state.prepared.as_ref().is_some_and(|p| Arc::ptr_eq(p, endpoint)))
        {
            return;
        }
        (state.features.clone(), state.stop.clone())
    };
    connection_at(app, Some(endpoint), &features, stop.as_ref()).await;
    let mut state = STATE.lock().unwrap();
    if state.active && app.native.current(endpoint) && state.current.is_some() {
        state.prepared = Some(endpoint.clone());
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
    SYNC_NOW.notify_one();
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

fn status(app: &App, state: &State) -> (std::path::PathBuf, Vec<u8>) {
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
    (app.data.join("plugin-provision.json"), doc.to_string().into_bytes())
}

static STATUS_WRITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn write_status((path, bytes): (std::path::PathBuf, Vec<u8>)) {
    let _guard = STATUS_WRITE.lock().await;
    let _ = tokio::task::spawn_blocking(move || {
        let _ = crate::auth::tls::write_private(&path, &bytes);
    })
    .await;
}

async fn connection_at(
    app: &Shared,
    endpoint: Option<&Arc<crate::opencode::Endpoint>>,
    features: &[&'static str],
    stop: Option<&CancellationToken>,
) {
    STATE.lock().unwrap().connections += 1;
    let discovered = {
        let discover = async {
            match endpoint {
                Some(endpoint) => provision::discovery_at(app, endpoint).await,
                None => provision::discovery(app).await,
            }
        };
        let retired = async {
            if let Some(ep) = endpoint {
                app.native.wait_retired(ep).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        let stopped = async {
            if let Some(stop) = stop {
                stop.cancelled().await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            biased;
            _ = stopped => Err("Plugin lifecycle stopping".into()),
            _ = retired => Err("OpenCode connection replaced during plugin discovery".into()),
            res = discover => res,
        }
    };
    let outcome = match discovered {
        Err(e) => Err(e),
        Ok(paths) => {
            let known = STATE.lock().unwrap().installations.iter().position(|i| i.paths.config == paths.config);
            match known {
                Some(index) => Ok((index, false)),
                None => {
                    if endpoint.is_some_and(|ep| !app.native.current(ep))
                        || stop.is_some_and(CancellationToken::is_cancelled)
                    {
                        Err("OpenCode connection replaced before plugin installation".into())
                    } else {
                        let contents: Vec<String> = features.iter().map(|f| content(app, f)).collect();
                        let (target, chosen, written) = (paths.clone(), features.to_vec(), contents.clone());
                        let app_check = app.clone();
                        let ep_check = endpoint.cloned();
                        let stop_check = stop.cloned();
                        let installed = tokio::task::spawn_blocking(move || {
                            let still_current = || {
                                !stop_check.as_ref().is_some_and(CancellationToken::is_cancelled)
                                    && ep_check.as_ref().is_none_or(|ep| app_check.native.current(ep))
                            };
                            let mut done = Vec::new();
                            for (feature, lease) in chosen.into_iter().zip(&written) {
                                let result = provision::payloads(feature).and_then(|(b, p)| {
                                    provision::install_checked(feature, &b, p.as_deref(), &target, lease, still_current)
                                });
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
                        match installed {
                            Err(err) => Err(err),
                            Ok(done) => {
                                let registered = {
                                    let mut state = STATE.lock().unwrap();
                                    if !state.active
                                        || stop.is_some_and(CancellationToken::is_cancelled)
                                        || endpoint.is_some_and(|ep| !app.native.current(ep))
                                    {
                                        Err(done)
                                    } else {
                                        let readiness = done
                                            .iter()
                                            .find(|i| i.feature == "session-pruning")
                                            .map(|i| Arc::new(Owner::new(i.lease.clone())));
                                        for i in &done {
                                            println!("plugin-provision {} {}", i.feature, i.sha256);
                                        }
                                        let ready = vec![false; done.len()];
                                        state.installations.push(Installation {
                                            paths,
                                            features: done,
                                            written: contents,
                                            readiness,
                                            ready,
                                            since: tokio::time::Instant::now(),
                                        });
                                        Ok((state.installations.len() - 1, true))
                                    }
                                };
                                match registered {
                                    Ok(pair) => Ok(pair),
                                    Err(stale_done) => {
                                        let _ =
                                            tokio::task::spawn_blocking(move || provision::dispose(&stale_done)).await;
                                        Err("OpenCode connection replaced during plugin provisioning".into())
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
    let snapshot = {
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
                state.prepared = None;
                state.last = Some(message);
            }
        }
        status(app, &state)
    };
    write_status(snapshot).await;
}

/// `DesktopPluginLifecycle.sync`: rewrite a lease whose request changed, else renew it off-thread
/// with non-blocking POSIX opens so a replaced FIFO can never stall the Tokio thread or worker pool.
async fn sync(app: &App, renew: bool) {
    let plan: Vec<(usize, usize, std::path::PathBuf, Option<String>, bool, bool)> = {
        let state = STATE.lock().unwrap();
        let mut jobs = Vec::new();
        for (inst_idx, installation) in state.installations.iter().enumerate() {
            let check_ready_window = installation.since.elapsed() <= READY_WAIT;
            for (feat_idx, feature) in installation.features.iter().enumerate() {
                let wanted = content(app, feature.feature);
                let rewrite = (wanted != installation.written[feat_idx]).then_some(wanted);
                let check_ready = check_ready_window && !installation.ready[feat_idx];
                if rewrite.is_some() || renew || check_ready {
                    jobs.push((inst_idx, feat_idx, feature.lease.clone(), rewrite, renew, check_ready));
                }
            }
        }
        jobs
    };
    if plan.is_empty() {
        return;
    }
    let results = tokio::task::spawn_blocking(move || {
        let mut out = Vec::with_capacity(plan.len());
        for (inst_idx, feat_idx, lease, rewrite, do_renew, check_ready) in plan {
            let written = if let Some(wanted) = rewrite {
                crate::extensions::artifact::write_replacing(&lease, wanted.as_bytes()).is_ok().then_some(wanted)
            } else {
                if do_renew {
                    let now = std::time::SystemTime::now();
                    let mut opts = fs::OpenOptions::new();
                    opts.write(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        opts.custom_flags(libc::O_NONBLOCK);
                    }
                    // The reference ignores a failed renewal; the lease simply expires.
                    if let Ok(file) = opts.open(&lease)
                        && file.metadata().is_ok_and(|meta| meta.is_file())
                    {
                        let _ = file.set_modified(now);
                    }
                }
                None
            };
            let became_ready = check_ready && provision::ready_marker(&lease).exists();
            if written.is_some() || became_ready {
                out.push((inst_idx, feat_idx, lease, written, became_ready));
            }
        }
        out
    })
    .await
    .unwrap_or_default();
    if results.is_empty() {
        return;
    }
    let snapshot = {
        let mut state = STATE.lock().unwrap();
        let mut changed = false;
        for (inst_idx, feat_idx, lease, written, became_ready) in results {
            let Some(installation) = state.installations.get_mut(inst_idx) else { continue };
            let Some(feature) = installation.features.get(feat_idx) else { continue };
            if feature.lease != lease {
                continue;
            }
            if let Some(written) = written {
                installation.written[feat_idx] = written;
            }
            if became_ready && !installation.ready[feat_idx] {
                installation.ready[feat_idx] = true;
                changed = true;
            }
        }
        changed.then(|| status(app, &state))
    };
    if let Some(snapshot) = snapshot {
        write_status(snapshot).await;
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
        state.features = features.clone();
        state.stop = Some(stop.clone());
    }
    let app = app.clone();
    Ok(Some(tokio::spawn(async move {
        // Renew active leases on an independent timer so slow reprovisioning discovery
        // (up to 15 s) never pauses lease renewal (TS `desktop-plugin-installation.ts:138-151`).
        let sync_app = app.clone();
        let sync_stop = stop.clone();
        let sync_task = tokio::spawn(async move {
            let mut renewed = tokio::time::Instant::now();
            while !sync_stop.is_cancelled() {
                tokio::select! {
                    _ = sync_stop.cancelled() => break,
                    _ = SYNC_NOW.notified() => {}
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
                let renew = renewed.elapsed() >= PRESENCE_INTERVAL;
                if renew {
                    renewed = tokio::time::Instant::now();
                }
                sync(&sync_app, renew).await;
            }
        });
        // A discovered daemon is first provisioned when its event stream connects.
        if let Some(endpoint) = app.native.endpoint() {
            let _serial = SERIAL.lock().await;
            connection_at(&app, Some(&endpoint), &features, Some(&stop)).await;
            let mut state = STATE.lock().unwrap();
            if state.current.is_some() && !stop.is_cancelled() && app.native.current(&endpoint) {
                state.prepared = Some(endpoint);
            }
        }
        while !stop.is_cancelled() {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = CONNECTED.notified() => {
                    let _serial = SERIAL.lock().await;
                    let endpoint = app.native.endpoint();
                    let already_prepared = endpoint.as_ref().is_some_and(|ep| {
                        let state = STATE.lock().unwrap();
                        state.current.is_some()
                            && state.prepared.as_ref().is_some_and(|prepared| Arc::ptr_eq(prepared, ep))
                    });
                    if already_prepared {
                        continue;
                    }
                    connection_at(&app, endpoint.as_ref(), &features, Some(&stop)).await;
                    if let Some(endpoint) = endpoint
                        && app.native.current(&endpoint)
                    {
                        let mut state = STATE.lock().unwrap();
                        if state.current.is_some() {
                            state.prepared = Some(endpoint);
                        }
                    }
                }
            }
        }
        let _ = sync_task.await;
        // Hold `SERIAL` across shutdown cleanup so any detached `prepare()` finishes and
        // registers its leases before we drain them, and subsequent waiters see `!state.active`.
        let _serial = SERIAL.lock().await;
        let (owners, leases, snapshot): (Vec<_>, Vec<_>, _) = {
            let mut state = STATE.lock().unwrap();
            state.active = false;
            let installations = std::mem::take(&mut state.installations);
            state.current = None;
            let snapshot = status(&app, &state);
            let (owners, leases) = installations.into_iter().map(|i| (i.readiness, i.features)).unzip();
            (owners, leases, snapshot)
        };
        write_status(snapshot).await;
        for owner in owners.into_iter().flatten() {
            owner.close().await;
        }
        let _ = tokio::task::spawn_blocking(move || {
            for features in leases {
                provision::dispose(&features);
            }
        })
        .await;
    })))
}

/// Ensures bundled plugins are provisioned for this exact captured endpoint, then runs a
/// fresh presence challenge against that endpoint's installation under the same deadline.
pub async fn ready_at(
    app: &Shared,
    endpoint: &Arc<crate::opencode::Endpoint>,
    directory: &str,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    if !STATE.lock().unwrap().active {
        return Ok(());
    }
    tokio::time::timeout_at(deadline, prepare(app, endpoint))
        .await
        .map_err(|_| "Provisioning timed out for captured connection".to_owned())?;
    let owner = {
        let state = STATE.lock().unwrap();
        if !state.active {
            return Ok(());
        }
        if !state.prepared.as_ref().is_some_and(|prepared| Arc::ptr_eq(prepared, endpoint)) {
            return Err("Pruning lease does not match captured connection".into());
        }
        state.current.and_then(|i| state.installations[i].readiness.clone())
    };
    let owner = owner.ok_or("Pruning presence unavailable for captured connection")?;
    owner.prepare(directory, deadline).await.map(|_| ())
}
