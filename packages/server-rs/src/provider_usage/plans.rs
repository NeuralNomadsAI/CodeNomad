//! API-key based provider plans and balances.
use std::{collections::HashSet, time::Duration};

use serde_json::{Value, json};

use super::{Context, Provider, shared::*};

pub async fn read(p: &Provider, context: &Context, auth: &Value, http: &Http) -> Quota {
    let api_key = || key(auth, p.aliases, &["key", "token"]);
    let mut windows = Fields::new();
    match p.id {
        "kimi-for-coding" => return kimi(p, context, auth, http).await,
        "openrouter" => return openrouter(context, api_key, http).await,
        "minimax-coding-plan" | "minimax-cn-coding-plan" => return minimax(p.id, api_key()?, http).await,
        "zai-coding-plan" | "zhipuai-coding-plan" => {
            let token = context.api_key.as_deref().map(Ok).unwrap_or_else(api_key)?;
            let host = if p.id == "zai-coding-plan" { "api.z.ai" } else { "open.bigmodel.cn" };
            let payload = http
                .get(
                    &format!("https://{host}/api/monitor/usage/quota/limit"),
                    &[("Authorization", &format!("Bearer {token}")), ("Content-Type", "application/json")],
                    true,
                )
                .await
                .map_err(|f| if f.status.is_none() { reason("provider-error") } else { f })?;
            if payload["success"] == false || payload.get("code").is_some_and(|c| num(c) != Some(200.0)) {
                let code = payload["code"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| payload["code"].as_f64().map(|n| n.to_string()))
                    .unwrap_or_default();
                let code =
                    (!code.is_empty() && code.len() <= 8 && code.bytes().all(|b| b.is_ascii_digit())).then_some(code);
                return Err(Failed { code, ..reason("provider-error") });
            }
            for limit in arr(&payload["data"]["limits"]) {
                let unit = match limit["unit"].as_f64() {
                    Some(3.0) => Some(HOUR),
                    Some(6.0) => Some(WEEK),
                    _ => None,
                };
                let seconds = num(&limit["number"]).zip(unit).map(|(n, unit)| n * unit);
                let percent = num(&limit["percentage"]);
                let reset = timestamp(&limit["nextResetTime"]);
                match limit["type"].as_str() {
                    Some("TOKENS_LIMIT") if percent.is_some() => {
                        windows.insert(label(seconds), window(percent, seconds, reset, None));
                    }
                    Some("TIME_LIMIT") if percent.is_some() => {
                        windows.insert("mcp-tools".into(), window(percent, Some(30.0 * DAY), reset, None));
                    }
                    Some("CREDIT_LIMIT") => {
                        let allowance = num(&limit["usage"]);
                        let consumed =
                            num(&limit["currentValue"]).or_else(|| Some(allowance? - num(&limit["remaining"])?));
                        let percent = percent.or_else(|| Some(consumed? / allowance.filter(|n| *n > 0.0)? * 100.0));
                        if percent.is_some() {
                            windows.insert(label(seconds), window(percent, seconds, reset, None));
                        }
                    }
                    _ => {}
                }
            }
            if windows.is_empty() {
                return Err(reason("provider-error"));
            }
        }
        "nano-gpt" => {
            let auth = format!("Bearer {}", api_key()?);
            let payload = http
                .get(
                    "https://nano-gpt.com/api/subscription/v1/usage",
                    &[("Authorization", &auth), ("Content-Type", "application/json")],
                    false,
                )
                .await?;
            for label in ["daily", "monthly"] {
                let s = &payload[label];
                if !truthy(s) {
                    continue;
                }
                let limit = s.get("limit").filter(|v| !v.is_null()).unwrap_or(&s["limits"][label]);
                let ratio =
                    num(&s["percentUsed"]).or_else(|| Some(num(&s["used"])? / num(limit).filter(|n| *n != 0.0)?));
                let at = s.get("resetAt").filter(|v| !v.is_null()).unwrap_or(&payload["period"]["currentPeriodEnd"]);
                windows.insert(
                    label.into(),
                    window(ratio.map(|r| r * 100.0), (label == "daily").then_some(DAY), timestamp(at), None),
                );
            }
        }
        "wafer" => {
            let payload = http
                .get(
                    "https://pass.wafer.ai/v1/inference/quota",
                    &[("Authorization", &format!("Bearer {}", api_key()?)), ("Accept-Encoding", "identity")],
                    false,
                )
                .await?;
            let reset = timestamp(&payload["window_end"]);
            let seconds = reset
                .zip(timestamp(&payload["window_start"]))
                .map(|(end, start)| (((end - start) / 1000.0) + 0.5).floor())
                .unwrap_or(FIVE_HOURS);
            let amount = num(&payload["remaining_included_requests"])
                .zip(num(&payload["included_request_limit"]))
                .map(|(remaining, limit)| format!("{remaining} / {limit}"));
            windows.insert(
                label(Some(seconds)),
                window(num(&payload["current_period_used_percent"]), Some(seconds), reset, amount),
            );
        }
        "cline-pass" => {
            let e = format!("Bearer {}", api_key()?);
            let payload = http
                .get(
                    "https://api.cline.bot/api/v1/users/me/plan/usage-limits",
                    &[("Authorization", &e), ("Accept", "application/json")],
                    false,
                )
                .await?;
            for s in arr(&payload["data"]["limits"]) {
                let (kind, seconds) = match s["type"].as_str() {
                    Some("five_hour") => ("5h", Some(FIVE_HOURS)),
                    Some("weekly") => ("weekly", Some(WEEK)),
                    Some("monthly") => ("monthly", None),
                    _ => continue,
                };
                if let Some(used) = num(&s["percentUsed"]) {
                    windows.insert(kind.into(), window(Some(used), seconds, timestamp(&s["resetsAt"]), None));
                }
            }
            if windows.is_empty() {
                return Err(INVALID);
            }
        }
        "deepinfra" | "hyper" | "kilo" | "zenmux" => {
            let token = match p.id {
                "zenmux" => var("ZENMUX_PLATFORM_API_KEY")?,
                "kilo" => key(auth, p.aliases, &["key", "token", "access"])?.into(),
                _ => api_key()?.into(),
            };
            let authorization = format!("Bearer {token}");
            let mut headers = vec![("Authorization", authorization.as_str()), ("Accept", "application/json")];
            if p.id == "kilo" {
                let entry = first_auth(auth, p.aliases);
                if let Some(org) =
                    ["kilocodeOrganizationId", "organizationId", "accountId"].iter().find_map(|k| text(&entry[*k]))
                {
                    headers.push(("x-kilocode-organizationid", org));
                }
            }
            let url = match p.id {
                "deepinfra" => "https://api.deepinfra.com/v1/me?checklist=true",
                "hyper" => "https://hyper.charm.land/v1/credits",
                "kilo" => "https://api.kilo.ai/api/profile/balance",
                _ => "https://zenmux.ai/api/v1/management/payg/balance",
            };
            let data = http.get(url, &headers, false).await?;
            let credit = match p.id {
                "deepinfra" => -num(&data["checklist"]["stripe_balance"]).ok_or(INVALID)?,
                "zenmux" => num(&data["data"]["total_credits"]).ok_or(INVALID)?,
                "kilo" => num(&data["balance"]).ok_or(INVALID)?,
                _ => {
                    let count = num(&data["balance"]).ok_or(INVALID)?;
                    let label = if count.fract() == 0.0 { count.to_string() } else { fixed(count, 2) };
                    windows.insert("credits".into(), window(None, None, None, Some(label)));
                    count * 0.05
                }
            };
            windows.insert("credits_balance".into(), balance(credit));
        }
        "exe-dev" => {
            let tok = format!("Bearer {}", var("EXE_DEV_USAGE_TOKEN")?);
            let data = http
                .send(
                    "https://exe.dev/exec",
                    &[("Authorization", &tok), ("Accept", "application/json"), ("Content-Type", "text/plain")],
                    Some(b"billing credits usage --group=day --json".to_vec()),
                    false,
                )
                .await?
                .checked_json()?;
            let spent = num(&data["total_cost_usd"]).ok_or(INVALID)?;
            let cap = num(&data["monthly_allowance_usd"]).filter(|n| *n >= 0.0).ok_or(INVALID)?;
            let at = timestamp(&data["period_end"]).ok_or(INVALID)?;
            let label = format!("${} / ${}", fixed(spent, 2), fixed(cap, 2));
            windows.insert(
                "monthly".into(),
                window((cap > 0.0).then(|| spent / cap * 100.0), None, Some(at), Some(label)),
            );
        }
        "command-code" => {
            let token = key(auth, p.aliases, &["key", "access", "token"])
                .map(str::to_owned)
                .or_else(|_| var("COMMAND_CODE_API_KEY"))?;
            let auth = format!("Bearer {token}");
            let headers = [("Accept", "application/json"), ("Authorization", auth.as_str())];
            let who = http.get("https://api.commandcode.ai/alpha/whoami", &headers, false).await?;
            if !who.is_object() && !who.is_array() {
                return Err(INVALID);
            }
            let url = "https://api.commandcode.ai/alpha/billing/credits";
            let url =
                text(&who["org"]["id"]).map(|id| format!("{url}?orgId={}", encode(id))).unwrap_or_else(|| url.into());
            let data = http.get(&url, &headers, false).await?;
            let format = |n: f64| ((((n + f64::EPSILON) * 100.0) + 0.5).floor() / 100.0).to_string();
            for (kind, field) in [
                ("monthly_credits", "monthlyCredits"),
                ("purchased_credits", "purchasedCredits"),
                ("free_credits", "freeCredits"),
            ] {
                if let Some(n) = data["credits"][field].as_f64() {
                    windows.insert(kind.into(), window(None, None, None, Some(format(n))));
                }
            }
            for (kind, field, duration) in [("5h", "fiveHour", FIVE_HOURS), ("weekly", "weekly", WEEK)] {
                let s = &data["windowLimits"][field];
                if let Some((used, cap)) = s["used"].as_f64().zip(s["cap"].as_f64().filter(|n| *n > 0.0)) {
                    let reset = s["resetAt"].as_f64().and_then(|_| timestamp(&s["resetAt"]));
                    windows.insert(
                        kind.into(),
                        window(
                            Some(used / cap * 100.0),
                            Some(duration),
                            reset,
                            Some(format!("{} / {}", format(used), format(cap))),
                        ),
                    );
                }
            }
            if windows.is_empty() {
                return Err(INVALID);
            }
        }
        "deepseek" => {
            let data = http
                .get(
                    "https://api.deepseek.com/user/balance",
                    &[("Authorization", &format!("Bearer {}", api_key()?)), ("Accept-Encoding", "identity")],
                    false,
                )
                .await?;
            let select = |currency| arr(&data["balance_infos"]).iter().find(|v| v["currency"] == currency);
            let row = select("USD").or_else(|| select("CNY")).ok_or(INVALID)?;
            let amount = num(&row["total_balance"]).ok_or(INVALID)?;
            let currency = if row["currency"] == "CNY" { "¥" } else { "$" };
            windows.insert(
                "credits_balance".into(),
                window(None, None, None, Some(format!("{currency}{}", fixed(amount, 2)))),
            );
        }
        "neuralwatt" => {
            let data = http
                .get(
                    "https://api.neuralwatt.com/v1/quota",
                    &[("Authorization", &format!("Bearer {}", api_key()?)), ("Accept-Encoding", "identity")],
                    false,
                )
                .await?;
            let s = &data["subscription"];
            let a = &data["key"]["allowance"];
            let remaining = num(&data["balance"]["credits_remaining_usd"]);
            if truthy(s) {
                let cap = num(&s["kwh_included"]).filter(|n| *n > 0.0);
                let percent = if truthy(&s["in_overage"]) {
                    Some(100.0)
                } else {
                    num(&s["kwh_used"]).zip(cap).map(|(n, cap)| n / cap * 100.0)
                };
                let reset = timestamp(&s["kwh_reset_date"]).or_else(|| timestamp(&s["current_period_end"]));
                windows.insert(text(&s["plan"]).unwrap_or("plan_limit").into(), window(percent, None, reset, None));
            }
            if truthy(a) {
                let spent = num(&a["spent_usd"]);
                let cap = num(&a["limit_usd"]);
                let effective =
                    cap.zip(remaining).map(|(c, r)| c.min(r + spent.unwrap_or_default())).or(cap).or(remaining);
                let percent = if truthy(&a["blocked"]) {
                    Some(100.0)
                } else {
                    spent.zip(effective.filter(|n| *n > 0.0)).map(|(n, cap)| n / cap * 100.0)
                };
                let (label, seconds) = match text(&a["period"]) {
                    Some("daily") => ("daily", Some(DAY)),
                    Some("weekly") => ("weekly", Some(WEEK)),
                    Some("monthly" | "month") => ("monthly", Some(30.0 * DAY)),
                    Some("yearly" | "year") => ("billing_cycle", Some(365.0 * DAY)),
                    _ => ("billing_cycle", None),
                };
                windows.insert(label.into(), window(percent, seconds, timestamp(&a["reset_at"]), None));
            } else if let Some(n) = remaining {
                windows.insert("credits_balance".into(), window(None, None, None, Some(format!("${}", fixed(n, 2)))));
            }
            if windows.is_empty() {
                return Err(INVALID);
            }
        }
        _ => return Err(MISSING),
    }
    Ok(windows.into())
}

