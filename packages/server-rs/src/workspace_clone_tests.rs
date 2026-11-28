//! Unit, security, transactional replacement, and Remote Control tests for `POST /api/workspaces/clone`.
use std::{
    path::{Path, PathBuf},
    process::Command as StdCommand,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Extension,
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode as Status, header},
    middleware::from_fn_with_state,
    response::IntoResponse,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::{
    App, Shared,
    auth::{Principal, devices, remote, tls},
    opencode::Native,
};

fn build_app(root: &Path, unrestricted: bool, ingress: Option<bool>) -> Shared {
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let config = data.join("config.yaml");
    let auth = crate::auth::Auth::new(crate::auth::Settings {
        username: "codenomad".into(),
        password: Some("secret".into()),
        file: None,
        cookie: "cn_clone_test".into(),
        token: false,
        managed_local: false,
        skip: true,
        idle: Duration::from_secs(3600),
        absolute: Duration::from_secs(3600),
    })
    .unwrap();
    let settings =
        crate::settings::Settings::new(crate::settings::document::Location::resolve(config.to_str().unwrap()));
    let meta = Value::Null;
    let native = Native::connect("opencode").unwrap();
    let dev = ingress.map(|is_ingress| {
        if is_ingress {
            devices::open_ingress_for_test(&data, "https://10.0.0.5:9898".into())
        } else {
            devices::open_for_test(&data, "https://10.0.0.5:9898".into(), vec!["https://10.0.0.5:9898".into()])
        }
    });
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let watches = crate::files::watch::Watches::new(tx);
    Arc::new(App::new(
        auth,
        0,
        data,
        root.to_path_buf(),
        unrestricted,
        settings,
        meta,
        native,
        PathBuf::from("opencode"),
        dev,
        watches,
        None,
    ))
}

fn create_bare_repo(path: &Path) {
    let out = StdCommand::new("git")
        .args(["init", "--bare", "-q"])
        .arg(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(out.status.success(), "git init --bare failed: {}", String::from_utf8_lossy(&out.stderr));
}

fn create_populated_bare_repo(work_base: &Path) -> PathBuf {
    let bare = work_base.join("populated.git");
    create_bare_repo(&bare);
    let seed = work_base.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    let run_git = |dir: &Path, args: &[&str]| {
        let out = StdCommand::new("git")
            .current_dir(dir)
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    run_git(&seed, &["init", "-q"]);
    std::fs::write(seed.join("hello.txt"), "cloned-content\n").unwrap();
    run_git(&seed, &["add", "hello.txt"]);
    run_git(&seed, &["commit", "-q", "-m", "initial"]);
    run_git(&seed, &["push", "-q", bare.to_str().unwrap(), "HEAD"]);
    bare
}

async fn post_clone(app: Shared, uri: &str, content_type: Option<&str>, body: Vec<u8>) -> (Status, Value) {
    let mut builder = Request::builder().method(Method::POST).uri(uri);
    if let Some(ct) = content_type {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    let req = builder.body(Body::from(body)).unwrap();
    let res = match super::clone(State(app), Extension(Principal(CancellationToken::new())), req).await {
        Ok(res) => res,
        Err(err) => err.into_response(),
    };
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}));
    (status, json)
}

