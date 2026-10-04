#![cfg(all(windows, feature = "fixtures"))]

use codenomad_native_host_lifetime::{launch_independent, Command, Identity};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::ptr::null_mut;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::*;

struct Observed {
    handle: OwnedHandle,
}
impl Observed {
    // Query/wait rights only. These handles can never be used for PID-based kills.
    fn capture(expected: Identity) -> Self {
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                expected.pid,
            )
        };
        assert!(!raw.is_null(), "fixture observation handle unavailable");
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let (mut birth, mut exit, mut kernel, mut user): (FILETIME, FILETIME, FILETIME, FILETIME) =
            unsafe { std::mem::zeroed() };
        assert_ne!(
            unsafe {
                GetProcessTimes(
                    handle.as_raw_handle(),
                    &mut birth,
                    &mut exit,
                    &mut kernel,
                    &mut user,
                )
            },
            0
        );
        assert_eq!(
            unsafe { GetProcessId(handle.as_raw_handle()) },
            expected.pid
        );
        assert_eq!(
            ((birth.dwHighDateTime as u64) << 32) | birth.dwLowDateTime as u64,
            expected.creation_filetime
        );
        Self { handle }
    }
    fn in_any_job(&self) -> bool {
        let mut assigned = 0;
        assert_ne!(
            unsafe { IsProcessInJob(self.handle.as_raw_handle(), null_mut(), &mut assigned) },
            0
        );
        assigned != 0
    }
    fn exited(&self, milliseconds: u32) -> bool {
        match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), milliseconds) } {
            0 => true,
            258 => false,
            _ => panic!("fixture observation wait unknown"),
        }
    }
}

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let parent = PathBuf::from("C:/Users/Admin/AppData/Local/Temp/opencode");
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = parent.join(format!(
            "native-host-lifetime-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&root).expect("private fixture directory creation failed");
        Self(root)
    }
    fn stop(&self) {
        let _ = std::fs::write(self.0.join("manager.stop"), b"fixture explicit crash");
        let _ = std::fs::write(self.0.join("external.stop"), b"fixture external stop");
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        self.stop();
        // Every fixture Node process has its own 60-second failsafe. Never inspect
        // shared process trees or terminate processes discovered by PID.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn node() -> PathBuf {
    std::env::var_os("CODENOMAD_NATIVE_FIXTURE_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:/Program Files/nodejs/node.exe"))
}
fn helper(root: &Root, role: &str) -> Command {
    Command {
        executable: env!("CARGO_BIN_EXE_host-lifetime-fixture").into(),
        args: vec![role.into()],
        directory: root.0.clone(),
        environment: std::env::vars().collect(),
    }
}
fn parse_report(report: &[u8]) -> Vec<Identity> {
    assert!(report.len() == 68 || report.len() == 56);
    assert_eq!(&report[..8], b"CNRPv001");
    report[8..]
        .chunks_exact(12)
        .map(|chunk| Identity {
            pid: u32::from_le_bytes(chunk[..4].try_into().unwrap()),
            creation_filetime: u64::from_le_bytes(chunk[4..].try_into().unwrap()),
        })
        .collect()
}

