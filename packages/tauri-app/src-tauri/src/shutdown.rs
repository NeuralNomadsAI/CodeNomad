use crate::native_request::RequestFence;
use crate::{client_state, local_windows::LocalWindows, AppState};
use std::collections::{HashMap, HashSet};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
#[cfg(windows)]
use tauri::WebviewWindow;
use tauri::{AppHandle, Emitter, Manager};

const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
const CLOSE_CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const UPDATE_RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(10);
const IPC_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_STOP_ATTEMPTS: usize = 2;
const FLUSH_CANCELLED_EVENT: &str = "client-state:flush-cancelled";
#[cfg(windows)]
const WINDOWS_SESSION_END_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(windows)]
const WINDOWS_SESSION_END_STOP_RESERVE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingClose {
    window_id: String,
    generation: u64,
    /// False for an unpersisted window and for the last user window, whose saved state stays.
    removes_state: bool,
}

struct LocalRemoval {
    generation: u64,
    deferred_prepare: Option<u64>,
}

enum LocalCloseCompletion {
    Release {
        request: client_state::RendererFlushRequest,
        shutdown_ready: bool,
    },
    Refused {
        error: String,
        deferred_prepare: Option<u64>,
    },
}

#[derive(Default)]
struct ShutdownState {
    next_generation: u64,
    local_closes: HashMap<String, PendingClose>,
    capturing_local_closes: HashMap<String, PendingClose>,
    removing_local_closes: HashMap<String, LocalRemoval>,
    releasing_local_closes: HashMap<String, u64>,
    approved_local_closes: HashSet<String>,
    global_pending: HashMap<String, u64>,
    global_requests: HashMap<String, u64>,
    building_local_windows: usize,
    shutdown_started: bool,
    cleanup_started: bool,
    exit_allowed: bool,
    restart_requested: bool,
    pending_automation_restart: Option<u64>,
    automation_restart: Option<crate::developer_relaunch::RelaunchPlan>,
    update: Option<crate::desktop_updater::PreparedUpdate>,
    #[cfg(windows)]
    windows_session_end_queried: bool,
    #[cfg(windows)]
    windows_session_end_deadline: Option<Instant>,
    #[cfg(windows)]
    windows_session_end_owns_shutdown: bool,
}

impl ShutdownState {
    fn local_close_in_flight(&self, label: &str) -> bool {
        self.local_closes.contains_key(label)
            || self.capturing_local_closes.contains_key(label)
            || self.removing_local_closes.contains_key(label)
            || self.releasing_local_closes.contains_key(label)
            || self.approved_local_closes.contains(label)
    }
}

#[derive(Default)]
pub(crate) struct ShutdownCoordinator {
    state: Mutex<ShutdownState>,
    release_acknowledged: Condvar,
}

pub(crate) struct LocalWindowBuild<'a>(&'a ShutdownCoordinator);

impl Drop for LocalWindowBuild<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|error| error.into_inner());
        state.building_local_windows -= 1;
        self.0.release_acknowledged.notify_all();
    }
}

impl ShutdownCoordinator {
    pub(crate) fn admit_local_window_build<T>(
        &self,
        register: impl FnOnce() -> Result<T, String>,
    ) -> Option<Result<(T, LocalWindowBuild<'_>), String>> {
        let mut state = self.state.lock().ok()?;
        if state.shutdown_started {
            return None;
        }
        Some(register().map(|record| {
            state.building_local_windows += 1;
            (record, LocalWindowBuild(self))
        }))
    }

    pub(crate) fn wait_for_local_window_builds(&self, timeout: Duration) -> bool {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let (state, _) = self.release_acknowledged
            .wait_timeout_while(state, timeout, |state| state.building_local_windows != 0)
            .unwrap_or_else(|error| error.into_inner());
        state.building_local_windows == 0
    }

