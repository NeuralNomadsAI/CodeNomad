//! OpenCode installed and updated without Node or npm, in the layout `npm install --global`
//! gives it (`opencode-update/shared-installation.ts`, `service.ts`): the configured registry,
//! the platform package `@opencode/cli` would select, sha512 integrity before extraction, an
//! atomic swap under the reference's lock that keeps the previous package for a rollback, and
//! `POST /api/opencode/update`.
pub mod layout;
pub mod npmrc;
pub mod package;
pub mod plan;

use std::{path::Path, time::Duration};

use axum::{Json, Router, extract::State, http::StatusCode as Status, response::IntoResponse, routing::post};
use serde::Serialize;
use serde_json::{Value, json};

use super::{admission, launch};
use crate::{Shared, bench, settings::Kind};
use layout::Prefix;

/// A refusal with the reference's code and HTTP status (`requestError`, `statusCode`).
#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl Error {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn failed(message: impl Into<String>) -> Self {
        Self::new("upgrade_failed", message)
    }
    pub fn busy(message: impl Into<String>) -> Self {
        Self::new("installation_busy", message)
    }
    pub fn status(&self) -> Status {
        match self.code {
            "installation_busy" | "installation_in_use" | "unsupported_binary" | "legacy_replacement_required" => {
                Status::CONFLICT
            }
            "binary_unavailable" => Status::UNPROCESSABLE_ENTITY,
            "upgrade_failed" | "update_check_failed" | "upgrade_verification_failed" => Status::BAD_GATEWAY,
            _ => Status::INTERNAL_SERVER_ERROR,
        }
    }
}
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::failed(message)
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Installed {
    pub prefix: String,
    pub binary: String,
    pub version: Option<String>,
    pub previous: Option<String>,
}

/// The installation in `prefix` as discovery reads it.
pub fn installed(prefix: &Prefix) -> Installed {
    Installed {
        prefix: prefix.root.to_string_lossy().into_owned(),
        binary: prefix.binary().to_string_lossy().into_owned(),
        version: layout::version(&prefix.package()).filter(|_| prefix.binary().is_file()),
        previous: layout::version(&prefix.previous()),
    }
}

pub enum Probed {
    Version(String),
    Missing,
    Failed,
    /// Timed out or overflowed its output: unknown.
    Unknown,
}

/// `opencode --version` within `timeout` (spawn.ts `parseBinaryVersion`): the first output line,
/// its presentation prefix removed. On expiry or past 64 KiB of output the probe's whole process
/// family is ended (`boundedVersionProbe`): wrappers may start descendants.
pub async fn probe_version(binary: &str, timeout: Duration) -> Probed {
    let Ok(spec) = launch::spec(binary, &["--version"]) else { return Probed::Failed };
    let mut command = tokio::process::Command::new(&spec.command);
    #[cfg(windows)]
    for arg in &spec.args {
        if spec.verbatim {
            command.raw_arg(arg);
        } else {
            command.arg(arg);
        }
    }
    #[cfg(not(windows))]
    command.args(&spec.args);
    crate::shared::process_group::prepare(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match command.kill_on_drop(true).spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Probed::Missing,
        Err(_) => return Probed::Failed,
    };
    let Some(group) = crate::shared::process_group::Group::adopt(&mut child) else { return Probed::Failed };
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let read = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| async move {
        match stream {
            Some(stream) => crate::shared::read_capped(stream, 64 * 1024).await,
            None => Ok(Vec::new()),
        }
    };
    let (out, err) = (out.map(|s| Box::new(s) as _), err.map(|s| Box::new(s) as _));
    let finished = tokio::time::timeout(timeout, async { tokio::join!(read(out), read(err), child.wait()) }).await;
    let Ok((Ok(stdout), Ok(stderr), Ok(status))) = finished else {
        // Before the leader is reaped, so the group is still its own.
        group.kill();
        let _ = child.kill().await;
        return Probed::Unknown;
    };
    if !status.success() {
        return Probed::Failed;
    }
    let first = |b: &[u8]| String::from_utf8_lossy(b).lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_owned);
    let line = first(&stdout).or_else(|| first(&stderr)).unwrap_or_default();
    let version = line.strip_prefix("opencode2 ").or_else(|| line.strip_prefix("opencode ")).unwrap_or(&line);
    let version = version.strip_prefix('v').filter(|v| v.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(version);
    Probed::Version(version.to_owned())
}
/// The installed binary's version: `Ok(None)` when it is missing.
pub async fn probe(binary: &str) -> Result<Option<String>, ()> {
    match probe_version(binary, Duration::from_secs(5)).await {
        Probed::Version(v) => Ok(Some(v)),
        Probed::Missing => Ok(None),
        _ => Err(()),
    }
}

