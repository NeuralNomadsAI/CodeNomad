//! `POST /api/opencode/service`: start/reconnect, restart or reload the shared OpenCode service
//! (`routes/opencode-update.ts`, `opencode-update/service.ts` `start`/`reload`/`activate`).
use std::{
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    Json,
    extract::{Request, State},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use futures_util::FutureExt;
use serde_json::{Value, json};
use tokio::time::Instant;

use super::{admission, daemon, launch, update};
use crate::{Shared, shared::fastify};

const RELOAD_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Start,
    Restart,
    Reload,
}

type Flight = futures_util::future::Shared<futures_util::future::BoxFuture<'static, Result<Value, String>>>;

struct Active {
    id: u64,
    binary_path: String,
    action: Action,
    flight: Flight,
}

/// One in-flight daemon-wide activation per server authority (`OpenCodeUpdateService.activation`).
#[derive(Default)]
pub struct Activation {
    active: Mutex<Option<Active>>,
    next_id: AtomicU64,
    #[cfg(test)]
    coalesced: AtomicU64,
}

#[cfg(test)]
impl Activation {
    pub(crate) fn coalesced_count(&self) -> u64 {
        self.coalesced.load(Ordering::SeqCst)
    }
}

fn parse_action(body: Option<fastify::Body>) -> Result<Action, Response> {
    let invalid = || (Status::BAD_REQUEST, Json(json!({"error": "invalid_service_action"}))).into_response();
    let body = match body {
        None | Some(fastify::Body::Json(Value::Null)) => return Ok(Action::Start),
        Some(fastify::Body::Json(Value::Object(map))) => map,
        Some(_) => return Err(invalid()),
    };
    let mut restart = false;
    let mut reload = false;
    for (key, value) in &body {
        match key.as_str() {
            "restart" => {
                restart = value.as_bool().ok_or_else(invalid)?;
            }
            "reload" => {
                reload = value.as_bool().ok_or_else(invalid)?;
            }
            _ => return Err(invalid()),
        }
    }
    if restart && reload {
        return Err(invalid());
    }
    Ok(if reload {
        Action::Reload
    } else if restart {
        Action::Restart
    } else {
        Action::Start
    })
}

async fn run_action(app: Shared, action: Action) -> Result<Value, String> {
    let (binary, _, _) = update::selected_binary(&app).await;
    let flight = {
        let mut slot = app.service_activation.active.lock().unwrap();
        if let Some(existing) = slot.as_ref() {
            if existing.action == action && existing.binary_path == binary {
                #[cfg(test)]
                app.service_activation.coalesced.fetch_add(1, Ordering::SeqCst);
                existing.flight.clone()
            } else {
                return Err("Another OpenCode service action is in progress".into());
            }
        } else {
            let id = app.service_activation.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
            let app_task = app.clone();
            let binary_task = binary.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let shared: Flight =
                async move { rx.await.unwrap_or_else(|_| Err("OpenCode service activation stopped".into())) }
                    .boxed()
                    .shared();
            *slot = Some(Active { id, binary_path: binary, action, flight: shared.clone() });
            tokio::spawn(async move {
                let result = activate(&app_task, &binary_task, action).await;
                let mut slot = app_task.service_activation.active.lock().unwrap();
                if slot.as_ref().is_some_and(|entry| entry.id == id) {
                    *slot = None;
                }
                let _ = tx.send(result);
            });
            shared
        }
    };
    flight.await
}

async fn assert_current(app: &Shared, binary: &str) -> Result<(), String> {
    let (selected, _, _) = update::selected_binary(app).await;
    if selected != binary {
        return Err("OpenCode selection changed during activation".into());
    }
    if launch::wsl(binary) {
        return Err("WSL OpenCode is not supported by this backend".into());
    }
    Ok(())
}

