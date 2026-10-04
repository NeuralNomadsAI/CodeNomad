//! Opt-in executable fixture support. No product config, daemon or global Job edits.
use crate::handle::{identity, in_job, require_outside, Job};
use crate::launch::{spawn_suspended, Child};
use crate::owner::Containment;
use crate::pipe;
use crate::{Command, Error, Identity, ManagerSession, Result};
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use std::time::Duration;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

const MANAGER: &str = r#"
let input=Buffer.alloc(0), proved=false;
const fs=require('fs');
process.stdin.on('data', data=>{
  input=Buffer.concat([input,data]);
  if(!proved && input.length>=64){
    const frame=input.subarray(0,64); input=input.subarray(64);
    if(frame.subarray(0,8).toString()!=='CNHLv001' || frame.readUInt32LE(40)!==process.pid) process.exit(2);
    process.stdout.write(frame); proved=true;
  }
  if(proved && input.length>=4 && input.length>=4+input.readUInt32LE(0)){
    const stop=input.subarray(4,4+input.readUInt32LE(0)).toString(); input=Buffer.alloc(0);
    process.stdout.write(Buffer.from([1]));
    setInterval(()=>{if(fs.existsSync(stop))process.exit(77)},20);
  }
});
setTimeout(()=>process.exit(78),60000);
"#;
const BACKEND: &str = r#"
const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
const report=Buffer.alloc(4); report.writeUInt32LE(child.pid); process.stdout.write(report);
child.unref(); setInterval(()=>{},1000); setTimeout(()=>process.exit(79),60000);
"#;
const EXTERNAL: &str = r#"
let input=Buffer.alloc(0);const fs=require('fs');
process.stdin.on('data',data=>{input=Buffer.concat([input,data]);if(input.length>=4&&input.length>=4+input.readUInt32LE(0)){
const stop=input.subarray(4,4+input.readUInt32LE(0)).toString();input=Buffer.alloc(0);setInterval(()=>{if(fs.existsSync(stop))process.exit(0)},20);
}});setTimeout(()=>process.exit(80),60000);
"#;
const WATCH_MANAGER: &str = r#"
let input=Buffer.alloc(0);const fs=require('fs');
process.stdin.on('data',data=>{input=Buffer.concat([input,data]);if(input.length>=4&&input.length>=4+input.readUInt32LE(0)){
const stop=input.subarray(4,4+input.readUInt32LE(0)).toString();input=Buffer.alloc(0);setInterval(()=>{if(fs.existsSync(stop))process.exit(77)},20);
}});setTimeout(()=>process.exit(81),60000);
"#;

fn stdin() -> windows_sys::Win32::Foundation::HANDLE {
    std::io::stdin().as_raw_handle()
}
fn stdout() -> windows_sys::Win32::Foundation::HANDLE {
    std::io::stdout().as_raw_handle()
}
pub fn packet(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > 4000 {
        return Err(Error("fixture-packet-bound"));
    }
    let mut result = (bytes.len() as u32).to_le_bytes().to_vec();
    result.extend(bytes);
    Ok(result)
}
fn read_packet() -> Result<Vec<u8>> {
    let length = pipe::read_exact(stdin(), 4, Duration::from_secs(5))?;
    let size = u32::from_le_bytes(length.try_into().unwrap()) as usize;
    if size > 4000 {
        return Err(Error("fixture-packet-bound"));
    }
    pipe::read_exact(stdin(), size, Duration::from_secs(5))
}
fn command(executable: PathBuf, args: Vec<String>, directory: PathBuf) -> Command {
    Command {
        executable,
        args,
        directory,
        environment: std::env::vars().collect(),
    }
}
fn configuration(bytes: &[u8]) -> Result<(PathBuf, PathBuf)> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error("fixture-config-invalid"))?;
    let fields: Vec<_> = text.split('\n').collect();
    if fields.len() != 2
        || fields
            .iter()
            .any(|field| field.is_empty() || field.contains('\0'))
    {
        return Err(Error("fixture-config-invalid"));
    }
    Ok((fields[0].into(), fields[1].into()))
}
fn append_identity(report: &mut Vec<u8>, identity: Identity) {
    report.extend(identity.pid.to_le_bytes());
    report.extend(identity.creation_filetime.to_le_bytes());
}

