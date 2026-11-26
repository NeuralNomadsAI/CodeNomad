//! Conversation Status provider usage: owned native session, projected credentials and bounded quota reads.
mod accounts;
mod google;
mod plans;
mod quota_marks;
pub(crate) mod selection;
#[cfg(test)]
mod selection_tests;
mod shared;
mod special;
mod subscriptions;
mod xai;

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    extract::{Path, RawQuery, State as AxumState},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use tokio::{sync::Mutex as AsyncMutex, time::Instant};

use self::shared::*;
use crate::{
    App, Shared, Workspace,
    auth::Principal,
    error,
    opencode::Endpoint,
    shared::{js_trim, now_ms},
};

pub struct State {
    http: OnceLock<Http>,
    cache: Mutex<VecDeque<Cached>>,
    flights: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    codex: Mutex<VecDeque<Cached>>,
    google: Mutex<VecDeque<google::Token>>,
    claude: Mutex<HashMap<&'static str, subscriptions::ClaudeRead>>,
    pub(crate) accounts: selection::AccountService,
}
impl Default for State {
    fn default() -> Self {
        Self {
            http: OnceLock::new(),
            cache: Default::default(),
            flights: Default::default(),
            codex: Default::default(),
            google: Default::default(),
            claude: Default::default(),
            accounts: selection::AccountService::default(),
        }
    }
}
impl State {
    #[cfg(test)]
    pub(crate) fn with_test_accounts(fixture: reqwest::Url, settle: Duration) -> Self {
        Self::with_test_accounts_timeout(fixture, settle, Duration::from_secs(15))
    }
    #[cfg(test)]
    pub(crate) fn with_test_accounts_timeout(
        fixture: reqwest::Url,
        settle: Duration,
        preflight_timeout: Duration,
    ) -> Self {
        let http = OnceLock::new();
        let _ = http.set(Http::with_fixture(fixture).expect("Test fixture client unavailable"));
        Self {
            http,
            cache: Default::default(),
            flights: Default::default(),
            codex: Default::default(),
            google: Default::default(),
            claude: Default::default(),
            accounts: selection::AccountService::with_timeouts(settle, preflight_timeout),
        }
    }
    pub(super) fn http(&self) -> &Http {
        self.http.get_or_init(|| Http::open().expect("Provider usage client unavailable"))
    }
    fn flight(&self, identity: &str) -> Arc<AsyncMutex<()>> {
        let mut flights = self.flights.lock().unwrap();
        if let Some(flight) = flights.get(identity).and_then(Weak::upgrade) {
            return flight;
        }
        flights.retain(|_, task| task.strong_count() > 0);
        let flight = Arc::new(AsyncMutex::new(()));
        flights.insert(identity.into(), Arc::downgrade(&flight));
        flight
    }
}
#[derive(Default)]
struct Context {
    integration: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    status: &'static str,
}
struct Cached {
    slot: String,
    identity: String,
    expires: u64,
    stamp: u64,
    reading: Quota,
}
fn save(cache: &mut VecDeque<Cached>, value: Cached, limit: usize) {
    cache.retain(|c| c.slot != value.slot);
    if cache.len() >= limit {
        cache.pop_front();
    }
    cache.push_back(value);
}
fn load(cache: &Mutex<VecDeque<Cached>>, slot: &str, identity: &str) -> Option<(Quota, u64)> {
    cache
        .lock()
        .unwrap()
        .iter()
        .find(|e| e.slot == slot && e.identity == identity && e.expires > now_ms())
        .map(|e| (e.reading.clone(), e.stamp))
}
struct Provider {
    id: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
}
const PROVIDERS: &[Provider] = &[
    Provider { id: "codex", name: "Codex", aliases: &["openai", "codex", "chatgpt"] },
    Provider { id: "github-copilot", name: "GitHub Copilot", aliases: &["github-copilot", "copilot"] },
    Provider {
        id: "kimi-for-coding",
        name: "Kimi for Coding",
        aliases: &["kimi-for-coding", "kimi", "kimi-code-plan-cn", "kimi-code-plan-global"],
    },
    Provider { id: "nano-gpt", name: "NanoGPT", aliases: &["nano-gpt", "nanogpt", "nano_gpt"] },
    Provider { id: "openrouter", name: "OpenRouter", aliases: &["openrouter"] },
    Provider { id: "zai-coding-plan", name: "z.ai", aliases: &["zai-coding-plan", "zai", "z.ai"] },
    Provider {
        id: "zhipuai-coding-plan",
        name: "Zhipu AI Coding Plan",
        aliases: &["zhipuai-coding-plan", "zhipuai", "zhipu"],
    },
    Provider { id: "wafer", name: "Wafer.ai", aliases: &["wafer", "wafer-ai", "wafer_ai", "wafer.ai"] },
    Provider { id: "minimax-coding-plan", name: "MiniMax Coding Plan", aliases: &["minimax-coding-plan", "minimax"] },
    Provider {
        id: "minimax-cn-coding-plan",
        name: "MiniMax Coding Plan CN",
        aliases: &["minimax-cn-coding-plan", "minimaxi"],
    },
    Provider { id: "cursor", name: "Cursor", aliases: &["cursor"] },
    Provider { id: "ollama-cloud", name: "Ollama Cloud", aliases: &["ollama-cloud", "ollamacloud"] },
    Provider { id: "opencode-go", name: "OpenCode Go", aliases: &["opencode-go", "opencode"] },
    Provider { id: "xai", name: "xAI", aliases: &["xai", "grok"] },
    Provider { id: "command-code", name: "Command Code", aliases: &["command-code"] },
    Provider { id: "deepseek", name: "DeepSeek", aliases: &["deepseek"] },
    Provider { id: "neuralwatt", name: "NeuralWatt", aliases: &["neuralwatt"] },
    Provider { id: "claude", name: "Claude", aliases: &["claude", "anthropic"] },
    Provider { id: "claude-code", name: "Claude", aliases: &["claude-code", "claude-agent"] },
    Provider { id: "cline-pass", name: "ClinePass", aliases: &["cline-pass"] },
    Provider { id: "deepinfra", name: "DeepInfra", aliases: &["deepinfra", "deep-infra", "deep_infra"] },
    Provider { id: "hyper", name: "Charm Hyper", aliases: &["hyper"] },
    Provider { id: "kilo", name: "Kilo Code", aliases: &["kilo", "kilocode", "kilo-code"] },
    Provider { id: "zenmux", name: "ZenMux", aliases: &["zenmux"] },
    Provider { id: "exe-dev", name: "exe.dev", aliases: &["exe-dev"] },
    Provider { id: "google", name: "Gemini CLI", aliases: &["google"] },
    Provider { id: "opencode-console", name: "OpenCode Console", aliases: &["opencode", "opencode-console"] },
];
const FREE: Provider = Provider { id: "opencode-free", name: "OpenCode Console", aliases: &["opencode"] };

