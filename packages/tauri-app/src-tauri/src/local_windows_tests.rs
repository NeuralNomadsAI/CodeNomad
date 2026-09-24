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

#[test]
fn menu_toggle_during_native_focus_gap_keeps_view_and_file_commands_enabled() {
    let windows = LocalWindows::default();
    let local = windows.registry.lock().unwrap().add(id(1), true).unwrap();
    let snapshot = |checked| {
        serde_json::from_value::<crate::view_menu::ViewMenuState>(serde_json::json!({
            "leftPanel": { "label": "Left", "checked": checked, "enabled": true },
            "rightPanel": { "label": "Right", "checked": true, "enabled": true },
            "timeline": { "label": "Timeline", "checked": true, "enabled": true },
            "timelineTools": { "label": "Tools", "checked": true, "enabled": true }
        })).unwrap()
    };
    windows.set_workspace_menu_enabled(&local.label, true).unwrap();
    windows.set_view_menu_state(&local.label, Some(snapshot(true))).unwrap();
    assert_eq!(windows.menu_state(Some(&local.label)), (true, Some(snapshot(true))));

    // The native popup temporarily owns focus, then the renderer publishes the
    // unchecked panel. Both menus must retain the same target as click dispatch.
    assert_eq!(windows.menu_state(None), (true, Some(snapshot(true))));
    windows.set_view_menu_state(&local.label, Some(snapshot(false))).unwrap();
    assert_eq!(windows.menu_state(None), (true, Some(snapshot(false))));
    assert_eq!(windows.menu_state(Some(&local.label)), (true, Some(snapshot(false))));

    for non_local in ["remote-profile", crate::preferences_window::LABEL] {
        assert_eq!(windows.menu_state(Some(non_local)), (false, None));
    }
    let other = windows.registry.lock().unwrap().add(id(2), true).unwrap();
    assert_eq!(windows.menu_state(Some(&local.label)), (true, Some(snapshot(false))));
    assert_eq!(windows.menu_state(None), (false, None), "new MRU has no project");
    windows.remove_runtime(&other.label);
    assert_eq!(windows.menu_state(None), (true, Some(snapshot(false))));
    windows.set_workspace_menu_enabled(&local.label, false).unwrap();
    assert_eq!(windows.menu_state(None), (false, None), "reload clears both snapshots");
    windows.remove_runtime(&local.label);
    assert_eq!(windows.menu_state(None), (false, None), "closed windows cannot remain targets");
}
