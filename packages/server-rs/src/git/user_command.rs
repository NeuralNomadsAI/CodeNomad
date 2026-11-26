//! Explicit mutations (`git add`, `restore --staged`, `rm --cached`, `commit`)
//! use the host's Git configuration (global/system filters such as Git LFS,
//! hooks, and signing), matching `packages/server/src/workspaces/git-mutations.ts`.
use std::{io, path::Path, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

use super::{Output, conflict, missing_git};
use crate::Error;

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Keep host configuration, but do not let ambient repository overrides
    // relocate the exact checkout that the route admitted.
    command
        .env_remove("GIT_DIR")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_NAMESPACE")
        .env_remove("GIT_QUARANTINE_PATH");
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

pub(super) fn literal_command(dir: &Path, args: &[&str]) -> Command {
    let mut command = command(dir, &[]);
    // Preserve the pre-existing guards on stage/unstage (`core.hooksPath`,
    // `core.fsmonitor=false`, `submodule.recurse=false`, `GIT_LITERAL_PATHSPECS=1`),
    // clearing conflicting ambient pathspec flags so Git never rejects the combination.
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if matches!(upper.as_str(), "GIT_GLOB_PATHSPECS" | "GIT_NOGLOB_PATHSPECS" | "GIT_ICASE_PATHSPECS") {
            command.env_remove(key);
        }
    }
    command
        .args(["-c", super::hooks(), "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"])
        .args(args)
        .env_remove("GIT_GLOB_PATHSPECS")
        .env_remove("GIT_NOGLOB_PATHSPECS")
        .env_remove("GIT_ICASE_PATHSPECS")
        .env("GIT_LITERAL_PATHSPECS", "1");
    command
}

pub(super) async fn execute(mut command: Command) -> Result<Output, Error> {
    let mut child = command.spawn().map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound { missing_git() } else { conflict("Git could not start") }
    })?;
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    // Hooks, signing, and clean filters (e.g. Git LFS) may legitimately take time.
    // Drain output without letting verbosity kill Git or hold the pool used by reads.
    let (bytes, err, status) = tokio::try_join!(drain(out, 64 * 1024), drain(err, 32 * 1024), child.wait())
        .map_err(|_| conflict("Git outcome unavailable"))?;
    Ok(Output { code: status.code().unwrap_or(-1), bytes, err })
}

pub(super) async fn execute_with_stdin(mut command: Command, input: Vec<u8>) -> Result<Output, Error> {
    command.stdin(Stdio::piped());
    let mut child = command.spawn().map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound { missing_git() } else { conflict("Git could not start") }
    })?;
    let mut stdin = child.stdin.take().unwrap();
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let write_stdin = async move {
        let result = stdin.write_all(&input).await;
        let _ = stdin.shutdown().await;
        match result {
            Ok(()) => Ok(()),
            // Git may exit early with a non-zero status and close stdin before reading everything.
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
            Err(e) => Err(e),
        }
    };
    let ((), bytes, err, status) =
        tokio::try_join!(write_stdin, drain(out, 64 * 1024), drain(err, 32 * 1024), child.wait())
            .map_err(|_| conflict("Git outcome unavailable"))?;
    Ok(Output { code: status.code().unwrap_or(-1), bytes, err })
}

pub(super) async fn run(dir: &Path, args: &[&str]) -> Result<Output, Error> {
    execute(command(dir, args)).await
}

