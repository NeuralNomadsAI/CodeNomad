//! Provider account selection adapters, admission-time rotation and reactive quota failure observer.
use std::{
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::http::StatusCode as Status;
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use super::{
    Context, Endpoint, plans,
    quota_marks::{EventDedupe, MAX_PENDING, QuotaFailure, QuotaMarks, parse_quota_failure},
    shared::*,
    special, subscriptions,
};
use crate::{App, Error, Shared, auth::Principal, error, shared::now_ms};

const MAX_SECRET_UTF16: usize = 16_384;
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(15);
const MARK_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_MARK_SETTLE: Duration = Duration::from_millis(500);

#[derive(Clone, Copy)]
pub(super) struct AdapterSpec {
    pub integration_id: &'static str,
    pub providers: Option<&'static [&'static str]>,
    pub methods: &'static [&'static str],
    pub reactive: bool,
}

const ADAPTERS: &[AdapterSpec] = &[
    AdapterSpec { integration_id: "openai", providers: None, methods: &["oauth"], reactive: false },
    AdapterSpec { integration_id: "opencode-go", providers: Some(&["opencode-go"]), methods: &["key"], reactive: true },
    AdapterSpec {
        integration_id: "opencode",
        providers: Some(&["opencode-go"]),
        methods: &["oauth", "key"],
        reactive: true,
    },
    AdapterSpec { integration_id: "anthropic", providers: None, methods: &["oauth"], reactive: true },
    AdapterSpec { integration_id: "github-copilot", providers: None, methods: &["oauth"], reactive: false },
    AdapterSpec { integration_id: "zai-coding-plan", providers: None, methods: &["key"], reactive: false },
    AdapterSpec { integration_id: "zhipuai-coding-plan", providers: None, methods: &["key"], reactive: false },
    AdapterSpec { integration_id: "kimi-for-coding", providers: None, methods: &["key"], reactive: false },
    AdapterSpec { integration_id: "minimax-coding-plan", providers: None, methods: &["key"], reactive: false },
    AdapterSpec { integration_id: "minimax-cn-coding-plan", providers: None, methods: &["key"], reactive: false },
];

pub(super) fn adapter(integration_id: &str) -> Option<&'static AdapterSpec> {
    ADAPTERS.iter().find(|spec| spec.integration_id == integration_id)
}

pub(super) fn supports(integration_id: &str) -> bool {
    adapter(integration_id).is_some()
}

pub(super) fn adapter_for_provider(provider: &Value) -> Option<&'static AdapterSpec> {
    let key = provider["integrationID"].as_str().or_else(|| provider["id"].as_str())?;
    let spec = adapter(key)?;
    let Some(allowed) = spec.providers else {
        return Some(spec);
    };
    let id = provider["id"].as_str();
    let canonical = provider["canonical"].as_str();
    let matches = id.is_some_and(|v| allowed.contains(&v)) || canonical.is_some_and(|v| allowed.contains(&v));
    matches.then_some(spec)
}

pub(super) fn accepts_method(spec: &AdapterSpec, method: &str) -> bool {
    spec.methods.contains(&method)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ReadState {
    Unknown,
    Available,
    Exhausted,
    Rejected,
}

pub(super) fn definite_rejection(status: u16) -> bool {
    (400..500).contains(&status) && status != 408 && status != 429
}

/// Past reset snapshots and empty/non-numeric usage are not availability evidence.
pub(super) fn quota_state(windows: &Fields, now: u64) -> ReadState {
    let relevant: Vec<&Value> = windows
        .iter()
        .filter(|(label, window)| {
            window["windowSeconds"].as_f64().is_some_and(|s| s.is_finite() && s > 0.0)
                || label.as_str() == "monthly"
                || label.as_str() == "monthly-code"
        })
        .map(|(_, window)| window)
        .collect();
    if relevant.is_empty()
        || relevant.iter().any(|window| {
            let used = window["usedPercent"].as_f64();
            let reset = window["resetAt"].as_f64();
            used.is_none_or(|n| !n.is_finite()) || reset.is_some_and(|r| !r.is_finite() || r <= now as f64)
        })
    {
        return ReadState::Unknown;
    }
    if relevant.iter().any(|window| window["usedPercent"].as_f64().is_some_and(|n| n >= 100.0)) {
        ReadState::Exhausted
    } else {
        ReadState::Available
    }
}

/// Strict Codex selection parser (`codex-selection-quota.ts`): rejects malformed declared
/// windows, missing/past resets, duplicate durations, out-of-range percentages and
/// contradictory availability flags before any normalization can omit or clamp them.
pub(super) fn parse_codex_selection_quota(payload: &Value, now: u64) -> Result<Usage, Failed> {
    let rate = payload.get("rate_limit").and_then(Value::as_object).ok_or(FAILED)?;
    for flag in ["allowed", "limit_reached"] {
        if let Some(value) = rate.get(flag)
            && !value.is_boolean()
        {
            return Err(FAILED);
        }
    }
    let sources: Vec<&Value> = ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|name| rate.get(name).filter(|v| !v.is_null()))
        .collect();
    if sources.is_empty() {
        return Err(FAILED);
    }
    let mut durations = Vec::with_capacity(sources.len());
    let mut exhausted = false;
    let mut windows = Fields::new();
    for source in sources {
        let obj = source.as_object().ok_or(FAILED)?;
        let seconds =
            num(obj.get("limit_window_seconds").unwrap_or(&Value::Null)).filter(|n| *n > 0.0).ok_or(FAILED)?;
        if durations.contains(&seconds) {
            return Err(FAILED);
        }
        let used =
            num(obj.get("used_percent").unwrap_or(&Value::Null)).filter(|n| (0.0..=100.0).contains(n)).ok_or(FAILED)?;
        let reset = timestamp(obj.get("reset_at").unwrap_or(&Value::Null)).filter(|r| *r > now as f64).ok_or(FAILED)?;
        durations.push(seconds);
        if used == 100.0 {
            exhausted = true;
        }
        windows.insert(label(Some(seconds)), window(Some(used), Some(seconds), Some(reset), None));
    }
    if !exhausted
        && (rate.get("allowed") == Some(&Value::Bool(false)) || rate.get("limit_reached") == Some(&Value::Bool(true)))
    {
        return Err(FAILED);
    }
    Ok(windows.into())
}

