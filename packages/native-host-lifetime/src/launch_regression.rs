//! Native containment regressions only. No independent-owner proof is fabricated;
//! these own-child fixtures retain the execution host's restrictive outer Job.
use crate::handle::{identity, in_job, Handle};
use crate::launch::{spawn_suspended, Child, Suspended};
use crate::owner::Containment;
use crate::{Command, Error, Result};
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::System::Threading::*;

// Instance/thread-local delays: instrumentation, never native admission policy.
pub(crate) struct Pause {
    entered: Sender<()>,
    release: Receiver<()>,
}
impl Pause {
    pub(crate) fn wait(self) {
        let _ = self.entered.send(());
        let _ = self.release.recv_timeout(Duration::from_secs(5));
    }
}
fn pause() -> (Pause, Receiver<()>, Sender<()>) {
    let (entered, observed) = channel();
    let (release, released) = channel();
    (
        Pause {
            entered,
            release: released,
        },
        observed,
        release,
    )
}
thread_local! { static PREPARATION: RefCell<Option<Pause>> = const { RefCell::new(None) }; }
pub(crate) fn before_create() {
    if let Some(pause) = PREPARATION.with(|slot| slot.borrow_mut().take()) {
        pause.wait();
    }
}

struct Fixture {
    root: PathBuf,
    manager: Child,
    owner: Containment,
    backend: Child,
    descendant: Handle,
    external: Child,
}
impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from("C:/Users/Admin/AppData/Local/Temp/opencode")
            .join(format!("native-launch-lock-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let manager = spawn_suspended(&command(&root, IDLE), 0)
            .unwrap()
            .resume()
            .unwrap();
        let owner = Containment::new(manager.process()).unwrap();
        let mut suspended = spawn_suspended(&command(&root, BACKEND), 0).unwrap();
        // The same borrowed proof/resume path used by ManagerSession.
        let result = {
            let mut assigned = owner.assign(manager.process(), &mut suspended).unwrap();
            assigned.resume()
        };
        result.unwrap();
        let mut backend = suspended.into_child().unwrap();
        let pid = u32::from_le_bytes(
            backend
                .read_private(4, Duration::from_secs(5))
                .unwrap()
                .try_into()
                .unwrap(),
        );
        let descendant = unsafe {
            Handle::take(OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            ))
            .unwrap()
        };
        let external = spawn_suspended(&command(&root, IDLE), 0)
            .unwrap()
            .resume()
            .unwrap();
        {
            let shared = owner.lock().unwrap();
            let job = shared.as_ref().unwrap();
            assert!(in_job(descendant.raw(), job.handle.raw()).unwrap());
            assert!(!in_job(external.process().handle.raw(), job.handle.raw()).unwrap());
        }
        Self {
            root,
            manager,
            owner,
            backend,
            descendant,
            external,
        }
    }
    fn late_command(&self) -> Command {
        let marker = self.root.join("late-started");
        command(
            &self.root,
            &format!(
                "require('fs').writeFileSync({:?},'unexpected');{IDLE}",
                marker.to_str().unwrap()
            ),
        )
    }
    fn crash_and_confirm(&self) {
        self.manager.process().terminate_owned().unwrap();
        assert!(
            self.backend.process().wait_exit(500).unwrap(),
            "existing backend waited for slow launch/cleanup"
        );
        assert_eq!(
            unsafe { WaitForSingleObject(self.descendant.raw(), 500) },
            0,
            "detached descendant waited for slow launch/cleanup"
        );
        assert!(
            !self.external.process().exited().unwrap(),
            "external sentinel was touched"
        );
    }
    fn confirm_late_cleanup(&self, late: &Handle, birth: crate::Identity) {
        assert_eq!(identity(late.raw()).unwrap(), birth);
        assert_eq!(
            unsafe { WaitForSingleObject(late.raw(), 5000) },
            0,
            "late native child leaked"
        );
        assert!(
            !self.root.join("late-started").exists(),
            "late child ran before valid admission"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.owner.close();
        let _ = self.manager.process().terminate_owned();
        let _ = self.backend.process().wait_exit(5000);
        let _ = self.external.process().terminate_owned();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
const IDLE: &str = "setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)";
const BACKEND: &str = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});const p=Buffer.alloc(4);p.writeUInt32LE(c.pid);process.stdout.write(p);c.unref();setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)";
fn command(root: &std::path::Path, script: &str) -> Command {
    Command {
        executable: std::env::var_os("CODENOMAD_NATIVE_FIXTURE_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| "C:/Program Files/nodejs/node.exe".into()),
        args: vec!["-e".into(), script.into()],
        directory: root.into(),
        environment: std::env::vars().collect(),
    }
}
fn admit(owner: &Containment, manager: &crate::Process, suspended: &mut Suspended) -> Result<()> {
    let mut assigned = owner.assign(manager, suspended)?;
    assigned.resume()
} // Lock/borrow gone before caller can drop or consume the suspended child.

#[test]
fn manager_death_closes_running_job_during_slow_preparation_and_rejects_late_child() {
    let fixture = Fixture::new();
    let (pause, entered, release) = pause();
    let (late_sent, late_received) = channel();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            PREPARATION.with(|slot| *slot.borrow_mut() = Some(pause));
            let mut suspended = spawn_suspended(&fixture.late_command(), 0).unwrap();
            late_sent
                .send((
                    suspended.process().identity(),
                    suspended.process().handle.duplicate().unwrap(),
                ))
                .unwrap();
            let result = admit(&fixture.owner, fixture.manager.process(), &mut suspended);
            assert!(!suspended.was_resumed());
            drop(suspended); // Native exact-handle cleanup, with no Job loan.
            result
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        fixture.crash_and_confirm(); // Must complete BEFORE releasing preparation.
        release.send(()).unwrap();
        let (birth, late) = late_received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            worker.join().unwrap(),
            Err(Error("native-containment-closed")) | Err(Error("native-manager-not-live"))
        ));
        fixture.confirm_late_cleanup(&late, birth);
    });
}

