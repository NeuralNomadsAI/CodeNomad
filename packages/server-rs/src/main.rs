//! CodeNomad backend in Rust: `codenomad-rs <root> <identity.json> <port or 0> <native-binary-label-path>`.
//! Start-up, then every domain's routes behind the loopback password session
//! and, with HTTPS configured, behind the paired-device admission.
mod app;
mod auth;
mod bench;
mod config;
mod events;
mod extensions;
mod files;
mod git;
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

use std::{env, fs, path::Path, sync::Arc};

use axum::{Router, middleware::from_fn, middleware::from_fn_with_state};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use app::{App, Error, Shared, Workspace, error, not_found, now, unavailable};
use shared::{data_owner, panic_guard};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if config::print_version() {
        return Ok(());
    }
    let args: Vec<_> = env::args().skip(1).collect();
    let [root, identity, port, binary] = &args[..] else {
        return Err("usage: codenomad-rs <root> <identity.json> <port or 0> <native-binary-label-path>".into());
    };
    let root = dunce::canonicalize(root)?;
    if !root.is_dir() {
        return Err("Workspace root must be a directory".into());
    }
    if !root.to_str().is_some_and(files::paths::local_absolute) {
        return Err("Workspace root must be a local absolute path".into());
    }
    let native = opencode::Native::connect().await?;
    let listener = TcpListener::bind(("127.0.0.1", port.parse::<u16>()?)).await?;
    let port = listener.local_addr()?.port();
    let identity = Path::new(identity);
    let data = identity.with_extension("data");
    fs::create_dir_all(&data)?;
    data_owner::protect(&data)?;
    git::empty_hooks(&data.join("git-empty-hooks"))?;
    if data_owner::foreign(identity)? {
        return Err("Identity file is owned by another account".into());
    }
    let tls = auth::tls::Listener::open(&data).await?;
    let devices = match &tls {
        Some(tls) => Some(auth::devices::open(&data, tls)?),
        None => None,
    };
    let meta = meta::document(identity, port, &root, tls.as_ref())?;
    let (watch_tx, watch_rx) = tokio::sync::mpsc::channel(512);
    let calendar_profile = missions::calendar::setup(&data)?;
    let auth = auth::Auth::new(&config::server_password()?)?;
    let watches = files::watch::Watches::new(watch_tx);
    let state =
        Arc::new(App::new(auth, port, data, root, meta, native, binary.into(), devices, watches, calendar_profile));

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
        .merge(opencode::routes())
        .fallback(|| async { unavailable() });

    let shutdown = CancellationToken::new();
    service::stop_on_terminate(shutdown.clone());
    bench::stop_on_stdin(shutdown.clone());
    let plugins = extensions::lifecycle::start(&state, shutdown.clone())?;
    missions::serve_bridge(&state, shutdown.clone());
    tokio::spawn(files::watch::run(state.clone(), watch_rx, shutdown.clone()));
    let remote = tls.map(|tls| {
        let remote = routes
            .clone()
            .merge(auth::remote_routes())
            .layer(from_fn(panic_guard::catch))
            .layer(from_fn_with_state(state.clone(), auth::remote::admit))
            .layer(from_fn(bench::refusal_trace))
            .with_state(state.clone());
        println!("HTTPS {}", tls.origin);
        tokio::spawn(auth::devices::sweep(state.clone(), shutdown.clone()));
        tokio::spawn(tls.serve(remote, shutdown.clone()))
    });
    let local = routes
        .merge(auth::local_routes())
        .layer(from_fn(panic_guard::catch))
        .layer(from_fn_with_state(state.clone(), auth::admit))
        .with_state(state.clone());
    tokio::spawn(auth::Auth::sweep(state.clone()));
    tokio::spawn(events::bridge(state));
    println!("http://127.0.0.1:{port}");
    let done = shutdown.clone();
    axum::serve(listener, local).with_graceful_shutdown(async move { done.cancelled().await }).await?;
    shutdown.cancel();
    if let Some(task) = plugins {
        let _ = task.await;
    }
    if let Some(task) = remote {
        task.await??;
    }
    Ok(())
}
