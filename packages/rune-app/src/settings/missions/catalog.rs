//! Lazy native agent/model/provider catalog for Mission execution profiles.
use super::Picker;
use crate::{
    platform,
    settings::{
        preferences::{Owner, Preferences},
        providers::Target,
    },
    strings::{locale, t},
};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::missions::{
        MissionCatalog, MissionDefaultScope, MissionExecution, MissionModelRef, MissionProfiles,
        MissionTaskMode, MissionTemplate, ProfileModel, execution_label, legal_profile_agents,
        read_mission_catalog, role_profile, summary_groups,
    },
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
    settings as chrome,
};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

type Flight = (Sender<()>, Receiver<Option<MissionCatalog>>);

#[derive(Default)]
pub(super) struct State {
    scope: Option<(String, String, Option<String>)>,
    authority: u64,
    seen: Option<u64>,
    manual_epoch: u64,
    flight: Option<Flight>,
    catalog: Option<MissionCatalog>,
    known_names: BTreeMap<(String, String), String>,
    pub(super) failed: bool,
}

impl State {
    pub(super) fn suspend(&mut self) {
        self.flight = None;
        self.seen = None;
    }

    pub(super) fn request_reload(&mut self) {
        self.manual_epoch = self.manual_epoch.wrapping_add(1);
        self.seen = None;
        self.failed = false;
    }

    pub(super) fn loading(&self) -> bool {
        self.flight.is_some()
    }

    pub(super) fn model_name(&self, model: &MissionModelRef) -> Option<String> {
        self.known_names
            .get(&(model.provider_id.clone(), model.id.clone()))
            .cloned()
    }