/// Server-only projected credential for selection. Never log, cache or serialize it.
pub(super) struct SelectionCredential {
    pub identity: String,
    pub login: Option<String>,
    kind: CredentialKind,
}

enum CredentialKind {
    Codex { access: String, account_id: String },
    Go { projected: Value },
    Usage { integration_id: &'static str, projected: Value, readable: bool },
}

pub(super) fn display_email(email: &str) -> bool {
    if email.encode_utf16().count() > 254
        || email.chars().any(|ch| ch.is_whitespace() || ch.is_ascii_control() || ch == '\u{feff}')
    {
        return false;
    }
    email.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty()
            && !domain.contains('@')
            && domain.rsplit_once('.').is_some_and(|(name, suffix)| !name.is_empty() && !suffix.is_empty())
    })
}

pub(super) fn project_one(entry: &Value) -> Option<Value> {
    let v = &entry["value"];
    let id = entry["integrationID"].as_str()?;
    if !matches!(v["type"].as_str(), Some("key" | "oauth")) {
        return None;
    }
    let metadata = &v["metadata"];
    let mut out = if v["type"] == "key" {
        json!({"type": "api", "key": v["key"]})
    } else {
        let mut out = json!({"type": "oauth"});
        for field in ["methodID", "access", "refresh", "expires"] {
            if let Some(val) = v.get(field) {
                out[field] = val.clone();
            }
        }
        if let Some(account) = metadata["accountID"].as_str() {
            out["accountId"] = json!(account);
        }
        if id == "google" {
            if let Some(cid) = entry.get("id") {
                out["credentialID"] = cid.clone();
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
    Some(out)
}

pub(super) fn build_credential(spec: &AdapterSpec, entry: &Value, now: u64) -> Option<SelectionCredential> {
    if entry["integrationID"].as_str() != Some(spec.integration_id) {
        return None;
    }
    let id = entry["id"].as_str().filter(|id| !id.is_empty() && id.encode_utf16().count() <= 256)?;
    let value = &entry["value"];
    let kind = value["type"].as_str()?;
    if !spec.methods.contains(&kind) {
        return None;
    }
    if spec.integration_id == "openai" {
        if kind != "oauth" {
            return None;
        }
        let method_id = value["methodID"].as_str()?;
        let access = text(&value["access"])?;
        let expires = value["expires"].as_f64()?;
        let limit = (now + 120_000) as f64;
        let claims = jwt(access);
        if !matches!(method_id, "chatgpt-browser" | "chatgpt-headless")
            || !expires.is_finite()
            || expires <= limit
            || claims.get("exp").is_some_and(|v| {
                v.is_null()
                    || v.is_boolean()
                    || v.as_str().is_some_and(|t| crate::shared::js_trim(t).is_empty())
                    || num(v).is_some_and(|exp| exp * 1000.0 <= limit)
            })
        {
            return None;
        }
        let account_id = text(&value["metadata"]["accountID"])
            .or_else(|| text(&claims["https://api.openai.com/auth"]["chatgpt_account_id"]))?
            .to_owned();
        let identity =
            hash(&json!([spec.integration_id, id, method_id, account_id, value["expires"], value["access"]]));
        let email = text(&value["metadata"]["email"])
            .or_else(|| text(&claims["https://api.openai.com/profile"]["email"]))
            .or_else(|| text(&claims["email"]))
            .filter(|email| display_email(email))
            .map(str::to_owned);
        return Some(SelectionCredential {
            identity,
            login: email,
            kind: CredentialKind::Codex { access: value["access"].as_str()?.to_owned(), account_id },
        });
    }

    if kind == "key" {
        let key_str = value["key"].as_str()?;
        if key_str.encode_utf16().count() > MAX_SECRET_UTF16 || text(&value["key"]).is_none() {
            return None;
        }
    } else {
        let access_str = value["access"].as_str()?;
        if access_str.encode_utf16().count() > MAX_SECRET_UTF16 || text(&value["access"]).is_none() {
            return None;
        }
        if spec.integration_id == "opencode" && value["methodID"] != "device" {
            return None;
        }
    }

    let projected = project_one(entry)?;
    let identity = hash(&json!([spec.integration_id, id, projected]));
    let email = if kind == "oauth" {
        text(&value["metadata"]["email"]).filter(|e| display_email(e)).map(str::to_owned)
    } else {
        None
    };

    let cred_kind = if matches!(spec.integration_id, "opencode-go" | "opencode") {
        CredentialKind::Go { projected }
    } else {
        let readable = if spec.integration_id == "github-copilot" {
            value["metadata"].get("enterpriseUrl").is_none()
        } else {
            true
        };
        CredentialKind::Usage { integration_id: spec.integration_id, projected, readable }
    };

    Some(SelectionCredential { identity, login: email, kind: cred_kind })
}

async fn read_credential_quota(cred: &SelectionCredential, http: &Http) -> ReadState {
    let result: Quota = match &cred.kind {
        CredentialKind::Codex { access, account_id } => {
            let auth = format!("Bearer {access}");
            match http
                .get(
                    "https://chatgpt.com/backend-api/wham/usage",
                    &[
                        ("Authorization", &auth),
                        ("ChatGPT-Account-Id", account_id),
                        ("Content-Type", "application/json"),
                    ],
                    true,
                )
                .await
            {
                Ok(payload) => parse_codex_selection_quota(&payload, now_ms()),
                Err(err) => Err(err),
            }
        }
        CredentialKind::Go { projected } => special::go_selection(projected, http, now_ms()).await,
        CredentialKind::Usage { integration_id, projected, readable } => {
            if !readable {
                Err(FAILED)
            } else {
                read_usage_selection(integration_id, projected, http).await
            }
        }
    };
    let after = now_ms();
    match result {
        Ok(usage) => quota_state(&usage.windows, after),
        Err(failed) => {
            if failed.status.is_some_and(definite_rejection) {
                ReadState::Rejected
            } else {
                ReadState::Unknown
            }
        }
    }
}

async fn read_usage_selection(integration_id: &'static str, projected: &Value, http: &Http) -> Quota {
    let auth = json!({ integration_id: projected });
    let provider = super::resolve(integration_id).ok_or(FAILED)?;
    let ctx = Context { integration: Some(integration_id.to_owned()), status: "available", ..Default::default() };
    let usage = match integration_id {
        "anthropic" => subscriptions::claude_fresh(&auth, http).await?,
        "github-copilot" => subscriptions::copilot(provider, &auth, http).await?,
        _ => plans::read(provider, &ctx, &auth, http).await?,
    };
    let windows = match integration_id {
        "anthropic" => usage.windows,
        "github-copilot" => select_windows(&usage.windows, &[], &[], Some(30.0 * DAY), true),
        "zai-coding-plan" | "zhipuai-coding-plan" => select_windows(&usage.windows, &["mcp-tools"], &[], None, false),
        "kimi-for-coding" => select_windows(&usage.windows, &[], &[("weekly", 7.0 * DAY)], None, false),
        "minimax-coding-plan" | "minimax-cn-coding-plan" => {
            select_windows(&usage.windows, &[], &[("5h", 5.0 * HOUR), ("weekly", 7.0 * DAY)], None, false)
        }
        _ => usage.windows,
    };
    Ok(windows.into())
}

fn select_windows(
    source: &Fields,
    drop: &[&str],
    defaults: &[(&str, f64)],
    fallback_seconds: Option<f64>,
    drop_unmeasured: bool,
) -> Fields {
    let mut result = Fields::new();
    for (label, window) in source {
        if drop.contains(&label.as_str()) || (drop_unmeasured && window["usedPercent"].is_null()) {
            continue;
        }
        let mut entry = window.clone();
        let has_seconds = entry["windowSeconds"].as_f64().is_some_and(|s| s.is_finite() && s > 0.0);
        if !has_seconds {
            let fallback = defaults.iter().find(|(k, _)| *k == label.as_str()).map(|(_, s)| *s).or(fallback_seconds);
            entry["windowSeconds"] = json!(fallback);
        }
        result.insert(label.clone(), entry);
    }
    result
}

#[derive(Default)]
struct ConnectionInner {
    epoch: u64,
    manual: usize,
    marks: QuotaMarks,
}

pub(crate) struct ConnectionState {
    gate: Arc<AsyncMutex<()>>,
    activate_gate: Arc<AsyncMutex<()>>,
    observer_gate: Arc<AsyncMutex<()>>,
    observer_pending: AtomicUsize,
    inner: Mutex<ConnectionInner>,
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self {
            gate: Arc::new(AsyncMutex::new(())),
            activate_gate: Arc::new(AsyncMutex::new(())),
            observer_gate: Arc::new(AsyncMutex::new(())),
            observer_pending: AtomicUsize::new(0),
            inner: Mutex::new(ConnectionInner::default()),
        }
    }
}

/// RAII fence held while a local manual credential/integration mutation is in flight.
pub(crate) struct ManualGuard {
    state: Arc<ConnectionState>,
    released: bool,
}

impl Drop for ManualGuard {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            let mut inner = self.state.inner.lock().unwrap();
            inner.manual = inner.manual.saturating_sub(1);
            inner.epoch = inner.epoch.saturating_add(1);
        }
    }
}

