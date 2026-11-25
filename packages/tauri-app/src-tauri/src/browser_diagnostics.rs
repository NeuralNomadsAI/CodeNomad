//! Console and network events of WebView2 previews, kept raw and bounded for the backend to read.
//! The events, domains and limits come from the shared `diagnostic-events.ts` (its generated JSON).
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

pub(super) struct Spec {
    pub(super) enable: Vec<(String, Value)>,
    pub(super) events: Vec<String>,
    message_events: Vec<String>,
    ending_events: Vec<String>,
    max_events: usize,
    max_bytes: usize,
    max_read: usize,
    max_read_bytes: usize,
    max_contexts: usize,
    max_text: usize,
}

pub(super) fn spec() -> &'static Spec {
    static SPEC: OnceLock<Spec> = OnceLock::new();
    SPEC.get_or_init(|| {
        let value: Value = serde_json::from_str(include_str!(
            "../../../server/src/automation/page/diagnostic-events.generated.json"
        ))
        .expect("generated diagnostic event specification");
        let number = |key: &str| value[key].as_u64().expect("diagnostic limit") as usize;
        let names = |key: &str| {
            value[key]
                .as_array()
                .expect("diagnostic event list")
                .iter()
                .map(|event| event.as_str().expect("event").to_string())
                .collect::<Vec<_>>()
        };
        Spec {
            enable: value["enable"]
                .as_array()
                .expect("diagnostic domains")
                .iter()
                .map(|entry| (entry[0].as_str().expect("domain").to_string(), entry[1].clone()))
                .collect(),
            events: names("events"),
            message_events: names("messageEvents"),
            ending_events: names("endingEvents"),
            max_events: number("maxEvents"),
            max_bytes: number("maxBytes"),
            max_read: number("maxRead"),
            max_read_bytes: number("maxReadBytes"),
            max_contexts: number("maxContexts"),
            max_text: number("maxText"),
        }
    })
}

/// Network events, and the others: each class has its own budget, so a console flood never evicts a request's
/// lifecycle.
#[derive(Clone, Copy, PartialEq)]
enum Class {
    Network,
    Page,
}

fn class_of(method: &str) -> Class {
    // A frame's detach ends its requests, so it belongs with them.
    if method.starts_with("Network.") || method == "Target.detachedFromTarget" {
        Class::Network
    } else {
        Class::Page
    }
}

/// An event too large to keep whole keeps its console text cut one character past `maxText`, so the readout still
/// reports it as truncated, as OpenCode's browser keeps an entry's text; other events stay as they are.
fn shrink(method: &str, mut params: Value, max_text: usize) -> Value {
    // Only fields the event has are cut: a missing one stays missing, as the TypeScript host leaves it.
    let cut = |value: &mut Value, pointer: &str| {
        if let Some(field) = value.pointer_mut(pointer) {
            if let Some(text) = field.as_str() {
                *field = json!(text.chars().take(max_text + 1).collect::<String>());
            }
        }
    };
    match method {
        "Runtime.consoleAPICalled" => {
            if let Some(args) = params["args"].as_array_mut() {
                for arg in args {
                    cut(arg, "/value");
                    cut(arg, "/description");
                    if let Some(arg) = arg.as_object_mut() {
                        arg.remove("preview");
                    }
                }
            }
        }
        "Runtime.exceptionThrown" => {
            cut(&mut params, "/exceptionDetails/text");
            cut(&mut params, "/exceptionDetails/exception/description");
            if let Some(exception) = params
                .pointer_mut("/exceptionDetails/exception")
                .and_then(Value::as_object_mut)
            {
                exception.remove("preview");
            }
        }
        "Log.entryAdded" => cut(&mut params, "/entry/text"),
        _ => {}
    }
    params
}
struct Buffer {
    generation: u64,
    instance: String,
    epoch: u64,
    sequence: u64,
    /// The last sequence a read returned: evicting it or anything before it loses nothing.
    delivered: u64,
    /// This epoch's console entries lost before any read, and the requests that lost an unread event.
    lost_messages: u64,
    lost_requests: HashSet<String>,
    /// Requests whose ending event, or whose frame's detach, was lost: they can no longer finish.
    ended_requests: HashSet<String>,
    /// The navigation that started this epoch: its redirects keep the epoch.
    navigation: Option<u64>,
    /// Retained events and bytes per class: network, then the others.
    tallies: [(usize, usize); 2],
    events: VecDeque<(u64, String, Value, Option<String>, usize)>,
    /// Live execution contexts by session and ID, oldest first, and whether each is a page world. They outlast
    /// epochs (document.open() keeps the page's) and evictions.
    contexts: VecDeque<(Option<String>, i64, bool)>,
}

