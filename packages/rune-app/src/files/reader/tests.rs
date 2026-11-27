use super::*;
use std::time::Duration;
mod http;
use http::{Http, poll, wait};

fn open(reader: &mut Reader, path: &str) {
    reader.open("/private".into(), path.into());
    reader.poll(reader.clock);
}
fn bytes(reader: &Reader) -> Option<&[u8]> {
    reader.preview().map(|p| p.bytes.as_slice())
}

#[test]
fn replacing_a_held_target_fences_old_completion_and_uses_the_reserved_slot() {
    platform::block_on(async {
        let http = Http::new().await;
        let reads = Reads::default();
        let (_cancel, alive) = bounded(1);
        let _scan1 = reads.background(&alive).await.unwrap();
        let _scan2 = reads.background(&alive).await.unwrap();
        let mut reader = http.reader(reads.clone());
        open(&mut reader, "first.txt");
        let first = http.body("first.txt", "YQ==").await;
        let old_id = reader.sequence;
        let old_target = reader.target().unwrap().clone();
        assert!(reader.busy());
        open(&mut reader, "second.txt");
        let second = http.body("second.txt", "Yg==").await;
        reader
            .out
            .try_send((
                old_id,
                old_target,
                Ok(Preview {
                    workspace_id: "owned".into(),
                    path: "first.txt".into(),
                    bytes: b"stale".to_vec(),
                    version: None,
                }),
            ))
            .unwrap();
        reader.poll(1.0);
        assert!(reader.busy());
        assert!(reader.preview().is_none());
        assert_eq!(reader.target().unwrap().path, "second.txt");
        drop(first);
        second.finish().await;
        poll(&mut reader, |r| !r.busy()).await;
        assert_eq!(bytes(&reader), Some(b"b".as_slice()));
        assert_eq!(reader.preview().unwrap().version.as_deref(), Some("v1"));
        open(&mut reader, "third.txt");
        let third = http.body("third.txt", "YQ==").await;
        reader.close();
        assert!(reader.target().is_none() && reader.preview().is_none() && !reader.busy());
        let _slot = wait(reads.preview(&alive)).await.unwrap();
        drop(third);
    });
}

#[test]
fn refresh_failure_preserves_last_good_bytes_and_explicit_retry_recovers() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut reader = http.reader(Reads::default());
        open(&mut reader, "first.txt");
        http.body("first.txt", "YQ==").await.finish().await;
        poll(&mut reader, |r| !r.busy()).await;
        reader.refresh();
        reader.poll(1.0);
        http.body("first.txt", "invalid!").await.finish().await;
        poll(&mut reader, |r| !r.busy()).await;
        assert_eq!(bytes(&reader), Some(b"a".as_slice()));
        assert!(reader.error().is_some());
        reader.poll(50.0);
        http.quiet().await;
        reader.refresh();
        reader.poll(51.0);
        http.body("first.txt", "Yg==").await.finish().await;
        poll(&mut reader, |r| !r.busy()).await;
        assert_eq!(bytes(&reader), Some(b"b".as_slice()));
        assert!(reader.error().is_none());
    });
}

#[test]
fn repeated_refreshes_during_a_body_coalesce_one_trailing_read() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut reader = http.reader(Reads::default());
        open(&mut reader, "first.txt");
        let first = http.body("first.txt", "YQ==").await;
        for _ in 0..30 {
            reader.refresh();
            reader.poll(1.0);
        }
        http.quiet().await;
        first.finish().await;
        poll(&mut reader, |r| r.sequence == 2).await;
        let trailing = http.body("first.txt", "Yg==").await;
        assert_eq!(bytes(&reader), Some(b"a".as_slice()));
        trailing.finish().await;
        poll(&mut reader, |r| !r.busy()).await;
        reader.poll(100.0);
        http.quiet().await;
        assert_eq!(reader.sequence, 2);
        assert_eq!(bytes(&reader), Some(b"b".as_slice()));
    });
}

