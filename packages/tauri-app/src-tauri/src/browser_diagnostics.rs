//! Console and network events of WebView2 previews, kept raw and bounded for the backend to read.
//! The events, domains and limits come from the shared `diagnostic-events.ts` (its generated JSON).
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

pub(super) struct Spec {
    pub(super) enable: Vec<(String, Value)>,
    pub(super) events: Vec<String>,
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
        Spec {
            enable: value["enable"]
                .as_array()
                .expect("diagnostic domains")
                .iter()
                .map(|entry| (entry[0].as_str().expect("domain").to_string(), entry[1].clone()))
                .collect(),
            events: value["events"]
                .as_array()
                .expect("diagnostic events")
                .iter()
                .map(|event| event.as_str().expect("event").to_string())
                .collect(),
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
    /// The last sequence before the current epoch: a navigation's clear is no loss.
    epoch_start: u64,
    bytes: usize,
    events: VecDeque<(u64, String, Value, usize)>,
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
                    epoch_start: 0,
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

    pub(super) fn record(&self, registration_id: &str, generation: u64, method: &str, params: &str) {
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
            .push_back((buffer.sequence, method.to_string(), value, params.len()));
        while buffer.events.len() > spec.max_events || buffer.bytes > spec.max_bytes {
            let Some((_, _, _, bytes)) = buffer.events.pop_front() else {
                break;
            };
            buffer.bytes -= bytes;
        }
    }

    /// A main-frame navigation starts a new document: its diagnostics start with its own request.
    pub(super) fn clear(&self, registration_id: &str, generation: u64) {
        if let Ok(mut buffers) = self.0.lock() {
            if let Some(buffer) = buffers
                .get_mut(registration_id)
                .filter(|buffer| buffer.generation == generation)
            {
                buffer.events.clear();
                buffer.bytes = 0;
                buffer.epoch += 1;
                buffer.epoch_start = buffer.sequence;
            }
        }
    }

    pub(super) fn read(&self, registration_id: &str, generation: u64, after: u64) -> Result<Value, String> {
        let spec = spec();
        let buffers = self.0.lock().map_err(|error| error.to_string())?;
        let buffer = buffers
            .get(registration_id)
            .filter(|buffer| buffer.generation == generation)
            .ok_or("Browser diagnostics are unavailable for this preview")?;
        let first = buffer
            .events
            .front()
            .map_or(buffer.sequence + 1, |(sequence, ..)| *sequence);
        let dropped = first.saturating_sub(after.max(buffer.epoch_start) + 1);
        let mut next = after.max(first.saturating_sub(1));
        let (mut events, mut bytes) = (Vec::new(), 0);
        for (sequence, method, params, size) in &buffer.events {
            if *sequence <= after {
                continue;
            }
            if events.len() >= spec.max_read || bytes + size > spec.max_read_bytes {
                break;
            }
            events.push(json!({ "method": method, "params": params }));
            bytes += size;
            next = *sequence;
        }
        Ok(json!({
            "epoch": format!("{}:{}", buffer.instance, buffer.epoch),
            "events": events,
            "next": next,
            "dropped": dropped,
            "more": next < buffer.sequence,
        }))
    }
}

/// Records the preview's diagnostic events from its own top-level protocol session.
#[cfg(windows)]
pub(super) fn install(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    controller: super::BrowserController,
    registration_id: String,
    generation: u64,
) -> Result<(), String> {
    use webview2_com::{
        CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceivedEventArgs2,
    };
    use windows_core::Interface;

    controller.diagnostics.start(&registration_id, generation);
    for method in &spec().events {
        let name = CoTaskMemPWSTR::from(method.as_str());
        let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(*name.as_ref().as_pcwstr()) }
            .map_err(|error| super::preview_error("get diagnostic event receiver", error))?;
        let (controller, registration_id, method) = (controller.clone(), registration_id.clone(), method.clone());
        let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let session = args.cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>()?;
            let mut session_id = Default::default();
            unsafe { session.SessionId(&mut session_id)? };
            if !CoTaskMemPWSTR::from(session_id).to_string().is_empty() {
                return Ok(());
            }
            let mut parameters = Default::default();
            unsafe { args.ParameterObjectAsJson(&mut parameters)? };
            controller.diagnostics.record(
                &registration_id,
                generation,
                &method,
                &CoTaskMemPWSTR::from(parameters).to_string(),
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
    fn reads_after_a_sequence_counts_evictions_and_restarts_each_document() {
        let buffers = Buffers::default();
        buffers.start("preview", 3);
        buffers.record("preview", 3, "Runtime.consoleAPICalled", r#"{"type":"log"}"#);
        buffers.record("preview", 3, "Page.frameNavigated", r#"{}"#);
        buffers.record("preview", 2, "Runtime.consoleAPICalled", r#"{"type":"stale"}"#);
        let read = buffers.read("preview", 3, 0).unwrap();
        assert_eq!(read["events"].as_array().unwrap().len(), 1);
        assert_eq!(read["next"], 1);
        assert_eq!(read["dropped"], 0);
        assert_eq!(read["more"], false);
        let epoch = read["epoch"].clone();
        buffers.clear("preview", 3);
        buffers.record("preview", 3, "Log.entryAdded", r#"{"entry":{}}"#);
        let read = buffers.read("preview", 3, 1).unwrap();
        assert_ne!(read["epoch"], epoch);
        assert_eq!(read["events"][0]["method"], "Log.entryAdded");
        assert_eq!(read["dropped"], 0, "a navigation's clear is no loss");
        assert!(buffers.read("preview", 4, 0).is_err());
        for _ in 0..spec().max_events + 5 {
            buffers.record("preview", 3, "Log.entryAdded", r#"{"entry":{}}"#);
        }
        // Sequences 2..=4007 in this document: 2..=7 were evicted, five of them after the cursor.
        let read = buffers.read("preview", 3, 2).unwrap();
        assert_eq!(read["dropped"], 5);
        assert_eq!(read["more"], true);
    }
}
