//! The CodeNomad window itself on Windows (`developer-cdp.ts` in process): `developer.execute`
//! inspects, acts on and captures the inspected local window through WebView2's own DevTools
//! session, with no remote debugging port.
use super::{
    input::{Guard, Refusal, Target},
    page,
    refs::RefTable,
    window_input::{program, Input},
};
use crate::browser_controller::page::operations;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager};

const DIAGNOSTICS: usize = 1_000;
const DIAGNOSTIC_TEXT: usize = 512;
const SCREENSHOT_BYTES: usize = 5 * 1024 * 1024;
const RESPONSE_BYTES: usize = 24 * 1024 * 1024;
const WINDOW_GONE: &str = "The selected window is no longer available";

/// DevTools events of one webview: console and exceptions for diagnostics, navigations that make
/// every earlier ref stale.
struct Watch {
    instance: String,
    epoch: AtomicU64,
    document: Mutex<Document>,
    diagnostics: Mutex<VecDeque<Value>>,
    operation: Mutex<WindowState>,
}

#[derive(Default)]
pub(crate) struct WindowAutomation {
    windows: Mutex<HashMap<String, Arc<Watch>>>,
}

struct WindowState {
    enabled: bool,
    refs: RefTable,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            enabled: false,
            refs: RefTable::new(
                "inspect again",
                format!("e{:020}", uuid::Uuid::new_v4().as_u128() as u64),
            ),
        }
    }
}

#[derive(Default)]
struct Document {
    frame: Option<String>,
    contexts: HashMap<String, u64>,
}

impl Document {
    fn changed(&mut self, event: &str, params: &Value) -> bool {
        match event {
            "Runtime.executionContextsCleared" => {
                self.contexts.clear();
                true
            }
            "Runtime.executionContextCreated" => {
                let ctx = &params["context"];
                let aux = &ctx["auxData"];
                let (Some(id), Some(frame)) = (ctx["id"].as_u64(), aux["frameId"].as_str()) else {
                    return false;
                };
                aux["isDefault"] == true
                    && self
                        .contexts
                        .insert(frame.into(), id)
                        .is_some_and(|old| old != id)
                    && self.frame.as_deref() == Some(frame)
            }
            "Runtime.executionContextDestroyed" => {
                let Some(id) = params["executionContextId"].as_u64() else {
                    return false;
                };
                let changed = self
                    .frame
                    .as_deref()
                    .is_some_and(|frame| self.contexts.get(frame) == Some(&id));
                self.contexts.retain(|_, context| *context != id);
                changed
            }
            "Page.frameDetached" | "Page.frameAttached" => {
                let Some(frame) = params["frameId"].as_str() else {
                    return false;
                };
                if event == "Page.frameDetached" {
                    self.contexts.remove(frame);
                }
                self.frame.as_deref() == Some(frame)
            }
            "Page.frameNavigated" | "Page.documentOpened"
                if params["frame"]["parentId"].is_null() =>
            {
                if let Some(id) = params["frame"]["id"].as_str() {
                    self.frame = Some(id.into());
                }
                true
            }
            _ => false,
        }
    }
}

/// `{ error, stage }`: `target` before the command reached the page, `action` during it.
fn failure(stage: &str, message: impl Into<String>) -> Value {
    json!({ "error": message.into(), "stage": stage })
}

fn bounded(text: String) -> String {
    if text.chars().count() > DIAGNOSTIC_TEXT {
        text.chars().take(DIAGNOSTIC_TEXT - 3).collect::<String>() + "..."
    } else {
        text
    }
}

/// `readDiagnostic` of a DevTools event.
fn diagnostic(event: &str, params: &Value) -> Option<Value> {
    match event {
        "Runtime.consoleAPICalled" => {
            let text = params["args"].as_array().into_iter().flatten().map(|arg| {
                let value = if arg["value"].is_null() {
                    &arg["description"]
                } else {
                    &arg["value"]
                };
                match value {
                    Value::Null => String::new(),
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                }
            });
            let level = match params["type"].as_str() {
                Some("error" | "assert") => "error",
                Some("warning") => "warning",
                _ => "log",
            };
            Some(json!({ "level": level, "text": bounded(text.collect::<Vec<_>>().join(" ")) }))
        }
        "Runtime.exceptionThrown" => {
            let detail = &params["exceptionDetails"];
            let text = detail["exception"]["description"]
                .as_str()
                .or(detail["text"].as_str())
                .unwrap_or("Runtime exception");
            Some(json!({ "level": "error", "text": bounded(text.into()) }))
        }
        _ => None,
    }
}

