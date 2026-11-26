use super::Preferences;
use crate::strings::t;
use rune::{El, col};
use rune_theme_codenomad::{Space, layout::Layout, settings as chrome};
pub(super) mod environment;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Toggle {
    EmptySessions,
    UnseenSubagents,
    SecondLaunch,
    ProviderBalance,
    Whitespace,
    LongReplies,
}

impl Toggle {
    const ALL: [Self; 6] = [
        Self::EmptySessions,
        Self::UnseenSubagents,
        Self::SecondLaunch,
        Self::ProviderBalance,
        Self::Whitespace,
        Self::LongReplies,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::EmptySessions => "autoCleanupBlankSessions",
            Self::UnseenSubagents => "keepUnseenSubagentIdleStatus",
            Self::SecondLaunch => "focusExistingWindowOnSecondLaunch",
            Self::ProviderBalance => "showProviderUsageCreditBalance",
            Self::Whitespace => "hideDiffWhitespaceChanges",
            Self::LongReplies => "holdLongAssistantReplies",
        }
    }

    pub fn default_value(self) -> bool {
        !matches!(self, Self::SecondLaunch | Self::ProviderBalance)
    }

    pub fn supported(self) -> bool {
        matches!(
            self,
            Self::EmptySessions | Self::UnseenSubagents | Self::Whitespace
        ) || (cfg!(target_os = "windows") && self == Self::SecondLaunch)
    }

    fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::EmptySessions => (
                "settings.behavior.autoCleanup.title",
                "settings.behavior.autoCleanup.subtitle",
            ),
            Self::UnseenSubagents => (
                "settings.behavior.keepUnseenSubagentIdle.title",
                "settings.behavior.keepUnseenSubagentIdle.subtitle",
            ),
            Self::SecondLaunch => (
                "settings.behavior.focusExistingWindowOnSecondLaunch.title",
                "settings.behavior.focusExistingWindowOnSecondLaunch.subtitle",
            ),
            Self::ProviderBalance => (
                "settings.behavior.providerUsageCreditBalance.title",
                "settings.behavior.providerUsageCreditBalance.subtitle",
            ),
            Self::Whitespace => (
                "advancedSettings.hideDiffWhitespace.title",
                "advancedSettings.hideDiffWhitespace.subtitle",
            ),
            Self::LongReplies => (
                "settings.behavior.holdLongAssistantReplies.title",
                "settings.behavior.holdLongAssistantReplies.subtitle",
            ),
        }
    }
}

pub(super) fn view<S: 'static>(
    prefs: &Preferences,
    native: bool,
    help_open: Option<Toggle>,
    info: fn(&mut S, Toggle),
    toggle: fn(&mut S, Toggle, bool),
    retry: fn(&mut S),
) -> El {
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .children(prefs.advanced_failed().then(|| {
                rune_theme_codenomad::layout::action_row()
                    .child(rune::text(t("settings.preferenceSaveFailed")).role("alert"))
                    .child(rune_theme_codenomad::layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        retry,
                    ))
            }))
            .children(
                Toggle::ALL
                    .into_iter()
                    .filter(|choice| native || *choice != Toggle::SecondLaunch)
                    .map(|choice| {
                        let (title, help) = choice.labels();
                        let value = prefs.advanced_toggle(choice);
                        let checked = value.unwrap_or_else(|| choice.default_value());
                        let explanation = if choice.supported() {
                            t(help)
                        } else {
                            t("advancedSettings.unavailable")
                        };
                        chrome::setting_row(
                            t(title),
                            rune_theme_codenomad::layout::action_row()
                                .child(
                                    chrome::info_tip(
                                        t(title),
                                        explanation,
                                        help_open == Some(choice),
                                        move |s| info(s, choice),
                                    )
                                    .key(format!("advanced-help-{}", choice.key())),
                                )
                                .child(
                                    chrome::setting_switch(
                                        t(title),
                                        checked,
                                        !choice.supported()
                                            || !prefs.can_retry()
                                            || value.is_none()
                                            || prefs.advanced_pending(choice),
                                        move |s| toggle(s, choice, !checked),
                                    )
                                    .description(explanation),
                                ),
                        )
                    }),
            ),
    )
}
