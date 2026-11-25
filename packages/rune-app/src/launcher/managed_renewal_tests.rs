use super::*;
use crate::catalog::Project;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn spawn_renewal_server(
    server_id: &'static str,
    valid_cookie: &'static str,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                let path = first_line.split_whitespace().nth(1).unwrap_or("");
                let authorized = req.lines().any(|line| {
                    line.to_ascii_lowercase()
                        .contains(&format!("cookie: {valid_cookie}"))
                });
                let (status, body) = if !authorized {
                    (
                        "401 Unauthorized",
                        r#"{"error":"Unauthorized"}"#.to_string(),
                    )
                } else if path == "/api/meta" {
                    (
                        "200 OK",
                        format!(
                            r#"{{"serverId":"{server_id}","apiContract":1,"capabilities":[]}}"#
                        ),
                    )
                } else if path == "/api/workspaces" {
                    (
                        "200 OK",
                        r#"[{"id":"ws-1","location":{"directory":"/proj"}}]"#.to_string(),
                    )
                } else {
                    ("404 Not Found", "{}".to_string())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}/"), handle)
}

#[test]
fn managed_local_host_renews_expired_session_without_showing_login() {
    crate::platform::block_on(async {
        let cookie_name = "codenomad_session_test";
        let renewed_value = "renewed_session_token_012345678901234567890";
        let (base, server) = spawn_renewal_server(
            "srv-managed",
            "codenomad_session_test=renewed_session_token_012345678901234567890",
        )
        .await;
        let expired = Backend::unauthenticated(&base).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_ref = calls.clone();
        let base_ref = base.clone();
        let host = crate::platform::LocalHost::fixture(move || {
            calls_ref.fetch_add(1, Ordering::SeqCst);
            Backend::connect_with_session_cookie(&base_ref, cookie_name, renewed_value).ok()
        });

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.host = Some(host);
        l.project = Some(Project {
            id: "ws-1".into(),
            path: "/proj".into(),
        });
        s.screen = crate::Screen::Chat { launcher: Some(l) };
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));

        // First 401 starts single-flight managed renewal while keeping Screen::Chat visible.
        assert!(crate::settings::authentication_required(
            &mut rt.state,
            &expired
        ));
        assert!(!rt.state.screen.is_launcher());
        assert!(!crate::shell::launcher_replaces_project(&rt.state));
        assert!(rt.state.screen.launcher().unwrap().authentication_required);
        assert!(
            rt.state
                .screen
                .launcher()
                .unwrap()
                .managed_renewal
                .is_some()
        );

        // Duplicate 401 while renewal is in flight must not spawn a second renewal or show login.
        assert!(crate::settings::authentication_required(
            &mut rt.state,
            &expired
        ));
        assert!(!rt.state.screen.is_launcher());
        assert!(!crate::shell::launcher_replaces_project(&rt.state));

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while rt
            .state
            .screen
            .launcher()
            .unwrap()
            .managed_renewal
            .is_some()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "managed renewal timed out"
            );
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let l = rt.state.screen.launcher().unwrap();
        assert!(!l.authentication_required);
        assert!(!rt.state.screen.is_launcher());
        assert!(
            !l.connection
                .as_ref()
                .unwrap()
                .client
                .same_connection(&expired.client),
            "renewed backend must replace the expired cookie jar"
        );
        assert_eq!(l.projects.len(), 1);
        assert_eq!(l.projects[0].id, "ws-1");
        server.abort();
    });
}

