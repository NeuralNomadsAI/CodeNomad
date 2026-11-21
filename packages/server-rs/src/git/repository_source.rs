//! Repository identity for the Mission editor. No repository contents or credentials cross this route.
use super::branches::Source;
use crate::{
    Error, Shared, error,
    shared::read_capped,
    worktrees::{fence, ownership},
};
use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::StatusCode as Status,
};
use reqwest::Url;
use serde_json::{Value, json};
use std::{path::Path as DiskPath, process::Stdio, sync::LazyLock, time::Duration};
use tokio::{process::Command, sync::Semaphore};

static SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));

pub(super) async fn read(
    State(app): State<Shared>,
    Path(id): Path<String>,
    query: Result<Query<Source>, QueryRejection>,
) -> Result<Json<Value>, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid repository directory");
    let Query(Source { directory }) = query.map_err(|_| invalid())?;
    if !(1..=4096).contains(&directory.encode_utf16().count()) {
        return Err(invalid());
    }
    let workspace = app.workspace(&id)?;
    let owned = ownership::resolve(&app, &workspace, &directory)
        .await
        .ok_or_else(|| error(Status::FORBIDDEN, "Foreign repository directory"))?;
    let identity = fence::identity(&owned.checkout);
    let _permit = fence::enter(std::slice::from_ref(&identity))
        .ok_or_else(|| error(Status::CONFLICT, "Worktree deletion pending"))?;
    let unavailable = || error(Status::SERVICE_UNAVAILABLE, "Repository discovery unavailable");
    let _slot = SLOTS.try_acquire().map_err(|_| unavailable())?;
    let result = tokio::time::timeout(Duration::from_secs(10), discover(DiskPath::new(&owned.directory)))
        .await
        .map_err(|_| unavailable())?;
    let changed = || error(Status::CONFLICT, "Repository directory changed");
    let fresh = app.workspace(&id).map_err(|_| changed())?;
    if fresh.path != workspace.path
        || fresh.location != workspace.location
        || !ownership::resolve(&app, &fresh, &directory)
            .await
            .is_some_and(|next| next.directory == owned.directory && fence::identity(&next.checkout) == identity)
    {
        return Err(changed());
    }
    Ok(Json(result))
}

async fn discover(directory: &DiskPath) -> Value {
    let unavailable = |reason| json!({"status":"unavailable","reason":reason});
    let Some(names) = read_git(directory, &["remote"]).await else { return unavailable("no_remote") };
    let mut names: Vec<_> = names.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    names.sort_by_key(|name| match *name {
        "upstream" => 0,
        "origin" => 1,
        _ => 2,
    });
    for name in names {
        let Some((host, path)) =
            read_git(directory, &["remote", "get-url", "--", name]).await.as_deref().and_then(parse)
        else {
            continue;
        };
        return match provider(&host).await {
            Some(provider) => json!({"status":"ok","repository":{"provider":provider,"host":host,"repository":path}}),
            None => unavailable("unsupported_host"),
        };
    }
    unavailable("no_remote")
}

async fn read_git(directory: &DiskPath, args: &[&str]) -> Option<String> {
    super::run(directory, args, 128 * 1024).await.ok()?.ok().ok().map(|o| o.text())
}

