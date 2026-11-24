#[cfg(not(target_os = "linux"))]
use std::path::Path;
#[cfg(not(target_os = "linux"))]
use std::process::Stdio;
use std::{
    collections::{HashMap, HashSet},
    io,
    os::unix::process::CommandExt,
    process::{Child, Command},
};
pub(super) struct Family {
    leader: i32,
    leader_start_id: Option<String>,
    leader_reaped: bool,
    #[cfg(target_os = "linux")]
    include_subreaper_children: bool,
}
impl Family {
    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }
    pub fn adopt(child: &mut Child) -> io::Result<Self> {
        let leader = i32::try_from(child.id())
            .map_err(|_| io::Error::other("Invalid process group leader"))?;
        let leader_start_id = start_id_of(leader);
        Ok(Self {
            leader,
            leader_start_id,
            leader_reaped: false,
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
        Ok(descendants_of(
            self.leader,
            self.leader_start_id.as_deref(),
            self.leader_reaped,
            self.subreaper_enabled(),
        )
        .is_empty())
    }
    pub fn terminate(&self) -> io::Result<()> {
        self.signal(libc::SIGKILL)
    }
    pub fn signal_term(&self) -> io::Result<()> {
        self.signal(libc::SIGTERM)
    }
    fn signal(&self, sig: libc::c_int) -> io::Result<()> {
        let mut first_err = None;
        for (pid, expected_start) in descendants_of(
            self.leader,
            self.leader_start_id.as_deref(),
            self.leader_reaped,
            self.subreaper_enabled(),
        ) {
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
        if error.raw_os_error() == Some(libc::ESRCH) {
            match first_err {
                Some(err) => Err(err),
                None => Ok(()),
            }
        } else {
            Err(error)
        }
    }
}

fn descendants_of(
    root: i32,
    leader_start_id: Option<&str>,
    leader_reaped: bool,
    include_subreaper_children: bool,
) -> Vec<(i32, String)> {
    let self_pid = std::process::id() as i32;
    let rows = process_table();
    let mut by_pid: HashMap<i32, &str> = HashMap::new();
    let mut children_by_parent: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, ppid, _, start_id) in &rows {
        if *pid <= 0 || *pid == self_pid {
            continue;
        }
        by_pid.insert(*pid, start_id.as_str());
        children_by_parent.entry(*ppid).or_default().push(*pid);
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
        for (pid, _, pgid, _) in &rows {
            if *pid > 0 && *pid != self_pid && *pgid == root && *pid != root {
                seeds.push(*pid);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut queue = seeds;
    let mut out = Vec::new();
    while let Some(current) = queue.pop() {
        if !seen.insert(current) {
            continue;
        }
        if current != root && current != self_pid {
            if let Some(start_id) = by_pid.get(&current) {
                out.push((current, (*start_id).to_owned()));
            }
        }
        if let Some(kids) = children_by_parent.get(&current) {
            queue.extend(kids.iter().copied());
        }
    }
    out
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
fn process_table() -> Vec<(i32, i32, i32, String)> {
    let mut rows = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return rows;
    };
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
        let Some(ppid) = fields.get(1).and_then(|v| v.parse::<i32>().ok()) else {
            continue;
        };
        let Some(pgid) = fields.get(2).and_then(|v| v.parse::<i32>().ok()) else {
            continue;
        };
        let Some(start_id) = fields.get(19) else {
            continue;
        };
        rows.push((pid, ppid, pgid, (*start_id).to_owned()));
    }
    rows
}

#[cfg(not(target_os = "linux"))]
fn process_table() -> Vec<(i32, i32, i32, String)> {
    let ps = ["/bin/ps", "/usr/bin/ps"]
        .into_iter()
        .find(|p| Path::new(p).is_file());
    let Some(ps) = ps else {
        return Vec::new();
    };
    let Ok(ps_child) = Command::new(ps)
        .args(["-ax", "-o", "pid=,ppid=,pgid=,lstart="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    let ps_pid = ps_child.id() as i32;
    let Ok(output) = ps_child.wait_with_output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let mut parts = trimmed.splitn(4, char::is_whitespace);
            let pid = parts.next()?.trim().parse::<i32>().ok()?;
            if pid == ps_pid {
                return None;
            }
            let rest = trimmed.strip_prefix(&pid.to_string())?.trim_start();
            let ppid_str = rest.split_whitespace().next()?;
            let ppid = ppid_str.parse::<i32>().ok()?;
            let rest = rest.strip_prefix(ppid_str)?.trim_start();
            let pgid_str = rest.split_whitespace().next()?;
            let pgid = pgid_str.parse::<i32>().ok()?;
            let start_id = rest.strip_prefix(pgid_str)?.trim().to_owned();
            if start_id.is_empty() {
                return None;
            }
            Some((pid, ppid, pgid, start_id))
        })
        .collect()
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
