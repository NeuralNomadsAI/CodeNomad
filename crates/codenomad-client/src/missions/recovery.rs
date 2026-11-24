use super::{
    LifecycleTarget,
    directory::panel_id,
    lifecycle::{CONTROL_TIMEOUT, MAX_REVISION},
};
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::Serialize;

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
    Admitted(Option<u64>),
    Refused(RecoveryError),
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
        let body = read_json_limited(response, 4 * 1024 * 1024)
            .await
            .unwrap_or(serde_json::Value::Null);
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
    body: &serde_json::Value,
    target: &LifecycleTarget,
    request: &RecoveryRequest,
) -> RecoveryOutcome {
    if !status.is_success() {
        return RecoveryOutcome::Refused(classify(body["code"].as_str()));
    }
    let mission = &body["mission"];
    if body["admitted"] == true && target.matches(mission) {
        let revision = mission["revision"]
            .as_u64()
            .filter(|r| (request.expected_revision..=MAX_REVISION).contains(r));
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
        assert_eq!(
            settle_recovery(reqwest::StatusCode::OK, &ok, &target, &request),
            RecoveryOutcome::Admitted(Some(8))
        );
        assert_eq!(
            settle_recovery(
                reqwest::StatusCode::OK,
                &json!({"admitted": false, "mission": ok["mission"]}),
                &target,
                &request,
            ),
            RecoveryOutcome::Refused(RecoveryError::Unknown)
        );
        let mut foreign = ok.clone();
        foreign["mission"]["projectID"] = json!("other");
        assert_eq!(
            settle_recovery(reqwest::StatusCode::OK, &foreign, &target, &request),
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
                    &json!({"code": code}),
                    &target,
                    &request,
                ),
                RecoveryOutcome::Refused(expected),
                "{code}"
            );
        }
    }
}
