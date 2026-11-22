//! One serialized opening action at a time; HTTP never runs on the UI thread.
mod connection;
mod projects;
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
use rune::{Tx, edit::TextEdit};
use std::{collections::HashSet, future::Future};
pub const MAX_BROWSED_SESSIONS: usize = 2_000;
pub use connection::connect;
pub use projects::{choose_project, open, restore};
#[cfg(feature = "test-support")]
pub use sessions::back;
use sessions::{bind, dismiss_origin_panel, retire_session};
pub use sessions::{can_change_session, can_visit, choose, create, list, visit};
pub(crate) use visits::Visits;

pub struct Launcher {
    pub address: TextEdit,
    pub password: TextEdit,
    pub folder: TextEdit,
    pub title: TextEdit,
    pub search: TextEdit,
    pub show_title: bool,
    pub show_search: bool,
    pub visits: Visits,
    pub connection: Option<Backend>,
    pub(crate) catalogue_watch: Option<codenomad_client::stream::CatalogueWatch>,
    pub(crate) catalogue_generation: u64,
    pub server_id: Option<String>,
    pub projects: Vec<Project>,
    pub project: Option<Project>,
    pub sessions: Vec<Session>,
    pub listed_sessions: HashSet<String>,
    pub next: Option<String>,
    pub pending: bool,
    listing: bool,
    pub error: Option<&'static str>,
    pub creation_uncertain: bool,
    pub openings: crate::workspace::opening::Openings,
    result: Option<Receiver<Result<Reply>>>,
    boot: Option<Receiver<Result<(Backend, crate::platform::LocalHost)>>>,
    host: Option<crate::platform::LocalHost>,
    wake: rune::Waker,
}
enum Reply {
    Connected(Backend, Vec<Project>, String),
    Opened(crate::workspace::opening::Opening, Sessions, Restored),
    Listed(Sessions, bool),
    Created(Backend, String, String, Option<u64>),
    Selected(Vec<String>, Option<Selection>, Option<u64>),
}
type Selection = (Backend, String, Option<usize>, Instant);
enum Restored {
    Empty,
    Bound(Backend, String),
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
            show_title: false,
            show_search: false,
            visits: Visits::default(),
            connection: None,
            catalogue_watch: None,
            catalogue_generation: 0,
            server_id: None,
            projects: vec![],
            project: None,
            sessions: vec![],
            listed_sessions: HashSet::new(),
            next: None,
            pending: starting,
            listing: false,
            error: None,
            creation_uncertain: false,
            openings: Default::default(),
            result: None,
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
    let blocked = !can_change_session(s);
    let selected = crate::workspace::active_session(s).map(str::to_owned);
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    let mut changed = !l.pending && l.visits.poll_checks();
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
    match result {
        Ok(Reply::Connected(b, projects, server_id)) => {
            l.catalogue_watch = Some(codenomad_client::stream::CatalogueWatch::new(
                b.clone(),
                l.wake.clone(),
            ));
            l.connection = Some(b);
            l.server_id = Some(server_id);
            l.projects = projects;
            l.password = TextEdit::new("");
            crate::workspace::connected(s);
            crate::workspace::resume(s, tx);
        }
        Ok(Reply::Opened(opening, rows, restored)) => {
            let project = opening.project.clone();
            if opening.adopt().is_err() {
                l.error = Some("rune.open_error");
                tx.instant();
                return true;
            }
            l.folder = TextEdit::new(&project.path);
            l.project = Some(project.clone());
            l.apply_listing(rows, false, None);
            l.search = TextEdit::new("");
            crate::workspace::opened(s, &project);
            match restored {
                Restored::Bound(backend, title) => bind(s, backend, title, None, tx),
                Restored::Missing(id) => {
                    retire_session(s, &id);
                    crate::git::project_opened(s);
                }
                Restored::Empty => crate::git::project_opened(s),
            }
        }
        Ok(Reply::Listed(rows, more)) => {
            l.apply_listing(rows, more, selected.as_deref());
            if l.next.is_none() {
                l.check_omitted_visits();
            }
        }
        Ok(Reply::Created(b, title, submitted, dismiss)) => {
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
                bind(s, b, title, None, tx);
            }
        }
        Ok(Reply::Selected(missing, selection, dismiss)) => {
            l.sessions.retain(|row| !missing.contains(&row.id));
            l.listed_sessions.retain(|id| !missing.contains(id));
            l.visits.forget(&missing);
            if let Some((backend, _, _, verified)) = &selection {
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
            if let Some((b, title, visit, _)) = selection.filter(|(b, _, _, _)| {
                !blocked
                    || s.phase == Phase::Failed && selected.as_deref() == Some(b.session.as_str())
            }) {
                l.show_title = false;
                dismiss_origin_panel(s, dismiss, tx);
                bind(s, b, title, visit, tx);
            } else if !blocked {
                l.error = Some("rune.open_error");
            }
        }
        Err(error) => {
            let key = match error.to_string().as_str() {
                "rune.connect_error" => "rune.connect_error",
                "rune.list_error" => "rune.list_error",
                "rune.create_error" => "rune.create_error",
                "rune.restore_error" => "rune.restore_error",
                _ => "rune.open_error",
            };
            if key == "rune.create_error" {
                l.creation_uncertain = true;
            }
            l.error = Some(key);
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
