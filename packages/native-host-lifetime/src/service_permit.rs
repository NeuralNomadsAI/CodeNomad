//! S-only irreversible admission ledger. No caller key, PID or JSON bit is authority.
use crate::channel_wire::{self as wire, ChannelBootstrap, ServicePolicy, ServiceRequest};
use crate::runtime_wire;
use crate::supervised_runtime::Authority;
use crate::{Error, Result, RuntimeMember};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
#[cfg(all(test, feature = "fixtures"))]
#[path = "service_environment_tests.rs"]
mod environment_tests;
#[path = "service_failure_receipt.rs"]
mod failure_receipt;
pub(crate) const MAX_REQUEST: usize = 110 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Envelope {
    pub(crate) request: ServiceRequest,
    pub(crate) deadline: u64,
}
pub(crate) struct Budget {
    absolute: u64,
    end: Instant,
}
impl Budget {
    pub(crate) fn new(absolute: u64) -> Result<Self> {
        let left = absolute
            .checked_sub(wire::now())
            .filter(|n| *n > 0 && *n <= 30000)
            .ok_or(Error("native-service-expired"))?;
        Ok(Self {
            absolute,
            end: Instant::now() + Duration::from_millis(left),
        })
    }
    pub(crate) fn check(&self) -> Result<()> {
        if wire::now() >= self.absolute || Instant::now() >= self.end {
            Err(Error("native-service-expired"))
        } else {
            Ok(())
        }
    }
    pub(crate) fn remaining(&self) -> u64 {
        self.end
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(self.absolute.saturating_sub(wire::now()) as u128) as u64
    }
    pub(crate) fn limit(&mut self, remaining: u64) -> Result<()> {
        if remaining == 0 || remaining > 30000 {
            return Err(Error("native-service-budget-invalid"));
        }
        self.end = self
            .end
            .min(Instant::now() + Duration::from_millis(remaining));
        self.check()
    }
}
#[derive(PartialEq)]
enum State {
    Issued,
    Forwarded,
    Prepared,
    Resumed,
    Complete,
    Failed,
    Cancelled,
}
struct Record {
    budget: Budget,
    state: State,
    digest: String,
    starter: Option<RuntimeMember>,
    owner: Option<crate::Process>,
    outside: bool,
}
pub(crate) struct Ledger {
    pub(crate) authority: Arc<Authority>,
    pub(crate) manager: ChannelBootstrap,
    pub(crate) broker: ChannelBootstrap,
    pub(crate) policy: ServicePolicy,
    pub(crate) peer: RuntimeMember,
    peer_owner: crate::handle::Handle,
    records: HashMap<String, Record>,
    closed: bool,
}
impl Ledger {
    pub(crate) fn fresh(&self) -> Result<()> {
        if self.closed {
            return Err(Error("native-service-fenced"));
        }
        self.authority.revalidate()?;
        self.peer.revalidate()?;
        if self.peer.exited()? {
            return Err(Error("native-service-peer-dead"));
        }
        self.authority.require_external_member(&self.peer)
    }
    pub(crate) fn new(
        authority: Arc<Authority>,
        manager: ChannelBootstrap,
        broker: ChannelBootstrap,
        policy: ServicePolicy,
        peer_process: &crate::Process,
    ) -> Result<Self> {
        let peer = RuntimeMember::locate(broker.peer.pid)?;
        if crate::channel_wire::Birth::from(peer.identity()) != broker.peer {
            return Err(Error("native-service-peer-birth"));
        }
        Ok(Self {
            authority,
            manager,
            broker,
            policy,
            peer,
            peer_owner: peer_process.handle.duplicate()?,
            records: HashMap::new(),
            closed: false,
        })
    }
    pub(crate) fn facts(&self) -> Result<Value> {
        self.fresh()?;
        let birth = self.peer.identity();
        Ok(
            json!({"pid":birth.pid,"filetime":birth.creation_filetime.to_string(),"outsideAllJobs":self.authority.independent(),
            "policyScope":self.manager.profile,"launcher":"native-service-launcher-v1"}),
        )
    }
    pub(crate) fn issue(&mut self, bytes: &[u8], deadline: u64) -> Result<Vec<u8>> {
        self.fresh()?;
        let e = self.parse(bytes, deadline)?;
        self.expire();
        self.records.retain(|_, r| r.budget.check().is_ok());
        if self.records.len() >= 16 {
            return Err(Error("native-service-permit-capacity"));
        }
        let budget = Budget::new(e.deadline)?;
        let nonce = wire::random_hex()?;
        let digest = runtime_wire::digest(bytes);
        let token = json!({"v":1,"nonce":nonce,"requestDigest":digest,"deadline":deadline,"profile":self.manager.profile,
            "generation":self.manager.generation,"runtimeId":runtime_wire::digest(&runtime_wire::unhex(&self.manager.secret)?),
            "peer":self.broker.peer,"manager":self.manager.peer,"source":self.manager.supervisor});
        let permit = runtime_wire::sign_receipt(&self.manager, &token)?;
        self.records.insert(
            nonce,
            Record {
                budget,
                state: State::Issued,
                digest,
                starter: None,
                owner: None,
                outside: false,
            },
        );
        Ok(permit)
    }
    fn parse(&self, bytes: &[u8], deadline: u64) -> Result<Envelope> {
        if bytes.len() > MAX_REQUEST {
            return Err(Error("native-service-request-bound"));
        }
        let e: Envelope =
            serde_json::from_slice(bytes).map_err(|_| Error("native-service-request-invalid"))?;
        if e.deadline != deadline {
            return Err(Error("native-service-deadline-mismatch"));
        }
        self.policy.admit(&e.request)?;
        crate::supervisor_config::artifact(&e.request.file)?;
        crate::supervisor_config::artifact(&e.request.cwd)?;
        Ok(e)
    }
    pub(crate) fn consume(&mut self, permit: &[u8], bytes: &[u8]) -> Result<Value> {
        self.fresh()?;
        let token = runtime_wire::verify_receipt(&self.manager, permit)?;
        let nonce = token["nonce"]
            .as_str()
            .ok_or(Error("native-service-permit-invalid"))?;
        let deadline = token["deadline"]
            .as_u64()
            .ok_or(Error("native-service-permit-invalid"))?;
        self.parse(bytes, deadline)?;
        if token["v"] != 1
            || token["profile"] != self.manager.profile
            || token["generation"] != self.manager.generation
            || token["runtimeId"]
                != runtime_wire::digest(&runtime_wire::unhex(&self.manager.secret)?)
            || token["source"] != serde_json::to_value(&self.manager.supervisor).unwrap()
            || token["peer"] != serde_json::to_value(&self.broker.peer).unwrap()
            || token["manager"] != serde_json::to_value(&self.manager.peer).unwrap()
            || token["requestDigest"] != runtime_wire::digest(bytes)
        {
            return Err(Error("native-service-permit-binding"));
        }
        let r = self
            .records
            .get_mut(nonce)
            .ok_or(Error("native-service-permit-unknown"))?;
        r.budget.check()?;
        if r.state != State::Issued
            || r.digest != runtime_wire::digest(bytes)
            || r.budget.absolute != deadline
        {
            return Err(Error("native-service-permit-used"));
        }
        r.state = State::Forwarded; // Irreversible BEFORE sending work or creating a child.
        let mut grant = token;
        grant["remainingMs"] = r.budget.remaining().into();
        grant["outsideAllJobsRequired"] = self.authority.independent().into();
        Ok(
            json!({"grant":hex(&runtime_wire::sign_receipt(&self.broker,&grant)?),"bytes":hex(bytes),"deadline":deadline}),
        )
    }
    pub(crate) fn prepare(&mut self, attestation: &[u8]) -> Result<Vec<u8>> {
        self.fresh()?;
        let a = runtime_wire::verify_receipt(&self.broker, attestation)?;
        let nonce = a["nonce"]
            .as_str()
            .ok_or(Error("native-service-prepare-invalid"))?;
        let pid = a["starter"]["pid"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= u32::MAX as u64)
            .ok_or(Error("native-service-prepare-invalid"))? as u32;
        let member = RuntimeMember::locate(pid)?;
        self.authority.require_external_member(&member)?;
        // The source handle is signed by native peer code while its exact freshly
        // created child is suspended. Never accept a JS handle or duplicate a Job.
        let source = a["ownedHandle"]
            .as_str()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .ok_or(Error("native-service-owned-handle-unproven"))?;
        let mut raw = std::ptr::null_mut();
        if unsafe {
            windows_sys::Win32::Foundation::DuplicateHandle(
                self.peer_owner.raw(),
                source as _,
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                &mut raw,
                0,
                0,
                windows_sys::Win32::Foundation::DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(Error("native-service-owned-handle-unavailable"));
        }
        let handle = unsafe { crate::handle::Handle::take(raw)? };
        let birth = crate::handle::identity(handle.raw())?;
        if birth != member.identity() {
            return Err(Error("native-service-owned-handle-birth"));
        }
        if member.exited()?
            || a["starter"]["filetime"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                != Some(member.identity().creation_filetime)
            || a["suspended"] != true
            || a["peer"] != serde_json::to_value(&self.broker.peer).unwrap()
        {
            return Err(Error("native-service-prepare-refused"));
        }
        let r = self
            .records
            .get_mut(nonce)
            .ok_or(Error("native-service-permit-unknown"))?;
        r.budget.check()?;
        if r.state != State::Forwarded || a["requestDigest"] != r.digest {
            return Err(Error("native-service-prepare-order"));
        }
        r.outside = self.authority.independent();
        r.owner = Some(crate::Process { handle, birth });
        r.starter = Some(member);
        r.state = State::Prepared;
        runtime_wire::sign_receipt(
            &self.broker,
            &json!({"nonce":nonce,"resume":true,"starter":a["starter"],"remainingMs":r.budget.remaining()}),
        )
    }
    pub(crate) fn resumed(&mut self, attestation: &[u8]) -> Result<()> {
        self.fresh()?;
        let a = runtime_wire::verify_receipt(&self.broker, attestation)?;
        let r = self
            .records
            .get_mut(
                a["nonce"]
                    .as_str()
                    .ok_or(Error("native-service-resume-invalid"))?,
            )
            .ok_or(Error("native-service-permit-unknown"))?;
        r.budget.check()?;
        if r.state != State::Prepared || a["resumed"] != true {
            return Err(Error("native-service-resume-order"));
        }
        r.state = State::Resumed;
        Ok(())
    }
    pub(crate) fn complete(&mut self, attestation: &[u8]) -> Result<Vec<u8>> {
        self.fresh()?;
        let a = runtime_wire::verify_receipt(&self.broker, attestation)?;
        let nonce = a["nonce"]
            .as_str()
            .ok_or(Error("native-service-complete-invalid"))?;
        let r = self
            .records
            .get_mut(nonce)
            .ok_or(Error("native-service-permit-unknown"))?;
        r.budget.check()?;
        let member = r
            .starter
            .as_ref()
            .ok_or(Error("native-service-starter-unknown"))?;
        if r.state != State::Resumed
            || member.exit_code()? != Some(0)
            || a["drained"] != true
            || a["requestDigest"] != r.digest
        {
            return Err(Error("native-service-complete-unconfirmed"));
        }
        r.state = State::Complete;
        let birth = member.identity();
        runtime_wire::sign_receipt(
            &self.manager,
            &json!({"requestDigest":r.digest,"runtimeId":runtime_wire::digest(&runtime_wire::unhex(&self.manager.secret)?),
            "peer":{"pid":self.broker.peer.pid,"filetime":self.broker.peer.creation_filetime},"starter":{"pid":birth.pid,"filetime":birth.creation_filetime.to_string()},
            "outsideAllJobsBeforeResume":r.outside,"policyScope":self.manager.profile,"originalExecutionPreserved":true,
            "nonce":nonce,"generation":self.manager.generation,"source":self.manager.supervisor}),
        )
    }
    pub(crate) fn verify_complete(&self, digest: &str, receipt: &[u8]) -> Result<Value> {
        self.fresh()?;
        let a = runtime_wire::verify_receipt(&self.manager, receipt)?;
        let r = self
            .records
            .get(
                a["nonce"]
                    .as_str()
                    .ok_or(Error("native-service-receipt-invalid"))?,
            )
            .ok_or(Error("native-service-permit-unknown"))?;
        r.budget.check()?;
        if r.state != State::Complete
            || r.digest != digest
            || a["requestDigest"] != digest
            || r.starter.as_ref().unwrap().exit_code()? != Some(0)
        {
            return Err(Error("native-service-receipt-unconfirmed"));
        }
        Ok(a)
    }
    pub(crate) fn cancel(&mut self, nonce: &str) {
        if let Some(r) = self.records.get_mut(nonce) {
            r.state = State::Cancelled;
            if let Some(p) = &r.owner {
                let _ = p.terminate_owned();
            }
        }
    }
    pub(crate) fn request_failure(
        &mut self,
        nonce: &str,
    ) -> Result<crate::service_reply::RequestFailure> {
        self.fresh()?;
        let r = self
            .records
            .get_mut(nonce)
            .ok_or(Error("native-service-permit-unknown"))?;
        // The private peer's static error is not proof. Observe THIS retained
        // creation handle: a live/zero-exit unconfirmed failure remains fatal.
        if r.state == State::Cancelled {
            if let Some(member) = &r.starter {
                if member.exit_code()?.is_none() {
                    return Err(Error("native-service-cancel-unconfirmed"));
                }
            }
            return Ok(crate::service_reply::RequestFailure::Cancelled);
        }
        if !matches!(r.state, State::Resumed | State::Failed)
            || r.starter
                .as_ref()
                .ok_or(Error("native-service-failed-starter-unknown"))?
                .exit_code()?
                .is_none_or(|code| code == 0)
        {
            return Err(Error("native-service-failure-unconfirmed"));
        }
        r.state = State::Failed;
        Ok(crate::service_reply::RequestFailure::Failed)
    }
    #[cfg(feature = "fixtures")]
    pub(crate) fn kill_fixture_peer(&self) -> Result<()> {
        self.peer.revalidate()?;
        crate::Process {
            handle: self.peer_owner.duplicate()?,
            birth: self.peer.identity(),
        }
        .terminate_owned()
    }
    #[cfg(feature = "fixtures")]
    pub(crate) fn running(&self, nonce: &str) -> Result<Option<RuntimeMember>> {
        let r = self
            .records
            .get(nonce)
            .ok_or(Error("native-service-permit-unknown"))?;
        if r.state != State::Resumed {
            return Ok(None);
        }
        let member = RuntimeMember::locate(r.starter.as_ref().unwrap().identity().pid)?;
        if member.identity() != r.starter.as_ref().unwrap().identity() {
            return Err(Error("native-fixture-starter-identity"));
        }
        Ok(Some(member))
    }
    pub(crate) fn expire(&mut self) {
        for r in self.records.values_mut() {
            if r.budget.check().is_err() {
                r.state = State::Cancelled;
                if let Some(p) = &r.owner {
                    let _ = p.terminate_owned();
                }
            }
        }
    }
    pub(crate) fn fence(&mut self) {
        self.closed = true;
        for r in self.records.values_mut() {
            r.state = State::Cancelled;
            if let Some(p) = &r.owner {
                let _ = p.terminate_owned();
            }
        }
    }
}
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_and_overlong_service_budgets_fail_closed() {
        assert!(Budget::new(wire::now().saturating_sub(1)).is_err());
        assert!(Budget::new(wire::now() + 31000).is_err());
    }
    #[test]
    fn monotonic_expiry_cannot_be_extended_by_a_peer_budget() {
        let mut b = Budget::new(wire::now() + 10000).unwrap();
        b.end = Instant::now() - Duration::from_millis(1);
        assert!(b.limit(30000).is_err());
    }
    #[test]
    fn grant_budget_only_narrows_the_original_deadline() {
        let mut b = Budget::new(wire::now() + 10000).unwrap();
        let before = b.end;
        b.limit(30000).unwrap();
        assert_eq!(b.end, before);
        b.limit(100).unwrap();
        assert!(b.end < before);
        assert!(b.limit(0).is_err());
    }
}
