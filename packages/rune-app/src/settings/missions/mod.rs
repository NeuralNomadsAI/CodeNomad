//! Preferences → Missions: defaults, native profiles, subagent depth, and saved configurations.
mod catalog;
mod defaults;
mod depth;
mod library;

use super::{
    preferences::{Owner, Preferences},
    providers::Target,
};
use crate::strings::{locale, t};
use codenomad_client::settings::missions::{
    MissionDefaultScope, MissionExecution, MissionTaskMode, global_task_mode, mission_defaults_for,
    task_mode_for,
};
use rune::{El, Waker, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Picker {
    Scope,
    TaskMode,
    RoleAgent(usize),
    RoleModel(usize),
    RoleVariant(usize),
    Depth,
    Library,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum InfoTip {
    Defaults,
    TaskMode,
    Depth,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Confirm {
    ResetProfiles(MissionDefaultScope),
    RepairDefaults,
    RemoveModel { id: String, name: String },
    ResetModels,
    RefreshDepth,
}

pub(super) struct Missions {
    scope: MissionDefaultScope,
    profiles_open: bool,
    defaults: defaults::State,
    catalog: catalog::State,
    depth: depth::State,
    library: library::State,
    open_picker: Option<Picker>,
    info_open: Option<InfoTip>,
    confirm: Option<Confirm>,
    wake: Option<Waker>,
}

impl Default for Missions {
    fn default() -> Self {
        Self {
            scope: MissionDefaultScope::All,
            profiles_open: false,
            defaults: defaults::State::default(),
            catalog: catalog::State::default(),
            depth: depth::State::default(),
            library: library::State::default(),
            open_picker: None,
            info_open: None,
            confirm: None,
            wake: None,
        }
    }
}

impl Missions {
    pub fn close(&mut self) {
        self.open_picker = None;
        self.info_open = None;
        self.confirm = None;
        self.catalog.suspend();
        self.depth.suspend();
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn cancel_confirm(&mut self) -> bool {
        if self.confirm.take().is_some() {
            return true;
        }
        if self.open_picker.take().is_some() {
            return true;
        }
        self.info_open.take().is_some()
    }

    pub fn poll(&mut self, prefs: &mut Preferences, wake: &Waker, active: bool) -> bool {
        self.wake = Some(wake.clone());
        let defaults_changed = self.defaults.poll(prefs, wake);
        let library_changed = self.library.poll(prefs);
        let target = prefs.provider_target.as_ref().filter(|_| prefs.can_retry());
        let config_disabled = self.defaults.reloading
            || (!self.defaults.writing() && !defaults::defaults_valid(prefs));
        let catalog_demanded = active && !config_disabled;
        let catalog_changed = self.catalog.poll(target, catalog_demanded, wake);
        let depth_changed = self.depth.poll(target, active, wake);
        defaults_changed | library_changed | catalog_changed | depth_changed
    }

    fn resolve_wake(&self, prefs: &Preferences) -> Option<Waker> {
        self.wake
            .clone()
            .or_else(|| prefs.window_wake.clone())
            .or_else(|| prefs.main_wake.clone())
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        active: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> Option<&mut Self>,
    ) -> El {
        let prefs = shared.borrow();
        let loaded = prefs.config_loaded();
        let read_failed = prefs.config_read_failed();
        let valid = defaults::defaults_valid(&prefs);
        let writing = self.defaults.writing();
        let disabled = !active || self.defaults.reloading || (!writing && (!loaded || !valid));
        let shown = self.defaults.shown(&prefs);
        let scope = self.scope;
        let exception = scope.exception();
        let entry = shown.iter().find(|item| item.template == scope);
        let global_mode = global_task_mode(&shown);
        let target = prefs.provider_target.as_ref().filter(|_| {
            prefs.can_retry() && prefs.provider_target.as_ref().is_some_and(Target::online)
        });
        let has_target = target.is_some();

        let toggle_info = move |s: &mut S, tip: InfoTip| {
            if let Some(m) = access(s) {
                m.info_open = (m.info_open != Some(tip)).then_some(tip);
            }
        };
        let set_picker = move |s: &mut S, picker: Option<Picker>| {
            if let Some(m) = access(s) {
                m.open_picker = picker;
            }
        };

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
            let Some(m) = access(s) else {
                return;
            };
            let mut prefs = shared_reload.borrow_mut();
            if let Some(wake) = m.resolve_wake(&prefs) {
                m.defaults.start_reload(&mut prefs, &wake);
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
                            self.defaults.reloading || !active,
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
            defaults_card = defaults_card
                .child(text(t("missions.defaults.invalid")).wrap().role("alert"))
                .child(
                    layout::action_row()
                        .child(
                            layout::button(
                                t("missions.defaults.reset"),
                                !active || self.defaults.reloading,
                                move |s: &mut S| {
                                    if let Some(m) = access(s) {
                                        m.confirm = Some(Confirm::RepairDefaults);
                                    }
                                },
                            )
                            .key("mission-defaults-repair"),
                        )
                        .child(
                            layout::button(
                                t("missions.preferences.reload"),
                                !active || self.defaults.reloading,
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
        let scope_index = MissionDefaultScope::ALL
            .iter()
            .position(|item| *item == scope)
            .unwrap_or(0);
        let scope_open = self.open_picker == Some(Picker::Scope) && !disabled;
        let scope_picker =
            chrome::picker("mission-scope", t("missions.defaults.scope"), &scope_labels)
                .current(Some(scope_labels[scope_index]))
                .disabled(disabled)
                .open(scope_open)
                .on_toggle(move |s: &mut S| set_picker(s, (!scope_open).then_some(Picker::Scope)))
                .on_close(move |s: &mut S| set_picker(s, None))
                .on_choose(move |s: &mut S, value, _| {
                    set_picker(s, None);
                    if let Some(m) = access(s)
                        && let Some(pos) = MissionDefaultScope::ALL
                            .iter()
                            .position(|item| t(item.label_key()) == value)
                    {
                        m.scope = MissionDefaultScope::ALL[pos];
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
            if let Some(m) = access(s)
                && let Some(pos) = mode_labels_choose.iter().position(|label| label == value)
            {
                let next = mode_values[pos];
                if next != mode_basis {
                    m.defaults.queue(defaults::DefaultsEdit::TaskMode {
                        scope,
                        basis: mode_basis,
                        next,
                    });
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
        let profiles_body = self.catalog.view_profiles(
            &prefs,
            scope,
            own_profiles,
            inherited_profiles.as_ref(),
            effective_mode,
            disabled || !has_target,
            self.open_picker,
            layers,
            set_picker,
            move |s: &mut S, role, execution: Option<MissionExecution>| {
                if let Some(m) = access(s) {
                    let basis = shown_profiles.as_ref().and_then(|p| p.role(role)).cloned();
                    m.defaults.queue(defaults::DefaultsEdit::Role {
                        scope,
                        role,
                        basis,
                        next: execution,
                    });
                }
            },
            move |s: &mut S| {
                if let Some(m) = access(s) {
                    m.confirm = Some(Confirm::ResetProfiles(scope));
                }
            },
            move |s: &mut S| {
                if let Some(m) = access(s) {
                    m.catalog.request_reload();
                }
            },
        );
        defaults_card = defaults_card.child(chrome::disclosure(
            &disclosure_label,
            self.profiles_open,
            profiles_body,
            move |s: &mut S| {
                if let Some(m) = access(s) {
                    m.profiles_open = !m.profiles_open;
                }
            },
        ));

        if self.defaults.failed {
            defaults_card =
                defaults_card.child(text(t("missions.defaults.error")).wrap().role("alert"));
        }

        let delete_checked = self.defaults.delete_sessions_shown(&prefs);
        let shared_delete = shared.clone();
        defaults_card = defaults_card.child(chrome::setting_row(
            t("missions.preferences.deleteSessions"),
            chrome::setting_switch(
                t("missions.preferences.deleteSessions"),
                delete_checked,
                !active || !loaded || self.defaults.busy_delete(),
                move |s: &mut S| {
                    let Some(m) = access(s) else {
                        return;
                    };
                    let prefs = shared_delete.borrow();
                    if let Some(wake) = m.resolve_wake(&prefs) {
                        m.defaults
                            .toggle_delete_sessions(&prefs, !delete_checked, &wake);
                    }
                },
            )
            .key("mission-delete-sessions"),
        ));
        if self.defaults.delete_failed {
            defaults_card = defaults_card.child(
                text(t("settings.preferenceSaveFailed"))
                    .wrap()
                    .role("alert"),
            );
        }

        let depth_card = self.depth.view(
            active,
            has_target,
            self.info_open,
            self.open_picker,
            layers,
            toggle_info,
            set_picker,
            move |s: &mut S, value| {
                if let Some(m) = access(s) {
                    m.depth.choose(value, active, has_target);
                }
            },
            move |s: &mut S| {
                if let Some(m) = access(s) {
                    if m.depth.needs_confirm_refresh() {
                        m.confirm = Some(Confirm::RefreshDepth);
                    } else {
                        m.depth.request_refresh();
                    }
                }
            },
        );

        let shared_remove = shared.clone();
        let shared_lib_reload = shared.clone();
        let library_card = self.library.view(
            &prefs,
            active,
            self.open_picker,
            layers,
            set_picker,
            move |s: &mut S, id| {
                if let Some(m) = access(s) {
                    m.library.select(id);
                }
            },
            move |s: &mut S| {
                if let Some(m) = access(s) {
                    let prefs = shared_remove.borrow();
                    if let Some(model) = m.library.selected_model(&prefs) {
                        m.confirm = Some(Confirm::RemoveModel {
                            id: model.id,
                            name: model.name,
                        });
                    }
                }
            },
            move |s: &mut S| {
                if let Some(m) = access(s) {
                    m.confirm = Some(Confirm::ResetModels);
                }
            },
            move |s: &mut S| {
                if let Some(m) = access(s) {
                    let mut prefs = shared_lib_reload.borrow_mut();
                    if let Some(wake) = m.resolve_wake(&prefs) {
                        m.library.start_reload(&mut prefs, &wake);
                    }
                }
            },
        );

        if let Some(confirm) = self.confirm.clone() {
            let shared_confirm = shared.clone();
            let (message, cancel_label, confirm_label) = match &confirm {
                Confirm::ResetProfiles(scope) => (
                    catalogue::format(
                        locale(),
                        "missions.defaults.resetProfilesConfirm",
                        &[("scope", t(scope.label_key()))],
                    ),
                    t("missions.control.cancel").to_owned(),
                    t("missions.preferences.reset").to_owned(),
                ),
                Confirm::RepairDefaults => (
                    t("missions.defaults.repairConfirm").to_owned(),
                    t("missions.control.cancel").to_owned(),
                    t("missions.defaults.reset").to_owned(),
                ),
                Confirm::RemoveModel { name, .. } => (
                    catalogue::format(locale(), "missions.models.removeConfirm", &[("name", name)]),
                    t("missions.control.cancel").to_owned(),
                    t("missions.models.remove").to_owned(),
                ),
                Confirm::ResetModels => (
                    t("missions.models.resetConfirm").to_owned(),
                    t("missions.control.cancel").to_owned(),
                    t("missions.models.reset").to_owned(),
                ),
                Confirm::RefreshDepth => (
                    t("settings.configFiles.confirmDiscard.message").to_owned(),
                    t("settings.configFiles.confirmDiscard.cancelLabel").to_owned(),
                    t("settings.configFiles.confirmDiscard.confirmLabel").to_owned(),
                ),
            };
            layers.push(rune_theme_codenomad::document_reader::editor::confirmation(
                layout::dark(),
                &message,
                &cancel_label,
                &confirm_label,
                move |s: &mut S, accept, _| {
                    let Some(m) = access(s) else {
                        return;
                    };
                    let taken = m.confirm.take();
                    if !accept || taken.as_ref() != Some(&confirm) {
                        return;
                    }
                    match confirm.clone() {
                        Confirm::ResetProfiles(scope) => {
                            m.defaults
                                .queue(defaults::DefaultsEdit::ResetProfiles { scope });
                        }
                        Confirm::RepairDefaults => {
                            m.defaults.queue(defaults::DefaultsEdit::Repair);
                        }
                        Confirm::RemoveModel { id, .. } => {
                            let prefs = shared_confirm.borrow();
                            if let Some(wake) = m.resolve_wake(&prefs) {
                                m.library.start_remove(&prefs, &id, &wake);
                            }
                        }
                        Confirm::ResetModels => {
                            let prefs = shared_confirm.borrow();
                            if let Some(wake) = m.resolve_wake(&prefs) {
                                m.library.start_reset(&prefs, &wake);
                            }
                        }
                        Confirm::RefreshDepth => {
                            m.depth.request_refresh();
                        }
                    }
                },
            ));
        }

        let _ = Owner::Config;
        col()
            .full_width()
            .separate(Space::Sm)
            .child(chrome::card(defaults_card))
            .child(depth_card)
            .child(library_card)
    }
}
