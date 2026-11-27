//! `WorktreeDeletionFence` (`workspaces/worktree-session-evacuation.ts`) as far as the prototype
//! needs it: worktree deletion blocks its target and evacuation destination (`run`), waits for
//! admitted overlapping writes to finish, and `subagent-depth` writes are admitted (`enter`) or
//! refused at once with 409 while a deletion is in progress. Plus the reference's per-target
//! write queue (`PluginControls.serializeMutation`). One process-wide fence, like the reference's.

use std::collections::HashMap;
use std::sync::{
    Arc, LazyLock, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Default)]
struct State {
    blocked: HashMap<String, usize>,
    active: HashMap<String, usize>,
    displays: Vec<(String, Weak<AtomicBool>)>,
    deleting_roots: Vec<String>,
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
fn contains(root: &str, target: &str) -> bool {
    target == root || target.starts_with(&if root.ends_with('/') { root.to_string() } else { format!("{root}/") })
}
fn overlap(left: &str, right: &str) -> bool {
    contains(left, right) || contains(right, left)
}
/// `reserveWorktreeDeletion` (`workspaces/manager.ts`): reserves only the deleted
/// target checkout root so new workspace opens under it are refused without stalling
/// workspace opens on the main checkout or sibling worktrees.
pub struct DeletionRoot(String);
impl Drop for DeletionRoot {
    fn drop(&mut self) {
        let mut s = STATE.lock().unwrap();
        if let Some(pos) = s.deleting_roots.iter().position(|r| r == &self.0) {
            s.deleting_roots.remove(pos);
        }
    }
}
pub fn reserve_deletion_root(directory: &str) -> Result<DeletionRoot, &'static str> {
    let target = normalize(directory);
    let mut s = STATE.lock().unwrap();
    if s.deleting_roots.iter().any(|root| overlap(root, &target)) {
        return Err("Worktree deletion is already in progress");
    }
    s.deleting_roots.push(target.clone());
    Ok(DeletionRoot(target))
}
pub fn is_deleting_root(directory: &str) -> bool {
    let candidate = normalize(directory);
    STATE.lock().unwrap().deleting_roots.iter().any(|root| contains(root, &candidate))
}
/// Nearest checkout root (`path` or an ancestor within `scope` containing `.git`),
/// matching TS `getWorktreeIdentityForPath` without spawning Git on every write.
pub fn checkout_root(scope: &std::path::Path, path: &std::path::Path) -> std::path::PathBuf {
    for dir in path.ancestors() {
        if !dir.starts_with(scope) {
            break;
        }
        if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
            return dir.to_path_buf();
        }
    }
    path.to_path_buf()
}
pub fn covered(blocked: &std::collections::HashSet<String>, needed: &std::collections::HashSet<String>) -> bool {
    let roots: Vec<_> = blocked.iter().map(|b| normalize(b)).collect();
    needed.iter().all(|path| {
        let target = normalize(path);
        roots.iter().any(|root| contains(root, &target))
    })
}
/// `canonicalWorktreeIdentity` for host paths.
pub fn identity(directory: &std::path::Path) -> String {
    let s = crate::files::node_path::Style::host().normalize(&directory.to_string_lossy());
    if cfg!(windows) { s.to_lowercase() } else { s }
}
pub(crate) fn session(id: &str) -> String {
    format!("session:{id}")
}
/// `isBlocked`: a deletion in progress overlaps `directory`.
pub fn is_blocked(directory: &str) -> bool {
    let target = normalize(directory);
    STATE.lock().unwrap().blocked.keys().any(|b| overlap(b, &target))
}

/// Display reads do not delay deletion. A deletion that starts and finishes before the response
/// still invalidates a display that was captured before it.
pub fn capture_display(directory: &str) -> Arc<AtomicBool> {
    let key = normalize(directory);
    let mut state = STATE.lock().unwrap();
    let live = Arc::new(AtomicBool::new(!state.blocked.keys().any(|b| overlap(b, &key))));
    state.displays.retain(|(_, t)| t.strong_count() != 0);
    state.displays.push((key, Arc::downgrade(&live)));
    live
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
    enter_checked(directories).ok()
}

fn enter_checked(directories: &[String]) -> Result<Entered, bool> {
    let normalized = normalized(directories);
    let mut s = STATE.lock().unwrap();
    let mut directory_blocked = false;
    let mut any_blocked = false;
    for d in &normalized {
        if s.blocked.keys().any(|b| overlap(b, d)) {
            any_blocked = true;
            if !d.starts_with("session:") {
                directory_blocked = true;
            }
        }
    }
    if any_blocked {
        return Err(directory_blocked);
    }
    for d in &normalized {
        *s.active.entry(d.clone()).or_default() += 1;
    }
    Ok(Entered(normalized))
}

