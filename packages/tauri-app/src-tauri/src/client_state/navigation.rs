use super::ClientState;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
const RELOAD_COALESCED: &str = "reload coalesced with an existing reload request";
const RELOAD_SUPERSEDED: &str = "reload superseded by a queued force reload";
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);
static PENDING_FLUSH: LazyLock<PendingFlush> = LazyLock::new(PendingFlush::default);
static NAVIGATIONS: LazyLock<Mutex<NavigationQueue<NavigationOperation>>> =
    LazyLock::new(|| Mutex::new(NavigationQueue::default()));

type Operation = Box<dyn FnOnce(AppHandle) -> Result<(), String> + Send + 'static>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NavigationKind {
    Cli,
    Reload,
    ForceReload,
}

impl NavigationKind {
    fn description(self) -> &'static str {
        match self {
            Self::Cli => "CLI navigation",
            Self::Reload => "reload",
            Self::ForceReload => "force reload",
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationFlushRequest {
    generation: u64,
}

struct NavigationOperation {
    app: AppHandle,
    target_url: Option<Url>,
    navigate: Operation,
}

struct QueuedNavigation<T> {
    kind: NavigationKind,
    description: String,
    value: T,
    completion: mpsc::Sender<Result<(), String>>,
}

impl<T> QueuedNavigation<T> {
    fn new(
        kind: NavigationKind,
        description: impl Into<String>,
        value: T,
    ) -> (Self, mpsc::Receiver<Result<(), String>>) {
        let (completion, receiver) = mpsc::channel();
        (
            Self {
                kind,
                description: description.into(),
                value,
                completion,
            },
            receiver,
        )
    }

    fn finish(self, result: Result<(), String>) {
        finish_request(&self.description, self.completion, result);
    }
}

struct NavigationQueue<T> {
    pending: VecDeque<QueuedNavigation<T>>,
    active: Option<NavigationKind>,
    worker_running: bool,
}

impl<T> Default for NavigationQueue<T> {
    fn default() -> Self {
        Self {
            pending: VecDeque::new(),
            active: None,
            worker_running: false,
        }
    }
}

impl<T> NavigationQueue<T> {
    fn enqueue(&mut self, request: QueuedNavigation<T>) -> bool {
        if request.kind != NavigationKind::Cli {
            if self.active == Some(request.kind) || self.active == Some(NavigationKind::ForceReload)
            {
                request.finish(Err(RELOAD_COALESCED.to_string()));
                return false;
            }

            if let Some(index) = self
                .pending
                .iter()
                .position(|queued| queued.kind != NavigationKind::Cli)
            {
                if request.kind == NavigationKind::ForceReload
                    && self.pending[index].kind == NavigationKind::Reload
                {
                    let replaced = std::mem::replace(&mut self.pending[index], request);
                    replaced.finish(Err(RELOAD_SUPERSEDED.to_string()));
                } else {
                    request.finish(Err(RELOAD_COALESCED.to_string()));
                }
                return false;
            }
        }

        if request.kind == NavigationKind::Cli {
            let index = self
                .pending
                .iter()
                .position(|queued| queued.kind != NavigationKind::Cli)
                .unwrap_or(self.pending.len());
            self.pending.insert(index, request);
        } else {
            self.pending.push_back(request);
        }

        if self.worker_running {
            false
        } else {
            self.worker_running = true;
            true
        }
    }

    fn next(&mut self) -> Option<QueuedNavigation<T>> {
        let request = self.pending.pop_front();
        if let Some(request) = request.as_ref() {
            self.active = Some(request.kind);
        } else {
            self.active = None;
            self.worker_running = false;
        }
        request
    }

    fn complete_active(&mut self) {
        self.active = None;
    }
}

#[derive(Default)]
struct PendingFlush {
    sender: Mutex<Option<(u64, mpsc::SyncSender<()>)>>,
}

impl PendingFlush {
    fn begin(&self, generation: u64) -> mpsc::Receiver<()> {
        let (sender, receiver) = mpsc::sync_channel(1);
        *self.sender.lock().unwrap_or_else(|err| err.into_inner()) = Some((generation, sender));
        receiver
    }

    fn acknowledge(&self, generation: u64) {
        let sender = self
            .sender
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
            .filter(|(current, _)| *current == generation)
            .map(|(_, sender)| sender.clone());
        if let Some(sender) = sender {
            let _ = sender.try_send(());
        }
    }

    fn complete(&self, generation: u64) {
        let mut pending = self.sender.lock().unwrap_or_else(|err| err.into_inner());
        if pending
            .as_ref()
            .is_some_and(|(current, _)| *current == generation)
        {
            pending.take();
        }
    }
}

pub(crate) fn before_main_window_navigation(
    app: &AppHandle,
    kind: NavigationKind,
    target_url: Option<Url>,
    navigate: impl FnOnce(AppHandle) -> Result<(), String> + Send + 'static,
) {
    let (request, _completion) = QueuedNavigation::new(
        kind,
        kind.description(),
        NavigationOperation {
            app: app.clone(),
            target_url,
            navigate: Box::new(navigate),
        },
    );
    let start_worker = NAVIGATIONS
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .enqueue(request);
    if start_worker {
        std::thread::spawn(run_navigation_queue);
    }
}

fn run_navigation_queue() {
    loop {
        let request = NAVIGATIONS
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .next();
        let Some(request) = request else {
            return;
        };

        let QueuedNavigation {
            description,
            completion,
            value:
                NavigationOperation {
                    app,
                    target_url,
                    navigate,
                },
            ..
        } = request;
        wait_for_renderer_flush(&app);
        let state = app.try_state::<ClientState>();
        let result = execute_navigation(state.as_deref(), target_url.as_ref(), || {
            navigate(app.clone())
        });
        finish_request(&description, completion, result);

        NAVIGATIONS
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .complete_active();
    }
}

fn wait_for_renderer_flush(app: &AppHandle) {
    let renderer_claimed = app
        .try_state::<ClientState>()
        .is_some_and(|state| state.renderer_access_is_claimed());
    if !renderer_claimed {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let receiver = PENDING_FLUSH.begin(generation);
    if let Err(err) = window.emit(
        "client-state:navigation-flush-requested",
        NavigationFlushRequest { generation },
    ) {
        eprintln!("[client-state] failed to request renderer navigation flush: {err}");
    }
    let _ = receiver.recv_timeout(RENDERER_FLUSH_TIMEOUT);
    PENDING_FLUSH.complete(generation);
}

fn execute_navigation(
    state: Option<&ClientState>,
    target_url: Option<&Url>,
    navigate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if let Some(state) = state {
        state.begin_renderer_navigation(target_url)?;
    }
    let result = navigate();
    if result.is_err() {
        if let Some(state) = state {
            state.cancel_renderer_navigation();
        }
    }
    result
}

fn finish_request(
    description: &str,
    completion: mpsc::Sender<Result<(), String>>,
    result: Result<(), String>,
) {
    if let Err(err) = &result {
        eprintln!("[client-state] {description} failed: {err}");
    }
    let _ = completion.send(result);
}

pub(crate) fn renderer_flushed(generation: u64) {
    PENDING_FLUSH.acknowledge(generation);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn queued(
        kind: NavigationKind,
        name: &'static str,
    ) -> (
        QueuedNavigation<&'static str>,
        mpsc::Receiver<Result<(), String>>,
    ) {
        QueuedNavigation::new(kind, name, name)
    }

    #[test]
    fn cli_navigation_survives_overlapping_reload_and_force_reload() {
        let mut queue = NavigationQueue::default();
        let (cli, cli_result) = queued(NavigationKind::Cli, "cli");
        assert!(queue.enqueue(cli));

        let cli = queue.next().unwrap();
        assert_eq!(cli.value, "cli");
        let (reload, reload_result) = queued(NavigationKind::Reload, "reload");
        assert!(!queue.enqueue(reload));
        let (force_reload, force_reload_result) =
            queued(NavigationKind::ForceReload, "force reload");
        assert!(!queue.enqueue(force_reload));

        assert_eq!(
            reload_result.recv().unwrap(),
            Err(RELOAD_SUPERSEDED.to_string())
        );
        cli.finish(Ok(()));
        queue.complete_active();
        assert_eq!(cli_result.recv().unwrap(), Ok(()));

        let force_reload = queue.next().unwrap();
        assert_eq!(force_reload.value, "force reload");
        force_reload.finish(Ok(()));
        queue.complete_active();
        assert_eq!(force_reload_result.recv().unwrap(), Ok(()));
        assert!(queue.next().is_none());
    }

    #[test]
    fn cli_requests_jump_queued_reload_without_reordering_each_other() {
        let mut queue = NavigationQueue::default();
        let (active_cli, _) = queued(NavigationKind::Cli, "active cli");
        queue.enqueue(active_cli);
        queue.next().unwrap();

        let (reload, _) = queued(NavigationKind::Reload, "reload");
        let (first_cli, _) = queued(NavigationKind::Cli, "first cli");
        let (second_cli, _) = queued(NavigationKind::Cli, "second cli");
        queue.enqueue(reload);
        queue.enqueue(first_cli);
        queue.enqueue(second_cli);

        queue.complete_active();
        assert_eq!(queue.next().unwrap().value, "first cli");
        queue.complete_active();
        assert_eq!(queue.next().unwrap().value, "second cli");
        queue.complete_active();
        assert_eq!(queue.next().unwrap().value, "reload");
    }

    #[test]
    fn stale_flush_acknowledgement_cannot_release_the_next_request() {
        let pending = PendingFlush::default();
        let first = pending.begin(1);
        pending.acknowledge(1);
        first.recv_timeout(Duration::from_millis(10)).unwrap();
        pending.complete(1);

        let second = pending.begin(2);
        pending.acknowledge(1);
        assert_eq!(
            second.recv_timeout(Duration::from_millis(10)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        pending.acknowledge(2);
        second.recv_timeout(Duration::from_millis(10)).unwrap();
        pending.complete(2);
    }

    #[test]
    fn failed_navigation_preserves_renderer_access_and_runs_once() {
        let directory = tempfile::tempdir().unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        let renderer_url = url::Url::parse("http://127.0.0.1:43123/workspace").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        state
            .claim_renderer_access("current-renderer", &renderer_url)
            .unwrap();

        let calls_for_navigation = Arc::clone(&calls);
        let result = execute_navigation(Some(&state), Some(&renderer_url), || {
            calls_for_navigation.fetch_add(1, Ordering::SeqCst);
            Err("synchronous navigation failure".to_string())
        });

        assert_eq!(result, Err("synchronous navigation failure".to_string()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        state
            .validate_renderer_access("current-renderer", &renderer_url)
            .unwrap();
    }

    #[test]
    fn accepted_navigation_rotates_renderer_access() {
        let directory = tempfile::tempdir().unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        let outgoing_url = url::Url::parse("http://127.0.0.1:43123/workspace").unwrap();
        let incoming_url = url::Url::parse("http://127.0.0.1:43124/workspace").unwrap();
        state
            .claim_renderer_access("outgoing-renderer", &outgoing_url)
            .unwrap();

        execute_navigation(Some(&state), Some(&incoming_url), || Ok(())).unwrap();

        state
            .validate_renderer_access("outgoing-renderer", &outgoing_url)
            .unwrap();
        assert!(state.renderer_origin_can_claim(&outgoing_url));
        state
            .claim_renderer_access("incoming-renderer", &incoming_url)
            .unwrap();
        assert!(state
            .validate_renderer_access("outgoing-renderer", &outgoing_url)
            .is_err());
        state
            .validate_renderer_access("incoming-renderer", &incoming_url)
            .unwrap();
    }
}