impl Buffer {
    fn track(&mut self, method: &str, params: &Value, session: Option<&str>, max: usize) {
        let session = session.map(str::to_string);
        match method {
            "Runtime.executionContextCreated" => {
                let Some(id) = params["context"]["id"].as_i64() else {
                    return;
                };
                let aux = &params["context"]["auxData"];
                let page = aux["frameId"].is_string() && aux["isDefault"] == true;
                self.contexts
                    .retain(|(owner, context, _)| *owner != session || *context != id);
                self.contexts.push_back((session, id, page));
                if self.contexts.len() > max {
                    self.contexts.pop_front();
                }
            }
            "Runtime.executionContextDestroyed" => {
                let id = params["executionContextId"].as_i64();
                self.contexts
                    .retain(|(owner, context, _)| *owner != session || Some(*context) != id);
            }
            "Runtime.executionContextsCleared" => self.contexts.retain(|(owner, ..)| *owner != session),
            "Target.detachedFromTarget" => {
                let detached = params["sessionId"].as_str().map(str::to_string);
                if detached.is_some() {
                    self.contexts.retain(|(owner, ..)| *owner != detached);
                }
            }
            _ => {}
        }
    }

    /// A lost detach ends every request of its frame and a lost ending event its request; other lost events only
    /// leave a request incomplete, which the loss count reports.
    fn lose(&mut self, method: &str, params: &Value, session: Option<&str>) {
        let spec = spec();
        if spec.message_events.iter().any(|event| event == method) {
            self.lost_messages += 1;
            return;
        }
        if self.lost_requests.len() >= spec.max_events || self.ended_requests.len() >= spec.max_events {
            return;
        }
        if method == "Target.detachedFromTarget" {
            if let Some(frame) = params["sessionId"].as_str() {
                self.ended_requests.insert(format!("{frame}:*"));
            }
        }
        let (Class::Network, Some(request)) = (class_of(method), params["requestId"].as_str()) else {
            return;
        };
        let key = format!("{}:{request}", session.unwrap_or_default());
        if spec.ending_events.iter().any(|event| event == method) {
            self.ended_requests.insert(key.clone());
        }
        self.lost_requests.insert(key);
    }
}

/// One buffer per registration generation: a candidate's setup or an older generation's removal never touches the
/// published one, and events of a replaced webview never reach its successor.
#[derive(Default)]
pub(super) struct Buffers(Mutex<HashMap<(String, u64), Buffer>>);

impl Buffers {
    pub(super) fn start(&self, registration_id: &str, generation: u64) {
        if let Ok(mut buffers) = self.0.lock() {
            buffers.insert(
                (registration_id.to_string(), generation),
                Buffer {
                    generation,
                    instance: uuid::Uuid::new_v4().to_string(),
                    epoch: 0,
                    sequence: 0,
                    delivered: 0,
                    lost_messages: 0,
                    lost_requests: HashSet::new(),
                    ended_requests: HashSet::new(),
                    navigation: None,
                    tallies: [(0, 0); 2],
                    events: VecDeque::new(),
                    contexts: VecDeque::new(),
                },
            );
        }
    }

    pub(super) fn remove(&self, registration_id: &str, generation: u64) {
        if let Ok(mut buffers) = self.0.lock() {
            buffers.remove(&(registration_id.to_string(), generation));
        }
    }

    pub(super) fn record(
        &self,
        registration_id: &str,
        generation: u64,
        method: &str,
        params: &str,
        session: Option<&str>,
    ) {
        let spec = spec();
        if !spec.events.iter().any(|event| event == method) {
            return;
        }
        let Ok(mut value) = serde_json::from_str::<Value>(params) else {
            return;
        };
        let Ok(mut buffers) = self.0.lock() else {
            return;
        };
        let Some(buffer) = buffers
            .get_mut(&(registration_id.to_string(), generation))
        else {
            return;
        };
        buffer.track(method, &value, session, spec.max_contexts);
        let mut size = params.len();
        if size > spec.max_read_bytes {
            value = shrink(method, value, spec.max_text);
            size = value.to_string().len();
            if size > spec.max_read_bytes {
                buffer.lose(method, &value, session);
                return;
            }
        }
        let class = class_of(method) as usize;
        buffer.sequence += 1;
        buffer
            .events
            .push_back((buffer.sequence, method.to_string(), value, session.map(str::to_string), size));
        buffer.tallies[class].0 += 1;
        buffer.tallies[class].1 += size;
        while buffer.tallies[class].0 > spec.max_events || buffer.tallies[class].1 > spec.max_bytes {
            let Some(index) = buffer
                .events
                .iter()
                .position(|(_, method, ..)| class_of(method) as usize == class)
            else {
                break;
            };
            let Some((sequence, method, params, session, bytes)) = buffer.events.remove(index) else {
                break;
            };
            buffer.tallies[class].0 -= 1;
            buffer.tallies[class].1 -= bytes;
            if sequence > buffer.delivered {
                buffer.lose(&method, &params, session.as_deref());
            }
        }
    }

