//! First real production launch channel only. Never a recurring-runtime readiness test.
#![cfg(windows)]

use codenomad_native_host_lifetime::{launch_independent, Command, Error};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::ptr::null_mut;
use std::time::Duration;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::*;

struct Sentinel(Child);
impl Drop for Sentinel {
    fn drop(&mut self) {
        // std::process::Child retains the exact CreateProcess handle; no PID kill.
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
        }
        self.0.wait().unwrap();
    }
}

#[test]
#[ignore = "explicit production first-channel qualification requires a pinned Node and private receipt directory"]
fn recurring_continuity_first_production_spawn_channel() {
    assert!(!cfg!(feature = "fixtures"), "production build required");
    let root = PathBuf::from(std::env::var_os("RECURRING_CONTINUITY_ROOT").unwrap());
    let node = PathBuf::from(std::env::var_os("RECURRING_CONTINUITY_NODE").unwrap());
    assert!(root.is_absolute() && root.is_dir() && node.is_absolute() && node.is_file());
    // Windows Node/OpenSSL requires SystemRoot for its native RNG initialization.
    // Preserve only this platform prerequisite, never profile/credential settings.
    let system_root = std::env::var("SystemRoot").unwrap();
    let mut inside = 0;
    assert_ne!(
        unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut inside) },
        0
    );
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    if inside != 0 {
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
    }

    // Unrelated to the prospective runtime Job. It may still be in the harness
    // Job: that is recorded, never misrepresented as an outside-all-Jobs daemon.
    let mut sentinel = Sentinel(
        std::process::Command::new(&node)
            .args([
                "-e",
                "process.stdout.write('ready\\n');setTimeout(()=>process.exit(0),30000)",
            ])
            .current_dir(&root)
            .env_clear()
            .env("SystemRoot", &system_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::from(
                std::fs::File::create(root.join("sentinel.log")).unwrap(),
            ))
            .spawn()
            .unwrap(),
    );
    let mut ready = String::new();
    BufReader::new(sentinel.0.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready, "ready\n");
    let mut sentinel_in_job = 0;
    assert_ne!(
        unsafe { IsProcessInJob(sentinel.0.as_raw_handle(), null_mut(), &mut sentinel_in_job) },
        0
    );

    let command = Command {
        executable: env!("CARGO_BIN_EXE_codenomad-host-supervisor").into(),
        args: vec![],
        directory: root.clone(),
        environment: vec![("SystemRoot".into(), system_root)],
    };
    // Same first launch/authenticate used by launch_supervisor(), without sending
    // application configuration or pretending later composition was exercised.
    let (outcome, refusal, supervisor) = match launch_independent(&command) {
        Err(error) => {
            if inside != 0
                && limits.BasicLimitInformation.LimitFlags
                    & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
                    == 0
            {
                assert_eq!(error, Error("native-parent-job-forbids-breakaway"));
            }
            ("BLOCKED_NATIVE_FIRST_CHANNEL", Some(error.0), None)
        }
        Ok(child) => {
            let birth = child.process().identity();
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    birth.pid,
                )
            };
            assert!(!raw.is_null());
            let observed = unsafe { OwnedHandle::from_raw_handle(raw) };
            assert_eq!(unsafe { GetProcessId(observed.as_raw_handle()) }, birth.pid);
            let (mut created, mut exited, mut kernel, mut user): (
                FILETIME,
                FILETIME,
                FILETIME,
                FILETIME,
            ) = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe {
                    GetProcessTimes(
                        observed.as_raw_handle(),
                        &mut created,
                        &mut exited,
                        &mut kernel,
                        &mut user,
                    )
                },
                0
            );
            assert_eq!(
                ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                birth.creation_filetime
            );
            let authenticated = child.authenticate(Duration::from_secs(5));
            let refusal = authenticated.as_ref().err().map(|e| e.0);
            let outcome = if authenticated.is_ok() {
                "OPENED_FIRST_CHANNEL_ONLY"
            } else {
                "BLOCKED_NATIVE_FIRST_CHANNEL"
            };
            // No config follows: EOF must shut down this exact supervisor. The
            // native auth-failure path already terminates its exact owned child.
            drop(authenticated);
            assert_eq!(
                unsafe { WaitForSingleObject(observed.as_raw_handle(), 7000) },
                0,
                "exact supervisor teardown unconfirmed"
            );
            (
                outcome,
                refusal,
                Some(
                    json!({"pid":birth.pid,"filetime":birth.creation_filetime.to_string(),"exitConfirmed":true}),
                ),
            )
        }
    };
    assert!(
        sentinel.0.try_wait().unwrap().is_none(),
        "native teardown touched external sentinel"
    );
    let sentinel_pid = sentinel.0.id();
    drop(sentinel);
    std::fs::write(root.join("native-first-channel.json"), serde_json::to_vec_pretty(&json!({
        "outcome":outcome,"refusal":refusal,"parentInJob":inside != 0,
        "parentJobLimitFlags":limits.BasicLimitInformation.LimitFlags,
        "productionFeatures":[],"supervisor":supervisor,
        "externalSentinel":{"pid":sentinel_pid,"inHarnessJob":sentinel_in_job != 0,
                "aliveAfterLaunchProbe":true,"exactOwnedExitConfirmed":true,"isOpenCodeDaemon":false},
        "attempts":1,"weakenedFallback":false,"managerStarted":false,"backendStarted":false,
        "continuityQualified":false,"serviceStarterQualified":false,"packagedParityQualified":false
    })).unwrap()).unwrap();
}
