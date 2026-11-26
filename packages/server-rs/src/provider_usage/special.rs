//! Cursor and cookie-authenticated dashboard reads, and OpenCode Console/Go quota.
use std::time::Duration;

use serde_json::{Value, json};

use super::{Context, Provider, plans::encode, shared::*};
use crate::shared::now_ms;

const CONSOLE: &str = "https://opencode.ai/console";

pub async fn read(p: &Provider, ctx: &Context, auth: &Value, http: &Http) -> Quota {
    match p.id {
        "cursor" => cursor(http).await,
        "ollama-cloud" => ollama(http).await,
        "opencode-go" => go(ctx, auth, http).await,
        "opencode-console" => console(auth, http, false).await,
        _ => Err(MISSING),
    }
}

async fn cursor(http: &Http) -> Quota {
    let auth = var("CURSOR_ACCESS_TOKEN").or_else(|_| var("CURSOR_TOKEN"))?;
    if jwt(&auth)["exp"].as_f64().is_some_and(|n| n * 1000.0 <= (now_ms() + 300_000) as f64) {
        return Err(reason("cursor-token-expired"));
    }
    let auth = format!("Bearer {auth}");
    let request = |path: &str, body: Option<Value>| {
        let url = format!("https://api2.cursor.sh/{path}");
        let auth = &auth;
        async move {
            if let Some(body) = body {
                http.post(
                    &url,
                    &[("Authorization", auth), ("Content-Type", "application/json"), ("Connect-Protocol-Version", "1")],
                    &body,
                )
                .await
            } else {
                http.get(&url, &[("Authorization", auth)], true).await
            }
        }
    };
    let failure = |status| match status {
        Some(401) => reason("cursor-token-expired"),
        Some(403) => reason("cursor-access-denied"),
        _ => reason("cursor-usage-unavailable"),
    };
    let mut failed_status = None;
    macro_rules! optional {
        ($future:expr) => {{
            match $future.await {
                Ok(v) => v,
                Err(Failed { status: Some(401), .. }) => return Err(failure(Some(401))),
                Err(e) => {
                    if e.status.is_some() {
                        failed_status = e.status;
                    }
                    Value::Null
                }
            }
        }};
    }
    let current = optional!(request("aiserver.v1.DashboardService/GetCurrentPeriodUsage", Some(json!({}))));
    let p = &current["planUsage"];
    let cap = num(&p["limit"]);
    let remaining = num(&p["remaining"]);
    let explicit = num(&p["totalPercentUsed"]);
    let spent = num(&p["totalSpend"]);
    let mut windows = Fields::new();
    if explicit.is_some() || cap.zip(remaining).is_some() || spent.is_some() {
        let plan = match request("aiserver.v1.DashboardService/GetPlanInfo", Some(json!({}))).await {
            Err(e) if e.status == Some(401) => return Err(failure(e.status)),
            result => result.unwrap_or_default(),
        };
        let percent = explicit.or_else(|| {
            let (c, n) = cap.filter(|n| *n != 0.0).zip(remaining)?;
            Some((c - n) / c * 100.0)
        });
        let at =
            current.get("billingCycleEnd").filter(|t| !t.is_null()).unwrap_or(&plan["planInfo"]["billingCycleEnd"]);
        windows.insert(
            "billing_cycle".into(),
            window(percent, None, timestamp(at), spent.map(|s| format!("${}", fixed(s / 100.0, 2)))),
        );
        return Ok(windows.into());
    }
    let profile = request("auth/full_stripe_profile", None).await.map_err(|e| failure(e.status))?;
    let team = num(&profile["teamId"]);
    let member = profile["isTeamMember"] == true
        || text(&profile["membershipType"]).is_some_and(|s| s.eq_ignore_ascii_case("enterprise"))
        || team.is_some();
    if member {
        let team = team
            .filter(|id| *id > 0.0 && *id <= 9_007_199_254_740_991.0 && id.fract() == 0.0)
            .ok_or(reason("cursor-team-unavailable"))?;
        let requests = optional!(request("auth/usage", None));
        let hard = optional!(request("aiserver.v1.DashboardService/GetHardLimit", Some(json!({"teamId":team as u64}))));
        let gpt = &requests["gpt-4"];
        if let Some(used) = num(&gpt["numRequests"]).filter(|n| *n >= 0.0) {
            let max = num(&gpt["maxRequestUsage"]).filter(|n| *n >= 0.0);
            let mut w = window(max.filter(|n| *n > 0.0).map(|n| used / n * 100.0), None, None, None);
            w["consumption"] = json!({"used":used});
            if let Some(max) = max {
                w["consumption"]["limit"] = json!(max);
            }
            windows.insert("requests:gpt-4".into(), w);
        }
        for (key, field) in [("per_user_limit", "hardLimitPerUser"), ("team_limit", "hardLimit")] {
            if let Some(n) = num(&hard[field]).filter(|n| *n >= 0.0) {
                let mut w = window(None, None, None, None);
                w["limitUSD"] = json!(n);
                windows.insert(key.into(), w);
            }
        }
        if !windows.is_empty() {
            return Ok(windows.into());
        }
    }
    Err(failure(if failed_status == Some(403) { failed_status } else { None }))
}

