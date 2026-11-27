//! Copilot, Codex and Claude quota windows and their authentication contracts.
use std::time::Duration;

use serde_json::{Value, json};

use super::{Provider, State, shared::*};
use crate::shared::{js_trim, now_ms};

pub async fn copilot(p: &Provider, auth: &Value, http: &Http) -> Quota {
    let entry = oauth(auth, p.aliases);
    let token = access(entry).ok_or(MISSING)?;
    let mut url = "https://api.github.com/copilot_internal/user".to_owned();
    if let Some(enterprise) = entry.get("enterpriseUrl") {
        let w = enterprise.as_str().ok_or(reason("invalid-base-url"))?;
        let w = if w.to_ascii_lowercase().starts_with("https://") { &w[8..] } else { w };
        let host = w.strip_suffix('/').unwrap_or(w);
        if !host.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-')) {
            return Err(reason("invalid-base-url"));
        }
        let original = base_url(&format!("https://{host}")).ok_or(reason("invalid-base-url"))?;
        url = format!("https://api.{}/copilot_internal/user", original.host_str().unwrap_or_default());
        base_url(&url).ok_or(reason("invalid-base-url"))?;
    }
    let auth = format!("token {token}");
    let p = http
        .get(
            &url,
            &[
                ("Authorization", &auth),
                ("Accept", "application/json"),
                ("Editor-Version", "vscode/1.96.2"),
                ("X-Github-Api-Version", "2025-04-01"),
            ],
            true,
        )
        .await?;
    let reset =
        ["quota_reset_date_utc", "quota_reset_date", "limited_user_reset_date"].iter().find_map(|k| timestamp(&p[*k]));
    let mut windows = Fields::new();
    for (name, key) in [("chat", "chat"), ("completions", "completions"), ("premium", "premium_interactions")] {
        let s = &p["quota_snapshots"][key];
        if !s.is_object() {
            continue;
        }
        let at = num(&s["quota_reset_at"]).map(|n| if n < 1e12 { n * 1000.0 } else { n }).or(reset);
        if s["unlimited"] == true {
            let mut w = window(None, None, at, None);
            w["consumption"] = if let Some(n) = num(&s["credits_used"]).filter(|n| *n >= 0.0 && s["has_quota"] != false)
            {
                json!({"creditsUsed":n})
            } else {
                json!({"unlimited":true})
            };
            windows.insert(name.into(), w);
            continue;
        }
        let cap = num(&s["entitlement"]);
        if cap == Some(0.0) {
            continue;
        }
        let counted = cap.filter(|c| *c > 0.0).zip(num(&s["quota_remaining"]).filter(|n| *n >= 0.0));
        let Some(used) =
            num(&s["percent_remaining"]).map(|n| 100.0 - n).or_else(|| counted.map(|(c, n)| 100.0 - n / c * 100.0))
        else {
            continue;
        };
        let mut w = window(Some(used), None, at, None);
        if let Some(c) = cap.filter(|c| *c > 0.0) {
            w["consumption"] =
                json!({"used": counted.map_or(c * used / 100.0, |(cap, left)| cap - left).max(0.0), "limit":c});
        }
        windows.insert(name.into(), w);
    }
    if windows.is_empty() {
        return Err(INVALID);
    }
    let mut usage = Usage::from(windows);
    let plan = match p["access_type_sku"].as_str() {
        Some("free_limited_copilot") => Some("free"),
        Some("free_educational_quota") => Some("student"),
        _ => match p["copilot_plan"].as_str() {
            Some("individual") => Some("pro"),
            Some("individual_pro") => Some("proPlus"),
            Some("individual_max") => Some("max"),
            Some("individual_edu") => Some("student"),
            Some("business") => Some("business"),
            Some("enterprise") => Some("enterprise"),
            _ => None,
        },
    };
    if let Some(plan) = plan {
        usage.extra.insert("copilotPlan".into(), json!(plan));
    }
    Ok(usage)
}

pub async fn codex(http: &Http, token: &str, account: &str) -> Quota {
    let auth = format!("Bearer {token}");
    let payload = http
        .get(
            "https://chatgpt.com/backend-api/wham/usage",
            &[("Authorization", &auth), ("ChatGPT-Account-Id", account), ("Content-Type", "application/json")],
            true,
        )
        .await?;
    let mut windows = Fields::new();
    for name in ["primary_window", "secondary_window"] {
        let s = &payload["rate_limit"][name];
        if let Some(used) = num(&s["used_percent"]) {
            let seconds = num(&s["limit_window_seconds"]);
            windows.insert(label(seconds), window(Some(used), seconds, timestamp(&s["reset_at"]), None));
        }
    }
    let credits = &payload["credits"];
    let balance = num(&credits["balance"]);
    if credits["unlimited"] == true || balance.is_some() {
        let value = if truthy(&credits["unlimited"]) {
            Some("Unlimited".into())
        } else {
            balance.map(|n| format!("${}", fixed(n, 2)))
        };
        windows.insert("credits_balance".into(), window(None, None, None, value));
    }
    let s = &payload["spend_control"]["individual_limit"];
    let used = num(&s["used_percent"]);
    let value = num(&s["used"]).zip(num(&s["limit"])).map(|(u, c)| format!("{} / {} used", fixed(u, 0), fixed(c, 0)));
    if used.is_some() || value.is_some() {
        windows.insert("credits".into(), window(used, None, None, value));
    }
    if windows.is_empty() { Err(INVALID) } else { Ok(windows.into()) }
}

