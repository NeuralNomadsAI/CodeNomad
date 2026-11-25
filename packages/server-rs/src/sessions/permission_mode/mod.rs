//! Native ordered rules; only the exact block owned in the CodeNomad profile is mutable.
mod observed;
pub(super) mod routes;
mod rules;
pub(crate) use observed::{RefreshQueue, observe_fork};
pub(crate) use routes::workspace_current;

use crate::{
    App, Error, Workspace, error,
    opencode::{self, Endpoint},
    settings::Settings,
};
use axum::{
    Json,
    http::{Method, StatusCode as Status},
};
use rules::Rule;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};

const OWNER: &str = "sessionPermissionBlocks";

fn unavailable() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Conversation permissions unavailable")
}

fn conflict() -> Error {
    error(Status::CONFLICT, "Permission rules changed")
}

fn unverified() -> Error {
    (
        Status::CONFLICT,
        Json(
            json!({"error":"Cannot switch to Autonomous: CodeNomad could not verify which rules to remove. No rules were changed.","code":"PERMISSION_BLOCK_UNVERIFIED"}),
        ),
    )
}

fn current(app: &App, endpoint: &Arc<Endpoint>) -> bool {
    app.native.endpoint().is_some_and(|e| Arc::ptr_eq(&e, endpoint))
}

async fn session_lock(id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    crate::worktrees::fence::serialize(format!("permission-mode\n{id}")).await
}

pub(crate) async fn lock_patch(id: &str, input: &Value) -> Result<tokio::sync::OwnedMutexGuard<()>, Error> {
    if !input["permissions"].is_array() || rules::parse(&input["permissions"]).is_err() {
        return Err(error(Status::BAD_REQUEST, "Invalid conversation permissions"));
    }
    Ok(session_lock(id).await)
}

fn directory(session: &Value) -> Option<&str> {
    let location = session["location"].as_object()?;
    (location.len() == 1).then(|| location["directory"].as_str()).flatten()
}

fn host() -> &'static str {
    match std::env::consts::OS {
        "windows" => "host:win32",
        "macos" => "host:darwin",
        "freebsd" => "host:freebsd",
        // Rust's supported Linux targets use Node's spelling.
        _ => "host:linux",
    }
}

fn key(session: &Value) -> Result<String, Error> {
    let id = session["id"].as_str().filter(|id| opencode::valid_id(id)).ok_or_else(unavailable)?;
    let created =
        session["time"]["created"].as_u64().filter(|v| *v <= 9_007_199_254_740_991).ok_or_else(unavailable)?;
    Ok(format!("{:x}", Sha256::digest(json!([host(), id, created]).to_string().as_bytes())))
}

fn saved(settings: &Settings, key: &str) -> Result<Option<Value>, Error> {
    Ok(settings.private_state_owner(OWNER).map_err(|_| unavailable())?.remove(key))
}

fn record(session: &Value, active: &[Rule], pending: Option<&[Rule]>) -> Value {
    recorded(session, active, pending, &Value::Null)
}

fn recorded(session: &Value, active: &[Rule], pending: Option<&[Rule]>, fork: &Value) -> Value {
    json!({"active":active,"pending":pending,
        "target":{"id":session["id"],"created":session["time"]["created"],"directory":session["location"]["directory"],"distro":null},
        "child":!root(session),"fork":fork,"previous":null,"revisions":null})
}

fn root(session: &Value) -> bool {
    !session["fork"].is_null() || session["parentID"].is_null()
}
fn owns_root(session: &Value, saved: Option<&Value>) -> bool {
    root(session) && (session["fork"].is_null() || saved.is_some_and(|p| p["fork"].is_object()))
}

fn remember(settings: &Settings, key: &str, base: Option<&Value>, next: Option<Value>) -> Result<(), Error> {
    if !settings.replace_private_state(OWNER, key, base, next).map_err(|_| unavailable())? {
        return Err(conflict());
    }
    Ok(())
}

async fn config(app: &App, endpoint: &Arc<Endpoint>, dir: &str) -> Result<Vec<Rule>, Error> {
    let response = app
        .native
        .client
        .get(endpoint.url.join("/api/config").map_err(|_| unavailable())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| unavailable())?;
    let entries = opencode::read_json(response.error_for_status().map_err(|_| unavailable())?, 16 * 1024 * 1024)
        .await
        .map_err(|_| unavailable())?;
    if !current(app, endpoint) {
        return Err(unavailable());
    }
    rules::config(&entries).map_err(|_| unavailable())
}

