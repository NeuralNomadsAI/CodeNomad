use super::{Backend, Launcher, Project, Reply, State, TextEdit, Tx};
use codenomad_client::{Receiver, bounded};

pub(super) enum RenewOutcome {
    Connected {
        backend: Box<Backend>,
        projects: Option<Vec<Project>>,
        server_id: String,
    },
    Denied,
    Transient,
}

pub(super) enum ProjectsRefresh {
    Loaded(Vec<Project>),
    AuthenticationExpired(Backend),
    Failed,
}

pub(super) struct ManagedRenewal {
    expired: Backend,
    receiver: Receiver<RenewOutcome>,
}

const MAX_ATTEST_ATTEMPTS: usize = 3;
const MAX_RENEWAL_ATTEMPTS: u8 = 2;

pub(super) fn watch_catalogue(l: &mut Launcher) {
    if l.catalogue_watch.is_none()
        && let Some(backend) = &l.connection
    {
        let (watch, task) =
            codenomad_client::stream::CatalogueWatch::new(backend.clone(), l.wake.clone());
        l.catalogue_watch = Some(watch);
        l.workspace_stream_generation = 0;
        l.detached_reconcile = None;
        l.detached_reconcile_trailing = false;
        l.failed_detached_workspaces.clear();
        crate::platform::spawn(task);
    }
}

pub fn connect(s: &mut State, _: &mut Tx) {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return;
    }
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.pending || l.managed_renewal.is_some() {
        return;
    }
    let address = if l.authentication_required {
        let Some(backend) = &l.connection else { return };
        backend.base.clone()
    } else {
        l.host = None;
        l.managed_renewal_failed_for = None;
        l.address.text.clone()
    };
    let password = l.password.text.clone();
    let expected_server = l
        .authentication_required
        .then(|| {
            l.server_id.clone().or_else(|| {
                l.connection
                    .as_ref()
                    .and_then(|backend| backend.client.server_identity().map(str::to_owned))
            })
        })
        .flatten();
    l.job("rune.connect_error", async move {
        let b = Backend::connect(&address, &password).await?;
        let server_id = b.attest_server().await?;
        if expected_server.is_some_and(|expected| expected != server_id) {
            return Err("Server identity changed during authentication".into());
        }
        let projects = b.projects().await?;
        Ok(Reply::Connected(b, projects, server_id))
    });
}

pub(super) fn start_managed_renewal(l: &mut Launcher, expired: &Backend) -> bool {
    if l.managed_renewal
        .as_ref()
        .is_some_and(|r| r.expired.client.same_connection(&expired.client))
    {
        return true;
    }
    if l.managed_renewal_failed_for
        .as_ref()
        .is_some_and(|failed| failed.client.same_connection(&expired.client))
    {
        return false;
    }
    let Some(current) = &l.connection else {
        return false;
    };
    if !current.client.same_connection(&expired.client) {
        return false;
    }
    let Some(host) = &l.host else {
        return false;
    };
    let Some(rx) = host.renew_managed_session() else {
        l.managed_renewal_failed_for = Some(expired.clone());
        return false;
    };
    l.catalogue_watch = None;
    l.workspace_stream_generation = 0;
    l.detached_reconcile = None;
    l.detached_reconcile_trailing = false;
    l.projects_refresh = None;
    let expected_server = l
        .server_id
        .clone()
        .or_else(|| current.client.server_identity().map(str::to_owned));
    let (out, input) = bounded(1);
    let wake = l.wake.clone();
    crate::platform::spawn(async move {
        let outcome = async {
            let backend = match rx.recv().await {
                Ok(crate::platform::ManagedRenewal::Renewed(backend)) => backend,
                Ok(crate::platform::ManagedRenewal::Transient) => return RenewOutcome::Transient,
                Ok(crate::platform::ManagedRenewal::Denied) | Err(_) => {
                    return RenewOutcome::Denied;
                }
            };
            backend.client.require_attestation();
            // Keep the same renewed cookie across bounded attestation retries if /api/meta's
            // response was lost after the server already marked the cookie delivered.
            let mut server_id = None;
            for attempt in 0..MAX_ATTEST_ATTEMPTS {
                match backend.attest_server().await {
                    Ok(id) => {
                        server_id = Some(id);
                        break;
                    }
                    Err(err) if codenomad_client::http::authentication_expired(&err) => {
                        return RenewOutcome::Denied;
                    }
                    Err(_) if attempt + 1 < MAX_ATTEST_ATTEMPTS => {
                        let delay_ms = if attempt == 0 { 150 } else { 400 };
                        crate::platform::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                    Err(_) => return RenewOutcome::Transient,
                }
            }
            let Some(server_id) = server_id else {
                return RenewOutcome::Transient;
            };
            if expected_server.is_some_and(|expected| expected != server_id) {
                return RenewOutcome::Denied;
            }
            // Attestation already marked the renewed cookie delivered on the server;
            // keep it across transient /api/workspaces errors, but reject if revoked (401).
            let projects = match backend.projects().await {
                Ok(projects) => Some(projects),
                Err(err)
                    if codenomad_client::http::authentication_expired(&err)
                        && matches!(backend.authentication_status().await, Ok(false)) =>
                {
                    return RenewOutcome::Denied;
                }
                Err(_) => None,
            };
            RenewOutcome::Connected {
                backend: Box::new(backend),
                projects,
                server_id,
            }
        }
        .await;
        let _ = out.send(outcome).await;
        wake();
    });
    l.managed_renewal = Some(ManagedRenewal {
        expired: expired.clone(),
        receiver: input,
    });
    true
}

pub(super) fn poll_managed_renewal(s: &mut State, selected: Option<String>, tx: &mut Tx) -> bool {
    let outcome = s.screen.launcher_mut().and_then(|l| {
        let result = l.managed_renewal.as_ref()?.receiver.try_recv().ok()?;
        let renewal = l.managed_renewal.take()?;
        Some((renewal.expired, result))
    });
    let Some((expired, result)) = outcome else {
        return false;
    };
    let still_current = s.screen.launcher().is_some_and(|l| {
        l.host.is_some()
            && l.connection
                .as_ref()
                .is_some_and(|c| c.client.same_connection(&expired.client))
    });
    if !still_current {
        return true;
    }
    match result {
        RenewOutcome::Connected {
            backend,
            projects,
            server_id,
        } => {
            if let Some(l) = s.screen.launcher_mut() {
                l.managed_renewal_failed_for = None;
                l.managed_renewal_attempts = 0;
                l.projects_stale = projects.is_none();
                l.error = projects.is_none().then_some("rune.list_error");
            }
            super::apply_connected(s, *backend, projects, server_id, selected, tx);
        }
        RenewOutcome::Transient => {
            let retried = s.screen.launcher_mut().is_some_and(|l| {
                l.managed_renewal_attempts = l.managed_renewal_attempts.saturating_add(1);
                if l.managed_renewal_attempts < MAX_RENEWAL_ATTEMPTS {
                    start_managed_renewal(l, &expired)
                } else {
                    l.managed_renewal_failed_for = Some(expired.clone());
                    false
                }
            });
            if !retried {
                s.phase = crate::Phase::Failed;
                s.show_launcher();
            }
        }
        RenewOutcome::Denied => {
            if let Some(l) = s.screen.launcher_mut() {
                l.managed_renewal_failed_for = Some(expired);
            }
            s.phase = crate::Phase::Failed;
            s.show_launcher();
        }
    }
    true
}

pub fn refresh_projects(s: &mut State) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    start_projects_refresh(l);
}

