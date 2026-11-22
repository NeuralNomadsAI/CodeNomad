//! Browser recovery replaces the captured occurrence, keeping the active editor and transcript.
use super::{Reply, attach, set_project};
use crate::{
    Phase, State,
    backend::Backend,
    workspace::{self, opening::Opening},
};

pub(crate) fn reopen(s: &mut State) -> bool {
    if s.screen.launcher().is_some_and(|l| l.pending) {
        return false;
    }
    if schedule(s).is_none() {
        s.phase = Phase::RestoreFailed;
    }
    true
}

fn schedule(s: &mut State) -> Option<()> {
    let (intent, saved) = workspace::active_workspace(s)?;
    let (intent, folder) = (intent.to_owned(), saved.folder.clone());
    let (server, session, old_id) = (
        saved.server_id.clone()?,
        saved.active_session_id.clone()?,
        saved.workspace_id.clone()?,
    );
    let l = s.screen.launcher_mut()?;
    let backend = l
        .connection
        .clone()
        .filter(|_| l.server_id.as_ref() == Some(&server))?;
    let pending = l.openings.begin(backend.clone(), &intent).ok()?;
    l.job("rune.restore_error", async move {
        if backend.server_id().await? != server || !backend.workspace_missing(&old_id).await? {
            return Err("workspace authority changed".into());
        }
        let opening = pending.create(&folder).await?;
        if !codenomad_client::same_server_path(&folder, &opening.project.path)
            || opening.project.id == old_id
        {
            return Err("workspace restoration identity mismatch".into());
        }
        let (backend, session) = backend
            .bind_at(&opening.project, &session, None, false)
            .await?;
        Ok(Reply::Reopened(opening, backend, session.title))
    });
    s.commands = None;
    s.incoming = None;
    s.paging = false;
    s.can_older = false;
    s.history_error = false;
    s.phase = Phase::Reconnecting;
    Some(())
}

pub(super) fn apply(s: &mut State, opening: Opening, backend: Backend, title: String) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let project = opening.project.clone();
    if opening.adopt().is_err() {
        s.phase = Phase::RestoreFailed;
        return;
    }
    set_project(l, Some(project.clone()));
    l.sessions.clear();
    l.next = None;
    workspace::capture(s);
    workspace::opened(s, &project);
    workspace::bound(s, &backend);
    crate::files::bind(s, &backend);
    s.chat_title = title;
    s.renew_scope();
    attach(s, backend);
    workspace::capture(s);
}
