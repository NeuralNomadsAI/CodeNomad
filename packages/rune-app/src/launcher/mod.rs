//! One serialized opening action at a time; HTTP never runs on the UI thread.
mod connection;
pub(crate) mod linked;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod managed_renewal_tests;
pub(crate) mod placement;
mod projects;
#[cfg(target_arch = "wasm32")]
mod reopen;
mod search;
mod sessions;
#[cfg(test)]
mod tests;
pub(crate) mod view;
mod visits;
use crate::{
    Phase, State,
    backend::Backend,
    catalog::{Project, Session, Sessions},
    history::Result,
};
use codenomad_client::{Receiver, bounded, runtime::Instant};
pub use connection::{connect, refresh_projects};
pub(crate) use placement::place;
pub(crate) use projects::set_project;
pub use projects::{choose_project, open, open_temporary_folder, restore};
#[cfg(target_arch = "wasm32")]
pub(crate) use reopen::reopen;
use rune::{Tx, edit::TextEdit};
#[cfg(target_arch = "wasm32")]
use sessions::attach;
#[cfg(feature = "test-support")]
pub use sessions::back;
use sessions::{bind, dismiss_origin_panel, retire_session, retry_mission_conversation};
pub(crate) use sessions::{
    bind_search, can_rebind_session, choose_child_ticket, choose_destination,
    choose_mission_conversation,
};
pub use sessions::{
    can_change_session, can_open_child_session, can_visit, choose, close_session, create,
    create_blank, list, visit,
};
use std::{collections::HashSet, future::Future};
pub(crate) use visits::Visits;

pub struct Launcher {
    pub address: TextEdit,
    pub password: TextEdit,
    pub folder: TextEdit,
    pub title: TextEdit,
    pub search: TextEdit,
    pub(crate) search_results: search::Search,
    pub show_title: bool,
    pub show_search: bool,
    pub visits: Visits,
    pub connection: Option<Backend>,
    pub(crate) authentication_required: bool,
    pub(crate) catalogue_watch: Option<codenomad_client::stream::CatalogueWatch>,
    pub(crate) catalogue_generation: u64,
    pub(crate) workspace_stream_generation: u64,
    pub server_id: Option<String>,
    pub projects: Vec<Project>,
    pub project: Option<Project>,
    pub sessions: Vec<Session>,
    pub listed_sessions: HashSet<String>,
    pub next: Option<String>,
    pub(crate) linked: linked::Linked,
    pub(crate) consumed_cursors: HashSet<u64>,
    pub pending: bool,
    listing: bool,
    pub error: Option<&'static str>,
    pub creation_uncertain: bool,
    pub creation_uncertain_linked: Option<String>,
    pub openings: crate::workspace::opening::Openings,
    result: Option<Receiver<Result<Reply>>>,
    pending_stream_generation: u64,
    stopped_during_pending: std::collections::HashMap<String, (bool, bool)>,
    stopped_during_pending_overflow: bool,
    pub(super) pending_temporary_cleanup: Option<(Backend, String, Option<String>)>,
    pub(crate) pending_restore_intent: Option<String>,
    detached_reconcile: Option<(u64, HashSet<String>, Receiver<Option<Vec<Project>>>)>,
    detached_reconcile_trailing: bool,
    failed_detached_workspaces: HashSet<String>,
    pub(crate) rebind_after_send: Option<String>,
    resume_after_job: bool,
    connection_generation: u64,
    pending_connection_generation: u64,
    selection_ticket: Option<u64>,
    close_mission_reader_on_bind: bool,
    rebinding_failed: bool,
    boot: Option<Receiver<Result<(Backend, crate::platform::LocalHost)>>>,
    host: Option<crate::platform::LocalHost>,
    managed_renewal: Option<connection::ManagedRenewal>,
    managed_renewal_failed_for: Option<Backend>,
    managed_renewal_attempts: u8,
    pub(crate) projects_stale: bool,
    projects_refresh: Option<(u64, Receiver<connection::ProjectsRefresh>)>,
    wake: rune::Waker,
}
enum Reply {
    Connected(Backend, Vec<Project>, String),
    AuthenticationExpired(Backend),
    Opened(crate::workspace::opening::Opening, Sessions, Restored),
    Listed(Sessions, Option<String>),
    Created(Backend, String, String, String, Option<u64>, Option<u64>),
    CreatedUnbound(Session, String),
    CreatePrecheckFailed,
    CreateRejected,
    CreateUncertainLinked(String),
    Selected(Vec<String>, Option<Selection>, Option<u64>, bool),
    #[cfg(target_arch = "wasm32")]
    Reopened(crate::workspace::opening::Opening, Backend, String, String),
    Placed(Backend, String, String, bool, bool),
    PlacementUnconfirmed(crate::git::PlacementHold),
    PlacementReconciled(Backend, String, String, crate::git::PlacementHold),
}
type Selection = (Backend, String, Option<usize>, Instant, String);
enum Restored {
    Empty,
    Bound(Backend, String, String),
    Missing(String),
}
impl Launcher {
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn fixture() -> Self {
        Self::with_boot(std::sync::Arc::new(|| {}), None)
    }
    pub fn blocks_prompt(&self) -> bool {
        self.pending && !self.listing
    }
    pub(crate) fn is_listing(&self) -> bool {
        self.listing
    }
    pub(crate) fn connection_generation(&self) -> u64 {
        self.connection_generation
    }
}

