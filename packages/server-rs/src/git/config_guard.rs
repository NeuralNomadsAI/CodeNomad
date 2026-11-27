//! Passive Git read guards (audit M3/M4): instead of refusing common repositories
//! (LFS filters, `include`/`includeIf`, `extensions.worktreeConfig`, partial clones,
//! alternates) with 403, passive working-tree reads (`status`, `diff`, worktree clean
//! checks) neutralize every effective `filter.<name>.*` driver across all scopes
//! (system, `~/.gitconfig`, XDG global, repo-local, `config.worktree`, and includes)
//! via `-c filter.<name>.{clean=,smudge=,process=,required=false}`, while `git::command`
//! keeps `core.hooksPath`, `core.fsmonitor=false`, `diff.external=`, `submodule.recurse=false`,
//! and `GIT_NO_LAZY_FETCH=1`.
use super::{bad, run};
use crate::Error;
use std::path::Path;

/// Collect `-c filter.<name>.{clean,smudge,process,required}` overrides disabling every
/// filter driver defined in effective Git configuration across all scopes (system,
/// `~/.gitconfig`, XDG global, local, `config.worktree`, and includes) so passive
/// working-tree reads never invoke external filter commands referenced by `.gitattributes`.
/// Limit: Git has no single-process `--no-filters` flag that preserves `.gitattributes`
/// `text`/`eol`/`binary` semantics; upgrade to a native flag if Git adds one.
pub async fn filter_disables(dir: &Path) -> Result<Vec<String>, Error> {
    let args = ["config", "--show-scope", "--includes", "--name-only", "-z", "--list"];
    let out = run(dir, &args, 256 * 1024).await?.ok()?;
    let mut names = std::collections::BTreeSet::new();
    collect_filter_names(&out.text(), &mut names)?;
    let mut flags = Vec::with_capacity(names.len() * 8);
    for name in names {
        flags.push("-c".into());
        flags.push(format!("filter.{name}.clean="));
        flags.push("-c".into());
        flags.push(format!("filter.{name}.smudge="));
        flags.push("-c".into());
        flags.push(format!("filter.{name}.process="));
        flags.push("-c".into());
        flags.push(format!("filter.{name}.required=false"));
    }
    Ok(flags)
}

fn collect_filter_names(listing: &str, out: &mut std::collections::BTreeSet<String>) -> Result<(), Error> {
    let mut parts = listing.split('\0');
    while let Some(scope) = parts.next() {
        if scope.is_empty() {
            break;
        }
        let raw = parts.next().ok_or_else(|| bad("Git configuration could not be read"))?;
        let Some((section, rest)) = raw.split_once('.') else { continue };
        if !section.eq_ignore_ascii_case("filter") {
            continue;
        }
        let Some((name, _var)) = rest.rsplit_once('.') else { continue };
        if !name.is_empty() && !name.contains(['\0', '\n', '\r']) {
            out.insert(name.to_owned());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

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

    #[test]
    fn filter_discovery_covers_all_scopes_including_xdg_local_worktree_and_includes() {
        let mut names = std::collections::BTreeSet::new();
        collect_filter_names(
            "system\0filter.lfs.clean\0global\0filter.My.Custom.smudge\0local\0filter.repo.clean\0worktree\0filter.wt.process\0global\0core.bare\0global\0filter.lfs.process\0",
            &mut names,
        )
        .unwrap();
        assert_eq!(names, ["My.Custom", "lfs", "repo", "wt"].into_iter().map(str::to_owned).collect());
        assert_eq!(collect_filter_names("global", &mut names).unwrap_err().0, axum::http::StatusCode::BAD_REQUEST);

        // Verify real `git config --show-scope --includes --name-only -z --list` discovers
        // filters from XDG global config alongside `~/.gitconfig`, local config, `include.path`,
        // and `extensions.worktreeConfig` (`config.worktree`).
        let env_root = crate::shared::test_dir("config-guard-all-scopes");
        let home = env_root.join("home");
        let xdg = env_root.join("xdg");
        let repo = env_root.join("repo");
        let extra = env_root.join("included.gitconfig");
        std::fs::create_dir_all(xdg.join("git")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        std::fs::write(home.join(".gitconfig"), "[user]\n\tname = Host\n").unwrap();
        std::fs::write(xdg.join("git").join("config"), "[filter \"xdgonly\"]\n\tclean = cat\n").unwrap();
        std::fs::write(&extra, "[filter \"incfilter\"]\n\tsmudge = cat\n").unwrap();
        git(&repo, &["config", "filter.localfilter.clean", "cat"]);
        git(&repo, &["config", "include.path", &extra.to_string_lossy().replace('\\', "/")]);
        git(&repo, &["config", "extensions.worktreeConfig", "true"]);
        git(&repo, &["config", "--worktree", "filter.wtfilter.process", "cat"]);

        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "--show-scope", "--includes", "--name-only", "-z", "--list"])
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("XDG_CONFIG_HOME", &xdg)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_CONFIG_GLOBAL")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let mut found = std::collections::BTreeSet::new();
        collect_filter_names(&String::from_utf8_lossy(&out.stdout), &mut found).unwrap();
        for expected in ["xdgonly", "incfilter", "localfilter", "wtfilter"] {
            assert!(found.contains(expected), "missing filter {expected} in {found:?}");
        }
        let _ = std::fs::remove_dir_all(env_root);
    }
}
