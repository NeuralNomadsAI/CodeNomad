//! Mission calendar request contract shared by the calendar routes: permits
//! (holds), the reference error bodies and strict native receipt validation.
use crate::{Error, Workspace, error, files, missions::run::directory, opencode::Endpoint, worktrees::fence};
use axum::{Json, http::StatusCode as Status};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
pub struct ClaimBinding {
    pub proof: Value,
    pub principal: CancellationToken,
    pub physical: String,
    pub project: String,
    pub canonical: String,
    pub endpoint: Arc<Endpoint>,
}
pub type Claims = Mutex<HashMap<String, Arc<ClaimBinding>>>;
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
    pub(crate) endpoint: Arc<Endpoint>,
    pub(crate) permit: Arc<fence::Entered>,
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
            && (raw["document"].is_null() && self.action == "delete" || raw["document"]["control"]["pending"] == false)
    }
}
pub(crate) const ACTIONS: [&str; 9] =
    ["create", "configure", "play", "pause", "resume", "stop", "check", "run-now", "delete"];
const REFUSALS: [&str; 6] = [
    "revision-conflict",
    "control-conflict",
    "date-passed",
    "coordinator-busy",
    "coordinator-owned",
    "coordinator-is-source",
];
pub(crate) const HOLD_CAPACITY: usize = 128;
pub(crate) fn bad() -> Error {
    error(Status::BAD_REQUEST, "Invalid fixture calendar request")
}
pub(crate) fn unavailable() -> Error {
    error(Status::SERVICE_UNAVAILABLE, "Mission calendar unavailable")
}
pub(crate) fn input_invalid() -> Error {
    (Status::BAD_REQUEST, Json(json!({"error":"Invalid Mission schedule request","code":"schedule-input-invalid"})))
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
    (Status::UNAUTHORIZED, Json(json!({"error":"Human authentication required","code":"schedule-human-required"})))
}
/// Reference `resultSchema`: a strict control receipt or none.
pub(crate) fn valid_result(result: &Value, mid: &str) -> bool {
    let Some(doc) = result.get("document") else {
        return false;
    };
    let control = &doc["control"];
    result["pending"].is_boolean()
        && result.get("deleted").is_none_or(Value::is_boolean)
        && result.get("refusal").is_none_or(valid_refusal)
        && (doc.is_null()
            || doc["id"] == mid
                && (doc.get("control") == Some(&Value::Null)
                    || control.as_object().is_some_and(|c| c.len() == 4)
                        && control["requestID"].as_str().is_some_and(good)
                        && counter(&control["expectedRevision"])
                        && action(&control["action"], true)
                        && control["pending"].is_boolean()))
}

fn counter(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= crate::missions::recurrence_contract::SAFE)
}

fn action(v: &Value, reconcile: bool) -> bool {
    v.as_str().is_some_and(|a| ACTIONS.contains(&a) || reconcile && a == "reconcile")
}

fn valid_refusal(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.len() == 6)
        && v["missionID"].as_str().is_some_and(good)
        && v["requestID"].as_str().is_some_and(good)
        && counter(&v["expectedRevision"])
        && action(&v["action"], false)
        && v["payloadDigest"]
            .as_str()
            .is_some_and(|d| d.len() == 64 && d.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
        && v["reason"].as_str().is_some_and(|r| REFUSALS.contains(&r))
}

pub(crate) fn exact_refusal(raw: &Value, mid: &str, request: &str, revision: u64, action: &str, digest: &str) -> bool {
    let r = &raw["refusal"];
    raw["pending"] == false
        && valid_refusal(r)
        && r["missionID"] == mid
        && r["requestID"] == request
        && r["expectedRevision"] == revision
        && r["action"] == action
        && r["payloadDigest"] == digest
}
/// The activation route keeps its own unconfirmed reply.
pub(crate) fn activation_pending() -> Error {
    (
        Status::SERVICE_UNAVAILABLE,
        Json(
            json!({"error":"Original Mission calendar request remains unconfirmed","code":"schedule-pending","pending":true}),
        ),
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
            endpoint: Arc::new(Endpoint {
                url: "http://127.0.0.1:1/".parse().unwrap(),
                password: String::new(),
                version: String::new(),
                pid: 0,
            }),
            permit: Arc::new(fence::enter(&["/schedule-contract-test".into()]).unwrap()),
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

    #[tokio::test]
    async fn an_unknown_control_retains_its_physical_admission() {
        let directory = "/schedule-hold-test/project".to_owned();
        let mut original = hold("pause");
        original.permit = Arc::new(fence::enter(std::slice::from_ref(&directory)).unwrap());
        let retained = original.clone();
        drop(original); // request/observer disconnected
        let paths = [directory.clone()];
        let deletion = fence::block(&paths);
        tokio::pin!(deletion);
        assert!(futures_util::poll!(&mut deletion).is_pending());
        assert!(fence::enter(&paths).is_none(), "retry on a replaced connection cannot enter a waiting deletion");
        drop(retained);
        let _blocked = deletion.await.unwrap();
    }

    #[test]
    fn native_receipts_are_strict() {
        assert!(valid_result(&json!({"pending":false,"document":null}), "msn_a"));
        assert!(valid_result(&json!({"pending":true,"document":{"id":"msn_a","control":null}}), "msn_a"));
        let control = |action: &str| {
            json!({"pending":false,"document":{"id":"msn_a","control":{
            "requestID":"req_1","expectedRevision":0,"action":action,"pending":false}}})
        };
        assert!(valid_result(&control("reconcile"), "msn_a"));
        assert!(!valid_result(&control("explode"), "msn_a"));
        let mut extra = control("play");
        extra["document"]["control"]["more"] = json!(1);
        assert!(!valid_result(&extra, "msn_a"));
        assert!(!valid_result(&json!({"document":null}), "msn_a"), "pending required");
        assert!(!valid_result(&json!({"pending":false}), "msn_a"), "explicit document required");
        assert!(
            !valid_result(&json!({"pending":false,"document":{"id":"msn_a"}}), "msn_a"),
            "explicit control required"
        );
        assert!(!valid_result(&json!({"pending":false,"document":{"id":"msn_b","control":null}}), "msn_a"));
    }

    #[test]
    fn only_a_known_and_exact_native_refusal_proves_no_effect() {
        let digest = "a".repeat(64);
        let mut raw = json!({"pending":false,"document":null,"refusal":{
            "missionID":"msn_a","requestID":"req_1","expectedRevision":0,
            "action":"create","payloadDigest":digest,"reason":"coordinator-owned"}});
        let exact = |r: &Value| exact_refusal(r, "msn_a", "req_1", 0, "create", &digest);
        for reason in REFUSALS {
            raw["refusal"]["reason"] = json!(reason);
            assert!(valid_result(&raw, "msn_a"));
            assert!(exact(&raw));
        }
        for (field, value) in [
            ("missionID", json!("msn_b")),
            ("requestID", json!("req_2")),
            ("expectedRevision", json!(1)),
            ("action", json!("configure")),
            ("payloadDigest", json!("b".repeat(64))),
            ("reason", json!("unqualified")),
            ("extra", json!(true)),
        ] {
            let mut changed = raw.clone();
            changed["refusal"][field] = value;
            assert!(!exact(&changed), "{field}");
        }
        raw["pending"] = json!(true);
        assert!(!exact(&raw));
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
