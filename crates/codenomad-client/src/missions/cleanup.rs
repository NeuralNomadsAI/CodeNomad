use super::{
    Cleanup,
    directory::panel_id,
    lifecycle::{CONTROL_TIMEOUT, MAX_REVISION, request_id, request_id_valid},
    stream_json::read_filtered_json,
};
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::Serialize;

const RECONCILE_ROOT_KEYS: &[&str] = &[
    "available",
    "version",
    "projectID",
    "cleanupUnavailable",
    "cleanups",
];
const RECONCILE_MISSION_KEYS: &[&str] = &["id", "projectID", "revision"];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionRequest {
    pub expected_revision: u64,
    pub request_id: String,
    pub delete_managed_sessions: bool,
}

impl DeletionRequest {
    pub fn new(expected_revision: u64, delete_managed_sessions: bool) -> Result<Self> {
        let request = Self {
            expected_revision,
            request_id: request_id()?,
            delete_managed_sessions,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn from_cleanup(cleanup: &Cleanup) -> Result<Self> {
        let request = Self {
            expected_revision: cleanup.expected_revision,
            request_id: cleanup.request_id.clone(),
            delete_managed_sessions: cleanup.delete_managed_sessions,
        };
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<()> {
        if !request_id_valid(&self.request_id)
            || !(1..=MAX_REVISION).contains(&self.expected_revision)
        {
            return Err("invalid Mission deletion request".into());
        }
        Ok(())
    }

    pub fn matches_cleanup(&self, mission_id: &str, cleanup: &Cleanup) -> bool {
        cleanup.mission_id == mission_id
            && cleanup.request_id == self.request_id
            && cleanup.expected_revision == self.expected_revision
            && cleanup.delete_managed_sessions == self.delete_managed_sessions
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeletionCode {
    CleanupPending,
    ControlPending,
    RevisionConflict,
    RequestConflict,
    MissionNotFound,
    ForeignSession,
    ChildSession,
    InvalidDeleteOption,
}

impl DeletionCode {
    fn parse(code: &str) -> Option<Self> {
        Some(match code {
            "cleanup-pending" => Self::CleanupPending,
            "control-pending" => Self::ControlPending,
            "revision-conflict" => Self::RevisionConflict,
            "request-conflict" => Self::RequestConflict,
            "mission-not-found" => Self::MissionNotFound,
            "foreign-session" => Self::ForeignSession,
            "child-session" => Self::ChildSession,
            "invalid-delete-option" => Self::InvalidDeleteOption,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeletionError {
    pub status: u16,
    pub code: Option<DeletionCode>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DeletionOutcome {
    Deleted(Option<Box<Cleanup>>),
    Failed(DeletionError),
    Unconfirmed,
    AuthenticationRequired,
}

impl DeletionOutcome {
    pub fn error_key(&self) -> &'static str {
        match self {
            Self::Failed(DeletionError {
                status: 503,
                code: Some(DeletionCode::CleanupPending),
            }) => "missions.cleanup.error.pending",
            Self::Failed(DeletionError {
                status: 409 | 503,
                code: Some(DeletionCode::ControlPending),
            }) => "missions.cleanup.error.controlPending",
            Self::Failed(DeletionError {
                status: 409,
                code: Some(DeletionCode::RevisionConflict),
            }) => "missions.cleanup.error.revisionConflict",
            Self::Failed(DeletionError {
                status: 409,
                code: Some(DeletionCode::RequestConflict),
            }) => "missions.cleanup.error.requestConflict",
            Self::Failed(DeletionError { status: 403, .. }) => "missions.cleanup.error.forbidden",
            Self::Failed(DeletionError { status: 404, .. }) => "missions.cleanup.error.missing",
            _ => "missions.cleanup.error.unconfirmed",
        }
    }
}

#[derive(Debug)]
pub struct MissionSnapshotRead {
    pub mission_revision: Option<u64>,
    pub cleanups: Vec<Cleanup>,
    pub cleanup_unavailable: bool,
}

impl Backend {
    pub async fn read_mission_reconciliation(
        &self,
        project: &str,
        mission_id: &str,
    ) -> Result<MissionSnapshotRead> {
        let url = mission_url(self, mission_id)?;
        let response = self.client.get(url).send().await?.error_for_status()?;
        let body: serde_json::Value = read_filtered_json(
            response,
            RECONCILE_ROOT_KEYS,
            RECONCILE_MISSION_KEYS,
            4 * 1024 * 1024,
        )
        .await?;
        parse_reconciliation(&body, project, mission_id)
    }

    pub async fn delete_mission(
        &self,
        mission_id: &str,
        request: &DeletionRequest,
        expected_deletion_id: Option<&str>,
        expected_created_at: Option<f64>,
        require_document_settled: bool,
    ) -> Result<DeletionOutcome> {
        request.validate()?;
        if expected_deletion_id.is_some_and(|id| !panel_id(id)) {
            return Err("invalid Mission deletion identifier".into());
        }
        let url = mission_url(self, mission_id)?;
        let response = delete_request(self, url, request).send().await?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED
            && self.authentication_status().await.ok() == Some(false)
        {
            return Ok(DeletionOutcome::AuthenticationRequired);
        }
        let body = read_json_limited(response, 4 * 1024 * 1024)
            .await
            .unwrap_or(serde_json::Value::Null);
        Ok(settle_deletion(
            status,
            &body,
            mission_id,
            request,
            expected_deletion_id,
            expected_created_at,
            require_document_settled,
        ))
    }
}

fn mission_url(backend: &Backend, mission_id: &str) -> Result<reqwest::Url> {
    if !valid_id(&backend.workspace)
        || !panel_id(mission_id)
        || mission_id.encode_utf16().count() > 100
    {
        return Err("invalid Mission target".into());
    }
    let mut url = reqwest::Url::parse(&backend.base)?.join("api/workspaces/")?;
    url.path_segments_mut()
        .map_err(|_| "invalid Mission backend URL")?
        .pop_if_empty()
        .extend([backend.workspace.as_str(), "missions", mission_id]);
    Ok(url)
}

fn delete_request(
    backend: &Backend,
    url: reqwest::Url,
    request: &DeletionRequest,
) -> reqwest::RequestBuilder {
    backend
        .client
        .delete(url)
        .timeout(CONTROL_TIMEOUT)
        .json(request)
}

fn settle_deletion(
    status: reqwest::StatusCode,
    body: &serde_json::Value,
    mission_id: &str,
    request: &DeletionRequest,
    expected_deletion_id: Option<&str>,
    expected_created_at: Option<f64>,
    require_document_settled: bool,
) -> DeletionOutcome {
    if !status.is_success() {
        let code = body["code"].as_str().and_then(DeletionCode::parse);
        return DeletionOutcome::Failed(DeletionError {
            status: status.as_u16(),
            code,
        });
    }
    if body["deleted"] != true {
        return DeletionOutcome::Unconfirmed;
    }
    let require_cleanup = expected_deletion_id.is_some()
        || expected_created_at.is_some()
        || request.delete_managed_sessions
        || require_document_settled;
    match body.get("cleanup") {
        None | Some(serde_json::Value::Null) if !require_cleanup => DeletionOutcome::Deleted(None),
        Some(value) if !value.is_null() => match serde_json::from_value::<Cleanup>(value.clone()) {
            Ok(cleanup)
                if valid_cleanup(&cleanup)
                    && request.matches_cleanup(mission_id, &cleanup)
                    && !cleanup.is_pending()
                    && (!require_document_settled || cleanup.document_pending == Some(false))
                    && expected_deletion_id.is_none_or(|id| cleanup.deletion_id == id)
                    && expected_created_at
                        .is_none_or(|ts| cleanup.created_at.to_bits() == ts.to_bits()) =>
            {
                DeletionOutcome::Deleted(Some(Box::new(cleanup)))
            }
            _ => DeletionOutcome::Unconfirmed,
        },
        _ => DeletionOutcome::Unconfirmed,
    }
}

fn parse_reconciliation(
    body: &serde_json::Value,
    project: &str,
    mission_id: &str,
) -> Result<MissionSnapshotRead> {
    if body["available"] != true || body["version"] != 1 || body["projectID"] != project {
        return Err("unavailable Mission reconciliation read".into());
    }
    let cleanup_unavailable = match body.get("cleanupUnavailable") {
        None | Some(serde_json::Value::Null) => false,
        Some(value) => value
            .as_bool()
            .ok_or("invalid Mission cleanupUnavailable flag")?,
    };
    let mission_revision = match body.get("mission") {
        None | Some(serde_json::Value::Null) => None,
        Some(mission) => {
            if mission["id"] != mission_id || mission["projectID"] != project {
                return Err("mismatched Mission reconciliation map".into());
            }
            let rev = mission["revision"]
                .as_u64()
                .filter(|r| (1..=MAX_REVISION).contains(r))
                .ok_or("invalid Mission reconciliation revision")?;
            Some(rev)
        }
    };
    let cleanups = match body.get("cleanups") {
        Some(value) if value.is_array() => serde_json::from_value::<Vec<Cleanup>>(value.clone())
            .map_err(|_| "invalid Mission reconciliation cleanups")?,
        _ => return Err("missing Mission reconciliation cleanups".into()),
    };
    if mission_revision.is_some() && !cleanups.is_empty() {
        return Err("contradictory Mission reconciliation payload".into());
    }
    let mut deletion_ids = std::collections::HashSet::with_capacity(cleanups.len());
    if cleanups.iter().any(|item| {
        !valid_cleanup(item)
            || item.mission_id != mission_id
            || !deletion_ids.insert(item.deletion_id.as_str())
    }) {
        return Err("invalid Mission cleanup row".into());
    }
    Ok(MissionSnapshotRead {
        mission_revision,
        cleanups,
        cleanup_unavailable,
    })
}

fn valid_cleanup(item: &Cleanup) -> bool {
    panel_id(&item.mission_id)
        && panel_id(&item.deletion_id)
        && request_id_valid(&item.request_id)
        && (1..=MAX_REVISION).contains(&item.expected_revision)
        && item.objective.encode_utf16().count() <= 240
        && item.created_at.is_finite()
        && item.removed <= MAX_REVISION
        && item.retained <= MAX_REVISION
        && item.pending <= MAX_REVISION
        && item.reasons.len() <= 5
        && item.reasons.iter().all(|reason| {
            matches!(
                reason.as_str(),
                "children" | "shared" | "moved" | "identity" | "guarded"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deletion_errors_match_solid_classification() {
        let request = DeletionRequest {
            expected_revision: 5,
            request_id: "req-1".into(),
            delete_managed_sessions: false,
        };
        for (status, code, expected) in [
            (
                503,
                Some("cleanup-pending"),
                "missions.cleanup.error.pending",
            ),
            (
                403,
                Some("cleanup-pending"),
                "missions.cleanup.error.forbidden",
            ),
            (
                409,
                Some("revision-conflict"),
                "missions.cleanup.error.revisionConflict",
            ),
            (
                409,
                Some("request-conflict"),
                "missions.cleanup.error.requestConflict",
            ),
            (
                409,
                Some("control-pending"),
                "missions.cleanup.error.controlPending",
            ),
            (409, None, "missions.cleanup.error.unconfirmed"),
            (
                404,
                Some("mission-not-found"),
                "missions.cleanup.error.missing",
            ),
            (503, None, "missions.cleanup.error.unconfirmed"),
            (
                503,
                Some("control-pending"),
                "missions.cleanup.error.controlPending",
            ),
        ] {
            let outcome = settle_deletion(
                reqwest::StatusCode::from_u16(status).unwrap(),
                &code.map_or_else(|| json!({}), |c| json!({"code": c})),
                "msn-1",
                &request,
                None,
                None,
                false,
            );
            assert_eq!(outcome.error_key(), expected, "{status} {code:?}");
        }
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true}),
                "msn-1",
                &request,
                None,
                None,
                false,
            ),
            DeletionOutcome::Deleted(None)
        );
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": false}),
                "msn-1",
                &request,
                None,
                None,
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
        let settled_cleanup = json!({
            "missionID": "msn-1", "deletionID": "del-1", "requestID": "req-1",
            "expectedRevision": 5, "deleteManagedSessions": false,
            "objective": "Obj", "createdAt": 1, "removed": 1, "retained": 0,
            "pending": 0, "reasons": [], "documentPending": false
        });
        assert!(matches!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": settled_cleanup}),
                "msn-1",
                &request,
                Some("del-1"),
                Some(1.0),
                true,
            ),
            DeletionOutcome::Deleted(Some(ref cleanup)) if cleanup.deletion_id == "del-1" && cleanup.removed == 1
        ));
        let mut wrong_created_at = settled_cleanup.clone();
        wrong_created_at["createdAt"] = json!(2);
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": wrong_created_at}),
                "msn-1",
                &request,
                Some("del-1"),
                Some(1.0),
                true,
            ),
            DeletionOutcome::Unconfirmed
        );
        let mut oversized_objective = settled_cleanup.clone();
        oversized_objective["objective"] = json!("x".repeat(241));
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": oversized_objective}),
                "msn-1",
                &request,
                Some("del-1"),
                Some(1.0),
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
        let mut invalid_reasons = settled_cleanup.clone();
        invalid_reasons["reasons"] = json!(["unknown-reason"]);
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": invalid_reasons}),
                "msn-1",
                &request,
                Some("del-1"),
                Some(1.0),
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
        let mut omitted_doc_pending = settled_cleanup.clone();
        omitted_doc_pending
            .as_object_mut()
            .unwrap()
            .remove("documentPending");
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": omitted_doc_pending}),
                "msn-1",
                &request,
                Some("del-1"),
                Some(1.0),
                true,
            ),
            DeletionOutcome::Unconfirmed
        );
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true}),
                "msn-1",
                &request,
                Some("del-1"),
                None,
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": settled_cleanup}),
                "msn-1",
                &request,
                Some("del-other"),
                None,
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
        let managed = DeletionRequest {
            expected_revision: 5,
            request_id: "req-1".into(),
            delete_managed_sessions: true,
        };
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true}),
                "msn-1",
                &managed,
                None,
                None,
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
        let mut wrong_req = settled_cleanup.clone();
        wrong_req["requestID"] = json!("other-req");
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": wrong_req}),
                "msn-1",
                &request,
                None,
                None,
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
        let mut still_pending = settled_cleanup;
        still_pending["pending"] = json!(1);
        assert_eq!(
            settle_deletion(
                reqwest::StatusCode::OK,
                &json!({"deleted": true, "cleanup": still_pending}),
                "msn-1",
                &request,
                None,
                None,
                false,
            ),
            DeletionOutcome::Unconfirmed
        );
    }

    #[test]
    fn reconciliation_read_validates_project_mission_and_cleanups() {
        let live = json!({
            "available": true,
            "version": 1,
            "projectID": "proj",
            "generatedAt": 1,
            "mission": {"id": "msn-1", "projectID": "proj", "revision": 5},
            "cleanups": []
        });
        let read = parse_reconciliation(&live, "proj", "msn-1").unwrap();
        assert_eq!(read.mission_revision, Some(5));
        assert!(!read.cleanup_unavailable);
        assert!(read.cleanups.is_empty());

        let tombstoned = json!({
            "available": true,
            "version": 1,
            "projectID": "proj",
            "generatedAt": 1,
            "cleanups": [{
                "missionID": "msn-1", "deletionID": "del-1", "requestID": "req-1",
                "expectedRevision": 5, "deleteManagedSessions": false,
                "objective": "Obj", "createdAt": 1, "removed": 0, "retained": 1,
                "pending": 0, "reasons": ["children"], "documentPending": true
            }]
        });
        let read = parse_reconciliation(&tombstoned, "proj", "msn-1").unwrap();
        assert_eq!(read.mission_revision, None);
        assert!(!read.cleanup_unavailable);
        assert_eq!(read.cleanups.len(), 1);
        assert!(read.cleanups[0].is_pending());

        let mut contradictory = tombstoned.clone();
        contradictory["mission"] = json!({"id": "msn-1", "projectID": "proj", "revision": 5});
        assert!(parse_reconciliation(&contradictory, "proj", "msn-1").is_err());

        assert!(parse_reconciliation(&live, "other", "msn-1").is_err());
        assert!(parse_reconciliation(&live, "proj", "other").is_err());
        let mut unavailable = live.clone();
        unavailable["available"] = json!(false);
        assert!(parse_reconciliation(&unavailable, "proj", "msn-1").is_err());

        let mut bad_flag = tombstoned.clone();
        bad_flag["cleanupUnavailable"] = json!("yes");
        assert!(parse_reconciliation(&bad_flag, "proj", "msn-1").is_err());

        let mut foreign_cleanup = tombstoned.clone();
        foreign_cleanup["cleanups"][0]["missionID"] = json!("msn-foreign");
        assert!(parse_reconciliation(&foreign_cleanup, "proj", "msn-1").is_err());

        let mut dup = tombstoned;
        let row = dup["cleanups"][0].clone();
        dup["cleanups"].as_array_mut().unwrap().push(row);
        assert!(parse_reconciliation(&dup, "proj", "msn-1").is_err());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn large_compact_reconciliation_over_4_mib_is_read() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let prefix = br#"{"available":true,"version":1,"projectID":"proj","generatedAt":1,"mission":{"id":"msn-big","projectID":"proj","revision":7,"tasks":[{"brief":""#;
                let suffix = br#""}]},"cleanups":[]}"#;
                let chunk = vec![b'b'; 64 * 1024];
                let chunk_count = 80usize; // 5 MiB of unselected compact map fields
                let total_len = prefix.len() + chunk.len() * chunk_count + suffix.len();
                assert!(total_len > 4 * 1024 * 1024);

                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut req = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        req.extend_from_slice(&buf[..n]);
                    }
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {total_len}\r\nConnection: close\r\n\r\n"
                    );
                    socket.write_all(head.as_bytes()).await.unwrap();
                    socket.write_all(prefix).await.unwrap();
                    for _ in 0..chunk_count {
                        socket.write_all(&chunk).await.unwrap();
                    }
                    socket.write_all(suffix).await.unwrap();
                });

                let mut backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
                backend.workspace = "owned".into();
                let snapshot = backend
                    .read_mission_reconciliation("proj", "msn-big")
                    .await
                    .unwrap();
                assert_eq!(snapshot.mission_revision, Some(7));
                assert!(snapshot.cleanups.is_empty());
                assert!(!snapshot.cleanup_unavailable);
                server.await.unwrap();
            });
    }
}