    fn begin_local_close(
        &self,
        label: String,
        window_id: String,
        persisted: bool,
        user_windows: impl FnOnce() -> Vec<String>,
    ) -> Option<u64> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.shutdown_started || state.local_close_in_flight(&label) {
            return None;
        }
        // Concurrent close admissions must agree which last local window retains its state.
        let removes_state = persisted
            && user_windows()
                .iter()
                .any(|other| other != &label && !state.local_close_in_flight(other));
        state.next_generation += 1;
        let generation = state.next_generation;
        state.local_closes.insert(
            label,
            PendingClose {
                window_id,
                generation,
                removes_state,
            },
        );
        Some(generation)
    }

    fn acknowledge_local(
        &self,
        label: &str,
        window_id: &str,
        generation: u64,
    ) -> Option<()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let pending = state.local_closes.get(label)?;
        if pending.window_id != window_id || pending.generation != generation {
            return None;
        }
        let pending = state.local_closes.remove(label)?;
        state.capturing_local_closes.insert(label.to_string(), pending);
        Some(())
    }

    fn cancel_local_close(&self, label: &str, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state
            .local_closes
            .get(label)
            .map(|pending| pending.generation)
            != Some(generation)
        {
            return false;
        }
        state.local_closes.remove(label);
        true
    }

    pub(crate) fn begin_shutdown(
        &self,
        labels: impl IntoIterator<Item = String>,
    ) -> Option<Vec<(String, u64)>> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        Self::begin_shutdown_locked(&mut state, labels)
    }

    fn begin_shutdown_locked(
        state: &mut ShutdownState,
        labels: impl IntoIterator<Item = String>,
    ) -> Option<Vec<(String, u64)>> {
        if state.shutdown_started {
            return None;
        }
        // Consume the local label snapshot under the same fence as window admission.
        let labels: Vec<_> = labels.into_iter().collect();
        state.shutdown_started = true;
        state.local_closes.clear();
        state.capturing_local_closes.clear();
        state.global_requests.clear();
        let mut requests = Vec::new();
        for label in labels {
            if state.releasing_local_closes.contains_key(&label) || state.approved_local_closes.contains(&label) {
                continue;
            }
            state.next_generation += 1;
            let generation = state.next_generation;
            state.global_pending.insert(label.clone(), generation);
            state.global_requests.insert(label.clone(), generation);
            requests.push((label, generation));
        }
        Some(requests)
    }

    fn begin_update(
        &self,
        labels: impl IntoIterator<Item = String>,
        mut update: crate::desktop_updater::PreparedUpdate,
    ) -> Option<Vec<(String, u64)>> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let requests = Self::begin_shutdown_locked(&mut state, labels)?;
        update.arm();
        state.update = Some(update);
        state.restart_requested = true;
        Some(requests)
    }

    fn can_restart_automation(state: &ShutdownState, label: &str) -> bool {
        !state.shutdown_started
            && !state.exit_allowed
            && !state.restart_requested
            && !state.local_close_in_flight(label)
    }

    fn reserve_automation_restart(
        &self,
        label: &str,
        fence: &RequestFence,
    ) -> Result<u64, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The CodeNomad host is shutting down")?;
        if !Self::can_restart_automation(&state, label) {
            return Err("The CodeNomad host is shutting down".into());
        }
        if state.pending_automation_restart.is_some() {
            return Err("CodeNomad restart is already pending".into());
        }
        fence.check()?;
        state.next_generation += 1;
        state.pending_automation_restart = Some(state.next_generation);
        Ok(state.next_generation)
    }

    fn cancel_automation_restart(&self, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state.pending_automation_restart == Some(generation) {
                state.pending_automation_restart.take();
            }
        }
    }

    fn begin_automation_restart(
        &self,
        labels: impl IntoIterator<Item = String>,
        label: &str,
        generation: u64,
        plan: crate::developer_relaunch::RelaunchPlan,
        fence: &RequestFence,
    ) -> Option<Vec<(String, u64)>> {
        let mut state = self.state.lock().ok()?;
        if state.pending_automation_restart != Some(generation) {
            return None;
        }
        state.pending_automation_restart.take();
        if !Self::can_restart_automation(&state, label) {
            return None;
        }
        fence.check().ok()?;
        let requests = Self::begin_shutdown_locked(&mut state, labels)?;
        state.automation_restart = Some(plan);
        Some(requests)
    }

    fn acknowledge_global(&self, label: &str, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.global_pending.get(label).copied() != Some(generation) {
            return false;
        }
        state.global_pending.remove(label);
        self.release_acknowledged.notify_all();
        state.global_pending.is_empty()
    }

    fn begin_workspace_releases(&self) -> Vec<(String, client_state::RendererFlushRequest)> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        #[cfg(windows)]
        if state.windows_session_end_deadline.is_some() {
            return Vec::new();
        }
        let labels: Vec<_> = state
            .global_requests
            .iter()
            .filter(|(label, _)| {
                label.as_str() != crate::preferences_window::LABEL
                    && !state.removing_local_closes.contains_key(*label)
            })
            .map(|(label, &generation)| (label.clone(), generation))
            .collect();
        labels
            .into_iter()
            .map(|(label, prepare_generation)| {
                state.next_generation += 1;
                let generation = state.next_generation;
                state.global_pending.insert(label.clone(), generation);
                (label, client_state::RendererFlushRequest { generation, prepare_generation: Some(prepare_generation) })
            })
            .collect()
    }

    fn wait_for_workspace_releases(&self, timeout: Duration) -> bool {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let (state, _) = self
            .release_acknowledged
            .wait_timeout_while(state, timeout, |state| {
                #[cfg(windows)]
                if state.windows_session_end_deadline.is_some() {
                    return false;
                }
                !state.global_pending.is_empty()
                    || !state.removing_local_closes.is_empty()
                    || !state.releasing_local_closes.is_empty()
            })
            .unwrap_or_else(|error| error.into_inner());
        state.global_pending.is_empty()
            && state.removing_local_closes.is_empty()
            && state.releasing_local_closes.is_empty()
    }

    fn begin_cleanup(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.shutdown_started
            || state.cleanup_started
            || !state.global_pending.is_empty()
        {
            return false;
        }
        #[cfg(windows)]
        if state.windows_session_end_owns_shutdown || state.windows_session_end_deadline.is_some() {
            return false;
        }
        state.cleanup_started = true;
        true
    }

    fn prepare_client_state_release(
        &self,
        queue: &client_state::IpcQueue,
        client_state: &client_state::ClientState,
    ) -> Result<(), Vec<(String, u64)>> {
        if !queue.seal_and_drain_until(Instant::now() + IPC_DRAIN_TIMEOUT) {
            eprintln!("[tauri] shutdown canceled: client state IPC did not drain");
            return Err(self.cleanup_failed(|| queue.reopen()));
        }
        client_state.prepare_ownership_release().map_err(|error| {
            eprintln!("[tauri] shutdown canceled: {error}");
            self.cleanup_failed(|| {
                client_state.resume_window_captures();
                queue.reopen();
            })
        })
    }

    fn cleanup_failed(&self, reopen: impl FnOnce()) -> Vec<(String, u64)> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        #[cfg(windows)]
        if state.windows_session_end_deadline.is_some() {
            return Vec::new();
        }
        reopen();
        state.update.take();
        let cancellations = state.global_requests.drain().collect();
        state.cleanup_started = false;
        state.shutdown_started = false;
        state.restart_requested = false;
        state.automation_restart.take();
        state.global_pending.clear();
        state.capturing_local_closes.clear();
        cancellations
    }

    fn expire_pending_shutdown(&self, requests: &[(String, u64)]) -> Vec<(String, u64)> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.shutdown_started || state.cleanup_started
            || state.global_requests.is_empty()
            || requests.iter().filter(|(label, generation)| {
                state.global_requests.get(label) == Some(generation)
            }).count() != state.global_requests.len()
        {
            return Vec::new();
        }
        state.update.take();
        state.shutdown_started = false;
        state.restart_requested = false;
        state.automation_restart.take();
        state.global_pending.clear();
        state.global_requests.drain().collect()
    }

    fn admit_local_removal(&self, label: &str, generation: u64) -> Option<PendingClose> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.capturing_local_closes.get(label)?.generation != generation {
            return None;
        }
        let pending = state.capturing_local_closes.remove(label)?;
        state.removing_local_closes.insert(label.to_string(), LocalRemoval {
            generation,
            deferred_prepare: None,
        });
        Some(pending)
    }

    /// A close already writing to disk decides whether this renderer still needs preparing.
    fn admit_global_prepare(&self, label: &str, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.global_pending.get(label) != Some(&generation) {
            return false;
        }
        if let Some(removal) = state.removing_local_closes.get_mut(label) {
            removal.deferred_prepare = Some(generation);
            return false;
        }
        true
    }

    fn local_close_status(&self, label: &str) -> Option<bool> {
        let Ok(state) = self.state.lock() else {
            return Some(false);
        };
        if state.approved_local_closes.contains(label) {
            Some(true)
        } else if state.local_close_in_flight(label) {
            Some(false)
        } else {
            None
        }
    }

    fn complete_local_removal(
        &self,
        label: &str,
        generation: u64,
        result: Result<(), String>,
    ) -> LocalCloseCompletion {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let removal = state.removing_local_closes.remove(label).expect("admitted local removal");
        debug_assert_eq!(removal.generation, generation);
        self.release_acknowledged.notify_all();
        if let Err(error) = result {
            return LocalCloseCompletion::Refused {
                error,
                deferred_prepare: removal.deferred_prepare.filter(|generation| {
                    state.global_pending.get(label) == Some(generation)
                }),
            };
        }
        // Quit joins this release instead of flushing a removed record.
        state.global_requests.remove(label);
        let shutdown_ready = state.global_pending.remove(label).is_some() && state.global_pending.is_empty();
        // A late preflush acknowledgement cannot finish the release phase.
        state.next_generation += 1;
        let release_generation = state.next_generation;
        state.releasing_local_closes.insert(label.to_string(), release_generation);
        LocalCloseCompletion::Release {
            request: client_state::RendererFlushRequest {
                generation: release_generation,
                prepare_generation: Some(generation),
            },
            shutdown_ready,
        }
    }

    fn finish_local_release(&self, label: &str, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.releasing_local_closes.get(label) != Some(&generation) {
            return false;
        }
        state.releasing_local_closes.remove(label);
        state.approved_local_closes.insert(label.to_string());
        self.release_acknowledged.notify_all();
        true
    }

    fn local_window_destroyed(&self, label: &str) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.local_closes.remove(label);
        state.capturing_local_closes.remove(label);
        state.approved_local_closes.remove(label);
        if state.releasing_local_closes.remove(label).is_some() {
            self.release_acknowledged.notify_all();
        }
    }

    fn exit_allowed(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.exit_allowed)
            .unwrap_or(false)
    }

    #[cfg(windows)]
    fn windows_session_end_confirmed(&self) -> bool {
        self.state.lock().unwrap_or_else(|error| error.into_inner()).windows_session_end_deadline.is_some()
    }

    fn request_restart(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.automation_restart.is_none() {
            state.restart_requested = true;
        }
    }

    fn complete_cleanup(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.exit_allowed = true;
        self.release_acknowledged.notify_all();
        state.restart_requested
    }

    pub(crate) fn with_navigation_authority<T>(&self, operation: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().ok()?;
        if state.shutdown_started {
            return None;
        }
        Some(operation())
    }

    #[cfg(test)]
    fn shutdown_started(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.shutdown_started)
            .unwrap_or(true)
    }

    #[cfg(windows)]
    fn begin_windows_session_end(
        &self,
        labels: impl IntoIterator<Item = String>,
    ) -> Option<Vec<(String, u64)>> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.windows_session_end_deadline.is_some() || state.windows_session_end_queried {
            return None;
        }
        state.windows_session_end_queried = true;
        state.pending_automation_restart.take();
        state.automation_restart.take();
        if state.update.take().is_some() {
            state.restart_requested = false;
        }
        let requests = Self::begin_shutdown_locked(&mut state, labels);
        state.windows_session_end_owns_shutdown = requests.is_some();
        requests
    }

    #[cfg(windows)]
    fn confirm_windows_session_end(&self) -> (Instant, bool) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(deadline) = state.windows_session_end_deadline {
            return (deadline, false);
        }
        let deadline = Instant::now() + WINDOWS_SESSION_END_TIMEOUT;
        state.windows_session_end_deadline = Some(deadline);
        if state.exit_allowed {
            return (deadline, false);
        }
        state.shutdown_started = true;
        state.cleanup_started = true;
        state.restart_requested = false;
        state.update.take();
        state.pending_automation_restart.take();
        state.automation_restart.take();
        state.global_pending.clear();
        self.release_acknowledged.notify_all();
        (deadline, true)
    }

    #[cfg(windows)]
    fn wait_for_windows_cleanup(&self, deadline: Instant) -> bool {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let (state, _) = self.release_acknowledged.wait_timeout_while(
            state,
            deadline.saturating_duration_since(Instant::now()),
            |state| !state.exit_allowed,
        ).unwrap_or_else(|error| error.into_inner());
        state.exit_allowed
    }

    #[cfg(windows)]
    fn cancel_windows_session_end(&self) -> Vec<(String, u64)> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.windows_session_end_deadline.is_some() || !state.windows_session_end_queried {
            return Vec::new();
        }
        state.windows_session_end_queried = false;
        if !state.windows_session_end_owns_shutdown || state.cleanup_started {
            return Vec::new();
        }
        state.windows_session_end_owns_shutdown = false;
        state.shutdown_started = false;
        state.global_pending.clear();
        state.global_requests.drain().collect()
    }
}

