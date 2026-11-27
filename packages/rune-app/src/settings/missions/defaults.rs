//! Compare-and-swap queue for `missionProfileDefaults` and `missionDeleteSessions`.
use super::{ConfigContext, ConfigEffects};
use crate::platform;
use codenomad_client::{
    Receiver, bounded,
    settings::missions::{
        MissionDefaultScope, MissionExecution, MissionPatchOutcome, MissionPreferenceExpectation,
        MissionProfileDefault, MissionProfiles, MissionTaskMode, change_mission_profile,
        encode_mission_defaults, normalize_mission_defaults, patch_mission_preferences_checked,
        set_mission_profile_role, valid_mission_defaults,
    },
};
use serde_json::{Value, json};
use std::collections::VecDeque;

#[derive(Clone, Debug)]
pub(super) enum DefaultsEdit {
    TaskMode {
        scope: MissionDefaultScope,
        basis: Option<MissionTaskMode>,
        next: Option<MissionTaskMode>,
    },
    Role {
        scope: MissionDefaultScope,
        role: &'static str,
        basis: Option<MissionExecution>,
        next: Option<MissionExecution>,
    },
    ResetProfiles {
        scope: MissionDefaultScope,
        owner: String,
        expected: MissionPreferenceExpectation,
    },
    Repair {
        owner: String,
        expected: MissionPreferenceExpectation,
    },
}

enum Reply {
    Patch {
        outcome: MissionPatchOutcome,
        expected_encoded: Value,
        pre_send_aborted: bool,
    },
    DeleteSessions {
        outcome: MissionPatchOutcome,
        pre_send_aborted: bool,
    },
}

#[derive(Default)]
pub(super) struct State {
    queued: VecDeque<DefaultsEdit>,
    in_flight_edit: Option<DefaultsEdit>,
    write_flight: Option<Receiver<Reply>>,
    defaults_confirming: bool,
    reconciling: Option<Option<Value>>,
    pending_delete: Option<bool>,
    delete_flight: Option<(bool, Receiver<Reply>)>,
    delete_confirming: Option<bool>,
    delete_reconciling: Option<bool>,
    reattach_pending: bool,
    pub(super) failed: bool,
    pub(super) needs_reload: bool,
    pub(super) delete_failed: bool,
    pub(super) reloading: bool,
}

fn role_choice(profiles: Option<&MissionProfiles>, role: &str) -> Option<MissionExecution> {
    profiles.and_then(|p| p.role(role)).cloned()
}

fn with_profiles(
    defaults: &[MissionProfileDefault],
    scope: MissionDefaultScope,
    profiles: Option<MissionProfiles>,
) -> Vec<MissionProfileDefault> {
    let task_mode = defaults
        .iter()
        .find(|item| item.template == scope)
        .and_then(|item| item.task_mode);
    let mut next: Vec<_> = defaults
        .iter()
        .filter(|item| item.template != scope)
        .cloned()
        .collect();
    if profiles.is_some() || task_mode.is_some() {
        next.push(MissionProfileDefault {
            template: scope,
            profiles: profiles.unwrap_or_default(),
            task_mode,
        });
    }
    next
}

pub(super) fn apply_edit(
    defaults: &[MissionProfileDefault],
    edit: &DefaultsEdit,
) -> Option<Vec<MissionProfileDefault>> {
    match edit {
        DefaultsEdit::TaskMode { scope, basis, next } => {
            let entry = defaults.iter().find(|item| item.template == *scope);
            if entry.and_then(|item| item.task_mode) != *basis {
                return None;
            }
            let profiles = entry.map(|item| item.profiles.clone()).unwrap_or_default();
            let mut updated: Vec<_> = defaults
                .iter()
                .filter(|item| item.template != *scope)
                .cloned()
                .collect();
            if profiles.has_any() || next.is_some() {
                updated.push(MissionProfileDefault {
                    template: *scope,
                    profiles,
                    task_mode: *next,
                });
            }
            Some(updated)
        }
        DefaultsEdit::Role {
            scope,
            role,
            basis,
            next,
        } => {
            let existing = defaults
                .iter()
                .find(|item| item.template == *scope)
                .map(|item| &item.profiles);
            if role_choice(existing, role) != *basis {
                return None;
            }
            let profiles = match scope {
                MissionDefaultScope::All => {
                    change_mission_profile(existing, role, next.clone().unwrap_or_default())
                }
                MissionDefaultScope::Template(_) => {
                    set_mission_profile_role(existing, role, next.clone())
                }
            };
            Some(with_profiles(defaults, *scope, profiles))
        }
        DefaultsEdit::ResetProfiles { scope, .. } => Some(with_profiles(defaults, *scope, None)),
        DefaultsEdit::Repair { .. } => Some(Vec::new()),
    }
}