/// Fresh roots use the profile setting; callers never infer Autonomous from unreadable settings.
pub(crate) async fn new_root(
    app: &App,
    endpoint: &Arc<Endpoint>,
    dir: &str,
    supported: bool,
) -> Result<Option<Value>, Error> {
    let ui = app.settings.raw_config_owner("ui").map_err(|_| unavailable())?;
    match ui.get("settings").and_then(|s| s.get("newConversationPermissions")) {
        None => Ok(None),
        Some(mode) if mode == "autonomous" => Ok(None),
        Some(mode) if mode == "supervised" && supported => Ok(Some(json!(config(app, endpoint, dir).await?))),
        _ => Err(unavailable()),
    }
}

/// Only a positively identified native root and the exact submitted block can
/// create private ownership. A receipt may recover a unique span, but never
/// replaces a newer record or changes current native permissions.
pub(crate) async fn confirm_root(
    app: &App,
    endpoint: &Arc<Endpoint>,
    dir: &str,
    project: &str,
    id: &str,
    block: &Value,
    recovering: bool,
    authority: impl Fn() -> bool,
) -> Result<(), Error> {
    let _lock = session_lock(id).await;
    let session = opencode::session_record_at(app, endpoint, id).await?;
    if !current(app, endpoint)
        || !authority()
        || session["projectID"] != project
        || directory(&session) != Some(dir)
        || !session["parentID"].is_null()
        || !session["fork"].is_null()
    {
        return Err(conflict());
    }
    let key = key(&session)?;
    let block = rules::parse(block).map_err(|_| unavailable())?;
    let native = rules::parse(&session["permissions"]).map_err(|_| unavailable())?;
    if !block.starts_with(&rules::start())
        || rules::positions(&native, &block).count() != 1
        || !recovering && native != block
    {
        return Err(conflict());
    }
    let prior = saved(&app.settings, &key)?;
    if recovering && prior.is_some() {
        return Ok(());
    }
    let next = record(&session, &block, None);
    if prior.as_ref() == Some(&next) {
        return Ok(());
    }
    remember(&app.settings, &key, None, Some(next))
}

#[derive(Default)]
struct Blocks {
    active: Option<Vec<Rule>>,
    pending: Option<Vec<Rule>>,
}

impl Blocks {
    fn read(raw: Option<&Value>) -> Result<Self, Error> {
        fn block(value: &Value) -> Result<Option<Vec<Rule>>, Error> {
            if value.is_null() {
                return Ok(None);
            }
            let block = rules::parse(value).map_err(|_| unavailable())?;
            if !block.starts_with(&rules::start()) {
                return Err(unavailable());
            }
            Ok(Some(block))
        }
        Ok(match raw {
            None => Self::default(),
            Some(raw) if raw.is_array() => Self { active: block(raw)?, pending: None },
            Some(raw) if raw.is_object() => Self { active: block(&raw["active"])?, pending: block(&raw["pending"])? },
            _ => return Err(unavailable()),
        })
    }

    fn span(&self, rules: &[Rule]) -> Result<Option<(usize, usize)>, ()> {
        rules::span(rules, self.active.as_deref(), self.pending.as_deref())
    }

    fn exists(&self) -> bool {
        self.active.is_some() || self.pending.is_some()
    }
}

fn maybe_supervised(rules: &[Rule]) -> bool {
    rules::positions(rules, &rules::start()).next().is_some()
}

struct Target<'a> {
    app: &'a App,
    endpoint: &'a Arc<Endpoint>,
    session: &'a Value,
    authority: &'a (dyn Fn() -> bool + Sync),
}

impl Target<'_> {
    fn check(&self) -> Result<(), Error> {
        if current(self.app, self.endpoint) && (self.authority)() { Ok(()) } else { Err(conflict()) }
    }

    async fn read(&self) -> Result<Vec<Rule>, Error> {
        self.check()?;
        let id = self.session["id"].as_str().ok_or_else(unavailable)?;
        let latest = opencode::session_record_at(self.app, self.endpoint, id).await?;
        self.check()?;
        if !["id", "projectID", "location", "parentID", "fork"].iter().all(|k| latest[k] == self.session[k])
            || latest["time"]["created"] != self.session["time"]["created"]
            || latest["metadata"].get("codenomad.schedule-carrier").is_some()
        {
            return Err(conflict());
        }
        rules::parse(&latest["permissions"]).map_err(|_| unavailable())
    }

    async fn replace(
        &self,
        original: &[Rule],
        updated: &[Rule],
        before: impl FnOnce() -> Result<(), Error>,
    ) -> Result<(), Error> {
        if self.read().await? != original {
            return Err(conflict());
        }
        self.check()?;
        let id = self.session["id"].as_str().ok_or_else(unavailable)?;
        before()?;
        self.check()?;
        let mut url = self.endpoint.url.clone();
        url.path_segments_mut().map_err(|_| unavailable())?.clear().extend(["api", "session", id]);
        let response = self
            .app
            .native
            .client
            .request(Method::PATCH, url)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .json(&json!({"permissions":updated}))
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        // A lost response may still have updated the array. Never repeat the
        // write from this request; exact readback is the only success proof.
        if self.read().await? == updated {
            Ok(())
        } else if response.is_ok_and(|r| r.status() == Status::NO_CONTENT) {
            Err(conflict())
        } else {
            Err(unavailable())
        }
    }
}

