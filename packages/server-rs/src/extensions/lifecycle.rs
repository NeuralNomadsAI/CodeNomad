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
    /// Leases whose immediate rollback disposal failed (e.g. Windows sharing violation), retained so
    /// shutdown retries removing them and reports `incomplete` if any still remain on disk.
    stranded: Vec<Vec<provision::Installed>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);
/// Shared-read / exclusive-shutdown gate for plugin lease I/O: concurrent provisioning and
/// independent lease renewals take `read()`, while shutdown disposal takes `write()` after
/// clearing `STATE.active` so no in-flight install or renewal can strand a lease on disk.
static LEASE_IO: std::sync::RwLock<()> = std::sync::RwLock::new(());
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
            if !state.active
                || !state.preparing.as_ref().is_some_and(|(ep, n)| Arc::ptr_eq(ep, endpoint) && Arc::ptr_eq(n, &notify))
            {
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

fn status(app: &App, state: &State) -> (u64, std::path::PathBuf, Vec<u8>) {
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
    let seq = NEXT_STATUS_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    (seq, app.data.join("plugin-provision.json"), doc.to_string().into_bytes())
}

static NEXT_STATUS_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static STATUS_WRITE: Mutex<u64> = Mutex::new(0);

async fn write_status((seq, path, bytes): (u64, std::path::PathBuf, Vec<u8>)) {
    let _ = tokio::task::spawn_blocking(move || {
        let mut last = STATUS_WRITE.lock().unwrap();
        if seq < *last {
            return;
        }
        *last = seq;
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
                        let (target, chosen) = (paths.clone(), features.to_vec());
                        let app_check = app.clone();
                        let ep_check = endpoint.cloned();
                        let stop_check = stop.cloned();
                        // Compute lease contents (which may read `config.yaml` for Memory) AND run
                        // installation + STATE registration under `LEASE_IO` inside `spawn_blocking`
                        // so neither the single-thread Tokio executor nor `LEASE_IO` blocks on
                        // config I/O and shutdown can never leave an unregistered `.lease` file.
                        // Lock order is strictly `LEASE_IO` -> `STATE`.
                        tokio::task::spawn_blocking(move || {
                            let written: Vec<String> = chosen.iter().map(|f| content(&app_check, f)).collect();
                            let _io = LEASE_IO.read().unwrap();
                            let still_current = || {
                                !stop_check.as_ref().is_some_and(CancellationToken::is_cancelled)
                                    && ep_check.as_ref().is_none_or(|ep| app_check.native.current(ep))
                                    && STATE.lock().unwrap().active
                            };
                            if !still_current() {
                                return Err("OpenCode connection replaced before plugin installation".into());
                            }
                            let mut done = Vec::new();
                            for (feature, lease) in chosen.into_iter().zip(&written) {
                                let result = provision::payloads(feature).and_then(|(b, p)| {
                                    provision::install_checked(
                                        feature,
                                        &b,
                                        p.as_deref(),
                                        &target,
                                        lease,
                                        still_current,
                                        &mut done,
                                    )
                                });
                                match result {
                                    Ok(i) => done.push(i),
                                    // A failed attempt relinquishes only its own new leases
                                    // (including any lease whose immediate rollback failed);
                                    // record leftovers so shutdown retries their removal.
                                    Err(e) => {
                                        if !done.is_empty() && provision::dispose_checked(&done).is_err() {
                                            STATE.lock().unwrap().stranded.push(done);
                                        }
                                        return Err(format!(
                                            "Failed to provision bundled desktop plugins for the current connection: {e}"
                                        ));
                                    }
                                }
                            }
                            let mut state = STATE.lock().unwrap();
                            if !state.active
                                || stop_check.as_ref().is_some_and(CancellationToken::is_cancelled)
                                || ep_check.as_ref().is_some_and(|ep| !app_check.native.current(ep))
                            {
                                drop(state);
                                if provision::dispose_checked(&done).is_err() {
                                    STATE.lock().unwrap().stranded.push(done);
                                }
                                return Err("OpenCode connection replaced during plugin provisioning".into());
                            }
                            let readiness = done
                                .iter()
                                .find(|i| i.feature == "session-pruning")
                                .map(|i| Arc::new(Owner::new(i.lease.clone())));
                            for i in &done {
                                println!("plugin-provision {} {}", i.feature, i.sha256);
                            }
                            let ready = vec![false; done.len()];
                            state.installations.push(Installation {
                                paths: target,
                                features: done,
                                written,
                                readiness,
                                ready,
                                since: tokio::time::Instant::now(),
                            });
                            Ok((state.installations.len() - 1, true))
                        })
                        .await
                        .unwrap_or_else(|_| Err("Provisioning task failed".into()))
                    }
                }
            }
        }
    };
    let (snapshot, stale_install) = {
        let mut state = STATE.lock().unwrap();
        let mut stale_install = None;
        match outcome {
            Ok((index, fresh)) => {
                if !state.active
                    || stop.is_some_and(CancellationToken::is_cancelled)
                    || endpoint.is_some_and(|ep| !app.native.current(ep))
                {
                    // Move a freshly added installation directly from `installations` into
                    // `stranded` while still holding `STATE` so shutdown can never observe a gap
                    // where the lease is in neither list (TS `desktop-plugin-lifecycle.ts:99-117`).
                    if fresh && index < state.installations.len() {
                        let removed = state.installations.remove(index);
                        if state.current.is_some_and(|c| c == index) {
                            state.current = None;
                        } else if let Some(c) = &mut state.current
                            && *c > index
                        {
                            *c -= 1;
                        }
                        state.stranded.push(removed.features);
                        stale_install = removed.readiness;
                    }
                    state.current = None;
                    state.prepared = None;
                } else {
                    state.current = Some(index);
                    state.prepared = endpoint.cloned();
                    state.reported.clear();
                    state.last = None;
                    if !fresh {
                        println!("plugin-provision connection {} reused", state.connections);
                    }
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
        (status(app, &state), stale_install)
    };
    if let Some(owner) = stale_install {
        let _ = tokio::time::timeout(Duration::from_secs(1), owner.close()).await;
    }
    let has_stranded = !STATE.lock().unwrap().stranded.is_empty();
    if has_stranded {
        let _ = tokio::task::spawn_blocking(move || {
            // Take exclusive `LEASE_IO.write()` so a concurrent `sync()` worker cannot recreate
            // a disposed lease, and keep any failed removal in `state.stranded` for shutdown.
            let _io = LEASE_IO.write().unwrap();
            let pending = std::mem::take(&mut STATE.lock().unwrap().stranded);
            let mut failed = Vec::new();
            for features in pending {
                if provision::dispose_checked(&features).is_err() {
                    failed.push(features);
                }
            }
            if !failed.is_empty() {
                STATE.lock().unwrap().stranded.extend(failed);
            }
        })
        .await;
    }
    write_status(snapshot).await;
}

/// `DesktopPluginLifecycle.sync`: compute desired lease content and rewrite/renew off-thread
/// with non-blocking POSIX opens so a replaced FIFO on `config.yaml` or a lease file can never
/// stall the Tokio thread or worker pool.
async fn sync(app: &Shared, renew: bool) {
    let plan: Vec<(usize, usize, &'static str, std::path::PathBuf, String, bool, bool)> = {
        let state = STATE.lock().unwrap();
        let mut jobs = Vec::new();
        for (inst_idx, installation) in state.installations.iter().enumerate() {
            let check_ready_window = installation.since.elapsed() <= READY_WAIT;
            for (feat_idx, feature) in installation.features.iter().enumerate() {
                let check_ready = check_ready_window && !installation.ready[feat_idx];
                jobs.push((
                    inst_idx,
                    feat_idx,
                    feature.feature,
                    feature.lease.clone(),
                    installation.written[feat_idx].clone(),
                    renew,
                    check_ready,
                ));
            }
        }
        jobs
    };
    if plan.is_empty() {
        return;
    }
    let sync_app = app.clone();
    let results = tokio::task::spawn_blocking(move || {
        let mut out = Vec::with_capacity(plan.len());
        for (inst_idx, feat_idx, feature_name, lease, prev_written, do_renew, check_ready) in plan {
            let wanted = content(&sync_app, feature_name);
            let rewrite = (wanted != prev_written).then_some(wanted);
            if rewrite.is_none() && !do_renew && !check_ready {
                continue;
            }
            let written = {
                let _io = LEASE_IO.read().unwrap();
                let still_registered = {
                    let state = STATE.lock().unwrap();
                    state.active
                        && state.installations.iter().any(|inst| inst.features.iter().any(|f| f.lease == lease))
                };
                if !still_registered {
                    continue;
                }
                if let Some(wanted) = rewrite {
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
                }
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

pub fn start(
    app: &Shared,
    stop: CancellationToken,
) -> Result<Option<tokio::task::JoinHandle<Result<(), String>>>, String> {
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
            tokio::select! {
                biased;
                _ = stop.cancelled() => {}
                _ = async {
                    let _serial = SERIAL.lock().await;
                    connection_at(&app, Some(&endpoint), &features, Some(&stop)).await;
                } => {}
            }
        }
        while !stop.is_cancelled() {
            tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                _ = CONNECTED.notified() => {
                    tokio::select! {
                        biased;
                        _ = stop.cancelled() => break,
                        _ = async {
                            let _serial = SERIAL.lock().await;
                            let endpoint = app.native.endpoint();
                            let already_prepared = endpoint.as_ref().is_some_and(|ep| {
                                let state = STATE.lock().unwrap();
                                state.current.is_some()
                                    && state.prepared.as_ref().is_some_and(|prepared| Arc::ptr_eq(prepared, ep))
                            });
                            if !already_prepared {
                                connection_at(&app, endpoint.as_ref(), &features, Some(&stop)).await;
                            }
                        } => {}
                    }
                }
            }
        }
        // Mark inactive immediately so any in-flight `sync_leases` worker exits before rewriting
        // leases once it acquires `LEASE_IO`.
        {
            STATE.lock().unwrap().active = false;
        }
        let mut sync_task = sync_task;
        if tokio::time::timeout(Duration::from_secs(1), &mut sync_task).await.is_err() {
            sync_task.abort();
        }
        // Hold `SERIAL` briefly across shutdown cleanup so any finishing `prepare()` registers its
        // leases before we drain them; if `SERIAL` is still held past the cap, report failure so
        // shutdown never claims `complete` with a potentially unregistered in-flight lease.
        let serial_guard = tokio::time::timeout(Duration::from_secs(2), SERIAL.lock()).await.ok();
        let serial_timed_out = serial_guard.is_none();
        let (owners, mut leases, snapshot): (Vec<_>, Vec<_>, _) = {
            let mut state = STATE.lock().unwrap();
            state.active = false;
            let installations = std::mem::take(&mut state.installations);
            let stranded = std::mem::take(&mut state.stranded);
            state.current = None;
            state.prepared = None;
            let snapshot = status(&app, &state);
            let (owners, mut leases): (Vec<_>, Vec<_>) =
                installations.into_iter().map(|i| (i.readiness, i.features)).unzip();
            leases.extend(stranded);
            (owners, leases, snapshot)
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), write_status(snapshot)).await;
        // Close all presence owners concurrently, waiting up to 6 s (matching `Owner::close`'s
        // pending-request drain window and TS `desktop-plugin-readiness.ts:174-182`) before
        // removing leases so `.prepare` folders drain cleanly.
        let close_results = futures_util::future::join_all(owners.into_iter().flatten().map(|owner| async move {
            match tokio::time::timeout(Duration::from_secs(6), owner.close()).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(e),
                Err(_) => Err("Timed out closing plugin readiness owner during shutdown".into()),
            }
        }))
        .await;
        let close_err = close_results.into_iter().find_map(Result::err);
        // Hold `LEASE_IO` across disposal so a late `sync_leases` worker can never recreate a
        // deleted lease after shutdown cleanup; retry once after 250 ms (TS `shutdown.ts:135-146`).
        // Bound the wait so a stalled background `sync_leases` I/O call cannot hang shutdown forever.
        let disposed = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let _io = LEASE_IO.write().unwrap();
                leases.extend(std::mem::take(&mut STATE.lock().unwrap().stranded));
                let mut last_err = None;
                for attempt in 0..2 {
                    let mut first_err = None;
                    for features in &leases {
                        if let Err(e) = provision::dispose_checked(features)
                            && first_err.is_none()
                        {
                            first_err = Some(e.to_string());
                        }
                    }
                    if first_err.is_none() {
                        return Ok(());
                    }
                    last_err = first_err;
                    if attempt == 0 {
                        std::thread::sleep(Duration::from_millis(250));
                    }
                }
                Err(last_err.unwrap())
            }),
        )
        .await;
        drop(serial_guard);
        match disposed {
            Ok(Ok(Ok(()))) if !serial_timed_out && close_err.is_none() => Ok(()),
            Ok(Ok(Ok(()))) if serial_timed_out => {
                Err("Timed out waiting for in-flight plugin provisioning during shutdown".into())
            }
            Ok(Ok(Ok(()))) => Err(close_err.unwrap()),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("Timed out disposing plugin leases during shutdown".into()),
        }
    })))
}

