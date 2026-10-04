//! Private signed failure attestation, deliberately without successful starter facts.
use super::Ledger;
use crate::{runtime_wire, Error, Result};
use serde_json::{json, Value};
impl Ledger {
    pub(crate) fn failure_receipt(&mut self, nonce: &str, digest: &str) -> Result<Vec<u8>> {
        let reason = self.request_failure(nonce)?;
        let r = self
            .records
            .get(nonce)
            .ok_or(Error("native-service-permit-unknown"))?;
        if r.digest != digest {
            return Err(Error("native-service-failure-digest"));
        }
        runtime_wire::sign_receipt(
            &self.manager,
            &json!({"error":reason.code(),"nonce":nonce,"requestDigest":digest,
            "runtimeId":runtime_wire::digest(&runtime_wire::unhex(&self.manager.secret)?),"manager":self.manager.peer,
            "profile":self.manager.profile,"generation":self.manager.generation,"source":self.manager.supervisor,"peer":self.broker.peer}),
        )
    }
    pub(crate) fn verify_response(&mut self, digest: &str, receipt: &[u8]) -> Result<Value> {
        let proof = runtime_wire::verify_receipt(&self.manager, receipt)?;
        if proof.get("error").is_none() {
            return self.verify_complete(digest, receipt);
        }
        crate::service_reply::fields(
            &proof,
            &[
                "error",
                "nonce",
                "requestDigest",
                "runtimeId",
                "manager",
                "profile",
                "generation",
                "source",
                "peer",
            ],
        )?;
        let nonce = proof["nonce"]
            .as_str()
            .ok_or(Error("native-service-failure-nonce"))?;
        if proof["error"] != self.request_failure(nonce)?.code()
            || proof["requestDigest"] != digest
            || self.records.get(nonce).unwrap().digest != digest
            || proof["profile"] != self.manager.profile
            || proof["generation"] != self.manager.generation
            || proof["runtimeId"]
                != runtime_wire::digest(&runtime_wire::unhex(&self.manager.secret)?)
            || proof["manager"] != serde_json::to_value(&self.manager.peer).unwrap()
            || proof["source"] != serde_json::to_value(&self.manager.supervisor).unwrap()
            || proof["peer"] != serde_json::to_value(&self.broker.peer).unwrap()
        {
            return Err(Error("native-service-failure-binding"));
        }
        Ok(proof)
    }
}
