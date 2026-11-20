//! `WorktreeDeletionFence` (`workspaces/worktree-session-evacuation.ts`) as far as the prototype
//! needs it: worktree deletion blocks its target and evacuation destination (`run`), waits for
//! admitted overlapping writes to finish, and `subagent-depth` writes are admitted (`enter`) or
//! refused at once with 409 while a deletion is in progress. Plus the reference's per-target
//! write queue (`PluginControls.serializeMutation`). One process-wide fence, like the reference's.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Default)]
struct State {
    blocked: HashMap<String, usize>,
    active: HashMap<String, usize>,
}
static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);
static IDLE: LazyLock<Notify> = LazyLock::new(Notify::new);
static QUEUES: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Mutex::default);
const DRAIN: Duration = Duration::from_secs(30);

/// `normalizeDirectory` (host paths; WSL is not ported).
pub fn normalize(directory: &str) -> String {
    let n = directory.trim().replace('\\', "/");
    let n = n.trim_end_matches('/');
    let n = if n.is_empty() { "/" } else { n };
    let b = n.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/';
    if drive || n.starts_with("//") { n.to_lowercase() } else { n.to_string() }
}
fn overlap(left: &str, right: &str) -> bool {
    let contains = |root: &str, target: &str| {
        target == root || target.starts_with(&if root.ends_with('/') { root.to_string() } else { format!("{root}/") })
    };
    contains(left, right) || contains(right, left)
}
/// `canonicalWorktreeIdentity` for host paths.
pub fn identity(directory: &std::path::Path) -> String {
    let s = crate::files::node_path::Style::host().normalize(&directory.to_string_lossy());
    if cfg!(windows) { s.to_lowercase() } else { s }
}
/// `isBlocked`: a deletion in progress overlaps `directory`.
pub fn is_blocked(directory: &str) -> bool {
    let target = normalize(directory);
    STATE.lock().unwrap().blocked.keys().any(|b| overlap(b, &target))
}

fn normalized(directories: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = directories.iter().map(|d| normalize(d)).collect();
    normalized.sort();
    normalized.dedup();
    normalized
}
/// One holder fewer for each of `keys`.
fn release(counts: &mut HashMap<String, usize>, keys: &[String]) {
    for d in keys {
        match counts.get_mut(d) {
            Some(n) if *n > 1 => *n -= 1,
            _ => _ = counts.remove(d),
        }
    }
}

/// An admitted write; dropping it releases the admission.
pub struct Entered(Vec<String>);
impl Drop for Entered {
    fn drop(&mut self) {
        release(&mut STATE.lock().unwrap().active, &self.0);
        IDLE.notify_waiters();
    }
}
/// `enter`: `None` while any of `directories` overlaps a deletion in progress.
pub fn enter(directories: &[String]) -> Option<Entered> {
    let normalized = normalized(directories);
    let mut s = STATE.lock().unwrap();
    if normalized.iter().any(|d| s.blocked.keys().any(|b| overlap(b, d))) {
        return None;
    }
    for d in &normalized {
        *s.active.entry(d.clone()).or_default() += 1;
    }
    Some(Entered(normalized))
}

/// A deletion in progress; dropping it unblocks its directories.
pub struct Blocked(Vec<String>);
impl Drop for Blocked {
    fn drop(&mut self) {
        release(&mut STATE.lock().unwrap().blocked, &self.0);
    }
}
/// `run` before its operation: block new overlapping admissions, then drain the admitted ones
/// (the reference rejects after 30 s, unblocking again).
pub async fn block(directories: &[String]) -> Result<Blocked, &'static str> {
    let blocked = normalized(directories);
    {
        let mut s = STATE.lock().unwrap();
        for d in &blocked {
            *s.blocked.entry(d.clone()).or_default() += 1;
        }
    }
    let guard = Blocked(blocked);
    let deadline = tokio::time::Instant::now() + DRAIN;
    loop {
        let idle = IDLE.notified();
        tokio::pin!(idle);
        idle.as_mut().enable();
        let busy = STATE.lock().unwrap().active.keys().any(|a| guard.0.iter().any(|b| overlap(b, a)));
        if !busy {
            return Ok(guard);
        }
        if tokio::time::timeout_at(deadline, idle).await.is_err() {
            return Err("Timed out waiting for worktree mutations to finish");
        }
    }
}

/// `serializeMutation`: one write at a time per target key, idle keys pruned.
pub async fn serialize(key: String) -> tokio::sync::OwnedMutexGuard<()> {
    let queue = {
        let mut q = QUEUES.lock().unwrap();
        q.retain(|_, m| Arc::strong_count(m) > 1);
        q.entry(key).or_default().clone()
    };
    queue.lock_owned().await
}
/// The reference's project queue key.
pub fn project_key(workspace: &str, directory: &str) -> String {
    let d = directory.trim().trim_end_matches(['\\', '/']).to_lowercase();
    format!("{workspace}\nproject\n{d}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_like_the_reference() {
        assert_eq!(normalize(" C:\\Repo\\A\\ "), "c:/repo/a");
        assert_eq!(normalize("/srv/Repo/"), "/srv/Repo");
        assert!(
            overlap("c:/repo", "c:/repo/sub")
                && overlap("c:/repo/sub", "c:/repo")
                && !overlap("c:/repo", "c:/repository")
        );
    }

    #[tokio::test]
    async fn deletion_refuses_new_writes_and_drains_admitted_ones() {
        let root = "C:\\fence-test\\Repo";
        let admitted = enter(&[format!("{root}\\.codenomad\\worktrees\\t")]).unwrap();
        let dirs = vec![format!("{root}\\.codenomad\\worktrees\\t"), root.to_string()];
        let deletion = tokio::spawn(async move { block(&dirs).await });
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(is_blocked(&format!("{root}\\sub")), "a subfolder of the blocked root overlaps");
        assert!(enter(&[root.to_string()]).is_none(), "a new write is refused during the deletion");
        assert!(!deletion.is_finished(), "the deletion waits for the admitted write");
        drop(admitted);
        let held = deletion.await.unwrap().unwrap();
        assert!(enter(&["C:\\fence-test\\Other".into()]).is_some(), "unrelated folders stay writable");
        drop(held);
        assert!(!is_blocked(root) && enter(&[root.to_string()]).is_some());
    }
}
