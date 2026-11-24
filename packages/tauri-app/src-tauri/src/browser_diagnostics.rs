//! Console and network events of WebView2 previews, kept raw and bounded for the backend to read.
//! The events, domains and limits come from the shared `diagnostic-events.ts` (its generated JSON).
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

pub(super) struct Spec {
    pub(super) enable: Vec<(String, Value)>,
    pub(super) events: Vec<String>,
    message_events: Vec<String>,
    request_events: Vec<String>,
    max_events: usize,
    max_bytes: usize,
    max_read: usize,
    max_read_bytes: usize,
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
            request_events: names("requestEvents"),
            max_events: number("maxEvents"),
            max_bytes: number("maxBytes"),
            max_read: number("maxRead"),
            max_read_bytes: number("maxReadBytes"),
        }
    })
}

struct Buffer {
    generation: u64,
    instance: String,
    epoch: u64,
    sequence: u64,
    /// The last sequence a read returned: evicting it or anything before it loses nothing.
    delivered: u64,
    /// This epoch's evicted, never-read console entries and requests.
    lost_messages: u64,
    lost_requests: u64,
    /// The navigation that started this epoch: its redirects keep the epoch.
    navigation: Option<u64>,
    bytes: usize,
    events: VecDeque<(u64, String, Value, Option<String>, usize)>,
}

/// One buffer per registration generation; events of a replaced webview never reach its successor.
#[derive(Default)]
pub(super) struct Buffers(Mutex<HashMap<String, Buffer>>);

impl Buffers {
    pub(super) fn start(&self, registration_id: &str, generation: u64) {
        if let Ok(mut buffers) = self.0.lock() {
            buffers.insert(
                registration_id.to_string(),
                Buffer {
                    generation,
                    instance: uuid::Uuid::new_v4().to_string(),
                    epoch: 0,
                    sequence: 0,
                    delivered: 0,
                    lost_messages: 0,
                    lost_requests: 0,
                    navigation: None,
                    bytes: 0,
                    events: VecDeque::new(),
                },
            );
        }
    }

    pub(super) fn remove(&self, registration_id: &str) {
        if let Ok(mut buffers) = self.0.lock() {
            buffers.remove(registration_id);
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
        if params.len() > spec.max_read_bytes || !spec.events.iter().any(|event| event == method) {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(params) else {
            return;
        };
        let Ok(mut buffers) = self.0.lock() else {
            return;
        };
        let Some(buffer) = buffers
            .get_mut(registration_id)
            .filter(|buffer| buffer.generation == generation)
        else {
            return;
        };
        buffer.sequence += 1;
        buffer.bytes += params.len();
        buffer
            .events
            .push_back((buffer.sequence, method.to_string(), value, session.map(str::to_string), params.len()));
        while buffer.events.len() > spec.max_events || buffer.bytes > spec.max_bytes {
            let Some((sequence, method, _, _, bytes)) = buffer.events.pop_front() else {
                break;
            };
            buffer.bytes -= bytes;
            if sequence <= buffer.delivered {
                continue;
            }
            if spec.message_events.contains(&method) {
                buffer.lost_messages += 1;
            } else if spec.request_events.contains(&method) {
                buffer.lost_requests += 1;
            }
        }
    }

    /// A new document's diagnostics start with its own request, as in OpenCode's browser. A redirect raises
    /// another start with the same navigation, which keeps the epoch; `None` is a document opened in place.
    pub(super) fn restart(&self, registration_id: &str, generation: u64, navigation: Option<u64>) {
        if let Ok(mut buffers) = self.0.lock() {
            if let Some(buffer) = buffers
                .get_mut(registration_id)
                .filter(|buffer| buffer.generation == generation)
            {
                if navigation.is_some() && buffer.navigation == navigation {
                    return;
                }
                buffer.navigation = navigation;
                buffer.events.clear();
                buffer.bytes = 0;
                buffer.epoch += 1;
                buffer.delivered = buffer.sequence;
                buffer.lost_messages = 0;
                buffer.lost_requests = 0;
            }
        }
    }

    pub(super) fn read(&self, registration_id: &str, generation: u64, after: u64) -> Result<Value, String> {
        let spec = spec();
        let mut buffers = self.0.lock().map_err(|error| error.to_string())?;
        let buffer = buffers
            .get_mut(registration_id)
            .filter(|buffer| buffer.generation == generation)
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
            "lost": { "messages": buffer.lost_messages, "requests": buffer.lost_requests },
            "more": next < buffer.sequence,
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
                let (Some(frame), Some(core)) = (value["sessionId"].as_str(), sender) else {
                    return Ok(());
                };
                if value["targetInfo"]["type"] != "iframe" {
                    return Ok(());
                }
                let core = core.cast::<ICoreWebView2_11>()?;
                let frame = CoTaskMemPWSTR::from(frame);
                for (command, params) in &spec().enable {
                    let command = CoTaskMemPWSTR::from(command.as_str());
                    let params = CoTaskMemPWSTR::from(params.to_string().as_str());
                    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                    // A frame that refuses a domain only lacks its diagnostics.
                    let _ = unsafe {
                        core.CallDevToolsProtocolMethodForSession(
                            *frame.as_ref().as_pcwstr(),
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
}