/// `assertExecutableWritable`: Windows cannot replace a mapped executable through npm.
fn assert_writable(binary: &Path) -> Result<(), Error> {
    if !cfg!(windows) {
        return Ok(());
    }
    match std::fs::OpenOptions::new().read(true).write(true).open(binary) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(Error::new("installation_in_use", "The OpenCode executable is in use or not writable"))
        }
        _ => Ok(()),
    }
}
/// `compareVersionStrings` for exact stable versions.
fn newer(left: &str, right: &str) -> bool {
    let parse = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(left) > parse(right)
}

/// The registry's `latest` `@opencode/cli`.
pub async fn latest(prefix: &Prefix) -> Result<String, Error> {
    let config = npmrc::Config::load(&prefix.root);
    let client = config.client()?;
    let unchecked = |e: String| Error::new("update_check_failed", e);
    package::latest(&package::packument(&client, &config, package::CLI).await.map_err(unchecked)?).map_err(unchecked)
}

/// `installSharedOpenCode(version)`: at least `version` (never a downgrade) in the planned prefix.
pub async fn install(version: &str) -> Result<Installed, Error> {
    if !package::exact(version) {
        return Err(Error::failed("Installation requires an exact stable OpenCode version"));
    }
    if admission::below_minimum(version) {
        return Err(Error::failed(
            admission::Refusal::Unsupported { actual: version.into(), reason: "native_contract" }.to_string(),
        ));
    }
    let prefix = plan::plan(false).await.prefix()?;
    let _lock = layout::lock(&prefix)?;
    if plan::plan(false).await.prefix.is_none_or(|p| p.root != prefix.root) {
        return Err(Error::failed("The OpenCode installation changed; check its status again"));
    }
    let binary = prefix.binary();
    let existing = probe(&binary.to_string_lossy()).await.ok().flatten();
    if let Some(existing) = &existing
        && !package::exact(existing)
        && !existing.starts_with("0.0.0-beta-")
    {
        return Err(Error::failed("Cannot replace an unverified OpenCode version automatically"));
    }
    let target = match &existing {
        Some(existing) if package::exact(existing) && newer(existing, version) => existing.clone(),
        _ => version.to_owned(),
    };
    let published = plan::npm_command(&prefix).is_some();
    if existing.as_deref() != Some(target.as_str()) || !published {
        // 2.0.15+ replaces its own running image (`opencode upgrade`); otherwise the reference's
        // npm reinstall needs a writable executable on Windows.
        let upgradable = existing.as_deref().is_some_and(|e| package::exact(e) && !newer("2.0.15", e) && e != target);
        if !(upgradable && published) {
            assert_writable(&binary)?;
        }
    }
    let names = if existing.as_deref() == Some(target.as_str()) {
        bin_names(&prefix.package())?
    } else {
        let staging = prefix.staging()?;
        let staged = stage(&prefix, &target, &staging).await;
        let swapped =
            staged.and_then(|names| Ok(layout::swap(&prefix, &staging.join("cli"), &staging).map(|_| names)?));
        let _ = std::fs::remove_dir_all(&staging);
        swapped?
    };
    layout::publish_commands(&prefix, &names)?;
    let verified = probe(&binary.to_string_lossy()).await.ok().flatten();
    if !verified.as_deref().is_some_and(|v| package::exact(v) && !newer(&target, v)) {
        return Err(Error::failed("Installed OpenCode version verification failed"));
    }
    if !bench::skip_user_path() {
        layout::register_path(&prefix.commands())?;
    }
    Ok(installed(&prefix))
}

