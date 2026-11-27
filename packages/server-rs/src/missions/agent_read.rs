//! Missions agent project read bridge command (reference `mission-agent-read.ts`, `project-read-tool.ts`).
use super::{
    bridge::{current_root, find},
    configuration,
    creation_admission::Scope,
    recurrence_contract::{
        PANEL_PAGE_BYTES, PANEL_REQUEST_BYTES, SAFE, bytes, rid, same_location, units,
    },
    recurrence_selector,
    run::{bad, foreign, held, playbook_details},
};
use crate::{App, Error, shared::read_capped, worktrees::fence};
use axum::http::Method;
use reqwest::Url;
use serde_json::{Map, Value, json};
use std::{path::Path, process::Stdio, sync::LazyLock, time::Duration};
use tokio::{process::Command, sync::Semaphore};

const MAX_PLAYBOOK_CHARS: usize = 100_000;
const CONTENT_SECTIONS: [&str; 10] = [
    "summary",
    "objective",
    "notes",
    "evidence",
    "next",
    "brief",
    "artifact",
    "achieved",
    "ongoing",
    "obstacles",
];
static REPO_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));

fn obj_keys(o: &Map<String, Value>, allowed: &[&str], required: &[&str]) -> bool {
    o.keys().all(|k| allowed.contains(&k.as_str())) && required.iter().all(|k| o.contains_key(*k))
}

fn counter(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= SAFE)
}

fn digest43(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')))
}

fn opt(o: &Map<String, Value>, key: &str, check: impl Fn(&Value) -> bool) -> bool {
    o.get(key).is_none_or(check)
}

fn sized(v: &Value, min: usize, max: usize) -> bool {
    v.as_str().is_some_and(|s| (min..=max).contains(&units(s)))
}

fn valid_window(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|w| obj_keys(w, &["offset", "order"], &["offset"]) && counter(&w["offset"]) && opt(w, "order", digest43))
}

fn valid_cursor(v: &Value) -> bool {
    v.as_object().is_some_and(|c| {
        obj_keys(c, &["digest", "index", "offset"], &["digest", "index", "offset"])
            && digest43(&c["digest"])
            && counter(&c["index"])
            && counter(&c["offset"])
    })
}

fn normalize_task_request(v: &mut Value) -> bool {
    let Some(t) = v.as_object_mut() else { return false };
    let list = |v: &Value, max: usize| v.as_array().is_some_and(|a| a.len() <= 50 && a.iter().all(|x| sized(x, 1, max)));
    let Some(mid) = t.get("missionID").and_then(Value::as_str).map(|s| s.trim().to_owned()) else { return false };
    if !(1..=100).contains(&units(&mid)) {
        return false;
    }
    t.insert("missionID".into(), Value::String(mid));
    let ok = obj_keys(t, &["missionID", "order", "offset", "attention", "keys", "ids", "reportIds"], &["missionID"])
        && opt(t, "order", |v| sized(v, 1, 64))
        && opt(t, "offset", counter)
        && opt(t, "attention", counter)
        && opt(t, "keys", |v| list(v, 64))
        && opt(t, "ids", |v| list(v, 240))
        && opt(t, "reportIds", |v| list(v, 240));
    let named = ["keys", "ids", "reportIds"].iter().any(|k| t.contains_key(*k));
    ok && [t.contains_key("offset"), t.contains_key("attention"), named].iter().filter(|x| **x).count() == 1
}

