//! Settings › Stats (`opencode/service-usage.ts`, `service-usage-cache.ts`, `routes/service-usage.ts`):
//! the OpenCode service's aggregate usage, deliberately service-wide (never workspace-scoped), and
//! the display cache only the backend writes (`state.yaml` › `ui.serviceUsage`).
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Path, RawQuery, State},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    App, Shared, error,
    opencode::Endpoint,
    search::query::{number, part},
    settings::Kind,
};

const DAY: f64 = 86_400_000.0;
const PERIODS: [f64; 4] = [7.0, 30.0, 90.0, 365.0];

/// Per-connection keys and the latest-admission order of `ServiceUsage`.
#[derive(Default)]
pub struct Usage {
    connection: Mutex<Option<(Arc<Endpoint>, String)>>,
    identity: Mutex<Option<(Arc<Endpoint>, String)>>,
    order: Mutex<Order>,
}
#[derive(Default)]
struct Order {
    sequence: u64,
    retired: u64,
    /// Insertion-ordered `admissions` map, at most 64 keys.
    admissions: Vec<(String, u64)>,
    pending: usize,
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/workspaces/{id}/service-usage", get(read))
        .route("/api/workspaces/{id}/service-usage/owner", get(owner))
        .route("/api/workspaces/{id}/service-usage/cache", get(cached))
}

enum Fail {
    NotFound,
    Forbidden,
    Invalid(&'static str),
    Other,
}
fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

struct Context {
    folder: String,
    created: String,
    endpoint: Arc<Endpoint>,
}
impl Context {
    async fn open(app: &App, id: &str) -> Result<Self, Fail> {
        let workspace = app.workspace(id).map_err(|_| Fail::NotFound)?;
        let deadline = tokio::time::Instant::now() + crate::opencode::daemon::TIMEOUT;
        let endpoint = app.native.acquire(deadline).await.map_err(|_| Fail::Other)?;
        let context =
            Context { folder: workspace.path.to_string_lossy().into_owned(), created: workspace.created_at, endpoint };
        context.current(app, id)?;
        Ok(context)
    }
    /// `assertCurrent` and the unchanged workspace record.
    fn current(&self, app: &App, id: &str) -> Result<(), Fail> {
        if !app.native.endpoint().is_some_and(|e| Arc::ptr_eq(&e, &self.endpoint)) {
            return Err(Fail::Other);
        }
        if !app.workspace(id).is_ok_and(|w| w.created_at == self.created && w.path.to_string_lossy() == self.folder) {
            return Err(Fail::Forbidden);
        }
        Ok(())
    }
    fn auth(&self) -> Value {
        json!(["basic", "opencode", self.endpoint.password])
    }
    /// `ownerKey`: path style, host, opened folder and the channel's credentials, digested.
    fn owner(&self) -> String {
        let style = if cfg!(windows) { "win32" } else { "posix" };
        hash(&json!([style, format!("host:{}", platform()), self.folder, self.auth()]))
    }
    fn connection(&self, app: &App) -> String {
        let mut slot = app.usage.connection.lock().unwrap();
        match &*slot {
            Some((endpoint, key)) if Arc::ptr_eq(endpoint, &self.endpoint) => key.clone(),
            _ => {
                let key = Uuid::new_v4().to_string();
                *slot = Some((self.endpoint.clone(), key.clone()));
                key
            }
        }
    }
    fn known_identity(&self, app: &App) -> Option<String> {
        let slot = app.usage.identity.lock().unwrap();
        let (_, value) = slot.as_ref().filter(|(e, _)| Arc::ptr_eq(e, &self.endpoint))?;
        Some(hash(&json!([value, self.folder])))
    }
    /// `identity`: the daemon's discovery root for this channel, kept per connection, then the folder.
    async fn identity(&self, app: &App) -> Result<String, Fail> {
        if let Some(known) = self.known_identity(app) {
            return Ok(known);
        }
        let failed = |_| Fail::Other;
        let response = app
            .native
            .get("/api/config")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(failed)?
            .error_for_status()
            .map_err(failed)?;
        let entries = crate::opencode::read_json(response, 2 * 1024 * 1024).await.map_err(|_| Fail::Other)?;
        let root = entries
            .as_array()
            .and_then(|e| e.iter().find(|x| x["type"] == "directory"))
            .and_then(|x| x["path"].as_str())
            .filter(|p| std::path::Path::new(p).is_absolute() && !p.contains('\0'))
            .ok_or(Fail::Other)?;
        let root = if cfg!(windows) { root.replace('/', "\\").to_lowercase() } else { root.to_owned() };
        let value = hash(&json!([format!("host:{}", platform()), root, self.auth()]));
        if !app.native.endpoint().is_some_and(|e| Arc::ptr_eq(&e, &self.endpoint)) {
            return Err(Fail::Other);
        }
        *app.usage.identity.lock().unwrap() = Some((self.endpoint.clone(), value));
        self.known_identity(app).ok_or(Fail::Other)
    }
}

/// fast-querystring as Fastify parses the query: each key's values.
fn query(raw: Option<&str>) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for segment in raw.unwrap_or("").split('&').filter(|s| !s.is_empty()) {
        let (key, value) = segment.split_once('=').unwrap_or((segment, ""));
        let (key, value) = (part(key), part(value));
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some((_, values)) => values.push(value),
            None => out.push((key, vec![value])),
        }
    }
    out
}
/// `z.object(shape).strict()` over the parsed query: the single value of each known key.
fn strict<'a>(fields: &'a [(String, Vec<String>)], keys: &[&str]) -> Option<Vec<Option<&'a str>>> {
    if fields.iter().any(|(k, v)| !keys.contains(&k.as_str()) || v.len() > 1) {
        return None;
    }
    Some(keys.iter().map(|key| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v[0].as_str())).collect())
}
fn timezone(value: Option<&str>) -> Option<String> {
    value.filter(|v| v.chars().count() <= 128 && crate::missions::time_zone::valid(v)).map(str::to_owned)
}