/// The loading page and the server's sign-in and pairing pages never run the application, so
/// nothing there would answer a flush: waiting for one would keep the window from closing and
/// CodeNomad from quitting. An unreadable address still asks.
fn awaits_renderer_flush(url: Option<&tauri::Url>) -> bool {
    url.map_or(true, |url| !crate::is_listenerless_document(url))
}

fn emit_prepare(app: &AppHandle, label: &str, generation: u64) -> bool {
    use crate::preferences_window::{PreferencesWindow, ShutdownPrepare, LABEL};
    if label == LABEL {
        match app.state::<PreferencesWindow>().prepare_shutdown(generation) {
            ShutdownPrepare::JoinClose => return true,
            ShutdownPrepare::Skip => return false,
            ShutdownPrepare::Renderer => {}
        }
    }
    if let Ok(window_id) = crate::identity::local_window_id(label) {
        // A booting document's claim may itself be queued behind the writer.
        // The seal drains admitted mutations without depending on a listener
        // that has not finished setting up yet.
        if !app.state::<client_state::ClientState>().renderer_has_claimed(&window_id) {
            return false;
        }
    }
    emit_flush(app, label, client_state::RendererFlushRequest { generation, prepare_generation: None })
}

fn emit_flush(app: &AppHandle, label: &str, request: client_state::RendererFlushRequest) -> bool {
    app.get_webview(label).is_some_and(|webview| {
        if !awaits_renderer_flush(webview.url().ok().as_ref()) {
            return false;
        }
        if label.starts_with("remote-") {
            let argument = if request.prepare_generation.is_some() { "\"release\"" } else { "\"prepare\"" };
            return webview.eval(format!(
                r#"Promise.resolve().then(() => window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__?.({argument}))
                    .finally(() => window.__TAURI_INTERNALS__.invoke("client_state_renderer_flushed", {{ generation: {generation}, accessToken: "" }}));"#,
                generation = request.generation,
            )).is_ok();
        }
        webview.emit_to(label, "client-state:flush-requested", request).is_ok()
    })
}

