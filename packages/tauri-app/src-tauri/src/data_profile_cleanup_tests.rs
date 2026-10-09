use super::*;
use crate::profile_transition::choice_key;
use std::cell::Cell;

const CONFIG: &str = "/home/user/.config/codenomad/config.yaml";
const OTHER_CONFIG: &str = "/work/other/config.yaml";
const LIVE: u32 = 4242;

struct Fixture {
    _directory: tempfile::TempDir,
    roots: ProfileRoots,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path();
        let roots = ProfileRoots {
            electron_base: base.join("Roaming").join("CodeNomad"),
            webview_root: base.join("Local").join(format!("{STABLE_IDENTIFIER}-v2")),
            tauri_data_parent: base.join("Roaming"),
            home_client_state: base.join("home").join(".codenomad").join("client-state"),
        };
        Self {
            _directory: directory,
            roots,
        }
    }

    fn file(&self, path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x".repeat(bytes)).unwrap();
    }

    fn scope(&self, key: &str, config: &str) -> crate::data_profile::ProfileScope {
        profile_scope(key, config, CONFIG)
    }

    fn scope_name(&self, key: &str, config: &str) -> String {
        self.scope(key, config).scope_name
    }

    fn tauri_lock(&self, key: &str, config: &str) -> PathBuf {
        self.roots.tauri_data_parent.join(format!(
            "{STABLE_IDENTIFIER}.scope.s{}",
            self.scope(key, config).suffix
        ))
    }

    fn electron_scope(&self, key: &str, config: &str) -> PathBuf {
        self.roots
            .electron_base
            .join("scopes")
            .join(self.scope_name(key, config))
    }

    fn webview_scope(&self, key: &str, config: &str) -> PathBuf {
        self.roots
            .webview_root
            .join("scopes")
            .join(self.scope_name(key, config))
    }

    /// The open `dev` profile, the default profile, `dev-v2` on both hosts, `team` of another
    /// config and an orphan lock folder; mirrors the Electron fixture.
    fn populated() -> Self {
        let fixture = Self::new();
        let roots = fixture.roots.clone();
        let f = |path: PathBuf, bytes| fixture.file(&path, bytes);
        f(
            fixture
                .electron_scope("dev", CONFIG)
                .join("client-state")
                .join("client-state.json"),
            5,
        );
        f(
            fixture
                .webview_scope("dev", CONFIG)
                .join("EBWebView")
                .join("data"),
            5,
        );
        f(
            fixture
                .tauri_lock("dev", CONFIG)
                .join("client-state.primary.lock"),
            0,
        );
        f(
            fixture
                .electron_scope("dev-v2", CONFIG)
                .join("client-state")
                .join("client-state.json"),
            100,
        );
        f(
            fixture
                .webview_scope("dev-v2", CONFIG)
                .join("EBWebView")
                .join("Default")
                .join("data"),
            200,
        );
        f(
            fixture
                .tauri_lock("dev-v2", CONFIG)
                .join("client-state.registration.owner"),
            3,
        );
        f(
            fixture
                .electron_scope("team", OTHER_CONFIG)
                .join("developer-mode-browser-v2")
                .join("Local State"),
            50,
        );
        f(
            roots
                .tauri_data_parent
                .join(format!("{STABLE_IDENTIFIER}.scope.s{}", "f".repeat(16)))
                .join("client-state.primary.lock"),
            1,
        );
        f(
            roots
                .electron_base
                .join("developer-mode-browser-v2")
                .join("Local State"),
            1000,
        );
        f(roots.electron_base.join("client-state.json"), 20);
        f(
            roots.home_client_state.join("v2").join("client-state.json"),
            30,
        );
        f(
            roots
                .home_client_state
                .join("v2")
                .join("partitions")
                .join("a".repeat(64)),
            40,
        );
        let participant = roots
            .home_client_state
            .join("v2")
            .join("election")
            .join("participant.1.a.json");
        f(participant.clone(), 0);
        fs::write(
            &participant,
            r#"{"pid":1,"runToken":"a","processStartIdentity":"old"}"#,
        )
        .unwrap();
        f(
            roots
                .webview_root
                .join("developer-mode")
                .join("local")
                .join("EBWebView")
                .join("Default")
                .join("data"),
            400,
        );
        f(
            roots
                .tauri_data_parent
                .join(STABLE_IDENTIFIER)
                .join("client-state.json"),
            60,
        );
        f(
            roots
                .electron_base
                .join("profile-selection")
                .join("choices.json"),
            0,
        );
        f(roots.electron_base.join("Local Storage").join("leveldb"), 7);
        fixture
    }
}

