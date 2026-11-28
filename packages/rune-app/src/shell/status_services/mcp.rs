//! Right-panel Status: MCP Servers section state, actions, and view.
use super::barrier::{self, Kind};
use crate::{State, backend::Backend, platform, screen, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    plugins::{
        ActionError,
        mcp::{self, McpSnapshot, McpState},
    },
};
use rune::{El, col};
use rune_theme_codenomad::{
    Space, git_panel,
    layout::{self, Layout},
    settings, shell,
};
use std::collections::{HashMap, HashSet};

enum ReadOutcome {
    Snapshot(McpSnapshot, HashMap<String, u64>),
    Unsupported,
    Failed,
}

type ReadFlight = (Sender<()>, Receiver<ReadOutcome>, HashMap<String, u64>);

pub(super) struct McpPanel {
    observer: u64,
    pub(super) expanded: bool,
    backend: Option<Backend>,
    online: bool,
    visible: bool,
    dirty: bool,
    location_unconfirmed: bool,
    confirmed_generations: HashMap<String, u64>,
    attempted_generations: HashMap<String, u64>,
    unconfirmed_servers: HashSet<String>,
    read: Option<ReadFlight>,
    pending_toggles: Vec<(String, String, u64)>,
    pub(super) snapshot: Option<McpSnapshot>,
    pub(super) unsupported: bool,
    pub(super) write_unsupported: bool,
    pub(super) failed: bool,
    action_error: Option<String>,
}

impl Default for McpPanel {
    fn default() -> Self {
        Self {
            observer: barrier::next_observer(),
            expanded: false,
            backend: None,
            online: false,
            visible: false,
            dirty: false,
            location_unconfirmed: false,
            confirmed_generations: HashMap::new(),
            attempted_generations: HashMap::new(),
            unconfirmed_servers: HashSet::new(),
            read: None,
            pending_toggles: Vec::new(),
            snapshot: None,
            unsupported: false,
            write_unsupported: false,
            failed: false,
            action_error: None,
        }
    }
}

impl McpPanel {
    pub(super) fn attach(&mut self, backend: Option<&Backend>) {
        if backend.is_some_and(|next| self.same_scope(next)) {
            self.online(false);
            return;
        }
        let expanded = self.expanded;
        *self = Self {
            expanded,
            ..Self::default()
        };
    }

    pub(super) fn bind(&mut self, backend: &Backend) {
        if !self.same_scope(backend) {
            self.attach(Some(backend));
            self.backend = (!backend.workspace.is_empty()).then(|| backend.clone());
            self.dirty = true;
        } else if self.backend.is_none() && !backend.workspace.is_empty() {
            self.backend = Some(backend.clone());
            self.dirty = true;
        }
    }

    pub(super) fn same_scope(&self, next: &Backend) -> bool {
        self.backend.as_ref().is_some_and(|prev| {
            prev.base == next.base
                && prev.workspace == next.workspace
                && prev.session == next.session
                && prev.client.same_connection(&next.client)
                && (self.location_unconfirmed || prev.session_directory == next.session_directory)
        })
    }

    pub(super) fn workspace_id(&self) -> Option<&str> {
        self.backend
            .as_ref()
            .map(|b| b.workspace.as_str())
            .filter(|id| !id.is_empty())
    }

    pub(super) fn online(&mut self, online: bool) {
        if self.online != online {
            self.online = online;
            self.dirty = true;
            if !online {
                self.read = None;
                self.location_unconfirmed = true;
                if let Some(backend) = &mut self.backend
                    && !backend.session.is_empty()
                {
                    backend.session_directory = None;
                }
            }
        }
    }

    pub(super) fn require_revalidation(&mut self) {
        self.online = true;
        self.location_unconfirmed = true;
        self.read = None;
        self.dirty = true;
        if let Some(backend) = &mut self.backend
            && !backend.session.is_empty()
        {
            backend.session_directory = None;
        }
    }

