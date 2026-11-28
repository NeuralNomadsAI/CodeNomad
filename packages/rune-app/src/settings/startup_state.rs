//! Startup-state restore preference and clear action shared between Preferences and workspace persistence.
use super::Preferences;
use crate::{history::Result, platform, platform::storage::ClearOutcome, strings::t};
use codenomad_client::{Receiver, bounded};
use rune::El;
use rune_theme_codenomad::{layout, settings as chrome};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Command {
    SetRestore(bool),
    Clear,
}

enum CommandOutcome {
    Restore { enabled: bool, cleanup_ok: bool },
    Cleared(ClearOutcome),
}

pub(super) struct StartupState {
    is_primary: bool,
    restore_enabled: bool,
    pending: Option<Command>,
    flight: Option<(Command, Receiver<Result<CommandOutcome>>)>,
    notice: Option<(&'static str, bool)>,
    feedback: Option<(&'static str, bool)>,
}

impl Default for StartupState {
    fn default() -> Self {
        Self {
            is_primary: false,
            restore_enabled: true,
            pending: None,
            flight: None,
            notice: None,
            feedback: None,
        }
    }
}

impl StartupState {
    pub(super) fn is_primary(&self) -> bool {
        self.is_primary
    }

    pub(super) fn restore_enabled(&self) -> bool {
        self.restore_enabled
    }

    pub(super) fn busy(&self) -> bool {
        self.pending.is_some() || self.flight.is_some()
    }

    pub(super) fn request_restore(&mut self, enabled: bool) -> bool {
        if !self.is_primary || self.busy() || self.restore_enabled == enabled {
            return false;
        }
        self.feedback = None;
        self.pending = Some(Command::SetRestore(enabled));
        true
    }

    pub(super) fn request_clear(&mut self) -> bool {
        if !self.is_primary || self.busy() {
            return false;
        }
        self.feedback = None;
        self.pending = Some(Command::Clear);
        true
    }

    pub(super) fn take_notice(&mut self) -> Option<(&'static str, bool)> {
        self.notice.take()
    }

    pub(super) fn feedback(&self) -> Option<(&'static str, bool)> {
        self.feedback
    }

    fn set_result_feedback(&mut self, key: &'static str, failed: bool) {
        self.notice = Some((key, failed));
        self.feedback = Some((key, failed));
    }

    fn apply_finished(s: &mut crate::State, command: Command, result: Result<CommandOutcome>) {
        match (command, result) {
            (
                Command::SetRestore(_),
                Ok(CommandOutcome::Restore {
                    enabled,
                    cleanup_ok,
                }),
            ) => {
                if let Some(ui) = s.workspace.as_mut() {
                    ui.apply_restore_enabled(
                        enabled,
                        &s.documents,
                        &mut s.saved_outlines,
                        s.wake.clone(),
                        s.temporary.stashed_for_snapshot(),
                    );
                }
                let mut prefs = s.settings.shared.borrow_mut();
                prefs.startup.restore_enabled = enabled;
                if !cleanup_ok {
                    prefs
                        .startup
                        .set_result_feedback("settings.appearance.startup.clearError", true);
                } else {
                    prefs.startup.feedback = None;
                }
            }
            (Command::SetRestore(_), Err(_)) => {
                if let Some(ui) = s.workspace.as_mut() {
                    ui.cancel_startup_mutation(
                        &mut s.saved_outlines,
                        s.temporary.stashed_for_snapshot(),
                    );
                }
                let mut prefs = s.settings.shared.borrow_mut();
                prefs
                    .startup
                    .set_result_feedback("settings.appearance.startup.updateError", true);
            }
            (Command::Clear, Ok(CommandOutcome::Cleared(outcome))) => {
                if let Some(ui) = s.workspace.as_mut() {
                    ui.apply_startup_cleared(
                        outcome,
                        &s.documents,
                        &mut s.saved_outlines,
                        s.temporary.stashed_for_snapshot(),
                    );
                }
                let mut prefs = s.settings.shared.borrow_mut();
                if outcome.all_ok() {
                    prefs
                        .startup
                        .set_result_feedback("settings.appearance.startup.clearSuccess", false);
                } else {
                    prefs
                        .startup
                        .set_result_feedback("settings.appearance.startup.clearError", true);
                }
            }
            (Command::Clear, Err(_)) | (_, Ok(_)) => {
                if let Some(ui) = s.workspace.as_mut() {
                    ui.cancel_startup_mutation(
                        &mut s.saved_outlines,
                        s.temporary.stashed_for_snapshot(),
                    );
                }
                let mut prefs = s.settings.shared.borrow_mut();
                prefs
                    .startup
                    .set_result_feedback("settings.appearance.startup.clearError", true);
            }
        }
    }

    /// Synchronizes primary ownership & restore state from the main window's workspace,
    /// drives any pending startup-state command, and reports whether UI should redraw.
    pub(super) fn poll_main(s: &mut crate::State) -> bool {
        let mut changed = false;
        let finished = {
            let mut prefs = s.settings.shared.borrow_mut();
            let outcome = prefs
                .startup
                .flight
                .as_ref()
                .and_then(|(cmd, rx)| rx.try_recv().ok().map(|res| (*cmd, res)));
            if outcome.is_some() {
                prefs.startup.flight = None;
                changed = true;
            }
            outcome
        };

        let had_finished = finished.is_some();
        if let Some((command, result)) = finished {
            Self::apply_finished(s, command, result);
        }

        let (primary, restore_enabled, store) =
            s.workspace.as_ref().map_or((false, true, None), |ui| {
                (
                    ui.is_primary_startup(),
                    ui.restore_enabled(),
                    ui.persistence_store(),
                )
            });

        let to_start = {
            let mut prefs = s.settings.shared.borrow_mut();
            if prefs.startup.is_primary != primary {
                prefs.startup.is_primary = primary;
                changed = true;
            }
            if !prefs.startup.busy() && prefs.startup.restore_enabled != restore_enabled {
                prefs.startup.restore_enabled = restore_enabled;
                changed = true;
            }
            if prefs.startup.flight.is_none() {
                prefs.startup.pending.take()
            } else {
                None
            }
        };

        if let Some(command) = to_start {
            changed = true;
            if let Some(store) = store.filter(|_| primary) {
                if let Some(ui) = s.workspace.as_mut() {
                    ui.begin_startup_mutation(
                        &s.documents,
                        &mut s.saved_outlines,
                        s.temporary.stashed_for_snapshot(),
                    );
                }
                let (tx, rx) = bounded(1);
                let wake = s.wake.clone();
                s.settings.shared.borrow_mut().startup.flight = Some((command, rx));
                platform::spawn(async move {
                    let result = match command {
                        Command::SetRestore(enabled) => store
                            .set_restore_enabled(enabled)
                            .await
                            .map(|cleanup_ok| CommandOutcome::Restore {
                                enabled,
                                cleanup_ok,
                            }),
                        Command::Clear => store
                            .clear_startup_state()
                            .await
                            .map(CommandOutcome::Cleared),
                    };
                    let _ = tx.send(result).await;
                    wake();
                });
            } else {
                let mut prefs = s.settings.shared.borrow_mut();
                let key = match command {
                    Command::SetRestore(_) => "settings.appearance.startup.updateError",
                    Command::Clear => "settings.appearance.startup.clearError",
                };
                prefs.startup.set_result_feedback(key, true);
            }
        }

        if changed {
            let mut prefs = s.settings.shared.borrow_mut();
            prefs.revision = prefs.revision.wrapping_add(1);
            if let Some(wake) = &prefs.window_wake {
                wake();
            }
            drop(prefs);
            if had_finished {
                // Re-run workspace::poll immediately so re-enabled checkpoints schedule without
                // waiting for unrelated UI activity.
                (s.wake)();
            }
        }
        changed
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn wait_for_flight(s: &mut crate::State, timeout: std::time::Duration) {
    // Promote any already-accepted pending command into flight before bounded shutdown wait.
    StartupState::poll_main(s);
    let flight = s.settings.shared.borrow_mut().startup.flight.take();
    let Some((command, rx)) = flight else {
        return;
    };
    let waited = platform::block_on(async move { tokio::time::timeout(timeout, rx.recv()).await });
    match waited {
        Ok(Ok(result)) => {
            StartupState::apply_finished(s, command, result);
        }
        Ok(Err(_)) => {
            StartupState::apply_finished(s, command, Err("startup state task closed".into()));
        }
        Err(_) => {
            // Timed out: leave workspace.persistence.mutating = true so shutdown does not
            // treat the unconfirmed mutation as saved or release active workspace records.
        }
    }
}

pub(super) fn view<S: 'static>(
    shared: &Rc<RefCell<Preferences>>,
    help_open: bool,
    toggle_help: impl Fn(&mut S) + 'static,
) -> El {
    let prefs = shared.borrow();
    let title = t("settings.appearance.startup.restore.title");
    let subtitle = t("settings.appearance.startup.restore.subtitle");
    let restore = prefs.startup.is_primary() && prefs.startup.restore_enabled();
    let disabled = !prefs.startup.is_primary() || prefs.startup.busy();
    let feedback = prefs
        .startup
        .feedback()
        .map(|(key, failed)| (t(key), failed));
    let toggle_shared = shared.clone();
    let clear_shared = shared.clone();
    chrome::card(chrome::startup_state_card(
        title,
        chrome::info_tip(title, subtitle, help_open, toggle_help).key("startup-restore-info"),
        chrome::setting_switch(title, restore, disabled, move |_: &mut S| {
            let mut prefs = toggle_shared.borrow_mut();
            let next = !prefs.startup.restore_enabled();
            if prefs.startup.request_restore(next)
                && let Some(wake) = &prefs.main_wake
            {
                wake();
            }
        })
        .key("startup-restore-switch"),
        chrome::secondary_action(
            t("settings.appearance.startup.clear.action"),
            disabled,
            move |_: &mut S| {
                let mut prefs = clear_shared.borrow_mut();
                if prefs.startup.request_clear()
                    && let Some(wake) = &prefs.main_wake
                {
                    wake();
                }
            },
        )
        .key("startup-clear-button"),
        feedback,
    ))
}
