//! Exact document, active tab and live destination checks before trusted WebView2 input.
use super::input::{Refusal, Target};
use serde_json::{json, Value};
use std::cell::{Cell, OnceCell};
use std::sync::OnceLock;

const GROUP: &str = "codenomad-automation";
const CHANGED: &str = "Page changed during action; inspect again";
pub(super) type Cdp<'a> = dyn Fn(&str, Value) -> Result<Value, String> + 'a;

pub(super) fn program(key: &str) -> &'static Value {
    static PROGRAMS: OnceLock<Value> = OnceLock::new();
    &PROGRAMS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../server/src/automation/page/developer.generated.json"
        ))
        .expect("generated trusted window programs")
    })[key]
}

pub(super) struct Input<'a> {
    cdp: &'a Cdp<'a>,
    action: &'a str,
    context: &'a Value,
    root: OnceCell<String>,
    sequence: Cell<u32>,
    receipt: Cell<Option<(u32, f64, f64)>>,
}

impl<'a> Input<'a> {
    pub(super) fn new(cdp: &'a Cdp<'a>, action: &'a str, context: &'a Value) -> Self {
        Self {
            cdp,
            action,
            context,
            root: OnceCell::new(),
            sequence: Cell::new(0),
            receipt: Cell::new(None),
        }
    }

    fn root(&self) -> Result<&str, String> {
        if let Some(root) = self.root.get() {
            return Ok(root);
        }
        let result = (self.cdp)(
            "Runtime.evaluate",
            json!({
                "expression": program("inputState"), "objectGroup": GROUP,
            }),
        )?;
        let root = result["result"]["objectId"].as_str().ok_or(CHANGED)?;
        Ok(self.root.get_or_init(|| root.to_owned()))
    }

