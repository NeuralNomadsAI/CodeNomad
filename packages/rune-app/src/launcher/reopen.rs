//! Browser recovery replaces the captured occurrence, keeping the active editor and transcript.
use super::{Reply, sessions::attach};
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
        if let Some(agent) = s.agent.as_mut() {
            agent.mark_scope_missing();
        }
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
        let (backend, session, slug) = backend
            .bind_session_placed(&opening.project, &session, false)
            .await?;
        Ok(Reply::Reopened(opening, backend, session.title, slug))
    });
    s.commands = None;
    s.incoming = None;
    s.paging = false;
    s.can_older = false;
    s.history_error = false;
    s.phase = Phase::Reconnecting;
    Some(())
}

pub(super) fn apply(s: &mut State, opening: Opening, backend: Backend, title: String, slug: &str) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let project = opening.project.clone();
    if opening.adopt().is_err() {
        s.phase = Phase::RestoreFailed;
        if let Some(agent) = s.agent.as_mut() {
            agent.mark_scope_missing();
        }
        return;
    }
    l.project = Some(project.clone());
    l.linked = Default::default();
    l.sessions.clear();
    l.listed_sessions.clear();
    l.next = None;
    l.consumed_cursors.clear();
    workspace::capture(s);
    workspace::opened(s, &project);
    workspace::bound(s, &backend);
    s.transcript_display
        .bind(&backend.base, &backend.workspace, &backend.session);
    crate::files::bind(s, &backend);
    crate::git::connected_placed(s, &backend, slug);
    workspace::restore_files_mode(s);
    if let Some(agent) = &mut s.agent {
        agent.rebind(crate::agent::start(backend.clone(), s.wake.clone()));
    }
    s.chat_title = title;
    s.renew_scope();
    attach(s, backend);
    workspace::capture(s);
    super::list(s, false);
}