/// Called under the same project mutation lane as the ordinary mode route.
/// Unowned and copied rules still apply natively; they are never rewritten here.
pub(crate) async fn refresh_before_send(
    app: &App,
    endpoint: &Arc<Endpoint>,
    session: &Value,
    authority: impl Fn() -> bool + Sync,
) -> Result<(), Error> {
    let initial = rules::parse(&session["permissions"]).map_err(|_| unavailable())?;
    if !maybe_supervised(&initial) {
        return Ok(());
    }
    let _lock = session_lock(session["id"].as_str().ok_or_else(unavailable)?).await;
    let target = Target { app, endpoint, session, authority: &authority };
    let key = key(session)?;
    let prior = saved(&app.settings, &key)?;
    let blocks = Blocks::read(prior.as_ref())?;
    if !blocks.exists() || !root(session) && !prior.as_ref().is_some_and(|p| p["child"] == true) {
        return Ok(());
    }
    let add_only = !owns_root(session, prior.as_ref());
    let refresh = refresh_block(&target, &key, prior.as_ref(), blocks, add_only).await;
    if refresh.is_err() && add_only && !session["fork"].is_null() {
        target.read().await?;
        return Ok(());
    }
    refresh
}

async fn refresh_block(
    target: &Target<'_>,
    key: &str,
    prior: Option<&Value>,
    blocks: Blocks,
    add_only: bool,
) -> Result<(), Error> {
    let Target { app, endpoint, session, .. } = *target;
    let fork = prior.and_then(|p| p.get("fork")).unwrap_or(&Value::Null);
    let original = target.read().await?;
    let Ok(Some((i, len))) = blocks.span(&original) else { return Ok(()) };
    let known = &original[i..i + len];
    let dir = directory(session).ok_or_else(unavailable)?;
    let mut replacement = config(app, endpoint, dir).await?;
    if add_only {
        replacement.retain(|r| r.deny() && !known.contains(r));
        replacement.splice(..0, known.iter().cloned());
    } else {
        rules::project(&mut replacement, &original[..i], cfg!(windows), false).map_err(|_| unavailable())?;
    }
    if known == replacement {
        if target.read().await? != original {
            return Err(conflict());
        }
        if blocks.pending.is_some() || prior.and_then(|p| p["target"]["directory"].as_str()) != Some(dir) {
            remember(&app.settings, key, prior, Some(recorded(session, known, None, fork)))?;
        }
        return Ok(());
    }
    let updated = [&original[..i], &replacement, &original[i + len..]].concat();
    if rules::positions(&updated, &replacement).count() != 1
        || replacement.len() > len && rules::positions(&original, &replacement).any(|pos| pos == i)
        || replacement.len() < len && rules::positions(&updated, known).any(|pos| pos == i)
    {
        return Err(conflict());
    }
    // Keep both revisions if readback fails or the process dies mid-write.
    let intent = recorded(session, known, Some(&replacement), fork);
    target.replace(&original, &updated, || remember(&app.settings, key, prior, Some(intent.clone()))).await?;
    remember(&app.settings, key, Some(&intent), Some(recorded(session, &replacement, None, fork)))
}

pub(crate) async fn refresh_coordinator(
    app: &App,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    coordinator: &Value,
) -> Result<(), Error> {
    let id = coordinator["id"].as_str().ok_or_else(unavailable)?;
    let dir = directory(coordinator).ok_or_else(unavailable)?;
    let authority = || {
        current(app, endpoint)
            && workspace_current(app, workspace)
            && dunce::canonicalize(dir).as_ref().ok() == Some(&workspace.path)
    };
    let latest = opencode::session_record_at(app, endpoint, id).await?;
    if !authority()
        || latest["projectID"] != coordinator["projectID"]
        || latest["location"] != coordinator["location"]
        || !latest["parentID"].is_null()
        || latest["time"]["created"] != coordinator["time"]["created"]
    {
        return Err(conflict());
    }
    refresh_before_send(app, endpoint, &latest, authority).await?;
    if !authority() {
        return Err(conflict());
    }
    Ok(())
}

