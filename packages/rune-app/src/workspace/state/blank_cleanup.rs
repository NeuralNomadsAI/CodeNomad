//! Automatic blank-session cleanup sweep (`autoCleanupBlankSessions`), matching Solid
//! `stores/blank-session-cleanup.ts` and `stores/session-state.ts:cleanupBlankSessions`.
use super::{Entry, State, Tab, Tx, Ui};
use crate::{
    backend::Backend,
    catalog::Project,
    settings,
    shell::notifications::{self, Category},
    strings::t,
};
use codenomad_client::{
    Receiver, Sender, TryRecvError, blank_session_cleanup::BlankCleanupError, bounded,
};
use std::collections::{HashSet, VecDeque};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    Preflight,
    Dispatch,
}

struct InFlight {
    session_id: String,
    step: Step,
    aborted: bool,
    cancel: Option<Sender<()>>,
    reply: Receiver<Result<bool, BlankCleanupError>>,
}

struct Sweep {
    backend: Backend,
    project: Project,
    watch_generation: Option<u64>,
    protected: HashSet<String>,
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
    let watch_generation = l.catalogue_watch.as_ref().map(|w| w.generation());
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
    if let Some(existing) = &mut entry.blank_cleanup.sweep
        && existing.project.id == project.id
        && existing.watch_generation == watch_generation
        && existing.backend.client.same_connection(&backend.client)
    {
        // Reuse the in-flight sweep on the same connection (matching Solid `automaticCleanupRequests`)
        // so creating another blank session never restarts a sweep that could delete the first one.
        existing.protected.insert(exclude_session_id.to_owned());
        return;
    }
    let mut protected = HashSet::new();
    protected.insert(exclude_session_id.to_owned());
    entry.blank_cleanup.sweep = Some(Sweep {
        backend,
        project,
        watch_generation,
        protected,
        candidates,
        in_flight: None,
        deleted_count: 0,
    });
    (s.wake)();
}

/// Returns `true` while an automatic `POST /session-cleanup/:sessionId` deletion is already
/// in flight on the server for `(project_id, session_id)`.
pub(crate) fn is_deleting_session(s: &State, project_id: &str, session_id: &str) -> bool {
    s.workspace.as_ref().is_some_and(|ui| {
        ui.entries.iter().any(|entry| {
            entry.blank_cleanup.sweep.as_ref().is_some_and(|sweep| {
                sweep.project.id == project_id
                    && sweep.in_flight.as_ref().is_some_and(|active| {
                        active.step == Step::Dispatch && active.session_id == session_id
                    })
            })
        })
    })
}

/// Synchronously aborts any in-flight automatic preflight targeting `session_id` (and removes it
/// from pending candidates) when the user selects or edits it. Once `POST` deletion has already
/// been dispatched, keep waiting for its authoritative server outcome.
pub(crate) fn abort_for_session(s: &mut State, session_id: &str) {
    let mut woke = false;
    if let Some(ui) = &mut s.workspace {
        for entry in &mut ui.entries {
            let Some(sweep) = entry.blank_cleanup.sweep.as_mut() else {
                continue;
            };
            sweep.protected.insert(session_id.to_owned());
            sweep.candidates.retain(|id| id != session_id);
            if let Some(active) = sweep.in_flight.as_mut()
                && active.step == Step::Preflight
                && active.session_id == session_id
            {
                active.cancel = None;
                active.reply.close();
                active.aborted = true;
                if active.reply.is_empty() {
                    sweep.in_flight = None;
                }
                woke = true;
            }
        }
    }
    if woke {
        (s.wake)();
    }
}

/// Synchronously aborts any automatic blank-cleanup sweep bound to `project_id`.
pub(crate) fn abort_for_project(s: &mut State, project_id: &str) {
    if let Some(ui) = &mut s.workspace {
        for entry in &mut ui.entries {
            if entry
                .blank_cleanup
                .sweep
                .as_ref()
                .is_some_and(|sweep| sweep.project.id == project_id)
            {
                entry.blank_cleanup.clear();
            }
        }
    }
}

