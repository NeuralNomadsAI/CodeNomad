//! The CodeNomad window itself on Windows (`developer-cdp.ts` in process): `developer.execute`
//! inspects, acts on and captures the inspected local window through WebView2's own DevTools
//! session, with no remote debugging port. Operations of one run are serialized.
use super::{page, refs::RefTable};
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
const CONTEXT: &str = r#"(() => {
  const root = document.querySelector('[data-tab-visible="true"][data-instance-id]');
  const pane = root?.querySelector('.session-cache-pane[data-session-active="true"][data-session-id]');
  return {
    windowId: window.__CODENOMAD_WINDOW_ID__ ?? null,
    instanceId: root?.getAttribute('data-instance-id') ?? null,
    sessionId: pane?.getAttribute('data-session-id') ?? null,
    title: document.title,
  };
})()"#;

/// DevTools events of one webview: console and exceptions for diagnostics, navigations that make
/// every earlier ref stale.
struct Watch {
    stamp: u64,
    epoch: AtomicU64,
    diagnostics: Mutex<VecDeque<Value>>,
}

#[derive(Default)]
pub(crate) struct WindowAutomation {
    state: Mutex<State>,
}

struct State {
    /// Shared by every window so a ref name is never reused for another element.
    refs: RefTable,
    watches: HashMap<String, Arc<Watch>>,
    stamps: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            refs: RefTable::new("inspect again", "e"),
            watches: HashMap::new(),
            stamps: 0,
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
                    "Page.frameNavigated",
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
                            if event == "Page.frameNavigated" {
                                watch.epoch.fetch_add(1, Ordering::SeqCst);
                                return Ok(());
                            }
                            let mut raw = Default::default();
                            unsafe { args.ParameterObjectAsJson(&mut raw)? };
                            let params =
                                serde_json::from_str(&CoTaskMemPWSTR::from(raw).to_string())
                                    .unwrap_or(Value::Null);
                            if let (Some(item), Ok(mut list)) =
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
    /// `developer.execute { runId, windowId, command }`, the command validated by the backend.
    pub(crate) fn execute(
        &self,
        app: &AppHandle,
        run_id: &str,
        params: Option<Value>,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let input = params.unwrap_or(Value::Null);
        if input["runId"].as_str() != Some(run_id) {
            return Ok(failure(
                "target",
                "Run codenomad.inspect before acting on or restarting this CodeNomad window",
            ));
        }
        let window_id = input["windowId"]
            .as_str()
            .ok_or("Invalid developer command")?;
        let command = &input["command"];
        let Some(webview) = app.webviews().into_values().find(|w| {
            crate::identity::local_window_id(w.label()).ok().as_deref() == Some(window_id)
        }) else {
            return Ok(failure(
                "target",
                "No CodeNomad page matches the selected window and OpenCode session",
            ));
        };
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let label = webview.label().to_string();
        let watch = match state.watches.get(&label) {
            Some(watch) => watch.clone(),
            None => {
                state.stamps += 1;
                let watch = Arc::new(Watch {
                    stamp: state.stamps,
                    epoch: AtomicU64::new(0),
                    diagnostics: Mutex::default(),
                });
                let call = |method: &str| cdp(&webview, method, json!({}), deadline, fence);
                if let Err(error) = install(&webview, watch.clone())
                    .and_then(|()| call("Page.enable"))
                    .and_then(|_| call("Runtime.enable"))
                    .and_then(|_| call("Accessibility.enable"))
                {
                    return Ok(failure("target", error));
                }
                state.watches.insert(label.clone(), watch.clone());
                watch
            }
        };
        let epoch = watch.epoch.load(Ordering::SeqCst);
        let context = match read_context(&webview, deadline, fence) {
            Ok(context) if context["windowId"] == window_id => context,
            Ok(_) => {
                return Ok(failure(
                    "target",
                    "CodeNomad window or active session changed; inspect again",
                ))
            }
            Err(error) => return Ok(failure("target", error)),
        };
        let generation = format!("{}\0{label}\0{epoch}", watch.stamp);
        let action = command["action"].as_str().unwrap_or_default();
        let changed = match action {
            "inspect" => "Page changed during inspection; inspect again",
            "screenshot" => "Page changed during screenshot; capture again",
            _ => "Page changed during action; inspect again",
        };
        // Refs and checkpoints belong to this navigation epoch and window.
        let checkpoint = || -> Result<(), String> {
            let current = read_context(&webview, deadline, fence).ok();
            if watch.epoch.load(Ordering::SeqCst) != epoch
                || current.is_none_or(|c| c["windowId"] != window_id)
            {
                return Err(changed.into());
            }
            Ok(())
        };
        let send = |operation: Value| -> Result<Value, String> {
            let parsed = operations::parse_in(operation, true)?;
            match parsed.cdp_in(true) {
                None => Ok(json!({})),
                Some((method, params)) => {
                    Ok(parsed.result(cdp(&webview, method, params, deadline, fence)?))
                }
            }
        };
        let session = page::Session {
            driver: "cdp",
            send: &send,
            checkpoint: &checkpoint,
            mark: true,
        };
        let outcome: Result<Value, page::Fail> = match action {
            "inspect" => page::snapshot(&session, &mut state.refs, &generation, command, true).map(|(snapshot, collapsed)| {
                let diagnostics: Vec<Value> = watch.diagnostics.lock().map(|mut list| list.drain(..).collect()).unwrap_or_default();
                json!({
                    "target": { "id": label, "title": context["title"], "url": webview.url().map(|u| u.to_string()).unwrap_or_default() },
                    "context": { "windowId": window_id, "instanceId": context["instanceId"], "sessionId": context["sessionId"] },
                    "snapshot": snapshot, "collapsed": collapsed, "diagnostics": diagnostics,
                })
            }),
            "screenshot" => screenshot(&webview, deadline, fence, &checkpoint).map_err(page::Fail::from),
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
        Ok(outcome.unwrap_or_else(|fail| failure("action", fail.message)))
    }
}

fn cdp(
    webview: &tauri::Webview,
    method: &str,
    params: Value,
    deadline: Instant,
    fence: &crate::native_request::RequestFence,
) -> Result<Value, String> {
    let fence = fence.clone();
    crate::browser_controller::cdp_guarded_inner(
        webview,
        method,
        params,
        deadline,
        move || fence.check(),
        RESPONSE_BYTES,
    )
}

/// `readContext`: the page's own window id, visible workspace and active conversation.
fn read_context(
    webview: &tauri::Webview,
    deadline: Instant,
    fence: &crate::native_request::RequestFence,
) -> Result<Value, String> {
    let response = cdp(
        webview,
        "Runtime.evaluate",
        json!({ "expression": CONTEXT, "returnByValue": true }),
        deadline,
        fence,
    )?;
    let value = &response["result"]["value"];
    let id = |v: &Value| v.is_null() || v.as_str().is_some_and(|s| s.encode_utf16().count() <= 256);
    if !value["windowId"]
        .as_str()
        .is_some_and(|s| s.encode_utf16().count() <= 256)
        || !id(&value["instanceId"])
        || !id(&value["sessionId"])
    {
        return Err("CodeNomad page has no valid window context".into());
    }
    Ok(value.clone())
}

fn screenshot(
    webview: &tauri::Webview,
    deadline: Instant,
    fence: &crate::native_request::RequestFence,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let params = json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false });
    let result = cdp(webview, "Page.captureScreenshot", params, deadline, fence)?;
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