#[test]
fn tab_suspension_and_disconnect_cancel_bodies_preserve_target_and_revalidate() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut reader = http.reader(Reads::default());
        open(&mut reader, "first.txt");
        http.body("first.txt", "YQ==").await.finish().await;
        poll(&mut reader, |r| !r.busy()).await;
        reader.refresh();
        reader.poll(1.0);
        let held = http.body("first.txt", "Yg==").await;
        reader.activate(false);
        assert!(!reader.busy());
        assert_eq!(bytes(&reader), Some(b"a".as_slice()));
        reader.invalidate();
        reader.poll(10.0);
        http.quiet().await;
        drop(held);
        reader.activate(true);
        reader.poll(11.0);
        let resumed = http.body("first.txt", "Yg==").await;
        reader.online(false);
        reader.poll(20.0);
        http.quiet().await;
        assert_eq!(reader.target().unwrap().session, "session");
        drop(resumed);
        reader.online(true);
        reader.poll(21.0);
        http.body("first.txt", "Yg==").await.finish().await;
        poll(&mut reader, |r| !r.busy()).await;
        assert_eq!(bytes(&reader), Some(b"b".as_slice()));
    });
}

#[test]
fn queued_read_and_dropped_occurrence_cannot_dispatch_after_cancellation() {
    platform::block_on(async {
        let http = Http::new().await;
        let reads = Reads::default();
        let (_cancel, alive) = bounded(1);
        let slot = reads.preview(&alive).await.unwrap();
        let mut reader = http.reader(reads.clone());
        open(&mut reader, "first.txt");
        http.quiet().await;
        reader.close();
        drop(slot);
        http.quiet().await;
        open(&mut reader, "second.txt");
        let held = http.body("second.txt", "Yg==").await;
        drop(reader);
        let _released = wait(reads.preview(&alive)).await.unwrap();
        drop(held);
    });
}

#[test]
fn hidden_panel_keeps_reader_live_and_workspace_stop_closes_it() {
    platform::block_on(async {
        use crate::files::Ui;
        use codenomad_client::transport::{DirectoryChange, WorkspaceEvent};
        let http = Http::new().await;
        let mut ui = Ui::new(
            http.backend.clone(),
            "/private".into(),
            Reads::default(),
            std::sync::Arc::new(|| {}),
        );
        ui.online(true);
        ui.open("first.txt".into());
        ui.poll(1.0);
        http.body("first.txt", "YQ==").await.finish().await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while ui.reader.busy() {
            assert!(std::time::Instant::now() < deadline);
            ui.poll(1.0);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        ui.show(false);
        for (workspace, directory, now) in [
            ("foreign", "/private", 2.0),
            ("owned", "/other-worktree", 10.0),
        ] {
            ui.event(WorkspaceEvent::FilesChanged {
                workspace_id: workspace.into(),
                changes: vec![DirectoryChange {
                    directory: directory.into(),
                    path: ".".into(),
                }],
            });
            ui.poll(now);
            ui.poll(now + 0.2);
            http.quiet().await;
        }
        ui.event(WorkspaceEvent::FilesChanged {
            workspace_id: "owned".into(),
            changes: vec![DirectoryChange {
                directory: "/private".into(),
                path: ".".into(),
            }],
        });
        ui.poll(20.0);
        ui.poll(20.2);
        let refreshed = http.body("first.txt", "Yg==").await;
        assert_eq!(bytes(&ui.reader), Some(b"a".as_slice()));
        ui.event(WorkspaceEvent::Stopped {
            workspace_id: "owned".into(),
            deleted: false,
            temporary_retained: false,
        });
        assert!(ui.reader.target().is_none() && !ui.reader.busy());
        ui.online(true);
        ui.open("second.txt".into());
        ui.poll(30.0);
        http.quiet().await;
        drop(refreshed);
    });
}

#[test]
fn switching_the_directory_revokes_the_old_reader_before_polling_results() {
    platform::block_on(async {
        let http = Http::new().await;
        let reads = Reads::default();
        let mut ui = crate::files::Ui::new(
            http.backend.clone(),
            "/private".into(),
            reads.clone(),
            std::sync::Arc::new(|| {}),
        );
        ui.online(true);
        ui.open("first.txt".into());
        ui.poll(1.0);
        let held = http.body("first.txt", "YQ==").await;
        ui.tree.switch("/other".into());
        ui.poll(2.0);
        assert!(ui.reader.target().is_none() && !ui.reader.busy());
        let (_cancel, alive) = bounded(1);
        let _slot = wait(reads.preview(&alive)).await.unwrap();
        drop(held);
    });
}