fn emit_flush_cancelled(app: &AppHandle, label: &str, generation: u64) {
    if let Some(webview) = app.get_webview(label) {
        if label.starts_with("remote-") {
            let _ = webview.eval(r#"window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__?.("cancel")"#);
            return;
        }
        let _ = webview.emit_to(
            label, FLUSH_CANCELLED_EVENT,
            client_state::RendererFlushRequest { generation, prepare_generation: None },
        );
    }
}

fn emit_flush_cancellations(app: &AppHandle, cancellations: Vec<(String, u64)>) {
    for (label, generation) in cancellations {
        emit_flush_cancelled(app, &label, generation);
    }
}

pub(crate) fn request_local_window_close(app: AppHandle, label: String) {
    let windows = app.state::<LocalWindows>();
    let record = windows.record(&label);
    let remote = label.starts_with("remote-");
    let window_id = match record.as_ref() {
        Some(record) => record.id.clone(),
        None if remote => label.clone(),
        None => return,
    };
    let Some(generation) = app.state::<ShutdownCoordinator>().begin_local_close(
        label.clone(),
        window_id.clone(),
        record.is_some_and(|record| record.persisted),
        || windows.user_window_labels(),
    ) else {
        return;
    };
    if !emit_prepare(&app, &label, generation) {
        finish_local_close(app, label, window_id, generation);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(if remote { RENDERER_FLUSH_TIMEOUT } else { CLOSE_CAPTURE_TIMEOUT });
        if remote {
            finish_local_close(app, label, window_id, generation);
        } else if app
            .state::<ShutdownCoordinator>()
            .cancel_local_close(&label, generation)
        {
            emit_flush_cancelled(&app, &label, generation);
        }
    });
}

