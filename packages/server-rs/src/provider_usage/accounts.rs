//! Read-only provider account display metadata. Credential exports never cross the broker.
use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::time::Duration;

use super::{
    plans,
    shared::{jwt, num, text},
};
use crate::{App, Error, Shared, auth::Principal, error, opencode::Endpoint, shared::now_ms};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    directory: String,
}

pub(super) async fn route(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((workspace, integration)): Path<(String, String)>,
    query: Result<Query<Input>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let invalid = || error(Status::BAD_REQUEST, "Invalid provider accounts request");
    let work = async {
        let Query(input) = query.map_err(|_| invalid())?;
        if ![&workspace, &integration].iter().all(|id| !id.is_empty() && id.encode_utf16().count() <= 256)
            || input.directory.is_empty()
            || input.directory.encode_utf16().count() > 4096
        {
            return Err(invalid());
        }
        let result = snapshot(&app, &workspace, &integration, &input.directory).await?;
        principal.live()?;
        Ok(Json(result))
    };
    let result = tokio::select! {
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15), work) => result.unwrap_or_else(|_| Err(unavailable())),
    };
    ([(header::CACHE_CONTROL, "no-store")], result).into_response()
}

fn unavailable() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Provider accounts unavailable")
}

async fn native(app: &App, endpoint: &Endpoint, url: reqwest::Url) -> Result<Value, Error> {
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .send()
        .await
        .map_err(|_| unavailable())?;
    if response.status() != Status::OK {
        return Err(unavailable());
    }
    crate::opencode::read_json(response, 8 * 1024 * 1024).await.map_err(|_| unavailable())
}

async fn snapshot(app: &App, workspace: &str, integration: &str, directory: &str) -> Result<Value, Error> {
    let workspace = app.workspace(workspace).map_err(|_| error(Status::NOT_FOUND, "Workspace not found"))?;
    let endpoint =
        app.native.acquire(tokio::time::Instant::now() + Duration::from_secs(15)).await.map_err(|_| unavailable())?;
    let foreign = || error(Status::FORBIDDEN, "Location does not belong to workspace");
    let owned = crate::worktrees::ownership::resolve(app, &workspace, directory).await.ok_or_else(foreign)?;
    let checkout = owned.checkout;
    let directory = owned.directory;
    if !crate::sessions::permission_mode::workspace_current(app, &workspace) {
        return Err(foreign());
    }
    if !app.native.current(&endpoint) {
        return Err(unavailable());
    }
    let methods = match integration {
        "openai" | "anthropic" | "github-copilot" => &["oauth"][..],
        "opencode-go"
        | "zai-coding-plan"
        | "zhipuai-coding-plan"
        | "kimi-for-coding"
        | "minimax-coding-plan"
        | "minimax-cn-coding-plan" => &["key"][..],
        "opencode" => &["key", "oauth"][..],
        _ => return Ok(json!({"supported":false,"enabled":false,"logins":{}})),
    };
    let mut url =
        endpoint.url.join(&format!("/api/integration/{}", plans::encode(integration))).map_err(|_| unavailable())?;
    url.query_pairs_mut().append_pair("location[directory]", &directory);
    let binding = native(app, &endpoint, url).await?;
    if binding["location"]["directory"] != directory
        || binding["location"].get("workspaceID").is_some()
        || binding["data"]["id"] != integration
        || !app.native.current(&endpoint)
    {
        return Err(unavailable());
    }
    let exports = native(app, &endpoint, endpoint.url.join("/api/credential").map_err(|_| unavailable())?).await?;
    let entries = exports["data"].as_array().ok_or_else(unavailable)?;
    let connections = binding["data"]["connections"].as_array().ok_or_else(unavailable)?;
    let mut logins = Map::new();
    let mut eligible = 0;
    for item in connections.iter().take(128) {
        if item["type"] != "credential" || !item["method"].as_str().is_some_and(|method| methods.contains(&method)) {
            continue;
        }
        let Some(id) = item["id"].as_str().filter(|id| !id.is_empty() && id.encode_utf16().count() <= 256) else {
            continue;
        };
        let Some(entry) = entries.iter().find(|entry| entry["id"] == id && entry["integrationID"] == integration)
        else {
            continue;
        };
        let Some(email) = login(integration, methods, &entry["value"]) else { continue };
        eligible += 1;
        if item["label"] == "default"
            && let Some(email) = email
        {
            logins.insert(id.into(), json!(email));
        }
    }
    let enabled = app
        .settings
        .owner(crate::settings::Kind::Config, "providerAccounts")
        .get("autoSelect")
        .and_then(|policy| policy.get(integration))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !crate::worktrees::ownership::resolve(app, &workspace, &directory)
        .await
        .is_some_and(|latest| latest.directory == directory && latest.checkout == checkout)
        || !crate::sessions::permission_mode::workspace_current(app, &workspace)
    {
        return Err(foreign());
    }
    if !app.native.current(&endpoint) {
        return Err(unavailable());
    }
    Ok(json!({"supported":eligible >= 2,"enabled":enabled,"logins":logins}))
}

fn login(integration: &str, methods: &[&str], value: &Value) -> Option<Option<String>> {
    let kind = value["type"].as_str()?;
    if !methods.contains(&kind) {
        return None;
    }
    if kind == "key" {
        return value["key"]
            .as_str()
            .filter(|key| key.encode_utf16().count() <= 16_384)
            .and_then(|_| text(&value["key"]))
            .map(|_| None);
    }
    let access = text(&value["access"])?;
    if (integration != "openai" && value["access"].as_str()?.encode_utf16().count() > 16_384)
        || (integration == "opencode" && value["methodID"] != "device")
    {
        return None;
    }
    let metadata = &value["metadata"];
    let claims = if integration == "openai" {
        let claims = jwt(access);
        let limit = (now_ms() + 120_000) as f64;
        if !matches!(value["methodID"].as_str(), Some("chatgpt-browser" | "chatgpt-headless"))
            || value["expires"].as_f64().is_none_or(|exp| exp <= limit)
            || claims.get("exp").is_some_and(|value| {
                value.is_null()
                    || value.is_boolean()
                    || value.as_str().is_some_and(|text| crate::shared::js_trim(text).is_empty())
                    || num(value).is_some_and(|exp| exp * 1000. <= limit)
            })
            || text(&metadata["accountID"])
                .or_else(|| text(&claims["https://api.openai.com/auth"]["chatgpt_account_id"]))
                .is_none()
        {
            return None;
        }
        claims
    } else {
        Value::Null
    };
    let email = text(&metadata["email"])
        .or_else(|| text(&claims["https://api.openai.com/profile"]["email"]))
        .or_else(|| text(&claims["email"]));
    Some(email.filter(|email| display_email(email)).map(str::to_owned))
}

fn display_email(email: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_display_keeps_only_a_bounded_email() {
        assert!(display_email("fixture@example.test"));
        for invalid in ["fixture", "a@@example.test", "a@domain", "a\u{7f}@example.test", "a @example.test"] {
            assert!(!display_email(invalid), "{invalid:?}");
        }
        assert!(!display_email(&format!("{}@example.test", "a".repeat(250))));
        let credential = json!({"type":"oauth","access":"fixture","metadata":{"email":"  claude@example.test  "}});
        assert_eq!(login("anthropic", &["oauth"], &credential), Some(Some("claude@example.test".into())));
        assert_eq!(login("opencode", &["oauth"], &credential), None);
    }
}
