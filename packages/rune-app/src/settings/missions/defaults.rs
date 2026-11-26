//! Compare-and-swap queue for `missionProfileDefaults` and `missionDeleteSessions`.
use super::{ConfigContext, ConfigEffects};
use crate::{backend::Backend, platform, settings::preferences::Owner};
use codenomad_client::{
    Receiver, bounded,
    settings::missions::{
        MissionDefaultScope, MissionExecution, MissionPatchOutcome, MissionPreferenceExpectation,
        MissionProfileDefault, MissionProfiles, MissionTaskMode, change_mission_profile,
        encode_mission_defaults, normalize_mission_defaults, patch_mission_preferences,
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
        guard: Option<(u64, u64)>,
    },
    ReloadAfterFailure {
        snapshot: Option<Value>,
        expected_encoded: Option<Value>,
        guard: Option<(u64, u64)>,
    },
    ManualReload {
        snapshot: Option<Value>,
        guard: Option<(u64, u64)>,
    },
    DeleteSessions {
        outcome: MissionPatchOutcome,
        guard: Option<(u64, u64)>,
    },
}

#[derive(Default)]
pub(super) struct State {
    queued: VecDeque<DefaultsEdit>,
    in_flight_edit: Option<DefaultsEdit>,
    write_flight: Option<Receiver<Reply>>,
    reload_flight: Option<Receiver<Reply>>,
    delete_flight: Option<(bool, Receiver<Reply>)>,
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
    }

    pub(super) fn writing(&self) -> bool {
        self.in_flight_edit.is_some() || !self.queued.is_empty() || self.write_flight.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn draining(&self) -> bool {
        self.write_flight.is_some()
            || self.delete_flight.is_some()
            || (!self.needs_reload && !self.reattach_pending && !self.queued.is_empty())
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        self.writing()
            || self.delete_flight.is_some()
            || self.failed
            || self.delete_failed
            || self.needs_reload
    }

    pub(super) fn busy_delete(&self) -> bool {
        self.delete_flight.is_some()
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
        snapshot.is_some_and(|doc| doc["settings"]["missionDeleteSessions"] == true)
    }

    pub(super) fn queue(&mut self, edit: DefaultsEdit) {
        if self.needs_reload {
            return;
        }
        self.failed = false;
        self.queued.push_back(edit);
    }

    pub(super) fn start_reload(
        &mut self,
        ctx: &ConfigContext<'_>,
        wake: &rune::Waker,
    ) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if self.writing() || self.reloading || !ctx.can_retry {
            return effects;
        }
        let Some(backend) = ctx.backend.cloned() else {
            return effects;
        };
        if ctx.transport_lost {
            effects.revalidate_transport = true;
        }
        self.reloading = true;
        self.failed = false;
        self.delete_failed = false;
        let guard = ctx.config_guard;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.reload_flight = Some(inbox);
        platform::spawn(async move {
            let snapshot = Owner::Config.read(&backend).await.ok();
            if out
                .send(Reply::ManualReload { snapshot, guard })
                .await
                .is_ok()
            {
                wake();
            }
        });
        effects.changed = true;
        effects
    }

    pub(super) fn toggle_delete_sessions(
        &mut self,
        ctx: &ConfigContext<'_>,
        next: bool,
        wake: &rune::Waker,
    ) -> bool {
        if !ctx.config_loaded || self.delete_flight.is_some() {
            return false;
        }
        let Some(backend) = ctx.backend.cloned() else {
            return false;
        };
        let expected = MissionPreferenceExpectation::from_ui_config(
            ctx.config_snapshot,
            "missionDeleteSessions",
        );
        let guard = ctx.config_guard;
        self.delete_failed = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.delete_flight = Some((next, inbox));
        platform::spawn(async move {
            let outcome = patch_mission_preferences(
                &backend,
                json!({ "missionDeleteSessions": next }),
                &[expected],
            )
            .await;
            if out
                .send(Reply::DeleteSessions { outcome, guard })
                .await
                .is_ok()
            {
                wake();
            }
        });
        true
    }

    pub(super) fn poll(&mut self, ctx: &ConfigContext<'_>, wake: &rune::Waker) -> ConfigEffects {
        let mut effects = ConfigEffects::default();
        if self.reattach_pending && ctx.config_loaded && self.write_flight.is_none() {
            self.reattach_pending = false;
        }
        if let Some(reply) = self
            .reload_flight
            .as_ref()
            .and_then(|inbox| inbox.try_recv().ok())
        {
            self.reload_flight = None;
            self.reloading = false;
            if let Reply::ManualReload { snapshot, guard } = reply {
                if let Some(snapshot) = snapshot {
                    self.needs_reload = false;
                    self.failed = false;
                    effects.applied = Some((snapshot, guard));
                } else {
                    self.failed = true;
                    self.needs_reload = true;
                }
            }
            effects.changed = true;
            effects.settled = true;
        }
        if let Some(reply) = self
            .delete_flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.delete_flight = None;
            if let Reply::DeleteSessions { outcome, guard } = reply {
                match outcome {
                    MissionPatchOutcome::Applied(snapshot) => {
                        self.delete_failed = false;
                        effects.applied = Some((snapshot, guard));
                    }
                    MissionPatchOutcome::Conflict
                    | MissionPatchOutcome::Unsupported
                    | MissionPatchOutcome::Failed => {
                        self.delete_failed = true;
                        effects.invalidate = true;
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
            match reply {
                Reply::Patch {
                    outcome,
                    expected_encoded,
                    guard,
                } => match outcome {
                    MissionPatchOutcome::Applied(snapshot) => {
                        self.in_flight_edit = None;
                        self.failed = false;
                        self.needs_reload = false;
                        effects.applied = Some((snapshot, guard));
                    }
                    MissionPatchOutcome::Conflict
                    | MissionPatchOutcome::Unsupported
                    | MissionPatchOutcome::Failed => {
                        self.failed = true;
                        if let Some(backend) = ctx.backend.cloned() {
                            self.spawn_failure_reload(
                                backend,
                                Some(expected_encoded),
                                ctx.config_guard,
                                wake,
                            );
                        } else {
                            self.in_flight_edit = None;
                            self.needs_reload = true;
                            self.queued.clear();
                        }
                    }
                },
                Reply::ReloadAfterFailure {
                    snapshot,
                    expected_encoded,
                    guard,
                } => {
                    self.in_flight_edit = None;
                    if let Some(snapshot) = snapshot {
                        let stored_matches = expected_encoded.as_ref().is_some_and(|expected| {
                            let stored = raw_defaults(Some(&snapshot));
                            valid_mission_defaults(stored)
                                && stored.is_some_and(|value| value == expected)
                        });
                        self.failed = !stored_matches;
                        self.needs_reload = false;
                        effects.applied = Some((snapshot, guard));
                    } else {
                        // Do not dequeue further edits against an unreloaded snapshot.
                        self.failed = true;
                        self.needs_reload = true;
                        self.queued.clear();
                    }
                }
                Reply::ManualReload { .. } | Reply::DeleteSessions { .. } => {}
            }
            effects.changed = true;
            effects.settled = true;
        }
        if self.write_flight.is_none()
            && self.in_flight_edit.is_none()
            && !self.needs_reload
            && !self.reattach_pending
            && let Some(edit) = self.queued.pop_front()
        {
            effects.changed = true;
            self.start_edit(ctx, edit, wake);
        }
        effects
    }

    fn start_edit(&mut self, ctx: &ConfigContext<'_>, edit: DefaultsEdit, wake: &rune::Waker) {
        let Some(backend) = ctx.backend.cloned() else {
            self.failed = true;
            self.needs_reload = true;
            self.queued.clear();
            return;
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
                    return;
                }
            }
            DefaultsEdit::TaskMode { .. } | DefaultsEdit::Role { .. } => {}
        }
        let repair = matches!(edit, DefaultsEdit::Repair { .. });
        if !ctx.config_loaded || (!repair && !valid_mission_defaults(raw_defaults(saved))) {
            self.failed = true;
            self.in_flight_edit = Some(edit);
            self.spawn_failure_reload(backend, None, ctx.config_guard, wake);
            return;
        }
        let current = normalize_mission_defaults(raw_defaults(saved));
        let Some(next) = apply_edit(&current, &edit) else {
            self.failed = true;
            self.in_flight_edit = Some(edit);
            self.spawn_failure_reload(backend, None, ctx.config_guard, wake);
            return;
        };
        let encoded = encode_mission_defaults(&next);
        if !valid_mission_defaults(Some(&encoded)) {
            self.failed = true;
            self.needs_reload = true;
            self.queued.clear();
            return;
        }
        let guard = ctx.config_guard;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.in_flight_edit = Some(edit);
        self.write_flight = Some(inbox);
        platform::spawn(async move {
            let outcome = patch_mission_preferences(
                &backend,
                json!({ "missionProfileDefaults": encoded }),
                &[current_expected],
            )
            .await;
            if out
                .send(Reply::Patch {
                    outcome,
                    expected_encoded: encoded,
                    guard,
                })
                .await
                .is_ok()
            {
                wake();
            }
        });
    }

    fn spawn_failure_reload(
        &mut self,
        backend: Backend,
        expected_encoded: Option<Value>,
        guard: Option<(u64, u64)>,
        wake: &rune::Waker,
    ) {
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.write_flight = Some(inbox);
        platform::spawn(async move {
            let snapshot = Owner::Config.read(&backend).await.ok();
            if out
                .send(Reply::ReloadAfterFailure {
                    snapshot,
                    expected_encoded,
                    guard,
                })
                .await
                .is_ok()
            {
                wake();
            }
        });
    }
}
