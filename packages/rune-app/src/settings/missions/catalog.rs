//! Lazy native agent/model/provider catalog for Mission execution profiles.
use super::{
    Picker,
    pickers::{build_agent_picker, build_model_picker, build_variant_picker, role_label},
};
use crate::{
    platform,
    settings::{
        preferences::{Owner, Preferences},
        providers::Target,
    },
    strings::{locale, t},
};
use codenomad_client::{
    Receiver, Sender, bounded, same_server_path,
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
    scope: Option<(String, String, u64)>,
    directory: Option<String>,
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
        pinned_directory: Option<&str>,
        location_failed: bool,
        open_epoch: u64,
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
        let scope = (backend.client_id.clone(), workspace.to_owned(), open_epoch);
        let mut changed = false;
        if self.scope.as_ref() != Some(&scope) || self.authority != authority {
            self.scope = Some(scope);
            self.directory = None;
            self.authority = authority;
            self.seen = None;
            self.flight = None;
            self.catalog = None;
            self.known_names.clear();
            self.failed = false;
            changed = true;
        }
        let Some(directory) = pinned_directory else {
            if self.directory.take().is_some()
                | self.flight.take().is_some()
                | self.seen.take().is_some()
                | self.catalog.take().is_some()
            {
                self.known_names.clear();
                self.failed = false;
                changed = true;
            }
            if location_failed && !self.failed {
                self.failed = true;
                changed = true;
            }
            return changed;
        };
        if self
            .directory
            .as_deref()
            .is_none_or(|prev| !same_server_path(prev, directory))
        {
            self.directory = Some(directory.to_owned());
            self.seen = None;
            self.flight = None;
            self.catalog = None;
            self.known_names.clear();
            self.failed = false;
            changed = true;
        }
        let revision = target
            .mission_catalog_revision()
            .wrapping_add(self.manual_epoch);
        if let Some(result) = self
            .flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.flight = None;
            if self.seen == Some(revision) {
                match result {
                    Some(catalog) => {
                        for (key, name) in &catalog.all_model_names {
                            self.known_names.insert(key.clone(), name.clone());
                        }
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
            let pinned = directory.to_owned();
            let wake = wake.clone();
            self.seen = Some(revision);
            self.flight = Some((cancel, inbox));
            self.failed = false;
            platform::spawn(async move {
                if let Some(result) = platform::reads::cancellable(
                    &cancelled,
                    read_mission_catalog(&backend, &workspace, session.as_deref(), Some(&pinned)),
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
        reset_disabled: bool,
        open_picker: Option<Picker>,
        layers: &mut Vec<El>,
        set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
        change_role: impl Fn(&mut S, &'static str, Option<MissionExecution>) + Clone + 'static,
        reset_profiles: impl Fn(&mut S) + Clone + 'static,
        reload_catalog: impl Fn(&mut S) + Clone + 'static,
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
        let shown_models = preferred_models(
            catalog_models,
            prefs.saved(Owner::Config),
            prefs.saved(Owner::State),
        );

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
                    chrome::secondary_action(
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
                    reset_disabled || !has_any,
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

fn preferred_models<'a>(
    models: &'a [ProfileModel],
    config: Option<&Value>,
    state: Option<&Value>,
) -> Vec<&'a ProfileModel> {
    let visibility = config
        .and_then(|doc| doc.get("settings"))
        .and_then(|s| s.get("modelVisibility"))
        .and_then(Value::as_object);
    let visible: Vec<&'a ProfileModel> = models
        .iter()
        .filter(|model| {
            let Some(pref) = visibility.and_then(|map| map.get(&model.provider_id)) else {
                return true;
            };
            let hidden = pref["hiddenModelIds"]
                .as_array()
                .is_some_and(|list| list.iter().any(|v| v.as_str() == Some(&model.id)));
            !hidden
        })
        .collect();
    let models_state = state.and_then(|doc| doc.get("models"));
    let favorites_only = models_state
        .and_then(|s| s.get("favoritesOnly"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !favorites_only {
        return visible;
    }
    let favorite_keys: HashSet<(String, String)> = models_state
        .and_then(|s| s.get("favorites"))
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
