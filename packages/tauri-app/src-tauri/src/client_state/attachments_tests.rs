use super::*;
use std::fs;
use std::sync::{Arc, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};

fn vector() -> Value {
    serde_json::from_str(include_str!("../../../../electron-app/electron/main/client-state-attachment-vector.json")).unwrap()
}

fn snapshot() -> Value {
    json!({"version":1, "revision":1, "savedAt":1, "layout":{}, "session":{"activeTabIndex":0,
        "tabs":[{"kind":"workspace", "serverId":"unknown-A", "folder":"Z:\\Case\\Project/ ", "drafts":{"secret":"DRAFT_SENTINEL"}}]}})
}

#[test]
fn attachments_real_v1_v2_v3_migrations_keep_exact_shells_and_unknown_live_coverage() {
    let fixture = vector();
    for version in [1, 2, 3] {
        let directory = tempfile::tempdir().unwrap();
        let initial = if version == 1 {
            json!({"version":1, "restoreEnabled":true, "snapshot":snapshot()})
        } else {
            json!({"version":2, "restoreEnabled":true, "protocolVersion":1,
                "snapshot":fixture["root"], "partitionKeys":fixture["partitionKeys"]})
        };
        fs::write(directory.path().join("client-state.json"), serde_json::to_vec(&initial).unwrap()).unwrap();
        fs::create_dir(directory.path().join("partitions")).unwrap();
        for (key, text) in fixture["partitions"].as_object().unwrap() {
            fs::write(directory.path().join("partitions").join(key), text.as_str().unwrap()).unwrap();
        }
        let state = ClientState::initialize_at(directory.path()).unwrap();
        if version == 3 {
            let payload = json!({"protocolVersion":1, "snapshot":fixture["root"], "partitionKeys":fixture["partitionKeys"], "partitions":fixture["partitions"]});
            state.commit_partitions_guarded(serde_json::from_value(payload).unwrap(), || true).unwrap();
        }
        let windows = LocalWindows::default();
        let result = state.attachment_inventory(&windows).unwrap();
        assert_eq!(result["status"], "unknown");
        assert_eq!(result["retainedStatus"], "complete");
        assert_eq!(result["refs"][0]["serverId"], "unknown-A");
        assert_eq!(result["refs"][0]["directory"], "Z:\\Case\\Project/ ");
        assert_eq!(result["owners"].as_array().unwrap().len(), 1);
        assert!(state.attachment_receipt_current(result["receipt"].as_str().unwrap(), &windows));
        assert!(!result.to_string().contains("DRAFT_SENTINEL"));
        assert!(!result.to_string().contains("sessionPartition"));
        if version != 1 {
            let manifest = fixture["root"]["sessionPartition"].as_str().unwrap();
            fs::write(directory.path().join("partitions").join(manifest), "corrupt").unwrap();
            assert_eq!(state.attachment_inventory(&windows).unwrap()["retainedStatus"], "unknown");
            fs::remove_file(directory.path().join("partitions").join(manifest)).unwrap();
            assert_eq!(state.attachment_inventory(&windows).unwrap()["retainedStatus"], "unknown");
        }
    }
}

#[test]
fn attachments_metadata_never_follows_workspace_content_and_rejects_overflow_or_bad_identity() {
    let fixture = vector();
    let record = WindowRecord { restore_enabled:true, snapshot:Some(fixture["root"].clone()), partition_protocol_version:Some(1),
        partition_keys:Some(serde_json::from_value(fixture["partitionKeys"].clone()).unwrap()), ..WindowRecord::default() };
    let key = fixture["root"]["sessionPartition"].as_str().unwrap();
    let tabs = project_metadata(&record, |requested| {
        assert_eq!(requested, key, "only the manifest may be read");
        Some(fixture["partitions"][key].as_str().unwrap().to_string())
    }).unwrap();
    assert_eq!(tabs.len(), 1);
    for shell in [json!({"kind":"workspace","folder":"/x","serverId":"../bad"}),
        json!({"kind":"workspace","folder":"x\u{0}y"}), json!({"kind":"workspace","folder":"/x","occurrence":32}), json!({"kind":"unknown"})] {
        let record = WindowRecord { snapshot:Some(json!({"version":1,"session":{"tabs":[shell],"activeTabIndex":0}})), ..WindowRecord::default() };
        assert!(project_metadata(&record, |_| panic!("content read forbidden")).is_none());
    }
    let record = WindowRecord { snapshot:Some(json!({"version":1,"session":{"tabs":vec![json!({"kind":"workspace","folder":"/x"});33],"activeTabIndex":0}})), ..WindowRecord::default() };
    assert!(project_metadata(&record, |_| panic!("content read forbidden")).is_none());
}

