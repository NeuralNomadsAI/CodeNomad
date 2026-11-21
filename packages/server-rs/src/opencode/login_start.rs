use axum::{
    Extension, Json,
    extract::{State, rejection::JsonRejection},
    http::StatusCode as Status,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Error, Shared, auth::Principal, error};

pub(super) async fn read() -> Json<Value> {
    Json(json!({"state":"unavailable"}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    #[serde(rename = "enabled")]
    _enabled: bool,
}

pub(super) async fn set(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    input: Result<Json<Input>, JsonRejection>,
) -> Result<Json<Value>, Error> {
    refuse(input.is_ok(), app.auth.enabled() && principal.live().is_ok())
}

fn refuse(valid: bool, authenticated: bool) -> Result<Json<Value>, Error> {
    if !valid {
        return Err(error(Status::BAD_REQUEST, "login-start-input-invalid"));
    }
    if !authenticated {
        return Err(error(Status::UNAUTHORIZED, "login-start-human-required"));
    }
    Err(error(Status::SERVICE_UNAVAILABLE, "login-start-unavailable"))
}

#[cfg(test)]
#[tokio::test]
async fn unsupported_host_never_acknowledges_an_os_change() {
    assert_eq!(read().await.0, json!({"state":"unavailable"}));
    let valid = |v| serde_json::from_value::<Input>(v).is_ok();
    assert_eq!(refuse(valid(json!({"enabled":true,"scope":"other"})), true).unwrap_err().0, Status::BAD_REQUEST);
    assert_eq!(refuse(true, false).unwrap_err().0, Status::UNAUTHORIZED);
    for enabled in [false, true] {
        assert_eq!(refuse(valid(json!({"enabled":enabled})), true).unwrap_err().0, Status::SERVICE_UNAVAILABLE);
    }
}
