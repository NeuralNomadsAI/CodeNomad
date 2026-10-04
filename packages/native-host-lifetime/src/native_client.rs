//! Addon-side retained source/session. Never accepts a native handle from JavaScript.
use crate::channel_wire::{self as wire, ChannelBootstrap};
use crate::handle::in_job;
use crate::named_channel::NamedChannel;
use crate::runtime_wire;
use crate::{Error, Result, RuntimeMember};
use serde_json::{json, Value};
use std::os::windows::io::AsRawHandle;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
#[cfg(feature = "fixtures")]
#[path = "service_client_fixture.rs"]
mod response_fixture;

pub(crate) struct Client {
    pub(crate) boot: ChannelBootstrap,
    pub(crate) channel: Mutex<NamedChannel>,
    source: RuntimeMember,
    manager: RuntimeMember,
    pub(crate) launch: Vec<u8>,
    pub(crate) control: Mutex<crate::service_control::ControlClient>,
    permits: Mutex<std::collections::HashMap<String, (String, crate::service_permit::Budget)>>,
    live: AtomicBool,
}
impl Client {
    pub(crate) fn open(challenge: &[u8]) -> Result<(Self, Vec<u8>)> {
        Self::open_role(challenge, "manager")
    }
    pub(crate) fn open_role(challenge: &[u8], role: &str) -> Result<(Self, Vec<u8>)> {
        if challenge.len() != 32 {
            return Err(Error("native-sdk-challenge-bound"));
        }
        let input = std::io::stdin().as_raw_handle();
        let output = std::io::stdout().as_raw_handle();
        crate::security::verify_private_pipe(input, true)?;
        crate::security::verify_private_pipe(output, true)?;
        // Native bootstrap pipes are inherited only via the S handle allowlist.
        // The installed entry must not let JS consume stdin before this call.
        let frame = crate::pipe::read_exact(input, 64, Duration::from_secs(5))?;
        if frame[..8] != *b"CNHLv001" {
            return Err(Error("native-sdk-bootstrap-magic"));
        }
        let manager = RuntimeMember::locate(std::process::id())?;
        if u32::from_le_bytes(frame[40..44].try_into().unwrap()) != manager.identity().pid
            || u64::from_le_bytes(frame[44..52].try_into().unwrap())
                != manager.identity().creation_filetime
            || (role == "manager" && !in_job(manager.raw(), std::ptr::null_mut())?)
        {
            return Err(Error("native-sdk-bootstrap-member"));
        }
        let source = RuntimeMember::locate(u32::from_le_bytes(frame[52..56].try_into().unwrap()))?;
        if source.identity().creation_filetime
            != u64::from_le_bytes(frame[56..64].try_into().unwrap())
        {
            return Err(Error("native-sdk-bootstrap-source"));
        }
        let mut creator = 0;
        if unsafe {
            windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId(input, &mut creator)
        } == 0
            || creator != source.identity().pid
        {
            return Err(Error("native-sdk-bootstrap-creator"));
        }
        crate::pipe::write_bootstrap(output, &frame)?;
        let size = u32::from_le_bytes(
            crate::pipe::read_exact(input, 4, Duration::from_secs(5))?
                .try_into()
                .unwrap(),
        ) as usize;
        if size == 0 || size > 4000 {
            return Err(Error("native-sdk-bootstrap-bound"));
        }
        let boot: ChannelBootstrap = serde_json::from_slice(&crate::pipe::read_exact(
            input,
            size,
            Duration::from_secs(5),
        )?)
        .map_err(|_| Error("native-sdk-bootstrap-invalid"))?;
        if boot.v != 1
            || boot.role != role
            || !wire::is_hex(&boot.profile)
            || !wire::is_hex(&boot.secret)
            || !wire::is_hex(&boot.receipt_secret)
            || boot.peer != manager.identity().into()
            || boot.supervisor != source.identity().into()
        {
            return Err(Error("native-sdk-bootstrap-identity"));
        }
        runtime_wire::identity(&boot)?;
        let mut channel = NamedChannel::open(&boot.pipe)?;
        if channel.server_pid()? != source.identity().pid {
            return Err(Error("native-sdk-channel-source"));
        }
        let nonce = challenge
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        channel.write(
            &json!({"v":1,"profile":boot.profile,"generation":boot.generation,"role":boot.role,
            "peer":boot.peer,"challenge":nonce,"proof":wire::mac(&boot,&nonce,"client")}),
            Duration::from_secs(5),
        )?;
        let end = Instant::now() + Duration::from_secs(5);
        let hello = loop {
            if Instant::now() >= end {
                return Err(Error("native-sdk-auth-deadline"));
            }
            if let Some(value) = channel.read(Duration::from_millis(20))? {
                break value;
            }
        };
        if hello["challenge"] != nonce
            || hello["hello"] != true
            || !hello["proof"]
                .as_str()
                .is_some_and(|s| wire::equal(s, &wire::mac(&boot, &nonce, "server")))
        {
            return Err(Error("native-sdk-auth-refused"));
        }
        // Sequence 1 belongs to RuntimeTransport. Setup receipt is supplied in
        // authenticated hello, not by consuming the product transport sequence.
        let receipt = hello["attestation"]
            .as_str()
            .ok_or(Error("native-sdk-receipt-missing"))?;
        let receipt = runtime_wire::unhex(receipt)?;
        let launch = serde_json::to_vec(&boot.application)
            .map_err(|_| Error("native-sdk-launch-invalid"))?;
        let control = crate::service_control::ControlClient::open(&boot)?;
        let client = Self {
            boot,
            channel: Mutex::new(channel),
            source,
            manager,
            launch,
            live: AtomicBool::new(true),
            control: Mutex::new(control),
            permits: Mutex::new(std::collections::HashMap::new()),
        };
        client.revalidate()?;
        Ok((client, receipt))
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        if !self.live.load(Ordering::Acquire) {
            return Err(Error("native-sdk-session-released"));
        }
        self.source.revalidate()?;
        self.manager.revalidate()?;
        if self.source.exited()? || self.manager.exited()? {
            return Err(Error("native-sdk-owner-dead"));
        }
        let channel = self
            .channel
            .lock()
            .map_err(|_| Error("native-sdk-channel-poisoned"))?;
        if channel.server_pid()? != self.source.identity().pid {
            return Err(Error("native-sdk-source-replaced"));
        }
        Ok(())
    }
    pub(crate) fn verify(
        &self,
        nonce: &[u8],
        digest: Option<&str>,
        receipt: &[u8],
        pid: u32,
    ) -> Result<Value> {
        self.revalidate()?;
        if nonce.len() != 32 {
            return Err(Error("native-sdk-challenge-bound"));
        }
        let value = runtime_wire::verify_receipt(&self.boot, receipt)?;
        let nonce = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
        if value["nonce"] != nonce
            || value["runtimeId"] != runtime_wire::digest(&runtime_wire::unhex(&self.boot.secret)?)
            || value["source"]["pid"] != self.source.identity().pid
            || value["source"]["filetime"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                != Some(self.source.identity().creation_filetime)
            || value["launchDigest"] != runtime_wire::digest(&self.launch)
        {
            return Err(Error("native-sdk-receipt-binding"));
        }
        let candidate = RuntimeMember::locate(pid)?;
        candidate.revalidate()?;
        if candidate.exited()? {
            return Err(Error("native-sdk-member-dead"));
        }
        let birth = if digest.is_some() {
            &value["manager"]
        } else {
            &value["member"]
        };
        if birth["pid"] != candidate.identity().pid
            || birth["filetime"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                != Some(candidate.identity().creation_filetime)
            || !in_job(candidate.raw(), std::ptr::null_mut())?
        {
            return Err(Error("native-sdk-member-birth"));
        }
        if let Some(digest) = digest {
            if pid != self.manager.identity().pid
                || digest != runtime_wire::digest(&self.launch)
                || value["generation"] != self.boot.generation
                || value["scope"]["key"] != self.boot.profile
            {
                return Err(Error("native-sdk-manager-binding"));
            }
            // An unqualified nested fixture may return accurate false facts. It
            // can NEVER invent the concrete native outside service-peer proof.
            if value["supervisorOutsideAllJobs"] == true
                && in_job(self.source.raw(), std::ptr::null_mut())?
            {
                return Err(Error("native-sdk-supervisor-contained"));
            }
            if value["supervisorOutsideAllJobs"] != true
                || value["ownerBootstrapVerified"] != true
                || value["servicePeer"].is_null()
            {
                return Err(Error("native-sdk-manager-conjunction-unqualified"));
            }
            let peer = RuntimeMember::locate(
                value["servicePeer"]["pid"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= u32::MAX as u64)
                    .ok_or(Error("native-service-peer-unknown"))? as u32,
            )?;
            if peer.exited()?
                || value["servicePeer"]["filetime"]
                    .as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    != Some(peer.identity().creation_filetime)
                || in_job(peer.raw(), std::ptr::null_mut())?
            {
                return Err(Error("native-service-peer-unqualified"));
            }
        } else if value["alive"] != true || value["inherited"] != true {
            return Err(Error("native-sdk-member-unqualified"));
        }
        self.revalidate()?;
        Ok(value)
    }
    pub(crate) fn release(&self) {
        self.live.store(false, Ordering::Release);
    }
    pub(crate) fn rpc(&self, value: Value) -> Result<Value> {
        self.revalidate()?;
        self.control
            .lock()
            .map_err(|_| Error("native-control-poisoned"))?
            .call(value)
    }
    pub(crate) fn authorize(&self, bytes: &[u8], deadline: u64) -> Result<Vec<u8>> {
        self.revalidate()?;
        if self.boot.role != "manager" || in_job(self.source.raw(), std::ptr::null_mut())? {
            return Err(Error("native-service-supervisor-unqualified"));
        }
        self.issue_permit(bytes, deadline)
    }
    fn issue_permit(&self, bytes: &[u8], deadline: u64) -> Result<Vec<u8>> {
        let budget = crate::service_permit::Budget::new(deadline)?;
        let reply=self.rpc(json!({"method":"permit","bytes":crate::service_permit::hex(bytes),"deadline":deadline}))?;
        budget.check()?;
        let permit = crate::service_control::decode(&reply["bytes"])?;
        let proof = runtime_wire::verify_receipt(&self.boot, &permit)?;
        let nonce = proof["nonce"]
            .as_str()
            .ok_or(Error("native-service-permit-invalid"))?
            .to_owned();
        let mut pending = self
            .permits
            .lock()
            .map_err(|_| Error("native-service-permits-poisoned"))?;
        pending.retain(|_, (_, b)| b.check().is_ok());
        if pending.len() >= 16 {
            return Err(Error("native-service-permit-capacity"));
        }
        pending.insert(nonce, (runtime_wire::digest(bytes), budget));
        Ok(permit)
    }
    pub(crate) fn verify_service(&self, digest: &str, receipt: &[u8]) -> Result<Value> {
        self.revalidate()?;
        if self.boot.role != "manager" || !crate::channel_wire::is_hex(digest) {
            return Err(Error("native-service-verifier-role"));
        }
        let proof = runtime_wire::verify_receipt(&self.boot, receipt)?;
        let nonce = proof["nonce"]
            .as_str()
            .ok_or(Error("native-service-receipt-invalid"))?;
        let (original, budget) = self
            .permits
            .lock()
            .map_err(|_| Error("native-service-permits-poisoned"))?
            .remove(nonce)
            .ok_or(Error("native-service-receipt-unissued-or-used"))?;
        budget.check()?;
        if original != digest {
            return Err(Error("native-service-receipt-digest"));
        }
        let value = self.rpc(
            json!({"method":"verify","digest":digest,"bytes":crate::service_permit::hex(receipt)}),
        )?;
        if let Some(code) = value["error"].as_str() {
            if !["native-service-failed", "native-service-cancelled"].contains(&code) {
                return Err(Error("native-service-error-code"));
            }
            self.revalidate()?;
            budget.check()?;
            return Err(Error("native-service-start-failed"));
        }
        if value["outsideAllJobsBeforeResume"] != true
            || in_job(self.source.raw(), std::ptr::null_mut())?
        {
            return Err(Error("native-service-starter-unqualified"));
        }
        self.revalidate()?;
        budget.check()?;
        Ok(value)
    }
    pub(crate) fn read(&self) -> Result<Vec<u8>> {
        self.revalidate()?;
        self.channel
            .lock()
            .map_err(|_| Error("native-sdk-channel-poisoned"))?
            .read_bytes(Duration::from_millis(20))
    }
    pub(crate) fn write(&self, data: &[u8]) -> Result<()> {
        self.revalidate()?;
        self.channel
            .lock()
            .map_err(|_| Error("native-sdk-channel-poisoned"))?
            .write_bytes(data, Duration::from_secs(5))
    }
}
