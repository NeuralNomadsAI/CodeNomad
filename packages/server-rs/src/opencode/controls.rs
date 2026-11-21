//! Session-scoped control admission beside the ordinary workspace relay.
use crate::{
    App, Error, error,
    opencode::{Endpoint, read_json, upstream_error},
};
use axum::http::{Method, StatusCode as Status};
use serde_json::Value;
use std::{sync::Arc, time::Duration};

pub fn permission(route: &str, method: &Method) -> Option<String> {
    if method != Method::POST {
        return None;
    }
    let parts: Vec<_> = route.strip_prefix("/api/session/")?.split('/').collect();
    (parts.len() == 4 && parts[1] == "permission" && parts[3] == "reply" && crate::opencode::valid_id(parts[2]))
        .then(|| parts[2].into())
}
pub fn valid_reply(input: &Value) -> bool {
    input.as_object().is_some_and(|v| v.keys().all(|k| matches!(k.as_str(), "decision" | "message")))
        && matches!(input["decision"].as_str(), Some("once" | "always" | "reject"))
        && (input.get("message").is_none()
            || input["message"].as_str().is_some_and(|s| s.encode_utf16().count() <= 4096))
}
pub fn form_cancel(route: &str, method: &Method) -> Option<String> {
    if method != Method::DELETE {
        return None;
    }
    let parts: Vec<_> = route.strip_prefix("/api/session/")?.split('/').collect();
    (parts.len() == 3 && parts[1] == "form" && crate::opencode::valid_id(parts[2])).then(|| parts[2].into())
}
pub fn valid_interrupt(input: &Value) -> bool {
    input.as_object().is_some_and(|v| v.keys().all(|k| k == "resume"))
        && (input.get("resume").is_none() || input["resume"].is_boolean())
}
pub async fn pending_form(app: &App, endpoint: &Arc<Endpoint>, session: &str, request: &str) -> Result<Value, Error> {
    pending_request(app, endpoint, session, request, "form").await
}
pub async fn pending(app: &App, endpoint: &Arc<Endpoint>, session: &str, request: &str) -> Result<Value, Error> {
    pending_request(app, endpoint, session, request, "permission").await
}
async fn pending_request(
    app: &App,
    endpoint: &Arc<Endpoint>,
    session: &str,
    request: &str,
    kind: &str,
) -> Result<Value, Error> {
    let missing = || {
        error(
            Status::CONFLICT,
            if kind == "form" {
                "Question is no longer pending for this session"
            } else {
                "Permission is no longer pending for this session"
            },
        )
    };
    let url = endpoint.url.join(&format!("/api/session/{session}/{kind}/{request}")).map_err(|_| upstream_error())?;
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| upstream_error())?;
    if response.status() == Status::NOT_FOUND {
        return Err(missing());
    }
    if !response.status().is_success() {
        return Err(upstream_error());
    }
    let value = read_json(response, 2 * 1024 * 1024).await.map_err(|_| upstream_error())?;
    let row = &value["data"];
    if row["id"] != request || row["sessionID"] != session || (kind == "form" && row["state"]["status"] != "pending") {
        return Err(missing());
    }
    Ok(row.clone())
}
#[test]
fn only_exact_permission_replies_enter_control_admission() {
    assert_eq!(permission("/api/session/s/permission/per_one/reply", &Method::POST).as_deref(), Some("per_one"));
    assert!(permission("/api/session/s/form/per_one/reply", &Method::POST).is_none());
    assert!(permission("/api/session/s/permission/per_one/reply/extra", &Method::POST).is_none());
    assert!(!valid_reply(&serde_json::json!({"decision":"allow"})));
    assert!(!valid_reply(&serde_json::json!({"decision":"once","metadata":{}})));
    assert!(valid_reply(&serde_json::json!({"decision":"reject","message":"explicit refusal"})));
}
