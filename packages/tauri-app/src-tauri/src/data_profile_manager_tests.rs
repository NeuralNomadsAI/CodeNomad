use super::*;
use crate::data_profile::shared_vectors;
use crate::profile_transition::{
    remembered_profile_state, RememberedProfileState, TransitionContext,
};
use serde_json::{json, Value};

fn days(count: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(count * 86_400)
}

fn touch(path: &Path, modified: SystemTime) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
}

/// The folder's birth time where the platform records one (not every Linux filesystem does).
fn birth(folder: &Path) -> Option<u64> {
    let created = fs::symlink_metadata(folder)
        .ok()
        .and_then(|metadata| metadata.created().ok())
        .and_then(epoch_millis);
    if cfg!(any(windows, target_os = "macos")) {
        assert!(created.is_some(), "{}", folder.display());
    }
    created
}

fn listed<'a>(listing: &'a OtherProfilesListing, id: &str) -> &'a OtherProfile {
    listing
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .unwrap()
}

fn choices_file(fixture: &Fixture) -> PathBuf {
    fixture
        .roots
        .electron_base
        .join("profile-selection")
        .join("choices.json")
}

fn write_choices(fixture: &Fixture, choices: Value) {
    fixture.file(&choices_file(fixture), 0);
    fs::write(
        choices_file(fixture),
        json!({ "version": 1, "choices": choices }).to_string(),
    )
    .unwrap();
}

fn stored_choices(fixture: &Fixture) -> Value {
    serde_json::from_str::<Value>(&fs::read_to_string(choices_file(fixture)).unwrap()).unwrap()
        ["choices"]
        .clone()
}

fn choose(fixture: &Fixture, name: &str) -> NextLaunchOutcome {
    set_next_launch(
        &fixture.roots,
        &current("dev", CONFIG),
        name,
        SystemTime::now(),
    )
    .outcome
}

#[test]
fn every_profile_reports_its_folder_birth_and_its_newest_state_file() {
    let fixture = Fixture::populated();
    let roots = &fixture.roots;
    let state = |key: &str| {
        fixture
            .electron_scope(key, CONFIG)
            .join("client-state")
            .join("client-state.json")
    };
    let shared = roots.home_client_state.join("v2").join("client-state.json");
    // The fixture's state files hold nothing restorable: every existing one counts anyway.
    touch(&state("dev"), days(20_300));
    touch(&state("dev-v2"), days(20_000));
    touch(&shared, days(20_100));
    touch(&roots.electron_base.join("client-state.json"), days(20_200));
    touch(
        &roots
            .tauri_data_parent
            .join(STABLE_IDENTIFIER)
            .join("client-state.json"),
        days(20_150),
    );
    let listing = list_other_profiles(roots, &current("dev", CONFIG), &standard());
    let dates = |id: &str| {
        let profile = listed(&listing, id);
        (profile.created_at, profile.last_used_at)
    };
    // Legacy default files count only while the current shared file is missing, as in the transition.
    assert_eq!(
        dates("default"),
        (
            birth(&roots.home_client_state.join("v2")),
            epoch_millis(days(20_100))
        )
    );
    assert_eq!(
        dates(&format!("scope:{}", fixture.scope_name("dev-v2", CONFIG))),
        (
            birth(&fixture.electron_scope("dev-v2", CONFIG)),
            epoch_millis(days(20_000))
        )
    );
    assert_eq!(
        dates(&format!(
            "scope:{}",
            fixture.scope_name("team", OTHER_CONFIG)
        )),
        (birth(&fixture.electron_scope("team", OTHER_CONFIG)), None)
    );
    let orphan = roots
        .tauri_data_parent
        .join(format!("{STABLE_IDENTIFIER}.scope.s{}", "f".repeat(16)));
    assert_eq!(
        dates(&format!("orphan:{}", "f".repeat(16))),
        (birth(&orphan), None)
    );
    // The open profile is measured over the folders deleting it would remove.
    assert_eq!(
        listing.current,
        OpenProfile {
            name: "dev".into(),
            size_bytes: 5 + 5,
            size_complete: true,
            created_at: birth(&fixture.electron_scope("dev", CONFIG)),
            last_used_at: epoch_millis(days(20_300)),
        }
    );

    fs::remove_file(&shared).unwrap();
    let listing = list_other_profiles(roots, &current("dev", CONFIG), &standard());
    assert_eq!(
        listed(&listing, "default").last_used_at,
        epoch_millis(days(20_200))
    );
}