pub(crate) fn cancel_pending_restore(s: &mut State) -> bool {
    let intent = s
        .workspace
        .as_ref()
        .map(|ui| ui.active_key().to_owned())
        .unwrap_or_else(|| "launcher".into());
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    if !l.pending || l.pending_restore_intent.as_deref() != Some(intent.as_str()) {
        return false;
    }
    l.openings.revoke_intent(&intent);
    l.result = None;
    l.pending = false;
    l.listing = false;
    l.pending_restore_intent = None;
    l.selection_ticket = None;
    l.resume_after_job = false;
    l.stopped_during_pending.clear();
    l.stopped_during_pending_overflow = false;
    true
}

impl Launcher {
    #[cfg(test)]
    pub(crate) fn workspace_stream_online(&self) -> bool {
        self.detached_reconcile.is_none()
            && self.failed_detached_workspaces.is_empty()
            && (self.catalogue_watch.is_none()
                || self.workspace_stream_generation == 0
                || self.workspace_stream_generation % 2 == 1)
    }
    pub(crate) fn workspace_stream_online_for(&self, workspace_id: &str) -> bool {
        self.detached_reconcile.is_none()
            && !self.failed_detached_workspaces.contains(workspace_id)
            && (self.catalogue_watch.is_none()
                || self.workspace_stream_generation == 0
                || self.workspace_stream_generation % 2 == 1)
    }
    pub fn local_connection(&self) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.host.is_some()
        }
        #[cfg(target_arch = "wasm32")]
        {
            false
        }
    }
    pub fn state_directory(&self) -> Option<std::path::PathBuf> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.host.as_ref().and_then(|h| h.state_directory())
        }
        #[cfg(target_arch = "wasm32")]
        {
            None
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub fn has_owned_server(&self) -> bool {
        self.host.is_some()
    }
    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(crate) fn set_fixture_host(&mut self, host: crate::platform::LocalHost) {
        self.host = Some(host);
    }
    pub fn new(wake: rune::Waker) -> Self {
        let boot = if crate::platform::setting("RUNE_BACKEND").is_none() {
            crate::platform::start_local(wake.clone())
        } else {
            None
        };
        Self::with_boot(wake, boot)
    }
    fn with_boot(
        wake: rune::Waker,
        boot: Option<Receiver<Result<(Backend, crate::platform::LocalHost)>>>,
    ) -> Self {
        let starting = boot.is_some();
        Self {
            address: TextEdit::new(crate::platform::default_backend()),
            password: TextEdit::new(crate::platform::setting("RUNE_PASSWORD").unwrap_or_default()),
            folder: TextEdit::new(""),
            title: TextEdit::new(""),
            search: TextEdit::new(""),
            search_results: Default::default(),
            show_title: false,
            show_search: false,
            visits: Visits::default(),
            connection: None,
            authentication_required: false,
            catalogue_watch: None,
            catalogue_generation: 0,
            workspace_stream_generation: 0,
            server_id: None,
            projects: vec![],
            project: None,
            sessions: vec![],
            listed_sessions: HashSet::new(),
            next: None,
            linked: Default::default(),
            consumed_cursors: HashSet::new(),
            pending: starting,
            listing: false,
            error: None,
            creation_uncertain: false,
            creation_uncertain_linked: None,
            openings: Default::default(),
            result: None,
            pending_stream_generation: 0,
            stopped_during_pending: std::collections::HashMap::new(),
            stopped_during_pending_overflow: false,
            pending_temporary_cleanup: None,
            pending_restore_intent: None,
            detached_reconcile: None,
            detached_reconcile_trailing: false,
            failed_detached_workspaces: HashSet::new(),
            rebind_after_send: None,
            resume_after_job: false,
            connection_generation: 0,
            pending_connection_generation: 0,
            selection_ticket: None,
            close_mission_reader_on_bind: false,
            rebinding_failed: false,
            boot,
            host: None,
            managed_renewal: None,
            managed_renewal_failed_for: None,
            managed_renewal_attempts: 0,
            projects_stale: false,
            projects_refresh: None,
            wake,
        }
    }
    pub(crate) fn renewing_managed_session(&self) -> bool {
        self.managed_renewal.is_some()
    }
    pub(crate) fn start_managed_renewal(&mut self, expired: &Backend) -> bool {
        connection::start_managed_renewal(self, expired)
    }
    fn job(
        &mut self,
        error: &'static str,
        f: impl Future<Output = Result<Reply>> + crate::platform::TaskBound + 'static,
    ) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.pending_restore_intent = None;
        self.pending_connection_generation = self.connection_generation;
        self.pending_stream_generation = self.workspace_stream_generation;
        self.stopped_during_pending.clear();
        self.stopped_during_pending_overflow = false;
        self.catalogue_generation = self.catalogue_generation.wrapping_add(1);
        self.error = None;
        let origin = (error != "rune.connect_error")
            .then(|| self.connection.clone())
            .flatten();
        let (out, input) = bounded(1);
        self.result = Some(input);
        let wake = self.wake.clone();
        crate::platform::spawn(async move {
            // Only the operation label reaches the UI; responses and credentials stay private.
            let result = match f.await {
                Ok(reply) => Ok(reply),
                Err(err)
                    if codenomad_client::http::authentication_expired(&err)
                        && let Some(origin) = origin =>
                {
                    if matches!(origin.authentication_status().await, Ok(false)) {
                        Ok(Reply::AuthenticationExpired(origin))
                    } else {
                        Err(error.into())
                    }
                }
                Err(_) => Err(error.into()),
            };
            let _ = out.send(result).await;
            wake();
        });
    }
}

const MAX_RECONCILE_ATTEMPTS: usize = 5;

