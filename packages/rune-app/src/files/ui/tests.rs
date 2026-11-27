use super::*;
use codenomad_client::{files::EntryKind, transport::DirectoryChange};

fn owner() -> Ui {
    let mut backend = platform::block_on(Backend::connect("http://127.0.0.1:1/", "")).unwrap();
    backend.workspace = "owned".into();
    backend.session = "session".into();
    let mut ui = Ui::new(
        backend,
        "/private".into(),
        Reads::default(),
        std::sync::Arc::new(|| {}),
    );
    ui.host_width = Some(1000.0);
    ui.tree.activate(true);
    let read = ui.tree.take_refresh().pop().unwrap();
    assert!(ui.tree.complete(
        read,
        Ok(vec![Entry {
            name: "src".into(),
            path: "src".into(),
            kind: EntryKind::Directory,
            absolute_path: None,
            directory_identity: Some("inode".into()),
            size: None,
            modified_at: None,
        }]),
        Ok
    ));
    ui.tree.activate(false);
    ui.snapshot();
    ui
}
fn observed(ui: &mut Ui, workspace: &str) {
    ui.event(WorkspaceEvent::FilesChanged {
        workspace_id: workspace.into(),
        changes: vec![DirectoryChange {
            directory: "/private".into(),
            path: ".".into(),
        }],
    });
}
fn stale(ui: &mut Ui) -> bool {
    ui.tree.activate(true);
    ui.tree.refresh(false);
    let requests = ui.tree.take_refresh();
    let stale = !requests.is_empty();
    ui.tree.activate(false);
    stale
}

#[test]
fn stream_reconnect_restores_files_while_detached_from_live_transcript() {
    use crate::transport::Event;
    let mut s = crate::init();
    let (out, incoming) = crate::bounded(2);
    s.incoming = Some(incoming);
    s.files = Some(owner());
    s.files.as_mut().unwrap().online(true);
    s.history_detached = true;
    out.try_send(Event::Reconnecting).unwrap();
    out.try_send(Event::AgentHint(true)).unwrap();
    assert!(crate::poll_chat(&mut s, 1));
    assert!(!s.files.as_ref().unwrap().online);
    assert!(crate::poll_chat(&mut s, 1));
    assert!(s.files.as_ref().unwrap().online);
    assert!(s.history_detached);
}

#[test]
fn suspension_preserves_selection_and_expansion_while_revoking_pending_reads() {
    let mut ui = owner();
    ui.panel = true;
    ui.online = true;
    ui.activate(true);
    ui.tree.select("src".into());
    let read = ui.tree.toggle("src").pop().unwrap();
    ui.activate(false);
    assert!(read.cancelled());
    assert!(!ui.tree.complete(read, Ok(vec![]), Ok));
    assert_eq!(ui.rows.len(), 1);
    assert_eq!(ui.tree.selected(), Some("src"));
    assert!(ui.tree.expanded("src"));
    assert!(!ui.rows[0].busy);
    assert!(ui.tree.take_refresh().is_empty());
    ui.activate(true);
    assert!(ui.tree.take_refresh().is_empty());
    ui.host_width = Some(1000.0);
    ui.activate(true);
    let next = ui.tree.take_refresh();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].path, "src");
}

#[test]
fn browsed_checkout_change_closes_the_reader_and_reuses_each_listing() {
    let mut ui = owner();
    ui.open("src/file.txt".into());
    ui.tree.select("src".into());
    ui.browse("/private".into());
    assert!(ui.reader.target().is_some());
    ui.browse("/other".into());
    assert!(ui.reader.target().is_none());
    assert!(ui.rows.is_empty());
    ui.browse("/private".into());
    assert_eq!(ui.rows[0].entry.path, "src");
    assert_eq!(ui.tree.selected(), Some("src"));
}

#[test]
fn compressed_hidden_drawer_revokes_tree_reads_and_retains_its_intention() {
    let mut ui = owner();
    ui.panel = true;
    ui.online = true;
    ui.activate(true);
    let read = ui.tree.load("src", true).unwrap();
    ui.host_width = Some(589.0);
    ui.activate(true);
    assert!(read.cancelled());
    assert!(ui.tree.take_refresh().is_empty());
    assert!(ui.panel);
    assert!(!ui.drawer().pinned);
    ui.host_width = Some(1000.0);
    ui.activate(true);
    assert!(ui.drawer().pinned);
}

#[test]
fn passive_bursts_coalesce_before_invalidating_hidden_snapshots() {
    let mut ui = owner();
    observed(&mut ui, "foreign");
    ui.poll(10.0);
    assert!(!stale(&mut ui));
    observed(&mut ui, "owned");
    observed(&mut ui, "owned");
    ui.poll(10.05);
    assert!(!stale(&mut ui));
    ui.poll(10.11);
    assert!(stale(&mut ui));
    assert_eq!(ui.rows[0].entry.path, "src");
    // A full authoritative read settles the first batch.
    ui.tree.activate(true);
    ui.tree.refresh(false);
    let read = ui.tree.take_refresh().pop().unwrap();
    assert!(ui.tree.complete(read, Ok(vec![]), Ok));
    ui.tree.activate(false);
    observed(&mut ui, "owned");
    ui.poll(10.3);
    assert!(!stale(&mut ui));
    ui.poll(15.12);
    assert!(stale(&mut ui));
    assert!(ui.tree.take_refresh().is_empty());
}

#[test]
fn reconnect_invalidates_all_retained_directory_snapshots_without_hidden_reads() {
    let mut ui = owner();
    ui.tree.switch("/other".into());
    ui.tree.activate(true);
    let read = ui.tree.take_refresh().pop().unwrap();
    assert!(ui.tree.complete(read, Ok(vec![]), Ok));
    ui.tree.activate(false);
    ui.online(true);
    ui.poll(1.0);
    assert!(ui.tree.take_refresh().is_empty());
    assert!(stale(&mut ui));
    ui.tree.switch("/private".into());
    assert!(stale(&mut ui));
    assert_eq!(ui.tree.rows().len(), 1);
}

#[test]
fn workspace_stop_revokes_requests_and_cannot_be_reopened_by_a_late_sync() {
    let mut ui = owner();
    ui.tree.activate(true);
    let read = ui.tree.load("src", true).unwrap();
    ui.event(WorkspaceEvent::Stopped {
        workspace_id: "foreign".into(),
        deleted: false,
        temporary_retained: false,
    });
    assert!(!read.cancelled());
    ui.event(WorkspaceEvent::Stopped {
        workspace_id: "owned".into(),
        deleted: false,
        temporary_retained: false,
    });
    assert!(ui.stopped);
    assert!(read.cancelled());
    ui.online(true);
    ui.show(true);
    ui.poll(100.0);
    assert!(ui.tree.load(".", true).is_none());
}
