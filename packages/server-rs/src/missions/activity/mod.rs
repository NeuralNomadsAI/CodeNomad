//! `POST /api/workspaces/:id/missions/panel-page` for the live sources
//! `activity` and `marks` (reference `readMissionPanelObservation` in
//! `missions/mission-panel-observation.ts`, called by `server/routes/missions.ts`).
//! The native plugin returns persisted context; this backend observes the
//! declared actors natively and pages the result with the panel transport.
mod context;
mod family;
mod native;
pub mod ojson;
mod project;

use crate::{Shared, missions::reads, files};
use axum::{
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use native::{Observer, same};
use ojson::{J, PAGE_BYTES, obj, utf16_len};
use serde_json::Value;
use std::{collections::HashSet, path::Path, sync::{Arc, atomic::Ordering}, time::Duration};
use tokio::time::Instant;

const OBSERVATION: Duration = Duration::from_secs(15);
const ASSEMBLY: u64 = 24 * 1024 * 1024;

fn json(status: Status, body: &J) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], body.stringify()).into_response()
}
fn refusal(reason: &str) -> Response {
    json(Status::OK, &obj(vec![("available", J::Bool(false)), ("reason", J::s(reason))]))
}
/// Invalid plugin data: the reference's foreign-snapshot answer.
fn foreign() -> Response {
    reads::unavailable(Status::BAD_GATEWAY, "plugin-unavailable")
}