fn resolve(id: &str) -> Option<&'static Provider> {
    PROVIDERS
        .iter()
        .rev()
        .find(|p| p.id.eq_ignore_ascii_case(id) || p.aliases.iter().any(|a| a.eq_ignore_ascii_case(id)))
}
pub fn routes() -> Router<Shared> {
    Router::new().route("/api/usage/{provider}", get(route)).route(
        "/api/workspaces/{id}/provider-accounts/{integration}",
        get(accounts::get_route).put(accounts::put_route),
    )
}

struct Query {
    instance: String,
    session: String,
    model: Option<String>,
}
fn query(raw: Option<&str>) -> Option<Query> {
    let mut fields = Fields::new();
    for entry in raw.unwrap_or("").split('&').filter(|s| !s.is_empty()) {
        let (key, val) = entry.split_once('=').unwrap_or((entry, ""));
        let key = crate::search::query::part(key);
        if key.is_empty() {
            continue;
        }
        if !matches!(key.as_str(), "instanceId" | "sessionId" | "modelId") {
            return None;
        }
        let val = crate::search::query::part(val);
        let val = js_trim(&val);
        if val.chars().count() > 256 || val.is_empty() && key != "modelId" || fields.insert(key, json!(val)).is_some() {
            return None;
        }
    }
    Some(Query {
        instance: fields.get("instanceId")?.as_str()?.into(),
        session: fields.get("sessionId")?.as_str()?.into(),
        model: fields.get("modelId").and_then(Value::as_str).map(str::to_owned),
    })
}
#[derive(Clone, Copy)]
enum Refusal {
    Unavailable,
    Session,
    Workspace,
    Foreign,
    Invalid,
}
impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, text) = match self {
            Self::Unavailable => (Status::SERVICE_UNAVAILABLE, "Provider usage unavailable"),
            Self::Session => (Status::NOT_FOUND, "Session not found"),
            Self::Workspace => (Status::NOT_FOUND, "Workspace not found"),
            Self::Foreign => (Status::FORBIDDEN, "Session does not belong to workspace"),
            Self::Invalid => (Status::BAD_REQUEST, "Invalid usage request"),
        };
        error(status, text).into_response()
    }
}
async fn route(
    AxumState(app): AxumState<Shared>,
    Extension(principal): Extension<Principal>,
    Path(provider): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let result = match query(raw.as_deref()).filter(|_| !js_trim(&provider).is_empty()) {
        Some(q) => {
            let until = Instant::now() + Duration::from_secs(15);
            let extra = resolve(js_trim(&provider)).is_some_and(|p| p.id == "opencode-console")
                && !special::free_model(js_trim(&provider), q.model.as_deref());
            let end = if extra { until + Duration::from_secs(15) } else { until };
            tokio::select! {
                r = tokio::time::timeout_at(end, owned_read(&app, &q, js_trim(&provider), until)) =>
                    r.unwrap_or(Err(Refusal::Unavailable)),
                _ = principal.0.cancelled() => Err(Refusal::Unavailable),
            }
        }
        None => Err(Refusal::Invalid),
    };
    ([(header::CACHE_CONTROL, "no-store")], result.map(Json)).into_response()
}

