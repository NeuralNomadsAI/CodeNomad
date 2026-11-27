use super::*;
use std::{
    fs,
    path::PathBuf,
    process::Stdio,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

// The ordinary test is inert. Only the process explicitly spawned below enters
// this fixture; its sole descendant inherits this spawn's OS containment.
#[test]
fn fixture_child() {
    let Some(root) = std::env::var_os("CODENOMAD_OWNED_PROCESS_TEST_ROOT") else {
        return;
    };
    assert!(
        std::env::var("CODENOMAD_PROFILE")
            .unwrap()
            .starts_with("trial-")
    );
    let root = PathBuf::from(root);
    if std::env::var_os("CODENOMAD_OWNED_PROCESS_GRANDCHILD").is_none() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "tests::fixture_child", "--nocapture"])
            .env("CODENOMAD_OWNED_PROCESS_GRANDCHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().unwrap();
        fs::write(root.join("child-ready"), b"owned").unwrap();
        // Reap on POSIX if the test independently asks the descendant to stop.
        let _ = child.wait();
    } else {
        fs::write(root.join("grandchild-ready"), b"owned").unwrap();
        fs::write(
            root.join(format!("grandchild-ready-{}", std::process::id())),
            b"owned",
        )
        .unwrap();
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
}

#[test]
fn termination_confines_and_stops_owned_descendants() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/host-process-tests")
        .join(format!("trial-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "tests::fixture_child", "--nocapture"])
        .env("CODENOMAD_PROFILE", "trial-host-process")
        .env("CODENOMAD_OWNED_PROCESS_TEST_ROOT", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = OwnedProcess::spawn(&mut command).unwrap();
    let bystander_root = root.join("bystander");
    fs::create_dir(&bystander_root).unwrap();
    let mut other_command = Command::new(std::env::current_exe().unwrap());
    other_command
        .args(["--exact", "tests::fixture_child", "--nocapture"])
        .env("CODENOMAD_PROFILE", "trial-host-process-bystander")
        .env("CODENOMAD_OWNED_PROCESS_TEST_ROOT", &bystander_root)
        .env("CODENOMAD_OWNED_PROCESS_GRANDCHILD", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut bystander = OwnedProcess::spawn(&mut other_command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("grandchild-ready").exists() {
        assert!(Instant::now() < deadline, "Owned grandchild became ready");
        assert!(child.try_wait().unwrap().is_none());
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!child.family_is_empty().unwrap());
    child.terminate().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let exited = child.try_wait().unwrap().is_some();
        if exited && child.family_is_empty().unwrap() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Owned family stopped and was reaped"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        bystander.try_wait().unwrap().is_none(),
        "Separate owned family remains alive"
    );
    bystander.terminate().unwrap();
}

#[test]
fn reusing_command_isolates_separate_owned_families() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/host-process-tests")
        .join(format!("trial-reuse-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let mut shared = Command::new(std::env::current_exe().unwrap());
    shared
        .args(["--exact", "tests::fixture_child", "--nocapture"])
        .env("CODENOMAD_PROFILE", "trial-host-process-reuse")
        .env("CODENOMAD_OWNED_PROCESS_TEST_ROOT", &root)
        .env("CODENOMAD_OWNED_PROCESS_GRANDCHILD", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut first = OwnedProcess::spawn(&mut shared).unwrap();
    let mut second = OwnedProcess::spawn(&mut shared).unwrap();
    assert!(
        !shared.get_envs().any(
            |(k, v)| k.to_string_lossy().starts_with("CODENOMAD_FIXTURE_TREE_") && v.is_some()
        ),
        "Reused Command must not retain per-spawn tree markers"
    );
    let first_ready = root.join(format!("grandchild-ready-{}", first.id()));
    let second_ready = root.join(format!("grandchild-ready-{}", second.id()));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !first_ready.exists() || !second_ready.exists() {
        assert!(
            Instant::now() < deadline,
            "Both reused-command children became ready"
        );
        thread::sleep(Duration::from_millis(10));
    }
    first.terminate().unwrap();
    let stop_deadline = Instant::now() + Duration::from_secs(5);
    while first.try_wait().unwrap().is_none() || !first.family_is_empty().unwrap() {
        assert!(
            Instant::now() < stop_deadline,
            "First family stopped cleanly"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        second.try_wait().unwrap().is_none(),
        "Terminating first family from reused Command must not stop second family"
    );
    second.terminate().unwrap();
}