fn finish_local_close(app: AppHandle, label: String, window_id: String, generation: u64) {
    if app
        .state::<ShutdownCoordinator>()
        .acknowledge_local(&label, &window_id, generation)
        .is_none()
    {
        return;
    }
    std::thread::spawn(move || {
        let coordinator = app.state::<ShutdownCoordinator>();
        client_state::capture_and_flush_window(&app, &label);
        let Some(pending) = coordinator.admit_local_removal(&label, generation) else {
            return;
        };
        let result = if pending.removes_state {
            match client_state::ClientState::remove_window_in_order(&app, pending.window_id) {
                Ok(true) => Ok(()),
                Ok(false) => Err("persistent window state was not removed".to_string()),
                Err(error) => Err(error),
            }
        } else {
            Ok(())
        };
        match coordinator.complete_local_removal(&label, generation, result) {
            LocalCloseCompletion::Release { request, shutdown_ready } => {
                let emitted = emit_flush(&app, &label, request);
                if shutdown_ready {
                    start_cleanup(app.clone());
                }
                if emitted {
                    std::thread::sleep(RENDERER_FLUSH_TIMEOUT);
                }
                finish_local_release(&app, &label, request.generation);
            }
            LocalCloseCompletion::Refused { error, deferred_prepare } => {
                eprintln!("[client-state] failed to remove closed window: {error}");
                emit_flush_cancelled(&app, &label, generation);
                if let Some(generation) = deferred_prepare {
                    if coordinator.admit_global_prepare(&label, generation)
                        && !emit_prepare(&app, &label, generation)
                        && coordinator.acknowledge_global(&label, generation)
                    {
                        start_cleanup(app.clone());
                    }
                }
            }
        }
    });
}

fn renderer_labels(app: &AppHandle) -> impl Iterator<Item = String> + '_ {
    // Inspect native windows before locking the coordinator.
    let remote: Vec<_> = app.webview_windows()
        .into_keys()
        .filter(|label| label.starts_with("remote-"))
        .collect();
    // Include loading Preferences: it may already be persisting an individual close.
    remote.into_iter()
        .chain(std::iter::once(crate::preferences_window::LABEL.to_string()))
        .chain(std::iter::once_with(|| app.state::<LocalWindows>().user_window_labels()).flatten())
}

pub(crate) fn request(app: AppHandle) {
    let labels = renderer_labels(&app);
    let Some(requests) = app.state::<ShutdownCoordinator>().begin_shutdown(labels) else {
        start_cleanup(app);
        return;
    };
    flush_shutdown(app, requests, CLOSE_CAPTURE_TIMEOUT);
}

pub(crate) fn request_update(
    app: AppHandle,
    update: crate::desktop_updater::PreparedUpdate,
) -> Result<(), String> {
    let requests = app.state::<ShutdownCoordinator>()
        .begin_update(renderer_labels(&app), update)
        .ok_or("Application shutdown is already in progress")?;
    flush_shutdown(app, requests, UPDATE_RENDERER_FLUSH_TIMEOUT);
    Ok(())
}