fn supervisor() -> Result<()> {
    let bootstrap = crate::OwnerBootstrap::accept_stdio(Duration::from_secs(5))?;
    let own = identity(unsafe { GetCurrentProcess() })?;
    let (node, root) = configuration(&read_packet()?)?;
    let manager = crate::launch_independent(&command(
        node.clone(),
        vec!["-e".into(), MANAGER.into()],
        root.clone(),
    ))?
    .authenticate(Duration::from_secs(5))?;
    let mut owner = ManagerSession::new(bootstrap, manager)?;
    let manager_stop = root.join("manager.stop");
    owner.write_manager_bootstrap(&packet(
        manager_stop
            .to_str()
            .ok_or(Error("fixture-config-invalid"))?
            .as_bytes(),
    )?)?;
    if owner.read_manager(1, Duration::from_secs(5))? != [1] {
        return Err(Error("fixture-manager-not-ready"));
    }
    let mut backend = owner.spawn_backend(&command(
        node.clone(),
        vec!["-e".into(), BACKEND.into()],
        root.clone(),
    ))?;
    let pid = u32::from_le_bytes(
        backend
            .read_private(4, Duration::from_secs(5))?
            .try_into()
            .unwrap(),
    );
    let descendant = owner.observe_backend_member(pid)?;
    let mut external = owner.spawn_external(&command(
        node,
        vec!["-e".into(), EXTERNAL.into()],
        root.clone(),
    ))?;
    external.write_bootstrap(&packet(
        root.join("external.stop")
            .to_str()
            .ok_or(Error("fixture-config-invalid"))?
            .as_bytes(),
    )?)?;
    require_outside(external.process.handle.raw())?;
    let mut report = Vec::from(*b"CNRPv001");
    for member in [
        own,
        owner.manager().identity(),
        backend.process().identity(),
        descendant,
        external.process().identity(),
    ] {
        append_identity(&mut report, member);
    }
    pipe::write_bootstrap(stdout(), &report)?;
    // UI/parent pipe EOF is NOT manager shutdown. The native manager handle is.
    if !owner.wait_manager_exit(60000)? {
        owner.manager().terminate_owned()?;
        return Err(Error("fixture-manager-deadline"));
    }
    if !backend.process().wait_exit(5000)? {
        return Err(Error("fixture-backend-stop-unconfirmed"));
    }
    Ok(())
}

fn ui_surrogate(allow_breakaway: bool) -> Result<()> {
    let bytes = read_packet()?;
    let (_, root) = configuration(&bytes)?;
    let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | if allow_breakaway {
            JOB_OBJECT_LIMIT_BREAKAWAY_OK
        } else {
            0
        };
    let job = Job::with_limits(flags)?;
    if unsafe { AssignProcessToJobObject(job.handle.raw(), GetCurrentProcess()) } == 0
        || !in_job(unsafe { GetCurrentProcess() }, job.handle.raw())?
    {
        return Err(Error("fixture-ui-job-assignment-failed"));
    }
    let launch = command(
        std::env::current_exe().map_err(|_| Error("fixture-executable-unavailable"))?,
        vec!["supervisor".into()],
        root,
    );
    if !allow_breakaway {
        match crate::launch_independent(&launch) {
            Err(Error("native-parent-job-forbids-breakaway")) => {
                pipe::write_bootstrap(stdout(), b"REFUSED")?
            }
            _ => return Err(Error("fixture-forbidden-breakaway-not-refused")),
        }
    } else {
        let mut manager =
            crate::launch_independent(&launch)?.authenticate(Duration::from_secs(5))?;
        manager.child.write_bootstrap(&packet(&bytes)?)?;
        let report = manager.child.read_private(68, Duration::from_secs(10))?;
        if &report[..8] != b"CNRPv001"
            || u32::from_le_bytes(report[8..12].try_into().unwrap())
                != manager.child.process.birth.pid
            || u64::from_le_bytes(report[12..20].try_into().unwrap())
                != manager.child.process.birth.creation_filetime
        {
            return Err(Error("fixture-supervisor-identity-mismatch"));
        }
        manager.child.process.revalidate()?;
        require_outside(manager.child.process.handle.raw())?;
        pipe::write_bootstrap(stdout(), &report)?;
        // Keep native/private handles through proof; no Job handle is transferred.
        if pipe::read_exact(stdin(), 1, Duration::from_secs(30))? != [b'C'] {
            return Err(Error("fixture-close-intent-invalid"));
        }
    }
    drop(job); // Actual last UI Job handle close kills this surrogate, not supervisor.
    Ok(())
}

/// Test-only launch that retains the execution host's restrictive outer Job.
/// It cannot construct an AuthenticatedManager or qualify independent launch.
pub fn launch_containment_fixture(command: &Command) -> Result<Child> {
    spawn_suspended(command, 0)?.resume()
}
/// Test only: bytes are diagnostic transport data, not AuthenticatedManager/OwnerBootstrap.
pub fn challenge_for_created_child(child: &Child) -> Result<Vec<u8>> {
    crate::launch::challenge_for(child.process())
}