async fn owner(State(app): State<Shared>, Path(id): Path<String>) -> Response {
    let Ok(context) = Context::open(&app, &id).await else {
        return error(Status::SERVICE_UNAVAILABLE, "Stats display owner unavailable").into_response();
    };
    let mut body = json!({"owner": context.owner(), "connection": context.connection(&app)});
    if let Some(identity) = context.known_identity(&app) {
        body["identity"] = json!(identity);
    }
    Json(body).into_response()
}

async fn cached(State(app): State<Shared>, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Response {
    let fields = query(raw.as_deref());
    let parsed = strict(&fields, &["timezone", "days"]).and_then(|v| {
        let days = match v[1] {
            None => None,
            Some(text) => Some(number(text)).filter(|d| PERIODS.contains(d)).map(Some)?,
        };
        Some((timezone(v[0])?, days))
    });
    let Some((zone, days)) = parsed else {
        return error(Status::BAD_REQUEST, "Invalid Stats display cache query").into_response();
    };
    let unavailable = || error(Status::SERVICE_UNAVAILABLE, "Stats display cache unavailable").into_response();
    let Ok(context) = Context::open(&app, &id).await else { return unavailable() };
    let Ok(identity) = context.identity(&app).await else { return unavailable() };
    if context.current(&app, &id).is_err() {
        return unavailable();
    }
    let owner = context.owner();
    let (days, snapshot) = cache::get(&app, &identity, &zone, days, &owner);
    let connection = context.connection(&app);
    let mut body = json!({"days": days, "owner": owner, "identity": identity, "connection": connection});
    if let Some(mut snapshot) = snapshot {
        (snapshot["owner"], snapshot["identity"], snapshot["connection"]) =
            (json!(owner), json!(identity), json!(connection));
        body["snapshot"] = snapshot;
    }
    Json(body).into_response()
}

async fn read(State(app): State<Shared>, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Response {
    let fields = query(raw.as_deref());
    let parsed = strict(&fields, &["from", "to", "timezone", "restorePeriod"]).and_then(|v| {
        let int = |text: Option<&str>, min: f64| {
            text.map(number).filter(|n| n.fract() == 0.0 && *n >= min && *n <= 8_640_000_000_000_000.0)
        };
        let (from, to, zone) = (int(v[0], 0.0)?, int(v[1], 1.0)?, timezone(v[2])?);
        let restore = match v[3] {
            None => false,
            Some("true") => true,
            Some(_) => return None,
        };
        (to > from && to - from <= 366.0 * DAY).then_some((from, to, zone, restore))
    });
    let Some((from, to, zone, restore)) = parsed else {
        return error(Status::BAD_REQUEST, "Invalid bounded service usage query").into_response();
    };
    match aggregate(&app, &id, from, to, zone, restore).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(Fail::NotFound) => error(Status::NOT_FOUND, "Workspace not found").into_response(),
        Err(Fail::Forbidden) => error(Status::FORBIDDEN, "Workspace connection changed").into_response(),
        Err(Fail::Invalid(text)) => error(Status::UNPROCESSABLE_ENTITY, text).into_response(),
        Err(Fail::Other) => error(Status::SERVICE_UNAVAILABLE, "Service usage unavailable").into_response(),
    }
}

/// `ServiceUsage.read`: the latest authorized admission per owner and zone selects the saved
/// period and alone refreshes the cached snapshot, whatever order the native answers arrive in.
async fn aggregate(app: &Shared, id: &str, from: f64, to: f64, zone: String, restore: bool) -> Result<Value, Fail> {
    let order = {
        let mut state = app.usage.order.lock().unwrap();
        state.sequence += 1;
        state.sequence
    };
    let context = Context::open(app, id).await?;
    let owner = context.owner();
    let from = if restore { to - cache::period(app, &owner, &zone) * DAY } else { from };
    if from < 0.0 {
        return Err(Fail::Invalid("Restored Stats range starts before the supported epoch"));
    }
    let key = json!([owner, zone]).to_string();
    let days = (to - from) / DAY;
    let admitted = {
        let mut state = app.usage.order.lock().unwrap();
        let previous = state.admissions.iter().find(|(k, _)| *k == key).map_or(0, |(_, o)| *o);
        let admitted = order > state.retired && order > previous;
        if admitted {
            state.admissions.retain(|(k, _)| *k != key);
            state.admissions.push((key.clone(), order));
            if state.admissions.len() > 64 {
                let (_, oldest) = state.admissions.remove(0);
                state.retired = state.retired.max(oldest);
            }
        }
        admitted
    };
    if admitted {
        cache::select(app, &owner, &zone, days);
    }
    let mut url = app.native.url().join("/api/experimental/session/stats").map_err(|_| Fail::Other)?;
    url.query_pairs_mut()
        .append_pair("from", &(from as i64).to_string())
        .append_pair("to", &(to as i64).to_string())
        .append_pair("timezone", &zone)
        .append_pair("tools", "none");
    let response = app.native.request(reqwest::Method::GET, url).send().await.map_err(|_| Fail::Other)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Fail::Other);
    }
    let body = crate::opencode::read_json(response, 8 * 1024 * 1024).await.map_err(|_| Fail::Other)?;
    context.current(app, id)?;
    let mut snapshot =
        json!({"scope": "service", "stats": body["data"], "owner": owner, "connection": context.connection(app)});
    if body.get("data").is_none() {
        snapshot.as_object_mut().unwrap().remove("stats");
    }
    if let Some(identity) = context.known_identity(app) {
        snapshot["identity"] = json!(identity);
    }
    let start = latest(app, &key, order) && {
        let mut state = app.usage.order.lock().unwrap();
        let free = state.pending < 32;
        state.pending += usize::from(free);
        free
    };
    if start {
        // Native totals return at once; discovery keeps its own deadline and late fences.
        let (app, id, saved) = (app.clone(), id.to_owned(), snapshot.clone());
        tokio::spawn(async move {
            if let Ok(identity) = context.identity(&app).await
                && context.current(&app, &id).is_ok()
                && latest(&app, &key, order)
            {
                cache::set(&app, &identity, &zone, days, &saved);
            }
            app.usage.order.lock().unwrap().pending -= 1;
        });
    }
    Ok(snapshot)
}
fn latest(app: &App, key: &str, order: u64) -> bool {
    let state = app.usage.order.lock().unwrap();
    order > state.retired && state.admissions.iter().any(|(k, o)| k == key && *o == order)
}

