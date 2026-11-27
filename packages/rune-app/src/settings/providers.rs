mod accounts;
mod form;
mod manager;
mod modal;
#[cfg(test)]
mod tests;

#[cfg(not(target_arch = "wasm32"))]
use super::view::Window;
use crate::{State, backend::Backend};
use codenomad_client::stream::{CatalogueChanges, ProviderMoves, SessionCatalogueChanges};
use rune::El;

pub(super) struct Target {
    backend: Backend,
    workspace: String,
    session: Option<String>,
    owned_tab: bool,
    revision: u64,
    mission_catalog: u64,
    observed: Option<u64>,
    observed_location_revision: u64,
    observed_upstream_healthy: bool,
    authority: u64,
    online: bool,
    stats: [u64; 2],
    stats_status: Option<(bool, Option<u64>)>,
    integrations: u64,
    integrations_session: u64,
}

impl Target {
    pub fn capture(s: &State) -> Option<Self> {
        let (backend, workspace, session, owned_tab, observed, online) =
            if let Some(l) = s.screen.launcher() {
                let backend = l.connection.clone()?;
                let workspace = l.project.as_ref()?.id.clone();
                let session = crate::workspace::active_session(s).map(str::to_owned);
                let (observed, online) = match l.catalogue_watch.as_ref() {
                    Some(watch) => {
                        let generation = watch.generation();
                        (Some(generation), generation % 2 == 1)
                    }
                    None => (None, true),
                };
                (backend, workspace, session, true, observed, online)
            } else {
                let backend = super::bound_backend(s)?;
                let (workspace, session) = (backend.workspace.clone(), backend.session.clone());
                (
                    backend,
                    workspace,
                    (!session.is_empty()).then_some(session),
                    false,
                    None,
                    true,
                )
            };
        let observed_location_revision = backend
            .client
            .location_revision(&workspace, session.as_deref());
        let observed_upstream_healthy = backend.client.workspace_upstream_healthy(&workspace);
        Some(Self {
            backend,
            workspace,
            session,
            owned_tab,
            revision: 0,
            mission_catalog: 0,
            observed,
            observed_location_revision,
            observed_upstream_healthy,
            authority: 0,
            online,
            stats: [0; 2],
            stats_status: None,
            integrations: 0,
            integrations_session: 0,
        })
    }

    pub fn validate(
        &mut self,
        s: &State,
        current: Option<&Backend>,
        changes: &CatalogueChanges,
        moves: &ProviderMoves,
        stopped: &CatalogueChanges,
        generation: Option<u64>,
    ) -> bool {
        let exists = (!self.owned_tab || crate::workspace::contains_project(s, &self.workspace))
            && !self.matches(stopped);
        let current = current.filter(|current| {
            current.base == self.backend.base
                && (current.client.same_connection(&self.backend.client)
                    || current.client.server_identity().is_some()
                        && current.client.server_identity()
                            == self.backend.client.server_identity())
        });
        let Some(current) = current.filter(|_| exists) else {
            return false;
        };
        if !self.backend.client.same_connection(&current.client) {
            self.backend = current.clone();
            self.observed = None;
            self.observed_location_revision = self
                .backend
                .client
                .location_revision(&self.workspace, self.session.as_deref());
            self.observed_upstream_healthy = self
                .backend
                .client
                .workspace_upstream_healthy(&self.workspace);
            self.authority = self.authority.wrapping_add(1);
        } else if self.matches(changes) {
            self.invalidate();
        }
        match moves {
            ProviderMoves::None => {}
            ProviderMoves::All => {
                self.authority = self.authority.wrapping_add(1);
                self.invalidate();
            }
            ProviderMoves::Sessions(entries) => {
                for (workspace, session) in entries {
                    if self.session_moved(workspace, session) {
                        break;
                    }
                }
            }
        }
        if let Some(generation) = generation
            && self.observed != Some(generation)
        {
            self.observed = Some(generation);
            self.transport(generation % 2 == 1);
            self.authority = self.authority.wrapping_add(1);
        }
        true
    }

    pub fn transport(&mut self, online: bool) {
        if self.online != online {
            self.online = online;
            self.authority = self.authority.wrapping_add(1);
            self.invalidate();
        }
    }

    pub fn online(&self) -> bool {
        self.online
    }

    pub(super) fn stats_source(&self) -> (&Backend, &str, u64, [u64; 2]) {
        (&self.backend, &self.workspace, self.authority, self.stats)
    }

    pub(super) fn stats_status(&self) -> Option<(bool, Option<u64>)> {
        self.stats_status
    }

    pub(super) fn stats_catalogue(
        &mut self,
        changes: &[CatalogueChanges; 2],
        status: Option<(bool, Option<u64>)>,
    ) -> bool {
        let mut changed = std::mem::replace(&mut self.stats_status, status) != status;
        for (index, lane) in changes.iter().enumerate() {
            if self.matches(lane) {
                self.stats[index] = self.stats[index].wrapping_add(1);
                changed = true;
            }
        }
        changed
    }

    pub(super) fn stats_hint(&mut self, workspace: &str, urgent: bool) {
        if self.is_workspace(workspace) {
            let counter = &mut self.stats[usize::from(!urgent)];
            *counter = counter.wrapping_add(1);
        }
    }

    pub(super) fn backend(&self) -> &Backend {
        &self.backend
    }

