use crate::runtime_wire::{self as wire, Decoder};
use crate::supervised_runtime::{Authority, SupervisedRuntime};
use crate::{Error, Result};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "supervisor_deadline.rs"]
mod deadline;

#[cfg(all(test, feature = "fixtures"))]
#[path = "supervisor_deadline_tests.rs"]
mod deadline_tests;

pub(crate) struct Shutdown(pub(crate) Arc<Authority>);
impl Drop for Shutdown {
    fn drop(&mut self) {
        self.0.close();
    }
}
pub(crate) fn serve(mut host: SupervisedRuntime) -> Result<()> {
    let mut ending = None;
    let result = dispatch(&mut host, &mut ending);
    // Services/controls join and exact broker cleanup are part of Stop, not
    // destructors allowed to turn an in-budget result into late success.
    drop(host);
    deadline::check(ending)?;
    result
}
fn dispatch(host: &mut SupervisedRuntime, ending: &mut Option<Instant>) -> Result<()> {
    let authority = host.authority.clone();
    let boot = host.manager_channel.boot.clone();
    let ledger = host.services.as_ref().map(|s| s.ledger.clone());
    host.manager_channel.authenticate_receipt(|nonce| {
        receipt(
            &authority,
            &boot,
            nonce,
            authority.manager().identity().pid,
            ledger.as_ref(),
        )
    })?;
    let _shutdown = Shutdown(host.authority.clone());
    let mut decoder = Decoder::new();
    let mut partial: Option<Instant> = None;
    let mut observed = Vec::new();
    let mut pending = crate::service_response::PendingServices::new();
    loop {
        deadline::check(*ending)?;
        if host.authority.manager().exited()? {
            return confirm_members(&observed, *ending);
        }
        if let Some(services) = &host.services {
            while let Ok(done) = services.results.try_recv() {
                crate::service_response::write(
                    &host.manager_channel,
                    &services.ledger,
                    &mut pending,
                    done,
                )?;
            }
        }
        if host.authority.manager().exited()? {
            return confirm_members(&observed, *ending);
        }
        host.authority.revalidate()?;
        host.manager_channel.revalidate()?;
        deadline::check(*ending)?;
        if partial.is_some_and(|end| Instant::now() >= end) {
            return Err(Error("native-runtime-partial-deadline"));
        }
        let packet = if let Some(packet) = decoder.take(&host.manager_channel.boot)? {
            packet
        } else {
            match host
                .manager_channel
                .pipe
                .read_bytes(deadline::remaining(*ending, Duration::from_millis(20))?)
            {
                Ok(bytes) => {
                    if !bytes.is_empty() {
                        if partial.is_none() {
                            partial = Some(Instant::now() + Duration::from_secs(5));
                        }
                        decoder.append(&bytes)?;
                    }
                    continue;
                }
                Err(_) if ending.is_some() => {
                    deadline::wait_exit(*ending, "native-runtime-stop-unconfirmed", |ms| {
                        host.authority.manager().wait_exit(ms)
                    })?;
                    return confirm_members(&observed, *ending);
                }
                Err(error) => {
                    if host.authority.manager().wait_exit(100)? {
                        continue;
                    }
                    return Err(error);
                }
            }
        };
        partial = None;
        let payload = match packet.opcode {
            1 if ending.is_none() && packet.payload.len() == 36 => {
                let pid = u32::from_le_bytes(packet.payload[32..36].try_into().unwrap());
                let member = host.authority.observe(pid)?;
                if pid != host.authority.manager().identity().pid
                    && !observed
                        .iter()
                        .any(|m: &crate::RuntimeMember| m.identity() == member.identity())
                {
                    observed.retain(|m| !m.wait_exit(0).unwrap_or(false));
                    if observed.len() >= 64 {
                        return Err(Error("native-runtime-member-bound"));
                    }
                    observed.push(member);
                }
                let nonce = packet.payload[..32]
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                receipt(
                    &host.authority,
                    &host.manager_channel.boot,
                    &nonce,
                    pid,
                    ledger.as_ref(),
                )?
            }
            2 if [
                b"backend-exit".as_slice(),
                b"startup-failed",
                b"owner-lost",
                b"election-lost",
            ]
            .contains(&packet.payload.as_slice()) =>
            {
                if let Some(services) = &host.services {
                    services
                        .ledger
                        .lock()
                        .map_err(|_| Error("native-service-ledger-poisoned"))?
                        .fence();
                    for (id, active) in &pending {
                        active
                            .cancelled
                            .store(true, std::sync::atomic::Ordering::Release);
                        let _ = services
                            .sender
                            .try_send(crate::service_channel::Work::Cancel(*id as u64));
                    }
                }
                vec![]
            }
            3 if packet.payload.is_empty() && ending.is_none() && pending.is_empty() => {
                // Authenticated M has drained native BackendProcess/control close. The
                // acknowledgement is NOT native proof of successful graceful Stop.
                let end = Instant::now() + Duration::from_secs(5);
                *ending = Some(end);
                if let Some(services) = &host.services {
                    services.begin_stop(end)?;
                }
                vec![]
            }
            4 if ending.is_none() && host.authority.independent() => {
                if packet.payload.len() < 4 || pending.len() >= 16 {
                    return Err(Error("native-service-frame-bound"));
                }
                let length = u32::from_le_bytes(packet.payload[..4].try_into().unwrap()) as usize;
                if !(32..=4096).contains(&length) || length + 4 >= packet.payload.len() {
                    return Err(Error("native-service-permit-bound"));
                }
                let services = host
                    .services
                    .as_ref()
                    .ok_or(Error("native-service-peer-unavailable"))?;
                let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let identity = services.submit(
                    packet.id as u64,
                    &packet.payload[4..4 + length],
                    &packet.payload[4 + length..],
                    cancelled.clone(),
                )?;
                pending.insert(
                    packet.id,
                    crate::service_response::PendingService {
                        identity,
                        cancelled,
                    },
                );
                continue;
            }
            _ => return Err(Error("native-runtime-operation-refused")),
        };
        let bytes = wire::encode(
            &host.manager_channel.boot,
            packet.id,
            packet.opcode,
            1,
            &payload,
        )?;
        let written = host.manager_channel.pipe.write_bytes(
            &bytes,
            deadline::remaining(*ending, Duration::from_secs(5))?,
        );
        // Even synchronous I/O or a cancellation-race completion can be observed late.
        deadline::check(*ending)?;
        written?;
        if packet.opcode == 2 {
            host.authority.close();
            return Err(Error("native-runtime-fatal"));
        }
    }
}
fn confirm_members(observed: &[crate::RuntimeMember], ending: Option<Instant>) -> Result<()> {
    deadline::check(ending)?;
    for member in observed {
        deadline::wait_exit(ending, "native-runtime-cleanup-unconfirmed", |ms| {
            member.wait_exit(ms)
        })?;
    }
    // An already-exited manager or last member is not permission for late success.
    deadline::check(ending)
}
pub(crate) fn receipt(
    authority: &Authority,
    boot: &crate::channel_wire::ChannelBootstrap,
    nonce: &str,
    pid: u32,
    ledger: Option<&crate::service_control::SharedLedger>,
) -> Result<Vec<u8>> {
    let member = authority.observe(pid)?;
    let birth = member.identity();
    let runtime_id = wire::digest(&wire::unhex(&boot.secret)?);
    let mut facts = if pid == authority.manager().identity().pid {
        json!({"nonce":nonce,"generation":boot.generation,"scope":boot.application["scope"],
                        "runtimeId":runtime_id,"manager":{"pid":birth.pid,"filetime":birth.creation_filetime.to_string()},
                        "supervisor":{"pid":boot.supervisor.pid,"filetime":boot.supervisor.creation_filetime},
                        "alive":true,"assignedSuspended":true,"supervisorOutsideAllJobs":authority.independent(),
                        "ownerBootstrapVerified":authority.independent(),"soleJobOwnerPid":boot.supervisor.pid,
                        "jobHandleInherited":false,"limitFlags":0x2000,
                         "servicePeer":if let Some(l)=ledger {l.lock().map_err(|_|Error("native-service-ledger-poisoned"))?.facts()?}else{serde_json::Value::Null}})
    } else {
        json!({"nonce":nonce,"runtimeId":runtime_id,"member":{"pid":birth.pid,"filetime":birth.creation_filetime.to_string()},
                    "alive":true,"inherited":true})
    };
    facts["launchDigest"] = wire::digest(
        &serde_json::to_vec(&boot.application).map_err(|_| Error("native-launch-invalid"))?,
    )
    .into();
    facts["source"] =
        json!({"pid":boot.supervisor.pid,"filetime":boot.supervisor.creation_filetime});
    wire::sign_receipt(boot, &facts)
}
