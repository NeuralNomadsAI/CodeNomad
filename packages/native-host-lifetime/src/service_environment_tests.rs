//! Genuine Windows/private native response path; inherited outer Job only.
use super::*;
use crate::launch::spawn_suspended;
use crate::runtime_wire::{self as wire, Decoder};
use crate::service_response::{PendingService, PendingServices};
use crate::{
    BrokerConfig, Child, Command, NodeProgram, Process, SupervisedRuntime, SupervisorConfig,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

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
    }
}
fn request(count: usize) -> ServiceRequest {
    ServiceRequest {
        file: "C:/Program Files/nodejs/node.exe".into(),
        args: vec!["service".into(), "start".into()],
        cwd: "C:/Windows".into(),
        windows_verbatim_arguments: false,
        env: (0..count)
            .map(|i| (format!("CN_ENV_{i}"), "fixture".into()))
            .collect(),
    }
}
fn policy(r: &ServiceRequest) -> ServicePolicy {
    ServicePolicy {
        executable: r.file.clone(),
        args_prefix: r.args.clone(),
        cwd: r.cwd.clone(),
        windows_verbatim_arguments: r.windows_verbatim_arguments,
    }
}
#[test]
fn service_policy_prepares_the_complete_command_before_permit_admission() {
    let valid = request(512);
    assert!(policy(&valid).admit(&valid).is_ok());
    let excessive = request(513);
    assert!(
        policy(&excessive).admit(&excessive).is_err(),
        "513 entries must refuse BEFORE permit issuance"
    );
    let mut duplicate = valid.clone();
    duplicate.env.remove("CN_ENV_1");
    duplicate.env.insert("cn_env_0".into(), "fixture".into());
    assert_eq!(duplicate.env.len(), 512);
    assert!(policy(&duplicate).admit(&duplicate).is_err());
    let mut huge_key = request(1);
    huge_key.env = [("x".repeat(32768), "fixture".into())].into();
    assert!(policy(&huge_key).admit(&huge_key).is_err());
    for verbatim in [false, true] {
        let mut args = request(1);
        args.windows_verbatim_arguments = verbatim;
        args.args.push("x".repeat(16385));
        assert!(policy(&args).admit(&args).is_err());
        args.args = vec!["x".repeat(16000), "y".repeat(16000)];
        assert!(policy(&args).admit(&args).is_err());
    }
}
fn file_uri(path: &Path) -> String {
    format!(
        "file:///{}",
        path.to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "%20")
    )
}
fn program(node: &str, entry: &Path, repo: &Path, loader: &str) -> NodeProgram {
    NodeProgram {
        node: node.into(),
        entry: entry.to_string_lossy().into(),
        cwd: repo.to_string_lossy().into(),
        loader: Some(loader.into()),
    }
}
#[test]
fn native_513_refusal_is_local_before_permit_and_512_starter_preserves_full_environment() {
    let repo = std::env::var_os("CODENOMAD_NATIVE_ENV_FIXTURE_REPO")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_owned()
        });
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    let root = PathBuf::from("C:/Users/Admin/AppData/Local/Temp/opencode").join(format!(
        "native-env-prepermit-process-{}-{}",
        std::process::id(),
        wire::digest(&wire::unhex(&crate::channel_wire::random_hex().unwrap()).unwrap())
    ));
    std::fs::create_dir(&root).unwrap();
    let addon = root.join("fixture.node");
    std::fs::copy(
        target.join("debug/codenomad_native_host_lifetime.dll"),
        &addon,
    )
    .expect("fresh compiled fixture addon required");
    let node = std::env::var("CODENOMAD_NATIVE_FIXTURE_NODE")
        .unwrap_or_else(|_| "C:/Program Files/nodejs/node.exe".into());
    let loader = file_uri(&repo.join("scripts/host-lifetime-node-ipc/loader.mjs"));
    let launcher = repo.join("packages/server/src/workspaces/native-service-launcher.ts");
    let binding_hash = wire::digest(&std::fs::read(&addon).unwrap());
    let inherited = crate::channel_wire::random_hex().unwrap();
    let broker_entry = root.join("broker-entry.mjs");
    let broker_source = format!("import {{runNativeServiceBroker}} from {:?};runNativeServiceBroker({:?},{:?}).catch(()=>process.exit(97));",
        file_uri(&repo.join("packages/native-host-lifetime/node/service-broker.mjs")), addon.to_str().unwrap(), binding_hash);
    std::fs::write(&broker_entry, &broker_source).unwrap();
    let cli = root.join("environment-cli.cjs");
    let cli_source = format!(
        r#"const fs=require('node:fs'),crypto=require('node:crypto');const env=Object.entries(process.env).map(([k,v])=>[k.toUpperCase(),v]).sort(([a],[b])=>a.localeCompare(b));fs.appendFileSync({:?},JSON.stringify({{pid:process.pid,phase:process.env.CN_ENV_PHASE,environmentCount:env.length,environmentSha256:crypto.createHash('sha256').update(JSON.stringify(env)).digest('hex'),inheritedSentinelSha256:crypto.createHash('sha256').update(process.env.CN_ENV_INHERITED_SENTINEL).digest('hex')}})+'\n');process.stdout.write('private-environment-preserved');"#,
        root.join("launches.jsonl").to_str().unwrap()
    );
    std::fs::write(&cli, cli_source).unwrap();
    let selected = ServiceRequest {
        file: node.clone(),
        args: vec![
            cli.to_string_lossy().into(),
            "service".into(),
            "start".into(),
        ],
        env: Default::default(),
        cwd: repo.to_string_lossy().into(),
        windows_verbatim_arguments: false,
    };
    // Explicit test artifact/synthetic inherited value, not an ownership policy flag.
    let manager_entry = root.join("manager-entry.mjs");
    std::fs::write(&manager_entry, format!("process.env.CN_ENV_FIXTURE_BINDING={:?};process.env.CN_ENV_INHERITED_SENTINEL={:?};await import({:?});",
        addon.to_str().unwrap(), inherited, file_uri(&repo.join("packages/native-host-lifetime/tests/fixtures/service-environment-manager.ts")))).unwrap();
    let runtime = SupervisedRuntime::nested_fixture(SupervisorConfig {
        v: 1, profile: "a".repeat(64), generation: "12345678-1234-1234-1234-123456789abc".into(),
        manager: program(&node, &manager_entry, &repo, &loader),
        application: json!({"root":root,"generation":"12345678-1234-1234-1234-123456789abc","scope":{"key":"a".repeat(64)},"fixtureMode":"service-response","fixtureServiceRequest":selected,"inheritedSentinel":inherited}),
        broker: Some(BrokerConfig { program: program(&node, &broker_entry, &repo, &loader),
            launcher_module: launcher.to_string_lossy().into(), policy: policy(&selected),
            binding_file: addon.to_string_lossy().into(), binding_sha256: binding_hash,
            entry_sha256: wire::digest(broker_source.as_bytes()), launcher_sha256: wire::digest(&std::fs::read(&launcher).unwrap()) }),
    }).unwrap();
    let authority = runtime.authority.clone();
    let external = spawn_suspended(
        &Command {
            executable: node.into(),
            args: vec![
                "-e".into(),
                "setTimeout(()=>process.exit(0),30000);setInterval(()=>{},1000)".into(),
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
    let manager = Process {
        handle: fixture.authority.manager().handle.duplicate().unwrap(),
        birth: fixture.authority.manager().identity(),
    };
    let ledger = runtime.services.as_ref().unwrap().ledger.clone();
    let mut observed = Vec::new();
    let mut submitted = 0;
    let mut completed = 0;
    let result = dispatch(
        runtime,
        &fixture.authority,
        &mut observed,
        &mut submitted,
        &mut completed,
    );
    let manager_exited = manager.wait_exit(1000).unwrap();
    let backend_exited = observed.len() == 1 && observed[0].wait_exit(1000).unwrap();
    let sentinel_live = !fixture.external.process().exited().unwrap();
    fixture.external.process().terminate_owned().unwrap();
    let lines = |name: &str| -> Vec<Value> {
        std::fs::read_to_string(fixture.root.join(name))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    };
    let attempts = lines("attempts.jsonl");
    let launches = lines("launches.jsonl");
    let completions = lines("completions.jsonl");
    let proof: Option<Value> = std::fs::read(fixture.root.join("manager-proof.json"))
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).unwrap());
    let l = ledger.lock().unwrap();
    let native_records: Vec<Value> = l.records.values().map(|r| json!({"requestDigest":r.digest,"starterPresent":r.starter.is_some(),
        "starter":r.starter.as_ref().map(|m|json!({"pid":m.identity().pid,"filetime":m.identity().creation_filetime.to_string()})),"complete":r.starter.as_ref().is_some_and(|m|m.exit_code().unwrap()==Some(0))})).collect();
    let receipt = json!({"result":result.as_ref().err().map(|e|e.0),"permits":l.records.len(),"submitted":submitted,"completed":completed,
        "attempts":attempts,"launches":launches,"completions":completions,"nativeRecords":native_records,"managerProof":proof,
        "manager":{"pid":manager.identity().pid,"filetime":manager.identity().creation_filetime.to_string()},
        "backend":observed.first().map(|m|json!({"pid":m.identity().pid,"filetime":m.identity().creation_filetime.to_string()})),
        "managerExitConfirmed":manager_exited,"backendExitConfirmed":backend_exited,"externalSentinelSurvived":sentinel_live,
        "exactSentinelCleanupConfirmed":fixture.external.process().exited().unwrap(),"independentLaunchQualified":false,"productQualified":false});
    std::fs::write(
        fixture.root.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    println!(
        "native environment receipt: {}",
        fixture.root.join("receipt.json").display()
    );
    drop(l);
    assert!(manager_exited && backend_exited && sentinel_live);
    assert_eq!(
        result,
        Ok(()),
        "invalid 513-entry request must refuse locally, not kill M/B"
    );
    assert_eq!((submitted, completed, launches.len()), (2, 2, 2));
    assert_eq!(completions.len(), 2);
    assert!(completions
        .iter()
        .all(|c| c["id"] != 0 && c["error"].is_null()));
    assert_eq!(proof.unwrap()["localRefusals"], 2);
    for phase in ["valid-before", "valid-after"] {
        let request = attempts
            .iter()
            .find(|a| a["phase"] == phase && a["stage"] == "request")
            .unwrap();
        let launch = launches.iter().find(|l| l["phase"] == phase).unwrap();
        assert_eq!(launch["environmentCount"], 512);
        assert_eq!(launch["environmentSha256"], request["environmentSha256"]);
        assert_eq!(
            launch["inheritedSentinelSha256"],
            wire::digest(inherited.as_bytes())
        );
    }
}
fn dispatch(
    mut host: SupervisedRuntime,
    authority: &Arc<Authority>,
    observed: &mut Vec<RuntimeMember>,
    submitted: &mut usize,
    completed: &mut usize,
) -> Result<()> {
    let _shutdown = crate::supervisor_dispatch::Shutdown(authority.clone());
    let boot = host.manager_channel.boot.clone();
    let ledger = host.services.as_ref().unwrap().ledger.clone();
    host.manager_channel.authenticate_receipt(|nonce| {
        crate::supervisor_dispatch::receipt(
            authority,
            &boot,
            nonce,
            authority.manager().identity().pid,
            Some(&ledger),
        )
    })?;
    let mut decoder = Decoder::new();
    let mut pending = PendingServices::new();
    let end = Instant::now() + Duration::from_secs(25);
    loop {
        if Instant::now() >= end {
            return Err(Error("native-env-fixture-deadline"));
        }
        authority.revalidate()?;
        host.manager_channel.revalidate()?;
        let services = host.services.as_ref().unwrap();
        while let Ok(done) = services.results.try_recv() {
            use std::io::Write;
            let completion = json!({"id":done.id,"error":done.result.as_ref().err().map(|e|e.0)});
            let root = host.config.application["root"]
                .as_str()
                .ok_or(Error("native-env-fixture-root"))?;
            let mut trace = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(Path::new(root).join("completions.jsonl"))
                .map_err(|_| Error("native-env-fixture-trace"))?;
            writeln!(trace, "{completion}").map_err(|_| Error("native-env-fixture-trace"))?;
            // SAME production writer/fatal completion behavior, not reinterpreted Refused.
            crate::service_response::write(&host.manager_channel, &ledger, &mut pending, done)?;
            *completed += 1;
        }
        let packet = if let Some(packet) = decoder.take(&boot)? {
            packet
        } else {
            decoder.append(
                &host
                    .manager_channel
                    .pipe
                    .read_bytes(Duration::from_millis(20))?,
            )?;
            continue;
        };
        match packet.opcode {
            1 if packet.payload.len() == 36 => {
                let pid = u32::from_le_bytes(packet.payload[32..].try_into().unwrap());
                let member = authority.observe(pid)?;
                if pid != authority.manager().identity().pid
                    && !observed.iter().any(|m| m.identity() == member.identity())
                {
                    observed.push(member);
                }
                let nonce = hex(&packet.payload[..32]);
                let receipt = crate::supervisor_dispatch::receipt(
                    authority,
                    &boot,
                    &nonce,
                    pid,
                    Some(&ledger),
                )?;
                host.manager_channel.pipe.write_bytes(
                    &wire::encode(&boot, packet.id, 1, 1, &receipt)?,
                    Duration::from_secs(2),
                )?;
            }
            4 if packet.payload.len() > 4 && packet.payload[..4] == [0, 0, 0, 0] => {
                // Existing narrow fixture handoff; public opcode 4 remains independent-only.
                let handoff: Value = serde_json::from_slice(&packet.payload[4..])
                    .map_err(|_| Error("native-env-fixture-handoff"))?;
                let permit = crate::service_control::decode(&handoff["permit"])?;
                let bytes = crate::service_control::decode(&handoff["bytes"])?;
                let cancelled = Arc::new(AtomicBool::new(false));
                let identity =
                    services.submit(packet.id as u64, &permit, &bytes, cancelled.clone())?;
                pending.insert(
                    packet.id,
                    PendingService {
                        identity,
                        cancelled,
                    },
                );
                *submitted += 1;
            }
            3 if pending.is_empty() && packet.payload.is_empty() => {
                host.manager_channel.pipe.write_bytes(
                    &wire::encode(&boot, packet.id, 3, 1, &[])?,
                    Duration::from_secs(2),
                )?;
                if !authority.manager().wait_exit(4000)? {
                    return Err(Error("native-env-fixture-manager-exit"));
                }
                return Ok(());
            }
            _ => return Err(Error("native-env-fixture-operation")),
        }
    }
}
