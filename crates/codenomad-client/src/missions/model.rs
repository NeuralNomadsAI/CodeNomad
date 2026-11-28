use crate::history::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Template {
    Custom,
    Debug,
    Wayfinder,
    Delivery,
    Compare,
}

impl Template {
    pub fn allowed_roles(self) -> &'static [&'static str] {
        match self {
            Self::Custom => &["specialist"],
            Self::Debug => &[
                "review-standards",
                "review-spec",
                "validator",
                "diagnostician",
                "implementer",
                "resolver",
            ],
            Self::Wayfinder => &[
                "cartographer",
                "research",
                "prototype",
                "grilling",
                "decision",
            ],
            Self::Delivery => &[
                "business-analyst",
                "technical-architect",
                "tech-lead",
                "developer",
                "qa-engineer",
                "ui-ux-designer",
            ],
            Self::Compare => &["model-a", "model-b", "comparator"],
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskMode {
    Native,
    Independent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

impl ModelRef {
    pub fn validate(&self) -> Result<()> {
        if !execution_id(&self.provider_id)
            || !execution_id(&self.id)
            || self.variant.as_deref().is_some_and(|v| !execution_id(v))
        {
            return Err("invalid Mission model selection".into());
        }
        Ok(())
    }

    pub fn same_model(&self, other: &Self) -> bool {
        self.provider_id == other.provider_id && self.id == other.id
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
}

impl ExecutionProfile {
    pub fn validate(&self) -> Result<()> {
        if self.agent.as_deref().is_some_and(|a| !execution_id(a)) {
            return Err("invalid Mission agent selection".into());
        }
        if let Some(model) = &self.model {
            model.validate()?;
        }
        Ok(())
    }

    pub fn is_explicit(&self) -> bool {
        self.agent.as_deref().is_some_and(execution_id)
            && self
                .model
                .as_ref()
                .is_some_and(|model| execution_id(&model.provider_id) && execution_id(&model.id))
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Profiles {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<ExecutionProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<BTreeMap<String, ExecutionProfile>>,
}

impl Profiles {
    pub fn validate_for_template(&self, template: Template) -> Result<()> {
        if let Some(coordinator) = &self.coordinator {
            coordinator.validate()?;
        }
        let allowed = template.allowed_roles();
        if let Some(roles) = &self.roles {
            for (role, execution) in roles {
                if !allowed.contains(&role.as_str()) {
                    return Err("Mission profile role does not belong to playbook".into());
                }
                execution.validate()?;
            }
        }
        if template == Template::Compare {
            let roles = self.roles.as_ref();
            let a = roles
                .and_then(|r| r.get("model-a"))
                .and_then(|e| e.model.as_ref());
            let b = roles
                .and_then(|r| r.get("model-b"))
                .and_then(|e| e.model.as_ref());
            match (a, b) {
                (Some(left), Some(right)) if !left.same_model(right) => {}
                _ => return Err("compare playbook requires two distinct models".into()),
            }
        }
        Ok(())
    }

    /// Calendar-backed Missions require explicit agent + model for the coordinator
    /// and every role of the selected playbook (matching `launch-policy.ts`).
    pub fn validate_explicit_for_template(&self, template: Template) -> Result<()> {
        self.validate_for_template(template)?;
        if !self
            .coordinator
            .as_ref()
            .is_some_and(ExecutionProfile::is_explicit)
        {
            return Err("calendar Mission requires an explicit coordinator profile".into());
        }
        let roles = self
            .roles
            .as_ref()
            .ok_or("calendar Mission requires explicit role profiles")?;
        for role in template.allowed_roles() {
            if !roles.get(*role).is_some_and(ExecutionProfile::is_explicit) {
                return Err("calendar Mission requires explicit profile for every role".into());
            }
        }
        Ok(())
    }
}

fn execution_id(value: &str) -> bool {
    !value.trim().is_empty() && value.encode_utf16().count() <= 240
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Completed,
    Failed,
    Stopped,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Prepared,
    Running,
    Paused,
    Stopped,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub id: String,
    pub title: Option<String>,
    pub objective: String,
    pub status: Status,
    pub run_state: Option<RunState>,
    pub coordinator_session_id: String,
    pub actor_count: u64,
    pub updated_at: f64,
    pub revision: u64,
    pub finish_sequence: Option<u64>,
    pub task_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    #[serde(rename = "missionID")]
    pub mission_id: String,
    #[serde(rename = "deletionID")]
    pub deletion_id: String,
    #[serde(rename = "requestID")]
    pub request_id: String,
    pub expected_revision: u64,
    pub delete_managed_sessions: bool,
    pub objective: String,
    pub created_at: f64,
    pub removed: u64,
    pub retained: u64,
    pub pending: u64,
    pub reasons: Vec<String>,
    pub document_pending: Option<bool>,
}

#[derive(Debug)]
pub enum DirectoryRows {
    Summaries(Vec<Summary>),
    Cleanups(Vec<Cleanup>),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub order: String,
    pub offset: u64,
    pub end: u64,
    pub total: u64,
}

#[derive(Debug)]
pub struct DirectoryPage {
    pub project_id: String,
    pub finish_high_water: Option<u64>,
    pub window: Window,
    pub rows: DirectoryRows,
}