#[test]
fn url_and_destination_validation_enforces_security_and_scope() {
    let dir = crate::shared::test_dir("clone-validate");
    let root = dir.join("scope");
    let foreign = dir.join("foreign");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    let root_real = dunce::canonicalize(&root).unwrap();
    let foreign_real = dunce::canonicalize(&foreign).unwrap();

    let restricted = build_app(&root_real, false, None);
    let unrestricted = build_app(&root_real, true, None);

    // Valid remote URLs & SCP-style SSH & local bare repo in scope.
    for ok_url in [
        "https://github.com/NeuralNomadsAI/CodeNomad.git",
        "http://127.0.0.1:8080/repo.git",
        "ssh://git@github.com/org/repo.git",
        "git://example.com/repo.git",
        "git@github.com:NeuralNomadsAI/CodeNomad.git",
        root_real.join("source.git").to_str().unwrap(),
    ] {
        assert!(validate_repository_url(&restricted, ok_url).is_ok(), "should allow {ok_url}");
    }

    // Rejected URLs: option injection, remote helpers, unsafe schemes, control chars, SSH host injection.
    for bad_url in [
        "",
        "--upload-pack=evil",
        "-u",
        "ext::sh -c id",
        "EXT::calc.exe",
        "fd::17/foo",
        "ftp://example.com/repo.git",
        "javascript:alert(1)",
        "ssh://-oProxyCommand=evil/repo.git",
        "ssh://-user@github.com/org/repo.git",
        "git@-oProxyCommand=evil:org/repo.git",
        "https://github.com/org/repo.git\n--upload-pack=x",
        "https://github.com/org/repo.git\0",
        foreign_real.join("secret.git").to_str().unwrap(),
    ] {
        assert_eq!(
            validate_repository_url(&restricted, bad_url).unwrap_err().0,
            Status::BAD_REQUEST,
            "should reject {bad_url}"
        );
    }

    #[cfg(windows)]
    {
        for bad_win in [r"\\evil\share\repo.git", "//evil/share/repo.git", r"\\.\pipe\git"] {
            assert_eq!(validate_repository_url(&unrestricted, bad_win).unwrap_err().0, Status::BAD_REQUEST);
            assert_eq!(resolve_destination(&unrestricted, bad_win).unwrap_err().0, Status::BAD_REQUEST);
        }
    }

    // Destination checks: relative, root, home, outside restricted scope, and exact restricted scope root.
    assert_eq!(resolve_destination(&unrestricted, "relative/path").unwrap_err().0, Status::BAD_REQUEST);
    let fs_root = if cfg!(windows) {
        let s = root_real.to_string_lossy();
        format!("{}:\\", s.chars().next().unwrap())
    } else {
        "/".into()
    };
    let root_err = resolve_destination(&unrestricted, &fs_root).unwrap_err();
    assert_eq!(root_err.0, Status::BAD_REQUEST);
    assert!(root_err.1.0["error"].as_str().unwrap().contains("filesystem root"));

    let home_dir = home();
    if !home_dir.as_os_str().is_empty() {
        let home_err = resolve_destination(&unrestricted, &home_dir.to_string_lossy()).unwrap_err();
        assert_eq!(home_err.0, Status::BAD_REQUEST);
        assert!(home_err.1.0["error"].as_str().unwrap().contains("home folder"));
    }

    // Restricted scope refuses foreign destinations AND the scope root itself (siblings would escape scope).
    assert_eq!(
        resolve_destination(&restricted, &foreign_real.join("out").to_string_lossy()).unwrap_err().0,
        Status::BAD_REQUEST
    );
    assert_eq!(resolve_destination(&restricted, &root_real.to_string_lossy()).unwrap_err().0, Status::BAD_REQUEST);
    let ok_dest = resolve_destination(&restricted, &format!("{}/sub/", root_real.to_string_lossy())).unwrap();
    assert_eq!(ok_dest, root_real.join("sub"));

    remove_tree(&dir);
}

#[tokio::test]
async fn clone_route_rejects_retired_selectors_queries_and_bad_bodies_before_host_work() {
    let _git = crate::git::test_git_serial().await;
    let dir = crate::shared::test_dir("clone-strict-http");
    let root = dunce::canonicalize(&dir).unwrap();
    let existing = root.join("existing");
    std::fs::create_dir_all(&existing).unwrap();
    let sentinel = existing.join("keep.txt");
    std::fs::write(&sentinel, "retained").unwrap();
    let missing_parent_dest = root.join("missing-parent").join("destination");

    let app = build_app(&root, false, None);

    // 1. Retired `serverId` selector (all value types) and unknown keys -> 400 with zero host side effects.
    for dest in [&existing, &missing_parent_dest] {
        for server_id in
            [json!("A"), json!("unknown"), json!("local-shared"), json!(""), json!(null), json!({}), json!(1)]
        {
            let body = serde_json::to_vec(&json!({
                "repositoryUrl": "https://fixture.invalid/repo.git",
                "destinationPath": dest,
                "cleanup": true,
                "serverId": server_id,
            }))
            .unwrap();
            let (status, payload) =
                post_clone(app.clone(), "/api/workspaces/clone", Some("application/json"), body).await;
            assert_eq!(status, Status::BAD_REQUEST, "{payload}");
            assert_eq!(payload["error"], "Unsupported workspace selector");
        }

        // 2. Any query parameter -> 400 before touching host.
        for query in ["serverId=A", "%73erverId=A", "binding%5BserverId%5D=A", "other=value"] {
            let body = serde_json::to_vec(&json!({
                "repositoryUrl": "https://fixture.invalid/repo.git",
                "destinationPath": dest,
                "cleanup": true,
            }))
            .unwrap();
            let (status, _) =
                post_clone(app.clone(), &format!("/api/workspaces/clone?{query}"), Some("application/json"), body)
                    .await;
            assert_eq!(status, Status::BAD_REQUEST, "query={query}");
        }
    }

    // 3. Unknown field, invalid cleanup type, missing fields, unsupported media type, empty JSON body.
    for bad_body in [
        json!({"repositoryUrl": "https://a.invalid/r.git", "destinationPath": existing, "extra": 1}),
        json!({"repositoryUrl": "https://a.invalid/r.git", "destinationPath": existing, "cleanup": null}),
        json!({"repositoryUrl": "https://a.invalid/r.git", "destinationPath": existing, "cleanup": "true"}),
        json!({"repositoryUrl": "   ", "destinationPath": existing}),
        json!({"repositoryUrl": "https://a.invalid/r.git", "destinationPath": "   "}),
        json!(null),
        json!([]),
    ] {
        let (status, _) = post_clone(
            app.clone(),
            "/api/workspaces/clone",
            Some("application/json"),
            serde_json::to_vec(&bad_body).unwrap(),
        )
        .await;
        assert_eq!(status, Status::BAD_REQUEST, "{bad_body}");
    }
    let (empty_status, _) =
        post_clone(app.clone(), "/api/workspaces/clone", Some("application/json"), Vec::new()).await;
    assert_eq!(empty_status, Status::BAD_REQUEST);
    let (media_status, _) =
        post_clone(app.clone(), "/api/workspaces/clone", Some("application/octet-stream"), b"{}".to_vec()).await;
    assert_eq!(media_status, Status::UNSUPPORTED_MEDIA_TYPE);

    // Zero host effects: missing-parent was never created, existing sentinel untouched, no workspaces opened.
    assert!(!root.join("missing-parent").exists());
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "retained");
    assert!(app.inner.lock().unwrap().workspaces.is_empty());

    remove_tree(&dir);
}

