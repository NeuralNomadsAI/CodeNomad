use super::ClientState;
use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};
use url::Url;

static NAVIGATIONS: LazyLock<Mutex<HashMap<String, NavigationQueue<NavigationOperation>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

type Operation = Box<dyn FnOnce(AppHandle) -> Result<(), String> + Send + 'static>;
type NavigationGuard = Box<dyn Fn() -> bool + Send + 'static>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NavigationKind {
    Cli,
    Reload,
    ForceReload,
}

struct NavigationOperation {
    app: AppHandle,
    window_label: String,
    target_url: Option<Url>,
    is_current: NavigationGuard,
    navigate: Operation,
}

struct QueuedNavigation<T> {
    kind: NavigationKind,
    value: T,
}

impl<T> QueuedNavigation<T> {
    fn new(kind: NavigationKind, value: T) -> Self {
        Self { kind, value }
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
                    self.pending[index] = request;
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

pub(crate) fn before_window_navigation(
    app: &AppHandle,
    window_label: String,
    kind: NavigationKind,
    target_url: Option<Url>,
    navigate: impl FnOnce(AppHandle) -> Result<(), String> + Send + 'static,
) {
    before_window_navigation_if(app, window_label, kind, target_url, || true, navigate);
}

pub(crate) fn before_window_navigation_if(
    app: &AppHandle,
    window_label: String,
    kind: NavigationKind,
    target_url: Option<Url>,
    is_current: impl Fn() -> bool + Send + 'static,
    navigate: impl FnOnce(AppHandle) -> Result<(), String> + Send + 'static,
) {
    let queue_label = window_label.clone();
    let request = QueuedNavigation::new(
        kind,
        NavigationOperation {
            app: app.clone(),
            window_label,
            target_url,
            is_current: Box::new(is_current),
            navigate: Box::new(navigate),
        },
    );
    let start_worker = NAVIGATIONS
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .entry(queue_label.clone())
        .or_default()
        .enqueue(request);
    if start_worker {
        std::thread::spawn(move || run_navigation_queue(queue_label));
    }
}

fn complete_active(window_label: &str) {
    if let Some(queue) = NAVIGATIONS
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .get_mut(window_label)
    {
        queue.complete_active();
    }
}

fn run_navigation_queue(window_label: String) {
    loop {
        let request = {
            let mut queues = NAVIGATIONS.lock().unwrap_or_else(|err| err.into_inner());
            let request = queues
                .get_mut(&window_label)
                .and_then(NavigationQueue::next);
            if request.is_none() {
                queues.remove(&window_label);
            }
            request
        };
        let Some(request) = request else {
            return;
        };

        let NavigationOperation {
            app,
            window_label,
            target_url,
            is_current,
            navigate,
        } = request.value;
        if !is_current() {
            complete_active(&window_label);
            continue;
        }
        let window_id = crate::identity::local_window_id(&window_label).ok();
        if let (Some(state), Some(window_id)) =
            (app.try_state::<ClientState>(), window_id.as_deref())
        {
            state.wait_for_renderer_flush(&app, &window_label, window_id, true);
        }
        if !is_current() {
            complete_active(&window_label);
            continue;
        }
        let result = crate::shutdown::with_navigation_authority(&app, || {
            let state = app.try_state::<ClientState>();
            execute_navigation_for(
                state.as_deref(),
                window_id.as_deref(),
                target_url.as_ref(),
                || navigate(app.clone()),
            )
        });
        if let Some(Err(err)) = result {
            eprintln!("[client-state] navigation failed: {err}");
        }

        complete_active(&window_label);
    }
}

fn execute_navigation(
    state: Option<&ClientState>,
    target_url: Option<&Url>,
    navigate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let window_id = state.map(ClientState::active_window_id).transpose()?;
    execute_navigation_for(state, window_id.as_deref(), target_url, navigate)
}

fn execute_navigation_for(
    state: Option<&ClientState>,
    window_id: Option<&str>,
    target_url: Option<&Url>,
    navigate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let pending = state
        .zip(window_id)
        .map(|(state, window_id)| {
            state
                .renderer_access
                .begin_navigation_for(window_id, target_url)
        })
        .transpose()?;
    let result = navigate();
    if result.is_err() {
        if let (Some(state), Some(pending)) = (state, pending) {
            state.renderer_access.cancel_navigation(pending);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn queued(kind: NavigationKind, name: &'static str) -> QueuedNavigation<&'static str> {
        QueuedNavigation::new(kind, name)
    }

    #[test]
    fn cli_navigation_survives_overlapping_reload_and_force_reload() {
        let mut queue = NavigationQueue::default();
        let cli = queued(NavigationKind::Cli, "cli");
        assert!(queue.enqueue(cli));

        let cli = queue.next().unwrap();
        assert_eq!(cli.value, "cli");
        let reload = queued(NavigationKind::Reload, "reload");
        assert!(!queue.enqueue(reload));
        let force_reload = queued(NavigationKind::ForceReload, "force reload");
        assert!(!queue.enqueue(force_reload));

        queue.complete_active();

        let force_reload = queue.next().unwrap();
        assert_eq!(force_reload.value, "force reload");
        queue.complete_active();
        assert!(queue.next().is_none());
    }

    #[test]
    fn cli_requests_jump_queued_reload_without_reordering_each_other() {
        let mut queue = NavigationQueue::default();
        let active_cli = queued(NavigationKind::Cli, "active cli");
        queue.enqueue(active_cli);
        queue.next().unwrap();

        let reload = queued(NavigationKind::Reload, "reload");
        let first_cli = queued(NavigationKind::Cli, "first cli");
        let second_cli = queued(NavigationKind::Cli, "second cli");
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
    fn identical_actions_in_different_window_queues_do_not_coalesce() {
        let mut queues: HashMap<&str, NavigationQueue<&str>> = HashMap::new();
        assert!(queues
            .entry("local-one")
            .or_default()
            .enqueue(queued(NavigationKind::Reload, "one")));
        assert!(queues
            .entry("local-two")
            .or_default()
            .enqueue(queued(NavigationKind::Reload, "two")));
        assert_eq!(
            queues.get_mut("local-one").unwrap().next().unwrap().value,
            "one"
        );
        assert_eq!(
            queues.get_mut("local-two").unwrap().next().unwrap().value,
            "two"
        );
    }

    #[test]
    fn failed_navigation_preserves_renderer_access_and_runs_once() {
        let directory = tempfile::tempdir().unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        let renderer_url = url::Url::parse("http://127.0.0.1:43123/workspace").unwrap();
        let window_id = state.active_window_id().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        state
            .renderer_access
            .claim_for(&window_id, "current-renderer", &renderer_url)
            .unwrap();

        let calls_for_navigation = Arc::clone(&calls);
        let result = execute_navigation(Some(&state), Some(&renderer_url), || {
            calls_for_navigation.fetch_add(1, Ordering::SeqCst);
            Err("synchronous navigation failure".to_string())
        });

        assert_eq!(result, Err("synchronous navigation failure".to_string()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        state
            .renderer_access
            .validate_for(&window_id, "current-renderer", &renderer_url)
            .unwrap();
    }

    #[test]
    fn accepted_navigation_rotates_renderer_access() {
        let directory = tempfile::tempdir().unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        let outgoing_url = url::Url::parse("http://127.0.0.1:43123/workspace").unwrap();
        let incoming_url = url::Url::parse("http://127.0.0.1:43124/workspace").unwrap();
        let window_id = state.active_window_id().unwrap();
        state
            .renderer_access
            .claim_for(&window_id, "outgoing-renderer", &outgoing_url)
            .unwrap();

        execute_navigation(Some(&state), Some(&incoming_url), || Ok(())).unwrap();

        state
            .renderer_access
            .validate_for(&window_id, "outgoing-renderer", &outgoing_url)
            .unwrap();
        assert!(state
            .renderer_access
            .allows_claim_origin_for(&window_id, &outgoing_url));
        state
            .renderer_access
            .claim_for(&window_id, "incoming-renderer", &incoming_url)
            .unwrap();
        assert!(state
            .renderer_access
            .validate_for(&window_id, "outgoing-renderer", &outgoing_url)
            .is_err());
        state
            .renderer_access
            .validate_for(&window_id, "incoming-renderer", &incoming_url)
            .unwrap();
    }
}
