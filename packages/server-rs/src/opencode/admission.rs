//! Admission of a discovered daemon (`runtime-support.ts`, `compatibility/negotiate.ts`): a minimum
//! release, then for any other version than the reviewed minimum its declared HTTP contract.
use std::{fmt, time::Duration};

use reqwest::Client;
use serde_json::Value;

use super::daemon::Endpoint;

pub const MINIMUM_VERSION: &str = "2.3.2";

/// Why no connection: an unsupported daemon (HTTP 426 on workspace creation) or any other failure.
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    Unsupported { actual: String, reason: &'static str },
    Failed(String),
}
impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Refusal::Failed(message) => f.write_str(message),
            Refusal::Unsupported { actual, reason } => {
                let why = match *reason {
                    "native_contract" => format!(
                        "requires the background subagent report contract, native image generation, replay, Code Mode job ordering and Mission Automations of {MINIMUM_VERSION}"
                    ),
                    "session_environment" => "requires PUT /api/session/{sessionID}/environment with variables".into(),
                    _ => "does not expose the canonical session, permission, Form and inbox API contract".into(),
                };
                write!(f, "opencode_update_required: OpenCode {actual}; {why}")
            }
        }
    }
}
impl From<String> for Refusal {
    fn from(message: String) -> Self {
        Refusal::Failed(message)
    }
}

/// `isBelowOpenCodeMinimum`: historical V2 betas, or a plain release below the minimum; other labels pass.
pub fn below_minimum(version: &str) -> bool {
    static RELEASE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^(?:0\.0\.0-beta-[0-9]+|([0-9]+)\.([0-9]+)\.([0-9]+)(?:\+[A-Za-z0-9_.-]+)?)$").unwrap()
    });
    let Some(found) = RELEASE.captures(version) else { return false };
    let Some(major) = found.get(1) else { return true };
    let number = |m: Option<regex::Match>| m.map_or(0.0, |m| m.as_str().parse::<f64>().unwrap_or(f64::INFINITY));
    let release = [number(Some(major)), number(found.get(2)), number(found.get(3))];
    let minimum = MINIMUM_VERSION.split('.').map(|p| p.parse::<f64>().unwrap()).collect::<Vec<_>>();
    release.as_slice() < minimum.as_slice()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub reload: bool,
}

/// `assertSupportedOpenCode`, then for any other version than the reviewed minimum the declared
/// HTTP contract (`negotiateRuntime`): read only, never a trial write.
pub async fn inspect(client: &Client, endpoint: &Endpoint) -> Result<Capabilities, Refusal> {
    let unsupported = |reason| Refusal::Unsupported { actual: endpoint.version.clone(), reason };
    if below_minimum(&endpoint.version) {
        return Err(unsupported("native_contract"));
    }
    if endpoint.version == MINIMUM_VERSION {
        return Ok(Capabilities { reload: true });
    }
    let target = endpoint.url.join("/openapi.json").map_err(|_| Refusal::Failed("Missing OpenCode contract".into()))?;
    let response = client
        .get(target)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| Refusal::Failed("Cannot negotiate OpenCode contract".into()))?;
    if !response.status().is_success() {
        return Err(Refusal::Failed(format!(
            "Cannot negotiate OpenCode contract (HTTP {})",
            response.status().as_u16()
        )));
    }
    let document = super::read_json(response, 8 * 1024 * 1024)
        .await
        .map_err(|_| Refusal::Failed("OpenCode contract exceeds limit".into()))?;
    contract(&document).map_err(unsupported)
}

pub async fn admit(client: &Client, endpoint: &Endpoint) -> Result<(), Refusal> {
    inspect(client, endpoint).await.map(|_| ())
}

/// The declared contract checks of `negotiateRuntime`.
pub fn contract(document: &Value) -> Result<Capabilities, &'static str> {
    let schemas = &document["components"]["schemas"];
    let resolve = |schema: &Value| match schema["$ref"].as_str().and_then(|r| r.strip_prefix("#/components/schemas/")) {
        Some(name) => schemas[name].clone(),
        None => schema.clone(),
    };
    let paths = &document["paths"];
    let has = |path: &str, method: &str| paths[path][method].is_object();
    let body = |path: &str, field: &str, method: &str| {
        let schema = &paths[path][method]["requestBody"]["content"]["application/json"]["schema"];
        resolve(schema)["properties"].get(field).is_some()
    };
    let session = "/api/session/{sessionID}";
    let inbox = resolve(&schemas["Session.Inbox.User"]);
    let inbox = &inbox["properties"];
    let modern = has(session, "patch")
        && has("/api/form", "get")
        && has(&format!("{session}/form/{{formID}}"), "delete")
        && has("/api/experimental/session/{sessionID}/wait", "post")
        && body(&format!("{session}/fork"), "before", "post")
        && body(&format!("{session}/command"), "name", "post")
        && body(&format!("{session}/permission/{{requestID}}/reply"), "decision", "post")
        && inbox.get("time").is_some()
        && inbox.get("timeCreated").is_none();
    if !modern {
        return Err("canonical_api");
    }
    if !body(&format!("{session}/environment"), "variables", "put") {
        return Err("session_environment");
    }
    let fields = |name: &str| schemas[name]["properties"].clone();
    let (text, compaction) = (fields("Session.Message.Assistant.Text"), fields("Session.Message.Compaction.Completed"));
    if text.get("native").is_none()
        || text.get("state").is_some()
        || compaction.get("metadata").is_none()
        || compaction.get("recent").is_some()
    {
        return Err("native_contract");
    }
    Ok(Capabilities { reload: has("/api/location/reload", "post") })
}
