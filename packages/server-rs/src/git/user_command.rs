//! Explicit mutations (`git add`, `restore --staged`, `rm --cached`, `commit`)
//! use the host's Git configuration (global/system filters such as Git LFS,
//! hooks, and signing), matching `packages/server/src/workspaces/git-mutations.ts`.
use std::{io, path::Path, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
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

async fn execute(mut command: Command) -> Result<Output, Error> {
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
        let out = StdCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
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
    async fn stage_honors_global_lfs_clean_filter_and_fails_when_required_filter_errors() {
        let repo = init_repo("lfs");
        let fake_home = repo.join("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        std::fs::write(repo.join(".gitattributes"), "*.bin filter=testlfs -text\n").unwrap();
        let raw = b"\x00\x01RAW-BINARY-PAYLOAD\xff";
        std::fs::write(repo.join("asset.bin"), raw).unwrap();

        let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 21\n";
        std::fs::write(
            fake_home.join(".gitconfig"),
            "[filter \"testlfs\"]\n\tclean = printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:0000\\nsize 21\\n'\n\trequired = true\n",
        )
        .unwrap();

        let mut cmd = command(&repo, &["add", "--", "asset.bin"]);
        // Lock B3 regression: `user_command::command` must never disable global/system config.
        let envs: Vec<String> = cmd.as_std().get_envs().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        for forbidden_override in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM"] {
            assert!(
                !envs.iter().any(|k| k.eq_ignore_ascii_case(forbidden_override)),
                "user_command must not set or strip {forbidden_override}"
            );
        }

        // Discover global config naturally from `$HOME/.gitconfig` without overriding `GIT_CONFIG_GLOBAL`.
        cmd.env_remove("GIT_CONFIG_GLOBAL")
            .env("HOME", &fake_home)
            .env("USERPROFILE", &fake_home)
            .env("XDG_CONFIG_HOME", fake_home.join("xdg"));
        execute(cmd).await.unwrap().mutation().unwrap();

        let staged = git(&repo, &["cat-file", "-p", ":asset.bin"]);
        assert_eq!(staged, pointer.as_bytes(), "staged blob must be the LFS pointer, not raw binary bytes");

        // When the required global filter fails, staging must fail with 409 and leave the path unindexed.
        std::fs::write(repo.join("broken.bin"), raw).unwrap();
        std::fs::write(fake_home.join(".gitconfig"), "[filter \"testlfs\"]\n\tclean = false\n\trequired = true\n")
            .unwrap();
        let mut failing = command(&repo, &["add", "--", "broken.bin"]);
        failing
            .env_remove("GIT_CONFIG_GLOBAL")
            .env("HOME", &fake_home)
            .env("USERPROFILE", &fake_home)
            .env("XDG_CONFIG_HOME", fake_home.join("xdg"));
        let err = execute(failing).await.unwrap().mutation().unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::CONFLICT);
        let listed = git(&repo, &["ls-files", "--stage", "--", "broken.bin"]);
        assert!(listed.is_empty(), "failing required filter must never index raw bytes");

        let _ = std::fs::remove_dir_all(repo);
    }
}
