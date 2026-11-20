//! Mission calendar request contract shared by the calendar routes: permits
//! (holds), the reference error bodies and strict native receipt validation.
use crate::{Error, Workspace, error, missions::run::directory, files};
use axum::{Json, http::StatusCode as Status};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex};
use tokio_util::sync::CancellationToken;
pub type Claims = Mutex<HashMap<String, (Value, CancellationToken, String)>>;
pub type Holds = Mutex<HashMap<String, Hold>>;
/// Reference `mission-scheduled-holds.ts`: a physical permit kept until an
/// exact receipt or an exact initial refusal settles it. In memory only, like
/// the reference; after a restart the native journal's idempotence decides.
#[derive(Clone)]
pub struct Hold {
    pub(crate) request: String,
    pub(crate) action: String,
    pub(crate) revision: u64,
    /// `missionCreationDigest([requestID, expectedRevision, action, payloadDigest])`.
    pub(crate) identity: String,
    pub(crate) delete_managed: bool,
    pub(crate) workspace: String,
    pub(crate) project: String,
    pub(crate) canonical: String,
    pub(crate) directory: String,
    pub(crate) physical: String,
    pub(crate) dispatched: bool,
    pub(crate) busy: bool,
    pub(crate) retried: bool,
}
impl Hold {
    pub(crate) fn owned_by(&self, w: &Workspace, project: &str, canonical: &str) -> bool {
        directory(w).ok() == Some(&self.directory)
            && w.id.to_string() == self.workspace
            && self.project == project
            && self.canonical == canonical
            && files::host_identity(&w.path).ok().as_ref() == Some(&self.physical)
    }
    /// The exact original receipt, settled or partial.
    pub(crate) fn exact(&self, mid: &str, raw: &Value) -> bool {
        if self.action == "delete" && raw["document"].is_null() {
            let d = &raw["deletionReceipt"];
            return d["id"] == mid
                && d["requestID"] == self.request.as_str()
                && d["expectedRevision"] == self.revision
                && d["deleteManagedSessions"] == self.delete_managed;
        }
        let c = &raw["document"]["control"];
        raw["document"]["id"] == mid
            && c["requestID"] == self.request.as_str()
            && c["action"] == self.action.as_str()
            && c["expectedRevision"] == self.revision
            && c["pending"].is_boolean()
    }
    pub(crate) fn settles(&self, mid: &str, raw: &Value) -> bool {
        self.dispatched
            && self.exact(mid, raw)
            && raw["pending"] == false
            && (raw["document"].is_null() && self.action == "delete"
                || raw["document"]["control"]["pending"] == false)
    }
}
pub(crate) const ACTIONS: [&str; 9] = [
    "create", "configure", "play", "pause", "resume", "stop", "check", "run-now", "delete",
];
pub(crate) const HOLD_CAPACITY: usize = 128;
pub(crate) fn bad() -> Error {
    error(Status::BAD_REQUEST, "Invalid fixture calendar request")
}
pub(crate) fn unavailable() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Mission calendar unavailable")
}
pub(crate) fn input_invalid() -> Error {
    (
        Status::BAD_REQUEST,
        Json(json!({"error":"Invalid Mission schedule request","code":"schedule-input-invalid"})),
    )
}
pub(crate) fn config_invalid() -> Error {
    (
        Status::BAD_REQUEST,
        Json(json!({"error":"Invalid Mission schedule configuration","code":"schedule-input-invalid"})),
    )
}
pub(crate) fn with_mission(mut body: Value, mid: Option<&str>) -> Value {
    if let Some(mid) = mid {
        body["missionID"] = json!(mid);
    }
    body
}
/// 503 `schedule-pending`, carrying the exact native receipt when one was read.
pub(crate) fn pending(mid: Option<&str>, result: Option<&Value>) -> Error {
    let mut body = result.filter(|r| r.is_object()).cloned().unwrap_or_else(|| json!({}));
    body["pending"] = json!(true);
    body["error"] = json!("Mission schedule action remains unconfirmed");
    body["code"] = json!("schedule-pending");
    (Status::SERVICE_UNAVAILABLE, Json(with_mission(body, mid)))
}
pub(crate) fn unconfirmed(status: Status, mid: Option<&str>) -> Error {
    (
        status,
        Json(with_mission(
            json!({"pending":true,"error":"Mission schedule action remains unconfirmed","code":"schedule-unconfirmed"}),
            mid,
        )),
    )
}
pub(crate) fn refused(mid: &str, result: &Value) -> Error {
    let mut body = result.clone();
    body["error"] = json!("Mission schedule action refused");
    body["code"] = json!("schedule-refused");
    (Status::CONFLICT, Json(with_mission(body, Some(mid))))
}
pub(crate) fn human_required() -> Error {
    (
        Status::UNAUTHORIZED,
        Json(json!({"error":"Human authentication required","code":"schedule-human-required"})),
    )
}
/// Reference `resultSchema`: a strict control receipt or none.
pub(crate) fn valid_result(result: &Value, mid: &str) -> bool {
    let doc = &result["document"];
    let control = &doc["control"];
    result["pending"].is_boolean()
        && result.get("deleted").is_none_or(Value::is_boolean)
        && (doc.is_null()
            || doc["id"] == mid
                && (control.is_null()
                    || control.as_object().is_some_and(|c| c.len() == 4)
                        && control["requestID"].as_str().is_some_and(good)
                        && control["expectedRevision"].is_u64()
                        && control["action"].as_str().is_some_and(|a| ACTIONS.contains(&a) || a == "reconcile")
                        && control["pending"].is_boolean()))
}
/// The activation route keeps its own unconfirmed reply.
pub(crate) fn activation_pending() -> Error {
    (
        Status::SERVICE_UNAVAILABLE,
        Json(json!({"error":"Original Mission calendar request remains unconfirmed","code":"schedule-pending","pending":true})),
    )
}
pub(crate) fn good(s: &str) -> bool {
    (3..=100).contains(&s.len()) && crate::opencode::valid_id(s)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn hold(action: &str) -> Hold {
        Hold {
            request: "req_1".into(),
            action: action.into(),
            revision: 3,
            identity: "x".into(),
            delete_managed: false,
            workspace: "w".into(),
            project: "p".into(),
            canonical: "c".into(),
            directory: "d".into(),
            physical: "h".into(),
            dispatched: true,
            busy: false,
            retried: false,
        }
    }

    #[test]
    fn only_the_exact_completed_receipt_settles_a_permit() {
        let play = hold("play");
        let receipt = |pending: bool, control_pending: bool, request: &str| {
            json!({"pending":pending,"document":{"id":"msn_a","control":{
                "requestID":request,"expectedRevision":3,"action":"play","pending":control_pending}}})
        };
        assert!(play.settles("msn_a", &receipt(false, false, "req_1")));
        assert!(!play.settles("msn_a", &receipt(true, true, "req_1")), "partial receipt");
        assert!(play.exact("msn_a", &receipt(true, true, "req_1")));
        assert!(!play.settles("msn_a", &receipt(false, false, "req_2")), "foreign request");
        assert!(!play.settles("msn_b", &receipt(false, false, "req_1")), "foreign document");
        let undispatched = Hold { dispatched: false, ..hold("play") };
        assert!(!undispatched.settles("msn_a", &receipt(false, false, "req_1")));
    }

    #[test]
    fn deletion_settles_only_on_its_exact_tombstone() {
        let delete = hold("delete");
        let tomb = json!({"pending":false,"document":null,"deleted":true,"deletionReceipt":{
            "id":"msn_a","requestID":"req_1","expectedRevision":3,"deleteManagedSessions":false}});
        assert!(delete.settles("msn_a", &tomb));
        assert!(!delete.settles("msn_a", &json!({"pending":false,"document":null,"deleted":true})));
        let mut managed = tomb.clone();
        managed["deletionReceipt"]["deleteManagedSessions"] = json!(true);
        assert!(!delete.settles("msn_a", &managed));
    }

    #[test]
    fn native_receipts_are_strict() {
        assert!(valid_result(&json!({"pending":false,"document":null}), "msn_a"));
        assert!(valid_result(&json!({"pending":true,"document":{"id":"msn_a","control":null}}), "msn_a"));
        let control = |action: &str| json!({"pending":false,"document":{"id":"msn_a","control":{
            "requestID":"req_1","expectedRevision":0,"action":action,"pending":false}}});
        assert!(valid_result(&control("reconcile"), "msn_a"));
        assert!(!valid_result(&control("explode"), "msn_a"));
        let mut extra = control("play");
        extra["document"]["control"]["more"] = json!(1);
        assert!(!valid_result(&extra, "msn_a"));
        assert!(!valid_result(&json!({"document":null}), "msn_a"), "pending required");
        assert!(!valid_result(&json!({"pending":false,"document":{"id":"msn_b","control":null}}), "msn_a"));
    }

    #[test]
    fn unconfirmed_replies_use_the_reference_codes() {
        let (status, Json(body)) = pending(Some("msn_a"), Some(&json!({"pending":true,"document":null})));
        assert_eq!(status, Status::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "schedule-pending");
        assert_eq!(body["missionID"], "msn_a");
        assert_eq!(body["pending"], true);
        let (status, Json(body)) = refused("msn_a", &json!({"pending":false,"refusal":{}}));
        assert_eq!((status, body["code"].as_str()), (Status::CONFLICT, Some("schedule-refused")));
        assert_eq!(unconfirmed(Status::CONFLICT, None).1.0["code"], "schedule-unconfirmed");
    }
}