async fn activate(app: &Shared, binary: &str, action: Action) -> Result<Value, String> {
    let restart = action == Action::Restart;
    let installed_version = update::read_current_version(binary).await?;
    let lifecycle =
        app.native.lifecycle_for(binary).ok_or_else(|| "OpenCode service lifecycle unavailable".to_owned())?;
    // Match TS `setupServiceOptions`: validate and freeze profile startup environment once for the whole action.
    let startup_env = launch::daemon_environment_from_config(lifecycle.config_path.as_deref())?;
    let previous = lifecycle.discover(Instant::now() + daemon::TIMEOUT).await?;
    if (previous.is_none() || restart) && admission::below_minimum(&installed_version) {
        return Err(
            admission::Refusal::Unsupported { actual: installed_version, reason: "native_contract" }.to_string()
        );
    }
    if restart
        && let Some(prev) = &previous
        && !update::can_replace_daemon(Some(&installed_version), Some(&prev.version))
    {
        return Err("The selected OpenCode executable cannot safely replace the running daemon".into());
    }
    assert_current(app, binary).await?;

    if action == Action::Reload {
        let Some(prev) = previous.filter(|ep| !ep.version.trim().is_empty()) else {
            return Err("OpenCode configuration reload unavailable".into());
        };
        let capabilities = admission::inspect(&app.native.client, &prev).await.map_err(|e| e.to_string())?;
        if !capabilities.reload {
            return Err("OpenCode does not expose configuration reload".into());
        }
        assert_current(app, binary).await?;
        // Explicit daemon-wide mutation: never use this as an automatic watcher fallback,
        // because native reload cancels pending Forms and permissions.
        let endpoint =
            app.native.reconnect(app, binary, Instant::now() + daemon::TIMEOUT).await.map_err(|e| e.to_string())?;
        assert_current(app, binary).await?;
        if !app.native.current(&endpoint) {
            return Err("OpenCode connection changed during reload".into());
        }
        if *endpoint != prev {
            let reconnected_caps =
                admission::inspect(&app.native.client, &endpoint).await.map_err(|e| e.to_string())?;
            if !reconnected_caps.reload {
                return Err("OpenCode does not expose configuration reload".into());
            }
            if !app.native.current(&endpoint) {
                return Err("OpenCode connection changed during reload".into());
            }
        }
        let mut reload_url = endpoint.url.clone();
        reload_url.set_path("/api/location/reload");
        let response = app
            .native
            .client
            .post(reload_url)
            .basic_auth("opencode", Some(&endpoint.password))
            .timeout(RELOAD_TIMEOUT)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("OpenCode configuration reload failed (HTTP {})", response.status().as_u16()));
        }
        if !app.native.current(&endpoint) {
            return Err("OpenCode connection changed during reload".into());
        }
        assert_current(app, binary).await?;
        return Ok(update::status_value(app, false).await);
    }

    let endpoint = if restart && previous.is_some() {
        lifecycle.restart_with_env(&startup_env, Instant::now() + daemon::TIMEOUT).await?
    } else if let Some(prev) = previous {
        prev
    } else {
        lifecycle.ensure_with_env(&startup_env, Instant::now() + daemon::TIMEOUT).await?
    };
    if endpoint.version.trim().is_empty() {
        return Err("OpenCode did not report an authenticated runtime version".into());
    }
    admission::inspect(&app.native.client, &endpoint).await.map_err(|e| e.to_string())?;
    assert_current(app, binary).await?;
    app.native.reconnect(app, binary, Instant::now() + daemon::TIMEOUT).await.map_err(|e| e.to_string())?;
    Ok(update::status_value(app, false).await)
}

/// `POST /api/opencode/service` `{ restart?: boolean, reload?: boolean }`.
pub async fn handle(State(app): State<Shared>, request: Request) -> Response {
    let body = match super::read_fastify_body(request).await {
        Ok(body) => body,
        Err(err) => return err.into_response(),
    };
    let action = match parse_action(body) {
        Ok(action) => action,
        Err(response) => return response,
    };
    match run_action(app, action).await {
        Ok(status) => Json(status).into_response(),
        Err(err) => {
            eprintln!("Failed to activate OpenCode: {err}");
            (Status::BAD_GATEWAY, Json(json!({"error": "service_activation_failed"}))).into_response()
        }
    }
}