/// Validates and normalizes `missionPanelPageRequestSchema` across all 7 panel sources.
fn parse_panel_request(raw: &Value) -> Option<Value> {
    let mut input = raw.clone();
    let source = input["source"].as_str()?.to_owned();
    let s = input.as_object_mut()?;
    let ok = match source.as_str() {
        "summaries" => {
            obj_keys(s, &["source", "window", "initial", "cursor"], &["source"])
                && opt(s, "window", valid_window)
                && opt(s, "initial", |v| *v == true)
                && opt(s, "cursor", valid_cursor)
        }
        "cleanups" => {
            obj_keys(s, &["source", "window", "cursor"], &["source"])
                && opt(s, "window", valid_window)
                && opt(s, "cursor", valid_cursor)
        }
        "mission" => {
            obj_keys(
                s,
                &["source", "missionID", "field", "part", "text", "header", "window", "cursor"],
                &["source", "missionID"],
            ) && sized(&s["missionID"], 1, 100)
                && opt(s, "field", |f| {
                    f.as_str().is_some_and(|f| {
                        !f.is_empty()
                            && f.len() <= 64
                            && f.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
                            && f.bytes().all(|b| b.is_ascii_alphanumeric())
                    })
                })
                && opt(s, "part", |p| p == "receipts" || p == "pending")
                && opt(s, "text", |t| *t == true)
                && opt(s, "header", |h| *h == true)
                && opt(s, "window", valid_window)
                && opt(s, "cursor", valid_cursor)
                && (!s.contains_key("header") || !s.contains_key("field") && !s.contains_key("window"))
                && (!s.contains_key("part") || s.get("field").is_some_and(|f| f == "control") && !s.contains_key("header"))
                && (!s.contains_key("text") || s.contains_key("field") && s.contains_key("window") && !s.contains_key("header"))
        }
        "tasks" => {
            obj_keys(s, &["source", "task", "cursor"], &["source", "task"])
                && opt(s, "cursor", valid_cursor)
                && s.get_mut("task").is_some_and(normalize_task_request)
        }
        "activity" => {
            obj_keys(s, &["source", "missionID", "actorOffset", "actorOrder", "cursor"], &["source", "missionID"])
                && sized(&s["missionID"], 1, 100)
                && opt(s, "actorOffset", counter)
                && opt(s, "actorOrder", digest43)
                && opt(s, "cursor", valid_cursor)
        }
        "marks" => {
            obj_keys(s, &["source", "missionOffset", "missionOrder", "cursor"], &["source"])
                && opt(s, "missionOffset", counter)
                && opt(s, "missionOrder", digest43)
                && opt(s, "cursor", valid_cursor)
        }
        "task-marks" => {
            obj_keys(s, &["source", "missionID", "window", "cursor"], &["source", "missionID", "window"])
                && sized(&s["missionID"], 1, 100)
                && valid_window(&s["window"])
                && opt(s, "cursor", valid_cursor)
        }
        _ => false,
    };
    (ok && bytes(&input) <= PANEL_REQUEST_BYTES).then_some(input)
}

fn parse_current_input(raw: &Value) -> Option<Value> {
    let o = raw.as_object()?;
    if !obj_keys(o, &["scheduleID", "owner"], &["scheduleID"]) {
        return None;
    }
    let schedule_id = o["scheduleID"].as_str().filter(|s| rid(s))?;
    if !opt(o, "owner", |v| v == "scheduled") {
        return None;
    }
    Some(json!({ "scheduleID": schedule_id, "owner": "scheduled" }))
}

fn parse_current_content_input(raw: &Value) -> Option<Value> {
    let o = raw.as_object()?;
    if !obj_keys(
        o,
        &["scheduleID", "owner", "passageID", "kind", "itemId", "section", "page", "revision"],
        &["scheduleID", "passageID", "kind"],
    ) {
        return None;
    }
    let schedule_id = o["scheduleID"].as_str().filter(|s| rid(s))?;
    let passage_id = o["passageID"].as_str().filter(|s| rid(s))?;
    if !opt(o, "owner", |v| v == "scheduled") {
        return None;
    }
    let kind = o["kind"].as_str().filter(|k| matches!(*k, "overview" | "task" | "report" | "change"))?;
    let item_id = match o.get("itemId") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| (1..=240).contains(&units(s)))?),
    };
    if (kind == "overview") != item_id.is_none() {
        return None;
    }
    let section = match o.get("section") {
        None => "summary",
        Some(v) => v.as_str().filter(|s| CONTENT_SECTIONS.contains(s))?,
    };
    let page = match o.get("page") {
        None => 0,
        Some(v) => v.as_u64().filter(|n| *n <= SAFE)?,
    };
    let revision = match o.get("revision") {
        None => None,
        Some(v) => Some(v.as_u64().filter(|n| (1..=SAFE).contains(n))?),
    };
    let mut out = json!({
        "scheduleID": schedule_id,
        "owner": "scheduled",
        "passageID": passage_id,
        "kind": kind,
        "section": section,
        "page": page,
    });
    if let Some(id) = item_id {
        out["itemId"] = json!(id);
    }
    if let Some(rev) = revision {
        out["revision"] = json!(rev);
    }
    Some(out)
}

