//! The exact-window bridge. The host drives the page; only the bridge issues inspection receipts.
mod pins;
pub(super) mod restart;

use std::time::Duration;

use axum::{
    Json,
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{NATIVE, actions, diagnostics, native_parent, refuse, result};
pub use pins::Pins;

const TARGETS: usize = 16;
const PROBE: Duration = Duration::from_secs(2);
const TARGET_GONE: &str = "The selected window is unavailable; choose a window in inspect({targets:true})";
const STALE_DOCUMENT: &str = "The selected window document changed; inspect again";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    native_identity: String,
    run_id: String,
    #[serde(flatten)]
    window: Window,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    window_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_instance: Option<String>,
}

#[derive(Clone, Debug)]
struct Pin {
    target: Target,
    document: Option<String>,
}

impl Target {
    fn parse(value: &Value) -> Option<Self> {
        let parts = value.as_str()?.split('/').collect::<Vec<_>>();
        if !(3..=4).contains(&parts.len())
            || parts.iter().any(|s| {
                !(1..=128).contains(&s.len()) || !s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
            })
        {
            return None;
        }
        Some(Self {
            native_identity: parts[0].into(),
            run_id: parts[1].into(),
            window: Window { window_id: parts[2].into(), window_instance: parts.get(3).map(|s| (*s).into()) },
        })
    }

    fn ready(native: &Value) -> Option<Self> {
        let status = &native["status"];
        if status["state"] != "ready" {
            return None;
        }
        serde_json::from_value(status.clone()).ok()
    }

    fn native_params(&self) -> Value {
        let mut params = json!(self.window);
        params["runId"] = json!(self.run_id);
        params
    }

    async fn still_available(&self) -> bool {
        self.window.window_instance.is_none()
            || native_parent::request("developer.status", self.native_params(), PROBE)
                .await
                .ok()
                .and_then(|native| Self::ready(&native))
                .as_ref()
                == Some(self)
    }

    async fn execute(
        &self,
        session: &str,
        document: Option<&str>,
        command: Value,
        deadline: Duration,
    ) -> Result<Value, Failure> {
        let mut params = self.native_params();
        params["sessionID"] = json!(session);
        params["command"] = command;
        if let Some(document) = document {
            params["document"] = json!(document);
        }
        let done = native_parent::request("developer.execute", params, deadline).await.map_err(Failure::Action)?;
        match done["error"].as_str() {
            Some(error) if done["stage"] == "target" => Err(Failure::Target(error.into())),
            Some(error) if done["stage"] == "document" => Err(Failure::Document(error.into())),
            Some(error) => Err(Failure::Action(error.into())),
            None => Ok(done),
        }
    }

    async fn context(&self, session: &str) -> Result<Value, Failure> {
        let result = self.execute(session, None, json!({ "action": "context" }), PROBE).await?;
        if !self.window.matches(&result["context"]) {
            return Err(Failure::Target("CodeNomad window or active session changed; inspect again".into()));
        }
        Ok(result)
    }
}

impl Window {
    fn matches(&self, context: &Value) -> bool {
        context["windowId"].as_str() == Some(&self.window_id)
            && match context.get("windowInstance") {
                None => self.window_instance.is_none(),
                Some(value) => value.as_str().is_some_and(|instance| Some(instance) == self.window_instance.as_deref()),
            }
    }
}

#[track_caller]
fn coded(status: Status, code: &str, error: &str) -> Response {
    if status.is_server_error() {
        diagnostics::error(status.as_u16(), error, std::panic::Location::caller());
    }
    (status, Json(json!({ "code": code, "error": error }))).into_response()
}

pub(super) fn stale_inspection() -> Response {
    coded(Status::CONFLICT, "stale-inspection", "A newer inspection selected the window")
}

fn unavailable(exact: bool, error: Option<&str>) -> Response {
    if exact {
        coded(Status::NOT_FOUND, "target-gone", TARGET_GONE)
    } else {
        coded(Status::NOT_FOUND, "no-window", error.unwrap_or("No ready local CodeNomad window for this backend"))
    }
}

enum Failure {
    Target(String),
    Document(String),
    Action(String),
}

