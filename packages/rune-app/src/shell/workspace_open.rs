use crate::{
    State,
    platform::workspace_open::{self, WorkspaceTarget},
    shell::{notifications, shortcuts},
    strings::locale,
    workspace,
};
use codenomad_client::{Receiver, Sender, bounded};
use rune_theme_codenomad::catalogue;
use std::sync::Arc;

pub(crate) struct Host {
    owner: Arc<()>,
    out: Sender<(String, String)>,
    incoming: Receiver<(String, String)>,
}

impl Default for Host {
    fn default() -> Self {
        let (out, incoming) = bounded(8);
        Self {
            owner: Arc::new(()),
            out,
            incoming,
        }
    }
}

impl Host {
    pub(crate) fn cancel(&mut self) {
        self.owner = Arc::new(());
        while self.incoming.try_recv().is_ok() {}
    }
}

pub(crate) fn available() -> bool {
    workspace_open::AVAILABLE
}

pub(crate) fn can_open(s: &State) -> bool {
    if !available() || !shortcuts::has_project(s) {
        return false;
    }
    let local_launcher = s.screen.launcher().is_some_and(|l| {
        l.local_connection()
            && l.connection.is_some()
            && !l.authentication_required
            && l.project.is_some()
    });
    if !local_launcher {
        return false;
    }
    if s.workspace.is_some()
        && workspace::active_workspace(s).is_none_or(|(_, saved)| saved.backend_id.is_some())
    {
        return false;
    }
    true
}

pub(crate) fn open(s: &mut State, target: WorkspaceTarget) -> bool {
    if !can_open(s) {
        return false;
    }
    let Some((mut backend, project)) = s
        .screen
        .launcher()
        .and_then(|l| Some((l.connection.clone()?, l.project.clone()?)))
    else {
        return false;
    };
    backend.workspace = project.id.clone();
    let slug = crate::git::active_checkout_slug(s, &project.id);
    let expected_root = project.path;
    let owner = Arc::downgrade(&s.workspace_open.owner);
    let out = s.workspace_open.out.clone();
    let wake = s.wake.clone();
    let language = locale().to_owned();
    crate::platform::spawn(async move {
        if let Err(error) =
            workspace_open::open_workspace(backend, slug, expected_root, target, owner).await
        {
            let title = catalogue::format(&language, "commands.openWorkspace.failed.title", &[]);
            let message = catalogue::format(
                &language,
                "commands.openWorkspace.failed.message",
                &[("message", &error)],
            );
            if out.try_send((title, message)).is_ok() {
                wake();
            }
        }
    });
    true
}

pub(crate) fn poll(s: &mut State) -> bool {
    let mut changed = false;
    while let Ok((title, message)) = s.workspace_open.incoming.try_recv() {
        notifications::emit_outcome(
            s,
            notifications::Category::Files,
            Some(title),
            message,
            true,
        );
        changed = true;
    }
    changed
}