struct Owned<'a> {
    app: &'a App,
    query: &'a Query,
    endpoint: Arc<Endpoint>,
    workspace: Workspace,
    directory: String,
}
impl Owned<'_> {
    fn current(&self) -> Result<(), Refusal> {
        if !self.app.native.endpoint().is_some_and(|e| Arc::ptr_eq(&e, &self.endpoint)) {
            return Err(Refusal::Unavailable);
        }
        if !self.app.workspace(&self.query.instance).is_ok_and(|w| {
            w.id == self.workspace.id && w.path == self.workspace.path && w.created_at == self.workspace.created_at
        }) {
            return Err(Refusal::Foreign);
        }
        Ok(())
    }
    async fn native(&self, path: &str, location: bool) -> Result<Value, Refusal> {
        self.current()?;
        let mut url = self.endpoint.url.join(path).map_err(|_| Refusal::Unavailable)?;
        if location {
            url.query_pairs_mut().append_pair("location[directory]", &self.directory);
        }
        let response = self
            .app
            .native
            .client
            .get(url)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .send()
            .await
            .map_err(|_| Refusal::Unavailable)?;
        let status = response.status();
        let data = crate::opencode::read_json(response, 8 * 1024 * 1024).await.map_err(|_| Refusal::Unavailable)?;
        self.current()?;
        if status == Status::NOT_FOUND && data["_tag"] == "SessionNotFoundError" && path.starts_with("/api/session/") {
            return Err(Refusal::Session);
        }
        if status != Status::OK {
            return Err(Refusal::Unavailable);
        }
        Ok(data)
    }
    async fn session(&self) -> Result<String, Refusal> {
        if matches!(self.query.session.as_str(), "." | "..") {
            return Err(Refusal::Unavailable);
        }
        let p = self.native(&format!("/api/session/{}", plans::encode(&self.query.session)), false).await?;
        let s = &p["data"];
        let directory = s["location"]["directory"].as_str().ok_or(Refusal::Unavailable)?;
        if s["id"] != self.query.session
            || s["location"].get("workspaceID").is_some()
            || !crate::worktrees::owns(self.app, &self.workspace, directory).await
        {
            return Err(Refusal::Foreign);
        }
        self.current()?;
        Ok(directory.to_owned())
    }
    async fn credentials(&self) -> Result<Value, Refusal> {
        let p = self.native("/api/credential", false).await?;
        p["data"].as_array().map(|entries| project(entries)).ok_or(Refusal::Unavailable)
    }
    async fn provider(&self, id: &str) -> Result<Value, Refusal> {
        self.binding("provider", id).await
    }
    async fn binding(&self, kind: &str, id: &str) -> Result<Value, Refusal> {
        if matches!(id, "" | "." | "..") {
            return Err(Refusal::Unavailable);
        }
        let doc = self.native(&format!("/api/{kind}/{}", plans::encode(id)), true).await?;
        if doc["location"]["directory"] != self.directory
            || doc["location"].get("workspaceID").is_some()
            || doc["data"]["id"] != id
        {
            return Err(Refusal::Unavailable);
        }
        Ok(doc["data"].clone())
    }
}

