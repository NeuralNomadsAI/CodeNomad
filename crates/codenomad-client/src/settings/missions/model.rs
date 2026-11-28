//! Mission defaults domain model matching `server/src/missions/profile-defaults.ts`.
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// ECMAScript `String.prototype.trim` whitespace (WhiteSpace + LineTerminator, including BOM,
/// excluding Unicode NEL U+0085 which Rust's `char::is_whitespace` strips).
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub(super) fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

pub fn valid_execution_id(value: &str) -> bool {
    !js_trim(value).is_empty() && value.encode_utf16().count() <= 240
}

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

fn non_empty_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| valid_execution_id(text))
        .map(str::to_owned)
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

pub(super) fn parse_profiles(value: &Value, allowed_roles: &[&str]) -> Option<MissionProfiles> {
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
