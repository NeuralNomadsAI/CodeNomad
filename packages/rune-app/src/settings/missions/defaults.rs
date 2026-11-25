//! Compare-and-swap queue for `missionProfileDefaults` and `missionDeleteSessions`.
use crate::{
    backend::Backend,
    platform,
    settings::preferences::{Owner, Preferences},
};
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
    },
    Repair,
}

enum Reply {
    Patch {
        outcome: MissionPatchOutcome,
        expected_encoded: Value,
    },
    ReloadAfterFailure {
        snapshot: Option<Value>,
        expected_encoded: Option<Value>,
    },
    ManualReload(Option<Value>),
    DeleteSessions(MissionPatchOutcome),
}

#[derive(Default)]
pub(super) struct State {
    owner: Option<String>,
    queued: VecDeque<DefaultsEdit>,
    in_flight_edit: Option<DefaultsEdit>,
    write_flight: Option<Receiver<Reply>>,
    reload_flight: Option<Receiver<Reply>>,
    delete_flight: Option<(bool, Receiver<Reply>)>,
    pub(super) failed: bool,
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
        DefaultsEdit::ResetProfiles { scope } => Some(with_profiles(defaults, *scope, None)),
        DefaultsEdit::Repair => Some(Vec::new()),
    }
}

pub(super) fn raw_defaults(snapshot: Option<&Value>) -> Option<&Value> {
    snapshot
        .and_then(|doc| doc.get("settings"))
        .and_then(|settings| settings.get("missionProfileDefaults"))
}

pub(super) fn defaults_valid(prefs: &Preferences) -> bool {
    prefs.config_loaded() && valid_mission_defaults(raw_defaults(prefs.saved(Owner::Config)))
}

impl State {
    pub(super) fn writing(&self) -> bool {
        self.in_flight_edit.is_some() || !self.queued.is_empty() || self.write_flight.is_some()
    }

    pub(super) fn busy_delete(&self) -> bool {
        self.delete_flight.is_some()
    }

    pub(super) fn shown(&self, prefs: &Preferences) -> Vec<MissionProfileDefault> {
        let mut current = normalize_mission_defaults(raw_defaults(prefs.saved(Owner::Config)));
        for edit in self.in_flight_edit.iter().chain(self.queued.iter()) {
            if let Some(next) = apply_edit(&current, edit) {
                current = next;
            }
        }
        current
    }

    pub(super) fn delete_sessions_shown(&self, prefs: &Preferences) -> bool {
        if let Some((pending, _)) = &self.delete_flight {
            return *pending;
        }
        prefs
            .saved(Owner::Config)
            .is_some_and(|doc| doc["settings"]["missionDeleteSessions"] == true)
    }

    pub(super) fn queue(&mut self, edit: DefaultsEdit) {
        self.failed = false;
        self.queued.push_back(edit);
    }

    pub(super) fn start_reload(&mut self, prefs: &mut Preferences, wake: &rune::Waker) -> bool {
        if self.writing() || self.reloading || !prefs.can_retry() {
            return false;
        }
        let Some(backend) = prefs.backend.clone() else {
            return false;
        };
        if prefs.is_transport_lost() {
            prefs.revalidate_transport();
        }
        self.owner = Some(backend.client_id.clone());
        self.reloading = true;
        self.failed = false;
        self.delete_failed = false;
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.reload_flight = Some(inbox);
        platform::spawn(async move {
            let snapshot = Owner::Config.read(&backend).await.ok();
            if out.send(Reply::ManualReload(snapshot)).await.is_ok() {
                wake();
            }
        });
        true
    }