fn project(entries: &[Value]) -> Value {
    let mut auth = Fields::new();
    for e in entries {
        let v = &e["value"];
        let Some(id) = e["integrationID"].as_str() else { continue };
        if e["active"] != true || !matches!(v["type"].as_str(), Some("key" | "oauth")) {
            continue;
        }
        let metadata = &v["metadata"];
        let mut out = if v["type"] == "key" {
            if id == "opencode" && auth.get(id).is_some_and(|e| e["type"] == "oauth") {
                continue;
            }
            json!({"type":"api","key":v["key"]})
        } else {
            let mut out = json!({"type":"oauth"});
            for field in ["methodID", "access", "refresh", "expires"] {
                if let Some(v) = v.get(field) {
                    out[field] = v.clone();
                }
            }
            if let Some(account) = metadata["accountID"].as_str() {
                out["accountId"] = json!(account);
            }
            if id == "google" {
                if let Some(id) = e.get("id") {
                    out["credentialID"] = id.clone();
                }
                if let Some(meta) = v.get("metadata") {
                    out["metadata"] = meta.clone();
                }
            }
            if id == "github-copilot"
                && let Some(url) = metadata.get("enterpriseUrl")
            {
                out["enterpriseUrl"] = url.clone();
            }
            out
        };
        if let Some(org) = metadata["orgID"].as_str() {
            out["orgId"] = json!(org);
        }
        if let Some(server) = metadata.get("server").filter(|s| id == "opencode" || s.is_string()) {
            out["server"] = server.clone();
        }
        auth.insert(id.into(), out);
    }
    Value::Object(auth)
}

fn settings(p: Option<&Value>, requested: &str, provider: &Provider) -> Context {
    let mut out = Context { status: if p.is_some() { "available" } else { "unavailable" }, ..Default::default() };
    if let Some(p) = p {
        if provider.id != "opencode-go" || p["id"] == "opencode-go" || p["canonical"] == "opencode-go" {
            out.integration = Some(p["integrationID"].as_str().unwrap_or(requested).to_owned());
        }
        let s = &p["settings"];
        if let Some(base) = s.get("baseURL") {
            out.base_url = Some(base.as_str().map(js_trim).unwrap_or("").into());
        }
        for field in ["baseURL", "apiKey"] {
            if let Some(raw) = s[field].as_str() {
                let lower = raw.to_ascii_lowercase();
                if lower.contains("{env:") || lower.contains("{file:") {
                    out.status = "unresolved";
                } else if field == "apiKey" {
                    out.api_key = text(&s[field]).map(str::to_owned);
                }
            }
        }
    }
    if provider.id == "kimi-for-coding" && out.integration.is_none() {
        out.integration = Some(requested.to_ascii_lowercase());
    }
    out
}