/// `ServiceUsageCache`: eight validated snapshots and period choices, evicted oldest first.
mod cache {
    use super::*;

    const LIMIT: usize = 1_048_576;

    fn stored(app: &App) -> Value {
        app.settings.owner(Kind::State, "ui").get("serviceUsage").cloned().unwrap_or(Value::Null)
    }
    fn hex64(v: &Value) -> Option<String> {
        v.as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            .map(str::to_owned)
    }
    fn period_of(v: &Value) -> Option<f64> {
        v.as_f64().filter(|d| PERIODS.contains(d))
    }

    /// The snapshot schema's parse output: unknown keys dropped, `None` when invalid.
    pub fn snapshot(v: &Value) -> Option<Value> {
        let n = |v: &Value| v.as_f64().filter(|x| *x >= 0.0).map(|_| v.clone());
        let text = |v: &Value| v.as_str().filter(|s| s.chars().count() <= 256).map(|_| v.clone());
        let tokens = |v: &Value| -> Option<Value> {
            let cache = v.get("cache")?;
            Some(
                json!({"input": n(v.get("input")?)?, "output": n(v.get("output")?)?, "reasoning": n(v.get("reasoning")?)?,
                "cache": {"read": n(cache.get("read")?)?, "write": n(cache.get("write")?)?}}),
            )
        };
        if v.get("scope")? != "service" {
            return None;
        }
        let s = v.get("stats")?;
        let range = s.get("range")?;
        let (from, to) = (n(range.get("from")?)?, n(range.get("to")?)?);
        let span = to.as_f64()? - from.as_f64()?;
        if span <= 0.0 || span > 366.0 * DAY || s.get("tools")?.get("mode")? != "none" {
            return None;
        }
        let models = s.get("models")?.as_array().filter(|m| m.len() <= 256)?;
        let models = models
            .iter()
            .map(|m| {
                let model = m.get("model")?;
                let mut id = json!({"providerID": text(model.get("providerID")?)?, "id": text(model.get("id")?)?});
                if let Some(variant) = model.get("variant") {
                    id["variant"] = text(variant)?;
                }
                Some(json!({"model": id, "steps": n(m.get("steps")?)?, "tokens": tokens(m.get("tokens")?)?, "cost": n(m.get("cost")?)?}))
            })
            .collect::<Option<Vec<_>>>()?;
        let date = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap();
        let activity = s.get("activity")?.as_array().filter(|a| a.len() <= 366)?;
        let activity = activity
            .iter()
            .map(|a| {
                let day = a.get("date")?.as_str().filter(|d| date.is_match(d))?;
                Some(json!({"date": day, "steps": n(a.get("steps")?)?}))
            })
            .collect::<Option<Vec<_>>>()?;
        let mut stats = json!({"range": {"from": from, "to": to}, "tokens": tokens(s.get("tokens")?)?,
            "tools": {"mode": "none"}, "models": models, "activity": activity});
        for key in ["sessions", "subagents", "prompts", "steps", "cost", "activeDays", "streak"] {
            stats[key] = n(s.get(key)?)?;
        }
        Some(json!({"scope": "service", "stats": stats}))
    }
    fn entry(v: &Value) -> Option<Value> {
        let identity = hex64(v.get("identity")?)?;
        let days = period_of(v.get("days")?)?;
        let zone = timezone(v.get("timezone")?.as_str())?;
        let snapshot = snapshot(v.get("snapshot")?)?;
        let range = &snapshot["stats"]["range"];
        (range["to"].as_f64()? - range["from"].as_f64()? == days * DAY)
            .then(|| json!({"identity": identity, "days": days as u64, "timezone": zone, "snapshot": snapshot}))
    }
    fn selection(v: &Value) -> Option<Value> {
        let (owner, zone, days) =
            (hex64(v.get("owner")?)?, timezone(v.get("timezone")?.as_str())?, period_of(v.get("days")?)?);
        Some(json!({"owner": owner, "timezone": zone, "days": days as u64}))
    }

