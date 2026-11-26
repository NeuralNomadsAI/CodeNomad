#[cfg(not(target_arch = "wasm32"))]
use super::view::Window;
use crate::{State, backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{Provider, providers},
    stream::{CatalogueChanges, SessionCatalogueChanges},
};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, TextRole, layout::Layout, settings as chrome};

pub(super) struct Target {
    backend: Backend,
    workspace: String,
    session: Option<String>,
    owned_tab: bool,
    revision: u64,
    observed: Option<u64>,
    authority: u64,
    online: bool,
    stats: [u64; 2],
    stats_status: Option<(bool, Option<u64>)>,
    integrations: u64,
    integrations_session: u64,
}

impl Target {
    pub fn capture(s: &State) -> Option<Self> {
        let (backend, workspace, session, owned_tab) = if let Some(l) = s.screen.launcher() {
            let backend = l.connection.clone()?;
            let workspace = l.project.as_ref()?.id.clone();
            let session = crate::workspace::active_session(s).map(str::to_owned);
            (backend, workspace, session, true)
        } else {
            let backend = super::bound_backend(s)?;
            let (workspace, session) = (backend.workspace.clone(), backend.session.clone());
            (
                backend,
                workspace,
                (!session.is_empty()).then_some(session),
                false,
            )
        };
        Some(Self {
            backend,
            workspace,
            session,
            owned_tab,
            revision: 0,
            observed: None,
            authority: 0,
            online: true,
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
            self.authority = self.authority.wrapping_add(1);
        } else if self.matches(changes) {
            self.invalidate();
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

    fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    #[cfg(test)]
    pub(super) fn fixture(backend: Backend, workspace: &str, session: Option<&str>) -> Self {
        Self {
            backend,
            workspace: workspace.to_owned(),
            session: session.map(str::to_owned),
            owned_tab: false,
            revision: 0,
            observed: None,
            authority: 0,
            online: true,
            stats: [0; 2],
            stats_status: None,
            integrations: 0,
            integrations_session: 0,
        }
    }
}

type Flight = (Sender<()>, Receiver<Option<Vec<Provider>>>);

pub(super) struct Catalog {
    pub expanded: bool,
    scope: Option<(String, String, Option<String>)>,
    authority: u64,
    seen: Option<u64>,
    flight: Option<Flight>,
    rows: Option<Vec<Provider>>,
    failed: bool,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            expanded: true,
            scope: None,
            authority: 0,
            seen: None,
            flight: None,
            rows: None,
            failed: false,
        }
    }
}

impl Catalog {
    pub fn poll(&mut self, target: Option<&Target>, wake: Option<&rune::Waker>) -> bool {
        let Some((target, wake)) = target
            .zip(wake)
            .filter(|(target, _)| self.expanded && target.online)
        else {
            let changed = self.seen.is_some();
            *self = Self {
                expanded: self.expanded,
                ..Self::default()
            };
            return changed;
        };
        let mut changed = false;
        if self
            .scope
            .as_ref()
            .is_none_or(|(client, workspace, session)| {
                client != &target.backend.client_id
                    || workspace != &target.workspace
                    || session != &target.session
            })
            || self.authority != target.authority
        {
            *self = Self {
                expanded: true,
                scope: Some((
                    target.backend.client_id.clone(),
                    target.workspace.clone(),
                    target.session.clone(),
                )),
                authority: target.authority,
                ..Self::default()
            };
            changed = true;
        }
        if let Some(result) = self
            .flight
            .as_ref()
            .and_then(|(_, reply)| reply.try_recv().ok())
        {
            self.flight = None;
            if self.seen == Some(target.revision) {
                self.failed = result.is_none();
                if let Some(rows) = result {
                    self.rows = Some(rows);
                }
            }
            changed = true;
        }
        if self.flight.is_none() && self.seen != Some(target.revision) {
            let (cancel, cancelled) = bounded(1);
            let (out, reply) = bounded(1);
            let (backend, workspace, session, wake) = (
                target.backend.clone(),
                target.workspace.clone(),
                target.session.clone(),
                wake.clone(),
            );
            self.seen = Some(target.revision);
            self.flight = Some((cancel, reply));
            self.failed = false;
            platform::spawn(async move {
                if let Some(result) = platform::reads::cancellable(
                    &cancelled,
                    providers(&backend, &workspace, session.as_deref()),
                )
                .await
                    && out.send(result.ok()).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        changed
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn view(s: &Window, available: bool) -> El {
    content(&s.providers, available, |s: &mut Window| {
        s.providers.toggle()
    })
}

impl Catalog {
    pub fn toggle(&mut self) {
        *self = Self {
            expanded: !self.expanded,
            ..Self::default()
        };
    }

    pub fn suspend(&mut self) {
        *self = Self {
            expanded: self.expanded,
            ..Self::default()
        };
    }
}

pub(super) fn content<S: 'static>(
    catalog: &Catalog,
    available: bool,
    toggle: impl Fn(&mut S) + Clone + 'static,
) -> El {
    let mut body = col().full_width().separate(Space::Sm);
    if catalog.expanded {
        if !available {
            body = body.child(text(t("settings.providers.empty.noInstance")).role("status"));
        } else {
            if catalog.flight.is_some() {
                body = body.child(text(t("settings.providers.loading")).role("status"));
            } else if catalog.failed {
                body = body.child(
                    text(t("settings.providers.errors.loadFailed"))
                        .wrap()
                        .role("alert"),
                );
            }
            if let Some(rows) = &catalog.rows {
                if rows.is_empty() {
                    body = body.child(
                        text(t("settings.providers.empty.noConfiguredProviders")).role("status"),
                    );
                }
                for provider in rows {
                    let mut row = col().full_width().separate(Space::Sm).child(
                        text(&provider.name)
                            .full_width()
                            .wrap_anywhere()
                            .text_role(TextRole::Title)
                            .role("heading"),
                    );
                    if let Some(active) = &provider.active {
                        let label = text(&active.label);
                        row = row.child(chrome::setting_row(
                            t("settings.accounts.current"),
                            if active.environment {
                                label.help(t("settings.providers.source.env"))
                            } else {
                                label
                            },
                        ));
                    }
                    body = body.child(chrome::card(row).key(format!("provider-{}", provider.id)));
                }
            }
        }
    }
    chrome::card(chrome::disclosure(
        t("settings.providers.models.title"),
        catalog.expanded,
        body,
        toggle,
    ))
}
