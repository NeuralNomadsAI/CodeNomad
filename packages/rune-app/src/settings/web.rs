use super::{
    Preferences,
    providers::{self, Catalog, Target},
};
use crate::{State, screen, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    settings as chrome,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    General,
    Providers,
}

impl Default for Section {
    fn default() -> Self {
        Self::General
    }
}

#[derive(Default)]
pub(super) struct Panel {
    shown: bool,
    section: Section,
    contrast_help: bool,
    permissions: super::behavior::Permissions,
    catalog: Catalog,
}

impl Panel {
    pub fn shown(&self) -> bool {
        self.shown
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &rune::Waker) -> bool {
        self.shown
            && self.section == Section::Providers
            && self.catalog.poll(
                prefs.provider_target.as_ref().filter(|_| prefs.can_retry()),
                Some(wake),
            )
    }
}

pub(super) fn entry() -> El {
    layout::button(t("settings.title"), false, |s: &mut State| {
        let target = Target::capture(s);
        s.settings.shared.borrow_mut().provider_target = target;
        s.settings.web.shown = true;
        (s.wake)();
    })
    .key("open-preferences")
}

fn close(s: &mut State) {
    let panel = &mut s.settings.web;
    panel.shown = false;
    panel.contrast_help = false;
    panel.permissions.close();
    panel.catalog.suspend();
    s.settings.shared.borrow_mut().provider_target = None;
}

pub(super) fn view(s: &State, prefs: &Preferences, system_more: bool) -> Option<El> {
    let panel = &s.settings.web;
    if !panel.shown || crate::platform::pairing::required(s) {
        return None;
    }
    let navigation = chrome::segments(
        t("settings.navigationAriaLabel"),
        &[t("settings.nav.general"), t("settings.nav.providers")],
        Some(usize::from(panel.section == Section::Providers)),
        false,
        |s: &mut State, index| {
            let panel = &mut s.settings.web;
            panel.section = if index == 1 {
                Section::Providers
            } else {
                Section::General
            };
            if panel.section != Section::Providers {
                panel.catalog.suspend();
            }
            panel.contrast_help = false;
            panel.permissions.close();
        },
    );
    let mut layers = Vec::new();
    let body = match panel.section {
        Section::General => col()
            .full_width()
            .child(general(panel, prefs, system_more))
            .child(
                panel
                    .permissions
                    .view(&s.settings.shared, &mut layers, |s: &mut State| {
                        &mut s.settings.web.permissions
                    }),
            ),
        Section::Providers => {
            let available =
                prefs.can_retry() && prefs.provider_target.as_ref().is_some_and(Target::online);
            providers::content(&panel.catalog, available, |s: &mut State| {
                s.settings.web.catalog.toggle()
            })
        }
    };
    Some(
        chrome::embedded_section(
            t("settings.title"),
            col()
                .full_width()
                .separate(Space::Md)
                .child(navigation)
                .child(body),
            layout::button(
                t("settings.close"),
                false,
                screen::action(&s.input_scope, close),
            )
            .key("close-preferences"),
            close,
        )
        .children(layers),
    )
}

fn general(panel: &Panel, prefs: &Preferences, system_more: bool) -> El {
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .child(text(t("settings.appearance.colorScheme.title")).role("heading"))
            .child(super::contrast::view(
                prefs,
                system_more,
                panel.contrast_help,
                |s: &mut State| s.settings.web.contrast_help = !s.settings.web.contrast_help,
                |s: &mut State, choice| s.settings.shared.borrow_mut().set_contrast(choice),
            ))
            .children(prefs.error().map(|error| {
                layout::action_row()
                    .child(text(t(error)).wrap().role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        |s: &mut State| {
                            s.settings.shared.borrow_mut().retry();
                        },
                    ))
            })),
    )
}