pub(crate) struct AccountService {
    policy_revision: AtomicU64,
    connections: Mutex<Vec<(Weak<Endpoint>, Arc<ConnectionState>)>>,
    dedupe: Mutex<EventDedupe>,
    mark_settle: Duration,
    preflight_timeout: Duration,
}

impl Default for AccountService {
    fn default() -> Self {
        Self::with_timeouts(DEFAULT_MARK_SETTLE, PREFLIGHT_TIMEOUT)
    }
}

impl AccountService {
    pub(crate) fn with_timeouts(mark_settle: Duration, preflight_timeout: Duration) -> Self {
        Self {
            policy_revision: AtomicU64::new(0),
            connections: Mutex::new(Vec::new()),
            dedupe: Mutex::new(EventDedupe::default()),
            mark_settle,
            preflight_timeout,
        }
    }
    #[cfg(test)]
    pub(super) fn active_at(&self, endpoint: &Arc<Endpoint>, integration_id: &str, at: f64) -> Option<Option<String>> {
        let state = self.connection_state(endpoint);
        let inner = state.inner.lock().unwrap();
        inner.marks.active_at(integration_id, at).map(|opt| opt.map(str::to_owned))
    }

    fn connection_state(&self, endpoint: &Arc<Endpoint>) -> Arc<ConnectionState> {
        let mut list = self.connections.lock().unwrap();
        list.retain(|(weak, _)| weak.strong_count() > 0);
        if let Some((_, existing)) =
            list.iter().find(|(weak, _)| weak.upgrade().is_some_and(|e| Arc::ptr_eq(&e, endpoint)))
        {
            return Arc::clone(existing);
        }
        let created = Arc::new(ConnectionState::default());
        list.push((Arc::downgrade(endpoint), Arc::clone(&created)));
        created
    }

