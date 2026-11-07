//! Closed semantic operation schema; fixed programs come from the shared registry.
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;
const GROUP: &str = "codenomad-automation";
const INVALID: &str = "Unsupported or invalid browser page operation parameters";
fn registry() -> &'static Value {
    static REGISTRY: OnceLock<Value> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../server/src/automation/page/functions.generated.json"
        ))
        .expect("generated fixed function registry")
    })
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Operation {
    Tree,
    Viewport,
    ReleaseHandles,
    Checkpoint,
    Resolve {
        node: u64,
    },
    ScrollIntoView {
        node: u64,
    },
    Geometry {
        node: u64,
    },
    HitTest {
        x: f64,
        y: f64,
    },
    Call {
        function: String,
        handle: Option<String>,
        args: Vec<Value>,
    },
    Pointer {
        event: Value,
    },
    Wheel {
        event: Value,
    },
    Keyboard {
        event: Value,
    },
    InsertText {
        text: String,
    },
}
fn keys(value: &Value, allowed: &[&str], required: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or(INVALID)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(INVALID.into());
    }
    Ok(())
}
fn number(value: &Value, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|value| value.is_finite() && value.abs() <= max)
}
fn integer(value: &Value, max: u64) -> bool {
    value.as_u64().is_some_and(|value| value <= max)
}
fn handle(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| !value.is_empty() && value.len() <= 512)
}
pub(super) fn envelope(method: &str, value: &Value) -> Result<(), String> {
    let mut allowed = vec!["sessionID", "operationID"];
    let mut required = allowed.clone();
    if method == "browser.page.send" {
        allowed.extend(["generation", "operation"]);
        required.extend(["generation", "operation"]);
    } else if method == "browser.page.check" {
        allowed.push("generation");
        required.push("generation");
    } else if method == "browser.page.end" {
        allowed.push("generation");
    }
    keys(value, &allowed, &required)?;
    if value.get("generation").is_some_and(|value| !handle(value)) {
        return Err(INVALID.into());
    }
    Ok(())
}

pub(super) fn parse(value: Value) -> Result<Operation, String> {
    if value.to_string().len() > 256 * 1024 {
        return Err(INVALID.into());
    }
    let operation: Operation =
        serde_json::from_value(value.clone()).map_err(|_| INVALID.to_string())?;
    match &operation {
        Operation::Tree
        | Operation::Viewport
        | Operation::ReleaseHandles
        | Operation::Checkpoint => keys(&value, &["op"], &["op"])?,
        Operation::Resolve { node }
        | Operation::Geometry { node }
        | Operation::ScrollIntoView { node }
            if *node == 0 || *node > 9_007_199_254_740_991 =>
        {
            return Err(INVALID.into())
        }
        Operation::HitTest { x, y }
            if !x.is_finite()
                || !y.is_finite()
                || x.abs() > 10_000_000.0
                || y.abs() > 10_000_000.0
                || x.fract() != 0.0
                || y.fract() != 0.0 =>
        {
            return Err(INVALID.into())
        }
        Operation::Call {
            function,
            handle: target,
            args,
        } => {
            let definition = registry().get(function).ok_or(INVALID)?;
            if definition["scope"] == "element" {
                if !target.as_ref().is_some_and(|id| handle(&json!(id))) {
                    return Err(INVALID.into());
                }
            } else if value.get("handle").is_some() {
                return Err(INVALID.into());
            }
            let rules = definition["args"].as_array().ok_or(INVALID)?;
            if rules.len() != args.len() {
                return Err(INVALID.into());
            }
            for (rule, argument) in rules.iter().zip(args) {
                let valid = match rule.as_str() {
                    Some("string") => argument.is_string(),
                    Some("boolean") => argument.is_boolean(),
                    Some("strings") => argument
                        .as_array()
                        .is_some_and(|items| items.iter().all(Value::is_string)),
                    Some("handle") => {
                        keys(argument, &["handle"], &["handle"]).is_ok()
                            && handle(&argument["handle"])
                    }
                    _ => false,
                };
                if !valid {
                    return Err(INVALID.into());
                }
            }
        }
        Operation::Pointer { event }
        | Operation::Wheel { event }
        | Operation::Keyboard { event } => {
            let keyboard = matches!(&operation, Operation::Keyboard { .. });
            let wheel = matches!(&operation, Operation::Wheel { .. });
            if keyboard {
                keys(
                    event,
                    &[
                        "type",
                        "key",
                        "code",
                        "windowsVirtualKeyCode",
                        "modifiers",
                        "text",
                        "unmodifiedText",
                        "location",
                        "timestamp",
                        "buttons",
                    ],
                    &["type"],
                )?;
                if !matches!(
                    event["type"].as_str(),
                    Some("keyDown" | "rawKeyDown" | "keyUp")
                ) {
                    return Err(INVALID.into());
                }
                for key in ["key", "code", "text", "unmodifiedText"] {
                    if let Some(value) = event.get(key) {
                        if !value
                            .as_str()
                            .is_some_and(|text| !text.is_empty() && text.len() <= 256)
                        {
                            return Err(INVALID.into());
                        }
                    }
                }
            } else {
                let allowed = if wheel {
                    vec![
                        "type",
                        "x",
                        "y",
                        "deltaX",
                        "deltaY",
                        "modifiers",
                        "timestamp",
                    ]
                } else {
                    vec![
                        "type",
                        "x",
                        "y",
                        "button",
                        "buttons",
                        "clickCount",
                        "modifiers",
                        "timestamp",
                    ]
                };
                keys(
                    event,
                    &allowed,
                    if wheel {
                        &["type", "x", "y", "deltaX", "deltaY"]
                    } else {
                        &["type", "x", "y"]
                    },
                )?;
                if !number(&event["x"], 10_000_000.0) || !number(&event["y"], 10_000_000.0) {
                    return Err(INVALID.into());
                }
                if wheel {
                    if event["type"] != "mouseWheel"
                        || !number(&event["deltaX"], 10_000_000.0)
                        || !number(&event["deltaY"], 10_000_000.0)
                    {
                        return Err(INVALID.into());
                    }
                } else {
                    if !matches!(
                        event["type"].as_str(),
                        Some("mouseMoved" | "mousePressed" | "mouseReleased")
                    ) {
                        return Err(INVALID.into());
                    }
                    if let Some(button) = event.get("button") {
                        if !matches!(button.as_str(), Some("left" | "right" | "middle" | "none")) {
                            return Err(INVALID.into());
                        }
                    }
                }
            }
            for (key, max) in [
                ("modifiers", 15),
                ("buttons", 7),
                ("clickCount", 3),
                ("windowsVirtualKeyCode", 65535),
                ("location", 3),
            ] {
                if let Some(value) = event.get(key) {
                    if !integer(value, max) {
                        return Err(INVALID.into());
                    }
                }
            }
            if let Some(value) = event.get("timestamp") {
                if !number(value, 9_007_199_254_740_991.0) {
                    return Err(INVALID.into());
                }
            }
        }
        _ => {}
    }
    Ok(operation)
}

