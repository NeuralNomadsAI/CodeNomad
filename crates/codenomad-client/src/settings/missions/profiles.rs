//! Mission execution-profile inheritance, mutation, and inline summary helpers.
use super::{
    MissionDefaultScope, MissionExecution, MissionModelRef, MissionProfileDefault, MissionProfiles,
    MissionTemplate,
};
use std::collections::BTreeMap;

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
    for role in std::iter::once("coordinator").chain(template.roles().iter().copied()) {
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

#[cfg(test)]
mod tests {
    use super::super::*;
    use serde_json::json;

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
        let encoded = encode_mission_defaults(&[MissionProfileDefault {
            template: MissionDefaultScope::Template(MissionTemplate::Custom),
            profiles: MissionProfiles {
                coordinator: Some(MissionExecution::default()),
                roles: BTreeMap::new(),
            },
            task_mode: None,
        }]);
        assert_eq!(encoded.as_array().unwrap().len(), 2);
        assert_eq!(encoded[0]["template"], "all");
        assert_eq!(encoded[1]["template"], "custom");
    }

    #[test]
    fn bom_only_id_and_unknown_role_fail_closed() {
        assert!(!valid_execution_id("\u{FEFF}"));
        assert!(!valid_execution_id(&"a".repeat(241)));
        assert!(!valid_mission_defaults(Some(
            &json!([{"template":"unknown","profiles":{}}])
        )));
        assert!(!valid_mission_defaults(Some(&json!([{
            "template": "custom",
            "profiles": { "roles": { "validator": { "agent": "a" } } }
        }]))));
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
        assert_eq!(resolved.roles["model-a"].agent.as_deref(), Some("build"));
        assert!(!resolved.roles.contains_key("comparator"));
        let judge = role_profile(MissionTemplate::Compare, Some(&resolved), "comparator").unwrap();
        assert_eq!(judge.model.unwrap().id, "coord-m");
    }
}