fn install(webview: &tauri::Webview, watch: Arc<Watch>) -> Result<(), String> {
    use webview2_com::{CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler};
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| {
                let core =
                    unsafe { platform.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
                for event in [
                    "Runtime.consoleAPICalled",
                    "Runtime.exceptionThrown",
                    "Runtime.executionContextsCleared",
                    "Runtime.executionContextCreated",
                    "Runtime.executionContextDestroyed",
                    "Page.frameNavigated",
                    "Page.documentOpened",
                    "Page.frameDetached",
                    "Page.frameAttached",
                ] {
                    let name = CoTaskMemPWSTR::from(event);
                    let receiver = unsafe {
                        core.GetDevToolsProtocolEventReceiver(*name.as_ref().as_pcwstr())
                    }
                    .map_err(|e| e.to_string())?;
                    let watch = watch.clone();
                    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                        move |_, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut raw = Default::default();
                            unsafe { args.ParameterObjectAsJson(&mut raw)? };
                            let params =
                                serde_json::from_str(&CoTaskMemPWSTR::from(raw).to_string())
                                    .unwrap_or(Value::Null);
                            if watch
                                .document
                                .lock()
                                .is_ok_and(|mut doc| doc.changed(event, &params))
                            {
                                watch.epoch.fetch_add(1, Ordering::SeqCst);
                            } else if let (Some(item), Ok(mut list)) =
                                (diagnostic(event, &params), watch.diagnostics.lock())
                            {
                                list.push_back(item);
                                while list.len() > DIAGNOSTICS {
                                    list.pop_front();
                                }
                            }
                            Ok(())
                        },
                    ));
                    let mut token = 0;
                    unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }
                        .map_err(|e| e.to_string())?;
                }
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "WebView2 event registration timed out".to_string())?
}

