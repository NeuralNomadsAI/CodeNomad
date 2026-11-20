//! `memory/git.ts`, `memory/git-environment.ts` and `requireHostGit`: the private
//! repository's Git plumbing, with every inherited Git override cleared.

use super::model::{Code, MemoryError, Result, fail};
use crate::shared::{js_trim, read_capped};
use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

const BRANCH: &str = "refs/heads/main";
/// `git-environment.ts` LOCAL: removed even when the host spells them differently.
const LOCAL: &str = "GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_IMPLICIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_GRAFT_FILE GIT_SHALLOW_FILE GIT_NAMESPACE GIT_PREFIX \
    GIT_INTERNAL_SUPER_PREFIX GIT_REPLACE_REF_BASE GIT_NO_REPLACE_OBJECTS GIT_CEILING_DIRECTORIES \
    GIT_DISCOVERY_ACROSS_FILESYSTEM GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL \
    GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM";

#[derive(Debug)]
pub enum GitError {
    /// `ENOENT`: no Git in the backend's PATH (`git_required`).
    Missing,
    /// Timeout, kill, oversized output or another spawn failure.
    Failed,
    /// A completed command with a non-zero exit status.
    Exit(i32, String),
}

/// `memoryGitEnvironment()` applied to a command.
pub fn clean(cmd: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
            cmd.env_remove(key);
        }
    }
    for key in LOCAL.split(' ') {
        cmd.env_remove(key);
    }
}

/// `runGitProcess(directory, args, { env, timeout })` (1 MiB stdout like `execFile`).
pub async fn execute(mut cmd: Command, timeout: Duration) -> std::result::Result<String, GitError> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd
        .spawn()
        .map_err(|e| if e.kind() == io::ErrorKind::NotFound { GitError::Missing } else { GitError::Failed })?;
    let (out, err) = (child.stdout.take().expect("stdout"), child.stderr.take().expect("stderr"));
    let finished = tokio::time::timeout(timeout, async {
        tokio::try_join!(read_capped(out, 1024 * 1024), read_capped(err, 1024 * 1024), child.wait())
    })
    .await;
    let (stdout, stderr, status) = match finished {
        Ok(Ok(v)) => v,
        _ => return Err(GitError::Failed),
    };
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    match status.code() {
        Some(0) => Ok(stdout),
        Some(code) => Err(GitError::Exit(code, String::from_utf8_lossy(&stderr).into_owned())),
        None => Err(GitError::Failed),
    }
}

/// `requireHostGit`: `git --version` in the backend's working directory, 5 s.
pub async fn require_host_git() -> Result<()> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))).arg("--version");
    match execute(cmd, Duration::from_secs(5)).await {
        Ok(v) if regex::Regex::new(r"^git version \S+").unwrap().is_match(v.strip_suffix('\n').unwrap_or(&v)) => Ok(()),
        Err(GitError::Missing) => Err(missing()),
        _ => Err(probe_unavailable()),
    }
}
pub fn missing() -> MemoryError {
    fail(Code::GitUnavailable, "git_required")
}
pub fn probe_unavailable() -> MemoryError {
    fail(Code::Conflict, "Git availability could not be checked. Retry the operation.")
}
fn storage() -> MemoryError {
    fail(Code::Unreadable, "Memory storage is unavailable")
}
async fn failure(e: GitError) -> MemoryError {
    match e {
        GitError::Missing => require_host_git().await.err().unwrap_or_else(storage),
        _ => storage(),
    }
}

pub struct MemoryGit {
    pub directory: PathBuf,
}