pub(super) fn start_projects_refresh(l: &mut Launcher) {
    if l.projects_refresh.is_some() || l.authentication_required || l.managed_renewal.is_some() {
        return;
    }
    let Some(backend) = l.connection.clone() else {
        return;
    };
    let generation = l.connection_generation;
    let (out, input) = bounded(1);
    let wake = l.wake.clone();
    l.projects_refresh = Some((generation, input));
    crate::platform::spawn(async move {
        let outcome = match backend.projects().await {
            Ok(projects) => ProjectsRefresh::Loaded(projects),
            Err(err)
                if codenomad_client::http::authentication_expired(&err)
                    && matches!(backend.authentication_status().await, Ok(false)) =>
            {
                ProjectsRefresh::AuthenticationExpired(backend)
            }
            Err(_) => ProjectsRefresh::Failed,
        };
        let _ = out.send(outcome).await;
        wake();
    });
}

pub(super) fn poll_projects_refresh(s: &mut State) -> bool {
    let settled = s.screen.launcher_mut().and_then(|l| {
        let (generation, rx) = l.projects_refresh.as_ref()?;
        let outcome = rx.try_recv().ok()?;
        let generation = *generation;
        l.projects_refresh = None;
        Some((generation, outcome))
    });
    let Some((generation, outcome)) = settled else {
        return false;
    };
    let current_generation = s
        .screen
        .launcher()
        .is_some_and(|l| l.connection_generation == generation);
    if !current_generation {
        return true;
    }
    match outcome {
        ProjectsRefresh::Loaded(projects) => {
            let live_ids: std::collections::HashSet<String> =
                projects.iter().map(|p| p.id.clone()).collect();
            if let Some(l) = s.screen.launcher_mut() {
                l.projects = projects;
                l.projects_stale = false;
                if l.error == Some("rune.list_error") {
                    l.error = None;
                }
            }
            let live: std::collections::HashSet<&str> =
                live_ids.iter().map(String::as_str).collect();
            crate::workspace::stop_unlisted_detached(s, &live);
        }
        ProjectsRefresh::AuthenticationExpired(expired) => {
            let _ = crate::settings::authentication_required(s, &expired);
        }
        ProjectsRefresh::Failed => {
            if let Some(l) = s.screen.launcher_mut() {
                l.projects_stale = true;
                l.error = Some("rune.list_error");
            }
        }
    }
    true
}

pub(super) fn poll_boot(l: &mut Launcher) -> bool {
    let mut boot_changed = false;
    if let Some(result) = l
        .boot
        .as_ref()
        .and_then(|receiver| receiver.try_recv().ok())
    {
        l.boot = None;
        l.pending = false;
        l.rebinding_failed = false;
        l.managed_renewal = None;
        l.managed_renewal_failed_for = None;
        boot_changed = true;
        match result {
            Ok((backend, host)) => {
                l.address = TextEdit::new(&backend.base);
                l.host = Some(host);
                // Bootstrap owns the authenticated cookie jar even if project listing fails.
                backend.client.require_attestation();
                l.connection = Some(backend.clone());
                l.job("rune.list_error", async move {
                    let server_id = backend.attest_server().await?;
                    let projects = backend.projects().await?;
                    Ok(Reply::Connected(backend, projects, server_id))
                });
            }
            Err(_) => l.error = Some("rune.connect_error"),
        }
    }
    boot_changed
}
