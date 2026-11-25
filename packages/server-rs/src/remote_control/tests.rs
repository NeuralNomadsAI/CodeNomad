use std::{
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Bytes,
    extract::{Path as RoutePath, State},
    http::{StatusCode as Status, header},
    middleware::from_fn_with_state,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    lease::OwnerLease,
    start_route, stop_route,
    tunnel::{OpenRequest, TunnelOpener, TunnelSession, TunnelState, open_opentunnel},
};
use crate::{App, Shared, auth, files, opencode, settings};

struct FakeTunnel {
    hostname: String,
    url: String,
    state: Mutex<TunnelState>,
    closed_rx: Mutex<Option<oneshot::Receiver<Option<String>>>>,
    _keep_alive: Mutex<Option<oneshot::Sender<Option<String>>>>,
    closed_flag: Arc<AtomicBool>,
}

impl FakeTunnel {
    fn live(route: &str) -> (Arc<Self>, Arc<AtomicBool>) {
        let (tx, rx) = oneshot::channel();
        let closed_flag = Arc::new(AtomicBool::new(false));
        let hostname = format!("{route}.tunnel.example");
        let url = format!("https://{hostname}");
        (
            Arc::new(Self {
                hostname,
                url,
                state: Mutex::new(TunnelState::Connected),
                closed_rx: Mutex::new(Some(rx)),
                _keep_alive: Mutex::new(Some(tx)),
                closed_flag: closed_flag.clone(),
            }),
            closed_flag,
        )
    }

    fn pair(route: &str) -> (Arc<Self>, oneshot::Sender<Option<String>>, Arc<AtomicBool>) {
        let (tx, rx) = oneshot::channel();
        let closed_flag = Arc::new(AtomicBool::new(false));
        let hostname = format!("{route}.tunnel.example");
        let url = format!("https://{hostname}");
        (
            Arc::new(Self {
                hostname,
                url,
                state: Mutex::new(TunnelState::Connected),
                closed_rx: Mutex::new(Some(rx)),
                _keep_alive: Mutex::new(None),
                closed_flag: closed_flag.clone(),
            }),
            tx,
            closed_flag,
        )
    }
}

impl TunnelSession for FakeTunnel {
    fn hostname(&self) -> &str {
        &self.hostname
    }

    fn url(&self) -> &str {
        &self.url
    }

    fn state(&self) -> TunnelState {
        *self.state.lock().unwrap()
    }

    fn take_closed(&self) -> Option<oneshot::Receiver<Option<String>>> {
        self.closed_rx.lock().unwrap().take()
    }

    fn close(&self) -> Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.closed_flag.store(true, Ordering::SeqCst);
        *self.state.lock().unwrap() = TunnelState::Stopped;
        Box::pin(async {})
    }
}

fn build_test_app(dir: &PathBuf, origins: Vec<String>, disabled_by_admin: bool) -> Shared {
    build_test_app_with_port(dir, 0, origins, disabled_by_admin)
}

fn build_test_app_with_port(dir: &PathBuf, port: u16, origins: Vec<String>, disabled_by_admin: bool) -> Shared {
    let origin = origins.first().cloned().unwrap_or_default();
    let devices = auth::devices::open_for_test_with_policy(dir, origin, origins, disabled_by_admin);
    let auth = auth::Auth::new(auth::Settings {
        username: "fixture".into(),
        password: None,
        file: None,
        cookie: "fixture".into(),
        token: false,
        managed_local: false,
        skip: true,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let settings =
        settings::Settings::new(settings::document::Location::resolve(dir.join("config.yaml").to_str().unwrap()));
    let native = opencode::Native::test_connection(([127, 0, 0, 1], 9).into());
    let app = Arc::new(App::new(
        auth,
        port,
        dir.clone(),
        dir.clone(),
        false,
        settings,
        Value::Null,
        native,
        PathBuf::new(),
        Some(devices),
        files::watch::Watches::new(tx),
        None,
    ));
    let remote_router = Router::new()
        .merge(auth::routes())
        .merge(auth::remote_routes())
        .merge(crate::previews::routes())
        .layer(from_fn_with_state((app.clone(), None), auth::remote::admit))
        .with_state(app.clone());
    app.remote_control.attach_router(remote_router);
    app
}

async fn response_json(resp: axum::response::Response) -> (Status, Value) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 16 * 1024).await.unwrap();
    let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
    (status, value)
}