    fn entries(app: &App) -> Vec<Value> {
        let value = stored(app);
        let Some(list) = value.get("entries").and_then(Value::as_array).filter(|_| value["version"] == 1) else {
            return Vec::new();
        };
        if list.len() > 8 || Value::Array(list.clone()).to_string().len() > LIMIT {
            return Vec::new();
        }
        list.iter().filter_map(entry).collect()
    }
    fn selections(app: &App) -> Vec<Value> {
        let value = stored(app);
        value
            .get("selections")
            .and_then(Value::as_array)
            .filter(|s| s.len() <= 8)
            .and_then(|s| s.iter().map(selection).collect::<Option<Vec<_>>>())
            .unwrap_or_default()
    }
    pub fn period(app: &App, owner: &str, zone: &str) -> f64 {
        selections(app)
            .iter()
            .find(|s| s["owner"] == owner && s["timezone"] == zone)
            .and_then(|s| s["days"].as_f64())
            .unwrap_or(30.0)
    }
    fn save(app: &App, mut entries: Vec<Value>, selections: Vec<Value>) {
        while !entries.is_empty() && json!({"entries": entries, "selections": selections}).to_string().len() > LIMIT {
            entries.pop();
        }
        let patch = json!({"serviceUsage": {"version": 1, "entries": entries, "selections": selections}});
        // Optional display state: a failed write never fails the Stats read.
        let _ = crate::settings::patch_owner(app, Kind::State, "ui", patch);
    }
    pub fn select(app: &App, owner: &str, zone: &str, days: f64) {
        let Some(chosen) = selection(&json!({"owner": owner, "timezone": zone, "days": days})) else { return };
        let previous = selections(app);
        if previous
            .first()
            .is_some_and(|p| p["owner"] == owner && p["timezone"] == zone && p["days"].as_f64() == Some(days))
        {
            return;
        }
        let mut list = vec![chosen];
        list.extend(previous.into_iter().filter(|p| p["owner"] != owner || p["timezone"] != zone));
        list.truncate(8);
        save(app, entries(app), list);
    }
    pub fn get(app: &App, identity: &str, zone: &str, days: Option<f64>, owner: &str) -> (u64, Option<Value>) {
        let count = days.unwrap_or_else(|| period(app, owner, zone));
        let saved = entries(app)
            .into_iter()
            .find(|e| e["identity"] == identity && e["timezone"] == zone && e["days"].as_f64() == Some(count));
        (count as u64, saved.map(|e| e["snapshot"].clone()))
    }
    pub fn set(app: &App, identity: &str, zone: &str, days: f64, snapshot: &Value) {
        let Some(parsed) = entry(&json!({"identity": identity, "timezone": zone, "days": days, "snapshot": snapshot}))
        else {
            return;
        };
        let mut list = vec![parsed];
        list.extend(
            entries(app)
                .into_iter()
                .filter(|e| !(e["identity"] == identity && e["timezone"] == zone && e["days"].as_f64() == Some(days))),
        );
        list.truncate(8);
        save(app, list, selections(app));
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn snapshots_keep_the_schema_fields_only() {
            let tokens = json!({"input": 1, "output": 2, "reasoning": 0, "cache": {"read": 0, "write": 0}, "extra": 1});
            let stats = json!({"range": {"from": 0, "to": 7.0 * DAY}, "sessions": 1, "subagents": 0, "prompts": 2,
                "steps": 3, "tokens": tokens, "cost": 0.5, "tools": {"mode": "none"}, "activeDays": 1, "streak": 1,
                "models": [{"model": {"providerID": "p", "id": "m"}, "steps": 3, "tokens": tokens, "cost": 0.5}],
                "activity": [{"date": "2026-11-20", "steps": 3}], "projects": []});
            let parsed = snapshot(&json!({"scope": "service", "stats": stats, "owner": "x"})).unwrap();
            assert!(parsed.get("owner").is_none() && parsed["stats"].get("projects").is_none());
            assert!(parsed["stats"]["tokens"].get("extra").is_none());
            let entry = |days| {
                entry(
                    &json!({"identity": "a".repeat(64), "days": days, "timezone": "Europe/Paris", "snapshot": parsed}),
                )
            };
            assert!(entry(7).is_some() && entry(30).is_none());
            for broken in [
                json!({"activity": [{"date": "2026-1-20", "steps": 3}]}),
                json!({"cost": -1}),
                json!({"tools": {"mode": "all"}}),
            ] {
                let mut stats = stats.clone();
                for (key, value) in broken.as_object().unwrap() {
                    stats[key] = value.clone();
                }
                assert!(snapshot(&json!({"scope": "service", "stats": stats})).is_none());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_are_strict_and_coerced() {
        let fields = query(Some("from=0x10&to=+20&timezone=Europe%2FParis"));
        assert_eq!(
            strict(&fields, &["from", "to", "timezone"]).unwrap(),
            [Some("0x10"), Some(" 20"), Some("Europe/Paris")]
        );
        assert!(strict(&query(Some("from=1&from=2")), &["from"]).is_none());
        assert!(strict(&query(Some("other=1")), &["from"]).is_none());
        assert_eq!(number("0x10"), 16.0);
        assert!(timezone(Some("europe/paris")).is_some() && timezone(Some("Mars/Base")).is_none());
    }
}