async fn owned_read(app: &App, q: &Query, requested: &str, until: Instant) -> Result<Value, Refusal> {
    let workspace = app.workspace(&q.instance).map_err(|_| Refusal::Workspace)?;
    let endpoint = app.native.acquire(until).await.map_err(|_| Refusal::Unavailable)?;
    let mut owned = Owned { app, query: q, endpoint, workspace, directory: String::new() };
    owned.directory = tokio::time::timeout_at(until, owned.session()).await.map_err(|_| Refusal::Unavailable)??;
    let free = special::free_model(requested, q.model.as_deref());
    let provider = if free { Some(&FREE) } else { resolve(requested) };
    let state = &app.provider_usage;
    let native =
        if !free && provider.is_none_or(|p| p.id == "codex") { codex(state, &owned, requested).await } else { None };
    let (provider, name, reading, stamp) = if let Some((reading, stamp)) = native {
        (resolve("codex"), "Codex", reading, stamp)
    } else if let Some(p) = provider {
        let mut auth = match p.id {
            "codex" => json!({}),
            "opencode-free" => {
                let limit = until - Duration::from_secs(3);
                match tokio::time::timeout_at(limit, owned.credentials()).await {
                    Ok(Ok(auth)) => auth,
                    _ => {
                        if owned.session().await? != owned.directory {
                            return Err(Refusal::Foreign);
                        }
                        return Ok(public(
                            requested,
                            q.model.as_deref(),
                            Some(p),
                            p.name,
                            special::free_unavailable(),
                            now_ms(),
                        ));
                    }
                }
            }
            _ => tokio::time::timeout_at(until, owned.credentials()).await.map_err(|_| Refusal::Unavailable)??,
        };
        let info = if matches!(p.id, "google" | "opencode-console" | "opencode-free" | "codex") {
            None
        } else {
            owned.provider(requested).await.ok()
        };
        if p.id == "claude-code" {
            auth["claude-code"] = subscriptions::claude_host(app).await.map_err(|_| Refusal::Unavailable)?;
        }
        if p.id == "opencode-go" {
            let info = info.as_ref().filter(|p| p["id"] == "opencode-go" || p["canonical"] == "opencode-go");
            let alias = info.map(|p| p["integrationID"].as_str().unwrap_or(requested));
            for id in ["opencode-go", "opencode"] {
                if alias != Some(id) {
                    auth.as_object_mut().unwrap().remove(id);
                }
            }
        }
        let ctx = settings(info.as_ref(), requested, p);
        let name = if p.id == "google" && auth["google"]["methodID"] == "antigravity" { "Antigravity" } else { p.name };
        let (result, stamp) = if matches!(p.id, "opencode-console" | "opencode-free") {
            let deadline = if free { until - Duration::from_secs(3) } else { until };
            let state = state.clone();
            // Console coalesces reads; ending the caller's wait must not cancel the shared transport.
            let task =
                tokio::spawn(
                    async move { reading(&state, p, ctx, auth, Instant::now() + Duration::from_secs(15)).await },
                );
            match tokio::time::timeout_at(deadline, task).await {
                Ok(Ok(value)) => value,
                _ if free => (special::free_unavailable(), now_ms()),
                _ => (Err(reason("opencode-console-network-error")), now_ms()),
            }
        } else {
            reading(state, p, ctx, auth, until).await
        };
        (Some(p), name, result, stamp)
    } else {
        (None, requested, Err(MISSING), now_ms())
    };
    if owned.session().await? != owned.directory {
        return Err(Refusal::Foreign);
    }
    Ok(public(requested, q.model.as_deref(), provider, name, reading, stamp))
}

async fn reading(state: &State, p: &Provider, ctx: Context, auth: Value, until: Instant) -> (Quota, u64) {
    let identity = hash(&json!([
        p.aliases.iter().map(|a| &auth[*a]).collect::<Vec<_>>(),
        ctx.integration,
        ctx.status,
        ctx.base_url,
        ctx.api_key
    ]));
    let slot = if p.id == "opencode-free" { format!("free:{identity}") } else { p.id.into() };
    let flight = state.flight(&format!("{}:{identity}", p.id));
    let _lock = flight.lock().await;
    if let Some(data) = load(&state.cache, &slot, &identity) {
        return data;
    }
    let quota = async {
        match p.id {
            "codex" => Err(MISSING),
            "github-copilot" => subscriptions::copilot(p, &auth, state.http()).await,
            "claude" | "claude-code" => subscriptions::claude(state, p, &auth).await,
            "google" => google::read(state, &auth).await,
            "xai" => xai::read(state.http(), &auth).await,
            "opencode-free" => special::console(&auth, state.http(), true).await,
            "cursor" | "ollama-cloud" | "opencode-go" | "opencode-console" => {
                special::read(p, &ctx, &auth, state.http()).await
            }
            _ => plans::read(p, &ctx, &auth, state.http()).await,
        }
    };
    let value = match p.id {
        "google" => match tokio::time::timeout_at(until - Duration::from_secs(3), quota).await {
            Ok(reading) => reading,
            Err(_) => return (Err(if auth["google"].is_object() { FAILED } else { MISSING }), now_ms()),
        },
        "opencode-console" | "opencode-free" => match tokio::time::timeout_at(until, quota).await {
            Ok(value) => value,
            Err(_) if p.id == "opencode-free" => return (special::free_unavailable(), now_ms()),
            Err(_) => return (Err(reason("opencode-console-network-error")), now_ms()),
        },
        _ => quota.await,
    };
    let now = now_ms();
    let mut expires = now + if value.is_ok() { 60_000 } else { 5_000 };
    if matches!(p.id, "opencode-console" | "opencode-free")
        && auth["opencode"]["type"] == "oauth"
        && let Some(deadline) = auth["opencode"]["expires"].as_f64()
    {
        expires = expires.min(deadline as u64);
    }
    if p.id != "opencode-free" || value.as_ref().is_ok_and(|u| u.extra.get("ok") == Some(&json!(true))) {
        save(
            &mut state.cache.lock().unwrap(),
            Cached { slot, identity, expires, stamp: now, reading: value.clone() },
            60,
        );
    }
    (value, now)
}