async fn rpc(app: &crate::App, endpoint: &crate::opencode::Endpoint, dir: &str, input: &Value) -> Result<J, ()> {
    let url = endpoint.url.join("/api/rpc/codenomad.missions/panelPage").map_err(|_| ())?;
    let mut response = app
        .native
        .client
        .post(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .json(&serde_json::json!({ "input": input }))
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if body.len() + chunk.len() > PAGE_BYTES + 4096 {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    ojson::parse(&body).ok_or(())
}

/// Header fields compared across continuations: `passage` by JSON, the rest by identity.
fn same_header(a: &[(String, J)], b: &[(String, J)]) -> bool {
    a.len() == b.len()
        && a.iter().all(|(k, v)| {
            b.iter().find(|(key, _)| key == k).is_some_and(|(_, w)| {
                if k == "passage" { v == w } else { !matches!(v, J::O(_) | J::A(_)) && v == w }
            })
        })
}

pub async fn panel(app: Shared, id: String, input: Value) -> Response {
    let Some(request) = context::request(&input) else {
        return json(Status::BAD_REQUEST, &obj(vec![("available", J::Bool(false)), ("reason", J::s("invalid-request"))]));
    };
    let generation = app.inner.lock().unwrap().generation;
    let opened = match reads::open(&app, &id).await {
        Ok(opened) => opened,
        Err(refused) => return refused,
    };
    let source = if request.activity { "activity" } else { "marks" };

    // Persisted context, in digest-pinned slices of one exact text.
    let mut cursor: Option<J> = None;
    let (mut text, mut length) = (String::new(), 0u64);
    let (mut header, mut digest, mut characters): (Option<Vec<(String, J)>>, Option<String>, Option<u64>) = (None, None, None);
    loop {
        if !opened.display.load(Ordering::Relaxed)
            || !app.native.endpoint().is_some_and(|p| Arc::ptr_eq(&p, &opened.endpoint)) {
            return refusal("observation-unavailable");
        }
        let mut call = input.clone();
        call.as_object_mut().unwrap().remove("cursor");
        if let Some(c) = &cursor {
            call["cursor"] = serde_json::from_str(&c.stringify()).unwrap();
        }
        let Ok(output) = rpc(&app, &opened.endpoint, &opened.dir, &call).await else {
            return reads::unavailable(Status::OK, "plugin-unavailable");
        };
        let Some(result) = output.get("output") else { return foreign() };
        if !context::page_result(result) || result.stringify().len() > PAGE_BYTES {
            return foreign();
        }
        if result.get("available") == Some(&J::Bool(false)) {
            return json(Status::OK, result);
        }
        let page = result.get("page").unwrap();
        let page_digest = page.get("digest").and_then(J::str).unwrap().to_owned();
        let digest = digest.get_or_insert_with(|| page_digest.clone()).clone();
        let pieces = page.get("pieces").and_then(J::arr).unwrap();
        if result.get("projectID").and_then(J::str) != Some(opened.project.as_str())
            || result.get("source").and_then(J::str) != Some(source)
            || result.get("phase").and_then(J::str) != Some("context")
            || result.get("missionID").and_then(J::str) != request.mission.as_deref()
            || result.get("field").is_some()
            || result.get("observedAt").is_some()
            || result.get("revision").is_some() != request.activity
            || context::DAMAGE.iter().any(|f| result.get(f).is_none())
            || page.get("total").and_then(J::count) != Some(1)
            || pieces.is_empty()
            || page_digest != digest
        {
            return foreign();
        }
        let own: Vec<(String, J)> = result
            .obj()
            .unwrap()
            .iter()
            .filter(|(k, _)| !matches!(k.as_str(), "page" | "available" | "version"))
            .cloned()
            .collect();
        if header.as_ref().is_some_and(|h| !same_header(&own, h)) {
            return foreign();
        }
        header.get_or_insert(own);
        for piece in pieces {
            let n = |k| piece.get(k).and_then(J::count).unwrap_or(u64::MAX);
            let chunk = piece.get("text").and_then(J::str).unwrap_or_default();
            let total = *characters.get_or_insert(n("characters"));
            let size = utf16_len(chunk) as u64;
            if n("index") != 0 || n("offset") != length || total > ASSEMBLY || n("characters") != total || size == 0 || length + size > total {
                return foreign();
            }
            text.push_str(chunk);
            length += size;
        }
        cursor = page.get("next").cloned();
        match &cursor {
            Some(next) => {
                let n = |k| next.get(k).and_then(J::count);
                if next.get("digest").and_then(J::str) != Some(digest.as_str())
                    || n("index") != Some(0)
                    || n("offset") != Some(length)
                    || length >= characters.unwrap()
                {
                    return foreign();
                }
            }
            None if Some(length) != characters => return foreign(),
            None => break,
        }
    }
    let header = header.unwrap();
    if ojson::content_digest(&format!("[{text}]")) != digest.unwrap() {
        return foreign();
    }
    let Some(parsed) = ojson::parse(text.as_bytes()) else { return foreign() };
    let (contexts, mission_page) = if request.activity {
        match context::context(&parsed) {
            Some(c) => (vec![c], None),
            None => return foreign(),
        }
    } else {
        match context::marks(&parsed) {
            Some(m) => (m.get("contexts").and_then(J::arr).unwrap().to_vec(), m.get("missionPage").cloned()),
            None => return foreign(),
        }
    };
    let field = |v: &J, k: &str| v.get(k).cloned();
    let count = |v: &J, path: &[&str]| path.iter().try_fold(v, |v, k| v.get(k)).and_then(J::count);
    let actor_total: usize = contexts.iter().map(|c| c.get("actors").and_then(J::arr).map_or(0, <[_]>::len)).sum();
    let header_value = |k: &str| header.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    let foreign_actors = contexts.iter().any(|c| c.get("projectID").and_then(J::str) != Some(opened.project.as_str()))
        || actor_total > context::ACTIVITY_ACTORS
        || request.activity && {
            let c = &contexts[0];
            let total = count(c, &["actorPage", "total"]).unwrap_or(0);
            c.get("id").and_then(J::str) != request.mission.as_deref()
                || field(c, "revision") != header_value("revision")
                || count(c, &["actorPage", "offset"]) != Some(request.offset.unwrap_or(0).min(total))
                || request.order.as_deref().is_some_and(|o| c.get("actorPage").and_then(|p| p.get("order")).and_then(J::str) != Some(o))
                || context::DAMAGE.iter().any(|k| field(c, k) != header_value(k))
        }
        || !request.activity && {
            let p = mission_page.as_ref().unwrap();
            let total = p.get("total").and_then(J::count).unwrap_or(0);
            p.get("offset").and_then(J::count) != Some(request.offset.unwrap_or(0).min(total))
                || request.order.as_deref().is_some_and(|o| p.get("order").and_then(J::str) != Some(o))
                || contexts.iter().any(|c| count(c, &["actorPage", "offset"]) != Some(0))
        };
    if foreign_actors {
        return foreign();
    }
    let Some(missions) = contexts.iter().map(project::Mission::read).collect::<Option<Vec<_>>>() else {
        return foreign();
    };
    let crate::missions::reads::Opened { slot, workspace, initial, .. } = opened;
    drop(slot);

    // Currentness of this read's view: workspace record and Location, physical
    // identities of the owned and actor directories, and the native connection.
    let directories: Vec<(String, Option<String>)> = missions
        .iter()
        .flat_map(|m| m.actors.iter().map(|a| a.location.directory.clone()))
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|d| {
            let identity = files::host_identity(Path::new(&d)).ok();
            (d, identity)
        })
        .collect();
    let displays: Vec<_> = directories.iter().map(|(d, _)| crate::worktrees::fence::capture_display(d)).collect();
    let current = || {
        app.workspace(&id).is_ok_and(|w| {
            w.path == workspace.path && w.location == workspace.location && w.created_at == workspace.created_at
        }) && files::host_identity(&workspace.path).ok() == initial
            && directories.iter().all(|(d, i)| files::host_identity(Path::new(d)).ok() == *i)
            && opened.display.load(Ordering::Relaxed)
            && displays.iter().all(|d| d.load(Ordering::Relaxed))
            && app.native.endpoint().is_some_and(|p| Arc::ptr_eq(&p, &opened.endpoint))
            && app.inner.lock().unwrap().generation == generation
    };
    let observer = Observer::new(&app, &workspace, Instant::now() + OBSERVATION, &current);
    let activity = project::project(&observer, &opened.project, &missions).await;
    if !current() {
        return refusal("observation-unavailable");
    }

    let values: Vec<J> = contexts.iter().zip(&missions).map(|(c, m)| observation(c, m, &activity)).collect();
    let mut header = header;
    for entry in header.iter_mut() {
        if entry.0 == "phase" {
            entry.1 = J::s("observed");
        }
    }
    header.push(("observedAt".into(), J::U(activity.generated_at)));
    let value = match mission_page {
        None => values.into_iter().next().unwrap(),
        Some(page) => obj(vec![("missionPage", page), ("observations", J::A(values))]),
    };
    match ojson::panel_page(&header, &[value], request.cursor.as_ref()) {
        Ok(page) => json(Status::OK, &page),
        Err("budget") => reads::unavailable(Status::OK, "workspace-unavailable"),
        Err(reason) => refusal(reason),
    }
}

/// One context's observation row (`MissionPanelActivityObservation`).
fn observation(context: &J, mission: &project::Mission, activity: &project::Projection) -> J {
    let observed = activity.missions.iter().find(|o| o.mission == mission.id).expect("observed mission");
    let own: HashSet<&str> = mission.actors.iter().map(|a| a.session.as_str()).collect();
    let page = |k| context.get("actorPage").and_then(|p| p.get(k)).and_then(J::count).unwrap_or(0);
    let partial = page("end") - page("offset") < page("total");
    let family = &observed.family;
    let member_actor = |s: &str| family.members.iter().find(|m| m.session == s).map(|m| m.actor.as_str());
    let mut items = Vec::new();
    for capture in &activity.requests {
        let roots: HashSet<&str> = capture
            .owned
            .iter()
            .filter(|id| mission.actors.iter().any(|a| a.session == **id && same(Some(&a.location), Some(&capture.location))))
            .map(String::as_str)
            .collect();
        let actor_of = |s: &str| -> Option<String> {
            if roots.contains(s) {
                return Some(s.to_owned());
            }
            member_actor(s).filter(|a| family.state != "unknown" && roots.contains(a)).map(str::to_owned)
        };
        let lists = [("form", capture.forms_observed, &capture.forms), ("permission", capture.permissions_observed, &capture.permissions)];
        for (kind, seen, list) in lists {
            if !seen {
                continue;
            }
            for request in list {
                let sid = request.get("sessionID").and_then(J::str).unwrap_or_default();
                if let Some(actor) = actor_of(sid) {
                    items.push(obj(vec![("kind", J::s(kind)), ("request", request.clone()), ("actorSessionId", J::S(actor))]));
                }
            }
        }
    }
    let blank = |i: &J| i.get("sessionID").and_then(J::str).is_none_or(|s| s.trim().is_empty() || s == "global");
    let request_complete = family.state == "observed"
        && activity.requests.iter().all(|c| c.forms_observed && c.permissions_observed)
        && mission.actors.iter().all(|a| {
            activity.requests.iter().any(|c| c.owned.contains(&a.session) && same(Some(&a.location), Some(&c.location)))
        })
        && !activity.requests.iter().any(|c| c.forms.iter().chain(&c.permissions).any(blank));
    let flag = |k| context.get(k) == Some(&J::Bool(true));
    let damaged = context.get("discardedEvents").and_then(J::count).unwrap_or(0) > 0
        || flag("controlUnavailable")
        || flag("notificationUnavailable")
        || flag("cleanupUnavailable");
    let coverage = if damaged || family.state == "unknown" {
        "unknown"
    } else if partial || family.state == "partial" {
        "partial"
    } else {
        "observed"
    };
    let request_state = if request_complete && !damaged {
        if partial { "partial" } else { "observed" }
    } else if !items.is_empty() {
        "partial"
    } else {
        "unknown"
    };
    let members = family
        .members
        .iter()
        .map(|m| {
            let mut entries = vec![("sessionId", J::s(&m.session))];
            if let Some(p) = &m.parent {
                entries.push(("parentSessionId", J::s(p)));
            }
            entries.push(("actorSessionId", J::s(&m.actor)));
            // Another declared actor may be outside this window: its classification stays unspecified.
            if !partial || own.contains(m.session.as_str()) {
                if let Some(t) = &m.task_key {
                    entries.push(("taskKey", J::s(t)));
                }
                entries.push(("kind", J::s(if m.declared { "declared" } else { "ordinary" })));
            }
            obj(entries)
        })
        .collect();
    let family_state = if family.state == "observed" && partial { "partial" } else { family.state };
    obj(vec![
        ("context", context.clone()),
        ("coverage", J::s(coverage)),
        ("requests", obj(vec![("state", J::s(request_state)), ("items", J::A(items))])),
        (
            "activity",
            obj(vec![
                ("actors", J::A(observed.actors.iter().map(|(s, st)| obj(vec![("sessionId", J::s(s)), ("state", J::s(*st))])).collect())),
                ("family", obj(vec![("state", J::s(family_state)), ("members", J::A(members))])),
            ]),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_headers_compare_like_the_reference() {
        let h = vec![("revision".to_owned(), J::U(1)), ("passage".to_owned(), obj(vec![("a", J::U(1))]))];
        assert!(same_header(&h, &h.clone()));
        let mut other = h.clone();
        other[0].1 = J::U(2);
        assert!(!same_header(&h, &other));
        let window = vec![("window".to_owned(), obj(vec![]))];
        assert!(!same_header(&window, &window.clone()));
    }
}