fn job_only() -> Result<()> {
    let (node, root) = configuration(&read_packet()?)?;
    let job = Job::new()?;
    let suspended = spawn_suspended(
        &command(
            node.clone(),
            vec!["-e".into(), BACKEND.into()],
            root.clone(),
        ),
        0,
    )?;
    // Actual nested Job, still suspended. The outer host Job is never changed.
    job.assign(suspended.process())?;
    let mut backend = suspended.resume()?;
    let descendant_pid = u32::from_le_bytes(
        backend
            .read_private(4, Duration::from_secs(5))?
            .try_into()
            .unwrap(),
    );
    let descendant = unsafe {
        crate::handle::Handle::take(windows_sys::Win32::System::Threading::OpenProcess(
            windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            descendant_pid,
        ))?
    };
    if !in_job(descendant.raw(), job.handle.raw())? {
        return Err(Error("fixture-descendant-job-unproven"));
    }
    let mut external = launch_containment_fixture(&command(
        node,
        vec!["-e".into(), EXTERNAL.into()],
        root.clone(),
    ))?;
    external.write_bootstrap(&packet(
        root.join("external.stop")
            .to_str()
            .ok_or(Error("fixture-config-invalid"))?
            .as_bytes(),
    )?)?;
    if in_job(external.process.handle.raw(), job.handle.raw())? {
        return Err(Error("fixture-external-in-backend-job"));
    }
    let mut report = Vec::from(*b"CNRPv001");
    for member in [
        identity(unsafe { GetCurrentProcess() })?,
        backend.process().identity(),
        identity(descendant.raw())?,
        external.process().identity(),
    ] {
        append_identity(&mut report, member);
    }
    pipe::write_bootstrap(stdout(), &report)?;
    // Hold the only Job handle until the test crashes this exact native process.
    // A deadline/parent EOF is also safe: returning drops the Job handle.
    let _ = pipe::read_exact(stdin(), 1, Duration::from_secs(30));
    drop(job);
    Ok(())
}

fn job_watch() -> Result<()> {
    let (node, root) = configuration(&read_packet()?)?;
    let mut manager = launch_containment_fixture(&command(
        node.clone(),
        vec!["-e".into(), WATCH_MANAGER.into()],
        root.clone(),
    ))?;
    manager.write_bootstrap(&packet(
        root.join("manager.stop")
            .to_str()
            .ok_or(Error("fixture-config-invalid"))?
            .as_bytes(),
    )?)?;
    // This exercises native death coupling only, not ManagerSession admission.
    // Both owner and manager deliberately retain the host's restrictive outer Job.
    let owner = Containment::new(manager.process())?;
    let mut suspended = spawn_suspended(
        &command(
            node.clone(),
            vec!["-e".into(), BACKEND.into()],
            root.clone(),
        ),
        0,
    )?;
    let result = {
        let mut assigned = owner.assign(manager.process(), &mut suspended)?;
        assigned.resume()
    };
    result?;
    let mut backend = suspended.into_child()?;
    let pid = u32::from_le_bytes(
        backend
            .read_private(4, Duration::from_secs(5))?
            .try_into()
            .unwrap(),
    );
    let descendant = unsafe {
        crate::handle::Handle::take(windows_sys::Win32::System::Threading::OpenProcess(
            windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        ))?
    };
    let mut external = launch_containment_fixture(&command(
        node,
        vec!["-e".into(), EXTERNAL.into()],
        root.clone(),
    ))?;
    external.write_bootstrap(&packet(
        root.join("external.stop")
            .to_str()
            .ok_or(Error("fixture-config-invalid"))?
            .as_bytes(),
    )?)?;
    {
        let shared = owner.lock()?;
        let job = shared.as_ref().ok_or(Error("fixture-manager-exited"))?;
        if !in_job(descendant.raw(), job.handle.raw())?
            || in_job(external.process.handle.raw(), job.handle.raw())?
        {
            return Err(Error("fixture-job-membership-unproven"));
        }
    }
    let mut report = Vec::from(*b"CNRPv001");
    for member in [
        identity(unsafe { GetCurrentProcess() })?,
        manager.process().identity(),
        backend.process().identity(),
        identity(descendant.raw())?,
        external.process().identity(),
    ] {
        append_identity(&mut report, member);
    }
    pipe::write_bootstrap(stdout(), &report)?;
    if !manager.process().wait_exit(60000)? {
        manager.process().terminate_owned()?;
        return Err(Error("fixture-manager-deadline"));
    }
    // The watch thread, not a manually closed Job or guessed PID, must kill backend.
    if !backend.process().wait_exit(5000)? {
        return Err(Error("fixture-native-death-watch-failed"));
    }
    Ok(())
}

pub fn run(role: &str) -> Result<()> {
    match role {
        "supervisor" => supervisor(),
        "ui-surrogate" => ui_surrogate(true),
        "ui-forbidden" => ui_surrogate(false),
        "job-only" => job_only(),
        "job-watch" => job_watch(),
        "runtime-ipc" => crate::runtime_fixture::run(),
        "supervisor-channel" => crate::channel_fixture::run(),
        "supervisor-service-response" => crate::service_dispatch_fixture::run(),
        "pipe-proof" => {
            let (_, _, frame) = crate::bootstrap::read_frame(stdin(), Duration::from_secs(5))?;
            pipe::write_bootstrap(stdout(), &frame)?;
            let _ = pipe::read_exact(stdin(), 1, Duration::from_secs(5));
            Ok(())
        }
        _ => Err(Error("fixture-role-invalid")),
    }
}