fn current(key: &str, config: &str) -> CurrentProfile {
    CurrentProfile {
        key: key.to_string(),
        config_identity: config.to_string(),
        default_identity: CONFIG.to_string(),
    }
}

fn live(pid: u32) -> bool {
    pid == LIVE
}

fn dependencies<'a>(
    pid_alive: &'a dyn Fn(u32) -> bool,
    remove: &'a dyn Fn(&Path, bool) -> std::io::Result<()>,
) -> Dependencies<'a> {
    Dependencies {
        pid_alive,
        now: &system_time,
        size_entries: MAX_SIZE_ENTRIES,
        remove,
        hostname: &test_host,
        macos: false,
    }
}

fn test_host() -> Option<String> {
    Some("box".to_string())
}

/// Creates a (possibly dangling) symlink to `target`; `false` when the platform refuses (Windows
/// without symlink privilege), so the caller can skip.
fn symlink_to(target: &str, link: &Path) -> bool {
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_file(target, link);
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    match result {
        Ok(()) => true,
        Err(error)
            if error.kind() == ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314) =>
        {
            false
        }
        Err(error) => panic!("symlink: {error}"),
    }
}

fn standard() -> Dependencies<'static> {
    dependencies(&live, &remove_path)
}

fn ids(listing: &OtherProfilesListing) -> Vec<String> {
    listing
        .profiles
        .iter()
        .map(|profile| profile.id.clone())
        .collect()
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn lists_every_other_profile_but_never_the_open_one() {
    let fixture = Fixture::populated();
    let listing = list_other_profiles(&fixture.roots, &current("dev", CONFIG), &standard());
    assert_eq!(
        ids(&listing),
        vec![
            "default".to_string(),
            format!("scope:{}", fixture.scope_name("dev-v2", CONFIG)),
            format!("scope:{}", fixture.scope_name("team", OTHER_CONFIG)),
            format!("orphan:{}", "f".repeat(16)),
        ]
    );
    let profile = |index: usize| &listing.profiles[index];
    assert_eq!(profile(0).size_bytes, 1000 + 20 + 30 + 40 + 400 + 60);
    assert!(!profile(0).other_configuration);
    assert_eq!(
        (
            profile(1).name.as_str(),
            profile(1).size_bytes,
            profile(1).size_complete,
            profile(1).status,
            profile(1).other_configuration
        ),
        ("dev-v2", 303, true, ProfileStatus::Available, false)
    );
    assert!(profile(2).other_configuration);
    assert_eq!(profile(3).size_bytes, 1);
}

#[test]
fn default_profile_is_listed_only_when_a_named_profile_is_open() {
    let fixture = Fixture::populated();
    let listing = list_other_profiles(&fixture.roots, &current("stable", CONFIG), &standard());
    assert!(!listing
        .profiles
        .iter()
        .any(|profile| profile.kind == ProfileKind::Default));
    assert!(ids(&listing).contains(&format!("scope:{}", fixture.scope_name("dev", CONFIG))));
    let empty = Fixture::new();
    assert!(
        list_other_profiles(&empty.roots, &current("stable", CONFIG), &standard())
            .profiles
            .is_empty()
    );
    let other = list_other_profiles(&fixture.roots, &current("dev", OTHER_CONFIG), &standard());
    assert!(
        other.profiles[0].kind == ProfileKind::Default && other.profiles[0].other_configuration
    );
}

#[test]
fn lock_folders_are_found_among_many_unrelated_application_folders() {
    let fixture = Fixture::populated();
    // NTFS lists names alphabetically: these precede `ai.neuralnomads...` in %APPDATA%.
    for index in 0..600 {
        fs::create_dir(
            fixture
                .roots
                .tauri_data_parent
                .join(format!("aa-app-{index}")),
        )
        .unwrap();
    }
    let listing = list_other_profiles(&fixture.roots, &current("dev", CONFIG), &standard());
    assert!(ids(&listing).contains(&format!("orphan:{}", "f".repeat(16))));
}

#[test]
fn size_measurement_is_bounded() {
    let fixture = Fixture::new();
    for index in 0..20 {
        fixture.file(
            &fixture
                .electron_scope("big", CONFIG)
                .join(format!("f{index}")),
            1,
        );
    }
    let mut bounded = standard();
    bounded.size_entries = 5;
    let listing = list_other_profiles(&fixture.roots, &current("stable", CONFIG), &bounded);
    assert!(!listing.profiles[0].size_complete);
    assert!(listing.profiles[0].size_bytes < 20);
}

#[test]
fn profiles_open_in_either_host_or_in_an_unknown_state_are_never_deleted() {
    type Arrange = fn(&Fixture, &Path);
    let cases: Vec<(&str, Arrange, ProfileStatus)> = vec![
        (
            "electron marker",
            |f, s| {
                f.file(
                    &s.join(format!("client-state.running.{LIVE}.token.json")),
                    1,
                )
            },
            ProfileStatus::InUse,
        ),
        (
            "electron primary lock",
            |_, s| {
                fs::write(
                    s.join("client-state.primary.lock"),
                    format!(r#"{{"pid":{LIVE},"runToken":"t"}}"#),
                )
                .unwrap()
            },
            ProfileStatus::InUse,
        ),
        (
            "chromium singleton",
            // requestSingleInstanceLock runs while userData is the profile folder itself.
            |f, s| f.file(&s.join("lockfile"), 1),
            ProfileStatus::InUse,
        ),
        (
            "cross-host election",
            |f, s| {
                let participant = s
                    .join("client-state")
                    .join("election")
                    .join(format!("participant.{LIVE}.t.json"));
                f.file(&participant, 0);
                fs::write(
                    participant,
                    format!(r#"{{"pid":{LIVE},"runToken":"t","processStartIdentity":"x"}}"#),
                )
                .unwrap();
            },
            ProfileStatus::InUse,
        ),
        (
            "tauri marker",
            |f, _| {
                f.file(
                    &f.tauri_lock("dev-v2", CONFIG)
                        .join(format!("client-state.running.{LIVE}.0.lock")),
                    1,
                )
            },
            ProfileStatus::InUse,
        ),
        (
            "webview2 lock",
            |f, _| {
                f.file(
                    &f.webview_scope("dev-v2", CONFIG)
                        .join("developer-mode")
                        .join("local")
                        .join("EBWebView")
                        .join("lockfile"),
                    1,
                )
            },
            ProfileStatus::InUse,
        ),
        (
            "unparseable lock",
            |_, s| fs::write(s.join("client-state.primary.lock"), "{").unwrap(),
            ProfileStatus::Unknown,
        ),
    ];
    for (label, arrange, expected) in cases {
        let fixture = Fixture::populated();
        let scope = fixture.electron_scope("dev-v2", CONFIG);
        arrange(&fixture, &scope);
        let id = format!("scope:{}", fixture.scope_name("dev-v2", CONFIG));
        let listing = list_other_profiles(&fixture.roots, &current("dev", CONFIG), &standard());
        let status = listing
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .unwrap()
            .status;
        assert_eq!(status, expected, "{label}");
        let result =
            delete_other_profiles(&fixture.roots, &current("dev", CONFIG), &[id], &standard());
        let outcome = if expected == ProfileStatus::InUse {
            DeletionOutcome::InUse
        } else {
            DeletionOutcome::Unknown
        };
        assert_eq!(result.results[0].outcome, outcome, "{label}");
        assert!(
            scope.exists() && fixture.tauri_lock("dev-v2", CONFIG).exists(),
            "{label}"
        );
    }
}

#[test]
fn chromium_singleton_is_read_in_the_profile_folder_and_matched_by_host_and_pid() {
    let fixture = Fixture::populated();
    let scope = fixture.electron_scope("dev-v2", CONFIG);
    let id = format!("scope:{}", fixture.scope_name("dev-v2", CONFIG));
    let status = || {
        list_other_profiles(&fixture.roots, &current("dev", CONFIG), &standard())
            .profiles
            .into_iter()
            .find(|profile| profile.id == id)
            .unwrap()
            .status
    };
    // Nothing creates a process singleton in Chromium's storage folder; it is not evidence.
    fixture.file(&scope.join("developer-mode-browser-v2").join("lockfile"), 1);
    assert_eq!(status(), ProfileStatus::Available);
    let lock = scope.join("SingletonLock");
    if !symlink_to(&format!("box-{LIVE}"), &lock) {
        eprintln!("symlinks unavailable; skipping POSIX SingletonLock cases");
        return;
    }
    assert!(symlink_to(
        "/tmp/scoped_dir/SingletonSocket",
        &scope.join("SingletonSocket")
    ));
    assert_eq!(status(), ProfileStatus::InUse, "a live PID of this host");
    for (target, expected) in [
        ("box-9999", ProfileStatus::Available),
        ("other-4242", ProfileStatus::Unknown),
        ("box", ProfileStatus::Unknown),
        ("box-12x", ProfileStatus::Unknown),
    ] {
        fs::remove_file(&lock).unwrap();
        assert!(symlink_to(target, &lock));
        assert_eq!(status(), expected, "{target}");
    }
    // A dangling stale lock of this host does not block deletion; the folder and its links go.
    fs::remove_file(&lock).unwrap();
    assert!(symlink_to("box-9999", &lock));
    let result = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &[id.clone()],
        &standard(),
    );
    assert_eq!(result.results[0].outcome, DeletionOutcome::Deleted);
    assert!(!scope.exists());
}

#[test]
fn a_link_nested_inside_a_deleted_profile_is_removed_without_touching_its_target() {
    let fixture = Fixture::populated();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("precious"), "keep").unwrap();
    link_directory(
        outside.path(),
        &fixture
            .electron_scope("dev-v2", CONFIG)
            .join("client-state")
            .join("linked"),
    );
    link_directory(
        outside.path(),
        &fixture
            .webview_scope("dev-v2", CONFIG)
            .join("EBWebView")
            .join("linked"),
    );
    let id = format!("scope:{}", fixture.scope_name("dev-v2", CONFIG));
    let result = delete_other_profiles(&fixture.roots, &current("dev", CONFIG), &[id], &standard());
    assert_eq!(result.results[0].outcome, DeletionOutcome::Deleted);
    assert!(!fixture.electron_scope("dev-v2", CONFIG).exists());
    assert_eq!(
        fs::read_to_string(outside.path().join("precious")).unwrap(),
        "keep"
    );
}

#[test]
fn macos_listings_disclose_that_webkit_storage_is_shared_and_kept() {
    let fixture = Fixture::populated();
    let mut macos = standard();
    macos.macos = true;
    assert!(
        list_other_profiles(&fixture.roots, &current("dev", CONFIG), &macos).shared_web_kit_storage
    );
    assert!(
        !list_other_profiles(&fixture.roots, &current("dev", CONFIG), &standard())
            .shared_web_kit_storage
    );
    assert_eq!(SYSTEM.macos, cfg!(target_os = "macos"));
}

#[test]
fn the_open_configuration_forgets_its_choice_of_a_profile_deleted_for_it() {
    let fixture = Fixture::populated();
    let selection = fixture.roots.electron_base.join("profile-selection");
    fixture.file(&fixture.electron_scope("team", CONFIG).join("x"), 1);
    let choices =
        serde_json::json!({ choice_key(CONFIG): "team", choice_key(OTHER_CONFIG): "team" });
    fs::write(
        selection.join("choices.json"),
        serde_json::json!({ "version": 1, "choices": choices }).to_string(),
    )
    .unwrap();
    let id = format!("scope:{}", fixture.scope_name("team", CONFIG));
    let result = delete_other_profiles(&fixture.roots, &current("dev", CONFIG), &[id], &standard());
    assert_eq!(result.choices, ForgetOutcome::Updated);
    let stored: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(selection.join("choices.json")).unwrap()).unwrap();
    assert_eq!(
        stored["choices"],
        serde_json::json!({ choice_key(OTHER_CONFIG): "team" })
    );
    // Deleting another configuration's profile never touches the open configuration's choice.
    fs::write(
        selection.join("choices.json"),
        serde_json::json!({ "version": 1, "choices": { choice_key(CONFIG): "team" } }).to_string(),
    )
    .unwrap();
    fixture.file(&fixture.electron_scope("team", CONFIG).join("x"), 1);
    fixture.file(
        &fixture
            .electron_scope("team", "/third/config.yaml")
            .join("x"),
        1,
    );
    let other = format!("scope:{}", fixture.scope_name("team", OTHER_CONFIG));
    let result = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &[other],
        &standard(),
    );
    assert_eq!(result.choices, ForgetOutcome::Unchanged);
}