    pub(super) fn request_refresh(&mut self) {
        if !self.online || self.read.is_some() || self.any_toggle_active() {
            return;
        }
        self.failed = false;
        self.action_error = None;
        self.dirty = true;
    }

    pub(super) fn synchronized(&mut self) {
        if !self.online {
            self.online(true);
        }
    }

    pub(super) fn location_moved(&mut self) {
        self.online = false;
        self.location_unconfirmed = true;
        self.read = None;
        self.dirty = true;
        self.action_error = None;
        if let Some(backend) = &mut self.backend {
            backend.session_directory = None;
        }
    }

    pub(super) fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub(super) fn show(&mut self, visible: bool) {
        if self.visible != visible {
            self.visible = visible;
            if visible {
                self.dirty = true;
            } else {
                self.read = None;
            }
        }
    }

    fn toggle_section(&mut self) {
        self.expanded = !self.expanded;
        if self.expanded {
            self.dirty = true;
        } else {
            self.read = None;
        }
    }

    fn server_busy(&self, server: &str) -> bool {
        self.backend
            .as_ref()
            .is_some_and(|b| barrier::is_active(&Kind::McpServer(server.to_owned()), &b.base))
    }

    fn any_toggle_active(&self) -> bool {
        self.pending_toggles
            .iter()
            .any(|(server, base, _)| barrier::is_active(&Kind::McpServer(server.clone()), base))
            || self.snapshot.as_ref().is_some_and(|snap| {
                snap.servers
                    .iter()
                    .any(|server| self.server_busy(&server.name))
            })
    }

