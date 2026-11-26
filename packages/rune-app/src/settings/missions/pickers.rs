//! Role labels and native agent/model/variant pickers for Mission execution profiles.
use super::Picker;
use crate::strings::t;
use codenomad_client::settings::missions::{
    MissionExecution, MissionModelRef, ProfileAgent, ProfileModel,
};
use rune::El;
use rune_theme_codenomad::settings as chrome;
use std::collections::BTreeMap;

pub(super) fn role_label(role: &str) -> &'static str {
    match role {
        "coordinator" => t("missions.control.profiles.role.coordinator"),
        "specialist" => t("missions.control.profiles.role.specialist"),
        "review-standards" => t("missions.control.profiles.role.review-standards"),
        "review-spec" => t("missions.control.profiles.role.review-spec"),
        "validator" => t("missions.control.profiles.role.validator"),
        "diagnostician" => t("missions.control.profiles.role.diagnostician"),
        "implementer" => t("missions.control.profiles.role.implementer"),
        "resolver" => t("missions.control.profiles.role.resolver"),
        "cartographer" => t("missions.control.profiles.role.cartographer"),
        "research" => t("missions.control.profiles.role.research"),
        "prototype" => t("missions.control.profiles.role.prototype"),
        "grilling" => t("missions.control.profiles.role.grilling"),
        "decision" => t("missions.control.profiles.role.decision"),
        "business-analyst" => t("missions.control.profiles.role.business-analyst"),
        "technical-architect" => t("missions.control.profiles.role.technical-architect"),
        "tech-lead" => t("missions.control.profiles.role.tech-lead"),
        "developer" => t("missions.control.profiles.role.developer"),
        "qa-engineer" => t("missions.control.profiles.role.qa-engineer"),
        "ui-ux-designer" => t("missions.control.profiles.role.ui-ux-designer"),
        "model-a" => t("missions.control.profiles.role.model-a"),
        "model-b" => t("missions.control.profiles.role.model-b"),
        "comparator" => t("missions.control.profiles.role.comparator"),
        _ => t("missions.control.profiles.role.specialist"),
    }
}

