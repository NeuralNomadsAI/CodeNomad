//! Process-parent stdin/stdout renewal for the bootstrap-only local session
//! (`managed-session-control.ts`).
use super::Auth;

pub const RENEW_PREFIX: &str = "codenomad:renew-session ";
pub const RESPONSE_PREFIX: &str = "CODENOMAD_MANAGED_SESSION:";

pub(super) struct ManagedSession {
    pub(super) current: String,
    pub(super) previous: Option<String>,
    pub(super) delivered: bool,
}

fn valid_request_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// The credential travels only over the attached parent's process pipes.
pub fn handle_control(line: &str, auth: &Auth, mut send: impl FnMut(&str)) -> bool {
    let Some(id) = line.strip_prefix(RENEW_PREFIX) else {
        return false;
    };
    if !valid_request_id(id) {
        return false;
    }
    let renewed = auth.renew_managed_session();
    send(&format!("{RESPONSE_PREFIX}{id} {}", renewed.as_deref().unwrap_or("-")));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        App,
        auth::{self, Auth, Settings},
        files,
        opencode::Native,
        settings,
    };
    use axum::{Json, Router, http::StatusCode, middleware::from_fn_with_state, routing::get};
    use serde_json::{Value, json};
    use std::{
        net::SocketAddr,
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };
    use tokio::net::TcpListener;

    struct Fixture {
        app: Arc<App>,
        base: String,
        client: reqwest::Client,
        server: tokio::task::JoinHandle<()>,
        dir: PathBuf,
    }
    impl Fixture {
        async fn new(managed_local: bool, idle: Duration) -> Self {
            let dir = std::env::temp_dir().join(format!("codenomad-managed-session-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let auth = Auth::new(Settings {
                username: "local".into(),
                password: None,
                file: Some(dir.join("auth.json")),
                cookie: "codenomad_session_test".into(),
                token: true,
                managed_local,
                skip: false,
                idle,
                absolute: Duration::from_secs(60),
            })
            .unwrap();
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            let cfg = settings::Settings::new(settings::document::Location::resolve(
                dir.join("config.yaml").to_str().unwrap(),
            ));
            let native = Native::test_connection(SocketAddr::from(([127, 0, 0, 1], 9)));
            let app = Arc::new(App::new(
                auth,
                port,
                dir.clone(),
                dir.clone(),
                false,
                cfg,
                Value::Null,
                native,
                PathBuf::new(),
                None,
                files::watch::Watches::new(tx),
                None,
            ));
            let router = Router::new()
                .merge(auth::routes())
                .merge(auth::local_routes())
                .route("/api/private", get(|| async { Json(json!({"ok": true})) }))
                .layer(from_fn_with_state(app.clone(), auth::admit))
                .with_state(app.clone());
            let server = tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            let client =
                reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
            Self { app, base: format!("http://127.0.0.1:{port}"), client, server, dir }
        }
        fn issue_token(&self) -> String {
            let token = auth::random_id().unwrap();
            *self.app.auth.token.lock().unwrap() = Some((token.clone(), Instant::now()));
            token
        }
        async fn call(
            &self,
            method: reqwest::Method,
            path: &str,
            cookie: Option<&str>,
            body: Option<Value>,
        ) -> (StatusCode, Option<String>, Vec<u8>) {
            let mut req = self.client.request(method, format!("{}{path}", self.base));
            if let Some(cookie) = cookie {
                req = req.header(reqwest::header::COOKIE, cookie);
            }
            if let Some(body) = body {
                req = req.json(&body);
            }
            let res = req.send().await.unwrap();
            let status = StatusCode::from_u16(res.status().as_u16()).unwrap();
            let set_cookie =
                res.headers().get(reqwest::header::SET_COOKIE).and_then(|v| v.to_str().ok()).map(str::to_owned);
            let bytes = res.bytes().await.unwrap().to_vec();
            (status, set_cookie, bytes)
        }
        fn renew(&self) -> String {
            let id = "9d754f99-0b08-44d0-a99c-0d6c95229647";
            let mut lines = Vec::new();
            assert!(handle_control(&format!("codenomad:renew-session {id}"), &self.app.auth, |line| {
                lines.push(line.to_owned())
            }));
            assert_eq!(lines.len(), 1);
            let prefix = format!("{RESPONSE_PREFIX}{id} ");
            let value = lines[0].strip_prefix(&prefix).expect("response prefix").to_owned();
            assert!(
                value == "-"
                    || (value.len() == 43
                        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))),
                "unexpected reply: {value}"
            );
            value
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[tokio::test]
    async fn parent_renews_expired_managed_session_and_logout_or_password_retires_right() {
        let f = Fixture::new(true, Duration::from_millis(35)).await;
        let first = f.app.auth.bootstrap_token().unwrap();
        let (status, set_cookie, _) =
            f.call(reqwest::Method::POST, "/api/auth/token", None, Some(json!({"token": first}))).await;
        assert_eq!(status, StatusCode::OK);
        let old_cookie = set_cookie.unwrap().split(';').next().unwrap().to_owned();
        assert_eq!(f.renew(), "-", "live delivered session does not renew");

        tokio::time::sleep(Duration::from_millis(55)).await;
        assert_eq!(
            f.call(reqwest::Method::GET, "/api/private", Some(&old_cookie), None).await.0,
            StatusCode::UNAUTHORIZED
        );
        let (status, _, body) = f.call(reqwest::Method::GET, "/api/auth/status", Some(&old_cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({"authenticated": false}));
        assert_eq!(
            f.call(reqwest::Method::POST, "/api/auth/token", None, Some(json!({"token": first}))).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            f.call(reqwest::Method::POST, "/api/auth/renew", Some(&old_cookie), None).await.0,
            StatusCode::UNAUTHORIZED
        );

        let renewed = f.renew();
        assert_eq!(renewed.len(), 43);
        assert_eq!(f.renew(), renewed, "the same hand-off survives a lost response");
        let cookie = format!("{}={renewed}", f.app.auth.cookie_name());
        assert_ne!(cookie, old_cookie);
        assert_eq!(f.call(reqwest::Method::GET, "/api/private", Some(&cookie), None).await.0, StatusCode::OK);
        assert_eq!(
            f.call(reqwest::Method::POST, "/api/auth/renew", Some(&cookie), None).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            f.call(reqwest::Method::GET, "/api/private", Some(&old_cookie), None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(f.renew(), "-", "once delivered, live session does not re-emit");

        tokio::time::sleep(Duration::from_millis(55)).await;
        let (status, cleared, _) = f.call(reqwest::Method::POST, "/api/auth/logout", Some(&cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(cleared.unwrap().contains("Max-Age=0"));
        assert_eq!(f.renew(), "-", "logout retires managed renewal right");

        // Raced logout with immediate predecessor cookie revokes the renewed active session.
        let second = f.issue_token();
        let (_, set_cookie, _) =
            f.call(reqwest::Method::POST, "/api/auth/token", None, Some(json!({"token": second}))).await;
        let race_cookie = set_cookie.unwrap().split(';').next().unwrap().to_owned();
        tokio::time::sleep(Duration::from_millis(55)).await;
        let uninstalled = f.renew();
        assert_ne!(uninstalled, "-");
        let renewed_cookie = format!("{}={uninstalled}", f.app.auth.cookie_name());
        assert_eq!(f.call(reqwest::Method::GET, "/api/private", Some(&renewed_cookie), None).await.0, StatusCode::OK);
        let (status, _, _) = f.call(reqwest::Method::POST, "/api/auth/logout", Some(&race_cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            f.call(reqwest::Method::GET, "/api/private", Some(&renewed_cookie), None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(f.renew(), "-");

        // Setting a user password revokes sessions and retires renewal right.
        let third = f.issue_token();
        let (_, set_cookie, _) =
            f.call(reqwest::Method::POST, "/api/auth/token", None, Some(json!({"token": third}))).await;
        let new_cookie = set_cookie.unwrap().split(';').next().unwrap().to_owned();
        let (status, _, _) = f
            .call(
                reqwest::Method::POST,
                "/api/auth/password",
                Some(&new_cookie),
                Some(json!({"password": "fixture-only"})),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            f.call(reqwest::Method::GET, "/api/private", Some(&new_cookie), None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(f.renew(), "-");
    }

    #[tokio::test]
    async fn control_rejects_malformed_lines_and_unmanaged_servers() {
        let unmanaged = Fixture::new(false, Duration::from_millis(25)).await;
        let token = unmanaged.app.auth.bootstrap_token().unwrap();
        let (status, _, _) =
            unmanaged.call(reqwest::Method::POST, "/api/auth/token", None, Some(json!({"token": token}))).await;
        assert_eq!(status, StatusCode::OK);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(unmanaged.renew(), "-");

        let mut emitted = Vec::new();
        for bad in [
            "codenomad:renew-session",
            "codenomad:renew-session short",
            "codenomad:renew-session 9D754F99-0B08-44D0-A99C-0D6C95229647",
            "codenomad:renew-session 9d754f99-0b08-44d0-a99c-0d6c95229647 extra",
            " codenomad:renew-session 9d754f99-0b08-44d0-a99c-0d6c95229647",
        ] {
            assert!(!handle_control(bad, &unmanaged.app.auth, |line| emitted.push(line.to_owned())), "{bad:?}");
        }
        assert!(emitted.is_empty());
    }
}
