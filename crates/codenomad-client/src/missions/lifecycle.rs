use super::directory::panel_id;
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::{Deserialize, Serialize};

pub(super) const MAX_REVISION: u64 = (1 << 53) - 1;
pub(super) const CONTROL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleAction {
    Start,
    Pause,
    Stop,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleRequest {
    pub action: LifecycleAction,
    pub request_id: String,
    pub expected_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graceful: Option<bool>,
}

impl LifecycleRequest {
    pub fn new(action: LifecycleAction, expected_revision: u64, graceful: bool) -> Result<Self> {
        let request = Self {
            action,
            request_id: request_id()?,
            expected_revision,
            graceful: graceful.then_some(true),
        };
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<()> {
        if !request_id_valid(&self.request_id)
            || !(1..=MAX_REVISION).contains(&self.expected_revision)
            || self
                .graceful
                .is_some_and(|value| !value || self.action != LifecycleAction::Pause)
        {
            return Err("invalid Mission lifecycle intent".into());
        }
        Ok(())
    }
}

pub(super) fn request_id_valid(id: &str) -> bool {
    !id.is_empty() && id == id.trim() && id.encode_utf16().count() <= 128
}

pub(super) fn request_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    #[cfg(not(target_arch = "wasm32"))]
    getrandom::fill(&mut bytes).map_err(|_| "Mission request entropy unavailable")?;
    #[cfg(target_arch = "wasm32")]
    web_sys::window()
        .ok_or("browser window required")?
        .crypto()
        .map_err(|_| "browser entropy unavailable")?
        .get_random_values_with_u8_array(&mut bytes)
        .map_err(|_| "browser entropy unavailable")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p] = bytes;
    Ok(format!(
        "{a:02x}{b:02x}{c:02x}{d:02x}-{e:02x}{f:02x}-{g:02x}{h:02x}-{i:02x}{j:02x}-{k:02x}{l:02x}{m:02x}{n:02x}{o:02x}{p:02x}"
    ))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlReceipt {
    pub id: String,
    #[serde(rename = "requestID")]
    pub request_id: String,
    pub action: LifecycleAction,
    pub expected_revision: u64,
    pub completed_revision: Option<u64>,
    pub graceful: Option<bool>,
    pub pending: u64,
    pub receipts: u64,
    pub unconfirmed_receipts: u64,
    pub partial_descendants: u64,
}

impl ControlReceipt {
    pub(super) fn valid(&self, revision: u64) -> bool {
        panel_id(&self.id)
            && request_id_valid(&self.request_id)
            && (1..=revision).contains(&self.expected_revision)
            && self.pending <= MAX_REVISION
            && self.receipts <= MAX_REVISION
            && self.unconfirmed_receipts <= self.receipts
            && self.partial_descendants <= self.receipts
            && self
                .completed_revision
                .is_none_or(|r| (self.expected_revision..=revision).contains(&r))
            && self
                .graceful
                .is_none_or(|graceful| graceful && self.action == LifecycleAction::Pause)
    }

    pub fn matches(&self, request: &LifecycleRequest) -> bool {
        self.request_id == request.request_id
            && self.expected_revision == request.expected_revision
            && self.action == request.action
            && self.graceful == request.graceful
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleOutcome {
    Acknowledged(u64),
    Rejected,
    Unconfirmed,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LifecycleTarget {
    pub mission: String,
    pub project: String,
    pub canonical: String,
    pub coordinator: String,
    pub coordinator_location: Option<(String, Option<String>)>,
}

impl LifecycleTarget {
    pub(super) fn matches(&self, value: &serde_json::Value) -> bool {
        value["id"] == self.mission
            && value["projectID"] == self.project
            && value["projectCanonical"] == self.canonical
            && value["coordinatorSessionId"] == self.coordinator
            && self
                .coordinator_location
                .as_ref()
                .is_none_or(|(directory, workspace)| {
                    value["actors"].as_array().is_some_and(|actors| {
                        actors.iter().any(|actor| {
                            actor["kind"] == "coordinator"
                                && actor["sessionId"] == self.coordinator
                                && actor["location"]["directory"] == *directory
                                && actor["location"]["workspaceID"].as_str() == workspace.as_deref()
                        })
                    })
                })
    }
}

impl super::MapHeader {
    pub fn lifecycle_target(&self) -> LifecycleTarget {
        LifecycleTarget {
            mission: self.root.id.clone(),
            project: self.root.project.clone(),
            canonical: self.root.project_canonical.clone(),
            coordinator: self.root.coordinator_session_id.clone(),
            coordinator_location: self.coordinator.as_ref().and_then(|actor| {
                let location = &actor["location"];
                Some((
                    location["directory"].as_str()?.into(),
                    location["workspaceID"].as_str().map(str::to_owned),
                ))
            }),
        }
    }
}

impl Backend {
    pub async fn control_mission(
        &self,
        target: &LifecycleTarget,
        request: &LifecycleRequest,
    ) -> Result<LifecycleOutcome> {
        request.validate()?;
        if !valid_id(&self.workspace)
            || !panel_id(&target.mission)
            || target.mission.encode_utf16().count() > 100
        {
            return Err("invalid Mission control target".into());
        }
        let mut url = reqwest::Url::parse(&self.base)?.join("api/workspaces/")?;
        url.path_segments_mut()
            .map_err(|_| "invalid Mission backend URL")?
            .pop_if_empty()
            .extend([
                self.workspace.as_str(),
                "missions",
                target.mission.as_str(),
                "control",
            ]);
        let response = control_post(self, url, request).send().await?;
        let status = response.status();
        let body = read_json_limited(response, 4 * 1024 * 1024).await?;
        Ok(settle(status, &body, target, request))
    }
}

fn settle(
    status: reqwest::StatusCode,
    body: &serde_json::Value,
    target: &LifecycleTarget,
    request: &LifecycleRequest,
) -> LifecycleOutcome {
    if status.as_u16() == 409 && body["code"] == "revision-conflict" {
        return LifecycleOutcome::Rejected;
    }
    let mission = &body["mission"];
    let control = &mission["control"];
    let revision = mission["revision"].as_u64();
    if status.is_success()
        && target.matches(mission)
        && control["missionID"] == target.mission
        && control["requestID"] == request.request_id
        && control["expectedRevision"] == request.expected_revision
        && serde_json::from_value::<LifecycleAction>(control["action"].clone()).ok()
            == Some(request.action)
        && control.get("graceful").map(|value| value == true) == request.graceful
        && control["pending"].as_array().is_some_and(Vec::is_empty)
        && known_receipts(control)
        && let (Some(revision), Some(completed)) = (revision, control["completedRevision"].as_u64())
        && (request.expected_revision.saturating_add(1)..=revision).contains(&completed)
        && revision <= MAX_REVISION
    {
        return LifecycleOutcome::Acknowledged(revision);
    }
    LifecycleOutcome::Unconfirmed
}

fn control_post(
    backend: &Backend,
    url: reqwest::Url,
    request: &LifecycleRequest,
) -> reqwest::RequestBuilder {
    backend
        .client
        .post(url)
        .timeout(CONTROL_TIMEOUT)
        .json(request)
}

fn known_receipts(control: &serde_json::Value) -> bool {
    control
        .get("unconfirmedReceipts")
        .is_none_or(|count| count.as_u64() == Some(0))
        && control.get("receipts").is_none_or(|rows| {
            rows.as_array().is_some_and(|rows| {
                rows.iter().all(|row| {
                    row["acknowledgementState"] == "known"
                        && row["nativeAcknowledgement"].is_object()
                })
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lifecycle_post_keeps_the_native_family_budget() {
        let backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
        let url = reqwest::Url::parse(&backend.base).unwrap();
        let request = LifecycleRequest::new(LifecycleAction::Stop, 7, false).unwrap();
        let built = control_post(&backend, url.clone(), &request)
            .build()
            .unwrap();
        assert_eq!(built.timeout().unwrap().as_secs(), 90);
        assert_eq!(
            backend
                .client
                .get(url)
                .build()
                .unwrap()
                .timeout()
                .unwrap()
                .as_secs(),
            30
        );
    }

    #[test]
    fn lifecycle_ack_is_exact_and_only_revision_conflict_certifies_rejection() {
        let request = LifecycleRequest::new(LifecycleAction::Pause, 7, true).unwrap();
        assert_eq!(request.request_id.len(), 36);
        assert_eq!(request.request_id.as_bytes()[14], b'4');
        assert!(matches!(
            request.request_id.as_bytes()[19],
            b'8' | b'9' | b'a' | b'b'
        ));
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({
                "action":"pause","expectedRevision":7,"requestId":request.request_id,"graceful":true,
            })
        );
        let target = LifecycleTarget {
            mission: "msn-one".into(),
            project: "project".into(),
            canonical: "/fixture".into(),
            coordinator: "coordinator".into(),
            coordinator_location: None,
        };
        let body = json!({"mission":{
            "id":"msn-one","projectID":"project","projectCanonical":"/fixture","coordinatorSessionId":"coordinator","revision":8,
            "control":{"missionID":"msn-one","requestID":request.request_id,"action":"pause","expectedRevision":7,
                "graceful":true,"pending":[],"completedRevision":8}
        }});
        assert_eq!(
            settle(reqwest::StatusCode::OK, &body, &target, &request),
            LifecycleOutcome::Acknowledged(8)
        );
        let mut unknown = body.clone();
        unknown["mission"]["control"]["receipts"] =
            json!([{"sessionID":"ses-one","receiptID":"rec-one","acknowledgementState":"unknown"}]);
        assert_eq!(
            settle(reqwest::StatusCode::OK, &unknown, &target, &request),
            LifecycleOutcome::Unconfirmed
        );
        for (path, value) in [
            ("/mission/control/requestID", json!("foreign")),
            ("/mission/control/graceful", json!(false)),
            ("/mission/control/pending", json!(["ses-one"])),
            ("/mission/control/completedRevision", json!(7)),
            ("/mission/coordinatorSessionId", json!("unowned")),
        ] {
            let mut foreign = body.clone();
            *foreign.pointer_mut(path).unwrap() = value;
            assert_eq!(
                settle(reqwest::StatusCode::OK, &foreign, &target, &request),
                LifecycleOutcome::Unconfirmed,
                "{path}"
            );
        }
        for (code, expected) in [
            ("revision-conflict", LifecycleOutcome::Rejected),
            ("control-pending", LifecycleOutcome::Unconfirmed),
            ("request-conflict", LifecycleOutcome::Unconfirmed),
        ] {
            assert_eq!(
                settle(
                    reqwest::StatusCode::CONFLICT,
                    &json!({"code":code}),
                    &target,
                    &request
                ),
                expected
            );
        }
    }
}