impl Operation {
    pub(super) fn webkit_result(&self) -> Value {
        if matches!(self, Self::Checkpoint | Self::ReleaseHandles) {
            json!({})
        } else {
            json!({"error":{"code":"unsupported","driver":"webkit","operation":self.name()}})
        }
    }
    pub(super) fn name(&self) -> &'static str {
        match self {
            Self::Tree => "tree",
            Self::Viewport => "viewport",
            Self::ReleaseHandles => "release-handles",
            Self::Checkpoint => "checkpoint",
            Self::Resolve { .. } => "resolve",
            Self::ScrollIntoView { .. } => "scroll-into-view",
            Self::Geometry { .. } => "geometry",
            Self::HitTest { .. } => "hit-test",
            Self::Call { .. } => "call",
            Self::Pointer { .. } => "pointer",
            Self::Wheel { .. } => "wheel",
            Self::Keyboard { .. } => "keyboard",
            Self::InsertText { .. } => "insert-text",
        }
    }
    pub(super) fn cdp(&self) -> Option<(&'static str, Value)> {
        Some(match self {
            Self::Tree => ("Accessibility.getFullAXTree", json!({})),
            Self::Resolve { node } => (
                "DOM.resolveNode",
                json!({"backendNodeId":node,"objectGroup":GROUP}),
            ),
            Self::ScrollIntoView { node } => {
                ("DOM.scrollIntoViewIfNeeded", json!({"backendNodeId":node}))
            }
            Self::Geometry { node } => ("DOM.getContentQuads", json!({"backendNodeId":node})),
            Self::Viewport => ("Page.getLayoutMetrics", json!({})),
            Self::HitTest { x, y } => (
                "DOM.getNodeForLocation",
                json!({"x":*x as i64,"y":*y as i64,"includeUserAgentShadowDOM":false,"ignorePointerEventsNone":false}),
            ),
            Self::Call {
                function,
                handle,
                args,
            } => {
                let definition = &registry()[function];
                if definition["scope"] == "element" {
                    (
                        "Runtime.callFunctionOn",
                        json!({"objectId":handle,"functionDeclaration":definition["source"],"arguments":args.iter().map(|arg| if arg.get("handle").is_some() { json!({"objectId":arg["handle"]}) } else { json!({"value":arg}) }).collect::<Vec<_>>(),"returnByValue":definition["handle"] != true,"objectGroup":GROUP}),
                    )
                } else if definition["handle"] == true {
                    (
                        "Runtime.evaluate",
                        json!({"expression":definition["source"],"objectGroup":GROUP}),
                    )
                } else {
                    (
                        "Runtime.evaluate",
                        json!({"expression":definition["source"],"returnByValue":true}),
                    )
                }
            }
            Self::Pointer { event } | Self::Wheel { event } => {
                ("Input.dispatchMouseEvent", event.clone())
            }
            Self::Keyboard { event } => ("Input.dispatchKeyEvent", event.clone()),
            Self::InsertText { text } => ("Input.insertText", json!({"text":text})),
            Self::ReleaseHandles => ("Runtime.releaseObjectGroup", json!({"objectGroup":GROUP})),
            Self::Checkpoint => return None,
        })
    }
    pub(super) fn result(&self, raw: Value) -> Value {
        match self {
            Self::Tree => {
                json!({"nodes":raw["nodes"].as_array().map(|nodes| nodes.iter().map(semantic_node).collect::<Vec<_>>()).unwrap_or_default()})
            }
            Self::Resolve { .. } => optional("handle", raw["object"].get("objectId")),
            Self::Call { function, .. } => {
                if let Some(error) = raw.get("exceptionDetails") {
                    return json!({"exception":error["exception"]["description"].as_str().or_else(||error["text"].as_str()).unwrap_or("")});
                }
                if registry()[function]["handle"] == true {
                    optional("handle", raw["result"].get("objectId"))
                } else {
                    optional("value", raw["result"].get("value"))
                }
            }
            Self::Viewport => {
                let viewport = raw
                    .get("cssLayoutViewport")
                    .filter(|value| !value.is_null())
                    .unwrap_or(&raw["layoutViewport"]);
                let mut result = optional("width", viewport.get("clientWidth"));
                if let Some(height) = viewport.get("clientHeight") {
                    result["height"] = height.clone();
                }
                result
            }
            Self::HitTest { .. } => optional("node", raw.get("backendNodeId")),
            _ => raw,
        }
    }
}
fn optional(key: &str, value: Option<&Value>) -> Value {
    let mut result = Map::new();
    if let Some(value) = value {
        result.insert(key.into(), value.clone());
    }
    Value::Object(result)
}
fn semantic_node(raw: &Value) -> Value {
    let mut result = Map::new();
    for (key, source) in [
        ("id", "nodeId"),
        ("parent", "parentId"),
        ("children", "childIds"),
        ("ignored", "ignored"),
        ("node", "backendDOMNodeId"),
    ] {
        if let Some(value) = raw.get(source) {
            result.insert(key.into(), value.clone());
        }
    }
    for key in ["role", "name", "description", "value"] {
        if let Some(value) = raw[key].get("value") {
            result.insert(key.into(), value.clone());
        }
    }
    if let Some(properties) = raw["properties"].as_array() {
        result.insert(
            "properties".into(),
            Value::Array(
                properties
                    .iter()
                    .map(|property| {
                        let mut result = optional("name", property.get("name"));
                        if let Some(value) = property["value"].get("value") {
                            result["value"] = value.clone();
                        }
                        result
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_operations_refuse_scripts_unknown_fields_and_bad_args() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../server/src/automation/page/contract.cases.json"
        ))
        .unwrap();
        for value in cases["valid"].as_array().unwrap() {
            assert!(
                parse(value.clone()).is_ok(),
                "valid operation rejected: {value}"
            );
            let operation = parse(value.clone()).unwrap();
            if !matches!(operation, Operation::Checkpoint | Operation::ReleaseHandles) {
                assert_eq!(operation.webkit_result()["error"]["code"], "unsupported");
                assert_eq!(
                    operation.webkit_result()["error"]["operation"],
                    operation.name()
                );
            }
        }
        for value in cases["invalid"].as_array().unwrap() {
            assert!(
                parse(value.clone()).is_err(),
                "invalid operation accepted: {value}"
            );
        }
        for bad in [
            json!({"op":"Runtime.evaluate","expression":"alert(1)"}),
            json!({"op":"tree","extra":true}),
            json!({"op":"call","function":"mark-input","args":[]}),
            json!({"op":"call","function":"select","handle":"h","args":["wrong"]}),
            json!({"op":"pointer","event":{"type":"mouseMoved","x":0,"y":0,"arbitrary":true}}),
        ] {
            assert!(parse(bad).is_err());
        }
        let call = parse(
            json!({"op":"call","function":"set-value","handle":"h","args":["\";evil()",false]}),
        )
        .unwrap();
        let (_, params) = call.cdp().unwrap();
        assert_eq!(params["arguments"][0]["value"], "\";evil()");
        assert!(!params["functionDeclaration"]
            .as_str()
            .unwrap()
            .contains("evil()"));
        assert!(parse(json!({"op":"checkpoint"})).unwrap().cdp().is_none());
    }
}