/// Synchronously aborts any in-flight automatic preflight whose target just became locally
/// protected (draft, attachment, unconfirmed prompt, command receipt, or rebind).
pub(crate) fn abort_if_protected(s: &mut State) {
    let targets: Vec<String> = s
        .workspace
        .as_ref()
        .map(|ui| {
            ui.entries
                .iter()
                .enumerate()
                .filter_map(|(index, entry)| {
                    let sweep = entry.blank_cleanup.sweep.as_ref()?;
                    let active = sweep.in_flight.as_ref()?;
                    if active.step != Step::Preflight {
                        return None;
                    }
                    locally_protected(ui, index, s, &active.session_id)
                        .then(|| active.session_id.clone())
                })
                .collect()
        })
        .unwrap_or_default();
    for session_id in targets {
        abort_for_session(s, &session_id);
    }
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
    if !matches!(owner.saved, Tab::Workspace(_)) {
        return true;
    }
    super::cleanup::session_protected_in_workspace(s, ui, session_id)
}

fn handle_unauthorized(s: &mut State, backend: &Backend) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = crate::settings::authentication_required(s, backend);
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = backend;
        crate::platform::pairing::observe(s);
    }
}

fn sweep_current(ui: &Ui, index: usize, s: &State, sweep: &Sweep) -> bool {
    if !settings::auto_cleanup_blank_sessions(s) {
        return false;
    }
    let entry = &ui.entries[index];
    if entry.project.as_ref().map(|p| p.id.as_str()) != Some(sweep.project.id.as_str()) {
        return false;
    }
    let Some(l) = s.screen.launcher() else {
        return false;
    };
    if l.authentication_required
        || l.catalogue_watch.as_ref().map(|w| w.generation()) != sweep.watch_generation
    {
        return false;
    }
    l.connection
        .as_ref()
        .is_some_and(|conn| conn.client.same_connection(&sweep.backend.client))
}

