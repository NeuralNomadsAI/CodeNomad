mod drafts;
mod missions;
mod restoration;
mod tabs;

use super::*;
use crate::{Phase, init};
use codenomad_client::{bounded, http::Http};
use std::collections::BTreeMap;

fn workspace(id: &str, draft: &str) -> Workspace {
    Workspace {
        backend_id: None,
        server_id: None,
        folder: "/fixture".into(),
        project_name: None,
        temporary: false,
        occurrence: 0,
        workspace_id: None,
        active_session_id: Some(id.into()),
        drafts: BTreeMap::from([(id.into(), draft.into())]),
        attachment_drafts: Default::default(),
        attachment_parts: Default::default(),
        view: Default::default(),
    }
}
fn backend(session: &str) -> Backend {
    Backend {
        client: Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "fixture".into(),
        session: session.into(),
        client_id: "fixture".into(),
        session_directory: None,
        fresh_mode: false,
    }
}
fn runtime(s: State) -> rune::Runtime<State> {
    rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0))
}

fn draft_state() -> State {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    let mut l = crate::launcher::Launcher::fixture();
    l.connection = Some(backend(""));
    l.server_id = Some("trial-server".into());
    s.screen = crate::Screen::Chat { launcher: Some(l) };
    s.workspace = Some(ui);
    opened(
        &mut s,
        &Project {
            id: "project".into(),
            path: "/fixture".into(),
            temporary: false,
        },
    );
    s
}