fn spawn_detached_reconcile(l: &mut Launcher, generation: u64) {
    spawn_detached_reconcile_with(l, generation, HashSet::new());
}

fn spawn_detached_reconcile_with(l: &mut Launcher, generation: u64, opened_after: HashSet<String>) {
    let Some(backend) = l.connection.clone() else {
        return;
    };
    let (out, input) = bounded(1);
    l.detached_reconcile = Some((generation, opened_after, input));
    l.detached_reconcile_trailing = false;
    l.failed_detached_workspaces.clear();
    let wake = l.wake.clone();
    crate::platform::spawn(async move {
        let mut delay_ms = 1_000u64;
        for attempt in 0..MAX_RECONCILE_ATTEMPTS {
            match codenomad_client::runtime::until_closed(&out, backend.projects()).await {
                None => return,
                Some(Ok(projects)) => {
                    let _ = out.send(Some(projects)).await;
                    wake();
                    return;
                }
                Some(Err(_)) => {
                    if attempt + 1 == MAX_RECONCILE_ATTEMPTS {
                        let _ = out.send(None).await;
                        wake();
                        return;
                    }
                    if codenomad_client::runtime::until_closed(
                        &out,
                        crate::platform::sleep(std::time::Duration::from_millis(delay_ms)),
                    )
                    .await
                    .is_none()
                    {
                        return;
                    }
                    delay_ms = (delay_ms * 2).min(8_000);
                }
            }
        }
    });
}

pub(crate) fn can_retry_detached_workspace(s: &State, workspace_id: &str) -> bool {
    crate::workspace::has_detached_panels(s)
        && s.screen.launcher().is_some_and(|l| {
            l.failed_detached_workspaces.contains(workspace_id)
                && l.detached_reconcile.is_none()
                && !l.authentication_required
                && l.workspace_stream_generation % 2 == 1
        })
}

pub(crate) fn retry_detached_reconcile(s: &mut State) {
    if !crate::workspace::has_detached_panels(s) {
        return;
    }
    if let Some(l) = s.screen.launcher_mut()
        && !l.failed_detached_workspaces.is_empty()
        && l.detached_reconcile.is_none()
        && !l.authentication_required
        && l.workspace_stream_generation % 2 == 1
    {
        let generation = l.workspace_stream_generation;
        spawn_detached_reconcile(l, generation);
    }
}

pub(crate) fn session_loaded(s: &State) -> bool {
    s.files.is_some()
        || s.agent.is_some()
        || s.commands.is_some()
        || s.incoming.is_some()
        || s.composer.pending()
        || s.status_permissions.writing()
}

pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let browser_changed = cfg!(target_arch = "wasm32") && (search::poll(s) | linked::poll(s));
    let selected = crate::workspace::active_session(s).map(str::to_owned);
    let stream_update = s.screen.launcher_mut().and_then(|l| {
        let watch = l.catalogue_watch.as_ref()?;
        let unauthorized = watch.take_authentication_required();
        let disconnected = watch.take_disconnect();
        let (generation, overflow, events) = watch.take_workspace_events();
        let temporary_folders = watch.take_temporary_folders();
        let previous = l.workspace_stream_generation;
        l.workspace_stream_generation = generation;
        let expired = unauthorized.then(|| l.connection.clone()).flatten();
        Some((
            previous,
            generation,
            overflow,
            disconnected,
            events,
            temporary_folders,
            expired,
        ))
    });
    let mut relayed = false;
    if let Some((
        previous,
        generation,
        overflow,
        disconnected,
        events,
        temporary_folders,
        expired,
    )) = stream_update
    {
        let mut stopped = Vec::new();
        let mut stopped_ids = HashSet::new();
        let mut other = Vec::new();
        for event in events {
            if let codenomad_client::transport::WorkspaceEvent::Stopped { workspace_id, .. } =
                &event
            {
                stopped_ids.insert(workspace_id.clone());
                stopped.push(event);
            } else {
                other.push(event);
            }
        }
        if !stopped_ids.is_empty() {
            other.retain(|event| {
                crate::workspace::event_workspace_id(event)
                    .is_none_or(|id| !stopped_ids.contains(id))
            });
        }
        if overflow
            && let Some(l) = s.screen.launcher_mut()
            && l.pending
        {
            l.stopped_during_pending_overflow = true;
        }
        if !stopped.is_empty() {
            if let Some(l) = s.screen.launcher_mut() {
                for event in &stopped {
                    if let codenomad_client::transport::WorkspaceEvent::Stopped {
                        workspace_id,
                        deleted,
                        temporary_retained,
                    } = event
                    {
                        if l.pending {
                            if l.stopped_during_pending.len() < 128
                                || l.stopped_during_pending.contains_key(workspace_id)
                            {
                                l.stopped_during_pending
                                    .insert(workspace_id.clone(), (*deleted, *temporary_retained));
                            } else {
                                l.stopped_during_pending_overflow = true;
                            }
                        }
                        if let Some((_, opened_after, _)) = &mut l.detached_reconcile {
                            opened_after.remove(workspace_id);
                        }
                    }
                }
            }
            for event in &stopped {
                if let codenomad_client::transport::WorkspaceEvent::Stopped {
                    workspace_id,
                    deleted,
                    temporary_retained,
                } = event
                {
                    relayed |= crate::workspace::detach_stopped_temporary(
                        s,
                        workspace_id,
                        *deleted,
                        *temporary_retained,
                        tx,
                    );
                }
            }
            relayed |= crate::workspace::deliver_detached_events(s, &stopped);
        }
        if let Some(folders) = temporary_folders {
            crate::shell::temporary::bump_reconcile_epoch(s);
            relayed |= crate::workspace::reconcile_temporary_folders(s, &folders);
        }
        #[cfg(target_arch = "wasm32")]
        if disconnected && !crate::platform::pairing::required(s) {
            crate::platform::pairing::observe(s);
        }
        #[cfg(not(target_arch = "wasm32"))]
        let _ = disconnected;
        let mut start_reconcile = None;
        let mut overflow_reconcile = false;
        let mut reconcile_temporary = false;
        if generation != previous {
            if generation > 0 && generation % 2 == 0 {
                if let Some(l) = s.screen.launcher_mut() {
                    l.detached_reconcile = None;
                    l.detached_reconcile_trailing = false;
                    l.failed_detached_workspaces.clear();
                }
                relayed |= crate::workspace::set_detached_online(s, false);
            } else if generation % 2 == 1 {
                reconcile_temporary = true;
                #[cfg(target_arch = "wasm32")]
                crate::platform::pairing::observe_launcher_authenticated(s, generation);
                relayed |= crate::workspace::set_detached_online(s, false);
                if crate::workspace::has_detached_panels(s) {
                    start_reconcile = Some(generation);
                }
            }
        } else if overflow && generation % 2 == 1 {
            reconcile_temporary = true;
            relayed |= crate::workspace::set_detached_online(s, false);
            if crate::workspace::has_detached_panels(s) {
                start_reconcile = Some(generation);
                overflow_reconcile = true;
            }
        }
        if reconcile_temporary {
            crate::shell::temporary::trigger_reconnect_reconcile(s);
        }
        if let Some(reconcile_generation) = start_reconcile
            && crate::workspace::has_detached_panels(s)
            && let Some(l) = s.screen.launcher_mut()
            && !l.authentication_required
        {
            if overflow_reconcile
                && l.detached_reconcile
                    .as_ref()
                    .is_some_and(|(active_gen, _, _)| *active_gen == reconcile_generation)
            {
                l.detached_reconcile_trailing = true;
            } else {
                spawn_detached_reconcile(l, reconcile_generation);
            }
        }
        if !other.is_empty() {
            relayed |= crate::workspace::deliver_detached_events(s, &other);
        }
        if let Some(expired) = expired {
            relayed |= crate::settings::authentication_required(s, &expired);
        }
    }
    let cancel_reconcile = s.screen.launcher().and_then(|l| {
        let (_, opened_after, _) = l.detached_reconcile.as_ref()?;
        if l.authentication_required {
            Some(false)
        } else if !l.detached_reconcile_trailing
            && !crate::workspace::has_unopened_detached_panels(s, opened_after)
        {
            Some(!opened_after.is_empty())
        } else {
            None
        }
    });
    if let Some(bring_opened_online) = cancel_reconcile {
        if let Some(l) = s.screen.launcher_mut() {
            l.detached_reconcile = None;
            l.detached_reconcile_trailing = false;
        }
        if bring_opened_online {
            relayed |= crate::workspace::set_detached_online(s, true);
        }
    }
    let reconciled = s.screen.launcher_mut().and_then(|l| {
        let (reconcile_generation, _, rx) = l.detached_reconcile.as_ref()?;
        let result = rx.try_recv().ok()?;
        let current = l.workspace_stream_generation;
        let reconcile_generation = *reconcile_generation;
        let trailing = std::mem::take(&mut l.detached_reconcile_trailing);
        let opened_after = l
            .detached_reconcile
            .take()
            .map(|(_, opened_after, _)| opened_after)?;
        (reconcile_generation == current).then_some((current, trailing, opened_after, result))
    });
    if let Some((current, trailing, opened_after, result)) = reconciled {
        if trailing {
            if let Some(projects) = &result {
                let mut live: HashSet<&str> = projects.iter().map(|p| p.id.as_str()).collect();
                for id in &opened_after {
                    live.insert(id.as_str());
                }
                relayed |= crate::workspace::stop_unlisted_detached(s, &live);
            }
            if crate::workspace::has_detached_panels(s)
                && let Some(l) = s.screen.launcher_mut()
                && !l.authentication_required
            {
                spawn_detached_reconcile(l, current);
            }
        } else {
            match result {
                Some(projects) => {
                    let live: HashSet<&str> = projects.iter().map(|p| p.id.as_str()).collect();
                    relayed |=
                        crate::workspace::reconcile_detached_online(s, &opened_after, Some(&live));
                }
                None => {
                    let failed: HashSet<String> = crate::workspace::detached_workspace_ids(s)
                        .into_iter()
                        .filter(|id| !opened_after.contains(id))
                        .collect();
                    if let Some(l) = s.screen.launcher_mut() {
                        l.failed_detached_workspaces.extend(failed);
                    }
                    if !opened_after.is_empty() {
                        relayed |=
                            crate::workspace::reconcile_detached_online(s, &opened_after, None);
                    }
                }
            }
        }
    }
    if s.screen
        .launcher()
        .is_some_and(|l| !l.failed_detached_workspaces.is_empty())
    {
        let active_detached = crate::workspace::detached_workspace_ids(s);
        if let Some(l) = s.screen.launcher_mut() {
            l.failed_detached_workspaces
                .retain(|id| active_detached.contains(id));
        }
    }
    let loaded = session_loaded(s);
    let deferred_rebind = s.screen.launcher().and_then(|l| {
        let id = l.rebind_after_send.as_ref()?;
        if l.authentication_required
            || (loaded && s.screen.is_launcher())
            || crate::workspace::active_session(s) != Some(id.as_str())
        {
            return Some(None);
        }
        if !s.composer.pending() && !l.pending && !s.status_permissions.writing() {
            return Some(Some(id.clone()));
        }
        None
    });
    if let Some(action) = deferred_rebind {
        if let Some(l) = s.screen.launcher_mut() {
            l.rebind_after_send = None;
        }
        if let Some(id) = action {
            s.incoming = None;
            if loaded {
                s.phase = Phase::Failed;
            }
            choose_destination(s, id, None, tx);
            relayed = true;
        }
    }
    if connection::poll_managed_renewal(s, selected.clone(), tx) {
        tx.instant();
        return true;
    }
    if connection::poll_projects_refresh(s) {
        relayed = true;
    }
    let blocked = !can_change_session(s)
        || s.screen
            .launcher()
            .is_some_and(|l| l.authentication_required);
    let child_blocked = !can_open_child_session(s)
        || s.screen
            .launcher()
            .is_some_and(|l| l.authentication_required);
    #[cfg(target_arch = "wasm32")]
    let pairing_required = crate::platform::pairing::required(s);
    let Some(l) = s.screen.launcher_mut() else {
        return relayed;
    };
    let mut changed = relayed | browser_changed | (!l.pending && l.visits.poll_checks());
    changed |= connection::poll_boot(l);
    let Some(result) = l.result.as_ref().and_then(|rx| rx.try_recv().ok()) else {
        if changed {
            tx.instant();
        }
        return changed;
    };
    l.result = None;
    l.pending = false;
    l.listing = false;
    l.pending_restore_intent = None;
    let temporary_cleanup = l.pending_temporary_cleanup.take();
    let stale_connection = l.pending_connection_generation != l.connection_generation;
    let pending_stream_generation = l.pending_stream_generation;
    let stopped_during_pending = std::mem::take(&mut l.stopped_during_pending);
    let stopped_during_pending_overflow = std::mem::take(&mut l.stopped_during_pending_overflow);
    let close_mission_reader = std::mem::take(&mut l.close_mission_reader_on_bind);
    let rebinding_failed = std::mem::take(&mut l.rebinding_failed);
    if l.selection_ticket
        .take()
        .is_some_and(|ticket| ticket != s.notifications.navigation_ticket())
    {
        if rebinding_failed && s.phase == Phase::Reconnecting {
            s.phase = Phase::Failed;
        }
        if std::mem::take(&mut l.resume_after_job)
            && !l.authentication_required
            && l.project.is_none()
        {
            crate::workspace::resume(s, tx);
        }
        if let Some((backend, path, req_id)) = temporary_cleanup {
            crate::shell::temporary::queue_abandon(s, backend, path, req_id);
        }
        tx.instant();
        return true;
    }
    match result {
        Ok(Reply::Connected(b, projects, server_id)) => {
            if !stale_connection {
                apply_connected(s, b, Some(projects), server_id, selected, tx);
            }
        }
        Ok(Reply::AuthenticationExpired(expired)) => {
            if rebinding_failed && s.phase == Phase::Reconnecting {
                s.phase = Phase::Failed;
            }
            crate::settings::authentication_required(s, &expired);
        }
        Ok(Reply::Opened(opening, rows, restored)) => {
            let project = opening.project.clone();
            if stale_connection && temporary_cleanup.is_some() {
                drop(opening);
                if let Some((backend, path, req_id)) = temporary_cleanup {
                    crate::shell::temporary::queue_abandon(s, backend, path, req_id);
                }
                tx.instant();
                return true;
            }
            if opening.adopt().is_err() {
                l.error = Some("rune.open_error");
                if let Some((backend, path, req_id)) = temporary_cleanup {
                    crate::shell::temporary::queue_abandon(s, backend, path, req_id);
                }
                tx.instant();
                return true;
            }
            l.folder = TextEdit::new(&project.path);
            set_project(l, Some(project.clone()));
            l.linked = Default::default();
            l.creation_uncertain = false;
            l.creation_uncertain_linked = None;
            l.rebind_after_send = None;
            l.failed_detached_workspaces.remove(&project.id);
            let stopped_meta = stopped_during_pending.get(&project.id).copied();
            let stopped_in_flight = stopped_meta.is_some();
            let current_stream_generation = l.workspace_stream_generation;
            let needs_reconcile = !stopped_in_flight
                && (stopped_during_pending_overflow
                    || (current_stream_generation % 2 == 1
                        && pending_stream_generation != current_stream_generation));
            if !stopped_in_flight {
                if !stopped_during_pending_overflow
                    && let Some((reconcile_generation, opened_after, _)) = &mut l.detached_reconcile
                    && pending_stream_generation == *reconcile_generation
                {
                    opened_after.insert(project.id.clone());
                } else if !l.authentication_required
                    && let Some((reconcile_generation, mut opened_after, _)) =
                        l.detached_reconcile.take()
                {
                    opened_after.remove(&project.id);
                    spawn_detached_reconcile_with(l, reconcile_generation, opened_after);
                }
            }
            connection::watch_catalogue(l);
            l.apply_listing(rows, false, None);
            l.search = TextEdit::new("");
            let auth_required = l.authentication_required;
            crate::workspace::opened(s, &project);
            match restored {
                Restored::Bound(backend, title, slug) if !auth_required && !stopped_in_flight => {
                    if stale_connection {
                        choose_destination(s, backend.session, None, tx);
                    } else {
                        bind(s, backend, title, None, &slug, tx);
                    }
                }
                Restored::Bound(_, _, _) if stopped_in_flight => {
                    crate::git::project_opened(s);
                    crate::workspace::restore_files_mode(s);
                }
                Restored::Bound(_, _, _) => {}
                Restored::Missing(id) => {
                    retire_session(s, &id);
                    crate::git::project_opened(s);
                    crate::workspace::restore_files_mode(s);
                }
                Restored::Empty => {
                    crate::git::project_opened(s);
                    crate::workspace::restore_files_mode(s);
                }
            }
            if let Some((deleted, temporary_retained)) = stopped_meta {
                let _ = crate::workspace::detach_stopped_temporary(
                    s,
                    &project.id,
                    deleted,
                    temporary_retained,
                    tx,
                );
                crate::workspace::deliver_detached_events(
                    s,
                    &[codenomad_client::transport::WorkspaceEvent::Stopped {
                        workspace_id: project.id,
                        deleted,
                        temporary_retained,
                    }],
                );
            } else if needs_reconcile
                && !auth_required
                && current_stream_generation % 2 == 1
                && crate::workspace::has_detached_panels(s)
                && s.screen
                    .launcher()
                    .is_some_and(|l| l.detached_reconcile.is_none())
            {
                let _ = crate::workspace::set_detached_online(s, false);
                if let Some(l) = s.screen.launcher_mut() {
                    spawn_detached_reconcile(l, current_stream_generation);
                }
            }
            #[cfg(target_arch = "wasm32")]
            linked::load(s);
        }
        Ok(Reply::Listed(rows, cursor)) => {
            if let Some(cursor) = cursor {
                l.consume_cursor(&cursor);
                l.apply_listing(rows, true, selected.as_deref());
                if l.next.is_none() {
                    l.check_omitted_visits();
                }
            } else if cfg!(target_os = "windows")
                || l.creation_uncertain_linked.is_some() && cfg!(not(target_arch = "wasm32"))
            {
                l.apply_directory_refresh(rows, selected.as_deref());
                crate::workspace::schedule_catalogue(s);
            } else {
                l.apply_listing(rows, false, selected.as_deref());
                if l.next.is_none() {
                    l.check_omitted_visits();
                }
                #[cfg(target_arch = "wasm32")]
                linked::load(s);
            }
        }
        Ok(Reply::Created(b, title, slug, submitted, dismiss, ticket)) => {
            if !submitted.is_empty() && l.title.text == submitted {
                l.title = TextEdit::new("");
                l.show_title = false;
            }
            let superseded = ticket.is_some_and(|t| t != s.notifications.navigation_ticket());
            let stopped_in_flight = stopped_during_pending_overflow
                || stopped_during_pending.contains_key(&b.workspace);
            if blocked || superseded || l.authentication_required || stopped_in_flight {
                if !stopped_in_flight {
                    l.sessions.insert(
                        0,
                        Session {
                            id: b.session,
                            title,
                        },
                    );
                }
            } else if stale_connection {
                let session_id = b.session;
                if !l.sessions.iter().any(|row| row.id == session_id) {
                    l.sessions.insert(
                        0,
                        Session {
                            id: session_id.clone(),
                            title,
                        },
                    );
                }
                l.rebind_after_send = None;
                dismiss_origin_panel(s, dismiss, tx);
                choose_destination(s, session_id, ticket, tx);
            } else {
                dismiss_origin_panel(s, dismiss, tx);
                bind(s, b, title, None, &slug, tx);
            }
        }
        Ok(Reply::CreatedUnbound(session, submitted)) => {
            if !submitted.is_empty() && l.title.text == submitted {
                l.title = TextEdit::new("");
                l.show_title = false;
            }
            let stopped_in_flight = stopped_during_pending_overflow
                || l.project
                    .as_ref()
                    .is_some_and(|p| stopped_during_pending.contains_key(&p.id));
            if !stopped_in_flight && !l.sessions.iter().any(|row| row.id == session.id) {
                l.sessions.insert(0, session);
            }
            l.error = Some("sessionList.reload.error");
            crate::shell::notifications::emit_outcome(
                s,
                crate::shell::notifications::Category::Sessions,
                None,
                crate::strings::t("sessionList.reload.error"),
                true,
            );
        }
        Ok(Reply::CreatePrecheckFailed) => {
            l.error = Some("sessionList.reload.error");
            crate::shell::notifications::emit_outcome(
                s,
                crate::shell::notifications::Category::Sessions,
                None,
                crate::strings::t("sessionList.reload.error"),
                true,
            );
        }
        Ok(Reply::CreateRejected) => {
            l.error = Some("rune.create_error");
            crate::shell::notifications::emit_outcome(
                s,
                crate::shell::notifications::Category::Sessions,
                None,
                crate::strings::t("rune.create_error"),
                true,
            );
        }
        Ok(Reply::CreateUncertainLinked(directory)) => {
            l.creation_uncertain = true;
            l.creation_uncertain_linked = Some(directory);
            l.linked.mark_reload();
            l.error = Some("rune.create_error");
            crate::shell::notifications::emit_outcome(
                s,
                crate::shell::notifications::Category::Sessions,
                None,
                crate::strings::t("rune.create_error"),
                true,
            );
        }
        Ok(Reply::Selected(missing, selection, dismiss, allow_streaming)) => {
            let selection_blocked = if allow_streaming {
                child_blocked
            } else {
                blocked
            };
            l.sessions.retain(|row| !missing.contains(&row.id));
            l.linked.rows.retain(|row| !missing.contains(&row.id));
            if let Some(pages) = &mut l.linked.pages {
                pages.rows.retain(|row| !missing.contains(&row.id));
            }
            l.search_results
                .rows
                .retain(|row| !missing.contains(&row.id));
            l.listed_sessions.retain(|id| !missing.contains(id));
            l.visits.forget(&missing);
            if let Some((backend, _, _, verified, _)) = &selection {
                l.visits.verified(&backend.session, *verified);
            }
            if let Some(id) = selected.as_deref().filter(|id| {
                (s.phase == Phase::Failed || rebinding_failed) && missing.iter().any(|m| m == id)
            }) {
                retire_session(s, id);
                tx.instant();
                return true;
            }
            let auth_required = l.authentication_required;
            #[cfg(target_arch = "wasm32")]
            let auth_required = auth_required || pairing_required;
            if let Some((b, title, visit, _, slug)) = selection.filter(|(b, _, _, _, _)| {
                !auth_required
                    && !stopped_during_pending_overflow
                    && !stopped_during_pending.contains_key(&b.workspace)
                    && (!selection_blocked
                        || (s.phase == Phase::Failed || rebinding_failed)
                            && selected.as_deref() == Some(b.session.as_str()))
            }) {
                l.show_title = false;
                if stale_connection {
                    if rebinding_failed && s.phase == Phase::Reconnecting {
                        s.phase = Phase::Failed;
                    }
                    dismiss_origin_panel(s, dismiss, tx);
                    if close_mission_reader {
                        retry_mission_conversation(s, b.session);
                    } else {
                        choose_destination(s, b.session, None, tx);
                    }
                } else {
                    dismiss_origin_panel(s, dismiss, tx);
                    if close_mission_reader {
                        crate::workspace::close_mission_reader(s);
                    }
                    bind(s, b, title, visit, &slug, tx);
                }
            } else {
                if rebinding_failed && s.phase == Phase::Reconnecting {
                    s.phase = Phase::Failed;
                }
                if !selection_blocked {
                    l.error = Some("sessionList.reload.error");
                    crate::shell::notifications::emit_outcome(
                        s,
                        crate::shell::notifications::Category::Sessions,
                        None,
                        crate::strings::t("sessionList.reload.error"),
                        true,
                    );
                }
            }
        }
        #[cfg(target_arch = "wasm32")]
        Ok(Reply::Reopened(opening, backend, title, slug)) => {
            if !l.authentication_required && !pairing_required && !stale_connection {
                let id = opening.project.id.clone();
                l.failed_detached_workspaces.remove(&id);
                let stopped_in_flight = stopped_during_pending.contains_key(&id);
                let current_stream_generation = l.workspace_stream_generation;
                let needs_reconcile = !stopped_in_flight
                    && (stopped_during_pending_overflow
                        || (current_stream_generation % 2 == 1
                            && pending_stream_generation != current_stream_generation));
                if !stopped_in_flight {
                    if !stopped_during_pending_overflow
                        && let Some((reconcile_generation, opened_after, _)) =
                            &mut l.detached_reconcile
                        && pending_stream_generation == *reconcile_generation
                    {
                        opened_after.insert(id.clone());
                    } else if let Some((reconcile_generation, mut opened_after, _)) =
                        l.detached_reconcile.take()
                    {
                        opened_after.remove(&id);
                        spawn_detached_reconcile_with(l, reconcile_generation, opened_after);
                    }
                }
                if !stopped_in_flight {
                    reopen::apply(s, opening, backend, title, &slug);
                } else {
                    s.phase = Phase::RestoreFailed;
                    if let Some(agent) = s.agent.as_mut() {
                        agent.mark_scope_missing();
                    }
                }
                if stopped_in_flight {
                    crate::workspace::deliver_detached_events(
                        s,
                        &[codenomad_client::transport::WorkspaceEvent::Stopped {
                            workspace_id: id,
                            deleted: false,
                            temporary_retained: false,
                        }],
                    );
                } else if needs_reconcile
                    && current_stream_generation % 2 == 1
                    && crate::workspace::has_detached_panels(s)
                    && s.screen
                        .launcher()
                        .is_some_and(|l| l.detached_reconcile.is_none())
                {
                    let _ = crate::workspace::set_detached_online(s, false);
                    if let Some(l) = s.screen.launcher_mut() {
                        spawn_detached_reconcile(l, current_stream_generation);
                    }
                }
            } else if pairing_required && !stale_connection {
                s.phase = Phase::WorkspaceMissing;
            }
        }
        Ok(Reply::Placed(backend, title, slug, confirmed, attempted)) => {
            if selected.as_deref() == Some(backend.session.as_str()) {
                let auth_required = l.authentication_required;
                l.error = (!confirmed).then_some("sessionList.worktreeMove.error");
                crate::workspace::schedule_catalogue(s);
                if !auth_required
                    && !stopped_during_pending_overflow
                    && !stopped_during_pending.contains_key(&backend.workspace)
                    && (attempted
                        || crate::git::placement(s) != Some(slug.as_str())
                        || s.phase == Phase::Failed)
                {
                    if stale_connection {
                        choose_destination(s, backend.session, None, tx);
                    } else {
                        bind(s, backend, title, None, &slug, tx);
                    }
                }
            }
        }
        Ok(Reply::PlacementUnconfirmed(family)) => {
            l.error = Some("sessionList.worktreeMove.error");
            crate::git::hold_placement(s, family);
            crate::workspace::schedule_catalogue(s);
        }
        Ok(Reply::PlacementReconciled(backend, title, slug, family)) => {
            let auth_required = l.authentication_required;
            crate::git::release_placement(s, &backend.base, &family);
            crate::workspace::schedule_catalogue(s);
            if !auth_required
                && !stopped_during_pending_overflow
                && !stopped_during_pending.contains_key(&backend.workspace)
                && (crate::git::placement(s) != Some(slug.as_str()) || s.phase == Phase::Failed)
            {
                if stale_connection {
                    choose_destination(s, backend.session, None, tx);
                } else {
                    bind(s, backend, title, None, &slug, tx);
                }
            }
        }
        Err(error) => {
            if rebinding_failed && s.phase == Phase::Reconnecting {
                s.phase = Phase::Failed;
            }
            if stale_connection && l.resume_after_job {
                l.error = None;
            } else {
                let key = match error.to_string().as_str() {
                    "rune.connect_error" => "rune.connect_error",
                    "rune.list_error" => "rune.list_error",
                    "rune.create_error" => "rune.create_error",
                    "rune.restore_error" => "rune.restore_error",
                    "sessionList.reload.error" => "sessionList.reload.error",
                    "sessionList.worktreeMove.error" => "sessionList.worktreeMove.error",
                    _ => "rune.open_error",
                };
                if key == "rune.create_error" {
                    l.creation_uncertain = true;
                }
                l.error = Some(key);
                if matches!(key, "rune.restore_error" | "rune.open_error") {
                    use crate::shell::notifications::{Category, emit_outcome};
                    emit_outcome(s, Category::Projects, None, crate::strings::t(key), true);
                } else if matches!(key, "sessionList.reload.error" | "rune.create_error") {
                    crate::shell::notifications::emit_outcome(
                        s,
                        crate::shell::notifications::Category::Sessions,
                        None,
                        crate::strings::t(key),
                        true,
                    );
                }
                #[cfg(target_arch = "wasm32")]
                {
                    if key == "rune.restore_error" && !s.screen.is_launcher() {
                        s.phase = Phase::RestoreFailed;
                        if let Some(agent) = s.agent.as_mut() {
                            agent.mark_scope_missing();
                        }
                    }
                    if !crate::platform::pairing::required(s) {
                        crate::platform::pairing::observe(s);
                    }
                }
            }
        }
    }
    if s.screen.launcher_mut().is_some_and(|l| {
        !l.pending
            && !l.authentication_required
            && std::mem::take(&mut l.resume_after_job)
            && l.project.is_none()
    }) {
        crate::workspace::resume(s, tx);
    }
    if let Some(l) = s.screen.launcher_mut()
        && !l.pending
    {
        l.visits.poll_checks();
    }
    tx.instant();
    true
}