pub(super) fn raw_defaults(snapshot: Option<&Value>) -> Option<&Value> {
    snapshot
        .and_then(|doc| doc.get("settings"))
        .and_then(|settings| settings.get("missionProfileDefaults"))
}

pub(super) fn defaults_valid(config_loaded: bool, snapshot: Option<&Value>) -> bool {
    config_loaded && valid_mission_defaults(raw_defaults(snapshot))
}

impl State {
    pub(super) fn rebind(&mut self, same_address: bool) {
        if !same_address {
            *self = Self::default();
            return;
        }
        self.reattach_pending = true;
        self.reloading = false;
        if self.pending_delete.take().is_some() {
            self.delete_failed = true;
        }
    }

    pub(super) fn write_in_flight(&self) -> bool {
        self.write_flight.is_some() || self.delete_flight.is_some()
    }

    pub(super) fn writing(&self) -> bool {
        self.in_flight_edit.is_some()
            || !self.queued.is_empty()
            || self.write_flight.is_some()
            || self.defaults_confirming
            || self.reconciling.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn draining(&self, can_start_write: bool, config_refreshing: bool) -> bool {
        self.write_flight.is_some()
            || self.delete_flight.is_some()
            || (config_refreshing
                && (self.defaults_confirming
                    || self.delete_confirming.is_some()
                    || self.delete_reconciling.is_some()
                    || self.reconciling.is_some()))
            || (can_start_write
                && (self.pending_delete.is_some()
                    || (!self.needs_reload && !self.queued.is_empty())))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn needs_config_revalidation(&self) -> bool {
        self.write_flight.is_some()
            || self.delete_flight.is_some()
            || self.defaults_confirming
            || self.delete_confirming.is_some()
            || self.delete_reconciling.is_some()
            || self.reconciling.is_some()
            || self.pending_delete.is_some()
            || (!self.needs_reload && !self.queued.is_empty())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        self.writing()
            || self.delete_flight.is_some()
            || self.pending_delete.is_some()
            || self.delete_confirming.is_some()
            || self.delete_reconciling.is_some()
            || self.failed
            || self.delete_failed
            || self.needs_reload
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn pending_ops(&self) -> u32 {
        let count = self.queued.len()
            + usize::from(self.in_flight_edit.is_some())
            + usize::from(self.pending_delete.is_some())
            + usize::from(self.delete_flight.is_some());
        u32::try_from(count).unwrap_or(u32::MAX)
    }

    pub(super) fn expected_after_pending(
        &self,
        snapshot: Option<&Value>,
    ) -> MissionPreferenceExpectation {
        if self.in_flight_edit.is_none() && self.queued.is_empty() {
            MissionPreferenceExpectation::from_ui_config(snapshot, "missionProfileDefaults")
        } else {
            MissionPreferenceExpectation {
                key: "missionProfileDefaults",
                present: true,
                value: Some(encode_mission_defaults(&self.shown(snapshot))),
            }
        }
    }

    pub(super) fn busy_delete(&self) -> bool {
        self.delete_flight.is_some()
            || self.pending_delete.is_some()
            || self.delete_confirming.is_some()
            || self.delete_reconciling.is_some()
    }

    pub(super) fn shown(&self, snapshot: Option<&Value>) -> Vec<MissionProfileDefault> {
        let mut current = normalize_mission_defaults(raw_defaults(snapshot));
        for edit in self.in_flight_edit.iter().chain(self.queued.iter()) {
            if let Some(next) = apply_edit(&current, edit) {
                current = next;
            }
        }
        current
    }

    pub(super) fn delete_sessions_shown(&self, snapshot: Option<&Value>) -> bool {
        if let Some((pending, _)) = &self.delete_flight {
            return *pending;
        }
        if let Some(pending) = self
            .pending_delete
            .or(self.delete_confirming)
            .or(self.delete_reconciling)
        {
            return pending;
        }
        snapshot.is_some_and(|doc| doc["settings"]["missionDeleteSessions"] == true)
    }

    pub(super) fn queue(&mut self, edit: DefaultsEdit) {
        if self.needs_reload {
            return;
        }
        self.failed = false;
        self.queued.push_back(edit);
    }

    pub(super) fn start_reload(&mut self, ctx: &ConfigContext<'_>) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if self.writing() || self.reloading || !ctx.can_retry || ctx.backend.is_none() {
            return effects;
        }
        if ctx.transport_lost {
            effects.revalidate_transport = true;
        }
        self.reloading = true;
        self.failed = false;
        self.delete_failed = false;
        effects.invalidate = true;
        effects.changed = true;
        effects
    }

    pub(super) fn queue_delete_sessions(&mut self, ctx: &ConfigContext<'_>, next: bool) -> bool {
        if !ctx.config_loaded || self.busy_delete() || ctx.backend.is_none() {
            return false;
        }
        self.delete_failed = false;
        self.pending_delete = Some(next);
        true
    }

    pub(super) fn poll_replies(&mut self, ctx: &ConfigContext<'_>) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if self.reattach_pending
            && ctx.config_loaded
            && !ctx.config_refreshing
            && self.write_flight.is_none()
        {
            self.reattach_pending = false;
        }
        if let Some(reply) = self
            .delete_flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            let pending_value = self.delete_flight.take().map(|(value, _)| value);
            if let Reply::DeleteSessions {
                outcome,
                pre_send_aborted,
            } = reply
            {
                match outcome {
                    MissionPatchOutcome::Applied(_) => {
                        self.delete_failed = false;
                        self.delete_confirming = pending_value;
                        effects.invalidate = true;
                    }
                    MissionPatchOutcome::Conflict
                    | MissionPatchOutcome::Unsupported
                    | MissionPatchOutcome::Failed => {
                        self.delete_failed = true;
                        if !pre_send_aborted && ctx.backend.is_some() && ctx.can_retry {
                            self.delete_reconciling = pending_value;
                            effects.invalidate = true;
                        }
                    }
                }
            }
            effects.changed = true;
            effects.settled = true;
        }
        if let Some(reply) = self
            .write_flight
            .as_ref()
            .and_then(|inbox| inbox.try_recv().ok())
        {
            self.write_flight = None;
            if let Reply::Patch {
                outcome,
                expected_encoded,
                pre_send_aborted,
            } = reply
            {
                match outcome {
                    MissionPatchOutcome::Applied(_) => {
                        self.failed = false;
                        self.needs_reload = false;
                        self.defaults_confirming = true;
                        effects.invalidate = true;
                    }
                    MissionPatchOutcome::Conflict
                    | MissionPatchOutcome::Unsupported
                    | MissionPatchOutcome::Failed => {
                        self.failed = true;
                        if !pre_send_aborted && ctx.backend.is_some() && ctx.can_retry {
                            self.reconciling = Some(Some(expected_encoded));
                            effects.invalidate = true;
                        } else {
                            self.in_flight_edit = None;
                            self.needs_reload = true;
                            self.queued.clear();
                        }
                    }
                }
            }
            effects.changed = true;
            effects.settled = true;
        }
        effects
    }

    pub(super) fn settle_config(&mut self, ctx: &ConfigContext<'_>) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if ctx.config_refreshing {
            return effects;
        }
        if self.reloading {
            self.reloading = false;
            if ctx.config_loaded {
                self.needs_reload = false;
                self.failed = false;
            } else {
                self.failed = true;
                self.needs_reload = true;
            }
            effects.changed = true;
            effects.settled = true;
        }
        if self.delete_confirming.is_some() {
            self.delete_confirming = None;
            if !ctx.config_loaded {
                self.delete_failed = true;
            }
            effects.changed = true;
            effects.settled = true;
        }
        if let Some(expected) = self.delete_reconciling.take() {
            if ctx.config_loaded {
                let actual = ctx
                    .config_snapshot
                    .is_some_and(|doc| doc["settings"]["missionDeleteSessions"] == true);
                self.delete_failed = actual != expected;
            } else {
                self.delete_failed = true;
            }
            effects.changed = true;
            effects.settled = true;
        }
        if self.defaults_confirming {
            self.defaults_confirming = false;
            self.in_flight_edit = None;
            if !ctx.config_loaded {
                self.failed = true;
                self.needs_reload = true;
                self.queued.clear();
            }
            effects.changed = true;
            effects.settled = true;
        }
        if let Some(expected_encoded) = self.reconciling.take() {
            self.in_flight_edit = None;
            if ctx.config_loaded {
                let stored_matches = expected_encoded.as_ref().is_some_and(|expected| {
                    let stored = raw_defaults(ctx.config_snapshot);
                    valid_mission_defaults(stored) && stored.is_some_and(|value| value == expected)
                });
                self.failed = !stored_matches;
                self.needs_reload = false;
            } else {
                // Do not dequeue further edits against an unreloaded snapshot.
                self.failed = true;
                self.needs_reload = true;
                self.queued.clear();
            }
            effects.changed = true;
            effects.settled = true;
        }
        if !ctx.config_loaded && !self.write_in_flight() {
            if self.pending_delete.take().is_some() {
                self.delete_failed = true;
                effects.changed = true;
                effects.settled = true;
            }
            if !self.queued.is_empty() && self.in_flight_edit.is_none() {
                self.queued.clear();
                self.failed = true;
                self.needs_reload = true;
                effects.changed = true;
                effects.settled = true;
            }
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
        if self.write_in_flight()
            || self.reloading
            || self.defaults_confirming
            || self.delete_confirming.is_some()
            || self.delete_reconciling.is_some()
            || self.reconciling.is_some()
            || self.reattach_pending
        {
            return effects;
        }
        if let Some(next) = self.pending_delete.take() {
            self.start_delete_sessions(
                ctx,
                next,
                #[cfg(test)]
                pre_patch_gate.take(),
                wake,
            );
            effects.changed = true;
            return effects;
        }
        if self.in_flight_edit.is_none()
            && !self.needs_reload
            && let Some(edit) = self.queued.pop_front()
        {
            effects.changed = true;
            effects.invalidate |= self.start_edit(
                ctx,
                edit,
                #[cfg(test)]
                pre_patch_gate.take(),
                wake,
            );
        }
        effects
    }

    fn start_delete_sessions(
        &mut self,
        ctx: &ConfigContext<'_>,
        next: bool,
        #[cfg(test)] pre_patch_gate: Option<Receiver<()>>,
        wake: &rune::Waker,
    ) {
        let Some(backend) = ctx.backend.cloned() else {
            self.delete_failed = true;
            return;
        };
        let expected = MissionPreferenceExpectation::from_ui_config(
            ctx.config_snapshot,
            "missionDeleteSessions",
        );
        let send_authority = ctx.send_authority(
            &backend,
            #[cfg(test)]
            pre_patch_gate,
        );
        self.delete_failed = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.delete_flight = Some((next, inbox));
        platform::spawn(async move {
            let (outcome, pre_send_aborted) = if !send_authority.authorize_send(&backend).await {
                (MissionPatchOutcome::Failed, true)
            } else {
                match patch_mission_preferences_checked(
                    &backend,
                    json!({ "missionDeleteSessions": next }),
                    &[expected],
                    || send_authority.still_ok(&backend),
                )
                .await
                {
                    Some(outcome) => (outcome, false),
                    None => (MissionPatchOutcome::Failed, true),
                }
            };
            if out
                .send(Reply::DeleteSessions {
                    outcome,
                    pre_send_aborted,
                })
                .await
                .is_ok()
            {
                wake();
            }
        });
    }

    fn start_edit(
        &mut self,
        ctx: &ConfigContext<'_>,
        edit: DefaultsEdit,
        #[cfg(test)] pre_patch_gate: Option<Receiver<()>>,
        wake: &rune::Waker,
    ) -> bool {
        let Some(backend) = ctx.backend.cloned() else {
            self.failed = true;
            self.needs_reload = true;
            self.queued.clear();
            return false;
        };
        let saved = ctx.config_snapshot;
        let current_expected =
            MissionPreferenceExpectation::from_ui_config(saved, "missionProfileDefaults");
        match &edit {
            DefaultsEdit::Repair { owner, expected }
            | DefaultsEdit::ResetProfiles {
                owner, expected, ..
            } => {
                if backend.client_id != *owner || current_expected != *expected {
                    self.failed = true;
                    self.needs_reload = true;
                    self.queued.clear();
                    return false;
                }
            }
            DefaultsEdit::TaskMode { .. } | DefaultsEdit::Role { .. } => {}
        }
        let repair = matches!(edit, DefaultsEdit::Repair { .. });
        if !ctx.config_loaded || (!repair && !valid_mission_defaults(raw_defaults(saved))) {
            self.failed = true;
            self.in_flight_edit = Some(edit);
            self.reconciling = Some(None);
            return true;
        }
        let current = normalize_mission_defaults(raw_defaults(saved));
        let Some(next) = apply_edit(&current, &edit) else {
            self.failed = true;
            self.in_flight_edit = Some(edit);
            self.reconciling = Some(None);
            return true;
        };
        let encoded = encode_mission_defaults(&next);
        if !valid_mission_defaults(Some(&encoded)) {
            self.failed = true;
            self.needs_reload = true;
            self.queued.clear();
            return false;
        }
        let send_authority = ctx.send_authority(
            &backend,
            #[cfg(test)]
            pre_patch_gate,
        );
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.in_flight_edit = Some(edit);
        self.write_flight = Some(inbox);
        platform::spawn(async move {
            let (outcome, pre_send_aborted) = if !send_authority.authorize_send(&backend).await {
                (MissionPatchOutcome::Failed, true)
            } else {
                match patch_mission_preferences_checked(
                    &backend,
                    json!({ "missionProfileDefaults": encoded }),
                    &[current_expected],
                    || send_authority.still_ok(&backend),
                )
                .await
                {
                    Some(outcome) => (outcome, false),
                    None => (MissionPatchOutcome::Failed, true),
                }
            };
            if out
                .send(Reply::Patch {
                    outcome,
                    expected_encoded: encoded,
                    pre_send_aborted,
                })
                .await
                .is_ok()
            {
                wake();
            }
        });
        false
    }
}