impl Failure {
    fn response(self, exact: bool) -> Response {
        match self {
            Self::Target(_) if exact => unavailable(true, None),
            Self::Document(message) => coded(Status::CONFLICT, "stale-document", &message),
            Self::Action(message) | Self::Target(message) => refuse(Status::CONFLICT, &message),
        }
    }
}

pub(super) fn selects_window(command: &Value) -> bool {
    command["action"] == "inspect" && command.get("ref").is_none_or(|r| *r == "")
}

pub(super) async fn handle(pins: &Pins, session: &str, mode: &str, body: &Value, inspection: Option<u64>) -> Response {
    let probe = mode == "developer-probe";
    let inventory = probe && body["purpose"] == "targets";
    let command = if probe {
        Value::Null
    } else {
        match actions::developer(&body["command"]) {
            Ok(command) => command,
            Err(error) => return refuse(Status::BAD_REQUEST, &error),
        }
    };
    let fresh = selects_window(&command);
    let explicit = match body.get("target") {
        Some(_) if !(fresh || probe && body["purpose"] == "target") => {
            return refuse(Status::BAD_REQUEST, "Select another window in a fresh inspection");
        }
        Some(target) => match Target::parse(target) {
            Some(target) => Some(target),
            None => return refuse(Status::BAD_REQUEST, "Use a window identifier returned by inspect({targets:true})"),
        },
        None => None,
    };
    let pin = (!probe).then(|| pins.get(session, &body["pin"])).flatten();
    if !probe && pin.is_none() {
        if body.get("pin").is_some() {
            return coded(
                Status::NOT_FOUND,
                "target-gone",
                "The inspection is unavailable; choose a window in inspect({targets:true})",
            );
        }
        if !fresh {
            return coded(Status::NOT_FOUND, "inspect-required", "Run codenomad.inspect before acting on this window");
        }
    }
    let exact = explicit.as_ref().or_else(|| pin.as_ref().map(|pin| &pin.target));
    let is_exact = exact.is_some();
    let method = if inventory { "developer.targets" } else { "developer.status" };
    let native =
        match native_parent::request(method, exact.map_or_else(|| json!({}), Target::native_params), PROBE).await {
            Ok(native) => native,
            Err(error) => return unavailable(is_exact, Some(&error)),
        };
    let Some(target) = Target::ready(&native).filter(|target| exact.is_none_or(|exact| target == exact)) else {
        return unavailable(is_exact, None);
    };
    let run = &target.run_id;
    if probe {
        let mut selected = json!({ "available": true, "nativeIdentity": target.native_identity, "runId": run });
        if inventory {
            selected["windows"] = json!(inventory_windows(&native, &target, session).await);
        } else {
            if explicit.is_none() && (pins.access(run, false).is_none() || target.context(session).await.is_err()) {
                return unavailable(false, None);
            }
            if let Some(instance) = &target.window.window_instance {
                selected["windowInstance"] = json!(instance);
            }
            selected["windowId"] = json!(target.window.window_id);
        }
        return result(selected);
    }

    let Some(access) = pins.access(run, explicit.is_some() && fresh) else {
        return refuse(Status::CONFLICT, "Developer CDP run is closed; inspect again");
    };
    let document = (!fresh).then(|| pin.as_ref().and_then(|pin| pin.document.as_deref())).flatten();
    let action = command["action"].as_str().unwrap_or_default();
    let capture = action == "inspect" || action == "screenshot";
    let inspecting = action == "inspect";
    let mut done = match target.execute(session, document, command, NATIVE).await {
        Ok(done) => done,
        Err(error) => return error.response(is_exact),
    };
    if capture && !target.still_available().await {
        return unavailable(is_exact, None);
    }
    if inspecting {
        let captured = match inspection_document(&target, &mut done, document) {
            Ok(captured) => captured,
            Err(error) => return error.response(is_exact),
        };
        if let Some(ticket) = inspection {
            let Some(pin) = pins.publish(session, ticket, access, Pin { target, document: captured }) else {
                return stale_inspection();
            };
            done["pin"] = json!(pin);
        }
        diagnostics::extend(&mut done, &native["logs"]);
    }
    result(done)
}