    pub(super) fn toggle_delete_sessions(
        &mut self,
        prefs: &Preferences,
        next: bool,
        wake: &rune::Waker,
    ) -> bool {
        if !prefs.config_loaded() || self.delete_flight.is_some() {
            return false;
        }
        let Some(backend) = prefs.backend.clone() else {
            return false;
        };
        let expected = MissionPreferenceExpectation::from_ui_config(
            prefs.saved(Owner::Config),
            "missionDeleteSessions",
        );
        self.owner = Some(backend.client_id.clone());
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
            if out.send(Reply::DeleteSessions(outcome)).await.is_ok() {
                wake();
            }
        });
        true
    }

    pub(super) fn poll(&mut self, prefs: &mut Preferences, wake: &rune::Waker) -> bool {
        let mut changed = false;
        let current_owner = prefs.backend.as_ref().map(|b| b.client_id.as_str());
        if self.owner.as_deref().is_some() && self.owner.as_deref() != current_owner {
            *self = Self::default();
            return true;
        }
        if let Some(reply) = self
            .reload_flight
            .as_ref()
            .and_then(|inbox| inbox.try_recv().ok())
        {
            self.reload_flight = None;
            self.reloading = false;
            if let Reply::ManualReload(Some(snapshot)) = reply {
                prefs.apply_mission_config(snapshot);
            }
            changed = true;
        }
        if let Some(reply) = self
            .delete_flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.delete_flight = None;
            if let Reply::DeleteSessions(outcome) = reply {
                match outcome {
                    MissionPatchOutcome::Applied(snapshot) => {
                        self.delete_failed = false;
                        prefs.apply_mission_config(snapshot);
                    }
                    MissionPatchOutcome::Conflict
                    | MissionPatchOutcome::Unsupported
                    | MissionPatchOutcome::Failed => {
                        self.delete_failed = true;
                        prefs.invalidate_config_for_missions();
                    }
                }
            }
            changed = true;
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
                } => match outcome {
                    MissionPatchOutcome::Applied(snapshot) => {
                        self.in_flight_edit = None;
                        self.failed = false;
                        prefs.apply_mission_config(snapshot);
                    }
                    MissionPatchOutcome::Conflict
                    | MissionPatchOutcome::Unsupported
                    | MissionPatchOutcome::Failed => {
                        self.failed = true;
                        if let Some(backend) = prefs.backend.clone() {
                            self.spawn_failure_reload(backend, Some(expected_encoded), wake);
                        } else {
                            self.in_flight_edit = None;
                        }
                    }
                },
                Reply::ReloadAfterFailure {
                    snapshot,
                    expected_encoded,
                } => {
                    self.in_flight_edit = None;
                    if let Some(snapshot) = snapshot {
                        let stored_matches = expected_encoded.as_ref().is_some_and(|expected| {
                            let stored = raw_defaults(Some(&snapshot));
                            valid_mission_defaults(stored)
                                && stored.is_some_and(|value| value == expected)
                        });
                        self.failed = !stored_matches;
                        prefs.apply_mission_config(snapshot);
                    } else {
                        self.failed = true;
                    }
                }
                Reply::ManualReload(_) | Reply::DeleteSessions(_) => {}
            }
            changed = true;
        }
        if self.write_flight.is_none()
            && self.in_flight_edit.is_none()
            && let Some(edit) = self.queued.pop_front()
        {
            changed = true;
            self.start_edit(prefs, edit, wake);
        }
        changed
    }

    fn start_edit(&mut self, prefs: &Preferences, edit: DefaultsEdit, wake: &rune::Waker) {
        let Some(backend) = prefs.backend.clone() else {
            self.failed = true;
            return;
        };
        self.owner = Some(backend.client_id.clone());
        let saved = prefs.saved(Owner::Config);
        let repair = matches!(edit, DefaultsEdit::Repair);
        if !prefs.config_loaded() || (!repair && !valid_mission_defaults(raw_defaults(saved))) {
            self.failed = true;
            self.in_flight_edit = Some(edit);
            self.spawn_failure_reload(backend, None, wake);
            return;
        }
        let current = normalize_mission_defaults(raw_defaults(saved));
        let Some(next) = apply_edit(&current, &edit) else {
            self.failed = true;
            self.in_flight_edit = Some(edit);
            self.spawn_failure_reload(backend, None, wake);
            return;
        };
        let encoded = encode_mission_defaults(&next);
        let expected =
            MissionPreferenceExpectation::from_ui_config(saved, "missionProfileDefaults");
        let (out, inbox) = bounded(1);
        let wake = wake.clone();
        self.in_flight_edit = Some(edit);
        self.write_flight = Some(inbox);
        platform::spawn(async move {
            let outcome = patch_mission_preferences(
                &backend,
                json!({ "missionProfileDefaults": encoded }),
                &[expected],
            )
            .await;
            if out
                .send(Reply::Patch {
                    outcome,
                    expected_encoded: encoded,
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
                })
                .await
                .is_ok()
            {
                wake();
            }
        });
    }
}