pub fn encode(value: &str) -> String {
    const COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(value, COMPONENT).to_string()
}

async fn kimi(p: &Provider, ctx: &Context, auth: &Value, http: &Http) -> Quota {
    let mut aliases = p.aliases.to_vec();
    aliases.sort_by_key(|alias| Some(*alias) != ctx.integration.as_deref());
    let mut seen = HashSet::new();
    let list = aliases
        .iter()
        .filter_map(|alias| {
            let key = key(auth, &[*alias], &["key", "token"]).ok()?;
            let host = if *alias == "kimi-code-plan-global" { "api.kimi.ai" } else { "api.kimi.com" };
            seen.insert((host, key)).then_some((host, key))
        })
        .collect::<Vec<_>>();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    let mut fail = MISSING;
    for (i, (host, key)) in list.iter().enumerate() {
        let budget = deadline.saturating_duration_since(tokio::time::Instant::now()) / (list.len() - i) as u32;
        let result = tokio::time::timeout(budget.max(Duration::from_millis(1)), async {
            let payload = http
                .get(
                    &format!("https://{host}/coding/v1/usages"),
                    &[("Authorization", &format!("Bearer {key}")), ("Accept", "application/json")],
                    true,
                )
                .await?;
            let mut windows = Fields::new();
            let usage = &payload["usage"];
            let percent =
                |v: &Value| Some(100.0 - num(&v["remaining"])? / num(&v["limit"]).filter(|n| *n != 0.0)? * 100.0);
            if truthy(usage) {
                windows.insert("weekly".into(), window(percent(usage), None, timestamp(&usage["resetTime"]), None));
            }
            for v in arr(&payload["limits"]) {
                let unit = match v["window"]["timeUnit"].as_str() {
                    Some("TIME_UNIT_MINUTE") => Some(60.0),
                    Some("TIME_UNIT_HOUR") => Some(HOUR),
                    Some("TIME_UNIT_DAY") => Some(DAY),
                    _ => None,
                };
                let seconds = num(&v["window"]["duration"]).zip(unit).map(|(n, u)| n * u);
                let d = &v["detail"];
                windows.insert(label(seconds), window(percent(d), seconds, timestamp(&d["resetTime"]), None));
            }
            for (field, label, seconds) in [
                ("limit_5h", "5h", Some(FIVE_HOURS)),
                ("limit_7d", "weekly", Some(WEEK)),
                ("limit_month_total", "monthly", None),
                ("limit_month_code", "monthly-code", None),
            ] {
                let s = &payload["usages"][field];
                if let Some(ratio) = num(&s["used_ratio"]).filter(|r| (0.0..=1.0).contains(r)) {
                    let at = s["reset_time"].as_str().and_then(|_| timestamp(&s["reset_time"]));
                    windows.insert(label.into(), window(Some(ratio * 100.0), seconds, at, None));
                }
            }
            if !windows.values().any(|w| w["usedPercent"].is_number()) {
                return Err(INVALID);
            }
            Ok(windows.into())
        })
        .await
        .unwrap_or(Err(FAILED));
        match result {
            Ok(u) => return Ok(u),
            Err(error) => fail = error,
        }
    }
    Err(fail)
}