#[test]
fn attachments_corrupt_future_secondary_restore_off_and_receipt_aba_are_honest() {
    for raw in ["{", "{\"version\":99}"] {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("client-state.json"), raw).unwrap();
        let state = ClientState::initialize_at(directory.path()).unwrap();
        assert_eq!(state.attachment_inventory(&LocalWindows::default()).unwrap()["retainedStatus"], "unknown");
    }
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    state.save_snapshot(snapshot()).unwrap();
    let windows = LocalWindows::default();
    let first = state.attachment_inventory(&windows).unwrap();
    let secondary = ClientState::initialize_at(directory.path()).unwrap();
    assert_eq!(secondary.attachment_inventory(&windows).unwrap()["retainedStatus"], "unknown");
    let id = state.active_window_id().unwrap();
    state.unregister_window(&id);
    assert!(!state.attachment_receipt_current(first["receipt"].as_str().unwrap(), &windows));
    let second = state.attachment_inventory(&windows).unwrap();
    state.remove_window(&id).unwrap(); state.add_window(id).unwrap();
    assert!(!state.attachment_receipt_current(second["receipt"].as_str().unwrap(), &windows));
    state.set_restore_enabled(false).unwrap();
    let disabled = state.attachment_inventory(&windows).unwrap();
    assert_eq!(disabled["status"], "unknown");
    assert_eq!(disabled["refs"], json!([]));
    state.release_locks();
    assert!(!state.attachment_receipt_current(disabled["receipt"].as_str().unwrap(), &windows));
}

#[test]
fn attachments_wait_for_real_publication_and_rollback_then_recover_with_a_new_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let holding = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = std::sync::Mutex::new(release_rx);
    let flag = holding.clone();
    let state = Arc::new(ClientState::initialize_at_with_writer(directory.path(), Arc::new(move |path, bytes, valid| {
        if flag.load(Ordering::SeqCst) {
            entered_tx.send(()).unwrap(); release_rx.lock().unwrap().recv().unwrap();
            return Err("owned write failure".into());
        }
        super::super::write_atomically(path, bytes, valid)
    })).unwrap());
    state.save_snapshot(snapshot()).unwrap();
    let windows = Arc::new(LocalWindows::default());
    let first = state.attachment_inventory(&windows).unwrap();
    holding.store(true, Ordering::SeqCst);
    let writer_state = state.clone();
    let writer = std::thread::spawn(move || writer_state.save_snapshot(json!({"version":1,"session":null})));
    entered_rx.recv().unwrap();
    assert!(!state.attachment_receipt_current(first["receipt"].as_str().unwrap(), &windows));
    let reader_state = state.clone(); let reader_windows = windows.clone();
    let (read_tx, read_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || read_tx.send(reader_state.attachment_inventory(&reader_windows)).unwrap());
    assert!(read_rx.try_recv().is_err());
    release_tx.send(()).unwrap();
    assert!(writer.join().unwrap().is_err()); reader.join().unwrap();
    assert_eq!(read_rx.recv().unwrap().unwrap()["retainedStatus"], "unknown");
    holding.store(false, Ordering::SeqCst);
    state.save_snapshot(snapshot()).unwrap();
    let fresh = state.attachment_inventory(&windows).unwrap();
    assert_eq!(fresh["refs"][0]["serverId"], "unknown-A");
    assert!(state.attachment_receipt_current(fresh["receipt"].as_str().unwrap(), &windows));
}