#[test]
fn a_profile_opened_mid_deletion_stops_it() {
    let fixture = Fixture::populated();
    fixture.file(
        &fixture
            .tauri_lock("dev-v2", CONFIG)
            .join("client-state.running.9999.0.lock"),
        1,
    );
    let removals = Cell::new(0);
    let pid_alive = |pid: u32| pid == 9999 && removals.get() > 0;
    let remove = |path: &Path, directory: bool| {
        removals.set(removals.get() + 1);
        remove_path(path, directory)
    };
    let id = format!("scope:{}", fixture.scope_name("dev-v2", CONFIG));
    let result = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &[id],
        &dependencies(&pid_alive, &remove),
    );
    assert_eq!(removals.get(), 1);
    assert_eq!(result.results[0].outcome, DeletionOutcome::Incomplete);
    assert_eq!(
        result.results[0].remaining,
        vec![
            path_string(fixture.webview_scope("dev-v2", CONFIG)),
            path_string(fixture.tauri_lock("dev-v2", CONFIG))
        ]
    );
}

#[test]
fn deleting_a_named_profile_removes_its_folders_on_both_hosts_only() {
    let fixture = Fixture::populated();
    let ids = vec![
        format!("scope:{}", fixture.scope_name("dev-v2", CONFIG)),
        format!("orphan:{}", "f".repeat(16)),
    ];
    let result = delete_other_profiles(&fixture.roots, &current("dev", CONFIG), &ids, &standard());
    assert!(result
        .results
        .iter()
        .all(|entry| entry.outcome == DeletionOutcome::Deleted));
    assert!(!fixture.electron_scope("dev-v2", CONFIG).exists());
    assert!(!fixture.webview_scope("dev-v2", CONFIG).exists());
    assert!(!fixture.tauri_lock("dev-v2", CONFIG).exists());
    assert!(fixture.electron_scope("dev", CONFIG).exists());
    assert!(fixture.tauri_lock("dev", CONFIG).exists());
    assert!(fixture
        .roots
        .electron_base
        .join("developer-mode-browser-v2")
        .exists());
}

