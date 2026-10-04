//! Native narrow response-path fixture. Never admits opcode 4 through the public facade.
use crate::runtime_wire::{self as wire, Decoder};
use crate::service_response::{PendingService, PendingServices};
use crate::supervised_runtime::SupervisedRuntime;
use crate::{Error, Result, RuntimeMember};
use std::os::windows::io::AsRawHandle;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::{Duration, Instant};

pub(crate) fn run() -> Result<()> {
    let config = crate::channel_fixture::read_config()?;
    let case = config.application["fixtureResponseCase"]
        .as_str()
        .ok_or(Error("native-fixture-response-case"))?
        .to_owned();
    if ![
        "healthy",
        "malformed-peer",
        "unknown-peer-id",
        "unknown-completion",
        "invalid-receipt",
        "peer-loss",
        "unconfirmed-failure",
        "wrong-peer-scope",
        "oversize-output",
    ]
    .contains(&case.as_str())
    {
        return Err(Error("native-fixture-response-case"));
    }
    let mut host = SupervisedRuntime::nested_fixture(config)?;
    let authority = host.authority.clone();
    let mut members: Vec<RuntimeMember> = Vec::new();
    let mut completed = 0;
    let result = (|| -> Result<()> {
        let _shutdown = crate::supervisor_dispatch::Shutdown(authority.clone());
        let ledger = host
            .services
            .as_ref()
            .ok_or(Error("native-fixture-service-missing"))?
            .ledger
            .clone();
        let boot = host.manager_channel.boot.clone();
        host.manager_channel.authenticate_receipt(|nonce| {
            crate::supervisor_dispatch::receipt(
                &authority,
                &boot,
                nonce,
                authority.manager().identity().pid,
                Some(&ledger),
            )
        })?;
        let mut decoder = Decoder::new();
        let mut pending = PendingServices::new();
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            if Instant::now() >= end {
                return Err(Error("native-fixture-response-deadline"));
            }
            authority.revalidate()?;
            host.manager_channel.revalidate()?;
            let services = host.services.as_ref().unwrap();
            while let Ok(mut done) = services.results.try_recv() {
                // Deliberate native fixture faults feed the SAME production
                // completion function; no JS SDK object or ownership bit is forged.
                if case == "unknown-completion" && done.id != 0 {
                    done.id += 100000;
                }
                if case == "invalid-receipt" {
                    if let Ok(crate::service_channel::ServiceOutcome::Succeeded(
                        ref mut receipt,
                        _,
                    )) = done.result
                    {
                        receipt[0] ^= 1;
                    }
                }
                crate::service_response::write(&host.manager_channel, &ledger, &mut pending, done)?;
                completed += 1;
            }
            let packet = if let Some(packet) = decoder.take(&host.manager_channel.boot)? {
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
                        && !members.iter().any(|m| m.identity() == member.identity())
                    {
                        members.push(member);
                    }
                    let nonce = crate::service_permit::hex(&packet.payload[..32]);
                    let receipt = crate::supervisor_dispatch::receipt(
                        &authority,
                        &host.manager_channel.boot,
                        &nonce,
                        pid,
                        Some(&ledger),
                    )?;
                    host.manager_channel.pipe.write_bytes(
                        &wire::encode(&host.manager_channel.boot, packet.id, 1, 1, &receipt)?,
                        Duration::from_secs(2),
                    )?;
                }
                4 if pending.len() < 16 && completed < 2 => {
                    // Explicit fixture handoff. The fixture-only SDK issued and
                    // retained the real permit on its native control channel.
                    // Public serve() still requires independent authority.
                    if packet.payload.len() < 5 || packet.payload[..4] != [0, 0, 0, 0] {
                        return Err(Error("native-fixture-handoff-shape"));
                    }
                    let handoff: serde_json::Value =
                        serde_json::from_slice(&packet.payload[4..])
                            .map_err(|_| Error("native-fixture-handoff-invalid"))?;
                    crate::service_reply::fields(&handoff, &["permit", "bytes"])?;
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
                    if case == "peer-loss" {
                        ledger.lock().unwrap().kill_fixture_peer()?;
                    }
                }
                3 if case == "healthy"
                    && completed == 2
                    && pending.is_empty()
                    && packet.payload.is_empty() =>
                {
                    host.manager_channel.pipe.write_bytes(
                        &wire::encode(&host.manager_channel.boot, packet.id, 3, 1, &[])?,
                        Duration::from_secs(2),
                    )?;
                    if !authority.manager().wait_exit(5000)? {
                        return Err(Error("native-fixture-response-manager-exit"));
                    }
                    return Ok(());
                }
                _ => return Err(Error("native-fixture-response-operation")),
            }
        }
    })();
    if case == "healthy" && result.is_err() {
        return result;
    }
    if case != "healthy" && result.is_ok() {
        return Err(Error("native-fixture-fatal-not-observed"));
    }
    let fatal_code = result.as_ref().err().map(|e| e.0);
    let expected: &[&str] = match case.as_str() {
        "healthy" => &[],
        "malformed-peer" => &["native-service-response-shape"],
        "unknown-peer-id" | "unknown-completion" => &["native-service-response-unknown"],
        "invalid-receipt" => &["native-receipt-source"],
        // Intentional retained-peer death may surface before read, as pipe EOF,
        // or as synchronous broken-pipe I/O. All remain fatal transport paths.
        "peer-loss" => &[
            "native-channel-peer-lost",
            "native-channel-closed",
            "native-channel-io-failed",
        ],
        "unconfirmed-failure" => &["native-service-failure-unconfirmed"],
        "wrong-peer-scope" => &["native-service-response-scope"],
        "oversize-output" => &["native-service-output-bound"],
        _ => return Err(Error("native-fixture-response-case")),
    };
    if (fatal_code.is_none() && !expected.is_empty())
        || fatal_code.is_some_and(|code| !expected.contains(&code))
    {
        return Err(Error(
            fatal_code.unwrap_or("native-fixture-unexpected-fatal-path"),
        ));
    }
    // The production Shutdown guard must close the real sole-owned runtime Job.
    if !authority.manager().wait_exit(5000)? || members.len() != 1 || !members[0].wait_exit(5000)? {
        return Err(Error("native-fixture-response-cleanup-unconfirmed"));
    }
    let proof=serde_json::to_vec(&serde_json::json!({"case":case,"compiledAddon":true,"nativePrivateChannel":true,
        "sameProductionCompletionWriter":true,"correlatedFailurePreservesManagerBackend":case=="healthy","subsequentServiceSuccess":case=="healthy","fatalCode":fatal_code,
        "fatalFaultClosesRuntimeJob":case!="healthy","managerAndBackendExitConfirmed":true,"independentLaunchQualified":false,"productManagerQualified":false})).unwrap();
    crate::pipe::write_bootstrap(std::io::stdout().as_raw_handle(), &proof)
}