#[test]
fn attachments_receipts_belong_to_the_private_transport_backend_generation_even_when_empty() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    state.save_snapshot(json!({"version":1,"session":null})).unwrap();
    let windows = LocalWindows::default();
    state.bind_attachment_backend(1);
    let first = state.attachment_inventory(&windows).unwrap();
    assert!(state.attachment_receipt_current(first["receipt"].as_str().unwrap(), &windows));
    state.bind_attachment_backend(2);
    assert!(!state.attachment_receipt_current(first["receipt"].as_str().unwrap(), &windows));
    let fresh = state.attachment_inventory(&windows).unwrap();
    assert_eq!(fresh["status"], "unknown");
    assert_eq!(fresh["retainedStatus"], "complete");
    assert!(state.attachment_receipt_current(fresh["receipt"].as_str().unwrap(), &windows));
}

#[test]
fn attachments_union_uses_real_live_registry_including_ephemeral_and_retained_only_windows() {
    let directory = tempfile::tempdir().unwrap();
    let state = ClientState::initialize_at(directory.path()).unwrap();
    state.save_snapshot(snapshot()).unwrap();
    let retained = uuid::Uuid::new_v4().to_string();
    state.add_window(retained.clone()).unwrap();
    state.save_snapshot_guarded_for(&retained, snapshot(), || true).unwrap();
    let windows = LocalWindows::default();
    windows.register(state.active_window_id().unwrap(), true).unwrap();
    let ephemeral = windows.register(uuid::Uuid::new_v4().to_string(), false).unwrap();
    assert!(windows.register("preferences".into(), false).is_err());
    assert!(windows.register("remote-foreign-backend".into(), false).is_err());
    let result = state.attachment_inventory(&windows).unwrap();
    let owners = result["owners"].as_array().unwrap();
    assert_eq!(owners.len(), 3);
    assert_eq!(owners.iter().filter(|owner| owner["live"] == true && owner["retained"] == true).count(), 1);
    assert_eq!(result["refs"].as_array().unwrap().len(), 2);
    assert_eq!(result["status"], "unknown");
    assert!(state.attachment_receipt_current(result["receipt"].as_str().unwrap(), &windows));
    windows.remove_runtime(&ephemeral.label).unwrap();
    windows.register(ephemeral.id, false).unwrap();
    assert!(!state.attachment_receipt_current(result["receipt"].as_str().unwrap(), &windows));
}