#[test]
fn deleting_the_default_profile_removes_only_its_own_children() {
    let fixture = Fixture::populated();
    let roots = &fixture.roots;
    let result = delete_other_profiles(
        roots,
        &current("dev", CONFIG),
        &["default".to_string()],
        &standard(),
    );
    assert_eq!(result.results[0].outcome, DeletionOutcome::Deleted);
    for removed in [
        roots.electron_base.join("developer-mode-browser-v2"),
        roots.electron_base.join("client-state.json"),
        roots.home_client_state.join("v2").join("client-state.json"),
        roots.home_client_state.join("v2").join("partitions"),
        roots.webview_root.join("developer-mode"),
        roots
            .tauri_data_parent
            .join(STABLE_IDENTIFIER)
            .join("client-state.json"),
    ] {
        assert!(!removed.exists(), "{}", removed.display());
    }
    for kept in [
        fixture.electron_scope("dev", CONFIG),
        fixture.electron_scope("dev-v2", CONFIG),
        roots
            .electron_base
            .join("profile-selection")
            .join("choices.json"),
        fixture.webview_scope("dev-v2", CONFIG),
        roots.home_client_state.join("v2").join("election"),
        roots.electron_base.join("Local Storage"),
    ] {
        assert!(kept.exists(), "{}", kept.display());
    }
    assert_eq!(
        result.results[0].kept,
        vec![path_string(roots.electron_base.join("Local Storage"))]
    );
}

