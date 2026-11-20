//! Repository configuration admitted before any Git display or mutation
//! (audit M3). The listing is the effective configuration of the directory
//! Git actually runs in (local, `config.worktree` and command scopes; system
//! and global are disabled by `command`), with includes named but never
//! followed, plus every absorbed submodule's own configuration. Status and
//! diff reads pass `--ignore-submodules=dirty`: gitlink commits stay visible
//! (reference parity) and Git never runs in a submodule's work tree, whose
//! configuration may live outside `.git/modules`.
use super::run;
use crate::{Error, error};
use axum::http::StatusCode as Status;
use std::path::{Path, PathBuf};

fn refused() -> Error {
    error(Status::FORBIDDEN, "Repository uses unqualified Git configuration")
}

/// Keys that run external programs, import or relocate configuration, or
/// fetch objects on demand.
pub fn forbidden(key: &str) -> bool {
    let key = key.trim().to_ascii_lowercase();
    key.starts_with("filter.")
        || key.starts_with("include.")
        || key.starts_with("includeif.")
        || key == "extensions.worktreeconfig"
        || key == "extensions.partialclone"
        || key.ends_with(".promisor")
        || key.starts_with("diff.") && (key.ends_with(".textconv") || key.ends_with(".command"))
}

fn check(listing: &str) -> Result<(), Error> {
    // Scope names (`local`, `worktree`, `command`) never match a refused key.
    if listing.split(['\0', '\t', '\n']).any(forbidden) { Err(refused()) } else { Ok(()) }
}

pub async fn effective(dir: &Path) -> Result<(), Error> {
    let args = ["config", "--show-scope", "--no-includes", "--name-only", "-z", "--list"];
    check(&run(dir, &args, 64 * 1024).await?.ok()?.text())
}

/// Every `config` of an absorbed submodule under `<main>/.git/modules`.
pub async fn submodules(main: &Path) -> Result<(), Error> {
    let base = main.join(".git").join("modules");
    let files = tokio::task::spawn_blocking(move || module_configs(&base)).await.map_err(|_| refused())??;
    for file in files {
        let file = file.to_str().ok_or_else(refused)?;
        let args = ["config", "--file", file, "--no-includes", "--name-only", "-z", "--list"];
        check(&run(main, &args, 64 * 1024).await?.ok()?.text())?;
    }
    Ok(())
}

const MODULE_DIRECTORIES: usize = 512;
const MODULE_CONFIGS: usize = 64;

fn module_configs(base: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut found = Vec::new();
    let mut pending = vec![base.to_path_buf()];
    let mut visited = 0;
    while let Some(dir) = pending.pop() {
        visited += 1;
        if visited > MODULE_DIRECTORIES {
            return Err(refused());
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if dir == base && e.kind() == std::io::ErrorKind::NotFound => return Ok(found),
            Err(_) => return Err(refused()),
        };
        if dir.join("HEAD").is_file() {
            // A submodule's Git directory: its configuration, then nested modules.
            for name in ["config", "config.worktree"] {
                let file = dir.join(name);
                match std::fs::symlink_metadata(&file) {
                    Ok(meta) if meta.is_file() => found.push(file),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err(refused()),
                }
            }
            if found.len() > MODULE_CONFIGS {
                return Err(refused());
            }
            let nested = dir.join("modules");
            if std::fs::symlink_metadata(&nested).is_ok_and(|m| m.is_dir()) {
                pending.push(nested);
            }
            continue;
        }
        // A grouping directory of a submodule name containing `/`.
        for entry in entries {
            let entry = entry.map_err(|_| refused())?;
            let kind = entry.file_type().map_err(|_| refused())?;
            if kind.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn refused_keys() {
        for key in [
            "filter.x.clean",
            "Filter.X.smudge",
            "include.path",
            "includeIf.gitdir:/x/.path",
            "extensions.worktreeConfig",
            "extensions.partialClone",
            "remote.origin.promisor",
            "diff.pdf.textconv",
            "diff.x.command",
        ] {
            assert!(forbidden(key), "{key}");
        }
        for key in ["core.bare", "diff.renames", "user.name", "remote.origin.url", "core.hookspath"] {
            assert!(!forbidden(key), "{key}");
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
        assert!(status.success(), "{args:?}");
    }

    fn repository(name: &str) -> PathBuf {
        let dir = crate::shared::test_dir(&format!("config-guard-{name}"));
        git(&dir, &["init", "-q"]);
        dir
    }

    #[tokio::test]
    async fn repository_hooks_never_run() {
        let repo = repository("hooks");
        git(&repo, &["config", "user.name", "a"]);
        git(&repo, &["config", "user.email", "a@a"]);
        let marker = repo.join("hook-ran");
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.to_string_lossy().replace('\\', "/"))).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Control: plain Git runs the repository hook.
        git(&repo, &["commit", "--allow-empty", "-q", "-m", "control"]);
        assert!(marker.exists(), "control hook did not run");
        std::fs::remove_file(&marker).unwrap();
        let empty = repo.join("empty-hooks");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(empty.join("pre-commit"), "").unwrap();
        assert!(super::super::empty_hooks(&empty).is_err(), "a non-empty folder is refused");
        std::fs::remove_file(empty.join("pre-commit")).unwrap();
        super::super::empty_hooks(&empty).unwrap();
        let out = run(&repo, &["commit", "--allow-empty", "-q", "-m", "x"], 4096).await.unwrap();
        assert_eq!(out.code, 0);
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(repo);
    }

    #[tokio::test]
    async fn worktree_config_and_submodule_filters_are_refused() {
        let plain = repository("plain");
        effective(&plain).await.unwrap();
        submodules(&plain).await.unwrap();

        let worktree = repository("worktree");
        git(&worktree, &["config", "extensions.worktreeConfig", "true"]);
        git(&worktree, &["config", "--worktree", "filter.x.clean", "cat"]);
        assert_eq!(effective(&worktree).await.unwrap_err().0, Status::FORBIDDEN);

        let module = repository("module");
        let git_dir = module.join(".git").join("modules").join("group").join("sub");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(git_dir.join("config"), "[core]\n\tbare = false\n").unwrap();
        submodules(&module).await.unwrap();
        std::fs::write(git_dir.join("config"), "[filter \"x\"]\n\tclean = cat\n").unwrap();
        assert_eq!(submodules(&module).await.unwrap_err().0, Status::FORBIDDEN);
        for dir in [plain, worktree, module] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
