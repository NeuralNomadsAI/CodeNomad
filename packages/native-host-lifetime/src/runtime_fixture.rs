//! Lower-level owned nested-Job proof. Never creates an OwnerBootstrap exemption.
use crate::handle::identity;
use crate::launch::spawn_suspended;
use crate::pipe;
use crate::runtime_core::{PendingRuntime, RuntimeMember};
use crate::{Child, Command, Error, Result};
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use std::time::Duration;

fn read_packet(handle: windows_sys::Win32::Foundation::HANDLE) -> Result<Vec<u8>> {
    let bytes = pipe::read_exact(handle, 4, Duration::from_secs(5))?;
    let size = u32::from_le_bytes(bytes.try_into().unwrap()) as usize;
    if size > 4000 {
        return Err(Error("runtime-fixture-packet-bound"));
    }
    pipe::read_exact(handle, size, Duration::from_secs(5))
}
fn ack(opcode: u8, id: u32, data: &[u8]) -> Vec<u8> {
    let mut payload = vec![opcode | 128];
    payload.extend(id.to_le_bytes());
    payload.extend(data);
    crate::fixture::packet(&payload).unwrap()
}
fn birth_bytes(member: &RuntimeMember) -> Vec<u8> {
    let birth = member.identity();
    let mut bytes = birth.pid.to_le_bytes().to_vec();
    bytes.extend(birth.creation_filetime.to_le_bytes());
    bytes
}
fn command(node: PathBuf, args: Vec<String>, root: PathBuf) -> Command {
    Command {
        executable: node,
        args,
        directory: root,
        environment: std::env::vars()
            .filter(|(key, _)| {
                ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]
                    .iter()
                    .any(|allowed| key.eq_ignore_ascii_case(allowed))
            })
            .collect(),
    }
}
struct External(Child);
impl Drop for External {
    fn drop(&mut self) {
        let _ = self.0.process().terminate_owned();
    }
}

pub(crate) fn run() -> Result<()> {
    let config = read_packet(std::io::stdin().as_raw_handle())?;
    let text = std::str::from_utf8(&config).map_err(|_| Error("runtime-fixture-config"))?;
    let fields: Vec<PathBuf> = text.split('\n').map(PathBuf::from).collect();
    if fields.len() != 4
        || fields
            .iter()
            .enumerate()
            .any(|(i, p)| i != 2 && !p.is_absolute())
        || !fields[2].to_string_lossy().starts_with("file:///")
        || text.contains('\0')
    {
        return Err(Error("runtime-fixture-config"));
    }
    let (node, root, loader, manager_entry) = (&fields[0], &fields[1], &fields[2], &fields[3]);
    let launch = command(
        node.clone(),
        vec![
            "--import".into(),
            loader.to_string_lossy().into(),
            manager_entry.to_string_lossy().into(),
            root.to_string_lossy().into(),
        ],
        root.clone(),
    );
    // Explicit private path: retain outer host Job; no independent-session facade.
    // These are the SAME suspended creation, assignment loan and watcher primitives.
    let mut runtime = PendingRuntime::prepare(&launch)?.resume()?;
    runtime.authenticate(Duration::from_secs(5))?;
    let manager = runtime.observe(runtime.manager().identity().pid)?;
    runtime.write_bootstrap(&crate::fixture::packet(&[0, 0, 0, 0, 0])?)?;
    let mut members: Vec<RuntimeMember> = Vec::new();
    let mut admissions = 0;
    let mut external: Option<External> = None;
    let mut complete = false;
    for expected_id in 1..=16u32 {
        let length = runtime.read(4, Duration::from_secs(10))?;
        let size = u32::from_le_bytes(length.try_into().unwrap()) as usize;
        if !(5..=1024).contains(&size) {
            return Err(Error("runtime-fixture-packet-bound"));
        }
        let packet = runtime.read(size, Duration::from_secs(5))?;
        let opcode = packet[0];
        let id = u32::from_le_bytes(packet[1..5].try_into().unwrap());
        if id != expected_id {
            return Err(Error("runtime-fixture-correlation"));
        }
        let payload = &packet[5..];
        let data = match opcode {
            1 | 2 if payload.len() == 4 => {
                let pid = u32::from_le_bytes(payload.try_into().unwrap());
                let member = runtime.observe(pid)?; // NO AssignProcessToJobObject for B/D.
                if pid == manager.identity().pid
                    || members.iter().any(|m| m.identity() == member.identity())
                {
                    return Err(Error("runtime-fixture-member-reused"));
                }
                if opcode == 1 {
                    admissions += 1;
                } else if admissions != 4 {
                    return Err(Error("runtime-fixture-descendant-order"));
                }
                let bytes = birth_bytes(&member);
                members.push(member);
                bytes
            }
            3 if payload.is_empty() && external.is_none() && members.len() == 5 => {
                // Sole allowed fixture service operation. Config/argv not taken from M.
                // Real official service execution remains coordinator-owned integration.
                let child = spawn_suspended(&command(node.clone(), vec!["-e".into(),
                    "process.stdout.write('S');setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)".into()], root.clone()), 0)?.resume()?;
                let mut child = External(child);
                if child.0.read_private(1, Duration::from_secs(5))? != b"S" {
                    return Err(Error("runtime-fixture-external-ready"));
                }
                if !matches!(
                    runtime.observe(child.0.process().identity().pid),
                    Err(Error("native-runtime-member-not-contained"))
                ) {
                    return Err(Error("runtime-fixture-external-wrong-job"));
                }
                external = Some(child);
                vec![]
            }
            4 if payload.is_empty()
                && admissions == 4
                && members.len() == 5
                && external.is_some() =>
            {
                // B+D still live when M reports protocol completion. No cleanup receipt yet.
                if members[3].wait_exit(0)? || members[4].wait_exit(0)? {
                    return Err(Error("runtime-fixture-survivor-not-live"));
                }
                complete = true;
                vec![]
            }
            _ => return Err(Error("runtime-fixture-operation-refused")),
        };
        runtime.write_bootstrap(&ack(opcode, id, &data))?;
        if complete {
            break;
        }
    }
    if !complete || !manager.wait_exit(5000)? {
        return Err(Error("runtime-fixture-manager-death-unconfirmed"));
    }
    // Keep RuntimeCore alive: ONLY its exact-manager native watcher closes Job here.
    for member in &members {
        if !member.wait_exit(5000)? {
            return Err(Error("runtime-fixture-descendant-survived-manager"));
        }
    }
    let external = external.ok_or(Error("runtime-fixture-external-missing"))?;
    external.0.process().revalidate()?;
    if external.0.process().exited()? {
        return Err(Error("runtime-fixture-external-killed"));
    }
    if !matches!(
        runtime.revalidate(),
        Err(Error("native-runtime-manager-not-live"))
    ) {
        return Err(Error("runtime-fixture-late-admission-not-refused"));
    }
    // Native retained query handle identities stay exact across exit (no PID reuse kill).
    let _birth = identity(runtime.manager().handle.raw())?;
    external.0.process().terminate_owned()?; // Exact owned sentinel, never a tree/group.
    pipe::write_bootstrap(std::io::stdout().as_raw_handle(), br#"{"runtimeInheritedJob":true,"managerAssignedBeforeResume":true,"nativeMembershipBeforeReadiness":4,"realNodeIpcProtocol":true,"privateManagerChallenge":true,"managerDeathKilledBackendAndDetachedChild":true,"externalSentinelSurvived":true,"wrongJobRejected":true,"lateAdmissionRefused":true,"independentLaunchQualified":false,"serviceOperation":"fixed-node-sentinel-only"}"#)?;
    Ok(())
}
