#[cfg(target_os = "linux")]
use crate::unix_signal::is_proc_exiting_stat;
#[cfg(not(target_os = "linux"))]
use crate::unix_signal::parse_ps_table;
use crate::unix_signal::{ProcessRow, group_signal_error_is_harmless};
#[cfg(not(target_os = "linux"))]
use std::path::Path;
#[cfg(not(target_os = "linux"))]
use std::process::Stdio;
#[cfg(target_os = "macos")]
use std::sync::{
    OnceLock,
    atomic::{AtomicU64, Ordering},
};
#[cfg(target_os = "macos")]
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::{HashMap, HashSet},
    io,
    os::unix::process::CommandExt,
    process::{Child, Command},
    sync::Mutex,
};
#[cfg(target_os = "macos")]
static NEXT_TREE_SEQ: AtomicU64 = AtomicU64::new(1);

pub(super) struct Family {
    leader: i32,
    leader_start_id: Option<String>,
    leader_reaped: bool,
    known_descendants: Mutex<HashMap<i32, String>>,
    #[cfg(target_os = "macos")]
    tree_marker: String,
    #[cfg(target_os = "linux")]
    include_subreaper_children: bool,
}
impl Family {
    pub fn prepare(command: &mut Command) -> Option<(String, String)> {
        command.process_group(0);
        #[cfg(target_os = "macos")]
        {
            let seq = NEXT_TREE_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let key = format!("CODENOMAD_FIXTURE_TREE_{}_{}", std::process::id(), seq);
            let val = format!("{nanos}");
            command.env(&key, &val);
            return Some((key.clone(), format!("{key}={val}")));
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }
    pub fn cleanup_command(command: &mut Command, marker: Option<&(String, String)>) {
        if let Some((key, _)) = marker {
            command.env_remove(key);
        }
    }
    pub fn adopt(child: &mut Child, tree_marker: Option<(String, String)>) -> io::Result<Self> {
        let leader = i32::try_from(child.id())
            .map_err(|_| io::Error::other("Invalid process group leader"))?;
        let leader_start_id = start_id_of(leader);
        #[cfg(not(target_os = "macos"))]
        let _ = tree_marker;
        Ok(Self {
            leader,
            leader_start_id,
            leader_reaped: false,
            known_descendants: Mutex::new(HashMap::new()),
            #[cfg(target_os = "macos")]
            tree_marker: tree_marker.map_or_else(String::new, |(_, entry)| entry),
            #[cfg(target_os = "linux")]
            include_subreaper_children: false,
        })
    }
    pub fn mark_leader_reaped(&mut self) {
        self.leader_reaped = true;
    }
    #[cfg(target_os = "linux")]
    pub fn track_subreaper(&mut self) {
        self.include_subreaper_children = true;
    }
    pub fn sample_descendants(&self) {
        let _ = self.descendants();
    }
    fn descendants(&self) -> Option<Descendants> {
        let mut known = self
            .known_descendants
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(target_os = "macos")]
        let marker = Some(self.tree_marker.as_str()).filter(|value| !value.is_empty());
        #[cfg(not(target_os = "macos"))]
        let marker: Option<&str> = None;
        descendants_of(
            self.leader,
            self.leader_start_id.as_deref(),
            self.leader_reaped,
            self.subreaper_enabled(),
            marker,
            &mut known,
        )
    }
    fn leader_reused(&self) -> bool {
        match (&self.leader_start_id, start_id_of(self.leader)) {
            (Some(expected), Some(actual)) => actual != *expected,
            (None, _) => true,
            (Some(_), None) => false,
        }
    }
    fn subreaper_enabled(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.include_subreaper_children
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }
    pub fn empty(&self) -> io::Result<bool> {
        if !self.leader_reused() {
            // SAFETY: kill with signal zero only queries our spawn's process group.
            let group_empty = if unsafe { libc::kill(-self.leader, 0) } == 0 {
                false
            } else {
                query_error(io::Error::last_os_error())?
            };
            if !group_empty {
                return Ok(false);
            }
        }
        match self.descendants() {
            Some(found) => Ok(found.complete && found.list.is_empty()),
            None => Ok(false),
        }
    }
    pub fn terminate(&self) -> io::Result<()> {
        self.signal(libc::SIGKILL)
    }
    pub fn signal_term(&self) -> io::Result<()> {
        self.signal(libc::SIGTERM)
    }
    fn signal(&self, sig: libc::c_int) -> io::Result<()> {
        let mut first_err = None;
        if let Some(found) = self.descendants() {
            for (pid, expected_start) in found.list {
                if start_id_of(pid).as_deref() != Some(expected_start.as_str()) {
                    continue;
                }
                // SAFETY: pid was enumerated as a descendant of our own spawned process group/root
                // and its OS birth identity was re-verified immediately before signaling.
                if unsafe { libc::kill(pid, sig) } != 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() != Some(libc::ESRCH) && first_err.is_none() {
                        first_err = Some(err);
                    }
                }
            }
        }
        if self.leader_reused() {
            return match first_err {
                Some(err) => Err(err),
                None => Ok(()),
            };
        }
        // SAFETY: the child was created as this group leader before exec, its start identity
        // still matches, and this handle never attaches to any pre-existing process group.
        if unsafe { libc::kill(-self.leader, sig) } == 0 {
            return match first_err {
                Some(err) => Err(err),
                None => Ok(()),
            };
        }
        let error = io::Error::last_os_error();
        let raw = error.raw_os_error();
        if group_signal_error_is_harmless(
            raw == Some(libc::ESRCH),
            raw == Some(libc::EPERM),
            cfg!(not(target_os = "linux")),
            self.leader,
            || self.leader_reused(),
            process_table,
        ) {
            match first_err {
                Some(err) => Err(err),
                None => Ok(()),
            }
        } else {
            Err(error)
        }
    }
}