#[test]
fn real_native_job_holder_crash_kills_suspended_assigned_backend_and_detached_descendant() {
    let root = Root::new();
    let mut owner = codenomad_native_host_lifetime::fixture::launch_containment_fixture(&helper(
        &root, "job-only",
    ))
    .unwrap();
    let mut members = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let config = format!("{}\n{}", node().to_str().unwrap(), root.0.to_str().unwrap());
        owner
            .write_bootstrap(
                &codenomad_native_host_lifetime::fixture::packet(config.as_bytes()).unwrap(),
            )
            .unwrap();
        let identities = parse_report(
            &owner
                .read_private(56, Duration::from_secs(10))
                .expect("native containment fixture unavailable"),
        );
        assert_eq!(identities[0], owner.process().identity());
        members = identities.into_iter().map(Observed::capture).collect();
        assert!(members[1].in_any_job());
        assert!(members[2].in_any_job());
        for member in &members {
            assert!(!member.exited(0));
        }
        // Exact handle from our CreateProcess, not a PID found through observation.
        owner.process().terminate_owned().unwrap();
        assert!(
            members[1].exited(5000),
            "backend survived native Job holder crash"
        );
        assert!(
            members[2].exited(5000),
            "detached descendant survived native Job holder crash"
        );
        assert!(
            !members[3].exited(300),
            "private Job cleanup touched external sentinel"
        );
        std::fs::write(root.0.join("external.stop"), b"stop own sentinel").unwrap();
        assert!(members[3].exited(5000));
    }));
    if result.is_err() {
        root.stop();
        let _ = owner.process().terminate_owned();
        for member in &members {
            let _ = member.exited(5000);
        }
        if members.is_empty() {
            std::thread::sleep(Duration::from_secs(5));
        }
    }
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn real_node_manager_crash_closes_backend_job_through_retained_native_handle_watch() {
    let root = Root::new();
    let mut owner = codenomad_native_host_lifetime::fixture::launch_containment_fixture(&helper(
        &root,
        "job-watch",
    ))
    .unwrap();
    let mut members = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let config = format!("{}\n{}", node().to_str().unwrap(), root.0.to_str().unwrap());
        owner
            .write_bootstrap(
                &codenomad_native_host_lifetime::fixture::packet(config.as_bytes()).unwrap(),
            )
            .unwrap();
        let identities = parse_report(
            &owner
                .read_private(68, Duration::from_secs(10))
                .expect("native manager-watch fixture unavailable"),
        );
        assert_eq!(identities[0], owner.process().identity());
        members = identities.into_iter().map(Observed::capture).collect();
        for member in &members {
            assert!(!member.exited(0));
        }
        std::fs::write(root.0.join("manager.stop"), b"crash own manager").unwrap();
        assert!(members[1].exited(5000));
        assert!(
            members[2].exited(5000),
            "backend survived retained-manager-handle death watch"
        );
        assert!(
            members[3].exited(5000),
            "descendant survived retained-manager-handle death watch"
        );
        assert!(owner.process().wait_exit(5000).unwrap());
        assert!(
            !members[4].exited(300),
            "native manager death watch touched external sentinel"
        );
        std::fs::write(root.0.join("external.stop"), b"stop own sentinel").unwrap();
        assert!(members[4].exited(5000));
    }));
    if result.is_err() {
        root.stop();
        let _ = owner.process().terminate_owned();
        for member in &members {
            let _ = member.exited(5000);
        }
        if members.is_empty() {
            std::thread::sleep(Duration::from_secs(5));
        }
    }
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "positive native qualification requires an execution host whose Job permits breakaway"]
fn native_ui_job_close_preserves_manager_and_manager_crash_kills_backend_descendants() {
    assert!(node().is_file(), "fixture Node executable unavailable");
    let root = Root::new();
    let mut ui = launch_independent(&helper(&root, "ui-surrogate"))
        .expect("native fixture UI launch refused");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let config = format!("{}\n{}", node().to_str().unwrap(), root.0.to_str().unwrap());
        ui.write_bootstrap(
            &codenomad_native_host_lifetime::fixture::packet(config.as_bytes()).unwrap(),
        )
        .unwrap();
        let identities = parse_report(
            &ui.read_private(68, Duration::from_secs(20))
                .expect("native fixture proof unavailable"),
        );
        let members: Vec<_> = identities.into_iter().map(Observed::capture).collect();
        let (supervisor, manager, backend, descendant, external) = (
            &members[0],
            &members[1],
            &members[2],
            &members[3],
            &members[4],
        );
        assert!(
            !supervisor.in_any_job(),
            "native owner still belongs to a UI Job"
        );
        assert!(
            !manager.in_any_job(),
            "native Node manager still belongs to a UI Job"
        );
        assert!(backend.in_any_job());
        assert!(descendant.in_any_job());
        assert!(
            !external.in_any_job(),
            "external sentinel inherited backend containment"
        );
        for member in &members {
            assert!(!member.exited(0));
        }
        // The surrogate owns the last UI Job handle. Close, do not kill guessed PIDs.
        ui.write_bootstrap(b"C").unwrap();
        assert!(
            ui.process().wait_exit(5000).unwrap(),
            "UI Job close was not confirmed"
        );
        for member in &members {
            assert!(
                !member.exited(200),
                "UI Job close killed a persistent/private child"
            );
        }
        // Actual Node manager crashes itself in response to its fixture-owned flag.
        std::fs::write(root.0.join("manager.stop"), b"crash").unwrap();
        assert!(manager.exited(5000), "manager crash not observed");
        assert!(backend.exited(5000), "backend survived owner loss");
        assert!(
            descendant.exited(5000),
            "detached descendant survived Job closure"
        );
        assert!(
            supervisor.exited(5000),
            "native owner helper did not finish"
        );
        assert!(
            !external.exited(300),
            "backend cleanup touched external daemon sentinel"
        );
        std::fs::write(root.0.join("external.stop"), b"stop own sentinel").unwrap();
        assert!(external.exited(5000));
    }));
    if result.is_err() {
        root.stop();
        let _ = ui.process().terminate_owned();
        // Leave stop flags available while bounded fixture-only children exit.
        std::thread::sleep(Duration::from_millis(500));
    }
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "surrogate qualification requires escaping the execution host Job first"]
fn native_restrictive_ui_job_fails_closed_without_weakening_limits() {
    let root = Root::new();
    let mut ui = launch_independent(&helper(&root, "ui-forbidden")).unwrap();
    let config = format!("{}\n{}", node().to_str().unwrap(), root.0.to_str().unwrap());
    ui.write_bootstrap(
        &codenomad_native_host_lifetime::fixture::packet(config.as_bytes()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        ui.read_private(7, Duration::from_secs(5)).unwrap(),
        b"REFUSED"
    );
    assert!(ui.process().wait_exit(5000).unwrap());
}

#[test]
#[ignore = "challenge qualification requires an independently launched process"]
fn missing_or_wrong_private_challenge_cannot_create_an_authenticated_manager() {
    let root = Root::new();
    for script in ["process.stdin.once('data',()=>process.stdout.write(Buffer.alloc(64)));setInterval(()=>{},1000)",
        "setInterval(()=>{},1000)"] {
        let command = Command { executable: node(), args: vec!["-e".into(), script.into()], directory: root.0.clone(),
            environment: std::env::vars().collect() };
        let child = launch_independent(&command).unwrap();
        assert!(child.authenticate(Duration::from_millis(300)).is_err());
    }
}

#[test]
fn execution_host_restriction_is_a_native_refusal_not_an_environment_override() {
    let mut inside = 0;
    assert_ne!(
        unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut inside) },
        0
    );
    if inside != 0 {
        use windows_sys::Win32::System::JobObjects::*;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        assert_ne!(
            unsafe {
                QueryInformationJobObject(
                    null_mut(),
                    JobObjectExtendedLimitInformation,
                    &mut limits as *mut _ as _,
                    std::mem::size_of_val(&limits) as u32,
                    null_mut(),
                )
            },
            0
        );
        if limits.BasicLimitInformation.LimitFlags
            & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
            == 0
        {
            let root = Root::new();
            assert!(matches!(
                launch_independent(&helper(&root, "ui-surrogate")),
                Err(codenomad_native_host_lifetime::Error(
                    "native-parent-job-forbids-breakaway"
                ))
            ));
        }
    }
}