async fn read_git(directory: &Path, args: &[&str]) -> Option<String> {
    crate::git::run(directory, args, 128 * 1024).await.ok()?.ok().ok().map(|o| o.text())
}

fn parse_remote_url(raw: &str) -> Option<(String, String)> {
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

async fn probe_cli(program: &str, args: &[&str], capture: bool) -> Option<Vec<u8>> {
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

async fn detect_provider(host: &str) -> Option<&'static str> {
    match host {
        "github.com" => return Some("github"),
        "gitlab.com" => return Some("gitlab"),
        "codeberg.org" | "gitea.com" => return Some("gitea"),
        _ => {}
    }
    for (cli, provider) in [("gh", "github"), ("glab", "gitlab")] {
        if probe_cli(cli, &["auth", "status", "--hostname", host], false).await.is_some() {
            return Some(provider);
        }
    }
    let tea = probe_cli("tea", &["logins", "list", "-o", "json"], true).await?;
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

async fn discover_repository(directory: &Path) -> Value {
    let unavailable = |reason| json!({ "status": "unavailable", "reason": reason });
    let Some(names) = read_git(directory, &["remote"]).await else { return unavailable("no_remote") };
    let mut names: Vec<_> = names.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    names.sort_by_key(|name| match *name {
        "upstream" => 0,
        "origin" => 1,
        _ => 2,
    });
    for name in names {
        let Some((host, path)) =
            read_git(directory, &["remote", "get-url", "--", name]).await.as_deref().and_then(parse_remote_url)
        else {
            continue;
        };
        return match detect_provider(&host).await {
            Some(provider) => {
                json!({ "status": "ok", "repository": { "provider": provider, "host": host, "repository": path } })
            }
            None => unavailable("unsupported_host"),
        };
    }
    unavailable("no_remote")
}

pub(super) async fn read(app: &App, scope: Scope, co: Value, input: Value) -> Result<Value, Error> {
    let o = input.as_object().ok_or_else(bad)?;
    let kind = o.get("kind").and_then(Value::as_str).ok_or_else(bad)?;

    if kind == "playbook" {
        if !obj_keys(o, &["kind", "template", "taskMode"], &["kind", "template"]) {
            return Err(bad());
        }
        let template = o["template"].as_str().filter(|t| configuration::TEMPLATES.contains(t)).ok_or_else(bad)?;
        let task_mode = match o.get("taskMode") {
            None => "native",
            Some(v) => v.as_str().filter(|m| matches!(*m, "native" | "independent")).ok_or_else(bad)?,
        };
        let details = playbook_details(task_mode);
        let playbook = find(details, "playbooks", "id", template).ok_or_else(bad)?;
        let result = json!({ "taskMode": details["taskMode"], "playbook": playbook });
        scope.refresh(app).await?;
        current_root(app, &scope, &co).await?;
        if serde_json::to_string_pretty(&result).map_or(usize::MAX, |s| units(&s)) > MAX_PLAYBOOK_CHARS {
            return Err(held());
        }
        return Ok(result);
    }

    let _permit = scope.permit().ok_or_else(held)?;
    let current = || async {
        scope.refresh(app).await?;
        current_root(app, &scope, &co).await?;
        Ok::<(), Error>(())
    };
    current().await?;

    if kind == "sources" {
        if !obj_keys(o, &["kind", "source", "cursor", "search"], &["kind", "source"]) {
            return Err(bad());
        }
        let source = o["source"]
            .as_str()
            .filter(|s| matches!(*s, "branches" | "conversations" | "coordinators" | "repository"))
            .ok_or_else(bad)?;
        let cursor = match o.get("cursor") {
            None => None,
            Some(v) => Some(v.as_str().filter(|s| (1..=4096).contains(&units(s))).ok_or_else(bad)?),
        };
        let search = match o.get("search") {
            None => None,
            Some(v) => Some(v.as_str().filter(|s| units(s) <= 200).ok_or_else(bad)?),
        };
        if !matches!(source, "conversations" | "coordinators") && (cursor.is_some() || search.is_some()) {
            return Err(bad());
        }
        if matches!(source, "conversations" | "coordinators") {
            let mut query: Vec<(&str, &str)> = Vec::new();
            if let Some(c) = cursor {
                query.push(("cursor", c));
            } else {
                query.push(("directory", scope.dir.as_str()));
                query.push(("limit", "50"));
                query.push(("order", "desc"));
                if let Some(s) = search {
                    query.push(("search", s));
                }
                if source == "coordinators" {
                    query.push(("parentID", "null"));
                }
            }
            let (status, page) = scope.request(app, Method::GET, "/api/session", &query, None, 10, 2 * 1024 * 1024).await?;
            current().await?;
            let rows = page["data"]
                .as_array()
                .filter(|rows| status.is_success() && page["cursor"].is_object() && rows.len() <= 50)
                .ok_or_else(held)?;
            let sources: Vec<Value> = rows
                .iter()
                .filter(|row| {
                    row["id"].as_str().is_some_and(|id| !id.starts_with("ses_cn_schedule_"))
                        && row["projectID"] == co["projectID"]
                        && row["location"] == co["location"]
                        && (source != "coordinators" || row["parentID"].is_null())
                })
                .map(|row| json!({ "id": row["id"], "title": row["title"] }))
                .collect();
            return Ok(json!({ "sources": sources, "next": page["cursor"]["next"] }));
        }
        let checkout = Path::new(&scope.dir);
        let result = if source == "branches" {
            let refs = crate::git::run(
                checkout,
                &["for-each-ref", "--count=201", "--sort=refname", "--format=%(refname)", "refs/heads/"],
                256 * 1024,
            )
            .await?
            .ok()?
            .text();
            let branches: Vec<&str> = refs.lines().filter(|r| !r.is_empty()).collect();
            if branches.len() > 200 || branches.iter().any(|r| !r.starts_with("refs/heads/") || units(r) > 1024) {
                return Err(held());
            }
            json!({ "branches": branches })
        } else {
            let _slot = REPO_SLOTS.try_acquire().map_err(|_| held())?;
            tokio::time::timeout(Duration::from_secs(10), discover_repository(checkout))
                .await
                .map_err(|_| held())?
        };
        current().await?;
        return Ok(result);
    }

    if !obj_keys(o, &["kind", "input"], &["kind", "input"]) {
        return Err(bad());
    }
    let inner = &o["input"];
    let (method, normalized) = match kind {
        "panel" => ("panelPage", parse_panel_request(inner).ok_or_else(bad)?),
        "current" => ("recurrenceCurrent", parse_current_input(inner).ok_or_else(bad)?),
        "current-page" => ("recurrenceCurrentPage", recurrence_selector::page_input(inner).ok_or_else(bad)?),
        "current-content" => ("recurrenceCurrentContent", parse_current_content_input(inner).ok_or_else(bad)?),
        _ => return Err(bad()),
    };
    let (status, response) = scope.call(app, method, &normalized, 15, 128 * 1024).await?;
    if !status.is_success() {
        return Err(held());
    }
    let value = response.get("output").cloned().ok_or_else(held)?;
    current().await?;
    if bytes(&value) > PANEL_PAGE_BYTES {
        return Err(held());
    }
    if value["available"] != false && value["projectID"] != co["projectID"] {
        return Err(foreign());
    }
    if let Some(canonical) = value.get("projectCanonical")
        && canonical.as_str().map(fence::normalize).as_deref() != Some(scope.canonical.as_str())
    {
        return Err(foreign());
    }
    if let Some(location) = value.get("location")
        && !same_location(location, &scope.dir)
    {
        return Err(foreign());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::RawQuery, http::StatusCode};

    #[test]
    fn panel_and_current_schemas_validate_all_sources_and_refinements() {
        assert!(parse_panel_request(&json!({"source":"summaries","initial":true})).is_some());
        assert!(parse_panel_request(&json!({"source":"cleanups"})).is_some());
        assert!(parse_panel_request(&json!({"source":"marks","missionOffset":0})).is_some());
        assert!(parse_panel_request(&json!({"source":"task-marks","missionID":"msn_1","window":{"offset":0}})).is_some());
        assert!(parse_panel_request(&json!({"source":"task-marks","missionID":"msn_1"})).is_none());
        assert!(parse_panel_request(&json!({"source":"mission","missionID":"msn_1","header":true,"field":"body"})).is_none());
        assert!(parse_panel_request(&json!({"source":"mission","missionID":"msn_1","field":"control","part":"pending"})).is_some());
        assert!(parse_panel_request(&json!({"source":"mission","missionID":"msn_1","field":"body","part":"pending"})).is_none());

        assert_eq!(
            parse_current_input(&json!({"scheduleID":"rcs_123"})),
            Some(json!({"scheduleID":"rcs_123","owner":"scheduled"}))
        );
        assert!(parse_current_content_input(&json!({"scheduleID":"rcs_123","passageID":"rcp_1","kind":"overview"})).is_some());
        assert!(parse_current_content_input(&json!({"scheduleID":"rcs_123","passageID":"rcp_1","kind":"overview","itemId":"x"})).is_none());
        assert!(parse_current_content_input(&json!({"scheduleID":"rcs_123","passageID":"rcp_1","kind":"task","itemId":"tsk_1"})).is_some());
        assert!(parse_current_content_input(&json!({"scheduleID":"rcs_123","passageID":"rcp_1","kind":"task"})).is_none());
    }

    #[test]
    fn remote_url_parser_strips_credentials_and_rejects_local_paths() {
        assert_eq!(
            parse_remote_url("https://tok:sec@GitHub.COM/Org/Repo.git"),
            Some(("github.com".into(), "Org/Repo".into()))
        );
        assert_eq!(
            parse_remote_url("git@gitlab.com:group/sub/Repo.git"),
            Some(("gitlab.com".into(), "group/sub/Repo".into()))
        );
        assert!(parse_remote_url("C:/team/repo").is_none());
        assert!(parse_remote_url("file:///team/repo").is_none());
    }

    #[tokio::test]
    async fn playbooks_route_respects_task_mode_and_rejects_invalid_queries() {
        let default = super::super::run::playbooks(RawQuery(None)).await.unwrap();
        let default_body: Value =
            serde_json::from_slice(&axum::body::to_bytes(default.into_body(), 1024 * 1024).await.unwrap()).unwrap();
        assert_eq!(default_body["taskMode"], "native");

        let independent = super::super::run::playbooks(RawQuery(Some("taskMode=independent".into()))).await.unwrap();
        let independent_body: Value =
            serde_json::from_slice(&axum::body::to_bytes(independent.into_body(), 1024 * 1024).await.unwrap()).unwrap();
        assert_eq!(independent_body["taskMode"], "independent");
        assert_eq!(independent_body["playbooks"].as_array().map(Vec::len), Some(5));

        for bad_query in ["taskMode=other", "foo=bar", "taskMode=native&taskMode=independent"] {
            let err = super::super::run::playbooks(RawQuery(Some(bad_query.into()))).await.unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "{bad_query}");
            assert_eq!(err.1.0, json!({"error":"Invalid playbook request"}), "{bad_query}");
        }
    }
}