impl WindowAutomation {
    /// `developer.execute` only admits the exact registered, ready local renderer.
    pub(crate) fn execute(
        &self,
        app: &AppHandle,
        run_id: &str,
        params: Option<Value>,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let input = params.unwrap_or(Value::Null);
        let command = &input["command"];
        let (Some(window_id), Some(instance)) =
            (input["windowId"].as_str(), input["windowInstance"].as_str())
        else {
            return Ok(failure("target", WINDOW_GONE));
        };
        let label = crate::identity::local_window_label(window_id)?;
        let app_state = app.state::<crate::AppState>();
        let windows = app.state::<crate::local_windows::LocalWindows>();
        let available = || windows.automation_matches(&label, instance);
        if input["runId"].as_str() != Some(run_id) || !available() {
            return Ok(failure("target", WINDOW_GONE));
        }
        let Some(webview) = app.get_webview(&label) else {
            return Ok(failure("target", WINDOW_GONE));
        };
        let Ok(url) = crate::require_local_app_webview(&webview, &app_state) else {
            return Ok(failure("target", WINDOW_GONE));
        };
        let watch = {
            let mut windows = self.windows.lock().map_err(|e| e.to_string())?;
            windows.retain(|label, _| app.get_webview(label).is_some());
            match windows
                .get(&label)
                .filter(|watch| watch.instance == instance)
            {
                Some(watch) => watch.clone(),
                None => {
                    let watch = Arc::new(Watch {
                        instance: instance.to_owned(),
                        epoch: AtomicU64::new(0),
                        document: Mutex::default(),
                        diagnostics: Mutex::default(),
                        operation: Mutex::default(),
                    });
                    windows.insert(label.clone(), watch.clone());
                    watch
                }
            }
        };
        let native = {
            let app = app.clone();
            let label = label.clone();
            let instance = instance.to_owned();
            let fence = fence.clone();
            move || {
                fence.check()?;
                if !app
                    .state::<crate::local_windows::LocalWindows>()
                    .automation_matches(&label, &instance)
                {
                    return Err(WINDOW_GONE.into());
                }
                Ok(())
            }
        };
        let mut state = watch.operation.lock().map_err(|e| e.to_string())?;
        if !available() {
            return Ok(failure("target", WINDOW_GONE));
        }
        if !state.enabled {
            let call = |method: &str| cdp(&webview, method, json!({}), deadline, native.clone());
            let setup = || {
                install(&webview, watch.clone())?;
                call("Page.enable")?;
                let tree = call("Page.getFrameTree")?;
                let frame = tree["frameTree"]["frame"]["id"]
                    .as_str()
                    .ok_or("No main document")?;
                watch
                    .document
                    .lock()
                    .map_err(|e| e.to_string())?
                    .frame
                    .get_or_insert_with(|| frame.to_owned());
                call("Runtime.enable")?;
                call("Accessibility.enable")?;
                Ok::<_, String>(())
            };
            if let Err(error) = setup() {
                return Ok(failure("target", error));
            }
            state.enabled = true;
        }
        let epoch = watch.epoch.load(Ordering::SeqCst);
        let generation = format!("{instance}/{epoch}");
        let action = command["action"].as_str().unwrap_or_default();
        let selecting = action == "inspect" && command.get("ref").is_none();
        if action != "context" && !selecting && input["document"] != generation {
            return Ok(failure("document", "The page changed; inspect it again"));
        }
        let changed = match action {
            "inspect" => "Page changed during inspection; inspect again",
            "screenshot" => "Page changed during screenshot; capture again",
            _ => "Page changed during action; inspect again",
        };
        let guard = {
            let watch = watch.clone();
            move || {
                native()?;
                if watch.epoch.load(Ordering::SeqCst) != epoch {
                    return Err(changed.into());
                }
                Ok(())
            }
        };
        let devtools = |method: &str, params: Value| {
            let result = cdp(&webview, method, params, deadline, guard.clone())?;
            guard()?;
            Ok(result)
        };
        let session_id = input["sessionID"]
            .as_str()
            .filter(|id| id.encode_utf16().count() <= 256);
        let read = |session| read_context(&devtools, session, window_id, instance);
        let mut context = match read(if action == "context" {
            session_id
        } else {
            None
        }) {
            Ok(context) => context,
            Err(error) => return Ok(failure("target", error)),
        };
        if action == "context" {
            return Ok(json!({"context": context, "document": generation}));
        }
        let title = context.as_object_mut().and_then(|c| c.remove("title"));
        context.as_object_mut().unwrap().remove("sessionOpen");
        let monitor_tab = action == "wait" || action == "scroll" && command.get("ref").is_none();
        let checkpoint = || -> Result<(), String> {
            let current = read(None).map_err(|_| changed.to_string())?;
            if monitor_tab
                && ["tabId", "instanceId", "sessionId"]
                    .iter()
                    .any(|k| current[k] != context[k])
            {
                return Err("The active tab changed during the action; inspect again".into());
            }
            Ok(())
        };
        let input = Input::new(&devtools, action, &context);
        let send = |operation: Value| -> Result<Value, String> {
            let function = operation["function"].as_str().map(str::to_owned);
            let parsed = operations::parse_in(operation, true)?;
            match parsed.cdp_in(true) {
                None => Ok(json!({})),
                Some((method, params)) => {
                    Ok(parsed.result(input.send(function.as_deref(), method, params)?))
                }
            }
        };
        let input_check = || {
            guard().map_err(|message| Refusal {
                message,
                same_document: false,
                timeout: false,
            })
        };
        let destination = |kind: &str, params: &mut Value, target: Option<Target<'_>>| {
            input.destination(kind, params, target)
        };
        let session = page::Session {
            driver: "cdp",
            send: &send,
            checkpoint: &checkpoint,
            mark: true,
            guard: Some(Guard {
                check: &input_check,
                destination: &destination,
            }),
        };
        let outcome: Result<Value, page::Fail> = match action {
            "inspect" => page::snapshot(&session, &mut state.refs, &generation, command, true).map(|(snapshot, collapsed)| {
                let diagnostics: Vec<Value> = watch.diagnostics.lock().map(|mut list| list.drain(..).collect()).unwrap_or_default();
                json!({
                    "target": { "id": label, "title": title, "url": url },
                    "context": context, "document": generation, "snapshot": snapshot, "collapsed": collapsed, "diagnostics": diagnostics,
                })
            }),
            "screenshot" => screenshot(&devtools, &checkpoint).map_err(page::Fail::from),
            _ => {
                let refs = &state.refs;
                let resolve = |r: &str| refs.resolve(r, &generation);
                page::act(&session, command, &resolve).map(|result| {
                    let mut out = json!({ "ok": true });
                    out.as_object_mut().unwrap().extend(result.as_object().cloned().unwrap_or_default());
                    out
                })
            }
        };
        if !available() {
            return Ok(failure("target", WINDOW_GONE));
        }
        Ok(outcome.unwrap_or_else(|fail| {
            let stage = if watch.epoch.load(Ordering::SeqCst) != epoch {
                "document"
            } else {
                "action"
            };
            failure(stage, fail.message)
        }))
    }
}