async fn mode(target: &Target<'_>, requested: Option<routes::Mode>) -> Result<routes::Mode, Error> {
    let _lock = session_lock(target.session["id"].as_str().ok_or_else(unavailable)?).await;
    mode_locked(target, requested).await
}

async fn mode_locked(target: &Target<'_>, requested: Option<routes::Mode>) -> Result<routes::Mode, Error> {
    use routes::Mode::{Autonomous, Supervised};
    target.check()?;
    let session = target.session;
    let key = key(session)?;
    let settings = &target.app.settings;
    let prior = saved(settings, &key)?;
    let blocks = Blocks::read(prior.as_ref())?;
    let original = target.read().await?;
    let fork = !session["fork"].is_null();
    let owns = owns_root(session, prior.as_ref());
    let span = if owns || requested.is_none() { blocks.span(&original) } else { Ok(None) };
    let inherited = prior.as_ref().map(|p| p["fork"]["copy"].clone()).filter(Value::is_array);
    match requested {
        None => Ok(if !matches!(span, Ok(None)) || (fork || blocks.exists()) && maybe_supervised(&original) {
            Supervised
        } else {
            Autonomous
        }),
        Some(Autonomous) => {
            if let Some((i, len)) = span.map_err(|_| unverified())? {
                let updated = [&original[..i], &original[i + len..]].concat();
                if !fork && maybe_supervised(&updated) {
                    return Err(unverified());
                }
                target.replace(&original, &updated, || Ok(())).await?;
                if prior.is_some() {
                    let keep = inherited
                        .as_ref()
                        .map(rules::parse)
                        .transpose()
                        .map_err(|_| unavailable())?
                        .map(|copy| record(session, &copy, None));
                    remember(settings, &key, prior.as_ref(), keep)?;
                }
                return Ok(if fork && maybe_supervised(&updated) { Supervised } else { Autonomous });
            } else if (fork || blocks.exists()) && maybe_supervised(&original) {
                return Err(unverified());
            }
            if prior.is_some() {
                remember(settings, &key, prior.as_ref(), None)?;
            }
            Ok(Autonomous)
        }
        Some(Supervised) => {
            if !matches!(span, Ok(None)) {
                return Ok(Supervised);
            }
            let mut block = config(target.app, target.endpoint, directory(session).ok_or_else(unavailable)?).await?;
            if !fork && rules::positions(&original, &block).next().is_some() {
                return Err(conflict());
            }
            rules::project(&mut block, &original, cfg!(windows), false).map_err(|_| unavailable())?;
            let updated = [&original, block.as_slice()].concat();
            if rules::positions(&updated, &block).count() != 1 || target.read().await? != original {
                return Err(conflict());
            }
            let copy = inherited.or_else(|| {
                if fork && !owns {
                    blocks.span(&original).ok().flatten().map(|(i, len)| json!(&original[i..i + len]))
                } else {
                    None
                }
            });
            let fork = if fork { json!({"copy":copy}) } else { Value::Null };
            target
                .replace(&original, &updated, || {
                    remember(settings, &key, prior.as_ref(), Some(recorded(session, &block, None, &fork)))
                })
                .await?;
            Ok(Supervised)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ownership_record_uses_ts_host_digest_and_preserves_neighbors() {
        let dir = crate::shared::test_dir("session-permission-state");
        let location = crate::settings::document::Location::resolve(dir.join("config.yaml").to_str().unwrap());
        let settings = Settings::new(location);
        let row = json!({"id":"ses_example","time":{"created":1720000000000u64},"location":{"directory":"/example"}});
        let key = key(&row).unwrap();
        if cfg!(windows) {
            assert_eq!(key, "33b142eb4201b28712a3fe69aa7b911bbb8f3893f4abe8e5cbf3ad8491cebeaa");
        }
        std::fs::write(&settings.location.state, "ui:\n  keep: true\nsessionPermissionBlocks:\n  other: [unchanged]\n")
            .unwrap();
        let created = record(&row, &rules::start(), None);
        remember(&settings, &key, None, Some(created.clone())).unwrap();
        assert_eq!(saved(&settings, &key).unwrap(), Some(created.clone()));
        assert!(Blocks::read(Some(&created)).unwrap().exists());
        assert!(remember(&settings, &key, None, None).is_err());
        assert_eq!(settings.private_state_owner(OWNER).unwrap()["other"], json!(["unchanged"]));
        assert_eq!(settings.private_state_owner("ui").unwrap()["keep"], true);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