async fn openrouter<'a>(ctx: &'a Context, credential: impl FnOnce() -> Result<&'a str, Failed>, http: &Http) -> Quota {
    let key = ctx.api_key.as_deref().map(Ok).unwrap_or_else(credential)?;
    let base = base_url(ctx.base_url.as_deref().unwrap_or("https://openrouter.ai/api/v1"))
        .ok_or(reason("invalid-base-url"))?;
    if ctx.status != "available" {
        return Err(reason("provider-error"));
    }
    let base = base.as_str().trim_end_matches('/');
    let auth = format!("Bearer {key}");
    let headers = [("Authorization", auth.as_str()), ("Content-Type", "application/json")];
    let mut windows = Fields::new();
    let data = http.get(&format!("{base}/key"), &headers, true).await?;
    let data = &data["data"];
    let limit = num(&data["limit"]);
    if !data.is_object() || !data.get("limit").is_some_and(|v| v.is_null() || limit.is_some_and(|n| n >= 0.0)) {
        return Err(INVALID);
    }
    if let Some(limit) = limit {
        let left = num(&data["limit_remaining"]);
        let mut value =
            window(left.map(|left| if limit > 0.0 { (limit - left) / limit * 100.0 } else { 100.0 }), None, None, None);
        if let Some(left) = left {
            value["balanceUSD"] = json!({"remaining": left.max(0.0), "total": limit});
        }
        windows.insert("key_limit".into(), value);
    }
    if let Ok(Ok(credits)) =
        tokio::time::timeout(Duration::from_secs(5), http.get(&format!("{base}/credits"), &headers, true)).await
    {
        let val = |name| num(&credits["data"][name]).filter(|n| *n >= 0.0);
        if let Some((total, used)) = val("total_credits").zip(val("total_usage")) {
            let mut value = window((total > 0.0).then(|| used / total * 100.0), None, None, None);
            value["balanceUSD"] = json!({"remaining": (total - used).max(0.0), "total": total});
            windows.insert("credits".into(), value);
        }
    }
    Ok(windows.into())
}