#[test]
fn failed_managed_renewal_falls_back_to_login_once_without_looping() {
    crate::platform::block_on(async {
        let expired = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_ref = calls.clone();
        let host = crate::platform::LocalHost::fixture(move || {
            calls_ref.fetch_add(1, Ordering::SeqCst);
            None
        });

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat { launcher: Some(l) };
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));

        assert!(crate::settings::authentication_required(
            &mut rt.state,
            &expired
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while rt
            .state
            .screen
            .launcher()
            .unwrap()
            .managed_renewal
            .is_some()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "managed renewal timed out"
            );
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(rt.state.screen.is_launcher());
        assert!(rt.state.screen.launcher().unwrap().authentication_required);

        // Subsequent 401 for the same expired backend must not retry managed renewal.
        assert!(crate::settings::authentication_required(
            &mut rt.state,
            &expired
        ));
        assert!(
            rt.state
                .screen
                .launcher()
                .unwrap()
                .managed_renewal
                .is_none()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn managed_renewal_rejects_server_identity_mismatch_and_shows_login() {
    crate::platform::block_on(async {
        let cookie_name = "codenomad_session_test";
        let renewed_value = "renewed_session_token_012345678901234567890";
        let (base, server) = spawn_renewal_server(
            "srv-impostor",
            "codenomad_session_test=renewed_session_token_012345678901234567890",
        )
        .await;
        let expired = Backend::unauthenticated(&base).unwrap();
        let base_ref = base.clone();
        let host = crate::platform::LocalHost::fixture(move || {
            Backend::connect_with_session_cookie(&base_ref, cookie_name, renewed_value).ok()
        });

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-expected".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat { launcher: Some(l) };
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));

        assert!(crate::settings::authentication_required(
            &mut rt.state,
            &expired
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while rt
            .state
            .screen
            .launcher()
            .unwrap()
            .managed_renewal
            .is_some()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "managed renewal timed out"
            );
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(rt.state.screen.is_launcher());
        assert!(crate::shell::launcher_replaces_project(&rt.state));
        let l = rt.state.screen.launcher().unwrap();
        assert!(l.authentication_required);
        assert!(
            l.connection
                .as_ref()
                .unwrap()
                .client
                .same_connection(&expired.client)
        );
        server.abort();
    });
}

#[test]
fn attested_managed_renewal_keeps_new_cookie_when_projects_list_fails() {
    crate::platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");
                    let (status, body) = if path == "/api/meta" {
                        (
                            "200 OK",
                            r#"{"serverId":"srv-ok","apiContract":1,"capabilities":[]}"#,
                        )
                    } else if path == "/api/workspaces" {
                        ("500 Internal Server Error", r#"{"error":"transient"}"#)
                    } else {
                        ("404 Not Found", "{}")
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        let base = format!("http://127.0.0.1:{port}/");
        let expired = Backend::unauthenticated(&base).unwrap();
        let base_ref = base.clone();
        let host = crate::platform::LocalHost::fixture(move || {
            Backend::connect_with_session_cookie(
                &base_ref,
                "codenomad_session_test",
                "renewed_session_token_012345678901234567890",
            )
            .ok()
        });

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-ok".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat { launcher: Some(l) };
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));

        assert!(crate::settings::authentication_required(
            &mut rt.state,
            &expired
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while rt
            .state
            .screen
            .launcher()
            .unwrap()
            .managed_renewal
            .is_some()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "managed renewal timed out"
            );
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let l = rt.state.screen.launcher().unwrap();
        assert!(!l.authentication_required, "attested cookie must be kept");
        assert_eq!(l.error, Some("rune.list_error"));
        assert!(
            !l.connection
                .as_ref()
                .unwrap()
                .client
                .same_connection(&expired.client)
        );
        server.abort();
    });
}

#[test]
fn launcher_job_proxied_401_does_not_expire_live_codenomad_session() {
    crate::platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");
                    let (status, body) = if path == "/api/auth/status" {
                        ("200 OK", r#"{"authenticated":true}"#)
                    } else {
                        (
                            "401 Unauthorized",
                            r#"{"error":"upstream opencode unauthorized"}"#,
                        )
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        let base = format!("http://127.0.0.1:{port}/");
        let backend = Backend::unauthenticated(&base).unwrap();
        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(backend.clone());
        let check_backend = backend.clone();
        l.job("sessionList.reload.error", async move {
            check_backend
                .client
                .get(format!("{base}workspaces/ws-1/instance/api/session"))
                .send()
                .await?
                .error_for_status()?;
            Err("expected 401".into())
        });
        s.screen = crate::Screen::Chat { launcher: Some(l) };
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while rt.state.screen.launcher().unwrap().pending {
            assert!(
                std::time::Instant::now() < deadline,
                "launcher job timed out"
            );
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let l = rt.state.screen.launcher().unwrap();
        assert!(!l.authentication_required);
        assert_eq!(l.error, Some("sessionList.reload.error"));
        server.abort();
    });
}