#[test]
fn the_open_default_profile_is_described_by_its_own_folders() {
    let fixture = Fixture::populated();
    let roots = &fixture.roots;
    touch(
        &roots.home_client_state.join("v2").join("client-state.json"),
        days(20_400),
    );
    let listing = list_other_profiles(roots, &current("stable", CONFIG), &standard());
    assert_eq!(
        listing.current,
        OpenProfile {
            name: "default".into(),
            size_bytes: 1000 + 20 + 30 + 40 + 400 + 60,
            size_complete: true,
            created_at: birth(&roots.home_client_state.join("v2")),
            last_used_at: epoch_millis(days(20_400)),
        }
    );
    // The default profile of another configuration is a scope named `default` too.
    fixture.file(
        &fixture
            .electron_scope("stable", OTHER_CONFIG)
            .join("client-state")
            .join("client-state.json"),
        8,
    );
    let other = list_other_profiles(roots, &current("stable", OTHER_CONFIG), &standard());
    assert_eq!(
        (other.current.name.as_str(), other.current.size_bytes),
        ("default", 8)
    );
}

#[test]
fn dates_are_unknown_without_the_folder_or_any_state_file() {
    let fixture = Fixture::new();
    let roots = &fixture.roots;
    // A profile known only through its WebView folder has no client-state folder yet.
    fixture.file(
        &fixture
            .webview_scope("team", CONFIG)
            .join("EBWebView")
            .join("data"),
        1,
    );
    // The default profile's client-state folder is a link: it is never followed.
    fixture.file(&roots.webview_root.join("local").join("data"), 1);
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir_all(&roots.home_client_state).unwrap();
    link_directory(outside.path(), &roots.home_client_state.join("v2"));
    let listing = list_other_profiles(roots, &current("dev", CONFIG), &standard());
    assert_eq!(listing.profiles.len(), 2);
    for profile in &listing.profiles {
        assert_eq!(
            (profile.created_at, profile.last_used_at),
            (None, None),
            "{}",
            profile.id
        );
    }
    assert_eq!(
        listing.current,
        OpenProfile {
            name: "dev".into(),
            size_bytes: 0,
            size_complete: true,
            created_at: None,
            last_used_at: None,
        }
    );
}

#[test]
fn the_next_launch_is_the_remembered_profile_this_configurations_launch_opens() {
    let fixture = Fixture::new();
    let next = |pinned: bool| {
        let open = CurrentProfile {
            pinned,
            ..current("dev", CONFIG)
        };
        let listing = list_other_profiles(&fixture.roots, &open, &standard());
        (listing.next_launch, listing.pinned)
    };
    assert_eq!(next(false), (None, false));
    write_choices(&fixture, json!({ choice_key(OTHER_CONFIG): "team" }));
    assert_eq!(next(true), (None, true));
    write_choices(
        &fixture,
        json!({ choice_key(CONFIG): "Team", choice_key(OTHER_CONFIG): "dev" }),
    );
    // Checked as the launch checks it: a profile whose folder is gone is not opened.
    assert_eq!(next(false).0, None);
    fs::create_dir_all(fixture.electron_scope("team", CONFIG)).unwrap();
    assert_eq!(next(false), (Some("team".to_string()), false));
    // Nor is one linked to a missing drive, although its choice is kept.
    write_choices(&fixture, json!({ choice_key(CONFIG): "gone" }));
    link_directory(
        &fixture.roots.electron_base.join("missing-drive"),
        &fixture.electron_scope("gone", CONFIG),
    );
    assert_eq!(next(false).0, None);
    write_choices(&fixture, json!({ choice_key(CONFIG): "stable" }));
    assert_eq!(next(false).0.as_deref(), Some("default"));
    for raw in ["{ not json", r#"{"version":2,"choices":{}}"#] {
        fs::write(choices_file(&fixture), raw).unwrap();
        assert_eq!(next(false).0, None, "{raw}");
    }
}

