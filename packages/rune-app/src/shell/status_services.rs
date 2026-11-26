//! Right-panel Status: MCP Servers and Plugins sections coordinator.
use crate::{State, backend::Backend};
use codenomad_client::transport::WorkspaceEvent;
use rune::El;

mod barrier;
mod mcp;
mod plugins;
mod plugins_cards;
mod plugins_view;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

#[derive(Default)]
pub(crate) struct Services {
    mcp: mcp::McpPanel,
    pub(crate) plugins: plugins::PluginsPanel,
}

impl Services {
    pub(crate) fn attach(&mut self, backend: Option<&Backend>) {
        self.mcp.attach(backend);
        self.plugins.attach(backend);
    }

    pub(crate) fn bind(&mut self, backend: &Backend) {
        self.mcp.bind(backend);
        self.plugins.bind(backend);
    }

    pub(crate) fn same_scope(&self, backend: &Backend) -> bool {
        self.mcp.same_scope(backend) && self.plugins.same_scope(backend)
    }

    pub(crate) fn workspace_id(&self) -> Option<&str> {
        self.plugins
            .workspace_id()
            .or_else(|| self.mcp.workspace_id())
    }

    pub(crate) fn online(&mut self, online: bool) {
        self.mcp.online(online);
        self.plugins.online(online);
    }

    pub(crate) fn synchronized(&mut self) {
        self.mcp.synchronized();
        self.plugins.synchronized();
    }

    pub(crate) fn location_moved(&mut self) {
        self.mcp.location_moved();
        self.plugins.location_moved();
    }

    pub(crate) fn invalidate_mcp(&mut self) {
        self.mcp.invalidate();
    }

    pub(crate) fn invalidate_plugins(&mut self, directory: Option<&str>) {
        self.plugins.invalidate(directory);
    }

    pub(crate) fn confirm_open(&self) -> bool {
        self.plugins.confirm_remove.is_some()
    }

    pub(crate) fn dismiss_confirm(&mut self, tx: &mut rune::Tx) -> bool {
        self.plugins.cancel_remove_confirm(tx)
    }

    pub(crate) fn event(&mut self, event: &WorkspaceEvent) {
        match event {
            WorkspaceEvent::PluginsChanged { directory, .. } => {
                self.plugins.invalidate(directory.as_deref());
            }
            WorkspaceEvent::McpStatusChanged { .. } => {
                self.mcp.invalidate();
            }
            WorkspaceEvent::ServicesConfigChanged { .. } => {
                self.plugins.invalidate(None);
                self.mcp.invalidate();
            }
            WorkspaceEvent::NativeStreamStatus { connected, .. } => {
                if *connected {
                    self.mcp.require_revalidation();
                    self.plugins.require_revalidation();
                } else {
                    self.online(false);
                }
            }
            WorkspaceEvent::Stopped { .. } => {
                self.online(false);
            }
            WorkspaceEvent::SessionMoved { .. } => {
                self.location_moved();
            }
            _ => {}
        }
    }

    pub(crate) fn show(&mut self, visible: bool) {
        self.mcp.show(visible);
        self.plugins.show(visible);
    }
}

pub(crate) fn poll(s: &mut State, now: f64, tx: &mut rune::Tx) -> bool {
    if let crate::Screen::Launcher(launcher) = &s.screen {
        if let (Some(conn), Some(project)) = (&launcher.connection, &launcher.project)
            && !launcher.authentication_required
        {
            let mut backend = conn.clone();
            backend.workspace.clone_from(&project.id);
            backend.session.clear();
            backend.session_directory = None;
            if !s.status_services.same_scope(&backend) {
                s.status_services.bind(&backend);
                s.status_services.online(true);
            }
        } else {
            s.status_services.attach(None);
        }
    }
    #[cfg(target_arch = "wasm32")]
    let pairing = crate::platform::pairing::required(s);
    #[cfg(not(target_arch = "wasm32"))]
    let pairing = false;
    let visible = !pairing
        && !super::launcher_replaces_project(s)
        && s.shell.visible(1)
        && crate::workspace::right_panel_tab(s) == crate::workspace::RightPanelTab::Status;
    s.status_services.show(visible);
    let mcp_changed = s.status_services.mcp.poll(&s.reads, &s.wake);
    let plugins_changed = s.status_services.plugins.poll(now, &s.reads, &s.wake, tx);
    mcp_changed || plugins_changed
}

pub(super) fn view(s: &State) -> impl IntoIterator<Item = El> {
    [mcp::view(s), plugins_view::view(s)].into_iter().flatten()
}
