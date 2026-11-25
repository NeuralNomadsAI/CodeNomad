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

pub(super) struct ConfigEntries {
    pub entries: Vec<Value>,
    pub experimental: Vec<Option<crate::subagent_depth::jsonc::J>>,
}

pub(super) async fn config_entries(app: &App, endpoint: &Arc<Endpoint>, dir: &str) -> Result<ConfigEntries, Error> {
    if !on_connection(app, endpoint) {
        return Err(unavailable());
    }
    let response = app
        .native
        .client
        .get(endpoint.url.join("/api/config").map_err(|_| unavailable())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", dir)])
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| unavailable())?
        .error_for_status()
        .map_err(|_| unavailable())?;
    let bytes = crate::opencode::read_bytes(response, 2 * 1024 * 1024).await.map_err(|_| unavailable())?;
    if !on_connection(app, endpoint) {
        return Err(unavailable());
    }
    use crate::subagent_depth::jsonc::{self, J};
    let entries: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    let text = std::str::from_utf8(&bytes).map_err(|_| unavailable())?;
    let (Some(J::Arr(ordered)), false) = jsonc::parse(&jsonc::utf16(text), false) else { return Err(unavailable()) };
    if entries.len() > 256 || ordered.len() != entries.len() {
        return Err(unavailable());
    }
    let experimental = ordered.iter().map(|entry| entry.get("info").and_then(|info| info.get("experimental")).cloned()).collect();
    Ok(ConfigEntries { entries, experimental })
}

pub(super) const INLINE_CONFIG_SOURCE: &str = "OPENCODE_CONFIG_CONTENT";
pub(super) const REMOTE_CONFIG_SOURCE: &str = "well-known";

pub(super) fn source_path(path: &str) -> Option<&str> {
    (!matches!(path, INLINE_CONFIG_SOURCE | REMOTE_CONFIG_SOURCE)).then_some(path)
}

pub(super) fn experimental(entry: &Value) -> Option<&Value> {
    (entry["type"] == "document").then(|| entry["info"].get("experimental")).flatten()
}

pub(super) fn origin<'a>(entries: &'a [Value], flag: &'a Value) -> Option<&'a str> {
    // Runtimes with the top-level setting name the deciding source themselves; pathless config has no file.
    if let Some(path) = flag["path"].as_str().filter(|p| !p.is_empty()) {
        return source_path(path);
    }
    let provenance = flag["provenance"].as_str()?;
    if !matches!(provenance, "experimental-block" | "all-flags") {
        return None;
    }
    entries
        .iter()
        .rev()
        .find(|entry| {
            experimental(entry)
                .is_some_and(|block| provenance == "experimental-block" || block.get("all_flags").is_some())
        })
        .and_then(|entry| entry["path"].as_str())
}

