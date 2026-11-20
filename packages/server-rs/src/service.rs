//! Running as a user service: the daemon endpoint from its registration record and
//! a graceful stop on Ctrl+C or SIGTERM (systemd's default stop signal).
//!
//! The record's loopback URL and password are used only after `/api/info` on that URL,
//! authenticated with that password, reports the record's PID: a stale record of a
//! stopped daemon is never trusted.
use std::{path::Path, time::Duration};

use reqwest::Url;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub fn loopback(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

async fn confirmed(path: &Path, client: &reqwest::Client) -> Option<(String, String)> {
    let bytes = crate::extensions::artifact::read_bounded(path, 64 * 1024).ok()??;
    let record: Value = serde_json::from_slice(&bytes).ok()?;
    let url = Url::parse(record["url"].as_str()?).ok()?;
    let password = record["password"].as_str().filter(|p| !p.is_empty())?.to_owned();
    let pid = record["pid"].as_u64()?;
    if !loopback(&url) {
        return None;
    }
    let info: Value = client
        .get(url.join("/api/info").ok()?)
        .basic_auth("opencode", Some(&password))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let reported = info.get("data").unwrap_or(&info)["pid"].as_u64();
    (reported == Some(pid)).then(|| (url.as_str().to_owned(), password))
}

/// Waits up to a minute for a confirmed record.
pub async fn endpoint(path: &Path) -> Result<(String, String), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build()?;
    for _ in 0..120 {
        if let Some(endpoint) = confirmed(path, &client).await {
            return Ok(endpoint);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("OpenCode service registration is missing, stale or unreachable".into())
}

/// A signal during a stop already under way, from stdin or a first signal, exits 1 at once
/// (`createServerShutdownHandler`).
pub fn stop_on_terminate(stop: CancellationToken) {
    let trigger = |stop: &CancellationToken| {
        if stop.is_cancelled() {
            std::process::exit(1);
        }
        stop.cancel();
    };
    #[cfg(unix)]
    tokio::spawn({
        let stop = stop.clone();
        async move {
            use tokio::signal::unix::{SignalKind, signal};
            if let Ok(mut term) = signal(SignalKind::terminate()) {
                while term.recv().await.is_some() {
                    trigger(&stop);
                }
            }
        }
    });
    tokio::spawn(async move {
        while tokio::signal::ctrl_c().await.is_ok() {
            trigger(&stop);
        }
    });
}
