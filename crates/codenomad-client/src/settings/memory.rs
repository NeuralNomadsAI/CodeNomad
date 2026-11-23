use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use serde_json::{Value, json};
use std::time::Duration;

pub async fn enabled(backend: &Backend) -> Result<bool> {
    let url = format!("{}api/memory/settings", backend.base);
    let response = backend
        .client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?;
    decode(read_json_limited(response, 4096).await?)
}

pub async fn set_enabled(backend: &Backend, enabled: bool) -> Result<bool> {
    let url = format!("{}api/memory/settings", backend.base);
    let response = backend
        .client
        .put(url)
        .timeout(Duration::from_secs(40))
        .json(&json!({"enabled":enabled}))
        .send()
        .await?
        .error_for_status()?;
    decode(read_json_limited(response, 4096).await?)
}

fn decode(value: Value) -> Result<bool> {
    value["enabled"]
        .as_bool()
        .ok_or_else(|| "Invalid memory preference".into())
}

#[cfg(test)]
#[test]
fn memory_setting_requires_an_explicit_boolean() {
    assert!(!decode(json!({"enabled":false})).unwrap());
    assert!(decode(json!({"enabled":true})).unwrap());
    for invalid in [
        json!({}),
        json!(true),
        json!({"enabled":"true"}),
        json!({"enabled":null}),
    ] {
        assert!(decode(invalid).is_err());
    }
}