    pub(crate) fn note_policy_change(&self) {
        self.policy_revision.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn policy_revision(&self) -> u64 {
        self.policy_revision.load(Ordering::SeqCst)
    }

    /// Fence local explicit credential/integration mutations immediately, including switches
    /// away and back. A manual account change also forgets reactive exhaustion marks.
    pub(crate) async fn manual_fence(&self, endpoint: &Arc<Endpoint>) -> ManualGuard {
        let state = self.connection_state(endpoint);
        let activate = state.activate_gate.lock().await;
        {
            let mut inner = state.inner.lock().unwrap();
            inner.epoch = inner.epoch.saturating_add(1);
            inner.manual = inner.manual.saturating_add(1);
            inner.marks.manual_change(now_ms());
        }
        drop(activate);
        ManualGuard { state, released: false }
    }

    pub(crate) fn is_enabled(&self, app: &App, integration_id: &str) -> bool {
        if !supports(integration_id) {
            return false;
        }
        app.settings
            .owner(crate::settings::Kind::Config, "providerAccounts")
            .get("autoSelect")
            .and_then(|policy| policy.get(integration_id))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn any_enabled(&self, app: &App) -> bool {
        let owner = app.settings.owner(crate::settings::Kind::Config, "providerAccounts");
        let Some(policy) = owner.get("autoSelect").and_then(Value::as_object) else {
            return false;
        };
        ADAPTERS.iter().any(|spec| policy.get(spec.integration_id).and_then(Value::as_bool) == Some(true))
    }

    /// Synchronous, bounded native event hook called when an `instance.event` is routed to an
    /// owned workspace. Attribution reads run off the relay per connection.
    pub(crate) fn observe_event(&self, app: &Shared, endpoint: &Arc<Endpoint>, event: &Value) {
        let Some(kind) = event["type"].as_str() else { return };
        if !matches!(
            kind,
            "credential.switched" | "session.step.started" | "session.step.failed" | "session.execution.failed"
        ) {
            return;
        }
        {
            let mut dedupe = self.dedupe.lock().unwrap();
            if !dedupe.once(event["id"].as_str()) {
                return;
            }
        }
        let created = event["created"].as_f64().filter(|n| n.is_finite()).unwrap_or_else(|| now_ms() as f64);
        let state = self.connection_state(endpoint);
        if kind == "credential.switched" {
            if let Some(integration_id) = event["data"]["integrationID"].as_str() {
                let cred = match event["data"].get("credentialID") {
                    Some(Value::String(id)) => Some(Some(id.clone())),
                    Some(Value::Null) => Some(None),
                    _ => None,
                };
                state.inner.lock().unwrap().marks.switched(integration_id, created, cred);
            }
            return;
        }
        if kind == "session.step.started" {
            if let Some(session_id) = event["data"]["sessionID"].as_str() {
                let provider_id = event["data"]["model"]["providerID"].as_str().map(str::to_owned);
                state.inner.lock().unwrap().marks.step_started(session_id, created, provider_id);
            }
            return;
        }
        let Some(mut failure) = parse_quota_failure(event) else { return };
        failure.watermark = Some(state.inner.lock().unwrap().marks.watermark());
        {
            let mut dedupe = self.dedupe.lock().unwrap();
            if !dedupe.accept_failure(&failure.session_id, failure.failed_at) {
                return;
            }
        }
        if state
            .observer_pending
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_PENDING).then_some(n + 1))
            .is_err()
        {
            return;
        }
        let app = Arc::clone(app);
        let endpoint = Arc::clone(endpoint);
        let conn = Arc::clone(&state);
        tokio::spawn(async move {
            let _pending = PendingGuard(&conn.observer_pending);
            let _lock = conn.observer_gate.lock().await;
            let _ = tokio::time::timeout(
                MARK_TIMEOUT,
                app.provider_usage.accounts.mark_quota_failure(&app, &endpoint, &failure),
            )
            .await;
        });
    }

