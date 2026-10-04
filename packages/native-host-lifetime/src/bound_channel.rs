use crate::channel_wire::{self as wire, Birth, ChannelBootstrap, Hello};
use crate::handle::{identity, Handle};
use crate::named_channel::NamedChannel;
use crate::{Error, Process, Result};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub(crate) struct BoundChannel {
    pub(crate) pipe: NamedChannel,
    pub(crate) boot: ChannelBootstrap,
    peer: Process,
    supervisor: Process,
}
impl BoundChannel {
    pub(crate) fn new(
        peer: &Process,
        role: &str,
        profile: &str,
        generation: &str,
        application: Value,
    ) -> Result<Self> {
        let mut own = std::ptr::null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                GetCurrentProcess(),
                GetCurrentProcess(),
                &mut own,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(Error("native-channel-owner-handle-unavailable"));
        }
        let own = unsafe { Handle::take(own)? };
        let supervisor = Process {
            birth: identity(own.raw())?,
            handle: own,
        };
        let peer = Process {
            birth: peer.identity(),
            handle: peer.handle.duplicate()?,
        };
        let pipe = NamedChannel::new()?;
        let boot = ChannelBootstrap {
            v: 1,
            profile: profile.into(),
            generation: generation.into(),
            role: role.into(),
            pipe: pipe.name.clone(),
            secret: wire::random_hex()?,
            receipt_secret: wire::random_hex()?,
            control_pipe: String::new(),
            supervisor: supervisor.identity().into(),
            peer: peer.identity().into(),
            application,
        };
        Ok(Self {
            pipe,
            boot,
            peer,
            supervisor,
        })
    }
    pub(crate) fn bootstrap_bytes(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(&self.boot)
            .map_err(|_| Error("native-channel-bootstrap-invalid"))?;
        if bytes.len() > 4000 {
            return Err(Error("native-channel-bootstrap-bound"));
        }
        let mut framed = (bytes.len() as u32).to_le_bytes().to_vec();
        framed.extend(bytes);
        Ok(framed)
    }
    pub(crate) fn publish_child(&self, child: &mut crate::Child) -> Result<()> {
        child.write_bootstrap(&self.bootstrap_bytes()?)
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        self.supervisor.revalidate()?;
        self.peer.revalidate()?;
        if self.peer.exited()? || self.pipe.client_pid()? != self.peer.identity().pid {
            return Err(Error("native-channel-peer-lost"));
        }
        Ok(())
    }
    pub(crate) fn authenticate(&mut self) -> Result<()> {
        self.authenticate_receipt(|_| Ok(vec![]))
    }
    pub(crate) fn authenticate_receipt(
        &mut self,
        receipt: impl Fn(&str) -> Result<Vec<u8>>,
    ) -> Result<()> {
        let end = Instant::now() + Duration::from_secs(5);
        for _ in 0..8 {
            self.pipe
                .connect(end.saturating_duration_since(Instant::now()))?;
            self.peer.revalidate()?;
            self.supervisor.revalidate()?;
            // A locator is public. Reject another actual process BEFORE reading any proof.
            if self.pipe.client_pid()? != self.peer.identity().pid {
                self.pipe.disconnect();
                continue;
            }
            let value = loop {
                if Instant::now() >= end {
                    return Err(Error("native-channel-auth-deadline"));
                }
                if let Some(v) = self.pipe.read(Duration::from_millis(50))? {
                    break v;
                }
            };
            let hello: Hello =
                serde_json::from_value(value).map_err(|_| Error("native-channel-auth-invalid"))?;
            if hello.v != 1
                || hello.profile != self.boot.profile
                || hello.generation != self.boot.generation
                || hello.role != self.boot.role
                || hello.peer != Birth::from(self.peer.identity())
                || !wire::is_hex(&hello.challenge)
                || !wire::equal(
                    &hello.proof,
                    &wire::mac(&self.boot, &hello.challenge, "client"),
                )
            {
                return Err(Error("native-channel-auth-refused"));
            }
            self.revalidate()?;
            self.pipe.write(&json!({"v":1,"hello":true,"profile":self.boot.profile,"generation":self.boot.generation,
                "role":self.boot.role,"peer":self.boot.peer,"supervisor":self.boot.supervisor,
                "challenge":hello.challenge,"proof":wire::mac(&self.boot,&hello.challenge,"server"),
                "attestation":receipt(&hello.challenge)?.iter().map(|b|format!("{b:02x}")).collect::<String>()}), Duration::from_secs(5))?;
            return Ok(());
        }
        Err(Error("native-channel-spoof-budget"))
    }
}
