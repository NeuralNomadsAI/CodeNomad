#![cfg(all(windows, feature = "fixtures"))]

use codenomad_native_host_lifetime::{fixture, Command};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn root() -> Root {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from("C:/Users/Admin/AppData/Local/Temp/opencode")
        .join(format!("native-host-pipe-{}-{stamp}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    Root(root)
}
fn command(root: &Root) -> Command {
    Command {
        executable: env!("CARGO_BIN_EXE_host-lifetime-fixture").into(),
        args: vec!["pipe-proof".into()],
        directory: root.0.clone(),
        environment: std::env::vars().collect(),
    }
}

#[test]
fn native_pipe_creator_pid_filetime_and_child_handle_are_bound_to_private_challenge() {
    let root = root();
    let mut child = fixture::launch_containment_fixture(&command(&root)).unwrap();
    let frame = fixture::challenge_for_created_child(&child).unwrap();
    assert_eq!(frame.len(), 64);
    assert_eq!(&frame[..8], b"CNHLv001");
    assert_eq!(
        u32::from_le_bytes(frame[40..44].try_into().unwrap()),
        child.process().identity().pid
    );
    assert_eq!(
        u64::from_le_bytes(frame[44..52].try_into().unwrap()),
        child.process().identity().creation_filetime
    );
    assert_eq!(
        u32::from_le_bytes(frame[52..56].try_into().unwrap()),
        std::process::id()
    );
    child.write_bootstrap(&frame).unwrap();
    assert_eq!(
        child.read_private(64, Duration::from_secs(5)).unwrap(),
        frame
    );
    child.write_bootstrap(b"X").unwrap();
    assert!(child.process().wait_exit(5000).unwrap());
    // This validates the real pipe/native identity layer only; the execution host
    // Job remains intact and no independent-owner proof is manufactured.
}

#[test]
fn malicious_frame_cannot_claim_another_parent_or_creation_identity() {
    let root = root();
    for offset in [0, 40, 44, 52, 56] {
        let mut child = fixture::launch_containment_fixture(&command(&root)).unwrap();
        let mut frame = fixture::challenge_for_created_child(&child).unwrap();
        frame[offset] ^= 0x80;
        child.write_bootstrap(&frame).unwrap();
        assert!(child.read_private(64, Duration::from_secs(1)).is_err());
        assert!(child.process().wait_exit(5000).unwrap());
    }
}
