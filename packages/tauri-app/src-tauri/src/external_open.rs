//! Opens external links in the user's default handler: help, release notes,
//! intercepted navigations and the links the renderer hands over. On Linux the
//! handler, often a browser that outlives an AppImage's mount, starts with the
//! host's environment (`appimage_environment`); elsewhere the opener plugin
//! launches it. Handoffs always run off the native event loop on a dedicated
//! FIFO worker thread.

use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Runtime};

type OpenJob = Box<dyn FnOnce() + Send>;

enum GlobalQueue {
    Uninitialized,
    Running(ExternalOpenQueue),
    Closed,
}

static QUEUE: Mutex<GlobalQueue> = Mutex::new(GlobalQueue::Uninitialized);

#[derive(Clone)]
pub(crate) struct ExternalOpenQueue {
    // Only admission is locked; openers never execute under this mutex.
    admission: Arc<Mutex<(mpsc::Sender<OpenJob>, bool)>>,
}

impl ExternalOpenQueue {
    fn new() -> Self {
        let (sender, receiver) = mpsc::channel::<OpenJob>();
        std::thread::Builder::new()
            .name("external-open".into())
            .spawn(move || receiver.into_iter().for_each(|job| job()))
            .expect("start external opener worker");
        Self {
            admission: Arc::new(Mutex::new((sender, true))),
        }
    }

    fn enqueue(&self, job: OpenJob) -> Result<(), String> {
        let admission = self
            .admission
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !admission.1 {
            return Err("External URL opener is closed for shutdown".to_string());
        }
        admission
            .0
            .send(job)
            .map_err(|_| "External URL opener worker stopped".to_string())
    }

    fn drain_until(&self, timeout: Duration) -> bool {
        let (done, barrier) = mpsc::sync_channel(1);
        {
            let mut admission = self
                .admission
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            admission.1 = false;
            if admission
                .0
                .send(Box::new(move || {
                    let _ = done.send(());
                }))
                .is_err()
            {
                return false;
            }
        }
        barrier.recv_timeout(timeout).is_ok()
    }

    fn enqueue_url(
        &self,
        url: String,
        open: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
        on_error: impl FnOnce(String) + Send + 'static,
    ) {
        if let Err(error) = self.enqueue(Box::new(move || {
            if let Err(error) = open(&url) {
                on_error(error);
            }
        })) {
            eprintln!("[tauri] failed to enqueue external URL handoff: {error}");
        }
    }

    async fn open_url_async(
        &self,
        url: String,
        open: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let (done, reply) = tokio::sync::oneshot::channel();
        self.enqueue(Box::new(move || {
            let _ = done.send(open(&url));
        }))?;
        reply
            .await
            .map_err(|_| "External URL opener dropped before replying".to_string())?
    }
}

fn open_global_queue() -> Option<ExternalOpenQueue> {
    let mut global = QUEUE.lock().unwrap_or_else(|error| error.into_inner());
    match &*global {
        GlobalQueue::Running(queue) => Some(queue.clone()),
        GlobalQueue::Closed => None,
        GlobalQueue::Uninitialized => {
            let queue = ExternalOpenQueue::new();
            *global = GlobalQueue::Running(queue.clone());
            Some(queue)
        }
    }
}

pub(crate) fn drain_pending(timeout: Duration) -> bool {
    let previous = {
        let mut global = QUEUE.lock().unwrap_or_else(|error| error.into_inner());
        std::mem::replace(&mut *global, GlobalQueue::Closed)
    };
    match previous {
        GlobalQueue::Running(queue) => queue.drain_until(timeout),
        GlobalQueue::Uninitialized | GlobalQueue::Closed => true,
    }
}

pub(crate) fn enqueue_open_url<R: Runtime>(
    app: &AppHandle<R>,
    url: String,
    on_error: impl FnOnce(AppHandle<R>, String) + Send + 'static,
) {
    let Some(queue) = open_global_queue() else {
        eprintln!("[tauri] failed to enqueue external URL handoff: External URL opener is closed for shutdown");
        return;
    };
    let worker_app = app.clone();
    let error_app = app.clone();
    queue.enqueue_url(
        url,
        move |url| open_url_blocking(&worker_app, url),
        move |error| on_error(error_app, error),
    );
}

pub(crate) async fn open_url_async<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let queue = open_global_queue()
        .ok_or_else(|| "External URL opener is closed for shutdown".to_string())?;
    queue
        .open_url_async(url, move |url| open_url_blocking(&app, url))
        .await
}

fn open_url_blocking<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        open_with_host_environment(url)
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|error| error.to_string())
    }
}

