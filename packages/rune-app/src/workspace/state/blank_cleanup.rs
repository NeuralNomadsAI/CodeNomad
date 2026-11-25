//! Automatic blank-session cleanup sweep (`autoCleanupBlankSessions`), matching Solid
//! `stores/blank-session-cleanup.ts` and `stores/session-state.ts:cleanupBlankSessions`.
use super::{Entry, State, Tab, Tx, Ui, same_project};
use crate::{
    backend::Backend,
    catalog::Project,
    settings,
    shell::notifications::{self, Category},
    strings::t,
};
use codenomad_client::{Receiver, Sender, TryRecvError, bounded};
use std::collections::{HashSet, VecDeque};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    Preflight,
    Dispatch,
}

struct InFlight {
    session_id: String,
    step: Step,
    reply: Receiver<bool>,
    _cancel: Sender<()>,
}

struct Sweep {
    backend: Backend,
    project: Project,
    generation: u64,
    exclude: String,
    candidates: VecDeque<String>,
    in_flight: Option<InFlight>,
    deleted_count: usize,
}

#[derive(Default)]
pub(super) struct Runner {
    sweep: Option<Sweep>,
}

impl Runner {
    pub(super) fn clear(&mut self) {
        self.sweep = None;
    }

    #[cfg(test)]
    pub(super) fn active(&self) -> bool {
        self.sweep.is_some()
    }
}

