use std::{
    collections::{HashMap, HashSet},
    io,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command},
};
pub(super) struct Family {
    leader: i32,
}
impl Family {
    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }
    pub fn adopt(child: &mut Child) -> io::Result<Self> {
        let leader = i32::try_from(child.id())
            .map_err(|_| io::Error::other("Invalid process group leader"))?;
        Ok(Self { leader })
    }
    pub fn empty(&self) -> io::Result<bool> {
        // SAFETY: kill with signal zero only queries our spawn's process group.
        let group_empty = if unsafe { libc::kill(-self.leader, 0) } == 0 {
            false
        } else {
            query_error(io::Error::last_os_error())?
        };
        if !group_empty {
            return Ok(false);
        }
        Ok(descendants_of(self.leader).is_empty())
    }
    pub fn terminate(&self) -> io::Result<()> {
        self.signal(libc::SIGKILL)
    }
    pub fn signal_term(&self) -> io::Result<()> {
        self.signal(libc::SIGTERM)
    }
    fn signal(&self, sig: libc::c_int) -> io::Result<()> {
        let mut first_err = None;
        for pid in descendants_of(self.leader) {
            // SAFETY: pid was enumerated as a descendant of our own spawned process group/root.
            if unsafe { libc::kill(pid, sig) } != 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::ESRCH) && first_err.is_none() {
                    first_err = Some(err);
                }
            }
        }
        // SAFETY: the child was created as this group leader before exec, and
        // this handle never attaches to any pre-existing process group.
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

fn descendants_of(root: i32) -> Vec<i32> {
    let self_pid = std::process::id() as i32;
    let rows = process_table();
    let mut children_by_parent: HashMap<i32, Vec<i32>> = HashMap::new();
    let mut seeds = vec![root];
    for &(pid, ppid, pgid) in &rows {
        if pid <= 0 || pid == self_pid {
            continue;
        }
        children_by_parent.entry(ppid).or_default().push(pid);
        if pgid == root && pid != root {
            seeds.push(pid);
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
            out.push(current);
        }
        if let Some(kids) = children_by_parent.get(&current) {
            queue.extend(kids.iter().copied());
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn process_table() -> Vec<(i32, i32, i32)> {
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
        let mut fields = stat[rparen + 1..].split_whitespace();
        let _state = fields.next();
        let Some(ppid) = fields.next().and_then(|v| v.parse::<i32>().ok()) else {
            continue;
        };
        let Some(pgid) = fields.next().and_then(|v| v.parse::<i32>().ok()) else {
            continue;
        };
        rows.push((pid, ppid, pgid));
    }
    rows
}

#[cfg(not(target_os = "linux"))]
fn process_table() -> Vec<(i32, i32, i32)> {
    let ps = ["/bin/ps", "/usr/bin/ps"]
        .into_iter()
        .find(|p| Path::new(p).is_file());
    let Some(ps) = ps else {
        return Vec::new();
    };
    let Ok(output) = Command::new(ps)
        .args(["-ax", "-o", "pid=,ppid=,pgid="])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<i32>().ok()?;
            let ppid = parts.next()?.parse::<i32>().ok()?;
            let pgid = parts.next()?.parse::<i32>().ok()?;
            Some((pid, ppid, pgid))
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
