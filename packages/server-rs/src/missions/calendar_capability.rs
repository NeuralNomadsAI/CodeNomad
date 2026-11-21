//! Read-only recognition of the public Automations contract. The shared plugin
//! separately qualifies the native service and the fixed Code Mode action.
use super::{on_connection, unavailable};
use crate::{App, Error, opencode::Endpoint};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub(super) async fn automation_api(app: &App, endpoint: &Arc<Endpoint>) -> Result<Value, Error> {
    if !on_connection(app, endpoint) {
        return Err(unavailable());
    }
    let response = app
        .native
        .client
        .get(endpoint.url.join("/openapi.json").map_err(|_| unavailable())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let doc = crate::opencode::read_json(response, 4 * 1024 * 1024).await.map_err(|_| unavailable())?;
    if !on_connection(app, endpoint) {
        return Err(unavailable());
    }
    Ok(match contract(&doc) {
        Ok(()) => json!({"available":true}),
        Err(reason) => json!({"available":false,"reason":reason}),
    })
}

pub(super) async fn flag_origin(
    app: &App, endpoint: &Arc<Endpoint>, dir: &str, provenance: &str,
) -> Result<Option<String>, Error> {
    if !matches!(provenance, "experimental-block" | "all-flags") {
        return Ok(None);
    }
    let response = app.native.client.get(endpoint.url.join("/api/config").map_err(|_| unavailable())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .timeout(Duration::from_secs(5))
        .send().await.map_err(|_| unavailable())?
        .error_for_status().map_err(|_| unavailable())?;
    let entries = crate::opencode::read_json(response, 2 * 1024 * 1024).await.map_err(|_| unavailable())?;
    if !on_connection(app, endpoint) {
        return Err(unavailable());
    }
    let entries = entries.as_array().ok_or_else(unavailable)?;
    Ok(origin(entries, provenance).map(str::to_owned))
}

fn origin<'a>(entries: &'a [Value], provenance: &str) -> Option<&'a str> {
    entries.iter().rev().find(|entry| {
        if entry["type"] != "document" { return false; }
        let Some(experimental) = entry["info"].get("experimental") else { return false; };
        provenance == "experimental-block" || experimental.get("all_flags").is_some()
    }).and_then(|entry| entry["path"].as_str())
}

#[test]
fn flag_origin_tracks_native_document_precedence() {
    let entries = [
        json!({"type":"document","path":"/global","info":{"experimental":{"all_flags":true}}}),
        json!({"type":"document","path":"/project","info":{"experimental":{"automations":false}}}),
        json!({"type":"directory","path":"/unrelated"}),
    ];
    assert_eq!(origin(&entries, "experimental-block"), Some("/project"));
    assert_eq!(origin(&entries, "all-flags"), Some("/global"));
}

fn members(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten()
}
struct Schema<'a>(&'a Value, &'a Value);
impl<'a> Schema<'a> {
    fn node(&self) -> &'a Value {
        match self.1["$ref"].as_str().and_then(|r| r.strip_prefix("#/components/schemas/")) {
            Some(name) => &self.0[name],
            None => self.1,
        }
    }
    fn at(&self, v: &'a Value) -> Self {
        Self(self.0, v)
    }
    fn field(&self, key: &str) -> Self {
        self.at(&self.node()["properties"][key])
    }
    fn typed(&self, kind: &str) -> bool {
        self.node()["type"] == kind
    }
    fn fields(&self, names: &[&str], kind: &str) -> bool {
        names.iter().all(|n| self.field(n).typed(kind))
    }
    fn includes(&self, key: &str, entry: &str) -> bool {
        members(&self.node()[key]).any(|item| item == entry)
    }
    fn requires(&self, keys: &[&str]) -> bool {
        keys.iter().all(|&key| self.includes("required", key))
    }
    fn alternatives(&self, mut check: impl FnMut(Self) -> bool) -> bool {
        members(&self.node()["anyOf"]).any(|v| check(self.at(v)))
    }
    fn timing(&self) -> bool {
        ["at", "every", "cron"].iter().all(|&kind| {
            self.alternatives(|s| {
                s.typed("object")
                    && s.requires(&["type", kind])
                    && s.fields(&[kind, "tz"], "string")
                    && s.field("type").includes("enum", kind)
            })
        })
    }
    fn prompt(&self, target: bool) -> bool {
        self.alternatives(|s| {
            s.typed("object")
                && s.requires(&["type", "prompt"])
                && s.field("type").includes("enum", "prompt")
                && s.field("prompt").typed("string")
                && (!target
                    || s.requires(&["to"])
                        && s.field("to")
                            .alternatives(|t| t.requires(&["session"]) && t.field("session").typed("string")))
        })
    }
    fn info(&self) -> bool {
        let status = self.field("status");
        let run = self.field("runCount");
        let time = self.field("time");
        self.typed("object")
            && self.requires(&[
                "id",
                "name",
                "projectID",
                "directory",
                "trigger",
                "tz",
                "action",
                "status",
                "runCount",
                "time",
            ])
            && self.fields(&["id", "name", "projectID", "directory", "sessionID", "tz"], "string")
            && self.fields(&["nextDueAt", "expires"], "number")
            && run.typed("integer")
            && run.node()["minimum"] == 0
            && status.typed("string")
            && ["active", "paused", "done"].iter().all(|v| status.includes("enum", v))
            && time.typed("object")
            && time.fields(&["created", "updated"], "number")
            && self.field("trigger").timing()
            && self.field("action").prompt(true)
    }
}

