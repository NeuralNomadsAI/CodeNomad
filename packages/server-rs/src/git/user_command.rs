//! Explicit commits use the host's Git hooks and signing configuration.
use std::{io, path::Path, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use super::{Output, conflict, missing_git};
use crate::Error;

pub(super) async fn run(dir: &Path, args: &[&str]) -> Result<Output, Error> {
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
    let mut child = command.spawn().map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound { missing_git() } else { conflict("Git could not start") }
    })?;
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    // Hooks and signing may legitimately take time. Drain output without
    // letting verbosity kill Git or hold the pool used by checkout reads.
    let (bytes, err, status) = tokio::try_join!(drain(out, 64 * 1024), drain(err, 32 * 1024), child.wait())
        .map_err(|_| conflict("Git outcome unavailable"))?;
    Ok(Output { code: status.code().unwrap_or(-1), bytes, err })
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
