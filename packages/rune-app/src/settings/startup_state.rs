//! Startup-state restore preference and clear action shared between Preferences and workspace persistence.
use super::Preferences;
use crate::{history::Result, platform, strings::t};
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
    Cleared,
}

pub(super) struct StartupState {
    is_primary: bool,
    restore_enabled: bool,
    pending: Option<Command>,
    flight: Option<(Command, Receiver<Result<CommandOutcome>>)>,
    notice: Option<(&'static str, bool)>,
}

impl Default for StartupState {
    fn default() -> Self {
        Self {
            is_primary: false,
            restore_enabled: true,
            pending: None,
            flight: None,
            notice: None,
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
        self.pending = Some(Command::SetRestore(enabled));
        true
    }

    pub(super) fn request_clear(&mut self) -> bool {
        if !self.is_primary || self.busy() {
            return false;
        }
        self.pending = Some(Command::Clear);
        true
    }

    pub(super) fn take_notice(&mut self) -> Option<(&'static str, bool)> {
        self.notice.take()
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

        if let Some((command, result)) = finished {
            match (command, result) {
                (
                    Command::SetRestore(_),
                    Ok(CommandOutcome::Restore {
                        enabled,
                        cleanup_ok,
                    }),
                ) => {
                    if let Some(ui) = s.workspace.as_mut() {
                        ui.apply_restore_enabled(enabled, &s.documents, &mut s.saved_outlines);
                    }
                    let mut prefs = s.settings.shared.borrow_mut();
                    prefs.startup.restore_enabled = enabled;
                    if !cleanup_ok {
                        prefs.startup.notice =
                            Some(("settings.appearance.startup.clearError", true));
                    }
                }
                (Command::SetRestore(_), Err(_)) => {
                    if let Some(ui) = s.workspace.as_mut() {
                        ui.cancel_startup_mutation();
                    }
                    let mut prefs = s.settings.shared.borrow_mut();
                    prefs.startup.notice = Some(("settings.appearance.startup.updateError", true));
                }
                (Command::Clear, Ok(CommandOutcome::Cleared)) => {
                    if let Some(ui) = s.workspace.as_mut() {
                        ui.apply_startup_cleared(&s.documents, &mut s.saved_outlines);
                    }
                    let mut prefs = s.settings.shared.borrow_mut();
                    prefs.startup.notice =
                        Some(("settings.appearance.startup.clearSuccess", false));
                }
                (Command::Clear, Err(_)) => {
                    if let Some(ui) = s.workspace.as_mut() {
                        ui.cancel_startup_mutation();
                    }
                    let mut prefs = s.settings.shared.borrow_mut();
                    prefs.startup.notice = Some(("settings.appearance.startup.clearError", true));
                }
                _ => {}
            }
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
                if matches!(command, Command::Clear | Command::SetRestore(false))
                    && let Some(ui) = s.workspace.as_mut()
                {
                    ui.begin_startup_mutation(&mut s.saved_outlines);
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
                            .map(|()| CommandOutcome::Cleared),
                    };
                    let _ = tx.send(result).await;
                    wake();
                });
            } else {
                let mut prefs = s.settings.shared.borrow_mut();
                prefs.startup.notice = Some((
                    match command {
                        Command::SetRestore(_) => "settings.appearance.startup.updateError",
                        Command::Clear => "settings.appearance.startup.clearError",
                    },
                    true,
                ));
            }
        }

        if changed {
            let mut prefs = s.settings.shared.borrow_mut();
            prefs.revision = prefs.revision.wrapping_add(1);
            if let Some(wake) = &prefs.window_wake {
                wake();
            }
        }
        changed
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
        layout::button(
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
    ))
}
