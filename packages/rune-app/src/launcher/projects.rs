use super::{Launcher, Reply, Restored, State, TextEdit, Tx};
use crate::catalog::{Project, SessionMissing};

pub(crate) fn set_project(l: &mut Launcher, project: Option<Project>) {
    if l.project.as_ref().map(|p| &p.id) != project.as_ref().map(|p| &p.id) {
        l.search_results = Default::default();
        l.linked = Default::default();
        l.adopt_recovered_for = None;
    }
    l.project = project;
}

pub fn choose_project(s: &mut State, path: &str, tx: &mut Tx) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    l.folder = TextEdit::new(path);
    open(s, tx);
}
pub fn open(s: &mut State, tx: &mut Tx) {
    if !crate::workspace::input_ready(s) {
        return;
    }
    if !crate::workspace::prepare_open(s, tx) {
        if let Some(l) = s.screen.launcher_mut() {
            l.error = Some("rune.open_error");
        }
        return;
    }
    let intent = s
        .workspace
        .as_ref()
        .map(|ui| ui.active_key().to_string())
        .unwrap_or_else(|| "launcher".into());
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let Some(b) = l.connection.clone() else {
        return;
    };
    if l.pending {
        return;
    }
    let pending = match l.openings.begin(b.clone(), &intent) {
        Ok(pending) => pending,
        Err(_) => {
            l.error = Some("rune.open_error");
            return;
        }
    };
    let folder = l.folder.text.trim().to_string();
    l.job("rune.open_error", async move {
        let opening = pending.create(&folder).await?;
        let rows = b.sessions(&opening.project, None).await?;
        Ok(Reply::Opened(opening, rows, Restored::Empty))
    });
}

pub fn open_temporary_folder(
    s: &mut State,
    created: codenomad_client::temporary_workspaces::CreatedTemporaryFolder,
    tx: &mut Tx,
) -> bool {
    if !crate::workspace::input_ready(s) {
        return false;
    }
    if !crate::workspace::prepare_open(s, tx) {
        if let Some(l) = s.screen.launcher_mut() {
            l.error = Some("rune.open_error");
        }
        return false;
    }
    let intent = s
        .workspace
        .as_ref()
        .map(|ui| ui.active_key().to_string())
        .unwrap_or_else(|| "launcher".into());
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    let Some(b) = l.connection.clone() else {
        return false;
    };
    if l.pending {
        return false;
    }
    let pending = match l.openings.begin(b.clone(), &intent) {
        Ok(pending) => pending,
        Err(_) => {
            l.error = Some("rune.open_error");
            return false;
        }
    };
    let request_id = pending.request_id().to_owned();
    let cleanup_req = created
        .supports_cancel_and_abandon
        .then(|| request_id.clone());
    l.pending_temporary_cleanup = Some((b.clone(), created.path.clone(), cleanup_req));
    l.folder = TextEdit::new(&created.path);
    l.job("rune.open_error", async move {
        let mut opening = match pending.create(&created.path).await {
            Ok(opening) => opening,
            Err(err) => {
                let _ = b
                    .abandon_temporary_folder(
                        &created.path,
                        created
                            .supports_cancel_and_abandon
                            .then_some(request_id.as_str()),
                    )
                    .await;
                return Err(err);
            }
        };
        opening.project.temporary = true;
        let rows = match b.sessions(&opening.project, None).await {
            Ok(rows) => rows,
            Err(err) => {
                let _ = b
                    .abandon_temporary_folder(
                        &created.path,
                        created
                            .supports_cancel_and_abandon
                            .then_some(request_id.as_str()),
                    )
                    .await;
                return Err(err);
            }
        };
        Ok(Reply::Opened(opening, rows, Restored::Empty))
    });
    true
}

pub fn restore(s: &mut State, saved: crate::workspace::Workspace) {
    let intent = s
        .workspace
        .as_ref()
        .map(|ui| ui.active_key().to_string())
        .unwrap_or_else(|| "launcher".into());
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.pending {
        return;
    }
    let Some(backend) = l.connection.clone() else {
        return;
    };
    if l.server_id.is_none() && backend.client.needs_capability_recheck() {
        return;
    }
    let local = l.local_connection();
    let identity = if local {
        saved.backend_id.is_none()
    } else {
        saved.backend_id.as_deref()
            == Some(if cfg!(target_arch = "wasm32") {
                "web"
            } else {
                "external"
            })
            && saved.server_id.is_some()
            && saved.server_id == l.server_id
    };
    if !identity {
        l.error = Some("rune.restore_error");
        return;
    }
    let pending = match l.openings.begin(backend.clone(), &intent) {
        Ok(pending) => pending,
        Err(_) => {
            l.error = Some("rune.restore_error");
            return;
        }
    };
    l.job("rune.restore_error", async move {
        let opening = pending.create(&saved.folder).await?;
        let rows = backend.sessions(&opening.project, None).await?;
        let bound = if let Some(id) = &saved.active_session_id {
            match backend
                .bind_session_placed(&opening.project, id, false)
                .await
            {
                Ok((bound, session, slug)) => Restored::Bound(bound, session.title, slug),
                Err(err) if err.is::<SessionMissing>() => Restored::Missing(
                    id.clone(),
                    err.downcast_ref::<SessionMissing>()
                        .is_some_and(|reason| reason.is_deleted()),
                ),
                Err(err) => return Err(err),
            }
        } else {
            Restored::Empty
        };
        Ok(Reply::Opened(opening, rows, bound))
    });
    l.pending_restore_intent = Some(intent);
}