fn contract(doc: &Value) -> Result<(), &'static str> {
    const BASE: &str = "/api/experimental/automation";
    const ITEM: &str = "/api/experimental/automation/{automationID}";
    let routes = [
        (BASE, "post", "create"),
        (BASE, "get", "list"),
        (ITEM, "get", "get"),
        (ITEM, "delete", "delete"),
        ("/api/experimental/automation/{automationID}/pause", "post", "pause"),
        ("/api/experimental/automation/{automationID}/resume", "post", "resume"),
    ];
    let paths = &doc["paths"];
    if routes.iter().any(|(path, method, _)| paths[*path][*method].is_null()) {
        return Err("missing-api");
    }
    let schemas = &doc["components"]["schemas"];
    let schema = |v| Schema(schemas, v);
    let valid = schema(&schemas["Config.InfoEncoded"]).field("experimental").field("automations").typed("boolean")
        && routes.iter().all(|&(path, method, action)| {
            let op = &paths[path][method];
            let params = || members(&op["parameters"]);
            if op["operationId"] != format!("experimental.automation.{action}")
                || path != BASE
                    && !params().any(|p| {
                        p["name"] == "automationID"
                            && p["in"] == "path"
                            && p["required"] == true
                            && schema(&p["schema"]).typed("string")
                    })
            {
                return false;
            }
            if action == "delete" {
                return op["responses"]["204"].is_object();
            }
            let body = schema(&op["responses"]["200"]["content"]["application/json"]["schema"]);
            let data = body.field("data");
            body.typed("object")
                && body.requires(&["data"])
                && match action {
                    "list" => {
                        data.typed("array")
                            && schema(&data.node()["items"]).info()
                            && params().any(|p| {
                                p["name"] == "sessionID" && p["in"] == "query" && {
                                    let s = schema(&p["schema"]);
                                    s.typed("string") || s.alternatives(|a| a.typed("string"))
                                }
                            })
                    }
                    "create" => {
                        let args = schema(&op["requestBody"]["content"]["application/json"]["schema"]);
                        data.info()
                            && args.typed("object")
                            && args.requires(&["name", "trigger", "action"])
                            && args.fields(&["sessionID", "name", "expires"], "string")
                            && args.field("trigger").timing()
                            && args.field("action").prompt(false)
                    }
                    _ => data.info(),
                }
        });
    valid.then_some(()).ok_or("incompatible-contract")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_operations_and_missing_payload_contract_are_distinct() {
        assert_eq!(contract(&json!({})), Err("missing-api"));
        let base = "/api/experimental/automation";
        let mut document = json!({"paths":{}});
        document["paths"][base] = json!({"get":{},"post":{}});
        document["paths"][format!("{base}/{{automationID}}")] = json!({"get":{},"delete":{}});
        document["paths"][format!("{base}/{{automationID}}/pause")] = json!({"post":{}});
        document["paths"][format!("{base}/{{automationID}}/resume")] = json!({"post":{}});
        assert_eq!(contract(&document), Err("incompatible-contract"));
    }
}