/// The previous package back in place (reversible: the replaced one becomes the previous).
pub async fn rollback() -> Result<Installed, Error> {
    let prefix = plan::plan(false).await.prefix()?;
    let _lock = layout::lock(&prefix)?;
    let Some(previous) = layout::version(&prefix.previous()) else {
        return Err(Error::failed("No previous OpenCode installation to restore"));
    };
    let staging = prefix.staging()?;
    let restored = layout::roll_back(&prefix, &staging);
    let _ = std::fs::remove_dir_all(&staging);
    restored?;
    if probe(&prefix.binary().to_string_lossy()).await.ok().flatten().as_deref() != Some(previous.as_str()) {
        return Err(Error::failed("Restored OpenCode version verification failed"));
    }
    Ok(installed(&prefix))
}

fn bin_names(package: &Path) -> Result<Vec<String>, Error> {
    let manifest: Value = std::fs::read(package.join("package.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| Error::failed("Invalid OpenCode package manifest"))?;
    let bin = manifest["bin"]
        .as_object()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| Error::failed("OpenCode package does not declare a binary"))?;
    if bin.values().any(|v| v != "./bin/opencode.exe") {
        return Err(Error::failed("Unexpected OpenCode package binary"));
    }
    Ok(bin.keys().cloned().collect())
}

/// `staging/cli`: the verified `@opencode/cli@version` package.json, the first platform package
/// whose binary runs and reports `version`, nested as npm installs it, its binary linked to `bin/`.
async fn stage(prefix: &Prefix, version: &str, staging: &Path) -> Result<Vec<String>, Error> {
    let config = npmrc::Config::load(&prefix.root);
    let client = config.client()?;
    let cli = package::manifest(&package::packument(&client, &config, package::CLI).await?, package::CLI, version)?;
    let tarball = staging.join("cli.tgz");
    package::download(&client, &config, &cli, &tarball).await?;
    let root = staging.join("cli");
    let failed = |_| Error::failed("Cannot write the OpenCode package");
    std::fs::create_dir_all(root.join("bin")).map_err(failed)?;
    package::extract(&tarball, &[("package.json", &root.join("package.json"))])?;
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("package.json")).map_err(failed)?)
        .map_err(|_| Error::failed("Invalid OpenCode package manifest"))?;
    if manifest["name"] != package::CLI || manifest["version"] != version {
        return Err(Error::failed("The OpenCode package does not match its registry version"));
    }
    let names = bin_names(&root)?;
    let dependencies = manifest["optionalDependencies"].as_object().cloned().unwrap_or_default();
    let source = if cfg!(windows) { "bin/opencode.exe" } else { "bin/opencode" };
    let mut tried = Vec::new();
    for name in package::candidates(&dependencies)? {
        let Some(pinned) = dependencies[&name].as_str().filter(|v| package::exact(v)) else { continue };
        let short = name
            .strip_prefix("@opencode/")
            .filter(|s| !s.contains(['/', '\\', '.']))
            .ok_or_else(|| Error::failed("Invalid OpenCode platform package"))?;
        tried.push(name.clone());
        let attempt = async {
            let manifest = package::manifest(&package::packument(&client, &config, &name).await?, &name, pinned)?;
            let file = staging.join(format!("{short}.tgz"));
            package::download(&client, &config, &manifest, &file).await?;
            let folder = root.join("node_modules").join("@opencode").join(short);
            std::fs::create_dir_all(folder.join("bin")).map_err(|_| "Cannot write the OpenCode package".to_owned())?;
            let binary = folder.join(source);
            package::extract(&file, &[("package.json", &folder.join("package.json")), (source, &binary)])?;
            let _ = std::fs::remove_file(&file);
            layout::link_or_copy(&binary, &root.join(layout::BIN))?;
            Ok::<_, String>(())
        };
        match attempt.await {
            // A tampered package is never skipped for another one.
            Err(e) if e.starts_with("integrity_mismatch") => return Err(Error::failed(e)),
            Err(_) => continue,
            Ok(()) => {}
        }
        if probe(&root.join(layout::BIN).to_string_lossy()).await.ok().flatten().as_deref() == Some(version) {
            return Ok(names);
        }
        let _ = std::fs::remove_file(root.join(layout::BIN));
        let _ = std::fs::remove_dir_all(root.join("node_modules"));
    }
    let names = tried.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(" or ");
    Err(Error::failed(format!("Failed to install OpenCode. Try manually installing {names}.")))
}