/// Returns true when the lifecycle is inactive or this exact captured endpoint already owns the
/// active session-pruning readiness lease (TS `desktop-plugin-lifecycle.ts:147-154`).
pub fn has_ready_lease(app: &Shared, endpoint: &Arc<crate::opencode::Endpoint>) -> bool {
    let state = STATE.lock().unwrap();
    if !state.active {
        return true;
    }
    app.native.current(endpoint)
        && state.prepared.as_ref().is_some_and(|prepared| Arc::ptr_eq(prepared, endpoint))
        && state.current.and_then(|i| state.installations[i].readiness.as_ref()).is_some()
}

/// Runs a fresh presence challenge against the lease already bound to this exact captured
/// endpoint under the caller's deadline, without re-provisioning (TS `desktop-plugin-lifecycle.ts:147-154`).
pub async fn ready_at(
    app: &Shared,
    endpoint: &Arc<crate::opencode::Endpoint>,
    directory: &str,
    deadline: tokio::time::Instant,
    still_valid: impl Fn() -> bool,
) -> Result<(), String> {
    if !STATE.lock().unwrap().active {
        return Ok(());
    }
    ready_strict_at(app, endpoint, directory, deadline, still_valid).await
}

/// Strict variant requiring an active lifecycle installation bound to `endpoint` with a live
/// readiness owner, never bypassing readiness when provisioning is inactive.
pub fn has_strict_ready_lease(app: &Shared, endpoint: &Arc<crate::opencode::Endpoint>) -> bool {
    #[cfg(test)]
    if test_lease_for(endpoint).is_some() {
        return app.native.current(endpoint);
    }
    let state = STATE.lock().unwrap();
    state.active
        && app.native.current(endpoint)
        && state.prepared.as_ref().is_some_and(|prepared| Arc::ptr_eq(prepared, endpoint))
        && state.current.and_then(|i| state.installations[i].readiness.as_ref()).is_some()
}

