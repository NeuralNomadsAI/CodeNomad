use super::{
    LifecycleTarget,
    directory::panel_id,
    lifecycle::{CONTROL_TIMEOUT, MAX_REVISION},
    stream_json::read_filtered_json,
};
use crate::{
    backend::Backend,
    history::{Result, valid_id},
};
use serde::{Deserialize, Serialize};

const RECOVERY_KEPT_LIMIT: usize = 4 * 1024 * 1024;
const RECOVERY_ROOT_KEYS: &[&str] = &["admitted", "code"];
const RECOVERY_MISSION_KEYS: &[&str] = &[
    "id",
    "projectID",
    "projectCanonical",
    "coordinatorSessionId",
    "revision",
    "actors",
];

#[derive(Default, Deserialize)]
struct RecoveryBody {
    #[serde(default)]
    admitted: bool,
    code: Option<String>,
    mission: Option<RecoveryMission>,
}

#[derive(Deserialize)]
struct RecoveryMission {
    id: Option<String>,
    #[serde(rename = "projectID")]
    project_id: Option<String>,
    #[serde(rename = "projectCanonical")]
    project_canonical: Option<String>,
    #[serde(rename = "coordinatorSessionId")]
    coordinator_session_id: Option<String>,
    revision: Option<u64>,
    #[serde(default)]
    actors: Vec<RecoveryActor>,
}

#[derive(Deserialize)]
struct RecoveryActor {
    kind: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    location: Option<RecoveryLocation>,
}

#[derive(Deserialize)]
struct RecoveryLocation {
    directory: Option<String>,
    #[serde(rename = "workspaceID")]
    workspace_id: Option<String>,
}

