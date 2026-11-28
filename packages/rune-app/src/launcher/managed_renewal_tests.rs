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
            match Backend::connect_with_session_cookie(&base_ref, cookie_name, renewed_value) {
                Ok(backend) => crate::platform::ManagedRenewal::Renewed(backend),
                Err(_) => crate::platform::ManagedRenewal::Denied,
            }
        });

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.host = Some(host);
        l.project = Some(Project {
            id: "ws-1".into(),
            path: "/proj".into(),
            temporary: false,
        });
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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
            crate::platform::ManagedRenewal::Denied
        });

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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
        let host =
            crate::platform::LocalHost::fixture(
                move || match Backend::connect_with_session_cookie(
                    &base_ref,
                    cookie_name,
                    renewed_value,
                ) {
                    Ok(backend) => crate::platform::ManagedRenewal::Renewed(backend),
                    Err(_) => crate::platform::ManagedRenewal::Denied,
                },
            );

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-expected".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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
        let fail_workspaces = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let fail_ref = fail_workspaces.clone();
        let valid_cookie = "codenomad_session_test=renewed_session_token_012345678901234567890";
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let fail_ref = fail_ref.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");
                    let authorized = req.lines().any(|line| {
                        line.to_ascii_lowercase()
                            .contains(&format!("cookie: {valid_cookie}"))
                    });
                    let (status, body) = if !authorized {
                        ("401 Unauthorized", r#"{"error":"Unauthorized"}"#)
                    } else if path == "/api/meta" {
                        (
                            "200 OK",
                            r#"{"serverId":"srv-ok","apiContract":1,"capabilities":[]}"#,
                        )
                    } else if path == "/api/workspaces" {
                        if fail_ref.load(Ordering::SeqCst) {
                            ("500 Internal Server Error", r#"{"error":"transient"}"#)
                        } else {
                            (
                                "200 OK",
                                r#"[{"id":"ws-recovered","location":{"directory":"/recovered"}}]"#,
                            )
                        }
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
        let host =
            crate::platform::LocalHost::fixture(
                move || match Backend::connect_with_session_cookie(
                    &base_ref,
                    "codenomad_session_test",
                    "renewed_session_token_012345678901234567890",
                ) {
                    Ok(backend) => crate::platform::ManagedRenewal::Renewed(backend),
                    Err(_) => crate::platform::ManagedRenewal::Denied,
                },
            );

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-ok".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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
        assert!(
            l.projects_stale,
            "failed project list must remain refreshable"
        );
        assert_eq!(l.error, Some("rune.list_error"));
        assert!(
            !l.connection
                .as_ref()
                .unwrap()
                .client
                .same_connection(&expired.client)
        );

        // Dedicated project inventory retry recovers the project list with the kept cookie.
        fail_workspaces.store(false, Ordering::SeqCst);
        refresh_projects(&mut rt.state);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while rt
            .state
            .screen
            .launcher()
            .unwrap()
            .projects_refresh
            .is_some()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "projects refresh timed out"
            );
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let l = rt.state.screen.launcher().unwrap();
        assert!(!l.projects_stale);
        assert_eq!(l.error, None);
        assert_eq!(l.projects.len(), 1);
        assert_eq!(l.projects[0].id, "ws-recovered");
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
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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

#[test]
fn renewed_cookie_revoked_on_workspaces_401_is_rejected_and_shows_login() {
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
                        ("401 Unauthorized", r#"{"error":"Unauthorized"}"#)
                    } else if path == "/api/auth/status" {
                        ("200 OK", r#"{"authenticated":false}"#)
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
        let host =
            crate::platform::LocalHost::fixture(
                move || match Backend::connect_with_session_cookie(
                    &base_ref,
                    "codenomad_session_test",
                    "renewed_session_token_012345678901234567890",
                ) {
                    Ok(backend) => crate::platform::ManagedRenewal::Renewed(backend),
                    Err(_) => crate::platform::ManagedRenewal::Denied,
                },
            );

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-ok".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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
            assert!(std::time::Instant::now() < deadline, "renewal timed out");
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(rt.state.screen.is_launcher());
        let l = rt.state.screen.launcher().unwrap();
        assert!(
            l.authentication_required,
            "revoked renewed cookie must not be installed"
        );
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
fn stale_created_reply_after_renewal_preserves_session_without_binding_expired_backend() {
    crate::platform::block_on(async {
        let cookie_name = "codenomad_session_test";
        let renewed_value = "renewed_session_token_012345678901234567890";
        let (base, server) = spawn_renewal_server(
            "srv-managed",
            "codenomad_session_test=renewed_session_token_012345678901234567890",
        )
        .await;
        let expired = Backend::unauthenticated(&base).unwrap();
        let mut expired_session_backend = expired.clone();
        expired_session_backend.workspace = "ws-1".into();
        expired_session_backend.session = "ses_created".into();
        let base_ref = base.clone();
        let host =
            crate::platform::LocalHost::fixture(
                move || match Backend::connect_with_session_cookie(
                    &base_ref,
                    cookie_name,
                    renewed_value,
                ) {
                    Ok(backend) => crate::platform::ManagedRenewal::Renewed(backend),
                    Err(_) => crate::platform::ManagedRenewal::Denied,
                },
            );

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.host = Some(host);
        l.project = Some(Project {
            id: "ws-1".into(),
            path: "/proj".into(),
            temporary: false,
        });
        let (job_tx, job_rx) = bounded(1);
        l.pending = true;
        l.pending_connection_generation = l.connection_generation;
        l.result = Some(job_rx);
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
        let mut rt =
            rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));

        assert!(crate::settings::authentication_required(
            &mut rt.state,
            &expired
        ));
        assert!(rt.state.phase == Phase::Reconnecting);
        // Clicking Retry while renewal is in flight keeps the chat view visible.
        rt.update(|s, tx| {
            crate::chat::connection::retry_connection(s, tx);
        });
        assert!(!rt.state.screen.is_launcher());
        assert!(rt.state.phase == Phase::Reconnecting);

        // Wait for managed renewal to settle while the old Created job is still pending.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while rt
            .state
            .screen
            .launcher()
            .unwrap()
            .managed_renewal
            .is_some()
        {
            assert!(std::time::Instant::now() < deadline, "renewal timed out");
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let renewed_client = rt
            .state
            .screen
            .launcher()
            .unwrap()
            .connection
            .as_ref()
            .unwrap()
            .client
            .clone();
        assert!(!renewed_client.same_connection(&expired.client));

        // Now deliver the late Reply::Created carrying the expired backend.
        job_tx
            .send(Ok(Reply::Created(
                expired_session_backend,
                "Fresh title".into(),
                "root".into(),
                String::new(),
                None,
                None,
            )))
            .await
            .unwrap();
        rt.update(|s, tx| {
            let _ = poll(s, tx);
        });
        let l = rt.state.screen.launcher().unwrap();
        assert!(
            l.sessions.iter().any(|row| row.id == "ses_created"),
            "created session must be retained in the sidebar"
        );
        // The old expired backend must never be bound; instead a new selection job starts on the renewed client.
        assert!(
            l.pending,
            "stale Created reply must re-verify and bind via the renewed connection"
        );
        assert!(
            crate::settings::bound_backend(&rt.state)
                .as_ref()
                .is_none_or(|b| !b.client.same_connection(&expired.client)),
            "expired backend must never be installed onto the active conversation"
        );
        server.abort();
    });
}

#[test]
fn transient_managed_renewal_retries_once_and_recovers() {
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
            let attempt = calls_ref.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                crate::platform::ManagedRenewal::Transient
            } else {
                match Backend::connect_with_session_cookie(&base_ref, cookie_name, renewed_value) {
                    Ok(backend) => crate::platform::ManagedRenewal::Renewed(backend),
                    Err(_) => crate::platform::ManagedRenewal::Denied,
                }
            }
        });

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.host = Some(host);
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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
                "transient retry timed out"
            );
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let l = rt.state.screen.launcher().unwrap();
        assert!(!l.authentication_required);
        assert!(!rt.state.screen.is_launcher());
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
fn stale_connected_reply_after_renewal_does_not_reinstall_expired_backend() {
    crate::platform::block_on(async {
        let cookie_name = "codenomad_session_test";
        let renewed_value = "renewed_session_token_012345678901234567890";
        let (base, server) = spawn_renewal_server(
            "srv-managed",
            "codenomad_session_test=renewed_session_token_012345678901234567890",
        )
        .await;
        let expired = Backend::unauthenticated(&base).unwrap();
        let base_ref = base.clone();
        let host =
            crate::platform::LocalHost::fixture(
                move || match Backend::connect_with_session_cookie(
                    &base_ref,
                    cookie_name,
                    renewed_value,
                ) {
                    Ok(backend) => crate::platform::ManagedRenewal::Renewed(backend),
                    Err(_) => crate::platform::ManagedRenewal::Denied,
                },
            );

        let mut s = crate::init();
        let mut l = Launcher::fixture();
        l.connection = Some(expired.clone());
        l.server_id = Some("srv-managed".into());
        l.host = Some(host);
        let (boot_tx, boot_rx) = bounded(1);
        l.pending = true;
        l.pending_connection_generation = l.connection_generation;
        l.result = Some(boot_rx);
        s.screen = crate::Screen::Chat {
            launcher: Some(Box::new(l)),
        };
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
            assert!(std::time::Instant::now() < deadline, "renewal timed out");
            rt.update(|s, tx| {
                let _ = poll(s, tx);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let renewed_client = rt
            .state
            .screen
            .launcher()
            .unwrap()
            .connection
            .as_ref()
            .unwrap()
            .client
            .clone();
        assert!(!renewed_client.same_connection(&expired.client));

        // Deliver the late bootstrap Reply::Connected carrying the expired client.
        boot_tx
            .send(Ok(Reply::Connected(
                expired.clone(),
                vec![Project {
                    id: "ws-stale".into(),
                    path: "/stale".into(),
                    temporary: false,
                }],
                "srv-managed".into(),
            )))
            .await
            .unwrap();
        rt.update(|s, tx| {
            let _ = poll(s, tx);
        });
        let l = rt.state.screen.launcher().unwrap();
        assert!(
            l.connection
                .as_ref()
                .unwrap()
                .client
                .same_connection(&renewed_client),
            "late Reply::Connected from an older generation must not reinstall the expired client"
        );
        assert_eq!(l.projects.len(), 1);
        assert_eq!(l.projects[0].id, "ws-1");
        server.abort();
    });
}
