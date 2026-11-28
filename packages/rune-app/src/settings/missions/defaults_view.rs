//! Defaults card view for Preferences → Missions (scope, task mode, folded profiles, deleteSessions).
use super::{Confirm, InfoTip, Missions, Picker, defaults};
use crate::{
    settings::preferences::{Owner, Preferences},
    strings::{locale, t},
};
use codenomad_client::settings::missions::{
    MissionDefaultScope, MissionExecution, MissionPreferenceExpectation, MissionTaskMode,
    global_task_mode, mission_defaults_for, task_mode_for,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

impl Missions {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn view_defaults_card<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        prefs: &Preferences,
        active: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> Option<&mut Self>,
        toggle_info: impl Fn(&mut S, InfoTip) + Copy + 'static,
        set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
    ) -> El {
        let loaded = prefs.config_loaded();
        let read_failed = prefs.config_read_failed();
        let snapshot = prefs.saved(Owner::Config);
        let valid = defaults::defaults_valid(loaded, snapshot);
        let writing = prefs.missions.defaults.writing();
        let reloading = prefs.missions.defaults.reloading;
        let needs_reload = prefs.missions.defaults.needs_reload;
        let disabled = !active || reloading || needs_reload || (!writing && (!loaded || !valid));
        let shown = prefs.missions.defaults.shown(snapshot);
        let scope = prefs.missions.scope();
        let exception = scope.exception();
        let entry = shown.iter().find(|item| item.template == scope);
        let global_mode = global_task_mode(&shown);
        let has_target = prefs.can_retry()
            && !prefs.is_transport_lost()
            && prefs.provider_target.as_ref().is_some_and(|t| {
                t.online()
                    && t.backend()
                        .client
                        .workspace_upstream_healthy(t.location().0)
            });

        let header = layout::action_row()
            .child(
                text(t("missions.defaults.title"))
                    .text_role(TextRole::Title)
                    .role("heading"),
            )
            .child(
                chrome::info_tip(
                    t("missions.defaults.title"),
                    t("missions.defaults.hint"),
                    self.info_open == Some(InfoTip::Defaults),
                    move |s: &mut S| toggle_info(s, InfoTip::Defaults),
                )
                .key("mission-defaults-info"),
            );
        let mut defaults_card = col().full_width().separate(Space::Sm).child(header);

        let shared_reload = shared.clone();
        let do_reload_defaults = move |s: &mut S| {
            let Some(m) = access(s) else { return };
            let mut prefs = shared_reload.borrow_mut();
            if let Some(wake) = m.resolve_wake(&prefs) {
                prefs.start_mission_defaults_reload(&wake);
            }
        };

        if !loaded && !writing {
            let label = if read_failed {
                t("missions.defaults.unavailable")
            } else {
                t("missions.defaults.loading")
            };
            defaults_card = defaults_card.child(text(label).wrap().role(if read_failed {
                "alert"
            } else {
                "status"
            }));
            if read_failed {
                defaults_card = defaults_card.child(
                    layout::action_row().child(
                        layout::button(
                            t("missions.preferences.reload"),
                            reloading || !active,
                            do_reload_defaults.clone(),
                        )
                        .key("mission-defaults-reload-unavailable")
                        .label(t("missions.defaults.reload"))
                        .help(t("missions.defaults.reload")),
                    ),
                );
            }
        }

        if loaded && !valid && !writing {
            let shared_repair = shared.clone();
            defaults_card = defaults_card
                .child(text(t("missions.defaults.invalid")).wrap().role("alert"))
                .child(
                    layout::action_row()
                        .child(
                            layout::button(
                                t("missions.defaults.reset"),
                                !active || reloading || needs_reload,
                                move |s: &mut S| {
                                    let Some(m) = access(s) else { return };
                                    let prefs = shared_repair.borrow();
                                    if let Some(backend) = prefs.backend.as_ref() {
                                        m.confirm = Some(Confirm::RepairDefaults {
                                            owner: backend.client_id.clone(),
                                            expected: MissionPreferenceExpectation::from_ui_config(
                                                prefs.saved(Owner::Config),
                                                "missionProfileDefaults",
                                            ),
                                        });
                                    }
                                },
                            )
                            .key("mission-defaults-repair"),
                        )
                        .child(
                            layout::button(
                                t("missions.preferences.reload"),
                                !active || reloading,
                                do_reload_defaults.clone(),
                            )
                            .key("mission-defaults-reload-invalid")
                            .label(t("missions.defaults.reload"))
                            .help(t("missions.defaults.reload")),
                        ),
                );
        }

        let scope_labels: Vec<&str> = MissionDefaultScope::ALL
            .iter()
            .map(|item| t(item.label_key()))
            .collect();
        let scope_labels_choose: Vec<String> =
            scope_labels.iter().map(|s| (*s).to_owned()).collect();
        let scope_index = MissionDefaultScope::ALL
            .iter()
            .position(|item| *item == scope)
            .unwrap_or(0);
        let scope_open = self.open_picker == Some(Picker::Scope) && !disabled;
        let shared_scope = shared.clone();
        let scope_picker =
            chrome::picker("mission-scope", t("missions.defaults.scope"), &scope_labels)
                .current(Some(scope_labels[scope_index]))
                .disabled(disabled)
                .open(scope_open)
                .on_toggle(move |s: &mut S| set_picker(s, (!scope_open).then_some(Picker::Scope)))
                .on_close(move |s: &mut S| set_picker(s, None))
                .on_choose(move |s: &mut S, value, _| {
                    set_picker(s, None);
                    if access(s).is_some()
                        && let Some(pos) =
                            scope_labels_choose.iter().position(|label| label == value)
                    {
                        shared_scope
                            .borrow_mut()
                            .missions
                            .set_scope(MissionDefaultScope::ALL[pos]);
                    }
                });
        defaults_card = defaults_card.child(chrome::setting_row(
            t("missions.defaults.scope"),
            chrome::build_picker(scope_picker, layers),
        ));

        let mut mode_labels = Vec::new();
        let mut mode_values: Vec<Option<MissionTaskMode>> = Vec::new();
        if exception.is_some() {
            mode_labels.push(catalogue::format(
                locale(),
                "missions.defaults.inheritGlobal",
                &[("value", t(global_mode.label_key()))],
            ));
            mode_values.push(None);
        }
        mode_labels.push(t(MissionTaskMode::Native.label_key()).to_owned());
        mode_values.push(Some(MissionTaskMode::Native));
        mode_labels.push(t(MissionTaskMode::Independent.label_key()).to_owned());
        mode_values.push(Some(MissionTaskMode::Independent));
        let current_mode = if exception.is_some() {
            entry.and_then(|item| item.task_mode)
        } else {
            Some(global_mode)
        };
        let mode_index = mode_values
            .iter()
            .position(|v| *v == current_mode)
            .unwrap_or(0);
        let mode_refs: Vec<&str> = mode_labels.iter().map(String::as_str).collect();
        let mode_open = self.open_picker == Some(Picker::TaskMode) && !disabled;
        let mode_labels_choose = mode_labels.clone();
        let mode_basis = entry.and_then(|item| item.task_mode);
        let shared_mode = shared.clone();
        let mode_picker = chrome::picker(
            "mission-task-mode",
            t("missions.taskMode.label"),
            &mode_refs,
        )
        .current(Some(mode_refs[mode_index]))
        .disabled(disabled)
        .open(mode_open)
        .on_toggle(move |s: &mut S| set_picker(s, (!mode_open).then_some(Picker::TaskMode)))
        .on_close(move |s: &mut S| set_picker(s, None))
        .on_choose(move |s: &mut S, value, _| {
            set_picker(s, None);
            if access(s).is_some()
                && let Some(pos) = mode_labels_choose.iter().position(|label| label == value)
            {
                let next = mode_values[pos];
                if next != mode_basis {
                    shared_mode.borrow_mut().missions.defaults.queue(
                        defaults::DefaultsEdit::TaskMode {
                            scope,
                            basis: mode_basis,
                            next,
                        },
                    );
                }
            }
        });
        let task_mode_info = chrome::info_tip(
            t("missions.taskMode.label"),
            t("missions.taskMode.hint"),
            self.info_open == Some(InfoTip::TaskMode),
            move |s: &mut S| toggle_info(s, InfoTip::TaskMode),
        )
        .key("mission-task-mode-info");
        defaults_card = defaults_card.child(chrome::setting_row_with_info(
            t("missions.taskMode.label"),
            Some(task_mode_info),
            chrome::build_picker(mode_picker, layers),
        ));

        let own_profiles = entry.map(|item| &item.profiles);
        let summary_profiles = exception
            .map(|tpl| mission_defaults_for(&shown, tpl, true))
            .unwrap_or_else(|| own_profiles.cloned());
        let inherited_profiles =
            exception.map(|tpl| mission_defaults_for(&shown, tpl, false).unwrap_or_default());
        let effective_mode = exception
            .map(|tpl| task_mode_for(&shown, tpl))
            .unwrap_or(global_mode);
        let disclosure_label = match self
            .catalog
            .inline_summary(summary_profiles.as_ref(), scope.template())
        {
            Some(summary) => format!("{} · {summary}", t("missions.create.agents")),
            None => t("missions.create.agents").to_owned(),
        };
        let shown_profiles = own_profiles.cloned();
        let shared_role = shared.clone();
        let shared_reset_profiles = shared.clone();
        let profiles_body = self.catalog.view_profiles(
            prefs,
            scope,
            own_profiles,
            inherited_profiles.as_ref(),
            effective_mode,
            disabled || !has_target,
            disabled,
            self.open_picker,
            layers,
            set_picker,
            move |s: &mut S, role, execution: Option<MissionExecution>| {
                if access(s).is_some() {
                    let basis = shown_profiles.as_ref().and_then(|p| p.role(role)).cloned();
                    shared_role.borrow_mut().missions.defaults.queue(
                        defaults::DefaultsEdit::Role {
                            scope,
                            role,
                            basis,
                            next: execution,
                        },
                    );
                }
            },
            move |s: &mut S| {
                let Some(m) = access(s) else { return };
                let prefs = shared_reset_profiles.borrow();
                if let Some(backend) = prefs.backend.as_ref() {
                    m.confirm = Some(Confirm::ResetProfiles {
                        scope,
                        owner: backend.client_id.clone(),
                        expected: prefs
                            .missions
                            .defaults
                            .expected_after_pending(prefs.saved(Owner::Config)),
                    });
                }
            },
            {
                let shared_catalog_reload = shared.clone();
                move |s: &mut S| {
                    if let Some(m) = access(s) {
                        shared_catalog_reload.borrow_mut().missions.retry_location();
                        m.catalog.request_reload();
                    }
                }
            },
        );
        let shared_profiles_toggle = shared.clone();
        defaults_card = defaults_card.child(chrome::disclosure(
            &disclosure_label,
            prefs.missions.profiles_open(),
            profiles_body,
            move |s: &mut S| {
                if access(s).is_some() {
                    shared_profiles_toggle
                        .borrow_mut()
                        .missions
                        .toggle_profiles_open();
                }
            },
        ));

        if prefs.missions.defaults.failed {
            defaults_card =
                defaults_card.child(text(t("missions.defaults.error")).wrap().role("alert"));
        }
        if needs_reload && valid {
            defaults_card = defaults_card.child(
                layout::action_row().child(
                    layout::button(
                        t("missions.preferences.reload"),
                        !active || reloading,
                        do_reload_defaults,
                    )
                    .key("mission-defaults-reload-error")
                    .label(t("missions.defaults.reload"))
                    .help(t("missions.defaults.reload")),
                ),
            );
        }

        let delete_checked = prefs.missions.defaults.delete_sessions_shown(snapshot);
        let shared_delete = shared.clone();
        defaults_card = defaults_card.child(chrome::setting_row(
            t("missions.preferences.deleteSessions"),
            chrome::setting_switch(
                t("missions.preferences.deleteSessions"),
                delete_checked,
                !active || !loaded || prefs.missions.defaults.busy_delete(),
                move |s: &mut S| {
                    let Some(m) = access(s) else { return };
                    let mut prefs = shared_delete.borrow_mut();
                    if let Some(wake) = m.resolve_wake(&prefs) {
                        prefs.toggle_mission_delete_sessions(!delete_checked, &wake);
                    }
                },
            )
            .key("mission-delete-sessions"),
        ));
        if prefs.missions.defaults.delete_failed {
            defaults_card = defaults_card.child(
                text(t("settings.preferenceSaveFailed"))
                    .wrap()
                    .role("alert"),
            );
        }

        chrome::card(defaults_card)
    }
}