/// One update at a time in this process (`inFlightUpgrades`); the lock fences other processes.
static UPDATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `OpenCodeUpdateService.upgrade` for the default selection.
pub async fn upgrade(app: &Shared) -> Result<String, Error> {
    let _serial = UPDATING.lock().await;
    let configured =
        app.settings.owner(Kind::Config, "server").get("opencodeBinary").and_then(Value::as_str).map(str::to_owned);
    let default =
        configured.as_deref().is_none_or(|c| c.is_empty() || c == "opencode" || c == "opencode2" || launch::retired(c));
    let (selected, source) = plan::resolve_default().await;
    let binary = launch::resolve(&selected);
    let current_plan = plan::plan(false).await;
    // A foreign command that cannot run is installed beside, never repaired.
    let foreign = current_plan.foreign.as_ref().is_some_and(|f| f.command == binary);
    let current = match probe_version(&binary, Duration::from_secs(5)).await {
        Probed::Version(v) => Some(if v.is_empty() { "unknown".into() } else { v }),
        Probed::Missing => None,
        _ if foreign => None,
        _ => return Err(Error::new("binary_unavailable", "Unable to read OpenCode version")),
    };
    let prefix = current_plan.prefix;
    let user = plan::user_prefix().ok_or_else(|| Error::failed("No user npm prefix"))?;
    let latest = latest(prefix.as_ref().unwrap_or(&user)).await?;
    if admission::below_minimum(&latest) {
        return Err(Error::new(
            "upgrade_failed",
            admission::Refusal::Unsupported { actual: latest, reason: "native_contract" }.to_string(),
        ));
    }
    let comparable = |v: &str| package::exact(v) || v.starts_with("0.0.0-beta-");
    if current.as_deref().is_some_and(|v| !comparable(v)) {
        return Err(Error::new(
            "unsupported_binary",
            "Cannot order this custom OpenCode version for an automatic update",
        ));
    }
    if let Some(current) = &current
        && !newer(&latest, current)
        && source != Some("user")
    {
        return Ok(current.clone());
    }
    if !default || launch::wsl(&binary) || prefix.is_none() {
        return Err(Error::new(
            "unsupported_binary",
            "Automatic updates require the default command and a writable npm installation",
        ));
    }
    let target = match &current {
        Some(current) if package::exact(current) && newer(current, &latest) => current.clone(),
        _ => latest.clone(),
    };
    install(&target).await?;
    let installed = probe(&launch::resolve(&plan::resolve_default().await.0)).await.ok().flatten().unwrap_or_default();
    if !package::exact(&installed) || newer(&target, &installed) {
        return Err(Error::new(
            "upgrade_verification_failed",
            format!("OpenCode reported {target}, but the configured binary is {installed} instead of {latest}"),
        ));
    }
    Ok(installed)
}

async fn update(State(app): State<Shared>) -> axum::response::Response {
    match upgrade(&app).await {
        Ok(version) => Json(json!({"success": true, "version": version})).into_response(),
        Err(e) => {
            eprintln!("Failed to update OpenCode: {}", e.message);
            (e.status(), Json(json!({"success": false, "error": e.code}))).into_response()
        }
    }
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/opencode/update", post(update))
}

/// `codenomad-rs opencode install [<version>] | rollback | status`: one JSON line, exit 1 on refusal.
pub async fn command(args: &[String]) -> i32 {
    if let [action] = args
        && action == "status"
    {
        let current = plan::plan(true).await;
        let (path, source) = plan::resolve_default().await;
        let mut status = json!({"ok": true, "plan": current.prefix.as_ref().map(|p| p.root.to_string_lossy()),
            "resolved": {"path": path, "source": source}, "installed": current.prefix.as_ref().or(plan::user_prefix().as_ref()).map(installed)});
        if let (Value::Object(status), Value::Object(notice)) = (&mut status, plan::notice(&current)) {
            status.extend(notice);
        }
        println!("{status}");
        return 0;
    }
    let result = async {
        match args {
            [action] if action == "rollback" => rollback().await,
            [action] if action == "install" => install(&latest(&plan::plan(false).await.prefix()?).await?).await,
            [action, version] if action == "install" => install(version).await,
            _ => Err(Error::failed("usage: codenomad-rs opencode install [<version>] | rollback | status")),
        }
    }
    .await;
    match result {
        Ok(installed) => {
            println!("{}", json!({"ok": true, "installed": installed}));
            0
        }
        Err(e) => {
            println!("{}", json!({"ok": false, "code": e.code, "error": e.message}));
            1
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
