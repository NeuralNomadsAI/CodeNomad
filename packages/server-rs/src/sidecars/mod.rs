//! SideCars (`sidecars/manager.ts`, `routes/sidecars.ts`): local services on 127.0.0.1 kept in
//! `config.yaml` (`server.sidecars`, read once at start like the reference), their port probe
//! and `sidecar.*` events; the proxy is in `proxy`.
pub mod proxy;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    App, Error, Shared, error, now,
    settings::{Kind, document::Doc},
    shared::{fastify, js_trim},
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SideCar {
    pub id: String,
    kind: &'static str,
    name: String,
    /// Any integer a hand-edited document holds, as the reference loads it.
    pub port: i64,
    pub insecure: bool,
    pub prefix_mode: &'static str,
    status: &'static str,
    created_at: String,
    updated_at: String,
}

/// `loadConfiguredSideCars`: malformed records are skipped; statuses start stopped.
pub fn load(server: &Doc) -> Vec<SideCar> {
    let text = |v: &Value| v.as_str().map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let list = server.get("sidecars").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut records: Vec<SideCar> = Vec::new();
    for item in &list {
        let port = item["port"].as_f64().filter(|p| p.fract() == 0.0 && *p != 0.0);
        let (Some(id), Some(name), Some(port), true) =
            (text(&item["id"]), text(&item["name"]), port, item["kind"] == "port")
        else {
            continue;
        };
        let created = item["createdAt"].as_str().filter(|s| !s.is_empty()).map_or_else(now, str::to_owned);
        let updated =
            item["updatedAt"].as_str().filter(|s| !s.is_empty()).map_or_else(|| created.clone(), str::to_owned);
        let record = SideCar {
            id,
            kind: "port",
            name,
            port: port as i64,
            insecure: item["insecure"] == true,
            prefix_mode: if item["prefixMode"] == "preserve" { "preserve" } else { "strip" },
            status: "stopped",
            created_at: created,
            updated_at: updated,
        };
        // `Map.set`: a repeated id keeps its first position, last record.
        match records.iter_mut().find(|r| r.id == record.id) {
            Some(slot) => *slot = record,
            None => records.push(record),
        }
    }
    records
}

pub fn routes() -> Router<Shared> {
    Router::new().route("/api/sidecars", get(list).post(create)).route("/api/sidecars/{id}", put(update).delete(remove))
}

/// `buildProxyBasePath`: `/sidecars/<encodeURIComponent(id)>`.
pub fn base(id: &str) -> String {
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
    format!("/sidecars/{}", percent_encoding::utf8_percent_encode(id, COMPONENT))
}

/// `buildTargetPath`: the public path, kept or stripped of its base.
pub fn target_path(record: &SideCar, path: &str, search: &str) -> String {
    let base = base(&record.id);
    let path = if path.is_empty() { &base } else { path };
    if record.prefix_mode == "preserve" {
        return format!("{path}{search}");
    }
    let stripped = path.strip_prefix(base.as_str()).unwrap_or(path);
    let stripped = match stripped {
        "" | "/" => "/".to_owned(),
        s if !s.starts_with('/') => format!("/{s}"),
        s => s.to_owned(),
    };
    format!("{stripped}{search}")
}

