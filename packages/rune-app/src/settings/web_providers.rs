use super::{
    Preferences,
    providers::{self, Catalog, Target},
};
use crate::{State, screen, strings::t};
use rune::El;
use rune_theme_codenomad::{layout, settings as chrome};

#[derive(Default)]
pub(super) struct Panel {
    shown: bool,
    catalog: Catalog,
}

impl Panel {
    pub fn poll(&mut self, prefs: &Preferences, wake: &rune::Waker) -> bool {
        self.shown
            && self.catalog.poll(
                prefs.provider_target.as_ref().filter(|_| prefs.can_retry()),
                Some(wake),
            )
    }
}

pub(super) fn entry() -> El {
    layout::button(t("settings.nav.providers"), false, |s: &mut State| {
        let target = Target::capture(s);
        s.settings.shared.borrow_mut().provider_target = target;
        s.settings.web_providers.shown = true;
        (s.wake)();
    })
    .key("open-providers")
}

fn close(s: &mut State) {
    let panel = &mut s.settings.web_providers;
    panel.shown = false;
    panel.catalog.suspend();
    s.settings.shared.borrow_mut().provider_target = None;
}

pub(super) fn view(s: &State, prefs: &Preferences) -> Option<El> {
    let panel = &s.settings.web_providers;
    if !panel.shown || crate::platform::pairing::required(s) {
        return None;
    }
    let available = prefs.can_retry() && prefs.provider_target.as_ref().is_some_and(Target::online);
    let body = providers::content(&panel.catalog, available, |s: &mut State| {
        s.settings.web_providers.catalog.toggle()
    });
    Some(chrome::embedded_section(
        t("settings.nav.providers"),
        body,
        layout::button(
            t("settings.close"),
            false,
            screen::action(&s.input_scope, close),
        )
        .key("close-providers"),
        close,
    ))
}