async fn minimax(id: &str, key: &str, http: &Http) -> Quota {
    let cn = id == "minimax-cn-coding-plan";
    let first = if cn { "api.minimaxi.com" } else { "api.minimax.io" };
    let second = if cn { "www.minimaxi.com" } else { first };
    let auth = format!("Bearer {key}");
    let headers = [("Authorization", auth.as_str())];
    let usable = |p: &Value| {
        (!truthy(&p["base_resp"]) || p["base_resp"]["status_code"].as_f64() == Some(0.0))
            && !arr(&p["model_remains"]).is_empty()
    };
    let token = http.get(&format!("https://{first}/v1/token_plan/remains"), &headers, false).await.ok().filter(usable);
    let token_plan = token.is_some();
    let payload = match token {
        Some(p) => p,
        None => http.get(&format!("https://{second}/v1/api/openplatform/coding_plan/remains"), &headers, false).await?,
    };
    if !usable(&payload) {
        return Err(
            if payload["base_resp"]["status_code"].as_f64() == Some(0.0)
                && payload.get("model_remains").is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
            {
                reason("minimax-limits-not-shared")
            } else {
                INVALID
            },
        );
    }
    let models = arr(&payload["model_remains"]);
    let name = |m: &Value| m["model_name"].as_str().unwrap_or_default().to_ascii_lowercase();
    let model = models
        .iter()
        .find(|m| name(m).starts_with("minimax-m") && num(&m["current_interval_total_count"]).unwrap_or_default() > 0.0)
        .or_else(|| models.iter().find(|m| matches!(name(m).as_str(), "general" | "chat" | "text")))
        .or_else(|| models.iter().find(|m| num(&m["current_interval_remaining_percent"]).is_some()))
        .unwrap_or(&models[0]);
    if !truthy(model) {
        return Err(INVALID);
    }
    let mut windows = Fields::new();
    for (key, prefix, suffix) in [("5h", "interval", ""), ("weekly", "weekly", "weekly_")] {
        let val = |f| num(&model[format!("current_{prefix}_{f}")]);
        let remaining = val("remaining_percent");
        let total = val("total_count");
        if key == "weekly" && (val("status") == Some(3.0) || remaining.is_none() && total.unwrap_or_default() <= 0.0) {
            continue;
        }
        let fraction = remaining.map(|n| 100.0 - n).or_else(|| {
            let total = total.filter(|n| *n != 0.0)?;
            let used = val("usage_count")?;
            Some((if token_plan { total - used } else { used }).max(0.0) / total * 100.0)
        });
        let end = timestamp(&model[format!("{suffix}end_time")]);
        let seconds = end
            .zip(timestamp(&model[format!("{suffix}start_time")]))
            .filter(|(e, s)| e > s)
            .map(|(e, s)| ((e - s) / 1000.0).floor())
            .or_else(|| {
                num(&model[format!("{suffix}remains_time")]).filter(|n| *n > 0.0).map(|n| (n / 1000.0).floor())
            });
        windows.insert(key.into(), window(fraction, seconds, end, None));
    }
    Ok(windows.into())
}