#[test]
fn choosing_a_new_profile_creates_its_folder_and_replaces_this_configurations_choice() {
    let fixture = Fixture::new();
    write_choices(
        &fixture,
        json!({ choice_key(CONFIG): "dev", choice_key(OTHER_CONFIG): "dev" }),
    );
    assert_eq!(choose(&fixture, " Team "), NextLaunchOutcome::Updated);
    assert_eq!(
        stored_choices(&fixture),
        json!({ choice_key(CONFIG): "team", choice_key(OTHER_CONFIG): "dev" })
    );
    assert!(plain_directory(&fixture.electron_scope("team", CONFIG)));
    // The next launch's remembered-profile check finds the new profile and keeps the choice.
    let launch = TransitionContext {
        config_identity: CONFIG.into(),
        default_identity: CONFIG.into(),
        user_data_base: fixture.roots.electron_base.clone(),
        default_state_files: Vec::new(),
    };
    assert_eq!(
        remembered_profile_state("team", &launch),
        RememberedProfileState::Present
    );
    for name in ["default", "STABLE"] {
        assert_eq!(choose(&fixture, name), NextLaunchOutcome::Updated);
        assert_eq!(stored_choices(&fixture)[choice_key(CONFIG)], "default");
    }
    // Only the named profile got a folder, and the selection lock was released.
    assert_eq!(
        entries(&fixture.roots.electron_base.join("scopes")).unwrap(),
        vec![fixture.scope_name("team", CONFIG)]
    );
    assert!(!fixture
        .roots
        .electron_base
        .join("profile-selection")
        .join("choices.lock")
        .exists());
}

#[test]
fn next_launch_names_follow_the_shared_profile_grammar() {
    let fixture = Fixture::new();
    let vectors = shared_vectors();
    for vector in vectors["profileNames"].as_array().unwrap() {
        let input = vector["input"].as_str().unwrap();
        assert_eq!(
            choose(&fixture, input),
            NextLaunchOutcome::Updated,
            "{input}"
        );
        assert_eq!(
            stored_choices(&fixture)[choice_key(CONFIG)],
            vector["display"],
            "{input}"
        );
    }
    let invalid = Fixture::new();
    let names = vectors["invalidProfileNames"].as_array().unwrap();
    for input in names
        .iter()
        .map(|name| name.as_str().unwrap())
        .chain(["", " \t"])
    {
        assert_eq!(
            choose(&invalid, input),
            NextLaunchOutcome::Invalid,
            "{input:?}"
        );
    }
    assert!(!invalid.roots.electron_base.exists());
}

#[test]
fn an_existing_entry_at_the_profile_folder_is_left_as_it_is() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    let relocated = outside.path().join("team");
    fs::create_dir(&relocated).unwrap();
    let folder = fixture.electron_scope("team", CONFIG);
    fs::create_dir_all(folder.parent().unwrap()).unwrap();
    link_directory(&relocated, &folder);
    // The drive holding the relocated profile is disconnected: the link dangles.
    fs::remove_dir(&relocated).unwrap();
    assert_eq!(choose(&fixture, "team"), NextLaunchOutcome::Updated);
    assert!(fs::symlink_metadata(&folder)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!relocated.exists());
    assert_eq!(stored_choices(&fixture)[choice_key(CONFIG)], "team");
}

#[test]
fn a_profile_folder_that_cannot_be_created_fails_without_remembering() {
    let fixture = Fixture::new();
    // A file where `scopes/` should be.
    fixture.file(&fixture.roots.electron_base.join("scopes"), 1);
    assert_eq!(choose(&fixture, "team"), NextLaunchOutcome::Failed);
    assert!(!choices_file(&fixture).exists());
}

#[test]
fn profile_commands_are_granted_to_local_windows_and_preferences_only() {
    let permissions = |text: &str| -> Vec<Value> {
        serde_json::from_str::<Value>(text).unwrap()["permissions"]
            .as_array()
            .unwrap()
            .clone()
    };
    let granted = [
        include_str!("../capabilities/main-window.json"),
        include_str!("../capabilities/preferences-window.json"),
    ];
    let others = [
        include_str!("../capabilities/remote-window-notifications.json"),
        include_str!("../capabilities/owned-webview-zoom.json"),
    ];
    for command in [
        "list_others",
        "delete_others",
        "set_next_launch",
        "relaunch",
    ] {
        let permission = json!(format!("allow-data-profiles-{}", command.replace('_', "-")));
        assert!(
            granted
                .iter()
                .all(|capability| permissions(capability).contains(&permission)),
            "{command}"
        );
        assert!(
            !others
                .iter()
                .any(|capability| permissions(capability).contains(&permission)),
            "{command}"
        );
        let name = format!("data_profiles_{command}");
        assert!(include_str!("../build.rs").contains(&format!("\"{name}\",")));
        assert!(include_str!("main.rs").contains(&format!("data_profile_cleanup::{name},")));
    }
}