fn remove_deleted_session(ui: &mut Ui, _owner_index: usize, s: &mut State, session_id: &str) {
    for (index, entry) in ui.entries.iter_mut().enumerate() {
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
    let (cancel, cancelled) = bounded::<()>(1);
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let sid = session_id.clone();
    crate::platform::spawn(async move {
        let work = async {
            let _permit = reads.background(&cancelled).await?;
            match step {
                Step::Preflight => {
                    backend
                        .verify_blank_session_cancellable(&project, &sid, &cancelled)
                        .await
                }
                Step::Dispatch => {
                    backend
                        .delete_blank_session_cancellable(&project, &sid, &cancelled)
                        .await
                }
            }
        };
        if let Some(outcome) = codenomad_client::runtime::until_closed(&out, work)
            .await
            .flatten()
            && !cancelled.is_closed()
            && out.try_send(outcome).is_ok()
        {
            wake();
        }
    });
    InFlight {
        session_id,
        step,
        aborted: false,
        cancel: Some(cancel),
        reply,
    }
}

pub(super) fn poll(s: &mut State, ui: &mut Ui, _tx: &mut Tx) -> bool {
    let mut changed = false;
    let mut toasts: Vec<(Backend, usize)> = Vec::new();
    let mut removed: Vec<(usize, String)> = Vec::new();
    let mut unauthorized: Vec<Backend> = Vec::new();

    for index in 0..ui.entries.len() {
        let Some(mut sweep) = ui.entries[index].blank_cleanup.sweep.take() else {
            continue;
        };
        if !sweep_current(ui, index, s, &sweep) {
            continue;
        }

        if let Some(in_flight) = sweep.in_flight.as_mut()
            && in_flight.step == Step::Preflight
            && (sweep.protected.contains(&in_flight.session_id)
                || locally_protected(ui, index, s, &in_flight.session_id))
        {
            // Cancel HTTP preflight and close `reply` atomically before reading any queued
            // outcome so a received 401 is preserved while a completed preflight never posts.
            in_flight.cancel = None;
            in_flight.reply.close();
            in_flight.aborted = true;
        }

        let mut stop_sweep = false;
        if let Some(in_flight) = sweep.in_flight.take() {
            match in_flight.reply.try_recv() {
                Ok(Err(BlankCleanupError::Unauthorized)) => {
                    unauthorized.push(sweep.backend);
                    continue;
                }
                Ok(Err(err)) if err.is_unavailable() => {
                    stop_sweep = true;
                }
                Ok(Ok(true)) => match in_flight.step {
                    Step::Preflight => {
                        if !in_flight.aborted
                            && !sweep.protected.contains(&in_flight.session_id)
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
                Ok(Ok(false)) | Ok(Err(_)) => {}
                Err(TryRecvError::Closed) => {
                    if !in_flight.aborted {
                        stop_sweep = true;
                    }
                }
                Err(TryRecvError::Empty) => {
                    sweep.in_flight = Some(in_flight);
                }
            }
        }

        if stop_sweep {
            sweep.candidates.clear();
        }

        while sweep.in_flight.is_none() {
            let Some(candidate) = sweep.candidates.pop_front() else {
                break;
            };
            if sweep.protected.contains(&candidate) || locally_protected(ui, index, s, &candidate) {
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
    for backend in unauthorized {
        handle_unauthorized(s, &backend);
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
                temporary: false,
            };
            let mut state = crate::init();
            crate::gallery::shell::fixture(&mut state);
            state.workspace = Some(workspace::Ui::new());
            workspace::connected(&mut state);
            crate::settings::fixture_config_doc(
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
            temporary: false,
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
        crate::settings::fixture_config_doc(
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

    #[test]
    fn closed_tab_and_linked_tab_drafts_protect_blank_sessions() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        let mut ui = workspace::Ui::new();
        ui.fixture_hydrate(workspace::Snapshot {
            revision: 1,
            saved_at: 1,
            panel_widths: [None; 2],
            file_wrap: None,
            tabs: vec![
                Tab::Workspace(workspace::Workspace {
                    backend_id: None,
                    server_id: None,
                    folder: "/repo".into(),
                    project_name: None,
                    temporary: false,
                    occurrence: 0,
                    workspace_id: Some("ws1".into()),
                    active_session_id: Some("ses_new".into()),
                    drafts: Default::default(),
                    attachment_drafts: Default::default(),
                    attachment_parts: Default::default(),
                    view: Default::default(),
                }),
                Tab::Workspace(workspace::Workspace {
                    backend_id: None,
                    server_id: None,
                    folder: "/repo-wt".into(),
                    project_name: None,
                    temporary: false,
                    occurrence: 0,
                    workspace_id: Some("ws2".into()),
                    active_session_id: Some("ses_linked_open".into()),
                    drafts: [("ses_linked_draft".into(), "wip".into())].into(),
                    attachment_drafts: Default::default(),
                    attachment_parts: Default::default(),
                    view: Default::default(),
                }),
            ],
            active: Some(0),
        });
        ui.fixture_ready();
        ui.closed.push(workspace::Workspace {
            backend_id: None,
            server_id: None,
            folder: "/repo".into(),
            project_name: None,
            temporary: false,
            occurrence: 1,
            workspace_id: Some("ws1".into()),
            active_session_id: None,
            drafts: [("ses_closed_draft".into(), "saved draft".into())].into(),
            attachment_drafts: Default::default(),
            attachment_parts: Default::default(),
            view: Default::default(),
        });
        state.workspace = Some(ui);
        if let Some(l) = state.screen.launcher_mut() {
            l.sessions = vec![
                Session {
                    id: "ses_new".into(),
                    title: "New".into(),
                },
                Session {
                    id: "ses_closed_draft".into(),
                    title: "Closed".into(),
                },
                Session {
                    id: "ses_free".into(),
                    title: "Free".into(),
                },
            ];
            l.linked.rows = vec![
                Session {
                    id: "ses_linked_open".into(),
                    title: "Linked Open".into(),
                },
                Session {
                    id: "ses_linked_draft".into(),
                    title: "Linked Draft".into(),
                },
            ];
        }
        let ui_ref = state.workspace.as_ref().unwrap();
        assert!(locally_protected(ui_ref, 0, &state, "ses_closed_draft"));
        assert!(locally_protected(ui_ref, 0, &state, "ses_linked_open"));
        assert!(locally_protected(ui_ref, 0, &state, "ses_linked_draft"));
        assert!(!locally_protected(ui_ref, 0, &state, "ses_free"));
    }

    #[test]
    fn disabling_auto_cleanup_mid_sweep_aborts_sweep() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        state.workspace = Some(workspace::Ui::new());
        workspace::connected(&mut state);
        crate::settings::fixture_config_doc(
            &mut state,
            json!({"settings": {"autoCleanupBlankSessions": true}}),
        );
        let project = Project {
            id: "ws1".into(),
            path: "/repo".into(),
            temporary: false,
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
        schedule(&mut state, "ses_new");
        assert!(
            state.workspace.as_ref().unwrap().entries[0]
                .blank_cleanup
                .active()
        );
        crate::settings::fixture_config_doc(
            &mut state,
            json!({"settings": {"autoCleanupBlankSessions": false}}),
        );
        let mut rt = rune::Runtime::new(
            state,
            crate::view,
            (1000.0, 800.0),
            rune::Env::new(false, 1.0),
        );
        rt.update(|s, tx| {
            let mut ui = s.workspace.take().unwrap();
            let _ = poll(s, &mut ui, tx);
            s.workspace = Some(ui);
        });
        assert!(
            !rt.state.workspace.as_ref().unwrap().entries[0]
                .blank_cleanup
                .active()
        );
    }

    #[test]
    fn second_session_creation_reuses_active_sweep_and_protects_both_new_sessions() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        state.workspace = Some(workspace::Ui::new());
        workspace::connected(&mut state);
        crate::settings::fixture_config_doc(
            &mut state,
            json!({"settings": {"autoCleanupBlankSessions": true}}),
        );
        let project = Project {
            id: "ws1".into(),
            path: "/repo".into(),
            temporary: false,
        };
        {
            let l = state.screen.launcher_mut().unwrap();
            l.connection = Some(Backend::unauthenticated("http://127.0.0.1:1/").unwrap());
            l.project = Some(project.clone());
            l.sessions = vec![
                Session {
                    id: "ses_old".into(),
                    title: "Old".into(),
                },
                Session {
                    id: "ses_new_1".into(),
                    title: "New 1".into(),
                },
            ];
        }
        workspace::opened(&mut state, &project);
        schedule(&mut state, "ses_new_1");

        // Creating a second session bumps catalogue_generation and adds ses_new_2.
        {
            let l = state.screen.launcher_mut().unwrap();
            l.catalogue_generation += 1;
            l.sessions.push(Session {
                id: "ses_new_2".into(),
                title: "New 2".into(),
            });
        }
        schedule(&mut state, "ses_new_2");

        let sweep = state.workspace.as_ref().unwrap().entries[0]
            .blank_cleanup
            .sweep
            .as_ref()
            .expect("sweep reused");
        assert!(sweep.protected.contains("ses_new_1"));
        assert!(sweep.protected.contains("ses_new_2"));
        assert_eq!(
            sweep.candidates.iter().cloned().collect::<Vec<_>>(),
            vec!["ses_old"]
        );
    }

    #[test]
    fn auto_cleanup_aborts_preflight_on_selection_and_blocks_reopen_during_dispatch() {
        platform::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (preflight_seen_tx, preflight_seen_rx) = tokio::sync::oneshot::channel::<()>();
            let (dispatch_seen_tx, dispatch_seen_rx) = tokio::sync::oneshot::channel::<()>();
            let (dispatch_release_tx, dispatch_release_rx) = tokio::sync::oneshot::channel::<()>();
            let preflight_seen_tx =
                std::sync::Arc::new(std::sync::Mutex::new(Some(preflight_seen_tx)));
            let dispatch_seen_tx =
                std::sync::Arc::new(std::sync::Mutex::new(Some(dispatch_seen_tx)));
            let dispatch_release_rx =
                std::sync::Arc::new(tokio::sync::Mutex::new(Some(dispatch_release_rx)));
            let posted = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

            let server = {
                let posted = posted.clone();
                tokio::spawn(async move {
                    loop {
                        let Ok((mut socket, _)) = listener.accept().await else {
                            break;
                        };
                        let preflight_seen_tx = preflight_seen_tx.clone();
                        let dispatch_seen_tx = dispatch_seen_tx.clone();
                        let dispatch_release_rx = dispatch_release_rx.clone();
                        let posted = posted.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 4096];
                            let Ok(n) = socket.read(&mut buf).await else {
                                return;
                            };
                            let req = String::from_utf8_lossy(&buf[..n]);
                            let first = req.lines().next().unwrap_or("");
                            if first.contains("/api/session/ses_preflight/message?") {
                                if let Some(tx) = preflight_seen_tx.lock().unwrap().take() {
                                    let _ = tx.send(());
                                }
                                // Hold connection open until client cancels preflight.
                                let mut drain = [0u8; 64];
                                let _ = socket.read(&mut drain).await;
                                return;
                            }
                            if let Some(rest) =
                                first.strip_prefix("POST /api/workspaces/ws1/session-cleanup/")
                            {
                                let sid = rest.split_whitespace().next().unwrap_or("");
                                posted.lock().unwrap().push(sid.to_owned());
                                if sid == "ses_dispatch" {
                                    if let Some(tx) = dispatch_seen_tx.lock().unwrap().take() {
                                        let _ = tx.send(());
                                    }
                                    if let Some(rx) = dispatch_release_rx.lock().await.take() {
                                        let _ = rx.await;
                                    }
                                }
                                let payload = r#"{"deleted":true}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                                    payload.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                return;
                            }
                            let body: Value = if first.contains("/message?") {
                                json!({"data": [], "cursor": {}})
                            } else if first.contains("/inbox") {
                                json!({"data": []})
                            } else if first.contains("parentID=") {
                                json!({"data": [], "cursor": {}})
                            } else if first.contains("/api/session/active") {
                                json!({"data": {}})
                            } else if let Some(rest) =
                                first.strip_prefix("GET /workspaces/ws1/instance/api/session/")
                            {
                                let sid = rest.split_whitespace().next().unwrap_or("");
                                json!({"data": {"id": sid, "projectID": "proj1", "location": {"directory": "/repo"}, "time": {"updated": 1}}})
                            } else {
                                json!({})
                            };
                            let payload = body.to_string();
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                                payload.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        });
                    }
                })
            };

            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = Project {
                id: "ws1".into(),
                path: "/repo".into(),
                temporary: false,
            };
            let mut state = crate::init();
            crate::gallery::shell::fixture(&mut state);
            state.workspace = Some(workspace::Ui::new());
            workspace::connected(&mut state);
            crate::settings::fixture_config_doc(
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
                        id: "ses_preflight".into(),
                        title: "Preflight".into(),
                    },
                    Session {
                        id: "ses_dispatch".into(),
                        title: "Dispatch".into(),
                    },
                ];
            }
            workspace::opened(&mut state, &project);
            let mut rt = rune::Runtime::new(
                state,
                crate::view,
                (1000.0, 800.0),
                rune::Env::new(false, 1.0),
            );
            rt.update(|s, tx| {
                schedule(s, "ses_new");
                let mut ui = s.workspace.take().unwrap();
                let _ = poll(s, &mut ui, tx);
                s.workspace = Some(ui);
            });
            tokio::time::timeout(Duration::from_secs(5), preflight_seen_rx)
                .await
                .expect("preflight did not start")
                .unwrap();

            // Synchronously abort preflight as navigation does when selecting a session.
            rt.update(|s, _tx| {
                crate::shell::blank_cleanup::abort_for_session(s, "ses_preflight");
            });

            // Drive sweep until ses_dispatch enters in-flight POST deletion.
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut dispatch_seen_rx = Some(dispatch_seen_rx);
            while dispatch_seen_rx.is_some() {
                assert!(Instant::now() < deadline, "dispatch did not start");
                rt.update(|s, tx| {
                    let mut ui = s.workspace.take().unwrap();
                    let _ = poll(s, &mut ui, tx);
                    s.workspace = Some(ui);
                });
                if let Some(rx) = dispatch_seen_rx.as_mut()
                    && rx.try_recv().is_ok()
                {
                    dispatch_seen_rx = None;
                } else {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }

            // Reopen guard must block selecting ses_dispatch while POST is in flight, and
            // abort_for_session / poll must NOT drop the in-flight POST outcome.
            assert!(crate::shell::blank_cleanup::is_deleting_session(
                &rt.state,
                "ws1",
                "ses_dispatch"
            ));
            rt.update(|s, tx| {
                crate::shell::blank_cleanup::abort_for_session(s, "ses_dispatch");
                let mut ui = s.workspace.take().unwrap();
                let _ = poll(s, &mut ui, tx);
                s.workspace = Some(ui);
            });
            assert!(crate::shell::blank_cleanup::is_deleting_session(
                &rt.state,
                "ws1",
                "ses_dispatch"
            ));

            let _ = dispatch_release_tx.send(());
            let finish_deadline = Instant::now() + Duration::from_secs(5);
            while rt.state.workspace.as_ref().unwrap().entries[0]
                .blank_cleanup
                .active()
            {
                assert!(Instant::now() < finish_deadline, "dispatch did not finish");
                rt.update(|s, tx| {
                    let mut ui = s.workspace.take().unwrap();
                    let _ = poll(s, &mut ui, tx);
                    s.workspace = Some(ui);
                });
                tokio::time::sleep(Duration::from_millis(5)).await;
            }

            assert_eq!(posted.lock().unwrap().as_slice(), ["ses_dispatch"]);
            let ids: Vec<_> = rt
                .state
                .screen
                .launcher()
                .unwrap()
                .sessions
                .iter()
                .map(|row| row.id.as_str())
                .collect();
            assert_eq!(ids, ["ses_new", "ses_preflight"]);
            server.abort();
        });
    }

    #[test]
    fn auto_cleanup_protects_rebind_and_pending_drafts() {
        let mut state = crate::init();
        crate::gallery::shell::fixture(&mut state);
        state.workspace = Some(workspace::Ui::new());
        workspace::connected(&mut state);
        let project = Project {
            id: "ws1".into(),
            path: "/repo".into(),
            temporary: false,
        };
        {
            let l = state.screen.launcher_mut().unwrap();
            l.connection = Some(Backend::unauthenticated("http://127.0.0.1:1/").unwrap());
            l.project = Some(project.clone());
            l.sessions = vec![
                Session {
                    id: "ses_rebind".into(),
                    title: "Rebind".into(),
                },
                Session {
                    id: "ses_pending".into(),
                    title: "Pending".into(),
                },
                Session {
                    id: "ses_free".into(),
                    title: "Free".into(),
                },
            ];
            l.rebind_after_send = Some("ses_rebind".into());
        }
        workspace::opened(&mut state, &project);
        state.workspace.as_mut().unwrap().entries[0]
            .pending_drafts
            .insert("ses_pending".into());
        let ui = state.workspace.as_ref().unwrap();
        assert!(locally_protected(ui, 0, &state, "ses_rebind"));
        assert!(locally_protected(ui, 0, &state, "ses_pending"));
        assert!(!locally_protected(ui, 0, &state, "ses_free"));
    }

    #[test]
    fn auto_cleanup_stops_on_unauthorized_and_unavailable_outages() {
        for status in [401u16, 503u16] {
            platform::block_on(async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
                let server = {
                    let seen = seen.clone();
                    tokio::spawn(async move {
                        loop {
                            let Ok((mut socket, _)) = listener.accept().await else {
                                break;
                            };
                            let seen = seen.clone();
                            tokio::spawn(async move {
                                let mut buf = vec![0u8; 4096];
                                let Ok(n) = socket.read(&mut buf).await else {
                                    return;
                                };
                                let req = String::from_utf8_lossy(&buf[..n]);
                                let first = req.lines().next().unwrap_or("").to_owned();
                                seen.lock().unwrap().push(first);
                                let payload = r#"{"error":"failed"}"#;
                                let resp = format!(
                                    "HTTP/1.1 {status} ERR\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                                    payload.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                            });
                        }
                    })
                };

                let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
                let project = Project {
                    id: "ws1".into(),
                    path: "/repo".into(),
                    temporary: false,
                };
                let mut state = crate::init();
                crate::gallery::shell::fixture(&mut state);
                state.workspace = Some(workspace::Ui::new());
                workspace::connected(&mut state);
                crate::settings::fixture_config_doc(
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
                            id: "ses_first".into(),
                            title: "First".into(),
                        },
                        Session {
                            id: "ses_second".into(),
                            title: "Second".into(),
                        },
                    ];
                }
                workspace::opened(&mut state, &project);
                let mut rt = rune::Runtime::new(
                    state,
                    crate::view,
                    (1000.0, 800.0),
                    rune::Env::new(false, 1.0),
                );
                rt.update(|s, _tx| schedule(s, "ses_new"));

                let deadline = Instant::now() + Duration::from_secs(5);
                while rt.state.workspace.as_ref().unwrap().entries[0]
                    .blank_cleanup
                    .active()
                {
                    assert!(Instant::now() < deadline, "sweep timed out for {status}");
                    rt.update(|s, tx| {
                        let mut ui = s.workspace.take().unwrap();
                        let _ = poll(s, &mut ui, tx);
                        s.workspace = Some(ui);
                    });
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }

                let requests = seen.lock().unwrap().clone();
                assert_eq!(requests.len(), 1, "must stop immediately on HTTP {status}");
                assert!(requests[0].contains("ses_first"));
                assert_eq!(
                    rt.state.screen.launcher().unwrap().authentication_required,
                    status == 401
                );
                server.abort();
            });
        }
    }
}
