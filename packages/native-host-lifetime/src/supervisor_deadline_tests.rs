//! Real retained-handle, private-channel regressions in the inherited outer Job.
//! These never construct independent authority or qualify backend HTTP Stop.
use super::*;
use crate::launch::spawn_suspended;
use crate::{
    BrokerConfig, Child, Command, NodeProgram, Process, RuntimeMember, ServicePolicy,
    SupervisorConfig,
};
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
    private_drain_with_broker(case, close_ms, exit_ms, None)
}
fn private_drain_with_broker(
    case: &str,
    close_ms: u64,
    exit_ms: u64,
    broker_delay: Option<u64>,
) -> (Result<()>, u64) {
    let parent = std::env::temp_dir().join("opencode");
    std::fs::create_dir_all(&parent).unwrap();
    let root = parent.join(format!(
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
    let broker = broker_delay.map(|delay_ms| {
        let entry = root.join("broker.cjs");
        let source = include_str!("../tests/fixtures/deadline-broker.cjs");
        std::fs::write(&entry, source).unwrap();
        std::fs::write(
            root.join("broker-delay.json"),
            json!({"delayMs":delay_ms}).to_string(),
        )
        .unwrap();
        // The raw private peer never loads this inert fixture artifact. Native
        // handle/channel checks remain real; this is not addon qualification.
        let binding = root.join("unused.node");
        std::fs::write(&binding, b"unused private deadline fixture").unwrap();
        BrokerConfig {
            program: NodeProgram {
                node: node.clone(),
                entry: entry.to_string_lossy().into(),
                cwd: root.to_string_lossy().into(),
                loader: None,
            },
            launcher_module: script
                .with_file_name("native-service-launcher.js")
                .to_string_lossy()
                .into(),
            policy: ServicePolicy {
                executable: node.clone(),
                args_prefix: vec!["service".into(), "start".into()],
                cwd: root.to_string_lossy().into(),
                windows_verbatim_arguments: false,
            },
            binding_file: binding.to_string_lossy().into(),
            binding_sha256: wire::digest(&std::fs::read(binding).unwrap()),
            entry_sha256: wire::digest(source.as_bytes()),
            launcher_sha256: wire::digest(b"// never executed\n"),
        }
    });
    if broker.is_some() {
        std::fs::write(
            root.join("native-service-launcher.js"),
            b"// never executed\n",
        )
        .unwrap();
    }
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
        broker,
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
    let broker_member = broker_delay.map(|_| {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.root.join("broker.json")).unwrap())
                .unwrap();
        let member = RuntimeMember::locate(value["pid"].as_u64().unwrap() as u32).unwrap();
        fixture.authority.require_external_member(&member).unwrap();
        member
    });
    let result = serve(runtime);
    let returned_at = wall_ms();
    let ack: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture.root.join("ack.json")).unwrap()).unwrap();
    let elapsed = returned_at - ack["acknowledgedAt"].as_u64().unwrap();
    let cleaned =
        manager.wait_exit(1000).unwrap() && members.iter().all(|m| m.wait_exit(1000).unwrap());
    let sentinel_live = !fixture.external.process().exited().unwrap();
    let broker_cleaned = broker_member
        .as_ref()
        .is_none_or(|m| m.wait_exit(1000).unwrap());
    let cleanup_elapsed = wall_ms() - ack["acknowledgedAt"].as_u64().unwrap();
    fixture.external.process().terminate_owned().unwrap();
    let receipt = json!({"case":case,"result":result.as_ref().err().map(|e|e.0),"elapsedAfterAckMs":elapsed,
        "closeMs":close_ms,"exitMs":exit_ms,"brokerDelayMs":broker_delay,"brokerExitConfirmed":broker_cleaned,"closed":fixture.root.join("closed.json").exists(),
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
    assert!(broker_cleaned, "owned broker did not confirm cleanup");
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

#[test]
fn broker_teardown_cannot_renew_absolute_drain_deadline() {
    for (case, exit_ms) in [("broker-late", 4000), ("broker-manager-late", 7000)] {
        let (result, elapsed) = private_drain_with_broker(case, 3000, exit_ms, Some(10000));
        assert_eq!(result, Err(Error("native-runtime-stop-drain-deadline")));
        assert!(
            elapsed < 6000,
            "broker teardown renewed the five-second cutoff"
        );
    }
}

#[test]
fn broker_teardown_within_original_drain_deadline_succeeds() {
    let (result, elapsed) = private_drain_with_broker("broker-remaining", 400, 1200, Some(200));
    assert_eq!(result, Ok(()));
    assert!(elapsed < 5000);
}
