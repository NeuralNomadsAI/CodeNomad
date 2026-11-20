//! CodeNomad server in Rust: `codenomad-rs serve [options]` as Tauri launches the reference,
//! or the bench's positional launch. Start-up, then every domain's routes behind the loopback
//! password session and, with HTTPS configured, behind the paired-device admission.
mod app;
mod auth;
mod bench;
mod config;
mod events;
mod extensions;
mod files;
mod git;
mod host;
mod memory;
mod meta;
#[rustfmt::skip] // Frozen while its contract is redesigned: moved, never reformatted.
mod missions;
mod opencode;
mod search;
mod service;
mod sessions;
mod shared;
mod storage;
mod subagent_depth;
mod workspaces;
mod worktrees;

use std::{env, fs, sync::Arc};

use axum::{Router, extract::Request, middleware::from_fn, middleware::from_fn_with_state};
use tokio_util::sync::CancellationToken;

use app::{App, Error, Shared, Workspace, error, not_found, now, unavailable};
use shared::{data_owner, panic_guard};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    bench::panic_on_start();
    let args: Vec<_> = env::args().skip(1).collect();
    let launch = if host::cli::serves(&args) {
        match host::cli::parse(&args) {
            Ok(host::cli::Command::Serve(launch)) => *launch,
            Ok(host::cli::Command::Print(text)) => return Ok(println!("{text}")),
            Err(message) => {
                eprintln!("error: {message}");
                std::process::exit(1);
            }
        }
    } else {
        bench::positional(&args)?
    };
    let serve = launch.serve;
    let complete = run(launch).await?;
    if serve {
        host::finish(complete);
    }
    Ok(())
}

/// Serves until a stop request; true when every listener and task stopped cleanly.
async fn run(launch: host::Launch) -> Result<bool, Box<dyn std::error::Error>> {
    let root = dunce::canonicalize(&launch.root)?;
    if !root.is_dir() {
        return Err("Workspace root must be a directory".into());
    }
    if !root.to_str().is_some_and(files::paths::local_absolute) {
        return Err("Workspace root must be a local absolute path".into());
    }
    let auth = auth::Auth::new(launch.auth)?;
    if let Some(token) = auth.bootstrap_token().filter(|_| launch.serve) {
        host::line(&format!("CODENOMAD_BOOTSTRAP_TOKEN:{token}"));
    }
    let native = opencode::Native::connect().await?;
    let listener = launch.http.listen().await?;
    let port = listener.local_addr()?.port();
    let (identity, data) = (launch.identity.as_path(), launch.data);
    fs::create_dir_all(&data)?;
    data_owner::protect(&data)?;
    git::empty_hooks(&data.join("git-empty-hooks"))?;
    if data_owner::foreign(identity)? {
        return Err("Identity file is owned by another account".into());
    }
    let tls = match launch.https {
        Some(settings) => Some(auth::tls::Listener::open(settings).await?),
        None => None,
    };
    let devices = match &tls {
        Some(tls) => Some(auth::devices::open(&data, tls)?),
        None => None,
    };
    let meta = meta::document(identity, port, &root, tls.as_ref(), launch.ui.meta())?;
    let (watch_tx, watch_rx) = tokio::sync::mpsc::channel(512);
    let calendar_profile = missions::calendar::setup(&data)?;
    let watches = files::watch::Watches::new(watch_tx);
    let state =
        Arc::new(App::new(auth, port, data, root, meta, native, launch.binary, devices, watches, calendar_profile));

    let routes = Router::new()
        .merge(meta::routes())
        .merge(auth::routes())
        .merge(workspaces::routes())
        .merge(files::routes())
        .merge(search::routes())
        .merge(git::routes())
        .merge(worktrees::routes())
        .merge(storage::routes())
        .merge(memory::routes())
        .merge(subagent_depth::routes())
        .merge(sessions::routes())
        .merge(events::routes())
        .merge(extensions::routes())
        .merge(missions::routes())
        .merge(opencode::routes());

    let shutdown = CancellationToken::new();
    service::stop_on_terminate(shutdown.clone());
    if launch.serve {
        host::read_stdin(shutdown.clone());
    } else {
        bench::stop_on_stdin(shutdown.clone());
    }
    let plugins = extensions::lifecycle::start(&state, shutdown.clone())?;
    missions::serve_bridge(&state, shutdown.clone());
    tokio::spawn(files::watch::run(state.clone(), watch_rx, shutdown.clone()));
    let remote_url = tls.as_ref().map(|tls| tls.origin.clone());
    let remote = tls.map(|tls| {
        let remote = routes
            .clone()
            .merge(auth::remote_routes())
            .fallback(|| async { unavailable() })
            .layer(from_fn(panic_guard::catch))
            .layer(from_fn_with_state(state.clone(), auth::remote::admit))
            .layer(from_fn(bench::refusal_trace))
            .with_state(state.clone());
        if !launch.serve {
            println!("HTTPS {}", tls.origin);
        }
        tokio::spawn(auth::devices::sweep(state.clone(), shutdown.clone()));
        tokio::spawn(tls.serve(remote, shutdown.clone()))
    });
    let ui = Arc::new(launch.ui);
    let local = routes
        .merge(auth::local_routes())
        .fallback(move |req: Request| {
            let ui = ui.clone();
            async move { host::ui::serve(&ui, req).await }
        })
        .layer(from_fn(panic_guard::catch))
        .layer(from_fn_with_state(state.clone(), auth::admit))
        .with_state(state.clone());
    tokio::spawn(auth::Auth::sweep(state.clone()));
    tokio::spawn(events::bridge(state.clone()));
    let local_url = format!("http://127.0.0.1:{port}");
    if launch.serve {
        // The remote listener is HTTPS when enabled, else the (then visible) HTTP one.
        host::announce(&local_url, Some(remote_url.unwrap_or(format!("http://localhost:{port}"))).as_deref());
    } else {
        println!("{local_url}");
    }
    let done = shutdown.clone();
    let served = axum::serve(listener, local)
        .with_graceful_shutdown(async move {
            done.cancelled().await;
            // Event streams end, as `closeSseClients` does, so the drain can finish.
            state.events.shutdown.cancel();
        })
        .await;
    shutdown.cancel();
    if let Some(task) = plugins {
        let _ = task.await;
    }
    let remote = match remote {
        Some(task) => task.await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())),
        None => Ok(()),
    };
    host::native_parent::close();
    if !launch.serve {
        served?;
        remote?;
        return Ok(true);
    }
    Ok(served.is_ok() && remote.is_ok())
}