fn flush_shutdown(app: AppHandle, requests: Vec<(String, u64)>, timeout: Duration) {
    crate::remote_dictation::revoke(&app, None);
    for (label, generation) in &requests {
        if !app.state::<ShutdownCoordinator>().admit_global_prepare(label, *generation) {
            continue;
        }
        if !emit_prepare(&app, label, *generation) {
            app.state::<ShutdownCoordinator>()
                .acknowledge_global(label, *generation);
        } else if label.starts_with("remote-") {
            // A remote page can be offline or from a server without this hook.
            let app = app.clone();
            let (label, generation) = (label.clone(), *generation);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(900));
                renderer_flushed(app, label.clone(), label, generation);
            });
        }
    }
    if requests.is_empty()
        || requests.iter().all(|(label, generation)| {
            app.state::<ShutdownCoordinator>()
                .state
                .lock()
                .ok()
                .is_some_and(|state| state.global_pending.get(label) != Some(generation))
        })
    {
        start_cleanup(app);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        let cancellations = app.state::<ShutdownCoordinator>().expire_pending_shutdown(&requests);
        emit_flush_cancellations(&app, cancellations);
    });
}

pub(crate) fn renderer_flushed(app: AppHandle, label: String, window_id: String, generation: u64) {
    if finish_local_release(&app, &label, generation) {
        return;
    }
    if app
        .state::<ShutdownCoordinator>()
        .acknowledge_global(&label, generation)
    {
        start_cleanup(app);
        return;
    }
    finish_local_close(app, label, window_id, generation);
}

pub(crate) fn preferences_renderer_flushed(app: AppHandle, generation: u64) {
    if app.state::<ShutdownCoordinator>().acknowledge_global(crate::preferences_window::LABEL, generation) {
        start_cleanup(app);
    }
}

fn start_cleanup(app: AppHandle) {
    if !app
        .state::<ShutdownCoordinator>()
        .begin_cleanup()
    {
        return;
    }
    if let Some(speech) = app.try_state::<crate::device_speech::DeviceSpeech>() {
        speech.revoke(None);
    }
    std::thread::spawn(move || {
        if let Some(speech) = app.try_state::<crate::device_speech::DeviceSpeech>() {
            speech.stop_hex();
        }
        let coordinator = app.state::<ShutdownCoordinator>();
        // An admitted renderer can be in the shutdown snapshot before its native
        // window exists. Let it enqueue publication before capture and sealing.
        if !coordinator.wait_for_local_window_builds(IPC_DRAIN_TIMEOUT) {
            eprintln!("[tauri] shutdown canceled: local window construction did not settle");
            let cancellations = coordinator.cleanup_failed(|| {});
            emit_flush_cancellations(&app, cancellations);
            return;
        }
        #[cfg(windows)]
        if coordinator.windows_session_end_confirmed() {
            return;
        }
        client_state::capture_all_windows(&app);
        #[cfg(windows)]
        if coordinator.windows_session_end_confirmed() {
            return;
        }
        release_workspaces(&app, RENDERER_FLUSH_TIMEOUT);
        #[cfg(windows)]
        if coordinator.windows_session_end_confirmed() {
            return;
        }
        let queue = app.state::<client_state::IpcQueue>();
        let client_state = app.state::<client_state::ClientState>();
        if let Err(cancellations) = coordinator.prepare_client_state_release(&queue, &client_state) {
            emit_flush_cancellations(&app, cancellations);
            return;
        }
        let reopen = || {
            client_state.resume_window_captures();
            queue.reopen();
        };
        let result = if let Some(state) = app.try_state::<AppState>() {
            retry_bounded(SHUTDOWN_STOP_ATTEMPTS, || {
                #[cfg(windows)]
                if coordinator.windows_session_end_confirmed() {
                    return Ok(());
                }
                state.manager.stop().map_err(|error| error.to_string())
            })
        } else {
            Ok(())
        };
        if let Err(error) = result {
            eprintln!("[tauri] shutdown cleanup remains unconfirmed: {error}");
            let cancellations = coordinator.cleanup_failed(reopen);
            emit_flush_cancellations(&app, cancellations);
            return;
        }
        let update = {
            let mut state = coordinator.state.lock().unwrap_or_else(|error| error.into_inner());
            #[cfg(windows)]
            if state.windows_session_end_deadline.is_some() {
                return;
            }
            state.update.take()
        };
        if let Err(error) = update.map(|update| update.install()).unwrap_or(Ok(())) {
            eprintln!("[tauri] update installation failed: {error}");
            // The failed installer must not be replayed. Restore the owned
            // backend after reopening navigation, so even immediate readiness
            // can restore the windows. A newer quit still wins recovery admission.
            let cancellations = coordinator.cleanup_failed(reopen);
            emit_flush_cancellations(&app, cancellations);
            let recovery = app.try_state::<AppState>().map(|state| {
                state.manager.start(app.clone(), crate::is_dev_mode())
            });
            match recovery {
                // Recovery reloads every window; the new documents report it.
                Some(Ok(())) => crate::desktop_updater::record_failure(),
                // Without a reload, the live document that started the update reports it.
                Some(Err(error)) => {
                    eprintln!("[tauri] backend recovery after failed update: {error}");
                    crate::desktop_updater::report_failure(&app);
                }
                None => crate::desktop_updater::report_failure(&app),
            }
            return;
        }
        client_state::release(&app);
        let restart = coordinator.complete_cleanup();
        if restart {
            #[cfg(target_os = "macos")]
            RESTART_ON_EXIT.store(true, std::sync::atomic::Ordering::Release);
            app.request_restart();
        } else {
            app.exit(0);
        }
    });
}

