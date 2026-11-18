use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub(crate) struct RequestFence {
    deadline: Instant,
    deadline_ms: u64,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl RequestFence {
    pub(crate) fn new(
        deadline_ms: u64,
        current: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(u64::MAX);
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(deadline_ms.saturating_sub(now)))
            .unwrap_or_else(Instant::now);
        Self {
            deadline,
            deadline_ms,
            current: Arc::new(current),
        }
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if !(self.current)() {
            return Err("Native backend process is no longer current".into());
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(u64::MAX);
        if Instant::now() >= self.deadline || now_ms >= self.deadline_ms {
            return Err("Native request expired before execution".into());
        }
        Ok(())
    }
}

/// Shared by the desktop stream reader and native-engine regression harness.
/// A replacement process never receives its predecessor's result.
pub(crate) fn dispatch(
    request: NativeRequest,
    fence: RequestFence,
    handle: impl FnOnce(&NativeRequest, RequestFence) -> Result<Value, String>,
) -> Option<String> {
    if !(fence.current)() {
        return None;
    }
    let result = fence.check().and_then(|()| handle(&request, fence.clone()));
    if !(fence.current)() {
        return None;
    }
    let result = match fence.check() {
        Ok(()) => result,
        Err(error) => Err(error),
    };
    Some(response(&request.id, result))
}

pub(crate) const REQUEST_PREFIX: &str = "CODENOMAD_NATIVE_REQUEST:";
pub(crate) const RESPONSE_PREFIX: &str = "CODENOMAD_NATIVE_RESPONSE:";
pub(crate) const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize, PartialEq)]
pub(crate) struct NativeRequest {
    pub(crate) v: u8,
    pub(crate) id: String,
    pub(crate) method: String,
    pub(crate) params: Option<Value>,
    pub(crate) deadline: u64,
}

#[derive(Serialize)]
struct NativeError {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct NativeResponse<'a> {
    v: u8,
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeError>,
}

pub(crate) fn parse(line: &str) -> Option<NativeRequest> {
    if !line.starts_with(REQUEST_PREFIX) || line.len() > MAX_LINE_BYTES {
        return None;
    }
    let request = serde_json::from_str::<NativeRequest>(&line[REQUEST_PREFIX.len()..]).ok()?;
    (request.v == 1
        && !request.id.is_empty()
        && request.id.len() <= 128
        && !request.method.is_empty()
        && request.method.len() <= 128)
        .then_some(request)
}

pub(crate) fn response(id: &str, result: Result<Value, String>) -> String {
    let response = match result {
        Ok(result) => NativeResponse {
            v: 1,
            id,
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(message) => NativeResponse {
            v: 1,
            id,
            ok: false,
            result: None,
            error: Some(NativeError {
                code: "native_error",
                message,
            }),
        },
    };
    format!(
        "{RESPONSE_PREFIX}{}\n",
        serde_json::to_string(&response).unwrap()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_requests_and_serializes_responses() {
        let request = parse(
            "CODENOMAD_NATIVE_REQUEST:{\"v\":1,\"id\":\"r1\",\"method\":\"developer.status\",\"deadline\":9999999999999}",
        )
        .unwrap();
        assert_eq!(request.id, "r1");
        assert!(parse("CODENOMAD_NATIVE_REQUEST:{\"v\":2}").is_none());
        assert_eq!(
            response("r1", Ok(json!({ "available": true }))),
            "CODENOMAD_NATIVE_RESPONSE:{\"v\":1,\"id\":\"r1\",\"ok\":true,\"result\":{\"available\":true}}\n"
        );
    }

    #[test]
    fn fences_expired_dispatch_retired_processes_and_late_results() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let request = || NativeRequest {
            v: 1,
            id: "request".into(),
            method: "browser.probe".into(),
            params: None,
            deadline: u64::MAX,
        };
        let expired = RequestFence::new(0, || true);
        let response =
            dispatch(request(), expired, |_, _| panic!("expired work dispatched")).unwrap();
        assert!(response.contains("expired"));
        let current = Arc::new(AtomicBool::new(true));
        let predicate = current.clone();
        let fence = RequestFence::new(u64::MAX - 1, move || predicate.load(Ordering::SeqCst));
        // Use a representable deadline while keeping this test independent of clock changes.
        let fence = RequestFence {
            deadline: Instant::now() + Duration::from_secs(10),
            ..fence
        };
        let queued = fence.clone();
        assert!(dispatch(request(), fence, |_, _| {
            current.store(false, Ordering::SeqCst);
            Ok(json!({"secret":"old process"}))
        })
        .is_none());
        assert!(queued.check().unwrap_err().contains("no longer current"));
        let late = RequestFence {
            deadline: Instant::now() + Duration::from_millis(5),
            deadline_ms: u64::MAX,
            current: Arc::new(|| true),
        };
        let response = dispatch(request(), late, |_, _| {
            std::thread::sleep(Duration::from_millis(10));
            Ok(json!({"stale":true}))
        })
        .unwrap();
        assert!(response.contains("expired"));
        assert!(!response.contains("stale"));
        let absolute = RequestFence {
            deadline: Instant::now() + Duration::from_secs(10),
            deadline_ms: 0,
            current: Arc::new(|| true),
        };
        assert!(absolute.check().unwrap_err().contains("expired"));
    }
}