    pub(super) fn authority(&self) -> u64 {
        self.authority
    }

    pub(super) fn integrations_source(
        &self,
    ) -> (&Backend, &str, Option<&str>, u64, u64, u64, bool) {
        (
            &self.backend,
            &self.workspace,
            self.session.as_deref(),
            self.authority,
            self.integrations,
            self.integrations_session,
            self.online,
        )
    }

    pub(super) fn integrations_catalogue(
        &mut self,
        changes: &CatalogueChanges,
        session_changes: &SessionCatalogueChanges,
    ) -> bool {
        let mut changed = false;
        if self.matches(changes) {
            self.integrations = self.integrations.wrapping_add(1);
            changed = true;
        }
        let session_matched = match session_changes {
            SessionCatalogueChanges::None => false,
            SessionCatalogueChanges::All => true,
            SessionCatalogueChanges::Sessions(pairs) => self
                .session
                .as_ref()
                .is_some_and(|ses| pairs.contains(&(self.workspace.clone(), ses.clone()))),
        };
        if session_matched {
            self.integrations_session = self.integrations_session.wrapping_add(1);
            changed = true;
        }
        changed
    }

    pub(super) fn integrations_hint(&mut self, workspace: &str, session: Option<&str>) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        match session {
            None => {
                self.integrations = self.integrations.wrapping_add(1);
                true
            }
            Some(ses) if self.session.as_deref() == Some(ses) => {
                self.integrations_session = self.integrations_session.wrapping_add(1);
                true
            }
            Some(_) => false,
        }
    }

    pub(super) fn location(&self) -> (&str, Option<&str>) {
        (&self.workspace, self.session.as_deref())
    }

    pub fn revision(&self) -> u64 {
        self.authority.wrapping_add(self.revision)
    }

    pub(super) fn sync_location_state(&mut self) -> bool {
        let rev = self
            .backend
            .client
            .location_revision(&self.workspace, self.session.as_deref());
        let healthy = self
            .backend
            .client
            .workspace_upstream_healthy(&self.workspace);
        let changed =
            self.observed_location_revision != rev || self.observed_upstream_healthy != healthy;
        self.observed_location_revision = rev;
        self.observed_upstream_healthy = healthy;
        changed
    }

    pub(super) fn mission_catalog_revision(&self) -> u64 {
        self.revision().wrapping_add(self.mission_catalog)
    }

    pub(super) fn mission_catalog_catalogue(&mut self, changes: &CatalogueChanges) -> bool {
        if !self.matches(changes) {
            return false;
        }
        self.mission_catalog = self.mission_catalog.wrapping_add(1);
        true
    }

    pub(super) fn mission_catalog_hint(&mut self, workspace: &str) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        self.mission_catalog = self.mission_catalog.wrapping_add(1);
        true
    }

    fn matches(&self, changes: &CatalogueChanges) -> bool {
        match changes {
            CatalogueChanges::None => false,
            CatalogueChanges::All => true,
            CatalogueChanges::Workspaces(ids) => ids.contains(&self.workspace),
        }
    }

    pub fn is_workspace(&self, workspace: &str) -> bool {
        self.workspace == workspace
    }

    pub fn hint(&mut self, workspace: &str) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        self.invalidate();
        true
    }

    pub fn session_moved(&mut self, workspace: &str, session: &str) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        if !session.is_empty() && self.session.as_deref() != Some(session) {
            return false;
        }
        self.authority = self.authority.wrapping_add(1);
        self.invalidate();
        true
    }

    fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    #[cfg(test)]
    pub(super) fn fixture(backend: Backend, workspace: &str, session: Option<&str>) -> Self {
        let observed_location_revision = backend.client.location_revision(workspace, session);
        let observed_upstream_healthy = backend.client.workspace_upstream_healthy(workspace);
        Self {
            backend,
            workspace: workspace.to_owned(),
            session: session.map(str::to_owned),
            owned_tab: false,
            revision: 0,
            mission_catalog: 0,
            observed: None,
            observed_location_revision,
            observed_upstream_healthy,
            authority: 0,
            online: true,
            stats: [0; 2],
            stats_status: None,
            integrations: 0,
            integrations_session: 0,
        }
    }
}

#[derive(Default)]
pub(super) struct Catalog {
    manager: manager::Manager,
}

impl Catalog {
    pub fn poll<S: 'static>(
        &mut self,
        target: Option<&Target>,
        now: f64,
        wake: Option<&rune::Waker>,
        tx: &mut rune::Tx,
        visible: bool,
        access: fn(&mut S) -> &mut Catalog,
    ) -> bool {
        self.manager.poll(target, now, wake, tx, visible, access)
    }

    pub fn toggle(&mut self) {
        self.manager.toggle();
    }

    pub fn suspend(&mut self) {
        self.manager.suspend();
    }

    pub fn cancel_on_hide(&mut self) -> bool {
        self.manager.cancel_on_hide()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn dismiss_modal(&mut self, tx: &mut rune::Tx) -> bool {
        self.manager.dismiss_modal(tx)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn view(s: &Window, available: bool, layers: &mut Vec<El>) -> El {
    content(&s.providers, available, layers, |s: &mut Window| {
        &mut s.providers
    })
}

pub(super) fn content<S: 'static>(
    catalog: &Catalog,
    available: bool,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
) -> El {
    manager::Manager::view(catalog, available, layers, access)
}