pub(crate) fn preferences_close_settled(app: &AppHandle, generation: u64, saved: bool) {
    let coordinator = app.state::<ShutdownCoordinator>();
    let label = crate::preferences_window::LABEL;
    if !coordinator.admit_global_prepare(label, generation) {
        return;
    }
    // A refused close leaves Preferences open; prepare that renderer as usual.
    if (saved || !emit_prepare(app, label, generation))
        && coordinator.acknowledge_global(label, generation)
    {
        start_cleanup(app.clone());
    }
}

pub(crate) fn request_restart(app: AppHandle) {
    app.state::<ShutdownCoordinator>().request_restart();
    request(app);
}

pub(crate) fn reserve_automation_restart(
    app: &AppHandle,
    label: &str,
    fence: &RequestFence,
) -> Result<u64, String> {
    app.state::<ShutdownCoordinator>().reserve_automation_restart(label, fence)
}

pub(crate) fn finish_automation_restart(
    app: AppHandle,
    label: &str,
    generation: u64,
    plan: Option<crate::developer_relaunch::RelaunchPlan>,
    fence: &RequestFence,
) {
    let coordinator = app.state::<ShutdownCoordinator>();
    let Some(plan) = plan else {
        coordinator.cancel_automation_restart(generation);
        return;
    };
    let labels = renderer_labels(&app);
    let requests = coordinator.begin_automation_restart(labels, label, generation, plan, fence);
    if let Some(requests) = requests {
        flush_shutdown(app, requests, RENDERER_FLUSH_TIMEOUT);
    }
}

#[cfg(windows)]
pub(crate) fn take_automation_restart(app: &AppHandle) -> Option<crate::developer_relaunch::RelaunchPlan> {
    let coordinator = app.state::<ShutdownCoordinator>();
    let mut state = coordinator.state.lock().ok()?;
    if state.exit_allowed {
        state.automation_restart.take()
    } else {
        None
    }
}

/// Set once cleanup has requested Tauri's restart; `RunEvent::Exit` then relaunches
/// with this process's environment (`macos_relaunch.rs`).
#[cfg(target_os = "macos")]
static RESTART_ON_EXIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
pub(crate) fn restart_on_exit() -> bool {
    RESTART_ON_EXIT.load(std::sync::atomic::Ordering::Acquire)
}

fn retry_bounded<E>(
    attempts: usize,
    mut operation: impl FnMut() -> Result<(), E>,
) -> Result<(), E> {
    assert!(attempts > 0);
    for attempt in 1..=attempts {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) if attempt == attempts => return Err(error),
            Err(_) => {}
        }
    }
    unreachable!()
}

pub(crate) fn with_navigation_authority<T>(
    app: &AppHandle,
    operation: impl FnOnce() -> T,
) -> Option<T> {
    app.state::<ShutdownCoordinator>()
        .with_navigation_authority(operation)
}

pub(crate) fn local_window_close_status(app: &AppHandle, label: &str) -> Option<bool> {
    app.state::<ShutdownCoordinator>().local_close_status(label)
}

fn release_workspaces(app: &AppHandle, timeout: Duration) {
    let coordinator = app.state::<ShutdownCoordinator>();
    for (label, request) in coordinator.begin_workspace_releases() {
        if !emit_flush(app, &label, request) {
            coordinator.acknowledge_global(&label, request.generation);
        }
    }
    coordinator.wait_for_workspace_releases(timeout);
}

pub(crate) fn finish_local_release(app: &AppHandle, label: &str, generation: u64) -> bool {
    if !app
        .state::<ShutdownCoordinator>()
        .finish_local_release(label, generation)
    {
        return false;
    }
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.window().close();
    }
    true
}

pub(crate) fn local_window_close_in_flight(app: &AppHandle, label: &str) -> bool {
    local_window_close_status(app, label).is_some()
}

pub(crate) fn local_window_destroyed(app: &AppHandle, label: &str) {
    app.state::<ShutdownCoordinator>()
        .local_window_destroyed(label);
}

pub(crate) fn exit_allowed(app: &AppHandle) -> bool {
    app.state::<ShutdownCoordinator>().exit_allowed()
}

#[cfg(windows)]
fn prepare_windows_session_end(app: &AppHandle) {
    let labels = renderer_labels(app);
    let requests = app
        .state::<ShutdownCoordinator>()
        .begin_windows_session_end(labels);
    let Some(requests) = requests else {
        return;
    };
    crate::remote_dictation::revoke(app, None);
    for (label, flush_generation) in requests {
        if !app.state::<ShutdownCoordinator>().admit_global_prepare(&label, flush_generation) {
            continue;
        }
        if label.starts_with("remote-") || !emit_prepare(app, &label, flush_generation) {
            app.state::<ShutdownCoordinator>()
                .acknowledge_global(&label, flush_generation);
        }
    }
}

