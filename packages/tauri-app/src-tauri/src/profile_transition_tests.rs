use super::*;
use crate::data_profile::shared_vectors;
use std::cell::Cell;

struct Sandbox {
    _root: tempfile::TempDir,
    context: TransitionContext,
    directory: PathBuf,
}

fn fixture(name: &str) -> String {
    shared_vectors()["stateFixtures"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap()["content"]
        .to_string()
}

fn with_tabs() -> String {
    fixture("partitioned window with a workspace tab")
}

fn empty() -> String {
    fixture("partitioned window with only the session partition")
}

fn sandbox() -> Sandbox {
    let root = tempfile::tempdir().unwrap();
    let context = TransitionContext {
        config_identity: "/home/dev/.config/codenomad/config.yaml".into(),
        default_identity: "/home/dev/.config/codenomad/config.yaml".into(),
        user_data_base: root.path().join("CodeNomad"),
        default_state_files: vec![
            root.path()
                .join("home/.codenomad/client-state/v2/client-state.json"),
            root.path().join("legacy/client-state.json"),
        ],
    };
    let directory = selection_directory(&context.user_data_base);
    Sandbox {
        _root: root,
        context,
        directory,
    }
}

fn write(path: &Path, content: &str, modified: SystemTime) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
}

fn days(count: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(count * 86_400)
}

impl Sandbox {
    fn scoped_file(&self, key: &str) -> PathBuf {
        let scope = profile_scope(
            key,
            &self.context.config_identity,
            &self.context.default_identity,
        );
        self.context
            .user_data_base
            .join("scopes")
            .join(scope.scope_name)
            .join("client-state/client-state.json")
    }

    fn resolve(&self) -> TransitionResult {
        resolve_transition_profile(&self.context, SystemTime::now, |_| {
            panic!("unexpected wait")
        })
        .unwrap()
    }

    fn resolved(&self) -> (String, Reason) {
        match self.resolve() {
            TransitionResult::Resolved { key, reason } => (key, reason),
            TransitionResult::Ask { .. } => panic!("unexpected question"),
        }
    }

    fn choices_text(&self) -> String {
        fs::read_to_string(self.directory.join(CHOICES_FILENAME)).unwrap()
    }
}

#[test]
fn no_profile_with_state_keeps_the_default_profile_and_remembers_it() {
    let sandbox = sandbox();
    write(&sandbox.scoped_file("dev"), &empty(), SystemTime::now());
    assert_eq!(sandbox.resolved(), ("stable".into(), Reason::None));
    let choices = read_choices(&sandbox.directory);
    let mut expected = Map::new();
    expected.insert(
        choice_key(&sandbox.context.config_identity),
        Value::String("default".into()),
    );
    assert_eq!(choices, ChoicesFile::Valid(expected));
    assert!(!sandbox.choices_text().contains("config.yaml"));
    assert!(!sandbox.choices_text().contains("scopes"));
}

#[test]
fn exactly_one_profile_with_state_is_selected_without_asking() {
    let sandbox = sandbox();
    write(&sandbox.scoped_file("dev"), &with_tabs(), SystemTime::now());
    write(
        &sandbox.context.default_state_files[0],
        &empty(),
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("dev".into(), Reason::Single));
    write(
        &sandbox.context.default_state_files[0],
        &with_tabs(),
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("dev".into(), Reason::Remembered));
}

#[test]
fn legacy_default_files_count_only_while_the_current_shared_file_is_absent() {
    let sandbox = sandbox();
    write(
        &sandbox.context.default_state_files[1],
        &fixture("legacy monolithic snapshot with tabs"),
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("stable".into(), Reason::Single));
}