    pub(super) async fn mark_quota_failure(&self, app: &App, endpoint: &Arc<Endpoint>, failure: &QuotaFailure) -> bool {
        let state = self.connection_state(endpoint);
        let (watermark, step_started_at, step_provider, epoch) = {
            let inner = state.inner.lock().unwrap();
            let watermark = failure.watermark.unwrap_or_else(|| inner.marks.watermark());
            let (started, provider) = inner.marks.step_for(&failure.session_id, failure.failed_at);
            (watermark, started, provider, inner.epoch)
        };
        if !app.native.current(endpoint) {
            return false;
        }
        let Ok(session) = native_session(app, endpoint, &failure.session_id).await else { return false };
        let provider_id = step_provider.as_deref().or_else(|| session["model"]["providerID"].as_str());
        let Some(provider_id) = provider_id else { return false };
        if session["location"].get("workspaceID").is_some() {
            return false;
        }
        let Some(directory) = session["location"]["directory"].as_str() else { return false };
        let Ok(provider) = native_provider(app, endpoint, provider_id, directory).await else { return false };
        let Some(spec) = adapter_for_provider(&provider) else { return false };
        if !self.is_enabled(app, spec.integration_id) {
            return false;
        }
        let integration_id = spec.integration_id;
        let Ok(integration) = native_integration(app, endpoint, integration_id, directory).await else { return false };
        let Some(selected) = integration["connections"].as_array().and_then(|list| list.first()) else { return false };
        let Some(selected_id) = selected["id"].as_str() else { return false };
        if selected["type"] != "credential" || !selected["method"].as_str().is_some_and(|m| accepts_method(spec, m)) {
            return false;
        }
        {
            let inner = state.inner.lock().unwrap();
            if let Some(known) = inner.marks.active_at(integration_id, step_started_at)
                && known != Some(selected_id)
            {
                return false;
            }
        }
        let Some(identity) = active_identity(app, endpoint, spec, selected_id).await else { return false };
        let is_fenced = || {
            let inner = state.inner.lock().unwrap();
            epoch != inner.epoch
                || inner.manual > 0
                || inner.marks.switched_since(integration_id, step_started_at)
                || inner.marks.changed_after(integration_id, watermark)
        };
        if is_fenced() {
            return false;
        }
        if !self.mark_settle.is_zero() {
            tokio::time::sleep(self.mark_settle).await;
        }
        let Ok(latest) = native_integration(app, endpoint, integration_id, directory).await else { return false };
        let Some(current) = latest["connections"].as_array().and_then(|list| list.first()) else { return false };
        if current["type"] != "credential"
            || current["id"].as_str() != Some(selected_id)
            || active_identity(app, endpoint, spec, selected_id).await.as_deref() != Some(identity.as_str())
        {
            return false;
        }
        if !app.native.current(endpoint) {
            return false;
        }
        let mut inner = state.inner.lock().unwrap();
        if epoch != inner.epoch
            || inner.manual > 0
            || inner.marks.switched_since(integration_id, step_started_at)
            || inner.marks.changed_after(integration_id, watermark)
        {
            return false;
        }
        inner.marks.mark(integration_id, selected_id, failure.limit_name.as_deref(), now_ms());
        true
    }
}

