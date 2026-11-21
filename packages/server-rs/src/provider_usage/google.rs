//! Google CLI and Antigravity quota, with bounded OAuth refresh and checked public labels.
use std::{collections::VecDeque, sync::LazyLock};

use serde_json::{Value, json};

use super::{State, shared::*};
use crate::shared::now_ms;

// Public installed-application identifiers, as embedded by each upstream client.
const GEMINI: (&str, &str) =
    ("681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com", "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");
const ANTIGRAVITY: (&str, &str) = (
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    "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",
);

pub struct Token {
    identity: String,
    expires: u64,
    value: String,
}

pub fn model(value: &str) -> Option<&str> {
    static FORM: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^gemini-[0-9]{1,2}(?:\.[0-9]{1,2})?-(?:pro|flash(?:-lite)?)(?:-(?:preview|exp))?(?:-[0-9]{2}-[0-9]{2}|-[0-9]{3})?$").unwrap()
    });
    let value = value.strip_prefix("google/").unwrap_or(value);
    let value = ["models/", "gemini-cli/", "gemini-cli-"].iter().find_map(|p| value.strip_prefix(p)).unwrap_or(value);
    (value.len() <= 64 && FORM.is_match(value)).then_some(value)
}

fn remember(cache: &mut VecDeque<Token>, token: Token) {
    if cache.len() >= 32 {
        cache.pop_front();
    }
    cache.push_back(token);
}
pub async fn read(state: &State, auth: &Value) -> Quota {
    let e = &auth["google"];
    if !e.is_object() {
        return Err(MISSING);
    }
    let anti = e["methodID"] == "antigravity";
    if e["type"] != "oauth" || !anti && e["methodID"] != "gemini-cli" {
        return Err(FAILED);
    }
    let access = text(&e["access"]);
    let packed = text(&e["refresh"]).unwrap_or_default();
    if access.is_some_and(|s| s.encode_utf16().count() > 16_384) || packed.encode_utf16().count() > 16_384 {
        return Err(FAILED);
    }
    let mut parts = packed.split('|');
    let refresh = parts.next().filter(|s| !s.trim().is_empty()).map(str::trim);
    let project = parts.next().map(str::trim).filter(|s| !s.is_empty());
    let managed = parts.next().map(str::trim).filter(|s| !s.is_empty());
    let mut project = if anti { managed.or(project) } else { project.or(managed) }.map(str::to_owned);
    if anti && project.is_none() {
        return Err(FAILED);
    }
    let identity = hash(e);
    let now = now_ms();
    let cached = {
        let mut cache = state.google.lock().unwrap();
        cache.retain(|token| token.expires > now);
        cache.iter().find(|token| token.identity == identity).map(|token| token.value.clone())
    };
    let installed = if anti { ANTIGRAVITY } else { GEMINI };
    let (client, secret) = state.http().fixture_oauth().unwrap_or(installed);
    let token =
        if let Some(access) = access.filter(|_| e["expires"].as_f64().is_some_and(|expires| expires > now as f64)) {
            access.to_owned()
        } else if let Some(token) = cached {
            token
        } else {
            let refresh = refresh.ok_or(FAILED)?;
            let form = reqwest::Url::parse_with_params(
                "https://oauth2.googleapis.com/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                    ("client_id", client),
                    ("client_secret", secret),
                ],
            )
            .map_err(|_| FAILED)?;
            let data = state
                .http()
                .send(
                    "https://oauth2.googleapis.com/token",
                    &[("Content-Type", "application/x-www-form-urlencoded")],
                    Some(form.query().unwrap_or_default().as_bytes().to_vec()),
                    true,
                )
                .await?
                .checked_json()?;
            let token =
                text(&data["access_token"]).filter(|s| s.encode_utf16().count() <= 16_384).ok_or(FAILED)?.to_owned();
            let expires = data["expires_in"]
                .as_f64()
                .map(|s| now as f64 + s * 1000.0)
                .filter(|t| t.is_finite() && *t > now_ms() as f64)
                .ok_or(FAILED)? as u64;
            remember(&mut state.google.lock().unwrap(), Token { identity, expires, value: token.clone() });
            token
        };
    let secrets = packed
        .split('|')
        .chain(access)
        .chain([token.as_str(), GEMINI.1, ANTIGRAVITY.1, secret])
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect::<Vec<_>>();
    let safe = |value: &str| !secrets.iter().any(|s| value.to_lowercase().contains(s));
    let auth = format!("Bearer {token}");
    let mut headers = vec![("Authorization", auth.as_str()), ("Content-Type", "application/json")];
    let http = state.http();
    if anti {
        headers
            .push(("User-Agent", "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)"));
        let p = http
            .post(
                "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
                &headers,
                &json!({"project":project}),
            )
            .await?;
        let groups = p["groups"].as_array().filter(|a| !a.is_empty()).ok_or(INVALID)?;
        let mut w = Fields::new();
        for group in groups {
            let buckets = group["buckets"].as_array().ok_or(INVALID)?;
            if ["displayName", "groupId", "family"].iter().any(|k| group[*k].as_str().is_some_and(|s| !safe(s))) {
                continue;
            }
            let name = text(&group["displayName"]);
            if group.get("displayName").is_some() && name.is_none() {
                return Err(INVALID);
            }
            let family = match name.map(str::to_ascii_lowercase).as_deref() {
                Some("gemini" | "gemini models") => Some("Gemini"),
                Some("claude and gpt" | "claude and gpt models") => Some("Claude/GPT"),
                None if groups.len() == 1 => None,
                _ => continue,
            };
            for bucket in buckets {
                if !bucket.is_object() {
                    return Err(INVALID);
                }
                if bucket["disabled"] == true
                    || ["bucketId", "displayName", "window"]
                        .iter()
                        .any(|k| bucket[*k].as_str().is_some_and(|s| !safe(s)))
                {
                    continue;
                }
                let kind = text(&bucket["window"]).map(str::to_ascii_lowercase).unwrap_or_default();
                let seconds = match kind.as_str() {
                    "5h" => FIVE_HOURS,
                    "weekly" => WEEK,
                    _ => continue,
                };
                let field = |k| bucket["remaining"].get(k).or_else(|| bucket.get(k));
                let fraction = field("remainingFraction")
                    .map(|v| v.as_f64().filter(|n| (0.0..=1.0).contains(n)).ok_or(INVALID))
                    .transpose()?;
                let reset = field("resetTime")
                    .map(|v| {
                        v.as_str()
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .map(|t| t.timestamp_millis() as f64)
                            .ok_or(INVALID)
                    })
                    .transpose()?;
                let label = family.map_or_else(|| kind.clone(), |f| format!("{kind}:{f}"));
                if !safe(&label) {
                    continue;
                }
                if w.insert(label, window(fraction.map(|n| (1.0 - n) * 100.0), Some(seconds), reset, None)).is_some() {
                    return Err(INVALID);
                }
            }
        }
        return if w.values().any(|w| w["usedPercent"].is_number()) { Ok(w.into()) } else { Err(INVALID) };
    }
    if project.is_none() {
        // Existing setup only; never onboard an account.
        let body =
            br#"{"metadata":{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}"#
                .to_vec();
        let setup = http
            .send("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", &headers, Some(body), true)
            .await?
            .checked_json()?;
        project = text(&setup["cloudaicompanionProject"]).map(str::to_owned);
    }
    let p = http
        .post(
            "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
            &headers,
            &json!({"project":project.ok_or(INVALID)?}),
        )
        .await?;
    let mut usage = Usage::default();
    for b in p["buckets"].as_array().ok_or(INVALID)? {
        let Some(model) = b["modelId"].as_str().and_then(model) else { continue };
        if !safe(model)
            || ["modelId", "bucketId", "displayName", "tokenType"]
                .iter()
                .any(|k| b[*k].as_str().is_some_and(|s| !safe(s)))
        {
            continue;
        }
        let name = match text(&b["tokenType"]) {
            Some(s @ ("REQUESTS" | "TOKENS" | "INPUT_TOKENS" | "OUTPUT_TOKENS")) => s.to_ascii_lowercase(),
            _ => "usage".into(),
        };
        if !safe(&format!("{name}:{model}")) {
            continue;
        }
        let at = match usage.models.iter().position(|(m, _)| m == model) {
            Some(i) => i,
            None => {
                usage.models.push((model.to_owned(), Fields::new()));
                usage.models.len() - 1
            }
        };
        let fraction = b["remainingFraction"].as_f64().filter(|f| (0.0..=1.0).contains(f));
        let v = window(fraction.map(|f| (1.0 - f) * 100.0), None, timestamp(&b["resetTime"]), None);
        if usage.models[at].1.insert(name, v).is_some() {
            return Err(INVALID);
        }
    }
    if usage.models.iter().any(|(_, w)| w.values().any(|w| w["usedPercent"].is_number())) {
        Ok(usage)
    } else {
        Err(INVALID)
    }
}
