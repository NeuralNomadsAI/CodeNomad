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
    generation: u64,
    out: Sender<(u64, String, String)>,
    incoming: Receiver<(u64, String, String)>,
}

impl Default for Host {
    fn default() -> Self {
        let (out, incoming) = bounded(8);
        Self {
            owner: Arc::new(()),
            generation: 0,
            out,
            incoming,
        }
    }
}

impl Host {
    pub(crate) fn cancel(&mut self) {
        self.owner = Arc::new(());
        self.generation = self.generation.wrapping_add(1);
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
    let Some(project) = s.screen.launcher().and_then(|l| {
        (l.local_connection() && l.connection.is_some() && !l.authentication_required)
            .then_some(l.project.as_ref())
            .flatten()
    }) else {
        return false;
    };
    if s.workspace.is_some()
        && workspace::active_workspace(s).is_none_or(|(_, saved)| saved.backend_id.is_some())
    {
        return false;
    }
    crate::git::conversation_checkout(s, &project.id, &project.path).is_some()
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
    let Some((slug, expected_dir)) =
        crate::git::conversation_checkout(s, &project.id, &project.path)
    else {
        return false;
    };
    backend.workspace = project.id.clone();
    let owner = Arc::downgrade(&s.workspace_open.owner);
    let generation = s.workspace_open.generation;
    let out = s.workspace_open.out.clone();
    let wake = s.wake.clone();
    let language = locale().to_owned();
    crate::platform::spawn(async move {
        if let Err(error) =
            workspace_open::open_workspace(backend, slug, expected_dir, target, owner.clone()).await
        {
            if owner.strong_count() == 0 {
                return;
            }
            let title = catalogue::format(&language, "commands.openWorkspace.failed.title", &[]);
            let message = catalogue::format(
                &language,
                "commands.openWorkspace.failed.message",
                &[("message", &error)],
            );
            if out.try_send((generation, title, message)).is_ok() {
                wake();
            }
        }
    });
    true
}

pub(crate) fn poll(s: &mut State) -> bool {
    let mut changed = false;
    let current = s.workspace_open.generation;
    while let Ok((generation, title, message)) = s.workspace_open.incoming.try_recv() {
        if generation != current {
            continue;
        }
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

#[cfg(test)]
pub(crate) fn inject_error_for_test(
    s: &State,
    generation: u64,
    title: impl Into<String>,
    message: impl Into<String>,
) {
    let _ = s
        .workspace_open
        .out
        .try_send((generation, title.into(), message.into()));
}

#[cfg(test)]
pub(crate) fn generation_for_test(s: &State) -> u64 {
    s.workspace_open.generation
}