struct ActivationGuard {
    state: Arc<ConnectionState>,
    integration_id: &'static str,
    completed_ok: bool,
}

impl Drop for ActivationGuard {
    fn drop(&mut self) {
        if !self.completed_ok {
            self.state.inner.lock().unwrap().marks.active_unknown(self.integration_id);
        }
    }
}

struct PendingGuard<'a>(&'a AtomicUsize);
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn selection_failed() -> Error {
    error(Status::BAD_GATEWAY, "PROVIDER_ACCOUNT_SELECTION_FAILED")
}

/// Admission-time provider account rotation before prompt/command forwarding.
/// Never blocks when disabled or quota is unavailable; ambiguous activation fails closed with 502.
pub(crate) async fn before_send<F, Fut>(
    app: &App,
    endpoint: &Arc<Endpoint>,
    principal: &Principal,
    session_id: &str,
    validate: F,
) -> Result<(), Error>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = bool>,
{
    before_send_with_http(app, endpoint, principal, session_id, app.provider_usage.http(), validate).await
}

pub(crate) async fn before_send_with_http<F, Fut>(
    app: &App,
    endpoint: &Arc<Endpoint>,
    principal: &Principal,
    session_id: &str,
    http: &Http,
    validate: F,
) -> Result<(), Error>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = bool>,
{
    let service = &app.provider_usage.accounts;
    if !service.any_enabled(app) {
        return Ok(());
    }
    let state = service.connection_state(endpoint);
    let activation_dispatched = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dispatched_ref = Arc::clone(&activation_dispatched);
    let work = async {
        let _gate = state.gate.lock().await;
        principal.live()?;
        if !app.native.current(endpoint) {
            return Err(crate::opencode::pre_dispatch_unavailable());
        }
        let (epoch, manual) = {
            let inner = state.inner.lock().unwrap();
            (inner.epoch, inner.manual)
        };
        let policy_revision = service.policy_revision();
        if !service.any_enabled(app) || manual > 0 {
            return Ok(());
        }
        let Ok(session) = native_session(app, endpoint, session_id).await else { return Ok(()) };
        let Some(provider_id) = session["model"]["providerID"].as_str() else { return Ok(()) };
        let Some(model_id) = session["model"]["id"].as_str() else { return Ok(()) };
        if session["location"].get("workspaceID").is_some() {
            return Ok(());
        }
        let Some(directory) = session["location"]["directory"].as_str() else { return Ok(()) };
        if !validate(directory.to_owned()).await {
            return Ok(());
        }
        let Ok(provider) = native_provider(app, endpoint, provider_id, directory).await else { return Ok(()) };
        let Some(spec) = adapter_for_provider(&provider) else { return Ok(()) };
        if !service.is_enabled(app, spec.integration_id) {
            return Ok(());
        }
        let integration_id = spec.integration_id;
        let Ok(integration) = native_integration(app, endpoint, integration_id, directory).await else { return Ok(()) };
        let Some(connections) = integration["connections"].as_array() else { return Ok(()) };
        let Some(selected) = connections.first() else { return Ok(()) };
        let Some(selected_id) = selected["id"].as_str() else { return Ok(()) };
        if selected["type"] != "credential"
            || !selected["method"].as_str().is_some_and(|m| accepts_method(spec, m))
            || selected["status"]["status"] == "needs_auth"
        {
            return Ok(());
        }
        let Ok(entries) = native_credentials(app, endpoint).await else { return Ok(()) };
        let Some(current_entry) = entries
            .iter()
            .find(|e| e["integrationID"] == integration_id && e["id"] == selected_id && e["active"] == true)
        else {
            return Ok(());
        };
        let Some(current) = build_credential(spec, current_entry, now_ms()) else { return Ok(()) };
        let current_read = read_credential_quota(&current, http).await;
        if current_read == ReadState::Available {
            state.inner.lock().unwrap().marks.clear(integration_id, selected_id);
            return Ok(());
        }
        let current_marked = state.inner.lock().unwrap().marks.has(integration_id, selected_id, now_ms());
        if current_read != ReadState::Exhausted && !current_marked {
            return Ok(());
        }

        // Stable native catalog order; at most 20 candidates; never temporarily activate candidates.
        for candidate in connections.iter().skip(1).take(20) {
            if candidate["type"] != "credential"
                || !candidate["method"].as_str().is_some_and(|m| accepts_method(spec, m))
                || candidate["status"]["status"] == "needs_auth"
            {
                continue;
            }
            let Some(candidate_id) = candidate["id"].as_str() else { continue };
            let Some(entry) = entries.iter().find(|e| e["integrationID"] == integration_id && e["id"] == candidate_id)
            else {
                continue;
            };
            let Some(cred) = build_credential(spec, entry, now_ms()) else { continue };
            let read = read_credential_quota(&cred, http).await;
            let acceptable = match read {
                ReadState::Available => {
                    state.inner.lock().unwrap().marks.clear(integration_id, candidate_id);
                    true
                }
                ReadState::Unknown if spec.reactive => {
                    !state.inner.lock().unwrap().marks.has(integration_id, candidate_id, now_ms())
                }
                _ => false,
            };
            if !acceptable {
                continue;
            }

            let fenced = || {
                let inner = state.inner.lock().unwrap();
                epoch != inner.epoch
                    || inner.manual > 0
                    || policy_revision != service.policy_revision()
                    || !service.is_enabled(app, integration_id)
            };
            if fenced() || !validate(directory.to_owned()).await {
                return Ok(());
            }

            let Ok(latest) = native_integration(app, endpoint, integration_id, directory).await else { return Ok(()) };
            let Ok(fresh_entries) = native_credentials(app, endpoint).await else { return Ok(()) };
            let latest_connections = latest["connections"].as_array();
            let current_conn = latest_connections.and_then(|c| c.first());
            let candidate_conn = latest_connections
                .and_then(|c| c.iter().find(|item| item["type"] == "credential" && item["id"] == candidate_id));
            let fresh_current = fresh_entries
                .iter()
                .find(|e| e["id"] == selected_id && e["active"] == true && e["integrationID"] == integration_id);
            let fresh_candidate =
                fresh_entries.iter().find(|e| e["id"] == candidate_id && e["integrationID"] == integration_id);
            let verify_now = now_ms();
            if current_conn.is_none_or(|c| c["type"] != "credential" || c["id"] != selected_id)
                || candidate_conn.is_none_or(|c| c["status"]["status"] == "needs_auth")
                || fresh_current.and_then(|e| build_credential(spec, e, verify_now)).map(|c| c.identity).as_deref()
                    != Some(current.identity.as_str())
                || fresh_candidate.and_then(|e| build_credential(spec, e, verify_now)).map(|c| c.identity).as_deref()
                    != Some(cred.identity.as_str())
            {
                return Ok(());
            }

            let Ok(latest_session) = native_session(app, endpoint, session_id).await else { return Ok(()) };
            if latest_session["location"]["directory"] != directory
                || latest_session["location"].get("workspaceID").is_some()
                || latest_session["model"]["providerID"] != provider_id
                || latest_session["model"]["id"] != model_id
                || !validate(directory.to_owned()).await
            {
                return Ok(());
            }
            let _activate_lock = state.activate_gate.lock().await;
            principal.live()?;
            if !app.native.current(endpoint) {
                return Err(crate::opencode::pre_dispatch_unavailable());
            }
            {
                let mut inner = state.inner.lock().unwrap();
                if epoch != inner.epoch
                    || inner.manual > 0
                    || policy_revision != service.policy_revision()
                    || !service.is_enabled(app, integration_id)
                    || (read == ReadState::Unknown && inner.marks.has(integration_id, candidate_id, now_ms()))
                {
                    return Ok(());
                }
                inner.marks.switched(integration_id, now_ms() as f64, Some(Some(candidate_id.to_owned())));
            }
            let url = endpoint
                .url
                .join(&format!("/api/credential/{}/activate", plans::encode(candidate_id)))
                .map_err(|_| selection_failed())?;
            dispatched_ref.store(true, Ordering::SeqCst);
            let mut activation_guard =
                ActivationGuard { state: Arc::clone(&state), integration_id, completed_ok: false };
            let activated = app
                .native
                .client
                .post(url)
                .basic_auth("opencode", Some(&endpoint.password))
                .send()
                .await
                .is_ok_and(|res| res.status() == Status::NO_CONTENT);
            if !activated {
                return Err(selection_failed());
            }
            activation_guard.completed_ok = true;
            return Ok(());
        }
        Ok(())
    };

    tokio::select! {
        biased;
        _ = principal.0.cancelled() => {
            if activation_dispatched.load(Ordering::SeqCst) {
                Err(selection_failed())
            } else {
                Err(crate::auth::unauthorized())
            }
        }
        _ = app.native.wait_retired(endpoint) => {
            if activation_dispatched.load(Ordering::SeqCst) {
                Err(selection_failed())
            } else {
                Err(crate::opencode::pre_dispatch_unavailable())
            }
        }
        result = tokio::time::timeout(service.preflight_timeout, work) => match result {
            Ok(outcome) => outcome,
            Err(_) => {
                if activation_dispatched.load(Ordering::SeqCst) {
                    Err(selection_failed())
                } else if !app.native.current(endpoint) {
                    Err(crate::opencode::pre_dispatch_unavailable())
                } else {
                    Ok(())
                }
            }
        }
    }
}

