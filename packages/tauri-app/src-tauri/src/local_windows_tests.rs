use super::*;

fn id(value: u8) -> String {
    format!("00000000-0000-4000-8000-{value:012}")
}

#[test]
fn registry_tracks_uuid_labels_mru_and_folder_ack_order() {
    let mut registry = Registry::default();
    let first = registry.add(id(1), true).unwrap();
    let second = registry.add(id(2), true).unwrap();
    assert_eq!(registry.mru_label(), Some(second.label.clone()));
    assert_eq!(registry.mark_focused(&first.label), Some(first.id.clone()));
    assert_eq!(registry.mru_label(), Some(first.label.clone()));
    let record = registry.records.get_mut(&first.label).unwrap();
    record.pending_folders.push_back(PendingFolder {
        path: "one".to_string(),
        attempts: 0,
    });
    record.pending_folders.push_back(PendingFolder {
        path: "two".to_string(),
        attempts: 0,
    });
    assert_eq!(
        record
            .pending_folders
            .front()
            .map(|pending| pending.path.as_str()),
        Some("one")
    );
    assert_eq!(registry.remove(&first.label).unwrap().id, first.id);
    assert_eq!(registry.mru_label(), Some(second.label));
}

#[test]
fn registry_enforces_maximum_and_lowercase_labels() {
    let mut registry = Registry::default();
    for value in 0..MAX_LOCAL_WINDOWS {
        registry.add(id(value as u8), true).unwrap();
    }
    assert_eq!(
        registry.add(id(99), false).unwrap_err(),
        "Too many local windows"
    );
}

#[test]
fn remote_focus_never_falls_through_to_background_local() {
    let local = format!("local-{}", id(1));
    assert_eq!(
        select_local_label(Some("remote-profile"), Some(&local)),
        None
    );
    assert_eq!(select_local_label(None, Some(&local)), Some(local.clone()));
    assert_eq!(select_local_label(Some(&local), None), Some(local));
}

#[test]
fn browser_children_are_not_top_level_focus_targets() {
    let local = format!("local-{}", id(1));
    assert!(is_primary_webview_label(&local, &local));
    assert!(!is_primary_webview_label("browser-registration", &local));
}
