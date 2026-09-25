use serde::{Deserialize, Serialize};
use serde_json::Value;

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
}