async fn native_get(app: &App, endpoint: &Endpoint, url: reqwest::Url) -> Result<Value, ()> {
    let response =
        app.native.client.get(url).basic_auth("opencode", Some(&endpoint.password)).send().await.map_err(|_| ())?;
    if response.status() != Status::OK {
        return Err(());
    }
    crate::opencode::read_json(response, 8 * 1024 * 1024).await.map_err(|_| ())
}

async fn native_session(app: &App, endpoint: &Arc<Endpoint>, session_id: &str) -> Result<Value, ()> {
    if matches!(session_id, "" | "." | "..") {
        return Err(());
    }
    let url = endpoint.url.join(&format!("/api/session/{}", plans::encode(session_id))).map_err(|_| ())?;
    let payload = native_get(app, endpoint, url).await?;
    if !app.native.current(endpoint) || payload["data"]["id"] != session_id {
        return Err(());
    }
    Ok(payload["data"].clone())
}

async fn native_provider(app: &App, endpoint: &Arc<Endpoint>, provider_id: &str, directory: &str) -> Result<Value, ()> {
    if matches!(provider_id, "" | "." | "..") {
        return Err(());
    }
    let mut url = endpoint.url.join(&format!("/api/provider/{}", plans::encode(provider_id))).map_err(|_| ())?;
    url.query_pairs_mut().append_pair("location[directory]", directory);
    let payload = native_get(app, endpoint, url).await?;
    if !app.native.current(endpoint)
        || payload["location"]["directory"] != directory
        || payload["location"].get("workspaceID").is_some()
        || payload["data"]["id"] != provider_id
    {
        return Err(());
    }
    Ok(payload["data"].clone())
}