#[tokio::test]
async fn clone_route_clones_real_repo_handles_conflicts_and_replaces_transactionally() {
    let _git = crate::git::test_git_serial().await;
    let dir = crate::shared::test_dir("clone-real-e2e");
    let root = dunce::canonicalize(&dir).unwrap();
    let bare = create_populated_bare_repo(&root);
    let app = build_app(&root, false, None);

    // 1. Clone into a missing nested destination (creates parent dirs, returns 201 { path }, does not open workspace).
    let dest = root.join("nested").join("cloned-repo");
    let (status, body) = post_clone(
        app.clone(),
        "/api/workspaces/clone",
        Some("application/json"),
        serde_json::to_vec(&json!({
            "repositoryUrl": bare,
            "destinationPath": dest,
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, Status::CREATED, "{body}");
    assert_eq!(body["path"], dest.to_string_lossy().as_ref());
    assert!(dest.join(".git").exists());
    assert_eq!(std::fs::read_to_string(dest.join("hello.txt")).unwrap().replace("\r\n", "\n"), "cloned-content\n");
    assert!(app.inner.lock().unwrap().workspaces.is_empty(), "cloning must not open a workspace");

    // 2. Non-empty destination without cleanup -> 409 and sentinel preserved.
    let sentinel = dest.join("keep.txt");
    std::fs::write(&sentinel, "retained").unwrap();
    let (status, body) = post_clone(
        app.clone(),
        "/api/workspaces/clone",
        Some("application/json"),
        serde_json::to_vec(&json!({
            "repositoryUrl": bare,
            "destinationPath": dest,
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, Status::CONFLICT, "{body}");
    assert_eq!(body["error"], "Destination folder is not empty");
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "retained");

    // 3. Regular file at destination (even with cleanup: true) -> 409 and file preserved.
    let file_dest = root.join("not-a-dir.txt");
    std::fs::write(&file_dest, "file-data").unwrap();
    let (status, body) = post_clone(
        app.clone(),
        "/api/workspaces/clone",
        Some("application/json"),
        serde_json::to_vec(&json!({
            "repositoryUrl": bare,
            "destinationPath": file_dest,
            "cleanup": true,
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, Status::CONFLICT, "{body}");
    assert_eq!(body["error"], "Destination path exists and is not a folder");
    assert_eq!(std::fs::read_to_string(&file_dest).unwrap(), "file-data");

    // 4. Failed clone with cleanup: true preserves existing destination and leaves no temp sibling dirs.
    let missing_repo = root.join("missing.git");
    let (status, _) = post_clone(
        app.clone(),
        "/api/workspaces/clone",
        Some("application/json"),
        serde_json::to_vec(&json!({
            "repositoryUrl": missing_repo,
            "destinationPath": dest,
            "cleanup": true,
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, Status::CONFLICT);
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "retained");

    // 5. Successful clone with cleanup: true replaces existing repo transactionally with no backup/temp leftovers.
    let (status, body) = post_clone(
        app.clone(),
        "/api/workspaces/clone",
        Some("application/json"),
        serde_json::to_vec(&json!({
            "repositoryUrl": bare,
            "destinationPath": dest,
            "cleanup": true,
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(status, Status::CREATED, "{body}");
    assert_eq!(body["path"], dest.to_string_lossy().as_ref());
    assert!(dest.join(".git").exists());
    assert!(!sentinel.exists(), "old sentinel must be replaced");
    let nested_entries: Vec<String> = std::fs::read_dir(root.join("nested"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(nested_entries, vec!["cloned-repo".to_owned()], "no .clone-* or .backup-* leftovers");

    remove_tree(&dir);
}

#[tokio::test]
async fn remote_control_admits_workspaces_clone_for_paired_browser_and_server_device() {
    let _git = crate::git::test_git_serial().await;
    let dir = crate::shared::test_dir("clone-remote-control");
    let root = dunce::canonicalize(&dir).unwrap();
    let bare = create_populated_bare_repo(&root);
    let direct_app = build_app(&root, false, Some(false));
    let ingress_app = build_app(&root, false, Some(true));

    let origin = "https://10.0.0.5:9898";
    let host = "10.0.0.5:9898";
    for (ingress, is_server) in [(false, false), (false, true), (true, false), (true, true)] {
        let app = if ingress { &ingress_app } else { &direct_app };
        let payload = if ingress {
            axum::body::Bytes::new()
        } else {
            axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))
        };
        let issued = devices::issue(State(app.clone()), payload).await;
        assert_eq!(issued.status(), Status::OK);
        let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
        let link: Value = serde_json::from_slice(&body).unwrap();
        let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();

        let channel = tls::Channel {
            origin: origin.to_owned(),
            origins: Arc::from([origin.to_owned()]),
            ingress,
            socket: CancellationToken::new(),
            principal: Arc::new(Mutex::new(None)),
        };
        let router = crate::auth::remote_routes()
            .merge(crate::workspaces::routes())
            .layer(from_fn_with_state((app.clone(), None), remote::admit))
            .layer(axum::Extension(channel))
            .with_state(app.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{addr}");
        let dest = root.join(format!("remote-{ingress}-{is_server}"));

        // Unpaired request must be rejected with 401.
        let unauth_req = client
            .post(format!("{base}/api/workspaces/clone"))
            .header(header::HOST, host)
            .json(&json!({"repositoryUrl": bare, "destinationPath": dest}));
        let unauth_req = if is_server {
            unauth_req.header("x-codenomad-server-request", "1")
        } else {
            unauth_req.header(header::ORIGIN, origin)
        };
        let unauth_status = unauth_req.send().await.unwrap().status();
        // Ingress + explicit server header without Origin fails CSRF check with 403 before pairing.
        let expected_unauth = if ingress && is_server { Status::FORBIDDEN } else { Status::UNAUTHORIZED };
        assert_eq!(unauth_status, expected_unauth);
        assert!(!dest.exists());

        // Pair device.
        let cookie = if is_server {
            let paired = client
                .post(format!("{base}/api/remote-control/server-pair"))
                .header(header::HOST, host)
                .header("x-codenomad-server-pairing", "1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json!({"code": code, "hostName": "peer-host"}).to_string())
                .send()
                .await
                .unwrap();
            assert_eq!(paired.status(), Status::OK);
            let cred = paired.json::<Value>().await.unwrap()["credential"].as_str().unwrap().to_owned();
            format!("{}={cred}", devices::COOKIE)
        } else {
            let paired = client
                .post(format!("{base}/api/remote-control/pair"))
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .json(&json!({"code": code}))
                .send()
                .await
                .unwrap();
            assert_eq!(paired.status(), Status::OK);
            paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned()
        };

        // Paired browser cross-origin mutation must be rejected with 403.
        if !is_server {
            let csrf = client
                .post(format!("{base}/api/workspaces/clone"))
                .header(header::HOST, host)
                .header(header::ORIGIN, "https://evil.example")
                .header(header::COOKIE, cookie.as_str())
                .json(&json!({"repositoryUrl": bare, "destinationPath": dest}))
                .send()
                .await
                .unwrap();
            assert_eq!(csrf.status(), Status::FORBIDDEN);
        }

        // Paired clone succeeds with 201 { path }.
        let req = client
            .post(format!("{base}/api/workspaces/clone"))
            .header(header::HOST, host)
            .header(header::COOKIE, cookie.as_str())
            .json(&json!({"repositoryUrl": bare, "destinationPath": dest}));
        let req =
            if is_server { req.header("x-codenomad-server-request", "1") } else { req.header(header::ORIGIN, origin) };
        let res = req.send().await.unwrap();
        assert_eq!(res.status(), Status::CREATED);
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["path"], dest.to_string_lossy().as_ref());
        assert!(dest.join(".git").exists());

        server.abort();
    }

    remove_tree(&dir);
}