fn link_directory(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[test]
fn links_and_junctions_are_never_listed_or_followed() {
    let fixture = Fixture::populated();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("precious"), "keep").unwrap();
    let linked = format!("linked-{}", "a".repeat(16));
    link_directory(
        outside.path(),
        &fixture.roots.electron_base.join("scopes").join(&linked),
    );
    fs::remove_dir_all(fixture.roots.webview_root.join("developer-mode")).unwrap();
    link_directory(outside.path(), &fixture.roots.webview_root.join("local"));
    let listing = list_other_profiles(&fixture.roots, &current("dev", CONFIG), &standard());
    assert!(!ids(&listing).contains(&format!("scope:{linked}")));
    let missing = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &[format!("scope:{linked}")],
        &standard(),
    );
    assert_eq!(missing.results[0].outcome, DeletionOutcome::Missing);
    let result = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &["default".to_string()],
        &standard(),
    );
    assert_eq!(result.results[0].outcome, DeletionOutcome::Incomplete);
    assert_eq!(
        result.results[0].remaining,
        vec![path_string(fixture.roots.webview_root.join("local"))]
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("precious")).unwrap(),
        "keep"
    );
}

#[test]
fn a_failed_removal_reports_exactly_what_remained() {
    let fixture = Fixture::populated();
    let stuck = fixture.webview_scope("dev-v2", CONFIG);
    let remove = |path: &Path, directory: bool| {
        if path == stuck {
            return Err(std::io::Error::new(ErrorKind::Other, "busy"));
        }
        remove_path(path, directory)
    };
    let id = format!("scope:{}", fixture.scope_name("dev-v2", CONFIG));
    let result = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &[id],
        &dependencies(&live, &remove),
    );
    assert_eq!(result.results[0].outcome, DeletionOutcome::Incomplete);
    assert_eq!(
        result.results[0].remaining,
        vec![path_string(stuck.clone())]
    );
}

