//! Actual suspended Win32 starter/stdio owner in the authenticated outside peer.
use crate::handle::{require_outside, Handle};
use crate::native_client::Client;
use crate::runtime_wire;
use crate::service_permit::{hex, Budget, Envelope};
use crate::{Child, Command, Error, Result};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_BROKEN_PIPE};
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
pub(crate) struct Starter {
    child: Child,
    stderr: Handle,
    pub(crate) client: Arc<Client>,
    nonce: String,
    digest: String,
    budget: Budget,
    stdout_eof: bool,
    stderr_eof: bool,
    stdout_bytes: usize,
    stderr_bytes: usize,
    closed: bool,
}
pub(crate) type OwnedStarter = Arc<Mutex<Starter>>;
impl Starter {
    pub(crate) fn prepare(client: Arc<Client>, grant: &[u8], bytes: &[u8]) -> Result<OwnedStarter> {
        client.revalidate()?;
        if client.boot.role != "broker" {
            return Err(Error("native-service-peer-role"));
        }
        let g = runtime_wire::verify_receipt(&client.boot, grant)?;
        let e: Envelope =
            serde_json::from_slice(bytes).map_err(|_| Error("native-service-request-invalid"))?;
        let mut budget = Budget::new(e.deadline)?;
        budget.limit(
            g["remainingMs"]
                .as_u64()
                .ok_or(Error("native-service-budget-invalid"))?,
        )?;
        let digest = runtime_wire::digest(bytes);
        let nonce = g["nonce"]
            .as_str()
            .ok_or(Error("native-service-grant-invalid"))?
            .to_owned();
        if g["requestDigest"] != digest
            || g["profile"] != client.boot.profile
            || g["generation"] != client.boot.generation
            || g["peer"] != serde_json::to_value(&client.boot.peer).unwrap()
            || g["deadline"] != e.deadline
        {
            return Err(Error("native-service-grant-binding"));
        }
        let strict = g["outsideAllJobsRequired"] == true;
        if strict {
            require_outside(unsafe { GetCurrentProcess() })?;
        } else {
            #[cfg(not(feature = "fixtures"))]
            return Err(Error("native-service-independent-proof-required"));
        }
        let policy: crate::ServicePolicy =
            serde_json::from_value(client.boot.application["policy"].clone())
                .map_err(|_| Error("native-service-policy-invalid"))?;
        policy.admit(&e.request)?;
        let command = Command {
            executable: e.request.file.into(),
            args: e.request.args,
            directory: e.request.cwd.into(),
            environment: e.request.env.into_iter().collect(),
        };
        let (mut pending, stderr) =
            crate::launch::spawn_service_suspended(&command, e.request.windows_verbatim_arguments)?;
        if strict {
            require_outside(pending.process().handle.raw())?;
        }
        let birth = pending.process().identity();
        let proof = runtime_wire::sign_receipt(
            &client.boot,
            &json!({"nonce":nonce,"requestDigest":digest,"peer":client.boot.peer,
            "starter":{"pid":birth.pid,"filetime":birth.creation_filetime.to_string()},"suspended":true,
            "ownedHandle":(pending.process().handle.raw() as usize).to_string()}),
        )?;
        let reply = client.rpc(json!({"method":"prepare","bytes":hex(&proof)}))?;
        let accepted = runtime_wire::verify_receipt(
            &client.boot,
            &crate::service_control::decode(&reply["bytes"])?,
        )?;
        if accepted["nonce"] != nonce || accepted["resume"] != true {
            return Err(Error("native-service-resume-refused"));
        }
        budget.limit(
            accepted["remainingMs"]
                .as_u64()
                .ok_or(Error("native-service-budget-invalid"))?,
        )?;
        budget.check()?;
        client.revalidate()?;
        if strict {
            require_outside(pending.process().handle.raw())?;
        }
        pending.resume_thread()?;
        let child = pending.into_child()?;
        let starter = Self {
            child,
            stderr,
            client: client.clone(),
            nonce: nonce.clone(),
            digest,
            budget,
            stdout_eof: false,
            stderr_eof: false,
            stdout_bytes: 0,
            stderr_bytes: 0,
            closed: false,
        };
        let proof =
            runtime_wire::sign_receipt(&client.boot, &json!({"nonce":nonce,"resumed":true}))?;
        client.rpc(json!({"method":"resumed","bytes":hex(&proof)}))?;
        starter.budget.check()?;
        Ok(Arc::new(Mutex::new(starter)))
    }
    pub(crate) fn read(&mut self, stderr: bool) -> Result<Value> {
        self.client.revalidate()?;
        self.budget.check()?;
        let handle = if stderr {
            self.stderr.raw()
        } else {
            self.child.output.raw()
        };
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            if unsafe { GetLastError() } == ERROR_BROKEN_PIPE {
                if stderr {
                    self.stderr_eof = true
                } else {
                    self.stdout_eof = true
                };
                return Ok(json!({"eof":true}));
            }
            return Err(Error("native-service-pipe-failed"));
        }
        if available == 0 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            return Ok(json!({"bytes":""}));
        }
        let mut bytes = vec![0u8; available.min(16384) as usize];
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle,
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                &mut read,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(Error("native-service-pipe-failed"));
        }
        bytes.truncate(read as usize);
        let total = if stderr {
            &mut self.stderr_bytes
        } else {
            &mut self.stdout_bytes
        };
        *total += bytes.len();
        if *total > 65536 {
            self.kill()?;
            return Err(Error("native-service-output-bound"));
        }
        Ok(json!({"bytes":hex(&bytes)}))
    }
    pub(crate) fn status(&self) -> Result<Value> {
        self.budget.check()?;
        if !self.child.process().exited()? {
            return Ok(Value::Null);
        }
        let mut code = 0;
        if unsafe {
            windows_sys::Win32::System::Threading::GetExitCodeProcess(
                self.child.process().handle.raw(),
                &mut code,
            )
        } == 0
        {
            return Err(Error("native-service-exit-unknown"));
        }
        Ok(json!({"exitCode":code,"drained":self.stdout_eof&&self.stderr_eof}))
    }
    pub(crate) fn finish(&self) -> Result<Vec<u8>> {
        self.budget.check()?;
        let status = self.status()?;
        if status["exitCode"] != 0 || status["drained"] != true {
            return Err(Error("native-service-close-unconfirmed"));
        }
        let proof = runtime_wire::sign_receipt(
            &self.client.boot,
            &json!({"nonce":self.nonce,"requestDigest":self.digest,"drained":true}),
        )?;
        let reply = self
            .client
            .rpc(json!({"method":"complete","bytes":hex(&proof)}))?;
        self.budget.check()?;
        crate::service_control::decode(&reply["bytes"])
    }
    pub(crate) fn kill(&mut self) -> Result<()> {
        self.child.process().terminate_owned()?;
        self.closed = true;
        Ok(())
    }
}
impl Drop for Starter {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.child.process().terminate_owned();
        }
    }
}
