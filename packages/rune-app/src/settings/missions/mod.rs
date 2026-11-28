//! Preferences → Missions: defaults, native profiles, subagent depth, and saved configurations.
mod catalog;
mod defaults;
mod defaults_view;
mod depth;
mod depth_view;
mod library;
mod pickers;
mod shared;

pub(super) use shared::{ConfigContext, ConfigEffects, SendAuthority, Shared, opener_directory};

use super::{
    preferences::{Owner, Preferences},
    providers::Target,
};
use crate::strings::{locale, t};
use codenomad_client::settings::missions::{MissionDefaultScope, MissionPreferenceExpectation};
use rune::{El, Waker, col};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
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

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Confirm {
    ResetProfiles {
        scope: MissionDefaultScope,
        owner: String,
        expected: MissionPreferenceExpectation,
    },
    RepairDefaults {
        owner: String,
        expected: MissionPreferenceExpectation,
    },
    RemoveModel {
        id: String,
        name: String,
        owner: String,
        expected: MissionPreferenceExpectation,
    },
    ResetModels {
        owner: String,
        expected: MissionPreferenceExpectation,
    },
    RefreshDepth,
}

#[derive(Default)]
pub(super) struct Missions {
    catalog: catalog::State,
    open_picker: Option<Picker>,
    info_open: Option<InfoTip>,
    confirm: Option<Confirm>,
    wake: Option<Waker>,
}