fn apply_connected(
    s: &mut State,
    b: Backend,
    projects: Option<Vec<Project>>,
    server_id: String,
    selected: Option<String>,
    tx: &mut Tx,
) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let reauthenticated = std::mem::take(&mut l.authentication_required);
    let live_ids: Option<HashSet<String>> = if reauthenticated {
        projects
            .as_ref()
            .map(|list| list.iter().map(|p| p.id.clone()).collect())
    } else {
        None
    };
    l.catalogue_watch = None;
    l.workspace_stream_generation = 0;
    l.detached_reconcile = None;
    l.detached_reconcile_trailing = false;
    l.failed_detached_workspaces.clear();
    l.rebind_after_send = None;
    l.resume_after_job = false;
    l.managed_renewal = None;
    l.managed_renewal_failed_for = None;
    l.managed_renewal_attempts = 0;
    l.projects_refresh = None;
    l.connection_generation = l.connection_generation.wrapping_add(1);
    l.connection = Some(b);
    l.server_id = Some(server_id);
    if let Some(projects) = projects {
        l.projects = projects;
        l.projects_stale = false;
    }
    l.password = TextEdit::new("");
    if reauthenticated {
        connection::watch_catalogue(l);
    }
    let has_project = l.project.is_some();
    let job_pending = l.pending;
    crate::workspace::connected(s);
    if reauthenticated {
        crate::workspace::renew_connection(s);
        if let Some(live_ids) = &live_ids {
            let live: HashSet<&str> = live_ids.iter().map(String::as_str).collect();
            crate::workspace::stop_unlisted_detached(s, &live);
        }
        if has_project && let Some(id) = selected {
            if s.composer.pending() && s.incoming.is_none() {
                crate::composer::settle_pending(
                    s,
                    codenomad_client::transport::PromptOutcome::Unconfirmed,
                );
            }
            if (s.composer.pending() && s.incoming.is_some())
                || s.status_permissions.writing()
                || job_pending
            {
                if let Some(l) = s.screen.launcher_mut() {
                    l.rebind_after_send = Some(id);
                }
                s.phase = Phase::Failed;
                s.show_chat();
            } else if session_loaded(s) {
                s.incoming = None;
                s.phase = Phase::Failed;
                s.show_chat();
                choose_destination(s, id, None, tx);
            } else {
                s.incoming = None;
                choose_destination(s, id, None, tx);
            }
        } else {
            let active_live = s
                .screen
                .launcher()
                .and_then(|l| l.project.as_ref())
                .is_some_and(|p| {
                    live_ids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(p.id.as_str()))
                });
            if active_live {
                crate::git::project_opened(s);
                crate::workspace::restore_files_mode(s);
            }
            if job_pending {
                if let Some(l) = s.screen.launcher_mut() {
                    l.resume_after_job = true;
                }
            } else {
                crate::workspace::resume(s, tx);
            }
        }
    } else {
        crate::workspace::resume(s, tx);
    }
}