fn parse(raw: &str) -> Option<(String, String)> {
    let raw = crate::shared::js_trim(raw);
    let (host, path) = if let Some((scheme, _)) = raw.split_once("://")
        && ["http", "https", "ssh", "git"].iter().any(|s| s.eq_ignore_ascii_case(scheme))
    {
        let u = Url::parse(raw).ok()?;
        let mut host = u.host_str()?.to_ascii_lowercase();
        if matches!(u.scheme(), "http" | "https")
            && let Some(port) = u.port()
        {
            host.push_str(&format!(":{port}"));
        }
        (host, percent_encoding::percent_decode_str(u.path()).decode_utf8().ok()?.into_owned())
    } else {
        static SCP: LazyLock<regex::Regex> =
            LazyLock::new(|| regex::Regex::new(r"^(?:[^@/\s]+@)?([^:/\s]+):(.+)$").unwrap());
        let scp = SCP.captures(raw)?;
        let (host, path) = (&scp[1], &scp[2]);
        if host.len() == 1 && host.as_bytes()[0].is_ascii_alphabetic() || path.starts_with('/') {
            return None;
        }
        (host.to_ascii_lowercase(), path.to_owned())
    };
    // Reparse as a web authority to validate the address without accepting userinfo or URL delimiters.
    let web = Url::parse(&format!("https://{host}/")).ok()?;
    let bare = web.host_str()?;
    static DNS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$").unwrap()
    });
    if !(bare.starts_with('[') || DNS.is_match(bare))
        || !web.username().is_empty()
        || web.password().is_some()
        || web.path() != "/"
        || web.query().is_some()
        || web.fragment().is_some()
        || !(host == bare
            || host
                .strip_prefix(bare)
                .and_then(|p| p.strip_prefix(':'))
                .is_some_and(|port| (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit())))
    {
        return None;
    }
    let path = path.trim_matches('/');
    let (owner, name) = path.rsplit_once('/')?;
    let name = name
        .get(..name.len().saturating_sub(4))
        .filter(|prefix| name[prefix.len()..].eq_ignore_ascii_case(".git"))
        .unwrap_or(name);
    let path = format!("{owner}/{name}");
    path.split('/')
        .all(|s| {
            !s.is_empty()
                && !s.bytes().all(|b| b == b'.')
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
        .then_some((host, path))
}

async fn provider(host: &str) -> Option<&'static str> {
    match host {
        "github.com" => return Some("github"),
        "gitlab.com" => return Some("gitlab"),
        "codeberg.org" | "gitea.com" => return Some("gitea"),
        _ => {}
    }
    for (cli, provider) in [("gh", "github"), ("glab", "gitlab")] {
        if probe(cli, &["auth", "status", "--hostname", host], false).await.is_some() {
            return Some(provider);
        }
    }
    let tea = probe("tea", &["logins", "list", "-o", "json"], true).await?;
    let entries: Vec<Value> = serde_json::from_slice(&tea).ok()?;
    let login = entries.iter().find(|row| {
        row["url"].as_str().and_then(|s| Url::parse(s).ok()).is_some_and(|u| {
            u.host_str().is_some_and(|name| {
                u.port().map_or_else(|| name.to_owned(), |p| format!("{name}:{p}")).eq_ignore_ascii_case(host)
            })
        })
    })?;
    login["name"].as_str().filter(|s| !s.is_empty()).map(|_| "gitea")
}

async fn probe(program: &str, args: &[&str], capture: bool) -> Option<Vec<u8>> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(if capture { Stdio::piped() } else { Stdio::null() })
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().ok()?;
    let pipe = child.stdout.take();
    let (status, output) = tokio::try_join!(child.wait(), async {
        match pipe {
            Some(pipe) => read_capped(pipe, 128 * 1024).await,
            None => Ok(Vec::new()),
        }
    })
    .ok()?;
    status.success().then_some(output)
}

#[cfg(test)]
#[test]
fn reads_the_forge_identity_without_transport_credentials() {
    for (input, host, path) in [
        ("https://token:x@GitHub.COM:443/Org/Repo.git", "github.com", "Org/Repo"),
        ("ssh://git@forge.example:2222/group/sub/Repo", "forge.example", "group/sub/Repo"),
        ("http://forge.example:8080/team/Repo.GIT", "forge.example:8080", "team/Repo"),
        ("git@gitlab.com:group/Repo", "gitlab.com", "group/Repo"),
    ] {
        assert_eq!(parse(input), Some((host.into(), path.into())));
    }
    for invalid in [
        "C:/team/repo",
        "file:///team/repo",
        "https://github.com/only",
        "https://github.com/a/%25",
        "https://github.com/a/...",
    ] {
        assert!(parse(invalid).is_none(), "{invalid}");
    }
}