    pub(super) fn send(
        &self,
        function: Option<&str>,
        method: &str,
        mut params: Value,
    ) -> Result<Value, String> {
        if method == "Runtime.evaluate" {
            let key = match function {
                Some("mark-input") => Some("markInput"),
                Some("unmark-input") => Some("unmarkInput"),
                _ => None,
            };
            if let Some(key) = key {
                let result = (self.cdp)(
                    "Runtime.callFunctionOn",
                    json!({
                        "objectId": self.root()?, "functionDeclaration": program(key), "returnByValue": true,
                    }),
                )?;
                let value = &result["result"]["value"];
                if result.get("exceptionDetails").is_some()
                    || (key == "markInput"
                        && !value.as_f64().is_some_and(|n| n.is_finite() && n > 0.0))
                    || (key == "unmarkInput" && value != true)
                {
                    return Err(CHANGED.into());
                }
                return Ok(result);
            }
        }
        if method == "Runtime.callFunctionOn" {
            if let Some(code) = params["functionDeclaration"]
                .as_str()
                .and_then(|source| program("guardedCalls").get(source))
            {
                let mut args = vec![
                    json!({"objectId": params["objectId"]}),
                    json!({"value": self.context}),
                ];
                args.extend(
                    params["arguments"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
                params["arguments"] = json!(args);
                params["functionDeclaration"] = code.clone();
                params["objectId"] = json!(self.root()?);
            }
        }
        let result = (self.cdp)(method, params)?;
        if method == "DOM.resolveNode" && matches!(self.action, "press" | "type") {
            if let Some(object) = result["object"]["objectId"].as_str() {
                let owner = (self.cdp)(
                    "Runtime.callFunctionOn",
                    json!({
                        "objectId": object, "returnByValue": true,
                        "functionDeclaration": "function () { return this.ownerDocument?.defaultView === window.top }",
                    }),
                )?;
                if owner["result"]["value"] != true {
                    return Err(
                        "cdp page driver does not support keyboard input into a subframe".into(),
                    );
                }
            }
        }
        Ok(result)
    }

    pub(super) fn destination(
        &self,
        kind: &str,
        params: &mut Value,
        target: Option<Target<'_>>,
    ) -> Result<(), Refusal> {
        let mouse = matches!(kind, "pointer" | "wheel");
        let refused = |message: String| Refusal {
            message,
            same_document: true,
            timeout: false,
        };
        let changed = || Refusal {
            message: CHANGED.into(),
            same_document: false,
            timeout: false,
        };
        let transport = |error: String| {
            if error.contains("timed out") {
                Refusal {
                    message: "The input destination check timed out; inspect again".into(),
                    same_document: true,
                    timeout: true,
                }
            } else {
                changed()
            }
        };
        let point = if mouse {
            let xy = |key: &str| {
                params[key]
                    .as_f64()
                    .filter(|x| x.is_finite())
                    .map(f64::floor)
            };
            Some(xy("x").zip(xy("y")).ok_or_else(changed)?)
        } else {
            None
        };
        let release = matches!(params["type"].as_str(), Some("mouseReleased" | "keyUp"));
        let press = params["type"] == "mousePressed";
        let confirm = point.filter(|_| release).and_then(|(x, y)| {
            self.receipt
                .get()
                .filter(|&(_, px, py)| x == px && y == py)
                .map(|(id, _, _)| id)
        });
        if mouse && release && confirm.is_none() {
            return Err(refused(
                "Cannot confirm the original pointer recipient; inspect again".into(),
            ));
        }
        let track = (!release && mouse && target.is_some_and(|t| press || t.drag_source.is_some()))
            .then(|| {
                let id = self.sequence.get() + 1;
                self.sequence.set(id);
                id
            });
        let root = self.root.get().ok_or_else(changed)?;
        let by_handle = |handle: Option<&str>| match handle {
            Some(id) => json!({"objectId": id}),
            None => json!({"value": null}),
        };
        let read = |confirmed: Option<&str>| {
            (self.cdp)(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": root, "objectGroup": GROUP,
                    "functionDeclaration": program(if self.action == "scroll" { "wheelDestination" } else { "destination" }),
                    "arguments": [
                        {"value": point.map(|(x, y)| json!({"x": x, "y": y}))}, {"value": self.context},
                        {"value": release}, by_handle(target.map(|t| t.handle)), {"value": kind == "insert-text"},
                        by_handle(target.and_then(|t| t.drag_source)), {"value": track}, {"value": confirm},
                        by_handle(confirmed), {"value": self.action == "drag" && press},
                    ]
                }),
            )
        };
        let mut hit = read(None).map_err(transport)?;
        if let Some(object) = hit["result"]["objectId"].as_str() {
            let node = (self.cdp)(
                "DOM.describeNode",
                json!({"objectId": object, "depth": 0, "pierce": true}),
            )
            .map_err(transport)?;
            if node["node"].is_object()
                && node["node"]["shadowRoots"]
                    .as_array()
                    .is_none_or(Vec::is_empty)
            {
                hit = read(Some(object)).map_err(transport)?;
            }
        }
        let reference = target.map_or("the target", |t| t.reference);
        match hit["result"]["value"].as_str() {
            Some("ready") if hit.get("exceptionDetails").is_none() => {
                if let Some((x, y)) = point {
                    self.receipt.set(track.map(|id| (id, x, y)));
                    params["x"] = json!(x);
                    params["y"] = json!(y);
                }
                Ok(())
            }
            Some("root") => Err(changed()),
            status => Err(refused(match status {
                Some("tab") => "The active tab changed during the action; inspect again".into(),
                Some("element") => format!("{reference} is no longer in the page; inspect again"),
                Some("focus") => format!("Keyboard focus changed before input to {reference}; inspect again"),
                Some("receiver") => "The original pointer recipient changed; inspect again".into(),
                Some(status) if status.starts_with("cover:") =>
                    format!("{reference} is covered by {}; close or move it first, then inspect again", &status[6..]),
                _ if mouse => "Cannot confirm the pointer is in the main document; inspect again".into(),
                _ => "Keyboard focus is outside the main document or unavailable; focus the main document and inspect again".into(),
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_closed_shadow_targets_and_requires_the_original_pointer_receipt() {
        let result = Cell::new("shadow");
        let calls = Cell::new(0);
        let cdp = |method: &str, params: Value| {
            calls.set(calls.get() + 1);
            Ok(match method {
                "Runtime.evaluate" => json!({"result":{"objectId":"root"}}),
                "DOM.describeNode" => json!({"node":{"shadowRoots":[{"shadowRootType":"closed"}]}}),
                "Runtime.callFunctionOn" if result.get() == "shadow" => {
                    json!({"result":{"objectId":"host"}})
                }
                "Runtime.callFunctionOn" => {
                    assert_eq!(params["arguments"][0]["value"], json!({"x":1.0, "y":2.0}));
                    assert_eq!(params["arguments"][3]["objectId"], "ref-handle");
                    assert_eq!(
                        params["arguments"][7]["value"],
                        if result.get() == "receiver" {
                            json!(2)
                        } else {
                            Value::Null
                        }
                    );
                    json!({"result":{"value":result.get()}})
                }
                _ => panic!("{method}"),
            })
        };
        let context = json!({"tabId":"old-tab"});
        let input = Input::new(&cdp, "click", &context);
        input.root().unwrap();
        let target = Some(Target::new("e1", "ref-handle"));
        let mut press = json!({"type":"mousePressed", "x":1.5, "y":2.5});
        let mut release = json!({"type":"mouseReleased", "x":1.0, "y":2.0});
        assert!(input
            .destination("pointer", &mut press, target)
            .unwrap_err()
            .message
            .contains("main document"));
        let after_refusal = calls.get();
        assert!(input
            .destination("pointer", &mut release, target)
            .unwrap_err()
            .message
            .contains("original pointer recipient"));
        assert_eq!(
            calls.get(),
            after_refusal,
            "no release can follow a refused press"
        );
        result.set("ready");
        input.destination("pointer", &mut press, target).unwrap();
        assert_eq!(
            (press["x"].as_f64(), press["y"].as_f64()),
            (Some(1.0), Some(2.0))
        );
        result.set("receiver");
        assert!(input
            .destination("pointer", &mut release, target)
            .unwrap_err()
            .message
            .contains("recipient changed"));
    }
}
