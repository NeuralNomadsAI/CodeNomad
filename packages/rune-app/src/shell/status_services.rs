//! Right-panel Status: MCP Servers and Plugins sections coordinator.
use crate::{State, backend::Backend};
use rune::El;

mod barrier;
mod mcp;
mod plugins;
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

    pub(crate) fn show(&mut self, visible: bool) {
        self.mcp.show(visible);
        self.plugins.show(visible);
    }
}

pub(crate) fn poll(s: &mut State, _tx: &mut rune::Tx) -> bool {
    if let crate::Screen::Launcher(launcher) = &s.screen {
        if let (Some(conn), Some(project)) = (&launcher.connection, &launcher.project)
            && !launcher.authentication_required
        {
            let mut backend = conn.clone();
            backend.workspace.clone_from(&project.id);
            backend.session.clear();
            backend.session_directory = None;
            s.status_services.bind(&backend);
            s.status_services.online(true);
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
    let plugins_changed = s.status_services.plugins.poll(&s.reads, &s.wake);
    mcp_changed || plugins_changed
}

pub(super) fn view(s: &State) -> impl IntoIterator<Item = El> {
    [mcp::view(s), plugins_view::view(s)].into_iter().flatten()
}
