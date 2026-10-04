//! Explicit nested-Job fixture: cannot construct OwnerBootstrap or qualify .open().
use crate::supervised_runtime::SupervisedRuntime;
use crate::{Error, Result, SupervisorConfig};
use std::os::windows::io::AsRawHandle;
use std::time::Duration;
pub(crate) fn run() -> Result<()> {
    let config = read_config()?;
    run_config(config)
}
pub(crate) fn read_config() -> Result<SupervisorConfig> {
    let input = std::io::stdin().as_raw_handle();
    let length = crate::pipe::read_exact(input, 4, Duration::from_secs(5))?;
    let size = u32::from_le_bytes(length.try_into().unwrap()) as usize;
    if size > 4000 {
        return Err(Error("native-channel-fixture-bound"));
    }
    let config: SupervisorConfig = serde_json::from_slice(&crate::pipe::read_exact(
        input,
        size,
        Duration::from_secs(5),
    )?)
    .map_err(|_| Error("native-channel-fixture-config"))?;
    Ok(config)
}
fn run_config(config: SupervisorConfig) -> Result<()> {
    let drained = config.application["fixtureMode"] == "drain";
    let refused = config.application["fixtureMode"] == "product-closed";
    let broker_present = config.broker.is_some();
    let runtime = SupervisedRuntime::nested_fixture(config)?;
    let authority = runtime.authority.clone();
    let mut crash_starter = None;
    if let Some(broker) = runtime.config.broker.clone() {
        use crate::channel_wire::ServiceRequest;
        use crate::service_channel::Work;
        use std::sync::{atomic::AtomicBool, Arc};
        let worker = runtime
            .services
            .as_ref()
            .ok_or(Error("native-fixture-service-missing"))?;
        let request = ServiceRequest {
            file: broker.policy.executable,
            args: broker.policy.args_prefix,
            env: std::env::vars()
                .filter(|(key, _)| {
                    ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]
                        .iter()
                        .any(|k| key.eq_ignore_ascii_case(k))
                })
                .chain([("CNHL_MOCK_ENV".into(), "unchanged".into())])
                .collect(),
            cwd: broker.policy.cwd,
            windows_verbatim_arguments: broker.policy.windows_verbatim_arguments,
        };
        let deadline = crate::channel_wire::now() + 5000;
        let bytes = serde_json::to_vec(&serde_json::json!({"request":request,"deadline":deadline}))
            .map_err(|_| Error("native-fixture-request"))?;
        let permit = worker.ledger.lock().unwrap().issue(&bytes, deadline)?;
        let token = crate::runtime_wire::verify_receipt(&runtime.manager_channel.boot, &permit)?;
        for field in ["profile", "generation", "requestDigest"] {
            let mut altered = token.clone();
            altered[field] = "invalid".into();
            let signed =
                crate::runtime_wire::sign_receipt(&runtime.manager_channel.boot, &altered)?;
            if worker
                .submit(9, &signed, &bytes, Arc::new(AtomicBool::new(false)))
                .is_ok()
            {
                return Err(Error("native-fixture-permit-scope-ignored"));
            }
        }
        let mut exposed = runtime.manager_channel.boot.clone();
        exposed.receipt_secret = exposed.secret.clone();
        let forged = crate::runtime_wire::sign_receipt(&exposed, &token)?;
        if worker
            .submit(9, &forged, &bytes, Arc::new(AtomicBool::new(false)))
            .is_ok()
        {
            return Err(Error("native-fixture-wire-key-authority"));
        }
        let mut corrupt = permit.clone();
        corrupt[0] ^= 1;
        let mut expired: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let old = crate::channel_wire::now() - 1;
        expired["deadline"] = old.into();
        if worker
            .submit(9, &corrupt, &bytes, Arc::new(AtomicBool::new(false)))
            .is_ok()
        {
            return Err(Error("native-fixture-forged-permit-accepted"));
        }
        let mut modified = bytes.clone();
        modified.push(b' ');
        if worker
            .submit(9, &permit, &modified, Arc::new(AtomicBool::new(false)))
            .is_ok()
        {
            return Err(Error("native-fixture-request-digest-ignored"));
        }
        worker.submit(1, &permit, &bytes, Arc::new(AtomicBool::new(false)))?;
        if worker
            .submit(2, &permit, &bytes, Arc::new(AtomicBool::new(false)))
            .is_ok()
        {
            return Err(Error("native-fixture-replay-accepted"));
        }
        let result = worker
            .results
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| Error("native-channel-fixture-service-deadline"))?;
        if result.id != 1 {
            return Err(Error("native-channel-fixture-service-correlation"));
        }
        let crate::service_channel::ServiceOutcome::Succeeded(receipt, output) = result.result?
        else {
            return Err(Error("native-fixture-success-expected"));
        };
        if output["stdout"] != "mock-service-started:unchanged" || output["stderr"] != "" {
            return Err(Error("native-channel-fixture-service-output"));
        }
        worker
            .sender
            .try_send(Work::Cancel(1))
            .map_err(|_| Error("native-channel-fixture-service-queue"))?;
        let facts = worker
            .ledger
            .lock()
            .unwrap()
            .verify_complete(&crate::runtime_wire::digest(&bytes), &receipt)?;
        if facts["outsideAllJobsBeforeResume"] != false {
            return Err(Error("native-fixture-independent-proof-forged"));
        }
        if worker
            .ledger
            .lock()
            .unwrap()
            .issue(&serde_json::to_vec(&expired).unwrap(), old)
            .is_ok()
        {
            return Err(Error("native-fixture-expired-permit-issued"));
        }
        let mut envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        envelope["request"]["env"]["CNHL_MOCK_MODE"] = "hang".into();
        envelope["deadline"] = (crate::channel_wire::now() + 3000).into();
        let hang = serde_json::to_vec(&envelope).unwrap();
        let until = envelope["deadline"].as_u64().unwrap();
        let permit = worker.ledger.lock().unwrap().issue(&hang, until)?;
        let token = crate::runtime_wire::verify_receipt(&runtime.manager_channel.boot, &permit)?;
        let nonce = token["nonce"].as_str().unwrap();
        worker.submit(2, &permit, &hang, Arc::new(AtomicBool::new(false)))?;
        let end = std::time::Instant::now() + Duration::from_secs(2);
        let member = loop {
            if let Some(m) = worker.ledger.lock().unwrap().running(nonce)? {
                break m;
            }
            if std::time::Instant::now() >= end {
                return Err(Error("native-fixture-starter-not-running"));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        worker.ledger.lock().unwrap().cancel(nonce);
        if !member.wait_exit(1000)? {
            return Err(Error("native-fixture-owned-cancel-unconfirmed"));
        }
        let cancelled = worker
            .results
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| Error("native-fixture-cancel-response"))?;
        if cancelled.id != 2
            || !matches!(
                cancelled.result,
                Ok(crate::service_channel::ServiceOutcome::RequestFailed(
                    crate::service_reply::RequestFailure::Cancelled
                ))
            )
        {
            return Err(Error("native-fixture-cancel-delivered-success"));
        }
        envelope["deadline"] = (crate::channel_wire::now() + 1000).into();
        let expiring = serde_json::to_vec(&envelope).unwrap();
        let permit = worker
            .ledger
            .lock()
            .unwrap()
            .issue(&expiring, envelope["deadline"].as_u64().unwrap())?;
        let token = crate::runtime_wire::verify_receipt(&runtime.manager_channel.boot, &permit)?;
        let nonce = token["nonce"].as_str().unwrap();
        worker.submit(3, &permit, &expiring, Arc::new(AtomicBool::new(false)))?;
        let end = std::time::Instant::now() + Duration::from_millis(800);
        let member = loop {
            if let Some(member) = worker.ledger.lock().unwrap().running(nonce)? {
                break member;
            }
            if std::time::Instant::now() >= end {
                return Err(Error("native-fixture-expiry-starter-not-running"));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let expired = worker
            .results
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| Error("native-fixture-expiry-response"))?;
        if expired.id != 3
            || !matches!(
                expired.result,
                Ok(crate::service_channel::ServiceOutcome::RequestFailed(
                    crate::service_reply::RequestFailure::Cancelled
                ))
            )
            || !member.wait_exit(1000)?
        {
            return Err(Error("native-fixture-expiry-not-fenced"));
        }
        if !drained && !refused {
            envelope["deadline"] = (crate::channel_wire::now() + 20000).into();
            let bytes = serde_json::to_vec(&envelope).unwrap();
            let permit = worker
                .ledger
                .lock()
                .unwrap()
                .issue(&bytes, envelope["deadline"].as_u64().unwrap())?;
            let token =
                crate::runtime_wire::verify_receipt(&runtime.manager_channel.boot, &permit)?;
            let nonce = token["nonce"].as_str().unwrap();
            worker.submit(4, &permit, &bytes, Arc::new(AtomicBool::new(false)))?;
            let end = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                if let Some(member) = worker.ledger.lock().unwrap().running(nonce)? {
                    crash_starter = Some(member);
                    break;
                }
                if std::time::Instant::now() >= end {
                    return Err(Error("native-fixture-crash-starter-not-running"));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        envelope["deadline"] = (crate::channel_wire::now() + 10000).into();
        let queued = serde_json::to_vec(&envelope).unwrap();
        let limit = envelope["deadline"].as_u64().unwrap();
        let mut admitted = 0;
        while worker.ledger.lock().unwrap().issue(&queued, limit).is_ok() {
            admitted += 1;
            if admitted > 16 {
                return Err(Error("native-fixture-permits-unbounded"));
            }
        }
        if admitted == 0 {
            return Err(Error("native-fixture-permit-capacity-not-exercised"));
        }
    }
    if let Err(error) = runtime.serve() {
        if let Ok(data) = authority.core().diagnostic() {
            eprintln!("native-addon-fixture-stage-{}", data[0]);
        }
        return Err(error);
    }
    if !authority.manager().wait_exit(5000)? {
        return Err(Error("native-channel-fixture-owner-live"));
    }
    if let Some(member) = crash_starter {
        if !member.wait_exit(1000)? {
            return Err(Error("native-fixture-starter-survived-manager"));
        }
    }
    let mut code = 0;
    if unsafe {
        windows_sys::Win32::System::Threading::GetExitCodeProcess(
            authority.manager().handle.raw(),
            &mut code,
        )
    } == 0
        || code != if drained || refused { 0 } else { 77 }
    {
        if let Ok(data) = authority.core().diagnostic() {
            eprintln!("native-addon-fixture-stage-{}", data[0]);
        }
        return Err(Error("native-addon-fixture-consumer-incomplete"));
    }
    let evidence=serde_json::to_vec(&serde_json::json!({"compiledAddon":true,"abi":"codenomad.runtime.v1",
        "nativePrivateChannel":true,"sustainedWire":"CNHRv001","exactManagerDeathCleanup":true,
        "outsideBrokerSharedLauncherMock":broker_present,"nativeSuspendedStarterCounterproof":broker_present,"singleUsePermitReplayRejected":true,
        "nativeOwnedStarterCancellation":true,"exactRequestDigestRejected":true,"expiredPermitRejected":true,
        "nativePermitScopeGenerationAndWireKeyRejected":true,"managerDeathKillsOnlyOwnedStarter":!drained&&!refused,
        "nativeDeadlineKillsOwnedStarter":true,
        "nativePermitBackpressure":true,
        "stopAcknowledgementConsumed":drained,"productFactoryRefused":refused,
        "independentLaunchQualified":false,"productManagerQualified":false,"serviceStarterQualified":false})).map_err(|_|Error("native-fixture-evidence"))?;
    crate::pipe::write_bootstrap(std::io::stdout().as_raw_handle(), &evidence)?;
    Ok(())
}