pub(crate) fn admit(directories: &[String]) -> Result<Entered, crate::Error> {
    let permit = enter_checked(directories);
    #[cfg(test)]
    {
        super::fence_test_trace::record("checkout fence", if permit.is_ok() { "admitted" } else { "refused" });
        if directories.iter().any(|key| key.starts_with("session:")) {
            super::fence_test_trace::record("session reservation", if permit.is_ok() { "admitted" } else { "refused" });
        }
    }
    permit.map_err(|directory_blocked| {
        let message =
            if directory_blocked { "Worktree deletion is in progress" } else { "Session move is in progress" };
        crate::error(axum::http::StatusCode::CONFLICT, message)
    })
}

/// A deletion in progress; dropping it unblocks its directories.
pub struct Blocked(Vec<String>);
impl Drop for Blocked {
    fn drop(&mut self) {
        release(&mut STATE.lock().unwrap().blocked, &self.0);
    }
}

/// Placement changes cannot overtake an admitted session request.
pub(crate) fn try_block(directories: &[String]) -> Option<Blocked> {
    let keys = normalized(directories);
    let mut state = STATE.lock().unwrap();
    if keys.iter().any(|key| state.active.keys().chain(state.blocked.keys()).any(|p| overlap(p, key))) {
        return None;
    }
    for key in &keys {
        *state.blocked.entry(key.clone()).or_default() += 1;
    }
    Some(Blocked(keys))
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
        s.displays.retain(|(key, weak)| {
            let Some(live) = weak.upgrade() else { return false };
            if blocked.iter().any(|b| overlap(b, key)) {
                live.store(false, Ordering::Relaxed);
                return false;
            }
            true
        });
    }
    let guard = Blocked(blocked);
    let deadline = tokio::time::Instant::now() + DRAIN;
    loop {
        let idle = IDLE.notified();
        tokio::pin!(idle);
        idle.as_mut().enable();
        let busy = STATE.lock().unwrap().active.keys().any(|a| guard.0.iter().any(|b| overlap(b, a)));
        if !busy {
            #[cfg(test)]
            super::fence_test_trace::record("checkout fence", "drained");
            return Ok(guard);
        }
        #[cfg(test)]
        super::fence_test_trace::record("checkout fence", "waiting on admitted mutations");
        if tokio::time::timeout_at(deadline, idle).await.is_err() {
            return Err("Timed out waiting for worktree mutations to finish");
        }
    }
}

/// `serializeMutation`: one write at a time per target key, reporting whether the caller waited.
pub async fn serialize_checked(key: String) -> (tokio::sync::OwnedMutexGuard<()>, bool) {
    let lock = queue(key);
    match lock.clone().try_lock_owned() {
        Ok(guard) => (guard, false),
        Err(_) => (lock.lock_owned().await, true),
    }
}
/// `serializeMutation`: one write at a time per target key, idle keys pruned.
pub async fn serialize(key: String) -> tokio::sync::OwnedMutexGuard<()> {
    serialize_checked(key).await.0
}

fn queue(key: String) -> Arc<tokio::sync::Mutex<()>> {
    let mut q = QUEUES.lock().unwrap();
    q.retain(|_, m| Arc::strong_count(m) > 1);
    q.entry(key).or_default().clone()
}
/// The reference's project queue key.
pub fn project_key(workspace: &str, directory: &str) -> String {
    let d = directory.trim().trim_end_matches(['\\', '/']).to_lowercase();
    format!("{workspace}\nproject\n{d}")
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

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
        let deadline = Instant::now() + Duration::from_secs(5);
        while !is_blocked(&format!("{root}\\sub")) {
            assert!(Instant::now() < deadline, "deletion must register the blocked root");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(is_blocked(&format!("{root}\\sub")), "a subfolder of the blocked root overlaps");
        assert!(enter(&[root.to_string()]).is_none(), "a new write is refused during the deletion");
        assert!(!deletion.is_finished(), "the deletion waits for the admitted write");
        drop(admitted);
        let held = deletion.await.unwrap().unwrap();
        assert!(enter(&["C:\\fence-test\\Other".into()]).is_some(), "unrelated folders stay writable");
        drop(held);
        assert!(!is_blocked(root) && enter(&[root.to_string()]).is_some());
    }

    #[tokio::test]
    async fn a_completed_deletion_invalidates_the_captured_display_only() {
        let staged = capture_display("/fence-test/repository/tree");
        let other = capture_display("/fence-test/elsewhere");
        drop(block(&["/fence-test/repository".into()]).await.unwrap());
        assert!(!staged.load(Ordering::Relaxed));
        assert!(other.load(Ordering::Relaxed));
        assert!(capture_display("/fence-test/repository/tree").load(Ordering::Relaxed));
    }
}
