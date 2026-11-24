//! CodeNomad server in Rust: `codenomad-rs serve [options]` as Tauri launches the reference,
//! the bench's positional launch, or `codenomad-rs opencode …` (OpenCode installation). Start-up, then every domain's routes behind the loopback
//! password session and, with HTTPS configured, behind the paired-device admission.
mod app;
mod auth;
mod automation;
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
mod previews;
mod provider_usage;
mod search;
mod service;
mod sessions;
mod settings;
mod shared;
mod sidecars;
mod storage;
mod subagent_depth;
mod usage;
mod workspaces;
mod worktrees;

use std::{env, fs, sync::Arc};

use axum::{Router, extract::Request, middleware::from_fn, middleware::from_fn_with_state};
use tokio_util::sync::CancellationToken;

use app::{App, Error, Shared, Workspace, error, not_found, now, unavailable};
use shared::{data_owner, panic_guard};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    automation::diagnostics::install();
    bench::panic_on_start();
    let args: Vec<_> = env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "opencode") {
        std::process::exit(opencode::install::command(&args[1..]).await);
    }
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
    if launch.serve {
        config::set_serve();
    }
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
    if !launch.serve && config::service_record_named() {
        return Err("CNRS_OPENCODE_SERVICE_FILE is not supported: run the install again".into());
    }
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
    let settings = settings::Settings::new(launch.settings);
    let meta = meta::document(settings.server_id()?, port, &root, tls.as_ref(), launch.ui.meta())?;
    let positional = launch.binary.to_string_lossy();
    let binary = if !positional.is_empty() {
        opencode::launch::resolve(&positional)
    } else if let Some(configured) = launch.serve.then(|| opencode::launch::custom_binary(&settings)).flatten() {
        configured
    } else {
        opencode::launch::resolve(&opencode::install::plan::resolve_default().await.0)
    };
    let native = opencode::Native::connect(&binary)?;
    let (watch_tx, watch_rx) = tokio::sync::mpsc::channel(512);
    let calendar_profile = missions::calendar::setup(&data, &settings.location.config)?;
    let watches = files::watch::Watches::new(watch_tx);
    let state = Arc::new(App::new(
        auth,
        port,
        data,
        root,
        launch.unrestricted,
        settings,
        meta,
        native,
        binary.into(),
        devices,
        watches,
        calendar_profile,
    ));

    let shutdown = CancellationToken::new();
    let routes = Router::new()
        .merge(meta::routes())
        .merge(auth::routes())
        .merge(workspaces::routes())
        .merge(files::routes())
        .merge(search::routes())
        .merge(git::routes())
        .merge(worktrees::routes())
        .merge(storage::routes())
        .merge(settings::routes())
        .merge(memory::routes())
        .merge(subagent_depth::routes())
        .merge(sessions::routes(shutdown.clone()))
        .merge(events::routes())
        .merge(extensions::routes())
        .merge(missions::routes())
        .merge(sidecars::routes())
        .merge(usage::routes())
        .merge(provider_usage::routes())
        .merge(previews::routes())
        .merge(opencode::routes())
        .merge(opencode::install::routes());

    service::stop_on_terminate(shutdown.clone());
    // One stdin reader serves the stop command and native responses (also under a bench host).
    if launch.serve || host::native_parent::available() {
        host::read_stdin(shutdown.clone());
    } else {
        bench::stop_on_stdin(shutdown.clone());
    }
    let bridge = automation::publish(&state, shutdown.clone()).await;
    let plugins_stop = CancellationToken::new();
    let plugins = extensions::lifecycle::start(&state, plugins_stop.clone())?;
    tokio::spawn(previews::sweep(state.clone(), shutdown.clone()));
    tokio::spawn(files::watch::run(state.clone(), watch_rx, shutdown.clone()));
    let remote_url = tls.as_ref().map(|tls| tls.origin.clone());
    let remote = tls.map(|tls| {
        let remote = routes
            .clone()
            .merge(auth::remote_routes())
            .fallback(|| async { unavailable() })
            .layer(from_fn(panic_guard::catch))
            .layer(from_fn_with_state((state.clone(), launch.ui.remote_bundle()), auth::remote::admit))
            .layer(from_fn(bench::refusal_trace))
            .with_state(state.clone());
        if !launch.serve {
            println!("HTTPS {}", tls.origin);
        }
        tokio::spawn(auth::devices::sweep(state.clone(), shutdown.clone()));
        tokio::spawn(tls.serve(remote, shutdown.clone()))
    });
    let ui = Arc::new(launch.ui);
    tokio::spawn(sidecars::probe(state.clone()));
    let local = routes
        .merge(auth::local_routes())
        .merge(sidecars::proxy::routes(ui.clone()))
        .fallback({
            let ui = ui.clone();
            let app = state.clone();
            move |req: Request| {
                let (ui, app) = (ui.clone(), app.clone());
                async move {
                    match previews::fallback(&app, req).await {
                        Ok(response) => response,
                        Err(req) => host::ui::serve(&ui, req).await,
                    }
                }
            }
        })
        .layer(from_fn_with_state(state.clone(), auth::admit))
        .layer(from_fn_with_state(state.clone(), previews::admit_local))
        .layer(from_fn(panic_guard::catch))
        .with_state(state.clone());
    tokio::spawn(auth::Auth::sweep(state.clone()));
    tokio::spawn(events::bridge(state.clone()));
    tokio::spawn(meta::releases::run(state.clone(), shutdown.clone()));
    let local_url = format!("http://127.0.0.1:{port}");
    if launch.serve {
        // The remote listener is HTTPS when enabled, else the (then visible) HTTP one.
        host::announce(&local_url, Some(remote_url.unwrap_or(format!("http://localhost:{port}"))).as_deref());
    } else {
        println!("{local_url}");
    }
    let done = shutdown.clone();
    let served = shared::serve_local(listener, local, done, || {
        // Event streams end, as `closeSseClients` does, so the drain can finish.
        state.events.shutdown.cancel();
    })
    .await;
    shutdown.cancel();
    let remote = match remote {
        Some(task) => task.await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())),
        None => Ok(()),
    };
    // Drain local, remote, and automation bridge HTTP listeners before tearing down plugin leases
    // (TS `index.ts:753-767`, `shutdown.ts:130-137`), keeping bridge drain under the 25 s ceiling.
    if let Some(mut task) = bridge
        && tokio::time::timeout(std::time::Duration::from_secs(25), &mut task).await.is_err()
    {
        task.abort();
    }
    plugins_stop.cancel();
    if let Some(task) = plugins {
        let _ = task.await;
    }
    host::native_parent::close();
    if !launch.serve {
        served?;
        remote?;
        return Ok(true);
    }
    Ok(served.is_ok() && remote.is_ok())
}