fn inspection_document(target: &Target, done: &mut Value, document: Option<&str>) -> Result<Option<String>, Failure> {
    if !target.window.matches(&done["context"]) {
        return Err(Failure::Target(TARGET_GONE.into()));
    }
    if !done["snapshot"].is_string() || !done["diagnostics"].is_array() {
        return Err(Failure::Action("CodeNomad returned an invalid inspection".into()));
    }
    let snapshot = done.as_object_mut().unwrap(); // Validated above.
    let captured =
        snapshot.remove("document").and_then(|value| value.as_str().filter(|s| !s.is_empty()).map(str::to_owned));
    if document.is_some() && document != captured.as_deref() {
        return Err(Failure::Document(STALE_DOCUMENT.into()));
    }
    if target.window.window_instance.is_some() && captured.is_none() {
        return Err(Failure::Action("CodeNomad page has no valid document context".into()));
    }
    if let Some(context) = snapshot.get_mut("context").and_then(Value::as_object_mut) {
        context.remove("sessionOpen");
    }
    Ok(captured)
}

async fn inventory_windows(native: &Value, target: &Target, session: &str) -> Vec<Value> {
    let windows: Vec<_> = native["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .take(TARGETS)
        .filter_map(|row| {
            let window: Window = serde_json::from_value(row.clone()).ok()?;
            Some((Target { window, ..target.clone() }, row["focused"] == true))
        })
        .collect();
    stream::iter(windows)
        .map(|(target, focused)| async move {
            let read = target.context(session).await.ok();
            inventory_row(&target.window, focused, session, read.as_ref().map(|done| &done["context"]))
        })
        .buffered(TARGETS)
        .collect()
        .await
}

fn inventory_row(window: &Window, focused: bool, session: &str, context: Option<&Value>) -> Value {
    let mut row = json!(window);
    row["focused"] = json!(focused);
    row["session"] = json!(match context {
        Some(c) if c["sessionId"] == session && c["instanceId"].as_str().is_none_or(|id| !id.contains('~')) => {
            if let Some(tab) = c["tabId"].as_str().filter(|tab| !tab.is_empty()) {
                row["tabId"] = json!(tab);
            }
            "visible"
        }
        Some(c) if c["sessionOpen"] == true => "open",
        Some(_) => "elsewhere",
        None => "unknown",
    });
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_target_includes_native_run_and_window_incarnation() {
        let target = Target::parse(&json!("tauri:test/run-1/window_1/incarnation.1")).unwrap();
        let mut status = json!({
            "state": "ready", "nativeIdentity": "tauri:test", "runId": "run-1",
            "windowId": "window_1", "windowInstance": "incarnation.1",
        });
        assert_eq!(
            target.native_params(),
            json!({"runId": "run-1", "windowId": "window_1", "windowInstance": "incarnation.1"})
        );
        assert_eq!(Target::ready(&json!({"status": status})).as_ref(), Some(&target));
        assert!(target.window.matches(&status));
        for (key, different) in [
            ("nativeIdentity", "tauri:other"),
            ("runId", "run-2"),
            ("windowId", "window_2"),
            ("windowInstance", "replacement"),
        ] {
            let saved = std::mem::replace(&mut status[key], json!(different));
            assert_ne!(Target::ready(&json!({"status": status})).as_ref(), Some(&target));
            status[key] = saved;
        }
        assert!(!target.window.matches(&json!({"windowId": "window_1"})));
        for input in ["tauri/run/window/", "/run/window", "tauri/run/w%2Fa", "tauri/run/w/ü", "tauri/run/w/i/extra"] {
            assert!(Target::parse(&json!(input)).is_none(), "{input}");
        }
    }

    #[test]
    fn inventory_distinguishes_presence_of_the_invoking_session() {
        let window = Target::parse(&json!("tauri:test/r/w/i")).unwrap().window;
        let row = |context: Option<Value>| inventory_row(&window, true, "caller", context.as_ref());
        assert_eq!(
            row(Some(json!({"instanceId": "local", "sessionId": "caller", "tabId": "tab"}))),
            json!({"windowId":"w", "windowInstance":"i", "focused":true, "session":"visible", "tabId":"tab"})
        );
        assert_eq!(row(Some(json!({"instanceId": "host~remote", "sessionId": "caller"})))["session"], "elsewhere");
        assert_eq!(row(Some(json!({"sessionId": "other", "sessionOpen": true})))["session"], "open");
        assert_eq!(row(None)["session"], "unknown");
    }
}