#[test]
fn resume_failure_releases_job_loan_before_slow_exact_child_cleanup() {
    let fixture = Fixture::new();
    let (pause, entered, release) = pause();
    let (late_sent, late_received) = channel();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            let mut suspended = spawn_suspended(&fixture.late_command(), 0).unwrap();
            late_sent
                .send((
                    suspended.process().identity(),
                    suspended.process().handle.duplicate().unwrap(),
                ))
                .unwrap();
            suspended.fail_resume().unwrap(); // Actual ResumeThread failure on a non-thread handle.
            suspended.cleanup_pause = Some(pause);
            let result = admit(&fixture.owner, fixture.manager.process(), &mut suspended);
            assert!(!suspended.was_resumed());
            drop(suspended); // Deliberately paused BEFORE Terminate/WaitForSingleObject.
            result
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let (birth, late) = late_received.recv_timeout(Duration::from_secs(5)).unwrap();
        fixture.crash_and_confirm(); // Job must close while cleanup is still paused.
        release.send(()).unwrap();
        assert!(matches!(
            worker.join().unwrap(),
            Err(Error("native-resume-unproven"))
        ));
        fixture.confirm_late_cleanup(&late, birth);
    });
}

#[test]
fn preflight_failure_releases_job_loan_before_slow_exact_child_cleanup() {
    let fixture = Fixture::new();
    let (pause, entered, release) = pause();
    let (late_sent, late_received) = channel();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            let mut suspended = spawn_suspended(&fixture.late_command(), 0).unwrap();
            late_sent
                .send((
                    suspended.process().identity(),
                    suspended.process().handle.duplicate().unwrap(),
                ))
                .unwrap();
            // A real exited native child, not a forged PID/FILETIME/proof assertion.
            suspended.process().terminate_owned().unwrap();
            suspended.cleanup_pause = Some(pause);
            let result = admit(&fixture.owner, fixture.manager.process(), &mut suspended);
            assert!(!suspended.was_resumed());
            drop(suspended);
            result
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let (birth, late) = late_received.recv_timeout(Duration::from_secs(5)).unwrap();
        fixture.crash_and_confirm(); // Constructor's error must have released its loan.
        release.send(()).unwrap();
        assert!(matches!(
            worker.join().unwrap(),
            Err(Error("native-backend-not-live"))
        ));
        fixture.confirm_late_cleanup(&late, birth);
    });
}

#[test]
fn closed_and_poisoned_containment_reject_without_resuming_or_retaining_cleanup_loan() {
    let fixture = Fixture::new();
    // Poison via a controlled panic while holding THIS private Job's mutex.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = fixture.owner.lock().unwrap();
        panic!("private fixture poison");
    }));
    let mut suspended = spawn_suspended(&fixture.late_command(), 0).unwrap();
    let birth = suspended.process().identity();
    let late = suspended.process().handle.duplicate().unwrap();
    assert!(matches!(
        admit(&fixture.owner, fixture.manager.process(), &mut suspended),
        Err(Error("native-containment-unknown"))
    ));
    assert!(!suspended.was_resumed());
    fixture.crash_and_confirm(); // Watcher recovers poison only to close the Job.
    drop(suspended);
    fixture.confirm_late_cleanup(&late, birth);
    let mut closed = spawn_suspended(&fixture.late_command(), 0).unwrap();
    assert!(admit(&fixture.owner, fixture.manager.process(), &mut closed).is_err());
    assert!(!closed.was_resumed());
    drop(closed);
}