pub struct ClaudeRead {
    identity: String,
    usage: Option<Usage>,
    cooldown: u64,
}

pub async fn claude(state: &State, provider: &Provider, auth: &Value) -> Quota {
    let aliases: &[&str] = if provider.id == "claude" { &["anthropic", "claude"] } else { &["claude-code"] };
    let entry = oauth(auth, aliases);
    let access = access(entry).ok_or(MISSING)?;
    let identity = hash(&json!([access, text(&entry["refresh"])]));
    {
        let mut map = state.claude.lock().unwrap();
        let slot = map.entry(provider.id).or_insert_with(|| ClaudeRead {
            identity: identity.clone(),
            usage: None,
            cooldown: 0,
        });
        if slot.identity != identity {
            *slot = ClaudeRead { identity: identity.clone(), usage: None, cooldown: 0 };
        }
        if timestamp(&entry["expires"]).is_some_and(|n| n <= (now_ms() + 120_000) as f64) {
            return Err(FAILED);
        }
        if slot.cooldown > now_ms() {
            return slot.usage.clone().ok_or(FAILED);
        }
    }
    let authorization = format!("Bearer {access}");
    let response = state
        .http()
        .send(
            "https://api.anthropic.com/api/oauth/usage",
            &[("Authorization", &authorization), ("anthropic-beta", "oauth-2025-04-20")],
            None,
            false,
        )
        .await?;
    if response.status == 429 {
        let now = now_ms();
        let raw = response.headers.get("retry-after").and_then(|r| r.to_str().ok()).unwrap_or_default();
        let delay = num(&json!(raw))
            .filter(|t| *t > 0.0)
            .map(|t| t * 1000.0)
            .or_else(|| timestamp(&json!(raw)).filter(|t| *t > now as f64).map(|t| t - now as f64));
        let mut map = state.claude.lock().unwrap();
        let slot = map.get_mut(provider.id).filter(|s| s.identity == identity).ok_or(FAILED)?;
        slot.cooldown = now + delay.unwrap_or(300_000.0).min(3_600_000.0) as u64;
        return slot.usage.clone().ok_or(FAILED);
    }
    let p = response.checked_json()?;
    let u = parse_claude_usage(&p)?;
    if let Some(slot) = state.claude.lock().unwrap().get_mut(provider.id).filter(|s| s.identity == identity) {
        slot.usage = Some(u.clone());
    }
    Ok(u)
}

/// Stateless Claude quota read for account selection (no shared cooldown or fallback snapshot).
pub(super) async fn claude_fresh(auth: &Value, http: &Http) -> Quota {
    let entry = oauth(auth, &["anthropic", "claude"]);
    let access = access(entry).ok_or(MISSING)?;
    if timestamp(&entry["expires"]).is_some_and(|n| n <= (now_ms() + 120_000) as f64) {
        return Err(FAILED);
    }
    let authorization = format!("Bearer {access}");
    let response = http
        .send(
            "https://api.anthropic.com/api/oauth/usage",
            &[("Authorization", &authorization), ("anthropic-beta", "oauth-2025-04-20")],
            None,
            false,
        )
        .await?;
    let p = response.checked_json()?;
    parse_claude_usage(&p)
}