#[test]
fn attachments_fence_each_waiting_writer_before_and_after_real_root_publication() {
    let directory = tempfile::tempdir().unwrap();
    let hold = Arc::new(AtomicBool::new(false));
    let flag = hold.clone();
    let (persisted_tx, persisted_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let finish_rx = std::sync::Mutex::new(finish_rx);
    let state = Arc::new(ClientState::initialize_at_with_writer(directory.path(), Arc::new(move |path, bytes, valid| {
        super::super::write_atomically(path, bytes, valid)?;
        if flag.swap(false, Ordering::SeqCst) {
            persisted_tx.send(()).unwrap();
            finish_rx.lock().unwrap().recv().unwrap();
        }
        Ok(())
    })).unwrap());
    state.save_snapshot(json!({"version":1,"session":null})).unwrap();
    let windows = LocalWindows::default();
    let first = state.attachment_inventory(&windows).unwrap();
    let (admitted_tx, admitted_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    state.attachment_state.lock().unwrap().after_admission = Some(Box::new(move || {
        admitted_tx.send(()).unwrap(); resume_rx.recv().unwrap();
    }));
    hold.store(true, Ordering::SeqCst);
    let writing = state.clone();
    let writer = std::thread::spawn(move || writing.save_snapshot(snapshot()));
    admitted_rx.recv().unwrap();
    assert!(!state.attachment_receipt_current(first["receipt"].as_str().unwrap(), &windows));
    let empty = state.attachment_inventory(&windows).unwrap();
    assert_eq!(empty["retainedStatus"], "complete");
    assert_eq!(empty["refs"], json!([]));
    assert!(!state.attachment_receipt_current(empty["receipt"].as_str().unwrap(), &windows));
    resume_tx.send(()).unwrap();
    persisted_rx.recv().unwrap();
    assert!(fs::read_to_string(directory.path().join("client-state.json")).unwrap().contains("unknown-A"));
    let during_publication = state.attachment_receipt_current(empty["receipt"].as_str().unwrap(), &windows);

    let (queued_tx, queued_rx) = mpsc::channel();
    let (resume_next_tx, resume_next_rx) = mpsc::channel();
    state.attachment_state.lock().unwrap().after_admission = Some(Box::new(move || {
        queued_tx.send(()).unwrap(); resume_next_rx.recv().unwrap();
    }));
    let writing = state.clone();
    let next = std::thread::spawn(move || writing.save_snapshot(json!({"version":1,"session":null})));
    queued_rx.recv().unwrap();
    finish_tx.send(()).unwrap();
    assert!(writer.join().unwrap().unwrap());
    let between = state.attachment_inventory(&windows).unwrap();
    assert_eq!(between["refs"][0]["serverId"], "unknown-A");
    let while_next_waits = state.attachment_receipt_current(between["receipt"].as_str().unwrap(), &windows);
    resume_next_tx.send(()).unwrap();
    assert!(next.join().unwrap().unwrap());
    let fresh = state.attachment_inventory(&windows).unwrap();
    assert_eq!(fresh["refs"], json!([]));
    assert_eq!(fresh["retainedStatus"], "complete");
    assert_eq!(fresh["status"], "unknown");
    assert!(state.attachment_receipt_current(fresh["receipt"].as_str().unwrap(), &windows));
    assert!(!state.attachment_receipt_current(empty["receipt"].as_str().unwrap(), &windows));
    assert!(!state.attachment_receipt_current(between["receipt"].as_str().unwrap(), &windows));
    assert!(!during_publication, "an empty receipt survived root commit before writer return");
    assert!(!while_next_waits, "a waiting writer lost its publication fence");
}

#[test]
fn attachments_real_manifest_exact_limit_overflow_and_fresh_recovery() {
    use sha2::{Digest, Sha256};
    let fixture = vector();
    let original_key = fixture["root"]["sessionPartition"].as_str().unwrap();
    let original = fixture["partitions"][original_key].as_str().unwrap();
    let manifest = format!("{original}{}", " ".repeat(1024 * 1024 - original.len()));
    let key = format!("{:x}", Sha256::digest(manifest.as_bytes()));
    let mut keys: Vec<String> = fixture["partitionKeys"].as_array().unwrap().iter().map(|value| {
        let value = value.as_str().unwrap(); if value == original_key { key.clone() } else { value.to_string() }
    }).collect();
    keys.sort();
    let mut root = fixture["root"].clone();
    root["sessionPartition"] = json!(key);
    root["partitionKeys"] = json!(keys);
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("partitions")).unwrap();
    let path = directory.path().join("partitions").join(&key);
    fs::write(&path, &manifest).unwrap();
    fs::write(directory.path().join("client-state.json"), serde_json::to_vec(&json!({"version":2,
        "restoreEnabled":true,"protocolVersion":1,"snapshot":root,"partitionKeys":keys})).unwrap()).unwrap();
    // The referenced workspace partition is absent; metadata reads the manifest only.
    let state = ClientState::initialize_at(directory.path()).unwrap();
    let windows = LocalWindows::default();
    let first = state.attachment_inventory(&windows).unwrap();
    assert_eq!(first["retainedStatus"], "complete");
    assert_eq!(first["refs"].as_array().unwrap().len(), 1);
    assert!(state.attachment_receipt_current(first["receipt"].as_str().unwrap(), &windows));
    fs::write(&path, format!("{manifest} ")).unwrap();
    let refused = state.attachment_inventory(&windows).unwrap();
    assert_eq!(refused["retainedStatus"], "unknown");
    assert!(!state.attachment_receipt_current(first["receipt"].as_str().unwrap(), &windows));
    fs::write(&path, &manifest).unwrap();
    let fresh = state.attachment_inventory(&windows).unwrap();
    assert_eq!(fresh["retainedStatus"], "complete");
    assert_eq!(fresh["status"], "unknown");
    assert!(state.attachment_receipt_current(fresh["receipt"].as_str().unwrap(), &windows));
    assert!(!state.attachment_receipt_current(refused["receipt"].as_str().unwrap(), &windows));
}