#[test]
fn owner_lease_acquires_blocks_live_replaces_stale_and_releases_own_only() {
    let dir = crate::shared::test_dir("rc-lease");
    let file = dir.join("remote-control.owner");
    let alive = Arc::new(AtomicBool::new(true));
    let alive_check = alive.clone();
    let lease_a = OwnerLease::with_hooks(file.clone(), 1001, Arc::new(move |_| alive_check.load(Ordering::SeqCst)));
    let alive_check = alive.clone();
    let lease_b = OwnerLease::with_hooks(file.clone(), 2002, Arc::new(move |_| alive_check.load(Ordering::SeqCst)));

    assert!(lease_a.try_acquire());
    assert!(lease_a.try_acquire(), "same PID re-acquires");
    assert!(!lease_b.try_acquire(), "live owner blocks second backend");

    // Releasing by non-owner leaves owner's file intact.
    lease_b.release();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "1001");

    // Once owner dies, stale lease is replaced.
    alive.store(false, Ordering::SeqCst);
    assert!(lease_b.try_acquire());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "2002");

    // Corrupt lease file is replaced cleanly.
    std::fs::write(&file, "not-a-pid").unwrap();
    assert!(lease_a.try_acquire());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "1001");

    lease_a.release();
    assert!(!file.exists());

    // Real OS liveness check sees current process as alive.
    let real = OwnerLease::new(&dir);
    assert!(real.try_acquire());
    let contender = OwnerLease::with_hooks(
        file.clone(),
        std::process::id().wrapping_add(1),
        Arc::new(|pid| pid == std::process::id()),
    );
    assert!(!contender.try_acquire());
    real.release();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn start_pair_over_ingress_previews_and_stop_lifecycle() {
    let dir = crate::shared::test_dir("rc-lifecycle");
    let app = build_test_app(&dir, vec![], false);
    let registry_path = dir.join("remote-control-devices.json");
    assert!(!registry_path.exists(), "fresh host writes nothing before first Remote Control use");

    // Initial status is stopped and previews default to true.
    let initial = auth::devices::status(State(app.clone()), None).await.0;
    assert_eq!(initial["state"], "stopped");
    assert_eq!(initial["enabled"], false);
    assert_eq!(initial["startsOnLaunch"], false);
    assert_eq!(initial["previews"], true);
    assert_eq!(initial["manageable"], true);

    // Issuing a tunnel pairing while stopped returns 409 Conflict.
    let (code, body) = response_json(auth::devices::issue(State(app.clone()), Bytes::new()).await).await;
    assert_eq!(code, Status::CONFLICT);
    assert_eq!(body["error"], "Remote Control is not connected");

    let closed_flag_slot: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));
    let observed_target: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let closed_ref = closed_flag_slot.clone();
    let target_ref = observed_target.clone();
    let opener: TunnelOpener = Arc::new(move |req: OpenRequest| {
        let closed_ref = closed_ref.clone();
        let target_ref = target_ref.clone();
        Box::pin(async move {
            *target_ref.lock().unwrap() = Some(req.target.clone());
            let (tunnel, closed_flag) = FakeTunnel::live(&req.route);
            (req.on_origin)(tunnel.url.clone());
            *closed_ref.lock().unwrap() = Some(closed_flag);
            Ok(tunnel as Arc<dyn TunnelSession>)
        })
    });
    app.remote_control.set_opener(opener);

    // POST /api/remote-control/start starts ingress + tunnel and issues a pairing link.
    let (status_code, started) = response_json(start_route(State(app.clone())).await).await;
    assert_eq!(status_code, Status::OK);
    assert_eq!(started["status"]["enabled"], true);
    assert_eq!(started["status"]["startsOnLaunch"], true);
    assert_eq!(started["status"]["state"], "connected");
    assert_eq!(started["status"]["previews"], true);
    assert!(started["status"]["lastConnectedAt"].as_str().is_some());
    assert!(registry_path.exists(), "route & startsOnLaunch persisted on start");

    let remote_url = started["status"]["remoteUrl"].as_str().unwrap().to_owned();
    let host = remote_url.strip_prefix("https://").unwrap().to_owned();
    let pairing_url = started["pairing"]["url"].as_str().unwrap();
    let pair_code = pairing_url.strip_prefix(&format!("{remote_url}/remote-pair#")).expect(pairing_url);

    let ingress_target = observed_target.lock().unwrap().clone().unwrap();
    let ingress_port = app.remote_control.ingress_port().unwrap();
    assert_eq!(ingress_target, format!("127.0.0.1:{ingress_port}"));

    // Talk to the real loopback ingress as OpenTunnel does after terminating TLS.
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{ingress_target}");

    // Unknown Host header -> 421 Misdirected Request.
    let rogue =
        client.get(format!("{base}/api/auth/status")).header(header::HOST, "evil.invalid").send().await.unwrap();
    assert_eq!(rogue.status(), Status::MISDIRECTED_REQUEST);

    // Pairing page served with no-store, no-referrer, DENY framing.
    let page = client.get(format!("{base}/remote-pair")).header(header::HOST, &host).send().await.unwrap();
    assert_eq!(page.status(), Status::OK);
    assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(page.headers()[header::REFERRER_POLICY], "no-referrer");
    assert_eq!(page.headers()[header::X_FRAME_OPTIONS], "DENY");

    // Exchange pairing code over ingress -> Set-Cookie bound to tunnel device.
    let paired = client
        .post(format!("{base}/api/remote-control/pair"))
        .header(header::HOST, &host)
        .header(header::ORIGIN, &remote_url)
        .json(&json!({ "code": pair_code }))
        .send()
        .await
        .unwrap();
    assert_eq!(paired.status(), Status::OK);
    let cookie = paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let paired_body: Value = paired.json().await.unwrap();
    let device_id = Uuid::parse_str(paired_body["device"]["id"].as_str().unwrap()).unwrap();

    // Authenticated remote status reports manageable: false and omits directOrigins.
    let remote_status: Value = client
        .get(format!("{base}/api/remote-control/status"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(remote_status["manageable"], false);
    assert_eq!(remote_status["state"], "connected");
    assert_eq!(remote_status["pairedDevices"], 1);
    assert!(remote_status.get("directOrigins").is_none());

    // Host-only control routes are refused with 404 over ingress.
    for (method, path) in [
        (reqwest::Method::POST, "/api/remote-control/start"),
        (reqwest::Method::DELETE, "/api/remote-control"),
        (reqwest::Method::GET, "/api/remote-control/devices"),
    ] {
        let resp = client
            .request(method, format!("{base}{path}"))
            .header(header::HOST, &host)
            .header(header::ORIGIN, &remote_url)
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), Status::NOT_FOUND, "remote path {path} must be refused");
    }

    // PUT /api/remote-control/previews returns the live connected status (never hardcoded stopped).
    let (pv_code, pv_status) = response_json(
        auth::devices::set_previews(State(app.clone()), Bytes::from_static(br#"{"enabled":false}"#)).await,
    )
    .await;
    assert_eq!(pv_code, Status::OK);
    assert_eq!(pv_status["state"], "connected");
    assert_eq!(pv_status["enabled"], true);
    assert_eq!(pv_status["previews"], false);

    // Self-proxy guard refuses a preview targeting the active ingress port.
    let preview_target = format!("http://127.0.0.1:{ingress_port}/api/auth/status");
    let preview_created = reqwest::Url::parse(&preview_target).unwrap();
    let pinned = crate::previews::test_pinned_client(&app, &preview_created).await;
    assert_eq!(pinned.err(), Some(Status::NOT_FOUND));

    // DELETE /api/remote-control stops tunnel, clears startsOnLaunch, stops ingress and revokes live tunnel auth.
    let (stop_code, stopped) = response_json(stop_route(State(app.clone())).await).await;
    assert_eq!(stop_code, Status::OK);
    assert_eq!(stopped["enabled"], false);
    assert_eq!(stopped["startsOnLaunch"], false);
    assert_eq!(stopped["state"], "stopped");
    assert!(stopped.get("remoteUrl").is_none());
    assert!(closed_flag_slot.lock().unwrap().as_ref().unwrap().load(Ordering::SeqCst));
    assert!(app.remote_control.ingress_port().is_none());
    assert!(
        !app.devices.as_ref().unwrap().lock().unwrap().is_authorized(device_id, app.remote_control.is_tunnel_active())
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn stop_cancels_in_flight_start_and_allows_clean_restart() {
    let dir = crate::shared::test_dir("rc-cancel-start");
    let app = build_test_app(&dir, vec![], false);

    let entered = Arc::new(Notify::new());
    let release_slow = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let late_closed = Arc::new(AtomicBool::new(false));

    let entered_c = entered.clone();
    let release_c = release_slow.clone();
    let calls_c = calls.clone();
    let late_closed_c = late_closed.clone();

    let opener: TunnelOpener = Arc::new(move |req: OpenRequest| {
        let entered = entered_c.clone();
        let release = release_c.clone();
        let calls = calls_c.clone();
        let late_closed = late_closed_c.clone();
        let call_num = calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call_num == 0 {
                // Deliberately ignore req.cancel to verify generation fencing still closes a late tunnel.
                entered.notify_one();
                release.notified().await;
                let (tunnel, closed_flag) = FakeTunnel::live(&req.route);
                return Ok(Arc::new(ClosingSpy { inner: tunnel, flag: late_closed_c_wrap(closed_flag, late_closed) })
                    as Arc<dyn TunnelSession>);
            }
            let (tunnel, _closed) = FakeTunnel::live(&req.route);
            (req.on_origin)(tunnel.url.clone());
            Ok(tunnel as Arc<dyn TunnelSession>)
        })
    });
    app.remote_control.set_opener(opener);

    let app_start = app.clone();
    let first_start = tokio::spawn(async move { start_route(State(app_start)).await });
    entered.notified().await;

    // While first start is in-flight, status reports connecting.
    let mid = auth::devices::status(State(app.clone()), None).await.0;
    assert_eq!(mid["state"], "connecting");
    assert_eq!(mid["enabled"], true);

    // Stop while first start is still blocked, then release the slow opener.
    let app_stop = app.clone();
    let stop_task = tokio::spawn(async move { stop_route(State(app_stop)).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    release_slow.notify_one();

    let (stop_code, stopped) = response_json(stop_task.await.unwrap()).await;
    assert_eq!(stop_code, Status::OK);
    assert_eq!(stopped["state"], "stopped");
    assert_eq!(stopped["enabled"], false);

    let (start1_code, start1_body) = response_json(first_start.await.unwrap()).await;
    assert_eq!(start1_code, Status::BAD_GATEWAY);
    assert_eq!(start1_body["error"], "Remote Control was stopped");
    assert!(late_closed.load(Ordering::SeqCst), "abandoned late tunnel must be closed");
    assert!(app.remote_control.ingress_port().is_none());

    // Subsequent start cleanly opens a fresh ingress and tunnel.
    let (start2_code, start2_body) = response_json(start_route(State(app.clone())).await).await;
    assert_eq!(start2_code, Status::OK);
    assert_eq!(start2_body["status"]["state"], "connected");
    assert!(app.remote_control.ingress_port().is_some());

    app.remote_control.shutdown(&app).await;
    let _ = std::fs::remove_dir_all(&dir);
}

fn late_closed_c_wrap(inner: Arc<AtomicBool>, outer: Arc<AtomicBool>) -> (Arc<AtomicBool>, Arc<AtomicBool>) {
    (inner, outer)
}

struct ClosingSpy {
    inner: Arc<FakeTunnel>,
    flag: (Arc<AtomicBool>, Arc<AtomicBool>),
}

impl TunnelSession for ClosingSpy {
    fn hostname(&self) -> &str {
        self.inner.hostname()
    }
    fn url(&self) -> &str {
        self.inner.url()
    }
    fn state(&self) -> TunnelState {
        self.inner.state()
    }
    fn take_closed(&self) -> Option<oneshot::Receiver<Option<String>>> {
        self.inner.take_closed()
    }
    fn close(&self) -> Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.flag.0.store(true, Ordering::SeqCst);
        self.flag.1.store(true, Ordering::SeqCst);
        self.inner.close()
    }
}

#[tokio::test]
async fn unexpected_tunnel_drop_sets_error_preserves_starts_on_launch_and_resumes_on_next_launch() {
    let dir = crate::shared::test_dir("rc-drop-resume");
    let app = build_test_app(&dir, vec![], false);

    let drop_tx_slot: Arc<Mutex<Option<oneshot::Sender<Option<String>>>>> = Arc::new(Mutex::new(None));
    let drop_ref = drop_tx_slot.clone();
    let opener: TunnelOpener = Arc::new(move |req: OpenRequest| {
        let drop_ref = drop_ref.clone();
        Box::pin(async move {
            let (tunnel, tx, _closed) = FakeTunnel::pair(&req.route);
            (req.on_origin)(tunnel.url.clone());
            *drop_ref.lock().unwrap() = Some(tx);
            Ok(tunnel as Arc<dyn TunnelSession>)
        })
    });
    app.remote_control.set_opener(opener.clone());

    let (code, _) = response_json(start_route(State(app.clone())).await).await;
    assert_eq!(code, Status::OK);

    // Simulate fatal tunnel drop from relay.
    let tx = drop_tx_slot.lock().unwrap().take().unwrap();
    tx.send(Some("bridge attach failed: bad_token".into())).unwrap();

    // Wait briefly for the watcher task to process the drop.
    for _ in 0..50 {
        let st = auth::devices::status(State(app.clone()), None).await.0;
        if st["state"] == "error" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let after_drop = auth::devices::status(State(app.clone()), None).await.0;
    assert_eq!(after_drop["state"], "error");
    assert_eq!(after_drop["enabled"], false);
    assert_eq!(after_drop["startsOnLaunch"], true, "unexpected drop keeps startsOnLaunch");
    assert_eq!(after_drop["error"], "bridge attach failed: bad_token");
    assert!(app.remote_control.ingress_port().is_none());
    assert!(!dir.join("remote-control.owner").exists(), "lease released on drop");

    // Next backend launch with same data dir resumes automatically when lease is free.
    let app2 = build_test_app(&dir, vec![], false);
    app2.remote_control.set_opener(opener.clone());
    app2.remote_control.resume(&app2).await;
    let resumed = auth::devices::status(State(app2.clone()), None).await.0;
    assert_eq!(resumed["state"], "connected");
    assert_eq!(resumed["enabled"], true);
    assert_eq!(resumed["startsOnLaunch"], true);

    // A third backend seeing another live owner does NOT resume at launch.
    let app3 = build_test_app(&dir, vec![], false);
    let calls3 = Arc::new(AtomicUsize::new(0));
    let calls3_c = calls3.clone();
    app3.remote_control.set_lease(OwnerLease::with_hooks(
        dir.join("remote-control.owner"),
        std::process::id().wrapping_add(99),
        Arc::new(|pid| pid == std::process::id()),
    ));
    app3.remote_control.set_opener(Arc::new(move |req: OpenRequest| {
        calls3_c.fetch_add(1, Ordering::SeqCst);
        let opener = opener.clone();
        opener(req)
    }));
    app3.remote_control.resume(&app3).await;
    assert_eq!(calls3.load(Ordering::SeqCst), 0, "contending backend skips launch resume");
    assert_eq!(auth::devices::status(State(app3.clone()), None).await.0["state"], "stopped");

    // Shutdown preserves startsOnLaunch, releases lease, and blocks late resume/start calls.
    app2.remote_control.shutdown(&app2).await;
    assert!(app2.devices.as_ref().unwrap().lock().unwrap().starts_on_launch());
    assert!(!dir.join("remote-control.owner").exists());
    app2.remote_control.resume(&app2).await;
    assert_eq!(auth::devices::status(State(app2.clone()), None).await.0["state"], "stopped");
    let (after_shutdown_code, _) = response_json(start_route(State(app2.clone())).await).await;
    assert_eq!(after_shutdown_code, Status::BAD_GATEWAY);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn administrator_disable_blocks_start_pairings_and_resume_while_keeping_revocation() {
    let dir = crate::shared::test_dir("rc-admin-disabled");
    // Seed a registry with startsOnLaunch=true and one existing paired device.
    let device_id = Uuid::new_v4();
    let now = crate::now();
    let doc = json!({
        "version": 1,
        "route": "codenomad-abcdef012345",
        "enabled": true,
        "devices": [{
            "id": device_id,
            "name": "Existing Phone",
            "tokenHash": "a".repeat(64),
            "createdAt": now,
            "lastSeenAt": now,
        }]
    });
    std::fs::write(dir.join("remote-control-devices.json"), serde_json::to_string_pretty(&doc).unwrap()).unwrap();

    let app = build_test_app(&dir, vec![], true);
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_c = calls.clone();
    app.remote_control.set_opener(Arc::new(move |req| {
        calls_c.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let (t, _tx, _c) = FakeTunnel::pair(&req.route);
            Ok(t as Arc<dyn TunnelSession>)
        })
    }));

    // Resume does nothing when disabled by administrator.
    app.remote_control.resume(&app).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let st = auth::devices::status(State(app.clone()), None).await.0;
    assert_eq!(st["disabledByAdministrator"], true);
    assert_eq!(st["startsOnLaunch"], false);
    assert_eq!(st["pairedDevices"], 1);

    // Start and pairings are refused with 403 remote_control_disabled.
    let (start_code, start_body) = response_json(start_route(State(app.clone())).await).await;
    assert_eq!(start_code, Status::FORBIDDEN);
    assert_eq!(start_body["code"], "remote_control_disabled");

    let (pair_code, pair_body) = response_json(auth::devices::issue(State(app.clone()), Bytes::new()).await).await;
    assert_eq!(pair_code, Status::FORBIDDEN);
    assert_eq!(pair_body["code"], "remote_control_disabled");

    // Existing devices stay listed and revocable.
    let (list_code, list_body) = response_json(auth::devices::list(State(app.clone())).await).await;
    assert_eq!(list_code, Status::OK);
    assert_eq!(list_body["devices"].as_array().unwrap().len(), 1);

    let revoke_resp = auth::devices::revoke(State(app.clone()), RoutePath(device_id.to_string())).await;
    assert_eq!(revoke_resp.status(), Status::NO_CONTENT);
    assert_eq!(auth::devices::status(State(app.clone()), None).await.0["pairedDevices"], 0);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn direct_https_pairing_remains_independent_of_tunnel_stop() {
    let dir = crate::shared::test_dir("rc-direct-indep");
    let direct = "https://192.168.1.50:9898".to_owned();
    let app = build_test_app(&dir, vec![direct.clone()], false);

    // Direct HTTPS pairing works even when tunnel is stopped.
    let (code, direct_pair) = response_json(
        auth::devices::issue(State(app.clone()), Bytes::from(format!(r#"{{"origin":"{direct}"}}"#))).await,
    )
    .await;
    assert_eq!(code, Status::OK);
    let direct_code =
        direct_pair["url"].as_str().unwrap().strip_prefix(&format!("{direct}/remote-pair#")).unwrap().to_owned();

    // Stopping the tunnel must NOT cancel the pending direct-HTTPS pairing code.
    let _ = stop_route(State(app.clone())).await;

    // Exchange the direct code on its verified direct channel succeeds.
    let channel = auth::tls::Channel {
        origin: direct.clone(),
        origins: Arc::from([direct.clone()]),
        ingress: false,
        socket: CancellationToken::new(),
        principal: Arc::new(Mutex::new(None)),
    };
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/remote-control/pair")
        .body(axum::body::Body::from(format!(r#"{{"code":"{direct_code}"}}"#)))
        .unwrap();
    let exchanged = auth::devices::exchange(State(app.clone()), axum::Extension(channel), req).await;
    assert_eq!(exchanged.status(), Status::OK);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn opentunnel_adapter_rejects_invalid_api_url_and_surfaces_ready_fatal_attach_error() {
    // 1. Invalid, non-HTTP, and non-origin API URLs fail cleanly without panicking or leaking secrets.
    for raw in [
        "not a valid url",
        "mailto:user@example.com",
        "file:///tmp/api",
        "https://user:supersecret@api.example",
        "https://api.example/extra/path",
        "https://api.example?q=1",
        "https://api.example#frag",
    ] {
        let bad = open_opentunnel(
            OpenRequest {
                route: "codenomad-test".into(),
                target: "127.0.0.1:9".into(),
                api: Some(raw.into()),
                on_origin: Arc::new(|_| {}),
                cancel: CancellationToken::new(),
            },
            None,
        )
        .await;
        let bad_err = bad.err().expect("invalid URL must error");
        assert!(bad_err.contains("Invalid CODENOMAD_REMOTE_CONTROL_API URL"), "{raw}: {bad_err}");
        assert!(!bad_err.contains("supersecret"), "error must never echo raw credentials");
    }

    // Verify shared_storage_from matches @opentunnel/client across platforms:
    // XDG_DATA_HOME wins; on Windows USERPROFILE wins over HOME (matching Node os.homedir()).
    let xdg_root = super::tunnel::shared_storage_from(
        Some(PathBuf::from("/custom-xdg")),
        Some(PathBuf::from("/some-home")),
        Some(PathBuf::from("C:\\Users\\WinUser")),
    );
    assert_eq!(xdg_root.root(), PathBuf::from("/custom-xdg").join("opentunnel"));
    let home_root = super::tunnel::shared_storage_from(
        None,
        Some(PathBuf::from("/posix-home")),
        Some(PathBuf::from("C:\\Users\\WinUser")),
    );
    #[cfg(windows)]
    assert_eq!(home_root.root(), PathBuf::from("C:\\Users\\WinUser").join(".local").join("share").join("opentunnel"));
    #[cfg(not(windows))]
    assert_eq!(home_root.root(), PathBuf::from("/posix-home").join(".local").join("share").join("opentunnel"));

    // Also verify Route::from keeps proxy_protocol disabled.
    let route = opentunnel::Route::from("127.0.0.1:12345");
    assert!(route.proxy_protocol.is_none());

    // 2. Real opentunnel v0.7.0 Client + Tunnel::ready() against a loopback mock OpenTunnel API
    // & RFC 6455 WebSocket bridge:
    //   (a) Fatal attach_error surfaces immediately from Tunnel::ready() without waiting for cancel.
    //   (b) Attached session connects cleanly and close() awaits actual bridge socket teardown.
    let dir = crate::shared::test_dir("rc-opentunnel-ready");
    let storage = opentunnel::Storage::at(dir.clone());
    let cert = rcgen::generate_simple_self_signed(vec!["*.mock.opentunnel.test".to_owned()]).unwrap();
    let identity = opentunnel::Identity {
        id: "tun_mock".into(),
        hostname: "mock.opentunnel.test".into(),
        token: "tok_mock".into(),
        private_key: cert.key_pair.serialize_pem(),
        certificate: cert.cert.pem(),
        chain: String::new(),
        certificate_expiry: "2099-01-01T00:00:00Z".into(),
    };
    storage.save("default", &identity).unwrap();

    // (a) Fatal attach_error("bad_token")
    let (fatal_addr, fatal_server, _) =
        spawn_mock_bridge(identity.certificate.clone(), MockBridgeMode::FatalAttach).await;
    let origin_seen = Arc::new(Mutex::new(None));
    let origin_ref = origin_seen.clone();
    let fatal_res = open_opentunnel(
        OpenRequest {
            route: "codenomad-test01".into(),
            target: "127.0.0.1:12345".into(),
            api: Some(format!("http://{fatal_addr}")),
            on_origin: Arc::new(move |url| {
                *origin_ref.lock().unwrap() = Some(url);
            }),
            cancel: CancellationToken::new(),
        },
        Some(storage.clone()),
    )
    .await;
    let fatal_err = fatal_res.err().expect("fatal attach must fail via Tunnel::ready()");
    assert!(fatal_err.contains("bad_token"), "expected bad_token attach error, got: {fatal_err}");
    assert_eq!(origin_seen.lock().unwrap().as_deref(), Some("https://codenomad-test01.mock.opentunnel.test"));
    fatal_server.abort();

    // (b) Successful attach + verified bridge close on session.close().await
    let (ok_addr, ok_server, bridge_closed) =
        spawn_mock_bridge(identity.certificate.clone(), MockBridgeMode::Attach("codenomad-test01".into())).await;
    let session = open_opentunnel(
        OpenRequest {
            route: "codenomad-test01".into(),
            target: "127.0.0.1:12345".into(),
            api: Some(format!("http://{ok_addr}")),
            on_origin: Arc::new(|_| {}),
            cancel: CancellationToken::new(),
        },
        Some(storage),
    )
    .await
    .expect("real opentunnel adapter must attach to mock bridge");
    assert_eq!(session.state(), TunnelState::Connected);
    assert_eq!(session.hostname(), "codenomad-test01.mock.opentunnel.test");
    assert!(!bridge_closed.load(Ordering::SeqCst));
    session.close().await;
    // Wait briefly for the loopback TCP FIN to be observed by the mock bridge task.
    for _ in 0..50 {
        if bridge_closed.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(bridge_closed.load(Ordering::SeqCst), "session.close() must tear down the bridge connection");
    ok_server.abort();

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn owner_lease_concurrent_contenders_select_strictly_one_winner() {
    use std::sync::Barrier;

    let dir = crate::shared::test_dir("rc-lease-race");
    let file = dir.join("remote-control.owner");
    let threads = 8u32;

    // 1. Fresh directory race: all contenders alive.
    let barrier = Arc::new(Barrier::new(threads as usize));
    let mut handles = Vec::new();
    for i in 0..threads {
        let barrier = barrier.clone();
        let file = file.clone();
        handles.push(std::thread::spawn(move || {
            let pid = 10_000 + i;
            let lease = OwnerLease::with_hooks(file, pid, Arc::new(|p| p >= 10_000));
            barrier.wait();
            lease.try_acquire()
        }));
    }
    let winners: usize = handles.into_iter().map(|h| h.join().unwrap()).filter(|&ok| ok).count();
    assert_eq!(winners, 1, "exactly one contender may acquire a fresh lease");

    // 2. Stale lease race: seed a dead PID (999) and race 8 live contenders.
    std::fs::write(&file, "999").unwrap();
    let barrier = Arc::new(Barrier::new(threads as usize));
    let mut handles = Vec::new();
    for i in 0..threads {
        let barrier = barrier.clone();
        let file = file.clone();
        handles.push(std::thread::spawn(move || {
            let pid = 20_000 + i;
            let lease = OwnerLease::with_hooks(file, pid, Arc::new(|p| p >= 20_000));
            barrier.wait();
            lease.try_acquire()
        }));
    }
    let winners: usize = handles.into_iter().map(|h| h.join().unwrap()).filter(|&ok| ok).count();
    assert_eq!(winners, 1, "exactly one contender may replace a stale lease");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn overlapping_start_waits_for_active_tunnel_close_and_lease_release_follows_close() {
    let dir = crate::shared::test_dir("rc-overlap-close");
    let app = build_test_app(&dir, vec![], false);

    let close_entered = Arc::new(Notify::new());
    let release_close = Arc::new(Notify::new());
    let close_finished = Arc::new(AtomicBool::new(false));
    let second_started_after_close = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));

    let ce = close_entered.clone();
    let rc = release_close.clone();
    let cf = close_finished.clone();
    let ss = second_started_after_close.clone();
    let calls_c = calls.clone();

    struct SlowCloseTunnel {
        inner: Arc<FakeTunnel>,
        entered: Arc<Notify>,
        release: Arc<Notify>,
        finished: Arc<AtomicBool>,
    }
    impl TunnelSession for SlowCloseTunnel {
        fn hostname(&self) -> &str {
            self.inner.hostname()
        }
        fn url(&self) -> &str {
            self.inner.url()
        }
        fn state(&self) -> TunnelState {
            self.inner.state()
        }
        fn take_closed(&self) -> Option<oneshot::Receiver<Option<String>>> {
            self.inner.take_closed()
        }
        fn close(&self) -> Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
            let entered = self.entered.clone();
            let release = self.release.clone();
            let finished = self.finished.clone();
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                finished.store(true, Ordering::SeqCst);
            })
        }
    }

    app.remote_control.set_opener(Arc::new(move |req: OpenRequest| {
        let ce = ce.clone();
        let rc = rc.clone();
        let cf = cf.clone();
        let ss = ss.clone();
        let n = calls_c.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if n == 0 {
                let (inner, _) = FakeTunnel::live(&req.route);
                (req.on_origin)(inner.url.clone());
                return Ok(Arc::new(SlowCloseTunnel { inner, entered: ce, release: rc, finished: cf })
                    as Arc<dyn TunnelSession>);
            }
            ss.store(cf.load(Ordering::SeqCst), Ordering::SeqCst);
            let (inner, _) = FakeTunnel::live(&req.route);
            (req.on_origin)(inner.url.clone());
            Ok(inner as Arc<dyn TunnelSession>)
        })
    }));

    let (code, _) = response_json(start_route(State(app.clone())).await).await;
    assert_eq!(code, Status::OK);

    // Begin stop; it blocks inside SlowCloseTunnel::close().
    let app_stop = app.clone();
    let stop_task = tokio::spawn(async move { stop_route(State(app_stop)).await });
    close_entered.notified().await;

    // Lease must STILL be held while bridge close has not finished!
    assert!(dir.join("remote-control.owner").exists(), "lease must remain held until tunnel close finishes");

    // Start a second tunnel concurrently while stop is still awaiting close().
    let app_start2 = app.clone();
    let start2_task = tokio::spawn(async move { start_route(State(app_start2)).await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "new start must wait for active tunnel close");

    release_close.notify_one();
    assert_eq!(stop_task.await.unwrap().status(), Status::OK);
    let (code2, body2) = response_json(start2_task.await.unwrap()).await;
    assert_eq!(code2, Status::OK);
    assert_eq!(body2["status"]["state"], "connected");
    assert!(second_started_after_close.load(Ordering::SeqCst), "second opener ran strictly after first close finished");

    app.remote_control.shutdown(&app).await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn revocation_failure_recovery_validation_errors_and_pairing_parity() {
    let dir = crate::shared::test_dir("rc-parity-revoke");
    let direct = "https://192.168.1.77:9898".to_owned();
    let app = build_test_app(&dir, vec![direct.clone()], false);

    // 1. Validation JSON 400 checks.
    let (bad_origin_code, bad_origin) =
        response_json(auth::devices::issue(State(app.clone()), Bytes::from_static(br#"{"origin":""}"#)).await).await;
    assert_eq!(bad_origin_code, Status::BAD_REQUEST);
    assert!(bad_origin["error"].is_string());

    let (bad_uuid_code, bad_uuid) =
        response_json(auth::devices::revoke(State(app.clone()), RoutePath("not-a-uuid".into())).await).await;
    assert_eq!(bad_uuid_code, Status::BAD_REQUEST);
    assert!(bad_uuid["error"].is_string());

    let (bad_pv_code, bad_pv) =
        response_json(auth::devices::set_previews(State(app.clone()), Bytes::from_static(b"{not-json")).await).await;
    assert_eq!(bad_pv_code, Status::BAD_REQUEST);
    assert!(bad_pv["error"].is_string());

    // 2. Pair two devices over direct HTTPS (one browser, one server-pair!).
    let direct_channel = auth::tls::Channel {
        origin: direct.clone(),
        origins: Arc::from([direct.clone()]),
        ingress: false,
        socket: CancellationToken::new(),
        principal: Arc::new(Mutex::new(None)),
    };
    let remote_stack = auth::routes()
        .merge(auth::remote_routes())
        .layer(from_fn_with_state((app.clone(), None), auth::remote::admit))
        .layer(axum::Extension(direct_channel))
        .with_state(app.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let direct_server = tokio::spawn(async move {
        let _ = axum::serve(listener, remote_stack).await;
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{addr}");

    // server-pair 403 refusal on direct HTTPS includes Cache-Control: no-store.
    let bad_sp = client
        .post(format!("{base}/api/remote-control/server-pair"))
        .header(header::HOST, "192.168.1.77:9898")
        .header(header::CONTENT_TYPE, "application/json")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_sp.status(), Status::FORBIDDEN);
    assert_eq!(bad_sp.headers().get(header::CACHE_CONTROL).and_then(|v| v.to_str().ok()), Some("no-store"));

    // Valid server-pair over direct HTTPS succeeds.
    let (_, sp_issue) = response_json(
        auth::devices::issue(State(app.clone()), Bytes::from(format!(r#"{{"origin":"{direct}"}}"#))).await,
    )
    .await;
    let sp_code = sp_issue["url"].as_str().unwrap().strip_prefix(&format!("{direct}/remote-pair#")).unwrap();
    let sp_ok = client
        .post(format!("{base}/api/remote-control/server-pair"))
        .header(header::HOST, "192.168.1.77:9898")
        .header("x-codenomad-server-pairing", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .json(&json!({ "code": sp_code, "hostName": "peer-host" }))
        .send()
        .await
        .unwrap();
    assert_eq!(sp_ok.status(), Status::OK);
    let sp_body: Value = sp_ok.json().await.unwrap();
    let dev_a_id = sp_body["device"]["id"].as_str().unwrap().to_owned();
    let dev_a_cred = sp_body["credential"].as_str().unwrap().to_owned();

    // Direct HTTPS server-device credential must actually authenticate subsequent server requests.
    let sp_auth: Value = client
        .get(format!("{base}/api/auth/status"))
        .header(header::HOST, "192.168.1.77:9898")
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, format!("{}={dev_a_cred}", auth::devices::COOKIE))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sp_auth["authenticated"], true, "direct HTTPS server-pair credential must authenticate");

    // Pair second browser device on direct HTTPS.
    let (_, b_issue) = response_json(
        auth::devices::issue(State(app.clone()), Bytes::from(format!(r#"{{"origin":"{direct}"}}"#))).await,
    )
    .await;
    let b_code = b_issue["url"].as_str().unwrap().strip_prefix(&format!("{direct}/remote-pair#")).unwrap();
    let b_ok = client
        .post(format!("{base}/api/remote-control/pair"))
        .header(header::HOST, "192.168.1.77:9898")
        .header(header::ORIGIN, &direct)
        .json(&json!({ "code": b_code }))
        .send()
        .await
        .unwrap();
    assert_eq!(b_ok.status(), Status::OK);
    let b_cookie = b_ok.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();
    let b_token = b_cookie.split_once('=').unwrap().1.to_owned();

    // Authenticate device B once so its principal token sits in `devices.tokens`.
    assert!(app.devices.as_ref().unwrap().lock().unwrap().authenticate(&b_token, Some(&direct), false).is_some());

    // 3. Force revocation persistence failure by replacing remote-control-devices.json with a directory.
    let reg = dir.join("remote-control-devices.json");
    let backup = std::fs::read(&reg).unwrap();
    std::fs::remove_file(&reg).unwrap();
    std::fs::create_dir(&reg).unwrap();

    let (fail_code, _) =
        response_json(auth::devices::revoke(State(app.clone()), RoutePath(dev_a_id.clone())).await).await;
    assert_eq!(fail_code, Status::SERVICE_UNAVAILABLE);
    let (_, listed) = response_json(auth::devices::list(State(app.clone())).await).await;
    assert!(
        listed["devices"].as_array().unwrap().iter().any(|d| d["id"] == dev_a_id && d["revocationPending"] == true),
        "failed revocation must appear with revocationPending: true"
    );

    // Restore writable path and retry revocation; device B must authenticate with a fresh live token!
    std::fs::remove_dir(&reg).unwrap();
    std::fs::write(&reg, backup).unwrap();
    // Open a second backend BEFORE revocation so it holds a stale device snapshot in memory.
    let stale_backend = build_test_app(&dir, vec![direct.clone()], false);
    let retry = auth::devices::revoke(State(app.clone()), RoutePath(dev_a_id.clone())).await;
    assert_eq!(retry.status(), Status::NO_CONTENT);
    // Second backend calling stop() must merge disk state and never resurrect revoked device A!
    let _ = stop_route(State(stale_backend)).await;
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&reg).unwrap()).unwrap();
    assert!(
        on_disk["devices"].as_array().unwrap().iter().all(|d| d["id"] != dev_a_id),
        "second backend stop() must not resurrect a device revoked on disk"
    );
    let (_, after_retry) = response_json(auth::devices::list(State(app.clone())).await).await;
    assert_eq!(after_retry["devices"].as_array().unwrap().len(), 1);
    let (_, b_principal) = app
        .devices
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .authenticate(&b_token, Some(&direct), false)
        .expect("surviving device must authenticate after revocation recovery");
    assert!(!b_principal.is_cancelled(), "surviving device must receive a fresh non-cancelled principal token");

    // 4. Native pair without Origin works on tunnel ingress, browser metadata without Origin is 403,
    // and malformed JSON returns 400!
    app.remote_control.set_opener(Arc::new(|req: OpenRequest| {
        Box::pin(async move {
            let (tunnel, _) = FakeTunnel::live(&req.route);
            (req.on_origin)(tunnel.url.clone());
            Ok(tunnel as Arc<dyn TunnelSession>)
        })
    }));
    let (sc, started) = response_json(start_route(State(app.clone())).await).await;
    assert_eq!(sc, Status::OK);
    let remote_url = started["status"]["remoteUrl"].as_str().unwrap();
    let host = remote_url.strip_prefix("https://").unwrap();
    let pair_code =
        started["pairing"]["url"].as_str().unwrap().strip_prefix(&format!("{remote_url}/remote-pair#")).unwrap();
    let ingress_port = app.remote_control.ingress_port().unwrap();
    let browser_no_origin = client
        .post(format!("http://127.0.0.1:{ingress_port}/api/remote-control/pair"))
        .header(header::HOST, host)
        .header("sec-fetch-site", "cross-site")
        .json(&json!({ "code": pair_code }))
        .send()
        .await
        .unwrap();
    assert_eq!(browser_no_origin.status(), Status::FORBIDDEN, "browser metadata without Origin must be 403");
    let bad_json_pair = client
        .post(format!("http://127.0.0.1:{ingress_port}/api/remote-control/pair"))
        .header(header::HOST, host)
        .header(header::CONTENT_TYPE, "application/json")
        .body("{not-json")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_json_pair.status(), Status::BAD_REQUEST, "malformed JSON on /pair must be 400");
    let native_pair = client
        .post(format!("http://127.0.0.1:{ingress_port}/api/remote-control/pair"))
        .header(header::HOST, host)
        .json(&json!({ "code": pair_code }))
        .send()
        .await
        .unwrap();
    assert_eq!(native_pair.status(), Status::OK, "native tunnel pair without Origin must succeed");

    // 5. Local listener refuses /api/remote-control/pair and /remote-pair with 404.
    let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_addr = local_listener.local_addr().unwrap();
    let local_app = build_test_app_with_port(&dir, local_addr.port(), vec![direct.clone()], false);
    let local_stack = auth::routes()
        .merge(auth::local_routes())
        .layer(from_fn_with_state(local_app.clone(), auth::admit))
        .with_state(local_app);
    let local_server = tokio::spawn(async move {
        let _ = axum::serve(local_listener, local_stack).await;
    });
    for (method, path) in [
        (reqwest::Method::POST, "/api/remote-control/pair"),
        (reqwest::Method::GET, "/remote-pair"),
        (reqwest::Method::POST, "/api/remote-control/server-pair"),
    ] {
        let resp = client.request(method, format!("http://{local_addr}{path}")).send().await.unwrap();
        assert_eq!(resp.status(), Status::NOT_FOUND, "local {path} must return 404");
    }

    app.remote_control.shutdown(&app).await;
    direct_server.abort();
    local_server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn disabling_previews_disconnects_live_remote_websocket_of_local_preview() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let dir = crate::shared::test_dir("rc-preview-ws-cutoff");
    let app = build_test_app(&dir, vec![], false);
    app.remote_control.set_opener(Arc::new(|req: OpenRequest| {
        Box::pin(async move {
            let (tunnel, _) = FakeTunnel::live(&req.route);
            (req.on_origin)(tunnel.url.clone());
            Ok(tunnel as Arc<dyn TunnelSession>)
        })
    }));
    let (sc, started) = response_json(start_route(State(app.clone())).await).await;
    assert_eq!(sc, Status::OK);
    let remote_url = started["status"]["remoteUrl"].as_str().unwrap().to_owned();
    let host = remote_url.strip_prefix("https://").unwrap().to_owned();
    let ingress_port = app.remote_control.ingress_port().unwrap();

    // Upstream WebSocket echo server accepting multiple sequential/concurrent connections.
    let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_port = ws_listener.local_addr().unwrap().port();
    let upstream_closed_count = Arc::new(AtomicUsize::new(0));
    let upstream_closed_c = upstream_closed_count.clone();
    let upstream_task = tokio::spawn(async move {
        while let Ok((mut sock, _)) = ws_listener.accept().await {
            let closed_c = upstream_closed_c.clone();
            tokio::spawn(async move {
                let req = read_http_head(&mut sock).await;
                let key = header_value(&req, "sec-websocket-key").unwrap_or_default();
                let accept = ws_accept_key(&key);
                let resp = format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                );
                if sock.write_all(resp.as_bytes()).await.is_err() {
                    return;
                }
                while let Ok(payload) = read_ws_frame(&mut sock).await {
                    if write_ws_text(&mut sock, &String::from_utf8_lossy(&payload)).await.is_err() {
                        break;
                    }
                }
                closed_c.fetch_add(1, Ordering::SeqCst);
            });
        }
    });

    // Register a locally-created preview (source_device = None) pointing to ws_port.
    let local_router = crate::previews::routes().with_state(app.clone());
    let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_addr = local_listener.local_addr().unwrap();
    let local_server = tokio::spawn(async move {
        let _ = axum::serve(local_listener, local_router).await;
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let created: Value = client
        .post(format!("http://{local_addr}/api/previews"))
        .json(&json!({ "sessionId": "s1", "url": format!("http://127.0.0.1:{ws_port}/ws") }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let proxy_url = created["proxyUrl"].as_str().unwrap();

    // Closing a local preview WebSocket must NOT cancel the shared preview token.
    for msg in ["local-1", "local-2"] {
        let mut local_ws = tokio::net::TcpStream::connect(local_addr).await.unwrap();
        let req = format!(
            "GET {proxy_url} HTTP/1.1\r\nHost: {local_addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        local_ws.write_all(req.as_bytes()).await.unwrap();
        let head = read_http_head(&mut local_ws).await;
        assert!(head.starts_with("HTTP/1.1 101 "), "local preview WS {msg} failed: {head}");
        write_ws_masked_text(&mut local_ws, msg).await.unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(2), read_ws_frame(&mut local_ws)).await.unwrap().unwrap();
        assert_eq!(echoed, msg.as_bytes());
        drop(local_ws);
    }

    // Closing a remote preview WebSocket must also leave the preview usable for reconnects.
    {
        let mut first = tokio::net::TcpStream::connect(("127.0.0.1", ingress_port)).await.unwrap();
        let upgrade_req = format!(
            "GET {proxy_url} HTTP/1.1\r\nHost: {host}\r\nOrigin: {remote_url}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        first.write_all(upgrade_req.as_bytes()).await.unwrap();
        let head = read_http_head(&mut first).await;
        assert!(head.starts_with("HTTP/1.1 101 "), "first remote preview WS failed: {head}");
        write_ws_masked_text(&mut first, "remote-1").await.unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(2), read_ws_frame(&mut first)).await.unwrap().unwrap();
        assert_eq!(echoed, b"remote-1");
        drop(first);
    }
    for _ in 0..50 {
        if upstream_closed_count.load(Ordering::SeqCst) >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Open a second remote preview WebSocket on the same preview, verify frames, then disable previews.
    let mut peer = tokio::net::TcpStream::connect(("127.0.0.1", ingress_port)).await.unwrap();
    let upgrade_req = format!(
        "GET {proxy_url} HTTP/1.1\r\nHost: {host}\r\nOrigin: {remote_url}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    peer.write_all(upgrade_req.as_bytes()).await.unwrap();
    let head = read_http_head(&mut peer).await;
    assert!(head.starts_with("HTTP/1.1 101 "), "expected 101 Switching Protocols, got: {head}");

    // Prove the upgraded WebSocket actually carries frames before previews are disabled!
    write_ws_masked_text(&mut peer, "ping-before-disable").await.unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(2), read_ws_frame(&mut peer)).await.unwrap().unwrap();
    assert_eq!(echoed, b"ping-before-disable", "upgraded preview WebSocket must remain open after 101");
    let before_disable = upstream_closed_count.load(Ordering::SeqCst);

    // Disable previews via PUT /api/remote-control/previews -> must cut BOTH client and upstream!
    let (pv_code, _) = response_json(
        auth::devices::set_previews(State(app.clone()), Bytes::from_static(br#"{"enabled":false}"#)).await,
    )
    .await;
    assert_eq!(pv_code, Status::OK);

    let mut drain = [0u8; 32];
    let eof = tokio::time::timeout(Duration::from_secs(2), peer.read(&mut drain)).await.unwrap().unwrap();
    assert_eq!(eof, 0, "remote preview WebSocket must close when previews are disabled");
    for _ in 0..50 {
        if upstream_closed_count.load(Ordering::SeqCst) > before_disable {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        upstream_closed_count.load(Ordering::SeqCst) > before_disable,
        "upstream WebSocket must also observe closure"
    );

    app.remote_control.shutdown(&app).await;
    upstream_task.abort();
    local_server.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn start_timeout_during_slow_stop_still_releases_lease_when_stop_finishes() {
    struct GatedCloseTunnel {
        hostname: String,
        url: String,
        close_started: Arc<Notify>,
        allow_close: Arc<Notify>,
    }
    impl TunnelSession for GatedCloseTunnel {
        fn hostname(&self) -> &str {
            &self.hostname
        }
        fn url(&self) -> &str {
            &self.url
        }
        fn state(&self) -> TunnelState {
            TunnelState::Connected
        }
        fn take_closed(&self) -> Option<oneshot::Receiver<Option<String>>> {
            None
        }
        fn close(&self) -> Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
            let started = self.close_started.clone();
            let allow = self.allow_close.clone();
            Box::pin(async move {
                started.notify_waiters();
                allow.notified().await;
            })
        }
    }

    let dir = crate::shared::test_dir("rc-start-timeout-lease");
    let app = build_test_app(&dir, vec![], false);
    let close_started = Arc::new(Notify::new());
    let allow_close = Arc::new(Notify::new());
    let cs = close_started.clone();
    let ac = allow_close.clone();
    app.remote_control.set_opener(Arc::new(move |req: OpenRequest| {
        let cs = cs.clone();
        let ac = ac.clone();
        Box::pin(async move {
            let hostname = format!("{}.tunnel.example", req.route);
            let url = format!("https://{hostname}");
            (req.on_origin)(url.clone());
            Ok(Arc::new(GatedCloseTunnel { hostname, url, close_started: cs, allow_close: ac })
                as Arc<dyn TunnelSession>)
        })
    }));
    app.remote_control.set_prior_wait(Duration::from_millis(60));

    // Start acquires the launch lease.
    let _ = app.remote_control.start(&app).await.unwrap();
    let contender = OwnerLease::with_hooks(
        dir.join("remote-control.owner"),
        std::process::id().wrapping_add(1),
        Arc::new(|pid| pid == std::process::id()),
    );
    assert!(!contender.try_acquire(), "lease must be held while tunnel is active");

    // Begin Stop (which blocks inside GatedCloseTunnel::close).
    let started_wait = close_started.notified();
    let app_stop = app.clone();
    let stop_task = tokio::spawn(async move { app_stop.remote_control.stop(&app_stop).await });
    tokio::time::timeout(Duration::from_secs(2), started_wait).await.unwrap();

    // Start during slow Stop times out waiting on `prev_closing`, advancing generation.
    let err = app.remote_control.start(&app).await.unwrap_err();
    match err {
        super::StartError::Failed(msg) => assert!(msg.contains("still closing"), "unexpected error: {msg}"),
        super::StartError::Disabled => panic!("expected Failed, got Disabled"),
    }
    assert!(!contender.try_acquire(), "lease must remain held while old bridge is still closing");

    // Once the old bridge finishes closing, the lease MUST be released even though Start advanced generation.
    allow_close.notify_waiters();
    assert!(stop_task.await.unwrap().is_ok());
    assert!(contender.try_acquire(), "lease must be released once old bridge finishes closing");
    contender.release();

    app.remote_control.shutdown(&app).await;
    let _ = std::fs::remove_dir_all(&dir);
}

enum MockBridgeMode {
    FatalAttach,
    Attach(String),
}

async fn spawn_mock_bridge(
    cert_pem: String,
    mode: MockBridgeMode,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>, Arc<AtomicBool>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let closed = Arc::new(AtomicBool::new(false));
    let closed_c = closed.clone();
    let mode = Arc::new(mode);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let cert_pem = cert_pem.clone();
            let mode = mode.clone();
            let closed_c = closed_c.clone();
            tokio::spawn(async move {
                let req = read_http_head(&mut sock).await;
                let first_line = req.lines().next().unwrap_or("");
                if first_line.contains("/certificate") {
                    let body = serde_json::to_string(&json!({
                        "id": "cert_mock",
                        "state": {
                            "type": "ready",
                            "certificate": cert_pem,
                            "chain": "",
                            "expiry": "2099-01-01T00:00:00Z"
                        }
                    }))
                    .unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                } else if first_line.contains("/connect") {
                    let key = header_value(&req, "sec-websocket-key").unwrap_or_default();
                    let accept = ws_accept_key(&key);
                    let resp = format!(
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: opentunnel\r\n\r\n"
                    );
                    if sock.write_all(resp.as_bytes()).await.is_err() {
                        return;
                    }
                    // Read client's attach frame (masked WebSocket text frame).
                    let _ = read_ws_frame(&mut sock).await;
                    match &*mode {
                        MockBridgeMode::FatalAttach => {
                            let msg = r#"{"type":"attach_error","code":"bad_token"}"#;
                            let _ = write_ws_text(&mut sock, msg).await;
                            let _ = sock.shutdown().await;
                        }
                        MockBridgeMode::Attach(route) => {
                            let msg = serde_json::to_string(&json!({
                                "type": "attached",
                                "session": "ses_mock",
                                "routes": [route],
                                "heartbeat_ms": 15000,
                                "idle_timeout_ms": 45000
                            }))
                            .unwrap();
                            let _ = write_ws_text(&mut sock, &msg).await;
                            // Wait until client closes the WebSocket / TCP stream.
                            let mut buf = [0u8; 64];
                            loop {
                                match sock.read(&mut buf).await {
                                    Ok(0) | Err(_) => break,
                                    Ok(n) if n >= 2 && (buf[0] & 0x0f) == 0x8 => {
                                        // Echo close frame and exit.
                                        let _ = sock.write_all(&[0x88, 0x00]).await;
                                        break;
                                    }
                                    Ok(_) => {}
                                }
                            }
                            closed_c.store(true, Ordering::SeqCst);
                        }
                    }
                }
            });
        }
    });
    (addr, task, closed)
}

async fn read_http_head(sock: &mut tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt;
    let mut data = Vec::new();
    let mut buf = [0u8; 1024];
    while !data.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = sock.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if data.len() > 16_384 {
            break;
        }
    }
    String::from_utf8_lossy(&data).into_owned()
}

fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines().skip(1).find_map(|line| {
        let (k, v) = line.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_owned())
    })
}

async fn read_ws_frame(sock: &mut tokio::net::TcpStream) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut hdr = [0u8; 2];
    sock.read_exact(&mut hdr).await?;
    let masked = (hdr[1] & 0x80) != 0;
    let len_byte = (hdr[1] & 0x7f) as u64;
    let len = if len_byte == 126 {
        let mut b = [0u8; 2];
        sock.read_exact(&mut b).await?;
        u16::from_be_bytes(b) as usize
    } else if len_byte == 127 {
        let mut b = [0u8; 8];
        sock.read_exact(&mut b).await?;
        u64::from_be_bytes(b) as usize
    } else {
        len_byte as usize
    };
    let mut mask = [0u8; 4];
    if masked {
        sock.read_exact(&mut mask).await?;
    }
    let mut payload = vec![0u8; len];
    sock.read_exact(&mut payload).await?;
    if masked {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }
    Ok(payload)
}

async fn write_ws_text(sock: &mut tokio::net::TcpStream, text: &str) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let bytes = text.as_bytes();
    let mut frame = Vec::with_capacity(bytes.len() + 4);
    frame.push(0x81);
    if bytes.len() < 126 {
        frame.push(bytes.len() as u8);
    } else {
        frame.push(126);
        frame.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    }
    frame.extend_from_slice(bytes);
    sock.write_all(&frame).await
}

async fn write_ws_masked_text(sock: &mut tokio::net::TcpStream, text: &str) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let bytes = text.as_bytes();
    let mask = [0x37u8, 0xfa, 0x21, 0x3d];
    let mut frame = Vec::with_capacity(bytes.len() + 8);
    frame.push(0x81);
    frame.push(0x80 | (bytes.len() as u8));
    frame.extend_from_slice(&mask);
    for (i, &b) in bytes.iter().enumerate() {
        frame.push(b ^ mask[i % 4]);
    }
    sock.write_all(&frame).await
}

fn ws_accept_key(client_key: &str) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let input = format!("{client_key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    STANDARD.encode(sha1(input.as_bytes()))
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let temp = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}