impl RecoveryMission {
    fn matches(&self, target: &LifecycleTarget) -> bool {
        self.id.as_deref() == Some(target.mission.as_str())
            && self.project_id.as_deref() == Some(target.project.as_str())
            && self.project_canonical.as_deref() == Some(target.canonical.as_str())
            && self.coordinator_session_id.as_deref() == Some(target.coordinator.as_str())
            && target
                .coordinator_location
                .as_ref()
                .is_none_or(|(directory, workspace)| {
                    self.actors.iter().any(|actor| {
                        actor.kind.as_deref() == Some("coordinator")
                            && actor.session_id.as_deref() == Some(target.coordinator.as_str())
                            && actor.location.as_ref().is_some_and(|loc| {
                                loc.directory.as_deref() == Some(directory.as_str())
                                    && loc.workspace_id.as_deref() == workspace.as_deref()
                            })
                    })
                })
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum RecoveryTarget {
    Coordinator,
    Report { task_key: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryRequest {
    pub expected_revision: u64,
    pub target: RecoveryTarget,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRecovery<'a> {
    expected_revision: u64,
    target: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_key: Option<&'a str>,
}

impl RecoveryRequest {
    pub fn new(expected_revision: u64, target: RecoveryTarget) -> Result<Self> {
        let request = Self {
            expected_revision,
            target,
        };
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<()> {
        if !(1..=MAX_REVISION).contains(&self.expected_revision) {
            return Err("invalid Mission recovery revision".into());
        }
        if let RecoveryTarget::Report { task_key } = &self.target
            && (task_key.trim().is_empty()
                || task_key.chars().count() > 100
                || task_key.contains('\0'))
        {
            return Err("invalid Mission recovery task key".into());
        }
        Ok(())
    }

    fn wire(&self) -> WireRecovery<'_> {
        match &self.target {
            RecoveryTarget::Coordinator => WireRecovery {
                expected_revision: self.expected_revision,
                target: "coordinator",
                task_key: None,
            },
            RecoveryTarget::Report { task_key } => WireRecovery {
                expected_revision: self.expected_revision,
                target: "report",
                task_key: Some(task_key.as_str()),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryError {
    Busy,
    Unknown,
    Conflict,
    Member,
    Failed,
}

impl RecoveryError {
    pub fn key(self) -> &'static str {
        match self {
            Self::Busy => "missions.recovery.error.busy",
            Self::Unknown => "missions.recovery.error.unknown",
            Self::Conflict => "missions.recovery.error.conflict",
            Self::Member => "missions.recovery.error.member",
            Self::Failed => "missions.recovery.error.failed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryOutcome {
    Admitted(u64),
    Refused(RecoveryError),
    AuthenticationRequired,
}

impl Backend {
    pub async fn recover_mission(
        &self,
        target: &LifecycleTarget,
        request: &RecoveryRequest,
    ) -> Result<RecoveryOutcome> {
        request.validate()?;
        if !valid_id(&self.workspace)
            || !panel_id(&target.mission)
            || target.mission.encode_utf16().count() > 100
        {
            return Err("invalid Mission recovery target".into());
        }
        let mut url = reqwest::Url::parse(&self.base)?.join("api/workspaces/")?;
        url.path_segments_mut()
            .map_err(|_| "invalid Mission backend URL")?
            .pop_if_empty()
            .extend([
                self.workspace.as_str(),
                "missions",
                target.mission.as_str(),
                "recover",
            ]);
        let response = recovery_post(self, url, request).send().await?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED
            && self.authentication_status().await.ok() == Some(false)
        {
            return Ok(RecoveryOutcome::AuthenticationRequired);
        }
        let body: RecoveryBody = read_filtered_json(
            response,
            RECOVERY_ROOT_KEYS,
            RECOVERY_MISSION_KEYS,
            RECOVERY_KEPT_LIMIT,
        )
        .await
        .unwrap_or_default();
        Ok(settle_recovery(status, &body, target, request))
    }
}

fn recovery_post(
    backend: &Backend,
    url: reqwest::Url,
    request: &RecoveryRequest,
) -> reqwest::RequestBuilder {
    backend
        .client
        .post(url)
        .timeout(CONTROL_TIMEOUT)
        .json(&request.wire())
}

fn classify(code: Option<&str>) -> RecoveryError {
    match code {
        Some("recovery-busy") => RecoveryError::Busy,
        Some("already-member") => RecoveryError::Member,
        Some("recovery-unknown") => RecoveryError::Unknown,
        Some(
            "recovery-conflict"
            | "revision-conflict"
            | "mission-not-running"
            | "control-pending"
            | "mission-not-found"
            | "foreign-session",
        ) => RecoveryError::Conflict,
        _ => RecoveryError::Failed,
    }
}

fn settle_recovery(
    status: reqwest::StatusCode,
    body: &RecoveryBody,
    target: &LifecycleTarget,
    request: &RecoveryRequest,
) -> RecoveryOutcome {
    if !status.is_success() {
        return RecoveryOutcome::Refused(classify(body.code.as_deref()));
    }
    if body.admitted
        && let Some(mission) = body.mission.as_ref()
        && mission.matches(target)
        && let Some(revision) = mission
            .revision
            .filter(|r| (request.expected_revision..=MAX_REVISION).contains(r))
    {
        return RecoveryOutcome::Admitted(revision);
    }
    RecoveryOutcome::Refused(RecoveryError::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_wire_body_omits_task_key_for_coordinator_and_validates_report_keys() {
        let coord = RecoveryRequest::new(7, RecoveryTarget::Coordinator).unwrap();
        assert_eq!(
            serde_json::to_value(coord.wire()).unwrap(),
            json!({"expectedRevision": 7, "target": "coordinator"})
        );
        let report = RecoveryRequest::new(
            7,
            RecoveryTarget::Report {
                task_key: "task-1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(report.wire()).unwrap(),
            json!({"expectedRevision": 7, "target": "report", "taskKey": "task-1"})
        );
        assert!(RecoveryRequest::new(0, RecoveryTarget::Coordinator).is_err());
        assert!(
            RecoveryRequest::new(
                7,
                RecoveryTarget::Report {
                    task_key: "   ".into(),
                },
            )
            .is_err()
        );
    }

    #[test]
    fn recovery_settlement_classifies_codes_and_requires_matching_admitted_mission() {
        let target = LifecycleTarget {
            mission: "msn-one".into(),
            project: "project".into(),
            canonical: "/fixture".into(),
            coordinator: "coordinator".into(),
            coordinator_location: None,
        };
        let request = RecoveryRequest::new(7, RecoveryTarget::Coordinator).unwrap();
        let ok = json!({
            "admitted": true,
            "mission": {
                "id": "msn-one",
                "projectID": "project",
                "projectCanonical": "/fixture",
                "coordinatorSessionId": "coordinator",
                "revision": 8
            }
        });
        let parse = |value: &serde_json::Value| -> RecoveryBody {
            serde_json::from_value(value.clone()).unwrap()
        };
        assert_eq!(
            settle_recovery(reqwest::StatusCode::OK, &parse(&ok), &target, &request),
            RecoveryOutcome::Admitted(8)
        );
        let mut missing_rev = ok.clone();
        missing_rev["mission"]
            .as_object_mut()
            .unwrap()
            .remove("revision");
        assert_eq!(
            settle_recovery(
                reqwest::StatusCode::OK,
                &parse(&missing_rev),
                &target,
                &request,
            ),
            RecoveryOutcome::Refused(RecoveryError::Unknown)
        );
        let mut regressed = ok.clone();
        regressed["mission"]["revision"] = json!(6);
        assert_eq!(
            settle_recovery(
                reqwest::StatusCode::OK,
                &parse(&regressed),
                &target,
                &request,
            ),
            RecoveryOutcome::Refused(RecoveryError::Unknown)
        );
        assert_eq!(
            settle_recovery(
                reqwest::StatusCode::OK,
                &parse(&json!({"admitted": false, "mission": ok["mission"]})),
                &target,
                &request,
            ),
            RecoveryOutcome::Refused(RecoveryError::Unknown)
        );
        let mut foreign = ok.clone();
        foreign["mission"]["projectID"] = json!("other");
        assert_eq!(
            settle_recovery(reqwest::StatusCode::OK, &parse(&foreign), &target, &request),
            RecoveryOutcome::Refused(RecoveryError::Unknown)
        );
        for (code, expected) in [
            ("recovery-busy", RecoveryError::Busy),
            ("already-member", RecoveryError::Member),
            ("recovery-unknown", RecoveryError::Unknown),
            ("recovery-conflict", RecoveryError::Conflict),
            ("revision-conflict", RecoveryError::Conflict),
            ("mission-not-running", RecoveryError::Conflict),
            ("control-pending", RecoveryError::Conflict),
            ("mission-not-found", RecoveryError::Conflict),
            ("foreign-session", RecoveryError::Conflict),
            ("unexpected", RecoveryError::Failed),
        ] {
            assert_eq!(
                settle_recovery(
                    reqwest::StatusCode::CONFLICT,
                    &parse(&json!({"code": code})),
                    &target,
                    &request,
                ),
                RecoveryOutcome::Refused(expected),
                "{code}"
            );
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn large_recovery_acknowledgement_over_64_mib_is_admitted() {
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
                let prefix = br#"{"admitted":true,"mission":{"id":"msn-large","projectID":"project","projectCanonical":"/fixture","coordinatorSessionId":"coordinator","revision":7,"actors":[{"kind":"coordinator","sessionId":"coordinator","location":{"directory":"/fixture"}}],"history":[{"text":""#;
                let suffix = br#""}]}}"#;
                let chunk = vec![b'x'; 64 * 1024];
                let chunk_count = 1040usize; // 65 MiB of unselected history payload
                let total_len = prefix.len() + chunk.len() * chunk_count + suffix.len();
                assert!(total_len > 64 * 1024 * 1024);

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
                let target = LifecycleTarget {
                    mission: "msn-large".into(),
                    project: "project".into(),
                    canonical: "/fixture".into(),
                    coordinator: "coordinator".into(),
                    coordinator_location: Some(("/fixture".into(), None)),
                };
                let request = RecoveryRequest::new(7, RecoveryTarget::Coordinator).unwrap();
                let outcome = backend.recover_mission(&target, &request).await.unwrap();
                assert_eq!(outcome, RecoveryOutcome::Admitted(7));
                server.await.unwrap();
            });
    }
}
