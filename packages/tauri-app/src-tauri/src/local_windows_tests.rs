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
fn new_window_admission_ignores_hidden_launch_windows() {
    let windows = LocalWindows::default();
    {
        let mut registry = windows.registry.lock().unwrap();
        registry.add_window(id(99), false, true).unwrap();
        for value in 0..MAX_LOCAL_WINDOWS - 1 {
            registry.add(id(value as u8), true).unwrap();
        }
    }
    // create_new_window's preflight: sixteen records, fifteen of them user windows.
    assert_eq!(windows.records().len(), MAX_LOCAL_WINDOWS);
    assert!(windows.has_user_window_capacity());
    windows.registry.lock().unwrap().add(id(98), true).unwrap();
    assert!(!windows.has_user_window_capacity());
    assert_eq!(
        windows.connect_only_labels(),
        vec![local_window_label(&id(99)).unwrap()]
    );
    assert!(windows.is_connect_only(&local_window_label(&id(99)).unwrap()));
    assert!(!windows.is_connect_only(&local_window_label(&id(0)).unwrap()));
    // Shutdown asks only user windows' renderers to persist their state.
    let user_labels = windows.user_window_labels();
    assert_eq!(user_labels.len(), MAX_LOCAL_WINDOWS);
    assert!(!user_labels.contains(&local_window_label(&id(99)).unwrap()));
}

#[test]
fn only_a_user_window_closing_beside_another_one_forgets_its_saved_state() {
    let windows = LocalWindows::default();
    let (first, second) = {
        let mut registry = windows.registry.lock().unwrap();
        // A hidden launch window and remote windows never count: they hold no local state.
        registry.add_window(id(99), false, true).unwrap();
        (
            registry.add(id(1), true).unwrap().label,
            registry.add(id(2), true).unwrap().label,
        )
    };
    assert!(windows.has_other_user_window(&first, |_| false));
    // The other one is already closing: this is the last local window, which keeps its state.
    assert!(!windows.has_other_user_window(&first, |label| label == second));
    windows.remove_runtime(&second);
    assert!(!windows.has_other_user_window(&first, |_| false));
}

#[test]
fn connect_only_launches_defer_the_preferences_restore_until_a_normal_start() {
    let windows = LocalWindows::default();
    assert!(!windows.startup_restore_deferred());
    windows.defer_startup_restore();
    assert!(windows.startup_restore_deferred());
    windows.release_startup_restore();
    assert!(!windows.startup_restore_deferred());
}

#[test]
fn hidden_launch_windows_hold_no_slot_and_are_never_launch_targets() {
    let mut registry = Registry::default();
    let launch = registry.add_window(id(99), false, true).unwrap();
    assert_eq!(
        registry.mru_label(),
        None,
        "folder launches never land in it"
    );
    assert_eq!(registry.mark_focused(&launch.label), None);
    assert_eq!(registry.mru_label(), None);
    for value in 0..MAX_LOCAL_WINDOWS {
        registry.add(id(value as u8), true).unwrap();
    }
    assert_eq!(
        registry.add(id(98), true).unwrap_err(),
        "Too many local windows",
        "all sixteen saved windows restore beside the hidden one"
    );
    assert_ne!(registry.mru_label(), Some(launch.label.clone()));
    registry.promote(&launch.label);
    assert_eq!(registry.mru_label(), Some(launch.label));
}

#[test]
fn hidden_launch_windows_settle_by_outcome() {
    let mut registry = Registry::default();
    let launch = registry.add_window(id(1), false, true).unwrap();
    registry
        .queue_connection(&launch.label, "prod".into(), None)
        .unwrap();
    assert_eq!(
        registry.next_connection(&launch.label).unwrap(),
        Some(PendingConnectionPayload {
            target: "prod".into(),
            failure: None,
            hidden: true,
        })
    );
    assert_eq!(
        registry
            .acknowledge_connection(&launch.label, "prod", None, false)
            .unwrap(),
        ConnectionSettlement::Close
    );

    registry
        .queue_connection(&launch.label, "missing".into(), None)
        .unwrap();
    registry
        .queue_connection(&launch.label, "later".into(), None)
        .unwrap();
    assert!(registry
        .acknowledge_connection(&launch.label, "later", None, false)
        .unwrap_err()
        .contains("out of order"));
    assert_eq!(
        registry
            .acknowledge_connection(&launch.label, "missing", Some("unknown".into()), false)
            .unwrap(),
        ConnectionSettlement::StartNormally(VecDeque::from([
            PendingConnection {
                target: "missing".into(),
                failure: Some("unknown".into()),
            },
            PendingConnection {
                target: "later".into(),
                failure: None,
            },
        ]))
    );
    assert_eq!(registry.next_connection(&launch.label).unwrap(), None);

    registry
        .queue_connection(&launch.label, "self-signed".into(), None)
        .unwrap();
    assert_eq!(
        registry
            .acknowledge_connection(&launch.label, "self-signed", None, true)
            .unwrap(),
        ConnectionSettlement::StartNormally(VecDeque::from([PendingConnection {
            target: "self-signed".into(),
            failure: None,
        }])),
        "a connection that needs a prompt runs in a visible window"
    );

    registry
        .queue_connection(&launch.label, "slow".into(), None)
        .unwrap();
    assert_eq!(registry.abandon_connections(&launch.label).len(), 1);
    assert!(registry.abandon_connections(&launch.label).is_empty());
}

#[test]
fn ordinary_windows_report_their_own_failures_and_stay_open() {
    let mut registry = Registry::default();
    let local = registry.add(id(1), true).unwrap();
    registry
        .queue_connection(
            &local.label,
            "missing".into(),
            Some("No saved server".into()),
        )
        .unwrap();
    registry
        .queue_connection(&local.label, "down".into(), None)
        .unwrap();
    assert_eq!(
        registry.next_connection(&local.label).unwrap(),
        Some(PendingConnectionPayload {
            target: "missing".into(),
            failure: Some("No saved server".into()),
            hidden: false,
        })
    );
    assert_eq!(
        registry
            .acknowledge_connection(&local.label, "missing", None, false)
            .unwrap(),
        ConnectionSettlement::Keep
    );
    assert_eq!(
        registry
            .acknowledge_connection(&local.label, "down", Some("unreachable".into()), false)
            .unwrap(),
        ConnectionSettlement::Keep
    );
    assert!(registry.abandon_connections(&local.label).is_empty());
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
fn updates_requested_from_preferences_or_remote_run_in_the_last_local_window() {
    let local = format!("local-{}", id(1));
    let other = format!("local-{}", id(2));
    for focused in ["preferences", "remote-profile"] {
        assert_eq!(select_update_label(Some(focused), Some(&local)), Some(local.clone()));
    }
    assert_eq!(select_update_label(Some(&other), Some(&local)), Some(other));
    assert_eq!(select_update_label(Some("preferences"), None), None);
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
            "timeline": { "label": "Timeline", "checked": true, "enabled": true }
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