async fn ollama(http: &Http) -> Quota {
    let cookie = var("OLLAMA_CLOUD_COOKIE")?;
    let response = http
        .send(
            "https://ollama.com/settings",
            &[("Cookie", &cookie), ("User-Agent", "CodeNomad usage provider")],
            None,
            true,
        )
        .await?;
    if response.status != 200 {
        return Err(FAILED);
    }
    let html = String::from_utf8_lossy(&response.bytes);
    let mut w = Fields::new();
    for (name, pattern) in
        [("session", r"(?i)Session\s+usage[^0-9]*([0-9.]+)%"), ("weekly", r"(?i)Weekly\s+usage[^0-9]*([0-9.]+)%")]
    {
        if let Some(c) = regex::Regex::new(pattern).unwrap().captures(&html) {
            w.insert(name.into(), window(c[1].parse().ok(), None, None, None));
        }
    }
    if let Some(c) = regex::Regex::new(r"(?i)Premium[^0-9]*([0-9]+)\s*/\s*([0-9]+)").unwrap().captures(&html) {
        let used = c[1].parse::<f64>().map_err(|_| INVALID)?;
        let total = c[2].parse::<f64>().map_err(|_| INVALID)?;
        w.insert(
            "premium".into(),
            window((total > 0.0).then(|| used / total * 100.0), None, None, Some(format!("{used} / {total}"))),
        );
    }
    if w.is_empty() { Err(INVALID) } else { Ok(w.into()) }
}
fn amount(v: &Value) -> Option<f64> {
    if let Some(s) = v.as_str()
        && !regex::Regex::new(r"^-?[0-9]+(?:\.[0-9]+)?$").unwrap().is_match(s)
    {
        return None;
    }
    num(v).filter(|n| n.abs() <= 9_007_199_254_740_991.0)
}
fn console_balance(v: &Value) -> Option<Value> {
    let mut w = window(None, None, None, None);
    w["balanceUSD"] = json!({"remaining":amount(&v["availableMicroCents"])? / 1e8});
    Some(w)
}
async fn go(ctx: &Context, auth: &Value, http: &Http) -> Quota {
    let e = ctx
        .integration
        .as_deref()
        .filter(|id| matches!(*id, "opencode-go" | "opencode"))
        .map_or(&Value::Null, |id| &auth[id]);
    let scope = e.get("server").is_none_or(|s| {
        text(s)
            .and_then(|s| reqwest::Url::parse(s).ok())
            .is_some_and(|url| url.origin().ascii_serialization() == "https://opencode.ai")
    });
    let oauth = e["type"] == "oauth";
    let token = if !scope {
        None
    } else if e["type"] == "api" {
        text(&e["key"])
    } else if oauth {
        text(&e["access"]).filter(|s| !stale(e, s))
    } else {
        None
    };
    let mut w = Fields::new();
    if let Some(tok) = token {
        let authorization = format!("Bearer {tok}");
        let mut headers = vec![("Authorization", authorization.as_str()), ("Accept", "application/json")];
        if let Some(org) = text(&e["orgId"]) {
            headers.push(("x-org-id", org));
        } else if oauth {
            return Err(FAILED);
        }
        if oauth {
            let p = http.get(&format!("{CONSOLE}/api/go/status"), &headers, true).await?;
            for (field, name, seconds) in
                [("fiveHour", "5h", FIVE_HOURS), ("week", "weekly", WEEK), ("month", "monthly", 30.0 * DAY)]
            {
                let s = &p["access"]["meters"][field];
                if s.is_null() {
                    continue;
                }
                let used = amount(&s["usedMicroCents"]).filter(|n| *n >= 0.0).ok_or(INVALID)?;
                let cap = amount(&s["limitMicroCents"]).filter(|n| *n > 0.0).ok_or(INVALID)?;
                let at = timestamp(&s["resetsAt"]);
                if !s["resetsAt"].is_null() && at.is_none() {
                    return Err(INVALID);
                }
                w.insert(name.into(), window(Some(used / cap * 100.0), Some(seconds), at, None));
            }
            match http.get(&format!("{CONSOLE}/api/billing/status"), &headers, true).await {
                Ok(p) => {
                    if let Some(balance) = console_balance(&p) {
                        w.insert("credits_balance".into(), balance);
                    }
                }
                Err(e) if e.status == Some(401) => return Err(e),
                _ => {}
            }
        } else {
            let r = http.send("https://opencode.ai/zen/go/v1/usage", &headers, None, true).await?;
            if r.status == 401
                && r.json().ok().is_some_and(|p| {
                    p.get("code").filter(|v| !v.is_null()).unwrap_or(&p["error"]["code"]) == "api_key_expired"
                })
            {
                return Err(reason("opencode-go-key-expired"));
            }
            let p = r.checked_json()?;
            for (keys, name, seconds) in [
                (["rolling", "rollingUsage"], "5h", FIVE_HOURS),
                (["weekly", "weeklyUsage"], "weekly", WEEK),
                (["monthly", "monthlyUsage"], "monthly", 30.0 * DAY),
            ] {
                let s = [&p["usage"], &p]
                    .into_iter()
                    .find_map(|c| keys.iter().find_map(|k| c.get(*k).filter(|v| !v.is_null())));
                let Some(s) = s else { continue };
                if !s.is_object() || s.get("status").is_some_and(|v| !matches!(v.as_str(), Some("ok" | "rate-limited")))
                {
                    return Err(INVALID);
                }
                let used = num(s.get("percent").filter(|v| !v.is_null()).unwrap_or(&s["usagePercent"]))
                    .filter(|n| *n >= 0.0)
                    .ok_or(INVALID)?;
                let at = if !s["resetsAt"].is_null() {
                    Some(timestamp(&s["resetsAt"]).ok_or(INVALID)?)
                } else if !s["resetInSec"].is_null() {
                    Some(now_ms() as f64 + num(&s["resetInSec"]).filter(|n| *n >= 0.0).ok_or(INVALID)? * 1000.0)
                } else {
                    None
                };
                w.insert(
                    name.into(),
                    window(Some(if s["status"] == "rate-limited" { 100.0 } else { used }), Some(seconds), at, None),
                );
            }
        }
    } else {
        let workspace = var("OPENCODE_GO_WORKSPACE_ID")?;
        let cookie = var("OPENCODE_GO_AUTH_COOKIE")?;
        let cookie = format!("auth={}", cookie.strip_prefix("auth=").unwrap_or(&cookie));
        let r = http
            .send(
                &format!("https://opencode.ai/workspace/{}/go", encode(&workspace)),
                &[("Cookie", &cookie), ("User-Agent", "CodeNomad usage provider")],
                None,
                true,
            )
            .await?;
        if r.status != 200 {
            return Err(FAILED);
        }
        let html = ["&quot;", "&#34;", "\\u0022", "\\\""]
            .iter()
            .fold(String::from_utf8_lossy(&r.bytes).into_owned(), |s, p| s.replace(p, "\""));
        for (name, field) in [("5h", "rollingUsage"), ("weekly", "weeklyUsage"), ("monthly", "monthlyUsage")] {
            let pattern = format!(r#"(?s)["']?{field}["']?\s*:\s*(?:\$R\[\d+\]\s*=\s*)?\{{([^{{}}]*)\}}"#);
            let re = regex::Regex::new(&pattern).unwrap();
            let Some(c) = re.captures(&html) else { continue };
            let val = |k| {
                regex::Regex::new(&format!(r#"["']?{k}["']?\s*:\s*["']?(-?\d+(?:\.\d+)?)"#)).ok()?.captures(&c[1])?[1]
                    .parse::<f64>()
                    .ok()
            };
            if let Some((used, reset)) = val("usagePercent").zip(val("resetInSec")) {
                w.insert(name.into(), window(Some(used), None, Some(now_ms() as f64 + reset.max(0.0) * 1000.0), None));
            }
        }
    }
    if w.is_empty() { Err(INVALID) } else { Ok(w.into()) }
}

/// Explicit-credential OpenCode Go quota read for account selection (no env-cookie fallback,
/// preserves upstream HTTP statuses so definite 4xx errors reject a candidate).
pub(super) async fn go_selection(e: &Value, http: &Http, now: u64) -> Quota {
    let scope = e.get("server").is_none_or(|s| {
        text(s)
            .and_then(|s| reqwest::Url::parse(s).ok())
            .is_some_and(|url| url.origin().ascii_serialization() == "https://opencode.ai")
    });
    if !scope {
        return Err(FAILED);
    }
    let oauth = e["type"] == "oauth";
    let token = if e["type"] == "api" {
        text(&e["key"])
    } else if oauth {
        text(&e["access"]).filter(|s| {
            let limit = (now + 120_000) as f64;
            e["expires"].as_f64().is_some_and(|n| n > limit)
                && !num(&jwt(s)["exp"]).is_some_and(|n| n * 1000.0 <= limit)
        })
    } else {
        None
    };
    let Some(tok) = token else {
        return Err(FAILED);
    };
    let authorization = format!("Bearer {tok}");
    let mut headers = vec![("Authorization", authorization.as_str()), ("Accept", "application/json")];
    if let Some(org) = text(&e["orgId"]) {
        headers.push(("x-org-id", org));
    } else if oauth {
        return Err(FAILED);
    }
    let mut w = Fields::new();
    if oauth {
        let p = http.get(&format!("{CONSOLE}/api/go/status"), &headers, true).await?;
        for (field, name, seconds) in
            [("fiveHour", "5h", FIVE_HOURS), ("week", "weekly", WEEK), ("month", "monthly", 30.0 * DAY)]
        {
            let s = &p["access"]["meters"][field];
            if s.is_null() {
                continue;
            }
            let used = amount(&s["usedMicroCents"]).filter(|n| *n >= 0.0).ok_or(INVALID)?;
            let cap = amount(&s["limitMicroCents"]).filter(|n| *n > 0.0).ok_or(INVALID)?;
            let at = timestamp(&s["resetsAt"]);
            if !s["resetsAt"].is_null() && at.is_none() {
                return Err(INVALID);
            }
            w.insert(name.into(), window(Some(used / cap * 100.0), Some(seconds), at, None));
        }
        match http.get(&format!("{CONSOLE}/api/billing/status"), &headers, true).await {
            Ok(p) => {
                if let Some(balance) = console_balance(&p) {
                    w.insert("credits_balance".into(), balance);
                }
            }
            Err(err) if err.status == Some(401) => return Err(err),
            _ => {}
        }
    } else {
        let p = http.get("https://opencode.ai/zen/go/v1/usage", &headers, true).await?;
        for (keys, name, seconds) in [
            (["rolling", "rollingUsage"], "5h", FIVE_HOURS),
            (["weekly", "weeklyUsage"], "weekly", WEEK),
            (["monthly", "monthlyUsage"], "monthly", 30.0 * DAY),
        ] {
            let s = [&p["usage"], &p]
                .into_iter()
                .find_map(|c| keys.iter().find_map(|k| c.get(*k).filter(|v| !v.is_null())));
            let Some(s) = s else { continue };
            if !s.is_object() || s.get("status").is_some_and(|v| !matches!(v.as_str(), Some("ok" | "rate-limited"))) {
                return Err(INVALID);
            }
            let used = num(s.get("percent").filter(|v| !v.is_null()).unwrap_or(&s["usagePercent"]))
                .filter(|n| *n >= 0.0)
                .ok_or(INVALID)?;
            let at = if !s["resetsAt"].is_null() {
                Some(timestamp(&s["resetsAt"]).ok_or(INVALID)?)
            } else if !s["resetInSec"].is_null() {
                Some(now as f64 + num(&s["resetInSec"]).filter(|n| *n >= 0.0).ok_or(INVALID)? * 1000.0)
            } else {
                None
            };
            w.insert(
                name.into(),
                window(Some(if s["status"] == "rate-limited" { 100.0 } else { used }), Some(seconds), at, None),
            );
        }
    }
    if w.is_empty() { Err(INVALID) } else { Ok(w.into()) }
}

const METRICS: [&str; 7] = [
    "totalRequests",
    "totalInputTokens",
    "totalOutputTokens",
    "totalCacheReadTokens",
    "totalCacheWrite5mTokens",
    "totalCacheWrite1hTokens",
    "totalCostMicroCents",
];
fn integer(n: u64) -> Result<u64, Failed> {
    (n <= 9_007_199_254_740_991).then_some(n).ok_or(INVALID)
}
fn decimal(v: &Value) -> Result<u64, Failed> {
    let t = v.as_str().filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).ok_or(INVALID)?;
    integer(t.parse().map_err(|_| INVALID)?)
}
fn info(v: &Value) -> Result<u64, Failed> {
    let n = v.as_f64().filter(|n| *n >= 0.0 && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0).ok_or(INVALID)?;
    Ok(n as u64)
}
fn counts(v: &Value) -> Result<[u64; 7], Failed> {
    let mut values = [0; 7];
    for (i, key) in METRICS.into_iter().enumerate() {
        values[i] = decimal(&v[key])?;
    }
    Ok(values)
}
fn model_text(v: &Value) -> Result<&str, Failed> {
    v.as_str().filter(|s| text(v).is_some() && s.encode_utf16().count() <= 256).ok_or(INVALID)
}
fn free_result(configured: bool, err: Option<&str>, requests: Option<u64>, balance: Option<Value>) -> Quota {
    let mut usage = Usage::default();
    usage.extra.insert("freeEstimate".into(), json!({"requests":requests,"reference":800}));
    if let Some(requests) = requests {
        usage.windows.insert(
            "daily".into(),
            window(Some(requests as f64 / 800.0 * 100.0), Some(DAY), None, Some(format!("{requests} / 800"))),
        );
    }
    if let Some(w) = balance {
        usage.windows.insert("credits_balance".into(), w);
    }
    if let Some(err) = err {
        usage.extra.insert("unavailableReason".into(), json!(err));
    }
    usage.extra.insert("configured".into(), json!(configured));
    usage.extra.insert("ok".into(), json!(requests.is_some()));
    Ok(usage)
}
pub fn free_unavailable() -> Quota {
    free_result(true, Some("opencode-console-network-error"), None, None)
}
pub fn free_model(provider: &str, model: Option<&str>) -> bool {
    provider.eq_ignore_ascii_case("opencode")
        && model.is_some_and(|model| {
            let m = crate::shared::js_trim(model).to_ascii_lowercase();
            m == "big-pickle" || m.ends_with("-free")
        })
}
pub async fn console(auth: &Value, http: &Http, free: bool) -> Quota {
    let e = &auth["opencode"];
    let missing = Failed { configured: false, ..reason("opencode-console-missing-credential") };
    let invalid = reason("opencode-console-invalid-credential");
    let credential = || {
        if !e.is_object() {
            return Err(missing);
        }
        if e["type"] == "oauth" {
            let org = e["orgId"]
                .as_str()
                .filter(|s| regex::Regex::new(r"^(org|wrk)_[A-Za-z0-9]+$").unwrap().is_match(s))
                .ok_or_else(|| invalid.clone())?;
            if e["server"] != CONSOLE || e["expires"].as_f64().is_none_or(|expires| expires <= now_ms() as f64) {
                return Err(invalid);
            }
            text(&e["access"]).ok_or(invalid)?;
            return Ok((e["access"].as_str().unwrap(), Some(org)));
        }
        if e.get("server").is_some_and(|s| s != CONSOLE) {
            return Err(invalid);
        }
        if e["type"] != "api" || text(&e["key"]).is_none() {
            return Err(missing);
        }
        Ok((e["key"].as_str().unwrap(), None))
    };
    let (token, org) = match credential() {
        Ok(c) => c,
        Err(e) => return if free { free_result(e.configured, e.reason, None, None) } else { Err(e) },
    };
    let token = format!("Bearer {token}");
    let mut headers = vec![("Authorization", token.as_str())];
    if let Some(org) = org {
        headers.push(("x-org-id", org));
    }
    let read = |path: String| {
        let url = format!("{CONSOLE}/api/{path}");
        let h = &headers;
        async move { http.get(&url, h, true).await }
    };
    let balance = read("billing/status".into());
    let usage = async {
        let mut requests = Fields::new();
        if !free {
            for range in ["24h", "7d", "30d"] {
                let p = read(format!("usage/summary?range={range}")).await?;
                requests.insert(range.into(), json!(counts(&p)?[0]));
                let mut sum = [0, 0];
                for s in p["services"].as_array().ok_or(INVALID)? {
                    model_text(&s["service"])?;
                    for (i, field) in ["totalRequests", "totalCostMicroCents"].into_iter().enumerate() {
                        sum[i] = integer(sum[i] + decimal(&s[field])?)?;
                    }
                }
            }
        }
        let mut rows = Vec::new();
        let mut expected = None;
        let mut totals = [0; 7];
        for page in 1..=20 {
            let range = if free { "24h" } else { "30d" };
            let p = read(format!("usage/models?range={range}&page={page}&pageSize=50")).await?;
            let meta = &p["pageInfo"];
            let total = info(&meta["total"])?;
            let pages = info(&meta["pageCount"])?;
            let items = p["items"].as_array().ok_or(INVALID)?;
            if info(&meta["page"])? != page
                || info(&meta["pageSize"])? != 50
                || total > 1000
                || pages > 20
                || (if total == 0 { page != 1 || pages > 1 } else { pages != total.div_ceil(50) || page > pages })
                || items.len() as u64 != total.saturating_sub((page - 1) * 50).min(50)
                || expected.is_some_and(|s| s != (total, pages))
            {
                return Err(INVALID);
            }
            expected = Some((total, pages));
            for row in items {
                let counts = counts(row)?;
                for (i, n) in counts.into_iter().enumerate() {
                    totals[i] = integer(totals[i] + n)?;
                }
                rows.push(json!({"provider":model_text(&row["provider"])?, "model":model_text(&row["model"])?, "requests":counts[0]}));
            }
            if page >= pages {
                break;
            }
        }
        Ok((requests, rows))
    };
    // The balance starts concurrently and may wait at most 250 ms after the usage reply.
    tokio::pin!(usage);
    let balance = tokio::time::timeout(Duration::from_secs(3), balance);
    tokio::pin!(balance);
    let (usage, balance) = tokio::select! {
        biased;
        b = &mut balance => (usage.await, b.ok().and_then(Result::ok)),
        u = &mut usage => (u, tokio::time::timeout(Duration::from_millis(250), &mut balance).await
            .ok().and_then(Result::ok).and_then(Result::ok)),
    };
    let balance = balance.as_ref().and_then(console_balance);
    match usage {
        Ok((requests, rows)) if free => {
            let _ = requests;
            let sum = rows
                .iter()
                .filter(|r| free_model("opencode", r["model"].as_str()))
                .try_fold(0, |sum, r| integer(sum + r["requests"].as_u64().unwrap_or_default()))?;
            free_result(true, None, Some(sum), balance)
        }
        Ok((requests, rows)) => {
            let mut u = Usage::default();
            if let Some(w) = balance {
                u.windows.insert("credits_balance".into(), w);
            }
            u.extra.insert(
                "console".into(),
                json!({"requests":requests, "models":rows, "budgets":{"status":"unavailable","items":[]}}),
            );
            Ok(u)
        }
        Err(e) => {
            let code = match e.status {
                Some(401) => "opencode-console-invalid-credential",
                Some(403) => "opencode-console-access-denied",
                None if e.malformed => "opencode-console-invalid-response",
                _ => "opencode-console-network-error",
            };
            if free { free_result(true, Some(code), None, None) } else { Err(reason(code)) }
        }
    }
}
