use super::view::Window;
use crate::{State, backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{Provider, providers},
    stream::CatalogueChanges,
};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, TextRole, layout::Layout, settings as chrome};

pub(super) struct Target {
    backend: Backend,
    workspace: String,
    session: Option<String>,
    owned_tab: bool,
    revision: u64,
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
        })
    }

    pub fn validate(
        &mut self,
        s: &State,
        current: Option<&Backend>,
        changes: &CatalogueChanges,
        stopped: &CatalogueChanges,
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
            self.invalidate();
        } else if self.matches(changes) {
            self.invalidate();
        }
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

    fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }
}

type Flight = (Sender<()>, Receiver<Option<Vec<Provider>>>);

#[derive(Default)]
pub(super) struct Catalog {
    expanded: bool,
    client_id: Option<String>,
    seen: Option<u64>,
    flight: Option<Flight>,
    rows: Option<Vec<Provider>>,
    failed: bool,
}

impl Catalog {
    pub fn poll(&mut self, target: Option<&Target>, wake: Option<&rune::Waker>) -> bool {
        let Some((target, wake)) = target.zip(wake).filter(|_| self.expanded) else {
            let changed = self.seen.is_some();
            *self = Self {
                expanded: self.expanded,
                ..Self::default()
            };
            return changed;
        };
        let mut changed = false;
        if self.client_id.as_deref() != Some(&target.backend.client_id) {
            *self = Self {
                expanded: true,
                client_id: Some(target.backend.client_id.clone()),
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

pub(super) fn view(s: &Window, available: bool) -> El {
    let catalog = &s.providers;
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
        |s: &mut Window| {
            s.providers = Catalog {
                expanded: !s.providers.expanded,
                ..Catalog::default()
            };
        },
    ))
}
