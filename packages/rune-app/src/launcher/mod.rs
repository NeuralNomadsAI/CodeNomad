//! One serialized opening action at a time; HTTP never runs on the UI thread.
mod connection;
pub(crate) mod linked;
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
pub use connection::connect;
pub(crate) use placement::place;
pub(crate) use projects::set_project;
pub use projects::{choose_project, open, restore};
#[cfg(target_arch = "wasm32")]
pub(crate) use reopen::reopen;
use rune::{Tx, edit::TextEdit};
#[cfg(target_arch = "wasm32")]
use sessions::attach;
#[cfg(feature = "test-support")]
pub use sessions::back;
pub(crate) use sessions::choose_destination;
use sessions::{bind, dismiss_origin_panel, retire_session};
pub use sessions::{can_change_session, can_visit, choose, create, list, visit};
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
    pub openings: crate::workspace::opening::Openings,
    result: Option<Receiver<Result<Reply>>>,
    selection_ticket: Option<u64>,
    boot: Option<Receiver<Result<(Backend, crate::platform::LocalHost)>>>,
    host: Option<crate::platform::LocalHost>,
    wake: rune::Waker,
}
enum Reply {
    Connected(Backend, Vec<Project>, String),
    Opened(crate::workspace::opening::Opening, Sessions, Restored),
    Listed(Sessions, Option<String>),
    Created(Backend, String, String, String, Option<u64>),
    Selected(Vec<String>, Option<Selection>, Option<u64>),
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
            openings: Default::default(),
            result: None,
            selection_ticket: None,
            boot,
            host: None,
            wake,
        }
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
        self.catalogue_generation = self.catalogue_generation.wrapping_add(1);
        self.error = None;
        let (out, input) = bounded(1);
        self.result = Some(input);
        let wake = self.wake.clone();
        crate::platform::spawn(async move {
            // Only the operation label reaches the UI; responses and credentials stay private.
            let result = f.await.map_err(|_| error.into());
            let _ = out.send(result).await;
            wake();
        });
    }
}

pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let browser_changed = cfg!(target_arch = "wasm32") && (search::poll(s) | linked::poll(s));
    let blocked = !can_change_session(s);
    let selected = crate::workspace::active_session(s).map(str::to_owned);
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    let mut changed = browser_changed | (!l.pending && l.visits.poll_checks());
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
    if l.selection_ticket
        .take()
        .is_some_and(|ticket| ticket != s.notifications.navigation_ticket())
    {
        tx.instant();
        return true;
    }
    match result {
        Ok(Reply::Connected(b, projects, server_id)) => {
            let reauthenticated = std::mem::take(&mut l.authentication_required);
            l.catalogue_watch = None;
            l.connection = Some(b);
            l.server_id = Some(server_id);
            l.projects = projects;
            l.password = TextEdit::new("");
            if reauthenticated {
                connection::watch_catalogue(l);
            }
            crate::workspace::connected(s);
            if reauthenticated {
                crate::workspace::renew_connection(s);
                if let Some(id) = selected {
                    s.show_chat();
                    choose_destination(s, id, None, tx);
                } else {
                    crate::git::project_opened(s);
                    crate::workspace::restore_files_mode(s);
                    crate::workspace::resume(s, tx);
                }
            } else {
                crate::workspace::resume(s, tx);
            }
        }
        Ok(Reply::Opened(opening, rows, restored)) => {
            let project = opening.project.clone();
            if opening.adopt().is_err() {
                l.error = Some("rune.open_error");
                tx.instant();
                return true;
            }
            l.folder = TextEdit::new(&project.path);
            set_project(l, Some(project.clone()));
            l.linked = Default::default();
            connection::watch_catalogue(l);
            l.apply_listing(rows, false, None);
            l.search = TextEdit::new("");
            crate::workspace::opened(s, &project);
            match restored {
                Restored::Bound(backend, title, slug) => {
                    bind(s, backend, title, None, &slug, tx);
                }
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
            } else if cfg!(target_os = "windows") {
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
        Ok(Reply::Created(b, title, slug, submitted, dismiss)) => {
            if l.title.text == submitted {
                l.title = TextEdit::new("");
                l.show_title = false;
            }
            if blocked {
                l.sessions.insert(
                    0,
                    Session {
                        id: b.session,
                        title,
                    },
                );
            } else {
                dismiss_origin_panel(s, dismiss, tx);
                bind(s, b, title, None, &slug, tx);
            }
        }
        Ok(Reply::Selected(missing, selection, dismiss)) => {
            l.sessions.retain(|row| !missing.contains(&row.id));
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
            if let Some(id) = selected
                .as_deref()
                .filter(|id| s.phase == Phase::Failed && missing.iter().any(|m| m == id))
            {
                retire_session(s, id);
                tx.instant();
                return true;
            }
            if let Some((b, title, visit, _, slug)) = selection.filter(|(b, _, _, _, _)| {
                !blocked
                    || s.phase == Phase::Failed && selected.as_deref() == Some(b.session.as_str())
            }) {
                l.show_title = false;
                dismiss_origin_panel(s, dismiss, tx);
                bind(s, b, title, visit, &slug, tx);
            } else if !blocked {
                l.error = Some("rune.open_error");
            }
        }
        #[cfg(target_arch = "wasm32")]
        Ok(Reply::Reopened(opening, backend, title, slug)) => {
            reopen::apply(s, opening, backend, title, &slug)
        }
        Ok(Reply::Placed(backend, title, slug, confirmed, attempted)) => {
            if selected.as_deref() == Some(backend.session.as_str()) {
                l.error = (!confirmed).then_some("sessionList.worktreeMove.error");
                crate::workspace::schedule_catalogue(s);
                if attempted
                    || crate::git::placement(s) != Some(slug.as_str())
                    || s.phase == Phase::Failed
                {
                    bind(s, backend, title, None, &slug, tx);
                }
            }
        }
        Ok(Reply::PlacementUnconfirmed(family)) => {
            l.error = Some("sessionList.worktreeMove.error");
            crate::git::hold_placement(s, family);
            crate::workspace::schedule_catalogue(s);
        }
        Ok(Reply::PlacementReconciled(backend, title, slug, family)) => {
            crate::git::release_placement(s, &backend.base, &family);
            crate::workspace::schedule_catalogue(s);
            if crate::git::placement(s) != Some(slug.as_str()) || s.phase == Phase::Failed {
                bind(s, backend, title, None, &slug, tx);
            }
        }
        Err(error) => {
            let key = match error.to_string().as_str() {
                "rune.connect_error" => "rune.connect_error",
                "rune.list_error" => "rune.list_error",
                "rune.create_error" => "rune.create_error",
                "rune.restore_error" => "rune.restore_error",
                "sessionList.worktreeMove.error" => "sessionList.worktreeMove.error",
                _ => "rune.open_error",
            };
            if key == "rune.create_error" {
                l.creation_uncertain = true;
            }
            l.error = Some(key);
            if matches!(key, "rune.restore_error" | "rune.open_error") {
                use crate::shell::notifications::{Category, emit};
                emit(s, Category::Projects, None, crate::strings::t(key));
            }
            #[cfg(target_arch = "wasm32")]
            {
                if key == "rune.restore_error" && !s.screen.is_launcher() {
                    s.phase = Phase::RestoreFailed;
                }
                crate::platform::pairing::observe(s);
            }
        }
    }
    if let Some(l) = s.screen.launcher_mut()
        && !l.pending
    {
        l.visits.poll_checks();
    }
    tx.instant();
    true
}