#[test]
fn several_profiles_with_state_ask_once_and_concurrent_launches_wait_for_the_answer() {
    let sandbox = sandbox();
    write(
        &sandbox.context.default_state_files[0],
        &with_tabs(),
        days(20_697),
    );
    write(&sandbox.scoped_file("dev-v2"), &with_tabs(), days(20_727));
    let TransitionResult::Ask { candidates, lock } = sandbox.resolve() else {
        panic!("expected a question");
    };
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect::<Vec<_>>(),
        vec!["dev-v2", "default"]
    );
    let waits = Cell::new(0);
    let mut held = Some(lock);
    let waiting = resolve_transition_profile(&sandbox.context, SystemTime::now, |_| {
        waits.set(waits.get() + 1);
        if let Some(lock) = held.take() {
            assert!(lock.commit(&sandbox.context, "dev-v2"));
            lock.release();
        }
    })
    .unwrap();
    assert!(
        matches!(waiting, TransitionResult::Resolved { ref key, reason: Reason::Remembered } if key == "dev-v2")
    );
    assert_eq!(waits.get(), 1);
    assert_eq!(sandbox.resolved(), ("dev-v2".into(), Reason::Remembered));
}

#[test]
fn a_valid_remembered_choice_is_never_overridden_and_corrupt_choices_rerun_detection() {
    let sandbox = sandbox();
    let id = choice_key(&sandbox.context.config_identity);
    write(
        &sandbox.directory.join(CHOICES_FILENAME),
        &json!({ "version": 1, "choices": { id.clone(): "dev" } }).to_string(),
        SystemTime::now(),
    );
    write(
        &sandbox.context.default_state_files[0],
        &with_tabs(),
        SystemTime::now(),
    );
    fs::create_dir_all(
        sandbox
            .scoped_file("dev")
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(sandbox.resolved(), ("dev".into(), Reason::Remembered));
    write(
        &sandbox.directory.join(CHOICES_FILENAME),
        "{ not json",
        SystemTime::now(),
    );
    write(&sandbox.scoped_file("dev"), &empty(), SystemTime::now());
    assert_eq!(sandbox.resolved(), ("stable".into(), Reason::Single));
    write(
        &sandbox.directory.join(CHOICES_FILENAME),
        &json!({ "version": 1, "choices": { id: "../escape" } }).to_string(),
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("stable".into(), Reason::Single));
}

#[test]
fn a_remembered_named_profile_missing_for_this_config_reruns_detection_and_is_replaced() {
    let sandbox = sandbox();
    let id = choice_key(&sandbox.context.config_identity);
    let other = choice_key("/other/config.yaml");
    write(
        &sandbox.directory.join(CHOICES_FILENAME),
        &json!({ "version": 1, "choices": { id.clone(): "dev", other.clone(): "dev" } })
            .to_string(),
        SystemTime::now(),
    );
    // `dev` exists only for another configuration: this one's folder was deleted.
    let other_scope = profile_scope(
        "dev",
        "/other/config.yaml",
        &sandbox.context.default_identity,
    );
    fs::create_dir_all(
        sandbox
            .context
            .user_data_base
            .join("scopes")
            .join(other_scope.scope_name),
    )
    .unwrap();
    write(
        &sandbox.context.default_state_files[0],
        &with_tabs(),
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("stable".into(), Reason::Single));
    let mut expected = Map::new();
    expected.insert(id.clone(), Value::String("default".into()));
    expected.insert(other, Value::String("dev".into()));
    assert_eq!(
        read_choices(&sandbox.directory),
        ChoicesFile::Valid(expected)
    );
    // A remembered profile whose folder exists is kept; `default` never needs a folder.
    write(&sandbox.scoped_file("dev"), &empty(), SystemTime::now());
    write(
        &sandbox.directory.join(CHOICES_FILENAME),
        &json!({ "version": 1, "choices": { id: "dev" } }).to_string(),
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("dev".into(), Reason::Remembered));
}

#[test]
fn an_unknown_future_choices_file_is_never_overwritten() {
    let sandbox = sandbox();
    let future = json!({ "version": 2, "profiles": {} }).to_string();
    write(
        &sandbox.directory.join(CHOICES_FILENAME),
        &future,
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("stable".into(), Reason::Unremembered));
    assert_eq!(sandbox.choices_text(), future);
}

#[test]
fn choices_are_keyed_by_config_identity() {
    let sandbox = sandbox();
    write(
        &sandbox.directory.join(CHOICES_FILENAME),
        &json!({ "version": 1, "choices": { choice_key("/other/config.yaml"): "dev" } })
            .to_string(),
        SystemTime::now(),
    );
    assert_eq!(sandbox.resolved(), ("stable".into(), Reason::None));
    let ChoicesFile::Valid(choices) = read_choices(&sandbox.directory) else {
        panic!("expected valid choices");
    };
    assert_eq!(choices.len(), 2);
}

#[test]
fn a_stale_lock_from_a_crashed_launch_is_taken_over() {
    let sandbox = sandbox();
    write(
        &sandbox.directory.join(LOCK_FILENAME),
        r#"{"pid":1,"token":"crashed"}"#,
        SystemTime::now() - LOCK_STALE - Duration::from_secs(5),
    );
    let waits = Cell::new(0);
    let result = resolve_transition_profile(&sandbox.context, SystemTime::now, |_| {
        waits.set(waits.get() + 1)
    })
    .unwrap();
    assert!(
        matches!(result, TransitionResult::Resolved { ref key, reason: Reason::None } if key == "stable")
    );
    assert_eq!(waits.get(), 1);
}

#[test]
fn an_unwritable_choices_file_never_prevents_startup() {
    let sandbox = sandbox();
    write(&sandbox.scoped_file("dev"), &with_tabs(), SystemTime::now());
    // A directory in place of choices.json makes the atomic rename fail like EPERM/EBUSY would.
    fs::create_dir_all(sandbox.directory.join(CHOICES_FILENAME)).unwrap();
    assert_eq!(sandbox.resolved(), ("dev".into(), Reason::Unremembered));
    let leftovers = fs::read_dir(&sandbox.directory)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp") || name == LOCK_FILENAME)
        .collect::<Vec<_>>();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn an_unusable_selection_directory_or_lock_still_starts_with_the_detected_profile() {
    let sandbox = sandbox();
    write(
        &sandbox.scoped_file("dev-v2"),
        &with_tabs(),
        SystemTime::now(),
    );
    // A file where the selection directory should be: mkdir and the lock fail without contention.
    write(&sandbox.directory, "not a directory", SystemTime::now());
    assert_eq!(sandbox.resolved(), ("dev-v2".into(), Reason::Unremembered));
    write(
        &sandbox.context.default_state_files[0],
        &with_tabs(),
        SystemTime::now(),
    );
    let TransitionResult::Ask { lock, .. } = sandbox.resolve() else {
        panic!("expected a question");
    };
    let heartbeat = lock.start_heartbeat();
    drop(heartbeat);
    assert!(!lock.commit(&sandbox.context, "dev-v2"));
    lock.release();
    assert_eq!(
        fs::read_to_string(&sandbox.directory).unwrap(),
        "not a directory"
    );
}

#[test]
fn choice_keys_fold_unicode_case_on_windows_so_both_hosts_share_a_choice() {
    for vector in shared_vectors()["choiceKeys"].as_array().unwrap() {
        let windows = vector["windows"].as_bool().unwrap();
        let keys = vector["identities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|identity| choice_key_for(identity.as_str().unwrap(), windows))
            .collect::<Vec<_>>();
        match vector["key"].as_str() {
            Some(expected) => assert!(keys.iter().all(|key| key == expected), "{keys:?}"),
            None => assert_ne!(keys[0], keys[1]),
        }
    }
}

#[test]
fn dropping_the_heartbeat_joins_its_thread_promptly() {
    let sandbox = sandbox();
    fs::create_dir_all(&sandbox.directory).unwrap();
    let lock = SelectionLock::try_acquire(&sandbox.directory, SystemTime::now())
        .unwrap()
        .unwrap();
    let started = std::time::Instant::now();
    drop(lock.start_heartbeat());
    assert!(started.elapsed() < LOCK_HEARTBEAT);
    lock.release();
}

#[test]
fn a_live_lock_is_not_stolen() {
    let sandbox = sandbox();
    fs::create_dir_all(&sandbox.directory).unwrap();
    let lock = SelectionLock::try_acquire(&sandbox.directory, SystemTime::now())
        .unwrap()
        .unwrap();
    assert!(
        SelectionLock::try_acquire(&sandbox.directory, SystemTime::now())
            .unwrap()
            .is_none()
    );
    assert!(sandbox.directory.join(LOCK_FILENAME).exists());
    lock.release();
    assert!(!sandbox.directory.join(LOCK_FILENAME).exists());
}
