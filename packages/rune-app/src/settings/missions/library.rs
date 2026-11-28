//! Saved Mission configurations (`missionModels`) section matching `MissionModelLibrary`.
use super::{ConfigContext, ConfigEffects, Picker, pickers::push_unique_label};
use crate::{
    platform,
    settings::preferences::{Owner, Preferences},
    strings::t,
};
use codenomad_client::{
    Receiver, bounded,
    settings::missions::{
        MissionPatchOutcome, MissionPreferenceExpectation, UserMissionModel,
        normalize_mission_models, patch_mission_preferences_checked, remove_mission_model_value,
        valid_mission_models,
    },
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

enum Reply {
    Remove {
        outcome: MissionPatchOutcome,
        pre_send_aborted: bool,
    },
    Reset {
        outcome: MissionPatchOutcome,
        pre_send_aborted: bool,
    },
}

enum PendingOp {
    Remove {
        id: String,
        confirmed_owner: String,
        confirmed_expected: MissionPreferenceExpectation,
    },
    Reset {
        confirmed_owner: String,
        confirmed_expected: MissionPreferenceExpectation,
    },
}

enum ReconcileExpectation {
    Removed(String),
    Reset,
}

#[derive(Default)]
pub(super) struct State {
    selected_id: String,
    pending_label: Option<&'static str>,
    failed: bool,
    needs_reload: bool,
    reconciliation_pending: bool,
    pending_op: Option<PendingOp>,
    flight: Option<Receiver<Reply>>,
    in_flight_expected: Option<ReconcileExpectation>,
    reconcile_expected: Option<ReconcileExpectation>,
    confirming: bool,
    reconciling: bool,
    reloading: bool,
}

pub(super) fn raw_models(snapshot: Option<&Value>) -> Option<&Value> {
    snapshot
        .and_then(|doc| doc.get("settings"))
        .and_then(|settings| settings.get("missionModels"))
}

pub(super) fn models_valid(config_loaded: bool, snapshot: Option<&Value>) -> bool {
    config_loaded && valid_mission_models(raw_models(snapshot))
}

impl State {
    pub(super) fn rebind(&mut self, same_address: bool) {
        if !same_address {
            *self = Self::default();
            return;
        }
        if self.reloading {
            self.reloading = false;
            self.pending_label = None;
        }
        if self.pending_op.take().is_some() {
            self.pending_label = None;
            self.failed = true;
            self.needs_reload = true;
        }
    }

    pub(super) fn write_in_flight(&self) -> bool {
        self.flight.is_some()
    }

    pub(super) fn pending(&self) -> bool {
        self.flight.is_some()
            || self.pending_op.is_some()
            || self.confirming
            || self.reconciling
            || self.reloading
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn draining(&self, can_start_write: bool, config_refreshing: bool) -> bool {
        self.flight.is_some()
            || (config_refreshing && (self.confirming || self.reconciling))
            || (can_start_write && self.pending_op.is_some())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn needs_config_revalidation(&self) -> bool {
        self.flight.is_some() || self.confirming || self.reconciling || self.pending_op.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        self.flight.is_some()
            || self.pending_op.is_some()
            || self.confirming
            || self.reconciling
            || self.failed
            || self.needs_reload
            || self.reconciliation_pending
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn pending_ops(&self) -> u32 {
        u32::from(self.pending_op.is_some()) + u32::from(self.flight.is_some())
    }

    pub(super) fn select(&mut self, id: String) {
        self.selected_id = id;
    }

    pub(super) fn selected_model(&self, snapshot: Option<&Value>) -> Option<UserMissionModel> {
        let models = normalize_mission_models(raw_models(snapshot));
        models
            .into_iter()
            .find(|model| model.id == self.selected_id)
    }

    pub(super) fn queue_remove(
        &mut self,
        ctx: &ConfigContext<'_>,
        id: &str,
        confirmed_owner: &str,
        confirmed_expected: MissionPreferenceExpectation,
    ) -> bool {
        if self.pending()
            || self.needs_reload
            || !models_valid(ctx.config_loaded, ctx.config_snapshot)
        {
            return false;
        }
        let Some(backend) = ctx.backend else {
            return false;
        };
        let current_expected =
            MissionPreferenceExpectation::from_ui_config(ctx.config_snapshot, "missionModels");
        if backend.client_id != confirmed_owner || current_expected != confirmed_expected {
            self.failed = true;
            self.needs_reload = true;
            return false;
        }
        let models = normalize_mission_models(raw_models(ctx.config_snapshot));
        if !models.iter().any(|model| model.id == id) {
            self.failed = true;
            self.needs_reload = true;
            return false;
        }
        self.pending_label = Some("missions.models.removing");
        self.failed = false;
        self.reconciliation_pending = false;
        self.pending_op = Some(PendingOp::Remove {
            id: id.to_owned(),
            confirmed_owner: confirmed_owner.to_owned(),
            confirmed_expected,
        });
        true
    }

    pub(super) fn queue_reset(
        &mut self,
        ctx: &ConfigContext<'_>,
        confirmed_owner: &str,
        confirmed_expected: MissionPreferenceExpectation,
    ) -> bool {
        if self.pending() || self.needs_reload || !ctx.config_loaded {
            return false;
        }
        let Some(backend) = ctx.backend else {
            return false;
        };
        let current_expected =
            MissionPreferenceExpectation::from_ui_config(ctx.config_snapshot, "missionModels");
        if backend.client_id != confirmed_owner || current_expected != confirmed_expected {
            self.failed = true;
            self.needs_reload = true;
            return false;
        }
        self.pending_label = Some("missions.models.resetting");
        self.failed = false;
        self.reconciliation_pending = false;
        self.pending_op = Some(PendingOp::Reset {
            confirmed_owner: confirmed_owner.to_owned(),
            confirmed_expected,
        });
        true
    }

    pub(super) fn start_reload(&mut self, ctx: &ConfigContext<'_>) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if self.pending() || !ctx.can_retry || ctx.backend.is_none() {
            return effects;
        }
        if ctx.transport_lost {
            effects.revalidate_transport = true;
        }
        self.pending_label = Some("missions.models.reloading");
        self.failed = false;
        self.reconciliation_pending = false;
        self.reloading = true;
        effects.invalidate = true;
        effects.changed = true;
        effects
    }

    pub(super) fn poll_replies(&mut self, ctx: &ConfigContext<'_>) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        let Some(reply) = self.flight.as_ref().and_then(|inbox| inbox.try_recv().ok()) else {
            return effects;
        };
        self.flight = None;
        let in_flight_expected = self.in_flight_expected.take();
        match reply {
            Reply::Remove {
                outcome,
                pre_send_aborted,
            }
            | Reply::Reset {
                outcome,
                pre_send_aborted,
            } => match outcome {
                MissionPatchOutcome::Applied(_) => {
                    self.selected_id.clear();
                    self.failed = false;
                    self.needs_reload = false;
                    self.reconciliation_pending = false;
                    self.reconcile_expected = None;
                    self.confirming = true;
                    effects.invalidate = true;
                }
                MissionPatchOutcome::Conflict | MissionPatchOutcome::Unsupported => {
                    self.failed = true;
                    self.needs_reload = true;
                    self.reconcile_expected = None;
                    if !pre_send_aborted && ctx.backend.is_some() && ctx.can_retry {
                        self.reconciling = true;
                        effects.invalidate = true;
                    } else {
                        self.pending_label = None;
                    }
                }
                MissionPatchOutcome::Failed => {
                    self.failed = true;
                    self.needs_reload = true;
                    if !pre_send_aborted && ctx.backend.is_some() && ctx.can_retry {
                        self.reconciling = true;
                        self.reconcile_expected = in_flight_expected;
                        effects.invalidate = true;
                    } else {
                        self.reconcile_expected = None;
                        self.pending_label = None;
                    }
                }
            },
        }
        effects.changed = true;
        effects.settled = true;
        effects
    }

    pub(super) fn settle_config(&mut self, ctx: &ConfigContext<'_>) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if ctx.config_refreshing {
            return effects;
        }
        if self.reloading {
            self.reloading = false;
            self.pending_label = None;
            self.reconcile_expected = None;
            if ctx.config_loaded {
                self.failed = false;
                self.needs_reload = false;
                self.reconciliation_pending = false;
            } else {
                self.failed = true;
                self.needs_reload = true;
            }
            effects.changed = true;
            effects.settled = true;
        }
        if self.confirming {
            self.confirming = false;
            self.pending_label = None;
            if !ctx.config_loaded {
                self.failed = true;
                self.needs_reload = true;
            }
            effects.changed = true;
            effects.settled = true;
        }
        if self.reconciling {
            self.reconciling = false;
            self.pending_label = None;
            let expected = self.reconcile_expected.take();
            let confirmed = ctx.config_loaded
                && models_valid(true, ctx.config_snapshot)
                && expected.is_some_and(|exp| {
                    let models = normalize_mission_models(raw_models(ctx.config_snapshot));
                    match exp {
                        ReconcileExpectation::Removed(id) => !models.iter().any(|m| m.id == id),
                        ReconcileExpectation::Reset => models.is_empty(),
                    }
                });
            if confirmed {
                self.selected_id.clear();
                self.failed = false;
                self.needs_reload = false;
                self.reconciliation_pending = false;
            } else {
                self.failed = true;
                self.needs_reload = true;
                if !ctx.config_loaded {
                    self.reconciliation_pending = true;
                }
            }
            effects.changed = true;
            effects.settled = true;
        }
        if !ctx.config_loaded && self.flight.is_none() && self.pending_op.take().is_some() {
            self.pending_label = None;
            self.failed = true;
            self.needs_reload = true;
            effects.changed = true;
            effects.settled = true;
        }
        effects
    }

    pub(super) fn launch_next(
        &mut self,
        ctx: &ConfigContext<'_>,
        #[cfg(test)] pre_patch_gate: &mut Option<Receiver<()>>,
        wake: &rune::Waker,
    ) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if self.flight.is_some() || self.confirming || self.reconciling || self.reloading {
            return effects;
        }
        let Some(op) = self.pending_op.take() else {
            return effects;
        };
        let Some(backend) = ctx.backend.cloned() else {
            self.pending_label = None;
            self.failed = true;
            self.needs_reload = true;
            effects.changed = true;
            return effects;
        };
        let current_expected =
            MissionPreferenceExpectation::from_ui_config(ctx.config_snapshot, "missionModels");
        let send_authority = ctx.send_authority(
            &backend,
            #[cfg(test)]
            pre_patch_gate.take(),
        );
        match op {
            PendingOp::Remove {
                id,
                confirmed_owner,
                confirmed_expected,
            } => {
                if !models_valid(ctx.config_loaded, ctx.config_snapshot)
                    || backend.client_id != confirmed_owner
                    || current_expected != confirmed_expected
                {
                    self.pending_label = None;
                    self.failed = true;
                    self.needs_reload = true;
                    effects.changed = true;
                    return effects;
                }
                let models = normalize_mission_models(raw_models(ctx.config_snapshot));
                if !models.iter().any(|model| model.id == id) {
                    self.pending_label = None;
                    self.failed = true;
                    self.needs_reload = true;
                    effects.changed = true;
                    return effects;
                }
                let next = remove_mission_model_value(&models, &id);
                let (out, inbox) = bounded(1);
                let wake = wake.clone();
                self.flight = Some(inbox);
                self.in_flight_expected = Some(ReconcileExpectation::Removed(id));
                platform::spawn(async move {
                    let (outcome, pre_send_aborted) =
                        if !send_authority.authorize_send(&backend).await {
                            (MissionPatchOutcome::Failed, true)
                        } else {
                            match patch_mission_preferences_checked(
                                &backend,
                                json!({ "missionModels": next }),
                                &[confirmed_expected],
                                || send_authority.still_ok(&backend),
                            )
                            .await
                            {
                                Some(outcome) => (outcome, false),
                                None => (MissionPatchOutcome::Failed, true),
                            }
                        };
                    if out
                        .send(Reply::Remove {
                            outcome,
                            pre_send_aborted,
                        })
                        .await
                        .is_ok()
                    {
                        wake();
                    }
                });
                effects.changed = true;
            }
            PendingOp::Reset {
                confirmed_owner,
                confirmed_expected,
            } => {
                if !ctx.config_loaded
                    || backend.client_id != confirmed_owner
                    || current_expected != confirmed_expected
                {
                    self.pending_label = None;
                    self.failed = true;
                    self.needs_reload = true;
                    effects.changed = true;
                    return effects;
                }
                let (out, inbox) = bounded(1);
                let wake = wake.clone();
                self.flight = Some(inbox);
                self.in_flight_expected = Some(ReconcileExpectation::Reset);
                platform::spawn(async move {
                    let (outcome, pre_send_aborted) =
                        if !send_authority.authorize_send(&backend).await {
                            (MissionPatchOutcome::Failed, true)
                        } else {
                            match patch_mission_preferences_checked(
                                &backend,
                                json!({ "missionModels": [] }),
                                &[confirmed_expected],
                                || send_authority.still_ok(&backend),
                            )
                            .await
                            {
                                Some(outcome) => (outcome, false),
                                None => (MissionPatchOutcome::Failed, true),
                            }
                        };
                    if out
                        .send(Reply::Reset {
                            outcome,
                            pre_send_aborted,
                        })
                        .await
                        .is_ok()
                    {
                        wake();
                    }
                });
                effects.changed = true;
            }
        }
        effects
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn view<S: 'static>(
        &self,
        prefs: &Preferences,
        active: bool,
        open_picker: Option<Picker>,
        layers: &mut Vec<El>,
        set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
        select: impl Fn(&mut S, String) + Clone + 'static,
        remove: impl Fn(&mut S) + Clone + 'static,
        reset: impl Fn(&mut S) + Clone + 'static,
        reload: impl Fn(&mut S) + Clone + 'static,
    ) -> El {
        let loaded = prefs.config_loaded();
        let snapshot = prefs.saved(Owner::Config);
        let valid = models_valid(loaded, snapshot);
        let disabled = !active || self.pending() || self.needs_reload || !valid;
        let models = normalize_mission_models(raw_models(snapshot));
        let selection = models.iter().find(|m| m.id == self.selected_id);

        let mut name_counts: BTreeMap<&str, usize> = BTreeMap::new();
        for model in &models {
            *name_counts.entry(model.name.as_str()).or_default() += 1;
        }
        let none_label = t("missions.models.none");
        let mut labels = vec![none_label.to_owned()];
        let mut ids = vec![String::new()];
        for model in &models {
            let duplicate = name_counts.get(model.name.as_str()).copied().unwrap_or(0) > 1;
            let candidate = if duplicate || model.name == none_label {
                format!("{} ({})", model.name, model.id)
            } else {
                model.name.clone()
            };
            push_unique_label(&mut labels, candidate, &model.id);
            ids.push(model.id.clone());
        }
        let current_index = selection
            .and_then(|sel| ids.iter().position(|id| id == &sel.id))
            .unwrap_or(0);
        let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let is_open = open_picker == Some(Picker::Library) && !disabled;
        let labels_for_choose = labels.clone();
        let picker = chrome::picker("mission-model-library", t("missions.models.select"), &refs)
            .current(Some(refs[current_index]))
            .disabled(disabled)
            .open(is_open)
            .on_toggle(move |s: &mut S| set_picker(s, (!is_open).then_some(Picker::Library)))
            .on_close(move |s: &mut S| set_picker(s, None))
            .on_choose(move |s: &mut S, value, _| {
                set_picker(s, None);
                if let Some(pos) = labels_for_choose.iter().position(|label| label == value) {
                    select(s, ids[pos].clone());
                }
            });
        let picker = chrome::build_picker(picker, layers);

        let mut card = col()
            .role("region")
            .label(t("missions.models.title"))
            .full_width()
            .separate(Space::Sm)
            .child(
                text(t("missions.models.title"))
                    .text_role(TextRole::Title)
                    .role("heading"),
            )
            .child(chrome::setting_row(t("missions.models.select"), picker));

        let invalid_loaded = loaded && !valid;
        if invalid_loaded {
            card = card
                .child(text(t("missions.models.invalid")).wrap().role("alert"))
                .child(
                    layout::action_row()
                        .child(
                            layout::button(
                                t("missions.models.reset"),
                                self.pending() || self.needs_reload || !active,
                                reset,
                            )
                            .key("mission-models-reset"),
                        )
                        .child(
                            layout::button(
                                t("missions.preferences.reload"),
                                self.pending() || !active,
                                reload.clone(),
                            )
                            .key("mission-models-reload-invalid")
                            .label(t("missions.models.reload"))
                            .help(t("missions.models.reload")),
                        ),
                );
        }

        card = card.child(
            layout::action_row().child(
                layout::button(
                    t("missions.models.remove"),
                    disabled || selection.is_none(),
                    remove,
                )
                .key("mission-models-remove"),
            ),
        );

        if let Some(label) = self.pending_label {
            card = card.child(text(t(label)).role("status"));
        }
        if self.failed {
            card = card.child(text(t("missions.models.error")).wrap().role("alert"));
        }
        if self.reconciliation_pending {
            card = card.child(
                text(t("missions.defaults.reconciliationPending"))
                    .wrap()
                    .role("alert"),
            );
        }
        if (self.failed || self.needs_reload || self.reconciliation_pending) && !invalid_loaded {
            card = card.child(
                layout::action_row().child(
                    layout::button(
                        t("missions.preferences.reload"),
                        self.pending() || !active,
                        reload,
                    )
                    .key("mission-models-reload")
                    .label(t("missions.models.reload"))
                    .help(t("missions.models.reload")),
                ),
            );
        }

        chrome::card(card)
    }
}
