use super::super::{Preferences, preferences::server::LEVELS};
use crate::strings::t;
use rune::{El, col};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(in crate::settings) struct Logging(bool);

impl Logging {
    pub fn close(&mut self) {
        self.0 = false;
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        layers: &mut Vec<El>,
        logs_action: El,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        const KEY: &str = "opencode-log-level";
        let prefs = shared.borrow();
        let title = t("settings.opencode.logLevel.title");
        let labels = LEVELS.map(|(_, key)| t(key));
        let current = prefs.log_level().map(|index| labels[index]);
        let pending = prefs.log_level_pending();
        let toggle = {
            let shared = shared.clone();
            move |s: &mut S| {
                let prefs = shared.borrow();
                if !prefs.log_level_available() || prefs.log_level_pending() {
                    return false;
                }
                let state = access(s);
                state.0 = !state.0;
                true
            }
        };
        let press = toggle.clone();
        let (choose, retry) = (shared.clone(), shared.clone());
        let trigger = chrome::build_picker(
            chrome::stepping_picker(KEY, title, &labels)
                .current(current)
                .disabled(!prefs.log_level_available())
                .open(self.0 && !pending)
                .on_toggle(move |s| {
                    press(s);
                })
                .on_close(move |s| access(s).close())
                .on_choose(move |s, label, _| {
                    access(s).close();
                    let mut prefs = choose.borrow_mut();
                    if prefs.log_level_available()
                        && !prefs.log_level_pending()
                        && let Some(index) = labels.iter().position(|&candidate| candidate == label)
                    {
                        prefs.set_log_level(index);
                    }
                }),
            layers,
        )
        .busy(pending);
        #[cfg(target_arch = "wasm32")]
        let trigger = trigger.description(current.unwrap_or(""));
        chrome::card(
            col()
                .full_width()
                .separate(Space::Sm)
                .on_key(move |s, event, tx| {
                    event.key == rune::Key::Enter
                        && event.mods == rune::Mods::default()
                        && !tx.key_repeat()
                        && !access(s).0
                        && tx.focused() == Some("opencode-log-level-trigger")
                        && toggle(s)
                })
                .child(chrome::setting_row(title, trigger))
                .children(prefs.log_level_failed().map(|error| {
                    layout::action_row()
                        .child(chrome::palette::save_error(t(error)))
                        .child(chrome::secondary_action(
                            t("sessionList.loadError.retry"),
                            !prefs.can_retry() || pending,
                            move |_: &mut S| retry.borrow_mut().retry_log_level(),
                        ))
                }))
                .child(logs_action),
        )
    }
}
