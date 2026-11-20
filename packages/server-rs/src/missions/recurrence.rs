//! Daily recurrence reads (reference `mission-recurrence-snapshot.ts` and
//! `mission-recurrence-current.ts`): the snapshot, archived passage pages and
//! the current passage identity, panel pages and content. Every native reply
//! is validated against the reference schema and its provenance before it is
//! published; a workspace or physical root that changed meanwhile refuses.
use crate::{
    App, Shared, Workspace,
    worktrees::linked::native,
    missions::recurrence_contract::{
        self as contract, PANEL_PAGE_BYTES, PANEL_REQUEST_BYTES, bytes, current_identity, rid, same_location,
    },
    missions::recurrence_selector::page_input,
    files,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

pub(crate) fn fail(status: Status, text: &str) -> Response {
    (status, Json(json!({ "error": text }))).into_response()
}
/// The owned root a recurrence route acts on, with its native project.
#[derive(Clone)]
pub(crate) struct Scope {
    pub w: Workspace,
    pub id: String,
    pub dir: String,
    pub project: String,
    pub canonical: String,
    pub host: String,
}
#[derive(Debug, PartialEq)]
pub(crate) enum Refused {
    NotFound,
    NotOwned,
    Unavailable,
    Plugin,
}
pub(crate) fn workspace(app: &App, id: &str) -> Option<Workspace> {
    let id = id.trim();
    (1..=200).contains(&id.len()).then(|| app.workspace(id).ok()).flatten()
}
/// Workspace, owned native Location and project, then the active Missions plugin.
pub(crate) async fn scope(app: &App, id: &str, plugin: bool) -> Result<Scope, Refused> {
    let w = workspace(app, id).ok_or(Refused::NotFound)?;
    let dir = w.location["directory"].as_str().ok_or(Refused::NotFound)?.to_owned();
    let host = files::host_identity(&w.path).map_err(|_| Refused::NotOwned)?;
    files::root(&w).map_err(|_| Refused::NotOwned)?;
    let location = [("location[directory]", dir.as_str())];
    let resolved = native(app, Method::GET, "/api/location", &location, None, 128 * 1024)
        .await
        .map_err(|_| Refused::Unavailable)?;
    let at = |v: &Value| v.as_str().and_then(|p| dunce::canonicalize(p).ok()).as_ref() == Some(&w.path);
    let canonical = resolved["project"]["canonical"].as_str().unwrap_or_default().to_owned();
    if !at(&resolved["directory"]) || !at(&resolved["project"]["canonical"]) {
        return Err(Refused::NotOwned);
    }
    let project = resolved["project"]["id"]
        .as_str()
        .filter(|p| contract::nid(p) && *p != "global")
        .ok_or(Refused::NotOwned)?
        .to_owned();
    if plugin {
        let plugins = native(app, Method::GET, "/api/plugin", &location, None, 512 * 1024)
            .await
            .map_err(|_| Refused::Unavailable)?;
        if !plugins["data"].as_array().is_some_and(|rows| {
            rows.iter().any(|r| r["id"] == "codenomad.missions" && r["state"]["status"] == "active")
        }) {
            return Err(Refused::Plugin);
        }
    }
    Ok(Scope { id: w.id.to_string(), w, dir, project, canonical, host })
}
/// The workspace, its Location and physical root are still those admitted.
pub(crate) fn still(app: &App, s: &Scope) -> bool {
    app.workspace(&s.id).is_ok_and(|w| w.path == s.w.path && w.location == s.w.location)
        && files::host_identity(&s.w.path).ok().as_deref() == Some(s.host.as_str())
}
/// One native Missions RPC; any refusal or transport failure is opaque.
pub(crate) async fn rpc(app: &App, dir: &str, method: &str, input: Value, max: usize) -> Result<Value, ()> {
    crate::missions::run::rpc(app, dir, method, input, max).await.map_err(|_| ())
}
/// Fastify-style strict query: each key once, `None` on a repeat or bad encoding.
pub(crate) fn query(raw: Option<&str>) -> Option<Map<String, Value>> {
    let mut out = Map::new();
    for part in raw.unwrap_or_default().split('&').filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        let decode = |s: &str| {
            percent_encoding::percent_decode_str(&s.replace('+', " "))
                .decode_utf8()
                .ok()
                .map(|s| s.into_owned())
        };
        let (k, v) = (decode(k)?, decode(v)?);
        if out.insert(k, Value::String(v)).is_some() {
            return None;
        }
    }
    Some(out)
}
/// `z.coerce.number()`: JavaScript `Number(text)`.
pub(crate) fn number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    if t.bytes().any(|b| b.is_ascii_alphabetic() && !matches!(b, b'e' | b'E'))
        && !matches!(t, "Infinity" | "+Infinity" | "-Infinity")
    {
        return None;
    }
    t.parse::<f64>().ok()
}
/// A coerced safe non-negative (or positive) integer query value.
pub(crate) fn integer(v: &Value, min: u64) -> Option<u64> {
    let n = number(v.as_str()?)?;
    (n.fract() == 0.0 && n >= min as f64 && n <= contract::SAFE as f64).then_some(n as u64)
}