impl MemoryGit {
    pub async fn run(&self, args: &[&str], index: Option<&Path>) -> std::result::Result<String, GitError> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.directory);
        cmd.arg(format!("--git-dir={}", self.directory.join(".git").display()));
        cmd.arg(format!("--work-tree={}", self.directory.display()));
        const CONFIG: &str = "commit.gpgsign=false tag.gpgsign=false core.autocrlf=false core.safecrlf=false \
            core.fsmonitor=false core.attributesFile= core.excludesFile= gc.auto=0";
        for setting in std::iter::once(crate::git::hooks()).chain(CONFIG.split(' ')) {
            cmd.args(["-c", setting]);
        }
        cmd.args(args);
        clean(&mut cmd);
        cmd.envs([
            ("GIT_AUTHOR_NAME", "CodeNomad Memory"),
            ("GIT_AUTHOR_EMAIL", "memory@codenomad.local"),
            ("GIT_COMMITTER_NAME", "CodeNomad Memory"),
            ("GIT_COMMITTER_EMAIL", "memory@codenomad.local"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" }),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_LITERAL_PATHSPECS", "1"),
            ("GIT_NO_REPLACE_OBJECTS", "1"),
        ]);
        if let Some(index) = index {
            cmd.env("GIT_INDEX_FILE", index);
        }
        execute(cmd, Duration::from_secs(15)).await
    }

    /// `run` with the reference's error translation: a missing Git is `git_required`.
    async fn checked(&self, args: &[&str], index: Option<&Path>) -> Result<String> {
        match self.run(args, index).await {
            Ok(v) => Ok(v),
            Err(e) => Err(failure(e).await),
        }
    }

    pub async fn symbolic_head(&self) -> Result<String> {
        Ok(self.checked(&["symbolic-ref", "HEAD"], None).await?.trim().to_owned())
    }

    pub async fn initialize(&self) -> Result<()> {
        require_host_git().await?;
        let git = self.directory.join(".git");
        match std::fs::symlink_metadata(&git) {
            Ok(info) if !info.is_dir() || info.file_type().is_symlink() => {
                return Err(fail(Code::Conflict, "Invalid memory repository"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(storage()),
        }
        match std::fs::symlink_metadata(git.join("commondir")) {
            Ok(_) => return Err(fail(Code::Conflict, "Memory repository must be independent")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(storage()),
        }
        super::store::private_dir(&self.directory, true).map_err(|_| storage())?;
        // Git's idempotent init also completes an initialization interrupted by a crash.
        self.checked(&["init", "--initial-branch=main", "--template="], None).await?;
        if self.symbolic_head().await? != BRANCH {
            return Err(fail(Code::Conflict, "Memory repository branch changed"));
        }
        Ok(())
    }

    async fn head(&self) -> Result<Option<String>> {
        match self.run(&["rev-parse", "--verify", "--quiet", BRANCH], None).await {
            Ok(v) => Ok(Some(v.trim().to_owned())),
            Err(GitError::Exit(1, _)) => Ok(None),
            Err(e) => Err(failure(e).await),
        }
    }

    /// `commit(relativePath, transactionId)`: a private index, exact bytes, CAS on the branch.
    pub async fn commit(&self, relative: &str, transaction: &str) -> Result<()> {
        let index = self.directory.join(".git").join(format!("memory-index-{}", uuid::Uuid::new_v4()));
        let result = self.commit_with(&index, relative, transaction).await;
        let _ = std::fs::remove_file(&index);
        let _ = std::fs::remove_file(index.with_added_extension("lock"));
        result
    }

    async fn commit_with(&self, index: &Path, relative: &str, transaction: &str) -> Result<()> {
        let before = self.head().await?;
        let message = format!("memory: update entry\n\nMemory-Transaction: {transaction}");
        let previous = match &before {
            Some(head) => Some(self.checked(&["show", "-s", "--format=%T%n%B", head], None).await?),
            None => None,
        };
        // `indexOf("\n")`, `slice(separator + 1)` and `slice(0, separator)` with -1 as JS has them.
        let separator = previous.as_ref().and_then(|p| p.find('\n'));
        let already = match (&previous, separator) {
            (Some(p), Some(s)) => js_trim(&p[s + 1..]) == message,
            (Some(p), None) => js_trim(p) == message,
            _ => false,
        };
        match &before {
            Some(head) => self.checked(&["read-tree", head], Some(index)).await?,
            None => self.checked(&["read-tree", "--empty"], Some(index)).await?,
        };
        let file = self.directory.join(relative);
        match std::fs::symlink_metadata(&file) {
            Ok(_) => {
                let path = file.to_string_lossy().into_owned();
                let blob =
                    self.checked(&["hash-object", "-w", "--no-filters", "--", &path], None).await?.trim().to_owned();
                self.checked(
                    &["update-index", "--add", "--cacheinfo", &format!("100644,{blob},{relative}")],
                    Some(index),
                )
                .await?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.checked(&["update-index", "--force-remove", "--", relative], Some(index)).await?;
            }
            Err(_) => return Err(storage()),
        }
        let tree = self.checked(&["write-tree"], Some(index)).await?.trim().to_owned();
        if already {
            let p = previous.as_deref().unwrap_or_default();
            let cut = separator.unwrap_or_else(|| p.char_indices().last().map_or(0, |(i, _)| i));
            let committed = js_trim(&p[..cut]);
            if tree != committed {
                return Err(fail(Code::Conflict, "Memory transaction differs from its commit"));
            }
        } else {
            let mut args = vec!["commit-tree", tree.as_str()];
            if let Some(head) = &before {
                args.extend(["-p", head.as_str()]);
            }
            args.extend(["-m", message.as_str()]);
            let commit = self.checked(&args, None).await?.trim().to_owned();
            let zero = "0".repeat(40);
            self.checked(&["update-ref", "--no-deref", BRANCH, &commit, before.as_deref().unwrap_or(&zero)], None)
                .await?;
        }
        std::fs::rename(index, self.directory.join(".git").join("index")).map_err(|_| storage())
    }
}