#[test]
fn flag_origin_tracks_native_document_precedence() {
    let entries = [
        json!({"type":"document","path":"/global","info":{"experimental":{"all_flags":true}}}),
        json!({"type":"document","path":"/project","info":{"experimental":{"automations":false}}}),
        json!({"type":"directory","path":"/unrelated"}),
    ];
    assert_eq!(origin(&entries, &json!({"enabled":false,"provenance":"experimental-block"})), Some("/project"));
    assert_eq!(origin(&entries, &json!({"enabled":true,"provenance":"all-flags"})), Some("/global"));
    assert_eq!(
        origin(&entries, &json!({"enabled":true,"provenance":"automations-setting","path":"/p.json"})),
        Some("/p.json")
    );
    assert_eq!(origin(&entries, &json!({"enabled":true,"provenance":"automations-setting"})), None);
    for path in [INLINE_CONFIG_SOURCE, REMOTE_CONFIG_SOURCE] {
        assert_eq!(
            origin(&entries, &json!({"enabled":false,"provenance":"automations-setting","path":path})),
            None
        );
    }
    assert_eq!(
        origin(&[], &json!({"enabled":false,"provenance":"experimental-block","path":"/g.json"})),
        Some("/g.json")
    );
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
    // The on/off setting is top-level `automations`, or `experimental.automations` on runtimes that read that block.
    let config = schema(&schemas["Config.InfoEncoded"]);
    let valid = (config.field("automations").typed("boolean")
        || config.field("experimental").field("automations").typed("boolean"))
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

    fn fixture() -> Value {
        let string = json!({"type":"string"});
        let number = json!({"type":"number"});
        let reference = |name: &str| json!({"$ref": format!("#/components/schemas/{name}")});
        let action = json!({"anyOf":[{
            "type":"object",
            "properties":{
                "type":{"type":"string","enum":["prompt"]},
                "prompt":string,
                "to":{"anyOf":[{"type":"object","properties":{"session":string},"required":["session"]}]}
            },
            "required":["type","prompt","to"]
        }]});
        let triggers: Vec<Value> = ["at", "every", "cron"]
            .into_iter()
            .map(|kind| {
                json!({
                    "type":"object",
                    "properties":{"type":{"type":"string","enum":[kind]}, kind: string, "tz": string},
                    "required":["type", kind]
                })
            })
            .collect();
        let schemas = json!({
            "Config.InfoEncoded": {
                "type":"object",
                "properties":{"experimental":{"type":"object","properties":{"automations":{"type":"boolean"}}}}
            },
            "Automation.Info": {
                "type":"object",
                "properties":{
                    "id":string,"name":string,"projectID":string,"directory":string,"sessionID":string,
                    "trigger":reference("Automation.Trigger"),"tz":string,"action":action,
                    "status":{"type":"string","enum":["active","paused","done"]},
                    "runCount":{"type":"integer","minimum":0},
                    "nextDueAt":number,"expires":number,
                    "time":{"type":"object","properties":{"created":number,"updated":number}}
                },
                "required":["id","name","projectID","directory","trigger","tz","action","status","runCount","time"]
            },
            "Automation.Trigger": {"anyOf": triggers},
            "Automation.CreatePayload": {
                "type":"object",
                "properties":{
                    "sessionID":string,"name":string,"trigger":reference("Automation.Trigger"),
                    "action":action,"expires":string
                },
                "required":["name","trigger","action"]
            }
        });
        let base = "/api/experimental/automation";
        let item = "/api/experimental/automation/{automationID}";
        let mut paths = serde_json::Map::new();
        for (path, method, name) in [
            (base, "post", "create"),
            (base, "get", "list"),
            (item, "get", "get"),
            (item, "delete", "delete"),
            ("/api/experimental/automation/{automationID}/pause", "post", "pause"),
            ("/api/experimental/automation/{automationID}/resume", "post", "resume"),
        ] {
            let mut op = json!({"operationId": format!("experimental.automation.{name}")});
            if name == "delete" {
                op["responses"] = json!({"204":{}});
            } else {
                let data = if name == "list" {
                    json!({"type":"array","items":reference("Automation.Info")})
                } else {
                    reference("Automation.Info")
                };
                op["responses"] = json!({"200":{"content":{"application/json":{"schema":{
                    "type":"object","properties":{"data":data},"required":["data"]
                }}}}});
            }
            if name == "list" {
                op["parameters"] = json!([{"name":"sessionID","in":"query","required":false,"schema":{"anyOf":[string]}}]);
            } else if path != base {
                op["parameters"] = json!([{"name":"automationID","in":"path","required":true,"schema":string}]);
            }
            if name == "create" {
                op["requestBody"] = json!({"content":{"application/json":{"schema":reference("Automation.CreatePayload")}}});
            }
            paths
                .entry(path.to_owned())
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap()
                .insert(method.to_owned(), op);
        }
        json!({"paths": paths, "components": {"schemas": schemas}})
    }

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

    #[test]
    fn automations_setting_qualifies_at_top_level_or_in_experimental_block() {
        let mut doc = fixture();
        assert_eq!(contract(&doc), Ok(()));
        doc["components"]["schemas"]["Config.InfoEncoded"]["properties"] =
            json!({"automations":{"type":"boolean"},"experimental":{"type":"object","properties":{}}});
        assert_eq!(contract(&doc), Ok(()));
        doc["components"]["schemas"]["Config.InfoEncoded"]["properties"]["automations"]["type"] = json!("string");
        assert_eq!(contract(&doc), Err("incompatible-contract"));
        doc["components"]["schemas"]["Config.InfoEncoded"]["properties"] = json!({});
        assert_eq!(contract(&doc), Err("incompatible-contract"));
    }
}