fn cdp(
    webview: &tauri::Webview,
    method: &str,
    params: Value,
    deadline: Instant,
    guard: impl Fn() -> Result<(), String> + Send + 'static,
) -> Result<Value, String> {
    crate::browser_controller::cdp_guarded_inner(
        webview,
        None,
        method,
        params,
        deadline,
        guard,
        RESPONSE_BYTES,
    )
}

/// `readContext`: the page's own window id, visible workspace and active conversation.
fn read_context(
    cdp: &super::window_input::Cdp<'_>,
    session: Option<&str>,
    window: &str,
    instance: &str,
) -> Result<Value, String> {
    let program = program("context").as_str().expect("fixed context program");
    let session = json!(session);
    let response = cdp(
        "Runtime.evaluate",
        json!({ "expression": format!("({{ ...({program})({session}), title: document.title.slice(0, 512) }})"),
            "returnByValue": true }),
    )?;
    let value = &response["result"]["value"];
    let id = |v: &Value| v.is_null() || v.as_str().is_some_and(|s| s.encode_utf16().count() <= 256);
    if value["windowId"] != window
        || value["windowInstance"] != instance
        || !["instanceId", "sessionId", "tabId"]
            .iter()
            .all(|key| value.get(*key).is_some_and(id))
        || !value["sessionOpen"].is_boolean()
        || !value["title"].is_string()
    {
        return Err("CodeNomad page has no valid window context".into());
    }
    Ok(value.clone())
}

fn screenshot(
    cdp: &super::window_input::Cdp<'_>,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let params = json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false });
    let result = cdp("Page.captureScreenshot", params)?;
    checkpoint()?;
    let data = result["data"]
        .as_str()
        .ok_or("Chrome returned an invalid screenshot")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Chrome returned an invalid screenshot")?
        .len();
    if bytes > SCREENSHOT_BYTES {
        return Err(format!("Screenshot exceeds {SCREENSHOT_BYTES} byte limit"));
    }
    Ok(json!({ "image": { "data": data, "mime": "image/png" } }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_document_changes_retire_its_generation() {
        let mut doc = Document::default();
        assert!(doc.changed("Page.frameNavigated", &json!({"frame": {"id": "main"}})));
        let context = |id, frame: &str| json!({"context": {"id": id, "auxData": {"isDefault": true, "frameId": frame}}});
        assert!(!doc.changed("Runtime.executionContextCreated", &context(1, "main")));
        assert!(!doc.changed(
            "Page.frameNavigated",
            &json!({"frame": {"id": "child", "parentId": "main"}})
        ));
        assert!(!doc.changed("Runtime.executionContextCreated", &context(2, "child")));
        assert!(!doc.changed(
            "Runtime.executionContextDestroyed",
            &json!({"executionContextId":2})
        ));
        assert!(doc.changed("Runtime.executionContextCreated", &context(3, "main")));
        assert!(!doc.changed(
            "Runtime.executionContextDestroyed",
            &json!({"executionContextId":1})
        ));
        assert!(doc.changed(
            "Runtime.executionContextDestroyed",
            &json!({"executionContextId":3})
        ));
    }

    #[test]
    fn diagnostics_read_like_the_reference() {
        let console = json!({"type": "assert", "args": [{"value": "Failed"}, {"description": "Error: x"}, {"value": 3}, {}]});
        assert_eq!(
            diagnostic("Runtime.consoleAPICalled", &console),
            Some(json!({"level": "error", "text": "Failed Error: x 3 "}))
        );
        assert_eq!(
            diagnostic(
                "Runtime.consoleAPICalled",
                &json!({"type": "warning", "args": []})
            )
            .unwrap(),
            json!({"level": "warning", "text": ""})
        );
        let thrown = json!({"exceptionDetails": {"text": "Uncaught", "exception": {"description": "x".repeat(600)}}});
        let text = diagnostic("Runtime.exceptionThrown", &thrown).unwrap()["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!((text.len(), text.ends_with("...")), (512, true));
        assert_eq!(
            diagnostic("Runtime.exceptionThrown", &json!({})).unwrap()["text"],
            "Runtime exception"
        );
        assert_eq!(diagnostic("Page.frameNavigated", &json!({})), None);
    }
}