struct Codex {
    identity: String,
    key: String,
    account: String,
}
async fn codex_selected(owned: &Owned<'_>, requested: &str, recognized: &mut bool) -> Result<Option<Codex>, Failed> {
    let p = owned.provider(requested).await.map_err(|_| FAILED)?;
    if p["integrationID"].as_str().unwrap_or(requested) != "openai" {
        return Ok(None);
    }
    *recognized = true;
    let i = owned.binding("integration", "openai").await.map_err(|_| FAILED)?;
    let c = &i["connections"][0];
    if c["type"] != "credential" || c["method"] != "oauth" || c["status"]["status"] == "needs_auth" {
        return Err(FAILED);
    }
    let entries = owned.native("/api/credential", false).await.map_err(|_| FAILED)?;
    let e = arr(&entries["data"])
        .iter()
        .find(|e| e["active"] == true && e["id"] == c["id"] && e["integrationID"] == "openai")
        .ok_or(FAILED)?;
    let v = &e["value"];
    if v["type"] != "oauth" {
        return Err(FAILED);
    }
    if v["methodID"] == "chatgpt-token-sharing" {
        return Err(reason("openai-token-sharing-unsupported"));
    }
    if !matches!(v["methodID"].as_str(), Some("chatgpt-browser" | "chatgpt-headless"))
        || v["expires"].as_f64().is_none_or(|n| n <= (now_ms() + 120_000) as f64)
        || text(&v["access"]).is_none()
    {
        return Err(FAILED);
    }
    let access = v["access"].as_str().ok_or(FAILED)?;
    let claims = jwt(access);
    if num(&claims["exp"]).is_some_and(|n| n * 1000.0 <= (now_ms() + 120_000) as f64) {
        return Err(FAILED);
    }
    let account = text(&v["metadata"]["accountID"])
        .or_else(|| text(&claims["https://api.openai.com/auth"]["chatgpt_account_id"]))
        .ok_or(FAILED)?;
    let identity = hash(&json!([e["integrationID"], e["id"], v["methodID"], account, v["expires"], access]));
    Ok(Some(Codex { identity, key: access.into(), account: account.into() }))
}

async fn codex(state: &State, scope: &Owned<'_>, requested: &str) -> Option<(Quota, u64)> {
    let mut recognized = matches!(requested.to_ascii_lowercase().as_str(), "openai" | "codex" | "chatgpt");
    let slot = hash(&json!([
        scope.endpoint.url.as_str(),
        scope.endpoint.pid,
        scope.endpoint.password,
        scope.query.instance,
        scope.query.session,
        scope.directory,
        requested
    ]));
    let selected = match codex_selected(scope, requested, &mut recognized).await {
        Ok(Some(selected)) => selected,
        r => {
            state.codex.lock().unwrap().retain(|c| c.slot != slot);
            return match r {
                Err(e) if recognized => Some((Err(e), now_ms())),
                _ => None,
            };
        }
    };
    let flight = state.flight(&format!("codex:{slot}:{}", selected.identity));
    let _lock = flight.lock().await;
    let (result, stamp) = match load(&state.codex, &slot, &selected.identity) {
        Some(cached) => cached,
        None => (subscriptions::codex(state.http(), &selected.key, &selected.account).await, now_ms()),
    };
    let mut result = result;
    if result.is_ok() {
        match codex_selected(scope, requested, &mut recognized).await {
            Ok(Some(now)) if now.identity == selected.identity => {
                save(
                    &mut state.codex.lock().unwrap(),
                    Cached {
                        slot: slot.clone(),
                        identity: selected.identity,
                        expires: stamp + 60_000,
                        stamp,
                        reading: result.clone(),
                    },
                    128,
                );
            }
            _ => result = Err(FAILED),
        }
    }
    if result.is_err() {
        state.codex.lock().unwrap().retain(|c| c.slot != slot);
    }
    Some((result, stamp))
}

