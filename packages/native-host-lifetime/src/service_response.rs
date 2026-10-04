//! The same pending settlement/wire writer is used by S and the explicit native fixture.
use crate::bound_channel::BoundChannel;
use crate::service_channel::{Completion, ServiceOutcome};
use crate::service_control::SharedLedger;
use crate::{Error, Result};
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;
pub(crate) struct RequestIdentity {
    pub(crate) nonce: String,
    pub(crate) digest: String,
}
pub(crate) struct PendingService {
    pub(crate) identity: RequestIdentity,
    pub(crate) cancelled: Arc<AtomicBool>,
}
pub(crate) type PendingServices = HashMap<u32, PendingService>;
pub(crate) fn write(
    channel: &BoundChannel,
    ledger: &SharedLedger,
    pending: &mut PendingServices,
    done: Completion,
) -> Result<()> {
    if done.id == 0 {
        return Err(done
            .result
            .err()
            .unwrap_or(Error("native-service-worker-failed")));
    }
    let id = u32::try_from(done.id)
        .ok()
        .filter(|n| *n > 0)
        .ok_or(Error("native-service-completion-id"))?;
    let active = pending
        .get(&id)
        .ok_or(Error("native-service-response-unknown"))?;
    let mut l = ledger
        .lock()
        .map_err(|_| Error("native-service-ledger-poisoned"))?;
    let payload = match done.result? {
        ServiceOutcome::Succeeded(receipt, output) => {
            crate::service_reply::output(&output)?;
            let facts = l.verify_complete(&active.identity.digest, &receipt)?;
            if facts["nonce"] != active.identity.nonce {
                return Err(Error("native-service-response-permit-mismatch"));
            }
            let mut data = (receipt.len() as u32).to_le_bytes().to_vec();
            data.extend(receipt);
            data.extend(
                serde_json::to_vec(&output).map_err(|_| Error("native-service-output-invalid"))?,
            );
            data
        }
        ServiceOutcome::RequestFailed(reason) => {
            if l.request_failure(&active.identity.nonce)? != reason {
                return Err(Error("native-service-failure-inconsistent"));
            }
            // A signed failure attestation (not success facts) binds the exact
            // issued nonce so the SDK can consume that admission and reject only
            // this request, without closing the authenticated runtime channel.
            let receipt = l.failure_receipt(&active.identity.nonce, &active.identity.digest)?;
            let mut data = (receipt.len() as u32).to_le_bytes().to_vec();
            data.extend(receipt);
            data.extend(serde_json::to_vec(&serde_json::json!({"error":reason.code()})).unwrap());
            data
        }
    };
    drop(l);
    channel.revalidate()?;
    channel.pipe.write_bytes(
        &crate::runtime_wire::encode(&channel.boot, id, 4, 1, &payload)?,
        Duration::from_secs(2),
    )?;
    pending
        .remove(&id)
        .ok_or(Error("native-service-pending-inconsistent"))?;
    Ok(())
}