    pub(super) fn poll(
        &mut self,
        target: Option<&Target>,
        demanded: bool,
        wake: &rune::Waker,
    ) -> bool {
        let Some(target) = target.filter(|target| demanded && target.online()) else {
            let changed = self.flight.is_some() || self.seen.is_some();
            self.flight = None;
            self.seen = None;
            if target.is_none_or(|t| !t.online()) && self.catalog.is_some() {
                self.catalog = None;
                self.failed = false;
                return true;
            }
            return changed;
        };
        let (backend, workspace, authority, _) = target.stats_source();
        let (_, session) = target.location();
        let scope = (
            backend.client_id.clone(),
            workspace.to_owned(),
            session.map(str::to_owned),
        );
        let mut changed = false;
        if self.scope.as_ref() != Some(&scope) || self.authority != authority {
            self.scope = Some(scope);
            self.authority = authority;
            self.seen = None;
            self.flight = None;
            self.catalog = None;
            self.known_names.clear();
            self.failed = false;
            changed = true;
        }
        let revision = target.revision().wrapping_add(self.manual_epoch);
        if let Some(result) = self
            .flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.flight = None;
            if self.seen == Some(revision) {
                match result {
                    Some(catalog) => {
                        for model in &catalog.models {
                            self.known_names.insert(
                                (model.provider_id.clone(), model.id.clone()),
                                model.name.clone(),
                            );
                        }
                        self.catalog = Some(catalog);
                        self.failed = false;
                    }
                    None => {
                        self.failed = true;
                    }
                }
            }
            changed = true;
        }
        if self.flight.is_none() && self.seen != Some(revision) {
            let (cancel, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            let backend = backend.clone();
            let workspace = workspace.to_owned();
            let session = session.map(str::to_owned);
            let wake = wake.clone();
            self.seen = Some(revision);
            self.flight = Some((cancel, inbox));
            self.failed = false;
            platform::spawn(async move {
                if let Some(result) = platform::reads::cancellable(
                    &cancelled,
                    read_mission_catalog(&backend, &workspace, session.as_deref()),
                )
                .await
                    && out.send(result.ok()).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        changed
    }

    pub(super) fn inline_summary(
        &self,
        profiles: Option<&MissionProfiles>,
        template: MissionTemplate,
    ) -> Option<String> {
        let groups = summary_groups(profiles, template);
        if groups.len() == 1 && groups[0].1.is_none() {
            return None;
        }
        let native = t("missions.control.execution.nativeDefault");
        let parts: Vec<_> = groups
            .into_iter()
            .map(|(roles, execution)| {
                let role_names: Vec<_> = roles.into_iter().map(role_label).collect();
                let value = execution_label(execution.as_ref(), |m| self.model_name(m))
                    .unwrap_or_else(|| native.to_owned());
                format!("{}: {value}", role_names.join(", "))
            })
            .collect();
        Some(parts.join(" · "))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn view_profiles<S: 'static>(
        &self,
        prefs: &Preferences,
        scope: MissionDefaultScope,
        own_profiles: Option<&MissionProfiles>,
        inherited: Option<&MissionProfiles>,
        task_mode: MissionTaskMode,
        disabled: bool,
        open_picker: Option<Picker>,
        layers: &mut Vec<El>,
        set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
        change_role: impl Fn(&mut S, &'static str, Option<MissionExecution>) + Clone + 'static,
        reset_profiles: impl Fn(&mut S) + Copy + 'static,
        reload_catalog: impl Fn(&mut S) + Copy + 'static,
    ) -> El {
        let template = scope.template();
        let all_roles: Vec<&'static str> = std::iter::once("coordinator")
            .chain(scope.roles().iter().copied())
            .collect();
        let catalog_agents = self
            .catalog
            .as_ref()
            .map(|c| c.agents.as_slice())
            .unwrap_or(&[]);
        let catalog_models = self
            .catalog
            .as_ref()
            .map(|c| c.models.as_slice())
            .unwrap_or(&[]);
        let shown_models = preferred_models(catalog_models, prefs.saved(Owner::Config));

        let mut stack = col()
            .role("region")
            .label(t("missions.control.profiles.title"))
            .full_width()
            .separate(Space::Sm);

        for (index, &role) in all_roles.iter().enumerate() {
            let own = own_profiles.and_then(|p| p.role(role));
            let customized = own.is_some();
            let selected = if inherited.is_some() && !customized {
                inherited.and_then(|p| p.role(role)).cloned()
            } else if template == MissionTemplate::Compare && role == "comparator" {
                role_profile(template, own_profiles, role)
            } else {
                own.cloned()
            };
            let title = role_label(role);
            let header = if inherited.is_some() {
                let trailing = if customized {
                    let revert_label =
                        catalogue::format(locale(), "missions.defaults.revert", &[("role", title)]);
                    let change_role = change_role.clone();
                    layout::button(
                        t("missions.preferences.reset"),
                        disabled,
                        move |s: &mut S| change_role(s, role, None),
                    )
                    .key(format!("mission-revert-{role}"))
                    .label(revert_label.clone())
                    .help(revert_label)
                } else {
                    text(t("missions.defaults.fromGlobal")).text_role(TextRole::Small)
                };
                chrome::setting_row(title, trailing)
            } else {
                text(title).text_role(TextRole::Button)
            };

            let available_agents =
                legal_profile_agents(catalog_agents, role == "coordinator", task_mode);
            let agent_picker = build_agent_picker(
                index,
                title,
                role,
                selected.as_ref(),
                &available_agents,
                disabled,
                open_picker,
                layers,
                set_picker,
                change_role.clone(),
            );
            let selected_model = selected.as_ref().and_then(|exec| {
                let model = exec.model.as_ref()?;
                catalog_models
                    .iter()
                    .find(|m| m.provider_id == model.provider_id && m.id == model.id)
            });
            let model_picker = build_model_picker(
                index,
                title,
                role,
                selected.as_ref(),
                selected_model,
                &shown_models,
                &self.known_names,
                disabled,
                open_picker,
                layers,
                set_picker,
                change_role.clone(),
            );
            let variant_picker = build_variant_picker(
                index,
                title,
                role,
                selected.as_ref(),
                selected_model,
                disabled,
                open_picker,
                layers,
                set_picker,
                change_role.clone(),
            );

            stack = stack.child(
                col()
                    .key(format!("mission-role-{role}"))
                    .role("group")
                    .label(title)
                    .full_width()
                    .separate(Space::Xs)
                    .child(header)
                    .child(chrome::setting_row(
                        t("missions.control.execution.agent"),
                        agent_picker,
                    ))
                    .child(chrome::setting_row(
                        t("missions.control.execution.model"),
                        model_picker,
                    ))
                    .child(chrome::setting_row(
                        t("missions.control.execution.variant"),
                        variant_picker,
                    )),
            );
        }

        let has_any = own_profiles.is_some_and(MissionProfiles::has_any);
        stack = stack.child(
            layout::action_row().child(
                layout::button(
                    t("missions.preferences.reset"),
                    disabled || !has_any,
                    reset_profiles,
                )
                .key("mission-reset-profiles")
                .label(t("missions.defaults.resetProfiles"))
                .help(t("missions.defaults.resetProfiles")),
            ),
        );

        if self.failed {
            stack = stack.child(
                layout::action_row()
                    .child(
                        text(t("missions.control.profiles.error"))
                            .wrap()
                            .role("status"),
                    )
                    .child(
                        layout::button(
                            t("missions.preferences.reload"),
                            disabled || self.loading(),
                            reload_catalog,
                        )
                        .key("mission-catalog-reload"),
                    ),
            );
        }

        stack
    }
}

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

fn preferred_models<'a>(
    models: &'a [ProfileModel],
    config: Option<&Value>,
) -> Vec<&'a ProfileModel> {
    let settings = config.and_then(|doc| doc.get("settings"));
    let visibility = settings
        .and_then(|s| s.get("modelVisibility"))
        .and_then(Value::as_object);
    let visible: Vec<&'a ProfileModel> = models
        .iter()
        .filter(|model| {
            let Some(pref) = visibility.and_then(|map| map.get(&model.provider_id)) else {
                return true;
            };
            let hidden = pref["hiddenModels"]
                .as_array()
                .is_some_and(|list| list.iter().any(|v| v.as_str() == Some(&model.id)));
            !hidden
        })
        .collect();
    let favorites_only = settings
        .and_then(|s| s.get("modelPickerFavoritesOnly"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !favorites_only {
        return visible;
    }
    let favorite_keys: HashSet<(String, String)> = settings
        .and_then(|s| s.get("favoriteModels"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some((
                item["providerId"].as_str()?.to_owned(),
                item["modelId"].as_str()?.to_owned(),
            ))
        })
        .collect();
    let favorites: Vec<_> = visible
        .iter()
        .copied()
        .filter(|m| favorite_keys.contains(&(m.provider_id.clone(), m.id.clone())))
        .collect();
    if favorites.is_empty() {
        visible
    } else {
        favorites
    }
}

#[allow(clippy::too_many_arguments)]
fn build_agent_picker<S: 'static>(
    index: usize,
    title: &str,
    role: &'static str,
    selected: Option<&MissionExecution>,
    available: &[&codenomad_client::settings::missions::ProfileAgent],
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
        labels.push(format!("{saved} · {unavailable}"));
        values.push(Some(saved.to_owned()));
    }
    for agent in available {
        labels.push(agent.id.clone());
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
                let mut next = base.clone();
                next.agent = values[pos].clone();
                change_role(s, role, Some(next));
            }
        });
    chrome::build_picker(control, layers)
}

#[allow(clippy::too_many_arguments)]
fn build_model_picker<S: 'static>(
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
        labels.push(format!("{display} · {unavailable}"));
        values.push(Some(saved.clone()));
    }
    for m in &models {
        let base_label = format!("{} · {}", m.provider_name, m.name);
        let label = if counts
            .get(&(m.provider_name.clone(), m.name.clone()))
            .copied()
            .unwrap_or(0)
            > 1
        {
            format!("{base_label} ({})", m.id)
        } else {
            base_label
        };
        labels.push(label);
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
                let mut next = base.clone();
                // Switching models clears any incompatible variant.
                next.model = values[pos].clone();
                change_role(s, role, Some(next));
            }
        });
    chrome::build_picker(control, layers)
}

#[allow(clippy::too_many_arguments)]
fn build_variant_picker<S: 'static>(
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
        labels.push(format!("{saved} · {unavailable}"));
        values.push(Some(saved.to_owned()));
    }
    for variant in available {
        labels.push(variant.clone());
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
                model.variant = values[pos].clone();
                let mut next = base.clone();
                next.model = Some(model);
                change_role(s, role, Some(next));
            }
        });
    chrome::build_picker(control, layers)
}