#[cfg(windows)]
fn cancel_windows_session_end(app: &AppHandle) {
    let cancellations = app
        .state::<ShutdownCoordinator>()
        .cancel_windows_session_end();
    emit_flush_cancellations(app, cancellations);
}

#[cfg(windows)]
pub(crate) fn request_windows_session_end(app: AppHandle) {
    let coordinator = app.state::<ShutdownCoordinator>();
    let (deadline, start) = coordinator.confirm_windows_session_end();
    if start {
        let cleanup_app = app.clone();
        std::thread::spawn(move || {
            let speech_app = cleanup_app.clone();
            std::thread::spawn(move || {
                if let Some(speech) = speech_app.try_state::<crate::device_speech::DeviceSpeech>() {
                    speech.revoke(None);
                    speech.stop_hex();
                }
            });
            let persist_app = cleanup_app.clone();
            let saved = windows_session_end_cleanup(
                deadline,
                move |persist_deadline| {
                    // WM_ENDSESSION blocks native dispatch, so we can only
                    // drain writes already queued and save captured geometry.
                    if !persist_app.state::<client_state::IpcQueue>()
                        .seal_and_drain_until(persist_deadline)
                    {
                        return false;
                    }
                    match persist_app.state::<client_state::ClientState>().prepare_ownership_release() {
                        Ok(()) => true,
                        Err(error) => {
                            eprintln!("[client-state] failed to flush state: {error}");
                            false
                        }
                    }
                },
                |deadline| {
                    if let Some(state) = cleanup_app.try_state::<AppState>() {
                        if let Err(error) = retry_bounded(SHUTDOWN_STOP_ATTEMPTS, || {
                            state.manager.stop_until(deadline)
                        }) {
                            eprintln!("[tauri] Windows session-end backend stop: {error}");
                        }
                    }
                },
            );
            if saved {
                client_state::release(&cleanup_app);
            }
            cleanup_app.state::<ShutdownCoordinator>().complete_cleanup();
        });
    }
    if !coordinator.wait_for_windows_cleanup(deadline) {
        eprintln!("[tauri] Windows session-end cleanup exceeded {:?}", WINDOWS_SESSION_END_TIMEOUT);
    }
}

#[cfg(windows)]
fn windows_session_end_cleanup(
    deadline: Instant,
    persist: impl FnOnce(Instant) -> bool + Send + 'static,
    stop_backend: impl FnOnce(Instant),
) -> bool {
    let persist_deadline = deadline - WINDOWS_SESSION_END_STOP_RESERVE;
    let (done, persistence) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = done.send(persist(persist_deadline));
    });
    let saved = persistence
        .recv_timeout(persist_deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(false);
    if !saved {
        eprintln!("[tauri] Windows session-end client state persistence incomplete");
    }
    stop_backend(deadline);
    saved
}

#[cfg(windows)]
fn windows_session_end_handler(app: AppHandle, forward_end: bool) -> crate::windows_session_end::SessionEndHandler {
    let query_app = app.clone();
    crate::windows_session_end::SessionEndHandler {
        // Give renderers a chance to send their final commits before Windows
        // pauses native dispatch at WM_ENDSESSION.
        query: Box::new(move || {
            prepare_windows_session_end(&query_app);
        }),
        end: Box::new(move |ending| {
            if ending {
                request_windows_session_end(app.clone());
            } else {
                cancel_windows_session_end(&app);
            }
        }),
        forward_end,
    }
}

#[cfg(windows)]
pub(crate) fn install_windows_session_end_handler(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    crate::windows_session_end::install(hwnd.0, windows_session_end_handler(window.app_handle().clone(), false))
}

/// Tao's hidden event target exits the process on WM_ENDSESSION; it may receive the
/// message before any application window, so it runs the same flush first.
#[cfg(windows)]
fn install_tao_event_target_session_end_handler(app: &AppHandle) -> Result<(), String> {
    use crate::windows_session_end::{current_thread_window_of_class, install, TAO_EVENT_TARGET_CLASS};
    // Main thread only; a failed attempt is retried with the next window.
    static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if INSTALLED.load(std::sync::atomic::Ordering::Acquire) {
        return Ok(());
    }
    let target = current_thread_window_of_class(TAO_EVENT_TARGET_CLASS)
        .ok_or_else(|| format!("{TAO_EVENT_TARGET_CLASS} window not found"))?;
    install(target, windows_session_end_handler(app.clone(), true))?;
    INSTALLED.store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}

#[cfg(windows)]
pub(crate) fn schedule_windows_session_end_handler(window: &WebviewWindow) -> Result<(), String> {
    let window = window.clone();
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        if let Err(error) = install_windows_session_end_handler(&window) {
            eprintln!("[client-state] failed to install Windows session-end handler: {error}");
        }
        if let Err(error) = install_tao_event_target_session_end_handler(window.app_handle()) {
            eprintln!("[client-state] failed to install the Tao event target's Windows session-end handler: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "shutdown_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "shutdown_updater_tests.rs"]
mod updater_tests;
