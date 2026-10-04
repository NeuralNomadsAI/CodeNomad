//! Real retained-handle, private-channel regressions in the inherited outer Job.
//! These never construct independent authority or qualify backend HTTP Stop.
use super::*;
use crate::launch::spawn_suspended;
use crate::{Child, Command, NodeProgram, Process, RuntimeMember, SupervisorConfig};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    authority: Arc<Authority>,
    external: Child,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.authority.close();
        let _ = self.authority.manager().wait_exit(1000);
        let _ = self.external.process().terminate_owned();
        // Keep bounded private source/timing receipts for independent inspection.
    }
}
fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn private_drain(case: &str, close_ms: u64, exit_ms: u64) -> (Result<()>, u64) {
    let root = PathBuf::from("C:/Users/Admin/AppData/Local/Temp/opencode").join(format!(
        "native-stop-deadline-{}-{}-{}",
        std::process::id(),
        wall_ms(),
        case
    ));
    std::fs::create_dir(&root).unwrap();
    let script = root.join("manager.cjs");
    std::fs::write(
        &script,
        include_str!("../tests/fixtures/deadline-manager.cjs"),
    )
    .unwrap();
    let node = std::env::var("CODENOMAD_NATIVE_FIXTURE_NODE")
        .unwrap_or_else(|_| "C:/Program Files/nodejs/node.exe".into());
    let runtime = SupervisedRuntime::nested_fixture(SupervisorConfig {
        v: 1,
        profile: "a".repeat(64),
        generation: "12345678-1234-1234-1234-123456789abc".into(),
        manager: NodeProgram {
            node: node.clone(),
            entry: script.to_string_lossy().into(),
            cwd: root.to_string_lossy().into(),
            loader: None,
        },
        application: json!({"scope":{"key":"a".repeat(64)},"closeMs":close_ms,"exitMs":exit_ms}),
        broker: None,
    })
    .unwrap();
    let authority = runtime.authority.clone();
    let external = spawn_suspended(
        &Command {
            executable: node.into(),
            args: vec![
                "-e".into(),
                "setTimeout(()=>process.exit(0),20000);setInterval(()=>{},1000)".into(),
            ],
            directory: root.clone(),
            environment: std::env::vars().collect(),
        },
        0,
    )
    .unwrap()
    .resume()
    .unwrap();
    let fixture = Fixture {
        root,
        authority,
        external,
    };
    fixture
        .authority
        .require_external(fixture.external.process())
        .unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    let pids: serde_json::Value = loop {
        if let Ok(bytes) = std::fs::read(fixture.root.join("members.json")) {
            if let Ok(value) = serde_json::from_slice(&bytes) {
                break value;
            }
        }
        assert!(Instant::now() < end, "private manager children not ready");
        std::thread::sleep(Duration::from_millis(10));
    };
    let members: Vec<RuntimeMember> = ["backend", "descendant"]
        .iter()
        .map(|name| {
            fixture
                .authority
                .observe(pids[name].as_u64().unwrap() as u32)
                .unwrap()
        })
        .collect();
    // Retain exact M handle throughout the actual serve wait and after Job closure.
    let manager = Process {
        handle: fixture.authority.manager().handle.duplicate().unwrap(),
        birth: fixture.authority.manager().identity(),
    };
    let result = serve(runtime);
    let returned_at = wall_ms();
    let ack: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture.root.join("ack.json")).unwrap()).unwrap();
    let elapsed = returned_at - ack["acknowledgedAt"].as_u64().unwrap();
    let cleaned =
        manager.wait_exit(1000).unwrap() && members.iter().all(|m| m.wait_exit(1000).unwrap());
    let sentinel_live = !fixture.external.process().exited().unwrap();
    let cleanup_elapsed = wall_ms() - ack["acknowledgedAt"].as_u64().unwrap();
    fixture.external.process().terminate_owned().unwrap();
    let receipt = json!({"case":case,"result":result.as_ref().err().map(|e|e.0),"elapsedAfterAckMs":elapsed,
        "closeMs":close_ms,"exitMs":exit_ms,"closed":fixture.root.join("closed.json").exists(),
        "manager":{"pid":manager.identity().pid,"filetime":manager.identity().creation_filetime.to_string()},
        "members":members.iter().map(|m|json!({"pid":m.identity().pid,"filetime":m.identity().creation_filetime.to_string()})).collect::<Vec<_>>(),
        "sentinel":{"pid":fixture.external.process().identity().pid,"filetime":fixture.external.process().identity().creation_filetime.to_string()},
        "managerAndChildrenExitConfirmed":cleaned,"cleanupAfterAckMs":cleanup_elapsed,
        "externalSentinelSurvived":sentinel_live,"exactSentinelCleanupConfirmed":fixture.external.process().exited().unwrap(),
        "independentLaunchQualified":false,"productManagerQualified":false,"backendHttpStopQualified":false});
    std::fs::write(
        fixture.root.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    println!(
        "private drain receipt: {}",
        fixture.root.join("receipt.json").display()
    );
    assert!(cleaned, "exact runtime handles did not confirm cleanup");
    assert!(sentinel_live, "runtime cleanup touched external sentinel");
    (result, elapsed)
}

#[test]
fn late_channel_close_cannot_renew_absolute_drain_deadline() {
    // Two seconds of channel-closure headroom avoids an exact 4.9s scheduling race.
    let (result, elapsed) = private_drain("late", 3000, 7000);
    assert_eq!(result, Err(Error("native-runtime-stop-drain-deadline")));
    assert!(
        elapsed < 6000,
        "drain renewed its absolute five-second budget"
    );
}

#[test]
fn channel_close_and_manager_exit_within_remaining_budget_succeed() {
    let (result, elapsed) = private_drain("remaining", 400, 1200);
    assert_eq!(result, Ok(()));
    assert!(elapsed < 5000);
}
