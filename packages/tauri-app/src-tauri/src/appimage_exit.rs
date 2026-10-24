//! Linux AppImage exit. The AppImage runtime serves its mounted bundle only while
//! this process lives, but WebKit's helper processes, started from that mount, can
//! outlive it briefly: their next page fault in the vanished mount raises SIGBUS
//! and the desktop reports a crash. Just before exiting, terminate the child
//! processes that still run from the mount and wait for them. Other installations,
//! and children running from elsewhere (the shared OpenCode service), are left
//! alone.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const TERMINATE_GRACE: Duration = Duration::from_millis(1500);
const KILL_GRACE: Duration = Duration::from_millis(500);

/// Called from `RunEvent::Exit`, after the backend has stopped and right before the
/// process exits or restarts.
pub(crate) fn stop_mounted_children() {
    if let Some(mount) = appimage_mount() {
        stop_children_under(&mount);
    }
}

fn appimage_mount() -> Option<PathBuf> {
    let appimage = std::env::var_os("APPIMAGE")?;
    let appdir = std::env::var_os("APPDIR")?;
    if appimage.is_empty() || appdir.is_empty() {
        return None;
    }
    std::fs::canonicalize(appdir).ok()
}

fn stop_children_under(mount: &Path) {
    let me = std::process::id() as i32;
    let mut targets: Vec<OwnedFd> = child_pids(me)
        .into_iter()
        .filter_map(|pid| {
            // Signals go through the pidfd, so they reach only the process it pins.
            // Checking parentage and executable once it is open rejects a process
            // that reused the PID after the listing.
            let pidfd = pidfd_open(pid)?;
            (parent_of(pid) == Some(me) && runs_from(pid, mount)).then_some(pidfd)
        })
        .collect();
    for signal in [libc::SIGTERM, libc::SIGKILL] {
        if targets.is_empty() {
            return;
        }
        for pidfd in &targets {
            send_signal(pidfd, signal);
        }
        let grace = if signal == libc::SIGTERM {
            TERMINATE_GRACE
        } else {
            KILL_GRACE
        };
        targets = wait_for_exit(targets, grace);
    }
    if !targets.is_empty() {
        eprintln!(
            "[tauri] {} AppImage helper process(es) still running at exit",
            targets.len()
        );
    }
}

fn child_pids(parent: i32) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter(|&pid| parent_of(pid) == Some(parent))
        .collect()
}

fn parent_of(pid: i32) -> Option<i32> {
    parent_from_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// The parent PID from `/proc/<pid>/stat`, whose command name may hold spaces or
/// parentheses: the fields after its last `)` are the state, then the parent.
fn parent_from_stat(stat: &str) -> Option<i32> {
    stat[stat.rfind(')')? + 1..]
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

fn runs_from(pid: i32, mount: &Path) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|exe| exe.starts_with(mount))
}

fn pidfd_open(pid: i32) -> Option<OwnedFd> {
    // SAFETY: plain syscall; a non-negative result is a new descriptor we own.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

fn send_signal(pidfd: &OwnedFd, signal: i32) {
    // SAFETY: the descriptor stays open for the call; a null siginfo is allowed.
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        );
    }
}

/// Returns the processes still running after `grace`. A pidfd becomes readable when
/// its process exits, including as an unreaped zombie, which runs no more code.
fn wait_for_exit(mut pidfds: Vec<OwnedFd>, grace: Duration) -> Vec<OwnedFd> {
    let deadline = Instant::now() + grace;
    while !pidfds.is_empty() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut polled: Vec<libc::pollfd> = pidfds
            .iter()
            .map(|pidfd| libc::pollfd {
                fd: pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            })
            .collect();
        // SAFETY: `polled` is a live array of `polled.len()` entries.
        let ready = unsafe {
            libc::poll(
                polled.as_mut_ptr(),
                polled.len() as libc::nfds_t,
                remaining.as_millis().max(1) as i32,
            )
        };
        if ready < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            break;
        }
        let exited: Vec<bool> = polled.iter().map(|entry| entry.revents != 0).collect();
        let mut index = 0;
        pidfds.retain(|_| {
            let keep = !exited[index];
            index += 1;
            keep
        });
    }
    pidfds
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command};

    #[test]
    fn parent_survives_command_names_with_spaces_and_parentheses() {
        assert_eq!(
            parent_from_stat("4242 (WebKitWebProces) S 3722 4242 3722 0"),
            Some(3722)
        );
        assert_eq!(parent_from_stat("7 (a) b (c) R 1 7 7 0"), Some(1));
        assert_eq!(parent_from_stat("garbage"), None);
    }

    fn sleeper(program: &Path) -> Child {
        Command::new(program)
            .arg("30")
            .spawn()
            .expect("spawn sleeper")
    }

    fn exited_within(child: &mut Child, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if child.try_wait().expect("child status").is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn only_children_running_from_the_mount_are_stopped() {
        let mount = tempfile::tempdir().expect("mount directory");
        let mounted = mount.path().join("sleep");
        std::fs::copy("/bin/sleep", &mounted).expect("copy sleep into the mount");
        let mount = std::fs::canonicalize(mount.path()).expect("canonical mount");

        let mut inside = sleeper(&mounted);
        let mut outside = sleeper(Path::new("/bin/sleep"));
        assert!(child_pids(std::process::id() as i32).contains(&(inside.id() as i32)));
        stop_children_under(&mount);

        assert!(
            exited_within(&mut inside, Duration::from_secs(2)),
            "helper from the mount must stop"
        );
        assert!(
            outside.try_wait().expect("outside status").is_none(),
            "other children keep running"
        );
        outside.kill().expect("stop outside sleeper");
        outside.wait().expect("reap outside sleeper");
    }
}