struct Descendants {
    list: Vec<(i32, String)>,
    complete: bool,
}

fn descendants_of(
    root: i32,
    leader_start_id: Option<&str>,
    leader_reaped: bool,
    include_subreaper_children: bool,
    tree_marker: Option<&str>,
    known_descendants: &mut HashMap<i32, String>,
) -> Option<Descendants> {
    let self_pid = std::process::id() as i32;
    let rows = process_table()?;
    let mut by_pid: HashMap<i32, &str> = HashMap::new();
    let mut children_by_parent: HashMap<i32, Vec<i32>> = HashMap::new();
    for row in &rows {
        if row.pid <= 0 || row.pid == self_pid {
            continue;
        }
        if !row.start_id.is_empty() {
            by_pid.insert(row.pid, row.start_id.as_str());
        }
        children_by_parent
            .entry(row.ppid)
            .or_default()
            .push(row.pid);
    }
    let root_reused = match (leader_start_id, by_pid.get(&root).copied()) {
        (Some(expected), Some(actual)) => actual != expected,
        (None, _) => true,
        (Some(_), None) => false,
    };
    let mut seeds = Vec::new();
    if !leader_reaped && !root_reused {
        seeds.push(root);
    }
    if include_subreaper_children {
        seeds.push(self_pid);
    }
    if !root_reused {
        for row in &rows {
            if row.pid > 0 && row.pid != self_pid && row.pgid == root && row.pid != root {
                seeds.push(row.pid);
            }
        }
    }
    known_descendants
        .retain(|pid, expected_start| by_pid.get(pid).copied() == Some(expected_start.as_str()));
    seeds.extend(known_descendants.keys().copied());
    let mut complete = true;
    #[cfg(target_os = "macos")]
    if let Some(marker) = tree_marker {
        let mut scratch = vec![0u8; macos_argmax()];
        for row in &rows {
            if row.pid > 0
                && row.pid != self_pid
                && row.pid != root
                && !known_descendants.contains_key(&row.pid)
            {
                match process_has_env_entry(row.pid, marker, &mut scratch) {
                    Ok(true) => seeds.push(row.pid),
                    Ok(false) => {}
                    // Record incomplete scan without discarding already-verified descendants.
                    Err(()) => complete = false,
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = tree_marker;
    let mut seen = HashSet::new();
    let mut queue = seeds;
    let mut out = Vec::new();
    while let Some(current) = queue.pop() {
        if !seen.insert(current) {
            continue;
        }
        if current != root && current != self_pid {
            if let Some(start_id) = by_pid.get(&current) {
                let start_owned = (*start_id).to_owned();
                known_descendants.insert(current, start_owned.clone());
                out.push((current, start_owned));
            }
        }
        if let Some(kids) = children_by_parent.get(&current) {
            queue.extend(kids.iter().copied());
        }
    }
    Some(Descendants {
        list: out,
        complete,
    })
}

#[cfg(target_os = "linux")]
fn start_id_of(pid: i32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rparen = stat.rfind(')')?;
    let fields: Vec<&str> = stat[rparen + 1..].split_whitespace().collect();
    fields.get(19).map(|v| (*v).to_owned())
}

#[cfg(not(target_os = "linux"))]
fn start_id_of(pid: i32) -> Option<String> {
    let ps = ["/bin/ps", "/usr/bin/ps"]
        .into_iter()
        .find(|p| Path::new(p).is_file())?;
    let output = Command::new(ps)
        .env("LC_ALL", "C")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "linux")]
fn process_table() -> Option<Vec<ProcessRow>> {
    let mut rows = Vec::new();
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Ok(pid) = name.to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(rparen) = stat.rfind(')') else {
            continue;
        };
        let fields: Vec<&str> = stat[rparen + 1..].split_whitespace().collect();
        let Some(state) = fields.first().copied() else {
            continue;
        };
        let Some(ppid) = fields.get(1).and_then(|v| v.parse::<i32>().ok()) else {
            continue;
        };
        let Some(pgid) = fields.get(2).and_then(|v| v.parse::<i32>().ok()) else {
            continue;
        };
        let Some(start_id) = fields.get(19) else {
            continue;
        };
        rows.push(ProcessRow {
            pid,
            ppid,
            pgid,
            exiting: is_proc_exiting_stat(state),
            start_id: (*start_id).to_owned(),
        });
    }
    Some(rows)
}

#[cfg(not(target_os = "linux"))]
fn process_table() -> Option<Vec<ProcessRow>> {
    let ps = ["/bin/ps", "/usr/bin/ps"]
        .into_iter()
        .find(|p| Path::new(p).is_file())?;
    let ps_child = Command::new(ps)
        .env("LC_ALL", "C")
        .args(["-ax", "-o", "pid=,ppid=,pgid=,stat=,lstart="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let ps_pid = ps_child.id() as i32;
    let output = ps_child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_ps_table(&String::from_utf8_lossy(&output.stdout), ps_pid)
}

#[cfg(target_os = "macos")]
fn macos_argmax() -> usize {
    static ARGMAX: OnceLock<usize> = OnceLock::new();
    *ARGMAX.get_or_init(|| {
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut argmax: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        // SAFETY: querying read-only kernel scalar KERN_ARGMAX into a stack integer.
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                (&mut argmax as *mut libc::c_int).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && argmax > 0 {
            (argmax as usize).clamp(4096, 1024 * 1024)
        } else {
            256 * 1024
        }
    })
}

#[cfg(target_os = "macos")]
fn process_has_env_entry(pid: i32, expected_entry: &str, buf: &mut Vec<u8>) -> Result<bool, ()> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = buf.len();
    // SAFETY: reading KERN_PROCARGS2 for `pid` into our owned reusable buffer of `size` bytes.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        let err = io::Error::last_os_error().raw_os_error();
        // Exited process (ESRCH) or foreign UID/protected process (EACCES/EPERM/EINVAL) cannot be our fixture child.
        if matches!(
            err,
            Some(libc::ESRCH | libc::EACCES | libc::EPERM | libc::EINVAL)
        ) {
            return Ok(false);
        }
        return Err(());
    }
    if size == 0 {
        return Ok(false);
    }
    Ok(crate::procargs::procargs2_has_env_entry(
        &buf[..size.min(buf.len())],
        expected_entry,
    ))
}

fn query_error(error: io::Error) -> io::Result<bool> {
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(true),
        // XNU may retain a group containing only unreaped zombies (killpg1).
        Some(libc::EPERM) => Ok(false),
        _ => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_missing_group_proves_empty() {
        assert!(query_error(io::Error::from_raw_os_error(libc::ESRCH)).unwrap());
        assert!(!query_error(io::Error::from_raw_os_error(libc::EPERM)).unwrap());
        assert_eq!(
            query_error(io::Error::from_raw_os_error(libc::EINVAL))
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EINVAL)
        );
    }
}