impl Missions {
    pub fn close(&mut self) {
        self.open_picker = None;
        self.info_open = None;
        self.confirm = None;
        self.catalog.suspend();
    }

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
        let writes_changed = prefs.poll_missions_writes(wake);
        let raw_target = prefs.provider_target.as_ref().filter(|_| prefs.can_retry());
        let upstream_healthy = raw_target.is_none_or(|t| {
            t.backend()
                .client
                .workspace_upstream_healthy(t.location().0)
        });
        let online = !prefs.is_transport_lost()
            && raw_target.is_some_and(Target::online)
            && upstream_healthy;
        let online_target = raw_target.filter(|_| online);
        let config_disabled = prefs.missions.defaults.reloading
            || prefs.missions.defaults.needs_reload
            || (!prefs.missions.defaults.writing()
                && !defaults::defaults_valid(prefs.config_loaded(), prefs.saved(Owner::Config)));
        let catalog_demanded = active && !config_disabled;
        let open_epoch = prefs.missions.open_epoch();
        let (location_changed, location_failed) = prefs
            .missions
            .poll_location(raw_target, online, active, wake);
        let catalog_changed = self.catalog.poll(
            online_target,
            prefs.missions.pinned_directory(),
            location_failed,
            open_epoch,
            catalog_demanded,
            wake,
        );
        let depth_changed = if active {
            let transport_lost = prefs.is_transport_lost() || !upstream_healthy;
            let authority = prefs.authority_handle();
            prefs.missions.poll_depth(
                raw_target,
                location_failed,
                transport_lost,
                true,
                &authority,
                wake,
            )
        } else {
            prefs.missions.suspend_reads();
            false
        };
        writes_changed | location_changed | catalog_changed | depth_changed
    }

    pub(super) fn resolve_wake(&self, prefs: &Preferences) -> Option<Waker> {
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
        let has_target = prefs.can_retry()
            && !prefs.is_transport_lost()
            && prefs.provider_target.as_ref().is_some_and(|t| {
                t.online()
                    && t.backend()
                        .client
                        .workspace_upstream_healthy(t.location().0)
            });

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

        let defaults_card = self.view_defaults_card(
            shared,
            &prefs,
            active,
            layers,
            access,
            toggle_info,
            set_picker,
        );

        let shared_depth_choose = shared.clone();
        let shared_depth_refresh = shared.clone();
        let depth_card = prefs.missions.depth.view(
            active,
            has_target,
            prefs.missions.pinned_directory(),
            self.info_open,
            self.open_picker,
            layers,
            toggle_info,
            set_picker,
            move |s: &mut S, value| {
                if access(s).is_some() {
                    let mut prefs = shared_depth_choose.borrow_mut();
                    let pinned = prefs.missions.pinned_directory().map(str::to_owned);
                    prefs
                        .missions
                        .depth
                        .choose(value, active, has_target, pinned.as_deref());
                }
            },
            move |s: &mut S| {
                let Some(m) = access(s) else { return };
                let mut prefs = shared_depth_refresh.borrow_mut();
                if prefs.missions.depth.needs_confirm_refresh() {
                    m.confirm = Some(Confirm::RefreshDepth);
                } else {
                    prefs.missions.retry_location();
                    prefs.missions.depth.request_refresh();
                }
            },
        );

        let shared_lib_select = shared.clone();
        let shared_remove = shared.clone();
        let shared_reset = shared.clone();
        let shared_lib_reload = shared.clone();
        let library_card = prefs.missions.library.view(
            &prefs,
            active,
            self.open_picker,
            layers,
            set_picker,
            move |s: &mut S, id| {
                if access(s).is_some() {
                    shared_lib_select.borrow_mut().missions.library.select(id);
                }
            },
            move |s: &mut S| {
                let Some(m) = access(s) else { return };
                let prefs = shared_remove.borrow();
                if let Some(backend) = prefs.backend.as_ref()
                    && let Some(model) = prefs
                        .missions
                        .library
                        .selected_model(prefs.saved(Owner::Config))
                {
                    m.confirm = Some(Confirm::RemoveModel {
                        id: model.id,
                        name: model.name,
                        owner: backend.client_id.clone(),
                        expected: MissionPreferenceExpectation::from_ui_config(
                            prefs.saved(Owner::Config),
                            "missionModels",
                        ),
                    });
                }
            },
            move |s: &mut S| {
                let Some(m) = access(s) else { return };
                let prefs = shared_reset.borrow();
                if let Some(backend) = prefs.backend.as_ref() {
                    m.confirm = Some(Confirm::ResetModels {
                        owner: backend.client_id.clone(),
                        expected: MissionPreferenceExpectation::from_ui_config(
                            prefs.saved(Owner::Config),
                            "missionModels",
                        ),
                    });
                }
            },
            move |s: &mut S| {
                let Some(m) = access(s) else { return };
                let mut prefs = shared_lib_reload.borrow_mut();
                if let Some(wake) = m.resolve_wake(&prefs) {
                    prefs.start_mission_library_reload(&wake);
                }
            },
        );

        if let Some(confirm) = self.confirm.clone() {
            let shared_confirm = shared.clone();
            let (message, cancel_label, confirm_label) = confirm_copy(&confirm);
            layers.push(rune_theme_codenomad::document_reader::editor::confirmation(
                layout::dark(),
                &message,
                &cancel_label,
                &confirm_label,
                move |s: &mut S, accept, _| {
                    let Some(m) = access(s) else { return };
                    let taken = m.confirm.take();
                    if !accept || taken.as_ref() != Some(&confirm) {
                        return;
                    }
                    let mut prefs = shared_confirm.borrow_mut();
                    match confirm.clone() {
                        Confirm::ResetProfiles {
                            scope,
                            owner,
                            expected,
                        } => {
                            prefs
                                .missions
                                .defaults
                                .queue(defaults::DefaultsEdit::ResetProfiles {
                                    scope,
                                    owner,
                                    expected,
                                });
                        }
                        Confirm::RepairDefaults { owner, expected } => {
                            prefs
                                .missions
                                .defaults
                                .queue(defaults::DefaultsEdit::Repair { owner, expected });
                        }
                        Confirm::RemoveModel {
                            id,
                            owner,
                            expected,
                            ..
                        } => {
                            if let Some(wake) = m.resolve_wake(&prefs) {
                                prefs.start_mission_model_remove(&id, &owner, expected, &wake);
                            }
                        }
                        Confirm::ResetModels { owner, expected } => {
                            if let Some(wake) = m.resolve_wake(&prefs) {
                                prefs.start_mission_models_reset(&owner, expected, &wake);
                            }
                        }
                        Confirm::RefreshDepth => {
                            prefs.missions.retry_location();
                            prefs.missions.depth.request_refresh();
                        }
                    }
                },
            ));
        }

        col()
            .full_width()
            .separate(Space::Sm)
            .child(defaults_card)
            .child(depth_card)
            .child(library_card)
    }
}

fn confirm_copy(confirm: &Confirm) -> (String, String, String) {
    match confirm {
        Confirm::ResetProfiles { scope, .. } => (
            catalogue::format(
                locale(),
                "missions.defaults.resetProfilesConfirm",
                &[("scope", t(scope.label_key()))],
            ),
            t("missions.control.cancel").to_owned(),
            t("missions.preferences.reset").to_owned(),
        ),
        Confirm::RepairDefaults { .. } => (
            t("missions.defaults.repairConfirm").to_owned(),
            t("missions.control.cancel").to_owned(),
            t("missions.defaults.reset").to_owned(),
        ),
        Confirm::RemoveModel { name, .. } => (
            catalogue::format(locale(), "missions.models.removeConfirm", &[("name", name)]),
            t("missions.control.cancel").to_owned(),
            t("missions.models.remove").to_owned(),
        ),
        Confirm::ResetModels { .. } => (
            t("missions.models.resetConfirm").to_owned(),
            t("missions.control.cancel").to_owned(),
            t("missions.models.reset").to_owned(),
        ),
        Confirm::RefreshDepth => (
            t("settings.configFiles.confirmDiscard.message").to_owned(),
            t("settings.configFiles.confirmDiscard.cancelLabel").to_owned(),
            t("settings.configFiles.confirmDiscard.confirmLabel").to_owned(),
        ),
    }
}
