//! Session-scoped control admission beside the ordinary workspace relay.
use crate::{
    App, Error,
    opencode::{Endpoint, read_json, upstream_error},
};
use axum::{
    Json,
    http::{Method, StatusCode as Status},
};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone, Copy)]
pub(super) enum Control<'a> {
    Interrupt,
    Permission(&'a str),
    FormReply(&'a str),
    FormCancel(&'a str),
}

pub(super) fn is_global_form(route: &str, method: &Method) -> bool {
    let Some(rest) = route.strip_prefix("/api/session/global/form/") else {
        return false;
    };
    match method {
        &Method::POST => rest.strip_suffix("/reply").is_some_and(|id| !id.is_empty() && !id.contains('/')),
        &Method::DELETE => !rest.is_empty() && !rest.contains('/'),
        _ => false,
    }
}

pub(super) fn classify<'a>(route: &'a str, method: &Method) -> Option<Control<'a>> {
    let mut parts = route.strip_prefix("/api/session/")?.split('/');
    let session = parts.next()?;
    if matches!(session, "" | "active") {
        return None;
    }
    if session == "global" {
        return match (method, parts.next(), parts.next(), parts.next(), parts.next()) {
            (&Method::POST, Some("form"), Some(id), Some("reply"), None) if !id.is_empty() => {
                Some(Control::FormReply(id))
            }
            (&Method::DELETE, Some("form"), Some(id), None, None) if !id.is_empty() => Some(Control::FormCancel(id)),
            _ => None,
        };
    }
    match (method, parts.next(), parts.next(), parts.next(), parts.next()) {
        (&Method::POST, Some("interrupt"), None, None, None) => Some(Control::Interrupt),
        (&Method::POST, Some("permission"), Some(id), Some("reply"), None) if !id.is_empty() => {
            Some(Control::Permission(id))
        }
        (&Method::POST, Some("form"), Some(id), Some("reply"), None) if !id.is_empty() => Some(Control::FormReply(id)),
        (&Method::DELETE, Some("form"), Some(id), None, None) if !id.is_empty() => Some(Control::FormCancel(id)),
        _ => None,
    }
}

pub(super) fn invalid(message: &str) -> Error {
    (Status::BAD_REQUEST, Json(json!({ "error": message, "message": message })))
}

impl Control<'_> {
    pub(super) fn validate(self, input: &Value, target: &reqwest::Url) -> Result<(), Error> {
        let data = input.as_object().ok_or_else(|| invalid("Invalid session control"))?;
        let fields = |allowed: &[&str]| data.keys().all(|key| allowed.contains(&key.as_str()));
        match self {
            Self::Interrupt => {
                let mut resume = target.query_pairs().filter(|(key, _)| key == "resume");
                if !fields(&["resume"])
                    || data.get("resume").is_some_and(|value| !value.is_boolean())
                    || resume.next().is_some_and(|(_, value)| !matches!(value.as_ref(), "true" | "false"))
                    || resume.next().is_some()
                {
                    return Err(invalid("Invalid interruption request"));
                }
            }
            Self::Permission(_) => {
                if !fields(&["decision", "message"])
                    || !matches!(input["decision"].as_str(), Some("once" | "always" | "reject"))
                    || data.get("message").is_some_and(|v| v.as_str().is_none_or(|s| s.encode_utf16().count() > 4096))
                {
                    return Err(invalid("Invalid permission decision"));
                }
            }
            Self::FormReply(_) if !fields(&["answer"]) => return Err(invalid("Invalid question request")),
            Self::FormCancel(_) if !data.is_empty() => return Err(invalid("Invalid question request")),
            _ => {}
        }
        Ok(())
    }

    pub(super) async fn pending(self, app: &App, endpoint: &Endpoint, session: &str) -> Result<Option<Value>, Error> {
        let permission = matches!(self, Self::Permission(_));
        let (kind, request) = match self {
            Self::Interrupt => return Ok(None),
            Self::Permission(id) => ("permission", id),
            Self::FormReply(id) | Self::FormCancel(id) => ("form", id),
        };
        let (tag, missing) = if permission {
            (
                "PermissionNotFoundError",
                json!({"_tag":"PermissionNotFoundError","requestID":request,
                "message":"Permission is no longer pending for this session"}),
            )
        } else {
            (
                "FormNotFoundError",
                json!({"_tag":"FormNotFoundError","id":request,
                "message":"Question is no longer pending for this session"}),
            )
        };
        let mut url = endpoint.url.clone();
        url.path_segments_mut()
            .map_err(|_| upstream_error())?
            .clear()
            .extend(["api", "session", session, kind, request]);
        let response = app
            .native
            .client
            .get(url)
            .basic_auth("opencode", Some(&endpoint.password))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| upstream_error())?;
        let status = response.status();
        let value = read_json(response, 2 * 1024 * 1024).await.map_err(|_| upstream_error())?;
        if status == Status::NOT_FOUND && value["_tag"] == tag {
            return Err((Status::NOT_FOUND, Json(missing)));
        }
        if !status.is_success() {
            return Err(upstream_error());
        }
        let row = &value["data"];
        if !row.is_object() {
            return Err(upstream_error());
        }
        if row["id"] != request || row["sessionID"] != session {
            return Err((Status::NOT_FOUND, Json(missing)));
        }
        if permission {
            return Ok(Some(row.clone()));
        }
        if row.get("state").is_none_or(Value::is_null) {
            return Err(upstream_error());
        }
        if row["state"]["status"] != "pending" {
            return Err((
                Status::CONFLICT,
                Json(json!({"_tag":"FormAlreadySettledError","id":request,
                "message":"Question is no longer pending for this session"})),
            ));
        }
        Ok(None)
    }
}

#[test]
fn controls_validate_the_native_query_and_exact_body_fields() {
    let url = |query| reqwest::Url::parse(&format!("http://localhost/?{query}")).unwrap();
    let route = "/api/session/s/interrupt";
    let interrupt = classify(route, &Method::POST).unwrap();
    for query in ["", "resume=true", "resume=false"] {
        assert!(interrupt.validate(&json!({}), &url(query)).is_ok());
    }
    for query in ["resume=no", "resume=false&resume=true"] {
        assert_eq!(interrupt.validate(&json!({}), &url(query)).unwrap_err().0, Status::BAD_REQUEST);
    }
    let permission = classify("/api/session/s/permission/p/reply", &Method::POST).unwrap();
    assert!(permission.validate(&json!({"decision":"reject","message":"reason"}), &url("")).is_ok());
    assert!(permission.validate(&json!({"decision":["once"]}), &url("")).is_err());
    assert!(permission.validate(&json!({"decision":"once","message":"💡".repeat(2049)}), &url("")).is_err());
    let cancel = classify("/api/session/s/form/q", &Method::DELETE).unwrap();
    assert!(cancel.validate(&json!({"extra":true}), &url("")).is_err());
    assert!(classify("/api/session/s/form/q/reply/extra", &Method::POST).is_none());
}