async fn drain(mut input: impl AsyncRead + Unpin, max: usize) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = input.read(&mut buffer).await?;
        if count == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&buffer[..count.min(max - output.len())]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command as StdCommand;

    fn git(dir: &Path, args: &[&str]) -> Vec<u8> {
        let mut cmd = StdCommand::new("git");
        cmd.arg("-C").arg(dir).args(args);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
                cmd.env_remove(key);
            }
        }
        let out = cmd
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    }

    fn init_repo(name: &str) -> PathBuf {
        let dir = crate::shared::test_dir(&format!("git-user-command-{name}"));
        git(&dir, &["init", "-q"]);
        dir
    }

    #[tokio::test]
    async fn stage_and_unstage_honor_global_lfs_filter_and_literal_pathspecs() {
        let repo = init_repo("lfs");
        let fake_home = repo.join("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        std::fs::write(repo.join(".gitattributes"), "*.bin filter=testlfs -text\n").unwrap();
        let raw = b"\x00\x01RAW-BINARY-PAYLOAD\xff";
        std::fs::write(repo.join("asset.bin"), raw).unwrap();
        std::fs::write(repo.join("a[1].txt"), "bracket\n").unwrap();
        std::fs::write(repo.join("a1.txt"), "plain\n").unwrap();

        let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 21\n";
        std::fs::write(
            fake_home.join(".gitconfig"),
            "[filter \"testlfs\"]\n\tclean = printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:0000\\nsize 21\\n'\n\trequired = true\n",
        )
        .unwrap();

        let configure_home = |cmd: &mut Command| {
            // Lock B3 regression: stage/unstage must never override global/system config vars
            // and must strip conflicting pathspec env vars while setting GIT_LITERAL_PATHSPECS=1.
            let envs: Vec<(String, Option<String>)> = cmd
                .as_std()
                .get_envs()
                .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|s| s.to_string_lossy().into_owned())))
                .collect();
            for forbidden_override in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM"] {
                assert!(
                    !envs.iter().any(|(k, _)| k.eq_ignore_ascii_case(forbidden_override)),
                    "stage/unstage command must not set or strip {forbidden_override}"
                );
            }
            for stripped in ["GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"] {
                assert!(
                    envs.iter().any(|(k, v)| k.eq_ignore_ascii_case(stripped) && v.is_none()),
                    "stage/unstage command must remove {stripped}"
                );
            }
            assert!(
                envs.iter().any(|(k, v)| k.eq_ignore_ascii_case("GIT_LITERAL_PATHSPECS") && v.as_deref() == Some("1")),
                "stage/unstage command must set GIT_LITERAL_PATHSPECS=1"
            );
            // Isolate the test subprocess from host system/ambient config after checking production env.
            cmd.env_remove("GIT_CONFIG_GLOBAL")
                .env_remove("GIT_CONFIG_SYSTEM")
                .env_remove("GIT_CONFIG_COUNT")
                .env_remove("GIT_CONFIG_PARAMETERS")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", &fake_home)
                .env("USERPROFILE", &fake_home)
                .env("XDG_CONFIG_HOME", fake_home.join("xdg"));
        };

        // Exercise the exact `git::apply_paths_with` path used by `git-stage` / `git-unstage`.
        super::super::apply_paths_with(
            &repo,
            true,
            &["asset.bin".to_owned(), "a[1].txt".to_owned()],
            || Ok(()),
            &configure_home,
        )
        .await
        .unwrap();

        let staged = git(&repo, &["cat-file", "-p", ":asset.bin"]);
        assert_eq!(staged, pointer.as_bytes(), "staged blob must be the LFS pointer, not raw binary bytes");
        let cached = String::from_utf8(git(&repo, &["ls-files", "--cached"])).unwrap();
        let names: Vec<&str> = cached.lines().collect();
        assert_eq!(names, vec!["a[1].txt", "asset.bin"], "literal pathspec must not glob a1.txt");

        // Unstage without HEAD (`rm --cached`) and verify a1.txt stays untouched while a[1].txt is removed.
        super::super::apply_paths_with(&repo, true, &["a1.txt".to_owned()], || Ok(()), &configure_home).await.unwrap();
        super::super::apply_paths_with(&repo, false, &["a[1].txt".to_owned()], || Ok(()), &configure_home)
            .await
            .unwrap();
        let cached = String::from_utf8(git(&repo, &["ls-files", "--cached"])).unwrap();
        let names: Vec<&str> = cached.lines().collect();
        assert_eq!(names, vec!["a1.txt", "asset.bin"], "literal unstage must not disturb staged a1.txt");

        // Create a commit so `HEAD` exists, modify & stage both files, then verify `restore --staged`
        // unstages only `a[1].txt` while leaving `a1.txt` staged.
        git(&repo, &["config", "user.name", "test"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a[1].txt"), "bracket-2\n").unwrap();
        std::fs::write(repo.join("a1.txt"), "plain-2\n").unwrap();
        super::super::apply_paths_with(
            &repo,
            true,
            &["a[1].txt".to_owned(), "a1.txt".to_owned()],
            || Ok(()),
            &configure_home,
        )
        .await
        .unwrap();
        super::super::apply_paths_with(&repo, false, &["a[1].txt".to_owned()], || Ok(()), &configure_home)
            .await
            .unwrap();
        let staged_diff = String::from_utf8(git(&repo, &["diff", "--cached", "--name-only"])).unwrap();
        assert_eq!(staged_diff.trim(), "a1.txt", "restore --staged must unstage only a[1].txt");

        // When the required global filter fails, staging must fail with 409 and leave the path unindexed.
        std::fs::write(repo.join("broken.bin"), raw).unwrap();
        std::fs::write(fake_home.join(".gitconfig"), "[filter \"testlfs\"]\n\tclean = false\n\trequired = true\n")
            .unwrap();
        let err = super::super::apply_paths_with(&repo, true, &["broken.bin".to_owned()], || Ok(()), &configure_home)
            .await
            .unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::CONFLICT);
        let listed = git(&repo, &["ls-files", "--stage", "--", "broken.bin"]);
        assert!(listed.is_empty(), "failing required filter must never index raw bytes");

        let _ = std::fs::remove_dir_all(repo);
    }
}
