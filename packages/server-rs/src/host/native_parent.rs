//! Requests to the desktop host (`CODENOMAD_NATIVE_PARENT=1`). Placeholder of the same shape
//! as the `host-cli` bridge, kept unavailable until that bridge is merged.
use std::time::Duration;

use serde_json::Value;

pub fn available() -> bool {
    false
}

pub async fn request(_method: &str, _params: Value, _deadline: Duration) -> Result<Value, String> {
    Err("Native control is unavailable in this host".into())
}
