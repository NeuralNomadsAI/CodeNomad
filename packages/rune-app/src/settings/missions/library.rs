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
        normalize_mission_models, patch_mission_preferences, remove_mission_model_value,
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
use std::{collections::BTreeMap, sync::atomic::Ordering};

enum Reply {
    Remove {
        outcome: MissionPatchOutcome,
        guard: Option<(u64, u64)>,
    },
    Reset {
        outcome: MissionPatchOutcome,
        guard: Option<(u64, u64)>,
    },
    Reload {
        snapshot: Option<Value>,
        guard: Option<(u64, u64)>,
    },
}

#[derive(Default)]
pub(super) struct State {
    selected_id: String,
    pending_label: Option<&'static str>,
    failed: bool,
    needs_reload: bool,
    reconciliation_pending: bool,
    flight: Option<Receiver<Reply>>,
    flight_is_reload: bool,
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
        // Cancel stale reload GETs across reconnect, while keeping in-flight mutations as barriers.
        if self.flight_is_reload {
            self.flight = None;
            self.flight_is_reload = false;
            self.pending_label = None;
        }
    }

    pub(super) fn pending(&self) -> bool {
        self.flight.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        self.flight.is_some() || self.failed || self.needs_reload || self.reconciliation_pending
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

    pub(super) fn start_remove(
        &mut self,
        ctx: &ConfigContext<'_>,
        id: &str,
        confirmed_owner: &str,
        confirmed_expected: MissionPreferenceExpectation,
        wake: &rune::Waker,
    ) -> bool {
        if self.pending()
            || self.needs_reload
            || !models_valid(ctx.config_loaded, ctx.config_snapshot)
        {
            return false;
        }
        let Some(backend) = ctx.backend.cloned() else {
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
        let next = remove_mission_model_value(&models, id);
        let guard = ctx.config_guard;
        let (epoch_guard, expected_epoch) = ctx.write_authority.clone();
        self.pending_label = Some("missions.models.removing");
        self.failed = false;
        self.reconciliation_pending = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.flight = Some(inbox);
        self.flight_is_reload = false;
        platform::spawn(async move {
            let outcome = if epoch_guard.load(Ordering::Acquire) != expected_epoch {
                MissionPatchOutcome::Failed
            } else {
                patch_mission_preferences(
                    &backend,
                    json!({ "missionModels": next }),
                    &[confirmed_expected],
                )
                .await
            };
            if out.send(Reply::Remove { outcome, guard }).await.is_ok() {
                wake();
            }
        });
        true
    }

    pub(super) fn start_reset(
        &mut self,
        ctx: &ConfigContext<'_>,
        confirmed_owner: &str,
        confirmed_expected: MissionPreferenceExpectation,
        wake: &rune::Waker,
    ) -> bool {
        if self.pending() || self.needs_reload || !ctx.config_loaded {
            return false;
        }
        let Some(backend) = ctx.backend.cloned() else {
            return false;
        };
        let current_expected =
            MissionPreferenceExpectation::from_ui_config(ctx.config_snapshot, "missionModels");
        if backend.client_id != confirmed_owner || current_expected != confirmed_expected {
            self.failed = true;
            self.needs_reload = true;
            return false;
        }
        let guard = ctx.config_guard;
        let (epoch_guard, expected_epoch) = ctx.write_authority.clone();
        self.pending_label = Some("missions.models.resetting");
        self.failed = false;
        self.reconciliation_pending = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.flight = Some(inbox);
        self.flight_is_reload = false;
        platform::spawn(async move {
            let outcome = if epoch_guard.load(Ordering::Acquire) != expected_epoch {
                MissionPatchOutcome::Failed
            } else {
                patch_mission_preferences(
                    &backend,
                    json!({ "missionModels": [] }),
                    &[confirmed_expected],
                )
                .await
            };
            if out.send(Reply::Reset { outcome, guard }).await.is_ok() {
                wake();
            }
        });
        true
    }

    pub(super) fn start_reload(
        &mut self,
        ctx: &ConfigContext<'_>,
        wake: &rune::Waker,
    ) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if self.pending() || !ctx.can_retry {
            return effects;
        }
        let Some(backend) = ctx.backend.cloned() else {
            return effects;
        };
        if ctx.transport_lost {
            effects.revalidate_transport = true;
        }
        let guard = ctx.config_guard;
        self.pending_label = Some("missions.models.reloading");
        self.failed = false;
        self.reconciliation_pending = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.flight = Some(inbox);
        self.flight_is_reload = true;
        platform::spawn(async move {
            let snapshot = Owner::Config.read(&backend).await.ok();
            if out.send(Reply::Reload { snapshot, guard }).await.is_ok() {
                wake();
            }
        });
        effects.changed = true;
        effects
    }

    pub(super) fn poll(&mut self) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        let Some(reply) = self.flight.as_ref().and_then(|inbox| inbox.try_recv().ok()) else {
            return effects;
        };
        self.flight = None;
        self.flight_is_reload = false;
        self.pending_label = None;
        match reply {
            Reply::Remove { outcome, guard } | Reply::Reset { outcome, guard } => match outcome {
                MissionPatchOutcome::Applied(snapshot) => {
                    self.selected_id.clear();
                    self.failed = false;
                    self.needs_reload = false;
                    self.reconciliation_pending = false;
                    effects.applied = Some((snapshot, guard));
                }
                MissionPatchOutcome::Conflict
                | MissionPatchOutcome::Unsupported
                | MissionPatchOutcome::Failed => {
                    self.failed = true;
                    self.needs_reload = true;
                }
            },
            Reply::Reload { snapshot, guard } => match snapshot {
                Some(snapshot) => {
                    self.failed = false;
                    self.needs_reload = false;
                    self.reconciliation_pending = false;
                    effects.applied = Some((snapshot, guard));
                }
                None => {
                    self.failed = true;
                    self.needs_reload = true;
                }
            },
        }
        effects.changed = true;
        effects.settled = true;
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
