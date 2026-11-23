use super::{Preferences, preferences::behavior::PERMISSION_MODES};
use crate::strings::{locale, t};
use rune::{El, col, text};
use rune_theme_codenomad::{layout::Layout, settings as chrome};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(super) struct Permissions {
    open: bool,
    help_failed: bool,
}

impl Permissions {
    pub fn close(&mut self) {
        self.open = false;
        self.help_failed = false;
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        const KEY: &str = "new-conversation-permissions";
        let prefs = shared.borrow();
        let title = t("settings.behavior.newConversationPermissions.title");
        let labels = PERMISSION_MODES.map(|(_, label)| t(label));
        let mode = prefs.new_conversation_permissions();
        let current = PERMISSION_MODES
            .iter()
            .position(|&(value, _)| value == mode);
        let unavailable = !prefs.locale_ready() || !prefs.can_retry();
        let pending = prefs.new_conversation_permissions_pending();
        let toggle = {
            let shared = shared.clone();
            move |s: &mut S| {
                let prefs = shared.borrow();
                if prefs.can_retry()
                    && prefs.locale_ready()
                    && !prefs.new_conversation_permissions_pending()
                {
                    let state = access(s);
                    state.open = !state.open;
                    return true;
                }
                false
            }
        };
        let press = toggle.clone();
        let choose = shared.clone();
        let trigger = chrome::build_picker(
            chrome::picker(KEY, title, &labels)
                .current(current.map(|index| labels[index]))
                .disabled(unavailable)
                .open(self.open && !pending)
                .on_toggle(move |s| {
                    press(s);
                })
                .on_close(move |s| access(s).open = false)
                .on_choose(move |s, label, _| {
                    if std::mem::take(&mut access(s).open)
                        && let Some(index) = labels.iter().position(|&candidate| candidate == label)
                    {
                        choose
                            .borrow_mut()
                            .set_new_conversation_permissions(PERMISSION_MODES[index].0);
                    }
                }),
            layers,
        )
        .busy(pending);
        // The browser mirror exposes the select trigger as a button without its native value.
        #[cfg(target_arch = "wasm32")]
        let trigger = trigger.description(current.map_or("", |index| labels[index]));
        let hint = t("settings.behavior.newConversationPermissions.info");
        let help = format!(
            "https://neuralnomadsai.github.io/CodeNomad/{}/permissions.html#conversation-mode",
            locale()
        );
        let info = chrome::info_link(hint, move |s: &mut S, tx| {
            access(s).help_failed = tx.open_url(&help).is_err();
        });
        chrome::card(
            col()
                .full_width()
                .on_key(move |s, event, tx| {
                    event.key == rune::Key::Enter
                        && event.mods == rune::Mods::default()
                        && !tx.key_repeat()
                        && !access(s).open
                        && tx.focused() == Some("new-conversation-permissions-trigger")
                        && toggle(s)
                })
                .child(chrome::setting_row_with_info(title, Some(info), trigger))
                .children(prefs.new_conversation_permissions_failed().then(|| {
                    text(t("settings.behavior.newConversationPermissions.saveFailed"))
                        .role("alert")
                        .wrap()
                }))
                .children(
                    self.help_failed
                        .then(|| text(t("commands.openHelp.failed")).role("alert").wrap()),
                ),
        )
    }
}