pub(crate) fn schedule(s: &mut State, exclude_session_id: &str) {
    if !settings::auto_cleanup_blank_sessions(s) {
        return;
    }
    let Some(l) = s.screen.launcher() else {
        return;
    };
    if l.authentication_required {
        return;
    }
    let (Some(backend), Some(project)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    let generation = l.catalogue_generation;
    let mut seen = HashSet::new();
    let mut candidates = VecDeque::new();
    for row in l.sessions.iter().chain(l.linked.rows.iter()) {
        if row.id != exclude_session_id
            && !row.id.starts_with("ses_cn_schedule_")
            && seen.insert(row.id.clone())
        {
            candidates.push_back(row.id.clone());
        }
    }
    if candidates.is_empty() {
        return;
    }
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let entry = &mut ui.entries[ui.active];
    if entry.project.as_ref().map(|p| p.id.as_str()) != Some(project.id.as_str()) {
        return;
    }
    if let Some(existing) = &entry.blank_cleanup.sweep
        && existing.project.id == project.id
        && existing.generation == generation
        && existing.backend.client.same_connection(&backend.client)
    {
        // One bounded sweep per connection generation, matching Solid `automaticCleanupRequests`.
        return;
    }
    entry.blank_cleanup.sweep = Some(Sweep {
        backend,
        project,
        generation,
        exclude: exclude_session_id.to_owned(),
        candidates,
        in_flight: None,
        deleted_count: 0,
    });
    (s.wake)();
}

fn entry_has_session(entry: &Entry, active: bool, s: &State, session_id: &str) -> bool {
    if active {
        s.screen.launcher().is_some_and(|l| {
            l.sessions.iter().any(|row| row.id == session_id)
                || l.linked.rows.iter().any(|row| row.id == session_id)
        })
    } else {
        entry.sessions.iter().any(|row| row.id == session_id)
            || entry.linked.rows.iter().any(|row| row.id == session_id)
    }
}

fn locally_protected(ui: &Ui, owner_index: usize, s: &State, session_id: &str) -> bool {
    let owner = &ui.entries[owner_index];
    if !entry_has_session(owner, owner_index == ui.active, s, session_id) {
        return true;
    }
    let owner_saved = match &owner.saved {
        Tab::Workspace(saved) => saved,
        Tab::Blank => return true,
    };
    if owner.idle_markers.is_working(session_id) {
        return true;
    }
    for entry in &ui.entries {
        let Tab::Workspace(saved) = &entry.saved else {
            continue;
        };
        if !same_project(owner_saved, saved) {
            continue;
        }
        if saved.active_session_id.as_deref() == Some(session_id) {
            return true;
        }
        if entry.has_local_draft(session_id) {
            return true;
        }
    }
    false
}

fn sweep_current(ui: &Ui, index: usize, s: &State, sweep: &Sweep) -> bool {
    let entry = &ui.entries[index];
    if entry.project.as_ref().map(|p| p.id.as_str()) != Some(sweep.project.id.as_str()) {
        return false;
    }
    let Some(l) = s.screen.launcher() else {
        return false;
    };
    if l.authentication_required || l.catalogue_generation != sweep.generation {
        return false;
    }
    l.connection
        .as_ref()
        .is_some_and(|conn| conn.client.same_connection(&sweep.backend.client))
}

fn remove_deleted_session(ui: &mut Ui, owner_index: usize, s: &mut State, session_id: &str) {
    let owner_saved = match &ui.entries[owner_index].saved {
        Tab::Workspace(saved) => saved.clone(),
        Tab::Blank => return,
    };
    for (index, entry) in ui.entries.iter_mut().enumerate() {
        let matches = match &entry.saved {
            Tab::Workspace(saved) => same_project(&owner_saved, saved),
            Tab::Blank => false,
        };
        if !matches {
            continue;
        }
        entry.idle_markers.remove(session_id);
        if index == ui.active {
            if let Some(l) = s.screen.launcher_mut() {
                l.sessions.retain(|row| row.id != session_id);
                l.linked.rows.retain(|row| row.id != session_id);
                l.listed_sessions.remove(session_id);
                l.search_results.rows.retain(|row| row.id != session_id);
                l.visits.forget(&[session_id.to_owned()]);
            }
        } else {
            entry.sessions.retain(|row| row.id != session_id);
            entry.linked.rows.retain(|row| row.id != session_id);
            entry.listed_sessions.remove(session_id);
            entry.visits.forget(&[session_id.to_owned()]);
        }
    }
}

fn spawn_step(
    s: &State,
    backend: Backend,
    project: Project,
    session_id: String,
    step: Step,
) -> InFlight {
    let (out, reply) = bounded(1);
    let (cancel, cancelled) = bounded(1);
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let sid = session_id.clone();
    crate::platform::spawn(async move {
        let work = async {
            let _permit = reads.background(&cancelled).await?;
            let ok = match step {
                Step::Preflight => backend
                    .preflight_blank_session(&project, &sid)
                    .await
                    .unwrap_or(false),
                Step::Dispatch => backend
                    .cleanup_blank_session(&project, &sid)
                    .await
                    .unwrap_or(false),
            };
            Some(ok)
        };
        let result = codenomad_client::runtime::until_closed(&out, work)
            .await
            .flatten();
        if let Some(ok) = result {
            let _ = out.try_send(ok);
            wake();
        }
    });
    InFlight {
        session_id,
        step,
        reply,
        _cancel: cancel,
    }
}

pub(super) fn poll(s: &mut State, ui: &mut Ui, _tx: &mut Tx) -> bool {
    let mut changed = false;
    let mut toasts: Vec<(Backend, usize)> = Vec::new();
    let mut removed: Vec<(usize, String)> = Vec::new();

    for index in 0..ui.entries.len() {
        let Some(mut sweep) = ui.entries[index].blank_cleanup.sweep.take() else {
            continue;
        };
        if !sweep_current(ui, index, s, &sweep) {
            continue;
        }

        if let Some(in_flight) = &sweep.in_flight
            && (in_flight.session_id == sweep.exclude
                || locally_protected(ui, index, s, &in_flight.session_id))
        {
            // Abort preflight or cleanup immediately if user opened, typed or attached.
            sweep.in_flight = None;
        }

        if let Some(in_flight) = sweep.in_flight.take() {
            match in_flight.reply.try_recv() {
                Ok(true) => match in_flight.step {
                    Step::Preflight => {
                        if in_flight.session_id != sweep.exclude
                            && !locally_protected(ui, index, s, &in_flight.session_id)
                        {
                            sweep.in_flight = Some(spawn_step(
                                s,
                                sweep.backend.clone(),
                                sweep.project.clone(),
                                in_flight.session_id,
                                Step::Dispatch,
                            ));
                        }
                    }
                    Step::Dispatch => {
                        sweep.deleted_count += 1;
                        removed.push((index, in_flight.session_id));
                        changed = true;
                    }
                },
                Ok(false) | Err(TryRecvError::Closed) => {}
                Err(TryRecvError::Empty) => {
                    sweep.in_flight = Some(in_flight);
                }
            }
        }

        while sweep.in_flight.is_none() {
            let Some(candidate) = sweep.candidates.pop_front() else {
                break;
            };
            if candidate == sweep.exclude || locally_protected(ui, index, s, &candidate) {
                continue;
            }
            sweep.in_flight = Some(spawn_step(
                s,
                sweep.backend.clone(),
                sweep.project.clone(),
                candidate,
                Step::Preflight,
            ));
        }

        if sweep.in_flight.is_some() {
            ui.entries[index].blank_cleanup.sweep = Some(sweep);
        } else if sweep.deleted_count > 0 {
            toasts.push((sweep.backend, sweep.deleted_count));
        }
    }

    for (index, session_id) in removed {
        remove_deleted_session(ui, index, s, &session_id);
    }
    for (backend, count) in toasts {
        let key = if count == 1 {
            "sessionState.cleanup.toast.one"
        } else {
            "sessionState.cleanup.toast.other"
        };
        let message = t(key).replace("{count}", &count.to_string());
        notifications::emit_from(s, backend, Category::Sessions, message, false);
        changed = true;
    }
    changed
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::{
        catalog::Session,
        platform,
        workspace::{self, Tab},
    };
    use serde_json::{Value, json};
    use std::time::{Duration, Instant};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn serve_cleanup_server(
        listener: TcpListener,
        non_empty_id: &'static str,
        deleted: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let deleted = deleted.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let Ok(n) = socket.read(&mut buf).await else {
                    return;
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let (status, body): (u16, Value) = if let Some(rest) =
                    first.strip_prefix("POST /api/workspaces/ws1/session-cleanup/")
                {
                    let sid = rest.split_whitespace().next().unwrap_or("");
                    deleted.lock().unwrap().push(sid.to_owned());
                    (200, json!({"deleted": true}))
                } else if first.contains(&format!("/api/session/{non_empty_id}/message?")) {
                    (200, json!({"data": [{"id": "msg_1"}], "cursor": {}}))
                } else if first.contains("/message?") {
                    (200, json!({"data": [], "cursor": {}}))
                } else if first.contains("/inbox") {
                    (200, json!({"data": []}))
                } else if first.contains("parentID=") {
                    (200, json!({"data": [], "cursor": {}}))
                } else if first.contains("/api/session/active") {
                    (200, json!({"data": {}}))
                } else if let Some(rest) =
                    first.strip_prefix("GET /workspaces/ws1/instance/api/session/")
                {
                    let sid = rest.split_whitespace().next().unwrap_or("");
                    (
                        200,
                        json!({"data": {"id": sid, "projectID": "proj1", "location": {"directory": "/repo"}, "time": {"updated": 1}}}),
                    )
                } else {
                    (404, json!({}))
                };
                let payload = body.to_string();
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
            });
        }
    }

    #[test]
    fn automatic_cleanup_sweeps_only_blank_unprotected_sessions_and_coalesces() {
        platform::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let deleted = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let server = tokio::spawn(serve_cleanup_server(listener, "ses_used", deleted.clone()));

            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = Project {
                id: "ws1".into(),
                path: "/repo".into(),
            };
            let mut state = crate::init();
            crate::gallery::shell::fixture(&mut state);
            state.workspace = Some(workspace::Ui::new());
            workspace::connected(&mut state);
            crate::settings::fixture_config(
                &mut state,
                json!({"settings": {"autoCleanupBlankSessions": true}}),
            );
            {
                let l = state.screen.launcher_mut().unwrap();
                l.connection = Some(backend);
                l.project = Some(project.clone());
                l.sessions = vec![
                    Session {
                        id: "ses_new".into(),
                        title: "New".into(),
                    },
                    Session {
                        id: "ses_blank".into(),
                        title: "Blank".into(),
                    },
                    Session {
                        id: "ses_draft".into(),
                        title: "Draft".into(),
                    },
                    Session {
                        id: "ses_used".into(),
                        title: "Used".into(),
                    },
                ];
            }
            workspace::opened(&mut state, &project);
            if let Some(ui) = &mut state.workspace
                && let Tab::Workspace(saved) = &mut ui.entries[ui.active].saved
            {
                saved.active_session_id = Some("ses_new".into());
                saved.drafts.insert("ses_draft".into(), "typed text".into());
            }

            let mut rt = rune::Runtime::new(
                state,
                crate::view,
                (1000.0, 800.0),
                rune::Env::new(false, 1.0),
            );
            rt.update(|s, _tx| {
                schedule(s, "ses_new");
                // Overlapping call on the same generation coalesces instead of resetting.
                schedule(s, "ses_new");
                assert!(
                    s.workspace.as_ref().unwrap().entries[0]
                        .blank_cleanup
                        .active()
                );
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while rt.state.workspace.as_ref().unwrap().entries[0]
                .blank_cleanup
                .active()
            {
                assert!(Instant::now() < deadline, "blank cleanup sweep timed out");
                rt.update(|s, tx| {
                    let Some(mut ui) = s.workspace.take() else {
                        return;
                    };
                    let _ = poll(s, &mut ui, tx);
                    s.workspace = Some(ui);
                });
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(deleted.lock().unwrap().as_slice(), ["ses_blank"]);
            let ids: Vec<_> = rt
                .state
                .screen
                .launcher()
                .unwrap()
                .sessions
                .iter()
                .map(|row| row.id.as_str())
                .collect();
            assert_eq!(ids, ["ses_new", "ses_draft", "ses_used"]);
            server.abort();
        });
    }

    #[test]
    fn disabled_or_unconfirmed_preference_never_schedules_cleanup() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        state.workspace = Some(workspace::Ui::new());
        workspace::connected(&mut state);
        let project = Project {
            id: "ws1".into(),
            path: "/repo".into(),
        };
        {
            let l = state.screen.launcher_mut().unwrap();
            l.connection = Some(Backend::unauthenticated("http://127.0.0.1:1/").unwrap());
            l.project = Some(project.clone());
            l.sessions = vec![
                Session {
                    id: "ses_new".into(),
                    title: "New".into(),
                },
                Session {
                    id: "ses_blank".into(),
                    title: "Blank".into(),
                },
            ];
        }
        workspace::opened(&mut state, &project);

        // Unconfirmed config does not schedule destructive cleanup.
        schedule(&mut state, "ses_new");
        assert!(
            !state.workspace.as_ref().unwrap().entries[0]
                .blank_cleanup
                .active()
        );

        // Confirmed false also skips cleanup.
        crate::settings::fixture_config(
            &mut state,
            json!({"settings": {"autoCleanupBlankSessions": false}}),
        );
        schedule(&mut state, "ses_new");
        assert!(
            !state.workspace.as_ref().unwrap().entries[0]
                .blank_cleanup
                .active()
        );
    }
}
