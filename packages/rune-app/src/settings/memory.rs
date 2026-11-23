use super::Preferences;
use crate::{
    platform,
    strings::{locale, t},
};
use codenomad_client::{Receiver, backend::Backend, bounded, settings::memory};
use rune::{El, col, text};
use rune_theme_codenomad::{
    layout::{self, Layout},
    settings as chrome,
};

#[derive(Default)]
pub(super) struct Setting {
    pub visible: bool,
    online: bool,
    current: Option<bool>,
    refresh: bool,
    failed: bool,
    pending: Option<bool>,
    flight: Option<Receiver<(Option<bool>, bool)>>,
}

impl Setting {
    pub fn show(&mut self, visible: bool) {
        if visible && !self.visible {
            self.invalidate();
        }
        self.visible = visible;
    }

    pub fn bind(&mut self, same: bool) {
        if same {
            self.invalidate();
        } else {
            *self = Self {
                visible: self.visible,
                refresh: self.visible,
                ..Self::default()
            };
        }
    }

    pub fn invalidate(&mut self) {
        self.refresh = true;
    }

    pub fn transport(&mut self, online: bool) {
        let previous = std::mem::replace(&mut self.online, online);
        if online && !previous {
            self.invalidate();
        }
    }

    fn set(&mut self, next: bool) {
        if self.visible && !self.busy() && self.current.is_some_and(|current| current != next) {
            self.pending = Some(next);
            self.failed = false;
        }
    }

    fn busy(&self) -> bool {
        self.pending.is_some() || self.flight.is_some()
    }

    pub fn poll(
        &mut self,
        backend: &Backend,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> bool {
        let mut changed = false;
        if let Some(flight) = &self.flight {
            let (current, failed) = match flight.try_recv() {
                Ok(reply) => reply,
                Err(_) if flight.is_closed() => (None, true),
                Err(_) => return false,
            };
            self.flight = None;
            self.failed = failed;
            self.current = current;
            changed = true;
        }
        if self.pending.is_none() && (!self.visible || !self.refresh) {
            return changed;
        }
        let desired = self.pending.take();
        self.refresh = false;
        let (out, input) = bounded(1);
        self.flight = Some(input);
        let (backend, main, window) = (backend.clone(), main.clone(), window.clone());
        platform::spawn(async move {
            let result = if let Some(desired) = desired {
                match memory::set_enabled(&backend, desired).await {
                    Ok(actual) if actual == desired => (Some(actual), false),
                    _ => (memory::enabled(&backend).await.ok(), true),
                }
            } else {
                let actual = memory::enabled(&backend).await.ok();
                (actual, actual.is_none())
            };
            let _ = out.send(result).await;
            for wake in [main, window].into_iter().flatten() {
                wake();
            }
        });
        true
    }
}

pub(super) fn view<S: 'static>(
    prefs: &Preferences,
    help_failed: bool,
    apply: impl Fn(&mut S, Option<bool>) + Clone + 'static,
    help_error: impl Fn(&mut S, bool) + 'static,
) -> El {
    let setting = &prefs.memory;
    let title = t("settings.memory.title");
    let hint = t("settings.memory.info");
    let url = format!(
        "https://neuralnomadsai.github.io/CodeNomad/{}/settings.html#agent-memory",
        locale()
    );
    let info = chrome::info_link(hint, move |s, tx| help_error(s, tx.open_url(&url).is_err()));
    let next = !setting.current.unwrap_or(false);
    let set = apply.clone();
    let enabled = prefs.can_retry() && !setting.busy() && setting.current.is_some();
    chrome::card(
        col()
            .full_width()
            .child(chrome::setting_row_with_info(
                title,
                Some(info),
                chrome::setting_switch(title, !next, !enabled, move |s| set(s, Some(next))),
            ))
            .children(setting.failed.then(|| {
                layout::action_row()
                    .child(
                        text(t("settings.memory.error.unavailable"))
                            .wrap()
                            .role("alert"),
                    )
                    .child(layout::button(
                        t("settings.memory.retry"),
                        !prefs.can_retry() || setting.busy(),
                        move |s| apply(s, None),
                    ))
            }))
            .children(
                help_failed.then(|| text(t("commands.openHelp.failed")).role("alert").wrap()),
            ),
    )
}

pub(super) fn action(prefs: &mut Preferences, desired: Option<bool>) {
    if prefs.can_retry() && prefs.memory.visible {
        match desired {
            Some(desired) => prefs.memory.set(desired),
            None => prefs.memory.invalidate(),
        }
        for wake in [&prefs.main_wake, &prefs.window_wake].into_iter().flatten() {
            wake();
        }
    }
}
