//! Per-user supervisor for Windows, started directly by the user's scheduled
//! task. Windows-subsystem executable: no console window, no script host.
//!   cnrs-supervisor <root>
//! Runs the isolated OpenCode daemon on its fixed loopback port and the backend
//! of `releases\<current.txt>`, restarts whichever exits (the backend reconnects
//! to a restarted daemon by itself), serves `run\restart.request` and
//! `run\stop.request`, and stops the backend gracefully (`shutdown` on stdin).
//! Each child runs in a kill-on-close job: when the supervisor ends for any
//! reason (logoff, task stop, crash) nothing it started survives.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("cnrs-supervisor is Windows-only; Linux uses systemd --user units");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    let Some(root) = std::env::args_os().nth(1).map(std::path::PathBuf::from) else {
        std::process::exit(2);
    };
    windows::run(&root);
}

#[cfg(windows)]
mod windows {
    use std::{
        collections::BTreeMap,
        ffi::c_void,
        fs::{self, File, OpenOptions},
        io::Write,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle, process::CommandExt},
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        thread::sleep,
        time::{Duration, Instant, SystemTime},
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit { user_time: i64, job_time: i64, flags: u32, min_ws: usize, max_ws: usize, processes: u32, affinity: usize, priority: u32, scheduling: u32 }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit { basic: BasicLimit, io: [u64; 6], process_memory: usize, job_memory: usize, peak_process: usize, peak_job: usize }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// One kill-on-close job per child, so its whole process tree ends with it.
    struct Job(*mut c_void);
    impl Job {
        fn new() -> Option<Job> {
            // SAFETY: plain Win32 calls with a zero-initialised, correctly sized structure.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let info = ExtendedLimit { basic: BasicLimit { flags: KILL_ON_JOB_CLOSE, ..Default::default() }, ..Default::default() };
                if SetInformationJobObject(job, 9, (&info as *const ExtendedLimit).cast(), size_of::<ExtendedLimit>() as u32) == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }
        fn assign(&self, child: &Child) -> bool {
            // SAFETY: both handles are live for the duration of the call.
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) != 0 }
        }
        fn terminate(&self) {
            // SAFETY: live job handle owned by self.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing our own handle; kill-on-close ends any remaining member.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// E1 recheck before every launch: each item must be owned by this user (or
    /// SYSTEM), never a reparse point, and its DACL may allow only this user,
    /// SYSTEM and OWNER RIGHTS. Anything else refuses the launch.
    mod acl {
        use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path};
        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn GetNamedSecurityInfoW(name: *const u16, kind: u32, info: u32, owner: *mut *mut c_void, group: *mut *mut c_void,
                dacl: *mut *mut c_void, sacl: *mut *mut c_void, descriptor: *mut *mut c_void) -> u32;
            fn GetAce(acl: *const c_void, index: u32, ace: *mut *mut c_void) -> i32;
            fn EqualSid(a: *const c_void, b: *const c_void) -> i32;
            fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
            fn GetTokenInformation(token: *mut c_void, class: u32, info: *mut c_void, length: u32, returned: *mut u32) -> i32;
            fn CreateWellKnownSid(kind: u32, domain: *const c_void, sid: *mut c_void, size: *mut u32) -> i32;
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> *mut c_void;
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
            fn CloseHandle(handle: *mut c_void) -> i32;
            fn GetFileAttributesW(name: *const u16) -> u32;
        }
        pub struct Sids { user: Vec<u8>, system: Vec<u8>, owner_rights: Vec<u8> }
        fn well_known(kind: u32) -> Vec<u8> {
            let mut buffer = vec![0u8; 68];
            let mut size = buffer.len() as u32;
            // SAFETY: buffer sized for any SID (SECURITY_MAX_SID_SIZE).
            unsafe { CreateWellKnownSid(kind, std::ptr::null(), buffer.as_mut_ptr().cast(), &mut size) };
            buffer
        }
        pub fn sids() -> Option<Sids> {
            // SAFETY: token of our own process, TOKEN_QUERY; TokenUser output copied out before CloseHandle.
            unsafe {
                let mut token = std::ptr::null_mut();
                if OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) == 0 {
                    return None;
                }
                let mut buffer = vec![0u8; 256];
                let mut size = 0;
                let ok = GetTokenInformation(token, 1, buffer.as_mut_ptr().cast(), buffer.len() as u32, &mut size);
                CloseHandle(token);
                if ok == 0 {
                    return None;
                }
                let sid = (buffer.as_ptr() as *const *const u8).read_unaligned();
                // SID length: 8 + 4 * SubAuthorityCount (byte 1).
                let user = std::slice::from_raw_parts(sid, 8 + 4 * usize::from(*sid.add(1))).to_vec();
                Some(Sids { user, system: well_known(22), owner_rights: well_known(4) })
            }
        }
        /// `None` when private, else the reason.
        pub fn problem(path: &Path, sids: &Sids) -> Option<String> {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
            // SAFETY: NUL-terminated path; the descriptor is freed with LocalFree; ACE
            // pointers stay inside the descriptor while it lives.
            unsafe {
                let attributes = GetFileAttributesW(wide.as_ptr());
                if attributes == u32::MAX {
                    return Some(format!("{} is missing", path.display()));
                }
                if attributes & 0x400 != 0 {
                    return Some(format!("{} is a reparse point", path.display()));
                }
                let (mut owner, mut dacl, mut descriptor) = (std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
                if GetNamedSecurityInfoW(wide.as_ptr(), 1, 0x1 | 0x4, &mut owner, std::ptr::null_mut(), &mut dacl, std::ptr::null_mut(), &mut descriptor) != 0 {
                    return Some(format!("{} security is unreadable", path.display()));
                }
                let mine = |sid: *const c_void| EqualSid(sid, sids.user.as_ptr().cast()) != 0;
                let system = |sid: *const c_void| EqualSid(sid, sids.system.as_ptr().cast()) != 0;
                let mut result = None;
                if !(mine(owner) || system(owner)) {
                    result = Some(format!("{} has another owner", path.display()));
                } else if dacl.is_null() {
                    result = Some(format!("{} has no DACL", path.display()));
                } else {
                    let count = (dacl as *const u8).add(4).cast::<u16>().read_unaligned();
                    for index in 0..u32::from(count) {
                        let mut ace = std::ptr::null_mut();
                        if GetAce(dacl, index, &mut ace) == 0 {
                            result = Some(format!("{} DACL is unreadable", path.display()));
                            break;
                        }
                        let kind = *(ace as *const u8);
                        if matches!(kind, 1 | 6 | 10) {
                            continue; // deny entries only restrict
                        }
                        let sid = (ace as *const u8).add(8).cast::<c_void>();
                        let owner_rights = EqualSid(sid, sids.owner_rights.as_ptr().cast()) != 0;
                        if kind != 0 || !(mine(sid) || system(sid) || owner_rights) {
                            result = Some(format!("{} allows another account", path.display()));
                            break;
                        }
                    }
                }
                LocalFree(descriptor);
                result
            }
        }
        /// The item and, for a folder, everything below it (links are reported, never followed).
        pub fn tree(path: &Path, sids: &Sids) -> Option<String> {
            if let Some(problem) = problem(path, sids) {
                return Some(problem);
            }
            let meta = std::fs::symlink_metadata(path).ok()?;
            if meta.is_dir() {
                for entry in std::fs::read_dir(path).ok()?.flatten() {
                    if let Some(problem) = tree(&entry.path(), sids) {
                        return Some(problem);
                    }
                }
            }
            None
        }
    }

    struct Running { child: Child, job: Option<Job> }

    struct Layout { root: PathBuf, run: PathBuf, logs: PathBuf, sids: Option<acl::Sids> }
    impl Layout {
        /// Refuses a launch unless the root, `bin`, the executable's folder and the
        /// configuration are private to this user.
        fn private(&self, launched: &Path) -> bool {
            let Some(sids) = &self.sids else {
                self.note("launch refused: the user SID is unreadable");
                return false;
            };
            let folder = launched.parent().unwrap_or(launched);
            let shallow = [self.root.as_path(), &self.root.join("releases"), &self.root.join("opencode"), &self.run];
            let problem = shallow.iter().find_map(|p| acl::problem(p, sids))
                .or_else(|| [self.root.join("bin"), folder.to_path_buf(), self.root.join("config")].iter().find_map(|p| acl::tree(p, sids)));
            if let Some(problem) = problem {
                self.note(&format!("launch refused: {problem}"));
                return false;
            }
            true
        }
        fn note(&self, message: &str) {
            let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs());
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(self.logs.join("supervisor.log")) {
                let _ = writeln!(file, "{stamp} {message}");
            }
        }
        fn env(&self, name: &str) -> BTreeMap<String, String> {
            fs::read_to_string(self.root.join("config").join(name))
                .unwrap_or_default()
                .lines()
                .filter_map(|l| l.split_once('='))
                .filter(|(k, _)| !k.is_empty() && k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'))
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .collect()
        }
        fn pointer(&self, file: &Path) -> Option<String> {
            let value = fs::read_to_string(file).ok()?.trim().to_owned();
            (!value.is_empty() && !value.contains(['\\', '/', ':']) && value != "..").then_some(value)
        }
        fn opencode(&self) -> Option<PathBuf> {
            let dir = self.root.join("opencode");
            Some(dir.join(self.pointer(&dir.join("current.txt"))?).join("opencode.exe"))
        }
        fn pid(&self, name: &str, value: Option<u32>) {
            let file = self.run.join(format!("{name}.pid"));
            match value {
                Some(pid) => {
                    let _ = fs::write(&file, pid.to_string());
                }
                None => {
                    let _ = fs::remove_file(&file);
                }
            }
        }
        fn log(&self, name: &str) -> Option<File> {
            OpenOptions::new().create(true).append(true).open(self.logs.join(name)).ok()
        }

        fn spawn(&self, name: &str, exe: &Path, args: &[String], env: &BTreeMap<String, String>, cwd: &Path, stdin: bool) -> Option<Running> {
            if !self.private(exe) {
                return None;
            }
            let mut command = Command::new(exe);
            command.args(args).envs(env).current_dir(cwd).creation_flags(CREATE_NO_WINDOW)
                .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
                .stdout(self.log(&format!("{name}.out.log")).map_or_else(Stdio::null, Stdio::from))
                .stderr(self.log(&format!("{name}.err.log")).map_or_else(Stdio::null, Stdio::from));
            match command.spawn() {
                Ok(child) => {
                    let job = Job::new().filter(|job| job.assign(&child));
                    if job.is_none() {
                        self.note(&format!("{name}: job assignment failed"));
                    }
                    self.pid(name, Some(child.id()));
                    Some(Running { child, job })
                }
                Err(e) => {
                    self.note(&format!("{name} failed to start: {e}"));
                    None
                }
            }
        }
        fn start_daemon(&self) -> Option<Running> {
            let env = self.env("opencode.env");
            let port = self.env("install.conf").get("DAEMON_PORT").cloned()?;
            let exe = self.opencode()?;
            let home = PathBuf::from(env.get("USERPROFILE")?);
            self.note(&format!("starting daemon on port {port}"));
            let args = ["serve", "--service", "--hostname", "127.0.0.1", "--port", &port].map(String::from);
            self.spawn("daemon", &exe, &args, &env, &home, false)
        }
        fn start_backend(&self) -> Option<Running> {
            let version = self.pointer(&self.root.join("current.txt"))?;
            let exe = self.root.join("releases").join(&version).join("codenomad-rs.exe");
            let mut env = self.env("codenomad-rs.env");
            env.insert("CNRS_FIXTURE_STDIN_STOP".into(), "1".into());
            let port = self.env("install.conf").get("PORT").cloned()?;
            let state = self.root.join("state");
            let args = [state.join("projects").display().to_string(), state.join("host.json").display().to_string(), port,
                self.opencode()?.display().to_string()];
            self.note(&format!("starting backend {version}"));
            self.spawn("rust", &exe, &args, &env, &state, true)
        }
        fn stop_backend(&self, running: &mut Option<Running>) {
            let Some(mut r) = running.take() else { return };
            if let Some(mut stdin) = r.child.stdin.take() {
                let _ = stdin.write_all(b"shutdown\n");
            }
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline && matches!(r.child.try_wait(), Ok(None)) {
                sleep(Duration::from_millis(100));
            }
            if matches!(r.child.try_wait(), Ok(None)) {
                self.note("backend did not stop in 15 s: killed");
                if let Some(job) = &r.job { job.terminate() } else { let _ = r.child.kill(); }
            }
            let _ = r.child.wait();
            self.note("backend stopped");
            self.pid("rust", None);
        }
    }

    fn exited(running: &mut Option<Running>) -> Option<String> {
        match running.as_mut()?.child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => None,
        }
    }

    pub fn run(root: &Path) {
        let run = root.join("run");
        let layout = Layout { root: root.to_owned(), logs: run.join("logs"), run, sids: acl::sids() };
        let _ = fs::create_dir_all(&layout.logs);
        // Single instance: the exclusive lock lives as long as this process.
        let Ok(_lock) = OpenOptions::new().write(true).create(true).truncate(true).share_mode(0).open(layout.run.join("supervisor.lock")) else {
            return;
        };
        layout.pid("supervisor", Some(std::process::id()));
        let (stop, restart) = (layout.run.join("stop.request"), layout.run.join("restart.request"));
        let _ = fs::remove_file(&stop);
        let (mut daemon, mut backend): (Option<Running>, Option<Running>) = (None, None);
        let mut failures = 0u32;
        let mut retry_at = Instant::now();
        while !stop.exists() {
            if daemon.is_none() || exited(&mut daemon).is_some() {
                if let Some(code) = exited(&mut daemon) {
                    layout.note(&format!("daemon exited ({code})"));
                    sleep(Duration::from_secs(1));
                }
                daemon = layout.start_daemon();
            }
            if restart.exists() {
                layout.stop_backend(&mut backend);
                failures = 0;
                retry_at = Instant::now();
            }
            if let Some(code) = exited(&mut backend) {
                failures += 1;
                layout.note(&format!("backend exited ({code}), restart {failures}"));
                backend = None;
                layout.pid("rust", None);
                retry_at = Instant::now() + Duration::from_secs(u64::from((2 * failures).min(30)));
            }
            if backend.is_none() && Instant::now() >= retry_at {
                backend = layout.start_backend();
                if backend.is_none() {
                    failures += 1;
                    retry_at = Instant::now() + Duration::from_secs(2);
                }
                let _ = fs::remove_file(&restart);
            }
            sleep(Duration::from_millis(300));
        }
        layout.stop_backend(&mut backend);
        if let Some(mut d) = daemon.take() {
            if let Some(job) = &d.job { job.terminate() } else { let _ = d.child.kill(); }
            let _ = d.child.wait();
        }
        for name in ["daemon", "supervisor"] {
            layout.pid(name, None);
        }
        let _ = fs::remove_file(&stop);
        layout.note("supervisor stopped");
    }
}
