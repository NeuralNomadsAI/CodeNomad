use std::{path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Extension,
    extract::State,
    http::{StatusCode as Status, header},
    middleware::from_fn_with_state,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    App,
    auth::{self, devices, remote, tls},
    files, opencode, settings, temporary_workspaces, workspaces,
};

struct TempDir(PathBuf);
impl TempDir {
    fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dunce::canonicalize(&dir).unwrap())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn local_logout_revokes_session_clears_cookie_and_is_idempotent_without_cookie() {
    let dir = TempDir::new("cn-local-logout");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let auth = auth::Auth::new(auth::Settings {
        username: "codenomad".into(),
        password: Some("local-secret-password".into()),
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: false,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let app = Arc::new(App::new(
        auth,
        addr.port(),
        dir.0.clone(),
        dir.0.clone(),
        false,
        settings::Settings::new(settings::document::Location::resolve(dir.0.join("config.yaml").to_str().unwrap())),
        Value::Null,
        opencode::Native::connect("opencode").unwrap(),
        PathBuf::new(),
        None,
        files::watch::Watches::new(tx),
        None,
    ));

    let router =
        auth::routes().merge(auth::local_routes()).layer(from_fn_with_state(app.clone(), auth::admit)).with_state(app);
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{addr}");

    // Login to get a session cookie.
    let login = client
        .post(format!("{base}/api/auth/login"))
        .header(header::ORIGIN, &base)
        .json(&json!({"username":"codenomad","password":"local-secret-password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), Status::OK);
    let cookie = login.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();

    let before: Value = client
        .get(format!("{base}/api/auth/status"))
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(before["authenticated"], true);

    // Logout revokes the session and clears the session cookie with Max-Age=0.
    let logout = client
        .post(format!("{base}/api/auth/logout"))
        .header(header::ORIGIN, &base)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), Status::OK);
    let set_cookie = logout.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(set_cookie.starts_with("codenomad_session=;"), "{set_cookie}");
    assert!(set_cookie.contains("Max-Age=0"), "{set_cookie}");
    assert_eq!(logout.json::<Value>().await.unwrap(), json!({"ok": true}));

    // The revoked cookie is no longer authenticated.
    let after: Value = client
        .get(format!("{base}/api/auth/status"))
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["authenticated"], false);

    // Calling logout without a cookie stays public and idempotent; non-POST returns 404.
    let anon = client.post(format!("{base}/api/auth/logout")).header(header::ORIGIN, &base).send().await.unwrap();
    assert_eq!(anon.status(), Status::OK);
    assert_eq!(anon.json::<Value>().await.unwrap(), json!({"ok": true}));
    let wrong_local = client.get(format!("{base}/api/auth/logout")).send().await.unwrap();
    assert_eq!(wrong_local.status(), Status::NOT_FOUND);

    server.abort();
}

#[tokio::test]
async fn remote_logout_clears_paired_browser_device_cookie_and_admits_temporary_routes() {
    let dir = TempDir::new("cn-remote-logout");
    let origin = "https://192.168.1.20:9898";
    let origins = vec![origin.to_owned()];
    let devices_lock = devices::open_for_test(&dir.0, origin.into(), origins.clone());
    let auth = auth::Auth::new(auth::Settings {
        username: "codenomad".into(),
        password: Some("local-secret-password".into()),
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: false,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let app = Arc::new(App::new(
        auth,
        0,
        dir.0.clone(),
        dir.0.clone(),
        false,
        settings::Settings::new(settings::document::Location::resolve(dir.0.join("config.yaml").to_str().unwrap())),
        Value::Null,
        opencode::Native::connect("opencode").unwrap(),
        PathBuf::new(),
        Some(devices_lock),
        files::watch::Watches::new(tx),
        None,
    ));

    // Issue a direct pairing link and exchange it for a paired browser device cookie.
    let issued =
        devices::issue(State(app.clone()), axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))).await;
    assert_eq!(issued.status(), Status::OK);
    let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
    let link: Value = serde_json::from_slice(&body).unwrap();
    let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();

    let channel = tls::Channel {
        origin: origin.to_owned(),
        origins: Arc::from(origins),
        ingress: false,
        socket: CancellationToken::new(),
        principal: Arc::new(std::sync::Mutex::new(None)),
    };
    let router = auth::routes()
        .merge(auth::remote_routes())
        .merge(temporary_workspaces::routes())
        .merge(workspaces::routes())
        .merge(crate::previews::routes())
        .layer(from_fn_with_state((app.clone(), None), remote::admit))
        .layer(Extension(channel))
        .with_state(app.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{addr}");

    let paired = client
        .post(format!("{base}/api/remote-control/pair"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::ORIGIN, origin)
        .json(&json!({"code": code}))
        .send()
        .await
        .unwrap();
    assert_eq!(paired.status(), Status::OK);
    let cookie = paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();

    // Missing Origin on POST /api/auth/logout -> 403 CSRF rejection.
    let no_origin = client
        .post(format!("{base}/api/auth/logout"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(no_origin.status(), Status::FORBIDDEN);

    // Unpaired browser -> 401.
    let unpaired = client
        .post(format!("{base}/api/auth/logout"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::ORIGIN, origin)
        .send()
        .await
        .unwrap();
    assert_eq!(unpaired.status(), Status::UNAUTHORIZED);

    // GET /api/auth/logout -> 404 (POST only).
    let wrong_method = client
        .get(format!("{base}/api/auth/logout"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_method.status(), Status::NOT_FOUND);

    // Enable remote previews, create a live preview as the paired browser, then verify
    // POST /api/auth/logout revokes it and advances the device logout epoch.
    let enabled =
        devices::set_previews(State(app.clone()), axum::body::Bytes::from_static(br#"{"enabled":true}"#)).await;
    assert_eq!(enabled.status(), Status::OK);
    let preview_res = client
        .post(format!("{base}/api/previews"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({"sessionId": "ses_preview_test", "url": "http://127.0.0.1:4173/app"}))
        .send()
        .await
        .unwrap();
    assert_eq!(preview_res.status(), Status::OK);
    let preview_token = preview_res.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_owned();
    let list_res = devices::list(State(app.clone())).await;
    let list_body: Value =
        serde_json::from_slice(&axum::body::to_bytes(list_res.into_body(), 8192).await.unwrap()).unwrap();
    let paired_device_id =
        uuid::Uuid::parse_str(list_body["devices"][0]["id"].as_str().expect("paired browser device id")).unwrap();
    let before_epoch = app.previews.logout_epoch(paired_device_id);

    // Paired browser POST /api/auth/logout -> 200 {"ok":true} clearing __Host-codenomad_device
    // and revoking the browser's live previews.
    let logout = client
        .post(format!("{base}/api/auth/logout"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), Status::OK);
    let cleared = logout.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(cleared.starts_with("__Host-codenomad_device=;"), "{cleared}");
    assert!(cleared.contains("Secure"), "{cleared}");
    assert!(cleared.contains("Max-Age=0"), "{cleared}");
    assert_eq!(logout.json::<Value>().await.unwrap(), json!({"ok": true}));
    let after_epoch = app.previews.logout_epoch(paired_device_id);
    assert_eq!(after_epoch, before_epoch + 1);

    // The preview created before logout is gone.
    let gone_preview = client
        .delete(format!("{base}/api/previews/{preview_token}"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(gone_preview.status(), Status::NOT_FOUND);

    // A preview request whose middleware DeviceAdmission captured the pre-logout epoch is fenced
    // even if the handler runs after POST /api/auth/logout.
    let stale_admission = remote::DeviceAdmission { id: paired_device_id, logout_epoch: before_epoch };
    let stale_req = axum::http::Request::builder()
        .method(axum::http::Method::POST)
        .uri("/api/previews")
        .header(header::CONTENT_TYPE, "application/json")
        .extension(tls::Channel {
            origin: origin.to_owned(),
            origins: Arc::from(vec![origin.to_owned()]),
            ingress: false,
            socket: tokio_util::sync::CancellationToken::new(),
            principal: Arc::new(std::sync::Mutex::new(Some(paired_device_id))),
        })
        .extension(auth::Principal(tokio_util::sync::CancellationToken::new()))
        .extension(remote::BrowserDevice(paired_device_id))
        .extension(stale_admission)
        .body(axum::body::Body::from(r#"{"sessionId":"ses_race","url":"http://127.0.0.1:4173/race"}"#))
        .unwrap();
    let stale_err = crate::previews::create(State(app.clone()), stale_req).await.unwrap_err();
    assert_eq!(stale_err.0, Status::UNAUTHORIZED);

    // Temporary workspace routes are admitted in the remote catalog for paired devices.
    let created = client
        .post(format!("{base}/api/workspaces/temporary"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), Status::CREATED);
    let created_body: Value = created.json().await.unwrap();
    let folder = created_body["path"].as_str().unwrap().to_owned();
    assert_eq!(created_body["supportsCancelAndAbandon"], true);

    let listed: Value = client
        .get(format!("{base}/api/workspaces/temporary"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["folders"], json!([folder]));

    let abandoned = client
        .post(format!("{base}/api/workspaces/temporary/abandon"))
        .header(header::HOST, "192.168.1.20:9898")
        .header(header::ORIGIN, origin)
        .header(header::COOKIE, &cookie)
        .json(&json!({"path": folder}))
        .send()
        .await
        .unwrap();
    assert_eq!(abandoned.status(), Status::NO_CONTENT);

    // Server device on ingress: temporary workspace routes are admitted, POST /api/auth/logout is refused (404).
    let ingress_dir = TempDir::new("cn-remote-ingress-server");
    let ingress_origin = "https://remote.example.test";
    let ingress_devices = devices::open_ingress_for_test(&ingress_dir.0, ingress_origin.into());
    let ingress_auth = auth::Auth::new(auth::Settings {
        username: "codenomad".into(),
        password: Some("local-secret-password".into()),
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: false,
        idle: Duration::from_secs(60),
        absolute: Duration::from_secs(60),
    })
    .unwrap();
    let (tx2, _rx2) = tokio::sync::mpsc::channel(4);
    let ingress_app = Arc::new(App::new(
        ingress_auth,
        0,
        ingress_dir.0.clone(),
        ingress_dir.0.clone(),
        true,
        settings::Settings::new(settings::document::Location::resolve(
            ingress_dir.0.join("config.yaml").to_str().unwrap(),
        )),
        Value::Null,
        opencode::Native::connect("opencode").unwrap(),
        PathBuf::new(),
        Some(ingress_devices),
        files::watch::Watches::new(tx2),
        None,
    ));
    let ingress_issued = devices::issue(State(ingress_app.clone()), axum::body::Bytes::new()).await;
    assert_eq!(ingress_issued.status(), Status::OK);
    let ingress_body = axum::body::to_bytes(ingress_issued.into_body(), 4096).await.unwrap();
    let ingress_link: Value = serde_json::from_slice(&ingress_body).unwrap();
    let server_code = ingress_link["url"]
        .as_str()
        .unwrap()
        .strip_prefix(&format!("{ingress_origin}/remote-pair#"))
        .unwrap()
        .to_owned();
    let ingress_channel = tls::Channel {
        origin: ingress_origin.to_owned(),
        origins: Arc::from(vec![ingress_origin.to_owned()]),
        ingress: true,
        socket: CancellationToken::new(),
        principal: Arc::new(std::sync::Mutex::new(None)),
    };
    let ingress_router = auth::routes()
        .merge(auth::remote_routes())
        .merge(temporary_workspaces::routes())
        .layer(from_fn_with_state((ingress_app.clone(), None), remote::admit))
        .layer(Extension(ingress_channel))
        .with_state(ingress_app);
    let ingress_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ingress_addr = ingress_listener.local_addr().unwrap();
    let ingress_server = tokio::spawn(async move { axum::serve(ingress_listener, ingress_router).await.unwrap() });
    let ingress_base = format!("http://{ingress_addr}");

    let server_paired = client
        .post(format!("{ingress_base}/api/remote-control/server-pair"))
        .header(header::HOST, "remote.example.test")
        .header("x-codenomad-server-pairing", "1")
        .json(&json!({"code": server_code, "hostName": "peer-host"}))
        .send()
        .await
        .unwrap();
    assert_eq!(server_paired.status(), Status::OK);
    let server_cred = server_paired.json::<Value>().await.unwrap()["credential"].as_str().unwrap().to_owned();
    let server_cookie = format!("{}={server_cred}", devices::COOKIE);

    // Server device cannot call POST /api/auth/logout -> 404.
    let server_logout = client
        .post(format!("{ingress_base}/api/auth/logout"))
        .header(header::HOST, "remote.example.test")
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &server_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(server_logout.status(), Status::NOT_FOUND);

    // Server device can use temporary workspace routes.
    let server_temp = client
        .post(format!("{ingress_base}/api/workspaces/temporary"))
        .header(header::HOST, "remote.example.test")
        .header("x-codenomad-server-request", "1")
        .header(header::COOKIE, &server_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(server_temp.status(), Status::CREATED);

    ingress_server.abort();
    server.abort();
}