/// `isPortAvailable`: something accepts on 127.0.0.1:<port>.
async fn listening(port: i64) -> bool {
    let Ok(port) = u16::try_from(port) else { return false };
    tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

/// `refreshPortSideCar`: a changed status is saved with a new `updatedAt` and published.
async fn refresh(app: &App, id: &str) {
    let Some(port) = app.sidecars.lock().unwrap().iter().find(|r| r.id == id).map(|r| r.port) else { return };
    let status = if listening(port).await { "running" } else { "stopped" };
    let mut records = app.sidecars.lock().unwrap();
    let Some(record) = records.iter_mut().find(|r| r.id == id).filter(|r| r.status != status) else { return };
    record.status = status;
    record.updated_at = now();
    let event = json!({"type": "sidecar.updated", "sidecar": record});
    drop(records);
    app.emit(event);
}

/// The startup probe of every configured SideCar.
pub async fn probe(app: Shared) {
    let ids: Vec<_> = app.sidecars.lock().unwrap().iter().map(|r| r.id.clone()).collect();
    futures_util::future::join_all(ids.iter().map(|id| refresh(&app, id))).await;
}

/// `SideCarManager.get`, probing the port first.
pub async fn get_one(app: &App, id: &str) -> Option<SideCar> {
    refresh(app, id).await;
    app.sidecars.lock().unwrap().iter().find(|r| r.id == id).cloned()
}

fn persist(app: &App, records: &[SideCar]) -> Result<(), String> {
    let list: Vec<_> = records
        .iter()
        .map(|r| {
            json!({"id": r.id, "kind": r.kind, "name": r.name, "port": r.port, "insecure": r.insecure,
                "prefixMode": r.prefix_mode, "createdAt": r.created_at, "updatedAt": r.updated_at})
        })
        .collect();
    crate::settings::patch_owner(app, Kind::Config, "server", json!({ "sidecars": list }))
        .map(|_| ())
        .map_err(|f| f.message())
}

async fn list(State(app): State<Shared>) -> Json<Value> {
    probe(app.clone()).await;
    Json(json!({"sidecars": &*app.sidecars.lock().unwrap()}))
}

fn refused(message: impl AsRef<str>) -> Error {
    error(Status::BAD_REQUEST, message.as_ref())
}

/// `request.body ?? {}` behind Fastify's default parsers.
fn body(headers: &HeaderMap, bytes: &[u8]) -> Result<Value, Error> {
    Ok(match fastify::body(headers, bytes)? {
        None => json!({}),
        Some(fastify::Body::Json(value)) => value,
        Some(fastify::Body::Text(text)) => Value::String(text),
    })
}

/// `buildSideCarId`.
fn slug(name: &str) -> Result<String, String> {
    let mut id = String::new();
    for c in js_trim(name).to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            id.push(c);
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    let id = id.strip_prefix('-').unwrap_or(&id);
    let id = id.strip_suffix('-').unwrap_or(id);
    if id.is_empty() { Err("SideCar name must include letters or numbers".into()) } else { Ok(id.to_owned()) }
}

async fn create(State(app): State<Shared>, headers: HeaderMap, bytes: Bytes) -> Result<Response, Error> {
    let input = zod::parse(&body(&headers, &bytes)?, true).map_err(refused)?;
    let name = input.name.unwrap();
    let id = slug(&name).map_err(refused)?;
    let stamp = now();
    let record = SideCar {
        id: id.clone(),
        kind: "port",
        name,
        port: input.port.unwrap(),
        insecure: input.insecure,
        prefix_mode: input.prefix_mode,
        status: "stopped",
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    {
        let mut records = app.sidecars.lock().unwrap();
        if records.iter().any(|r| r.id == id) {
            return Err(refused(format!("SideCar '{id}' already exists")));
        }
        records.push(record);
        if let Err(message) = persist(&app, &records) {
            records.pop();
            return Err(refused(message));
        }
    }
    let saved = get_one(&app, &id).await.ok_or_else(|| refused("SideCar not found"))?;
    Ok((Status::CREATED, Json(saved)).into_response())
}

async fn update(
    State(app): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<SideCar>, Error> {
    let input = zod::parse(&body(&headers, &bytes)?, false).map_err(refused)?;
    {
        let mut records = app.sidecars.lock().unwrap();
        let at = records.iter().position(|r| r.id == id).ok_or_else(|| refused("SideCar not found"))?;
        let previous = records[at].clone();
        let record = &mut records[at];
        record.name = input.name.unwrap_or(previous.name.clone());
        record.port = input.port.unwrap_or(previous.port);
        // The schema's defaults apply to an update too: a missing field resets them.
        record.insecure = input.insecure;
        record.prefix_mode = input.prefix_mode;
        record.updated_at = now();
        if let Err(message) = persist(&app, &records) {
            records[at] = previous;
            return Err(refused(message));
        }
    }
    get_one(&app, &id).await.map(Json).ok_or_else(|| refused("SideCar not found"))
}

async fn remove(State(app): State<Shared>, Path(id): Path<String>) -> Result<Status, Error> {
    {
        let mut records = app.sidecars.lock().unwrap();
        let at =
            records.iter().position(|r| r.id == id).ok_or_else(|| error(Status::NOT_FOUND, "SideCar not found"))?;
        let record = records.remove(at);
        if let Err(message) = persist(&app, &records) {
            records.insert(at, record);
            return Err(refused(message));
        }
    }
    app.emit(json!({"type": "sidecar.removed", "sidecarId": id}));
    Ok(Status::NO_CONTENT)
}

/// `SideCarCreateSchema` and its partial update form (zod 4), refusals as their `ZodError` message.
mod zod {
    use serde_json::{Value, json};

    pub struct Input {
        pub name: Option<String>,
        pub port: Option<i64>,
        pub insecure: bool,
        pub prefix_mode: &'static str,
    }
    const SAFE: f64 = 9_007_199_254_740_991.0;

    fn kind(v: &Value) -> &'static str {
        match v {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
    fn expected(key: &str, want: &str, got: Option<&Value>) -> Vec<(&'static str, Value)> {
        let got = got.map_or("undefined", kind);
        vec![
            ("expected", json!(want)),
            ("code", json!("invalid_type")),
            ("path", json!([key])),
            ("message", json!(format!("Invalid input: expected {want}, received {got}"))),
        ]
    }
    fn bound(key: &str, code: &str, origin: &str, limit: f64, message: String) -> Vec<(&'static str, Value)> {
        let name = if code == "too_big" { "maximum" } else { "minimum" };
        vec![
            ("origin", json!(origin)),
            ("code", json!(code)),
            (name, json!(limit as i64)),
            ("inclusive", json!(true)),
            ("path", json!([key])),
            ("message", json!(message)),
        ]
    }

    /// `JSON.stringify(issues, null, 2)`, with each issue's keys in zod's order.
    fn message(issues: &[Vec<(&str, Value)>]) -> String {
        fn pretty(v: &Value, indent: usize) -> String {
            match v.as_array() {
                Some(items) if !items.is_empty() => {
                    let pad = " ".repeat(indent + 2);
                    let items: Vec<_> = items.iter().map(|x| format!("{pad}{x}")).collect();
                    format!("[\n{}\n{}]", items.join(",\n"), " ".repeat(indent))
                }
                _ => v.to_string(),
            }
        }
        let issues: Vec<_> = issues
            .iter()
            .map(|issue| {
                let fields: Vec<_> = issue.iter().map(|(k, v)| format!("    \"{k}\": {}", pretty(v, 4))).collect();
                format!("  {{\n{}\n  }}", fields.join(",\n"))
            })
            .collect();
        format!("[\n{}\n]", issues.join(",\n"))
    }

    pub fn parse(body: &Value, create: bool) -> Result<Input, String> {
        let Some(object) = body.as_object() else {
            return Err(message(&[vec![
                ("expected", json!("object")),
                ("code", json!("invalid_type")),
                ("path", json!([])),
                ("message", json!(format!("Invalid input: expected object, received {}", kind(body)))),
            ]]));
        };
        let mut issues = Vec::new();
        if create && object.get("kind").is_some_and(|k| k != "port") {
            issues.push(vec![
                ("code", json!("invalid_value")),
                ("values", json!(["port"])),
                ("path", json!(["kind"])),
                ("message", json!("Invalid input: expected \"port\"")),
            ]);
        }
        let name = match object.get("name") {
            None if !create => None,
            Some(Value::String(s)) => {
                let s = crate::shared::js_trim(s);
                if s.is_empty() {
                    issues.push(bound(
                        "name",
                        "too_small",
                        "string",
                        1.0,
                        "Too small: expected string to have >=1 characters".into(),
                    ));
                }
                Some(s.to_owned())
            }
            other => {
                issues.push(expected("name", "string", other));
                // zod still measures an array's length.
                if other.and_then(Value::as_array).is_some_and(Vec::is_empty) {
                    issues.push(bound(
                        "name",
                        "too_small",
                        "array",
                        1.0,
                        "Too small: expected array to have >=1 items".into(),
                    ));
                }
                None
            }
        };
        let port = match object.get("port") {
            None if !create => None,
            Some(Value::Number(n)) => {
                let n = n.as_f64().unwrap_or(f64::NAN);
                if n.fract() != 0.0 {
                    issues.push(vec![
                        ("expected", json!("int")),
                        ("format", json!("safeint")),
                        ("code", json!("invalid_type")),
                        ("path", json!(["port"])),
                        ("message", json!("Invalid input: expected int, received number")),
                    ]);
                } else {
                    if n.abs() > SAFE {
                        let (code, name, limit, op) = if n > 0.0 {
                            ("too_big", "maximum", SAFE, "<=")
                        } else {
                            ("too_small", "minimum", -SAFE, ">=")
                        };
                        let word = if n > 0.0 { "big" } else { "small" };
                        issues.push(vec![
                            ("code", json!(code)),
                            (name, json!(limit as i64)),
                            ("note", json!("Integers must be within the safe integer range.")),
                            ("origin", json!("int")),
                            ("inclusive", json!(true)),
                            ("path", json!(["port"])),
                            ("message", json!(format!("Too {word}: expected int to be {op}{}", limit as i64))),
                        ]);
                    }
                    if n < 1.0 {
                        issues.push(bound(
                            "port",
                            "too_small",
                            "number",
                            1.0,
                            "Too small: expected number to be >=1".into(),
                        ));
                    } else if n > 65535.0 {
                        issues.push(bound(
                            "port",
                            "too_big",
                            "number",
                            65535.0,
                            "Too big: expected number to be <=65535".into(),
                        ));
                    }
                }
                Some(n as i64)
            }
            other => {
                issues.push(expected("port", "number", other));
                None
            }
        };
        let insecure = match object.get("insecure") {
            None => false,
            Some(Value::Bool(b)) => *b,
            other => {
                issues.push(expected("insecure", "boolean", other));
                false
            }
        };
        let prefix_mode = match object.get("prefixMode").map(|v| v.as_str()) {
            None => "strip",
            Some(Some("preserve")) => "preserve",
            Some(Some("strip")) => "strip",
            Some(_) => {
                issues.push(vec![
                    ("code", json!("invalid_value")),
                    ("values", json!(["strip", "preserve"])),
                    ("path", json!(["prefixMode"])),
                    ("message", json!("Invalid option: expected one of \"strip\"|\"preserve\"")),
                ]);
                "strip"
            }
        };
        if !issues.is_empty() {
            return Err(message(&issues));
        }
        Ok(Input { name, port, insecure, prefix_mode })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // Messages printed by the reference schema (zod 4.6).
        #[test]
        fn refusals_are_the_reference_messages() {
            let text = |v: Value, create| parse(&v, create).err().unwrap().replace(['\n', ' '], "");
            assert_eq!(
                text(json!({}), true),
                r#"[{"expected":"string","code":"invalid_type","path":["name"],"message":"Invalidinput:expectedstring,receivedundefined"},{"expected":"number","code":"invalid_type","path":["port"],"message":"Invalidinput:expectednumber,receivedundefined"}]"#
            );
            assert_eq!(
                parse(&json!({"name": "a", "port": 70000}), true).err().unwrap(),
                "[\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 65535,\n    \"inclusive\": true,\n    \"path\": [\n      \"port\"\n    ],\n    \"message\": \"Too big: expected number to be <=65535\"\n  }\n]"
            );
            assert_eq!(
                text(json!({"kind": "x", "name": " ", "port": 1.5, "insecure": "a", "prefixMode": "z"}), true),
                r#"[{"code":"invalid_value","values":["port"],"path":["kind"],"message":"Invalidinput:expected\"port\""},{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["name"],"message":"Toosmall:expectedstringtohave>=1characters"},{"expected":"int","format":"safeint","code":"invalid_type","path":["port"],"message":"Invalidinput:expectedint,receivednumber"},{"expected":"boolean","code":"invalid_type","path":["insecure"],"message":"Invalidinput:expectedboolean,receivedstring"},{"code":"invalid_value","values":["strip","preserve"],"path":["prefixMode"],"message":"Invalidoption:expectedoneof\"strip\"|\"preserve\""}]"#
            );
            assert_eq!(
                text(json!({"name": [], "port": []}), true),
                r#"[{"expected":"string","code":"invalid_type","path":["name"],"message":"Invalidinput:expectedstring,receivedarray"},{"origin":"array","code":"too_small","minimum":1,"inclusive":true,"path":["name"],"message":"Toosmall:expectedarraytohave>=1items"},{"expected":"number","code":"invalid_type","path":["port"],"message":"Invalidinput:expectednumber,receivedarray"}]"#
            );
            assert_eq!(
                text(json!({"name": "a", "port": 1e20}), true),
                r#"[{"code":"too_big","maximum":9007199254740991,"note":"Integersmustbewithinthesafeintegerrange.","origin":"int","inclusive":true,"path":["port"],"message":"Toobig:expectedinttobe<=9007199254740991"},{"origin":"number","code":"too_big","maximum":65535,"inclusive":true,"path":["port"],"message":"Toobig:expectednumbertobe<=65535"}]"#
            );
            assert_eq!(
                text(json!(null), true),
                r#"[{"expected":"object","code":"invalid_type","path":[],"message":"Invalidinput:expectedobject,receivednull"}]"#
            );
            // An empty update still applies the defaults.
            let empty = parse(&json!({"foo": 1}), false).ok().unwrap();
            assert!(empty.name.is_none() && !empty.insecure && empty.prefix_mode == "strip");
            assert_eq!(parse(&json!({"name": "\u{a0}x\u{2028}", "port": 5}), true).ok().unwrap().name.unwrap(), "x");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_records_and_paths_follow_the_manager() {
        assert_eq!(slug("  My Docs -- Server! ").unwrap(), "my-docs-server");
        assert_eq!(slug("Été 2").unwrap(), "t-2");
        assert!(slug(" !! ").is_err());
        let server: Doc = serde_json::from_value(json!({"sidecars": [
            {"id": " a ", "kind": "port", "name": "A", "port": 3000.0, "prefixMode": "preserve", "insecure": true},
            {"id": "b", "kind": "port", "name": "B", "port": 0}, {"id": "c", "kind": "x", "name": "C", "port": 1},
            {"id": "d", "kind": "port", "name": " ", "port": 1}, "x",
            {"id": "a", "kind": "port", "name": "A2", "port": 3001, "createdAt": "t"}]}))
        .unwrap();
        let records = load(&server);
        assert_eq!(records.len(), 1);
        assert_eq!((records[0].name.as_str(), records[0].port, records[0].prefix_mode), ("A2", 3001, "strip"));
        assert_eq!((records[0].created_at.as_str(), records[0].updated_at.as_str()), ("t", "t"));
        let mut record = records[0].clone();
        record.id = "a b".into();
        assert_eq!(target_path(&record, "/sidecars/a%20b/x/y", "?q"), "/x/y?q");
        assert_eq!(target_path(&record, "/sidecars/a%20b", ""), "/");
        record.prefix_mode = "preserve";
        assert_eq!(target_path(&record, "/sidecars/a%20b/x", "?q"), "/sidecars/a%20b/x?q");
        assert_eq!(base("a'(b)*~!é/"), "/sidecars/a'(b)*~!%C3%A9%2F");
    }
}