    /// A new document's diagnostics start with its own request, as in OpenCode's browser. A redirect raises
    /// another start with the same navigation, which keeps the epoch; `None` is a document opened in place.
    pub(super) fn restart(&self, registration_id: &str, generation: u64, navigation: Option<u64>) {
        if let Ok(mut buffers) = self.0.lock() {
            if let Some(buffer) = buffers
                .get_mut(&(registration_id.to_string(), generation))
            {
                if navigation.is_some() && buffer.navigation == navigation {
                    return;
                }
                buffer.navigation = navigation;
                buffer.events.clear();
                buffer.tallies = [(0, 0); 2];
                buffer.epoch += 1;
                buffer.delivered = buffer.sequence;
                buffer.lost_messages = 0;
                buffer.lost_requests.clear();
                buffer.ended_requests.clear();
            }
        }
    }
    pub(super) fn read(&self, registration_id: &str, generation: u64, after: u64) -> Result<Value, String> {
        let spec = spec();
        let mut buffers = self.0.lock().map_err(|error| error.to_string())?;
        let buffer = buffers
            .get_mut(&(registration_id.to_string(), generation))
            .ok_or("Browser diagnostics are unavailable for this preview")?;
        let first = buffer
            .events
            .front()
            .map_or(buffer.sequence + 1, |(sequence, ..)| *sequence);
        let mut next = after.max(first.saturating_sub(1));
        let (mut events, mut bytes) = (Vec::new(), 0);
        for (sequence, method, params, session, size) in &buffer.events {
            if *sequence <= after {
                continue;
            }
            if events.len() >= spec.max_read || bytes + size > spec.max_read_bytes {
                break;
            }
            let mut event = json!({ "method": method, "params": params });
            if let Some(session) = session {
                event["session"] = json!(session);
            }
            events.push(event);
            bytes += size;
            next = *sequence;
        }
        buffer.delivered = buffer.delivered.max(next);
        Ok(json!({
            "epoch": format!("{}:{}", buffer.instance, buffer.epoch),
            "events": events,
            "next": next,
            "lost": { "messages": buffer.lost_messages, "requests": buffer.lost_requests.len() },
            "lostRequests": buffer.ended_requests.iter().collect::<Vec<_>>(),
            "more": next < buffer.sequence,
            "contexts": buffer.contexts.iter().map(|(session, id, page)| {
                let mut context = json!({ "id": id, "page": page });
                if let Some(session) = session {
                    context["session"] = json!(session);
                }
                context
            }).collect::<Vec<_>>(),
        }))
    }
}
/// Records the preview's diagnostic events, an out-of-process frame's with its protocol session, and gives each
/// attached frame the same domains.
#[cfg(windows)]
pub(super) fn install(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    controller: super::BrowserController,
    registration_id: String,
    generation: u64,
) -> Result<(), String> {
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2DevToolsProtocolEventReceivedEventArgs2, ICoreWebView2_11},
    };
    use windows_core::Interface;

    controller.diagnostics.start(&registration_id, generation);
    const ATTACHED: &str = "Target.attachedToTarget";
    let attached = ATTACHED.to_string();
    for method in spec().events.iter().chain(std::iter::once(&attached)) {
        let name = CoTaskMemPWSTR::from(method.as_str());
        let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(*name.as_ref().as_pcwstr()) }
            .map_err(|error| super::preview_error("get diagnostic event receiver", error))?;
        let (controller, registration_id, method) = (controller.clone(), registration_id.clone(), method.clone());
        let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let session = args.cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>()?;
            let mut session_id = Default::default();
            unsafe { session.SessionId(&mut session_id)? };
            let session_id = CoTaskMemPWSTR::from(session_id).to_string();
            let mut parameters = Default::default();
            unsafe { args.ParameterObjectAsJson(&mut parameters)? };
            let parameters = CoTaskMemPWSTR::from(parameters).to_string();
            if method == ATTACHED {
                let Ok(value) = serde_json::from_str::<Value>(&parameters) else {
                    return Ok(());
                };
                let (Some(child), Some(core)) = (value["sessionId"].as_str(), sender) else {
                    return Ok(());
                };
                // Paused at start by the auto-attach, as in OpenCode's browser: a page frame gets the diagnostic
                // domains first, then every child runs; a worker is then left.
                let kind = value["targetInfo"]["type"].as_str().unwrap_or_default();
                let mut commands: Vec<(String, String)> = if kind == "iframe" {
                    spec()
                        .enable
                        .iter()
                        .map(|(command, params)| (command.clone(), params.to_string()))
                        .collect()
                } else {
                    Vec::new()
                };
                commands.push(("Runtime.runIfWaitingForDebugger".into(), "{}".into()));
                let core11 = core.cast::<ICoreWebView2_11>()?;
                let child_session = CoTaskMemPWSTR::from(child);
                for (command, params) in &commands {
                    let command = CoTaskMemPWSTR::from(command.as_str());
                    let params = CoTaskMemPWSTR::from(params.as_str());
                    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                    // A frame that refuses a domain only lacks its diagnostics; its resumption is sent regardless.
                    let _ = unsafe {
                        core11.CallDevToolsProtocolMethodForSession(
                            *child_session.as_ref().as_pcwstr(),
                            *command.as_ref().as_pcwstr(),
                            *params.as_ref().as_pcwstr(),
                            &done,
                        )
                    };
                }
                if kind == "worker" {
                    let command = CoTaskMemPWSTR::from("Target.detachFromTarget");
                    let params = CoTaskMemPWSTR::from(json!({ "sessionId": child }).to_string().as_str());
                    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                    let _ = unsafe {
                        core.CallDevToolsProtocolMethod(
                            *command.as_ref().as_pcwstr(),
                            *params.as_ref().as_pcwstr(),
                            &done,
                        )
                    };
                }
                return Ok(());
            }
            controller.diagnostics.record(
                &registration_id,
                generation,
                &method,
                &parameters,
                (!session_id.is_empty()).then_some(session_id.as_str()),
            );
            Ok(())
        }));
        let mut token = 0;
        unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }
            .map_err(|error| super::preview_error("install diagnostic event handler", error))?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_after_a_sequence_and_restarts_for_each_document_but_not_for_its_redirects() {
        let buffers = Buffers::default();
        buffers.start("preview", 3);
        buffers.restart("preview", 3, Some(7));
        buffers.record("preview", 3, "Runtime.consoleAPICalled", r#"{"type":"log"}"#, None);
        buffers.record("preview", 3, "Page.frameNavigated", r#"{}"#, None);
        buffers.record("preview", 2, "Runtime.consoleAPICalled", r#"{"type":"stale"}"#, None);
        let read = buffers.read("preview", 3, 0).unwrap();
        assert_eq!(read["events"].as_array().unwrap().len(), 1);
        assert_eq!(read["next"], 1);
        assert_eq!(read["more"], false);
        let epoch = read["epoch"].clone();
        // A redirect starts the same navigation again: the document's events stay.
        buffers.restart("preview", 3, Some(7));
        assert_eq!(buffers.read("preview", 3, 0).unwrap()["epoch"], epoch);
        buffers.restart("preview", 3, Some(8));
        buffers.record("preview", 3, "Log.entryAdded", r#"{"entry":{}}"#, None);
        let read = buffers.read("preview", 3, 0).unwrap();
        assert_ne!(read["epoch"], epoch);
        assert_eq!(read["events"][0]["method"], "Log.entryAdded");
        assert!(read["events"][0].get("session").is_none());
        buffers.record("preview", 3, "Network.requestWillBeSent", r#"{"requestId":"f1"}"#, Some("frame"));
        assert_eq!(buffers.read("preview", 3, 2).unwrap()["events"][0]["session"], "frame");
        assert!(buffers.read("preview", 4, 0).is_err());
    }

    #[test]
    fn counts_only_unread_evictions_by_the_readout_they_feed() {
        let buffers = Buffers::default();
        buffers.start("preview", 1);
        buffers.record("preview", 1, "Network.requestWillBeSent", r#"{"requestId":"r1"}"#, None);
        // The request was read before it was evicted: it is no loss.
        buffers.read("preview", 1, 0).unwrap();
        for _ in 0..spec().max_events + 3 {
            buffers.record("preview", 1, "Log.entryAdded", r#"{"entry":{}}"#, None);
        }
        let read = buffers.read("preview", 1, 1).unwrap();
        assert_eq!(read["lost"]["messages"], 3);
        assert_eq!(read["lost"]["requests"], 0);
        assert_eq!(read["more"], true);
    }
    #[test]
    fn live_contexts_outlast_restarts_and_a_detached_frames_go() {
        let buffers = Buffers::default();
        buffers.start("preview", 1);
        let created = |id: i64, default: bool, session: Option<&str>| {
            buffers.record(
                "preview",
                1,
                "Runtime.executionContextCreated",
                &json!({ "context": { "id": id, "auxData": { "frameId": "f", "isDefault": default } } }).to_string(),
                session,
            )
        };
        created(1, true, None);
        created(2, false, None);
        created(3, true, Some("frame"));
        buffers.restart("preview", 1, None);
        let contexts = buffers.read("preview", 1, 0).unwrap()["contexts"].clone();
        assert_eq!(
            contexts,
            json!([{ "id": 1, "page": true }, { "id": 2, "page": false }, { "id": 3, "page": true, "session": "frame" }])
        );
        buffers.record("preview", 1, "Target.detachedFromTarget", r#"{"sessionId":"frame"}"#, None);
        buffers.record("preview", 1, "Runtime.executionContextDestroyed", r#"{"executionContextId":2}"#, None);
        assert_eq!(buffers.read("preview", 1, 0).unwrap()["contexts"], json!([{ "id": 1, "page": true }]));
    }
    #[test]
    fn each_generation_keeps_its_own_buffer_through_setup_and_removal() {
        let buffers = Buffers::default();
        buffers.start("preview", 1);
        buffers.record("preview", 1, "Log.entryAdded", r#"{"entry":{}}"#, None);
        // A candidate's setup leaves the published preview's events.
        buffers.start("preview", 2);
        assert_eq!(buffers.read("preview", 1, 0).unwrap()["events"].as_array().unwrap().len(), 1);
        // Removing the older generation leaves the newer one.
        buffers.remove("preview", 1);
        assert!(buffers.read("preview", 1, 0).is_err());
        assert!(buffers.read("preview", 2, 0).is_ok());
        buffers.record("preview", 2, "Network.requestWillBeSent", r#"{"requestId":"r1"}"#, None);
        for _ in 0..spec().max_events + 1 {
            buffers.record("preview", 2, "Network.loadingFinished", r#"{"requestId":"r2"}"#, None);
        }
        let read = buffers.read("preview", 2, 0).unwrap();
        let mut lost = read["lostRequests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        lost.sort();
        assert_eq!(lost, [":r2"], "only a request whose ending event was lost is named");
    }

    #[test]
    fn a_console_flood_keeps_network_events_and_oversized_text_is_cut() {
        let buffers = Buffers::default();
        buffers.start("preview", 1);
        buffers.record("preview", 1, "Network.loadingFinished", r#"{"requestId":"r1"}"#, None);
        for _ in 0..spec().max_events + 2 {
            buffers.record("preview", 1, "Runtime.consoleAPICalled", r#"{"args":[]}"#, None);
        }
        let read = buffers.read("preview", 1, 0).unwrap();
        assert_eq!(read["events"][0]["method"], "Network.loadingFinished");
        assert_eq!(read["lost"]["messages"], 2);
        let wide = Buffers::default();
        wide.start("preview", 1);
        let text = "x".repeat(spec().max_read_bytes + 1);
        let params = json!({ "args": [{ "type": "string", "value": text }] }).to_string();
        wide.record("preview", 1, "Runtime.consoleAPICalled", &params, None);
        let kept = wide.read("preview", 1, 0).unwrap();
        assert_eq!(
            kept["events"][0]["params"]["args"][0]["value"].as_str().unwrap().len(),
            spec().max_text + 1
        );
    }
    #[test]
    fn a_lost_detach_ends_its_frame_and_cut_text_adds_no_field() {
        let buffers = Buffers::default();
        buffers.start("preview", 1);
        buffers.record("preview", 1, "Target.detachedFromTarget", r#"{"sessionId":"frame"}"#, None);
        buffers.record("preview", 1, "Network.requestWillBeSentExtraInfo", r#"{"requestId":"r1"}"#, None);
        for _ in 0..spec().max_events + 1 {
            buffers.record("preview", 1, "Network.dataReceived", r#"{"requestId":"x"}"#, None);
            buffers.record("preview", 1, "Network.responseReceivedExtraInfo", r#"{"requestId":"r9"}"#, None);
        }
        let lost = buffers.read("preview", 1, 0).unwrap()["lostRequests"].clone();
        assert_eq!(lost, json!(["frame:*"]), "a lost header leaves its request to finish");
        let params = json!({ "args": [{ "type": "object", "description": "x".repeat(spec().max_read_bytes) }] });
        let cut = shrink("Runtime.consoleAPICalled", params, spec().max_text);
        assert!(cut["args"][0].get("value").is_none());
    }
}