/// Strict variant of [`ready_at`] requiring an active lifecycle installation bound to `endpoint`.
pub async fn ready_strict_at(
    app: &Shared,
    endpoint: &Arc<crate::opencode::Endpoint>,
    directory: &str,
    deadline: tokio::time::Instant,
    still_valid: impl Fn() -> bool,
) -> Result<(), String> {
    if !still_valid() {
        return Err("Operation is no longer valid".into());
    }
    #[cfg(test)]
    if let Some(owner) = test_lease_for(endpoint) {
        if !app.native.current(endpoint) || !still_valid() {
            return Err("Pruning lease does not match captured connection".into());
        }
        return owner
            .prepare_while(directory, deadline, || app.native.current(endpoint) && still_valid())
            .await
            .map(|_| ());
    }
    let owner = {
        let state = STATE.lock().unwrap();
        if !state.active
            || !app.native.current(endpoint)
            || !still_valid()
            || !state.prepared.as_ref().is_some_and(|prepared| Arc::ptr_eq(prepared, endpoint))
        {
            return Err("Pruning lease does not match captured connection".into());
        }
        state.current.and_then(|i| state.installations[i].readiness.clone())
    };
    let owner = owner.ok_or("Pruning presence unavailable for captured connection")?;
    owner.prepare_while(directory, deadline, || app.native.current(endpoint) && still_valid()).await.map(|_| ())
}