fn parse_claude_usage(p: &Value) -> Quota {
    let mut u = Usage::default();
    let limits = arr(&p["limits"]);
    for s in limits {
        let Some(n) = num(&s["percent"]) else { continue };
        let reset = timestamp(&s["resets_at"]);
        match s["kind"].as_str() {
            Some("session") => {
                u.windows.insert("5h".into(), window(Some(n), Some(FIVE_HOURS), reset, None));
            }
            Some("weekly_all") => {
                u.windows.insert("7d".into(), window(Some(n), Some(WEEK), reset, None));
            }
            Some("weekly_scoped") => {
                if let Some(name) = text(&s["scope"]["model"]["display_name"]) {
                    let windows = Fields::from_iter([("7d".into(), window(Some(n), Some(WEEK), reset, None))]);
                    if let Some((_, row)) = u.models.iter_mut().find(|(m, _)| m == name) {
                        *row = windows;
                    } else {
                        u.models.push((name.into(), windows));
                    }
                }
            }
            _ => {}
        }
    }
    if limits.is_empty() {
        for (name, field, seconds) in [("5h", "five_hour", FIVE_HOURS), ("7d", "seven_day", WEEK)] {
            let s = &p[field];
            if let Some(n) = num(&s["utilization"]) {
                u.windows.insert(name.into(), window(Some(n), Some(seconds), timestamp(&s["resets_at"]), None));
            }
        }
    }
    let s = &p["spend"];
    if s["enabled"] == true {
        let money = |key: &str| {
            let v = &s[key];
            num(&v["amount_minor"]).map(|n| n / 10_f64.powf(num(&v["exponent"]).unwrap_or(2.0)))
        };
        let used = num(&s["percent"]);
        let value = money("used").map(|spent| {
            let currency = text(&s["used"]["currency"]).unwrap_or("USD");
            let prefix = if currency == "USD" { "$".into() } else { format!("{currency} ") };
            let mut out = format!("{prefix}{}", fixed(spent, 2));
            if let Some(limit) = money("limit") {
                out.push_str(&format!(" / {prefix}{}", fixed(limit, 2)));
            }
            out
        });
        if used.is_some() || value.is_some() {
            u.windows.insert("extra_usage".into(), window(used, None, None, value));
        }
    }
    if u.windows.is_empty() && u.models.is_empty() {
        return Err(INVALID);
    }
    Ok(u)
}

pub async fn claude_host(app: &crate::App) -> Result<Value, ()> {
    let configured = app.settings.raw_config_owner("server").map_err(|_| ())?;
    let configured = match configured.get("environmentVariables") {
        None => None,
        Some(v) => Some(v.as_object().ok_or(())?),
    };
    if configured.is_some_and(|v| {
        v.iter().any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.as_str().is_none_or(|v| v.contains('\0')))
    }) {
        return Err(());
    }
    let var = |name: &str| {
        configured
            .and_then(|vars| {
                vars.iter().find(|(k, _)| if cfg!(windows) { k.eq_ignore_ascii_case(name) } else { *k == name })
            })
            .and_then(|(_, v)| v.as_str().map(str::to_owned))
            .or_else(|| std::env::var(name).ok())
    };
    if let Some(token) = var("CLAUDE_CODE_OAUTH_TOKEN").as_deref().map(js_trim).filter(|s| !s.is_empty()) {
        return Ok(json!({"type":"oauth", "access":token,"refresh":null,"expires":null}));
    }
    let home = if cfg!(windows) { var("USERPROFILE").or_else(|| var("HOME")) } else { var("HOME") };
    let setting = var("CLAUDE_SECURESTORAGE_CONFIG_DIR").or_else(|| var("CLAUDE_CONFIG_DIR"));
    let from_default = setting.as_deref().is_none_or(str::is_empty);
    let dir = if let Some(s) = setting.filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(s)
    } else if let Some(home) = home.as_deref().map(js_trim).filter(|s| !s.is_empty()) {
        std::path::Path::new(home).join(".claude")
    } else {
        return Ok(Value::Null);
    };
    let normalize = icu_normalizer::ComposingNormalizer::new_nfc();
    let dir = std::path::PathBuf::from(normalize.normalize(&dir.to_string_lossy()).into_owned());
    let parse = |data: &[u8]| {
        let data: Value = serde_json::from_slice(data).ok()?;
        let item = &data["claudeAiOauth"];
        Some(json!({"type":"oauth","access":text(&item["accessToken"])?, "refresh":text(&item["refreshToken"]),
            "expires":timestamp(&item["expiresAt"])}))
    };
    if cfg!(target_os = "macos") {
        use sha2::{Digest, Sha256};
        let suffix = if from_default {
            "".to_owned()
        } else {
            format!("-{}", &format!("{:x}", Sha256::digest(dir.to_string_lossy().as_bytes()))[..8])
        };
        let mut command = tokio::process::Command::new("/usr/bin/security");
        command
            .args(["find-generic-password", "-s", &format!("Claude Code-credentials{suffix}"), "-w"])
            .kill_on_drop(true);
        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(10), command.output()).await
            && output.status.success()
            && let Some(entry) = parse(&output.stdout)
        {
            return Ok(entry);
        }
    }
    if !dir.is_absolute() || !dir.to_str().is_some_and(crate::files::paths::local_absolute) {
        return Ok(Value::Null);
    }
    let entry = tokio::fs::read(dir.join(".credentials.json")).await.ok().and_then(|data| parse(&data));
    Ok(entry.unwrap_or(Value::Null))
}
