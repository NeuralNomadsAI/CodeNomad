#[cfg(test)]
mod tests;

use super::{
    BodyDescriptor, ContentOutcome, ContentRefusal, ContentSelector, LifecycleAction,
    LifecycleRequest, LifecycleTarget, RunState, Status, Template, content_digest,
    directory::panel_id,
    lifecycle::{request_id, request_id_valid},
    utf16_len,
};
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const MISSION_TITLE_MAX: usize = 60;
pub const MISSION_TEXT_MAX: usize = 20_000;
const MAX_REVISION: u64 = (1 << 53) - 1;
const MUTATION_TIMEOUT: Duration = Duration::from_secs(90);
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BODY_SLICES: usize = 64;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskMode {
    #[default]
    Native,
    Independent,
}

impl TaskMode {
    pub const ALL: [Self; 2] = [Self::Native, Self::Independent];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Independent => "independent",
        }
    }
}

/// JavaScript `\s` / `String.prototype.trim` whitespace (includes U+FEFF, excludes U+0085).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// First sentence or clause of the first non-empty line, bounded at a word,
/// matching `packages/server/src/missions/mission-title.ts`.
pub fn derive_mission_title(text: &str) -> String {
    let Some(line) = text
        .split('\n')
        .map(|raw| raw.trim_end_matches('\r'))
        .map(|raw| {
            raw.split(is_js_space)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .find(|line| !line.is_empty())
    else {
        return String::new();
    };
    let clause_end = first_clause_end(&line);
    let mut clause = js_trim(&line[..clause_end]);
    if let Some(stripped) = clause.strip_suffix(['.', ';', ':']) {
        clause = js_trim(stripped);
    }
    if utf16_len(clause) <= MISSION_TITLE_MAX {
        return clause.to_owned();
    }
    let cut = truncate_utf16(clause, MISSION_TITLE_MAX - 1);
    let bounded = match cut.rfind(' ') {
        Some(space) if utf16_len(&cut[..space]) > MISSION_TITLE_MAX / 2 => &cut[..space],
        _ => cut,
    };
    format!("{}…", bounded.trim_end_matches(is_js_space))
}

fn first_clause_end(line: &str) -> usize {
    let mut chars = line.char_indices().peekable();
    while let Some((idx, ch)) = chars.next() {
        if matches!(ch, '.' | '!' | '?' | ';' | ':')
            && chars.peek().is_some_and(|(_, next)| is_js_space(*next))
        {
            return idx + ch.len_utf8();
        }
    }
    line.len()
}

fn truncate_utf16(text: &str, max_units: usize) -> &str {
    let mut units = 0;
    let mut end = 0;
    for (idx, ch) in text.char_indices() {
        let len = ch.len_utf16();
        if units + len > max_units {
            break;
        }
        units += len;
        end = idx + ch.len_utf8();
    }
    &text[..end]
}

pub fn valid_title_input(title: &str) -> bool {
    let trimmed = js_trim(title);
    if trimmed.is_empty() {
        return true;
    }
    !trimmed.contains(['\r', '\n', '\0']) && utf16_len(trimmed) <= MISSION_TITLE_MAX
}

pub fn valid_objective_input(objective: &str) -> bool {
    let trimmed = js_trim(objective);
    !trimmed.is_empty() && !trimmed.contains('\0') && utf16_len(trimmed) <= MISSION_TEXT_MAX
}

pub fn valid_notes_input(notes: &str) -> bool {
    !notes.contains('\0') && utf16_len(notes) <= MISSION_TEXT_MAX
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMissionRequest {
    pub request_id: String,
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub template: Template,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_mode: Option<TaskMode>,
}

impl CreateMissionRequest {
    pub fn new(
        objective: &str,
        title: Option<&str>,
        notes: &str,
        template: Template,
        task_mode: TaskMode,
    ) -> Result<Self> {
        let req_id = request_id()?;
        Self::with_request_id(req_id, objective, title, notes, template, task_mode)
    }

    pub fn with_request_id(
        request_id: String,
        objective: &str,
        title: Option<&str>,
        notes: &str,
        template: Template,
        task_mode: TaskMode,
    ) -> Result<Self> {
        let trimmed_objective = js_trim(objective).to_owned();
        let trimmed_title = title
            .map(js_trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let notes = (!notes.is_empty()).then(|| notes.to_owned());
        let request = Self {
            request_id,
            objective: trimmed_objective,
            title: trimmed_title,
            notes,
            template,
            task_mode: Some(task_mode),
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<()> {
        if !request_id_valid(&self.request_id)
            || !valid_objective_input(&self.objective)
            || self.objective != js_trim(&self.objective)
            || self.title.as_deref().is_some_and(|title| {
                title.is_empty() || title != js_trim(title) || !valid_title_input(title)
            })
            || self
                .notes
                .as_deref()
                .is_some_and(|notes| !valid_notes_input(notes))
        {
            return Err("invalid Mission creation request".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMissionRequest {
    pub request_id: String,
    pub expected_revision: u64,
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

impl UpdateMissionRequest {
    pub fn new(expected_revision: u64, objective: &str, notes: &str) -> Result<Self> {
        let req_id = request_id()?;
        Self::with_request_id(req_id, expected_revision, objective, notes)
    }

    pub fn with_request_id(
        request_id: String,
        expected_revision: u64,
        objective: &str,
        notes: &str,
    ) -> Result<Self> {
        let request = Self {
            request_id,
            expected_revision,
            objective: js_trim(objective).to_owned(),
            notes: Some(notes.to_owned()),
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<()> {
        if !request_id_valid(&self.request_id)
            || !(1..=MAX_REVISION).contains(&self.expected_revision)
            || !valid_objective_input(&self.objective)
            || self.objective != js_trim(&self.objective)
            || self
                .notes
                .as_deref()
                .is_some_and(|notes| !valid_notes_input(notes))
        {
            return Err("invalid Mission update request".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationCode {
    CreationUncertain,
    CreationConflict,
    CreationCapacity,
    CreationUnavailable,
    CreationWorktreeDeleting,
    RevisionConflict,
    RequestConflict,
    MissionFinished,
    CompareModelsRequired,
    CompareModelsIdentical,
    Forbidden,
    Invalid,
}

impl MutationCode {
    fn from_code(raw: &str, create: bool) -> Option<Self> {
        match raw {
            "creation-uncertain" if create => Some(Self::CreationUncertain),
            "creation-conflict" if create => Some(Self::CreationConflict),
            "creation-capacity" if create => Some(Self::CreationCapacity),
            "creation-unavailable" if create => Some(Self::CreationUnavailable),
            "creation-worktree-deleting" if create => Some(Self::CreationWorktreeDeleting),
            "compare-models-required" if create => Some(Self::CompareModelsRequired),
            "compare-models-identical" if create => Some(Self::CompareModelsIdentical),
            "revision-conflict" => Some(Self::RevisionConflict),
            "request-conflict" => Some(Self::RequestConflict),
            "mission-finished" if !create => Some(Self::MissionFinished),
            _ => None,
        }
    }

    fn from_body(body: &Value, create: bool) -> Option<Self> {
        body.get("code")
            .and_then(Value::as_str)
            .and_then(|raw| Self::from_code(raw, create))
    }

    pub const fn error_key(self) -> &'static str {
        match self {
            Self::CompareModelsRequired => "missions.compare.compare-models-required",
            Self::CompareModelsIdentical => "missions.compare.compare-models-identical",
            Self::CreationCapacity => "missions.control.creation.capacity",
            Self::CreationUnavailable => "missions.control.creation.unavailable",
            Self::CreationWorktreeDeleting => "missions.control.creation.worktreeDeleting",
            Self::RevisionConflict => "missions.control.mutation.conflict",
            Self::RequestConflict => "missions.control.mutation.requestConflict",
            Self::MissionFinished => "missions.scheduling.lock.terminal",
            Self::Forbidden => "missions.control.mutation.forbidden",
            Self::CreationUncertain | Self::CreationConflict | Self::Invalid => {
                "missions.control.mutation.error"
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreateAcknowledgement {
    Fresh,
    Recovered,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatedMission {
    pub id: String,
    pub revision: u64,
    pub status: Status,
    pub run_state: Option<RunState>,
    pub pending_controls: bool,
    pub target: LifecycleTarget,
    pub acknowledgement: CreateAcknowledgement,
}

impl CreatedMission {
    pub fn can_auto_start(&self) -> bool {
        self.acknowledgement == CreateAcknowledgement::Fresh
            && self.status == Status::Active
            && self.run_state == Some(RunState::Prepared)
            && !self.pending_controls
    }

    pub fn start_request(&self) -> Result<LifecycleRequest> {
        if !self.can_auto_start() {
            return Err("created Mission cannot auto-start".into());
        }
        LifecycleRequest::new(LifecycleAction::Start, self.revision, false)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CreateMissionOutcome {
    Created(CreatedMission),
    Rejected(MutationCode),
    Uncertain,
    AuthExpired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CreationReceiptOutcome {
    Created { mission_id: String, revision: u64 },
    Rejected,
    Unknown,
    AuthExpired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpdateMissionOutcome {
    Updated { mission_id: String, revision: u64 },
    RevisionConflict,
    Rejected(MutationCode),
    Uncertain,
    AuthExpired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditReceiptOutcome {
    Applied { mission_id: String, revision: u64 },
    Unconfirmed,
    AuthExpired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditorBodyOutcome {
    Ready(String),
    Changed,
    Unavailable,
    AuthExpired,
}

impl Backend {
    pub async fn create_mission(&self, request: &CreateMissionRequest) -> CreateMissionOutcome {
        if !valid_id(&self.workspace) || request.validate().is_err() {
            return CreateMissionOutcome::Rejected(MutationCode::Invalid);
        }
        let Ok(url) = missions_url(self, &[]) else {
            return CreateMissionOutcome::Rejected(MutationCode::Invalid);
        };
        let Ok(response) = self
            .client
            .post(url)
            .timeout(MUTATION_TIMEOUT)
            .json(request)
            .send()
            .await
        else {
            return CreateMissionOutcome::Uncertain;
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return CreateMissionOutcome::AuthExpired;
        }
        let body = read_json_limited(response, MAX_RESPONSE_BYTES).await.ok();
        settle_create(status, body.as_ref(), request)
    }

    pub async fn creation_receipt(&self, request_id: &str) -> CreationReceiptOutcome {
        if !valid_id(&self.workspace) || !request_id_valid(request_id) {
            return CreationReceiptOutcome::Unknown;
        }
        let Ok(url) = missions_url(self, &["creation", request_id]) else {
            return CreationReceiptOutcome::Unknown;
        };
        let Ok(response) = self.client.get(url).timeout(RECEIPT_TIMEOUT).send().await else {
            return CreationReceiptOutcome::Unknown;
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return CreationReceiptOutcome::AuthExpired;
        }
        if !status.is_success() {
            return CreationReceiptOutcome::Unknown;
        }
        let Ok(body) = read_json_limited(response, MAX_RESPONSE_BYTES).await else {
            return CreationReceiptOutcome::Unknown;
        };
        parse_creation_receipt(&body, request_id)
    }

    pub async fn update_mission(
        &self,
        target: &LifecycleTarget,
        request: &UpdateMissionRequest,
    ) -> UpdateMissionOutcome {
        if !valid_id(&self.workspace)
            || !panel_id(&target.mission)
            || target.mission.encode_utf16().count() > 100
            || request.validate().is_err()
        {
            return UpdateMissionOutcome::Rejected(MutationCode::Invalid);
        }
        let Ok(url) = missions_url(self, &[target.mission.as_str()]) else {
            return UpdateMissionOutcome::Rejected(MutationCode::Invalid);
        };
        let Ok(response) = self
            .client
            .patch(url)
            .timeout(MUTATION_TIMEOUT)
            .json(request)
            .send()
            .await
        else {
            return UpdateMissionOutcome::Uncertain;
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return UpdateMissionOutcome::AuthExpired;
        }
        let body = read_json_limited(response, MAX_RESPONSE_BYTES).await.ok();
        settle_update(status, body.as_ref(), target, request)
    }

    /// Reads the full text of an editable Mission field (`objective` or `notes`)
    /// pinned to its exact `BodyDescriptor` digest.
    pub async fn read_editor_body(
        &self,
        project_id: &str,
        mission_id: &str,
        selector: &ContentSelector,
        expected: &BodyDescriptor,
    ) -> EditorBodyOutcome {
        self.read_bounded_body(
            project_id,
            mission_id,
            selector,
            expected,
            MISSION_TEXT_MAX as u64,
        )
        .await
    }

    /// Positively verifies that an optional editable field (`notes`) is absent on the server.
    pub async fn confirm_absent_editor_body(
        &self,
        project_id: &str,
        mission_id: &str,
        selector: &ContentSelector,
    ) -> EditorBodyOutcome {
        match self
            .mission_content(project_id, mission_id, selector, 0, None)
            .await
        {
            Ok(ContentOutcome::AuthExpired) => EditorBodyOutcome::AuthExpired,
            Ok(ContentOutcome::Refused {
                refusal: ContentRefusal::ContentNotFound,
                ..
            }) => EditorBodyOutcome::Ready(String::new()),
            Ok(ContentOutcome::Slice { .. })
            | Ok(ContentOutcome::Refused {
                refusal: ContentRefusal::ContentChanged,
                ..
            }) => EditorBodyOutcome::Changed,
            Ok(ContentOutcome::Refused { .. }) | Err(_) => EditorBodyOutcome::Unavailable,
        }
    }

    /// Reconciles an uncertain `PATCH /missions/{id}` by matching the exact user history
    /// entry (`requestID`, `expectedRevision + 1`) and verifying its recorded `after` bodies.
    pub async fn reconcile_mission_edit(
        &self,
        target: &LifecycleTarget,
        request: &UpdateMissionRequest,
    ) -> EditReceiptOutcome {
        if !valid_id(&self.workspace)
            || !panel_id(&target.mission)
            || target.mission.encode_utf16().count() > 100
            || request.validate().is_err()
        {
            return EditReceiptOutcome::Unconfirmed;
        }
        let Ok(url) = missions_url(self, &[target.mission.as_str()]) else {
            return EditReceiptOutcome::Unconfirmed;
        };
        let Ok(response) = self.client.get(url).timeout(RECEIPT_TIMEOUT).send().await else {
            return EditReceiptOutcome::Unconfirmed;
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return EditReceiptOutcome::AuthExpired;
        }
        if !status.is_success() {
            return EditReceiptOutcome::Unconfirmed;
        }
        let Ok(body) = read_json_limited(response, MAX_RESPONSE_BYTES).await else {
            return EditReceiptOutcome::Unconfirmed;
        };
        if body["available"] != true
            || body["controlUnavailable"] == true
            || body["notificationUnavailable"] == true
        {
            return EditReceiptOutcome::Unconfirmed;
        }
        let mission = &body["mission"];
        if !target.matches(mission)
            || (!mission["document"].is_null() && !mission["document"].is_object())
        {
            return EditReceiptOutcome::Unconfirmed;
        }
        let Some(revision) = mission["revision"]
            .as_u64()
            .filter(|r| (request.expected_revision.saturating_add(1)..=MAX_REVISION).contains(r))
        else {
            return EditReceiptOutcome::Unconfirmed;
        };
        let target_change_rev = request.expected_revision.saturating_add(1);
        let Some(change) = mission["history"].as_array().and_then(|history| {
            history.iter().find(|entry| {
                entry["source"] == "user"
                    && entry["requestID"] == request.request_id
                    && entry["revision"].as_u64() == Some(target_change_rev)
            })
        }) else {
            return EditReceiptOutcome::Unconfirmed;
        };
        let obj_after = self
            .read_change_after(
                &target.project,
                &target.mission,
                change,
                target_change_rev,
                "objective",
            )
            .await;
        if matches!(obj_after, ChangeAfter::AuthExpired) {
            return EditReceiptOutcome::AuthExpired;
        }
        let notes_after = self
            .read_change_after(
                &target.project,
                &target.mission,
                change,
                target_change_rev,
                "notes",
            )
            .await;
        if matches!(notes_after, ChangeAfter::AuthExpired) {
            return EditReceiptOutcome::AuthExpired;
        }
        let obj_matches = matches!(obj_after, ChangeAfter::Present(Some(ref value)) if value == &request.objective);
        let notes_matches = match &request.notes {
            Some(expected) => {
                matches!(notes_after, ChangeAfter::Present(Some(ref value)) if value == expected)
            }
            None => matches!(notes_after, ChangeAfter::Absent),
        };
        if !obj_matches || !notes_matches {
            return EditReceiptOutcome::Unconfirmed;
        }
        if mission["document"].is_object() {
            match self
                .verify_document_text_sync(&target.project, &target.mission, mission)
                .await
            {
                DocumentSync::Synced => {}
                DocumentSync::AuthExpired => return EditReceiptOutcome::AuthExpired,
                DocumentSync::Unconfirmed => return EditReceiptOutcome::Unconfirmed,
            }
        }
        EditReceiptOutcome::Applied {
            mission_id: target.mission.clone(),
            revision,
        }
    }

    async fn verify_document_text_sync(
        &self,
        project_id: &str,
        mission_id: &str,
        mission: &Value,
    ) -> DocumentSync {
        let current_objective = match self
            .read_mission_text_field(project_id, mission_id, mission, "objective")
            .await
        {
            EditorBodyOutcome::Ready(text) => text,
            EditorBodyOutcome::AuthExpired => return DocumentSync::AuthExpired,
            EditorBodyOutcome::Changed | EditorBodyOutcome::Unavailable => {
                return DocumentSync::Unconfirmed;
            }
        };
        let current_notes = match self
            .read_mission_optional_text_field(project_id, mission_id, mission, "notes")
            .await
        {
            OptionalTextField::Present(text) => Some(text),
            OptionalTextField::Absent => None,
            OptionalTextField::AuthExpired => return DocumentSync::AuthExpired,
            OptionalTextField::Unconfirmed => return DocumentSync::Unconfirmed,
        };
        let Ok(url) = missions_url(self, &[mission_id, "schedule"]) else {
            return DocumentSync::Unconfirmed;
        };
        let Ok(response) = self.client.get(url).timeout(RECEIPT_TIMEOUT).send().await else {
            return DocumentSync::Unconfirmed;
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return DocumentSync::AuthExpired;
        }
        if !status.is_success() {
            return DocumentSync::Unconfirmed;
        }
        let Ok(body) = read_json_limited(response, MAX_RESPONSE_BYTES).await else {
            return DocumentSync::Unconfirmed;
        };
        let doc = &body["document"];
        let Some(config) = doc["configuration"].as_object() else {
            return DocumentSync::Unconfirmed;
        };
        let doc_notes = match config.get("notes") {
            None => None,
            Some(Value::String(text)) => Some(text.as_str()),
            Some(_) => return DocumentSync::Unconfirmed,
        };
        if doc.is_object()
            && doc["id"].as_str() == Some(mission_id)
            && config.get("objective").and_then(Value::as_str) == Some(current_objective.as_str())
            && doc_notes == current_notes.as_deref()
        {
            DocumentSync::Synced
        } else {
            DocumentSync::Unconfirmed
        }
    }

    async fn read_mission_text_field(
        &self,
        project_id: &str,
        mission_id: &str,
        mission: &Value,
        field: &str,
    ) -> EditorBodyOutcome {
        if let Some(inline) = mission.get(field).and_then(Value::as_str) {
            return EditorBodyOutcome::Ready(inline.to_owned());
        }
        if let Some(raw_desc) = mission.get("bodies").and_then(|b| b.get(field)) {
            let Ok(desc) = serde_json::from_value::<BodyDescriptor>(raw_desc.clone()) else {
                return EditorBodyOutcome::Unavailable;
            };
            return self
                .read_editor_body(
                    project_id,
                    mission_id,
                    &ContentSelector::mission(field),
                    &desc,
                )
                .await;
        }
        EditorBodyOutcome::Unavailable
    }

    async fn read_mission_optional_text_field(
        &self,
        project_id: &str,
        mission_id: &str,
        mission: &Value,
        field: &str,
    ) -> OptionalTextField {
        if let Some(value) = mission.get(field) {
            if let Some(inline) = value.as_str() {
                return OptionalTextField::Present(inline.to_owned());
            }
            if !value.is_null() {
                return OptionalTextField::Unconfirmed;
            }
        }
        if let Some(raw_desc) = mission.get("bodies").and_then(|b| b.get(field))
            && !raw_desc.is_null()
        {
            let Ok(desc) = serde_json::from_value::<BodyDescriptor>(raw_desc.clone()) else {
                return OptionalTextField::Unconfirmed;
            };
            return match self
                .read_editor_body(
                    project_id,
                    mission_id,
                    &ContentSelector::mission(field),
                    &desc,
                )
                .await
            {
                EditorBodyOutcome::Ready(text) => OptionalTextField::Present(text),
                EditorBodyOutcome::AuthExpired => OptionalTextField::AuthExpired,
                EditorBodyOutcome::Changed | EditorBodyOutcome::Unavailable => {
                    OptionalTextField::Unconfirmed
                }
            };
        }
        match self
            .confirm_absent_editor_body(project_id, mission_id, &ContentSelector::mission(field))
            .await
        {
            EditorBodyOutcome::Ready(text) if text.is_empty() => OptionalTextField::Absent,
            EditorBodyOutcome::AuthExpired => OptionalTextField::AuthExpired,
            _ => OptionalTextField::Unconfirmed,
        }
    }

    async fn read_change_after(
        &self,
        project_id: &str,
        mission_id: &str,
        change: &Value,
        change_rev: u64,
        field: &str,
    ) -> ChangeAfter {
        if let Some(inline) = change.get(field).and_then(Value::as_object) {
            return ChangeAfter::Present(
                inline
                    .get("after")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            );
        }
        let Some(raw_desc) = change.get("bodies").and_then(|b| b.get(field)) else {
            return ChangeAfter::Absent;
        };
        let Ok(desc) = serde_json::from_value::<BodyDescriptor>(raw_desc.clone()) else {
            return ChangeAfter::Unconfirmed;
        };
        let max_json_units = (MISSION_TEXT_MAX as u64)
            .saturating_mul(12)
            .saturating_add(256);
        match self
            .read_bounded_body(
                project_id,
                mission_id,
                &ContentSelector::change(change_rev, field),
                &desc,
                max_json_units,
            )
            .await
        {
            EditorBodyOutcome::AuthExpired => ChangeAfter::AuthExpired,
            EditorBodyOutcome::Ready(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(Value::Object(obj)) => ChangeAfter::Present(
                    obj.get("after").and_then(Value::as_str).map(str::to_owned),
                ),
                _ => ChangeAfter::Unconfirmed,
            },
            EditorBodyOutcome::Changed | EditorBodyOutcome::Unavailable => ChangeAfter::Unconfirmed,
        }
    }

    async fn read_bounded_body(
        &self,
        project_id: &str,
        mission_id: &str,
        selector: &ContentSelector,
        expected: &BodyDescriptor,
        max_units: u64,
    ) -> EditorBodyOutcome {
        if expected.characters == 0 {
            return if expected.digest == content_digest("") {
                EditorBodyOutcome::Ready(String::new())
            } else {
                EditorBodyOutcome::Changed
            };
        }
        if expected.characters > max_units {
            return EditorBodyOutcome::Unavailable;
        }
        let mut assembled = String::new();
        let mut offset = 0u64;
        for _ in 0..MAX_BODY_SLICES {
            match self
                .mission_content(
                    project_id,
                    mission_id,
                    selector,
                    offset,
                    Some(&expected.digest),
                )
                .await
            {
                Ok(ContentOutcome::AuthExpired) => return EditorBodyOutcome::AuthExpired,
                Ok(ContentOutcome::Refused {
                    refusal: ContentRefusal::ContentChanged,
                    ..
                }) => return EditorBodyOutcome::Changed,
                Ok(ContentOutcome::Refused { .. }) | Err(_) => {
                    return EditorBodyOutcome::Unavailable;
                }
                Ok(ContentOutcome::Slice { slice, .. }) => {
                    if slice.characters != expected.characters || slice.digest != expected.digest {
                        return EditorBodyOutcome::Changed;
                    }
                    assembled.push_str(&slice.text);
                    match slice.next {
                        Some(next) => offset = next,
                        None => {
                            let valid = utf16_len(&assembled) as u64 == expected.characters
                                && content_digest(&assembled) == expected.digest;
                            return if valid {
                                EditorBodyOutcome::Ready(assembled)
                            } else {
                                EditorBodyOutcome::Changed
                            };
                        }
                    }
                }
            }
        }
        EditorBodyOutcome::Unavailable
    }
}

enum ChangeAfter {
    Present(Option<String>),
    Absent,
    Unconfirmed,
    AuthExpired,
}

enum DocumentSync {
    Synced,
    Unconfirmed,
    AuthExpired,
}

enum OptionalTextField {
    Present(String),
    Absent,
    Unconfirmed,
    AuthExpired,
}

fn missions_url(backend: &Backend, extra: &[&str]) -> Result<Url> {
    let mut url = Url::parse(&backend.base)?.join("api/workspaces/")?;
    url.path_segments_mut()
        .map_err(|()| "invalid Mission backend URL")?
        .pop_if_empty()
        .extend([backend.workspace.as_str(), "missions"])
        .extend(extra.iter().copied());
    Ok(url)
}

fn settle_create(
    status: StatusCode,
    body: Option<&Value>,
    request: &CreateMissionRequest,
) -> CreateMissionOutcome {
    if !status.is_success() {
        let code = body.and_then(|value| MutationCode::from_body(value, true));
        return match code {
            Some(MutationCode::CreationUncertain | MutationCode::CreationConflict) => {
                CreateMissionOutcome::Uncertain
            }
            Some(definitive) => CreateMissionOutcome::Rejected(definitive),
            None => match status.as_u16() {
                400 | 404 => CreateMissionOutcome::Rejected(MutationCode::Invalid),
                403 => CreateMissionOutcome::Rejected(MutationCode::Forbidden),
                _ => CreateMissionOutcome::Uncertain,
            },
        };
    }
    let Some(body) = body else {
        return CreateMissionOutcome::Uncertain;
    };
    let acknowledgement = match body["acknowledgement"].as_str() {
        Some("fresh") => CreateAcknowledgement::Fresh,
        Some("recovered") => CreateAcknowledgement::Recovered,
        _ => return CreateMissionOutcome::Uncertain,
    };
    let mission = &body["mission"];
    let Some(id) = mission["id"].as_str().filter(|id| panel_id(id)) else {
        return CreateMissionOutcome::Uncertain;
    };
    let Some(project) = mission["projectID"].as_str().filter(|p| !p.is_empty()) else {
        return CreateMissionOutcome::Uncertain;
    };
    let Some(canonical) = mission["projectCanonical"]
        .as_str()
        .filter(|p| !p.is_empty())
    else {
        return CreateMissionOutcome::Uncertain;
    };
    let Some(coordinator) = mission["coordinatorSessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
    else {
        return CreateMissionOutcome::Uncertain;
    };
    let Some(revision) = mission["revision"]
        .as_u64()
        .filter(|r| (1..=MAX_REVISION).contains(r))
    else {
        return CreateMissionOutcome::Uncertain;
    };
    let Ok(mission_status) = serde_json::from_value::<Status>(mission["status"].clone()) else {
        return CreateMissionOutcome::Uncertain;
    };
    let run_state = match mission.get("runState") {
        None | Some(Value::Null) => None,
        Some(value) => match serde_json::from_value::<RunState>(value.clone()) {
            Ok(state) => Some(state),
            Err(_) => return CreateMissionOutcome::Uncertain,
        },
    };
    let Ok(template) = serde_json::from_value::<Template>(mission["template"].clone()) else {
        return CreateMissionOutcome::Uncertain;
    };
    if template != request.template {
        return CreateMissionOutcome::Uncertain;
    }
    let returned_mode = match mission.get("taskMode").and_then(Value::as_str) {
        None | Some("native") => TaskMode::Native,
        Some("independent") => TaskMode::Independent,
        Some(_) => return CreateMissionOutcome::Uncertain,
    };
    if returned_mode != request.task_mode.unwrap_or_default() {
        return CreateMissionOutcome::Uncertain;
    }
    let coordinator_location = mission["actors"].as_array().and_then(|actors| {
        actors.iter().find_map(|actor| {
            if actor["kind"] == "coordinator" && actor["sessionId"] == coordinator {
                let loc = &actor["location"];
                Some((
                    loc["directory"].as_str()?.to_owned(),
                    loc["workspaceID"].as_str().map(str::to_owned),
                ))
            } else {
                None
            }
        })
    });
    let control = &mission["control"];
    let pending_controls = !control.is_null()
        && (control["pending"]
            .as_array()
            .is_some_and(|pending| !pending.is_empty())
            || control["unconfirmedReceipts"]
                .as_u64()
                .is_some_and(|count| count > 0));
    CreateMissionOutcome::Created(CreatedMission {
        id: id.to_owned(),
        revision,
        status: mission_status,
        run_state,
        pending_controls,
        target: LifecycleTarget {
            mission: id.to_owned(),
            project: project.to_owned(),
            canonical: canonical.to_owned(),
            coordinator: coordinator.to_owned(),
            coordinator_location,
        },
        acknowledgement,
    })
}

fn parse_creation_receipt(body: &Value, expected_request_id: &str) -> CreationReceiptOutcome {
    if body["requestId"].as_str() != Some(expected_request_id) {
        return CreationReceiptOutcome::Unknown;
    }
    match body["state"].as_str() {
        Some("rejected") => CreationReceiptOutcome::Rejected,
        Some("created") => {
            let mission = &body["mission"];
            let Some(id) = mission["id"].as_str().filter(|id| panel_id(id)) else {
                return CreationReceiptOutcome::Unknown;
            };
            let Some(revision) = mission["revision"]
                .as_u64()
                .filter(|r| (1..=MAX_REVISION).contains(r))
            else {
                return CreationReceiptOutcome::Unknown;
            };
            CreationReceiptOutcome::Created {
                mission_id: id.to_owned(),
                revision,
            }
        }
        _ => CreationReceiptOutcome::Unknown,
    }
}

fn settle_update(
    status: StatusCode,
    body: Option<&Value>,
    target: &LifecycleTarget,
    request: &UpdateMissionRequest,
) -> UpdateMissionOutcome {
    if !status.is_success() {
        let code = body.and_then(|value| MutationCode::from_body(value, false));
        if status.as_u16() == 409 && code == Some(MutationCode::RevisionConflict) {
            return UpdateMissionOutcome::RevisionConflict;
        }
        if status.as_u16() == 409
            && matches!(
                code,
                Some(MutationCode::RequestConflict | MutationCode::MissionFinished)
            )
        {
            return UpdateMissionOutcome::Rejected(code.unwrap());
        }
        return match status.as_u16() {
            403 => UpdateMissionOutcome::Rejected(MutationCode::Forbidden),
            400 | 404 => UpdateMissionOutcome::Rejected(MutationCode::Invalid),
            _ => UpdateMissionOutcome::Uncertain,
        };
    }
    let Some(body) = body else {
        return UpdateMissionOutcome::Uncertain;
    };
    let mission = &body["mission"];
    let Some(revision) = mission["revision"]
        .as_u64()
        .filter(|r| (request.expected_revision..=MAX_REVISION).contains(r))
    else {
        return UpdateMissionOutcome::Uncertain;
    };
    if target.matches(mission) {
        UpdateMissionOutcome::Updated {
            mission_id: target.mission.clone(),
            revision,
        }
    } else {
        UpdateMissionOutcome::Uncertain
    }
}
