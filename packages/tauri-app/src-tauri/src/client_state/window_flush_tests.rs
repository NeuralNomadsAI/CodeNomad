use super::*;
use std::sync::mpsc::{self, sync_channel, RecvTimeoutError};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

#[test]
fn worker_and_queue_stay_bounded_and_idle_worker_releases_callback() {
    let scheduler = WindowFlushScheduler::default();
    let (entered, entries) = mpsc::channel();
    let (release, releases) = mpsc::channel();
    let callback_owner = Arc::new(());
    let retained = Arc::downgrade(&callback_owner);
    scheduler
        .schedule(move || {
            let _owner = callback_owner;
            entered.send(thread::current().id()).unwrap();
            releases.recv_timeout(Duration::from_secs(5)).unwrap();
        })
        .unwrap();
    let worker_id = entries.recv_timeout(Duration::from_secs(5)).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let (trailing, trailing_calls) = mpsc::channel();
    for _ in 0..1_000 {
        let calls = Arc::clone(&calls);
        let trailing = trailing.clone();
        scheduler
            .schedule(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                trailing.send(thread::current().id()).unwrap();
            })
            .unwrap();
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
    assert_eq!(
        trailing_calls.recv_timeout(Duration::from_secs(5)).unwrap(),
        worker_id
    );
    assert!(
        retained.upgrade().is_none(),
        "idle worker retained its AppHandle-like owner"
    );
    scheduler.stop();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    scheduler
        .schedule(|| panic!("restarted after stop"))
        .unwrap();
    scheduler.stop();
}

#[test]
fn concurrent_stop_waits_for_drain_but_late_ui_submission_does_not() {
    let scheduler = Arc::new(WindowFlushScheduler::default());
    let (entered, entries) = mpsc::channel();
    let (release, releases) = mpsc::channel();
    scheduler
        .schedule(move || {
            entered.send(()).unwrap();
            releases.recv_timeout(Duration::from_secs(5)).unwrap();
        })
        .unwrap();
    entries.recv_timeout(Duration::from_secs(5)).unwrap();
    let stopping = Arc::clone(&scheduler);
    let (done, completion) = mpsc::channel();
    let first = thread::spawn(move || {
        stopping.stop();
        done.send(()).unwrap();
    });
    // Synchronize on the transition, not a sleep: stop has detached its worker.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !scheduler.state.lock().unwrap().stopping {
        assert!(std::time::Instant::now() < deadline);
        thread::yield_now();
    }
    let second_scheduler = Arc::clone(&scheduler);
    let (done, other_completion) = mpsc::channel();
    let second = thread::spawn(move || {
        second_scheduler.stop();
        done.send(()).unwrap();
    });
    scheduler
        .schedule(|| panic!("admitted after stop"))
        .unwrap();
    assert!(completion.try_recv().is_err());
    assert!(other_completion.try_recv().is_err());
    release.send(()).unwrap();
    completion.recv_timeout(Duration::from_secs(5)).unwrap();
    other_completion
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    first.join().unwrap();
    second.join().unwrap();
}

#[test]
fn stop_before_first_request_does_not_create_a_worker() {
    let scheduler = WindowFlushScheduler::default();
    scheduler.stop();
    scheduler
        .schedule(|| panic!("worker started after stop"))
        .unwrap();
    assert!(scheduler.state.lock().unwrap().worker.is_none());
}

#[test]
fn burst_requests_coalesce_to_one_flush() {
    let (sender, receiver) = sync_channel(1);
    let (flushed_sender, flushed_receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        run_debounced(receiver, Duration::from_millis(30), |()| {
            flushed_sender.send(()).unwrap();
        });
    });

    sender.try_send(()).unwrap();
    for _ in 0..256 {
        let _ = sender.try_send(());
    }
    flushed_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        flushed_receiver.recv_timeout(Duration::from_millis(80)),
        Err(RecvTimeoutError::Timeout)
    );

    drop(sender);
    worker.join().unwrap();
}

#[test]
fn request_during_flush_produces_one_trailing_flush() {
    let (sender, receiver) = sync_channel(1);
    let (entered_sender, entered_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut calls = 0;
        run_debounced(receiver, Duration::from_millis(20), |()| {
            calls += 1;
            entered_sender.send(calls).unwrap();
            if calls == 1 {
                release_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap();
            }
        });
    });

    sender.try_send(()).unwrap();
    assert_eq!(
        entered_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        1
    );
    for _ in 0..256 {
        let _ = sender.try_send(());
    }
    release_sender.send(()).unwrap();
    assert_eq!(
        entered_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        2
    );
    assert_eq!(
        entered_receiver.recv_timeout(Duration::from_millis(60)),
        Err(RecvTimeoutError::Timeout)
    );

    drop(sender);
    worker.join().unwrap();
}

#[test]
fn disconnect_drains_a_pending_request_without_waiting_for_debounce() {
    let (sender, receiver) = sync_channel(1);
    let (flushed_sender, flushed_receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        run_debounced(receiver, Duration::from_secs(10), |()| {
            flushed_sender.send(()).unwrap();
        });
    });

    sender.try_send(()).unwrap();
    drop(sender);
    flushed_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    worker.join().unwrap();
}