/// Tries the opener plugin's launchers (`xdg-open`, `gio open`, ...) in order, each
/// detached in its own session like the plugin's, so closing CodeNomad never
/// signals the handler.
#[cfg(target_os = "linux")]
fn open_with_host_environment(url: &str) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let mut last_error = None;
    for mut command in open::commands(url) {
        crate::appimage_environment::use_host_environment(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        match command.spawn() {
            Ok(mut child) => {
                // The launcher exits once it has handed the link over; reap it.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.map_or_else(|| "no URL launcher".to_string(), |error| error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{poll_fn, Future},
        pin::{pin, Pin},
        sync::{Arc, Mutex},
        task::Poll,
        time::Duration,
    };

    async fn assert_pending(mut future: Pin<&mut impl Future>) {
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    #[test]
    fn enqueue_returns_before_opener_completes_and_runs_off_dispatch_thread() {
        let queue = ExternalOpenQueue::new();
        let dispatch_thread = std::thread::current().id();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (error_tx, error_rx) = mpsc::channel();

        queue.enqueue_url(
            "https://example.com/help".into(),
            move |url| {
                started_tx
                    .send((std::thread::current().id(), url.to_string()))
                    .unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Err("launcher unavailable".into())
            },
            move |error| {
                error_tx.send(error).unwrap();
            },
        );

        let (worker_thread, url) = started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(worker_thread, dispatch_thread);
        assert_eq!(url, "https://example.com/help");
        assert!(error_rx.try_recv().is_err());

        release_tx.send(()).unwrap();
        assert_eq!(
            error_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "launcher unavailable"
        );
    }

    #[test]
    fn open_url_async_awaits_oneshot_without_blocking_executor() {
        let queue = ExternalOpenQueue::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        tauri::async_runtime::block_on(async {
            let mut opening = pin!(queue.open_url_async(
                "https://example.com/docs".into(),
                move |url| {
                    started_tx.send(url.to_string()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                }
            ));
            assert_pending(opening.as_mut()).await;
            assert_eq!(
                started_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                "https://example.com/docs"
            );
            assert_pending(opening.as_mut()).await;
            release_tx.send(()).unwrap();
            opening.await.unwrap();
        });
    }

    #[test]
    fn fifo_handoff_preserves_order_and_continues_after_error() {
        let queue = ExternalOpenQueue::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (done_tx, done_rx) = mpsc::channel();

        let first_seen = Arc::clone(&seen);
        let (err_tx, err_rx) = mpsc::channel();
        queue.enqueue_url(
            "https://example.com/first".into(),
            move |url| {
                first_seen.lock().unwrap().push(url.to_string());
                Err("first failed".into())
            },
            move |error| err_tx.send(error).unwrap(),
        );

        let second_seen = Arc::clone(&seen);
        queue.enqueue_url(
            "https://example.com/second".into(),
            move |url| {
                second_seen.lock().unwrap().push(url.to_string());
                done_tx.send(()).unwrap();
                Ok(())
            },
            |error| panic!("unexpected error: {error}"),
        );

        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            err_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "first failed"
        );
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "https://example.com/first".to_string(),
                "https://example.com/second".to_string(),
            ]
        );
    }

    #[test]
    fn drain_until_waits_for_queued_handoffs_and_bounds_stalled_openers() {
        let queue = ExternalOpenQueue::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (completed_tx, completed_rx) = mpsc::channel();

        queue.enqueue_url(
            "https://example.com/slow".into(),
            move |_| {
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                completed_tx.send(()).unwrap();
                Ok(())
            },
            |error| panic!("unexpected error: {error}"),
        );

        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // A stalled launcher does not block shutdown beyond the drain budget.
        assert!(!queue.drain_until(Duration::from_millis(30)));
        assert!(completed_rx.try_recv().is_err());

        release_tx.send(()).unwrap();
        assert!(queue.drain_until(Duration::from_secs(5)));
        completed_rx.try_recv().unwrap();
    }

    #[test]
    fn drain_seals_admission_so_post_barrier_handoffs_cannot_remain_pending() {
        let queue = Arc::new(ExternalOpenQueue::new());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        queue.enqueue_url(
            "https://example.com/in-flight".into(),
            move |_| {
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            },
            |error| panic!("unexpected error: {error}"),
        );
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        let draining = Arc::clone(&queue);
        let drain_handle = std::thread::spawn(move || draining.drain_until(Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(30));

        let late_ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let late_flag = Arc::clone(&late_ran);
        let late_admission = queue.enqueue(Box::new(move || {
            late_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }));

        release_tx.send(()).unwrap();
        assert!(drain_handle.join().unwrap());
        assert!(
            late_admission.is_err(),
            "handoffs enqueued after drain starts must be refused"
        );
        assert!(!late_ran.load(std::sync::atomic::Ordering::SeqCst));
    }
}