#[cfg(test)]
static TEST_LEASES: LazyLock<Mutex<std::collections::HashMap<usize, Arc<Owner>>>> = LazyLock::new(Default::default);

#[cfg(test)]
fn test_lease_for(endpoint: &Arc<crate::opencode::Endpoint>) -> Option<Arc<Owner>> {
    TEST_LEASES.lock().unwrap().get(&(Arc::as_ptr(endpoint) as usize)).cloned()
}

#[cfg(test)]
pub(crate) struct TestReadinessGuard {
    endpoint: Arc<crate::opencode::Endpoint>,
}

#[cfg(test)]
impl Drop for TestReadinessGuard {
    fn drop(&mut self) {
        TEST_LEASES.lock().unwrap().remove(&(Arc::as_ptr(&self.endpoint) as usize));
    }
}

/// Registers a test-only readiness lease scoped exclusively to `endpoint`, without activating or
/// mutating the process-wide provisioning lifecycle `STATE` used by unrelated parallel tests.
#[cfg(test)]
pub(crate) fn install_test_readiness_lease(
    endpoint: Arc<crate::opencode::Endpoint>,
    lease: std::path::PathBuf,
) -> TestReadinessGuard {
    let key = Arc::as_ptr(&endpoint) as usize;
    TEST_LEASES.lock().unwrap().insert(key, Arc::new(Owner::new(lease)));
    TestReadinessGuard { endpoint }
}
