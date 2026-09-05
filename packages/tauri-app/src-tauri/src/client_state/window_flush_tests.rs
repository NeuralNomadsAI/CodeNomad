use super::window_flush::run_debounced;
use std::sync::mpsc::{self, sync_channel, RecvTimeoutError};
use std::thread;
use std::time::Duration;

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