fn name(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}
fn model_key(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    let id = lower.strip_prefix("models/").unwrap_or(&lower);
    id.split(|c: char| !c.is_ascii_alphanumeric()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-")
}
fn public(
    requested: &str,
    model: Option<&str>,
    provider: Option<&Provider>,
    name_label: &str,
    data: Quota,
    stamp: u64,
) -> Value {
    let mut body = json!({
        "requestedProviderId": requested, "providerId": provider.map(|p| p.id), "providerName":name_label,
        "configured":data.as_ref().map_or_else(|f| f.configured, |_| true), "supported":provider.is_some(),
        "ok":data.is_ok(), "fetchedAt":stamp, "windows":{},
    });
    if let Some(model) = model {
        body["modelId"] = json!(model);
    }
    match data {
        Ok(mut u) => {
            if provider.is_some_and(|p| p.id == "google") {
                for (id, values) in u.models {
                    if model.is_none_or(|m| m.is_empty() || google::model(m) == Some(&id)) {
                        u.windows.extend(values.into_iter().map(|(k, v)| (format!("{k}:{id}"), v)));
                    }
                }
            } else if let Some(model) = model.filter(|s| !s.is_empty()) {
                let key = model_key(model);
                let select = u.models.iter().find(|(id, _)| model_key(name(id)) == key).or_else(|| {
                    u.models.iter().find(|(id, _)| {
                        let m = model_key(name(id));
                        m.contains(&key) || key.contains(&m)
                    })
                });
                if let Some((id, values)) = select {
                    if u.windows.is_empty() {
                        u.windows = values.clone();
                    } else {
                        u.windows.extend(values.iter().map(|(k, v)| (format!("{k}:{}", name(id)), v.clone())));
                    }
                }
            }
            body["windows"] = json!(u.windows);
            if let Some(at) = u.at {
                body["fetchedAt"] = json!(at);
            }
            body.as_object_mut().unwrap().extend(u.extra);
        }
        Err(f) => {
            if let Some(reason) = f.reason {
                body["unavailableReason"] = json!(reason);
            }
            if let Some(code) = f.code {
                body["providerErrorCode"] = json!(code);
            }
            match f.reason {
                Some("openai-token-sharing-unsupported") => body["unavailableAction"] = json!("chatgpt-usage"),
                Some("opencode-go-key-expired") => body["unavailableAction"] = json!("opencode-go-new-key"),
                _ => {}
            }
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_uses_only_active_credentials_and_keeps_console_oauth() {
        let entries = json!([
            {"active":false,"integrationID":"xai","value":{"type":"key","key":"inactive"}},
            {"active":true,"integrationID":"opencode","value":{"type":"oauth","access":"synthetic","metadata":{"server":false}}},
            {"active":true,"integrationID":"opencode","value":{"type":"key","key":"unused"}},
            {"active":true,"integrationID":"github-copilot","value":{"type":"oauth","access":"synthetic","metadata":{"enterpriseUrl":"example.test"}}}
        ]);
        let auth = project(arr(&entries));
        assert!(auth.get("xai").is_none());
        assert_eq!(auth["opencode"]["type"], "oauth");
        assert_eq!(auth["opencode"]["server"], false);
        assert_eq!(auth["github-copilot"]["enterpriseUrl"], "example.test");
        assert_eq!(resolve("opencode").unwrap().id, "opencode-console");
        assert!(query(Some("instanceId=w&sessionId=s&modelId=&modelId=x")).is_none());
    }
}
