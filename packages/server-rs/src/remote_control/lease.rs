//! Single-owner launch lease (`remote-control.owner`) in the private data folder.
//!
//! One backend per data directory resumes Remote Control at launch: OpenTunnel assigns
//! a route to one bridge at a time and a contender retries until it takes over.
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

type AliveCheck = Arc<dyn Fn(u32) -> bool + Send + Sync>;

pub struct OwnerLease {
    file: PathBuf,
    pid: u32,
    is_alive: AliveCheck,
}

impl OwnerLease {
    pub fn new(data: &Path) -> Self {
        Self::with_hooks(data.join("remote-control.owner"), std::process::id(), Arc::new(is_process_alive))
    }

    pub fn with_hooks(file: PathBuf, pid: u32, is_alive: AliveCheck) -> Self {
        Self { file, pid, is_alive }
    }

    /// Takes the lease unless another live backend holds it; stale or corrupt leases are replaced.
    ///
    /// Serialized through an advisory lock beside the lease file and published via a pre-populated
    /// temporary file + hard link so concurrent backends never observe an empty file or unlink
    /// each other's fresh lease.
    pub fn try_acquire(&self) -> bool {
        let Ok(_guard) = self.lock_mutex_file() else {
            return false;
        };
        for _ in 0..2 {
            match self.publish_exclusive() {
                Ok(()) => return true,
                Err(err) if err.kind() != ErrorKind::AlreadyExists => return false,
                Err(_) => {}
            }
            match self.owner() {
                Some(owner) if owner == self.pid => return true,
                Some(owner) if (self.is_alive)(owner) => return false,
                _ => {
                    let _ = fs::remove_file(&self.file);
                }
            }
        }
        false
    }

    /// Releases the lease only if this backend still owns it.
    pub fn release(&self) {
        let Ok(_guard) = self.lock_mutex_file() else {
            return;
        };
        if self.owner() == Some(self.pid) {
            let _ = fs::remove_file(&self.file);
        }
    }

    fn lock_mutex_file(&self) -> std::io::Result<fs::File> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent)?;
        }
        let lock_path = self.file.with_extension("owner.lock");
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock_file = options.open(lock_path)?;
        lock_file.lock()?;
        Ok(lock_file)
    }

    fn publish_exclusive(&self) -> std::io::Result<()> {
        let tmp = self.file.with_extension(format!("owner.{}.{}.tmp", self.pid, uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let write_res = (|| {
            let mut file = options.open(&tmp)?;
            file.write_all(self.pid.to_string().as_bytes())?;
            file.sync_all()?;
            Ok::<(), std::io::Error>(())
        })();
        if let Err(err) = write_res {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
        let link_res = fs::hard_link(&tmp, &self.file);
        let _ = fs::remove_file(&tmp);
        match link_res {
            Ok(()) => Ok(()),
            // Filesystems without hard links fall back to `create_new` under the advisory lock.
            Err(err) if err.kind() == ErrorKind::Unsupported => {
                let mut opts = OpenOptions::new();
                opts.create_new(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                let mut file = opts.open(&self.file)?;
                if let Err(err) = file.write_all(self.pid.to_string().as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&self.file);
                    return Err(err);
                }
                let _ = file.sync_all();
                Ok(())
            }
            Err(err) => Err(err),
        }
    }

    fn owner(&self) -> Option<u32> {
        let raw = fs::read_to_string(&self.file).ok()?;
        let pid = raw.trim().parse::<u32>().ok()?;
        (pid > 0).then_some(pid)
    }
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: `kill(pid, 0)` probes liveness without sending a signal.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ACCESS_DENIED, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    if pid == 0 {
        return false;
    }
    // SAFETY: Win32 handle is checked for null and always closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return std::io::Error::last_os_error().raw_os_error() == Some(ERROR_ACCESS_DENIED as i32);
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn is_process_alive(_pid: u32) -> bool {
    false
}