    pub(super) fn toggle_server(&mut self, server: String, connect: bool, wake: &rune::Waker) {
        if !self.online
            || !self.visible
            || !self.expanded
            || self.location_unconfirmed
            || self.unsupported
            || self.write_unsupported
            || self.unconfirmed_servers.contains(&server)
        {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(directory) = self.snapshot.as_ref().map(|s| s.directory.clone()) else {
            return;
        };
        let expected = self
            .confirmed_generations
            .get(&server)
            .copied()
            .unwrap_or(0);
        let Some(guard) = barrier::try_begin(
            Kind::McpServer(server.clone()),
            &backend.base,
            expected,
            self.observer,
            wake.clone(),
        ) else {
            self.unconfirmed_servers.insert(server);
            self.dirty = true;
            return;
        };
        self.action_error = None;
        self.read = None;
        self.unconfirmed_servers.insert(server.clone());
        self.pending_toggles
            .push((server.clone(), backend.base.clone(), guard.id()));
        platform::spawn(async move {
            let outcome = mcp::toggle_mcp(&backend, &directory, &server, connect).await;
            guard.finish(outcome);
        });
    }

    pub(super) fn poll(&mut self, reads: &platform::reads::Reads, wake: &rune::Waker) -> bool {
        let mut changed = false;
        let mut i = 0;
        while i < self.pending_toggles.len() {
            let (server, base, id) = &self.pending_toggles[i];
            let kind = Kind::McpServer(server.clone());
            let _ = barrier::observe(&kind, base, self.observer, wake);
            if let Some(outcome) = barrier::result(&kind, base, *id) {
                let (server, _, _) = self.pending_toggles.remove(i);
                match outcome {
                    Ok(()) => {}
                    Err(ActionError::Unsupported) => self.write_unsupported = true,
                    Err(_) => self.action_error = Some(server.clone()),
                }
                self.unconfirmed_servers.insert(server);
                self.dirty = true;
                changed = true;
            } else {
                i += 1;
            }
        }
        if let Some(backend) = &self.backend
            && let Some(snap) = &self.snapshot
        {
            for server in &snap.servers {
                let kind = Kind::McpServer(server.name.clone());
                let obs = barrier::observe(&kind, &backend.base, self.observer, wake);
                let confirmed = self
                    .confirmed_generations
                    .get(&server.name)
                    .copied()
                    .unwrap_or(0);
                let in_flight_covers = self.read.as_ref().is_some_and(|(_, _, gens)| {
                    gens.get(&server.name).copied().unwrap_or(0) == obs.settled_id
                });
                let already_attempted = self.failed
                    && self
                        .attempted_generations
                        .get(&server.name)
                        .copied()
                        .unwrap_or(0)
                        == obs.settled_id;
                if obs.active || obs.settled_id != confirmed {
                    if self.unconfirmed_servers.insert(server.name.clone()) {
                        changed = true;
                    }
                    if !obs.active && !in_flight_covers && !already_attempted {
                        self.dirty = true;
                    }
                }
            }
        }

        if let Some((_, rx, _)) = &self.read {
            match rx.try_recv() {
                Ok(outcome) => {
                    self.read = None;
                    if !self.dirty {
                        match outcome {
                            ReadOutcome::Snapshot(snap, read_gens) => {
                                let base = self.backend.as_ref().map(|b| b.base.as_str());
                                let mut need_reread = false;
                                for server in &snap.servers {
                                    let at_read = read_gens.get(&server.name).copied().unwrap_or(0);
                                    let live = base.map_or(0, |b| {
                                        barrier::settled_id(
                                            &Kind::McpServer(server.name.clone()),
                                            b,
                                        )
                                    });
                                    let active = base.is_some_and(|b| {
                                        barrier::is_active(&Kind::McpServer(server.name.clone()), b)
                                    });
                                    if !active && live == at_read {
                                        self.confirmed_generations
                                            .insert(server.name.clone(), at_read);
                                        self.unconfirmed_servers.remove(&server.name);
                                    } else {
                                        self.unconfirmed_servers.insert(server.name.clone());
                                        if !active {
                                            need_reread = true;
                                        }
                                    }
                                }
                                if let Some(backend) = &mut self.backend
                                    && !backend.session.is_empty()
                                {
                                    backend.session_directory = Some(snap.directory.clone());
                                }
                                self.snapshot = Some(snap);
                                self.unsupported = false;
                                self.failed = false;
                                self.location_unconfirmed = false;
                                if need_reread {
                                    self.dirty = true;
                                }
                            }
                            ReadOutcome::Unsupported => {
                                self.snapshot = None;
                                self.unsupported = true;
                                self.failed = false;
                                self.location_unconfirmed = false;
                            }
                            ReadOutcome::Failed => self.failed = true,
                        }
                    }
                    changed = true;
                }
                Err(codenomad_client::TryRecvError::Closed) => {
                    self.read = None;
                    if !self.dirty {
                        self.failed = true;
                    }
                    changed = true;
                }
                Err(codenomad_client::TryRecvError::Empty) => {}
            }
        }

        if self.dirty
            && self.visible
            && self.expanded
            && self.online
            && self.read.is_none()
            && !self.any_toggle_active()
            && let Some(mut backend) = self.backend.clone()
        {
            if self.location_unconfirmed && !backend.session.is_empty() {
                backend.session_directory = None;
            }
            let (cancel, cancelled) = bounded(1);
            let (out, rx) = bounded(1);
            let read_gens = barrier::mcp_generations(&backend.base);
            self.attempted_generations = read_gens.clone();
            self.dirty = false;
            self.read = Some((cancel, rx, read_gens.clone()));
            let (reads, wake) = (reads.clone(), wake.clone());
            platform::spawn(async move {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                if let Some(result) =
                    platform::reads::cancellable(&cancelled, mcp::load_mcp(&backend, None)).await
                {
                    let outcome = match result {
                        Ok(Some(snap)) => ReadOutcome::Snapshot(snap, read_gens),
                        Ok(None) => ReadOutcome::Unsupported,
                        Err(_) => ReadOutcome::Failed,
                    };
                    if out.send(outcome).await.is_ok() {
                        wake();
                    }
                }
            });
            changed = true;
        }
        changed
    }

    #[cfg(test)]
    pub(super) fn reading(&self) -> bool {
        self.read.is_some()
    }
}

fn failed_banner(s: &State, panel: &McpPanel) -> El {
    layout::action_row()
        .child(settings::palette::save_error(t("integrations.line.failed")).key("mcp-load-error"))
        .child(
            layout::button(
                t("settings.providers.refresh"),
                panel.read.is_some() || !panel.online || panel.any_toggle_active(),
                screen::action(&s.input_scope, |s| {
                    s.status_services.mcp.request_refresh();
                }),
            )
            .key("mcp-refresh"),
        )
}

pub(super) fn view(s: &State) -> Option<El> {
    let panel = &s.status_services.mcp;
    panel.backend.as_ref()?;
    let mut body = col().full_width().separate(Space::Xs);
    if panel.expanded {
        if panel.snapshot.is_none() && !panel.unsupported && !panel.failed {
            body = body.child(
                git_panel::note(t("instanceServiceStatus.mcp.loading"), "status").key("mcp-status"),
            );
        } else if panel.unsupported
            || panel
                .snapshot
                .as_ref()
                .is_some_and(|snap| snap.servers.is_empty())
        {
            body = body.child(
                git_panel::note(t("instanceServiceStatus.mcp.empty"), "status").key("mcp-status"),
            );
        } else if panel.failed && panel.snapshot.is_none() {
            body = body.child(failed_banner(s, panel));
        }
        if panel.failed && panel.snapshot.is_some() {
            body = body.child(failed_banner(s, panel));
        }
        if let Some(snap) = &panel.snapshot {
            for server in &snap.servers {
                let pending = panel.server_busy(&server.name);
                let running = matches!(server.status, McpState::Running);
                let dot = if pending {
                    shell::ServiceDot::Pending
                } else {
                    match server.status {
                        McpState::Running => shell::ServiceDot::Ready,
                        McpState::Error(_) => shell::ServiceDot::Error,
                        McpState::Stopped => shell::ServiceDot::Stopped,
                    }
                };
                let disabled = pending
                    || !panel.online
                    || panel.location_unconfirmed
                    || panel.write_unsupported
                    || panel.unconfirmed_servers.contains(&server.name);
                let server_name = server.name.clone();
                let next_connect = !running;
                let aria =
                    t("instanceServiceStatus.mcp.toggleAriaLabel").replace("{name}", &server.name);
                let row_help = match &server.status {
                    McpState::Error(Some(err)) => format!("{}\n{err}", server.name),
                    McpState::Error(None) => format!(
                        "{}\n{}",
                        server.name,
                        t("instanceServiceStatus.plugins.runtime.failed")
                    ),
                    _ => server.name.clone(),
                };
                let mut item = col()
                    .full_width()
                    .inset_surface()
                    .pad(Space::Sm)
                    .separate(Space::Xs)
                    .help(&row_help)
                    .child(shell::service_row(
                        Some(shell::status_dot(dot)),
                        &server.name,
                        [shell::compact_switch(
                            &aria,
                            running,
                            disabled,
                            screen::action(&s.input_scope, move |s| {
                                let wake = s.wake.clone();
                                s.status_services.mcp.toggle_server(
                                    server_name.clone(),
                                    next_connect,
                                    &wake,
                                );
                            }),
                        )
                        .key(format!("mcp-switch-{}", server.name))],
                    ));
                if let McpState::Error(err) = &server.status {
                    let message = err
                        .as_deref()
                        .unwrap_or_else(|| t("instanceServiceStatus.plugins.runtime.failed"));
                    item = item.child(
                        settings::palette::save_error(message)
                            .key(format!("mcp-error-{}", server.name)),
                    );
                }
                body = body.child(item.key(format!("mcp-row-{}", server.name)));
            }
        }
        if let Some(name) = &panel.action_error {
            let msg = t("settings.pluginPackages.error").replace("{target}", name);
            body = body.child(settings::palette::save_error(&msg).key("mcp-action-error"));
        }
    }
    Some(
        settings::disclosure(
            t("instanceServiceStatus.sections.mcp"),
            panel.expanded,
            body,
            screen::action(&s.input_scope, |s| {
                s.status_services.mcp.toggle_section();
            }),
        )
        .key("status-mcp"),
    )
}
