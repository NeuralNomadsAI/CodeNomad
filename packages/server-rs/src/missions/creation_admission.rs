//! One-time Mission creation options of the reference pipeline
//! (`mission-creation-pipeline.ts`, `mission-creation.ts`): followed
//! conversations, the task mode and an explicit coordinator. Their business
//! policy (catalog, membership, execution, followed sources) stays native.
use crate::{App, Error, Workspace};
use axum::{Json, http::{Method, StatusCode as Status}};
use serde_json::{Value, json};

/// `missionCreationRequestSchema` refusal.
pub fn invalid() -> Error {
    (Status::BAD_REQUEST, Json(json!({"error":"Invalid mission creation request"})))
}
/// A preparation failure that is not a declared refusal.
pub fn unavailable() -> Error {
    (Status::SERVICE_UNAVAILABLE, Json(json!({"error":"Mission creation unavailable","code":"creation-unavailable"})))
}
fn foreign_coordinator() -> Error {
    (Status::FORBIDDEN, Json(json!({"error":"Coordinator session does not belong to workspace project"})))
}

/// `nativeDocumentID`: 1–240 characters of `[A-Za-z0-9_.:-]`.
fn native_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 240 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}
/// JavaScript `String.prototype.trim` whitespace (zod `.trim()`).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

pub struct Options {
    pub task_mode: &'static str,
    pub watched: Option<Vec<String>>,
    pub coordinator: Option<String>,
}
/// The schema's `taskMode`, `watchedConversationIDs` and trimmed `coordinatorSessionId`.
pub fn options(task_mode: Option<&str>, watched: Option<Vec<String>>, coordinator: Option<&str>) -> Result<Options, Error> {
    let task_mode = match task_mode {
        None | Some("native") => "native",
        Some("independent") => "independent",
        Some(_) => return Err(invalid()),
    };
    if let Some(ids) = &watched {
        let unique = ids.iter().enumerate().all(|(i, x)| !ids[..i].contains(x));
        if ids.len() > 32 || !unique || !ids.iter().all(|id| native_id(id)) {
            return Err(invalid());
        }
    }
    let coordinator = match coordinator.map(js_trim) {
        None => None,
        Some(c) if c.is_empty() || c.encode_utf16().count() > 240 => return Err(invalid()),
        Some(c) => Some(c.to_owned()),
    };
    Ok(Options { task_mode, watched, coordinator })
}

/// The explicit coordinator: the exact native root of this project in an owned
/// Location. A failed read is no verdict (503); any mismatch is foreign (403).
/// This prototype's lifecycle bridge serves coordinators of the workspace's own
/// Location only, so a coordinator in a linked worktree is refused as foreign.
pub async fn coordinator(app: &App, w: &Workspace, project: &str, id: &str) -> Result<Value, Error> {
    if !crate::opencode::valid_id(id) {
        return Err(unavailable());
    }
    let row = crate::opencode::session_record(app, id).await.map_err(|_| unavailable())?;
    let directory = row["location"]["directory"].as_str().unwrap_or_default();
    let here = w.location["directory"] == directory
        && dunce::canonicalize(directory).ok().as_ref() == Some(&w.path)
        && row["location"].as_object().is_some_and(|l| l.len() == 1);
    if row["id"] != id || !row["parentID"].is_null() || row["projectID"] != project || !here {
        return Err(foreign_coordinator());
    }
    Ok(row["location"].clone())
}

/// `missionMutationStatus`: declared native rejections and their statuses.
fn rejection_status(code: &str) -> Option<Status> {
    Some(match code {
        "control-pending" | "cleanup-pending" | "recovery-unknown" => Status::SERVICE_UNAVAILABLE,
        "document-unavailable" | "control-conflict" | "recovery-conflict" | "recovery-busy" | "mission-not-running"
        | "revision-conflict" | "request-conflict" | "already-member" | "mission-finished" => Status::CONFLICT,
        "invalid-delete-option" | "invalid-execution" => Status::BAD_REQUEST,
        "mission-not-found" | "mission-deleted" | "session-not-found" => Status::NOT_FOUND,
        "foreign-session" | "child-session" => Status::FORBIDDEN,
        _ => return None,
    })
}
/// `readMissionMutationError` over the native RPC error body.
pub fn rejection(body: &Value) -> Option<Error> {
    let code = body["data"]["code"].as_str()?;
    let message = body["message"].as_str()?;
    if body["type"] != "mission.rejected" || message.encode_utf16().count() > 4096 {
        return None;
    }
    let status = rejection_status(code)?;
    Some((status, Json(json!({"error":message,"code":code}))))
}

