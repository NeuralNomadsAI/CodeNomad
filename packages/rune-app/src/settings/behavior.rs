use super::{
    Preferences,
    preferences::behavior::{GeneralToggle, PERMISSION_MODES},
};
use crate::strings::{locale, t};
use rune::{El, col};
use rune_theme_codenomad::{Space, layout::Layout, settings as chrome};
use std::{cell::RefCell, rc::Rc};

const BEFORE_PERMISSIONS: [GeneralToggle; 4] = [
    GeneralToggle::MessageTimeline,
    GeneralToggle::ScrollControlsInTimelineCorner,
    GeneralToggle::DiffViewMode,
    GeneralToggle::AutoExpandActiveSubsessions,
];

#[derive(Default)]
pub(super) struct General {
    open: bool,
    help_open: super::ExternalLink,
}

impl General {
    pub fn close(&mut self) {
        self.open = false;
        self.help_open.clear();
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        native: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        const KEY: &str = "new-conversation-permissions";
        let prefs = shared.borrow();
        let unavailable = !prefs.locale_ready() || !prefs.can_retry();
        let toggle_row = |toggle: GeneralToggle| {
            let title = t(toggle.title_key());
            let checked = prefs
                .general_toggle(toggle)
                .unwrap_or_else(|| toggle.default_value());
            let pending = prefs.general_toggle_pending(toggle);
            let info = toggle.help().map(|(info_key, page)| {
                let url = format!(
                    "https://neuralnomadsai.github.io/CodeNomad/{}/{page}",
                    locale()
                );
                chrome::info_link(t(info_key), move |s: &mut S, tx| {
                    access(s)
                        .help_open
                        .open(&url, tx, move |s| Some(&mut access(s).help_open));
                })
                .key(format!("behavior-help-{}", toggle.key()))
            });
            let owner = shared.clone();
            let control =
                chrome::checkbox_cell(title.into(), checked, unavailable, move |_: &mut S| {
                    let mut prefs = owner.borrow_mut();
                    if let Some(current) = prefs.general_toggle(toggle) {
                        prefs.set_general_toggle(toggle, !current);
                    }
                })
                .busy(pending)
                .key(format!("behavior-{}", toggle.key()));
            chrome::setting_row_with_info(title, info, control)
        };

        let title = t("settings.behavior.newConversationPermissions.title");
        let labels = PERMISSION_MODES.map(|(_, label)| t(label));
        let mode = prefs.new_conversation_permissions();
        let current = PERMISSION_MODES
            .iter()
            .position(|&(value, _)| value == mode);
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
            chrome::stepping_picker(KEY, title, &labels)
                .current(current.map(|index| labels[index]))
                .disabled(unavailable)
                .open(self.open && !pending)
                .on_toggle(move |s| {
                    press(s);
                })
                .on_close(move |s| access(s).open = false)
                .on_choose(move |s, label, _| {
                    access(s).open = false;
                    let mut prefs = choose.borrow_mut();
                    if prefs.can_retry()
                        && prefs.locale_ready()
                        && !prefs.new_conversation_permissions_pending()
                        && let Some(index) = labels.iter().position(|&candidate| candidate == label)
                    {
                        prefs.set_new_conversation_permissions(PERMISSION_MODES[index].0);
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
            access(s)
                .help_open
                .open(&help, tx, move |s| Some(&mut access(s).help_open));
        })
        .key("behavior-help-newConversationPermissions");
        chrome::card(
            col()
                .full_width()
                .separate(Space::Sm)
                .on_key(move |s, event, tx| {
                    event.key == rune::Key::Enter
                        && event.mods == rune::Mods::default()
                        && !tx.key_repeat()
                        && !access(s).open
                        && tx.focused() == Some("new-conversation-permissions-trigger")
                        && toggle(s)
                })
                .children(BEFORE_PERMISSIONS.into_iter().map(&toggle_row))
                .child(chrome::setting_row_with_info(title, Some(info), trigger))
                .children(prefs.new_conversation_permissions_failed().then(|| {
                    chrome::palette::save_error(t(
                        "settings.behavior.newConversationPermissions.saveFailed",
                    ))
                }))
                .child(toggle_row(GeneralToggle::FollowUpBehavior))
                .children(native.then(|| toggle_row(GeneralToggle::KeepComputerAwake)))
                .children(
                    self.help_open
                        .failed()
                        .then(|| chrome::palette::save_error(t("commands.openHelp.failed"))),
                ),
        )
    }
}