/// `GET /missions/recurrence` and `GET /missions/recurrence/:s/passages/:p`.
async fn read(app: Shared, id: String, page: Option<(String, String)>, raw: Option<String>) -> Response {
    let invalid = || fail(Status::BAD_REQUEST, "Invalid recurrence read request");
    let Some(q) = query(raw.as_deref()) else { return invalid() };
    let mut input = None;
    if let Some((schedule, passage)) = &page {
        let mut i = json!({"scheduleID":schedule,"passageID":passage,"section":0,"page":0});
        for (k, v) in &q {
            let ok = match k.as_str() {
                "section" => integer(v, 0).filter(|n| *n < 8_400).map(|n| i["section"] = json!(n)),
                "page" => integer(v, 0).filter(|n| *n <= 63).map(|n| i["page"] = json!(n)),
                "revision" => integer(v, 1).map(|n| i["revision"] = json!(n)),
                _ => None,
            };
            if ok.is_none() {
                return invalid();
            }
        }
        if !rid(schedule) || !rid(passage) {
            return invalid();
        }
        input = Some(i);
    } else if raw.is_some_and(|r| !r.is_empty()) {
        return invalid();
    }
    if workspace(&app, &id).is_none() {
        return fail(Status::NOT_FOUND, "Workspace unavailable");
    }
    // The prototype's Missions broker stays opt-in, like every Missions read.
    if !app.mission_reads {
        return fail(Status::SERVICE_UNAVAILABLE, "Mission service unavailable");
    }
    let s = match scope(&app, &id, true).await {
        Ok(s) => s,
        Err(Refused::NotFound) => return fail(Status::NOT_FOUND, "Workspace unavailable"),
        Err(Refused::NotOwned) => return fail(Status::FORBIDDEN, "Mission Location is not owned"),
        Err(Refused::Plugin) => return fail(Status::SERVICE_UNAVAILABLE, "Mission plugin unavailable"),
        Err(Refused::Unavailable) => return fail(Status::SERVICE_UNAVAILABLE, "Mission recurrence unavailable"),
    };
    let unavailable = || fail(Status::SERVICE_UNAVAILABLE, "Mission recurrence unavailable");
    let (method, body) = match &input {
        Some(i) => ("recurrencePassageRead", i.clone()),
        None => ("recurrenceSnapshot", json!({})),
    };
    let Ok(out) = rpc(&app, &s.dir, method, body, 4 * 1024 * 1024).await else { return unavailable() };
    let valid = if input.is_some() { contract::read_page(&out) } else { contract::snapshot(&out) };
    if !valid || !still(&app, &s) {
        return unavailable();
    }
    let provenance = out["projectID"] == s.project.as_str()
        && out["projectCanonical"] == s.canonical.as_str()
        && same_location(&out["location"], &s.dir);
    if let Some(i) = input {
        let exact = provenance
            && ["scheduleID", "passageID", "section", "page"].iter().all(|k| out[*k] == i[*k])
            && i.get("revision").is_none_or(|r| out["revision"] == *r);
        if !exact {
            return fail(Status::BAD_GATEWAY, "Foreign archived recurrence page");
        }
        let mut result = out;
        let o = result.as_object_mut().unwrap();
        o.remove("projectCanonical");
        o.remove("location");
        return Json(result).into_response();
    }
    if !provenance {
        return fail(Status::BAD_GATEWAY, "Foreign Mission recurrence snapshot");
    }
    Json(json!({"version":1,"projectID":s.project,"schedules":out["schedules"]})).into_response()
}
pub async fn snapshot(State(app): State<Shared>, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Response {
    read(app, id, None, raw).await
}
pub async fn passage(
    State(app): State<Shared>,
    Path((id, schedule, passage)): Path<(String, String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    read(app, id, Some((schedule, passage)), raw).await
}

const SECTIONS: [&str; 10] = [
    "summary", "objective", "notes", "evidence", "next", "brief", "artifact", "achieved", "ongoing", "obstacles",
];
enum Mode {
    Identity,
    Page(Value),
    Content(Value),
}
/// The three current-passage routes (`registerMissionRecurrenceCurrent`).
async fn current(app: Shared, id: String, schedule: String, passage: Option<String>, raw: Option<String>, body: Option<Bytes>) -> Response {
    let invalid = || fail(Status::BAD_REQUEST, "Invalid current passage request");
    let id_ok = (1..=200).contains(&id.trim().len()) && rid(&schedule) && passage.as_deref().is_none_or(rid);
    let Some(q) = query(raw.as_deref()) else { return invalid() };
    let mut kind = match q.get("owner").map(|v| v.as_str()) {
        None => "daily",
        Some(Some("daily")) => "daily",
        Some(Some("scheduled")) => "scheduled",
        _ => return invalid(),
    };
    let mode = match body {
        Some(b) => {
            let Some(input) = serde_json::from_slice(&b).ok().and_then(|v| page_input(&v)) else { return invalid() };
            if !id_ok || q.keys().any(|k| k != "owner") {
                return invalid();
            }
            if input["source"]["scheduleID"] != schedule.as_str() || input["source"]["passageID"] != passage.as_deref().unwrap_or_default() {
                return fail(Status::BAD_REQUEST, "Current passage selector differs");
            }
            kind = if input["source"]["owner"] == "scheduled" { "scheduled" } else { "daily" };
            Mode::Page(input)
        }
        None if passage.is_some() => {
            let mut c = json!({"scheduleID":schedule,"owner":kind,"passageID":passage,"section":"summary","page":0});
            for (k, v) in &q {
                let ok = match k.as_str() {
                    "owner" => Some(()),
                    "kind" => v.as_str().filter(|s| ["overview", "task", "report", "change"].contains(s)).map(|s| c["kind"] = json!(s)),
                    "itemId" => v.as_str().filter(|s| (1..=240).contains(&contract::units(s))).map(|s| c["itemId"] = json!(s)),
                    "section" => v.as_str().filter(|s| SECTIONS.contains(s)).map(|s| c["section"] = json!(s)),
                    "page" => integer(v, 0).map(|n| c["page"] = json!(n)),
                    "revision" => integer(v, 1).map(|n| c["revision"] = json!(n)),
                    _ => None,
                };
                if ok.is_none() {
                    return invalid();
                }
            }
            if !id_ok || c.get("kind").is_none() {
                return invalid();
            }
            if (c["kind"] == "overview") != c.get("itemId").is_none() {
                return fail(Status::BAD_REQUEST, "Invalid current passage target");
            }
            Mode::Content(c)
        }
        None => {
            if !id_ok || q.keys().any(|k| k != "owner") {
                return invalid();
            }
            Mode::Identity
        }
    };
    if workspace(&app, &id).is_none() {
        return fail(Status::NOT_FOUND, "Workspace unavailable");
    }
    let unavailable = || fail(Status::SERVICE_UNAVAILABLE, "Current Mission passage unavailable");
    if !app.mission_reads {
        return unavailable();
    }
    let s = match scope(&app, &id, true).await {
        Ok(s) => s,
        Err(Refused::NotFound) => return fail(Status::NOT_FOUND, "Workspace unavailable"),
        Err(Refused::NotOwned) => return fail(Status::FORBIDDEN, "Mission Location is not owned"),
        Err(_) => return unavailable(),
    };
    let identity = || async {
        let v = rpc(&app, &s.dir, "recurrenceCurrent", json!({"scheduleID":schedule,"owner":kind}), PANEL_PAGE_BYTES + 256).await?;
        let exact = bytes(&v) <= PANEL_PAGE_BYTES
            && current_identity(&v)
            && v["projectID"] == s.project.as_str()
            && v["projectCanonical"] == s.canonical.as_str()
            && same_location(&v["location"], &s.dir)
            && v["scheduleID"] == schedule.as_str()
            && v.get("source").is_none_or(|x| x["owner"] == kind);
        if !exact || !still(&app, &s) {
            return Err(());
        }
        Ok(v)
    };
    let Ok(before) = identity().await else { return unavailable() };
    if let Mode::Page(input) = &mode {
        if input["source"] != before["source"] {
            return Json(json!({"available":false,"reason":"changed"})).into_response();
        }
    }
    if !matches!(mode, Mode::Identity) && before["passageID"] != passage.as_deref().unwrap_or_default() {
        return unavailable();
    }
    let result = match mode {
        Mode::Identity => {
            let mut public = before.clone();
            let o = public.as_object_mut().unwrap();
            o.remove("projectCanonical");
            o.remove("location");
            public
        }
        // Live actor observation (`readMissionPanelObservation`) is not ported:
        // refuse with the reference's own observation refusal.
        Mode::Page(input) if input["selector"]["source"] == "activity" => json!({"available":false,"reason":"observation-unavailable"}),
        Mode::Page(input) => {
            let Ok(v) = rpc(&app, &s.dir, "recurrenceCurrentPage", input.clone(), PANEL_PAGE_BYTES + 256).await else {
                return unavailable();
            };
            if !contract::panel_page(&v)
                || bytes(&v) > PANEL_PAGE_BYTES
                || v["available"] == true && (v["projectID"] != s.project.as_str() || v["passage"] != input["source"])
                || !still(&app, &s)
            {
                return unavailable();
            }
            v
        }
        Mode::Content(c) => {
            let Ok(v) = rpc(&app, &s.dir, "recurrenceCurrentContent", c.clone(), PANEL_PAGE_BYTES + 256).await else {
                return unavailable();
            };
            let exact = bytes(&v) <= PANEL_PAGE_BYTES
                && contract::content_page(&v, true)
                && v["projectCanonical"] == before["projectCanonical"]
                && same_location(&v["location"], &s.dir)
                && v["scheduleID"] == before["scheduleID"]
                && v["missionID"] == before["source"]["missionID"]
                && v["passageID"] == before["passageID"]
                && v["projectID"] == before["projectID"]
                && v["page"] == c["page"]
                && c.get("revision").is_none_or(|r| v["revision"] == *r);
            if !exact || !still(&app, &s) {
                return unavailable();
            }
            let mut body = v;
            let o = body.as_object_mut().unwrap();
            o.remove("projectCanonical");
            o.remove("location");
            body
        }
    };
    if !still(&app, &s) {
        return fail(Status::FORBIDDEN, "Mission ownership changed");
    }
    if identity().await.ok() != Some(before) || bytes(&result) > PANEL_PAGE_BYTES {
        return unavailable();
    }
    Json(result).into_response()
}
pub async fn current_identity_route(
    State(app): State<Shared>,
    Path((id, schedule)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    current(app, id, schedule, None, raw, None).await
}
pub async fn current_page(
    State(app): State<Shared>,
    Path((id, schedule, passage)): Path<(String, String, String)>,
    RawQuery(raw): RawQuery,
    body: Bytes,
) -> Response {
    if body.len() > PANEL_REQUEST_BYTES {
        return fail(Status::PAYLOAD_TOO_LARGE, "Request body is too large");
    }
    current(app, id, schedule, Some(passage), raw, Some(body)).await
}
pub async fn current_content(
    State(app): State<Shared>,
    Path((id, schedule, passage)): Path<(String, String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    current(app, id, schedule, Some(passage), raw, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_follow_fastify_and_zod_coercion() {
        let q = query(Some("section=2&page=&revision=0x10")).unwrap();
        assert_eq!(integer(&q["section"], 0), Some(2));
        assert_eq!(integer(&q["page"], 0), Some(0), "Number('') is 0");
        assert_eq!(integer(&q["revision"], 1), Some(16));
        assert!(query(Some("page=1&page=2")).is_none(), "a repeated key is an array");
        assert_eq!(integer(&json!("1e1"), 0), Some(10));
        assert_eq!(integer(&json!("1.5"), 0), None);
        assert_eq!(integer(&json!("-1"), 0), None);
        assert_eq!(integer(&json!("0"), 1), None);
        assert_eq!(integer(&json!("abc"), 0), None);
        assert_eq!(integer(&json!("9007199254740992"), 0), None);
        assert_eq!(query(Some("owner=sch%65duled")).unwrap()["owner"], "scheduled");
    }
}
