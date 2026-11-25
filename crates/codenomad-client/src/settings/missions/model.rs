//! Mission defaults and saved-configuration schemas matching `server/src/missions/`.
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};

pub const MAX_MISSION_MODELS: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MissionTemplate {
    Custom,
    Debug,
    Wayfinder,
    Delivery,
    Compare,
}

impl MissionTemplate {
    pub const ALL: [Self; 5] = [
        Self::Custom,
        Self::Debug,
        Self::Wayfinder,
        Self::Delivery,
        Self::Compare,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Custom => "custom",
            Self::Debug => "debug",
            Self::Wayfinder => "wayfinder",
            Self::Delivery => "delivery",
            Self::Compare => "compare",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "custom" => Some(Self::Custom),
            "debug" => Some(Self::Debug),
            "wayfinder" => Some(Self::Wayfinder),
            "delivery" => Some(Self::Delivery),
            "compare" => Some(Self::Compare),
            _ => None,
        }
    }

    pub const fn label_key(self) -> &'static str {
        match self {
            Self::Custom => "missions.control.template.custom",
            Self::Debug => "missions.control.template.debug",
            Self::Wayfinder => "missions.control.template.wayfinder",
            Self::Delivery => "missions.control.template.delivery",
            Self::Compare => "missions.control.template.compare",
        }
    }

    pub const fn roles(self) -> &'static [&'static str] {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MissionDefaultScope {
    All,
    Template(MissionTemplate),
}

impl MissionDefaultScope {
    pub const ALL: [Self; 6] = [
        Self::All,
        Self::Template(MissionTemplate::Custom),
        Self::Template(MissionTemplate::Debug),
        Self::Template(MissionTemplate::Wayfinder),
        Self::Template(MissionTemplate::Delivery),
        Self::Template(MissionTemplate::Compare),
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Template(template) => template.as_str(),
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        if value == "all" {
            Some(Self::All)
        } else {
            MissionTemplate::parse(value).map(Self::Template)
        }
    }

    pub const fn label_key(self) -> &'static str {
        match self {
            Self::All => "missions.defaults.allPlaybooks",
            Self::Template(template) => template.label_key(),
        }
    }

    pub const fn template(self) -> MissionTemplate {
        match self {
            Self::All => MissionTemplate::Custom,
            Self::Template(template) => template,
        }
    }

    pub const fn exception(self) -> Option<MissionTemplate> {
        match self {
            Self::All => None,
            Self::Template(template) => Some(template),
        }
    }

    pub const fn roles(self) -> &'static [&'static str] {
        self.template().roles()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissionTaskMode {
    Native,
    Independent,
}

impl MissionTaskMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Independent => "independent",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "native" => Some(Self::Native),
            "independent" => Some(Self::Independent),
            _ => None,
        }
    }

    pub const fn label_key(self) -> &'static str {
        match self {
            Self::Native => "missions.taskMode.native",
            Self::Independent => "missions.taskMode.independent",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionModelRef {
    pub provider_id: String,
    pub id: String,
    pub variant: Option<String>,
}

impl MissionModelRef {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("providerID".into(), json!(self.provider_id));
        map.insert("id".into(), json!(self.id));
        if let Some(variant) = &self.variant {
            map.insert("variant".into(), json!(variant));
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MissionExecution {
    pub agent: Option<String>,
    pub model: Option<MissionModelRef>,
}

impl MissionExecution {
    pub fn is_empty(&self) -> bool {
        self.agent.is_none() && self.model.is_none()
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        if let Some(agent) = &self.agent {
            map.insert("agent".into(), json!(agent));
        }
        if let Some(model) = &self.model {
            map.insert("model".into(), model.to_json());
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MissionProfiles {
    pub coordinator: Option<MissionExecution>,
    pub roles: BTreeMap<String, MissionExecution>,
}

impl MissionProfiles {
    pub fn has_any(&self) -> bool {
        self.coordinator.is_some() || !self.roles.is_empty()
    }

    pub fn role(&self, role: &str) -> Option<&MissionExecution> {
        if role == "coordinator" {
            self.coordinator.as_ref()
        } else {
            self.roles.get(role)
        }
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        if let Some(coordinator) = &self.coordinator {
            map.insert("coordinator".into(), coordinator.to_json());
        }
        if !self.roles.is_empty() {
            let mut roles = Map::new();
            for (role, execution) in &self.roles {
                roles.insert(role.clone(), execution.to_json());
            }
            map.insert("roles".into(), Value::Object(roles));
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionProfileDefault {
    pub template: MissionDefaultScope,
    pub profiles: MissionProfiles,
    pub task_mode: Option<MissionTaskMode>,
}

impl MissionProfileDefault {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("template".into(), json!(self.template.as_str()));
        map.insert("profiles".into(), self.profiles.to_json());
        if let Some(task_mode) = self.task_mode {
            map.insert("taskMode".into(), json!(task_mode.as_str()));
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserMissionModel {
    pub id: String,
    pub name: String,
    pub objective: String,
    pub notes: String,
    pub template: MissionTemplate,
    pub profiles: Option<MissionProfiles>,
    pub task_mode: Option<MissionTaskMode>,
}

impl UserMissionModel {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("version".into(), json!(1));
        map.insert("id".into(), json!(self.id));
        map.insert("name".into(), json!(self.name));
        map.insert("objective".into(), json!(self.objective));
        map.insert("notes".into(), json!(self.notes));
        map.insert("template".into(), json!(self.template.as_str()));
        if let Some(profiles) = &self.profiles {
            map.insert("profiles".into(), profiles.to_json());
        }
        if let Some(task_mode) = self.task_mode {
            map.insert("taskMode".into(), json!(task_mode.as_str()));
        }
        Value::Object(map)
    }
}

fn non_empty_id(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (!text.trim().is_empty() && text.encode_utf16().count() <= 240).then(|| text.to_owned())
}

fn parse_execution(value: &Value) -> Option<MissionExecution> {
    let map = value.as_object()?;
    if map.keys().any(|key| key != "agent" && key != "model") {
        return None;
    }
    let agent = match map.get("agent") {
        None => None,
        Some(value) => Some(non_empty_id(value)?),
    };
    let model = match map.get("model") {
        None => None,
        Some(value) => {
            let model = value.as_object()?;
            if model
                .keys()
                .any(|key| !matches!(key.as_str(), "providerID" | "id" | "variant"))
            {
                return None;
            }
            let provider_id = non_empty_id(model.get("providerID")?)?;
            let id = non_empty_id(model.get("id")?)?;
            let variant = match model.get("variant") {
                None => None,
                Some(v) => Some(non_empty_id(v)?),
            };
            Some(MissionModelRef {
                provider_id,
                id,
                variant,
            })
        }
    };
    Some(MissionExecution { agent, model })
}

fn parse_profiles(value: &Value, allowed_roles: &[&str]) -> Option<MissionProfiles> {
    let map = value.as_object()?;
    if map.keys().any(|key| key != "coordinator" && key != "roles") {
        return None;
    }
    let coordinator = match map.get("coordinator") {
        None => None,
        Some(v) => Some(parse_execution(v)?),
    };
    let mut roles = BTreeMap::new();
    if let Some(raw_roles) = map.get("roles") {
        let raw_roles = raw_roles.as_object()?;
        for (role, execution) in raw_roles {
            if !allowed_roles.contains(&role.as_str()) {
                return None;
            }
            roles.insert(role.clone(), parse_execution(execution)?);
        }
    }
    Some(MissionProfiles { coordinator, roles })
}

fn parse_mission_defaults_strict(value: &Value) -> Option<Vec<MissionProfileDefault>> {
    let list = value.as_array()?;
    if list.len() > MissionDefaultScope::ALL.len() {
        return None;
    }
    let mut result = Vec::with_capacity(list.len());
    for entry in list {
        let map = entry.as_object()?;
        if map
            .keys()
            .any(|key| !matches!(key.as_str(), "template" | "profiles" | "taskMode"))
        {
            return None;
        }
        let template = MissionDefaultScope::parse(map.get("template")?.as_str()?)?;
        if result
            .iter()
            .any(|item: &MissionProfileDefault| item.template == template)
        {
            return None;
        }
        let task_mode = match map.get("taskMode") {
            None => None,
            Some(v) => Some(MissionTaskMode::parse(v.as_str()?)?),
        };
        let profiles = parse_profiles(map.get("profiles")?, template.roles())?;
        result.push(MissionProfileDefault {
            template,
            profiles,
            task_mode,
        });
    }
    if !result
        .iter()
        .any(|item| item.template == MissionDefaultScope::All)
        && let Some(legacy) = result
            .iter_mut()
            .find(|item| item.template == MissionDefaultScope::Template(MissionTemplate::Custom))
    {
        legacy.template = MissionDefaultScope::All;
    }
    Some(result)
}

pub fn valid_mission_defaults(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => parse_mission_defaults_strict(value).is_some(),
    }
}

pub fn normalize_mission_defaults(value: Option<&Value>) -> Vec<MissionProfileDefault> {
    value
        .and_then(parse_mission_defaults_strict)
        .unwrap_or_default()
}

pub fn encode_mission_defaults(defaults: &[MissionProfileDefault]) -> Value {
    let has_custom = defaults
        .iter()
        .any(|item| item.template == MissionDefaultScope::Template(MissionTemplate::Custom));
    let has_all = defaults
        .iter()
        .any(|item| item.template == MissionDefaultScope::All);
    let mut encoded = Vec::with_capacity(defaults.len() + usize::from(has_custom && !has_all));
    if has_custom && !has_all {
        encoded.push(
            MissionProfileDefault {
                template: MissionDefaultScope::All,
                profiles: MissionProfiles::default(),
                task_mode: None,
            }
            .to_json(),
        );
    }
    encoded.extend(defaults.iter().map(MissionProfileDefault::to_json));
    Value::Array(encoded)
}

pub fn global_task_mode(defaults: &[MissionProfileDefault]) -> MissionTaskMode {
    defaults
        .iter()
        .find(|item| item.template == MissionDefaultScope::All)
        .and_then(|item| item.task_mode)
        .unwrap_or(MissionTaskMode::Native)
}

pub fn task_mode_for(
    defaults: &[MissionProfileDefault],
    template: MissionTemplate,
) -> MissionTaskMode {
    defaults
        .iter()
        .find(|item| item.template == MissionDefaultScope::Template(template))
        .and_then(|item| item.task_mode)
        .unwrap_or_else(|| global_task_mode(defaults))
}

pub fn mission_defaults_for(
    defaults: &[MissionProfileDefault],
    template: MissionTemplate,
    exceptions: bool,
) -> Option<MissionProfiles> {
    let base = defaults
        .iter()
        .find(|item| item.template == MissionDefaultScope::All)
        .map(|item| &item.profiles);
    let specific = exceptions
        .then(|| {
            defaults
                .iter()
                .find(|item| item.template == MissionDefaultScope::Template(template))
                .map(|item| &item.profiles)
        })
        .flatten();
    let coordinator = specific
        .and_then(|p| p.coordinator.clone())
        .or_else(|| base.and_then(|p| p.coordinator.clone()));
    let mut roles = BTreeMap::new();
    for &role in template.roles() {
        let execution = specific
            .and_then(|p| p.roles.get(role).cloned())
            .or_else(|| {
                if template == MissionTemplate::Compare && role == "comparator" {
                    None
                } else {
                    base.and_then(|p| p.roles.get("specialist").cloned())
                }
            });
        if let Some(execution) = execution {
            roles.insert(role.to_owned(), execution);
        }
    }
    let result = MissionProfiles { coordinator, roles };
    result.has_any().then_some(result)
}

pub fn role_profile(
    template: MissionTemplate,
    profiles: Option<&MissionProfiles>,
    role: &str,
) -> Option<MissionExecution> {
    let own = profiles.and_then(|p| p.role(role)).cloned();
    if template != MissionTemplate::Compare || role != "comparator" {
        return own;
    }
    let fallback_model = profiles.and_then(|p| p.coordinator.as_ref()?.model.clone());
    match (own, fallback_model) {
        (None, None) => None,
        (Some(mut own), fallback) => {
            if own.model.is_none() {
                own.model = fallback;
            }
            Some(own)
        }
        (None, Some(model)) => Some(MissionExecution {
            agent: None,
            model: Some(model),
        }),
    }
}

/// Global (`all`) scope edit: an empty execution removes the role from defaults.
pub fn change_mission_profile(
    profiles: Option<&MissionProfiles>,
    role: &str,
    execution: MissionExecution,
) -> Option<MissionProfiles> {
    let selected = !execution.is_empty();
    let mut next = profiles.cloned().unwrap_or_default();
    if role == "coordinator" {
        next.coordinator = selected.then_some(execution);
    } else if selected {
        next.roles.insert(role.to_owned(), execution);
    } else {
        next.roles.remove(role);
    }
    next.has_any().then_some(next)
}

/// Playbook exception edit: `Some(empty)` overrides global with native defaults; `None` inherits.
pub fn set_mission_profile_role(
    profiles: Option<&MissionProfiles>,
    role: &str,
    execution: Option<MissionExecution>,
) -> Option<MissionProfiles> {
    let mut next = profiles.cloned().unwrap_or_default();
    if role == "coordinator" {
        next.coordinator = execution;
    } else if let Some(execution) = execution {
        next.roles.insert(role.to_owned(), execution);
    } else {
        next.roles.remove(role);
    }
    next.has_any().then_some(next)
}

pub fn summary_groups(
    profiles: Option<&MissionProfiles>,
    template: MissionTemplate,
) -> Vec<(Vec<&'static str>, Option<MissionExecution>)> {
    let mut groups: Vec<(Vec<&'static str>, Option<MissionExecution>)> = Vec::new();
    let roles = std::iter::once("coordinator").chain(template.roles().iter().copied());
    for role in roles {
        let requested = if role == "coordinator" {
            profiles.and_then(|p| p.coordinator.clone())
        } else {
            role_profile(template, profiles, role)
        };
        let execution = requested.filter(|e| !e.is_empty());
        if let Some((list, _)) = groups
            .iter_mut()
            .find(|(_, existing)| existing == &execution)
        {
            list.push(role);
        } else {
            groups.push((vec![role], execution));
        }
    }
    groups
}

pub fn execution_label(
    execution: Option<&MissionExecution>,
    model_name: impl Fn(&MissionModelRef) -> Option<String>,
) -> Option<String> {
    let execution = execution?;
    let mut parts = Vec::new();
    if let Some(agent) = &execution.agent {
        parts.push(agent.clone());
    }
    if let Some(model) = &execution.model {
        parts.push(
            model_name(model).unwrap_or_else(|| format!("{}/{}", model.provider_id, model.id)),
        );
        if let Some(variant) = &model.variant {
            parts.push(variant.clone());
        }
    }
    (!parts.is_empty()).then(|| parts.join(" / "))
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn parse_mission_model(value: &Value) -> Option<UserMissionModel> {
    let map = value.as_object()?;
    if map.keys().any(|key| {
        !matches!(
            key.as_str(),
            "version"
                | "id"
                | "name"
                | "objective"
                | "notes"
                | "template"
                | "profiles"
                | "taskMode"
        )
    }) {
        return None;
    }
    let version = map.get("version")?;
    if version.as_u64() != Some(1) && version.as_f64() != Some(1.0) {
        return None;
    }
    let id = map.get("id")?.as_str()?;
    if !is_uuid(id) {
        return None;
    }
    let name = map.get("name")?.as_str()?;
    if name.trim().is_empty() || name.encode_utf16().count() > 80 {
        return None;
    }
    let objective = map.get("objective")?.as_str()?;
    if objective.trim().is_empty() || objective.encode_utf16().count() > 20_000 {
        return None;
    }
    let notes = map.get("notes")?.as_str()?;
    if notes.encode_utf16().count() > 20_000 {
        return None;
    }
    let template = MissionTemplate::parse(map.get("template")?.as_str()?)?;
    let task_mode = match map.get("taskMode") {
        None => None,
        Some(v) => Some(MissionTaskMode::parse(v.as_str()?)?),
    };
    let profiles = match map.get("profiles") {
        None => None,
        Some(v) => Some(parse_profiles(v, template.roles())?),
    };
    Some(UserMissionModel {
        id: id.to_owned(),
        name: name.trim().to_owned(),
        objective: objective.trim().to_owned(),
        notes: notes.to_owned(),
        template,
        profiles,
        task_mode,
    })
}

fn parse_mission_models_strict(value: &Value) -> Option<Vec<UserMissionModel>> {
    let list = value.as_array()?;
    if list.len() > MAX_MISSION_MODELS {
        return None;
    }
    let mut ids = HashSet::with_capacity(list.len());
    let mut models = Vec::with_capacity(list.len());
    for item in list {
        let model = parse_mission_model(item)?;
        if !ids.insert(model.id.clone()) {
            return None;
        }
        models.push(model);
    }
    Some(models)
}

pub fn valid_mission_models(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => parse_mission_models_strict(value).is_some(),
    }
}

pub fn normalize_mission_models(value: Option<&Value>) -> Vec<UserMissionModel> {
    value
        .and_then(parse_mission_models_strict)
        .unwrap_or_default()
}

pub fn remove_mission_model_value(models: &[UserMissionModel], id: &str) -> Value {
    Value::Array(
        models
            .iter()
            .filter(|model| model.id != id)
            .map(UserMissionModel::to_json)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_migrate_legacy_custom_and_preserve_flexible_exception() {
        let legacy = json!([{
            "template": "custom",
            "profiles": { "coordinator": { "agent": "planner" } },
            "taskMode": "independent"
        }]);
        assert!(valid_mission_defaults(Some(&legacy)));
        let normalized = normalize_mission_defaults(Some(&legacy));
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].template, MissionDefaultScope::All);
        assert_eq!(global_task_mode(&normalized), MissionTaskMode::Independent);

        let flexible_only = vec![MissionProfileDefault {
            template: MissionDefaultScope::Template(MissionTemplate::Custom),
            profiles: MissionProfiles {
                coordinator: Some(MissionExecution::default()),
                roles: BTreeMap::new(),
            },
            task_mode: None,
        }];
        let encoded = encode_mission_defaults(&flexible_only);
        assert_eq!(encoded.as_array().unwrap().len(), 2);
        assert_eq!(encoded[0]["template"], "all");
        assert_eq!(encoded[1]["template"], "custom");
    }

    #[test]
    fn invalid_defaults_and_models_fail_closed() {
        assert!(!valid_mission_defaults(Some(
            &json!([{"template":"unknown","profiles":{}}])
        )));
        assert!(!valid_mission_defaults(Some(&json!([{
            "template": "custom",
            "profiles": { "roles": { "validator": { "agent": "a" } } }
        }]))));
        assert!(!valid_mission_models(Some(&json!([{
            "version": 1,
            "id": "not-a-uuid",
            "name": "Brief",
            "objective": "Ship",
            "notes": "",
            "template": "custom"
        }]))));
        let valid_model = json!([{
            "version": 1,
            "id": "004633fb-53c4-477c-8b01-4cc5c177724b",
            "name": "  Daily check  ",
            "objective": "Verify build",
            "notes": "",
            "template": "debug",
            "taskMode": "native"
        }]);
        assert!(valid_mission_models(Some(&valid_model)));
        let models = normalize_mission_models(Some(&valid_model));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "Daily check");
        assert_eq!(
            remove_mission_model_value(&models, "004633fb-53c4-477c-8b01-4cc5c177724b"),
            json!([])
        );
    }

    #[test]
    fn compare_comparator_inherits_coordinator_model_not_global_specialist() {
        let defaults = vec![MissionProfileDefault {
            template: MissionDefaultScope::All,
            profiles: MissionProfiles {
                coordinator: Some(MissionExecution {
                    agent: Some("plan".into()),
                    model: Some(MissionModelRef {
                        provider_id: "p".into(),
                        id: "coord-m".into(),
                        variant: None,
                    }),
                }),
                roles: BTreeMap::from([(
                    "specialist".into(),
                    MissionExecution {
                        agent: Some("build".into()),
                        model: None,
                    },
                )]),
            },
            task_mode: None,
        }];
        let resolved = mission_defaults_for(&defaults, MissionTemplate::Compare, true).unwrap();
        assert_eq!(
            resolved.roles.get("model-a").unwrap().agent.as_deref(),
            Some("build")
        );
        assert!(!resolved.roles.contains_key("comparator"));
        let judge = role_profile(MissionTemplate::Compare, Some(&resolved), "comparator").unwrap();
        assert_eq!(judge.model.unwrap().id, "coord-m");
    }
}
