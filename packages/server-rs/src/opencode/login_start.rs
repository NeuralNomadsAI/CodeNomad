use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::StatusCode as Status,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Error, Shared, auth::Principal, error};

#[cfg(windows)]
#[path = "login_start_windows.rs"]
mod platform;
#[cfg(unix)]
#[path = "login_start_posix.rs"]
mod platform;

const DESCRIPTION: &str = "CodeNomad: start OpenCode at login";
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Launch {
    command: String,
    args: Vec<String>,
}

#[derive(Debug, PartialEq)]
enum Failure {
    Unavailable,
    Unsupported,
    Failed,
}

impl From<Failure> for Error {
    fn from(value: Failure) -> Self {
        let (status, name) = match value {
            Failure::Unavailable => (Status::SERVICE_UNAVAILABLE, "login-start-unavailable"),
            Failure::Unsupported => (Status::UNPROCESSABLE_ENTITY, "login-start-unsupported-binary"),
            Failure::Failed => (Status::INTERNAL_SERVER_ERROR, "login-start-failed"),
        };
        error(status, name)
    }
}

async fn selection(app: &crate::App) -> String {
    if let Some(binary) = super::launch::custom_binary(&app.settings) {
        return binary;
    }
    super::launch::resolve(&super::install::plan::resolve_default().await.0)
}

fn executable(selected: &str) -> Result<Launch, Failure> {
    use std::path::Path;
    #[cfg(windows)]
    if super::launch::wsl(selected) {
        return platform::wsl_launch(selected);
    }
    let command = super::launch::spec(selected, &["serve", "--service"]).map_err(|_| Failure::Unsupported)?;
    let path = Path::new(&command.command);
    if !path.is_absolute()
        || command.verbatim
        || cfg!(windows) && !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        || !path.is_file()
    {
        return Err(Failure::Unsupported);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !path.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0) {
            return Err(Failure::Unsupported);
        }
    }
    Ok(Launch { command: command.command, args: command.args })
}

#[cfg(all(windows, test))]
#[path = "login_start_posix.rs"]
#[allow(dead_code)]
mod posix_artifacts;

fn status(on: bool) -> Json<Value> {
    Json(json!({"state":if on { "on" } else { "off" }}))
}

pub(super) async fn read() -> Result<Json<Value>, Error> {
    let Some(owner) = platform::Owner::host() else { return Ok(Json(json!({"state":"unavailable"}))) };
    let _guard = SERIAL.lock().await;
    Ok(status(owner.installed().await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    enabled: bool,
}

pub(super) async fn set(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    input: Result<Json<Input>, JsonRejection>,
) -> Result<Json<Value>, Error> {
    let Json(input) = input.map_err(|_| error(Status::BAD_REQUEST, "login-start-input-invalid"))?;
    if !app.auth.human(&principal) {
        return Err(error(Status::UNAUTHORIZED, "login-start-human-required"));
    }
    let owner = platform::Owner::host().ok_or(Failure::Unavailable)?;
    let _guard = SERIAL.lock().await;
    principal.live()?;
    if input.enabled {
        let selected = selection(&app).await;
        owner.install(&executable(&selected)?).await?;
    } else {
        owner.remove().await?;
    }
    Ok(status(owner.installed().await?))
}

pub(crate) fn refresh(app: &Shared) {
    let Some(owner) = platform::Owner::host() else { return };
    let app = app.clone();
    tokio::spawn(async move {
        let _guard = SERIAL.lock().await;
        if owner.installed().await == Ok(true) {
            if let Ok(launch) = executable(&selection(&app).await) {
                let _ = owner.install(&launch).await;
            }
        }
    });
}

async fn command(mut cmd: tokio::process::Command, seconds: u64) -> Result<String, Failure> {
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|_| Failure::Failed)?;
    let out = child.stdout.take().ok_or(Failure::Failed)?;
    let (bytes, status) = tokio::time::timeout(std::time::Duration::from_secs(seconds), async {
        tokio::try_join!(crate::shared::read_capped(out, 64 * 1024), child.wait())
    })
    .await
    .map_err(|_| Failure::Failed)?
    .map_err(|_| Failure::Failed)?;
    if !status.success() {
        return Err(Failure::Failed);
    }
    Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
}

fn install_file(file: &std::path::Path, bytes: &[u8]) -> Result<(), Failure> {
    use std::io::Write;
    let dir = file.parent().ok_or(Failure::Failed)?;
    std::fs::create_dir_all(dir).map_err(|_| Failure::Failed)?;
    let temporary = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut target =
        std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| Failure::Failed)?;
    let result = target.write_all(bytes).and_then(|_| target.sync_all());
    drop(target);
    let result = result.and_then(|_| std::fs::rename(&temporary, file));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| Failure::Failed)
}