pub(super) fn push_unique_label(labels: &mut Vec<String>, candidate: String, disambiguator: &str) {
    if !labels.contains(&candidate) {
        labels.push(candidate);
        return;
    }
    let mut unique = format!("{candidate} ({disambiguator})");
    let mut suffix = 2usize;
    while labels.contains(&unique) {
        unique = format!("{candidate} ({disambiguator} #{suffix})");
        suffix += 1;
    }
    labels.push(unique);
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_agent_picker<S: 'static>(
    index: usize,
    title: &str,
    role: &'static str,
    selected: Option<&MissionExecution>,
    available: &[&ProfileAgent],
    disabled: bool,
    open_picker: Option<Picker>,
    layers: &mut Vec<El>,
    set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
    change_role: impl Fn(&mut S, &'static str, Option<MissionExecution>) + Clone + 'static,
) -> El {
    let native = t("missions.control.execution.nativeDefault");
    let unavailable = t("missions.control.profiles.unavailable");
    let mut labels = vec![native.to_owned()];
    let mut values: Vec<Option<String>> = vec![None];
    let current_agent = selected.and_then(|e| e.agent.as_deref());
    if let Some(saved) = current_agent
        && !available.iter().any(|a| a.id == saved)
    {
        push_unique_label(&mut labels, format!("{saved} · {unavailable}"), saved);
        values.push(Some(saved.to_owned()));
    }
    for agent in available {
        let candidate = if agent.id == native || labels.contains(&agent.id) {
            format!("{} · {}", agent.id, t("missions.control.execution.agent"))
        } else {
            agent.id.clone()
        };
        push_unique_label(&mut labels, candidate, &agent.id);
        values.push(Some(agent.id.clone()));
    }
    let current_index = current_agent
        .and_then(|saved| values.iter().position(|v| v.as_deref() == Some(saved)))
        .unwrap_or(0);
    let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
    let picker_id = Picker::RoleAgent(index);
    let is_open = open_picker == Some(picker_id) && !disabled;
    let aria = format!("{title} · {}", t("missions.control.execution.agent"));
    let base = selected.cloned().unwrap_or_default();
    let labels_for_choose = labels.clone();
    let control = chrome::picker(&format!("mission-agent-{role}"), &aria, &refs)
        .current(Some(refs[current_index]))
        .disabled(disabled)
        .open(is_open)
        .on_toggle(move |s: &mut S| set_picker(s, (!is_open).then_some(picker_id)))
        .on_close(move |s: &mut S| set_picker(s, None))
        .on_choose(move |s: &mut S, value, _| {
            set_picker(s, None);
            if let Some(pos) = labels_for_choose.iter().position(|label| label == value) {
                let chosen = values[pos].clone();
                if chosen != base.agent {
                    let mut next = base.clone();
                    next.agent = chosen;
                    change_role(s, role, Some(next));
                }
            }
        });
    chrome::build_picker(control, layers)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_model_picker<S: 'static>(
    index: usize,
    title: &str,
    role: &'static str,
    selected: Option<&MissionExecution>,
    selected_model: Option<&ProfileModel>,
    shown_models: &[&ProfileModel],
    known_names: &BTreeMap<(String, String), String>,
    disabled: bool,
    open_picker: Option<Picker>,
    layers: &mut Vec<El>,
    set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
    change_role: impl Fn(&mut S, &'static str, Option<MissionExecution>) + Clone + 'static,
) -> El {
    let native = t("missions.control.execution.nativeDefault");
    let unavailable = t("missions.control.profiles.unavailable");
    let mut models: Vec<&ProfileModel> = shown_models.to_vec();
    if let Some(saved) = selected_model
        && !models
            .iter()
            .any(|m| m.provider_id == saved.provider_id && m.id == saved.id)
    {
        models.push(saved);
        models.sort_by(|l, r| {
            l.provider_id
                .to_lowercase()
                .cmp(&r.provider_id.to_lowercase())
                .then_with(|| l.name.to_lowercase().cmp(&r.name.to_lowercase()))
                .then_with(|| l.id.to_lowercase().cmp(&r.id.to_lowercase()))
        });
    }
    let mut counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    for m in &models {
        *counts
            .entry((m.provider_name.clone(), m.name.clone()))
            .or_default() += 1;
    }
    let mut labels = vec![native.to_owned()];
    let mut values: Vec<Option<MissionModelRef>> = vec![None];
    if let Some(saved) = selected.and_then(|e| e.model.as_ref())
        && selected_model.is_none()
    {
        let display = known_names
            .get(&(saved.provider_id.clone(), saved.id.clone()))
            .cloned()
            .unwrap_or_else(|| format!("{}/{}", saved.provider_id, saved.id));
        push_unique_label(
            &mut labels,
            format!("{display} · {unavailable}"),
            &format!("{}/{}", saved.provider_id, saved.id),
        );
        values.push(Some(saved.clone()));
    }
    for m in &models {
        let base_label = format!("{} · {}", m.provider_name, m.name);
        let duplicate = counts
            .get(&(m.provider_name.clone(), m.name.clone()))
            .copied()
            .unwrap_or(0)
            > 1;
        let disambiguator = format!("{}/{}", m.provider_id, m.id);
        let candidate = if duplicate || base_label == native || labels.contains(&base_label) {
            format!("{base_label} ({disambiguator})")
        } else {
            base_label
        };
        push_unique_label(&mut labels, candidate, &disambiguator);
        values.push(Some(MissionModelRef {
            provider_id: m.provider_id.clone(),
            id: m.id.clone(),
            variant: None,
        }));
    }
    let current_index = selected
        .and_then(|e| e.model.as_ref())
        .and_then(|saved| {
            values.iter().position(|v| {
                v.as_ref()
                    .is_some_and(|m| m.provider_id == saved.provider_id && m.id == saved.id)
            })
        })
        .unwrap_or(0);
    let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
    let picker_id = Picker::RoleModel(index);
    let is_open = open_picker == Some(picker_id) && !disabled;
    let aria = format!("{title} · {}", t("missions.control.execution.model"));
    let base = selected.cloned().unwrap_or_default();
    let labels_for_choose = labels.clone();
    let control = chrome::picker(&format!("mission-model-{role}"), &aria, &refs)
        .current(Some(refs[current_index]))
        .disabled(disabled)
        .open(is_open)
        .on_toggle(move |s: &mut S| set_picker(s, (!is_open).then_some(picker_id)))
        .on_close(move |s: &mut S| set_picker(s, None))
        .on_choose(move |s: &mut S, value, _| {
            set_picker(s, None);
            if let Some(pos) = labels_for_choose.iter().position(|label| label == value) {
                let chosen = values[pos].clone();
                let unchanged = match (&base.model, &chosen) {
                    (Some(cur), Some(next)) => {
                        cur.provider_id == next.provider_id && cur.id == next.id
                    }
                    (None, None) => true,
                    _ => false,
                };
                if !unchanged {
                    let mut next = base.clone();
                    // Switching models clears any incompatible variant.
                    next.model = chosen;
                    change_role(s, role, Some(next));
                }
            }
        });
    chrome::build_picker(control, layers)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_variant_picker<S: 'static>(
    index: usize,
    title: &str,
    role: &'static str,
    selected: Option<&MissionExecution>,
    selected_model: Option<&ProfileModel>,
    disabled: bool,
    open_picker: Option<Picker>,
    layers: &mut Vec<El>,
    set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
    change_role: impl Fn(&mut S, &'static str, Option<MissionExecution>) + Clone + 'static,
) -> El {
    let native = t("missions.control.execution.nativeDefault");
    let unavailable = t("missions.control.profiles.unavailable");
    let has_model = selected.and_then(|e| e.model.as_ref()).is_some();
    let control_disabled = disabled || !has_model;
    let current_variant = selected
        .and_then(|e| e.model.as_ref())
        .and_then(|m| m.variant.as_deref());
    let available: &[String] = selected_model.map(|m| m.variants.as_slice()).unwrap_or(&[]);
    let mut labels = vec![native.to_owned()];
    let mut values: Vec<Option<String>> = vec![None];
    if let Some(saved) = current_variant
        && !available.iter().any(|v| v == saved)
    {
        push_unique_label(&mut labels, format!("{saved} · {unavailable}"), saved);
        values.push(Some(saved.to_owned()));
    }
    for variant in available {
        let candidate = if variant == native || labels.contains(variant) {
            format!("{variant} · {}", t("missions.control.execution.variant"))
        } else {
            variant.clone()
        };
        push_unique_label(&mut labels, candidate, variant);
        values.push(Some(variant.clone()));
    }
    let current_index = current_variant
        .and_then(|saved| values.iter().position(|v| v.as_deref() == Some(saved)))
        .unwrap_or(0);
    let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
    let picker_id = Picker::RoleVariant(index);
    let is_open = open_picker == Some(picker_id) && !control_disabled;
    let aria = format!("{title} · {}", t("missions.control.execution.variant"));
    let base = selected.cloned().unwrap_or_default();
    let labels_for_choose = labels.clone();
    let control = chrome::picker(&format!("mission-variant-{role}"), &aria, &refs)
        .current(Some(refs[current_index]))
        .disabled(control_disabled)
        .open(is_open)
        .on_toggle(move |s: &mut S| set_picker(s, (!is_open).then_some(picker_id)))
        .on_close(move |s: &mut S| set_picker(s, None))
        .on_choose(move |s: &mut S, value, _| {
            set_picker(s, None);
            if let Some(pos) = labels_for_choose.iter().position(|label| label == value)
                && let Some(mut model) = base.model.clone()
            {
                let chosen = values[pos].clone();
                if chosen != model.variant {
                    model.variant = chosen;
                    let mut next = base.clone();
                    next.model = Some(model);
                    change_role(s, role, Some(next));
                }
            }
        });
    chrome::build_picker(control, layers)
}