async fn native_integration(
    app: &App,
    endpoint: &Arc<Endpoint>,
    integration_id: &str,
    directory: &str,
) -> Result<Value, ()> {
    if matches!(integration_id, "" | "." | "..") {
        return Err(());
    }
    let mut url = endpoint.url.join(&format!("/api/integration/{}", plans::encode(integration_id))).map_err(|_| ())?;
    url.query_pairs_mut().append_pair("location[directory]", directory);
    let payload = native_get(app, endpoint, url).await?;
    if !app.native.current(endpoint)
        || payload["location"]["directory"] != directory
        || payload["location"].get("workspaceID").is_some()
        || payload["data"]["id"] != integration_id
    {
        return Err(());
    }
    Ok(payload["data"].clone())
}

async fn native_credentials(app: &App, endpoint: &Arc<Endpoint>) -> Result<Vec<Value>, ()> {
    let url = endpoint.url.join("/api/credential").map_err(|_| ())?;
    let payload = native_get(app, endpoint, url).await?;
    if !app.native.current(endpoint) {
        return Err(());
    }
    payload["data"].as_array().cloned().ok_or(())
}

async fn active_identity(
    app: &App,
    endpoint: &Arc<Endpoint>,
    spec: &AdapterSpec,
    credential_id: &str,
) -> Option<String> {
    let entries = native_credentials(app, endpoint).await.ok()?;
    let entry = entries
        .iter()
        .find(|e| e["integrationID"] == spec.integration_id && e["id"] == credential_id && e["active"] == true)?;
    build_credential(spec, entry, now_ms()).map(|c| c.identity)
}