/// A dispatched creation without its exact acknowledgement or no-effect proof.
pub fn uncertain() -> Error {
    (Status::CONFLICT, Json(json!({"error":"Mission creation settlement is unknown; deletion remains blocked","code":"creation-uncertain"})))
}
/// `isMissionCreateNoEffectError`: the exact request-conflict receipt of this request.
fn no_effect(body: &Value, request: &str, mission: &str) -> bool {
    let receipt = &body["data"]["noEffect"];
    body["data"]["code"] == "request-conflict"
        && receipt.as_object().is_some_and(|r| r.len() == 2)
        && receipt["requestID"] == request
        && receipt["missionID"] == mission
}

/// The dispatched native `create`: its output, or the declared rejection
/// carrying an exact no-effect receipt. Any other failure after dispatch is
/// uncertain, as in the reference.
pub async fn create(app: &App, dir: &str, input: Value, mission: &str) -> Result<Value, Error> {
    let failed = uncertain;
    let request = input["requestID"].as_str().unwrap_or_default().to_owned();
    let url = app.native.url.join("/api/rpc/codenomad.missions/create").map_err(|_| failed())?;
    let res = app
        .native
        .request(Method::POST, url)
        .query(&[("location[directory]", dir)])
        .json(&json!({"input":input}))
        .timeout(std::time::Duration::from_secs(85))
        .send()
        .await
        .map_err(|_| failed())?;
    let status = res.status();
    let body = crate::opencode::read_json(res, 4 * 1024 * 1024).await.map_err(|_| failed())?;
    if !status.is_success() {
        return Err(if no_effect(&body, &request, mission) { rejection(&body) } else { None }.unwrap_or_else(failed));
    }
    body.get("output").cloned().ok_or_else(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_options_follow_the_reference_schema() {
        let ok = |m: Option<&str>, w: Option<Vec<&str>>, c: Option<&str>| {
            options(m, w.map(|w| w.into_iter().map(str::to_owned).collect()), c).is_ok()
        };
        assert!(ok(None, None, None));
        assert!(ok(Some("independent"), Some(vec!["ses_a", "ses.b:c-d"]), Some("  ses_x  ")));
        assert_eq!(options(None, None, Some(" ses_x ")).ok().unwrap().coordinator.as_deref(), Some("ses_x"));
        assert!(!ok(Some("other"), None, None));
        assert!(!ok(None, Some(vec!["ses_a", "ses_a"]), None), "unique");
        assert!(!ok(None, Some(vec!["bad/id"]), None));
        assert!(!ok(None, Some(vec![""]), None));
        assert!(!ok(None, Some(vec![" ses_a "]), None), "followed IDs are not trimmed");
        let many: Vec<String> = (0..33).map(|i| format!("ses_{i}")).collect();
        assert!(options(None, Some(many[..32].to_vec()), None).is_ok());
        assert!(options(None, Some(many), None).is_err());
        assert!(!ok(None, None, Some("   ")));
        assert!(!ok(None, None, Some(&"x".repeat(241))));
        assert_eq!(invalid().1.0, json!({"error":"Invalid mission creation request"}));
    }

    #[test]
    fn declared_native_rejections_keep_their_status_message_and_code() {
        let body = |code: &str| json!({"type":"mission.rejected","message":"Coordinator session already belongs to an active mission","data":{"code":code}});
        let (status, Json(value)) = rejection(&body("already-member")).unwrap();
        assert_eq!(status, Status::CONFLICT);
        assert_eq!(value, json!({"error":"Coordinator session already belongs to an active mission","code":"already-member"}));
        assert_eq!(rejection(&body("invalid-execution")).unwrap().0, Status::BAD_REQUEST);
        assert_eq!(rejection(&body("child-session")).unwrap().0, Status::FORBIDDEN);
        assert_eq!(rejection(&body("session-not-found")).unwrap().0, Status::NOT_FOUND);
        assert!(rejection(&body("unknown-code")).is_none());
        assert!(rejection(&json!({"type":"rpc.internal","message":"x","data":{"code":"already-member"}})).is_none());
        assert!(rejection(&json!({"type":"mission.rejected","data":{"code":"already-member"}})).is_none());
    }

    #[test]
    fn only_an_exact_no_effect_receipt_is_a_refusal_after_dispatch() {
        let body = |receipt: Value| json!({"type":"mission.rejected","message":"Mission request conflict",
            "data":{"code":"request-conflict","noEffect":receipt}});
        assert!(no_effect(&body(json!({"requestID":"req","missionID":"msn_a"})), "req", "msn_a"));
        assert!(!no_effect(&body(json!({"requestID":"req","missionID":"msn_b"})), "req", "msn_a"));
        assert!(!no_effect(&body(json!({"requestID":"other","missionID":"msn_a"})), "req", "msn_a"));
        assert!(!no_effect(&body(json!({"requestID":"req","missionID":"msn_a","extra":1})), "req", "msn_a"));
        let member = json!({"type":"mission.rejected","message":"x","data":{"code":"already-member"}});
        assert!(!no_effect(&member, "req", "msn_a"), "a declared rejection after dispatch stays uncertain");
        assert_eq!(uncertain().1.0["code"], "creation-uncertain");
    }
}