#[test]
fn remembered_choices_are_forgotten_only_when_no_folder_of_the_profile_remains() {
    let fixture = Fixture::populated();
    let selection = fixture.roots.electron_base.join("profile-selection");
    let key = |config: &str| choice_key(config);
    let write = |choices: serde_json::Value| {
        fs::write(
            selection.join("choices.json"),
            serde_json::json!({ "version": 1, "choices": choices }).to_string(),
        )
        .unwrap()
    };
    write(
        serde_json::json!({ key("/a"): "dev-v2", key("/b"): "default", key("/c"): "team", key("/d"): "dev" }),
    );
    fixture.file(&fixture.webview_scope("team", CONFIG).join("data"), 1);
    let ids = vec![
        format!("scope:{}", fixture.scope_name("dev-v2", CONFIG)),
        format!("scope:{}", fixture.scope_name("team", OTHER_CONFIG)),
    ];
    let result = delete_other_profiles(&fixture.roots, &current("dev", CONFIG), &ids, &standard());
    assert_eq!(result.choices, ForgetOutcome::Updated);
    let stored: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(selection.join("choices.json")).unwrap()).unwrap();
    assert_eq!(
        stored["choices"],
        serde_json::json!({ key("/b"): "default", key("/c"): "team", key("/d"): "dev" })
    );

    // A launch currently choosing a profile holds the lock: the file is left alone.
    write(serde_json::json!({ key("/a"): "team" }));
    fs::write(
        selection.join("choices.lock"),
        r#"{"pid":1,"token":"other"}"#,
    )
    .unwrap();
    fs::remove_dir_all(fixture.webview_scope("team", CONFIG)).unwrap();
    let unchanged = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &["default".to_string()],
        &standard(),
    );
    assert_eq!(unchanged.choices, ForgetOutcome::Unchanged);
    fixture.file(&fixture.electron_scope("team", CONFIG).join("x"), 1);
    let blocked = delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &[format!("scope:{}", fixture.scope_name("team", CONFIG))],
        &standard(),
    );
    assert_eq!(blocked.choices, ForgetOutcome::Busy);
    assert!(fs::read_to_string(selection.join("choices.json"))
        .unwrap()
        .contains("team"));
}

#[test]
fn only_listing_identifiers_are_accepted_from_the_renderer() {
    let scope = format!("scope:dev-{}", "a".repeat(16));
    let orphan = format!("orphan:{}", "b".repeat(16));
    assert_eq!(
        require_profile_ids(vec![
            "default".into(),
            "default".into(),
            scope.clone(),
            orphan.clone()
        ])
        .unwrap(),
        vec!["default".to_string(), scope, orphan]
    );
    for invalid in [
        vec![],
        vec!["../x".to_string()],
        vec![format!("scope:../dev-{}", "a".repeat(16))],
        vec![format!("scope:C:\\x-{}", "a".repeat(16))],
    ] {
        assert!(require_profile_ids(invalid).is_err());
    }
}

#[test]
fn serialized_listing_matches_the_shared_renderer_contract() {
    let fixture = Fixture::populated();
    let listing = list_other_profiles(&fixture.roots, &current("dev", CONFIG), &standard());
    let value = serde_json::to_value(&listing).unwrap();
    assert_eq!(value["sharedWebKitStorage"], false);
    let first = &value["profiles"][0];
    assert_eq!(first["id"], "default");
    assert_eq!(first["kind"], "default");
    assert_eq!(first["status"], "available");
    assert!(
        first["sizeBytes"].is_u64()
            && first["sizeComplete"].is_boolean()
            && first["otherConfiguration"].is_boolean()
    );
    let deletion = serde_json::to_value(delete_other_profiles(
        &fixture.roots,
        &current("dev", CONFIG),
        &["nope".to_string()],
        &standard(),
    ))
    .unwrap();
    assert_eq!(
        deletion,
        serde_json::json!({ "results": [{ "id": "nope", "name": "nope", "outcome": "missing", "remaining": [], "kept": [] }], "choices": "unchanged" })
    );
}
